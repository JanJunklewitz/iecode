using System.Text.Json;

namespace IECode.Core.Ads;

/// <summary>
/// Protocol and recovery logic of the ADS watchlist. No threads, no clock: the loop calls <see cref="Tick"/>
/// with the current time, stdin lines go to <see cref="Handle"/>. All ADS access goes through <see cref="IWatchBackend"/>.
/// </summary>
public sealed class WatchHost(IWatchBackend backend, Action<string> emit, Action<string>? log = null)
{
    public const int Protocol = 1, MaxSymbols = 200;
    private const int FlushMs = 100, RetryMs = 2000, MinIntervalMs = 10, MaxIntervalMs = 5000, ResolveBackoffMs = 5000;

    private readonly Action<string> _log = log ?? Console.Error.WriteLine;
    private readonly List<WatchRow> _pending = [];
    private readonly HashSet<string> _reported = [];
    private IReadOnlyList<string> _symbols = [];
    private IReadOnlyList<WatchItem> _items = [];
    /// <summary>The items as the backend resolved them; <see cref="_items"/> adds the errors of <see cref="_unreadable"/>.</summary>
    private IReadOnlyList<WatchItem> _resolvedItems = [];
    /// <summary>Items that still return 0x710/0x711 right after a fresh resolve: in the symbol table but not readable.</summary>
    private readonly SortedDictionary<int, uint> _unreadable = [];
    private int _gen;
    private bool _connected, _needResolve, _freshResolve;
    private DateTimeOffset? _lastFlush, _retryAt, _resolveBackoffUntil;
    private bool _retryPending;
    private int _intervalMs = 100;

    public int IntervalMs => _intervalMs;

    public void Start()
    {
        emit(WatchJson.Serialize(new WatchHelloEvent("hello", Protocol)));
        TryConnect();
    }

    public void Handle(string requestLine)
    {
        JsonElement? id = null;
        try
        {
            using var doc = JsonDocument.Parse(requestLine);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new IECodeException(ExitCodes.Usage, "Request must be a JSON object.");
            if (root.TryGetProperty("id", out var idEl)) id = idEl.Clone();
            var op = root.TryGetProperty("op", out var opEl) && opEl.ValueKind == JsonValueKind.String ? opEl.GetString() : null;
            object data = op switch
            {
                "watch" => DoWatch(Symbols(root)),
                "read" => DoRead(Symbols(root)),
                "write" => DoWrite(Str(root, "symbol"), Str(root, "value")),
                "interval" => DoInterval(root),
                _ => throw new IECodeException(ExitCodes.Usage, $"Unknown op '{op}'."),
            };
            emit(WatchJson.Serialize(new WatchReply(id, true, data, null, null)));
        }
        catch (JsonException ex)
        {
            emit(WatchJson.Serialize(new WatchReply(id, false, null, "Invalid JSON: " + ex.Message, null)));
        }
        catch (AdsFault f)
        {
            if (f.ConnectionLost) MarkLost(f.Message, null);
            emit(WatchJson.Serialize(new WatchReply(id, false, null, f.Message, f.AdsCode)));
        }
        catch (Exception ex)
        {
            emit(WatchJson.Serialize(new WatchReply(id, false, null, ex.Message, null)));
        }
    }

    public void Tick(DateTimeOffset now)
    {
        _lastFlush ??= now;
        if (!_connected)
        {
            if (_retryPending)
            {
                // The failed attempt may have blocked for seconds; count the retry delay from the first Tick after it.
                _retryPending = false;
                _retryAt = now + TimeSpan.FromMilliseconds(RetryMs);
                return;
            }
            if (_retryAt is { } at && now < at) return;
            TryConnect();
            return;
        }
        try
        {
            if (_needResolve) ResolveAgain();
            if (_items.Count > 0) Poll(now);
        }
        catch (AdsFault f) when (f.ConnectionLost)
        {
            MarkLost(f.Message, now);
            return;
        }
        catch (Exception ex)
        {
            ReportOnce("tick:" + ex.Message, ex.Message);
        }
        if (now - _lastFlush >= TimeSpan.FromMilliseconds(FlushMs)) Flush(now);
    }

    /// <summary>
    /// Dead-handle codes (0x710/0x711) make the host resolve again, unless they come right after a resolve that already
    /// loaded a fresh symbol table: then the symbol is in the table but not in the running program (or the runtime is
    /// going down), another resolve would only upload the same table again. Those items get an item error, the other
    /// items keep streaming, and the resolve is retried after <see cref="ResolveBackoffMs"/>.
    /// </summary>
    private void Poll(DateTimeOffset now)
    {
        var fresh = _freshResolve;
        _freshResolve = false;
        var guarded = fresh || _resolveBackoffUntil is { } until && now < until;
        IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> row;
        try
        {
            row = backend.ReadWatched();
        }
        catch (AdsFault f) when (!f.ConnectionLost)
        {
            if (f.AdsCode is { } c && AdsCodes.IsDeadHandle(c))
            {
                if (!guarded) { ResolveAgain(); return; }
                if (fresh) _resolveBackoffUntil = now + TimeSpan.FromMilliseconds(ResolveBackoffMs);
            }
            ReportOnce("read:" + f.Message, f.Message);
            return;
        }
        var dead = new SortedDictionary<int, uint>();
        for (var i = 0; i < row.Count; i++)
            if (row[i].AdsCode is { } c && AdsCodes.IsDeadHandle(c)) dead[i] = c;
        if ((dead.Count > 0 && !guarded) || backend.SymbolVersionChanged())
        {
            // The row belongs to the old resolution: drop it.
            ResolveAgain();
            return;
        }
        if (dead.Count > 0 && fresh) _resolveBackoffUntil = now + TimeSpan.FromMilliseconds(ResolveBackoffMs);
        if (!dead.SequenceEqual(_unreadable))
        {
            _unreadable.Clear();
            foreach (var (i, c) in dead) _unreadable[i] = c;
            Publish();
        }
        var v = new string?[row.Count];
        var e = new long?[row.Count];
        var anyEnum = false;
        for (var i = 0; i < row.Count; i++)
        {
            if (row[i].AdsCode is { } code)
            {
                if (dead.ContainsKey(i)) continue;
                var sym = i < _items.Count ? _items[i].Symbol : i.ToString();
                ReportOnce($"item:{sym}:{code}", $"{sym}: ADS error 0x{code:X}");
                continue;
            }
            v[i] = row[i].Value;
            e[i] = row[i].EnumValue;
            anyEnum |= e[i] is not null;
        }
        _pending.Add(new WatchRow(now.ToUnixTimeMilliseconds(), v, anyEnum ? e : null));
    }

    private void Flush(DateTimeOffset now)
    {
        _lastFlush = now;
        FlushPending();
    }

    private void FlushPending()
    {
        if (_pending.Count == 0) return;
        emit(WatchJson.Serialize(new WatchSamplesEvent("samples", _gen, _pending.ToArray())));
        _pending.Clear();
    }

    /// <summary>
    /// Resolves the watched symbols again; a changed result starts a new gen (rows of the old gen are flushed first).
    /// A failed resolve stays pending, so the next Tick tries again.
    /// </summary>
    private void ResolveAgain()
    {
        FlushPending();
        _needResolve = true;
        var items = backend.Resolve(_symbols);
        _needResolve = false;
        _freshResolve = true;
        if (!items.SequenceEqual(_resolvedItems))
        {
            _resolvedItems = items;
            _unreadable.Clear();
        }
        // Unreadable items keep their error until the next poll shows whether they read now.
        Publish();
    }

    /// <summary>Announces a new gen with an items event if the published items changed.</summary>
    private void Publish()
    {
        var items = _resolvedItems.Select((it, i) => _unreadable.TryGetValue(i, out var c)
            ? it with { Error = $"In the symbol table but not readable on the target (ADS error 0x{c:X} after a fresh symbol upload); retried every {ResolveBackoffMs / 1000} s" }
            : it).ToArray();
        if (items.SequenceEqual(_items)) return;
        FlushPending();
        _items = items;
        _gen++;
        emit(WatchJson.Serialize(new WatchItemsEvent("items", _gen, _items)));
    }

    private void TryConnect()
    {
        try
        {
            backend.Connect();
        }
        catch (Exception ex)
        {
            _connected = false;
            _retryAt = null;
            _retryPending = true;
            if (_reported.Add("connect:" + ex.Message))
                emit(WatchJson.Serialize(new WatchStateEvent("state", false, ex.Message)));
            return;
        }
        _connected = true;
        _retryAt = null;
        _reported.Clear();
        emit(WatchJson.Serialize(new WatchStateEvent("state", true, null)));
        try
        {
            if (_symbols.Count > 0 || _items.Count > 0) ResolveAgain();
        }
        catch (AdsFault f) when (f.ConnectionLost)
        {
            MarkLost(f.Message, null);
        }
        catch (Exception ex)
        {
            ReportOnce("tick:" + ex.Message, ex.Message);
        }
    }

    /// <summary>now == null: the caller has no clock reading after the failure, the retry delay starts with the next Tick.</summary>
    private void MarkLost(string message, DateTimeOffset? now)
    {
        FlushPending();
        if (!_connected) return;
        _connected = false;
        _retryAt = now is { } t ? t + TimeSpan.FromMilliseconds(RetryMs) : null;
        _retryPending = now is null;
        _reported.Clear();
        _reported.Add("connect:" + message);
        emit(WatchJson.Serialize(new WatchStateEvent("state", false, message)));
    }

    private void ReportOnce(string key, string message)
    {
        if (_reported.Add(key)) _log(message);
    }

    private object DoWatch(IReadOnlyList<string> symbols)
    {
        FlushPending();
        _symbols = symbols;
        _reported.RemoveWhere(k => k.StartsWith("item:", StringComparison.Ordinal));
        _unreadable.Clear();
        _freshResolve = false;
        _resolveBackoffUntil = null;
        IReadOnlyList<WatchItem> items;
        if (_connected)
        {
            try
            {
                items = backend.Resolve(symbols);
            }
            catch
            {
                // The extension keeps its gen after an error reply. Empty items make the next resolve differ,
                // so it announces a new gen with an items event before any samples of that gen.
                _items = _resolvedItems = [];
                _needResolve = true;
                throw;
            }
            _needResolve = false;
        }
        else
        {
            items = symbols.Select(s => new WatchItem(s, "", false, "Not connected")).ToArray();
            _needResolve = true;
        }
        _items = _resolvedItems = items;
        _gen++;
        return new WatchItemsData(_gen, _items);
    }

    private object DoRead(IReadOnlyList<string> symbols)
    {
        var result = new List<WatchReadItem>();
        foreach (var s in symbols)
        {
            try
            {
                var (type, value) = backend.ReadOnce(s);
                result.Add(new WatchReadItem(s, type, value, null));
            }
            catch (AdsFault f) when (!f.ConnectionLost)
            {
                result.Add(new WatchReadItem(s, null, null, f.Message));
            }
            catch (IECodeException ex)
            {
                result.Add(new WatchReadItem(s, null, null, ex.Message));
            }
        }
        return result;
    }

    private object DoWrite(string symbol, string value) => new WatchWriteData(symbol, backend.Write(symbol, value));

    private object DoInterval(JsonElement root)
    {
        if (!root.TryGetProperty("ms", out var ms) || !ms.TryGetInt32(out var n))
            throw new IECodeException(ExitCodes.Usage, "interval needs an integer 'ms'.");
        _intervalMs = Math.Clamp(n, MinIntervalMs, MaxIntervalMs);
        return new WatchIntervalData(_intervalMs);
    }

    private static string Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString()!
            : throw new IECodeException(ExitCodes.Usage, $"Missing string '{name}'.");

    private static IReadOnlyList<string> Symbols(JsonElement root)
    {
        if (!root.TryGetProperty("symbols", out var arr) || arr.ValueKind != JsonValueKind.Array)
            throw new IECodeException(ExitCodes.Usage, "Missing array 'symbols'.");
        if (arr.GetArrayLength() > MaxSymbols)
            throw new IECodeException(ExitCodes.Usage, $"At most {MaxSymbols} symbols are allowed.");
        return arr.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String
            ? e.GetString()!
            : throw new IECodeException(ExitCodes.Usage, "Symbols must be strings.")).ToArray();
    }
}
