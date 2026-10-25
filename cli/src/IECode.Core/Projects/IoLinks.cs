using System.Text;
using System.Xml.Linq;

namespace IECode.Core.Projects;

/// <summary>A link between a PLC / NC variable and an IO channel ("Mappings" of a TwinCAT project).</summary>
public sealed record IoLink(string Variable, string Io, IReadOnlyDictionary<string, string> Attributes, string File)
{
    public string AttributeText => string.Join(' ', Attributes.OrderBy(a => a.Key, StringComparer.Ordinal).Select(a => $"{a.Key}={a.Value}"));
}

public enum IoChangeKind { Added, Removed, Moved, Changed }

public sealed record IoChange(IoChangeKind Kind, string Variable, string? Before, string? After, string? Details = null);

/// <summary>
/// Reads IO links from .tsproj / .xti files:
/// <c>&lt;Mappings&gt;&lt;OwnerA Name="TIPC^…"&gt;&lt;OwnerB Name="TIID^…"&gt;&lt;Link VarA="…" VarB="…"/&gt;</c>.
/// The IO side (TIID^…) always ends up in <see cref="IoLink.Io"/>. Same rules as the VS Code extension.
/// </summary>
public static class IoLinks
{
    public static IReadOnlyList<IoLink> Extract(string xml, string file)
    {
        XDocument doc;
        try { doc = XDocument.Parse(xml.TrimStart('﻿')); }
        catch (Exception e) { throw new IECodeException(ExitCodes.Failed, $"Cannot read '{file}': {e.Message}", inner: e); }
        var links = new List<IoLink>();
        foreach (var a in doc.Descendants().Where(e => e.Name.LocalName == "OwnerA" && e.Attribute("Name") is not null))
        foreach (var b in a.Elements().Where(e => e.Name.LocalName == "OwnerB" && e.Attribute("Name") is not null))
        foreach (var l in b.Elements().Where(e => e.Name.LocalName == "Link"))
        {
            var sideA = $"{a.Attribute("Name")!.Value}^{l.Attribute("VarA")?.Value}";
            var sideB = $"{b.Attribute("Name")!.Value}^{l.Attribute("VarB")?.Value}";
            var attrs = l.Attributes().Where(x => x.Name.LocalName is not "VarA" and not "VarB").ToDictionary(x => x.Name.LocalName, x => x.Value);
            var (variable, io) = IsIo(sideA) && !IsIo(sideB) ? (sideB, sideA) : (sideA, sideB);
            links.Add(new IoLink(variable, io, attrs, file));
        }
        return links.OrderBy(l => l.Variable, StringComparer.Ordinal).ThenBy(l => l.Io, StringComparer.Ordinal).ToList();
    }

    private static bool IsIo(string path) => path.StartsWith("TIID^", StringComparison.OrdinalIgnoreCase);

    /// <summary>Compares two sets of links per variable: moved (other channel), added, removed, changed (same channel, other Size / offsets).</summary>
    public static IReadOnlyList<IoChange> Diff(IEnumerable<IoLink> before, IEnumerable<IoLink> after)
    {
        static Dictionary<string, Dictionary<string, IoLink>> Group(IEnumerable<IoLink> links) =>
            links.GroupBy(l => l.Variable).ToDictionary(g => g.Key, g => g.GroupBy(l => l.Io).ToDictionary(x => x.Key, x => x.First()));
        var a = Group(before);
        var b = Group(after);
        var changes = new List<IoChange>();
        foreach (var variable in a.Keys.Union(b.Keys).Order(StringComparer.Ordinal))
        {
            a.TryGetValue(variable, out var was);
            b.TryGetValue(variable, out var now);
            if (was is null) { changes.AddRange(now!.Keys.Select(io => new IoChange(IoChangeKind.Added, variable, null, io))); continue; }
            if (now is null) { changes.AddRange(was.Keys.Select(io => new IoChange(IoChangeKind.Removed, variable, io, null))); continue; }
            var gone = was.Keys.Where(io => !now.ContainsKey(io)).ToList();
            var fresh = now.Keys.Where(io => !was.ContainsKey(io)).ToList();
            var pairs = Math.Min(gone.Count, fresh.Count);
            for (var i = 0; i < pairs; i++) changes.Add(new IoChange(IoChangeKind.Moved, variable, gone[i], fresh[i]));
            changes.AddRange(gone.Skip(pairs).Select(io => new IoChange(IoChangeKind.Removed, variable, io, null)));
            changes.AddRange(fresh.Skip(pairs).Select(io => new IoChange(IoChangeKind.Added, variable, null, io)));
            foreach (var (io, link) in now)
                if (was.TryGetValue(io, out var old) && old.AttributeText != link.AttributeText)
                    changes.Add(new IoChange(IoChangeKind.Changed, variable, io, io, $"{(old.AttributeText is "" ? "–" : old.AttributeText)} → {(link.AttributeText is "" ? "–" : link.AttributeText)}"));
        }
        return changes;
    }

    /// <summary>Last <paramref name="segments"/> parts of a TwinCAT tree path, e.g. "Term 2 (EL1008)^Channel 1^Input".</summary>
    public static string Short(string? path, int segments = 3)
    {
        if (string.IsNullOrEmpty(path)) return "";
        var parts = path.Split('^');
        return parts.Length <= segments ? path : "…^" + string.Join('^', parts[^segments..]);
    }

    private static string Csv(string? s) => s is null ? "" : s.IndexOfAny([';', '"', '\n']) >= 0 ? $"\"{s.Replace("\"", "\"\"")}\"" : s;

    public static string ToCsv(IEnumerable<IoLink> links)
    {
        var sb = new StringBuilder("Variable;IO;Attributes;File\n");
        foreach (var l in links) sb.Append($"{Csv(l.Variable)};{Csv(l.Io)};{Csv(l.AttributeText)};{Csv(l.File)}\n");
        return sb.ToString();
    }

    public static string ToCsv(IEnumerable<IoChange> changes)
    {
        var sb = new StringBuilder("Change;Variable;Before;After;Details\n");
        foreach (var c in changes) sb.Append($"{c.Kind.ToString().ToLowerInvariant()};{Csv(c.Variable)};{Csv(c.Before)};{Csv(c.After)};{Csv(c.Details)}\n");
        return sb.ToString();
    }

    /// <summary>
    /// Links of a TwinCAT project (.tsproj plus all .xti files below its folder) in the working copy,
    /// or at a git commit when <paramref name="gitRef"/> is set.
    /// </summary>
    public static IReadOnlyList<IoLink> Load(string tsproj, string? gitRef)
    {
        tsproj = Path.GetFullPath(tsproj);
        var dir = Path.GetDirectoryName(tsproj)!;
        string Rel(string f) => Path.GetRelativePath(dir, f).Replace('\\', '/');
        var links = new List<IoLink>();
        if (gitRef is null)
        {
            var xti = Directory.EnumerateFiles(dir, "*.xti", SearchOption.AllDirectories)
                .Where(f => !Path.GetRelativePath(dir, f).Split(Path.DirectorySeparatorChar).Any(s => s.StartsWith('_') || s.StartsWith('.')));
            foreach (var f in xti.Prepend(tsproj)) links.AddRange(Extract(File.ReadAllText(f), Rel(f)));
            return links;
        }
        var git = Git.Open(dir);
        foreach (var rel in git.FilesAt(gitRef, dir).Where(r => r.EndsWith(".xti", StringComparison.OrdinalIgnoreCase)
                                                                 || r.Equals(Rel(tsproj), StringComparison.OrdinalIgnoreCase)))
        {
            var xml = git.Show(gitRef, Path.Combine(dir, rel));
            if (xml is not null) links.AddRange(Extract(xml, rel));
        }
        return links;
    }

    /// <summary>The .tsproj files a user meant: a .tsproj, the system projects of a .sln, or all .tsproj below a folder.</summary>
    public static IReadOnlyList<string> FindProjects(string? pathOrFolder)
    {
        var p = Path.GetFullPath(string.IsNullOrEmpty(pathOrFolder) ? "." : pathOrFolder);
        if (File.Exists(p))
        {
            if (p.EndsWith(".tsproj", StringComparison.OrdinalIgnoreCase)) return [p];
            if (p.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
                return SolutionFile.Load(p).TwinCatProjects.Where(t => !t.IsPlcOnly).Select(t => t.Path).ToList();
            throw new IECodeException(ExitCodes.Usage, $"'{pathOrFolder}' is not a .tsproj or .sln.");
        }
        if (!Directory.Exists(p)) throw new IECodeException(ExitCodes.NotFound, $"'{pathOrFolder}' does not exist.");
        return Directory.EnumerateFiles(p, "*.tsproj", new EnumerationOptions { RecurseSubdirectories = true, MaxRecursionDepth = 6 })
            .Where(f => !Path.GetRelativePath(p, f).Split(Path.DirectorySeparatorChar).SkipLast(1).Any(s => s.StartsWith('_') || s.StartsWith('.')))
            .Order(StringComparer.OrdinalIgnoreCase).ToList();
    }
}
