using System.Diagnostics;
using System.Runtime.Versioning;
using IECode.Core;

namespace IECode.Automation.Tests;

/// <summary>RepTool runs against batch-file doubles: supervision, the writer record, the timeout and the bounded output wait.</summary>
[SupportedOSPlatform("windows")]
public sealed class RepToolRunTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iecode-reptool-" + Guid.NewGuid().ToString("N")[..8]);
    private readonly string _lock = @"Local\iecode-test-" + Guid.NewGuid().ToString("N");
    private readonly StringWriter _out = new(), _err = new();

    public RepToolRunTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        var record = IECode.Core.RepositoryLock.WriterFilePath(_lock);
        try { File.Delete(record); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        try { Directory.Delete(record); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
        try { Directory.Delete(_dir, true); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
    }

    private Reporter Log => new(json: false, verbose: true, stdout: _out, stderr: _err);
    private string Record => IECode.Core.RepositoryLock.WriterFilePath(_lock);

    private RepTool Fake(string script, TimeSpan? timeout = null)
    {
        var exe = Path.Combine(_dir, "RepTool.cmd");
        File.WriteAllText(exe, "@echo off\r\n" + script + "\r\n");
        return RepTool.At(exe, "TwinCAT PLC Control_Build_4026.28", timeout ?? TimeSpan.FromSeconds(30), _lock);
    }

    private static bool Gone(int pid) { try { using var p = Process.GetProcessById(pid); return p.HasExited; } catch (ArgumentException) { return true; } }

    [Fact]
    public void ReturnsTheExitCodeAndLogsTheOutput()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "RepTool is a Windows tool");
        var code = Fake("echo installed %2\r\necho oops>&2\r\nexit /b 4").Uninstall(["Lib,1.0.0.0(Vendor)"], Log);
        Assert.Equal(4, code);
        Assert.Contains("installed", _out.ToString() + _err.ToString());
        Assert.Contains("oops", _err.ToString());
        Assert.False(File.Exists(Record));   // ended: nothing left for the next holder to wait for
    }

    [Fact]
    public void TheWriterIsRecordedBeforeRepToolRunsItsFirstCommand()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "RepTool is a Windows tool");
        var marker = Path.Combine(_dir, "seen.txt");
        // the double reports whether the record existed when it started
        Fake($"if exist \"{Record}\" (echo recorded>\"{marker}\") else (echo missing>\"{marker}\")\r\nexit /b 0").Uninstall(["x"], Log);
        Assert.Equal("recorded", File.ReadAllText(marker).Trim());
    }

    [Fact]
    public void RepToolNeverRunsWhenItsRecordCannotBeWritten()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "RepTool is a Windows tool");
        var marker = Path.Combine(_dir, "ran.txt");
        Directory.CreateDirectory(Record);   // a directory where the record belongs: it cannot be published
        Assert.ThrowsAny<Exception>(() => Fake($"echo x>\"{marker}\"\r\nexit /b 0").Uninstall(["x"], Log));
        Thread.Sleep(500);
        Assert.False(File.Exists(marker));
    }

    [Fact]
    public void ATimeoutStopsRepToolAndItsDescendantsAndClearsTheRecord()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "RepTool is a Windows tool");
        var before = Process.GetProcessesByName("ping").Select(p => p.Id).ToHashSet();
        var e = Assert.Throws<IECodeException>(() => Fake("ping -n 60 127.0.0.1 >nul", TimeSpan.FromSeconds(1)).Uninstall(["x"], Log));
        Assert.Equal(ExitCodes.Timeout, e.ExitCode);
        Assert.Contains("was stopped", e.Message);
        Assert.False(File.Exists(Record));
        Assert.All(Process.GetProcessesByName("ping").Select(p => p.Id).Where(id => !before.Contains(id)), id => Assert.True(Gone(id) || WaitGone(id)));
    }

    [Fact]
    public void ADescendantHoldingTheOutputOpenDoesNotHoldRepToolUp()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "RepTool is a Windows tool");
        var sw = Stopwatch.StartNew();
        var code = Fake("start /b ping -n 40 127.0.0.1\r\nexit /b 0").Uninstall(["x"], Log);
        Assert.Equal(0, code);
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(20), $"took {sw.Elapsed}");
        Assert.False(File.Exists(Record));
    }

    private static bool WaitGone(int pid)
    {
        for (var i = 0; i < 100; i++) { if (Gone(pid)) return true; Thread.Sleep(100); }
        return false;
    }
}
