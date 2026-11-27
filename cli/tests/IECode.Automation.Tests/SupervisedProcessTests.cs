using System.Diagnostics;
using IECode.Automation.Interop;

namespace IECode.Automation.Tests;

/// <summary>The supervised child behind RepTool: created suspended, in a kill-on-close job, output read through bounded pipes.</summary>
[System.Runtime.Versioning.SupportedOSPlatform("windows")]
public class SupervisedProcessTests
{
    private static readonly string Cmd = Environment.GetEnvironmentVariable("ComSpec") ?? @"C:\Windows\System32\cmd.exe";
    private static void Windows() => Assert.SkipUnless(OperatingSystem.IsWindows(), "job objects and suspended starts are Windows features");

    private static SupervisedProcess Start(string script, List<string>? output = null, List<string>? errors = null, Action<SupervisedProcess>? whileSuspended = null) =>
        SupervisedProcess.Start(Cmd, $"/c {script}", l => { lock (output ??= []) output.Add(l); }, l => { lock (errors ??= []) errors.Add(l); }, whileSuspended);

    private static bool Gone(int pid, TimeSpan within)
    {
        var until = DateTime.UtcNow + within;
        do
        {
            try { using var p = Process.GetProcessById(pid); if (p.HasExited) return true; }
            catch (ArgumentException) { return true; }
            Thread.Sleep(50);
        } while (DateTime.UtcNow < until);
        return false;
    }

    [Fact]
    public void ReadsBothOutputsAndTheExitCode()
    {
        Windows();
        var output = new List<string>();
        var errors = new List<string>();
        using var p = Start("echo hello& echo oops>&2& exit 3", output, errors);
        Assert.True(p.WaitForExit(TimeSpan.FromSeconds(20)));
        Assert.True(p.WaitForOutput(TimeSpan.FromSeconds(5)));
        Assert.Equal(3, p.ExitCode);
        Assert.Equal(["hello"], output);
        Assert.Equal(["oops"], errors);
    }

    [Fact]
    public void BookkeepingRunsBeforeTheChildDoesAnything()
    {
        Windows();
        var marker = Path.Combine(Path.GetTempPath(), "iecode-supervised-" + Guid.NewGuid().ToString("N"));
        try
        {
            long ticks = 0;
            using var p = Start($"echo x> \"{marker}\"", whileSuspended: s =>
            {
                Assert.False(File.Exists(marker));        // not run yet
                Assert.False(s.HasExited);
                ticks = s.StartTicksUtc;
                using var seen = Process.GetProcessById(s.Id);
                Assert.Equal(seen.StartTime.ToUniversalTime().Ticks, ticks);
            });
            Assert.True(p.WaitForExit(TimeSpan.FromSeconds(20)));
            Assert.True(File.Exists(marker));
            Assert.NotEqual(0, ticks);
        }
        finally { File.Delete(marker); }
    }

    [Fact]
    public void FailingBookkeepingStopsTheChildBeforeItRuns()
    {
        Windows();
        var marker = Path.Combine(Path.GetTempPath(), "iecode-supervised-" + Guid.NewGuid().ToString("N"));
        var pid = 0;
        try
        {
            var e = Assert.Throws<IOException>(() => Start($"echo x> \"{marker}\"", whileSuspended: s => { pid = s.Id; throw new IOException("cannot record the writer"); }));
            Assert.Equal("cannot record the writer", e.Message);
            Assert.True(Gone(pid, TimeSpan.FromSeconds(10)));
            Assert.False(File.Exists(marker));
        }
        finally { File.Delete(marker); }
    }

    [Fact]
    public void DisposingTheJobEndsTheChildAndItsDescendants()
    {
        Windows();
        var pingsBefore = Process.GetProcessesByName("ping").Select(x => x.Id).ToHashSet();
        var p = Start("ping -n 60 127.0.0.1 > nul");
        var pid = p.Id;
        int? ping = null;
        for (var i = 0; i < 100 && ping is null; i++)
        {
            Thread.Sleep(50);
            ping = Process.GetProcessesByName("ping").Select(x => x.Id).FirstOrDefault(id => !pingsBefore.Contains(id)) is var id && id != 0 ? id : null;
        }
        Assert.NotNull(ping);
        p.Dispose();   // what iecode dying does: the last handle to the kill-on-close job closes
        Assert.True(Gone(pid, TimeSpan.FromSeconds(10)));
        Assert.True(Gone(ping!.Value, TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public void TerminateEndsTheTreeAndReportsIt()
    {
        Windows();
        using var p = Start("ping -n 60 127.0.0.1 > nul");
        Assert.False(p.WaitForExit(TimeSpan.FromMilliseconds(300)));
        Assert.True(p.Terminate(TimeSpan.FromSeconds(10)));
        Assert.True(p.HasExited);
    }

    [Fact]
    public void WaitingForOutputIsBoundedWhenADescendantKeepsThePipeOpen()
    {
        Windows();
        // cmd ends at once; the detached ping inherits the redirected handles and keeps them open for 30 s
        using var p = Start("start /b ping -n 30 127.0.0.1 & exit 0");
        Assert.True(p.WaitForExit(TimeSpan.FromSeconds(20)));
        var sw = Stopwatch.StartNew();
        Assert.False(p.WaitForOutput(TimeSpan.FromMilliseconds(500)));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(5));
        p.Terminate(TimeSpan.FromSeconds(5));   // ends the descendant, the pipe closes
        Assert.True(p.WaitForOutput(TimeSpan.FromSeconds(10)));
    }
}
