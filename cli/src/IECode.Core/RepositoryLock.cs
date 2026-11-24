using System.Diagnostics;

namespace IECode.Core;

/// <summary>
/// Serialises writes to the TwinCAT library repository: one named mutex, held around each RepTool call. Parallel
/// installs from several iecode runs left a version listed but unusable. <c>Local\</c> limits the lock to one Windows
/// session, where parallel runs happen; it is not a machine-wide guarantee.
/// A file next to the mutex records the PID of the RepTool the holder started. When a holder dies without releasing
/// (the mutex is abandoned), its RepTool may still write; the next holder waits for that process to end.
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
    /// An abandoned mutex counts as acquired once the dead holder's recorded writer has ended. Release it on the
    /// thread that acquired it.
    /// </summary>
    public static RepositoryLock Acquire(Reporter log, TimeSpan timeout, string name = Name)
    {
        var clock = Stopwatch.StartNew();
        var mutex = new Mutex(false, name);
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
            if (abandoned)
            {
                log.Detail("The previous holder of the library repository lock ended without releasing it.");
                held.WaitForWriter(log, timeout - clock.Elapsed);
            }
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
    public void RecordWriter(Process writer)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_writerFile)!);
        File.WriteAllText(_writerFile, $"{writer.Id} {writer.StartTime.ToUniversalTime().Ticks}");
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
            log.Warn($"Waiting for the RepTool (PID {writer.Id}) of an aborted iecode to finish…");
            if (!writer.WaitForExit(timeout < TimeSpan.Zero ? TimeSpan.Zero : timeout))
                throw new IECodeException(ExitCodes.Timeout, $"The RepTool (PID {writer.Id}) of an aborted iecode is still writing to the library repository.",
                    "Wait for it to finish, or end it in the Task Manager.");
        }
        ClearWriter();
    }

    /// <summary>The recorded writer when it still runs (same PID and start time, so a reused PID does not count).</summary>
    private Process? Writer()
    {
        string[] parts;
        try { parts = File.ReadAllText(_writerFile).Split(' '); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return null; }
        if (parts.Length != 2 || !int.TryParse(parts[0], out var pid) || !long.TryParse(parts[1], out var ticks)) return null;
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

    private static string WriterFile(string name) =>
        Path.Combine(Path.GetTempPath(), "iecode", "locks", string.Concat(name.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_')) + ".writer");

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        ClearWriter();
        _mutex.ReleaseMutex();
        _mutex.Dispose();
    }
}
