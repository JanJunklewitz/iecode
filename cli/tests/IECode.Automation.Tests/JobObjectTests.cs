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

    private const string HelperEnv = "IECODE_JOB_HELPER_FILE";

    /// <summary>
    /// Runs only inside the helper process of <see cref="TheJobEndsItsProcessesWhenItsOwnerIsKilled"/>: owns the job, puts a
    /// child into it, reports the child's PID and then waits to be killed. Without the variable it does nothing.
    /// </summary>
    [Fact]
    public void JobOwnerHelper()
    {
        if (Environment.GetEnvironmentVariable(HelperEnv) is not { Length: > 0 } file) return;
        var child = Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 120"]) { UseShellExecute = false })!;
        if (!JobObject.TryKillOnClose(child, new Reporter(json: false, verbose: true, stdout: new StringWriter(), stderr: new StringWriter())))
            File.WriteAllText(file + ".failed", child.Id.ToString());
        else
            File.WriteAllText(file, child.Id.ToString());
        Thread.Sleep(TimeSpan.FromMinutes(2));
    }

    [Fact]
    public void TheJobEndsItsProcessesWhenItsOwnerIsKilled()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows job objects");
        var file = Path.Combine(Path.GetTempPath(), "iecode-job-" + Guid.NewGuid().ToString("N"));
        var exe = Path.ChangeExtension(typeof(JobObjectTests).Assembly.Location, ".exe");
        var psi = new ProcessStartInfo(exe, ["-method", typeof(JobObjectTests).FullName + "." + nameof(JobOwnerHelper), "-noColor"])
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment[HelperEnv] = file;
        using var owner = Process.Start(psi)!;
        // the helper's pipes are drained so it never blocks on a full buffer
        owner.OutputDataReceived += (_, _) => { };
        owner.ErrorDataReceived += (_, _) => { };
        owner.BeginOutputReadLine();
        owner.BeginErrorReadLine();
        Process? child = null;
        try
        {
            var sw = Stopwatch.StartNew();
            while (!File.Exists(file) && !File.Exists(file + ".failed") && !owner.HasExited && sw.Elapsed < TimeSpan.FromSeconds(60)) Thread.Sleep(100);
            Assert.False(File.Exists(file + ".failed"), "the helper could not put its child into the job");
            Assert.True(File.Exists(file), "the helper did not report its child (exited: " + owner.HasExited + ")");
            child = Process.GetProcessById(int.Parse(File.ReadAllText(file)));
            Assert.False(child.HasExited);

            // the owner dies like an iecode that was killed: nothing but the job can end the child now
            owner.Kill(entireProcessTree: false);
            owner.WaitForExit(10000);
            Assert.True(child.WaitForExit(10000), "the child outlived the owner of its kill-on-close job");
        }
        finally
        {
            if (!owner.HasExited) owner.Kill();
            if (child is { HasExited: false }) child.Kill();
            child?.Dispose();
            File.Delete(file);
            File.Delete(file + ".failed");
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
