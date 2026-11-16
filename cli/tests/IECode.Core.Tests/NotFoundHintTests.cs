using IECode.Core.Ads;

namespace IECode.Core.Tests;

public class NotFoundHintTests
{
    private static Func<string, string?> Types(params (string Path, string Type)[] known) =>
        path => known.FirstOrDefault(k => k.Path == path).Type;

    [Fact]
    public void IndexOutsideTheBounds_NamesTheBounds()
    {
        var hint = AdsCodes.NotFoundHint("MAIN.afb[999].bAlive", Types(("MAIN.afb", "ARRAY [1..6] OF FB_GasChannel")));
        Assert.Equal("'MAIN.afb' is ARRAY [1..6] OF FB_GasChannel: index 999 is outside 1..6.", hint);
    }

    [Fact]
    public void SecondDimensionOutside_IsFound()
    {
        var hint = AdsCodes.NotFoundHint("MAIN.a[1,5].x", Types(("MAIN.a", "ARRAY [0..2, 0..3] OF FB_X")));
        Assert.Equal("'MAIN.a' is ARRAY [0..2, 0..3] OF FB_X: index 5 is outside 0..3.", hint);
    }

    [Fact]
    public void IndexInsideTheBounds_StillNamesTheArray()
    {
        var hint = AdsCodes.NotFoundHint("MAIN.afb[2].bMissing", Types(("MAIN.afb", "ARRAY [1..6] OF FB_GasChannel")));
        Assert.Equal("'MAIN.afb' is ARRAY [1..6] OF FB_GasChannel.", hint);
    }

    [Theory]
    [InlineData("MAIN.fb.bAlive")]
    [InlineData("MAIN.afb[2].bAlive")]
    public void NoArrayOnThePath_GivesTheHideHint(string symbol) =>
        Assert.Equal(AdsCodes.HiddenHint, AdsCodes.NotFoundHint(symbol, Types(("MAIN.afb", "FB_GasChannel"))));
}
