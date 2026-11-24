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
            using (var watch = DialogWatch.Start(p, userCanAnswer: false, Log(err), Fast))
            {
                Assert.True(Until(() => watch.Cancelled is not null, TimeSpan.FromSeconds(30)), "no dialog cancelled: " + err);
                Assert.Equal(Title, watch.Cancelled!.Title);
                Assert.Contains("The path is too long.", watch.Cancelled.Text);
                Assert.False(watch.GaveUp);
                Assert.Equal($"XAE showed a dialog and was stopped: {Title}: The path is too long.", watch.Failure?.Message);
            }
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
            using var me = Process.GetCurrentProcess();
            using var watch = DialogWatch.Start(me, userCanAnswer: false, Log(new StringWriter()), Fast);
            Assert.False(p.WaitForExit(4000));
            Assert.Null(watch.Cancelled);
        }
        finally { End(p); }
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
