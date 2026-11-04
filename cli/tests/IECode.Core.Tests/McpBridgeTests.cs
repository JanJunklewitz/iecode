using System.Text.Json;
using IECode.Core.Mcp;

namespace IECode.Core.Tests;

public sealed class McpBridgeTests : IAsyncDisposable
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(5);
    private const string Cwd = "c:\\work\\plant";

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "iecode-bridge-" + Guid.NewGuid().ToString("N"));
    private readonly string _instances;
    private readonly string _tools;
    private readonly Dictionary<string, Func<Probe>> _windows = new();
    private readonly Dictionary<string, TaskCompletionSource<LinkEnd>> _ext = new();
    private readonly LinkEnd _claude;
    private readonly LinkEnd _bridgeSide;
    private readonly List<string> _log = [];
    private readonly CancellationTokenSource _cts = new();
    private Task _run = Task.CompletedTask;

    public McpBridgeTests()
    {
        _instances = Path.Combine(_dir, "instances");
        _tools = Path.Combine(_dir, "tools.json");
        Directory.CreateDirectory(_instances);
        (_claude, _bridgeSide) = LinkEnd.Pair();
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _claude.Dispose();
        try { await _run.WaitAsync(Wait); } catch (Exception) { }
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    // ---- harness ----

    private void Start(TimeSpan? search = null, int maxReply = Wire.MaxFrame)
    {
        var bridge = new McpBridge(Cwd, _instances, _tools, Connect, _bridgeSide, _bridgeSide, s => { lock (_log) _log.Add(s); }, search ?? TimeSpan.FromSeconds(30), maxReply);
        _run = Task.Run(() => bridge.RunAsync(_cts.Token));
    }

    private Probe Connect(InstanceInfo inst) => _windows[inst.Id]();

    private void AddInstance(string id, string workspace = "plant", string root = "c:\\work\\plant", int min = 1, int max = 1)
    {
        var json = JsonSerializer.Serialize(new
        {
            format = 1, id, pid = 1, startedAt = "2026-11-04T00:00:00Z", extensionVersion = "0.2.6",
            bridgeProtocol = new { min, max }, pipe = "iecode-mcp-" + id, roots = new[] { root },
            workspaceName = workspace, rootsRevision = 1, secret = "AAAA",
        });
        File.WriteAllText(Path.Combine(_instances, id + ".json"), json);
    }

    /// <summary>The window answers: a link whose extension end the test plays.</summary>
    private void WindowUp(string id)
    {
        var tcs = new TaskCompletionSource<LinkEnd>();
        _ext[id] = tcs;
        _windows[id] = () => { var (a, b) = LinkEnd.Pair(); tcs.TrySetResult(b); return new Probe.Ok(a); };
    }

    private void WindowGone(string id) => _windows[id] = () => new Probe.Absent();
    private void WindowSilent(string id) => _windows[id] = () => new Probe.Silent();

    private Task<LinkEnd> Ext(string id) => _ext[id].Task.WaitAsync(Wait);

    private Task Send(object message) => _claude.WriteLineAsync(JsonSerializer.Serialize(message));
    private Task SendRaw(string line) => _claude.WriteLineAsync(line);

    private async Task<JsonElement> Read(LinkEnd end)
    {
        var line = await end.ReadLineAsync().WaitAsync(Wait) ?? throw new InvalidOperationException("EOF");
        return JsonDocument.Parse(line).RootElement.Clone();
    }

    private Task<JsonElement> FromBridge() => Read(_claude);

    private static string ToolText(JsonElement reply) => reply.GetProperty("result").GetProperty("content")[0].GetProperty("text").GetString()!;
    private static object Call(object id, string name = "ads_read", object? args = null) =>
        new { jsonrpc = "2.0", id, method = "tools/call", @params = new { name, arguments = args ?? new { } } };
    private static string ResultLine(object id, string text) =>
        JsonSerializer.Serialize(new { jsonrpc = "2.0", id, result = new { content = new[] { new { type = "text", text } }, isError = false } });
    private static object List(object id) => new { jsonrpc = "2.0", id, method = "tools/list" };

    private async Task NoLineWithin(LinkEnd end, int ms = 300)
    {
        var read = end.ReadLineAsync();
        var done = await Task.WhenAny(read, Task.Delay(ms));
        Assert.NotSame(read, done);
    }

    // ---- tests ----

    [Fact]
    public async Task Initialize_IsAnsweredWithoutAWindow()
    {
        Start();
        await Send(new { jsonrpc = "2.0", id = 0, method = "initialize", @params = new { protocolVersion = "2025-11-25", capabilities = new { } } });
        var r = await FromBridge();
        Assert.Equal("2025-11-25", r.GetProperty("result").GetProperty("protocolVersion").GetString());
        Assert.True(r.GetProperty("result").GetProperty("capabilities").GetProperty("tools").GetProperty("listChanged").GetBoolean());
        Assert.Equal("iecode", r.GetProperty("result").GetProperty("serverInfo").GetProperty("name").GetString());
        // an unknown version falls back to the newest known one
        await Send(new { jsonrpc = "2.0", id = 1, method = "initialize", @params = new { protocolVersion = "1999-01-01" } });
        Assert.Equal(McpBridge.SupportedProtocolVersions[0], (await FromBridge()).GetProperty("result").GetProperty("protocolVersion").GetString());
    }

    [Fact]
    public async Task Ping_AndServerDiscover_AreAnsweredLocally()
    {
        Start();
        await Send(new { jsonrpc = "2.0", id = "p", method = "ping" });
        var ping = await FromBridge();
        Assert.Equal("p", ping.GetProperty("id").GetString());
        await Send(new { jsonrpc = "2.0", id = "server-discover-probe-1", method = "server/discover" });
        Assert.Equal(-32601, (await FromBridge()).GetProperty("error").GetProperty("code").GetInt32());
        await Send(new { jsonrpc = "2.0", method = "notifications/initialized" });
        await NoLineWithin(_claude);
    }

    [Fact]
    public async Task ToolsList_ForwardsToTheWindow()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(List(1));
        var ext = await Ext("a");
        var forwarded = await Read(ext);
        Assert.Equal("tools/list", forwarded.GetProperty("method").GetString());
        await ext.WriteLineAsync("""{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"ads_read"}]}}""");
        var reply = await FromBridge();
        Assert.Equal("ads_read", reply.GetProperty("result").GetProperty("tools")[0].GetProperty("name").GetString());
    }

    [Fact]
    public async Task ToolsList_FallsBackToToolsJsonWithoutAWindow()
    {
        File.WriteAllText(_tools, """{"tools":[{"name":"ads_scope","description":"d","inputSchema":{}}]}""");
        Start();
        await Send(List(1));
        Assert.Equal("ads_scope", (await FromBridge()).GetProperty("result").GetProperty("tools")[0].GetProperty("name").GetString());
    }

    [Fact]
    public async Task ToolsList_FromAPrettyPrintedToolsJson_IsOneLine()
    {
        // the extension writes tools.json indented; the reply must still be a single MCP line
        File.WriteAllText(_tools, """
            {
              "tools": [
                {
                  "name": "ads_scope",
                  "inputSchema": { "type": "object" }
                }
              ]
            }
            """);
        Start();
        await Send(List(1));
        var r = await FromBridge();
        Assert.Equal("ads_scope", r.GetProperty("result").GetProperty("tools")[0].GetProperty("name").GetString());
    }

    [Fact]
    public async Task ToolsList_IsEmptyWithoutAWindowAndWithoutToolsJson()
    {
        Start();
        await Send(List(1));
        Assert.Equal(0, (await FromBridge()).GetProperty("result").GetProperty("tools").GetArrayLength());
    }

    [Fact]
    public async Task NoWindow_GivesAToolErrorNamingTheFolder()
    {
        Start();
        await Send(Call(7));
        var r = await FromBridge();
        Assert.True(r.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Contains(Cwd, ToolText(r));
        Assert.Contains("open the folder in VS Code", ToolText(r));
    }

    [Fact]
    public async Task AWindowThatAppearsLater_IsFound()
    {
        Start();
        await Send(Call(1));
        Assert.True((await FromBridge()).GetProperty("result").GetProperty("isError").GetBoolean());
        AddInstance("a"); WindowUp("a");
        await Send(Call(2));
        var ext = await Ext("a");
        Assert.Equal(2, (await Read(ext)).GetProperty("id").GetInt32());
        await ext.WriteLineAsync("""{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}""");
        Assert.Equal("ok", ToolText(await FromBridge()));
    }

    [Fact]
    public async Task Conflict_GivesAToolErrorNamingBothWorkspaces()
    {
        AddInstance("a", "plant-east"); AddInstance("b", "plant-west"); WindowUp("a"); WindowUp("b");
        Start();
        await Send(Call(1));
        var text = ToolText(await FromBridge());
        Assert.Contains("plant-east", text);
        Assert.Contains("plant-west", text);
        Assert.Contains("both serve", text);
    }

    [Fact]
    public async Task VersionMismatch_NamesTheSideToUpdate()
    {
        AddInstance("new", min: 2, max: 3);
        Start();
        await Send(Call(1));
        Assert.Contains("Update the iecode CLI", ToolText(await FromBridge()));
        File.Delete(Path.Combine(_instances, "new.json"));
        AddInstance("old", min: 0, max: 0);
        await Send(Call(2));
        Assert.Contains("Update the IECode extension", ToolText(await FromBridge()));
    }

    [Fact]
    public async Task Cancel_IsForwardedWhileACallIsOpen_AfterItsCallOnTheSameLink()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(Call(5));
        var ext = await Ext("a");
        Assert.Equal("tools/call", (await Read(ext)).GetProperty("method").GetString());
        await Send(new { jsonrpc = "2.0", method = "notifications/cancelled", @params = new { requestId = 5 } });
        var cancel = await Read(ext);
        Assert.Equal("notifications/cancelled", cancel.GetProperty("method").GetString());
        Assert.Equal(5, cancel.GetProperty("params").GetProperty("requestId").GetInt32());
    }

    [Fact]
    public async Task LostConnectionDuringACall_IsReportedAndNotReplayed()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(Call(5));
        var ext = await Ext("a");
        await Read(ext);
        ext.Dispose(); // the window dies with the call open
        var text = ToolText(await FromBridge());
        Assert.Contains("may or may not have run", text);
        // the next call goes to a fresh connection; the old call is never re-sent
        WindowUp("a");
        await Send(Call(6));
        var fresh = await Ext("a");
        var line = await Read(fresh);
        Assert.Equal(6, line.GetProperty("id").GetInt32());
        await NoLineWithin(fresh);
    }

    [Fact]
    public async Task AReply_GoesToTheCallWithTheSameId()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(Call(1));
        await Send(Call("two"));
        var ext = await Ext("a");
        await Read(ext); await Read(ext);
        await ext.WriteLineAsync("""{"jsonrpc":"2.0","id":"two","result":{"content":[{"type":"text","text":"second"}],"isError":false}}""");
        var first = await FromBridge();
        Assert.Equal("two", first.GetProperty("id").GetString());
        await ext.WriteLineAsync("""{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"first"}],"isError":false}}""");
        Assert.Equal("first", ToolText(await FromBridge()));
    }

    [Fact]
    public async Task AWindowFoundAfterAListWithoutAWindow_SendsListChanged()
    {
        Start(search: TimeSpan.FromMilliseconds(50));
        await Send(List(1));
        Assert.Equal(0, (await FromBridge()).GetProperty("result").GetProperty("tools").GetArrayLength());
        AddInstance("a"); WindowUp("a");
        var note = await FromBridge();
        Assert.Equal("notifications/tools/list_changed", note.GetProperty("method").GetString());
        await NoLineWithin(_claude, 400); // announced once
    }

    [Fact]
    public async Task ASecondWindowWithTheSameFolder_TurnsTheNextCallIntoAConflict()
    {
        AddInstance("a", "plant-east"); WindowUp("a");
        Start();
        await Send(Call(1));
        var ext = await Ext("a");
        await Read(ext);
        await ext.WriteLineAsync("""{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}""");
        await FromBridge();
        AddInstance("b", "plant-west"); WindowUp("b");
        await Send(Call(2));
        var text = ToolText(await FromBridge());
        Assert.Contains("plant-east", text);
        Assert.Contains("plant-west", text);
    }

    [Fact]
    public async Task ALongerRootThatAppearsLater_WinsAtTheNextCall()
    {
        AddInstance("outer", "work", "c:\\work"); WindowUp("outer");
        Start();
        await Send(Call(1));
        var outer = await Ext("outer");
        await Read(outer);
        await outer.WriteLineAsync("""{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}""");
        await FromBridge();
        AddInstance("inner", "plant", "c:\\work\\plant"); WindowUp("inner");
        await Send(Call(2));
        var inner = await Ext("inner");
        Assert.Equal(2, (await Read(inner)).GetProperty("id").GetInt32());
        await NoLineWithin(outer);
    }

    [Fact]
    public async Task ASecondWindowTurnsTheNextCallIntoAConflict_WhileAnotherCallIsStillOpen()
    {
        AddInstance("a", "plant-east"); WindowUp("a");
        Start();
        await Send(Call(1)); // stays open
        var ext = await Ext("a");
        await Read(ext);
        AddInstance("b", "plant-west"); WindowUp("b");
        await Send(Call(2));
        var text = ToolText(await FromBridge());
        Assert.Contains("both serve", text);
        await NoLineWithin(ext); // the open call's window did not get call 2
    }

    [Fact]
    public async Task AnUnsureWindow_GivesAToolErrorAndNothingIsSent()
    {
        AddInstance("a"); WindowSilent("a");
        Start();
        await Send(Call(1));
        var text = ToolText(await FromBridge());
        Assert.Contains("did not answer in time", text);
        Assert.Contains("Nothing was sent", text);
    }

    [Fact]
    public async Task CancelDuringSelection_DropsTheCall()
    {
        AddInstance("a");
        var release = new ManualResetEventSlim();
        var (a, b) = LinkEnd.Pair();
        _windows["a"] = () => { release.Wait(Wait); return new Probe.Ok(a); };
        Start();
        await Send(Call(5));
        await Send(new { jsonrpc = "2.0", method = "notifications/cancelled", @params = new { requestId = 5 } });
        await Task.Delay(100, TestContext.Current.CancellationToken);
        release.Set();
        await NoLineWithin(_claude, 500); // no reply for a cancelled call
        await NoLineWithin(b, 300);       // and nothing reached the link
    }

    [Fact]
    public async Task ACancelForAnUnknownId_IsDropped()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(new { jsonrpc = "2.0", method = "notifications/cancelled", @params = new { requestId = 99 } });
        await Send(new { jsonrpc = "2.0", method = "notifications/cancelled", @params = new { } });
        await Send(new { jsonrpc = "2.0", id = "alive", method = "ping" });
        Assert.Equal("alive", (await FromBridge()).GetProperty("id").GetString());
        Assert.False(_ext["a"].Task.IsCompleted); // not even a window was contacted
    }

    [Fact]
    public async Task ToolsCallWithoutAnId_Gets32600AndIsNotForwarded()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(new { jsonrpc = "2.0", method = "tools/call", @params = new { name = "ads_read" } });
        Assert.Equal(-32600, (await FromBridge()).GetProperty("error").GetProperty("code").GetInt32());
        Assert.False(_ext["a"].Task.IsCompleted);
    }

    [Fact]
    public async Task ADuplicateOpenId_Gets32600AndIsNotForwarded()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        await Send(Call(5));
        var ext = await Ext("a");
        await Read(ext);
        await Send(Call(5));
        Assert.Equal(-32600, (await FromBridge()).GetProperty("error").GetProperty("code").GetInt32());
        await NoLineWithin(ext);
    }

    [Fact]
    public async Task AnOversizedReply_BecomesAToolError()
    {
        AddInstance("a"); WindowUp("a");
        Start(maxReply: 400);
        await Send(Call(1));
        var ext = await Ext("a");
        await Read(ext);
        await ext.WriteLineAsync(ResultLine(1, "ä" + new string('x', 600)));
        var r = await FromBridge();
        Assert.True(r.GetProperty("result").GetProperty("isError").GetBoolean());
        Assert.Equal("The result is too large to send. Ask for less.", ToolText(r));
    }

    [Fact]
    public async Task MoreThan32OpenCalls_GetAToolError_ButACancelStillPasses()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        for (var i = 1; i <= 32; i++) await Send(Call(i));
        var ext = await Ext("a");
        for (var i = 1; i <= 32; i++) await Read(ext);
        await Send(Call(33));
        Assert.Equal("Too many calls are running at once.", ToolText(await FromBridge()));
        await Send(new { jsonrpc = "2.0", method = "notifications/cancelled", @params = new { requestId = 1 } });
        Assert.Equal("notifications/cancelled", (await Read(ext)).GetProperty("method").GetString());
    }

    [Fact]
    public async Task ConcurrentReplies_NeverInterleaveOnStdout()
    {
        AddInstance("a"); WindowUp("a");
        Start();
        const int n = 20;
        for (var i = 1; i <= n; i++) await Send(Call(i));
        var ext = await Ext("a");
        for (var i = 1; i <= n; i++) await Read(ext);
        var big = new string('y', 50_000);
        await Task.WhenAll(Enumerable.Range(1, n).Select(i => Task.Run(() =>
            ext.WriteLineAsync(ResultLine(i, big)))));
        var seen = new HashSet<int>();
        for (var i = 0; i < n; i++)
        {
            var r = await FromBridge(); // every line parses on its own
            Assert.Equal(big, ToolText(r));
            seen.Add(r.GetProperty("id").GetInt32());
        }
        Assert.Equal(n, seen.Count);
    }

    [Fact]
    public async Task Stdout_CarriesOnlyMcpLines()
    {
        // a failing connect and a log call must not leak onto stdout
        AddInstance("a");
        _windows["a"] = () => throw new InvalidOperationException("boom");
        Start();
        await Send(Call(1));
        await Send(new { jsonrpc = "2.0", id = 2, method = "ping" });
        await SendRaw("this is not json");
        var lines = new List<JsonElement> { await FromBridge(), await FromBridge() };
        Assert.All(lines, l => Assert.Equal("2.0", l.GetProperty("jsonrpc").GetString()));
    }

    [Fact]
    public async Task ExitsWhenStdinCloses()
    {
        Start();
        _claude.Dispose();
        await _run.WaitAsync(Wait, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task ASilentWindowThatAnswersLater_IsNotMistakenForGone()
    {
        AddInstance("a"); WindowSilent("a");
        Start();
        await Send(Call(1));
        Assert.Contains("did not answer", ToolText(await FromBridge()));
        WindowUp("a"); // silence is never cached
        await Send(Call(2));
        var ext = await Ext("a");
        Assert.Equal(2, (await Read(ext)).GetProperty("id").GetInt32());
    }
}
