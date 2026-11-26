using System.CommandLine;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using IECode.Automation;
using IECode.Automation.Interop;
using IECode.Core;
using IECode.Core.Projects;

namespace IECode.Cli;

/// <summary>Runs a command body with uniform error handling, exit codes and JSON output.</summary>
internal static class Runner
{
    /// <summary>Command result: exit code and the data object written to JSON.</summary>
    public readonly record struct Outcome(int Code, object? Data)
    {
        public static Outcome Ok(object? data = null) => new(ExitCodes.Ok, data);
    }

    /// <summary>protocolStdout: stdout belongs to the command's own protocol, so --json never adds a result document there and log lines always go to stderr.</summary>
    public static void Action(Command command, Func<Context, Outcome> body, bool windowsOnly = false, bool protocolStdout = false) =>
        command.SetAction(parse => Run(parse, command, body, windowsOnly, protocolStdout));

    private static int Run(ParseResult parse, Command command, Func<Context, Outcome> body, bool windowsOnly, bool protocolStdout)
    {
        var log = new Reporter(!protocolStdout && parse.GetValue(Globals.Json), parse.GetValue(Globals.Verbose));
        if (parse.GetValue(Globals.NoColor)) log.DisableColor();
        if (parse.GetValue(Globals.MaxErrors) is int max) log.MaxErrors = Math.Max(0, max);
        var name = FullName(command);
        int code;
        try
        {
            if (windowsOnly && !OperatingSystem.IsWindows())
                throw new IECodeException(ExitCodes.NotSupportedPlatform, $"'iecode {name}' needs Windows with TwinCAT XAE.",
                    "File-based commands (info, lib list/info/update/outdated/restore --dry-run, ws list/graph/release --no-save, io links/diff, ads symbols/diff, clean --artifacts) work on any OS.");
            var outcome = body(new Context(parse, log));
            code = outcome.Code;
            log.Finish(name, code, outcome.Data);
        }
        catch (IECodeException e)
        {
            code = e.ExitCode;
            log.Error(e.Message);
            if (e.Hint is not null && !log.Json) Console.Error.WriteLine("  " + e.Hint.Replace("\n", "\n  "));
            log.Finish(name, code, null, e.Message, e.Hint);
        }
        catch (COMException e)
        {
            code = ExitCodes.Failed;
            log.Error($"TwinCAT reported an error: {e.Message} (0x{e.HResult:X8})");
            log.Finish(name, code, null, e.Message);
        }
        catch (Exception e)
        {
            code = ExitCodes.Unexpected;
            log.Error($"Unexpected error: {e.Message}");
            if (log.Verbose) Console.Error.WriteLine(e);
            log.Finish(name, code, null, e.ToString());
        }

        if (parse.GetValue(Globals.Pause) && !Console.IsInputRedirected)
        {
            Console.Error.Write("Press Enter to exit…");
            Console.ReadLine();
        }
        return code;
    }

    private static string FullName(Command c)
    {
        var names = new List<string>();
        for (Symbol? s = c; s is Command cmd && s is not RootCommand; s = s.Parents.FirstOrDefault())
            names.Insert(0, cmd.Name);
        return string.Join(' ', names);
    }

    /// <summary>
    /// Starts the XAE shell, selects version / user database / login, opens the solution, runs the body
    /// and always closes the shell again.
    /// </summary>
    /// <param name="saves">The command writes project files: then <c>--tc auto</c> stops instead of moving a project to another line.</param>
    /// <param name="discard">Close the solution without saving at the end even though <paramref name="saves"/> is set (build --no-save).</param>
    /// <param name="beforeOpen">Called right before the solution is opened, the point from which XAE can write to the project.</param>
    [SupportedOSPlatform("windows")]
    public static T WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false, Action? beforeOpen = null)
    {
        var slnFile = SolutionFile.Load(solution);
        using var shell = StartShell(ctx, ChooseVersion(ctx, slnFile, saves).Request);
        // a command that does not save must not save at Quit either, also when it fails early
        shell.DiscardChanges = !saves || discard;
        if (shell.ActiveUser() is { Length: > 0 } active) ctx.Log.Detail($"Active TwinCAT user: {active}");
        // from here on XAE may change files, also when the open or the command fails
        beforeOpen?.Invoke();
        shell.OpenSolution(slnFile.Path);
        return body(shell);
    }

    /// <summary>
    /// The version to open a solution with (<see cref="TcLineGuard"/>); prints its note as a warning. Call it before the
    /// first write of a command, so a stop happens before anything changed.
    /// </summary>
    public static TcChoice ChooseVersion(Context ctx, SolutionFile solution, bool saves, bool quiet = false)
    {
        var stamps = solution.TwinCatProjects.Select(p => p.TcVersion).ToList();
        var choice = TcLineGuard.Choose(ctx.Version, stamps, TwinCatInstall.Builds(RepTool.TwinCatDir), saves);
        if (!quiet)
        {
            if (stamps.FirstOrDefault(v => v is not null) is { } saved) ctx.Log.Detail($"Project was saved with TwinCAT {saved}");
            if (choice.Note is { } note) ctx.Log.Warn(note);
        }
        return choice;
    }

    /// <summary>RepTool for a version, with <c>--timeout</c> as the limit for the repository lock and the run.</summary>
    [SupportedOSPlatform("windows")]
    public static RepTool RepToolFor(Context ctx, TwinCatVersion version, string? profile = null) =>
        RepTool.Find(version, profile, TimeoutSetting.FromSeconds(ctx.Get(Globals.Timeout)));

    /// <summary>
    /// Starts a library export: XAE saves the PLC project to a private path next to <paramref name="finalFile"/> (see
    /// <see cref="StagedExport"/>), so nothing another invocation does to the final name can change this export.
    /// <see cref="FinishExport"/> completes it.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static StagedExport StageExport(XaeShell shell, string? plcName, string finalFile)
    {
        var export = StagedExport.Begin(finalFile);
        try { shell.SaveAsLibrary(plcName, export.Path, install: false); return export; }
        catch { export.Dispose(); throw; }
    }

    /// <summary>
    /// Completes an export: waits until XAE has finished writing the private file, installs that very file when
    /// <paramref name="installAs"/> is given, and publishes it to its final name. The file is published also when the
    /// install fails, so it can be installed later; the install error is then thrown.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static string FinishExport(Context ctx, StagedExport export, TwinCatVersion? installAs)
    {
        using (export)
        {
            // XAE may still write the file when SaveAsLibrary returns; RepTool must not install half of it
            FileReady.Wait(export.Path, TimeSpan.FromMinutes(2));
            IECodeException? failed = null;
            if (installAs is { } version)
            {
                try { InstallSaved(ctx, export.Path, version); }
                catch (IECodeException e) { failed = e; }
            }
            var published = export.Publish();
            if (failed is not null)
                throw new IECodeException(failed.ExitCode, $"{failed.Message} The library was saved as '{published}' but is not installed.", failed.Hint ?? "Install it with: iecode lib install <file>.", failed);
            return published;
        }
    }

    /// <summary>
    /// Installs a library XAE has just saved (a complete file: <see cref="FinishExport"/> checks that). XAE saves with install
    /// off and RepTool installs the file in a fresh process under the repository lock, so a shell that read the repository at
    /// start cannot write a stale copy. <paramref name="version"/> is the build the shell worked with
    /// (<see cref="TwinCatVersion.UsedBy"/>), not <c>--tc</c>.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static void InstallSaved(Context ctx, string file, TwinCatVersion version)
    {
        RepTool tool;
        try { tool = RepToolFor(ctx, version); }
        catch (IECodeException e) when (e.ExitCode == ExitCodes.VersionNotInstalled)
        {
            throw new IECodeException(e.ExitCode, $"XAE saved with TwinCAT {version}, but {e.Message}", e.Hint, e);
        }
        ctx.Log.Step($"Installing {Path.GetFileName(file)} (RepTool profile: {tool.Profile})…");
        var code = tool.Install(file, overwrite: true, ctx.Log);
        if (code != 0)
            throw new IECodeException(ExitCodes.LibraryFailed, $"Installing {Path.GetFileName(file)} failed (RepTool exit {code}).", "Run with --verbose to see its output.");
    }

    /// <summary>Starts a shell with the given version, user database and login; the caller opens solutions and disposes it.</summary>
    [SupportedOSPlatform("windows")]
    private static XaeShell StartShell(Context ctx, TwinCatVersion request)
    {
        var timeout = TimeoutSetting.FromSeconds(ctx.Get(Globals.Timeout));
        var shell = XaeShell.Start(new ShellOptions(request, ctx.Get(Globals.ProgId), ctx.Get(Globals.Visible), ctx.Get(Globals.ShowUi), timeout), ctx.Log);
        try
        {
            if (!request.IsAuto) SelectVersion(ctx, shell, request);
            if (ctx.Get(Globals.UserDb) is { } db) shell.SelectUserDb(db);
            if (Credentials(ctx) is ({ } user, { } password)) shell.Login(user, password);
            return shell;
        }
        catch { shell.Dispose(); throw; }
    }

    /// <summary>
    /// Selects the version in the Remote Manager. The install folders are only a hint: when --tc auto chose an exact
    /// build the Remote Manager does not know, the newest build of the same line is used; never another line.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void SelectVersion(Context ctx, XaeShell shell, TwinCatVersion request)
    {
        try { shell.SelectVersion(request); }
        catch (IECodeException e) when (ctx.Version.IsAuto && e.ExitCode == ExitCodes.VersionNotInstalled && request.Revision is not null)
        {
            ctx.Log.Warn($"{e.Message} Using the newest build of TwinCAT {request.Line}.");
            shell.SelectVersion(new TwinCatVersion(request.Build, null));
        }
    }

    /// <summary>
    /// One XAE shell for several solutions (starting XAE once saves ~5–10 s per solution). The version is decided per
    /// solution when it is opened; the shell is restarted when the TwinCAT line changes, and for a command that saves
    /// also when the exact build changes (so a project is not saved with an older build of its line).
    /// </summary>
    [SupportedOSPlatform("windows")]
    public sealed class ShellSession(Context ctx, bool saves, bool discard = false) : IDisposable
    {
        private XaeShell? _shell;
        private TwinCatVersion? _request;
        private string? _preparedFor;
        private string? _opened;

        /// <summary>
        /// Starts the shell for a solution without opening it: the version is chosen and selected in the Remote Manager, so
        /// a missing build or line fails here, before the caller changes anything. <see cref="Open"/> then reuses the shell.
        /// </summary>
        public void Prepare(string solution)
        {
            Ensure(SolutionFile.Load(solution), quiet: false);
            _preparedFor = Path.GetFullPath(solution);
        }

        /// <summary>The build the open shell works with, for RepTool after a save: what the Remote Manager selected, not what was asked for.</summary>
        public TwinCatVersion Request => TwinCatVersion.UsedBy(_shell?.SelectedVersion, _request ?? ctx.Version);

        /// <summary>
        /// Gives the shell that has the solution open: in a new shell when it needs another version than the open one or the
        /// last one stopped on a dialog, the shell at hand when the solution is not open yet, and the same shell without
        /// reopening when it is. Call it for every item of a run, not once per solution: the health check is here.
        /// </summary>
        public XaeShell Open(string solution)
        {
            var slnFile = SolutionFile.Load(solution);
            var full = Path.GetFullPath(solution);
            // the notes of the version choice were printed when the solution was prepared or opened
            var plan = Ensure(slnFile, quiet: string.Equals(_preparedFor, full, StringComparison.OrdinalIgnoreCase) || string.Equals(_opened, full, StringComparison.OrdinalIgnoreCase));
            _preparedFor = null;
            if (plan != ShellPlan.Keep)
            {
                _shell!.OpenSolution(slnFile.Path);
                _opened = Path.GetFullPath(slnFile.Path);
            }
            return _shell!;
        }

        private ShellPlan Ensure(SolutionFile slnFile, bool quiet)
        {
            var request = ChooseVersion(ctx, slnFile, saves, quiet).Request;
            var plan = TcLineGuard.PlanFor(_shell is null ? null : _request, request, saves, _shell?.DialogFailed == true, _opened, slnFile.Path);
            if (plan == ShellPlan.Replace)
            {
                if (_shell is not null)
                {
                    ctx.Log.Step(_shell.DialogFailed
                        ? $"Starting a new shell for {Path.GetFileName(slnFile.Path)} (the last one stopped on a dialog)"
                        : $"Switching to TwinCAT {request} for {Path.GetFileName(slnFile.Path)}");
                    _shell.Dispose();
                    _shell = null;
                }
                _opened = null;
                _shell = StartShell(ctx, request);
                _shell.DiscardChanges = !saves || discard;
                _request = request;
            }
            return plan;
        }

        public void Dispose() => _shell?.Dispose();
    }

    [SupportedOSPlatform("windows")]
    internal static (string, string)? Credentials(Context ctx)
    {
        if (ctx.Get(Globals.Credential) is { } target)
        {
            if (CredentialStore.Read(target) is { } stored) return stored;
            if (ctx.Log.Json || Console.IsInputRedirected)
                throw new IECodeException(ExitCodes.UserManagementFailed, $"No Windows credential '{target}' found.",
                    $"Create it once interactively (iecode … --credential {target}) or with: cmdkey /generic:{target} /user:<name> /pass");
            Console.Error.Write($"User for credential '{target}': ");
            var u = Console.ReadLine() ?? "";
            var p = ReadSecret("Password: ");
            CredentialStore.Write(target, u, p);
            ctx.Log.Step($"Saved credential '{target}' in Windows Credential Manager");
            return (u, p);
        }
        if (ctx.Get(Globals.User) is { } user)
        {
            var env = Environment.GetEnvironmentVariable("IECODE_PASSWORD");
            if (env is not null) return (user, env);
            if (ctx.Log.Json || Console.IsInputRedirected)
                throw new IECodeException(ExitCodes.UserManagementFailed, $"No password for '{user}'.", "Set IECODE_PASSWORD or use --credential.");
            return (user, ReadSecret($"Password for {user}: "));
        }
        return null;
    }

    private static string ReadSecret(string prompt)
    {
        Console.Error.Write(prompt);
        var chars = new List<char>();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter) break;
            if (key.Key == ConsoleKey.Backspace) { if (chars.Count > 0) { chars.RemoveAt(chars.Count - 1); Console.Error.Write("\b \b"); } continue; }
            if (!char.IsControl(key.KeyChar)) { chars.Add(key.KeyChar); Console.Error.Write('*'); }
        }
        Console.Error.WriteLine();
        return new string([.. chars]);
    }
}
