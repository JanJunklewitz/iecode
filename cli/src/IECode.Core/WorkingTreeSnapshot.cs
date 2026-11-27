using System.Security.Cryptography;

namespace IECode.Core;

/// <summary>
/// The <c>git status</c> of a folder at one moment, with length, write time and content hash of every listed file, so a
/// build's side effects can be listed ("git status changes"). Files clean before and after are not seen.
/// </summary>
public sealed class WorkingTreeSnapshot
{
    private sealed record Entry(string Code, long Length, DateTime WriteUtc, string? Hash);

    private readonly Dictionary<string, Entry> _entries;

    private WorkingTreeSnapshot(Dictionary<string, Entry> entries) => _entries = entries;

    /// <summary>The snapshot of a folder in a git working tree; null when it is not in one or git is not installed.</summary>
    public static WorkingTreeSnapshot? Take(string folder)
    {
        Git git;
        IReadOnlyList<(string Code, string Path, string? OrigPath)> status;
        try
        {
            git = Git.Open(folder);
            status = git.StatusEntries(folder);
        }
        catch (IECodeException) { return null; }

        var entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        foreach (var (code, path, orig) in status)
        {
            entries[path] = Read(git.Root, path, code);
            if (orig is not null) entries[orig] = Read(git.Root, orig, code);
        }
        return new WorkingTreeSnapshot(entries);
    }

    private static Entry Read(string root, string path, string code)
    {
        var info = new FileInfo(Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar)));
        if (!info.Exists) return new Entry(code, -1, default, null);
        try
        {
            using var s = info.OpenRead();
            return new Entry(code, info.Length, info.LastWriteTimeUtc, Convert.ToHexString(SHA256.HashData(s)));
        }
        catch (IOException) { return new Entry(code, info.Length, info.LastWriteTimeUtc, null); }
        catch (UnauthorizedAccessException) { return new Entry(code, info.Length, info.LastWriteTimeUtc, null); }
    }

    /// <summary>
    /// Repository-relative paths ('/') that appeared in or left the status list, or whose status, length, time or
    /// content differs from <paramref name="before"/>; sorted.
    /// </summary>
    public IReadOnlyList<string> ChangedSince(WorkingTreeSnapshot before) =>
        _entries.Keys.Union(before._entries.Keys)
            .Where(p => !_entries.TryGetValue(p, out var now) || !before._entries.TryGetValue(p, out var then) || now != then)
            .Order(StringComparer.Ordinal)
            .ToList();
}
