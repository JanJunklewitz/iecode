using System.Diagnostics;
using System.Runtime.Versioning;
using IECode.Automation.Interop;
using IECode.Core;

namespace IECode.Automation;

/// <summary>
/// Wraps RepTool.exe, TwinCAT's command-line tool for the local library repository. Works without
/// starting the XAE shell. The profile selects the TwinCAT version whose repository is used.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class RepTool
{
    public string Exe { get; }
    public string Profile { get; }

    /// <summary>Limit for waiting on the repository lock and for one RepTool run; the run is stopped after it.</summary>
    public TimeSpan Timeout { get; }

    /// <summary>The TwinCAT line this RepTool and profile belong to (decides which library repository it changes); null when unknown.</summary>
    public int? Line => TwinCatVersion.LineOfRepTool(Exe, Profile);

    /// <summary>Name of the repository mutex; a test uses its own so it does not touch the real lock.</summary>
    internal string LockName { get; init; } = RepositoryLock.Name;

    /// <summary>A RepTool at a given exe (a test double).</summary>
    internal static RepTool At(string exe, string profile, TimeSpan timeout, string lockName) => new(exe, profile, timeout) { LockName = lockName };

    private RepTool(string exe, string profile, TimeSpan timeout)
    {
        Exe = exe;
        Profile = profile;
        Timeout = timeout;
    }

    public static string? TwinCatDir =>
        Environment.GetEnvironmentVariable("TWINCAT3DIR") is { Length: > 0 } d ? d.TrimEnd('\\', '/') : null;

    /// <summary>
    /// Locates RepTool and picks a profile ("TwinCAT PLC Control_Build_&lt;build&gt;") matching the requested version.
    /// With the TwinCAT Remote Manager every build has its own <c>Components\Plc\Build_&lt;build&gt;</c> folder (RepTool in
    /// <c>Common</c>, profiles in <c>Profiles</c>); older installations have one <c>Components\Plc\Common</c>.
    /// </summary>
    public static RepTool Find(TwinCatVersion version, string? profile, TimeSpan? timeout = null)
    {
        var dir = TwinCatDir ?? throw new IECodeException(ExitCodes.NotFound, "TWINCAT3DIR is not set.", "Install TwinCAT XAE or open a new terminal after installing.");
        var plc = Path.Combine(dir, "Components", "Plc");
        var builds = (Directory.Exists(plc) ? Directory.EnumerateDirectories(plc, "Build_*") : [])
            .Where(d => File.Exists(Path.Combine(d, "Common", "RepTool.exe")))
            .ToDictionary(d => Path.GetFileName(d)["Build_".Length..], StringComparer.OrdinalIgnoreCase);
        var root = plc;
        if (builds.Count > 0)
        {
            var build = version.Resolve(builds.Keys)
                ?? throw new IECodeException(ExitCodes.VersionNotInstalled, $"No RepTool for TwinCAT {version} in '{plc}'.",
                    "Installed: " + string.Join(", ", builds.Keys.Order()));
            root = builds[build];
        }
        var exe = Path.Combine(root, "Common", "RepTool.exe");
        if (!File.Exists(exe)) throw new IECodeException(ExitCodes.NotFound, $"RepTool not found at '{exe}'.");
        return new RepTool(exe, profile ?? PickProfile(Path.Combine(root, "Profiles"), version), timeout ?? RepositoryLock.DefaultTimeout);
    }

    internal static string PickProfile(string profilesDir, TwinCatVersion version) =>
        TwinCatVersion.PickRepToolProfile(
            Directory.Exists(profilesDir)
                ? Directory.EnumerateFiles(profilesDir).Select(f => TwinCatVersion.RepToolProfileName(Path.GetFileName(f))).OfType<string>()
                : [],
            version);

    /// <summary>Installs one .library / .compiled-library file, or all libraries below a folder.</summary>
    public int Install(string path, bool overwrite, Reporter log)
    {
        var full = Path.GetFullPath(path);
        string[] args = Directory.Exists(full)
            ? [overwrite ? "--installLibsRecurs" : "--installLibsRecursNoOverwrite", full]
            : File.Exists(full) ? ["--installLib", full]
            : throw new IECodeException(ExitCodes.NotFound, $"'{path}' does not exist.");
        return Run(args, log);
    }

    /// <summary>Uninstalls libraries given as "name,version(vendor)"; version "all" removes every version.</summary>
    public int Uninstall(IEnumerable<string> libraries, Reporter log) =>
        Run(["--uninstallLibs", string.Join(",", libraries)], log);

    /// <summary>Runs RepTool under the repository lock (<see cref="RepositoryLock"/>); every repository write goes through here.</summary>
    private int Run(string[] args, Reporter log)
    {
        using var held = RepositoryLock.Acquire(log, Timeout, LockName);
        // RepTool only reads --profile="<name>" with the quotes around the value; ArgumentList would quote the whole
        // argument ("--profile=<name>") and RepTool then reports "No profile name specified".
        var arguments = string.Join(' ', [$"--profile=\"{Profile}\"", .. args.Select(Quote)]);
        log.Detail($"RepTool {arguments}");
        // RepTool starts suspended inside a kill-on-close job; its record for later lock holders is written before its first
        // instruction. If either step fails it never runs, and if iecode dies it dies with it: no unrecorded or orphaned writer.
        using var p = SupervisedProcess.Start(Exe, arguments,
            line => { if (!string.IsNullOrWhiteSpace(line)) log.Detail(line); },
            line => { if (!string.IsNullOrWhiteSpace(line)) log.Warn(line); },
            whileSuspended: child => held.RecordWriter(child.Id, child.StartTicksUtc));
        if (!p.WaitForExit(Timeout))
        {
            // the record stays unless RepTool is confirmed gone: a later holder then waits for it instead of starting a second writer
            if (!p.Terminate(StopWait))
                throw new IECodeException(ExitCodes.Timeout, $"RepTool did not finish within {Timeout.TotalSeconds:0} s and could not be stopped (PID {p.Id}).",
                    "End RepTool.exe in the Task Manager; the next iecode waits for it. The library repository may hold a partial install.");
            p.WaitForOutput(OutputWait);
            held.ClearWriter();
            throw new IECodeException(ExitCodes.Timeout, $"RepTool did not finish within {Timeout.TotalSeconds:0} s and was stopped.",
                "The library repository may hold a partial install; repeat the command, or raise --timeout.");
        }
        // a descendant that keeps the output pipes open must not hold iecode up: after a short wait it is ended with the job
        if (!p.WaitForOutput(OutputWait))
        {
            log.Warn("RepTool left a background process holding its output open; stopping it.");
            p.Terminate(StopWait);
            p.WaitForOutput(OutputWait);
        }
        var exit = p.ExitCode;
        held.ClearWriter();
        return exit;
    }

    /// <summary>How long to wait for RepTool's output to end after it exited, and for a stop to take effect.</summary>
    internal static readonly TimeSpan OutputWait = TimeSpan.FromSeconds(5), StopWait = TimeSpan.FromSeconds(10);

    /// <summary>Quotes an argument for the Windows command line (backslashes before a quote are doubled).</summary>
    internal static string Quote(string arg) =>
        arg.Length > 0 && !arg.Any(c => char.IsWhiteSpace(c) || c == '"')
            ? arg
            : "\"" + System.Text.RegularExpressions.Regex.Replace(arg, @"(\\*)(""|$)", m => m.Groups[1].Value + m.Groups[1].Value + (m.Groups[2].Value == "\"" ? "\\\"" : "")) + "\"";
}
