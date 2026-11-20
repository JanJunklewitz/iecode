using System.Runtime.Versioning;
using IECode.Core.Ads;
using TwinCAT.Ads;

namespace IECode.Automation.Tests;

/// <summary>
/// The names of the system-info symbols are the defaults of <see cref="PlcStateNames"/>, not yet checked against a PLC
/// (plan step "check the names against a simulation"); these tests use them through the defaults.
/// </summary>
[SupportedOSPlatform("windows")]
public class AdsPlcStateTests
{
    private static readonly PlcStateNames Names = PlcStateNames.Default;

    private static FakeSymbol Udint(string name) => new(name, "UDINT", "UDINT");

    private static FakeSet CounterSymbols(bool onlineChange = true) => new(
        [Udint(Names.CycleCount(1)), Udint(Names.CycleTime(1)), .. onlineChange ? new[] { Udint(Names.OnlineChange) } : []]);

    private static SumRead Values(params object?[] values) =>
        new(AdsErrorCode.NoError, values.Select(v => new SumItem(AdsErrorCode.NoError, v)).ToList());

    private static (AdsWatchBackend Backend, FakeLink Link, FakeLink? Router) Make(Action<FakeLink>? plc = null, Action<FakeLink>? router = null, bool withRouter = true, bool connect = true)
    {
        var link = new FakeLink();
        plc?.Invoke(link);
        FakeLink? routerLink = null;
        if (withRouter)
        {
            routerLink = new FakeLink { StateInfo = (AdsErrorCode.NoError, "Run", 0) };
            router?.Invoke(routerLink);
        }
        var backend = new AdsWatchBackend("test:851", () => link, null, newRouterLink: withRouter ? () => routerLink! : null);
        if (connect) backend.Connect();
        return (backend, link, routerLink);
    }

    [Fact]
    public void ReadPlcState_reads_state_and_task_counters()
    {
        var (b, _, _) = Make(l =>
        {
            l.Upload = () => CounterSymbols();
            l.Sum = () => Values(1234567u, 100000u, 3u);
        });
        var s = b.ReadPlcState(1);
        Assert.Equal("Run", s.AdsState);
        Assert.Equal(0, s.DeviceState);
        Assert.Equal(1234567L, s.CycleCount);
        Assert.Equal(10000L, s.CycleTimeUs);
        Assert.Equal(3L, s.OnlineChangeCount);
        Assert.Null(s.TaskNote);
    }

    [Fact]
    public void ReadPlcState_without_the_system_info_symbols_returns_state_and_a_note()
    {
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(new FakeSymbol("MAIN.x", "INT", "INT")));
        var s = b.ReadPlcState(1);
        Assert.Equal("Run", s.AdsState);
        Assert.Null(s.CycleCount);
        Assert.StartsWith("task counters not readable: ", s.TaskNote);
    }

    [Fact]
    public void ReadPlcState_maps_a_failing_state_read_to_an_AdsFault()
    {
        var (b, _, _) = Make(l => l.StateInfo = (AdsErrorCode.DeviceInvalidState, "", 0), withRouter: false);
        var f = Assert.Throws<AdsFault>(() => b.ReadPlcState(1));
        Assert.Contains("0x", f.Message);
    }

    [Fact]
    public void ReadPlcState_adds_the_system_state_from_port_10000()
    {
        var (b, _, _) = Make(l => l.Upload = () => CounterSymbols(), router: r => r.StateInfo = (AdsErrorCode.NoError, "Config", 0));
        Assert.Equal("Config", b.ReadPlcState(1).SystemState);
    }

    [Fact]
    public void ReadPlcState_without_an_answer_from_port_10000_leaves_the_system_state_out()
    {
        var (b, _, _) = Make(l => { l.Upload = () => CounterSymbols(); l.Sum = () => Values(1u, 10000u, 0u); },
            router: r => r.StateInfo = (AdsErrorCode.TargetPortNotFound, "", 0));
        var s = b.ReadPlcState(1);
        Assert.Null(s.SystemState);
        Assert.Equal("Run", s.AdsState);
    }

    [Fact]
    public void ReadPlcState_with_the_PLC_port_unreachable_returns_the_system_state_and_the_PLC_error()
    {
        var (b, _, _) = Make(router: r => r.StateInfo = (AdsErrorCode.NoError, "Config", 0), connect: false);
        var s = b.ReadPlcState(1);
        Assert.Equal("Config", s.SystemState);
        Assert.Null(s.AdsState);
        Assert.False(string.IsNullOrEmpty(s.PlcError));
    }

    [Fact]
    public void ReadPlcState_with_nothing_reachable_throws_the_PLC_fault()
    {
        var (b, _, _) = Make(router: r => r.StateInfo = (AdsErrorCode.TargetMachineNotFound, "", 0), connect: false);
        var f = Assert.Throws<AdsFault>(() => b.ReadPlcState(1));
        Assert.True(f.ConnectionLost);
    }

    [Fact]
    public void ReadPlcState_reads_the_counters_that_resolve()
    {
        var (b, _, _) = Make(l =>
        {
            l.Upload = () => CounterSymbols(onlineChange: false);
            l.Sum = () => Values(7u, 10000u);
        });
        var s = b.ReadPlcState(1);
        Assert.Equal(7L, s.CycleCount);
        Assert.Equal(1000L, s.CycleTimeUs);
        Assert.Null(s.OnlineChangeCount);
        Assert.Contains(Names.OnlineChange, s.TaskNote);
        Assert.StartsWith("not readable: ", s.TaskNote);
    }

    [Fact]
    public void ReadPlcState_keeps_the_ADS_code_of_the_PLC_error()
    {
        var (b, _, _) = Make(l => l.StateInfo = (AdsErrorCode.TargetPortNotFound, "", 0), router: r => r.StateInfo = (AdsErrorCode.NoError, "Run", 0));
        var s = b.ReadPlcState(1);
        Assert.Equal(0x6u, s.PlcAdsCode);
        Assert.True(s.PlcConnectionLost);
        Assert.Equal("Run", s.SystemState);
    }

    [Fact]
    public void ReadPlcState_notes_a_counter_item_that_fails_in_the_sum_read()
    {
        var (b, _, _) = Make(l =>
        {
            l.Upload = () => CounterSymbols();
            l.Sum = () => new SumRead(AdsErrorCode.NoError,
                [new SumItem(AdsErrorCode.NoError, 5u), new SumItem(AdsErrorCode.NoError, 10000u), new SumItem(AdsErrorCode.DeviceInvalidAccess, null)]);
        });
        var s = b.ReadPlcState(1);
        Assert.Equal(5L, s.CycleCount);
        Assert.Null(s.OnlineChangeCount);
        Assert.Contains(Names.OnlineChange, s.TaskNote);
    }
}
