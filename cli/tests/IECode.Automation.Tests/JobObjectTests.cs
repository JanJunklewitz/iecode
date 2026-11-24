using System.Diagnostics;
using System.Runtime.Versioning;
using IECode.Automation.Interop;
using IECode.Core;

namespace IECode.Automation.Tests;

[SupportedOSPlatform("windows")]
public class JobObjectTests
{
    [Fact]
    public void AStartedProcessIsPutIntoTheKillOnCloseJob()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows job objects");
        using var p = Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 30"]) { UseShellExecute = false })!;
        try
        {
            var err = new StringWriter();
            Assert.True(JobObject.TryKillOnClose(p, new Reporter(json: false, verbose: true, stdout: new StringWriter(), stderr: err)), err.ToString());
            Assert.True(JobObject.Holds(p));
        }
        finally
        {
            p.Kill();
            p.WaitForExit(5000);
        }
    }

    [Fact]
    public void AnotherProcessIsNotInTheJob()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows job objects");
        using var p = Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 30"]) { UseShellExecute = false })!;
        try { Assert.False(JobObject.Holds(p)); }
        finally
        {
            p.Kill();
            p.WaitForExit(5000);
        }
    }
}
