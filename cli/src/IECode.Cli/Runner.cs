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

    public static void Action(Command command, Func<Context, Outcome> body, bool windowsOnly = false) =>
        command.SetAction(parse => Run(parse, command, body, windowsOnly));

    private static int Run(ParseResult parse, Command command, Func<Context, Outcome> body, bool windowsOnly)
    {
        var log = new Reporter(parse.GetValue(Globals.Json), parse.GetValue(Globals.Verbose));
        if (parse.GetValue(Globals.NoColor)) log.DisableColor();
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
    [SupportedOSPlatform("windows")]
    public static T WithShell<T>(Context ctx, string solution, Func<XaeShell, T> body)
    {
        var slnFile = SolutionFile.Load(solution);
        var request = ctx.Version;
        if (request.IsAuto && slnFile.TwinCatProjects.Select(p => p.TcVersion).FirstOrDefault(v => v is not null) is { } saved)
        {
            // Prefer the exact version the project was saved with, if it's installed.
            request = TwinCatVersion.Parse(saved);
            ctx.Log.Detail($"Project was saved with TwinCAT {saved}");
        }

        var timeout = ctx.Get(Globals.Timeout) is int s ? TimeSpan.FromSeconds(s) : (TimeSpan?)null;
        using var shell = XaeShell.Start(new ShellOptions(request, ctx.Get(Globals.ProgId), ctx.Get(Globals.Visible), ctx.Get(Globals.ShowUi), timeout), ctx.Log);

        if (!request.IsAuto)
        {
            try { shell.SelectVersion(request); }
            catch (IECodeException e) when (ctx.Version.IsAuto && e.ExitCode == ExitCodes.VersionNotInstalled)
            {
                ctx.Log.Warn($"{e.Message} Using the shell's default version.");
            }
        }

        if (ctx.Get(Globals.UserDb) is { } db) shell.SelectUserDb(db);
        if (Credentials(ctx) is ({ } user, { } password)) shell.Login(user, password);
        if (shell.ActiveUser() is { Length: > 0 } active) ctx.Log.Detail($"Active TwinCAT user: {active}");

        shell.OpenSolution(slnFile.Path);
        return body(shell);
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
