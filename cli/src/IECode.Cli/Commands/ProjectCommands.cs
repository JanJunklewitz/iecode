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
                    var stars = plc.References.Count(r => !r.IsPinned);
                    ctx.Log.Info(plc.IsEncrypted ? $"    PLC {plc.Name}  · encrypted"
                        : $"    PLC {plc.Name}{lib}  · {plc.References.Count} references{(stars > 0 ? $" ({stars} resolve with *)" : "")}");
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
                        name = p.Name, path = p.Path, encrypted = p.IsEncrypted, isLibrary = p.IsLibrary, title = p.Title, company = p.Company, version = p.ProjectVersion,
                        references = p.References.Select(r => LibraryCommands.ToJson(r)),
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
        var noSave = new Option<bool>("--no-save")
        {
            Description = "Don't save the solution before building, and close it without saving (XAE may still save a project it changes while building)",
        };
        var isolate = new Option<bool>("--isolate")
        {
            Description = "Build in a temporary copy of the repository (ignored files included), so the working tree stays as it is",
        };
        var keepIsolated = new Option<bool>("--keep-isolated") { Description = "With --isolate: keep the copy and print its path" };
        var isolateDir = new Option<string?>("--isolate-dir") { Description = "With --isolate: parent folder of the copy (default: %TEMP%\\iecode\\b)" };
        var copyTmc = new Option<bool>("--copy-tmc") { Description = "With --isolate: copy the .tmc files the build wrote back next to the PLC projects" };
        var cmd = new Command("build", "Build the solution with TwinCAT XAE and report compiler messages")
            { sln, platforms, clean, configuration, noSave, isolate, keepIsolated, isolateDir, copyTmc };
        cmd.Validators.Add(r =>
        {
            if (!r.GetValue(isolate) && (r.GetValue(keepIsolated) || r.GetValue(isolateDir) is not null || r.GetValue(copyTmc)))
                r.AddError("--keep-isolated, --isolate-dir and --copy-tmc need --isolate.");
        });
        Action(cmd, ctx =>
        {
            var path = SolutionFile.Find(ctx.Get(sln));
            LibraryCommands.Preflight(ctx, SolutionFile.Load(path).PlcProjects);
            var folder = Path.GetDirectoryName(path)!;
            var root = Isolation.RootOf(path);
            var dir = ctx.Get(isolateDir) ?? Isolation.DefaultDir;
            WarnLongPath(ctx, folder, root, Isolation.CopyRootFor(root, dir, Environment.ProcessId), ctx.Get(isolate));
            if (ctx.Get(isolate)) return BuildIsolated(root, dir);

            var save = !ctx.Get(noSave);
            var before = WorkingTreeSnapshot.Take(folder);
            IReadOnlyList<string>? changed = null;
            List<BuildResult> results;
            var opening = false;
            // a build counts as saving for the line guard even with --no-save: XAE writes a project it changed while
            // building (spike, R35). The report also runs after a failed or broken-off build and after an open that
            // failed half-way: from the start of the open on, the shell may have written files. An error result then
            // carries the list as well (PartialData).
            try { results = WithShell(ctx, path, saves: true, shell => BuildAll(shell, save), discard: !save, beforeOpen: () => opening = true); }
            finally
            {
                if (opening)
                {
                    changed = ReportChanges(ctx, before, folder);
                    ctx.Log.PartialData = new { solution = path, changedFiles = changed };
                }
            }
            return new Outcome(BuildOutcome.ExitCode(results.Select(r => r.Ok)), new { solution = path, builds = results, changedFiles = changed });

            Outcome BuildIsolated(string root, string dir)
            {
                if (Isolation.OutsideRoot(path, root) is { Count: > 0 } outside)
                    throw new IECodeException(ExitCodes.Usage,
                        $"--isolate copies '{root}', but the solution has references or projects a copy cannot contain (outside of it, absolute, unresolvable or of an unsupported type):\n  " + string.Join("\n  ", outside),
                        "Build without --isolate, or make the references relative and inside the repository. A copy is no sandbox: only .plcproj, .tsproj and .tspproj projects are accepted.");
                var sw = System.Diagnostics.Stopwatch.StartNew();
                var copy = Isolation.Create(path, dir);
                copy.Keep = ctx.Get(keepIsolated);
                ctx.Log.Step($"Isolated copy: {copy.CopyRoot} ({copy.Files} files, {sw.Elapsed.TotalSeconds:0.0} s)");
                IReadOnlyList<string> tmc = [], tmcConflicts = [];
                try
                {
                    ctx.Log.MapDiagnostic = d => Isolation.MapBack(d, copy);
                    var tmcBefore = ctx.Get(copyTmc) ? Isolation.TmcSnapshot(copy) : null;
                    // the copy is thrown away: nothing to save, and no line change can reach the working tree
                    var list = WithShell(ctx, copy.Solution, saves: false, shell => BuildAll(shell, save: false));
                    if (tmcBefore is not null)
                    {
                        // only the result of a successful build is published; a failed one may leave half-written files
                        if (list.Any(r => !r.Ok)) ctx.Log.Warn("No .tmc file copied back: the build failed.");
                        else
                        {
                            var copied = Isolation.CopyTmcBack(copy, tmcBefore);
                            (tmc, tmcConflicts) = (copied.Written, copied.Conflicts);
                            ctx.Log.Info($"Copied {tmc.Count} .tmc file(s) back");
                            foreach (var f in tmc) ctx.Log.Detail($"  {f}");
                            foreach (var f in tmcConflicts) ctx.Log.Warn($"Not copied back, it changed in the repository during the build: {f}");
                        }
                    }
                    return new Outcome(BuildOutcome.ExitCode(list.Select(r => r.Ok)),
                        new { solution = path, builds = list, isolatedCopy = copy.Keep ? copy.CopyRoot : null, tmcCopied = tmc, tmcSkipped = tmcConflicts });
                }
                finally
                {
                    ctx.Log.MapDiagnostic = null;
                    if (copy.Keep) ctx.Log.Info($"Kept the isolated copy: {copy.CopyRoot}");
                    else if (!copy.TryDelete(TimeSpan.FromSeconds(15)))
                        ctx.Log.Warn($"Could not delete the isolated copy {copy.CopyRoot} (files still in use); a later --isolate build of the same repository removes it after 24 h, or delete it yourself.");
                }
            }

            List<BuildResult> BuildAll(XaeShell shell, bool save)
            {
                if (ctx.Get(configuration) is { } c) shell.SelectConfiguration(c);
                var list = new List<BuildResult>();
                var requested = ctx.Get(platforms) is { Length: > 0 } p ? p.Cast<string?>() : [null];
                foreach (var platform in requested)
                {
                    if (ctx.Get(clean)) shell.Clean();
                    var r = shell.Build(platform, save);
                    list.Add(r);
                    if (r.Ok) ctx.Log.Success($"{r.Platform}: build ok · {r.Warnings} warning(s) · {r.Seconds:0.0} s");
                    else ctx.Log.Error($"{r.Platform}: build failed{(r.StaticAnalysisOnly ? " on static analysis only" : "")} · {r.Errors} error(s) · {r.Warnings} warning(s)");
                }
                return list;
            }
        }, windowsOnly: true);
        return cmd;
    }

    /// <summary>Warns about a project file path long enough to make the hidden shell show dialogs.</summary>
    internal static void WarnLongPath(Context ctx, string folder, string root, string copyRoot, bool isolating)
    {
        // an isolated build copies the whole root, so that is what to scan then
        if (PathLength.Longest(isolating ? root : folder) is not { } longest) return;
        if (PathLength.Warning(longest, root, copyRoot, isolating) is { } warning) ctx.Log.Warn(warning);
    }

    /// <summary>Prints how many files the build changed in git status (the list with -v); null without git or a repository.</summary>
    private static IReadOnlyList<string>? ReportChanges(Context ctx, WorkingTreeSnapshot? before, string folder)
    {
        if (before is null || WorkingTreeSnapshot.Take(folder) is not { } after) return null;
        var changed = after.ChangedSince(before);
        ctx.Log.Info($"Git status changes: {changed.Count} file(s){(changed.Count > 0 && !ctx.Log.Verbose ? " (-v lists them)" : "")}");
        foreach (var f in changed) ctx.Log.Detail($"  {f}");
        return changed;
    }

    private static Command Check()
    {
        var sln = SolutionArg();
        var cmd = new Command("check", "Run 'Check all objects' on every PLC project (faster than a build)") { sln };
        Action(cmd, ctx =>
        {
            var path = SolutionFile.Find(ctx.Get(sln));
            LibraryCommands.Preflight(ctx, SolutionFile.Load(path).PlcProjects);
            var (errors, warnings, ok) = WithShell(ctx, path, saves: false, shell => shell.CheckAllObjects());
            if (ok) ctx.Log.Success($"Check ok · {warnings} warning(s)");
            else ctx.Log.Error($"Check failed · {errors} error(s) · {warnings} warning(s)");
            return new Outcome(BuildOutcome.ExitCode([ok]), new { solution = path, errors, warnings });
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
            WithShell(ctx, sln, saves: false, shell => { shell.Clean(); return 0; });
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

            var done = WithShell(ctx, path, saves: true, shell =>
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

            WithShell(ctx, path, saves: true, shell =>
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
