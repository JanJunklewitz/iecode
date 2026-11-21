using System.Text.Json;
using System.Text.Json.Serialization;

namespace IECode.Core.Ads;

public sealed record WatchItem(string Symbol, string Type, bool Numeric, string? Error);

public sealed class AdsFault(string message, uint? adsCode, bool connectionLost) : Exception(message)
{
    public uint? AdsCode { get; } = adsCode;
    public bool ConnectionLost { get; } = connectionLost;
}

/// <summary>
/// A write that failed before the ADS write request left: unknown or non-single-value symbol, or a value text that does not
/// parse for the type. Only this exception lets the host say "written: no"; a failing ADS write call stays an <see cref="AdsFault"/>
/// because a timeout does not prove the value never reached the PLC.
/// </summary>
public sealed class WriteNotSentException(string message, Exception? inner = null) : Exception(message, inner);

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
    /// <summary>True when the last successful <see cref="Resolve"/> saw another symbol version than the one before it, also across a reconnect.</summary>
    bool ResolveChangedVersion => false;
    (string Type, string Value) ReadOnce(string symbol);
    /// <summary>
    /// Writes and reads back. Value is the value read back; when only the read-back failed (the write went through),
    /// Value is null and ReadBackError tells why. Throws <see cref="WriteNotSentException"/> for every failure known to
    /// happen before the write request leaves.
    /// </summary>
    (string? Value, string? ReadBackError) Write(string symbol, string text);
    /// <summary>
    /// Prepares every value first (any failure: <see cref="WriteNotSentException"/> naming "writes[i] symbol: ...", nothing sent), then
    /// sends one sum write and reads the written items back with one sum read. A failure of the whole request after sending is an
    /// <see cref="AdsFault"/>: the outcome is unknown for every item.
    /// </summary>
    IReadOnlyList<WriteManyItem> WriteMany(IReadOnlyList<(string Symbol, string Value)> writes);
    /// <summary>
    /// The value leaves of a structure, function block instance or array in one sum read, to <paramref name="depth"/> levels.
    /// Null when the symbol is a single value or this backend cannot expand (the host then falls back to <see cref="ReadOnce"/>).
    /// </summary>
    StructRead? ReadMembers(string symbol, int depth) => null;
    /// <summary>
    /// The run state of the PLC and of the TwinCAT system plus the counters of one task. Never throws for an unreadable PLC part
    /// when the system state was read (the part becomes <see cref="PlcState.PlcError"/>); throws the PLC fault when neither part answered.
    /// </summary>
    PlcState ReadPlcState(int task) => throw new NotSupportedException("This backend cannot read the PLC state.");
}

/// <summary>
/// PLC run state, task counters and TwinCAT system state. <c>PlcAdsCode</c> and <c>PlcConnectionLost</c> describe the PLC fault when
/// <c>PlcError</c> is set; the loss flag is not on the wire, it makes the host reconnect.
/// </summary>
public sealed record PlcState(string? AdsState, int? DeviceState, long? CycleCount, long? CycleTimeUs, long? OnlineChangeCount,
    string? TaskNote, string? SystemState, string? PlcError, uint? PlcAdsCode = null, bool PlcConnectionLost = false);

internal sealed record WatchStateData(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? AdsState,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? DeviceState,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PlcError,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] uint? PlcAdsCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? CycleCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? CycleTimeUs,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? OnlineChangeCount,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TaskNote,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? SystemState);

/// <summary>One leaf of a structure read; <c>Name</c> is the full instance path.</summary>
public sealed record MemberValue(string Name, string Type, string? Value, string? Error);

public sealed record StructRead(string Type, IReadOnlyList<MemberValue> Members, int OmittedMembers, int OmittedElements, IReadOnlyList<string> NotExpanded);

public static class WriteStatus
{
    public const string Written = "written", NotWritten = "notWritten", Unknown = "unknown";
}

/// <summary>One item of a batch write. <c>Value</c> is the value read back; only the read-back may be missing on a written item.</summary>
public sealed record WriteManyItem(string Symbol, string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Value = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ReadBackError = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] uint? AdsCode = null);

internal sealed record WatchReply(
    JsonElement? Id,
    bool Ok,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] object? Data,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] uint? AdsCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Written = null);

internal sealed record WatchHelloEvent(string Event, int Protocol,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Target = null);
internal sealed record WatchStateEvent(string Event, bool Connected,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error);
internal sealed record WatchReloadedEvent(string Event, string Reason);
internal sealed record WatchItemsEvent(string Event, int Gen, IReadOnlyList<WatchItem> Items);
internal sealed record WatchSamplesEvent(string Event, int Gen, IReadOnlyList<WatchRow> Rows);
internal sealed record WatchRow(long T, IReadOnlyList<string?> V,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<long?>? E);
internal sealed record WatchItemsData(int Gen, IReadOnlyList<WatchItem> Items);
internal sealed record WatchReadNotes(int OmittedMembers, int OmittedElements, IReadOnlyList<string> NotExpanded);
internal sealed record WatchReadItem(string Symbol, string? Type, string? Value, string? Error,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<MemberValue>? Members = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] WatchReadNotes? Notes = null);
internal sealed record WatchWriteData(string Symbol, string? Value,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ReadBackError = null);
internal sealed record WatchIntervalData(int Ms);
internal sealed record WatchWriteManyData(IReadOnlyList<WriteManyItem> Items);

internal static class WatchJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
}
