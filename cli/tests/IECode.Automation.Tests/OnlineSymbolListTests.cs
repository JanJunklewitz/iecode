using System.Runtime.Versioning;
using IECode.Core;
using TwinCAT.Ads;

namespace IECode.Automation.Tests;

[SupportedOSPlatform("windows")]
public sealed class OnlineSymbolListTests
{
    [Fact]
    public void List_returns_the_matches_of_the_uploaded_table()
    {
        var link = new FakeLink { Upload = () => new FakeSet(new FakeSymbol("MAIN.a", "INT", "INT"), new FakeSymbol("MAIN.b", "INT", "INT"), new FakeSymbol("GVL.x", "INT", "INT")) };
        var (matches, total) = OnlineSymbolList.List(() => link, "test:851", "gvl.");
        Assert.Equal(["GVL.x"], matches.Select(m => m.Name));
        Assert.Equal(1, total);
    }

    [Theory]
    [InlineData("MAIN.fb.st.")]
    [InlineData("MAIN.fb.st.eMo")]
    public void List_finds_the_members_below_a_path_the_table_walk_does_not_reach(string filter)
    {
        var members = new FakeSymbol[] { new("MAIN.fb.st.eMode", "E_Mode", "INT"), new("MAIN.fb.st.fLife", "REAL", "REAL") };
        var st = new FakeSymbol("MAIN.fb.st", "ST_Set", "", single: false) { Children = members };
        // Enumerate lists the structure only, like a table walk that stops before its members
        var link = new FakeLink { Upload = () => new FakeSet(st, new FakeSymbol("MAIN.a", "INT", "INT")) };
        var (matches, total) = OnlineSymbolList.List(() => link, "test:851", filter);
        Assert.Equal(filter.EndsWith('.') ? ["MAIN.fb.st.eMode", "MAIN.fb.st.fLife"] : ["MAIN.fb.st.eMode"], matches.Select(m => m.Name));
        Assert.Equal(matches.Count, total);
    }

    [Fact]
    public void List_reports_an_empty_table_as_unreachable()
    {
        var link = new FakeLink { Upload = () => new FakeSet() };
        var e = Assert.Throws<IECodeException>(() => OnlineSymbolList.List(() => link, "test:851", "MAIN."));
        Assert.Equal(ExitCodes.TargetFailed, e.ExitCode);
        Assert.StartsWith("Cannot reach test:851 over ADS", e.Message);
    }

    [Fact]
    public void List_reports_a_target_that_does_not_answer()
    {
        var link = new FakeLink { State = AdsErrorCode.TargetPortNotFound };
        var e = Assert.Throws<IECodeException>(() => OnlineSymbolList.List(() => link, "test:851", "MAIN."));
        Assert.Equal(ExitCodes.TargetFailed, e.ExitCode);
    }
}
