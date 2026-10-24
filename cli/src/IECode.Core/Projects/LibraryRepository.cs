namespace IECode.Core.Projects;

/// <summary>A library version installed in a TwinCAT library repository.</summary>
public sealed record InstalledLibrary(string Name, string Version, string Vendor, string Path);

/// <summary>
/// Reads a TwinCAT library repository folder ("Managed Libraries"), laid out as
/// <c>&lt;vendor&gt;/&lt;library&gt;/&lt;version&gt;/</c>. Names are stored lower-case on disk.
/// </summary>
public static class LibraryRepository
{
    /// <summary>Default repository of a TwinCAT installation.</summary>
    public static string? DefaultPath(string? twinCatDir) =>
        twinCatDir is null ? null : System.IO.Path.Combine(twinCatDir, "Components", "Plc", "Managed Libraries");

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
            list.Add(new InstalledLibrary(System.IO.Path.GetFileName(lib), version, System.IO.Path.GetFileName(vendor), ver));
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

    /// <summary>Compares dotted versions numerically: 3.3.10.0 &gt; 3.3.9.0.</summary>
    public static int Compare(string a, string b) => VersionKey(a).CompareTo(VersionKey(b));

    private static Version VersionKey(string v)
    {
        var parts = v.Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).Concat([0, 0, 0, 0]).Take(4).ToArray();
        return new Version(parts[0], parts[1], parts[2], parts[3]);
    }
}
