using IECode.Core.Ads;
using TwinCAT.Ads;

namespace IECode.Automation.Tests;

/// <summary>A scripted ADS link: every call can return a code or throw, and the calls are counted.</summary>
internal sealed class FakeLink : IAdsLink
{
    public AdsErrorCode State = AdsErrorCode.NoError;
    /// <summary>Version byte answers, one per call; the last one repeats.</summary>
    public Queue<(AdsErrorCode Code, byte[] Data)> Versions = new([(AdsErrorCode.NoError, [1])]);
    public Func<ISymbolSet> Upload = () => new FakeSet();
    public Func<SumRead> Sum = () => new SumRead(AdsErrorCode.NoError, []);
    public int Uploads, VersionReads, Disposed;

    public void Connect() { }
    public AdsErrorCode ReadState() => State;

    public (AdsErrorCode Code, byte[] Data) ReadSymbolVersion()
    {
        VersionReads++;
        return Versions.Count > 1 ? Versions.Dequeue() : Versions.Peek();
    }

    public ISymbolSet UploadSymbols()
    {
        Uploads++;
        return Upload();
    }

    public ISymbolRead PrepareRead(IReadOnlyList<ILinkSymbol> symbols) => new Reader(this);
    public void Dispose() => Disposed++;

    private sealed class Reader(FakeLink link) : ISymbolRead
    {
        public SumRead Read() => link.Sum();
    }
}

internal sealed class FakeSet(params FakeSymbol[] symbols) : ISymbolSet
{
    public int Count => symbols.Length;

    public ILinkSymbol? Find(string path)
    {
        var s = symbols.FirstOrDefault(x => x.Name == path);
        return s?.Throw is { } e ? throw e : s;
    }
}

internal sealed class FakeSymbol(string name, string type, string baseType, IReadOnlyDictionary<long, string>? members = null, bool single = true) : ILinkSymbol
{
    public string Name => name;
    public Exception? Throw;
    /// <summary>Makes Read fail, e.g. the read-back after a write.</summary>
    public Exception? ReadThrow;
    /// <summary>Makes the ADS write call itself fail (the value was parsed, whether it reached the PLC is unknown).</summary>
    public Exception? WriteThrow;
    public object? Value;
    public string? Written;
    public string TypeName => type;
    public bool IsSingleValue => single;
    public string BaseType => baseType;
    public IReadOnlyDictionary<long, string>? Members => members;
    public object? Read() => ReadThrow is { } e ? throw e : Value;

    /// <summary>Like the real link: a value that does not parse is not sent; a failing write call is not told apart.</summary>
    public void Write(string text)
    {
        if (!short.TryParse(text, out var parsed)) throw new WriteNotSentException($"'{text}' is not a valid {TypeName}.");
        if (WriteThrow is { } e) throw e;
        Written = text;
        Value = parsed;
    }
}
