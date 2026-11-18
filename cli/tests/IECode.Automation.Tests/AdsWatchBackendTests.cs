using System.Runtime.Versioning;
using IECode.Core.Ads;
using TwinCAT.Ads;

namespace IECode.Automation.Tests;

[SupportedOSPlatform("windows")]
public class AdsWatchBackendTests
{
    private static (AdsWatchBackend Backend, FakeLink Link, List<string> Log) Make(Action<FakeLink>? setup = null)
    {
        var link = new FakeLink();
        setup?.Invoke(link);
        var log = new List<string>();
        var backend = new AdsWatchBackend("test:851", () => link, log.Add);
        return (backend, link, log);
    }

    private static FakeSymbol Int(string name, short value = 0) => new(name, "INT", "INT") { Value = value };

    private static SumRead Ok(params object?[] values) => new(AdsErrorCode.NoError, values.Select(v => new SumItem(AdsErrorCode.NoError, v)).ToList());

    private static SumRead Items(params AdsErrorCode[] codes) => new(AdsErrorCode.NoError, codes.Select(c => new SumItem(c, null)).ToList());

    [Fact]
    public void Connect_reports_a_target_that_does_not_answer_as_connection_lost()
    {
        var (b, _, _) = Make(l => l.State = AdsErrorCode.TargetPortNotFound);
        var f = Assert.Throws<AdsFault>(b.Connect);
        Assert.True(f.ConnectionLost);
        Assert.Equal(0x6u, f.AdsCode);
    }

    [Fact]
    public void Resolve_and_read_format_values_and_enum_members()
    {
        var mode = new FakeSymbol("MAIN.eMode", "E_Mode", "INT", new Dictionary<long, string> { [1] = "eRun" }) { Value = (short)1 };
        var (b, _, _) = Make(l =>
        {
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"), mode);
            l.Sum = () => Ok((short)7, (short)1);
        });
        b.Connect();
        var items = b.Resolve(["MAIN.nWatch", "MAIN.eMode", "MAIN.nope"]);
        Assert.Equal("Symbol not found. If the variable has {attribute 'hide'}, it has no ADS symbol: read it through a property with {attribute 'monitoring' := 'call'}.", items[2].Error);
        Assert.True(items[0].Numeric);
        var row = b.ReadWatched();
        Assert.Equal(("7", null, null), row[0]);
        Assert.Equal(("eRun", 1L, null), row[1]);
        Assert.Equal((null, null, null), row[2]);
    }

    [Fact]
    public void A_download_changes_the_symbol_version_and_the_next_resolve_uploads_a_new_table()
    {
        var (b, link, _) = Make(l =>
        {
            l.Versions = new([(AdsErrorCode.NoError, [1]), (AdsErrorCode.NoError, [2])]);
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        Assert.Equal(1, link.Uploads);
        Assert.True(b.SymbolVersionChanged());
        link.Upload = () => new FakeSet(new FakeSymbol("MAIN.nWatch", "REAL", "REAL") { Value = 1.5f });
        var items = b.Resolve(["MAIN.nWatch"]);
        Assert.Equal(2, link.Uploads);
        Assert.Equal("REAL", items[0].Type);
        Assert.False(b.SymbolVersionChanged());
    }

    [Fact]
    public void The_same_version_does_not_upload_again()
    {
        var (b, link, _) = Make(l => l.Upload = () => new FakeSet(Int("MAIN.nWatch")));
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        Assert.False(b.SymbolVersionChanged());
        b.Resolve(["MAIN.nWatch"]);
        Assert.Equal(1, link.Uploads);
    }

    [Theory]
    [InlineData(AdsErrorCode.DeviceSymbolNotFound)]
    [InlineData(AdsErrorCode.DeviceSymbolVersionInvalid)]
    public void A_dead_handle_on_the_version_read_means_the_table_is_changing(AdsErrorCode code)
    {
        var (b, link, _) = Make(l => l.Upload = () => new FakeSet(Int("MAIN.nWatch")));
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        link.Versions = new([(code, [])]);
        Assert.True(b.SymbolVersionChanged());
        var f = Assert.Throws<AdsFault>(() => b.Resolve(["MAIN.nWatch"]));
        Assert.False(f.ConnectionLost);
        Assert.Equal((uint)code, f.AdsCode);
    }

    [Fact]
    public void A_connection_error_on_the_version_read_is_connection_lost()
    {
        var (b, link, _) = Make(l => l.Upload = () => new FakeSet(Int("MAIN.nWatch")));
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        link.Versions = new([(AdsErrorCode.TlsSendError, [])]);
        var f = Assert.Throws<AdsFault>(() => b.SymbolVersionChanged());
        Assert.True(f.ConnectionLost);
    }

    [Fact]
    public void An_empty_symbol_table_with_wanted_symbols_is_connection_lost_and_is_not_cached()
    {
        var (b, link, _) = Make();
        b.Connect();
        var f = Assert.Throws<AdsFault>(() => b.Resolve(["MAIN.nWatch"]));
        Assert.True(f.ConnectionLost);
        link.Upload = () => new FakeSet(Int("MAIN.nWatch"));
        Assert.Null(b.Resolve(["MAIN.nWatch"])[0].Error);
        Assert.Equal(2, link.Uploads);
    }

    [Fact]
    public void A_failed_sum_read_with_a_connection_code_is_connection_lost()
    {
        var (b, _, _) = Make(l =>
        {
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
            l.Sum = () => new SumRead(AdsErrorCode.TlsSendError, null);
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        var f = Assert.Throws<AdsFault>(b.ReadWatched);
        Assert.True(f.ConnectionLost);
        Assert.Equal(0x1Du, f.AdsCode);
    }

    [Fact]
    public void A_marshalling_exception_after_a_download_becomes_a_dead_handle_fault()
    {
        var (b, link, _) = Make(l =>
        {
            l.Versions = new([(AdsErrorCode.NoError, [1]), (AdsErrorCode.NoError, [2])]);
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        link.Sum = () => throw new InvalidCastException("size mismatch");
        var f = Assert.Throws<AdsFault>(b.ReadWatched);
        Assert.False(f.ConnectionLost);
        Assert.Equal((uint)AdsErrorCode.DeviceSymbolVersionInvalid, f.AdsCode);
    }

    [Fact]
    public void A_marshalling_exception_without_a_download_stays_a_plain_fault()
    {
        var (b, _, _) = Make(l =>
        {
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
            l.Sum = () => throw new InvalidCastException("odd");
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        var f = Assert.Throws<AdsFault>(b.ReadWatched);
        Assert.False(f.ConnectionLost);
        Assert.Null(f.AdsCode);
    }

    [Fact]
    public void A_dead_item_makes_the_next_resolve_upload_again_but_other_errors_do_not()
    {
        var (b, link, _) = Make(l =>
        {
            l.Upload = () => new FakeSet(Int("MAIN.a"), Int("MAIN.b"));
            l.Sum = () => Items(AdsErrorCode.DeviceAccessDenied, AdsErrorCode.NoError);
        });
        b.Connect();
        b.Resolve(["MAIN.a", "MAIN.b"]);
        Assert.Equal((uint)AdsErrorCode.DeviceAccessDenied, b.ReadWatched()[0].AdsCode);
        b.Resolve(["MAIN.a", "MAIN.b"]);
        Assert.Equal(1, link.Uploads);
        link.Sum = () => Items(AdsErrorCode.DeviceSymbolNotFound, AdsErrorCode.NoError);
        Assert.Equal(0x710u, b.ReadWatched()[0].AdsCode);
        b.Resolve(["MAIN.a", "MAIN.b"]);
        Assert.Equal(2, link.Uploads);
    }

    [Fact]
    public void A_lookup_fault_of_one_symbol_is_an_item_error_only()
    {
        var bad = Int("MAIN.pRef");
        bad.Throw = new InvalidReference();
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(Int("MAIN.ok"), bad));
        b.Connect();
        var items = b.Resolve(["MAIN.pRef", "MAIN.ok"]);
        Assert.Contains("invalid reference", items[0].Error);
        Assert.Null(items[1].Error);
    }

    [Fact]
    public void An_unreadable_version_is_warned_once_and_asked_again_after_a_good_poll()
    {
        var (b, link, log) = Make(l =>
        {
            l.Versions = new([(AdsErrorCode.DeviceInvalidGroup, [])]);
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
            l.Sum = () => Ok((short)3);
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        Assert.False(b.SymbolVersionChanged());
        Assert.Single(log);
        var reads = link.VersionReads;
        b.ReadWatched();
        link.Versions = new([(AdsErrorCode.NoError, [5])]);
        Assert.True(b.SymbolVersionChanged());
        Assert.Equal(reads + 1, link.VersionReads);
        Assert.Single(log);
    }

    [Fact]
    public void Write_returns_the_read_back_value()
    {
        var sym = Int("MAIN.nWatch");
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(sym));
        b.Connect();
        Assert.Equal(("42", (string?)null), b.Write("MAIN.nWatch", "42"));
        Assert.Equal("42", sym.Written);
    }

    [Fact]
    public void Write_reports_a_failed_read_back()
    {
        var sym = Int("MAIN.nWatch");
        sym.ReadThrow = new AdsFault("Read MAIN.nWatch: connection lost", null, true);
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(sym));
        b.Connect();
        var (value, error) = b.Write("MAIN.nWatch", "42");
        Assert.Equal("42", sym.Written);
        Assert.Null(value);
        Assert.Contains("connection lost", error);
    }

    [Fact]
    public void Write_of_an_unknown_symbol_is_not_sent()
    {
        var sym = Int("MAIN.nWatch");
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(sym));
        b.Connect();
        var e = Assert.Throws<WriteNotSentException>(() => b.Write("MAIN.nope", "42"));
        Assert.Contains("{attribute 'hide'}", e.Message);
        Assert.Null(sym.Written);
    }

    [Fact]
    public void Write_of_a_value_that_is_not_a_single_value_is_not_sent()
    {
        var sym = new FakeSymbol("MAIN.fb", "FB_X", "", single: false);
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(sym));
        b.Connect();
        Assert.Throws<WriteNotSentException>(() => b.Write("MAIN.fb", "1"));
        Assert.Null(sym.Written);
    }

    [Fact]
    public void Write_of_an_unparsable_value_is_not_sent()
    {
        var sym = Int("MAIN.nWatch", 7);
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(sym));
        b.Connect();
        Assert.Throws<WriteNotSentException>(() => b.Write("MAIN.nWatch", "zz"));
        Assert.Null(sym.Written);
    }

    [Fact]
    public void Write_that_fails_in_the_ads_call_stays_an_ads_fault()
    {
        var sym = Int("MAIN.nWatch");
        sym.WriteThrow = new AdsFault("Write MAIN.nWatch: timeout", null, false);
        var (b, _, _) = Make(l => l.Upload = () => new FakeSet(sym));
        b.Connect();
        Assert.Throws<AdsFault>(() => b.Write("MAIN.nWatch", "42"));
    }

    private static FakeSymbol Axis(params FakeSymbol[] kids) => new("MAIN.stAxis", "ST_Axis", "", single: false) { Children = kids };

    private static (AdsWatchBackend Backend, FakeLink Link) MakeStruct(FakeSymbol root)
    {
        var link = new FakeLink { Upload = () => new FakeSet(root) };
        var backend = new AdsWatchBackend("test:851", () => link);
        backend.Connect();
        return (backend, link);
    }

    [Fact]
    public void ReadMembers_reads_all_leaves_of_a_struct_in_one_sum_read()
    {
        var root = Axis(new FakeSymbol("MAIN.stAxis.nPos", "DINT", "DINT"), new FakeSymbol("MAIN.stAxis.bOn", "BOOL", "BOOL"));
        var (b, link) = MakeStruct(root);
        link.Sum = () => Ok(120, true);
        var r = b.ReadMembers("MAIN.stAxis", 3)!;
        Assert.Equal("ST_Axis", r.Type);
        Assert.Equal([new MemberValue("MAIN.stAxis.nPos", "DINT", "120", null), new MemberValue("MAIN.stAxis.bOn", "BOOL", "TRUE", null)], r.Members);
        Assert.Equal(1, link.SumReads);
    }

    [Fact]
    public void ReadMembers_returns_null_for_a_single_value()
    {
        var (b, _) = MakeStruct(Int("MAIN.stAxis"));
        Assert.Null(b.ReadMembers("MAIN.stAxis", 3));
    }

    [Fact]
    public void ReadMembers_of_an_unknown_symbol_is_not_found_with_the_hide_hint()
    {
        var (b, _) = MakeStruct(Axis());
        var e = Assert.Throws<IECode.Core.IECodeException>(() => b.ReadMembers("MAIN.nope", 3));
        Assert.Equal(IECode.Core.ExitCodes.NotFound, e.ExitCode);
        Assert.Contains("{attribute 'hide'}", e.Message);
    }

    [Fact]
    public void One_member_with_a_read_error_does_not_fail_the_others()
    {
        var root = Axis(new FakeSymbol("MAIN.stAxis.nPos", "DINT", "DINT"), new FakeSymbol("MAIN.stAxis.nGone", "DINT", "DINT"));
        var (b, link) = MakeStruct(root);
        link.Sum = () => new SumRead(AdsErrorCode.NoError, [new SumItem(AdsErrorCode.NoError, 7), new SumItem(AdsErrorCode.DeviceSymbolNotFound, null)]);
        var r = b.ReadMembers("MAIN.stAxis", 3)!;
        Assert.Equal("7", r.Members[0].Value);
        Assert.Null(r.Members[1].Value);
        Assert.Equal("DeviceSymbolNotFound (0x710)", r.Members[1].Error);
    }

    [Fact]
    public void A_failed_sum_read_of_a_struct_is_an_ads_fault()
    {
        var (b, link) = MakeStruct(Axis(new FakeSymbol("MAIN.stAxis.nPos", "DINT", "DINT")));
        link.Sum = () => new SumRead((AdsErrorCode)0x745, null);
        Assert.Throws<AdsFault>(() => b.ReadMembers("MAIN.stAxis", 3));
    }

    private static readonly IReadOnlySet<uint> TestNoEffect = new HashSet<uint> { 0x1 };

    private static (AdsWatchBackend Backend, FakeLink Link, FakeSymbol[] Syms) MakeWriteMany(int count, IReadOnlySet<uint>? noEffect = null)
    {
        var syms = Enumerable.Range(0, count).Select(i => Int($"MAIN.n{i}")).ToArray();
        var link = new FakeLink { Upload = () => new FakeSet(syms) };
        var backend = new AdsWatchBackend("test:851", () => link, noEffectCodes: noEffect);
        backend.Connect();
        return (backend, link, syms);
    }

    [Fact]
    public void WriteMany_prepares_every_value_before_anything_is_sent()
    {
        var (b, link, syms) = MakeWriteMany(3);
        var e = Assert.Throws<WriteNotSentException>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "zz"), ("MAIN.n2", "3")]));
        Assert.Equal("writes[1] MAIN.n1: 'zz' is not a valid INT.", e.Message);
        Assert.Equal(0, link.SumWrites);
        Assert.Null(syms[0].Written);
    }

    [Fact]
    public void WriteMany_unknown_symbol_sends_nothing()
    {
        var (b, link, _) = MakeWriteMany(2);
        var e = Assert.Throws<WriteNotSentException>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.nope", "2")]));
        Assert.StartsWith("writes[1] MAIN.nope: Symbol 'MAIN.nope' not found", e.Message);
        Assert.Equal(0, link.SumWrites);
    }

    [Fact]
    public void WriteMany_non_single_value_symbol_sends_nothing()
    {
        var arr = new FakeSymbol("MAIN.aValues", "ARRAY [0..3] OF INT", "", single: false);
        var link = new FakeLink { Upload = () => new FakeSet(Int("MAIN.n0"), arr) };
        var b = new AdsWatchBackend("test:851", () => link);
        b.Connect();
        var e = Assert.Throws<WriteNotSentException>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.aValues", "2")]));
        Assert.StartsWith("writes[1] MAIN.aValues:", e.Message);
        Assert.Equal(0, link.SumWrites);
    }

    [Fact]
    public void WriteMany_sends_one_sum_write_and_reads_back_with_one_sum_read()
    {
        var (b, link, _) = MakeWriteMany(2);
        link.Sum = () => Ok((short)1, (short)2);
        var items = b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]);
        Assert.Equal(1, link.SumWrites);
        Assert.Equal(1, link.SumReads);
        Assert.Equal([new WriteManyItem("MAIN.n0", "written", "1"), new WriteManyItem("MAIN.n1", "written", "2")], items);
    }

    [Fact]
    public void WriteMany_a_device_code_marks_only_that_item_not_written()
    {
        var (b, link, _) = MakeWriteMany(3, TestNoEffect);
        link.SumWriteFn = _ => new SumWrite(AdsErrorCode.NoError, [AdsErrorCode.NoError, (AdsErrorCode)0x1, AdsErrorCode.NoError]);
        link.Sum = () => Ok((short)1, (short)3);
        var items = b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2"), ("MAIN.n2", "3")]);
        Assert.Equal(["written", "notWritten", "written"], items.Select(i => i.Status));
        Assert.Equal(0x1u, items[1].AdsCode);
        Assert.Contains("0x1", items[1].Error);
        Assert.Equal("3", items[2].Value);
    }

    [Fact]
    public void WriteMany_default_sets_treat_the_two_measured_device_codes_as_rejections_and_the_rest_as_unknown()
    {
        var (b, link, _) = MakeWriteMany(3);
        link.SumWriteFn = _ => new SumWrite(AdsErrorCode.NoError, [AdsErrorCode.DeviceInvalidAccess, AdsErrorCode.DeviceInvalidOffset, AdsErrorCode.DeviceServiceNotSupported]);
        var items = b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2"), ("MAIN.n2", "3")]);
        Assert.Equal(["notWritten", "notWritten", "unknown"], items.Select(i => i.Status));
    }

    [Fact]
    public void WriteMany_a_router_that_finds_no_runtime_sent_nothing()
    {
        var (b, link, _) = MakeWriteMany(2);
        link.SumWriteFn = _ => new SumWrite(AdsErrorCode.TargetPortNotFound, null);
        Assert.Throws<WriteNotSentException>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]));
    }

    [Fact]
    public void WriteMany_an_sdk_argument_exception_while_building_the_request_sent_nothing()
    {
        var (b, link, _) = MakeWriteMany(2);
        link.SumWriteFn = _ => throw new ArgumentOutOfRangeException("values");
        Assert.Throws<WriteNotSentException>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]));
    }

    [Fact]
    public void WriteMany_a_code_that_is_not_proven_to_be_a_rejection_is_unknown()
    {
        // Only the two measured device codes count as a rejection; any other code stays unknown.
        var (b, link, _) = MakeWriteMany(2);
        link.SumWriteFn = _ => new SumWrite(AdsErrorCode.NoError, [AdsErrorCode.NoError, (AdsErrorCode)0x2]);
        link.Sum = () => Ok((short)1);
        var items = b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]);
        Assert.Equal(["written", "unknown"], items.Select(i => i.Status));
        Assert.Contains("0x2", items[1].Error);
        Assert.Null(items[1].Value);
    }

    [Fact]
    public void WriteMany_a_result_count_mismatch_is_unknown_for_every_item()
    {
        var (b, link, _) = MakeWriteMany(3);
        link.SumWriteFn = _ => new SumWrite(AdsErrorCode.NoError, [AdsErrorCode.NoError, AdsErrorCode.NoError]);
        var items = b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2"), ("MAIN.n2", "3")]);
        Assert.All(items, i =>
        {
            Assert.Equal("unknown", i.Status);
            Assert.Equal("ADS returned 2 results for 3 writes", i.Error);
        });
    }

    [Fact]
    public void WriteMany_a_whole_request_failure_is_an_ads_fault_not_a_not_sent()
    {
        var (b, link, _) = MakeWriteMany(2);
        link.SumWriteFn = _ => new SumWrite((AdsErrorCode)0x745, null);
        var f = Assert.Throws<AdsFault>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]));
        Assert.Equal(0x745u, f.AdsCode);
    }

    [Fact]
    public void WriteMany_an_exception_from_the_link_is_an_ads_fault()
    {
        var (b, link, _) = MakeWriteMany(2);
        link.SumWriteFn = _ => throw new InvalidReference();
        Assert.Throws<AdsFault>(() => b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]));
    }

    [Fact]
    public void WriteMany_a_failed_read_back_keeps_written()
    {
        var (b, link, _) = MakeWriteMany(2);
        link.Sum = () => throw new IOException("link down");
        var items = b.WriteMany([("MAIN.n0", "1"), ("MAIN.n1", "2")]);
        Assert.All(items, i =>
        {
            Assert.Equal("written", i.Status);
            Assert.Null(i.Value);
            Assert.Contains("link down", i.ReadBackError);
        });
    }

    [Fact]
    public void WriteMany_resolves_the_symbol_table_once_for_the_whole_batch()
    {
        var (b, link, _) = MakeWriteMany(5);
        link.Sum = () => Ok((short)1, (short)1, (short)1, (short)1, (short)1);
        var versionReads = link.VersionReads;
        b.WriteMany(Enumerable.Range(0, 5).Select(i => ($"MAIN.n{i}", "1")).ToList());
        Assert.Equal(1, link.Uploads);
        Assert.Equal(1, link.VersionReads - versionReads);
    }

    [Fact]
    public void Resolve_reports_a_version_change_across_a_reconnect()
    {
        var (b, link, _) = Make(l =>
        {
            l.Versions = new([(AdsErrorCode.NoError, [3])]);
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        Assert.False(b.ResolveChangedVersion);
        b.Connect();
        link.Versions = new([(AdsErrorCode.NoError, [4])]);
        b.Resolve(["MAIN.nWatch"]);
        Assert.True(b.ResolveChangedVersion);
        b.Resolve(["MAIN.nWatch"]);
        Assert.False(b.ResolveChangedVersion);
    }

    [Fact]
    public void Resolve_with_an_unreadable_version_reports_no_change()
    {
        var (b, link, _) = Make(l => l.Upload = () => new FakeSet(Int("MAIN.nWatch")));
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        b.Connect();
        link.Versions = new([(AdsErrorCode.DeviceInvalidGroup, [])]);
        b.Resolve(["MAIN.nWatch"]);
        Assert.False(b.ResolveChangedVersion);
    }

    [Fact]
    public void An_unreadable_version_keeps_the_baseline_for_a_later_change()
    {
        var (b, link, _) = Make(l =>
        {
            l.Versions = new([(AdsErrorCode.NoError, [3])]);
            l.Upload = () => new FakeSet(Int("MAIN.nWatch"));
        });
        b.Connect();
        b.Resolve(["MAIN.nWatch"]);
        b.Connect();
        link.Versions = new([(AdsErrorCode.DeviceInvalidGroup, [])]);
        b.Resolve(["MAIN.nWatch"]);
        b.Connect();
        link.Versions = new([(AdsErrorCode.NoError, [4])]);
        b.Resolve(["MAIN.nWatch"]);
        Assert.True(b.ResolveChangedVersion);
    }
}


/// <summary>An AdsException subclass, as the SDK throws for symbol and marshalling problems; the bare type means a transport failure.</summary>
internal sealed class InvalidReference() : TwinCAT.AdsException("invalid reference");
