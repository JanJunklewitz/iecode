using System.CommandLine;
using IECode.Automation;
using IECode.Core;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary>Commands on a whole solution: info, build, check, clean, activate, encrypt, user.</summary>
internal static class ProjectCommands
{
    private static Argument<string?> SolutionArg() => new("solution")
    {
        Description = "Solution file, or a folder containing one (default: current folder)",
        Arity = ArgumentArity.ZeroOrOne,
    };

    public static IEnumerable<Command> All() => [Info(), Build(), Check(), Clean(), Activate(), Encrypt(), User()];

    private static Command Info()
    {
        var sln = SolutionArg();
        var installed = new Option<bool>("--installed") { Description = "Also list TwinCAT versions installed on this PC (Windows, starts the XAE shell)" };
        var cmd = new Command("info", "Show TwinCAT and PLC projects, versions and library references") { sln, installed };
        Action(cmd, ctx =>
        {
            var file = SolutionFile.Load(SolutionFile.Find(ctx.Get(sln)));
            ctx.Log.Info($"{file.Name}  ({file.Path})");
            foreach (var tc in file.TwinCatProjects)
            {
                ctx.Log.Info($"  {(tc.IsPlcOnly ? "PLC project" : "TwinCAT project")} {tc.Name}{(tc.TcVersion is null ? "" : $"  · saved with {tc.TcVersion}")}");
                foreach (var plc in tc.PlcProjects)
                {
                    var lib = plc.IsLibrary ? $"  · library {plc.Title} {plc.ProjectVersion} ({plc.Company})" : "";
                    ctx.Log.Info($"    PLC {plc.Name}{lib}  · {plc.References.Count} references");
                }
            }

            string[]? versions = null;
            if (ctx.Get(installed))
            {
                if (!OperatingSystem.IsWindows())
                    throw new IECodeException(ExitCodes.NotSupportedPlatform, "--installed needs Windows with TwinCAT XAE.");
                using var shell = XaeShell.Start(new ShellOptions(ctx.Version, ctx.Get(Globals.ProgId)), ctx.Log);
                versions = [.. shell.InstalledVersions()];
                ctx.Log.Info($"Installed TwinCAT versions ({shell.ProgId}): {string.Join(", ", versions)}");
            }

            return Outcome.Ok(new
            {
                solution = file.Path,
                projects = file.TwinCatProjects.Select(tc => new
                {
                    name = tc.Name,
                    path = tc.Path,
                    plcOnly = tc.IsPlcOnly,
                    tcVersion = tc.TcVersion,
                    plc = tc.PlcProjects.Select(p => new
                    {
                        name = p.Name, path = p.Path, isLibrary = p.IsLibrary, title = p.Title, company = p.Company, version = p.ProjectVersion,
                        references = p.References.Select(LibraryCommands.ToJson),
                    }),
                }),
                installedVersions = versions,
            });
        });
        return cmd;
    }

    private static Command Build()
    {
        var sln = SolutionArg();
        var platforms = new Option<string[]>("--platform", "-p") { Description = "Target platform, e.g. \"TwinCAT RT (x64)\"; repeat for several (default: active platform)" };
        var clean = new Option<bool>("--clean") { Description = "Clean before building" };
        var configuration = new Option<string?>("--configuration", "-c") { Description = "Solution configuration, e.g. Release" };
        var cmd = new Command("build", "Build the solution with TwinCAT XAE and report compiler messages") { sln, platforms, clean, configuration };
        Action(cmd, ctx =>
        {
            var path = SolutionFile.Find(ctx.Get(sln));
            var results = WithShell(ctx, path, shell =>
            {
                if (ctx.Get(configuration) is { } c) shell.SelectConfiguration(c);
                var list = new List<BuildResult>();
                var requested = ctx.Get(platforms) is { Length: > 0 } p ? p.Cast<string?>() : [null];
                foreach (var platform in requested)
                {
                    if (ctx.Get(clean)) shell.Clean();
                    var r = shell.Build(platform);
                    list.Add(r);
                    if (r.Ok) ctx.Log.Success($"{r.Platform}: build ok · {r.Warnings} warning(s) · {r.Seconds:0.0} s");
                    else ctx.Log.Error($"{r.Platform}: build failed · {r.Errors} error(s) · {r.Warnings} warning(s)");
                }
                return list;
            });
            return new Outcome(results.All(r => r.Ok) ? ExitCodes.Ok : ExitCodes.BuildFailed, new { solution = path, builds = results });
        }, windowsOnly: true);
        return cmd;
    }

    private static Command Check()
    {
        var sln = SolutionArg();
        var cmd = new Command("check", "Run 'Check all objects' on every PLC project (faster than a build)") { sln };
        Action(cmd, ctx =>
        {
            var path = SolutionFile.Find(ctx.Get(sln));
            var (errors, warnings) = WithShell(ctx, path, shell => shell.CheckAllObjects());
            if (errors == 0) ctx.Log.Success($"Check ok · {warnings} warning(s)");
            else ctx.Log.Error($"Check found {errors} error(s), {warnings} warning(s)");
            return new Outcome(errors == 0 ? ExitCodes.Ok : ExitCodes.BuildFailed, new { solution = path, errors, warnings });
        }, windowsOnly: true);
        return cmd;
    }

    private static Command Clean()
    {
        var path = new Argument<string?>("path") { Description = "Solution, or folder for --artifacts (default: current folder)", Arity = ArgumentArity.ZeroOrOne };
        var artifacts = new Option<bool>("--artifacts") { Description = "Delete generated _CompileInfo folders below the path (no TwinCAT needed)" };
        var boot = new Option<bool>("--boot") { Description = "With --artifacts: also delete _Boot folders" };
        var dryRun = new Option<bool>("--dry-run") { Description = "With --artifacts: only list what would be deleted" };
        var cmd = new Command("clean", "Clean the solution in XAE, or delete generated folders with --artifacts") { path, artifacts, boot, dryRun };
        Action(cmd, ctx =>
        {
            if (ctx.Get(artifacts))
            {
                var root = Path.GetFullPath(ctx.Get(path) ?? ".");
                if (File.Exists(root)) root = Path.GetDirectoryName(root)!;
                var folders = Artifacts.Find(root, ctx.Get(boot) ? Artifacts.AllFolders : Artifacts.DefaultFolders);
                var bytes = folders.Sum(Artifacts.Size);
                foreach (var f in folders) ctx.Log.Info($"  {Path.GetRelativePath(root, f)}");
                if (folders.Count == 0) { ctx.Log.Success("Nothing to clean"); return Outcome.Ok(new { deleted = Array.Empty<string>() }); }
                if (ctx.Get(dryRun)) { ctx.Log.Info($"{folders.Count} folder(s), {bytes / 1048576.0:0.0} MB would be deleted"); return Outcome.Ok(new { wouldDelete = folders, bytes }); }
                if (!ctx.Log.Confirm($"Delete {folders.Count} folder(s) ({bytes / 1048576.0:0.0} MB)?", ctx.Yes))
                    return new Outcome(ExitCodes.Cancelled, null);
                foreach (var f in folders) Directory.Delete(f, recursive: true);
                ctx.Log.Success($"Deleted {folders.Count} folder(s), {bytes / 1048576.0:0.0} MB");
                return Outcome.Ok(new { deleted = folders, bytes });
            }

            if (!OperatingSystem.IsWindows())
                throw new IECodeException(ExitCodes.NotSupportedPlatform, "'iecode clean' needs Windows with TwinCAT XAE.", "Use 'iecode clean --artifacts' on any OS.");
            var sln = SolutionFile.Find(ctx.Get(path));
            WithShell(ctx, sln, shell => { shell.Clean(); return 0; });
            ctx.Log.Success("Solution cleaned");
            return Outcome.Ok(new { solution = sln });
        });
        return cmd;
    }

    private static Command Activate()
    {
        var sln = SolutionArg();
        var targets = new Option<string[]>("--target", "-t") { Description = "AMS NetId of the target, or 'local'; repeat for several (default: local)" };
        var noRestart = new Option<bool>("--no-restart") { Description = "Activate only, don't restart TwinCAT in run mode" };
        var project = new Option<string?>("--project") { Description = "TwinCAT project to activate when the solution has several" };
        var noBuild = new Option<bool>("--no-build") { Description = "Skip the build before activating" };
        var cmd = new Command("activate", "Build and activate the configuration on one or more targets") { sln, targets, noRestart, project, noBuild };
        Action(cmd, ctx =>
        {
            var path = SolutionFile.Find(ctx.Get(sln));
            var ids = (ctx.Get(targets) is { Length: > 0 } t ? t : ["local"]).Select(AmsNetId.Parse).Distinct().ToList();
            var restart = !ctx.Get(noRestart);
            var remote = ids.Where(i => !i.IsLocal).ToList();
            if (remote.Count > 0 && !ctx.Log.Confirm(
                    $"Activate{(restart ? " and restart TwinCAT" : "")} on {string.Join(", ", remote)}?", ctx.Yes))
                return new Outcome(ExitCodes.Cancelled, null);

            var done = WithShell(ctx, path, shell =>
            {
                if (!ctx.Get(noBuild))
                {
                    var b = shell.Build(null);
                    if (!b.Ok) throw new IECodeException(ExitCodes.BuildFailed, $"Build failed with {b.Errors} error(s); nothing was activated.");
                }
                var list = new List<string>();
                foreach (var id in ids)
                {
                    shell.Activate(id, restart, ctx.Get(project));
                    ctx.Log.Success($"Activated on {(id.IsLocal ? "local system" : id.ToString())}{(restart ? " · TwinCAT in run mode" : "")}");
                    list.Add(id.ToString());
                }
                return list;
            });
            return Outcome.Ok(new { solution = path, targets = done, restarted = restart });
        }, windowsOnly: true);
        return cmd;
    }

    private static Command Encrypt()
    {
        var sln = SolutionArg();
        var protect = new Option<string[]>("--protect")
        {
            Description = "Object protection: \"<tree path>[,encrypted=true][,signed=true][,level=<name>]\"; repeat for several items",
        };
        var compiled = new Option<bool>("--compiled-library") { Description = "Instead: save the PLC project as .compiled-library (no source)" };
        var plc = new Option<string?>("--plc") { Description = "With --compiled-library: PLC project to save" };
        var outDir = new Option<string?>("--out") { Description = "With --compiled-library: output folder (default: next to the solution)" };
        var cmd = new Command("encrypt", "Protect project objects (encryption, signing, protection level with a user DB) or ship a compiled library")
            { sln, protect, compiled, plc, outDir };
        cmd.Validators.Add(r =>
        {
            var hasProtect = r.GetValue(protect) is { Length: > 0 };
            if (hasProtect == r.GetValue(compiled))
                r.AddError("Use either --protect <spec> (repeatable) or --compiled-library.");
        });
        Action(cmd, ctx =>
        {
            var path = SolutionFile.Find(ctx.Get(sln));
            if (ctx.Get(compiled))
                return LibraryCommands.SaveLibrary(ctx, path, ctx.Get(plc), compiled: true, install: false, ctx.Get(outDir));

            var specs = ctx.Get(protect).Select(ProtectionSpec.Parse).ToList();
            if (ctx.Get(Globals.UserDb) is null && specs.Any(s => s.Level is not null))
                ctx.Log.Warn("Protection levels come from the selected user database; pass --userdb if the project doesn't have one yet.");
            if (!ctx.Log.Confirm("Protected objects can only be opened by users of the user database afterwards. Keep a backup. Continue?", ctx.Yes))
                return new Outcome(ExitCodes.Cancelled, null);

            WithShell(ctx, path, shell =>
            {
                foreach (var s in specs) shell.SetProtection(s);
                return 0;
            });
            ctx.Log.Success($"Protection applied to {specs.Count} item(s)");
            return Outcome.Ok(new { solution = path, items = specs });
        }, windowsOnly: true);
        return cmd;
    }

    private static Command User()
    {
        var cmd = new Command("user", "TwinCAT user management (Security Management)");
        var status = new Command("status", "Show the active TwinCAT user (after --userdb / --user / --credential)");
        Action(status, ctx =>
        {
            using var shell = XaeShell.Start(new ShellOptions(ctx.Version, ctx.Get(Globals.ProgId)), ctx.Log);
            if (ctx.Get(Globals.UserDb) is { } db) shell.SelectUserDb(db);
            if (Credentials(ctx) is ({ } user, { } password)) shell.Login(user, password);
            var active = shell.ActiveUser();
            ctx.Log.Info(active is { Length: > 0 } ? $"Active user: {active}" : "No user logged in");
            return Outcome.Ok(new { activeUser = active });
        }, windowsOnly: true);
        cmd.Subcommands.Add(status);
        return cmd;
    }
}
