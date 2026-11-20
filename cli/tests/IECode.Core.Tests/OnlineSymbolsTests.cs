using IECode.Core.Ads;

namespace IECode.Core.Tests;

public sealed class OnlineSymbolsTests
{
    private static OnlineSymbol S(string name) => new(name, "INT", null);

    [Fact]
    public void Select_filters_case_insensitively_and_sorts_by_name()
    {
        var (matches, total) = OnlineSymbols.Select([S("MAIN.b"), S("main.a"), S("GVL.x")], "main.");
        Assert.Equal(["main.a", "MAIN.b"], matches.Select(m => m.Name));
        Assert.Equal(2, total);
    }

    [Fact]
    public void Select_caps_at_the_maximum_but_counts_everything()
    {
        var (matches, total) = OnlineSymbols.Select(Enumerable.Range(0, 600).Select(i => S($"MAIN.n{i:000}")), "MAIN.");
        Assert.Equal(500, matches.Count);
        Assert.Equal(600, total);
        Assert.Equal("MAIN.n000", matches[0].Name);
    }

    [Theory]
    [InlineData("  ")]
    [InlineData(null)]
    public void RequireFilter_refuses_a_blank_filter(string? filter)
    {
        var e = Assert.Throws<IECodeException>(() => OnlineSymbols.RequireFilter(filter));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
        Assert.Equal("--online needs --filter: the symbol table of a running PLC is too large to list.", e.Message);
    }

    [Fact]
    public void RequireFilter_trims() => Assert.Equal("MAIN.", OnlineSymbols.RequireFilter(" MAIN. "));
}
