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

    /// <summary>
    /// The file is protected with a user database (object protection "encrypted"): TwinCAT stores it binary,
    /// so only the name is known. XAE still opens and builds it for a user with the right level.
    /// </summary>
    public bool IsEncrypted { get; init; }

    public static PlcProjectFile Load(string path)
    {
        XDocument doc;
        try { doc = XDocument.Load(path); }
        catch (System.Xml.XmlException) when (!LooksLikeXml(path))
        {
            return new PlcProjectFile
            {
                Path = System.IO.Path.GetFullPath(path),
                Name = System.IO.Path.GetFileNameWithoutExtension(path),
                References = [],
                IsEncrypted = true,
            };
        }
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

    /// <summary>True when the file starts like XML (optional BOM and whitespace, then '&lt;'); encrypted files do not.</summary>
    private static bool LooksLikeXml(string path)
    {
        var head = new byte[64];
        int n;
        using (var f = File.OpenRead(path)) n = f.Read(head, 0, head.Length);
        var i = n >= 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF ? 3 : 0;
        while (i < n && head[i] is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n') i++;
        return i < n && head[i] == (byte)'<';
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
        var edit = PlanEdits([(library, version)], vendor);
        if (edit.Changes.Count > 0 && !dryRun)
        {
            var staged = edit.Stage();
            try { edit.Commit(staged); }
            catch { PlannedEdit.Discard(staged); throw; }
        }
        return edit.Changes;
    }

    /// <summary>
    /// Plans several library versions for this project in one go: every item is applied to the text of the one before,
    /// so the file is written once. Nothing is written; <see cref="PlannedEdit"/> stages and replaces the file.
    /// Library and vendor are compared with the XML entities decoded, as selection does.
    /// </summary>
    public PlannedEdit PlanEdits(IReadOnlyList<(string Library, string Version)> items, string? vendor = null)
    {
        foreach (var (_, version) in items)
            if (!ValidVersion().IsMatch(version))
                throw new IECodeException(ExitCodes.Usage, $"Invalid library version '{version}'.", "Use * (always newest) or a version like 1.3.0 or 3.3.3.0.");
        if (IsEncrypted)
            throw new IECodeException(ExitCodes.Failed, $"'{Path}' is encrypted; its library references cannot be edited as text.",
                "Change the reference in XAE as a user of the project's user database.");

        var bytes = File.ReadAllBytes(Path);
        var (encoding, preamble) = TextEncoding(bytes, Path);
        string text;
        try { text = encoding.GetString(bytes, preamble, bytes.Length - preamble); }
        catch (DecoderFallbackException e)
        {
            throw new IECodeException(ExitCodes.Failed, $"'{Path}' is not valid {encoding.WebName} text: {e.Message}", "Open and save it in XAE, or fix the encoding.", e);
        }

        var changes = new List<ReferenceChange>();
        foreach (var (library, version) in items)
            text = ResolutionInText().Replace(text, m =>
            {
                if (!XmlText(m.Groups["name"].Value).Trim().Equals(library, StringComparison.OrdinalIgnoreCase)) return m.Value;
                if (vendor is not null && !XmlText(m.Groups["vendor"].Value).Trim().Equals(vendor, StringComparison.OrdinalIgnoreCase)) return m.Value;
                var from = m.Groups["ver"].Value;
                if (from == version) return m.Value;
                changes.Add(new ReferenceChange(Name, XmlText(m.Groups["name"].Value).Trim(), XmlText(m.Groups["vendor"].Value).Trim(), from, version));
                return m.Groups["pre"].Value + m.Groups["name"].Value + m.Groups["sep"].Value + version + m.Groups["post"].Value;
            });

        return new PlannedEdit(Path, bytes, [.. bytes.AsSpan(0, preamble), .. encoding.GetBytes(text)], changes);
    }

    /// <summary>Element or attribute text as the XML parser reads it (<c>A &amp;amp; B</c> is <c>A &amp; B</c>).</summary>
    private static string XmlText(string raw) =>
        raw.Contains('&') ? System.Net.WebUtility.HtmlDecode(raw) : raw;

    /// <summary>
    /// The encoding of a .plcproj and the length of its byte order mark: UTF-8 (the default, with or without BOM) or
    /// UTF-16 with BOM. Decoding is strict, and anything else is refused, so a file is never rewritten in another encoding.
    /// </summary>
    private static (Encoding Encoding, int Preamble) TextEncoding(byte[] b, string path)
    {
        static IECodeException Unsupported(string path, string what) =>
            new(ExitCodes.Failed, $"'{path}' is encoded as {what}; its library references can only be edited as UTF-8 or UTF-16 with a byte order mark.",
                "Change the reference in XAE, or save the project as UTF-8.");
        if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) return (new UTF8Encoding(false, true), 3);
        if (b.Length >= 4 && ((b[0] == 0xFF && b[1] == 0xFE && b[2] == 0 && b[3] == 0) || (b[0] == 0 && b[1] == 0 && b[2] == 0xFE && b[3] == 0xFF)))
            throw Unsupported(path, "UTF-32");
        if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) return (new UnicodeEncoding(false, false, true), 2);
        if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) return (new UnicodeEncoding(true, false, true), 2);
        if (b.Length >= 2 && (b[0] == 0 || b[1] == 0)) throw Unsupported(path, "UTF-16 without a byte order mark");
        var head = Encoding.ASCII.GetString(b, 0, Math.Min(b.Length, 200));
        var declared = Regex.Match(head, @"^\s*<\?xml[^>]*\bencoding\s*=\s*[""'](?<enc>[^""']+)[""']", RegexOptions.IgnoreCase);
        if (declared.Success && !declared.Groups["enc"].Value.Equals("utf-8", StringComparison.OrdinalIgnoreCase))
            throw Unsupported(path, declared.Groups["enc"].Value);
        return (new UTF8Encoding(false, true), 0);
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
