namespace IECode.Core.Ads;

/// <summary>Checks on an uploaded PLC symbol table. Pure, so it is unit-tested without a runtime.</summary>
public static class SymbolTable
{
    /// <summary>
    /// The SDK symbol loader does not throw for an unreachable target: after its timeout it returns an empty table.
    /// A running PLC always has symbols, so an empty table while symbols were asked for means the connection is gone.
    /// </summary>
    public static bool MeansUnreachable(int requested, int tableCount) => requested > 0 && tableCount == 0;
}
