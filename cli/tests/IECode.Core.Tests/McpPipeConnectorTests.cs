using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using IECode.Core.Mcp;

namespace IECode.Core.Tests;

public sealed class McpPipeConnectorTests
{
    private static readonly TimeSpan Connect = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan Handshake = TimeSpan.FromMilliseconds(600);
    private static readonly string Secret = Convert.ToBase64String(new byte[32]);

    private static InstanceInfo Instance(string pipe) => new("a1", 1, "0.2.6", 1, 1, pipe, ["c:\\work"], "ws", Secret);
    private static string NewName() => "iecode-test-" + Guid.NewGuid().ToString("N");

    /// <summary>A pipe server that plays the extension: hello, check the bridge proof, answer with <paramref name="secret"/>'s proof; or stay silent.</summary>
    private static (NamedPipeServerStream Server, Task Done) Serve(string name, string? secret, CancellationToken ct)
    {
        var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var done = Task.Run(async () =>
        {
            try
            {
                await server.WaitForConnectionAsync(ct);
                if (secret is null) { await Task.Delay(3000, ct); return; }
                var extNonce = Wire.RandomNonce();
                await server.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { hello = "iecode-ext", nonce = extNonce }) + "\n"), ct);
                var buf = new byte[4096];
                var n = await server.ReadAsync(buf, ct);
                using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(buf, 0, n));
                var bridgeNonce = doc.RootElement.GetProperty("nonce").GetString()!;
                var proof = Wire.Proof(secret, "ext", extNonce, bridgeNonce);
                await server.WriteAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { ok = true, proof }) + "\n"), ct);
                await Task.Delay(500, ct);
            }
            catch (Exception e) when (e is OperationCanceledException or IOException or ObjectDisposedException) { }
        }, ct);
        return (server, done);
    }

    [Fact(Skip = "Windows only", SkipUnless = nameof(WindowsOnly.IsWindows), SkipType = typeof(WindowsOnly))]
    public void APipeThatDoesNotExist_IsAbsent()
    {
        Assert.IsType<Probe.Absent>(PipeConnector.Connect(Instance(NewName()), Connect, Handshake));
    }

    [Fact(Skip = "Windows only", SkipUnless = nameof(WindowsOnly.IsWindows), SkipType = typeof(WindowsOnly))]
    public void PipeExists_DoesNotConnect()
    {
        var name = NewName();
        Assert.False(PipeConnector.PipeExists(name));
        using var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        Assert.True(PipeConnector.PipeExists(name));
        // the single server instance was not used up by the existence check: a client can still connect
        using var client = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        client.Connect(1000);
    }

    [Fact]
    public async Task AWindowThatKnowsTheSecret_IsOk()
    {
        var name = NewName();
        var (server, done) = Serve(name, Secret, TestContext.Current.CancellationToken);
        using (server)
        {
            var probe = PipeConnector.Connect(Instance(name), Connect, Handshake);
            var ok = Assert.IsType<Probe.Ok>(probe);
            ok.Link.Dispose();
        }
        await done;
    }

    [Fact]
    public async Task AWindowWithAnotherSecret_IsSilent_NotAbsent()
    {
        var name = NewName();
        var (server, done) = Serve(name, Convert.ToBase64String(Enumerable.Repeat((byte)7, 32).ToArray()), TestContext.Current.CancellationToken);
        using (server)
        {
            Assert.IsType<Probe.Silent>(PipeConnector.Connect(Instance(name), Connect, Handshake));
        }
        await done;
    }

    [Fact]
    public async Task AWindowThatNeverAnswers_IsSilent_NotAbsent()
    {
        var name = NewName();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var (server, done) = Serve(name, null, cts.Token);
        using (server)
        {
            Assert.IsType<Probe.Silent>(PipeConnector.Connect(Instance(name), Connect, Handshake));
            cts.Cancel();
        }
        await done;
    }

    [Fact]
    public async Task AWindowThatIsBusy_IsSilent_NotAbsent()
    {
        // all server instances taken (a paused window): the pipe exists, the connect times out
        var name = NewName();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var (server, done) = Serve(name, null, cts.Token);
        using (server)
        {
            using var first = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            first.Connect(1000);
            Assert.IsType<Probe.Silent>(PipeConnector.Connect(Instance(name), Connect, Handshake));
            cts.Cancel();
        }
        await done;
    }
}
