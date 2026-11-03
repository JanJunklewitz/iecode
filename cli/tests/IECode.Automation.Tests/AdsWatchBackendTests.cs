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
        Assert.Equal("Symbol not found", items[2].Error);
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
        Assert.Throws<WriteNotSentException>(() => b.Write("MAIN.nope", "42"));
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
}


/// <summary>An AdsException subclass, as the SDK throws for symbol and marshalling problems; the bare type means a transport failure.</summary>
internal sealed class InvalidReference() : TwinCAT.AdsException("invalid reference");
