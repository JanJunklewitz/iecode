using System.CommandLine;
using System.Text;
using IECode.Core;
using IECode.Core.Projects;
using static IECode.Cli.Runner;

namespace IECode.Cli.Commands;

/// <summary><c>iecode io …</c>: IO links (mappings) of TwinCAT projects and their changes in git history. Any OS.</summary>
internal static class IoCommands
{
    private static Argument<string?> PathArg() => new("path") { Description = ".tsproj, .sln or folder (default: current folder)", Arity = ArgumentArity.ZeroOrOne };

    public static Command Create()
    {
        var io = new Command("io", "IO links: list the variable ↔ channel mappings and compare them with git history");
        io.Subcommands.Add(Links());
        io.Subcommands.Add(Diff());
        return io;
    }

    private static Option<bool> FullOption() => new("--full") { Description = "Show full tree paths instead of the short form" };

    private static Command Links()
    {
        var path = PathArg();
        var at = new Option<string?>("--at") { Description = "Git commit / branch / tag to read (default: working copy)" };
        var csv = new Option<string?>("--csv") { Description = "Also write the list to a CSV file" };
        var full = FullOption();
        var yaml = new Option<bool>("--yaml") { Description = "Show the links as a hardware tree (device › box › terminal › channel) as YAML" };
        var cmd = new Command("links", "List the IO links of TwinCAT projects") { path, at, csv, full, yaml };
        Action(cmd, ctx =>
        {
            var result = new List<object>();
            var all = new List<IoLink>();
            foreach (var tsproj in IoLinks.FindProjects(ctx.Get(path)))
            {
                if (ctx.Get(yaml))
                {
                    var snapshot = IoTree.Load(tsproj, ctx.Get(at));
                    foreach (var w in snapshot.Warnings) ctx.Log.Warn(w);
                    all.AddRange(snapshot.Links.Select(IoLinks.ToIoLink));
                    var text = IoTree.ToYaml(snapshot, $"# IO links of {Path.GetFileName(tsproj)} ({ctx.Get(at) ?? "working copy"}): {snapshot.Links.Count} link(s)");
                    foreach (var line in text.TrimEnd('\n').Split('\n')) ctx.Log.Info(line);
                    result.Add(new { project = tsproj, yaml = text });
                    continue;
                }
                var links = IoLinks.Load(tsproj, ctx.Get(at));
                all.AddRange(links);
                ctx.Log.Info($"{Path.GetFileNameWithoutExtension(tsproj)}  ({links.Count} link(s))");
                foreach (var l in links)
                    ctx.Log.Info(ctx.Get(full) ? $"  {l.Variable}  ↔  {l.Io}" : $"  {IoLinks.Short(l.Variable, 2),-48} ↔  {IoLinks.Short(l.Io)}");
                result.Add(new { project = tsproj, links });
            }
            if (ctx.Get(csv) is { } file)
            {
                // --yaml collects the links in tree order; the CSV is sorted either way
                File.WriteAllText(file, IoLinks.ToCsv(all.OrderBy(l => l.Variable, StringComparer.Ordinal).ThenBy(l => l.Io, StringComparer.Ordinal).ToList()), new UTF8Encoding(true));
                ctx.Log.Success($"Written {Path.GetFullPath(file)}");
            }
            return Outcome.Ok(result);
        });
        return cmd;
    }

    private static Command Diff()
    {
        var path = PathArg();
        var from = new Option<string>("--from") { Description = "Older version: git commit / branch / tag, e.g. HEAD~5 or origin/main", Required = true };
        var to = new Option<string?>("--to") { Description = "Newer version (default: working copy)" };
        var csv = new Option<string?>("--csv") { Description = "Also write the changes to a CSV file" };
        var fail = new Option<bool>("--fail-on-change") { Description = "Exit with code 18 if any link changed (for CI checks)" };
        var full = FullOption();
        var cmd = new Command("diff", "Compare IO links between two versions: added, removed, moved (other channel), changed (size / offsets)") { path, from, to, csv, fail, full };
        Action(cmd, ctx =>
        {
            var result = new List<object>();
            var allChanges = new List<IoChange>();
            string S(string? p, int n) => ctx.Get(full) ? p ?? "" : IoLinks.Short(p, n);
            foreach (var tsproj in IoLinks.FindProjects(ctx.Get(path)))
            {
                var before = IoLinks.Load(tsproj, ctx.Get(from));
                var after = IoLinks.Load(tsproj, ctx.Get(to));
                var changes = IoLinks.Diff(before, after);
                allChanges.AddRange(changes);
                ctx.Log.Info($"{Path.GetFileNameWithoutExtension(tsproj)}: {before.Count} → {after.Count} link(s), {changes.Count} change(s)  ({ctx.Get(from)} → {ctx.Get(to) ?? "working copy"})");
                foreach (var c in changes)
                {
                    var what = c.Kind switch
                    {
                        IoChangeKind.Added => $"→ {S(c.After, 3)}",
                        IoChangeKind.Removed => $"was {S(c.Before, 3)}",
                        IoChangeKind.Moved => $"{S(c.Before, 3)} → {S(c.After, 3)}",
                        _ => $"{S(c.Before, 3)}: {c.Details}",
                    };
                    ctx.Log.Info($"  {c.Kind.ToString().ToLowerInvariant(),-8} {S(c.Variable, 2),-44} {what}");
                }
                result.Add(new { project = tsproj, before = before.Count, after = after.Count, changes });
            }
            if (ctx.Get(csv) is { } file)
            {
                File.WriteAllText(file, IoLinks.ToCsv(allChanges), new UTF8Encoding(true));
                ctx.Log.Success($"Written {Path.GetFullPath(file)}");
            }
            if (allChanges.Count == 0) ctx.Log.Success("No IO link changes");
            return new Outcome(allChanges.Count > 0 && ctx.Get(fail) ? ExitCodes.IoLinksChanged : ExitCodes.Ok, result);
        });
        return cmd;
    }
}
