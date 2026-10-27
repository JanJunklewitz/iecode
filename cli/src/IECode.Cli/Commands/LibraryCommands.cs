using System.CommandLine;
using System.Text;
using IECode.Automation;
using IECode.Core;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary><c>iecode lib …</c>: save, save-all, list, info, update, outdated, installed, install, uninstall.</summary>
internal static class LibraryCommands
{
    public static Command Create()
    {
        var lib = new Command("lib", "PLC libraries: save (one or all), list, update references, install");
        foreach (var c in new[] { Save(), SaveAll(), List(), Info(), Update(), Outdated(), Installed(), Restore(), Install(), Uninstall() })
            lib.Subcommands.Add(c);
        return lib;
    }

    internal static object ToJson(LibraryReference r) => new
    {
        placeholder = r.Placeholder,
        kind = r.Kind,
        name = r.Effective.Name,
        version = r.Effective.Version,
        vendor = r.Effective.Vendor,
        pinned = r.IsPinned,
        defaultResolution = r.Default.ToString(),
        resolution = r.PinnedResolution?.ToString(),
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
        var outDir = new Option<string?>("--out", "-o") { Description = "Output folder (default: next to the solution)" };
        var cmd = new Command("save", "Save a PLC project as .library or .compiled-library") { sln, plc, compiled, install, outDir };
        Action(cmd, ctx => SaveLibrary(ctx, SolutionFile.Find(ctx.Get(sln)), ctx.Get(plc), ctx.Get(compiled), ctx.Get(install), ctx.Get(outDir)), windowsOnly: true);
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

        var written = WithShell(ctx, solution, shell => shell.SaveAsLibrary(plcName ?? meta?.Name, file, install));
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
            using var shell = StartShell(ctx);
            string? open = null;
            var step = 0;
            foreach (var p in plan)
            {
                step++;
                try
                {
                    if (!string.Equals(open, p.Unit.Solution!.Path, StringComparison.OrdinalIgnoreCase))
                    {
                        shell.OpenSolution(p.Unit.Solution.Path);
                        open = p.Unit.Solution.Path;
                    }
                    var written = shell.SaveAsLibrary(p.Unit.Plc.Name, p.File, ctx.Get(install));
                    ctx.Log.Success($"[{step}/{plan.Count}] {p.Unit.Id}: {written}{(ctx.Get(install) ? "  (installed)" : "")}");
                    results.Add(new { unit = p.Unit.Id, file = written, ok = true });
                }
                catch (IECodeException e) when (!ctx.Get(failFast))
                {
                    failed++;
                    ctx.Log.Error($"[{step}/{plan.Count}] {p.Unit.Id}: {e.Message}");
                    results.Add(new { unit = p.Unit.Id, file = p.File, ok = false, error = e.Message });
                }
            }
            var data = new { compiled = ctx.Get(compiled), installed = ctx.Get(install), saved = plan.Count - failed, failed, results };
            if (failed > 0)
            {
                ctx.Log.Warn($"{failed} of {plan.Count} project(s) could not be saved; library projects need Title, Company and Version and must compile.");
                return new Outcome(ExitCodes.LibraryFailed, data);
            }
            ctx.Log.Success($"{plan.Count} project(s) saved");
            return Outcome.Ok(data);
        });
        return cmd;
    }

    // ------------------------------------------------------------------ list

    private static Command List()
    {
        var paths = PathsArg("Projects to read");
        var csv = new Option<string?>("--csv") { Description = "Also write the list to a CSV file" };
        var cmd = new Command("list", "List library references with the version that applies (reads the .plcproj, no TwinCAT needed)") { paths, csv };
        Action(cmd, ctx =>
        {
            var projects = LoadProjects(ctx.Get(paths));
            foreach (var p in projects)
            {
                ctx.Log.Info($"{p.Name}  ({p.Path})");
                foreach (var r in p.References)
                    ctx.Log.Info($"  {r.Effective.Name,-28} {r.Effective.Version,-12} {r.Effective.Vendor,-28} {(r.IsPinned ? "pinned" : "newest (*)")}");
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
            return Outcome.Ok(projects.Select(p => new { project = p.Name, path = p.Path, references = p.References.Select(ToJson) }));
        });
        return cmd;
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
        var name = new Option<string>("--lib", "-l") { Description = "Library name, e.g. Tc3_MotorLib", Required = true };
        var to = new Option<string?>("--to") { Description = "New version, or * for always newest (default: newest installed with --repository, else required)" };
        var vendor = new Option<string?>("--vendor") { Description = "Only references from this vendor" };
        var fromLib = new Option<string?>("--from-project") { Description = "Take the version from this library .plcproj (its ProjectVersion)" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder for --to latest (default: TwinCAT's Managed Libraries)" };
        var dryRun = new Option<bool>("--dry-run") { Description = "Only show what would change" };
        var cmd = new Command("update", "Set a library to a version in every .plcproj below the paths (text edit, keeps formatting)")
            { paths, name, to, vendor, fromLib, repo, dryRun };
        Action(cmd, ctx =>
        {
            var lib = ctx.Get(name);
            var version = ctx.Get(to);
            if (ctx.Get(fromLib) is { } lp)
            {
                var src = PlcProjectFile.Load(lp);
                version = src.ProjectVersion ?? throw new IECodeException(ExitCodes.Usage, $"'{lp}' has no ProjectVersion.");
                ctx.Log.Step($"{src.Title ?? src.Name} is at version {version}");
            }
            if (version is null or "latest")
            {
                var installed = LibraryRepository.Scan(RepositoryPath(ctx.Get(repo)));
                version = LibraryRepository.Newest(installed, lib, ctx.Get(vendor))?.Version
                    ?? throw new IECodeException(ExitCodes.NotFound, $"{lib} is not installed in the library repository.", "Pass --to <version>.");
                ctx.Log.Step($"Newest installed {lib}: {version}");
            }

            var changes = new List<ReferenceChange>();
            foreach (var p in LoadProjects(ctx.Get(paths)))
            {
                var c = p.SetLibraryVersion(lib, version, ctx.Get(vendor), ctx.Get(dryRun));
                foreach (var ch in c) ctx.Log.Info($"  {ch.Project,-24} {ch.Library} {ch.From} → {ch.To}");
                changes.AddRange(c);
            }
            var projectsChanged = changes.Select(c => c.Project).Distinct().Count();
            if (changes.Count == 0) ctx.Log.Success($"Nothing to change: {lib} is already at {version} everywhere (or not referenced)");
            else if (ctx.Get(dryRun)) ctx.Log.Info($"{changes.Count} reference(s) in {projectsChanged} project(s) would change");
            else ctx.Log.Success($"{changes.Count} reference(s) in {projectsChanged} project(s) updated to {version}");
            return Outcome.Ok(new { library = lib, version, dryRun = ctx.Get(dryRun), changes });
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
        var filter = new Option<string?>("--lib", "-l") { Description = "Only this library" };
        var repo = new Option<string?>("--repository") { Description = "Library repository folder (default: TwinCAT's Managed Libraries)" };
        var cmd = new Command("installed", "List libraries installed in the local library repository") { filter, repo };
        Action(cmd, ctx =>
        {
            var all = LibraryRepository.Scan(RepositoryPath(ctx.Get(repo)))
                .Where(i => ctx.Get(filter) is not { } f || i.Name.Equals(f, StringComparison.OrdinalIgnoreCase))
                .OrderBy(i => i.Vendor).ThenBy(i => i.Name).ThenByDescending(i => i.Version, Comparer<string>.Create(LibraryRepository.Compare))
                .ToList();
            foreach (var i in all) ctx.Log.Info($"  {i.Name,-30} {i.Version,-12} {i.Vendor}");
            return Outcome.Ok(all);
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
            var tool = RepTool.Find(ctx.Version, ctx.Get(profile));
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
        var overwrite = new Option<bool>("--overwrite") { Description = "Replace versions that are already installed" };
        var profile = ProfileOption();
        var cmd = new Command("install", "Install libraries into the local library repository (RepTool)") { path, overwrite, profile };
        Action(cmd, ctx =>
        {
            var tool = RepTool.Find(ctx.Version, ctx.Get(profile));
            ctx.Log.Step($"RepTool profile: {tool.Profile}");
            var code = tool.Install(ctx.Get(path), ctx.Get(overwrite), ctx.Log);
            if (code != 0) throw new IECodeException(ExitCodes.LibraryFailed, $"RepTool failed with exit code {code}.", "Run with --verbose to see its output.");
            ctx.Log.Success($"Installed {ctx.Get(path)}");
            return Outcome.Ok(new { path = Path.GetFullPath(ctx.Get(path)), profile = tool.Profile });
        }, windowsOnly: true);
        return cmd;
    }

    private static Command Uninstall()
    {
        var names = new Argument<string[]>("libraries") { Description = "Library names", Arity = ArgumentArity.OneOrMore };
        var version = new Option<string>("--version") { Description = "Version to remove, or 'all'", DefaultValueFactory = _ => "all" };
        var vendor = new Option<string>("--vendor") { Description = "Vendor as shown in the library repository", Required = true };
        var profile = ProfileOption();
        var cmd = new Command("uninstall", "Remove libraries from the local library repository (RepTool)") { names, version, vendor, profile };
        Action(cmd, ctx =>
        {
            var items = ctx.Get(names).Select(n => $"{n},{ctx.Get(version)}({ctx.Get(vendor)})").ToList();
            if (!ctx.Log.Confirm($"Uninstall {string.Join("; ", items)}?", ctx.Yes)) return new Outcome(ExitCodes.Cancelled, null);
            var tool = RepTool.Find(ctx.Version, ctx.Get(profile));
            var code = tool.Uninstall(items, ctx.Log);
            if (code != 0) throw new IECodeException(ExitCodes.LibraryFailed, $"RepTool failed with exit code {code}.", "Run with --verbose to see its output.");
            ctx.Log.Success($"Uninstalled {items.Count} item(s)");
            return Outcome.Ok(new { uninstalled = items });
        }, windowsOnly: true);
        return cmd;
    }
}
