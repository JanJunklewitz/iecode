namespace IECode.Core.Projects;

/// <summary>A library file kept in a PLC project's <c>_Libraries</c> folder, and whether that version is installed.</summary>
public sealed record ProjectLibrary(string Name, string Version, string Vendor, string File, bool Installed, IReadOnlyList<string> Projects);

/// <summary>
/// The project library folder: TwinCAT XAE keeps copies of every library a PLC project uses (directly or
/// indirectly) in <c>_Libraries</c> next to the .plcproj, laid out like the repository as
/// <c>&lt;vendor&gt;/&lt;library&gt;/&lt;version&gt;/&lt;file&gt;</c>. XAE's "Install Project Libraries" installs them
/// all; "Install Project Libraries (Unknown versions)" only the versions missing locally.
/// </summary>
public static class ProjectLibraries
{
    public const string FolderName = "_Libraries";

    /// <summary>The project library folder of a .plcproj (it may not exist).</summary>
    public static string FolderOf(string plcProjectFile) =>
        System.IO.Path.Combine(System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(plcProjectFile))!, FolderName);

    /// <summary>Library files in a project library folder; empty when the folder does not exist.</summary>
    public static IReadOnlyList<(string Name, string Version, string Vendor, string File)> Scan(string folder)
    {
        var list = new List<(string, string, string, string)>();
        if (!Directory.Exists(folder)) return list;
        foreach (var vendor in Directory.EnumerateDirectories(folder))
        foreach (var lib in Directory.EnumerateDirectories(vendor))
        foreach (var ver in Directory.EnumerateDirectories(lib))
        {
            var version = System.IO.Path.GetFileName(ver);
            if (!char.IsDigit(version.FirstOrDefault())) continue;
            var file = Directory.EnumerateFiles(ver).Where(IsLibraryFile).Order(StringComparer.OrdinalIgnoreCase).FirstOrDefault();
            if (file is null) continue;
            list.Add((System.IO.Path.GetFileName(lib), version, System.IO.Path.GetFileName(vendor), file));
        }
        return list;
    }

    /// <summary>.library, .compiled-library and their format variants (e.g. .compiled-library-ge33).</summary>
    public static bool IsLibraryFile(string file)
    {
        var ext = System.IO.Path.GetExtension(file);
        return ext.Equals(".library", StringComparison.OrdinalIgnoreCase)
               || ext.StartsWith(".compiled-library", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The libraries of the projects' <c>_Libraries</c> folders, one entry per vendor/name/version, each marked
    /// as installed or not. With <paramref name="missingOnly"/> only the ones not in the repository.
    /// </summary>
    public static IReadOnlyList<ProjectLibrary> Plan(IEnumerable<PlcProjectFile> projects, IReadOnlyList<InstalledLibrary> installed, bool missingOnly)
    {
        var byKey = new Dictionary<string, (string Name, string Version, string Vendor, string File, List<string> Projects)>(StringComparer.OrdinalIgnoreCase);
        foreach (var p in projects)
        foreach (var l in Scan(FolderOf(p.Path)))
        {
            var key = $"{l.Vendor}\n{l.Name}\n{l.Version}";
            if (!byKey.TryGetValue(key, out var e)) byKey[key] = e = (l.Name, l.Version, l.Vendor, l.File, []);
            if (!e.Projects.Contains(p.Name, StringComparer.OrdinalIgnoreCase)) e.Projects.Add(p.Name);
        }
        return byKey.Values
            .Select(e => new ProjectLibrary(e.Name, e.Version, e.Vendor, e.File, IsInstalled(installed, e.Name, e.Version, e.Vendor), e.Projects))
            .Where(l => !missingOnly || !l.Installed)
            .OrderBy(l => l.Vendor, StringComparer.OrdinalIgnoreCase).ThenBy(l => l.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(l => l.Version, Comparer<string>.Create(LibraryRepository.Compare))
            .ToList();
    }

    private static bool IsInstalled(IReadOnlyList<InstalledLibrary> installed, string name, string version, string vendor) =>
        installed.Any(i => i.Name.Equals(name, StringComparison.OrdinalIgnoreCase)
                           && i.Version == version
                           && i.Vendor.Equals(vendor, StringComparison.OrdinalIgnoreCase));
}
