using System.Globalization;
using System.Net.Sockets;
using System.Runtime.Versioning;
using IECode.Core;
using IECode.Core.Ads;
using TwinCAT;
using TwinCAT.Ads;
using TwinCAT.Ads.SumCommand;
using TwinCAT.Ads.TypeSystem;
using TwinCAT.TypeSystem;
using AdsNetId = TwinCAT.Ads.AmsNetId;

namespace IECode.Automation;

/// <summary>
/// Beckhoff glue of the ADS watchlist (<see cref="WatchHost"/>): one ADS connection, the symbol table of the PLC and one
/// sum read per poll. All values are read by instance path, so a download never makes a read return bytes of another variable.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AdsWatchBackend(Core.AmsNetId target, int port, Action<string>? log = null) : IWatchBackend
{
    /// <summary>Index group of the symbol version byte; it changes with every download that changes the symbol table.</summary>
    private const uint SymbolVersionGroup = 0xF008;

    private readonly string _where = $"{target}:{port}";
    private AdsClient? _client;
    private ISymbolLoader? _loader;
    private byte? _loaderVersion, _watchVersion;
    private bool _stale = true, _versionUnreadable, _versionWarned, _resolved;
    private Watched[] _watched = [];
    private int[] _sumIndex = [];
    private SumSymbolRead? _sum;

    private sealed record Watched(IValueSymbol? Symbol, string BaseType, IReadOnlyDictionary<long, string>? Members);

    /// <summary>Opens the ADS port and proves the target is there: AdsClient.Connect alone only opens the local router port.</summary>
    public void Connect()
    {
        Drop();
        var client = new AdsClient();
        try
        {
            client.Connect(new AdsNetId(target.ToString()), port);
            var code = client.TryReadState(out _);
            if (code != AdsErrorCode.NoError) throw new AdsFault(Text($"Cannot reach {_where} over ADS", (uint)code), (uint)code, true);
        }
        catch (Exception e)
        {
            client.Dispose();
            var fault = Map(e, $"Cannot reach {_where} over ADS");
            throw fault.ConnectionLost ? fault : new AdsFault(fault.Message, fault.AdsCode, true);
        }
        _client = client;
    }

    /// <summary>Builds a new symbol loader after a fault or a symbol version change, otherwise looks the names up in the old one (O2).</summary>
    public IReadOnlyList<WatchItem> Resolve(IReadOnlyList<string> symbols)
    {
        // Until this resolve succeeds there is nothing valid to read; ReadWatched then asks the host to resolve again.
        _resolved = false;
        _sum = null;
        var client = Client();
        var version = ReadVersion(client);
        var loader = Loader(client, version);
        var watched = new Watched[symbols.Count];
        var items = new WatchItem[symbols.Count];
        for (var i = 0; i < symbols.Count; i++)
        {
            var name = symbols[i];
            IValueSymbol? sym;
            try
            {
                sym = Lookup(loader, name);
            }
            catch (AdsFault f) when (!f.ConnectionLost)
            {
                // E.g. a path through an invalid reference or pointer: an error of this item, not of the whole list.
                items[i] = new WatchItem(name, "", false, f.Message);
                watched[i] = new Watched(null, "", null);
                continue;
            }
            var typeName = sym?.DataType?.Name ?? "?";
            if (sym is null) items[i] = new WatchItem(name, "", false, "Symbol not found");
            else if (!AdsValues.IsSingleValue(sym.DataType)) items[i] = new WatchItem(name, typeName, false, $"{typeName} is not a single value; add its members instead");
            else
            {
                var (baseType, members) = AdsValues.Resolve(sym.DataType);
                watched[i] = new Watched(sym, baseType, members);
                items[i] = new WatchItem(name, typeName, PlcValueText.IsNumeric(baseType, members is not null), null);
                continue;
            }
            watched[i] = new Watched(null, "", null);
        }
        var index = Enumerable.Range(0, watched.Length).Where(i => watched[i].Symbol is not null).ToArray();
        _sum = index.Length == 0
            ? null
            : new SumSymbolRead(client, index.Select(i => (ISymbol)watched[i].Symbol!).ToList(), SumAccessMode.ValueByName, SumFallbackMode.All);
        _sumIndex = index;
        _watched = watched;
        _watchVersion = version;
        _resolved = true;
        return items;
    }

    public IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> ReadWatched()
    {
        if (!_resolved) throw new AdsFault("Watched symbols are not resolved", (uint)AdsErrorCode.DeviceSymbolNotFound, false);
        var row = new (string? Value, long? EnumValue, uint? AdsCode)[_watched.Length];
        if (_sum is null) return row;
        ResultSumValues2<ISymbol> result;
        try
        {
            result = _sum.Read2();
            if (result.Failed || result.ValueResults is null)
                throw new AdsFault(Text($"Read from {_where}", (uint)result.ErrorCode), (uint)result.ErrorCode, AdsCodes.IsConnectionLost((uint)result.ErrorCode));
        }
        catch (Exception e)
        {
            throw ReadFault(e);
        }
        // The target answers again: a symbol version that was unreadable (e.g. during a route hiccup) is tried once more
        // by the SymbolVersionChanged call after this poll, so a later download is noticed by its version again.
        _versionUnreadable = false;
        for (var k = 0; k < _sumIndex.Length; k++)
        {
            var i = _sumIndex[k];
            var w = _watched[i];
            var r = result.ValueResults[k];
            if (r.ErrorCode != AdsErrorCode.NoError)
            {
                if (AdsCodes.IsDeadHandle((uint)r.ErrorCode)) _stale = true;
                row[i] = (null, null, (uint)r.ErrorCode);
                continue;
            }
            row[i] = (PlcValueText.Format(w.BaseType, AdsValues.Normalize(w.BaseType, r.Value), w.Members), w.Members is null ? null : ToInt64(r.Value), null);
        }
        return row;
    }

    public bool SymbolVersionChanged()
    {
        var version = ReadVersion(Client());
        if (version is null || _watchVersion is null)
        {
            _watchVersion ??= version;
            return false;
        }
        if (version == _watchVersion) return false;
        _watchVersion = version;
        _stale = true;
        return true;
    }

    public (string Type, string Value) ReadOnce(string symbol)
    {
        var sym = Find(symbol);
        var (baseType, members) = AdsValues.Resolve(sym.DataType);
        var value = Call($"Read {symbol}", () => sym.ReadValue());
        return (sym.DataType?.Name ?? "?", PlcValueText.Format(baseType, AdsValues.Normalize(baseType, value), members));
    }

    public string Write(string symbol, string text)
    {
        var sym = Find(symbol);
        var (baseType, members) = AdsValues.Resolve(sym.DataType);
        var value = AdsValues.ParseForWrite(sym.DataType, text);
        Call($"Write {symbol}", () => { sym.WriteValue(value); return 0; });
        var back = Call($"Read {symbol}", () => sym.ReadValue());
        return PlcValueText.Format(baseType, AdsValues.Normalize(baseType, back), members);
    }

    public void Dispose() => Drop();

    private void Drop()
    {
        _client?.Dispose();
        _client = null;
        _loader = null;
        _sum = null;
        _resolved = false;
        _stale = true;
        _versionUnreadable = false;
        _watchVersion = null;
    }

    private AdsClient Client() => _client ?? throw new AdsFault($"Not connected to {_where}", null, true);

    private ISymbolLoader Loader(AdsClient client, byte? version)
    {
        if (_loader is null || _stale || version != _loaderVersion)
        {
            _loader = Call($"Symbol upload from {_where}", () => SymbolLoaderFactory.Create(client, SymbolLoaderSettings.Default));
            _loaderVersion = version;
            _stale = false;
        }
        return _loader;
    }

    private IValueSymbol? Lookup(ISymbolLoader loader, string name) =>
        Call($"Symbol lookup on {_where}", () => AdsValues.FindSymbol(loader.Symbols, name) as IValueSymbol);

    /// <summary>A single-value symbol for read / write requests; the loader is refreshed first if the symbol version moved on.</summary>
    private IValueSymbol Find(string symbol)
    {
        var client = Client();
        var sym = Lookup(Loader(client, ReadVersion(client)), symbol)
            ?? throw new IECodeException(ExitCodes.NotFound, $"Symbol '{symbol}' not found on {_where}.");
        if (!AdsValues.IsSingleValue(sym.DataType))
            throw new IECodeException(ExitCodes.Usage, $"{sym.DataType?.Name ?? "?"} is not a single value; add its members instead");
        return sym;
    }

    /// <summary>
    /// The 1-byte symbol version; null (warned once) if the target does not answer it. Until the next successful poll or
    /// reconnect it is not asked again, and downloads in between are noticed by read errors only.
    /// </summary>
    private byte? ReadVersion(AdsClient client)
    {
        if (_versionUnreadable) return null;
        var result = Call($"Symbol version read from {_where}", () => client.ReadAsResult(SymbolVersionGroup, 0, 1));
        var code = result.ErrorCode;
        var read = code == AdsErrorCode.NoError ? result.Data.Length : 0;
        if (read == 1) return result.Data.Span[0];
        if (AdsCodes.IsConnectionLost((uint)code)) throw new AdsFault(Text($"Symbol version read from {_where}", (uint)code), (uint)code, true);
        _versionUnreadable = true;
        if (!_versionWarned) log?.Invoke($"Cannot read the symbol version of {_where} (index group 0xF008: {code}, {read} byte(s)); downloads are noticed by read errors only.");
        _versionWarned = true;
        return null;
    }

    /// <summary>A failed sum read after a download (size mismatch, marshalling) becomes a dead-handle fault, so the host resolves again.</summary>
    private AdsFault ReadFault(Exception e)
    {
        var fault = Map(e, $"Read from {_where}");
        if (fault.ConnectionLost || fault.AdsCode is { } c && AdsCodes.IsDeadHandle(c)) return fault;
        return SymbolVersionChanged()
            ? new AdsFault(fault.Message + " (symbol version changed)", (uint)AdsErrorCode.DeviceSymbolVersionInvalid, false)
            : fault;
    }

    private T Call<T>(string what, Func<T> call)
    {
        try { return call(); }
        catch (Exception e) when (e is AdsFault or AdsException || IsTransport(e)) { throw Map(e, what); }
    }

    /// <summary>
    /// R2: an unreachable or stopped target also arrives as AdsErrorException, so the code decides (<see cref="AdsCodes"/>).
    /// Without a code, only transport failures mean the connection is gone; symbol, marshalling and type exceptions
    /// (AdsException subclasses, e.g. a read through an invalid reference) stay errors of the request or item.
    /// Only code-less, connection-lost and dead-handle faults mark the symbol loader stale; an ordinary ADS error code
    /// (access denied, symbol not found) says nothing about the loader and must not trigger another symbol upload.
    /// </summary>
    private AdsFault Map(Exception e, string what)
    {
        var fault = e switch
        {
            AdsFault f => f,
            _ when Code(e) is { } code => new AdsFault(Text(what, code), code, AdsCodes.IsConnectionLost(code)),
            _ when IsTransport(e) => new AdsFault($"{what}: connection lost ({e.Message})", null, true),
            _ => new AdsFault($"{what}: {e.Message}", null, false),
        };
        if (fault.AdsCode is not { } c || fault.ConnectionLost || AdsCodes.IsDeadHandle(c)) _stale = true;
        return fault;
    }

    private static uint? Code(Exception e)
    {
        for (var x = e; x is not null; x = x.InnerException)
            if (x is AdsErrorException a) return (uint)a.ErrorCode;
        return null;
    }

    private static bool IsTransport(Exception e) =>
        e is SocketException or IOException or ObjectDisposedException or ClientNotConnectedException or SessionException
        || e.GetType() == typeof(AdsException);

    private static string Text(string what, uint code) => $"{what}: {(AdsErrorCode)code} (0x{code:X})";

    private static long? ToInt64(object? value)
    {
        try { return value is IConvertible c ? c.ToInt64(CultureInfo.InvariantCulture) : null; }
        catch (Exception e) when (e is FormatException or InvalidCastException or OverflowException) { return null; }
    }
}
