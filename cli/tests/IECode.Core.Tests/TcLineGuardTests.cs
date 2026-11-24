namespace IECode.Core.Tests;

public class TcLineGuardTests
{
    static readonly string[] Both = ["3.1.4024.66", "3.1.4026.28"];
    static readonly string[] Only4024 = ["3.1.4024.47", "3.1.4024.66"];
    static readonly string[] Only4026 = ["3.1.4026.28"];

    static TcChoice Auto(string?[] stamps, string[] installed, bool saves = true) =>
        TcLineGuard.Choose(TwinCatVersion.Auto, stamps, installed, saves);

    [Fact] public void ExplicitRequestIsKept()
    {
        var c = TcLineGuard.Choose(TwinCatVersion.Parse("4026"), ["3.1.4024.66"], Both, saves: true);
        Assert.Equal("3.1.4026", c.Request.ToString());
        Assert.Null(c.Note);
    }

    [Fact] public void AutoUsesTheStamp() =>
        Assert.Equal("3.1.4024.66", Auto(["3.1.4024.66"], Both).Request.ToString());

    [Fact] public void StampedBuildMissingFallsBackToLine()
    {
        var c = Auto(["3.1.4024.62"], Both);
        Assert.Equal("3.1.4024.66", c.Request.ToString());
        Assert.Contains("3.1.4024.62", c.Note);
    }

    [Fact] public void StampedLineNotInstalledStops()
    {
        var e = Assert.Throws<IECodeException>(() => Auto(["3.1.4024.66"], Only4026));
        Assert.Equal(ExitCodes.VersionNotInstalled, e.ExitCode);
        Assert.Contains("--tc", e.Hint);
        Assert.Contains("iecode.tcVersion", e.Hint);
    }

    [Fact] public void NoStampAndBothLinesStops()
    {
        var e = Assert.Throws<IECodeException>(() => Auto([null], Both));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
        Assert.Contains("--tc", e.Hint);
        Assert.Contains("iecode.tcVersion", e.Hint);
    }

    [Fact] public void NoStampAndOneLineUsesThatLine()
    {
        var c = Auto([null], Only4024);
        Assert.Equal(4024, c.Request.Line);
        Assert.Null(c.Note);
    }

    [Fact] public void MixedLinesStop()
    {
        var e = Assert.Throws<IECodeException>(() => Auto(["3.1.4024.66", "3.1.4026.28"], Both));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
        Assert.Contains("4024", e.Message);
        Assert.Contains("4026", e.Message);
    }

    [Fact] public void NonSavingCommandWarnsInsteadOfStopping()
    {
        var noStamp = Auto([null], Both, saves: false);
        Assert.Equal(4026, noStamp.Request.Line);
        Assert.Contains("--tc", noStamp.Note);

        var otherLine = Auto(["3.1.4024.66"], Only4026, saves: false);
        Assert.Equal("3.1.4026.28", otherLine.Request.ToString());
        Assert.Contains("3.1.4024.66", otherLine.Note);

        var mixed = Auto(["3.1.4024.66", "3.1.4026.28"], Both, saves: false);
        Assert.Equal("3.1.4024.66", mixed.Request.ToString());
        Assert.Contains("4026", mixed.Note);
    }

    // (R1: a Visual Studio 2022 ProgID is no TwinCAT 4026; the guard only sees the Build_* folders, see BuildsFromFolders)

    [Fact] public void MixedLinesStopEvenWithoutInstallInformation()
    {
        var e = Assert.Throws<IECodeException>(() => Auto(["3.1.4024.66", "3.1.4026.28"], []));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
    }

    [Fact] public void UnknownInstallKeepsTheStamp()
    {
        Assert.Equal("3.1.4024.66", Auto(["3.1.4024.66"], []).Request.ToString());
        Assert.True(Auto([null], []).Request.IsAuto);
    }

    [Fact] public void UnreadableStampIsIgnored() =>
        Assert.Equal(4024, Auto(["garbage"], Only4024).Request.Line);
}

public class TwinCatInstallTests
{
    [Fact] public void BuildsFromFolders()
    {
        using var ws = new TempWorkspace();
        ws.Touch("tc/Components/Plc/Build_4024.66/Common/RepTool.exe");
        ws.Touch("tc/Components/Plc/Build_4026.28/Common/RepTool.exe");
        ws.Touch("tc/Components/Plc/Build_4024.10/Common/RepTool.exe");
        Directory.CreateDirectory(ws["tc/Components/Plc/Build_4026.3/Common"]);   // no RepTool: not a usable build
        Directory.CreateDirectory(ws["tc/Components/Plc/Common"]);
        Assert.Equal(["3.1.4024.10", "3.1.4024.66", "3.1.4026.28"], TwinCatInstall.Builds(ws["tc"]));
    }

    [Fact] public void MissingFolderGivesNoBuilds()
    {
        Assert.Empty(TwinCatInstall.Builds(null));
        Assert.Empty(TwinCatInstall.Builds(Path.Combine(Path.GetTempPath(), "no-such-twincat-" + Guid.NewGuid().ToString("N"))));
    }
}
