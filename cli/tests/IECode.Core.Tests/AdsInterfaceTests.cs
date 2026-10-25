using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class AdsInterfaceTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    private static string Tmc(string mainSymbols = "", string motorItems = "") => $"""
        <?xml version="1.0"?>
        <TcModuleClass xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <DataTypes>
            <DataType>
              <Name GUID="{"{00000000-0000-0000-0000-000000000001}"}">FB_Base</Name>
              <BitSize>64</BitSize>
              <SubItem><Name>nState</Name><Type>INT</Type><BitSize>16</BitSize><BitOffs>32</BitOffs></SubItem>
            </DataType>
            <DataType>
              <Name GUID="{"{00000000-0000-0000-0000-000000000002}"}">FB_Motor</Name>
              <BitSize>192</BitSize>
              <ExtendsType>FB_Base</ExtendsType>
              <SubItem><Name>bEnable</Name><Type>BOOL</Type><Comment><![CDATA[ Enable the drive ]]></Comment><BitSize>8</BitSize><BitOffs>64</BitOffs></SubItem>
              <SubItem><Name>stStatus</Name><Type>ST_Status</Type><BitSize>64</BitSize><BitOffs>128</BitOffs></SubItem>
              <SubItem><Name>pNext</Name><Type PointerTo="1">FB_Motor</Type><BitSize>64</BitSize><BitOffs>192</BitOffs></SubItem>
        {motorItems}
            </DataType>
            <DataType>
              <Name GUID="{"{00000000-0000-0000-0000-000000000003}"}">ST_Status</Name>
              <BitSize>64</BitSize>
              <SubItem><Name>fSpeed</Name><Type>REAL</Type><BitSize>32</BitSize><BitOffs>0</BitOffs></SubItem>
            </DataType>
            <DataType>
              <Name Namespace="Tc2_Standard">TON</Name>
              <BitSize>256</BitSize>
              <SubItem><Name>Q</Name><Type>BOOL</Type><BitSize>8</BitSize><BitOffs>0</BitOffs></SubItem>
            </DataType>
          </DataTypes>
          <Modules>
            <Module GUID="{"{00000000-0000-0000-0000-000000000010}"}">
              <Name>PLC1</Name>
              <DataAreas>
                <DataArea>
                  <AreaNo AreaType="InputDst" CreateSymbols="true">0</AreaNo>
                  <Name>PlcTask Inputs</Name>
                  <Symbol><Name>MAIN.bStart</Name><Comment><![CDATA[ Start button ]]></Comment><BitSize>1</BitSize><BaseType>BIT</BaseType><BitOffs>0</BitOffs></Symbol>
                </DataArea>
                <DataArea>
                  <AreaNo AreaType="Internal" CreateSymbols="true">2</AreaNo>
                  <Name>PlcTask Internal</Name>
                  <Symbol><Name>MAIN.fbMotor</Name><BitSize>192</BitSize><BaseType>FB_Motor</BaseType><BitOffs>0</BitOffs></Symbol>
                  <Symbol><Name>MAIN.tDelay</Name><BitSize>256</BitSize><BaseType Namespace="Tc2_Standard">TON</BaseType><BitOffs>192</BitOffs></Symbol>
                  <Symbol><Name>GVL.aValues</Name><BitSize>160</BitSize><BaseType>INT</BaseType><ArrayInfo><LBound>0</LBound><Elements>10</Elements></ArrayInfo><BitOffs>448</BitOffs></Symbol>
        {mainSymbols}
                </DataArea>
              </DataAreas>
            </Module>
          </Modules>
        </TcModuleClass>
        """;

    [Fact]
    public void ReadsTopLevelSymbolsFromTmc()
    {
        var symbols = AdsInterface.FromTmc(Tmc());
        Assert.Equal(["GVL.aValues", "MAIN.bStart", "MAIN.fbMotor", "MAIN.tDelay"], symbols.Select(s => s.Name));
        var start = symbols.Single(s => s.Name == "MAIN.bStart");
        Assert.Equal(("BIT", 1, "Start button", "PlcTask Inputs"), (start.Type, start.BitSize!.Value, start.Comment!, start.Area!));
        Assert.Equal("1 bit", start.SizeText);
        Assert.Equal("ARRAY [0..9] OF INT", symbols.Single(s => s.Name == "GVL.aValues").Type);
        Assert.Equal("24 B", symbols.Single(s => s.Name == "MAIN.fbMotor").SizeText);
    }

    [Fact]
    public void ExpandsMembersWithInheritanceButNotPointersOrArrays()
    {
        var names = AdsInterface.FromTmc(Tmc(), members: true).Select(s => s.Name).ToList();
        Assert.Equal([
            "GVL.aValues", "MAIN.bStart", "MAIN.fbMotor", "MAIN.fbMotor.bEnable", "MAIN.fbMotor.nState", "MAIN.fbMotor.pNext",
            "MAIN.fbMotor.stStatus", "MAIN.fbMotor.stStatus.fSpeed", "MAIN.tDelay", "MAIN.tDelay.Q",
        ], names);
        var symbols = AdsInterface.FromTmc(Tmc(), members: true);
        Assert.Equal("POINTER TO FB_Motor", symbols.Single(s => s.Name == "MAIN.fbMotor.pNext").Type);
        Assert.Equal("Enable the drive", symbols.Single(s => s.Name == "MAIN.fbMotor.bEnable").Comment);
        Assert.Equal(["GVL.aValues", "MAIN.bStart", "MAIN.fbMotor", "MAIN.tDelay"], AdsInterface.TopLevel(symbols).Select(s => s.Name));
    }

    [Fact]
    public void DiffFindsAddedRemovedAndChangedTypes()
    {
        var before = AdsInterface.FromTmc(Tmc(
            mainSymbols: "<Symbol><Name>MAIN.nCount</Name><BitSize>16</BitSize><BaseType>INT</BaseType></Symbol>" +
                         "<Symbol><Name>MAIN.bOld</Name><BitSize>8</BitSize><BaseType>BOOL</BaseType></Symbol>"), members: true);
        var after = AdsInterface.FromTmc(Tmc(
            mainSymbols: "<Symbol><Name>main.nCount</Name><BitSize>32</BitSize><BaseType>DINT</BaseType></Symbol>",
            motorItems: "<SubItem><Name>bReset</Name><Type>BOOL</Type><BitSize>8</BitSize></SubItem>"), members: true);
        var changes = AdsInterface.Diff(before, after);
        Assert.Equal(["Removed MAIN.bOld", "Added MAIN.fbMotor.bReset", "Changed main.nCount"], changes.Select(c => $"{c.Kind} {c.Name}"));
        Assert.Equal("INT → DINT, 2 B → 4 B", changes[2].Details);
        Assert.Empty(AdsInterface.Diff(before, before));
        Assert.StartsWith("Change;Name;Before;After;Details\n", AdsInterface.ToCsv(changes));
    }

    [Fact]
    public void SnapshotRoundTripsAndKeepsTopLevelWhenAsked()
    {
        var tmc = _ws.Touch("Machine/Machine/PLC1/PLC1.tmc");
        File.WriteAllText(tmc, Tmc());
        var info = AdsInterface.Load(tmc, members: true) with { Project = "PLC1" };
        var snap = _ws["snapshot.json"];
        File.WriteAllText(snap, AdsInterface.ToSnapshot(info));
        Assert.Contains("\"format\": \"iecode-ads-interface/1\"", File.ReadAllText(snap));
        Assert.DoesNotContain("sizeText", File.ReadAllText(snap));

        var full = AdsInterface.Load(snap, members: true);
        Assert.True(full.Members);
        Assert.Equal("PLC1", full.Project);
        Assert.Empty(AdsInterface.Diff(info.Symbols, full.Symbols));
        Assert.Equal(4, AdsInterface.Load(snap, members: false).Symbols.Count);
        Assert.Equal(Path.GetFullPath(tmc), AdsInterface.FindTmc(_ws["Machine/Machine/PLC1/PLC1.plcproj"]));
    }

    [Fact]
    public void DetectsStaleBuildOutput()
    {
        var plcproj = _ws["Machine/Machine/PLC1/PLC1.plcproj"];
        Assert.Null(AdsInterface.FindTmc(plcproj));
        var tmc = _ws.Touch("Machine/Machine/PLC1/PLC1.tmc");
        File.SetLastWriteTimeUtc(plcproj, DateTime.UtcNow.AddMinutes(-5));
        File.SetLastWriteTimeUtc(tmc, DateTime.UtcNow);
        Assert.False(AdsInterface.IsStale(tmc, plcproj));
        File.SetLastWriteTimeUtc(plcproj, DateTime.UtcNow.AddMinutes(5));
        Assert.True(AdsInterface.IsStale(tmc, plcproj));
    }

    [Fact]
    public void RejectsBrokenFiles()
    {
        var e = Assert.Throws<IECodeException>(() => AdsInterface.FromTmc("<TcModuleClass>", file: "x.tmc"));
        Assert.Contains("x.tmc", e.Message);
    }
}
