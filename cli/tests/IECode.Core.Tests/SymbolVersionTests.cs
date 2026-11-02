using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class SymbolVersionTests
{
    [Fact]
    public void Classify_VersionRead()
    {
        Assert.Equal(SymbolVersionRead.Value, SymbolVersion.Classify(0, 1));
        Assert.Equal(SymbolVersionRead.Unreadable, SymbolVersion.Classify(0, 0));
        Assert.Equal(SymbolVersionRead.ConnectionLost, SymbolVersion.Classify(0x745, 0));
        Assert.Equal(SymbolVersionRead.ConnectionLost, SymbolVersion.Classify(0x7, 0));
        // Seen at the start of a download: the symbol table is being replaced, not a target without a version.
        Assert.Equal(SymbolVersionRead.Changing, SymbolVersion.Classify(0x710, 0));
        Assert.Equal(SymbolVersionRead.Changing, SymbolVersion.Classify(0x711, 0));
        Assert.Equal(SymbolVersionRead.Unreadable, SymbolVersion.Classify(0x701, 0));
    }

    [Fact]
    public void NeedsResolve_AdoptsUnknownBaselineOnlyThroughAResolve()
    {
        Assert.False(SymbolVersion.NeedsResolve(5, 5));
        Assert.True(SymbolVersion.NeedsResolve(5, 6));
        // No version now: nothing to compare, downloads are noticed by read errors.
        Assert.False(SymbolVersion.NeedsResolve(5, null));
        Assert.False(SymbolVersion.NeedsResolve(null, null));
        // The watched symbols were resolved without a version: a readable version must not be adopted silently.
        Assert.True(SymbolVersion.NeedsResolve(null, 7));
    }
}
