using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Linq;

namespace IECode.Core.Projects;

/// <summary>A PLC variable that ADS clients can access by name, e.g. <c>MAIN.fbMotor.bEnable</c>.</summary>
/// <param name="BitSize">Size in bits, from the build output (unknown for symbols read from source code).</param>
/// <param name="Area">Data area of the PLC module, e.g. "PlcTask Inputs" or "PlcTask Internal".</param>
public sealed record AdsSymbol(string Name, string Type, int? BitSize = null, string? Comment = null, string? Area = null)
{
    [JsonIgnore]
    public string SizeText => BitSize is not { } b ? "" : b % 8 == 0 ? $"{b / 8} B" : $"{b} bit";
}

public enum AdsChangeKind { Added, Removed, Changed }

public sealed record AdsChange(AdsChangeKind Kind, string Name, string? Before, string? After, string? Details = null);

/// <summary>The ADS symbols of one PLC project and the file they were read from.</summary>
/// <param name="Members">True if structs and function blocks are expanded to their members.</param>
public sealed record AdsInterfaceInfo(string Project, string Source, IReadOnlyList<AdsSymbol> Symbols, bool Members);

/// <summary>
/// The ADS interface (symbol table) of a PLC project without a running PLC: read from the TwinCAT Module Class
/// file (<c>&lt;PLC&gt;.tmc</c>) that every build writes next to the <c>.plcproj</c>.
/// <c>&lt;DataArea&gt;&lt;Symbol&gt;</c> are the top-level symbols (MAIN.x, GVL.y), <c>&lt;DataType&gt;&lt;SubItem&gt;</c>
/// the members used to expand them. Same rules as the VS Code extension.
/// </summary>
public static class AdsInterface
{
    public const string SnapshotFormat = "iecode-ads-interface/1";
    private const int MaxDepth = 8;

    private sealed record Member(string Name, string Type, int? BitSize, string? Comment);
    private sealed record DataType(string Type, IReadOnlyList<Member> Members, string? Extends, string? Alias);

    private static XElement? Child(XElement e, string name) => e.Elements().FirstOrDefault(x => x.Name.LocalName == name);
    private static string? Text(XElement e, string name) => Child(e, name)?.Value.Trim() is { Length: > 0 } s ? s : null;
    private static int? Int(XElement e, string name) => int.TryParse(Text(e, name), out var i) ? i : null;

    /// <summary>Type text of a symbol or member: base type plus ARRAY / POINTER TO / REFERENCE TO.</summary>
    private static string TypeOf(XElement e, string typeElement)
    {
        var t = Child(e, typeElement);
        var type = t?.Value.Trim() ?? "";
        if (t?.Attribute("PointerTo") is { } p) type = string.Concat(Enumerable.Repeat("POINTER TO ", int.TryParse(p.Value, out var n) ? Math.Max(n, 1) : 1)) + type;
        if (t?.Attribute("ReferenceTo") is not null) type = "REFERENCE TO " + type;
        var dims = e.Elements().Where(x => x.Name.LocalName == "ArrayInfo")
            .Select(a => (lb: Int(a, "LBound") ?? 0, n: Int(a, "Elements") ?? 0))
            .Select(d => $"{d.lb}..{d.lb + d.n - 1}").ToList();
        return dims.Count > 0 ? $"ARRAY [{string.Join(", ", dims)}] OF {type}" : type;
    }

    private static string Key(XElement? nameOrType) =>
        nameOrType is null ? "" : (nameOrType.Attribute("Namespace")?.Value is { Length: > 0 } ns ? ns + "." : "") + nameOrType.Value.Trim();

    /// <summary>Reads the symbols of a .tmc file. With <paramref name="members"/>, structs and function blocks are expanded to their members.</summary>
    public static IReadOnlyList<AdsSymbol> FromTmc(string xml, bool members = false, string file = ".tmc")
    {
        XDocument doc;
        try { doc = XDocument.Parse(xml.TrimStart('﻿')); }
        catch (Exception e) { throw new IECodeException(ExitCodes.Failed, $"Cannot read '{file}': {e.Message}", inner: e); }

        var types = new Dictionary<string, DataType>(StringComparer.OrdinalIgnoreCase);
        foreach (var dt in doc.Descendants().Where(e => e.Name.LocalName == "DataType" && e.Parent?.Name.LocalName == "DataTypes"))
        {
            var name = Child(dt, "Name");
            if (name is null) continue;
            var items = dt.Elements().Where(x => x.Name.LocalName == "SubItem" && Text(x, "Name") is not null)
                .Select(s => new Member(Text(s, "Name")!, TypeOf(s, "Type"), Int(s, "BitSize"), Text(s, "Comment"))).ToList();
            var alias = Child(dt, "ArrayInfo") is null && items.Count == 0 ? Key(Child(dt, "BaseType")) : null;
            var type = new DataType(name.Value.Trim(), items, Key(Child(dt, "ExtendsType")) is { Length: > 0 } x ? x : null, alias is "" ? null : alias);
            types.TryAdd(Key(name), type);
            types.TryAdd(type.Type, type);
        }

        var result = new List<AdsSymbol>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var s in doc.Descendants().Where(e => e.Name.LocalName == "Symbol" && e.Parent?.Name.LocalName == "DataArea"))
        {
            var name = Text(s, "Name");
            if (name is null || !seen.Add(name)) continue;
            var area = Text(s.Parent!, "Name");
            var type = TypeOf(s, "BaseType");
            result.Add(new AdsSymbol(name, type, Int(s, "BitSize"), Text(s, "Comment"), area));
            if (members && type == (Child(s, "BaseType")?.Value.Trim() ?? ""))
                Expand(name, Key(Child(s, "BaseType")), area, 1);
        }
        return result.OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase).ToList();

        void Expand(string parent, string typeKey, string? area, int depth)
        {
            if (depth > MaxDepth) return;
            foreach (var m in MembersOf(typeKey, []))
            {
                var name = $"{parent}.{m.Name}";
                if (!seen.Add(name)) continue;
                result.Add(new AdsSymbol(name, m.Type, m.BitSize, m.Comment, area));
                if (types.ContainsKey(m.Type)) Expand(name, m.Type, area, depth + 1);
            }
        }

        // own members after the inherited ones (EXTENDS), aliases resolved
        IEnumerable<Member> MembersOf(string typeKey, HashSet<string> visited)
        {
            if (!types.TryGetValue(typeKey, out var t) || !visited.Add(t.Type)) return [];
            if (t.Alias is not null) return MembersOf(t.Alias, visited);
            return (t.Extends is null ? [] : MembersOf(t.Extends, visited)).Concat(t.Members);
        }
    }

    /// <summary>Compares two interfaces by symbol name (case-insensitive, like the PLC): added, removed, changed (type or size).</summary>
    public static IReadOnlyList<AdsChange> Diff(IEnumerable<AdsSymbol> before, IEnumerable<AdsSymbol> after)
    {
        static Dictionary<string, AdsSymbol> ByName(IEnumerable<AdsSymbol> s) =>
            s.GroupBy(x => x.Name, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
        static string Norm(string type) => string.Concat(type.Where(c => !char.IsWhiteSpace(c))).ToUpperInvariant();
        static string Describe(AdsSymbol s) => s.BitSize is null ? s.Type : $"{s.Type} ({s.SizeText})";
        var a = ByName(before);
        var b = ByName(after);
        var changes = new List<AdsChange>();
        foreach (var name in a.Keys.Union(b.Keys, StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase))
        {
            a.TryGetValue(name, out var was);
            b.TryGetValue(name, out var now);
            if (was is null) changes.Add(new AdsChange(AdsChangeKind.Added, now!.Name, null, Describe(now)));
            else if (now is null) changes.Add(new AdsChange(AdsChangeKind.Removed, was.Name, Describe(was), null));
            else
            {
                var details = new List<string>();
                if (Norm(was.Type) != Norm(now.Type)) details.Add($"{was.Type} → {now.Type}");
                if (was.BitSize is not null && now.BitSize is not null && was.BitSize != now.BitSize) details.Add($"{was.SizeText} → {now.SizeText}");
                if (details.Count > 0) changes.Add(new AdsChange(AdsChangeKind.Changed, now.Name, Describe(was), Describe(now), string.Join(", ", details)));
            }
        }
        return changes;
    }

    /// <summary>The .tmc of a PLC project: <c>&lt;plcproj name&gt;.tmc</c> next to it, or the only .tmc in that folder.</summary>
    public static string? FindTmc(string plcproj)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(plcproj))!;
        var exact = Path.Combine(dir, Path.GetFileNameWithoutExtension(plcproj) + ".tmc");
        if (File.Exists(exact)) return exact;
        var all = Directory.EnumerateFiles(dir, "*.tmc").ToList();
        return all.Count == 1 ? all[0] : null;
    }

    /// <summary>True if any PLC source file is newer than the .tmc (the interface may not match the code any more).</summary>
    public static bool IsStale(string tmc, string plcproj)
    {
        var built = File.GetLastWriteTimeUtc(tmc);
        var dir = Path.GetDirectoryName(Path.GetFullPath(plcproj))!;
        string[] exts = [".plcproj", ".tcpou", ".tcgvl", ".tcdut", ".tcio"];
        return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories)
            .Where(f => exts.Contains(Path.GetExtension(f).ToLowerInvariant()))
            .Where(f => !Path.GetRelativePath(dir, f).Split(Path.DirectorySeparatorChar).Any(s => s.StartsWith('_') || s.StartsWith('.')))
            .Any(f => File.GetLastWriteTimeUtc(f) > built);
    }

    /// <summary>Reads an interface from a .tmc or from a snapshot written by <see cref="ToSnapshot"/>.</summary>
    public static AdsInterfaceInfo Load(string file, bool members = false)
    {
        if (!File.Exists(file)) throw new IECodeException(ExitCodes.NotFound, $"'{file}' does not exist.");
        var text = File.ReadAllText(file);
        if (!file.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            return new AdsInterfaceInfo(Path.GetFileNameWithoutExtension(file), Path.GetFullPath(file), FromTmc(text, members, file), members);
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.TryGetProperty("format", out var f) && f.GetString() != SnapshotFormat)
                throw new IECodeException(ExitCodes.Failed, $"'{file}' has an unknown format '{f.GetString()}' (expected {SnapshotFormat}).");
            var symbols = root.GetProperty("symbols").Deserialize<List<AdsSymbol>>(Reporter.JsonOptions) ?? [];
            var expanded = root.TryGetProperty("members", out var m) && m.ValueKind == JsonValueKind.True;
            if (expanded && !members) symbols = TopLevel(symbols);
            return new AdsInterfaceInfo(root.TryGetProperty("project", out var p) ? p.GetString() ?? "" : "", Path.GetFullPath(file), symbols, expanded && members);
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            throw new IECodeException(ExitCodes.Failed, $"Cannot read '{file}': {e.Message}", inner: e);
        }
    }

    /// <summary>Only the symbols that aren't a member of another symbol in the list.</summary>
    public static List<AdsSymbol> TopLevel(IEnumerable<AdsSymbol> symbols)
    {
        var list = symbols.ToList();
        var names = new HashSet<string>(list.Select(s => s.Name), StringComparer.OrdinalIgnoreCase);
        return list.Where(s => !Parents(s.Name).Any(names.Contains)).ToList();
        static IEnumerable<string> Parents(string name)
        {
            for (var i = name.LastIndexOf('.'); i > 0; i = name.LastIndexOf('.', i - 1)) yield return name[..i];
        }
    }

    /// <summary>JSON snapshot of an interface, to commit next to the project and compare later builds with.</summary>
    public static string ToSnapshot(AdsInterfaceInfo info) => JsonSerializer.Serialize(new
    {
        format = SnapshotFormat,
        project = info.Project,
        members = info.Members,
        symbols = info.Symbols,
    }, new JsonSerializerOptions(Reporter.JsonOptions) { WriteIndented = true }) + "\n";

    private static string Csv(string? s) => s is null ? "" : s.IndexOfAny([';', '"', '\n']) >= 0 ? $"\"{s.Replace("\"", "\"\"")}\"" : s;

    public static string ToCsv(IEnumerable<AdsSymbol> symbols)
    {
        var sb = new StringBuilder("Name;Type;BitSize;Area;Comment\n");
        foreach (var s in symbols) sb.Append($"{Csv(s.Name)};{Csv(s.Type)};{s.BitSize};{Csv(s.Area)};{Csv(s.Comment)}\n");
        return sb.ToString();
    }

    public static string ToCsv(IEnumerable<AdsChange> changes)
    {
        var sb = new StringBuilder("Change;Name;Before;After;Details\n");
        foreach (var c in changes) sb.Append($"{c.Kind.ToString().ToLowerInvariant()};{Csv(c.Name)};{Csv(c.Before)};{Csv(c.After)};{Csv(c.Details)}\n");
        return sb.ToString();
    }
}
