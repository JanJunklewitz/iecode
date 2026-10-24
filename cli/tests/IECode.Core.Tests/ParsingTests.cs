namespace IECode.Core.Tests;

public class AmsNetIdTests
{
    [Theory]
    [InlineData("5.80.201.232.1.1", "5.80.201.232.1.1")]
    [InlineData("local", "127.0.0.1.1.1")]
    [InlineData(" <Local> ", "127.0.0.1.1.1")]
    public void Parses(string text, string expected) => Assert.Equal(expected, AmsNetId.Parse(text).ToString());

    [Theory]
    [InlineData("1.2.3.4.5")]
    [InlineData("1.2.3.4.5.256")]
    [InlineData("a.b.c.d.e.f")]
    [InlineData("")]
    public void RejectsInvalid(string text)
    {
        var e = Assert.Throws<IECodeException>(() => AmsNetId.Parse(text));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
    }

    [Fact]
    public void LocalIsLocal() => Assert.True(AmsNetId.Parse("127.0.0.1.1.1").IsLocal);
}

public class TwinCatVersionTests
{
    private static readonly string[] Installed = ["3.1.4024.62", "3.1.4024.66", "3.1.4026.12"];

    [Theory]
    [InlineData("4024", "3.1.4024.66")]
    [InlineData("4024.62", "3.1.4024.62")]
    [InlineData("3.1.4024.62", "3.1.4024.62")]
    [InlineData("4026", "3.1.4026.12")]
    [InlineData("auto", "3.1.4026.12")]
    public void ResolvesNewestMatching(string request, string expected) =>
        Assert.Equal(expected, TwinCatVersion.Parse(request).Resolve(Installed));

    [Fact]
    public void MissingBuildResolvesToNull() => Assert.Null(TwinCatVersion.Parse("4024.70").Resolve(Installed));

    [Theory]
    [InlineData("4.0")]
    [InlineData("TC3")]
    [InlineData("3.1.4024.x")]
    public void RejectsInvalid(string text) => Assert.Throws<IECodeException>(() => TwinCatVersion.Parse(text));

    [Fact]
    public void PicksRepToolProfileForVersion()
    {
        string[] profiles = ["TwinCAT PLC Control", "TwinCAT PLC Control_Build_4024.62", "TwinCAT PLC Control_Build_4024.66", "TwinCAT PLC Control_Build_4026.12"];
        Assert.Equal("TwinCAT PLC Control_Build_4024.66", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Parse("4024")));
        Assert.Equal("TwinCAT PLC Control_Build_4024.62", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Parse("4024.62")));
        Assert.Equal("TwinCAT PLC Control_Build_4026.12", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Auto));
        Assert.Equal("TwinCAT PLC Control", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Parse("4022")));
    }
}

public class ProtectionSpecTests
{
    [Fact]
    public void ParsesKeyValues()
    {
        var s = ProtectionSpec.Parse("TIPC^PLC1^PLC1 Project^POUs, encrypted=true, signed=false, level=Service");
        Assert.Equal(new ProtectionSpec("TIPC^PLC1^PLC1 Project^POUs", true, false, "Service"), s);
    }

    [Fact]
    public void BareTokenIsTheLevel()
    {
        var s = ProtectionSpec.Parse("TIPC^PLC1^PLC1 Project^POUs,encrypted=True,Service");
        Assert.Equal("Service", s.Level);
        Assert.True(s.Encrypted);
        Assert.Null(s.Signed);
    }

    [Theory]
    [InlineData("TIPC^PLC1")]                       // nothing to change
    [InlineData("encrypted=true")]                   // no item path
    [InlineData("TIPC^PLC1,encrypted=maybe")]        // not a bool
    [InlineData("TIPC^PLC1,colour=red")]             // unknown key
    [InlineData("TIPC^PLC1,Service,Developer")]      // level twice
    public void RejectsInvalid(string text) => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => ProtectionSpec.Parse(text)).ExitCode);
}

public class BuildSummaryTests
{
    [Fact]
    public void ParsesEnglish() =>
        Assert.Equal(new BuildSummary(2, 1, 0, 0),
            BuildSummary.TryParse("...\n========== Build: 2 succeeded, 1 failed, 0 up-to-date, 0 skipped =========="));

    [Fact]
    public void ParsesGerman() =>
        Assert.Equal(new BuildSummary(1, 0, 3, 0),
            BuildSummary.TryParse("========== Erstellen: 1 erfolgreich, 0 fehlerhaft, 3 aktuell, 0 übersprungen =========="));

    [Fact]
    public void TakesTheLastSummary() =>
        Assert.Equal(0, BuildSummary.TryParse("========== Build: 0 succeeded, 1 failed, 0 up-to-date, 0 skipped ==========\n" +
                                               "========== Build: 1 succeeded, 0 failed, 0 up-to-date, 0 skipped ==========")!.Failed);

    [Fact]
    public void NoSummaryIsNull() => Assert.Null(BuildSummary.TryParse("Build started..."));
}
