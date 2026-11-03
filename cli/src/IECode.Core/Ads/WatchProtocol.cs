using System.Text.Json;
using System.Text.Json.Serialization;

namespace IECode.Core.Ads;

public sealed record WatchItem(string Symbol, string Type, bool Numeric, string? Error);

public sealed class AdsFault(string message, uint? adsCode, bool connectionLost) : Exception(message)
{
    public uint? AdsCode { get; } = adsCode;
    public bool ConnectionLost { get; } = connectionLost;
}

public interface IWatchBackend : IDisposable
{
    /// <summary>Throws AdsFault(connectionLost: true) when the target cannot be reached.</summary>
    void Connect();
    /// <summary>Per-item errors go into WatchItem.Error; never throws for one bad name.</summary>
    IReadOnlyList<WatchItem> Resolve(IReadOnlyList<string> symbols);
    /// <summary>Per item, index-aligned with the last Resolve; EnumValue only for enum items. Throws AdsFault only for connection loss.</summary>
    IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> ReadWatched();
    /// <summary>Cheap read of the symbol version, called every tick before rows are published.</summary>
    bool SymbolVersionChanged();
    (string Type, string Value) ReadOnce(string symbol);
    /// <summary>Returns the value read back.</summary>
    string Write(string symbol, string text);
}

internal sealed record WatchReply(
    JsonElement? Id,
    bool Ok,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] object? Data,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] uint? AdsCode);

internal sealed record WatchHelloEvent(string Event, int Protocol);
internal sealed record WatchStateEvent(string Event, bool Connected,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error);
internal sealed record WatchItemsEvent(string Event, int Gen, IReadOnlyList<WatchItem> Items);
internal sealed record WatchSamplesEvent(string Event, int Gen, IReadOnlyList<WatchRow> Rows);
internal sealed record WatchRow(long T, IReadOnlyList<string?> V,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<long?>? E);
internal sealed record WatchItemsData(int Gen, IReadOnlyList<WatchItem> Items);
internal sealed record WatchReadItem(string Symbol, string? Type, string? Value, string? Error);
internal sealed record WatchWriteData(string Symbol, string Value);
internal sealed record WatchIntervalData(int Ms);

internal static class WatchJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
