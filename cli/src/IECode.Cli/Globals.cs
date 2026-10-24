using System.CommandLine;
using IECode.Core;

namespace IECode.Cli;

/// <summary>Options available on every command.</summary>
internal static class Globals
{
    public static readonly Option<bool> Json = new("--json") { Description = "Machine-readable output: one JSON document on stdout", Recursive = true };
    public static readonly Option<bool> Verbose = new("--verbose", "-v") { Description = "Show details", Recursive = true };
    public static readonly Option<bool> NoColor = new("--no-color") { Description = "Disable colored output", Recursive = true };
    public static readonly Option<bool> Yes = new("--yes", "-y") { Description = "Confirm questions (scripts and CI)", Recursive = true };
    public static readonly Option<bool> Pause = new("--pause") { Description = "Wait for Enter before exiting (when started by double-click)", Recursive = true };

    public static readonly Option<string> Tc = new("--tc")
    {
        Description = "TwinCAT version: 4024 | 4026 | exact build like 4024.66 | auto (version saved in the project, else default)",
        DefaultValueFactory = _ => "auto",
        Recursive = true,
    };
    public static readonly Option<string?> ProgId = new("--prog-id") { Description = "DTE ProgID of the shell, e.g. TcXaeShell.DTE.17.0 (default: picked from --tc)", Recursive = true };
    public static readonly Option<bool> Visible = new("--visible") { Description = "Show the XAE shell window", Recursive = true };
    public static readonly Option<bool> ShowUi = new("--show-ui") { Description = "Allow XAE message boxes (default: suppressed)", Recursive = true };
    public static readonly Option<int?> Timeout = new("--timeout") { Description = "Abort build/activation after N seconds (default 1800)", Recursive = true };

    public static readonly Option<string?> UserDb = new("--userdb") { Description = "TwinCAT user database (.tcudb) to select before opening the project", Recursive = true };
    public static readonly Option<string?> User = new("--user") { Description = "Log in to TwinCAT user management (password from IECODE_PASSWORD or prompt)", Recursive = true };
    public static readonly Option<string?> Credential = new("--credential") { Description = "Log in with a generic Windows credential (Credential Manager target name)", Recursive = true };

    public static void AddTo(RootCommand root)
    {
        foreach (var o in new Option[] { Json, Verbose, NoColor, Yes, Pause, Tc, ProgId, Visible, ShowUi, Timeout, UserDb, User, Credential })
            root.Options.Add(o);
    }
}

/// <summary>Everything a command needs: parsed global options and the reporter.</summary>
internal sealed record Context(ParseResult Parse, Reporter Log)
{
    public TwinCatVersion Version => TwinCatVersion.Parse(Parse.GetValue(Globals.Tc));
    public bool Yes => Parse.GetValue(Globals.Yes);
    public T Get<T>(Option<T> o) => Parse.GetValue(o)!;
    public T Get<T>(Argument<T> a) => Parse.GetValue(a)!;
}
