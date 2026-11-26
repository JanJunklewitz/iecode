using System.Diagnostics;
using System.Runtime.Versioning;
using IECode.Automation.Interop;
using IECode.Core;

namespace IECode.Automation.Tests;

/// <summary>
/// The dialog watcher against a real modal message box in a second process (a Windows PowerShell with a form that owns
/// the box), with the timings shortened to one second.
/// </summary>
[SupportedOSPlatform("windows")]
public class DialogWatchTests
{
    private static readonly DialogTimings Fast = new(TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    private const string Title = "iecode test dialog";

    private static Reporter Log(StringWriter err) => new(json: false, verbose: true, stdout: new StringWriter(), stderr: err);

    /// <summary>Starts a process that shows a modal box owned by a form and prints the answer.</summary>
    private static Process ShowBox(string title, string buttons)
    {
        var script =
            "Add-Type -AssemblyName System.Windows.Forms;" +
            "$f = New-Object System.Windows.Forms.Form; $f.Text = 'iecode test owner'; $f.Show();" +
            $"$r = [System.Windows.Forms.MessageBox]::Show($f, 'The path is too long.', '{title}', '{buttons}');" +
            "[Console]::Out.WriteLine($r)";
        var psi = new ProcessStartInfo("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        return Process.Start(psi)!;
    }

    private static bool Until(Func<bool> condition, TimeSpan max)
    {
        var sw = Stopwatch.StartNew();
        while (sw.Elapsed < max)
        {
            if (condition()) return true;
            Thread.Sleep(100);
        }
        return condition();
    }

    private static void End(Process p)
    {
        try { if (!p.HasExited) p.Kill(); } catch (InvalidOperationException) { }
        p.WaitForExit(5000);
        p.Dispose();
    }

    [Fact]
    public void CancelsAnUnknownModalDialogAndReadsItsText()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(Title, "OKCancel");
        try
        {
            var err = new StringWriter();
            DialogWatch watch;
            using (watch = DialogWatch.Start(p, userCanAnswer: false, Log(err), Fast))
            {
                Assert.True(Until(() => watch.Cancelled is not null, TimeSpan.FromSeconds(30)), "no dialog cancelled: " + err);
                Assert.Equal(Title, watch.Cancelled!.Title);
                Assert.Contains("The path is too long.", watch.Cancelled.Text);
                Assert.False(watch.GaveUp);
                Assert.Equal($"XAE showed a dialog and was stopped: {Title}: The path is too long.", watch.Failure?.Message);
            }
            // XaeShell.Close reads the failure after it stopped the watcher: a dialog during the shutdown must still be visible then
            Assert.NotNull(watch.Failure);
            Assert.True(p.WaitForExit(10000));
            Assert.Equal("Cancel", p.StandardOutput.ReadToEnd().Trim());
        }
        finally { End(p); }
    }

    [Fact]
    public void EndsTheProcessWhenTheDialogIgnoresCancelAndClose()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        // a Yes/No box has no Cancel and ignores WM_CLOSE
        var p = ShowBox(Title, "YesNo");
        try
        {
            var err = new StringWriter();
            using var watch = DialogWatch.Start(p, userCanAnswer: false, Log(err), Fast);
            Assert.True(Until(() => watch.GaveUp, TimeSpan.FromSeconds(30)), "did not give up: " + err);
            Assert.True(p.WaitForExit(10000), "process still runs");
            Assert.StartsWith("XAE showed a dialog that did not close and the shell was ended", watch.Failure?.Message);
            Assert.True(watch.ShellEnded);
        }
        finally { End(p); }
    }

    private static ShellOps Failing(List<uint> cancelled) => new()
    {
        Terminate = _ => (false, "Access is denied."),
        CurrentThread = () => 4711,
        EnableCallCancellation = () => { },
        CancelCall = thread => { lock (cancelled) cancelled.Add(thread); return 0; },
    };

    [Fact]
    public void ShellThatCannotBeEndedIsReportedAsNotEndedAndItsBlockedCallIsCancelled()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(Title, "YesNo");
        try
        {
            var err = new StringWriter();
            var cancelledCalls = new List<uint>();
            using var watch = DialogWatch.Start(p, userCanAnswer: false, Log(err), Fast, ops: Failing(cancelledCalls));
            // read at the Cancel stage: the cached message must not outlive the escalation
            Assert.True(Until(() => watch.Cancelled is not null, TimeSpan.FromSeconds(30)), "no dialog cancelled: " + err);
            var early = watch.Failure;
            Assert.True(Until(() => watch.GaveUp, TimeSpan.FromSeconds(30)), "did not give up: " + err);
            Assert.False(watch.ShellEnded);
            var late = watch.Failure!;
            Assert.DoesNotContain("was ended", late.Message);
            Assert.Contains("could not be ended (Access is denied.)", late.Message);
            Assert.NotSame(early, late);
            Assert.Same(late, watch.Failure);   // stable while nothing changes
            // the bounded fallback: the call the command thread is blocked in is cancelled, not waited for
            Assert.True(Until(() => { lock (cancelledCalls) return cancelledCalls.Contains(4711u); }, TimeSpan.FromSeconds(10)), "the blocked call was not cancelled: " + err);
            Assert.Contains("could not be ended", err.ToString());   // surfaced as a warning, not only with -v
        }
        finally { End(p); }
    }

    [Fact]
    public void KnownTitleIsConfirmedWithOk()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(DialogPolicy.KnownTitles[0], "OKCancel");
        try
        {
            using var watch = DialogWatch.Start(p, userCanAnswer: false, Log(new StringWriter()), Fast);
            Assert.True(p.WaitForExit(30000));
            Assert.Equal("OK", p.StandardOutput.ReadToEnd().Trim());
            Assert.Null(watch.Cancelled);
        }
        finally { End(p); }
    }

    [Fact]
    public void DialogOfAnotherProcessIsNotTouched()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(Title, "OKCancel");
        try
        {
            // a stand-in for the owned shell: a process without windows, so the watcher never acts on the test host
            var other = Process.Start(new ProcessStartInfo("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep 30"]) { UseShellExecute = false })!;
            try
            {
                using var watch = DialogWatch.Start(other, userCanAnswer: false, Log(new StringWriter()), Fast);
                Assert.False(p.WaitForExit(4000));
                Assert.Null(watch.Cancelled);
            }
            finally { End(other); }
        }
        finally { End(p); }
    }

    [Fact]
    public void KnownTitleOfAVerifiedHelperIsConfirmedDuringActivation()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        // the activation dialog may belong to a TwinCAT helper instead of the shell; here the helper check vouches for the test process
        var p = ShowBox(DialogPolicy.KnownTitles[0], "OKCancel");
        try
        {
            using var watch = DialogWatch.Start(null, userCanAnswer: false, Log(new StringWriter()), Fast, isHelper: pid => pid == p.Id);
            Assert.True(p.WaitForExit(30000));
            Assert.Equal("OK", p.StandardOutput.ReadToEnd().Trim());
        }
        finally { End(p); }
    }

    [Fact]
    public void KnownTitleInAnUnrelatedProcessIsNotConfirmedDuringActivation()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(DialogPolicy.KnownTitles[0], "OKCancel");
        try
        {
            // the helper check refuses the process (it is not a TwinCAT program): the dialog stays as it is
            using var watch = DialogWatch.Start(null, userCanAnswer: false, Log(new StringWriter()), Fast, isHelper: _ => false);
            Assert.False(p.WaitForExit(4000), "the dialog of an unrelated process was answered");
            Assert.Null(watch.Cancelled);
        }
        finally { End(p); }
    }

    [Fact]
    public void WithoutAHelperCheckNothingIsConfirmed()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(DialogPolicy.KnownTitles[0], "OKCancel");
        try
        {
            using var watch = DialogWatch.Start(null, userCanAnswer: false, Log(new StringWriter()), Fast);
            Assert.False(p.WaitForExit(4000), "the dialog was answered without any attribution");
        }
        finally { End(p); }
    }

    [Fact]
    public void ARealProcessIsAHelperOnlyUnderTheInstallFolder()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows processes");
        using var me = Process.GetCurrentProcess();
        // the test host does not live under a TwinCAT folder, and nothing without an install folder is attributed
        Assert.False(HelperProcess.Verify(me.Id, @"C:\Program Files (x86)\Beckhoff\TwinCAT\3.1"));
        Assert.False(HelperProcess.Verify(me.Id, null));
        // the host is neither one of the XAE shells, so only its folder decides
        Assert.True(HelperProcess.Verify(me.Id, Path.GetDirectoryName(me.MainModule!.FileName)));
    }

    [Fact]
    public void NothingIsCancelledWhenTheUserCanAnswer()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "Windows dialogs");
        var p = ShowBox(Title, "OKCancel");
        try
        {
            using var watch = DialogWatch.Start(p, userCanAnswer: true, Log(new StringWriter()), Fast);
            Assert.False(p.WaitForExit(4000));
            Assert.Null(watch.Cancelled);
        }
        finally { End(p); }
    }
}
