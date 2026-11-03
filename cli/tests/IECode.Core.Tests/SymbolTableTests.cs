using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class SymbolTableTests
{
    [Fact]
    public void EmptyTable_WithRequestedSymbols_MeansUnreachable()
    {
        // The SDK loader returns an empty table instead of throwing when the target does not answer.
        Assert.True(SymbolTable.MeansUnreachable(requested: 3, tableCount: 0));
        Assert.False(SymbolTable.MeansUnreachable(requested: 3, tableCount: 120));
        Assert.False(SymbolTable.MeansUnreachable(requested: 0, tableCount: 0));
    }
}
