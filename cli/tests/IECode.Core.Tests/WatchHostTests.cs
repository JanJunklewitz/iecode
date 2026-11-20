using System.Text.Json;
using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class WatchHostTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);

    private sealed class FakeBackend : IWatchBackend
    {
        public int ConnectCalls, ResolveCalls;
        public List<IReadOnlyList<string>> ResolvedLists = [];
        public Exception? ConnectFault;
        public Func<IReadOnlyList<string>, IReadOnlyList<WatchItem>> ResolveFn =
            s => s.Select(x => new WatchItem(x, "INT", true, null)).ToArray();
        public Func<IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)>> ReadFn = () => [];
        public Func<bool> VersionFn = () => false;
        public Func<string, string, (string? Value, string? ReadBackError)> WriteFn = (_, t) => (t, null);

        public void Connect()
        {
            ConnectCalls++;
            if (ConnectFault is not null) throw ConnectFault;
        }
        public IReadOnlyList<WatchItem> Resolve(IReadOnlyList<string> symbols)
        {
            ResolveCalls++;
            ResolvedLists.Add(symbols);
            return ResolveFn(symbols);
        }
        public IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> ReadWatched() => ReadFn();
        public bool SymbolVersionChanged() => VersionFn();
        public (string Type, string Value) ReadOnce(string symbol) => ("INT", "1");
        public (string? Value, string? ReadBackError) Write(string symbol, string text) => WriteFn(symbol, text);
        public int WriteManyCalls;
        public List<int> MembersDepths = [];
        public Func<string, int, StructRead?> MembersFn = (_, _) => null;
        public StructRead? ReadMembers(string symbol, int depth)
        {
            MembersDepths.Add(depth);
            return MembersFn(symbol, depth);
        }
        public Func<IReadOnlyList<(string Symbol, string Value)>, IReadOnlyList<WriteManyItem>> WriteManyFn =
            w => w.Select(x => new WriteManyItem(x.Symbol, WriteStatus.Written, x.Value)).ToList();
        public IReadOnlyList<WriteManyItem> WriteMany(IReadOnlyList<(string Symbol, string Value)> writes)
        {
            WriteManyCalls++;
            return WriteManyFn(writes);
        }
        public void Dispose() { }
    }

    private sealed class Rig
    {
        public readonly FakeBackend Backend = new();
        public readonly List<string> Lines = [];
        public readonly List<string> Log = [];
        public readonly WatchHost Host;
        public Rig() => Host = new WatchHost(Backend, Lines.Add, Log.Add);

        public JsonElement Last() => Parse(Lines[^1]);
        public List<JsonElement> Events(string name) =>
            Lines.Select(Parse).Where(e => e.TryGetProperty("event", out var n) && n.GetString() == name).ToList();
        public void Watch(params string[] symbols) =>
            Host.Handle(JsonSerializer.Serialize(new { id = 1, op = "watch", symbols }));
    }

    private static JsonElement Parse(string line) => JsonDocument.Parse(line).RootElement.Clone();

    private static (string?, long?, uint?) Ok(string v) => (v, null, null);
    private static (string?, long?, uint?) Err(uint c) => (null, null, c);

    [Fact]
    public void Start_EmitsHelloFirst()
    {
        var r = new Rig();
        r.Host.Start();
        var e = Parse(r.Lines[0]);
        Assert.Equal("hello", e.GetProperty("event").GetString());
        Assert.Equal(2, e.GetProperty("protocol").GetInt32());
    }

    [Fact]
    public void Start_HelloCarriesTheResolvedTarget_OnlyWhenGiven()
    {
        var plain = new Rig();
        plain.Host.Start();
        Assert.False(Parse(plain.Lines[0]).TryGetProperty("target", out _));

        var lines = new List<string>();
        new WatchHost(new FakeBackend(), lines.Add, null, "199.4.42.250.1.1").Start();
        Assert.Equal("199.4.42.250.1.1", Parse(lines[0]).GetProperty("target").GetString());
    }

    [Fact]
    public void Start_ConnectFailure_EmitsStateDisconnected()
    {
        var r = new Rig();
        r.Backend.ConnectFault = new AdsFault("no target", null, true);
        r.Host.Start();
        var s = Assert.Single(r.Events("state"));
        Assert.False(s.GetProperty("connected").GetBoolean());
        Assert.Equal("no target", s.GetProperty("error").GetString());
    }

    [Fact]
    public void Watch_ReturnsItems_WithNewGen()
    {
        var r = new Rig();
        r.Host.Start();
        r.Watch("MAIN.bStart", "GVL.nCount");
        var reply = r.Last();
        Assert.True(reply.GetProperty("ok").GetBoolean());
        Assert.Equal(1, reply.GetProperty("id").GetInt32());
        Assert.Equal(1, reply.GetProperty("data").GetProperty("gen").GetInt32());
        Assert.Equal(2, reply.GetProperty("data").GetProperty("items").GetArrayLength());
    }

    [Fact]
    public void Watch_MoreThan200_IsRejected()
    {
        var r = new Rig();
        r.Host.Start();
        r.Watch(Enumerable.Range(0, 201).Select(i => "MAIN.x" + i).ToArray());
        var reply = r.Last();
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.Contains("200", reply.GetProperty("error").GetString());
    }

    [Fact]
    public void Tick_EmitsSamples_EveryHundredMs()
    {
        var r = new Rig();
        r.Backend.ReadFn = () => [Ok("1")];
        r.Host.Start();
        r.Host.Handle("""{"id":2,"op":"interval","ms":10}""");
        r.Watch("MAIN.a");
        r.Lines.Clear();
        for (var ms = 0; ms < 100; ms += 10) r.Host.Tick(T0.AddMilliseconds(ms));
        Assert.Empty(r.Events("samples"));
        r.Host.Tick(T0.AddMilliseconds(100));
        var samples = r.Events("samples");
        var ev = Assert.Single(samples);
        Assert.Equal(1, ev.GetProperty("gen").GetInt32());
        var rows = ev.GetProperty("rows");
        Assert.Equal(11, rows.GetArrayLength());
        Assert.Equal(T0.ToUnixTimeMilliseconds(), rows[0].GetProperty("t").GetInt64());
        Assert.Equal(T0.AddMilliseconds(100).ToUnixTimeMilliseconds(), rows[10].GetProperty("t").GetInt64());
    }

    [Fact]
    public void WatchHost_BadSymbol_DoesNotStopOthers()
    {
        var r = new Rig();
        r.Backend.ResolveFn = s => s.Select(x => x == "MAIN.nope"
            ? new WatchItem(x, "", false, "Symbol not found")
            : new WatchItem(x, "INT", true, null)).ToArray();
        r.Backend.ReadFn = () => [(null, null, null), Ok("1")];
        r.Host.Start();
        r.Watch("MAIN.nope", "MAIN.a");
        var items = r.Last().GetProperty("data").GetProperty("items");
        Assert.Equal("Symbol not found", items[0].GetProperty("error").GetString());
        Assert.Equal(JsonValueKind.Null, items[1].GetProperty("error").ValueKind);
        r.Host.Tick(T0);
        r.Host.Tick(T0.AddMilliseconds(100));
        var row = r.Events("samples").Single().GetProperty("rows")[0].GetProperty("v");
        Assert.Equal(JsonValueKind.Null, row[0].ValueKind);
        Assert.Equal("1", row[1].GetString());
    }

    [Fact]
    public void WatchHost_ResolvesAgain_AfterDeadHandleCodes()
    {
        var r = new Rig();
        var thrown = false;
        r.Backend.ReadFn = () =>
        {
            if (!thrown) { thrown = true; throw new AdsFault("dead", 0x711, false); }
            return [Ok("1")];
        };
        r.Host.Start();
        r.Watch("MAIN.a");
        Assert.Equal(1, r.Backend.ResolveCalls);
        r.Host.Tick(T0);
        Assert.Equal(2, r.Backend.ResolveCalls);
        Assert.Equal(r.Backend.ResolvedLists[0], r.Backend.ResolvedLists[1]);
        r.Host.Tick(T0.AddMilliseconds(100));
        var ev = r.Events("samples").Single();
        Assert.Equal("1", ev.GetProperty("rows")[0].GetProperty("v")[0].GetString());
        Assert.Equal(1, ev.GetProperty("gen").GetInt32());
        Assert.Empty(r.Events("items"));
    }

    [Fact]
    public void WatchHost_ResolvesAgain_WhenSymbolVersionChanged()
    {
        var r = new Rig();
        var changed = true;
        r.Backend.ReadFn = () => [Ok("1")];
        r.Backend.VersionFn = () => { var c = changed; changed = false; return c; };
        r.Host.Start();
        r.Watch("MAIN.a");
        r.Host.Tick(T0);
        Assert.Equal(2, r.Backend.ResolveCalls);
    }

    [Fact]
    public void WatchHost_ReportsLostConnection_AndRetries()
    {
        var r = new Rig();
        var lost = true;
        r.Backend.ReadFn = () => lost ? throw new AdsFault("gone", 0x745, true) : [Ok("1")];
        r.Host.Start();
        r.Watch("MAIN.a");
        Assert.Equal(1, r.Backend.ConnectCalls);
        r.Host.Tick(T0);
        var states = r.Events("state");
        Assert.Contains(states, s => !s.GetProperty("connected").GetBoolean());
        Assert.Equal(1, r.Backend.ConnectCalls);
        r.Host.Tick(T0.AddMilliseconds(1900));
        Assert.Equal(1, r.Backend.ConnectCalls);
        lost = false;
        var resolves = r.Backend.ResolveCalls;
        r.Host.Tick(T0.AddMilliseconds(2000));
        Assert.Equal(2, r.Backend.ConnectCalls);
        Assert.True(r.Events("state").Last().GetProperty("connected").GetBoolean());
        Assert.Equal(resolves + 1, r.Backend.ResolveCalls);
        Assert.Single(r.Events("state"), s => !s.GetProperty("connected").GetBoolean());
    }

    [Fact]
    public void WatchHost_SlowFailedConnect_RetriesTwoSecondsAfterNextTick()
    {
        var r = new Rig();
        r.Backend.ConnectFault = new AdsFault("no target", null, true);
        r.Host.Start();
        Assert.Equal(1, r.Backend.ConnectCalls);
        // The test clock jumps 5 s (the blocked attempt) before the next Tick.
        r.Host.Tick(T0.AddSeconds(5));
        Assert.Equal(1, r.Backend.ConnectCalls);
        r.Host.Tick(T0.AddSeconds(5).AddMilliseconds(1900));
        Assert.Equal(1, r.Backend.ConnectCalls);
        r.Host.Tick(T0.AddSeconds(7));
        Assert.Equal(2, r.Backend.ConnectCalls);
    }

    [Fact]
    public void Start_ConnectThrowsOtherException_IsFailedConnect()
    {
        var r = new Rig();
        r.Backend.ConnectFault = new InvalidOperationException("boom");
        r.Host.Start();
        var s = Assert.Single(r.Events("state"));
        Assert.False(s.GetProperty("connected").GetBoolean());
        Assert.Equal("boom", s.GetProperty("error").GetString());
    }

    [Fact]
    public void Tick_NonConnectionExceptions_DoNotEscape_AndAreReportedOnce()
    {
        var r = new Rig();
        r.Backend.ReadFn = () => [Ok("1")];
        r.Backend.VersionFn = () => throw new AdsFault("version read failed", 0x705, false);
        r.Host.Start();
        r.Watch("MAIN.a");
        r.Host.Tick(T0);
        r.Host.Tick(T0.AddMilliseconds(100));
        Assert.Single(r.Log);

        var r2 = new Rig();
        r2.Host.Start();
        r2.Watch("MAIN.a");
        r2.Backend.VersionFn = () => true;
        r2.Backend.ReadFn = () => [Ok("1")];
        r2.Backend.ResolveFn = _ => throw new IECodeException(ExitCodes.Usage, "bad resolve");
        r2.Host.Tick(T0);
        r2.Host.Tick(T0.AddMilliseconds(100));
        Assert.Single(r2.Log);
        Assert.Equal(1, r2.Backend.ConnectCalls);
    }

    [Fact]
    public void Write_ReturnsReadBack()
    {
        var r = new Rig();
        r.Backend.WriteFn = (_, _) => ("5", null);
        r.Host.Start();
        r.Host.Handle("""{"id":3,"op":"write","symbol":"MAIN.x","value":"05"}""");
        var d = r.Last().GetProperty("data");
        Assert.True(r.Last().GetProperty("ok").GetBoolean());
        Assert.Equal("MAIN.x", d.GetProperty("symbol").GetString());
        Assert.Equal("5", d.GetProperty("value").GetString());
    }

    [Fact]
    public void Write_reply_says_not_written_only_before_sending()
    {
        var r = new Rig();
        r.Host.Start();
        r.Backend.WriteFn = (_, _) => throw new WriteNotSentException("Symbol 'MAIN.x' not found.");
        r.Host.Handle("""{"id":3,"op":"write","symbol":"MAIN.x","value":"1"}""");
        Assert.False(r.Last().GetProperty("ok").GetBoolean());
        Assert.Equal("no", r.Last().GetProperty("written").GetString());
        r.Backend.WriteFn = (_, _) => throw new AdsFault("Write MAIN.x: timeout", 0x745, false);
        r.Host.Handle("""{"id":4,"op":"write","symbol":"MAIN.x","value":"1"}""");
        Assert.False(r.Last().GetProperty("ok").GetBoolean());
        Assert.False(r.Last().TryGetProperty("written", out _));
        Assert.Equal(0x745u, r.Last().GetProperty("adsCode").GetUInt32());
    }

    [Fact]
    public void Write_reply_carries_the_read_back_error()
    {
        var r = new Rig();
        r.Host.Start();
        r.Backend.WriteFn = (_, _) => (null, "Read MAIN.x: connection lost");
        r.Host.Handle("""{"id":3,"op":"write","symbol":"MAIN.x","value":"1"}""");
        var d = r.Last().GetProperty("data");
        Assert.True(r.Last().GetProperty("ok").GetBoolean());
        Assert.Equal(JsonValueKind.Null, d.GetProperty("value").ValueKind);
        Assert.Equal("Read MAIN.x: connection lost", d.GetProperty("readBackError").GetString());
    }

    [Fact]
    public void Write_BadValue_IsErrorReply()
    {
        var r = new Rig();
        r.Backend.WriteFn = (_, _) => throw new IECodeException(ExitCodes.Usage, "bad value");
        r.Host.Start();
        r.Host.Handle("""{"id":3,"op":"write","symbol":"MAIN.x","value":"zz"}""");
        var reply = r.Last();
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.Equal("bad value", reply.GetProperty("error").GetString());
        r.Host.Handle("""{"id":4,"op":"interval","ms":100}""");
        Assert.True(r.Last().GetProperty("ok").GetBoolean());
    }

    [Fact]
    public void BadJson_IsErrorReply_NotCrash()
    {
        var r = new Rig();
        r.Host.Start();
        r.Host.Handle("{oops");
        var reply = r.Last();
        Assert.Equal(JsonValueKind.Null, reply.GetProperty("id").ValueKind);
        Assert.False(reply.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public void WatchHost_ResolvesAgain_TypeChanged_NewGen()
    {
        var r = new Rig();
        var type = "INT";
        r.Backend.ResolveFn = s => s.Select(x => new WatchItem(x, type, true, null)).ToArray();
        var thrown = false;
        r.Backend.ReadFn = () =>
        {
            if (!thrown) { thrown = true; type = "REAL"; throw new AdsFault("dead", 0x711, false); }
            return [Ok("1.5")];
        };
        r.Host.Start();
        r.Watch("MAIN.a");
        r.Host.Tick(T0);
        var ev = Assert.Single(r.Events("items"));
        Assert.Equal(2, ev.GetProperty("gen").GetInt32());
        Assert.Equal("REAL", ev.GetProperty("items")[0].GetProperty("type").GetString());
        r.Host.Tick(T0.AddMilliseconds(100));
        Assert.Equal(2, r.Events("samples").Last().GetProperty("gen").GetInt32());
    }

    [Fact]
    public void WatchHost_MixedRow_OneDeadHandle_ResolvesAgain_OtherCodeIsItemError()
    {
        var r = new Rig();
        var step = 0;
        r.Backend.ReadFn = () => step++ == 0 ? [Ok("1"), Err(0x711), Err(0x705)] : [Ok("1"), Err(0x705)];
        r.Host.Start();
        r.Watch("MAIN.a", "MAIN.b", "MAIN.c");
        r.Host.Tick(T0);
        Assert.Equal(2, r.Backend.ResolveCalls);

        var r2 = new Rig();
        r2.Backend.ReadFn = () => [Ok("1"), Err(0x705)];
        r2.Host.Start();
        r2.Watch("MAIN.a", "MAIN.b");
        r2.Host.Tick(T0);
        r2.Host.Tick(T0.AddMilliseconds(100));
        Assert.Equal(1, r2.Backend.ResolveCalls);
        var v = r2.Events("samples").Single().GetProperty("rows")[0].GetProperty("v");
        Assert.Equal("1", v[0].GetString());
        Assert.Equal(JsonValueKind.Null, v[1].ValueKind);
        Assert.Single(r2.Log);
    }

    [Fact]
    public void WatchHost_OtherAdsCode_KeepsPolling()
    {
        var r = new Rig();
        var reads = 0;
        r.Backend.ReadFn = () => { reads++; throw new AdsFault("no access", 0x705, false); };
        r.Host.Start();
        r.Watch("MAIN.a");
        r.Host.Tick(T0);
        r.Host.Tick(T0.AddMilliseconds(100));
        r.Host.Tick(T0.AddMilliseconds(200));
        Assert.Equal(3, reads);
        Assert.DoesNotContain(r.Events("state"), s => !s.GetProperty("connected").GetBoolean());
        Assert.Equal(1, r.Backend.ConnectCalls);
        Assert.Single(r.Log);
    }

    [Fact]
    public void WatchHost_ChecksSymbolVersion_BeforePublishingRows()
    {
        var r = new Rig();
        var changed = false;
        var value = "old";
        r.Backend.ReadFn = () => [Ok(value)];
        r.Backend.VersionFn = () => changed;
        r.Host.Start();
        r.Watch("MAIN.a");
        changed = true;
        r.Host.Tick(T0.AddMilliseconds(100));
        Assert.Equal(2, r.Backend.ResolveCalls);
        changed = false;
        value = "new";
        r.Host.Tick(T0.AddMilliseconds(200));
        r.Host.Tick(T0.AddMilliseconds(300));
        var all = r.Events("samples").SelectMany(e => e.GetProperty("rows").EnumerateArray())
            .Select(row => row.GetProperty("v")[0].GetString()).ToList();
        Assert.DoesNotContain("old", all);
        Assert.Contains("new", all);
    }

    [Fact]
    public void Samples_CarryEnumNumbers_OnlyWithEnumItems()
    {
        var r = new Rig();
        r.Backend.ReadFn = () => [("5", null, null), ("Running", 1L, null)];
        r.Host.Start();
        r.Watch("MAIN.n", "MAIN.state");
        r.Host.Tick(T0);
        r.Host.Tick(T0.AddMilliseconds(100));
        var row = r.Events("samples").Single().GetProperty("rows")[0];
        var e = row.GetProperty("e");
        Assert.Equal(JsonValueKind.Null, e[0].ValueKind);
        Assert.Equal(1, e[1].GetInt64());

        var r2 = new Rig();
        r2.Backend.ReadFn = () => [Ok("5")];
        r2.Host.Start();
        r2.Watch("MAIN.n");
        r2.Host.Tick(T0);
        r2.Host.Tick(T0.AddMilliseconds(100));
        Assert.False(r2.Events("samples").Single().GetProperty("rows")[0].TryGetProperty("e", out _));
    }

    [Fact]
    public void WatchHost_FailedWatch_RecoveryAnnouncesNewGen_BeforeItsSamples()
    {
        var r = new Rig();
        r.Backend.ReadFn = () => [Ok("1")];
        r.Host.Start();
        r.Watch("MAIN.a");
        r.Host.Tick(T0);
        r.Host.Tick(T0.AddMilliseconds(100));
        r.Backend.ResolveFn = _ => throw new AdsFault("Symbol upload failed", null, false);
        r.Watch("MAIN.a");
        Assert.False(r.Last().GetProperty("ok").GetBoolean());
        // The first resolve after the failure fails as well; the host must keep trying.
        r.Host.Tick(T0.AddMilliseconds(200));
        r.Backend.ResolveFn = s => s.Select(x => new WatchItem(x, "INT", true, null)).ToArray();
        r.Host.Tick(T0.AddMilliseconds(300));
        r.Host.Tick(T0.AddMilliseconds(400));
        r.Host.Tick(T0.AddMilliseconds(500));

        // Replay the lines as the extension sees them: samples of a gen it was never told about are dropped there.
        int? known = null;
        var samplesAfterRecovery = 0;
        foreach (var e in r.Lines.Select(Parse))
        {
            if (e.TryGetProperty("ok", out var ok) && ok.GetBoolean() && e.GetProperty("data").TryGetProperty("gen", out var g))
                known = g.GetInt32();
            else if (e.TryGetProperty("event", out var n) && n.GetString() == "items")
                known = e.GetProperty("gen").GetInt32();
            else if (e.TryGetProperty("event", out n) && n.GetString() == "samples")
            {
                Assert.Equal(known, e.GetProperty("gen").GetInt32());
                if (known > 1) samplesAfterRecovery++;
            }
        }
        Assert.True(samplesAfterRecovery > 0);
    }

    [Fact]
    public void WatchHost_PhantomSymbol_IsItemError_OthersKeepStreaming_ResolveBacksOff()
    {
        var r = new Rig();
        r.Backend.ReadFn = () => [Ok("1"), Err(0x710)];
        r.Host.Start();
        r.Watch("MAIN.a", "MAIN.phantom");
        r.Lines.Clear();
        r.Host.Tick(T0);
        Assert.Equal(2, r.Backend.ResolveCalls);
        // Still 0x710 right after a fresh resolve: no further resolve per tick, the item gets an error instead.
        for (var ms = 10; ms < 5000; ms += 10) r.Host.Tick(T0.AddMilliseconds(ms));
        Assert.Equal(2, r.Backend.ResolveCalls);
        var ev = Assert.Single(r.Events("items"));
        Assert.Equal(2, ev.GetProperty("gen").GetInt32());
        Assert.Equal(JsonValueKind.Null, ev.GetProperty("items")[0].GetProperty("error").ValueKind);
        Assert.Contains("not readable", ev.GetProperty("items")[1].GetProperty("error").GetString());
        var rows = r.Events("samples").Where(s => s.GetProperty("gen").GetInt32() == 2)
            .SelectMany(s => s.GetProperty("rows").EnumerateArray()).ToList();
        Assert.True(rows.Count > 400);
        Assert.All(rows, row =>
        {
            Assert.Equal("1", row.GetProperty("v")[0].GetString());
            Assert.Equal(JsonValueKind.Null, row.GetProperty("v")[1].ValueKind);
        });
        Assert.Empty(r.Log);

        // After the 5 s back-off one more resolve; the same result keeps the gen and backs off again.
        r.Host.Tick(T0.AddMilliseconds(5010));
        r.Host.Tick(T0.AddMilliseconds(5020));
        Assert.Equal(3, r.Backend.ResolveCalls);
        for (var ms = 5030; ms < 10000; ms += 10) r.Host.Tick(T0.AddMilliseconds(ms));
        Assert.Equal(3, r.Backend.ResolveCalls);
        Assert.Single(r.Events("items"));
    }

    [Fact]
    public void WatchHost_PhantomSymbol_ReadableAgain_ClearsItemError()
    {
        var r = new Rig();
        var phantom = true;
        r.Backend.ReadFn = () => phantom ? [Ok("1"), Err(0x711)] : [Ok("1"), Ok("2")];
        r.Host.Start();
        r.Watch("MAIN.a", "MAIN.b");
        r.Lines.Clear();
        r.Host.Tick(T0);
        r.Host.Tick(T0.AddMilliseconds(10));
        Assert.Single(r.Events("items"));
        phantom = false;
        r.Host.Tick(T0.AddMilliseconds(20));
        r.Host.Tick(T0.AddMilliseconds(200));
        var items = r.Events("items");
        Assert.Equal(2, items.Count);
        Assert.Equal(3, items[1].GetProperty("gen").GetInt32());
        Assert.Equal(JsonValueKind.Null, items[1].GetProperty("items")[1].GetProperty("error").ValueKind);
        var last = r.Events("samples").Last();
        Assert.Equal(3, last.GetProperty("gen").GetInt32());
        Assert.Equal("2", last.GetProperty("rows").EnumerateArray().Last().GetProperty("v")[1].GetString());
        Assert.Equal(2, r.Backend.ResolveCalls);
    }

    [Fact]
    public void WatchHost_DeadReadFault_RightAfterResolve_BacksOff()
    {
        var r = new Rig();
        r.Backend.ReadFn = () => throw new AdsFault("dead", 0x711, false);
        r.Host.Start();
        r.Watch("MAIN.a");
        r.Host.Tick(T0);
        for (var ms = 10; ms < 5000; ms += 10) r.Host.Tick(T0.AddMilliseconds(ms));
        Assert.Equal(2, r.Backend.ResolveCalls);
        r.Host.Tick(T0.AddMilliseconds(5010));
        Assert.Equal(3, r.Backend.ResolveCalls);
    }

    [Fact]
    public void WriteMany_reply_has_one_entry_per_item()
    {
        var r = new Rig();
        r.Backend.WriteManyFn = w => [new WriteManyItem("MAIN.a", "written", "1"), new WriteManyItem("MAIN.b", "notWritten", Error: "rejected", AdsCode: 1808)];
        r.Host.Start();
        r.Host.Handle("""{"id":5,"op":"writeMany","writes":[{"symbol":"MAIN.a","value":"1"},{"symbol":"MAIN.b","value":"2"}]}""");
        var reply = r.Last();
        Assert.True(reply.GetProperty("ok").GetBoolean());
        var items = reply.GetProperty("data").GetProperty("items");
        Assert.Equal(2, items.GetArrayLength());
        Assert.Equal("written", items[0].GetProperty("status").GetString());
        Assert.Equal("1", items[0].GetProperty("value").GetString());
        Assert.False(items[0].TryGetProperty("readBackError", out _));
        Assert.Equal("notWritten", items[1].GetProperty("status").GetString());
        Assert.Equal(1808u, items[1].GetProperty("adsCode").GetUInt32());
    }

    [Theory]
    [InlineData("""{"id":5,"op":"writeMany"}""", "Missing array 'writes'.")]
    [InlineData("""{"id":5,"op":"writeMany","writes":"x"}""", "Missing array 'writes'.")]
    [InlineData("""{"id":5,"op":"writeMany","writes":[]}""", "writes must not be empty.")]
    [InlineData("""{"id":5,"op":"writeMany","writes":[{"symbol":"A","value":"1"},{"symbol":"B"}]}""", "writes[1] needs string 'symbol' and 'value'.")]
    [InlineData("""{"id":5,"op":"writeMany","writes":[{"symbol":"MAIN.A","value":"1"},{"symbol":"main.a","value":"2"}]}""", "Duplicate symbol: main.a")]
    public void WriteMany_validation_failures_say_written_no_and_call_no_backend(string request, string error)
    {
        var r = new Rig();
        r.Host.Start();
        r.Host.Handle(request);
        var reply = r.Last();
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.Equal("no", reply.GetProperty("written").GetString());
        Assert.Equal(error, reply.GetProperty("error").GetString());
        Assert.Equal(0, r.Backend.WriteManyCalls);
    }

    [Fact]
    public void WriteMany_more_than_the_limit_is_refused_before_the_backend()
    {
        var r = new Rig();
        r.Host.Start();
        var writes = string.Join(",", Enumerable.Range(0, WatchHost.MaxWrites + 1).Select(i => $$"""{"symbol":"S{{i}}","value":"1"}"""));
        r.Host.Handle($$"""{"id":5,"op":"writeMany","writes":[{{writes}}]}""");
        var reply = r.Last();
        Assert.Equal("no", reply.GetProperty("written").GetString());
        Assert.Equal("At most 20 writes are allowed.", reply.GetProperty("error").GetString());
        Assert.Equal(0, r.Backend.WriteManyCalls);
    }

    [Fact]
    public void WriteMany_not_sent_exception_says_written_no()
    {
        var r = new Rig();
        r.Backend.WriteManyFn = _ => throw new WriteNotSentException("writes[1] MAIN.b: bad");
        r.Host.Start();
        r.Host.Handle("""{"id":5,"op":"writeMany","writes":[{"symbol":"MAIN.a","value":"1"},{"symbol":"MAIN.b","value":"2"}]}""");
        var reply = r.Last();
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.Equal("no", reply.GetProperty("written").GetString());
    }

    [Fact]
    public void WriteMany_ads_fault_has_no_written_field_and_keeps_the_code()
    {
        var r = new Rig();
        r.Backend.WriteManyFn = _ => throw new AdsFault("no reply", 0x745, false);
        r.Host.Start();
        r.Host.Handle("""{"id":5,"op":"writeMany","writes":[{"symbol":"MAIN.a","value":"1"},{"symbol":"MAIN.b","value":"2"}]}""");
        var reply = r.Last();
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.False(reply.TryGetProperty("written", out _));
        Assert.Equal(0x745u, reply.GetProperty("adsCode").GetUInt32());
    }

    private static StructRead OneMember() => new("ST_Axis", [new MemberValue("MAIN.st.a", "DINT", "5", null)], 0, 0, []);

    [Fact]
    public void Read_with_depth_asks_the_backend_for_members()
    {
        var r = new Rig();
        r.Backend.MembersFn = (_, _) => OneMember();
        r.Host.Start();
        r.Host.Handle("""{"id":7,"op":"read","symbols":["MAIN.st"],"depth":3}""");
        var item = r.Last().GetProperty("data")[0];
        Assert.Equal("ST_Axis", item.GetProperty("type").GetString());
        Assert.Equal("MAIN.st.a", item.GetProperty("members")[0].GetProperty("name").GetString());
        Assert.Equal(0, item.GetProperty("notes").GetProperty("omittedMembers").GetInt32());
    }

    [Fact]
    public void Read_without_depth_has_no_members_property()
    {
        var r = new Rig();
        r.Host.Start();
        r.Host.Handle("""{"id":7,"op":"read","symbols":["MAIN.n"]}""");
        var item = r.Last().GetProperty("data")[0];
        Assert.False(item.TryGetProperty("members", out _));
        Assert.False(item.TryGetProperty("notes", out _));
        Assert.Equal(4, item.EnumerateObject().Count());
        Assert.Empty(r.Backend.MembersDepths);
    }

    [Fact]
    public void Read_with_depth_of_a_single_value_falls_back_to_the_scalar_read()
    {
        var r = new Rig();
        r.Host.Start();
        r.Host.Handle("""{"id":7,"op":"read","symbols":["MAIN.n"],"depth":2}""");
        Assert.Equal("1", r.Last().GetProperty("data")[0].GetProperty("value").GetString());
    }

    [Fact]
    public void Depth_is_clamped_to_the_allowed_range()
    {
        var r = new Rig();
        r.Host.Start();
        r.Host.Handle("""{"id":7,"op":"read","symbols":["MAIN.n"],"depth":9}""");
        r.Host.Handle("""{"id":8,"op":"read","symbols":["MAIN.n"],"depth":0}""");
        Assert.Equal([5, 1], r.Backend.MembersDepths);
    }

    [Fact]
    public void A_non_integer_depth_fails_the_request()
    {
        var r = new Rig();
        r.Host.Start();
        r.Host.Handle("""{"id":7,"op":"read","symbols":["MAIN.n"],"depth":"x"}""");
        var reply = r.Last();
        Assert.False(reply.GetProperty("ok").GetBoolean());
        Assert.Equal("read needs an integer 'depth'.", reply.GetProperty("error").GetString());
    }
}
