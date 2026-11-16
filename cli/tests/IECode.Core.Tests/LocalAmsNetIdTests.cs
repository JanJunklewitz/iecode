namespace IECode.Core.Tests;

public class LocalAmsNetIdTests
{
    private const string Xml = """
        <?xml version="1.0"?>
        <TcRegistry><Key Name="System">
        <Value Name="AmsNetId" Type="BIN">C7042AFA0101</Value>
        <Value Name="DefaultTransportAmsNetId" Type="BIN">01020304FFFF</Value>
        </Key></TcRegistry>
        """;

    private static string Runtimes(TempWorkspace ws, params (string Name, string Xml)[] instances)
    {
        foreach (var (name, xml) in instances)
        {
            var file = ws[$"Runtimes/{name}/3.1/TcRegistry.xml"];
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, xml);
        }
        Directory.CreateDirectory(ws["Runtimes"]);
        return ws["Runtimes"];
    }

    [Fact]
    public void FromTcRegistry_ReadsTheAmsNetIdValueOnly() =>
        Assert.Equal("199.4.42.250.1.1", LocalAmsNetId.FromTcRegistry(Xml)!.Value.ToString());

    [Theory]
    [InlineData("not xml")]
    [InlineData("<TcRegistry/>")]
    [InlineData("<TcRegistry><Value Name=\"AmsNetId\" Type=\"BIN\">C7042A</Value></TcRegistry>")]
    [InlineData("<TcRegistry><Value Name=\"AmsNetId\" Type=\"BIN\">ZZ042AFA0101</Value></TcRegistry>")]
    [InlineData("<TcRegistry><Value Name=\"AmsNetId\" Type=\"SZ\">C7042AFA0101</Value></TcRegistry>")]
    public void FromTcRegistry_IsNullWhenThereIsNoValidValue(string xml) => Assert.Null(LocalAmsNetId.FromTcRegistry(xml));

    [Fact]
    public void Detect_PrefersTheClassicRegistryValue()
    {
        using var ws = new TempWorkspace();
        var id = LocalAmsNetId.Detect([5, 80, 201, 232, 1, 1], Runtimes(ws, ("UmRT_Default", Xml)));
        Assert.Equal("5.80.201.232.1.1", id!.Value.ToString());
    }

    [Fact]
    public void Detect_FallsBackToTheUmrtRegistry()
    {
        using var ws = new TempWorkspace();
        Assert.Equal("199.4.42.250.1.1", LocalAmsNetId.Detect(null, Runtimes(ws, ("UmRT_Default", Xml)))!.Value.ToString());
    }

    [Fact]
    public void Detect_IsNullForSeveralDifferentUmrtInstances()
    {
        using var ws = new TempWorkspace();
        var other = Xml.Replace("C7042AFA0101", "C7042AFB0101");
        Assert.Null(LocalAmsNetId.Detect(null, Runtimes(ws, ("UmRT_Default", Xml), ("UmRT_Two", other))));
    }

    [Fact]
    public void Detect_IsNullWithoutAnyRuntime()
    {
        using var ws = new TempWorkspace();
        Assert.Null(LocalAmsNetId.Detect(null, ws["missing"]));
        Assert.Null(LocalAmsNetId.Detect([1, 2, 3], Runtimes(ws)));
    }

    [Fact]
    public void Resolve_OnlyReplacesLocal()
    {
        using var ws = new TempWorkspace();
        var dir = Runtimes(ws, ("UmRT_Default", Xml));
        Assert.Equal("199.4.42.250.1.1", LocalAmsNetId.Resolve(AmsNetId.Local, null, dir).ToString());
        Assert.Equal("172.20.30.60.1.1", LocalAmsNetId.Resolve(AmsNetId.Parse("172.20.30.60.1.1"), null, dir).ToString());
        Assert.Equal(AmsNetId.Local, LocalAmsNetId.Resolve(AmsNetId.Local, null, ws["missing"]));
    }
}
