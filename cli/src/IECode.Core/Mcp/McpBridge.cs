using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace IECode.Core.Mcp;

/// <summary>
/// The stdio MCP server Claude Code starts (<c>iecode mcp</c>): it answers the session basics itself and relays <c>tools/list</c>,
/// <c>tools/call</c> and cancels to the VS Code window that serves its working directory. It knows no ADS and no write rules.
/// Stdout carries only MCP lines; everything else goes to <c>log</c> (stderr). It exits when stdin closes and never before: Claude
/// Code does not restart a dead server.
/// </summary>
public sealed class McpBridge
{
    /// <summary>Protocol versions seen from Claude Code's <c>initialize</c> (spike); the newest is the fallback.</summary>
    public static readonly string[] SupportedProtocolVersions = ["2025-11-25"];

    private const int MaxOpenCalls = 32;
    private const string TooLarge = "The result is too large to send. Ask for less.";
    private const string NotSent = "The connection to the IECode window was closed before the call was sent. Nothing was sent; retry.";
    private const string LostConnection = "The connection to IECode was lost during the call, so it may or may not have run. Read the state before acting; for a write, read the variable and ask the user.";
    private static readonly TimeSpan AbsentCache = TimeSpan.FromSeconds(5);

    private readonly string _cwd;
    private readonly string _instancesDir;
    private readonly string _toolsFile;
    private readonly Func<InstanceInfo, Probe> _connect;
    private readonly Stream _stdin;
    private readonly Stream _stdout;
    private readonly Action<string> _log;
    private readonly TimeSpan _searchInterval;
    private readonly int _maxReply;

    private readonly object _gate = new();
    private readonly Dictionary<string, Link> _links = new();
    private readonly Dictionary<string, long> _absentUntil = new();
    private readonly ConcurrentDictionary<string, object> _connectLocks = new();
    private readonly ConcurrentDictionary<string, CallState> _calls = new();
    private readonly ConcurrentDictionary<string, Pending> _pending = new();
    private readonly SemaphoreSlim _outLock = new(1, 1);
    private volatile bool _listedWithoutWindow;

    /// <param name="searchInterval">How often a window is searched for after a tool list was answered without one (default 5 s).</param>
    /// <param name="maxReply">Longest line written to stdout in bytes; a longer reply becomes a tool error (default <see cref="Wire.MaxFrame"/>).</param>
    public McpBridge(string cwd, string instancesDir, string toolsFile, Func<InstanceInfo, Probe> connect,
        Stream stdin, Stream stdout, Action<string> log, TimeSpan? searchInterval = null, int maxReply = Wire.MaxFrame)
    {
        _cwd = cwd;
        _instancesDir = instancesDir;
        _toolsFile = toolsFile;
        _connect = connect;
        _stdin = stdin;
        _stdout = stdout;
        _log = log;
        _searchInterval = searchInterval ?? TimeSpan.FromSeconds(5);
        _maxReply = maxReply;
    }

    /// <summary>Returns when stdin closes.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var search = SearchLoop(linked.Token);
        var framer = new LineFramer(Wire.MaxFrame, discardOversized: true);
        var buf = new byte[8192];
        try
        {
            while (true)
            {
                var n = await _stdin.ReadAsync(buf, linked.Token).ConfigureAwait(false);
                if (n == 0) break;
                var lines = framer.Push(buf.AsSpan(0, n));
                // Claude Code never restarts a dead server: a line over the limit is answered and dropped, the session goes on
                for (var dropped = framer.TakeOversized(); dropped > 0; dropped--)
                {
                    _log("mcp: a line from the client is over the frame limit; dropped");
                    Reply(RpcError("null", -32600, "A line was longer than the frame limit and was dropped"));
                }
                foreach (var line in lines)
                {
                    if (line.Length == 0) continue;
                    try { Dispatch(line); }
                    catch (JsonException) { Reply(RpcError("null", -32700, "Parse error")); }
                    catch (Exception e) { _log($"mcp: could not handle a line: {e.Message}"); }
                }
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            linked.Cancel();
            List<Link> links;
            lock (_gate) { links = [.. _links.Values]; _links.Clear(); }
            foreach (var l in links) l.Close();
        }
        await search.ConfigureAwait(false);
    }

    // ---- dispatch (runs on the reader loop, in order: request state exists before the first await) ----

    private void Dispatch(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("method", out var m) || m.ValueKind != JsonValueKind.String) return;
        var method = m.GetString()!;
        var hasId = TryId(root, "id", out var key, out var raw);
        var @params = root.TryGetProperty("params", out var p) ? p : default;

        switch (method)
        {
            case "initialize" when hasId:
                Reply(Result(raw, InitializeResult(@params)));
                break;
            case "ping" when hasId:
                Reply(Result(raw, "{}"));
                break;
            case "tools/list" when hasId:
                _ = Track(ListAsync(key, raw, line));
                break;
            case "tools/call":
                Call(hasId, key, raw, line);
                break;
            case "notifications/cancelled":
                Cancel(@params, line);
                break;
            default:
                if (hasId) Reply(RpcError(raw, -32601, $"Method not found: {method}"));
                break;
        }
    }

    private static string InitializeResult(JsonElement p)
    {
        var asked = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("protocolVersion", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var version = asked is not null && SupportedProtocolVersions.Contains(asked) ? asked : SupportedProtocolVersions[0];
        var server = typeof(McpBridge).Assembly.GetName().Version?.ToString(3) ?? "0";
        return JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["protocolVersion"] = version,
            ["capabilities"] = new Dictionary<string, object> { ["tools"] = new Dictionary<string, object> { ["listChanged"] = true } },
            ["serverInfo"] = new Dictionary<string, object> { ["name"] = "iecode", ["version"] = server },
        });
    }

    private void Call(bool hasId, string key, string raw, string line)
    {
        if (!hasId)
        {
            Reply(RpcError("null", -32600, "tools/call needs an id"));
            return;
        }
        var state = new CallState(key, raw);
        if (_calls.ContainsKey(key))
        {
            Reply(RpcError(raw, -32600, "A call with this id is already running"));
            return;
        }
        if (_calls.Count >= MaxOpenCalls)
        {
            Reply(ToolError(raw, "Too many calls are running at once."));
            return;
        }
        if (!_calls.TryAdd(key, state))
        {
            Reply(RpcError(raw, -32600, "A call with this id is already running"));
            return;
        }
        _ = Track(CallAsync(state, line));
    }

    private void Cancel(JsonElement p, string line)
    {
        if (p.ValueKind != JsonValueKind.Object || !TryId(p, "requestId", out var key, out _)) return;
        if (!_calls.TryGetValue(key, out var state)) return; // unknown id: dropped
        lock (state.Lock)
        {
            state.Cancelled = true;
            // with a link the cancel goes after the call line on that same link (one ordered outbox); without one the call is never sent
            state.Link?.Enqueue(line);
        }
    }

    // ---- tools/list ----

    private async Task ListAsync(string key, string raw, string line)
    {
        Selection selection;
        try { selection = await ChooseAsync().ConfigureAwait(false); }
        catch (Exception e)
        {
            _log($"mcp: window selection failed: {e.Message}");
            selection = new Selection.None();
        }
        if (selection is Selection.Chosen c && TryLink(c.Instance.Id) is { } link)
        {
            _pending[key] = new Pending(link, false, raw);
            if (link.Enqueue(line)) return;
            if (!_pending.TryRemove(key, out _)) return; // the link-lost handler already answered
        }
        _listedWithoutWindow = true;
        Reply(Result(raw, ToolsFromFile()));
    }

    private string ToolsFromFile()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(_toolsFile));
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("tools", out var t) && t.ValueKind == JsonValueKind.Array)
                return "{\"tools\":" + JsonSerializer.Serialize(t) + "}"; // compact: the file is indented, a reply must be one line
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { }
        return "{\"tools\":[]}";
    }

    // ---- tools/call ----

    private async Task CallAsync(CallState state, string line)
    {
        try
        {
            var selection = await ChooseAsync().ConfigureAwait(false);
            string? error = null;
            Link? link = null;
            switch (selection)
            {
                case Selection.Chosen c:
                    link = TryLink(c.Instance.Id);
                    if (link is null) error = NotSent;
                    break;
                case Selection.None:
                    error = $"No VS Code window with IECode is open for {_cwd}. Ask the user to open the folder in VS Code.";
                    break;
                case Selection.Conflict x:
                    error = $"{string.Join(" and ", x.Instances.Select(i => "workspace " + Name(i)))} both serve {_cwd}. Ask the user to close one of them.";
                    break;
                case Selection.Unsure:
                    error = $"The IECode window for {_cwd} did not answer in time (a paused debugger can cause this). Nothing was sent. Ask the user to resume it, then retry.";
                    break;
                case Selection.VersionMismatch v:
                    error = v.Instance.ProtocolMin > Wire.Protocol
                        ? $"The IECode extension in the window for {_cwd} is newer than this CLI (bridge protocol {v.Instance.ProtocolMin}-{v.Instance.ProtocolMax}, the CLI speaks {Wire.Protocol}). Update the iecode CLI."
                        : $"The IECode extension in the window for {_cwd} is older than this CLI (bridge protocol {v.Instance.ProtocolMin}-{v.Instance.ProtocolMax}, the CLI speaks {Wire.Protocol}). Update the IECode extension.";
                    break;
            }

            lock (state.Lock)
            {
                if (state.Cancelled)
                {
                    _calls.TryRemove(state.Key, out _); // cancelled before it was sent: dropped, no reply (as in MCP)
                    return;
                }
                if (error is null)
                {
                    _pending[state.Key] = new Pending(link!, true, state.Raw);
                    state.Link = link;
                    if (link!.Enqueue(line)) return;
                    if (!_pending.TryRemove(state.Key, out _)) return; // the link-lost handler already answered
                    state.Link = null;
                    error = NotSent;
                }
            }
            _calls.TryRemove(state.Key, out _);
            Reply(ToolError(state.Raw, error));
        }
        catch (Exception e)
        {
            _log($"mcp: call failed: {e.Message}");
            if (_calls.TryRemove(state.Key, out _)) Reply(ToolError(state.Raw, "The IECode bridge failed before the call was sent. Nothing was sent; retry."));
        }
    }

    /// <summary>Two windows on one folder usually share the workspace name, so the id tells them apart.</summary>
    private static string Name(InstanceInfo i) => (string.IsNullOrEmpty(i.WorkspaceName) ? "window" : i.WorkspaceName) + " [" + i.Id[..Math.Min(8, i.Id.Length)] + "]";

    // ---- window selection and links ----

    private Task<Selection> ChooseAsync() => Task.Run(() => Selection.Choose(_cwd, Instances.Load(_instancesDir), ConnectShared));

    private Link? TryLink(string id)
    {
        lock (_gate) return _links.TryGetValue(id, out var l) && !l.Closed ? l : null;
    }

    /// <summary>
    /// The probe the selection sees. A window we already hold a link to counts as live; a fresh authenticated link is kept for later
    /// calls (the selection gets a marker stream it may dispose); "gone" is remembered for 5 s, "silent" never.
    /// </summary>
    private Probe ConnectShared(InstanceInfo inst)
    {
        // one connect per window at a time: a second call that needs the same window waits and then finds the link of the first
        lock (_connectLocks.GetOrAdd(inst.Id, _ => new object()))
        {
            lock (_gate)
            {
                if (_links.TryGetValue(inst.Id, out var existing) && !existing.Closed) return new Probe.Ok(new MemoryStream());
                if (_absentUntil.TryGetValue(inst.Id, out var until) && until > Environment.TickCount64) return new Probe.Absent();
            }
            var probe = _connect(inst);
            switch (probe)
            {
                case Probe.Ok ok:
                    Link fresh;
                    lock (_gate) _links[inst.Id] = fresh = new Link(this, inst, ok.Link);
                    fresh.Start();
                    return new Probe.Ok(new MemoryStream());
                case Probe.Absent:
                    lock (_gate) _absentUntil[inst.Id] = Environment.TickCount64 + (long)AbsentCache.TotalMilliseconds;
                    return probe;
                default:
                    return probe;
            }
        }
    }

    private async Task SearchLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(_searchInterval, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
            if (!_listedWithoutWindow) continue;
            try
            {
                if (await ChooseAsync().ConfigureAwait(false) is Selection.Chosen && _listedWithoutWindow)
                {
                    _listedWithoutWindow = false;
                    Reply("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}");
                }
            }
            catch (Exception e) { _log($"mcp: window search failed: {e.Message}"); }
        }
    }

    // ---- traffic from a window ----

    private void OnLinkLine(Link link, string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.TryGetProperty("method", out _) || !TryId(root, "id", out var key, out _)) return;
            if (!_pending.TryGetValue(key, out var pending) || pending.Link != link) return; // not ours, or from the wrong window
            _pending.TryRemove(key, out _);
            if (pending.IsCall) _calls.TryRemove(key, out _);
            Reply(line, pending.Raw, pending.IsCall);
        }
        catch (JsonException) { _log("mcp: a window sent a line that is not JSON; ignored"); }
    }

    private void OnLinkLost(Link link)
    {
        lock (_gate)
        {
            if (_links.TryGetValue(link.Instance.Id, out var l) && l == link) _links.Remove(link.Instance.Id);
        }
        foreach (var (key, pending) in _pending.ToArray())
        {
            if (pending.Link != link || !_pending.TryRemove(key, out _)) continue;
            if (pending.IsCall)
            {
                _calls.TryRemove(key, out _);
                Reply(ToolError(pending.Raw, LostConnection));
            }
            else
            {
                _listedWithoutWindow = true;
                Reply(Result(pending.Raw, ToolsFromFile()));
            }
        }
    }

    // ---- output: one serialized writer, only MCP lines ----

    private static bool TryId(JsonElement obj, string name, out string key, out string raw)
    {
        key = raw = "";
        if (!obj.TryGetProperty(name, out var id)) return false;
        switch (id.ValueKind)
        {
            case JsonValueKind.String: key = "s:" + id.GetString(); raw = id.GetRawText(); return true;
            case JsonValueKind.Number: key = "n:" + id.GetRawText(); raw = id.GetRawText(); return true;
            default: return false;
        }
    }

    private static string Result(string rawId, string resultJson) => $"{{\"jsonrpc\":\"2.0\",\"id\":{rawId},\"result\":{resultJson}}}";
    private static string RpcError(string rawId, int code, string message) => $"{{\"jsonrpc\":\"2.0\",\"id\":{rawId},\"error\":{{\"code\":{code},\"message\":{JsonSerializer.Serialize(message)}}}}}";
    private static string ToolError(string rawId, string text) =>
        Result(rawId, $"{{\"content\":[{{\"type\":\"text\",\"text\":{JsonSerializer.Serialize(text)}}}],\"isError\":true}}");

    /// <summary>A reply for a call or list that is too long becomes a tool error (a call) or an error (a list).</summary>
    private void Reply(string line, string? rawId = null, bool isCall = false)
    {
        if (Encoding.UTF8.GetByteCount(line) > _maxReply)
        {
            line = rawId is null ? RpcError("null", -32603, TooLarge)
                : isCall ? ToolError(rawId, TooLarge) : RpcError(rawId, -32603, TooLarge);
        }
        _ = Track(WriteLineAsync(line));
    }

    private async Task WriteLineAsync(string line)
    {
        await _outLock.WaitAsync().ConfigureAwait(false);
        try
        {
            await _stdout.WriteAsync(Encoding.UTF8.GetBytes(line + "\n")).ConfigureAwait(false);
            await _stdout.FlushAsync().ConfigureAwait(false);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException) { _log("mcp: stdout is closed"); }
        finally { _outLock.Release(); }
    }

    /// <summary>Background work never throws into the void: a failure is logged.</summary>
    private Task Track(Task t) => t.ContinueWith(x => _log($"mcp: background task failed: {x.Exception?.GetBaseException().Message}"), TaskContinuationOptions.OnlyOnFaulted);

    // ---- state ----

    private sealed class CallState(string key, string raw)
    {
        public string Key { get; } = key;
        public string Raw { get; } = raw;
        public object Lock { get; } = new();
        public bool Cancelled;
        public Link? Link;
    }

    private sealed record Pending(Link Link, bool IsCall, string Raw);

    /// <summary>One authenticated connection to a window: an ordered outbox, so a cancel can never overtake its call.</summary>
    private sealed class Link(McpBridge owner, InstanceInfo instance, Stream stream)
    {
        private readonly Channel<string> _outbox = Channel.CreateUnbounded<string>(new UnboundedChannelOptions { SingleReader = true });
        private int _closed;

        public InstanceInfo Instance { get; } = instance;
        public bool Closed => Volatile.Read(ref _closed) != 0;

        public bool Enqueue(string line) => !Closed && _outbox.Writer.TryWrite(line);

        public void Start()
        {
            _ = Task.Run(ReadLoop);
            _ = Task.Run(WriteLoop);
        }

        public void Close()
        {
            if (Interlocked.Exchange(ref _closed, 1) != 0) return;
            _outbox.Writer.TryComplete();
            try { stream.Dispose(); } catch (Exception) { }
        }

        private async Task ReadLoop()
        {
            var framer = new LineFramer();
            var buf = new byte[8192];
            try
            {
                while (true)
                {
                    var n = await stream.ReadAsync(buf).ConfigureAwait(false);
                    if (n == 0) break;
                    foreach (var line in framer.Push(buf.AsSpan(0, n))) owner.OnLinkLine(this, line);
                }
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException or FrameTooLongException) { }
            Lost();
        }

        private async Task WriteLoop()
        {
            try
            {
                await foreach (var line in _outbox.Reader.ReadAllAsync().ConfigureAwait(false))
                {
                    await stream.WriteAsync(Encoding.UTF8.GetBytes(line + "\n")).ConfigureAwait(false);
                    await stream.FlushAsync().ConfigureAwait(false);
                }
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException) { Lost(); }
        }

        private void Lost()
        {
            Close();
            owner.OnLinkLost(this); // also for a link closed by us: the calls that were open on it still need their answer
        }
    }
}
