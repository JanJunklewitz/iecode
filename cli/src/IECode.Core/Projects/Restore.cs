using System.Text.RegularExpressions;

namespace IECode.Core.Projects;

/// <summary>A pinned library version referenced by a project but not installed in the library repository.</summary>
public sealed record MissingLibrary(string Name, string Version, string Vendor, IReadOnlyList<string> Projects, string? Source);

public enum ReferenceProblemKind { VersionMissing, NoVersionInstalled }

/// <summary>A library reference that cannot resolve. <see cref="Version"/> is <c>*</c> for <see cref="ReferenceProblemKind.NoVersionInstalled"/>.</summary>
public sealed record ReferenceProblem(string Name, string Version, string Vendor, ReferenceProblemKind Kind, IReadOnlyList<string> Projects);

/// <summary>
/// The library check before a build. Warns only: the line chosen at start may use another repository than the ones
/// scanned. Libraries the command builds and installs itself (<c>ws build</c>) count as installed, by exact identity.
/// </summary>
public static class Preflight
{
    public static IReadOnlyList<ReferenceProblem> Problems(
        IEnumerable<PlcProjectFile> projects, IReadOnlyList<InstalledLibrary> installed, IReadOnlyCollection<LibraryId> willInstall) =>
        Restore.Check(projects, [.. installed, .. willInstall.Select(l => new InstalledLibrary(l.Name, l.Version, l.Vendor, ""))]);
}

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

    /// <summary>
    /// References that cannot resolve: a pinned version not installed, or a <c>*</c> reference with no version of the
    /// library installed at all. Groups by name, version and vendor (a different vendor is a different library).
    /// </summary>
    public static IReadOnlyList<ReferenceProblem> Check(IEnumerable<PlcProjectFile> projects, IReadOnlyList<InstalledLibrary> installed)
    {
        var wanted = projects
            .SelectMany(p => p.References.Select(r => (p.Name, Id: r.Effective)))
            .GroupBy(x => (x.Id.Name.ToLowerInvariant(), x.Id.Version, x.Id.Vendor.ToLowerInvariant()))
            .Select(g => (g.First().Id, Projects: (IReadOnlyList<string>)g.Select(x => x.Name).Distinct().ToList()));

        var problems = new List<ReferenceProblem>();
        foreach (var (id, users) in wanted)
        {
            if (id.IsNewest)
            {
                if (LibraryRepository.Newest(installed, id.Name, id.Vendor) is null)
                    problems.Add(new ReferenceProblem(id.Name, "*", id.Vendor, ReferenceProblemKind.NoVersionInstalled, users));
                continue;
            }
            var present = installed.Any(i => i.Name.Equals(id.Name, StringComparison.OrdinalIgnoreCase)
                                             && i.Version == id.Version
                                             && i.Vendor.Equals(id.Vendor, StringComparison.OrdinalIgnoreCase));
            if (!present) problems.Add(new ReferenceProblem(id.Name, id.Version, id.Vendor, ReferenceProblemKind.VersionMissing, users));
        }
        return problems.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ThenBy(p => p.Version, StringComparer.Ordinal).ToList();
    }

    private sealed class NameVersionComparer : IEqualityComparer<(string, string)>
    {
        public bool Equals((string, string) a, (string, string) b) =>
            a.Item1.Equals(b.Item1, StringComparison.OrdinalIgnoreCase) && a.Item2 == b.Item2;
        public int GetHashCode((string, string) x) => HashCode.Combine(x.Item1.ToLowerInvariant(), x.Item2);
    }
}
