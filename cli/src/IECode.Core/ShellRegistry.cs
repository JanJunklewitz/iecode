using System.Diagnostics;
using System.Text.Json;

namespace IECode.Core;

/// <summary>
/// One XAE shell iecode started: its process (PID and exact creation time from the process handle, so a reused PID
/// never matches) and the iecode process that owns it.
/// </summary>
public sealed record ShellEntry(int Pid, DateTime StartedUtc, int OwnerPid, DateTime OwnerStartedUtc, string ProgId, string? Solution);

/// <summary>What <c>iecode shells</c> may do with a recorded shell.</summary>
public enum ShellState
{
    /// <summary>The recorded process is gone (or the PID now belongs to another process); the entry can be dropped.</summary>
    Stale,
    /// <summary>The shell runs and the iecode that started it is gone.</summary>
    Orphaned,
    /// <summary>The shell runs and its iecode still runs (a live command); killed only with --force.</summary>
    Owned,
}

/// <summary>
/// The XAE shells iecode started, one JSON file <c>&lt;pid&gt;.json</c> per shell (default
/// <c>%LOCALAPPDATA%\iecode\shells</c>). Backs <c>iecode shells list | kill</c>: only recorded processes are touched.
/// </summary>
public sealed class ShellRegistry(string folder)
{
    public string Folder { get; } = folder;

    public static string DefaultFolder() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iecode", "shells");

    public void Add(ShellEntry e)
    {
        Directory.CreateDirectory(Folder);
        var file = FileOf(e.Pid);
        var temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(e, Reporter.JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    public void Remove(int pid)
    {
        try { File.Delete(FileOf(pid)); }
        catch (DirectoryNotFoundException) { }
    }

    /// <summary>Every readable entry; broken or half-written files are skipped.</summary>
    public IReadOnlyList<ShellEntry> All()
    {
        if (!Directory.Exists(Folder)) return [];
        var list = new List<ShellEntry>();
        foreach (var file in Directory.EnumerateFiles(Folder, "*.json"))
        {
            try
            {
                if (JsonSerializer.Deserialize<ShellEntry>(File.ReadAllText(file), Reporter.JsonOptions) is { ProgId: not null } e) list.Add(e);
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException) { }
        }
        return [.. list.OrderBy(e => e.StartedUtc)];
    }

    /// <summary>The recorded process still runs: it exists and its creation time is exactly the recorded one.</summary>
    public static bool IsSame(ShellEntry e, DateTime? actualStartUtc) => actualStartUtc == e.StartedUtc;

    /// <summary>The iecode that started the shell still runs (same PID and creation time).</summary>
    public static bool OwnerAlive(ShellEntry e, DateTime? ownerActualStartUtc) => ownerActualStartUtc == e.OwnerStartedUtc;

    public static ShellState State(ShellEntry e, DateTime? shellStartUtc, DateTime? ownerStartUtc) =>
        !IsSame(e, shellStartUtc) ? ShellState.Stale
        : OwnerAlive(e, ownerStartUtc) ? ShellState.Owned
        : ShellState.Orphaned;

    /// <summary>Orphaned shells are killed; a shell whose iecode still runs only with <paramref name="force"/>; stale ones never.</summary>
    public static bool MayKill(ShellState s, bool force) => s == ShellState.Orphaned || (s == ShellState.Owned && force);

    /// <summary>
    /// The shell a CreateInstance started, from the shell processes before and after it (taken under the shell-start
    /// mutex): exactly one new PID, else null (another program started a shell at the same time; nothing is owned).
    /// </summary>
    public static int? Started(IEnumerable<int> before, IEnumerable<int> after)
    {
        var fresh = after.Except(before).Distinct().ToList();
        return fresh.Count == 1 ? fresh[0] : null;
    }

    /// <summary>Creation time (UTC) of a running process, or null when there is none with that PID.</summary>
    public static DateTime? StartTimeOf(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.HasExited ? null : p.StartTime.ToUniversalTime();
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return null;
        }
    }

    private string FileOf(int pid) => Path.Combine(Folder, pid + ".json");
}
