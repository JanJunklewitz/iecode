using System.CommandLine;
using System.Text;
using IECode.Automation;
using IECode.Core;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary><c>iecode lib …</c>: save, save-all, list, info, update, outdated, installed, check, restore, install, install-project, uninstall.</summary>
internal static class LibraryCommands
{
    public static Command Create()
    {
        var lib = new Command("lib", "PLC libraries: save (one or all), list, update references, install");
        foreach (var c in new[] { Save(), SaveAll(), List(), Info(), Update(), Outdated(), Installed(), Check(), Restore(), Install(), InstallProject(), Uninstall() })
            lib.Subcommands.Add(c);
        return lib;
    }

    /// <param name="resolvedVersion">For a <c>*</c> reference: the highest installed version (lib list); omitted when null.</param>
    internal static object ToJson(LibraryReference r, string? resolvedVersion = null) => new
    {
        placeholder = r.Placeholder,
        kind = r.Kind,
        name = r.Effective.Name,
        version = r.Effective.Version,
        vendor = r.Effective.Vendor,
        pinned = r.IsPinned,
        defaultResolution = r.Default.ToString(),
        resolution = r.PinnedResolution?.ToString(),
        resolvedVersion,
    };

    private static Argument<string[]> PathsArg(string what) => new("paths")
    {
        Description = $"{what} (.sln, .plcproj or folders; default: current folder)",
        Arity = ArgumentArity.ZeroOrMore,
    };

    private static IReadOnlyList<PlcProjectFile> LoadProjects(string[]? paths)
    {
        var files = PlcProjectFile.Discover(paths is { Length: > 0 } ? paths : ["."]).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (files.Count == 0) throw new IECodeException(ExitCodes.NotFound, "No .plcproj found.");
        return files.Select(PlcProjectFile.Load).ToList();
    }

    // ------------------------------------------------------------------ save

    private static Command Save()
    {
        var sln = new Argument<string?>("solution") { Description = "Solution of the library project (default: current folder)", Arity = ArgumentArity.ZeroOrOne };
        var plc = new Option<string?>("--plc") { Description = "PLC project to save when the solution has several" };
        var compiled = new Option<bool>("--compiled") { Description = "Save as .compiled-library (no source code)" };
        var install = new Option<bool>("--install") { Description = "Also install it in the local library repository" };
        var outDir = new Option<string?>("--out", "-o") { Description = "Output folder (default: dist next to the solution)" };
        var cmd = new Command("save", "Save a PLC project as .library or .compiled-library") { sln, plc, compiled, install, outDir };
        Action(cmd, ctx =>
        {
            var solution = SolutionFile.Find(ctx.Get(sln));
            return SaveLibrary(ctx, solution, ctx.Get(plc), ctx.Get(compiled), ctx.Get(install), ctx.Get(outDir) ?? LibraryExport.DistFolder(solution));
        }, windowsOnly: true);
        return cmd;
    }

    internal static Outcome SaveLibrary(Context ctx, string solution, string? plcName, bool compiled, bool install, string? outDir)
    {
        // File name from the library metadata, e.g. Tc3_MotorLib_1.3.0.library.
        var sln = SolutionFile.Load(solution);
        var meta = sln.PlcProjects.FirstOrDefault(p => plcName is null ? p.IsLibrary : p.Name.Equals(plcName, StringComparison.OrdinalIgnoreCase));
        var baseName = meta is { IsLibrary: true } ? $"{meta.Title}_{meta.ProjectVersion}" : sln.Name;
        var file = Path.Combine(Path.GetFullPath(outDir ?? Path.GetDirectoryName(solution)!), baseName + (compiled ? ".compiled-library" : ".library"));
        if (meta is { IsLibrary: false }) ctx.Log.Warn($"{meta.Name} has no library properties (Title, Company, Version); TwinCAT may refuse to save it.");

        var requested = ChooseVersion(ctx, sln, saves: true, quiet: true).Request;
        // the build the shell ends up with can differ from the request; RepTool must install into the build XAE saved with
        var (export, built) = WithShell(ctx, solution, saves: true, shell => (StageExport(shell, plcName ?? meta?.Name, file), TwinCatVersion.UsedBy(shell.SelectedVersion, requested)));
        var written = FinishExport(ctx, export, install ? built : null);
        ctx.Log.Success($"{written}{(install ? "  (installed)" : "")}");
        return Outcome.Ok(new { file = written, compiled, installed = install, title = meta?.Title, version = meta?.ProjectVersion });
    }

    // ------------------------------------------------------------------ save-all

    private static Command SaveAll()
    {
        var folder = new Argument<string?>("folder") { Description = "Workspace folder (default: current folder)", Arity = ArgumentArity.ZeroOrOne };
        var compiled = new Option<bool>("--compiled") { Description = "Save as .compiled-library (no source code)" };
        var install = new Option<bool>("--install") { Description = "Also install them in the local library repository (in build order, so users see the new versions)" };
        var librariesOnly = new Option<bool>("--libraries-only") { Description = "Only projects with library properties (Title, Company, Version)" };
        var outDir = new Option<string?>("--out", "-o") { Description = "One output folder for all files (default: --dist next to each solution)" };
        var dist = new Option<string>("--dist") { Description = "Folder next to each solution, without --out", DefaultValueFactory = _ => "dist" };
        var failFast = new Option<bool>("--fail-fast") { Description = "Stop at the first project that fails (default: save the others and report)" };
        var dryRun = new Option<bool>("--dry-run") { Description = "Only show what would be saved (any OS)" };
        var cmd = new Command("save-all", "Save every PLC project in the workspace as .library or .compiled-library, with one XAE shell")
            { folder, compiled, install, librariesOnly, outDir, dist, failFast, dryRun };
        Action(cmd, ctx =>
        {
            var w = Workspace.Load(ctx.Get(folder) ?? ".");
            foreach (var u in w.Units.Where(u => u.Solution is null))
                ctx.Log.Warn($"{u.Id} has no .sln; skipped (open it once in XAE to create one).");
            var plan = LibraryExport.Plan(w, ctx.Get(compiled), ctx.Get(outDir), ctx.Get(librariesOnly), ctx.Get(dist));
            if (plan.Count == 0) throw new IECodeException(ExitCodes.NotFound, "No PLC project with a solution found.");
            foreach (var p in plan)
                ctx.Log.Info($"  {p.Unit.Id,-36} → {Path.GetRelativePath(w.Root, p.File)}{(p.Unit.Plc.IsLibrary ? "" : "   (no library properties)")}");
            if (ctx.Get(dryRun)) return Outcome.Ok(new { dryRun = true, items = plan.Select(p => new { unit = p.Unit.Id, file = p.File, isLibrary = p.Unit.Plc.IsLibrary }) });

            if (!OperatingSystem.IsWindows())
                throw new IECodeException(ExitCodes.NotSupportedPlatform, "'iecode lib save-all' needs Windows with TwinCAT XAE.", "Use --dry-run to see the plan on any OS.");

            var results = new List<object>();
            var failed = 0;
            IECodeException? stopped = null;
            var reported = new List<Exception>();
            var notStarted = new List<string>();
            using var session = new ShellSession(ctx, saves: true);
            var step = 0;
            foreach (var p in plan)
            {
                if (stopped is not null) { notStarted.Add(p.Unit.Id); continue; }
                step++;
                try
                {
                    // for every item: the session reuses a healthy shell and replaces one that stopped on a dialog
                    var shell = session.Open(p.Unit.Solution!.Path);
                    var written = FinishExport(ctx, StageExport(shell, p.Unit.Plc.Name, p.File), ctx.Get(install) ? session.Request : null);
                    ctx.Log.Success($"[{step}/{plan.Count}] {p.Unit.Id}: {written}{(ctx.Get(install) ? "  (installed)" : "")}");
                    results.Add(new { unit = p.Unit.Id, file = written, ok = true });
                }
                catch (IECodeException e)
                {
                    failed++;
                    reported.Add(e);
                    ctx.Log.Error($"[{step}/{plan.Count}] {p.Unit.Id}: {e.Message}");
                    results.Add(new { unit = p.Unit.Id, file = p.File, ok = false, error = e.Message });
                    // a timeout (the repository lock or RepTool) would hit every following item too: stop instead of waiting N times,
                    // but hand back what was done so the caller knows where to resume
                    if (ctx.Get(failFast) || e.ExitCode == ExitCodes.Timeout) stopped = e;
                }
            }
            // a dialog during the shutdown is one more failure of the run; the results stay. The shell hands back its dialog
            // failure at any later call, so one an item already failed with is not a second, shutdown failure.
            var shutdown = session.Close();
            if (shutdown is not null && reported.Any(r => Chain(r).Any(x => ReferenceEquals(x, shutdown)))) shutdown = null;
            if (shutdown is not null) ctx.Log.Error($"Closing the shell: {shutdown.Message}");
            var data = new { compiled = ctx.Get(compiled), installed = ctx.Get(install), saved = results.Count - failed, failed, stopped = stopped is not null, notStarted, shutdownError = shutdown?.Message, results };
            if (stopped is not null)
            {
                ctx.Log.Warn($"Stopped after {results.Count} of {plan.Count} project(s); not started: {(notStarted.Count == 0 ? "none" : string.Join(", ", notStarted))}.");
                return new Outcome(stopped.ExitCode, data, stopped.Message, stopped.Hint);
            }
            if (failed > 0)
            {
                ctx.Log.Warn($"{failed} of {plan.Count} project(s) could not be saved; library projects need Title, Company and Version and must compile.");
                return new Outcome(ExitCodes.LibraryFailed, data);
            }
            if (shutdown is not null) return new Outcome(shutdown.ExitCode, data);
            ctx.Log.Success($"{plan.Count} project(s) saved");
            return Outcome.Ok(data);
        });
        return cmd;
    }

    /// <summary>The exception and the ones it wraps.</summary>
    private static IEnumerable<Exception> Chain(Exception e)
    {
        for (Exception? x = e; x is not null; x = x.InnerException) yield return x;
    }

    // ------------------------------------------------------------------ list

    private static Command List()
    {
        var paths = PathsArg("Projects to read");
        var csv = new Option<string?>("--csv") { Description = "Also write the list to a CSV file" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder for the highest installed version of * references (default: TwinCAT's Managed Libraries)" };
        var cmd = new Command("list", "List library references with the version that applies (reads the .plcproj, no TwinCAT needed)") { paths, csv, repo };
        Action(cmd, ctx =>
        {
            var projects = LoadProjects(ctx.Get(paths));
            var installed = StarRepository(ctx, ctx.Get(repo));
            string? Highest(LibraryReference r) => installed is null ? null : LibraryRepository.HighestFor(installed, r);
            foreach (var p in projects)
            {
                ctx.Log.Info($"{p.Name}  ({p.Path})");
                foreach (var r in p.References)
                {
                    var how = r.IsPinned ? "pinned" : Highest(r) is { } h ? $"newest (*), highest installed: {h}" : "newest (*)";
                    ctx.Log.Info($"  {r.Effective.Name,-28} {r.Effective.Version,-12} {r.Effective.Vendor,-28} {how}");
                }
            }
            if (ctx.Get(csv) is { } file)
            {
                var sb = new StringBuilder("Project;Kind;Placeholder;Name;Version;Vendor;Pinned\n");
                foreach (var p in projects)
                foreach (var r in p.References)
                    sb.Append($"{p.Name};{r.Kind};{r.Placeholder};{r.Effective.Name};{r.Effective.Version};{r.Effective.Vendor};{r.IsPinned}\n");
                File.WriteAllText(file, sb.ToString(), new UTF8Encoding(true));
                ctx.Log.Success($"Written {Path.GetFullPath(file)}");
            }
            var unpinned = projects.SelectMany(p => p.References).Count(r => !r.IsPinned);
            if (unpinned > 0) ctx.Log.Warn($"{unpinned} reference(s) resolve to the newest installed version (*); builds aren't reproducible.");
            return Outcome.Ok(projects.Select(p => new { project = p.Name, path = p.Path, references = p.References.Select(r => ToJson(r, Highest(r))) }));
        });
        return cmd;
    }

    /// <summary>
    /// The one repository <c>*</c> references are shown against (as <c>lib outdated</c>): the explicit one, else TwinCAT's
    /// default when it exists; null (no versions shown) when there is none or it cannot be read.
    /// </summary>
    private static IReadOnlyList<InstalledLibrary>? StarRepository(Context ctx, string? explicitPath)
    {
        if (explicitPath is not null) return LibraryRepository.Scan(explicitPath);
        var path = LibraryRepository.DefaultPath(Environment.GetEnvironmentVariable("TWINCAT3DIR"));
        if (path is null || !Directory.Exists(path)) return null;
        try { return LibraryRepository.Scan(path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            ctx.Log.Detail($"Installed versions not shown: {e.Message}");
            return null;
        }
    }

    // ------------------------------------------------------------------ info

    private static Command Info()
    {
        var paths = PathsArg("Library projects");
        var cmd = new Command("info", "Show library metadata (title, company, version) of library projects") { paths };
        Action(cmd, ctx =>
        {
            var libs = LoadProjects(ctx.Get(paths)).Where(p => p.IsLibrary).ToList();
            if (libs.Count == 0) throw new IECodeException(ExitCodes.NotFound, "No library project found (needs Title, Company and ProjectVersion in the .plcproj).");
            foreach (var l in libs) ctx.Log.Info($"{l.Title} {l.ProjectVersion} ({l.Company})  {l.Path}");
            return Outcome.Ok(libs.Select(l => new { name = l.Name, title = l.Title, company = l.Company, version = l.ProjectVersion, path = l.Path }));
        });
        return cmd;
    }

    // ------------------------------------------------------------------ update

    private static Command Update()
    {
        var paths = PathsArg("Projects to update");
        var names = new Option<string[]>("--lib", "-l") { Description = "Library name, e.g. Tc3_MotorLib, or name=version (repeatable)" };
        var to = new Option<string?>("--to") { Description = "New version for the named libraries, latest, or * for always newest (default: newest installed)" };
        var vendor = new Option<string?>("--vendor") { Description = "Only references from this vendor; without --lib: every library of this vendor, each to its newest installed version" };
        var fromLib = new Option<string?>("--from-project") { Description = "Take the version from this library .plcproj (its ProjectVersion); needs exactly one --lib" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder for --to latest (default: TwinCAT's Managed Libraries)" };
        var dryRun = new Option<bool>("--dry-run") { Description = "Only show what would change" };
        var cmd = new Command("update", "Set libraries to a version in every .plcproj below the paths (text edit, keeps formatting)")
            { paths, names, to, vendor, fromLib, repo, dryRun };
        Action(cmd, ctx =>
        {
            var projects = LoadProjects(ctx.Get(paths));
            var items = LibrarySelection.ParseUpdate(ctx.Get(names) ?? [], ctx.Get(to), ctx.Get(vendor), projects, fromProject: ctx.Get(fromLib) is not null);
            string? fromVersion = null;
            if (ctx.Get(fromLib) is { } lp)
            {
                var src = PlcProjectFile.Load(lp);
                fromVersion = src.ProjectVersion ?? throw new IECodeException(ExitCodes.Usage, $"'{lp}' has no ProjectVersion.");
                ctx.Log.Step($"{src.Title ?? src.Name} is at version {fromVersion}");
            }

            // every version is resolved before the first file is written
            IReadOnlyList<InstalledLibrary>? installed = null;
            var resolved = new List<UpdateItem>();
            var notInstalled = new List<string>();
            foreach (var item in items)
            {
                var version = item.Version ?? fromVersion ?? ctx.Get(to);
                if (version is null or "latest")
                {
                    installed ??= LibraryRepository.Scan(RepositoryPath(ctx.Get(repo)));
                    version = LibraryRepository.Newest(installed, item.Library, ctx.Get(vendor))?.Version;
                    if (version is null) { notInstalled.Add(item.Library); continue; }
                    ctx.Log.Step($"Newest installed {item.Library}: {version}");
                }
                resolved.Add(item with { Version = version });
            }
            // all of them at once, so one run shows every library to name or install
            if (notInstalled.Count > 0)
                throw new IECodeException(ExitCodes.NotFound, $"Not installed in the library repository: {string.Join(", ", notInstalled)}; nothing was changed.",
                    "Pass --to <version>, or name the libraries with --lib <name>=<version>.");

            var changes = LibrarySelection.ApplyUpdate(resolved, projects, ctx.Get(vendor), ctx.Get(dryRun));
            foreach (var ch in changes) ctx.Log.Info($"  {ch.Project,-24} {ch.Library} {ch.From} → {ch.To}");
            var projectsChanged = changes.Select(c => c.Project).Distinct().Count();
            var first = resolved[0];
            var target = resolved.Count == 1 ? $"{first.Library} is already at {first.Version}" : "the libraries are already at these versions";
            if (changes.Count == 0) ctx.Log.Success($"Nothing to change: {target} everywhere (or not referenced)");
            else if (ctx.Get(dryRun)) ctx.Log.Info($"{changes.Count} reference(s) in {projectsChanged} project(s) would change");
            else ctx.Log.Success($"{changes.Count} reference(s) in {projectsChanged} project(s) updated{(resolved.Count == 1 ? $" to {first.Version}" : "")}");
            return Outcome.Ok(new
            {
                library = first.Library, version = first.Version, dryRun = ctx.Get(dryRun), changes,
                items = resolved.Select(i => new { library = i.Library, version = i.Version }),
            });
        });
        return cmd;
    }

    // ------------------------------------------------------------------ outdated / installed

    private static string RepositoryPath(string? explicitPath) =>
        explicitPath ?? LibraryRepository.DefaultPath(Environment.GetEnvironmentVariable("TWINCAT3DIR"))
        ?? throw new IECodeException(ExitCodes.NotFound, "Library repository unknown.", "Pass --repository <folder> (TWINCAT3DIR is not set on this machine).");

    private static Command Outdated()
    {
        var paths = PathsArg("Projects to check");
        var repo = new Option<string?>("--repository") { Description = "Library repository folder (default: TwinCAT's Managed Libraries)" };
        var cmd = new Command("outdated", "List pinned references with a newer version in the library repository") { paths, repo };
        Action(cmd, ctx =>
        {
            var installed = LibraryRepository.Scan(RepositoryPath(ctx.Get(repo)));
            var rows = new List<object>();
            foreach (var p in LoadProjects(ctx.Get(paths)))
            foreach (var r in p.References.Where(r => r.IsPinned))
            {
                var newest = LibraryRepository.Newest(installed, r.Effective.Name, r.Effective.Vendor);
                if (newest is null || LibraryRepository.Compare(newest.Version, r.Effective.Version) <= 0) continue;
                ctx.Log.Info($"  {p.Name,-24} {r.Effective.Name,-28} {r.Effective.Version,-12} → {newest.Version}");
                rows.Add(new { project = p.Name, library = r.Effective.Name, vendor = r.Effective.Vendor, installed = r.Effective.Version, latest = newest.Version });
            }
            if (rows.Count == 0) ctx.Log.Success("All pinned references are up to date");
            return Outcome.Ok(rows);
        });
        return cmd;
    }

    private static Command Installed()
    {
        var filter = new Option<string?>("--lib", "-l") { Description = "Only libraries matching this name (* and ? as wildcards, e.g. Tc3_*)" };
        var vendor = new Option<string?>("--vendor") { Description = "Only libraries of this vendor" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder (default: TwinCAT's Managed Libraries)" };
        var cmd = new Command("installed", "List libraries installed in the local library repository") { filter, vendor, repo };
        Action(cmd, ctx =>
        {
            var all = LibrarySelection.Select(LibraryRepository.Scan(RepositoryPath(ctx.Get(repo))), ctx.Get(filter), ctx.Get(vendor), null)
                .OrderBy(i => i.Vendor).ThenBy(i => i.Name).ThenByDescending(i => i.Version, Comparer<string>.Create(LibraryRepository.Compare))
                .ToList();
            foreach (var i in all) ctx.Log.Info($"  {i.Name,-30} {i.Version,-12} {i.Vendor}");
            return Outcome.Ok(all);
        });
        return cmd;
    }

    // ------------------------------------------------------------------ check

    /// <summary>Every library repository TwinCAT may use on this PC (4024 and 4026 can differ).</summary>
    internal static IReadOnlyList<string> DefaultRepositories() =>
        LibraryRepository.Candidates(Environment.GetEnvironmentVariable("TWINCAT3DIR"),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));

    internal static string Describe(ReferenceProblem p) => p.Kind == ReferenceProblemKind.NoVersionInstalled
        ? $"{p.Name} * ({p.Vendor}): no version installed · used by {string.Join(", ", p.Projects)}"
        : $"{p.Name} {p.Version} ({p.Vendor}) not installed · used by {string.Join(", ", p.Projects)}";

    /// <summary>
    /// The library check before a build: warns, never fails. Libraries the command installs itself
    /// (the exports of <paramref name="stages"/>) count as installed for the stages after them.
    /// </summary>
    internal static void Preflight(Context ctx, IEnumerable<PlcProjectFile> projects) =>
        Preflight(ctx, [new BuildStage([.. projects], [])]);

    internal static void Preflight(Context ctx, IReadOnlyList<BuildStage> stages)
    {
        var roots = DefaultRepositories().Where(Directory.Exists).ToList();
        if (roots.Count == 0) { ctx.Log.Warn("Library references not checked: no library repository found."); return; }
        IReadOnlyList<ReferenceProblem> problems;
        try { problems = Core.Projects.Preflight.Problems(stages, LibraryRepository.ScanAll(roots)); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            ctx.Log.Warn($"Library references not checked: {e.Message}");
            return;
        }
        foreach (var p in problems) ctx.Log.Warn(Describe(p));
        if (problems.Count > 0) ctx.Log.Warn("The build will likely fail on these libraries; details: iecode lib check");
    }

    private static Command Check()
    {
        var paths = PathsArg("Projects to check");
        var repos = new Option<string[]>("--repository") { Description = "Library repository folder (repeatable; default: every TwinCAT repository on this PC)" };
        var cmd = new Command("check", "Find library references that cannot resolve before a build: missing pinned versions and * references with no version installed") { paths, repos };
        Action(cmd, ctx =>
        {
            var projects = LoadProjects(ctx.Get(paths));
            var explicitRoots = ctx.Get(repos) is { Length: > 0 } r ? r : null;
            var roots = explicitRoots ?? DefaultRepositories();
            var existing = roots.Where(Directory.Exists).ToList();
            foreach (var root in roots) ctx.Log.Detail($"{(Directory.Exists(root) ? "Scanning" : "Not found")}: {root}");
            if (existing.Count == 0)
                throw new IECodeException(ExitCodes.NotFound, "No library repository found; references not checked.", "Pass the folder with --repository.");
            // named folders must all be scanned; only the automatic candidates may be absent
            var installed = explicitRoots is null ? LibraryRepository.ScanAll(existing) : LibraryRepository.ScanExplicit(explicitRoots);
            var problems = Core.Projects.Restore.Check(projects, installed);
            foreach (var p in problems) ctx.Log.Error(Describe(p));
            if (problems.Count == 0) ctx.Log.Success($"All library references of {projects.Count} project(s) are installed (file check; XAE may still fail to resolve them)");
            return new Outcome(problems.Count == 0 ? ExitCodes.Ok : ExitCodes.NotFound, new { problems, repositories = existing });
        });
        return cmd;
    }

    // ------------------------------------------------------------------ restore

    private static Command Restore()
    {
        var paths = PathsArg("Projects whose pinned libraries to restore");
        var sources = new Option<string[]>("--source", "-s") { Description = "Folder with <Name>_<Version>.library files (repeatable)" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder (default: TwinCAT's Managed Libraries)" };
        var dryRun = new Option<bool>("--dry-run") { Description = "Only show what is missing" };
        var profile = ProfileOption();
        var cmd = new Command("restore", "Install the library versions pinned in the .plcproj files that are missing locally (CI, fresh PCs)") { paths, sources, repo, dryRun, profile };
        Action(cmd, ctx =>
        {
            var projects = LoadProjects(ctx.Get(paths));
            var installed = LibraryRepository.Scan(RepositoryPath(ctx.Get(repo)));
            var missing = Core.Projects.Restore.Plan(projects, installed, ctx.Get(sources) ?? []);
            foreach (var m in missing)
                ctx.Log.Info($"  {m.Name,-28} {m.Version,-12} {(m.Source is null ? "✖ not found in sources" : Path.GetFileName(m.Source))}   ({string.Join(", ", m.Projects)})");
            if (missing.Count == 0) { ctx.Log.Success("All pinned libraries are installed"); return Outcome.Ok(new { missing }); }
            var unresolved = missing.Where(m => m.Source is null).ToList();
            if (ctx.Get(dryRun)) return new Outcome(unresolved.Count == 0 ? ExitCodes.Ok : ExitCodes.NotFound, new { missing });
            if (!OperatingSystem.IsWindows())
                throw new IECodeException(ExitCodes.NotSupportedPlatform, "Installing libraries needs Windows with TwinCAT (RepTool).", "Use --dry-run to check on any OS.");
            var tool = RepToolFor(ctx, ctx.Version, ctx.Get(profile));
            foreach (var m in missing.Where(m => m.Source is not null))
            {
                var code = tool.Install(m.Source!, overwrite: false, ctx.Log);
                if (code != 0) throw new IECodeException(ExitCodes.LibraryFailed, $"Installing {m.Name} {m.Version} failed (RepTool exit {code}).");
                ctx.Log.Success($"Installed {m.Name} {m.Version}");
            }
            if (unresolved.Count > 0)
                throw new IECodeException(ExitCodes.NotFound, $"{unresolved.Count} library version(s) not found in the sources.", "Add a folder with --source, or install them manually.");
            return Outcome.Ok(new { missing });
        });
        return cmd;
    }

    // ------------------------------------------------------------------ install / uninstall (RepTool)

    private static Option<string?> ProfileOption() => new("--profile") { Description = "RepTool profile (default: matching --tc)" };

    private static Command Install()
    {
        var path = new Argument<string>("path") { Description = ".library / .compiled-library file, or a folder (installs all below it)" };
        var overwrite = new Option<bool>("--overwrite") { Description = "Folders: replace versions that are already installed (a single file is always installed over an existing version)" };
        var profile = ProfileOption();
        var cmd = new Command("install", "Install libraries into the local library repository (RepTool)") { path, overwrite, profile };
        Action(cmd, ctx =>
        {
            var tool = RepToolFor(ctx, ctx.Version, ctx.Get(profile));
            ctx.Log.Step($"RepTool profile: {tool.Profile}");
            var code = tool.Install(ctx.Get(path), ctx.Get(overwrite), ctx.Log);
            if (code != 0) throw new IECodeException(ExitCodes.LibraryFailed, $"RepTool failed with exit code {code}.", "Run with --verbose to see its output.");
            ctx.Log.Success($"Installed {ctx.Get(path)}");
            return Outcome.Ok(new { path = Path.GetFullPath(ctx.Get(path)), profile = tool.Profile });
        }, windowsOnly: true);
        return cmd;
    }

    private static Command InstallProject()
    {
        var paths = PathsArg("Projects whose _Libraries folder to install");
        var missingOnly = new Option<bool>("--missing-only") { Description = "Only versions not yet in the library repository (XAE: \"Install Project Libraries (Unknown versions)\")" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder to compare with (default: TwinCAT's Managed Libraries)" };
        var dryRun = new Option<bool>("--dry-run") { Description = "Only show what would be installed (any OS)" };
        var profile = ProfileOption();
        var cmd = new Command("install-project", $"Install the libraries kept in the projects' {ProjectLibraries.FolderName} folder (XAE: \"Install Project Libraries\")")
            { paths, missingOnly, repo, dryRun, profile };
        Action(cmd, ctx =>
        {
            var projects = LoadProjects(ctx.Get(paths));
            var withFolder = projects.Where(p => Directory.Exists(ProjectLibraries.FolderOf(p.Path))).ToList();
            foreach (var p in projects.Except(withFolder))
                ctx.Log.Detail($"{p.Name}: no {ProjectLibraries.FolderName} folder");
            if (withFolder.Count == 0)
                throw new IECodeException(ExitCodes.NotFound, $"No {ProjectLibraries.FolderName} folder next to the .plcproj.",
                    "Create it in XAE with References → Update Project Library Folder…, and commit it with the project.");

            var repoPath = ctx.Get(repo) ?? LibraryRepository.DefaultPath(Environment.GetEnvironmentVariable("TWINCAT3DIR"));
            var installed = repoPath is not null && Directory.Exists(repoPath) ? LibraryRepository.Scan(repoPath) : [];
            var plan = ProjectLibraries.Plan(withFolder, installed, ctx.Get(missingOnly));
            foreach (var l in plan)
                ctx.Log.Info($"  {l.Name,-36} {l.Version,-12} {l.Vendor,-32} {(l.Installed ? "installed" : "missing")}");
            object Data(int done) => new { missingOnly = ctx.Get(missingOnly), dryRun = ctx.Get(dryRun), installed = done, libraries = plan };
            if (plan.Count == 0)
            {
                ctx.Log.Success(ctx.Get(missingOnly) ? "All project libraries are installed" : "The project library folders are empty");
                return Outcome.Ok(Data(0));
            }
            if (ctx.Get(dryRun)) return Outcome.Ok(Data(0));
            if (!OperatingSystem.IsWindows())
                throw new IECodeException(ExitCodes.NotSupportedPlatform, "Installing libraries needs Windows with TwinCAT (RepTool).", "Use --dry-run to check on any OS.");

            var tool = RepToolFor(ctx, ctx.Version, ctx.Get(profile));
            ctx.Log.Step($"RepTool profile: {tool.Profile}");
            var done = 0;
            foreach (var l in plan)
            {
                var code = tool.Install(l.File, overwrite: true, ctx.Log);
                if (code != 0)
                    throw new IECodeException(ExitCodes.LibraryFailed, $"Installing {l.Name} {l.Version} failed (RepTool exit {code}); {done} of {plan.Count} installed.", "Run with --verbose to see its output.");
                done++;
                ctx.Log.Success($"[{done}/{plan.Count}] {l.Name} {l.Version}");
            }
            ctx.Log.Success($"{done} project librar{(done == 1 ? "y" : "ies")} installed");
            return Outcome.Ok(Data(done));
        });
        return cmd;
    }

    private static Command Uninstall()
    {
        var names = new Argument<string[]>("libraries") { Description = "Library names (none with --all)", Arity = ArgumentArity.ZeroOrMore };
        var version = new Option<string>("--version") { Description = "Version to remove, or 'all'", DefaultValueFactory = _ => "all" };
        var vendor = new Option<string>("--vendor") { Description = "Vendor as shown in the library repository", Required = true };
        var all = new Option<bool>("--all") { Description = "Every library of --vendor installed at --version (one version, not 'all'); names come from the library repository" };
        var repo = new Option<string?>("--repository") { Description = "With --all: must be the repository RepTool's profile changes (shown in the output); only needed for an old installation without per-build RepTool folders" };
        var profile = ProfileOption();
        var cmd = new Command("uninstall", "Remove libraries from the local library repository (RepTool)") { names, version, vendor, all, repo, profile };
        Action(cmd, ctx =>
        {
            var given = ctx.Get(names) ?? [];
            string? repoPath = null;
            List<string> items;
            RepTool tool;
            var twinCatDir = Environment.GetEnvironmentVariable("TWINCAT3DIR");
            var programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            if (ctx.Get(all))
            {
                LibrarySelection.CheckUninstallAll(given, ctx.Get(vendor), ctx.Get(version));
                // RepTool's profile decides which repository it deletes from: scan that one, not the one --repository names
                tool = RepToolFor(ctx, ctx.Version, ctx.Get(profile));
                repoPath = LibrarySelection.UninstallRepository(tool.Line, tool.Profile, ctx.Get(repo), twinCatDir, programData, DefaultRepositories().Where(Directory.Exists).ToList());
                ctx.Log.Step($"RepTool profile: {tool.Profile} · library repository: {repoPath}");
                // the version as installed (1.3.1.0), not as typed (1.3.1), so RepTool finds it
                items = [.. LibrarySelection.UninstallAll(LibraryRepository.Scan(repoPath), given, ctx.Get(vendor), ctx.Get(version))
                    .Select(i => $"{i.Name},{i.Version}({ctx.Get(vendor)})")];
            }
            else
            {
                if (given.Length == 0)
                    throw new IECodeException(ExitCodes.Usage, "No library named.", "Name the libraries, or use --all --vendor <vendor> --version <version>.");
                if (ctx.Get(repo) is not null)
                    throw new IECodeException(ExitCodes.Usage, "--repository only applies with --all.", "RepTool's profile (--tc, --profile) decides which repository changes.");
                items = [.. given.Select(n => $"{n},{ctx.Get(version)}({ctx.Get(vendor)})")];
                tool = RepToolFor(ctx, ctx.Version, ctx.Get(profile));
                repoPath = tool.Line is { } line ? LibraryRepository.ForLine(line, twinCatDir, programData) : null;
            }
            if (!ctx.Log.Confirm($"Uninstall {string.Join("; ", items)}{(repoPath is null ? "" : $" from {repoPath}")} (RepTool profile {tool.Profile})?", ctx.Yes)) return new Outcome(ExitCodes.Cancelled, null);
            var code = tool.Uninstall(items, ctx.Log);
            if (code != 0) throw new IECodeException(ExitCodes.LibraryFailed, $"RepTool failed with exit code {code}.", "Run with --verbose to see its output.");
            ctx.Log.Success($"Uninstalled {items.Count} item(s)");
            return Outcome.Ok(new { uninstalled = items, repository = repoPath, profile = tool.Profile });
        }, windowsOnly: true);
        return cmd;
    }
}
