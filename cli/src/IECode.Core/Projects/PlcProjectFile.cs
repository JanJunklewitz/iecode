using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace IECode.Core.Projects;

/// <summary>A PLC project (<c>.plcproj</c>): metadata and library references, read and edited without TwinCAT.</summary>
public sealed partial class PlcProjectFile
{
    public required string Path { get; init; }
    public required string Name { get; init; }
    public string? Title { get; init; }
    public string? Company { get; init; }
    public string? ProjectVersion { get; init; }
    public required IReadOnlyList<LibraryReference> References { get; init; }

    /// <summary>
    /// A project is treated as a library when it carries library metadata (Title + Company + ProjectVersion),
    /// which TwinCAT requires for "Save as library".
    /// </summary>
    public bool IsLibrary => !string.IsNullOrEmpty(Title) && !string.IsNullOrEmpty(Company) && !string.IsNullOrEmpty(ProjectVersion);

    public static PlcProjectFile Load(string path)
    {
        XDocument doc;
        try { doc = XDocument.Load(path); }
        catch (Exception e) { throw new IECodeException(ExitCodes.Failed, $"Cannot read '{path}': {e.Message}", inner: e); }

        string? Prop(string name) => doc.Descendants().FirstOrDefault(e => e.Name.LocalName == name && !e.HasElements)?.Value.Trim();
        static string? Child(XElement e, string name) => e.Elements().FirstOrDefault(c => c.Name.LocalName == name)?.Value;

        var pinned = doc.Descendants()
            .Where(e => e.Name.LocalName == "PlaceholderResolution")
            .Select(e => (Key: e.Attribute("Include")?.Value ?? "", Ok: LibraryId.TryParse(Child(e, "Resolution"), out var id), Id: id))
            .Where(x => x.Ok)
            .GroupBy(x => x.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.First().Id, StringComparer.OrdinalIgnoreCase);

        var refs = new List<LibraryReference>();
        foreach (var e in doc.Descendants())
        {
            if (e.Name.LocalName == "PlaceholderReference" && LibraryId.TryParse(Child(e, "DefaultResolution"), out var def))
            {
                var key = e.Attribute("Include")?.Value ?? def.Name;
                refs.Add(new LibraryReference(key, ReferenceKind.Placeholder, def, pinned.GetValueOrDefault(key)));
            }
            else if (e.Name.LocalName == "LibraryReference" && LibraryId.TryParse(e.Attribute("Include")?.Value, out var lib))
            {
                refs.Add(new LibraryReference(Child(e, "Namespace") ?? lib.Name, ReferenceKind.Library, lib, null));
            }
        }

        return new PlcProjectFile
        {
            Path = System.IO.Path.GetFullPath(path),
            Name = Prop("Name") ?? System.IO.Path.GetFileNameWithoutExtension(path),
            Title = Prop("Title"),
            Company = Prop("Company"),
            ProjectVersion = Prop("ProjectVersion"),
            References = refs,
        };
    }

    // Matches a resolution string inside element text (>...<) or an Include attribute ("...").
    [GeneratedRegex(@"(?<pre>[>""]\s*)(?<name>[^,<>""]+?)(?<sep>\s*,\s*)(?<ver>[^\s(<>""]+)(?<post>\s*\((?<vendor>[^)<>""]+)\))")]
    private static partial Regex ResolutionInText();

    [GeneratedRegex(@"^(\*|\d+(\.\d+){1,3})$")]
    private static partial Regex ValidVersion();

    /// <summary>
    /// Sets the version of a library everywhere it is resolved in this project (default resolution,
    /// pinned resolution, direct library reference). Edits the text in place, so formatting, encoding
    /// and line endings stay as TwinCAT wrote them. Returns what changed; writes only if not a dry run.
    /// </summary>
    public IReadOnlyList<ReferenceChange> SetLibraryVersion(string library, string version, string? vendor = null, bool dryRun = false)
    {
        if (!ValidVersion().IsMatch(version))
            throw new IECodeException(ExitCodes.Usage, $"Invalid library version '{version}'.", "Use * (always newest) or a version like 1.3.0 or 3.3.3.0.");

        var bytes = File.ReadAllBytes(Path);
        var hasBom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        var text = new UTF8Encoding(false).GetString(bytes, hasBom ? 3 : 0, bytes.Length - (hasBom ? 3 : 0));

        var changes = new List<ReferenceChange>();
        var updated = ResolutionInText().Replace(text, m =>
        {
            if (!m.Groups["name"].Value.Trim().Equals(library, StringComparison.OrdinalIgnoreCase)) return m.Value;
            if (vendor is not null && !m.Groups["vendor"].Value.Trim().Equals(vendor, StringComparison.OrdinalIgnoreCase)) return m.Value;
            var from = m.Groups["ver"].Value;
            if (from == version) return m.Value;
            changes.Add(new ReferenceChange(Name, m.Groups["name"].Value.Trim(), m.Groups["vendor"].Value.Trim(), from, version));
            return m.Groups["pre"].Value + m.Groups["name"].Value + m.Groups["sep"].Value + version + m.Groups["post"].Value;
        });

        if (changes.Count > 0 && !dryRun)
        {
            var output = new UTF8Encoding(false).GetBytes(updated);
            File.WriteAllBytes(Path, hasBom ? [0xEF, 0xBB, 0xBF, .. output] : output);
        }
        return changes;
    }

    /// <summary>Finds all <c>.plcproj</c> files below the given paths (files or folders), skipping TwinCAT output folders.</summary>
    public static IEnumerable<string> Discover(IEnumerable<string> paths)
    {
        foreach (var p in paths)
        {
            var full = System.IO.Path.GetFullPath(p);
            if (File.Exists(full))
            {
                if (full.EndsWith(".plcproj", StringComparison.OrdinalIgnoreCase)) yield return full;
                else if (full.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
                    foreach (var plc in SolutionFile.Load(full).PlcProjects) yield return plc.Path;
                continue;
            }
            if (!Directory.Exists(full))
                throw new IECodeException(ExitCodes.NotFound, $"'{p}' does not exist.");
            foreach (var f in Directory.EnumerateFiles(full, "*.plcproj", SearchOption.AllDirectories))
                if (!IsInOutputFolder(f, full)) yield return f;
        }
    }

    private static bool IsInOutputFolder(string file, string root) =>
        System.IO.Path.GetRelativePath(root, file)
            .Split(System.IO.Path.DirectorySeparatorChar)
            .Any(seg => seg.StartsWith('_') || seg is ".git" or "bin" or "obj" or "node_modules");
}

/// <summary>One edited library resolution.</summary>
public sealed record ReferenceChange(string Project, string Library, string Vendor, string From, string To);
