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
