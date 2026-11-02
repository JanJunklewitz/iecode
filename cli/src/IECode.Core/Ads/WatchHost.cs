using System.Text.Json;

namespace IECode.Core.Ads;

/// <summary>
/// Protocol and recovery logic of the ADS watchlist. No threads, no clock: the loop calls <see cref="Tick"/>
/// with the current time, stdin lines go to <see cref="Handle"/>. All ADS access goes through <see cref="IWatchBackend"/>.
/// </summary>
public sealed class WatchHost(IWatchBackend backend, Action<string> emit, Action<string>? log = null)
{
    public const int Protocol = 1, MaxSymbols = 200;
    private const int FlushMs = 100, RetryMs = 2000, MinIntervalMs = 10, MaxIntervalMs = 5000;

    private readonly Action<string> _log = log ?? Console.Error.WriteLine;
    private readonly List<WatchRow> _pending = [];
    private readonly HashSet<string> _reported = [];
    private IReadOnlyList<string> _symbols = [];
    private IReadOnlyList<WatchItem> _items = [];
    private int _gen;
    private bool _connected, _needResolve;
    private DateTimeOffset? _lastFlush, _retryAt;
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

    private void Poll(DateTimeOffset now)
    {
        IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> row;
        try
        {
            row = backend.ReadWatched();
        }
        catch (AdsFault f) when (!f.ConnectionLost)
        {
            if (f.AdsCode is { } c && AdsCodes.IsDeadHandle(c)) ResolveAgain();
            else ReportOnce("read:" + f.Message, f.Message);
            return;
        }
        if (row.Any(r => r.AdsCode is { } c && AdsCodes.IsDeadHandle(c)) || backend.SymbolVersionChanged())
        {
            // The row belongs to the old resolution: drop it.
            ResolveAgain();
            return;
        }
        var v = new string?[row.Count];
        var e = new long?[row.Count];
        var anyEnum = false;
        for (var i = 0; i < row.Count; i++)
        {
            if (row[i].AdsCode is { } code)
            {
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

    /// <summary>Resolves the watched symbols again; a changed result starts a new gen (rows of the old gen are flushed first).</summary>
    private void ResolveAgain()
    {
        FlushPending();
        _needResolve = false;
        var items = backend.Resolve(_symbols);
        if (!items.SequenceEqual(_items))
        {
            _items = items;
            _gen++;
            emit(WatchJson.Serialize(new WatchItemsEvent("items", _gen, _items)));
        }
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
        _gen++;
        if (_connected)
        {
            _items = backend.Resolve(symbols);
            _needResolve = false;
        }
        else
        {
            _items = symbols.Select(s => new WatchItem(s, "", false, "Not connected")).ToArray();
            _needResolve = true;
        }
        _reported.RemoveWhere(k => k.StartsWith("item:", StringComparison.Ordinal));
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
