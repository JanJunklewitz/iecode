using System.Diagnostics;

namespace IECode.Core.Tests;

/// <summary>
/// The named mutex around library repository writes. A mutex belongs to a thread, so each acquire that must not be
/// the test thread's runs on its own thread; the two-process tests hold it from a PowerShell child with a handshake.
/// </summary>
public class RepositoryLockTests
{
    private static string Unique() => @"Local\iecode-test-" + Guid.NewGuid().ToString("N");
    private static Reporter Log(StringWriter? err = null) => new(json: false, verbose: false, stdout: new StringWriter(), stderr: err ?? new StringWriter());

    [Fact]
    public void SecondAcquireWaitsUntilTheFirstIsReleased()
    {
        var name = Unique();
        var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name);
        var t = new OnThread<DateTime>(() => { using var _ = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name); return DateTime.UtcNow; });
        Thread.Sleep(300);
        Assert.False(t.IsCompleted);
        var released = DateTime.UtcNow;
        first.Dispose();
        Assert.True(t.Result >= released);
    }

    [Fact]
    public void TimesOut()
    {
        var name = Unique();
        using var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name);
        var e = new OnThread<IECodeException>(() => Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(200), name))).Result;
        Assert.Equal(ExitCodes.Timeout, e.ExitCode);
    }

    [Fact]
    public void WaitingIsLoggedOnce()
    {
        var name = Unique();
        var err = new StringWriter();
        using (RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name))
            _ = new OnThread<IECodeException>(() => Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(err), TimeSpan.FromMilliseconds(300), name))).Result;
        Assert.Single(err.ToString().Split('\n'), l => l.Contains("Waiting for another iecode library install"));
        using var free = RepositoryLock.Acquire(Log(err = new StringWriter()), TimeSpan.FromSeconds(1), name);
        Assert.DoesNotContain("Waiting", err.ToString());
    }

    [Fact]
    public void AbandonedLockIsAcquired()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "abandoned named mutexes are a Windows notion");
        var name = Unique();
        var th = new Thread(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name)); // never disposed: abandoned when the thread ends
        th.Start();
        th.Join();
        using var second = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name);
    }

    [Fact]
    public void AbandonedLockWaitsForTheWriterOfTheDeadHolder()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "abandoned named mutexes are a Windows notion");
        var name = Unique();
        using var writer = PowerShell("Start-Sleep -Milliseconds 1500");
        var th = new Thread(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name).RecordWriter(writer));
        th.Start();
        th.Join();
        var err = new StringWriter();
        using var second = RepositoryLock.Acquire(Log(err), TimeSpan.FromSeconds(10), name);
        Assert.True(writer.HasExited);
        Assert.Contains($"PID {writer.Id}", err.ToString());
    }

    [Fact]
    public void AbandonedLockTimesOutWhileTheWriterRuns()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "abandoned named mutexes are a Windows notion");
        var name = Unique();
        using var writer = PowerShell("Start-Sleep -Seconds 20");
        try
        {
            var th = new Thread(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name).RecordWriter(writer));
            th.Start();
            th.Join();
            var e = Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(500), name));
            Assert.Equal(ExitCodes.Timeout, e.ExitCode);
        }
        finally { writer.Kill(); }
    }

    [Fact]
    public void ReleasedLockDoesNotWaitForAnOldWriter()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "the writer is a Windows PowerShell child");
        var name = Unique();
        using var writer = PowerShell("Start-Sleep -Seconds 20");
        try
        {
            using (var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name)) first.RecordWriter(writer);
            var sw = Stopwatch.StartNew();
            using var second = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name);
            Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3));
        }
        finally { writer.Kill(); }
    }

    [Fact]
    public void AnotherProcessHoldsTheLockUntilItEnds()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "the child holds the mutex through Windows PowerShell");
        var name = Unique();
        using var child = PowerShell(
            $"$m = [System.Threading.Mutex]::new($false, '{name}'); [void]$m.WaitOne(); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadLine()",
            redirectInput: true);
        try
        {
            Assert.Equal("ready", child.StandardOutput.ReadLine()); // handshake: the child owns the mutex now
            var e = Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(300), name));
            Assert.Equal(ExitCodes.Timeout, e.ExitCode);

            var waiter = new OnThread<bool>(() => { using var _ = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(15), name); return true; });
            Thread.Sleep(300);
            Assert.False(waiter.IsCompleted);
            child.StandardInput.WriteLine(); // the child ends without releasing: the mutex is abandoned
            Assert.True(waiter.Result);
        }
        finally { if (!child.HasExited) child.Kill(); }
    }

    /// <summary>Runs on its own thread (a mutex belongs to the thread that took it); Result joins it.</summary>
    private sealed class OnThread<T>
    {
        private readonly Thread _thread;
        private T? _result;
        private Exception? _error;

        public OnThread(Func<T> body)
        {
            _thread = new Thread(() => { try { _result = body(); } catch (Exception e) { _error = e; } }) { IsBackground = true };
            _thread.Start();
        }

        public bool IsCompleted => !_thread.IsAlive;

        public T Result
        {
            get
            {
                if (!_thread.Join(TimeSpan.FromSeconds(30))) throw new TimeoutException("thread did not end");
                if (_error is not null) throw new AggregateException(_error);
                return _result!;
            }
        }
    }

    private static Process PowerShell(string script, bool redirectInput = false) =>
        Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardInput = redirectInput,
        })!;
}
