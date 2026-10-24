using System.CommandLine;
using System.Text;
using IECode.Cli.Commands;

namespace IECode.Cli;

internal static class Program
{
    // COM automation of the XAE shell requires a single-threaded apartment; command actions run on this thread.
    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        var root = new RootCommand("iecode – TwinCAT engineering from the command line: build, activate, libraries, protection.\n" +
                                   "Commands that drive TwinCAT XAE need Windows; file-based commands work on any OS.");
        Globals.AddTo(root);
        foreach (var c in ProjectCommands.All()) root.Subcommands.Add(c);
        root.Subcommands.Add(LibraryCommands.Create());
        root.Subcommands.Add(WorkspaceCommands.Create());
        root.Subcommands.Add(TargetCommands.Target());
        root.Subcommands.Add(TargetCommands.Ads());
        root.Subcommands.Add(DoctorCommand.Create());

        var parse = root.Parse(args);
        var code = parse.Invoke();
        return parse.Errors.Count > 0 ? Core.ExitCodes.Usage : code;
    }
}
