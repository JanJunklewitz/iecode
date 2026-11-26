using System.Diagnostics;
using System.Runtime.Versioning;

namespace IECode.Automation.Tests;

[SupportedOSPlatform("windows")]
public class ProcessTerminationTests
{
    private static Process Sleeper() =>
        Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 60"]) { UseShellExecute = false })!;

    [Fact]
    public void ARecordedProcessIsEndedAndItsExitConfirmed()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows processes");
        using var p = Sleeper();
        try
        {
            Assert.Equal(ProcessEnd.Ended, ProcessTermination.End(p.Id, p.StartTime.ToUniversalTime(), TimeSpan.FromSeconds(10), out _));
            Assert.True(p.WaitForExit(5000));
        }
        finally { if (!p.HasExited) p.Kill(); }
    }

    [Fact]
    public void AProcessWithAnotherCreationTimeIsLeftAlone()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows processes");
        using var p = Sleeper();
        try
        {
            // the PID of the recorded shell now belongs to this (different) process
            var result = ProcessTermination.End(p.Id, p.StartTime.ToUniversalTime().AddSeconds(-30), TimeSpan.FromSeconds(1), out var detail);
            Assert.Equal(ProcessEnd.Gone, result);
            Assert.Contains("another process", detail);
            Assert.False(p.HasExited);
        }
        finally { p.Kill(); p.WaitForExit(5000); }
    }

    [Fact]
    public void AnEndedProcessIsGoneEvenWhileAHandleKeepsItListed()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows processes");
        using var p = Sleeper();
        var start = p.StartTime.ToUniversalTime();
        p.Kill();
        p.WaitForExit(5000);
        Assert.Equal(ProcessEnd.Gone, ProcessTermination.End(p.Id, start, TimeSpan.FromSeconds(1), out _));
    }

    [Fact]
    public void ANonexistentPidIsGone()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows processes");
        Assert.Equal(ProcessEnd.Gone, ProcessTermination.End(int.MaxValue - 3, DateTime.UtcNow, TimeSpan.FromSeconds(1), out _));
    }

    [Fact]
    public void AProcessThatCannotBeOpenedIsAFailureNotPermissionToProceed()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows processes");
        // PID 4 (System) refuses terminate access for a normal user: that must not read as 'gone'
        var result = ProcessTermination.End(4, DateTime.UtcNow, TimeSpan.FromSeconds(1), out var detail);
        Assert.Equal(ProcessEnd.Failed, result);
        Assert.NotNull(detail);
    }
}
