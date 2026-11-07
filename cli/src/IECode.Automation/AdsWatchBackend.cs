using System.Globalization;
using System.Net.Sockets;
using System.Runtime.Versioning;
using IECode.Core;
using IECode.Core.Ads;
using TwinCAT;
using TwinCAT.Ads;

namespace IECode.Automation;

/// <summary>
/// Beckhoff glue of the ADS watchlist (<see cref="WatchHost"/>): one ADS connection, the symbol table of the PLC and one
/// sum read per poll. All values are read by instance path, so a download never makes a read return bytes of another variable.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AdsWatchBackend : IWatchBackend
{
    private readonly string _where;
    private readonly Func<IAdsLink> _newLink;
    private readonly Action<string>? _log;
    private IAdsLink? _link;
    private ISymbolSet? _loader;
    /// <summary>The symbol version byte (index group 0xF008) changes with every download that changes the symbol table.</summary>
    private byte? _loaderVersion, _watchVersion;
    private bool _stale = true, _versionUnreadable, _versionWarned, _resolved;
    /// <summary>A watched item read 0x710/0x711: the next Resolve uploads a new symbol table, one-off reads and writes do not.</summary>
    private bool _itemsDead;
    private Watched[] _watched = [];
    private int[] _sumIndex = [];
    private ISymbolRead? _sum;

    private sealed record Watched(ILinkSymbol? Symbol, string BaseType, IReadOnlyDictionary<long, string>? Members);

    public AdsWatchBackend(Core.AmsNetId target, int port, Action<string>? log = null)
        : this($"{target}:{port}", () => new BeckhoffLink(target, port), log)
    {
    }

    internal AdsWatchBackend(string where, Func<IAdsLink> newLink, Action<string>? log = null)
    {
        _where = where;
        _newLink = newLink;
        _log = log;
    }

    /// <summary>Opens the ADS port and proves the target is there: connecting alone only opens the local router port.</summary>
    public void Connect()
    {
        Drop();
        IAdsLink? link = null;
        try
        {
            link = _newLink();
            link.Connect();
            var code = link.ReadState();
            if (code != AdsErrorCode.NoError) throw new AdsFault(Text($"Cannot reach {_where} over ADS", (uint)code), (uint)code, true);
        }
        catch (Exception e)
        {
            link?.Dispose();
            var fault = Map(e, $"Cannot reach {_where} over ADS");
            throw fault.ConnectionLost ? fault : new AdsFault(fault.Message, fault.AdsCode, true);
        }
        _link = link;
    }

    /// <summary>Builds a new symbol loader after a fault or a symbol version change, otherwise looks the names up in the old one (O2).</summary>
    public IReadOnlyList<WatchItem> Resolve(IReadOnlyList<string> symbols)
    {
        // Until this resolve succeeds there is nothing valid to read; ReadWatched then asks the host to resolve again.
        _resolved = false;
        _sum = null;
        var link = Link();
        if (_itemsDead) _stale = true;
        _itemsDead = false;
        var version = ReadVersion(link);
        var loader = Loader(link, version, symbols.Count);
        var watched = new Watched[symbols.Count];
        var items = new WatchItem[symbols.Count];
        for (var i = 0; i < symbols.Count; i++)
        {
            var name = symbols[i];
            ILinkSymbol? sym;
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
            if (sym is null) items[i] = new WatchItem(name, "", false, AdsCodes.SymbolNotFound);
            else if (!sym.IsSingleValue) items[i] = new WatchItem(name, sym.TypeName, false, $"{sym.TypeName} is not a single value; add its members instead");
            else
            {
                watched[i] = new Watched(sym, sym.BaseType, sym.Members);
                items[i] = new WatchItem(name, sym.TypeName, PlcValueText.IsNumeric(sym.BaseType, sym.Members is not null), null);
                continue;
            }
            watched[i] = new Watched(null, "", null);
        }
        var index = Enumerable.Range(0, watched.Length).Where(i => watched[i].Symbol is not null).ToArray();
        _sum = index.Length == 0 ? null : link.PrepareRead(index.Select(i => watched[i].Symbol!).ToList());
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
        IReadOnlyList<SumItem> results;
        try
        {
            var result = _sum.Read();
            if (result.Items is null || result.Code != AdsErrorCode.NoError)
                throw new AdsFault(Text($"Read from {_where}", (uint)result.Code), (uint)result.Code, AdsCodes.IsConnectionLost((uint)result.Code));
            results = result.Items;
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
            var r = results[k];
            if (r.Code != AdsErrorCode.NoError)
            {
                // A symbol in the table but not in the running program reads 0x710 on every poll (the host backs off);
                // only a resolve should upload the table again for it, not every one-off read or write in between.
                if (AdsCodes.IsDeadHandle((uint)r.Code)) _itemsDead = true;
                row[i] = (null, null, (uint)r.Code);
                continue;
            }
            row[i] = (PlcValueText.Format(w.BaseType, AdsValues.Normalize(w.BaseType, r.Value), w.Members), w.Members is null ? null : ToInt64(r.Value), null);
        }
        return row;
    }

    /// <summary>The baseline is only stored by a successful <see cref="Resolve"/>, never adopted here.</summary>
    public bool SymbolVersionChanged()
    {
        byte? version;
        try
        {
            version = ReadVersion(Link());
        }
        catch (AdsFault f) when (!f.ConnectionLost && f.AdsCode is { } c && AdsCodes.IsDeadHandle(c))
        {
            // The symbol table is being replaced: resolve again (the resolve fails and is retried while this lasts).
            return true;
        }
        if (!SymbolVersion.NeedsResolve(_watchVersion, version)) return false;
        _stale = true;
        return true;
    }

    public (string Type, string Value) ReadOnce(string symbol)
    {
        var sym = Find(symbol);
        var value = Call($"Read {symbol}", sym.Read);
        return (sym.TypeName, PlcValueText.Format(sym.BaseType, AdsValues.Normalize(sym.BaseType, value), sym.Members));
    }

    public (string? Value, string? ReadBackError) Write(string symbol, string text)
    {
        ILinkSymbol sym;
        try
        {
            sym = Find(symbol);
        }
        catch (IECodeException e)
        {
            // Not found / not a single value: known before anything is sent.
            throw new WriteNotSentException(e.Message, e);
        }
        Call($"Write {symbol}", () => { sym.Write(text); return 0; });
        // From here on the PLC took the value; a failing read-back must not look like a failed write.
        try
        {
            var back = Call($"Read {symbol}", sym.Read);
            return (PlcValueText.Format(sym.BaseType, AdsValues.Normalize(sym.BaseType, back), sym.Members), null);
        }
        catch (Exception e)
        {
            return (null, e.Message);
        }
    }

    public void Dispose() => Drop();

    private void Drop()
    {
        _link?.Dispose();
        _link = null;
        _loader = null;
        _sum = null;
        _resolved = false;
        _stale = true;
        _itemsDead = false;
        _versionUnreadable = false;
        _watchVersion = null;
    }

    private IAdsLink Link() => _link ?? throw new AdsFault($"Not connected to {_where}", null, true);

    /// <summary>An empty table while <paramref name="requested"/> symbols are wanted is a lost connection, never cached.</summary>
    private ISymbolSet Loader(IAdsLink link, byte? version, int requested)
    {
        if (_loader is null || _stale || version != _loaderVersion)
        {
            // The table is uploaded on first access of Symbols, so the count is taken inside the mapped call.
            var (loader, count) = Call($"Symbol upload from {_where}", () =>
            {
                var l = link.UploadSymbols();
                return (l, l.Count);
            });
            if (SymbolTable.MeansUnreachable(requested, count))
            {
                _loader = null;
                _stale = true;
                throw new AdsFault($"Symbol upload from {_where}: empty symbol table, the target does not answer", null, true);
            }
            _loader = loader;
            _loaderVersion = version;
            _stale = false;
        }
        return _loader;
    }

    private ILinkSymbol? Lookup(ISymbolSet loader, string name) => Call($"Symbol lookup on {_where}", () => loader.Find(name));

    /// <summary>A single-value symbol for read / write requests; the loader is refreshed first if the symbol version moved on.</summary>
    private ILinkSymbol Find(string symbol)
    {
        var link = Link();
        var sym = Lookup(Loader(link, ReadVersion(link), 1), symbol)
            ?? throw new IECodeException(ExitCodes.NotFound, $"Symbol '{symbol}' not found on {_where}. {AdsCodes.HiddenHint}");
        if (!sym.IsSingleValue)
            throw new IECodeException(ExitCodes.Usage, $"{sym.TypeName} is not a single value; add its members instead");
        return sym;
    }

    /// <summary>
    /// The 1-byte symbol version; null (warned once) if the target does not answer it. Until the next successful poll or
    /// reconnect it is not asked again, and downloads in between are noticed by read errors only.
    /// 0x710/0x711 on the version itself means the symbol table is being replaced (start of a download): a dead-handle
    /// fault, so the host resolves again and a resolve in that window fails instead of storing no version.
    /// </summary>
    private byte? ReadVersion(IAdsLink link)
    {
        if (_versionUnreadable) return null;
        var (code, data) = Call($"Symbol version read from {_where}", link.ReadSymbolVersion);
        var read = code == AdsErrorCode.NoError ? data.Length : 0;
        switch (SymbolVersion.Classify((uint)code, read))
        {
            case SymbolVersionRead.Value:
                return data[0];
            case SymbolVersionRead.ConnectionLost:
                throw new AdsFault(Text($"Symbol version read from {_where}", (uint)code), (uint)code, true);
            case SymbolVersionRead.Changing:
                _stale = true;
                throw new AdsFault(Text($"Symbol version read from {_where}", (uint)code) + " (symbol table is changing)", (uint)code, false);
        }
        _versionUnreadable = true;
        if (!_versionWarned) _log?.Invoke($"Cannot read the symbol version of {_where} (index group 0xF008: {code}, {read} byte(s)); downloads are noticed by read errors only.");
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
