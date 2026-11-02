namespace IECode.Core.Ads;

/// <summary>Outcome of reading the 1-byte symbol version (index group 0xF008).</summary>
public enum SymbolVersionRead
{
    Value,
    ConnectionLost,
    /// <summary>0x710/0x711 on the version read itself: seen at the start of a download, the symbol table is being replaced.</summary>
    Changing,
    /// <summary>Any other answer: the target does not provide a version; downloads are noticed by read errors only.</summary>
    Unreadable,
}

/// <summary>Decisions around the PLC symbol version. Pure, so it is unit-tested without a runtime.</summary>
public static class SymbolVersion
{
    public static SymbolVersionRead Classify(uint adsCode, int bytesRead) => adsCode switch
    {
        0 => bytesRead == 1 ? SymbolVersionRead.Value : SymbolVersionRead.Unreadable,
        _ when AdsCodes.IsConnectionLost(adsCode) => SymbolVersionRead.ConnectionLost,
        _ when AdsCodes.IsDeadHandle(adsCode) => SymbolVersionRead.Changing,
        _ => SymbolVersionRead.Unreadable,
    };

    /// <summary>
    /// Whether the watched symbols must be resolved again. <paramref name="baseline"/> is the version of the last
    /// successful resolve (null: it could not be read then). A version that becomes readable later is not adopted
    /// silently: the symbols may have changed in between, so it takes one resolve, which then stores it.
    /// </summary>
    public static bool NeedsResolve(byte? baseline, byte? current) => current is { } c && baseline != c;
}
