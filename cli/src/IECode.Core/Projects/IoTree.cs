using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace IECode.Core.Projects;

/// <summary>A link, oriented like the Timaris hardware links tool: the PLC side left, otherwise the ordinally smaller side left.</summary>
public sealed record HwLink(string Left, string Right, string? Size, string? OffsLeft, string? OffsRight,
    IReadOnlyDictionary<string, string> Attributes, string File);

/// <summary>All links of a system project and the boxes of its IO tree (the nesting levels of the YAML tree).</summary>
public sealed record IoSnapshot(IReadOnlyList<HwLink> Links, IReadOnlyList<string> Boxes, IReadOnlyList<string> Warnings);

/// <summary>
/// IO links of a TwinCAT system project as a hardware tree (device > box > terminal > channel), in the format
/// of the HardwareLinks.yaml of the Timaris hardware links tool. Links come from the active &lt;Mappings&gt; of the
/// .tsproj and of the .xti files it references (directly or through other .xti files); owner names in an .xti are
/// relative to the item the file holds and are resolved along that chain. Unreferenced .xti files and
/// &lt;UnrestoredVarLinks&gt; are ignored. Same rules as the VS Code extension (src/core/iotree.ts).
/// </summary>
public static partial class IoTree
{
    private static readonly Dictionary<string, string> CategoryByParent = new() { ["Io"] = "IO", ["Safety"] = "SPLC", ["Plc"] = "PLC" };

    private sealed record LinkFile(string Path, string? Category, string? ItemPath, XDocument Doc);

    /// <summary>Links of a .tsproj in the working copy, or at a git commit when <paramref name="gitRef"/> is set.</summary>
    public static IoSnapshot Load(string tsproj, string? gitRef)
    {
        tsproj = Path.GetFullPath(tsproj);
        if (gitRef is null) return Read(tsproj, f => File.Exists(f) ? File.ReadAllText(f) : null);
        // one git call for every candidate file below the project; TwinCAT's file names may differ in case
        var dir = Path.GetDirectoryName(tsproj)!;
        var git = Git.Open(dir);
        var files = git.FilesAt(gitRef, dir)
            .Where(f => f.EndsWith(".xti", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".tsproj", StringComparison.OrdinalIgnoreCase))
            .Select(f => Path.GetFullPath(Path.Combine(dir, f))).ToList();
        var contents = git.ShowMany(gitRef, files);
        var byName = contents.ToDictionary(e => Path.GetFullPath(e.Key), e => e.Value, StringComparer.OrdinalIgnoreCase);
        return Read(tsproj, f => byName.GetValueOrDefault(Path.GetFullPath(f)));
    }

    /// <summary>All links of a system project (sorted, without duplicates); <paramref name="read"/> returns null for a missing file.</summary>
    public static IoSnapshot Read(string tsproj, Func<string, string?> read)
    {
        var warnings = new List<string>();
        var files = FileSet(Path.GetFullPath(tsproj), read, warnings);
        var dir = Path.GetDirectoryName(Path.GetFullPath(tsproj))!;
        var unique = new SortedDictionary<string, HwLink>(StringComparer.Ordinal);
        foreach (var f in files)
        {
            var rel = Path.GetRelativePath(dir, f.Path).Replace('\\', '/');
            foreach (var l in LinksOf(f.Doc, rel, f.ItemPath)) unique.TryAdd(LinkLine(l), l);
        }
        return new IoSnapshot(unique.Values.ToList(), BoxCatalog(files), warnings);
    }

    // ---------------------------------------------------------------------------------------------
    // File set

    /// <summary>Parses TwinCAT XML; repairs the duplicate RestoreInfo attributes TwinCAT sometimes writes.</summary>
    private static XDocument Parse(string xml, string file)
    {
        xml = xml.TrimStart('﻿');
        try { return XDocument.Parse(xml); }
        catch (System.Xml.XmlException first)
        {
            var fixedXml = DuplicateRestoreInfo().Replace(xml, m =>
            {
                var tag = m.Value;
                var one = RestoreInfoAttr().Match(tag);
                var cut = one.Index + one.Length;
                return tag[..cut] + RestoreInfoAttr().Replace(tag[cut..], "");
            });
            try { return XDocument.Parse(fixedXml); }
            catch (System.Xml.XmlException) { throw new IECodeException(ExitCodes.Failed, $"Cannot read '{file}': {first.Message}", inner: first); }
        }
    }

    [GeneratedRegex("""<[A-Za-z][^<>]*?\bRestoreInfo="[^"]*"[^<>]*?\bRestoreInfo="[^"]*"[^<>]*>""")]
    private static partial Regex DuplicateRestoreInfo();
    [GeneratedRegex("\\sRestoreInfo=\"[^\"]*\"")]
    private static partial Regex RestoreInfoAttr();

    private static string? NameOf(XElement? e) => e?.Element("Name")?.Value;

    /// <summary>TwinCAT writes characters that are invalid in file names as %_XX.</summary>
    private static string FromFileName(string file) =>
        FileEscape().Replace(Path.GetFileNameWithoutExtension(file), m => ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString());
    private static string ToFileName(string name) => InvalidFileChar().Replace(name, m => $"%_{(int)m.Value[0]:X2}");
    [GeneratedRegex("%_([0-9A-Fa-f]{2})")]
    private static partial Regex FileEscape();
    [GeneratedRegex("""[\\/:*?"<>|]""")]
    private static partial Regex InvalidFileChar();

    private static string ItemName(XDocument doc, string file)
    {
        var name = doc.Root?.Elements().Select(e => e.Element("Name")).FirstOrDefault(n => n is not null)?.Value;
        return string.IsNullOrEmpty(name) || name == "__FILENAME__" ? FromFileName(file) : name;
    }

    private static IEnumerable<XElement> FileReferences(XDocument doc, bool isProject)
    {
        var all = isProject ? doc.Root?.Element("Project")?.Descendants() ?? [] : doc.Root?.DescendantsAndSelf() ?? [];
        return all.Where(e => e.Attribute("File") is not null && e.Name.LocalName != "AdditionalTmcFile"
                              && (isProject || !e.Ancestors("Mappings").Any()));
    }

    private static List<LinkFile> FileSet(string tsproj, Func<string, string?> read, List<string> warnings)
    {
        if (read(tsproj) is not { } src) return [];
        var doc = Parse(src, tsproj);
        var dir = Path.GetDirectoryName(tsproj)!;
        var files = new List<LinkFile> { new(tsproj, null, null, doc) };
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { tsproj };

        void Add(string file, string category, string? parentItemPath)
        {
            if (read(file) is not { } text) { warnings.Add($"Referenced file not found: {Path.GetRelativePath(dir, file)}"); return; }
            var full = Path.GetFullPath(file);
            if (!visited.Add(full)) return;
            var item = Parse(text, full);
            var name = ItemName(item, full);
            var itemPath = parentItemPath is not null ? $"{parentItemPath}^{name}" : category switch
            {
                "IO" => $"TIID^{name}",
                // NC.xti writes its owners relative to the NC task, the .tsproj spells the task out.
                "NC" => item.Root?.Element("NC")?.Elements().Select(e => e.Element("Name")).FirstOrDefault(n => n is not null)?.Value is { Length: > 0 } task ? $"TINC^{task}" : "TINC",
                "PLC" => $"TIPC^{name}",
                _ => name,
            };
            files.Add(new LinkFile(full, category, itemPath, item));

            var folder = Path.Combine(Path.GetDirectoryName(full)!, Path.GetFileNameWithoutExtension(full));
            foreach (var el in FileReferences(item, false).ToList())
            {
                // A file box inside inline boxes (coupler > junction > drive) lives in one subfolder per inline box.
                var inline = new List<string>();
                for (var a = el.Parent; a?.Parent is not null && a.Parent.Name.LocalName != "TcSmItem"; a = a.Parent)
                {
                    if (a.Name.LocalName != "Box" || a.Attribute("File") is not null) continue;
                    if (NameOf(a) is { Length: > 0 } n && n != "__FILENAME__") inline.Insert(0, n);
                }
                var target = Path.Combine([folder, .. inline.Select(ToFileName)]);
                if (category == "NC" && el.Name.LocalName == "Axis")
                {
                    // NC.xti keeps its axis files in _Config/NC/Axes, and their links belong to <task>^Axes^<axis>.
                    target = Path.Combine(Path.GetDirectoryName(full)!, "Axes");
                    inline.Insert(0, "Axes");
                }
                // A PLC project keeps its instance file next to itself (_Config/PLC/Plc Instance.xti).
                if (category == "PLC" && el.Name.LocalName == "Instance") target = Path.GetDirectoryName(full)!;
                Add(Path.Combine(target, el.Attribute("File")!.Value), category, string.Join('^', [itemPath, .. inline]));
            }
        }

        foreach (var el in FileReferences(doc, true).ToList())
        {
            var category = el.Name.LocalName == "NC" ? "NC" : CategoryByParent.GetValueOrDefault(el.Parent?.Name.LocalName ?? "");
            if (category is null) continue;
            Add(Path.Combine(dir, "_Config", category, el.Attribute("File")!.Value), category, null);
        }
        return files;
    }

    // ---------------------------------------------------------------------------------------------
    // Links

    private static string ResolveOwner(string raw, string? itemPath) =>
        OwnerPrefix().IsMatch(raw) || string.IsNullOrEmpty(itemPath) ? raw : raw == "" ? itemPath : $"{itemPath}^{raw}";
    [GeneratedRegex(@"^TI[A-Z]+\^")]
    private static partial Regex OwnerPrefix();

    private static string JoinSide(string owner, string v) => owner == "" ? v : $"{owner}^{v}";

    /// <summary>Links of one file's active &lt;Mappings&gt;; <paramref name="itemPath"/> resolves relative owner names (null for a .tsproj).</summary>
    public static IReadOnlyList<HwLink> LinksOfFile(string xml, string file, string? itemPath = null) => LinksOf(Parse(xml, file), file, itemPath);

    private static List<HwLink> LinksOf(XDocument doc, string file, string? itemPath)
    {
        var links = new List<HwLink>();
        foreach (var l in doc.Root?.Elements("Mappings").Elements("OwnerA").Elements("OwnerB").Elements("Link") ?? [])
        {
            var b = l.Parent!;
            var a = b.Parent!;
            var varA = l.Attribute("VarA")?.Value ?? "";
            var varB = l.Attribute("VarB")?.Value ?? "";
            var attrs = l.Attributes().Where(x => x.Name.LocalName is not "VarA" and not "VarB").ToDictionary(x => x.Name.LocalName, x => x.Value);
            var sideA = JoinSide(ResolveOwner(a.Attribute("Name")?.Value ?? "", itemPath), varA);
            var sideB = JoinSide(ResolveOwner(b.Attribute("Name")?.Value ?? "", itemPath), varB);
            var aPlc = sideA.StartsWith("TIPC^", StringComparison.Ordinal);
            var bPlc = sideB.StartsWith("TIPC^", StringComparison.Ordinal);
            var swap = aPlc != bPlc ? bPlc : string.CompareOrdinal(sideB, sideA) < 0;
            attrs.TryGetValue("OffsA", out var offsA);
            attrs.TryGetValue("OffsB", out var offsB);
            links.Add(new HwLink(swap ? sideB : sideA, swap ? sideA : sideB, attrs.GetValueOrDefault("Size"),
                swap ? offsB : offsA, swap ? offsA : offsB, attrs, file));
        }
        return links;
    }

    /// <summary>One-line form of a link; also the key that makes links unique.</summary>
    public static string LinkLine(HwLink l)
    {
        var bits = new List<string>();
        if (l.Size is not null) bits.Add($"Size={l.Size}");
        if (l.OffsLeft is not null) bits.Add($"OffsLeft={l.OffsLeft}");
        if (l.OffsRight is not null) bits.Add($"OffsRight={l.OffsRight}");
        return $"{l.Left} <-> {l.Right}" + (bits.Count > 0 ? $" [{string.Join(' ', bits)}]" : "");
    }

    /// <summary>Every box of the IO files as a full path (TIID^device^box^…).</summary>
    private static List<string> BoxCatalog(List<LinkFile> files)
    {
        var paths = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var f in files.Where(f => f.Category == "IO" && f.Doc.Root is not null))
        {
            paths.Add(f.ItemPath!);
            foreach (var box in f.Doc.Root!.Elements().SelectMany(e => e.Descendants("Box")))
            {
                if (box.Attribute("File") is not null || box.Ancestors("Mappings").Any() || box.Element("Name") is not { } nameNode) continue;
                var own = nameNode.Value;
                if (string.IsNullOrEmpty(own) || own == "__FILENAME__") continue;
                var names = new List<string> { own };
                var complete = true;
                for (var a = box.Parent; a?.Parent is not null && a.Parent.Name.LocalName != "TcSmItem"; a = a.Parent)
                {
                    if (a.Name.LocalName != "Box") continue;
                    if (NameOf(a) is { Length: > 0 } n) names.Insert(0, n); else complete = false;
                }
                if (complete) paths.Add($"{f.ItemPath}^{string.Join('^', names)}");
            }
        }
        return paths.ToList();
    }

    // ---------------------------------------------------------------------------------------------
    // Tree

    /// <summary>Short display names: Plc^MAIN.x for PLC variables, NC^… for NC, the device path without TIID^ for IO.</summary>
    public static string ShortName(string s)
    {
        if (PlcInstanceVar().Match(s) is { Success: true } m) return $"{m.Groups[1].Value}^{m.Groups[2].Value}";
        if (s.StartsWith("TIPC^", StringComparison.Ordinal)) return s[5..];
        if (s.StartsWith("TINC^", StringComparison.Ordinal)) return "NC^" + s[5..];
        if (s.StartsWith("TIID^", StringComparison.Ordinal)) return s[5..];
        return s;
    }
    [GeneratedRegex(@"^TIPC\^([^^]+)\^\1 Instance\^[^^]+ (?:Inputs|Outputs)\^(.+)$")]
    private static partial Regex PlcInstanceVar();
    [GeneratedRegex(@"\^(?:ConnectionInputs|ConnectionOutputs|StandardInputs|StandardOutputs)\^")]
    private static partial Regex SafetySide();

    private sealed class Node
    {
        public Dictionary<string, Node> Kids { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, List<string>> Leaves { get; } = new(StringComparer.Ordinal);
    }

    private static Node BuildTree(IEnumerable<HwLink> links, IEnumerable<string> boxes)
    {
        var ioBoxes = boxes.Select(b => b.StartsWith("TIID^", StringComparison.Ordinal) ? b[5..] : b).ToHashSet(StringComparer.Ordinal);
        var root = new Node();
        foreach (var l in links)
        {
            // Which side is the place in the tree (usually the IO channel) and which is the linked value.
            var leftIo = l.Left.StartsWith("TIID^", StringComparison.Ordinal);
            var rightIo = l.Right.StartsWith("TIID^", StringComparison.Ordinal);
            var groupRight = true;
            if (l.Left.StartsWith("TIPC^", StringComparison.Ordinal)) groupRight = true;
            // IO to IO: the TwinSAFE logic terminal groups its safety links.
            else if (leftIo && rightIo) groupRight = !(SafetySide().IsMatch(l.Left) && !SafetySide().IsMatch(l.Right));
            else if (leftIo != rightIo) groupRight = rightIo;
            var (group, linkedSide, groupOffs, linkedOffs) = groupRight ? (l.Right, l.Left, l.OffsRight, l.OffsLeft) : (l.Left, l.Right, l.OffsLeft, l.OffsRight);

            var (keys, leaf) = SplitPlace(group, ioBoxes);
            var linked = ShortName(linkedSide);
            if (linkedSide.StartsWith("TIPC^", StringComparison.Ordinal))
            {
                // TwinCAT names many channels after the linked PLC variable: 'Channel 2^MAIN.x' for 'Plc^MAIN.x'.
                var suffix = "^" + linked[(linked.IndexOf('^') + 1)..];
                if (leaf.Length > suffix.Length && leaf.EndsWith(suffix, StringComparison.Ordinal)) leaf = leaf[..^suffix.Length];
            }
            var bits = new List<string>();
            if (l.Size is not null) bits.Add($"Size={l.Size}");
            if (groupOffs is not null) bits.Add($"OffsIO={groupOffs}");
            if (linkedOffs is not null) bits.Add($"OffsLinked={linkedOffs}");
            var value = bits.Count > 0 ? $"{linked} [{string.Join(' ', bits)}]" : linked;

            var node = root;
            foreach (var k in keys)
            {
                if (!node.Kids.TryGetValue(k, out var next)) node.Kids[k] = next = new Node();
                node = next;
            }
            if (!node.Leaves.TryGetValue(leaf, out var values)) node.Leaves[leaf] = values = [];
            values.Add(value);
        }
        return root;
    }

    /// <summary>Splits the place into nested keys (devices, boxes) and the leaf key (channel).</summary>
    private static (List<string> Keys, string Leaf) SplitPlace(string side, HashSet<string> ioBoxes)
    {
        var t = ShortName(side);
        var keys = new List<string>();
        var start = 0;
        if (side.StartsWith("TIID^", StringComparison.Ordinal))
        {
            // Every box of the catalogue on the way is a nested key; the rest after the deepest box is the leaf key.
            for (var i = t.IndexOf('^'); i >= 0; i = t.IndexOf('^', i + 1))
                if (ioBoxes.Contains(t[..i])) { keys.Add(t[start..i]); start = i + 1; }
            if (keys.Count == 0 && t.IndexOf('^') is > 0 and var first) { keys.Add(t[..first]); start = first + 1; }
        }
        else if (side.StartsWith("TINC^", StringComparison.Ordinal))
        {
            if (NcAxis().Match(t) is { Success: true } ax) keys.AddRange(["NC", ax.Groups[1].Value, "Axes", ax.Groups[2].Value]);
            else if (NcTask().Match(t) is { Success: true } task) keys.AddRange(["NC", task.Groups[1].Value]);
            else keys.Add("NC");
            start = string.Join('^', keys).Length + 1;
        }
        else if (t.IndexOf('^') is > 0 and var first) { keys.Add(t[..first]); start = first + 1; }
        return (keys, t[Math.Min(start, t.Length)..]);
    }
    [GeneratedRegex(@"^NC\^([^^]+)\^Axes\^([^^]+)\^.+$")]
    private static partial Regex NcAxis();
    [GeneratedRegex(@"^NC\^([^^]+)\^.+$")]
    private static partial Regex NcTask();

    /// <summary>Natural order (Channel 2 before Channel 10), ordinal within equal keys.</summary>
    private static List<string> NaturalSort(IEnumerable<string> items) =>
        items.Select(s => (Key: Digits().Replace(s, d => d.Value.PadLeft(6, '0')) + "\0" + s, Item: s))
            .OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => x.Item).ToList();
    [GeneratedRegex(@"\d+")]
    private static partial Regex Digits();

    /// <summary>Quotes what is not a plain YAML 1.2 string scalar (indicators, ': ', ' #', numbers, booleans).</summary>
    public static string YamlScalar(string s)
    {
        var unsafeText = s == "" || char.IsWhiteSpace(s[0]) || char.IsWhiteSpace(s[^1]) || "[]{}&*!|>'\"%@`#?,:".Contains(s[0])
            || s == "-" || s.StartsWith("- ", StringComparison.Ordinal) || s.StartsWith("-\t", StringComparison.Ordinal)
            || s.Contains(": ", StringComparison.Ordinal) || s.Contains(" #", StringComparison.Ordinal) || s.EndsWith(':') || NumberOrKeyword().IsMatch(s);
        return unsafeText ? $"'{s.Replace("'", "''")}'" : s;
    }
    [GeneratedRegex(@"^(?:[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|true|false|null|~|yes|no|on|off|y|n|[-+]?\.inf|\.nan)$", RegexOptions.IgnoreCase)]
    private static partial Regex NumberOrKeyword();

    /// <summary>The links as a YAML tree: device and box keys nested, one line per channel.</summary>
    public static string ToYaml(IoSnapshot snapshot, string? header = null)
    {
        var sb = new StringBuilder();
        if (header is not null) sb.Append(header).Append('\n');
        Write(BuildTree(snapshot.Links, snapshot.Boxes), 0, sb);
        return sb.ToString();
    }

    private static void Write(Node n, int depth, StringBuilder sb)
    {
        var entries = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var (k, kid) in n.Kids) entries[k] = kid;
        foreach (var (k, values) in n.Leaves)
        {
            var key = k;
            while (entries.ContainsKey(key)) key += "^";   // a leaf must not share its key with a box
            entries[key] = values;
        }
        var indent = new string(' ', depth * 2);
        foreach (var key in NaturalSort(entries.Keys))
        {
            var yamlKey = YamlScalar(key);
            if (entries[key] is Node kid)
            {
                sb.Append(indent).Append(yamlKey).Append(":\n");
                Write(kid, depth + 1, sb);
                continue;
            }
            var values = NaturalSort((List<string>)entries[key]);
            if (values.Count == 1) sb.Append(indent).Append(yamlKey).Append(": ").Append(YamlScalar(values[0])).Append('\n');
            else
            {
                sb.Append(indent).Append(yamlKey).Append(":\n");
                foreach (var v in values) sb.Append(indent).Append("  - ").Append(YamlScalar(v)).Append('\n');
            }
        }
    }
}
