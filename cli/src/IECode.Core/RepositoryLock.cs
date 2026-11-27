using System.Diagnostics;
using System.Text;

namespace IECode.Core;

/// <summary>
/// Serialises writes to the TwinCAT library repository: one named mutex, held around each RepTool call. Parallel
/// installs from several iecode runs left a version listed but unusable. <c>Local\</c> limits the lock to one Windows
/// session, where parallel runs happen; it is not a machine-wide guarantee.
/// A file next to the mutex records the PID of the RepTool the holder started. When a holder dies without releasing
/// (the mutex is abandoned), or a RepTool cannot be stopped after a timeout, it may still write; the next holder
/// waits for that process to end. The record is per user (local application data), like the session-wide mutex.
/// RepTool itself runs suspended in a kill-on-close job and is recorded before its first instruction, so a holder
/// that dies takes it along; the record is the second line of defence. A record that cannot be read fails closed.
/// </summary>
public sealed class RepositoryLock : IDisposable
{
    public const string Name = @"Local\iecode-library-repository";
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(1800);

    private readonly Mutex _mutex;
    private readonly string _writerFile;
    private bool _disposed;

    private RepositoryLock(Mutex mutex, string writerFile)
    {
        _mutex = mutex;
        _writerFile = writerFile;
    }

    /// <summary>
    /// Takes the lock, waiting up to <paramref name="timeout"/> (exit 17 after that). Logs once when it has to wait.
    /// An abandoned mutex counts as acquired. Every holder then waits for a recorded writer that still runs (the RepTool
    /// of a holder that died, or one that could not be stopped after a timeout). Release it on the thread that acquired it.
    /// </summary>
    public static RepositoryLock Acquire(Reporter log, TimeSpan timeout, string name = Name)
    {
        var clock = Stopwatch.StartNew();
        Mutex mutex;
        try { mutex = new Mutex(false, name); }
        catch (UnauthorizedAccessException)
        {
            throw new IECodeException(ExitCodes.Failed, "The library repository lock belongs to an iecode running as administrator.",
                "Run this iecode as administrator too, or wait until the other one has ended.");
        }
        bool abandoned = false, owned;
        try
        {
            owned = Wait(mutex, TimeSpan.Zero, ref abandoned);
            if (!owned)
            {
                log.Step("Waiting for another iecode library install…");
                owned = Wait(mutex, timeout, ref abandoned);
            }
        }
        catch { mutex.Dispose(); throw; }
        if (!owned)
        {
            mutex.Dispose();
            throw new IECodeException(ExitCodes.Timeout, $"Another iecode kept the library repository locked for {timeout.TotalSeconds:0} s.",
                "Wait for it to finish, or raise --timeout.");
        }

        var held = new RepositoryLock(mutex, WriterFile(name));
        try
        {
            if (abandoned) log.Detail("The previous holder of the library repository lock ended without releasing it.");
            held.WaitForWriter(log, timeout - clock.Elapsed);
            return held;
        }
        catch { held.Dispose(); throw; }
    }

    private static bool Wait(Mutex mutex, TimeSpan timeout, ref bool abandoned)
    {
        try { return mutex.WaitOne(timeout < TimeSpan.Zero ? TimeSpan.Zero : timeout); }
        catch (AbandonedMutexException) { abandoned = true; return true; }
    }

    /// <summary>Records the process that writes to the repository under this lock (RepTool).</summary>
    public void RecordWriter(Process writer) => RecordWriter(writer.Id, writer.StartTime.ToUniversalTime().Ticks);

    /// <summary>
    /// Records the writer's PID and start time. The file is published atomically (written beside, then moved over), so a reader
    /// sees the old or the new record, never a partial one. Throws when it cannot be written: a caller must not let a writer
    /// run that no later holder could wait for.
    /// </summary>
    public void RecordWriter(int pid, long startTicksUtc)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_writerFile)!);
        var temp = _writerFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                file.Write(Encoding.ASCII.GetBytes($"{pid} {startTicksUtc}"));
                file.Flush(flushToDisk: true);
            }
            File.Move(temp, _writerFile, overwrite: true);
        }
        catch
        {
            try { File.Delete(temp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            throw;
        }
    }

    /// <summary>Forgets the writer once it has ended.</summary>
    public void ClearWriter()
    {
        try { File.Delete(_writerFile); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private void WaitForWriter(Reporter log, TimeSpan timeout)
    {
        if (Writer() is not { } writer) return;
        using (writer)
        {
            log.Warn($"Waiting for the RepTool (PID {writer.Id}) started by an earlier iecode to finish…");
            if (!writer.WaitForExit(timeout < TimeSpan.Zero ? TimeSpan.Zero : timeout))
                throw new IECodeException(ExitCodes.Timeout, $"The RepTool (PID {writer.Id}) started by an earlier iecode is still writing to the library repository.",
                    "Wait for it to finish, or end it in the Task Manager.");
        }
        ClearWriter();
    }

    /// <summary>
    /// The recorded writer when it still runs (same PID and start time, so a reused PID does not count); null when there is no
    /// record or its process is gone. A record that cannot be read or understood fails closed: it may name a RepTool that still
    /// writes, and starting another one next to it is what the lock exists to prevent.
    /// </summary>
    private Process? Writer()
    {
        string content;
        try { content = File.ReadAllText(_writerFile); }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { return null; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw Unreadable(e.Message, e); }
        var parts = content.Split(' ');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var pid) || !long.TryParse(parts[1], out var ticks))
            throw Unreadable("it does not hold a PID and a start time", null);
        Process p;
        try { p = Process.GetProcessById(pid); }
        catch (ArgumentException) { return null; }
        try
        {
            if (!p.HasExited && p.StartTime.ToUniversalTime().Ticks == ticks) return p;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { }
        p.Dispose();
        return null;
    }

    private IECodeException Unreadable(string why, Exception? inner) =>
        new(ExitCodes.Failed, $"The record of the RepTool that writes to the library repository cannot be read ('{_writerFile}'): {why}.",
            "Check in the Task Manager that no RepTool.exe is running, then delete that file.", inner);

    /// <summary>Where the record of the writer for the named lock lives (public for the tests of other assemblies).</summary>
    public static string WriterFilePath(string name) => WriterFile(name);

    private static string WriterFile(string name) =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iecode", "locks", string.Concat(name.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_')) + ".writer");

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // the writer record stays: RepTool.Run clears it once its RepTool has ended, so one that could not be stopped is waited for
        _mutex.ReleaseMutex();
        _mutex.Dispose();
    }
}
