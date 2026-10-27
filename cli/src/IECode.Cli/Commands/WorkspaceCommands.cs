using System.CommandLine;
using System.Diagnostics;
using IECode.Automation;
using IECode.Core;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary><c>iecode ws …</c>: several libraries and applications in one folder (monorepo or checkout of several repos).</summary>
internal static class WorkspaceCommands
{
    private static Argument<string?> FolderArg() => new("folder") { Description = "Workspace folder (default: current folder)", Arity = ArgumentArity.ZeroOrOne };

    public static Command Create()
    {
        var ws = new Command("ws", "Workspace with several libraries and PLC projects: list, graph, build in order, release a library");
        ws.Subcommands.Add(List());
        ws.Subcommands.Add(Graph());
        ws.Subcommands.Add(Build());
        ws.Subcommands.Add(Release());
        return ws;
    }

    private static object Json(Workspace w) => new
    {
        root = w.Root,
        units = w.Units.Select(u => new { id = u.Id, group = u.Group, plc = u.Plc.Path, solution = u.Solution?.Path, isLibrary = u.Plc.IsLibrary, title = u.Plc.Title, version = u.Plc.ProjectVersion }),
        links = w.Links.Select(l => new { from = l.From, to = l.To, library = l.Reference.Effective.Name, version = l.Reference.Effective.Version, workspace = l.IsWorkspace }),
        buildOrder = w.BuildOrder(),
    };

    private static Command List()
    {
        var folder = FolderArg();
        var cmd = new Command("list", "Libraries, applications and standalone PLC projects in the workspace") { folder };
        Action(cmd, ctx =>
        {
            var w = Workspace.Load(ctx.Get(folder) ?? ".");
            foreach (var g in w.Units.GroupBy(u => u.Group).OrderBy(g => g.Key))
            {
                ctx.Log.Info(g.Key switch { UnitGroup.Library => "LIBRARIES", UnitGroup.Application => "APPLICATIONS", _ => "STANDALONE PLC" });
                foreach (var u in g)
                    ctx.Log.Info($"  {u.Id,-36} {(u.Plc.IsLibrary ? $"{u.Plc.Title} {u.Plc.ProjectVersion}" : ""),-24} {Path.GetRelativePath(w.Root, u.Solution?.Path ?? u.Plc.Path)}");
            }
            return Outcome.Ok(Json(w));
        });
        return cmd;
    }

    private static Command Graph()
    {
        var folder = FolderArg();
        var format = new Option<string>("--format") { Description = "text | mermaid", DefaultValueFactory = _ => "text" };
        format.AcceptOnlyFromAmong("text", "mermaid");
        var cmd = new Command("graph", "Library dependencies and build order") { folder, format };
        Action(cmd, ctx =>
        {
            var w = Workspace.Load(ctx.Get(folder) ?? ".");
            if (ctx.Get(format) == "mermaid") ctx.Log.Info(w.ToMermaid());
            else
            {
                foreach (var l in w.Links.OrderBy(l => l.To).ThenBy(l => l.From))
                    ctx.Log.Info($"  {l.To,-32} {(l.IsWorkspace ? "──▶" : "┄┄▶")} {l.From,-32} {(l.IsWorkspace ? "workspace" : "pinned " + l.Reference.Effective.Version)}");
                ctx.Log.Info($"Build order: {string.Join(" → ", w.BuildOrder())}");
            }
            return Outcome.Ok(Json(w));
        });
        return cmd;
    }

    /// <summary>Changed files since a git ref (committed and uncommitted).</summary>
    private static IEnumerable<string> GitChanges(string root, string since)
    {
        IEnumerable<string> Run(params string[] args)
        {
            var psi = new ProcessStartInfo("git") { WorkingDirectory = root, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var p = Process.Start(psi) ?? throw new IECodeException(ExitCodes.Failed, "Starting git failed.");
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            if (p.ExitCode != 0) throw new IECodeException(ExitCodes.Failed, $"git {string.Join(' ', args)} failed: {p.StandardError.ReadToEnd().Trim()}");
            return output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }
        var top = Run("rev-parse", "--show-toplevel").First();
        return Run("diff", "--name-only", $"{Git.CheckRef(since)}...HEAD")
            .Concat(Run("status", "--porcelain").Select(l => l.Length > 3 ? l[3..].Trim('"') : l))
            .Select(f => Path.GetFullPath(Path.Combine(top, f)));
    }

    private static Command Build()
    {
        var folder = FolderArg();
        var affected = new Option<bool>("--affected") { Description = "Only projects affected by changes (see --since / --changed) and their dependents" };
        var since = new Option<string?>("--since") { Description = "With --affected: git ref to compare against, e.g. origin/main (default: uncommitted changes)" };
        var changed = new Option<string[]>("--changed") { Description = "With --affected: changed files or project ids instead of git" };
        var dryRun = new Option<bool>("--dry-run") { Description = "Only show what would be built" };
        var cmd = new Command("build", "Build all (or affected) projects in dependency order; workspace libraries are saved + installed before their users") { folder, affected, since, changed, dryRun };
        Action(cmd, ctx =>
        {
            var w = Workspace.Load(ctx.Get(folder) ?? ".");
            ISet<string>? only = null;
            if (ctx.Get(affected))
            {
                var inputs = ctx.Get(changed) is { Length: > 0 } c ? c : GitChanges(w.Root, ctx.Get(since) ?? "HEAD");
                var units = inputs.Select(x => w.Units.FirstOrDefault(u => u.Id == x)?.Id ?? w.UnitOf(x)?.Id).OfType<string>().Distinct().ToList();
                ctx.Log.Step(units.Count == 0 ? "No changed projects" : $"Changed: {string.Join(", ", units)}");
                only = w.Affected(units);
            }
            var order = w.BuildOrder(only).Select(id => w[id]).ToList();
            var skipped = order.Where(u => u.Solution is null).ToList();
            foreach (var u in skipped) ctx.Log.Warn($"{u.Id} has no .sln; skipped (open it once in XAE to create one).");
            order = order.Where(u => u.Solution is not null).ToList();
            ctx.Log.Step(order.Count == 0 ? "Nothing to build" : $"Build order: {string.Join(" → ", order.Select(u => u.Id))}");
            if (ctx.Get(dryRun) || order.Count == 0) return Outcome.Ok(new { order = order.Select(u => u.Id), dryRun = ctx.Get(dryRun) });

            if (!OperatingSystem.IsWindows())
                throw new IECodeException(ExitCodes.NotSupportedPlatform, "'iecode ws build' needs Windows with TwinCAT XAE.", "Use --dry-run to see the build order on any OS.");

            var results = new List<object>();
            using var shell = StartShell(ctx);
            var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var step = 0;
            foreach (var u in order)
            {
                step++;
                if (!done.Add(u.Solution!.Path)) continue;
                shell.OpenSolution(u.Solution.Path);
                var r = shell.Build(null);
                results.Add(new { unit = u.Id, r.Ok, r.Errors, r.Warnings, r.Seconds });
                if (!r.Ok)
                {
                    ctx.Log.Error($"[{step}/{order.Count}] {u.Id}: build failed ({r.Errors} error(s)); stopping.");
                    return new Outcome(ExitCodes.BuildFailed, new { order = order.Select(x => x.Id), results });
                }
                ctx.Log.Success($"[{step}/{order.Count}] {u.Id}: build ok · {r.Seconds:0.0} s");
                var usedHere = w.Links.Any(l => l.To == u.Id && l.IsWorkspace && order.Any(o => o.Id == l.From));
                if (u.Plc.IsLibrary && usedHere)
                {
                    var file = Path.Combine(Path.GetDirectoryName(u.Solution.Path)!, "dist", $"{u.Plc.Title}_{u.Plc.ProjectVersion}.library");
                    shell.SaveAsLibrary(u.Plc.Name, file, install: true);
                    ctx.Log.Success($"        {u.Plc.Title} {u.Plc.ProjectVersion} saved and installed for its users");
                }
            }
            return Outcome.Ok(new { order = order.Select(u => u.Id), results });
        });
        return cmd;
    }

    private static Command Release()
    {
        var lib = new Argument<string>("library") { Description = "Library title (e.g. Tc3_MotorLib) or unit id" };
        var folder = new Option<string?>("--folder") { Description = "Workspace folder (default: current folder)" };
        var bump = new Option<string>("--bump") { Description = "major | minor | patch | <version>", DefaultValueFactory = _ => "patch" };
        var updateDependents = new Option<bool>("--update-dependents") { Description = "Set the new version in projects that use the library through a workspace link" };
        var includePinned = new Option<bool>("--include-pinned") { Description = "With --update-dependents: also update projects pinned to other versions" };
        var noSave = new Option<bool>("--no-save") { Description = "Only change versions; don't save/install the library (any OS)" };
        var cmd = new Command("release", "Bump a library's version, save + install it, and update the projects that use it") { lib, folder, bump, updateDependents, includePinned, noSave };
        Action(cmd, ctx =>
        {
            var w = Workspace.Load(ctx.Get(folder) ?? ".");
            var name = ctx.Get(lib);
            var unit = w.Units.FirstOrDefault(u => u.Plc.IsLibrary && (u.Plc.Title!.Equals(name, StringComparison.OrdinalIgnoreCase) || u.Id.Equals(name, StringComparison.OrdinalIgnoreCase)))
                ?? throw new IECodeException(ExitCodes.NotFound, $"Library project '{name}' not found in the workspace.",
                    "Libraries: " + string.Join(", ", w.Units.Where(u => u.Plc.IsLibrary).Select(u => u.Plc.Title)));
            var from = unit.Plc.ProjectVersion!;
            var to = Workspace.Bump(from, ctx.Get(bump));
            Workspace.SetProjectVersion(unit.Plc.Path, to);
            ctx.Log.Success($"{unit.Plc.Title}: {from} → {to}");

            string? file = null;
            if (!ctx.Get(noSave))
            {
                if (!OperatingSystem.IsWindows())
                    throw new IECodeException(ExitCodes.NotSupportedPlatform, "Saving the library needs Windows with TwinCAT XAE.", "Use --no-save to only change versions.");
                if (unit.Solution is null) throw new IECodeException(ExitCodes.NotFound, $"{unit.Id} has no .sln to save from.");
                var target = Path.Combine(Path.GetDirectoryName(unit.Solution.Path)!, "dist", $"{unit.Plc.Title}_{to}.library");
                file = WithShell(ctx, unit.Solution.Path, shell => shell.SaveAsLibrary(unit.Plc.Name, target, install: true));
                ctx.Log.Success($"Saved and installed {file}");
            }

            var changes = new List<ReferenceChange>();
            if (ctx.Get(updateDependents))
            {
                foreach (var l in w.Links.Where(l => l.To == unit.Id))
                {
                    var user = w[l.From];
                    var pinnedElsewhere = l.Reference.Effective.Version != from && l.Reference.Effective.Version != "*";
                    if (l.Reference.Effective.Version == "*") { ctx.Log.Detail($"{user.Id} uses * (newest): nothing to change"); continue; }
                    if (pinnedElsewhere && !ctx.Get(includePinned)) { ctx.Log.Info($"  {user.Id,-32} pinned to {l.Reference.Effective.Version}: not changed (--include-pinned)"); continue; }
                    var c = user.Plc.SetLibraryVersion(unit.Plc.Title!, to);
                    foreach (var ch in c) ctx.Log.Info($"  {user.Id,-32} {ch.From} → {ch.To}");
                    changes.AddRange(c);
                }
            }
            return Outcome.Ok(new { library = unit.Plc.Title, from, to, file, changes });
        });
        return cmd;
    }
}
