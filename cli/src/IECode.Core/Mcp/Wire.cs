using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace IECode.Core.Mcp;

/// <summary>Wire contract between the bridge (this side) and the extension: framing and the mutual HMAC handshake.</summary>
public static class Wire
{
    public const int Protocol = 1;
    public const int MaxFrame = 1_048_576;

    /// <summary>base64(HMAC-SHA256(secret bytes, "role|extNonce|bridgeNonce")).</summary>
    public static string Proof(string secret, string role, string extNonce, string bridgeNonce)
    {
        using var hmac = new HMACSHA256(Convert.FromBase64String(secret));
        return Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{role}|{extNonce}|{bridgeNonce}")));
    }

    /// <summary>Constant time; a different length is a mismatch.</summary>
    public static bool ProofMatches(string expected, string? given)
    {
        if (given is null) return false;
        var a = Encoding.UTF8.GetBytes(expected);
        var b = Encoding.UTF8.GetBytes(given);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    public static string RandomNonce() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
}

public sealed class FrameTooLongException : Exception
{
    public FrameTooLongException() : base("a frame is longer than the limit") { }
}

/// <summary>Splits a byte stream into newline-delimited UTF-8 lines; a partial line (and a multibyte character) survives chunk borders.</summary>
public sealed class LineFramer
{
    private readonly int _max;
    private byte[] _buf = new byte[256];
    private int _len;

    public LineFramer(int max = Wire.MaxFrame) => _max = max;

    public IReadOnlyList<string> Push(ReadOnlySpan<byte> chunk)
    {
        if (_len + chunk.Length > _buf.Length) Array.Resize(ref _buf, Math.Max(_buf.Length * 2, _len + chunk.Length));
        chunk.CopyTo(_buf.AsSpan(_len));
        _len += chunk.Length;

        var lines = new List<string>();
        var start = 0;
        for (; ; )
        {
            var nl = Array.IndexOf(_buf, (byte)'\n', start, _len - start);
            if (nl < 0) break;
            var end = nl;
            if (end - start > _max) throw new FrameTooLongException();
            if (end > start && _buf[end - 1] == '\r') end--;
            lines.Add(Encoding.UTF8.GetString(_buf, start, end - start));
            start = nl + 1;
        }
        if (start > 0)
        {
            Buffer.BlockCopy(_buf, start, _buf, 0, _len - start);
            _len -= start;
        }
        if (_len > _max) throw new FrameTooLongException();
        return lines;
    }
}

/// <summary>Steps 1 to 3 of the wire contract from the bridge side.</summary>
public static class BridgeHandshake
{
    /// <summary>True when the extension proved it knows the secret; false on a wrong proof, a malformed line, a close or silence longer than <paramref name="timeout"/>. The caller owns the stream.</summary>
    public static bool Run(Stream link, InstanceInfo info, TimeSpan timeout)
    {
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            return RunAsync(link, info, cts.Token).GetAwaiter().GetResult();
        }
        catch (Exception e) when (e is OperationCanceledException or IOException or ObjectDisposedException or FrameTooLongException or JsonException or InvalidOperationException or FormatException)
        {
            return false;
        }
    }

    private static async Task<bool> RunAsync(Stream link, InstanceInfo info, CancellationToken ct)
    {
        var framer = new LineFramer();
        var pending = new Queue<string>();

        async Task<string?> NextLine()
        {
            var buf = new byte[4096];
            while (pending.Count == 0)
            {
                var n = await link.ReadAsync(buf, ct).ConfigureAwait(false);
                if (n == 0) return null;
                foreach (var l in framer.Push(buf.AsSpan(0, n))) pending.Enqueue(l);
            }
            return pending.Dequeue();
        }

        var first = await NextLine().ConfigureAwait(false);
        if (first is null) return false;
        using var hello = JsonDocument.Parse(first);
        if (hello.RootElement.ValueKind != JsonValueKind.Object
            || !hello.RootElement.TryGetProperty("hello", out var h) || h.GetString() != "iecode-ext"
            || !hello.RootElement.TryGetProperty("nonce", out var n1) || n1.ValueKind != JsonValueKind.String) return false;
        var extNonce = n1.GetString()!;

        var bridgeNonce = Wire.RandomNonce();
        var reply = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["hello"] = "iecode-bridge",
            ["protocol"] = Wire.Protocol,
            ["nonce"] = bridgeNonce,
            ["proof"] = Wire.Proof(info.Secret, "bridge", extNonce, bridgeNonce),
        });
        await link.WriteAsync(Encoding.UTF8.GetBytes(reply + "\n"), ct).ConfigureAwait(false);
        await link.FlushAsync(ct).ConfigureAwait(false);

        var last = await NextLine().ConfigureAwait(false);
        if (last is null) return false;
        using var ok = JsonDocument.Parse(last);
        if (ok.RootElement.ValueKind != JsonValueKind.Object
            || !ok.RootElement.TryGetProperty("ok", out var okValue) || okValue.ValueKind != JsonValueKind.True
            || !ok.RootElement.TryGetProperty("proof", out var p) || p.ValueKind != JsonValueKind.String) return false;
        return Wire.ProofMatches(Wire.Proof(info.Secret, "ext", extNonce, bridgeNonce), p.GetString());
    }
}
