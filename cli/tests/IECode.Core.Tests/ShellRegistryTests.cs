using System.Diagnostics;

namespace IECode.Core.Tests;

public class ShellRegistryTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime Owner0 = new(2026, 11, 24, 7, 59, 0, DateTimeKind.Utc);
    private static ShellEntry Entry(int pid = 1234) => new(pid, T0.AddTicks(1234567), 99, Owner0, "TcXaeShell.DTE.15.0", @"C:\W\Machine.sln");

    [Fact]
    public void AddListRemove()
    {
        using var ws = new TempWorkspace();
        var r = new ShellRegistry(ws["shells"]);
        var e = Entry();
        r.Add(e);
        Assert.Equal(e, Assert.Single(r.All()));
        r.Remove(1234);
        Assert.Empty(r.All());
    }

    [Fact]
    public void AddReplacesTheEntryOfTheSamePid()
    {
        using var ws = new TempWorkspace();
        var r = new ShellRegistry(ws["shells"]);
        r.Add(Entry());
        var newer = Entry() with { Solution = null };
        r.Add(newer);
        Assert.Equal(newer, Assert.Single(r.All()));
    }

    [Fact]
    public void BrokenFileIsSkipped()
    {
        using var ws = new TempWorkspace();
        var r = new ShellRegistry(ws["shells"]);
        r.Add(Entry(7));
        File.WriteAllText(Path.Combine(ws["shells"], "5.json"), "{");
        File.WriteAllText(Path.Combine(ws["shells"], "6.json"), "null");
        Assert.Equal(7, Assert.Single(r.All()).Pid);
    }

    [Fact]
    public void MissingFolderIsEmpty()
    {
        using var ws = new TempWorkspace();
        var r = new ShellRegistry(ws["nothing-here"]);
        Assert.Empty(r.All());
        r.Remove(1);
    }

    [Fact]
    public void ReusedPidIsStale()
    {
        var e = Entry();
        Assert.True(ShellRegistry.IsSame(e, e.StartedUtc));
        // the time comes from the process handle both times, so any difference is another process
        Assert.False(ShellRegistry.IsSame(e, e.StartedUtc.AddMilliseconds(400)));
        Assert.False(ShellRegistry.IsSame(e, e.StartedUtc.AddMinutes(5)));
        Assert.False(ShellRegistry.IsSame(e, null));
    }

    [Fact]
    public void LiveOwnerIsSpared()
    {
        var e = Entry();
        Assert.True(ShellRegistry.OwnerAlive(e, Owner0));
        Assert.False(ShellRegistry.OwnerAlive(e, Owner0.AddSeconds(3)));
        Assert.False(ShellRegistry.OwnerAlive(e, null));

        Assert.Equal(ShellState.Owned, ShellRegistry.State(e, e.StartedUtc, Owner0));
        Assert.Equal(ShellState.Orphaned, ShellRegistry.State(e, e.StartedUtc, null));
        Assert.Equal(ShellState.Stale, ShellRegistry.State(e, null, Owner0));
        Assert.Equal(ShellState.Stale, ShellRegistry.State(e, T0.AddHours(1), Owner0));

        Assert.True(ShellRegistry.MayKill(ShellState.Orphaned, force: false));
        Assert.False(ShellRegistry.MayKill(ShellState.Owned, force: false));
        Assert.True(ShellRegistry.MayKill(ShellState.Owned, force: true));
        Assert.False(ShellRegistry.MayKill(ShellState.Stale, force: true));
    }

    [Fact]
    public void StartTimeOfTheCurrentProcess()
    {
        using var me = Process.GetCurrentProcess();
        Assert.Equal(me.StartTime.ToUniversalTime(), ShellRegistry.StartTimeOf(me.Id));
        Assert.Null(ShellRegistry.StartTimeOf(int.MaxValue));
    }

    [Fact]
    public void DefaultFolderIsUnderLocalAppData() =>
        Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "iecode", "shells"), ShellRegistry.DefaultFolder());
}

public class ShellRegistryReviewFixTests
{
    private static readonly DateTime T0 = new(2026, 11, 24, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void AnOwnerWhoseStartTimeCannotBeReadIsSpared()
    {
        var e = new ShellEntry(1, T0, 99, T0.AddMinutes(-1), "x", null);
        Assert.Equal(ShellState.Owned, ShellRegistry.State(e, T0, null, ownerUnreadable: true));
        Assert.Equal(ShellState.Orphaned, ShellRegistry.State(e, T0, null, ownerUnreadable: false));
    }

    [Fact]
    public void ProbeOfTheCurrentProcess()
    {
        using var me = System.Diagnostics.Process.GetCurrentProcess();
        var (start, unreadable) = ShellRegistry.Probe(me.Id);
        Assert.Equal(me.StartTime.ToUniversalTime(), start);
        Assert.False(unreadable);
        Assert.Equal((null, false), ShellRegistry.Probe(int.MaxValue));
    }
}

public class ShellOwnershipTests
{
    [Fact]
    public void TheNewProcessThatServesTheDteObjectIsProven() =>
        Assert.Equal(ShellOwnership.Proven, ShellRegistry.Verify(100, candidateSession: 1, ownSession: 1, serverPid: 100));

    [Fact]
    public void ANewProcessThatIsNotTheServerIsForeign() =>
        // a user started Visual Studio while the activation reused a running server
        Assert.Equal(ShellOwnership.Foreign, ShellRegistry.Verify(100, 1, 1, serverPid: 55));

    [Fact]
    public void AProcessOfAnotherSessionIsForeign() =>
        Assert.Equal(ShellOwnership.Foreign, ShellRegistry.Verify(100, candidateSession: 2, ownSession: 1, serverPid: 100));

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    public void AnUnreadableWindowLeavesItUndecided(int? server) =>
        Assert.Equal(ShellOwnership.Unknown, ShellRegistry.Verify(100, 1, 1, server));
}
