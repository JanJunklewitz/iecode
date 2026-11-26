namespace IECode.Core.Projects;

/// <summary>A library version installed in a TwinCAT library repository.</summary>
public sealed record InstalledLibrary(string Name, string Version, string Vendor, string Path);

/// <summary>
/// Reads a TwinCAT library repository folder ("Managed Libraries"), laid out as
/// <c>&lt;vendor&gt;/&lt;library&gt;/&lt;version&gt;/</c>. Names are stored lower-case on disk. A version counts as installed
/// when its folder holds a library file; that says the files are there, not that XAE can resolve the library.
/// </summary>
public static class LibraryRepository
{
    /// <summary>Default repository of a TwinCAT installation: the first of <see cref="Candidates"/> that exists, else the first one.</summary>
    public static string? DefaultPath(string? twinCatDir)
    {
        var candidates = Candidates(twinCatDir, Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
        return candidates.FirstOrDefault(Directory.Exists) ?? candidates.FirstOrDefault();
    }

    /// <summary>
    /// Where TwinCAT keeps its system repository: <c>%ProgramData%\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries</c>
    /// since 4026 (shared by all builds of the Remote Manager), <c>&lt;TwinCAT&gt;\Components\Plc\Managed Libraries</c> before.
    /// </summary>
    public static IReadOnlyList<string> Candidates(string? twinCatDir, string? programData)
    {
        var list = new List<string>();
        if (!string.IsNullOrEmpty(programData))
            list.Add(System.IO.Path.Combine(programData, "Beckhoff", "TwinCAT", "PlcEngineering", "Managed Libraries"));
        if (!string.IsNullOrEmpty(twinCatDir))
            list.Add(System.IO.Path.Combine(twinCatDir, "Components", "Plc", "Managed Libraries"));
        return list;
    }

    public static IReadOnlyList<InstalledLibrary> Scan(string root)
    {
        if (!Directory.Exists(root))
            throw new IECodeException(ExitCodes.NotFound, $"Library repository '{root}' not found.", "Pass the folder with --repository.");
        var list = new List<InstalledLibrary>();
        foreach (var vendor in Directory.EnumerateDirectories(root))
        foreach (var lib in Directory.EnumerateDirectories(vendor))
        foreach (var ver in Directory.EnumerateDirectories(lib))
        {
            var version = System.IO.Path.GetFileName(ver);
            if (!char.IsDigit(version.FirstOrDefault())) continue;
            if (!Directory.EnumerateFiles(ver).Any(ProjectLibraries.IsLibraryFile)) continue;   // an empty folder is what an interrupted install or removal leaves
            list.Add(new InstalledLibrary(System.IO.Path.GetFileName(lib), version, System.IO.Path.GetFileName(vendor), ver));
        }
        return list;
    }

    /// <summary>
    /// Every library of every repository that exists (a PC with 4024 and 4026 can have two). Folders that do not
    /// exist are skipped; the list is empty when none exists.
    /// </summary>
    public static IReadOnlyList<InstalledLibrary> ScanAll(IEnumerable<string> roots) =>
        [.. roots.Where(Directory.Exists).Distinct(StringComparer.OrdinalIgnoreCase).SelectMany(Scan)];

    /// <summary>
    /// Every library of repositories the user named: unlike <see cref="ScanAll"/> a folder that is missing or cannot be
    /// read fails with its path, because skipping it would report a check against a set that was not scanned.
    /// </summary>
    public static IReadOnlyList<InstalledLibrary> ScanExplicit(IEnumerable<string> roots)
    {
        var list = new List<InstalledLibrary>();
        foreach (var root in roots.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            try { list.AddRange(Scan(root)); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                throw new IECodeException(ExitCodes.NotFound, $"Library repository '{root}' cannot be read: {e.Message}", "Check the --repository path.");
            }
        }
        return list;
    }

    /// <summary>Newest installed version of a library (name/vendor compared case-insensitively), or null.</summary>
    public static InstalledLibrary? Newest(IEnumerable<InstalledLibrary> installed, string name, string? vendor) =>
        installed
            .Where(i => i.Name.Equals(name, StringComparison.OrdinalIgnoreCase)
                        && (vendor is null || i.Vendor.Equals(vendor, StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(i => VersionKey(i.Version))
            .FirstOrDefault();

    /// <summary>
    /// For a <c>*</c> reference the highest installed version of its library and vendor, which TwinCAT will pick in this
    /// repository; null for a pinned reference or when none is installed.
    /// </summary>
    public static string? HighestFor(IEnumerable<InstalledLibrary> installed, LibraryReference reference) =>
        reference.IsPinned ? null : Newest(installed, reference.Effective.Name, reference.Effective.Vendor)?.Version;

    /// <summary>
    /// A dotted version of one to four numeric components, each within int range; omitted components count as 0.
    /// Unlike the lenient ordering key this never turns an unreadable component into 0, so it is safe to decide a match on.
    /// </summary>
    public static bool TryParseVersion(string text, out Version version)
    {
        version = new Version(0, 0, 0, 0);
        var parts = text.Split('.');
        if (parts.Length is < 1 or > 4) return false;
        var n = new int[4];
        for (var i = 0; i < parts.Length; i++)
            if (parts[i].Length == 0 || !parts[i].All(char.IsAsciiDigit) || !int.TryParse(parts[i], out n[i])) return false;
        version = new Version(n[0], n[1], n[2], n[3]);
        return true;
    }

    /// <summary>Compares dotted versions numerically: 3.3.10.0 &gt; 3.3.9.0.</summary>
    public static int Compare(string a, string b) => VersionKey(a).CompareTo(VersionKey(b));

    private static Version VersionKey(string v)
    {
        var parts = v.Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).Concat([0, 0, 0, 0]).Take(4).ToArray();
        return new Version(parts[0], parts[1], parts[2], parts[3]);
    }
}
