using System.Text.RegularExpressions;

namespace IECode.Core.Projects;

/// <summary>A pinned library version referenced by a project but not installed in the library repository.</summary>
public sealed record MissingLibrary(string Name, string Version, string Vendor, IReadOnlyList<string> Projects, string? Source);

/// <summary>
/// Plans <c>iecode lib restore</c>: the .plcproj files are the source of truth (pinned versions);
/// everything not in the library repository is looked up in source folders
/// (files named <c>&lt;Name&gt;_&lt;Version&gt;.library</c> or <c>.compiled-library</c>).
/// </summary>
public static partial class Restore
{
    [GeneratedRegex(@"^(?<name>.+?)_(?<ver>\d+(?:\.\d+){1,3})\.(?:compiled-)?library$", RegexOptions.IgnoreCase)]
    private static partial Regex LibraryFile();

    /// <summary>Library files in the source folders, by (name, version).</summary>
    public static Dictionary<(string, string), string> ScanSources(IEnumerable<string> folders)
    {
        var found = new Dictionary<(string, string), string>(new NameVersionComparer());
        foreach (var dir in folders.Where(Directory.Exists))
        foreach (var f in Directory.EnumerateFiles(dir, "*library", SearchOption.AllDirectories))
        {
            var m = LibraryFile().Match(Path.GetFileName(f));
            if (m.Success) found.TryAdd((m.Groups["name"].Value, m.Groups["ver"].Value), f);
        }
        return found;
    }

    public static IReadOnlyList<MissingLibrary> Plan(IEnumerable<PlcProjectFile> projects, IReadOnlyList<InstalledLibrary> installed, IEnumerable<string> sourceFolders)
    {
        var sources = ScanSources(sourceFolders);
        var wanted = projects
            .SelectMany(p => p.References.Where(r => r.IsPinned).Select(r => (p.Name, Id: r.Effective)))
            .GroupBy(x => (x.Id.Name.ToLowerInvariant(), x.Id.Version))
            .Select(g => (Id: g.First().Id, Projects: (IReadOnlyList<string>)g.Select(x => x.Name).Distinct().ToList()));

        var missing = new List<MissingLibrary>();
        foreach (var (id, users) in wanted)
        {
            var present = installed.Any(i => i.Name.Equals(id.Name, StringComparison.OrdinalIgnoreCase)
                                             && i.Version == id.Version
                                             && i.Vendor.Equals(id.Vendor, StringComparison.OrdinalIgnoreCase));
            if (present) continue;
            missing.Add(new MissingLibrary(id.Name, id.Version, id.Vendor, users, sources.GetValueOrDefault((id.Name, id.Version))));
        }
        return missing.OrderBy(m => m.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private sealed class NameVersionComparer : IEqualityComparer<(string, string)>
    {
        public bool Equals((string, string) a, (string, string) b) =>
            a.Item1.Equals(b.Item1, StringComparison.OrdinalIgnoreCase) && a.Item2 == b.Item2;
        public int GetHashCode((string, string) x) => HashCode.Combine(x.Item1.ToLowerInvariant(), x.Item2);
    }
}
