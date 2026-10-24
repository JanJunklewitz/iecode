using System.Diagnostics;
using System.Runtime.Versioning;
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

    private RepTool(string exe, string profile)
    {
        Exe = exe;
        Profile = profile;
    }

    public static string? TwinCatDir =>
        Environment.GetEnvironmentVariable("TWINCAT3DIR") is { Length: > 0 } d ? d.TrimEnd('\\', '/') : null;

    /// <summary>Locates RepTool and picks a profile ("TwinCAT PLC Control_Build_&lt;build&gt;") matching the requested version.</summary>
    public static RepTool Find(TwinCatVersion version, string? profile)
    {
        var dir = TwinCatDir ?? throw new IECodeException(ExitCodes.NotFound, "TWINCAT3DIR is not set.", "Install TwinCAT XAE or open a new terminal after installing.");
        var plc = Path.Combine(dir, "Components", "Plc");
        var exe = Path.Combine(plc, "Common", "RepTool.exe");
        if (!File.Exists(exe)) throw new IECodeException(ExitCodes.NotFound, $"RepTool not found at '{exe}'.");
        return new RepTool(exe, profile ?? PickProfile(Path.Combine(plc, "Profiles"), version));
    }

    internal static string PickProfile(string profilesDir, TwinCatVersion version) =>
        TwinCatVersion.PickRepToolProfile(
            Directory.Exists(profilesDir)
                ? Directory.EnumerateFiles(profilesDir, "*.profile").Select(Path.GetFileNameWithoutExtension).OfType<string>()
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

    private int Run(string[] args, Reporter log)
    {
        var psi = new ProcessStartInfo(Exe) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
        psi.ArgumentList.Add($"--profile={Profile}");
        foreach (var a in args) psi.ArgumentList.Add(a);
        log.Detail($"RepTool {string.Join(' ', psi.ArgumentList)}");
        using var p = Process.Start(psi) ?? throw new IECodeException(ExitCodes.Failed, "Starting RepTool failed.");
        p.OutputDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) log.Detail(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) log.Warn(e.Data); };
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        p.WaitForExit();
        return p.ExitCode;
    }
}
