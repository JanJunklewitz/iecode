using System.Diagnostics;
using System.Text.Json;

namespace IECode.Core;

/// <summary>
/// One XAE shell iecode started: its process (PID and exact creation time from the process handle, so a reused PID
/// never matches) and the iecode process that owns it. A record is identified by PID and creation time together.
/// </summary>
public sealed record ShellEntry(int Pid, DateTime StartedUtc, int OwnerPid, DateTime OwnerStartedUtc, string ProgId, string? Solution);

/// <summary>Whether a new process is the COM server behind a DTE object.</summary>
public enum ShellOwnership
{
    /// <summary>The window of the DTE object belongs to the new process, in iecode's session.</summary>
    Proven,
    /// <summary>The DTE object could not say which process serves it (yet).</summary>
    Unknown,
    /// <summary>The DTE object is served by another process than the new one: the activation reused a running server, or the new process is unrelated.</summary>
    Foreign,
}

/// <summary>What <c>iecode shells</c> may do with a recorded shell.</summary>
public enum ShellState
{
    /// <summary>The recorded process is gone (or the PID now belongs to another process); the entry can be dropped.</summary>
    Stale,
    /// <summary>A process with the recorded PID runs, but its creation time cannot be read (another user, elevated): the record stays, and nothing is killed on a guess.</summary>
    Unknown,
    /// <summary>The shell runs and the iecode that started it is gone.</summary>
    Orphaned,
    /// <summary>The shell runs and its iecode still runs (a live command); killed only with --force.</summary>
    Owned,
}

/// <summary>
/// The XAE shells iecode started, one JSON file <c>&lt;pid&gt;-&lt;creation ticks&gt;.json</c> per shell (default
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
        var file = FileOf(e);
        var temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(e, Reporter.JsonOptions));
        File.Move(temp, file, overwrite: true);
    }

    /// <summary>
    /// Drops the record of exactly this process (PID and creation time). A newer record written for a reused PID has
    /// another creation time, so it has another file and is never removed with the stale one.
    /// </summary>
    public void Remove(ShellEntry e)
    {
        try { File.Delete(FileOf(e)); }
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

    /// <param name="ownerUnreadable">The owner PID exists but its start time cannot be read: counted as alive, so a live run's shell is never ended without --force.</param>
    /// <param name="shellUnreadable">The shell PID exists but its creation time cannot be read: <see cref="ShellState.Unknown"/>, never stale and never killable.</param>
    public static ShellState State(ShellEntry e, DateTime? shellStartUtc, DateTime? ownerStartUtc, bool ownerUnreadable = false, bool shellUnreadable = false) =>
        shellUnreadable && shellStartUtc is null ? ShellState.Unknown
        : !IsSame(e, shellStartUtc) ? ShellState.Stale
        : OwnerAlive(e, ownerStartUtc) || ownerUnreadable ? ShellState.Owned
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

    /// <summary>
    /// Whether <paramref name="candidatePid"/> (the one new shell process) is the server behind the DTE object, whose
    /// main window belongs to <paramref name="serverPid"/> (null when it could not be read). A process that is only new
    /// is not proof: another program may have started a shell meanwhile, or the object may be served by a reused one.
    /// </summary>
    public static ShellOwnership Verify(int candidatePid, int candidateSession, int ownSession, int? serverPid) =>
        serverPid is not { } s || s <= 0 ? ShellOwnership.Unknown
        : s != candidatePid || candidateSession != ownSession ? ShellOwnership.Foreign
        : ShellOwnership.Proven;

    /// <summary>Creation time (UTC) of a running process, or null when there is none with that PID.</summary>
    public static DateTime? StartTimeOf(int pid) => Probe(pid).StartUtc;

    /// <summary>
    /// Creation time (UTC) of a running process; <c>Unreadable</c> when a process with that PID runs but its time cannot
    /// be read (another user, elevated).
    /// </summary>
    public static (DateTime? StartUtc, bool Unreadable) Probe(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            try { return p.HasExited ? (null, false) : (p.StartTime.ToUniversalTime(), false); }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or NotSupportedException) { return (null, true); }
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return (null, false);
        }
    }

    private string FileOf(ShellEntry e) => Path.Combine(Folder, $"{e.Pid}-{e.StartedUtc.Ticks}.json");
}
