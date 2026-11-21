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
    /// <summary>The sum write: the codes per item in input order; a scripted SumWrite can also fail as a whole.</summary>
    public Func<IReadOnlyList<object>, SumWrite> SumWriteFn = v => new SumWrite(AdsErrorCode.NoError, v.Select(_ => AdsErrorCode.NoError).ToList());
    public int Uploads, VersionReads, Disposed, SumWrites, SumReads;

    public void Connect() { }
    public AdsErrorCode ReadState() => State;
    /// <summary>The answer of <see cref="ReadStateInfo"/>; a failing code is returned as it is.</summary>
    public (AdsErrorCode Code, string AdsState, int DeviceState) StateInfo = (AdsErrorCode.NoError, "Run", 0);
    public (AdsErrorCode Code, string AdsState, int DeviceState) ReadStateInfo() => StateInfo;

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
    public ISymbolWrite PrepareWrite(IReadOnlyList<ILinkSymbol> symbols) => new Writer(this, symbols);
    public void Dispose() => Disposed++;

    private sealed class Reader(FakeLink link) : ISymbolRead
    {
        public SumRead Read()
        {
            link.SumReads++;
            return link.Sum();
        }
    }

    private sealed class Writer(FakeLink link, IReadOnlyList<ILinkSymbol> symbols) : ISymbolWrite
    {
        public SumWrite Write(IReadOnlyList<object> values)
        {
            link.SumWrites++;
            var r = link.SumWriteFn(values);
            // Like the PLC: an item without an error code lands in the symbol.
            if (r.Items is not null)
                for (var i = 0; i < values.Count && i < r.Items.Count; i++)
                    if (r.Items[i] == AdsErrorCode.NoError && symbols[i] is FakeSymbol s) { s.Value = values[i]; s.Written = values[i].ToString(); }
            return r;
        }
    }
}

internal sealed class FakeSet(params FakeSymbol[] symbols) : ISymbolSet
{
    public int Count => symbols.Length;

    public IEnumerable<OnlineSymbol> Enumerate() => symbols.Select(s => new OnlineSymbol(s.Name, s.TypeName, null));

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
    public string Path => name;
    public NodeKind Kind { get; init; } = single ? NodeKind.Leaf : NodeKind.Struct;
    public IReadOnlyList<ILinkSymbol> Children { get; init; } = [];
    public string TypeName => type;
    public bool IsSingleValue => single;
    public string BaseType => baseType;
    public IReadOnlyDictionary<long, string>? Members => members;
    public object? Read() => ReadThrow is { } e ? throw e : Value;

    /// <summary>Like the real link: a value that does not parse is not sent; a failing write call is not told apart.</summary>
    public object Prepare(string text) =>
        short.TryParse(text, out var parsed) ? parsed : throw new WriteNotSentException($"'{text}' is not a valid {TypeName}.");

    public void Write(string text)
    {
        var parsed = (short)Prepare(text);
        if (WriteThrow is { } e) throw e;
        Written = text;
        Value = parsed;
    }
}
