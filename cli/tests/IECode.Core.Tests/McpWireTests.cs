using System.Text;
using System.Text.Json;
using IECode.Core.Mcp;

namespace IECode.Core.Tests;

public sealed class McpWireTests
{
    [Fact]
    public void Proof_MatchesTheGoldenFixture()
    {
        var g = McpTestData.LoadGolden();
        Assert.Equal(g.BridgeProof, Wire.Proof(g.Secret, "bridge", g.ExtNonce, g.BridgeNonce));
        Assert.Equal(g.ExtProof, Wire.Proof(g.Secret, "ext", g.ExtNonce, g.BridgeNonce));
    }

    [Fact]
    public void ProofMatches_RejectsDifferentLengths()
    {
        Assert.True(Wire.ProofMatches("abc", "abc"));
        Assert.False(Wire.ProofMatches("abc", "abcd"));
        Assert.False(Wire.ProofMatches("abc", ""));
        Assert.False(Wire.ProofMatches("abc", null));
    }

    [Fact]
    public void Framer_SplitsLinesAcrossChunks()
    {
        var f = new LineFramer();
        Assert.Equal(["{\"a\":1}"], f.Push("{\"a\":1}\n{\"b\""u8));
        Assert.Equal(["{\"b\":2}", ""], f.Push(":2}\r\n\n"u8));
        Assert.Empty(f.Push("tail"u8));
    }

    [Fact]
    public void Framer_DecodesUtf8SplitAcrossChunks()
    {
        var bytes = Encoding.UTF8.GetBytes("ä€\n");
        var f = new LineFramer();
        Assert.Empty(f.Push(bytes.AsSpan(0, 1)));
        Assert.Empty(f.Push(bytes.AsSpan(1, 3)));
        Assert.Equal(["ä€"], f.Push(bytes.AsSpan(4)));
    }

    [Fact]
    public void Framer_ThrowsOnALineOverTheLimit()
    {
        Assert.Throws<FrameTooLongException>(() => new LineFramer(10).Push(new string('x', 11).Select(c => (byte)c).ToArray()));
        Assert.Throws<FrameTooLongException>(() => new LineFramer(10).Push(Encoding.UTF8.GetBytes(new string('x', 11) + "\n")));
        Assert.Equal([new string('x', 10)], new LineFramer(10).Push(Encoding.UTF8.GetBytes(new string('x', 10) + "\n")));
        Assert.Throws<FrameTooLongException>(() => new LineFramer(10).Push(Encoding.UTF8.GetBytes(new string('ä', 6))));
    }

    // ---- handshake: a fake extension on the other end of an in-memory link ----

    private static readonly InstanceInfo Info = McpTestData.Instance("a1", ["c:\\work"], secret: Convert.ToBase64String(new byte[32]));

    /// <summary>Plays the extension: hello, then checks the bridge proof, then answers with <paramref name="extProof"/> (or the right one).</summary>
    private static async Task<bool> PlayExtension(LinkEnd ext, string? answerProof = null, bool closeAfterHello = false)
    {
        var extNonce = Wire.RandomNonce();
        await ext.WriteLineAsync(JsonSerializer.Serialize(new { hello = "iecode-ext", nonce = extNonce }));
        if (closeAfterHello) { ext.Dispose(); return false; }
        var line = await ext.ReadLineAsync();
        using var doc = JsonDocument.Parse(line!);
        var bridgeNonce = doc.RootElement.GetProperty("nonce").GetString()!;
        var bridgeOk = Wire.ProofMatches(Wire.Proof(Info.Secret, "bridge", extNonce, bridgeNonce), doc.RootElement.GetProperty("proof").GetString());
        var proof = answerProof ?? Wire.Proof(Info.Secret, "ext", extNonce, bridgeNonce);
        await ext.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, proof }));
        return bridgeOk;
    }

    [Fact]
    public async Task Handshake_AcceptsAPeerThatKnowsTheSecret()
    {
        var (bridge, ext) = LinkEnd.Pair();
        var peer = PlayExtension(ext);
        Assert.True(await Task.Run(() => BridgeHandshake.Run(bridge, Info, TimeSpan.FromSeconds(5))));
        Assert.True(await peer); // the bridge's own proof was right too
    }

    [Fact]
    public async Task Handshake_RejectsAWrongExtensionProof()
    {
        var (bridge, ext) = LinkEnd.Pair();
        var peer = PlayExtension(ext, answerProof: Wire.Proof(Info.Secret, "bridge", "x", "y"));
        Assert.False(await Task.Run(() => BridgeHandshake.Run(bridge, Info, TimeSpan.FromSeconds(5))));
        await peer;
    }

    [Fact]
    public async Task Handshake_TimesOutOnASilentPeer()
    {
        var (bridge, _) = LinkEnd.Pair(); // a debugger-paused extension host: connected, never answers
        var sw = System.Diagnostics.Stopwatch.StartNew();
        Assert.False(await Task.Run(() => BridgeHandshake.Run(bridge, Info, TimeSpan.FromMilliseconds(200))));
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task Handshake_RejectsAPeerThatClosesEarly()
    {
        var (bridge, ext) = LinkEnd.Pair();
        var peer = PlayExtension(ext, closeAfterHello: true);
        Assert.False(await Task.Run(() => BridgeHandshake.Run(bridge, Info, TimeSpan.FromSeconds(5))));
        await peer;
    }

    [Fact]
    public async Task Handshake_RejectsAMalformedHello()
    {
        var (bridge, ext) = LinkEnd.Pair();
        await ext.WriteLineAsync("not json");
        Assert.False(await Task.Run(() => BridgeHandshake.Run(bridge, Info, TimeSpan.FromSeconds(5))));
    }
}
