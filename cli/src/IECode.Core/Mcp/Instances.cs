using System.Text.Json;

namespace IECode.Core.Mcp;

/// <summary>One serving VS Code window as described by its instance file.</summary>
public sealed record InstanceInfo(string Id, int Pid, string ExtensionVersion, int ProtocolMin, int ProtocolMax,
    string Pipe, IReadOnlyList<string> Roots, string WorkspaceName, string Secret);

public static class Instances
{
    /// <summary>Reads every <c>*.json</c> of the instances directory; an unreadable file or one that is not format 1 is skipped.</summary>
    public static IReadOnlyList<InstanceInfo> Load(string instancesDir)
    {
        var result = new List<InstanceInfo>();
        string[] files;
        try { files = Directory.GetFiles(instancesDir, "*.json"); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return result; }
        foreach (var file in files)
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file));
                var r = doc.RootElement;
                if (r.ValueKind != JsonValueKind.Object || !r.TryGetProperty("format", out var f) || f.ValueKind != JsonValueKind.Number || f.GetInt32() != 1) continue;
                var proto = r.GetProperty("bridgeProtocol");
                result.Add(new InstanceInfo(
                    r.GetProperty("id").GetString()!,
                    r.GetProperty("pid").GetInt32(),
                    r.GetProperty("extensionVersion").GetString() ?? "",
                    proto.GetProperty("min").GetInt32(),
                    proto.GetProperty("max").GetInt32(),
                    r.GetProperty("pipe").GetString()!,
                    r.GetProperty("roots").EnumerateArray().Select(x => x.GetString()!).ToList(),
                    r.TryGetProperty("workspaceName", out var w) ? w.GetString() ?? "" : "",
                    r.GetProperty("secret").GetString()!));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
            {
                // half-written or foreign file: not an instance
            }
        }
        return result;
    }
}

public static class PathMatch
{
    private const char Sep = '\\';

    /// <summary>Full path, every existing link component resolved, backslashes, lower-case drive letter, no trailing separator (a drive root keeps its one).</summary>
    public static string Canonical(string path)
    {
        var full = Path.GetFullPath(path).Replace('/', Sep);
        var root = Path.GetPathRoot(full) ?? "";
        var current = root;
        foreach (var part in full[root.Length..].Split(Sep, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            var resolved = Resolve(current);
            if (resolved is not null) current = resolved;
        }
        var s = current.Replace('/', Sep);
        while (s.Length > 1 && s[^1] == Sep && !(s.Length == 3 && s[1] == ':')) s = s[..^1];
        if (s.Length >= 2 && s[1] == ':') s = char.ToLowerInvariant(s[0]) + s[1..];
        return s;
    }

    private static string? Resolve(string existing)
    {
        try
        {
            FileSystemInfo info = Directory.Exists(existing) ? new DirectoryInfo(existing) : new FileInfo(existing);
            return info.Exists ? info.ResolveLinkTarget(true)?.FullName : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>True when <paramref name="path"/> is the folder <paramref name="root"/> or lies inside it (component by component).</summary>
    public static bool Contains(string root, string path)
    {
        var r = Canonical(root);
        var p = Canonical(path);
        if (p.Equals(r, StringComparison.OrdinalIgnoreCase)) return true;
        var prefix = r.EndsWith(Sep) ? r : r + Sep;
        return p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }
}
