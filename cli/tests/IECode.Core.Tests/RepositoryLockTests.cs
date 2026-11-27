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
        using var writer = Holder("$null");   // runs until the test releases it: no timing assumption
        try
        {
            var th = new Thread(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name).RecordWriter(writer));
            th.Start();
            th.Join();
            var err = new StringWriter();
            var second = new OnThread<bool>(() => { using var _ = RepositoryLock.Acquire(Log(err), TimeSpan.FromSeconds(30), name); return true; });
            Assert.True(SpinWait.SpinUntil(() => err.ToString().Contains($"PID {writer.Id}"), TimeSpan.FromSeconds(20)));   // it is waiting for the writer
            Assert.False(second.IsCompleted);
            writer.StandardInput.WriteLine();
            Assert.True(second.Result);
            Assert.True(writer.WaitForExit(10000));
        }
        finally { if (!writer.HasExited) writer.Kill(); }
    }

    [Fact]
    public void ARecordThatCannotBeUnderstoodFailsClosed()
    {
        var name = Unique();
        var file = RepositoryLock.WriterFilePath(name);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "not a record");
        try
        {
            var e = Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name));
            Assert.Equal(ExitCodes.Failed, e.ExitCode);
            Assert.Contains(file, e.Message);
            Assert.True(File.Exists(file));   // not silently discarded
        }
        finally { File.Delete(file); }
    }

    [Fact]
    public void ARecordThatCannotBeReadFailsClosed()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "an exclusive open blocks reading only on Windows");
        var name = Unique();
        var file = RepositoryLock.WriterFilePath(name);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "1 2");
        try
        {
            using var exclusive = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            Assert.Equal(ExitCodes.Failed, Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name)).ExitCode);
        }
        finally { File.Delete(file); }
    }

    [Fact]
    public void AMissingRecordMeansNoWriterAndAGoneProcessIsNotWaitedFor()
    {
        var name = Unique();
        var file = RepositoryLock.WriterFilePath(name);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.Delete(file);
        using (RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name)) { }
        File.WriteAllText(file, $"{int.MaxValue - 7} 1");   // no such process
        try { using var _ = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name); }
        finally { File.Delete(file); }
    }

    [Fact]
    public void TheRecordIsPublishedWholeAndLeavesNoTempFile()
    {
        var name = Unique();
        var file = RepositoryLock.WriterFilePath(name);
        try
        {
            using (var held = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(2), name))
            {
                held.RecordWriter(4242, 99);
                Assert.Equal("4242 99", File.ReadAllText(file));
                held.RecordWriter(4243, 100);   // replaces the previous record
                Assert.Equal("4243 100", File.ReadAllText(file));
            }
            Assert.Empty(Directory.EnumerateFiles(Path.GetDirectoryName(file)!, Path.GetFileName(file) + ".*.tmp"));
        }
        finally { File.Delete(file); }
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
    public void ClearedWriterIsNotWaitedFor()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "the writer is a Windows PowerShell child");
        var name = Unique();
        using var writer = PowerShell("Start-Sleep -Seconds 20");
        try
        {
            using (var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name))
            {
                first.RecordWriter(writer);
                first.ClearWriter();
            }
            var sw = Stopwatch.StartNew();
            using var second = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name);
            Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3));
        }
        finally { writer.Kill(); }
    }

    [Fact]
    public void ReleasedLockWithAWriterStillRunningMakesTheNextHolderWait()
    {
        // a RepTool that could not be stopped after a timeout stays recorded, also when its holder released normally
        Assert.SkipUnless(WindowsOnly.IsWindows, "the writer is a Windows PowerShell child");
        var name = Unique();
        using var writer = PowerShell("Start-Sleep -Seconds 20");
        try
        {
            using (var first = RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name)) first.RecordWriter(writer);
            var e = Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(500), name));
            Assert.Equal(ExitCodes.Timeout, e.ExitCode);
        }
        finally { writer.Kill(); }
    }

    [Fact]
    public void AWaiterThatTimesOutKeepsTheRecordForTheNext()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "abandoned named mutexes are a Windows notion");
        var name = Unique();
        using var writer = PowerShell("Start-Sleep -Seconds 20");
        try
        {
            var th = new Thread(() => RepositoryLock.Acquire(Log(), TimeSpan.FromSeconds(5), name).RecordWriter(writer));
            th.Start();
            th.Join();
            Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(500), name));
            var e = Assert.Throws<IECodeException>(() => RepositoryLock.Acquire(Log(), TimeSpan.FromMilliseconds(500), name));
            Assert.Equal(ExitCodes.Timeout, e.ExitCode);
        }
        finally { writer.Kill(); }
    }

    [Fact]
    public void WaitsForAFileThatIsStillBeingWritten()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "only Windows keeps a file open for writing from exclusive opens");
        var file = Path.Combine(Path.GetTempPath(), "iecode-ready-" + Guid.NewGuid().ToString("N") + ".library");
        var stream = new FileStream(file, FileMode.Create, FileAccess.Write, FileShare.Read);
        try
        {
            stream.Write(new byte[100]);
            var closer = new Thread(() => { Thread.Sleep(600); stream.Dispose(); });
            var sw = Stopwatch.StartNew();
            closer.Start();
            FileReady.Wait(file, TimeSpan.FromSeconds(10));
            Assert.True(sw.Elapsed >= TimeSpan.FromMilliseconds(500));
            closer.Join();
        }
        finally { stream.Dispose(); File.Delete(file); }
    }

    [Fact]
    public void AFileThatNeverAppearsTimesOut()
    {
        var e = Assert.Throws<IECodeException>(() => FileReady.Wait(Path.Combine(Path.GetTempPath(), "iecode-missing-" + Guid.NewGuid().ToString("N")), TimeSpan.FromMilliseconds(300)));
        Assert.Equal(ExitCodes.LibraryFailed, e.ExitCode);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData(60, 60)]
    public void TimeoutSecondsAreTaken(int? given, int? seconds) =>
        Assert.Equal(seconds is int s ? TimeSpan.FromSeconds(s) : (TimeSpan?)null, TimeoutSetting.FromSeconds(given));

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(int.MaxValue)]
    public void TimeoutOutsideTheRangeIsAUsageError(int given) =>
        Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => TimeoutSetting.FromSeconds(given)).ExitCode);

    [Fact]
    public void AnotherProcessHoldsTheLockUntilItEnds()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "the child holds the mutex through Windows PowerShell");
        var name = Unique();
        using var child = Holder($"$m = [System.Threading.Mutex]::new($false, '{name}'); [void]$m.WaitOne()");   // returns once the child owns the mutex
        try
        {
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

    /// <summary>
    /// A PowerShell child that has run <paramref name="body"/>, reported "ready" (bounded wait) and then waits for a line on its
    /// input, so a test decides when it ends instead of guessing with a sleep. It is killed when the handshake fails.
    /// </summary>
    private static Process Holder(string body)
    {
        var child = PowerShell($"{body}; [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadLine()", redirectInput: true);
        var line = child.StandardOutput.ReadLineAsync();
        if (!line.Wait(TimeSpan.FromSeconds(30)) || line.Result != "ready")
        {
            try { child.Kill(); } catch (InvalidOperationException) { }
            throw new TimeoutException("the child process did not report ready");
        }
        return child;
    }

    private static Process PowerShell(string script, bool redirectInput = false) =>
        Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardInput = redirectInput,
        })!;
}
