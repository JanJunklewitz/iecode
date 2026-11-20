using System.Runtime.Versioning;
using TwinCAT;
using TwinCAT.Ads;
using TwinCAT.Ads.SumCommand;
using TwinCAT.Ads.TypeSystem;
using TwinCAT.TypeSystem;
using AdsNetId = TwinCAT.Ads.AmsNetId;

namespace IECode.Automation;

/// <summary>
/// The few calls <see cref="AdsWatchBackend"/> makes on the Beckhoff SDK, so the fault handling around them can be tested
/// with a fake that returns error codes and throws the SDK exceptions on demand.
/// </summary>
internal interface IAdsLink : IDisposable
{
    /// <summary>Opens the local router port only; whether the target answers is shown by <see cref="ReadState"/>.</summary>
    void Connect();
    AdsErrorCode ReadState();
    /// <summary>One byte of index group 0xF008; the data is shorter than one byte when the read fails.</summary>
    (AdsErrorCode Code, byte[] Data) ReadSymbolVersion();
    /// <summary>Uploads the symbol table of the PLC.</summary>
    ISymbolSet UploadSymbols();
    /// <summary>One sum read of all <paramref name="symbols"/> by instance path.</summary>
    ISymbolRead PrepareRead(IReadOnlyList<ILinkSymbol> symbols);
    /// <summary>One sum write of all <paramref name="symbols"/> by instance path, without a fallback to single writes.</summary>
    ISymbolWrite PrepareWrite(IReadOnlyList<ILinkSymbol> symbols);
}

internal interface ISymbolSet
{
    int Count { get; }
    /// <summary>Null when there is no such symbol; a value symbol otherwise (maybe a struct or array, see <see cref="ILinkSymbol.IsSingleValue"/>).</summary>
    ILinkSymbol? Find(string path);
    /// <summary>Every instance path down to depth 8 with its type; arrays, pointers and references are listed but not entered.</summary>
    IEnumerable<Core.Ads.OnlineSymbol> Enumerate();
}

internal interface ILinkSymbol
{
    string TypeName { get; }
    bool IsSingleValue { get; }
    /// <summary>The underlying primitive type name (enum and alias resolved); empty unless <see cref="IsSingleValue"/>.</summary>
    string BaseType { get; }
    IReadOnlyDictionary<long, string>? Members { get; }
    object? Read();
    /// <summary>The instance path of the symbol.</summary>
    string Path { get; }
    /// <summary>What a read does with it: a value, a container to enter, or something never entered (pointer, reference, interface).</summary>
    Core.Ads.NodeKind Kind { get; }
    /// <summary>The members of a structure or the elements of an array; empty for a value.</summary>
    IReadOnlyList<ILinkSymbol> Children { get; }
    /// <summary>Converts the text to the value to send; throws <see cref="Core.Ads.WriteNotSentException"/> when it does not fit the type.</summary>
    object Prepare(string text);
    void Write(string text);
}

internal interface ISymbolRead
{
    SumRead Read();
}

internal interface ISymbolWrite
{
    /// <summary>Sends the prepared values (index-aligned with the symbols) in one request.</summary>
    SumWrite Write(IReadOnlyList<object> values);
}

/// <summary><paramref name="Items"/> is null when the sum write as a whole failed.</summary>
internal sealed record SumWrite(AdsErrorCode Code, IReadOnlyList<AdsErrorCode>? Items);

/// <summary><paramref name="Items"/> is null when the sum read as a whole failed.</summary>
internal sealed record SumRead(AdsErrorCode Code, IReadOnlyList<SumItem>? Items);

internal readonly record struct SumItem(AdsErrorCode Code, object? Value);

[SupportedOSPlatform("windows")]
internal sealed class BeckhoffLink(Core.AmsNetId target, int port) : IAdsLink
{
    private readonly AdsClient _client = new();

    public void Connect() => _client.Connect(new AdsNetId(target.ToString()), port);

    public AdsErrorCode ReadState() => _client.TryReadState(out _);

    public (AdsErrorCode Code, byte[] Data) ReadSymbolVersion()
    {
        var result = _client.ReadAsResult(0xF008, 0, 1);
        return (result.ErrorCode, result.ErrorCode == AdsErrorCode.NoError ? result.Data.ToArray() : []);
    }

    public ISymbolSet UploadSymbols()
    {
        var loader = SymbolLoaderFactory.Create(_client, SymbolLoaderSettings.Default);
        // The table is uploaded on first access of Symbols.
        return new Set(loader.Symbols);
    }

    public ISymbolRead PrepareRead(IReadOnlyList<ILinkSymbol> symbols) =>
        new SumReader(new SumSymbolRead(_client, symbols.Select(s => (ISymbol)((Symbol)s).Value).ToList(), SumAccessMode.ValueByName, SumFallbackMode.All));

    public ISymbolWrite PrepareWrite(IReadOnlyList<ILinkSymbol> symbols) =>
        new SumWriter(new SumSymbolWrite(_client, symbols.Select(s => (ISymbol)((Symbol)s).Value).ToList(), SumFallbackMode.Sum));

    public void Dispose() => _client.Dispose();

    private sealed class Set(ISymbolCollection<ISymbol> symbols) : ISymbolSet
    {
        public int Count => symbols.Count;

        public ILinkSymbol? Find(string path) => AdsValues.FindSymbol(symbols, path) is IValueSymbol v ? new Symbol(v) : null;

        public IEnumerable<Core.Ads.OnlineSymbol> Enumerate() => Walk(symbols, 1);

        private static IEnumerable<Core.Ads.OnlineSymbol> Walk(IEnumerable<ISymbol> level, int depth)
        {
            foreach (var s in level)
            {
                yield return new Core.Ads.OnlineSymbol(s.InstancePath, s.DataType?.Name ?? "?", string.IsNullOrWhiteSpace(s.Comment) ? null : s.Comment);
                if (depth >= MaxEnumerateDepth || AdsValues.KindOf(s.DataType) != Core.Ads.NodeKind.Struct) continue;
                foreach (var sub in Walk(s.SubSymbols, depth + 1)) yield return sub;
            }
        }

        private const int MaxEnumerateDepth = 8;
    }

    private sealed class Symbol : ILinkSymbol
    {
        public Symbol(IValueSymbol value)
        {
            Value = value;
            IsSingleValue = AdsValues.IsSingleValue(value.DataType);
            if (IsSingleValue) (BaseType, Members) = AdsValues.Resolve(value.DataType);
        }

        public IValueSymbol Value { get; }
        public string TypeName => Value.DataType?.Name ?? "?";
        public bool IsSingleValue { get; }
        public string BaseType { get; } = "";
        public IReadOnlyDictionary<long, string>? Members { get; }
        public object? Read() => Value.ReadValue();
        public string Path => Value.InstancePath;

        public Core.Ads.NodeKind Kind => AdsValues.KindOf(Value.DataType);

        public IReadOnlyList<ILinkSymbol> Children => Kind is Core.Ads.NodeKind.Struct or Core.Ads.NodeKind.Array
            ? Value.SubSymbols.OfType<IValueSymbol>().Select(v => (ILinkSymbol)new Symbol(v)).ToList()
            : [];
        public object Prepare(string text)
        {
            try
            {
                return AdsValues.ParseForWrite(Value.DataType, text);
            }
            catch (Core.IECodeException e)
            {
                // Nothing was sent: the text does not fit the type.
                throw new Core.Ads.WriteNotSentException(e.Message, e);
            }
        }

        public void Write(string text) => Value.WriteValue(Prepare(text));
    }

    private sealed class SumWriter(SumSymbolWrite sum) : ISymbolWrite
    {
        public SumWrite Write(IReadOnlyList<object> values)
        {
            // WriteAsync reports the overall and the per-item codes as a result; the synchronous Write throws on any failure.
            var r = sum.WriteAsync(values.ToArray(), CancellationToken.None).GetAwaiter().GetResult();
            return new SumWrite(r.ErrorCode, r.Failed && r.SubErrors is null ? null : r.SubErrors?.ToList());
        }
    }

    private sealed class SumReader(SumSymbolRead sum) : ISymbolRead
    {
        public SumRead Read()
        {
            var r = sum.Read2();
            return r.Failed || r.ValueResults is null
                ? new SumRead(r.ErrorCode, null)
                : new SumRead(r.ErrorCode, r.ValueResults.Select(v => new SumItem(v.ErrorCode, v.Value)).ToList());
        }
    }
}
