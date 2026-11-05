using System.Text;
using System.Threading.Channels;
using IECode.Core.Mcp;

namespace IECode.Core.Tests;

/// <summary>One end of an in-memory duplex link: what one end writes the other reads; disposing an end gives the peer EOF.</summary>
internal sealed class LinkEnd : Stream
{
    private readonly Channel<byte[]> _in;
    private readonly Channel<byte[]> _out;
    private byte[] _rest = [];
    private int _restPos;

    private LinkEnd(Channel<byte[]> inbound, Channel<byte[]> outbound) { _in = inbound; _out = outbound; }

    public static (LinkEnd A, LinkEnd B) Pair()
    {
        var ab = Channel.CreateUnbounded<byte[]>();
        var ba = Channel.CreateUnbounded<byte[]>();
        return (new LinkEnd(ba, ab), new LinkEnd(ab, ba));
    }

    public bool Disposed { get; private set; }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override void Write(byte[] buffer, int offset, int count) => _out.Writer.TryWrite(buffer.AsSpan(offset, count).ToArray());

    public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (Disposed) throw new ObjectDisposedException(nameof(LinkEnd));
        _out.Writer.TryWrite(buffer.ToArray());
        return ValueTask.CompletedTask;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (Disposed) throw new ObjectDisposedException(nameof(LinkEnd));
        while (_restPos >= _rest.Length)
        {
            if (!await _in.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false)) return 0;
            if (_in.Reader.TryRead(out var next)) { _rest = next; _restPos = 0; }
        }
        var n = Math.Min(buffer.Length, _rest.Length - _restPos);
        _rest.AsMemory(_restPos, n).CopyTo(buffer);
        _restPos += n;
        return n;
    }

    protected override void Dispose(bool disposing)
    {
        Disposed = true;
        _out.Writer.TryComplete();
        base.Dispose(disposing);
    }

    /// <summary>Test helper: the next line the peer wrote, or null on EOF.</summary>
    public async Task<string?> ReadLineAsync(CancellationToken ct = default)
    {
        var sb = new List<byte>();
        var one = new byte[1];
        while (true)
        {
            if (await ReadAsync(one, ct) == 0) return sb.Count == 0 ? null : Encoding.UTF8.GetString([.. sb]);
            if (one[0] == '\n') return Encoding.UTF8.GetString([.. sb]);
            sb.Add(one[0]);
        }
    }

    public Task WriteLineAsync(string line) => WriteAsync(Encoding.UTF8.GetBytes(line + "\n")).AsTask();
}

internal static class McpTestData
{
    /// <summary>The golden fixture both languages read: testdata/mcp-wire.json at the repository root.</summary>
    public sealed record Golden(string Secret, string ExtNonce, string BridgeNonce, string BridgeProof, string ExtProof);

    public static Golden LoadGolden()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "testdata", "mcp-wire.json"))) dir = dir.Parent;
        if (dir is null) throw new FileNotFoundException("testdata/mcp-wire.json not found above " + AppContext.BaseDirectory);
        using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(dir.FullName, "testdata", "mcp-wire.json")));
        var r = doc.RootElement;
        return new Golden(r.GetProperty("secret").GetString()!, r.GetProperty("extNonce").GetString()!, r.GetProperty("bridgeNonce").GetString()!,
            r.GetProperty("bridgeProof").GetString()!, r.GetProperty("extProof").GetString()!);
    }

    public static InstanceInfo Instance(string id, string[] roots, string secret = "AAAA", string workspace = "ws", int min = 1, int max = 1)
        => new(id, 1, "0.2.6", min, max, $"iecode-mcp-{id}", roots, workspace, secret);
}
