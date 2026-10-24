using System.Text;
using System.Text.RegularExpressions;

namespace IECode.Core.Projects;

public enum UnitGroup { Library, Application, Standalone }

/// <summary>One PLC project in a workspace and the solution it belongs to (if any).</summary>
public sealed record Unit(string Id, UnitGroup Group, PlcProjectFile Plc, SolutionFile? Solution);

/// <summary>A library reference from one unit to a library project in the same workspace.</summary>
public sealed record Link(string From, string To, LibraryReference Reference, bool IsWorkspace);

/// <summary>
/// All TwinCAT solutions and loose PLC projects below a folder: libraries, applications, standalone
/// projects, and the library dependencies between them. Same rules as the VS Code extension.
/// </summary>
public sealed partial class Workspace
{
    public required string Root { get; init; }
    public required IReadOnlyList<Unit> Units { get; init; }
    public required IReadOnlyList<Link> Links { get; init; }

    private static readonly EnumerationOptions Deep = new() { RecurseSubdirectories = true, MaxRecursionDepth = 6, IgnoreInaccessible = true };

    public static Workspace Load(string root)
    {
        root = Path.GetFullPath(root);
        if (!Directory.Exists(root)) throw new IECodeException(ExitCodes.NotFound, $"Folder '{root}' not found.");
        var units = new List<Unit>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var sln in Directory.EnumerateFiles(root, "*.sln", Deep).Where(f => !Skip(root, f)).Order(StringComparer.OrdinalIgnoreCase))
        {
            var s = SolutionFile.Load(sln);
            if (s.TwinCatProjects.Count == 0) continue;
            var lib = s.PlcProjects.Any(p => p.IsLibrary);
            foreach (var p in s.PlcProjects)
            {
                seen.Add(p.Path);
                units.Add(new Unit($"{s.Name}/{p.Name}", lib ? UnitGroup.Library : UnitGroup.Application, p, s));
            }
        }
        foreach (var f in Directory.EnumerateFiles(root, "*.plcproj", Deep).Where(f => !Skip(root, f)).Order(StringComparer.OrdinalIgnoreCase))
        {
            if (!seen.Add(Path.GetFullPath(f))) continue;
            var p = PlcProjectFile.Load(f);
            var id = p.Name;
            for (var i = 2; units.Any(u => u.Id == id); i++) id = $"{p.Name}#{i}";
            units.Add(new Unit(id, p.IsLibrary ? UnitGroup.Library : UnitGroup.Standalone, p, null));
        }
        return new Workspace { Root = root, Units = units, Links = LinksOf(units) };
    }

    private static bool Skip(string root, string file) =>
        Path.GetRelativePath(root, file).Split(Path.DirectorySeparatorChar)
            .SkipLast(1).Any(seg => seg.StartsWith('_') || seg.StartsWith('.') || seg is "bin" or "obj" or "node_modules" or "out");

    private static List<Link> LinksOf(IReadOnlyList<Unit> units)
    {
        var libs = units.Where(u => u.Plc.IsLibrary).GroupBy(u => u.Plc.Title!, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        var links = new List<Link>();
        foreach (var u in units)
        foreach (var r in u.Plc.References)
        {
            if (!libs.TryGetValue(r.Effective.Name, out var lib) || lib.Id == u.Id) continue;
            var v = r.Effective.Version;
            links.Add(new Link(u.Id, lib.Id, r, v == "*" || v == lib.Plc.ProjectVersion));
        }
        return links;
    }

    public Unit this[string id] => Units.First(u => u.Id == id);

    /// <summary>Unit ids in build order (libraries first). Throws on cycles.</summary>
    public IReadOnlyList<string> BuildOrder(ISet<string>? only = null)
    {
        var ids = Units.Select(u => u.Id).Where(id => only is null || only.Contains(id)).Order(StringComparer.Ordinal).ToList();
        var state = new Dictionary<string, bool>();   // false = visiting, true = done
        var order = new List<string>();
        void Visit(string id, List<string> trail)
        {
            if (state.TryGetValue(id, out var done))
            {
                if (done) return;
                throw new IECodeException(ExitCodes.Failed, $"Library cycle: {string.Join(" → ", trail.Append(id))}");
            }
            state[id] = false;
            foreach (var dep in Links.Where(l => l.From == id && (only is null || only.Contains(l.To))).Select(l => l.To).Distinct())
                Visit(dep, [.. trail, id]);
            state[id] = true;
            order.Add(id);
        }
        foreach (var id in ids) Visit(id, []);
        return order;
    }

    /// <summary>The changed units plus everything that uses them through a workspace link.</summary>
    public ISet<string> Affected(IEnumerable<string> changed)
    {
        var result = new HashSet<string>(changed);
        bool grew;
        do
        {
            grew = false;
            foreach (var l in Links.Where(l => l.IsWorkspace && result.Contains(l.To) && !result.Contains(l.From)))
                grew |= result.Add(l.From);
        } while (grew);
        return result;
    }

    /// <summary>Unit that owns a file (deepest .plcproj folder containing it).</summary>
    public Unit? UnitOf(string file)
    {
        var f = Path.GetFullPath(Path.IsPathRooted(file) ? file : Path.Combine(Root, file));
        return Units
            .Where(u => f.StartsWith(Path.GetDirectoryName(u.Plc.Path)! + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        || f.Equals(u.Plc.Path, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(u => u.Plc.Path.Length)
            .FirstOrDefault();
    }

    public string ToMermaid()
    {
        static string Id(string s) => "n" + Regex.Replace(s, "[^A-Za-z0-9]", "_");
        var sb = new StringBuilder("flowchart TD\n");
        foreach (var u in Units)
            sb.AppendLine(u.Plc.IsLibrary ? $"  {Id(u.Id)}[(\"{u.Plc.Title} {u.Plc.ProjectVersion}\")]" : $"  {Id(u.Id)}[\"{u.Id}\"]");
        foreach (var l in Links)
            sb.AppendLine($"  {Id(l.To)} {(l.IsWorkspace ? "-->" : "-.->")}|{(l.IsWorkspace ? "workspace" : "pinned " + l.Reference.Effective.Version)}| {Id(l.From)}");
        return sb.ToString();
    }

    // ------------------------------------------------------------------ versions

    [GeneratedRegex(@"(<ProjectVersion>)\s*([^<]*?)\s*(</ProjectVersion>)")]
    private static partial Regex ProjectVersionTag();

    /// <summary>Next version for a bump: major | minor | patch, or an explicit version.</summary>
    public static string Bump(string current, string bump)
    {
        if (Regex.IsMatch(bump, @"^\d+(\.\d+){1,3}$")) return bump;
        var parts = current.Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).ToList();
        while (parts.Count < 3) parts.Add(0);
        switch (bump.ToLowerInvariant())
        {
            case "major": parts[0]++; parts[1] = 0; parts[2] = 0; break;
            case "minor": parts[1]++; parts[2] = 0; break;
            case "patch": parts[2]++; break;
            default: throw new IECodeException(ExitCodes.Usage, $"Invalid bump '{bump}'.", "Use major, minor, patch or a version like 1.4.0.");
        }
        for (var i = 3; i < parts.Count; i++) parts[i] = 0;
        return string.Join('.', parts);
    }

    /// <summary>Writes a new ProjectVersion into a library .plcproj, keeping the rest of the file identical.</summary>
    public static void SetProjectVersion(string plcproj, string version)
    {
        var bytes = File.ReadAllBytes(plcproj);
        var bom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var text = Encoding.UTF8.GetString(bytes, bom ? 3 : 0, bytes.Length - (bom ? 3 : 0));
        if (!ProjectVersionTag().IsMatch(text)) throw new IECodeException(ExitCodes.LibraryFailed, $"'{plcproj}' has no <ProjectVersion>.");
        var updated = ProjectVersionTag().Replace(text, m => m.Groups[1].Value + version + m.Groups[3].Value, 1);
        var output = new UTF8Encoding(false).GetBytes(updated);
        File.WriteAllBytes(plcproj, bom ? [0xEF, 0xBB, 0xBF, .. output] : output);
    }
}
