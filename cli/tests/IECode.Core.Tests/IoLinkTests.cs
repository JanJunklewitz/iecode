using System.Diagnostics;
using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class IoLinkTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    private static string Tsproj(string links, string project = "") => $"""
        <?xml version="1.0"?>
        <TcSmProject TcVersion="3.1.4024.66">
          {project}
          <Mappings>
            <OwnerA Name="TIPC^PLC1^PLC1 Instance">
              <OwnerB Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)">
        {links}
              </OwnerB>
            </OwnerA>
            <OwnerA Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 3 (EL2008)">
              <OwnerB Name="TIPC^PLC1^PLC1 Instance">
                <Link VarA="Channel 1^Output" VarB="PlcTask Outputs^MAIN.bLamp"/>
              </OwnerB>
            </OwnerA>
          </Mappings>
        </TcSmProject>
        """;

    private const string Old = """
                <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.bStop" VarB="Channel 2^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.nInputs" VarB="Channel 3^Input" Size="1" OffsA="8"/>
        """;
    private const string New = """
                <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 4^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.bReset" VarB="Channel 2^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.nInputs" VarB="Channel 3^Input" Size="1" OffsA="9"/>
        """;

    [Fact]
    public void ExtractsLinksWithIoSideNormalized()
    {
        var links = IoLinks.Extract(Tsproj(Old), "M.tsproj");
        Assert.Equal(4, links.Count);
        var lamp = links.Single(l => l.Variable.EndsWith("MAIN.bLamp"));
        Assert.Equal("TIPC^PLC1^PLC1 Instance^PlcTask Outputs^MAIN.bLamp", lamp.Variable);
        Assert.Equal("TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 3 (EL2008)^Channel 1^Output", lamp.Io);
        Assert.Equal("OffsA=8 Size=1", links.Single(l => l.Variable.EndsWith("nInputs")).AttributeText);
        Assert.Equal("…^Term 3 (EL2008)^Channel 1^Output", IoLinks.Short(lamp.Io));
        Assert.StartsWith("Variable;IO;Attributes;File\n", IoLinks.ToCsv(links));
    }

    [Fact]
    public void DiffFindsAddedRemovedMovedChanged()
    {
        var changes = IoLinks.Diff(IoLinks.Extract(Tsproj(Old), "a"), IoLinks.Extract(Tsproj(New), "b"));
        Assert.Equal(["Added MAIN.bReset", "Moved MAIN.bStart", "Removed MAIN.bStop", "Changed MAIN.nInputs"],
            changes.Select(c => $"{c.Kind} {c.Variable.Split('^')[^1]}"));
        Assert.Equal("OffsA=8 Size=1 → OffsA=9 Size=1", changes[3].Details);
        Assert.Empty(IoLinks.Diff(IoLinks.Extract(Tsproj(Old), "a"), IoLinks.Extract(Tsproj(Old), "b")));
    }

    [Fact]
    public void LoadsFromGitHistoryAndWorkingCopyIncludingReferencedXti()
    {
        var dir = _ws["Repo/Sys"];
        const string device = """<Io><Device File="Device 2.xti"/></Io>""";
        Directory.CreateDirectory(Path.Combine(dir, "_Config", "IO"));
        File.WriteAllText(Path.Combine(dir, "Sys.tsproj"), Tsproj(Old, $"<Project>{device}</Project>"));
        // owner names in an .xti are relative to its item ("" = the device itself)
        File.WriteAllText(Path.Combine(dir, "_Config", "IO", "Device 2.xti"), """
            <TcSmItem><Device><Name>Device 2</Name></Device><Mappings><OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="">
              <Link VarA="PlcTask Inputs^MAIN.bExtra" VarB="Channel 5^Input"/></OwnerB></OwnerA></Mappings></TcSmItem>
            """);
        File.WriteAllText(Path.Combine(dir, "_Config", "IO", "Old.xti"), Tsproj("""<Link VarA="PlcTask Inputs^MAIN.bOld" VarB="Channel 6^Input"/>"""));
        Git("init", "-q"); Git("add", "-A"); Git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "one");
        File.WriteAllText(Path.Combine(dir, "Sys.tsproj"), Tsproj(New, $"<Project>{device}</Project>"));

        var head = IoLinks.Load(Path.Combine(dir, "Sys.tsproj"), "HEAD");
        var work = IoLinks.Load(Path.Combine(dir, "Sys.tsproj"), null);
        Assert.Equal(5, head.Count);                                           // 4 in .tsproj + 1 in the referenced .xti
        Assert.Equal(5, work.Count);
        var extra = head.Single(l => l.File == "_Config/IO/Device 2.xti");
        Assert.Equal("TIID^Device 2^Channel 5^Input", extra.Io);
        Assert.DoesNotContain(head, l => l.Variable.EndsWith("MAIN.bOld"));    // unreferenced leftover
        Assert.Equal(4, IoLinks.Diff(head, work).Count);
        Assert.Equal([Path.Combine(dir, "Sys.tsproj")], IoLinks.FindProjects(_ws["Repo"]));
    }

    [Fact]
    public void YamlTreeNestsBoxesAndShortensNames()
    {
        var dir = _ws["Yaml"];
        Directory.CreateDirectory(Path.Combine(dir, "_Config", "IO", "Device 1 (EtherCAT)", "B1"));
        File.WriteAllText(Path.Combine(dir, "Sys.tsproj"), """
            <TcSmProject><Project><Io><Device File="Device 1 (EtherCAT).xti"/></Io></Project><Mappings>
              <OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="TIID^Device 1 (EtherCAT)^B1^Term 2 (EL1008)">
                <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.bStart2" VarB="Channel 1^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.yes" VarB="Channel 10^Input"/>
                <Link VarA="PlcTask Inputs^MAIN.bNamed" VarB="Channel 2^MAIN.bNamed" Size="1" OffsB="3"/>
              </OwnerB></OwnerA></Mappings></TcSmProject>
            """);
        // the device holds inline boxes; one box is stored in its own file, in a folder per inline box
        File.WriteAllText(Path.Combine(dir, "_Config", "IO", "Device 1 (EtherCAT).xti"), """
            <TcSmItem><Device><Name>Device 1 (EtherCAT)</Name>
              <Box><Name>B1</Name><Box><Name>Term 2 (EL1008)</Name></Box><Box File="Term 9.xti"/></Box>
            </Device></TcSmItem>
            """);
        File.WriteAllText(Path.Combine(dir, "_Config", "IO", "Device 1 (EtherCAT)", "B1", "Term 9.xti"), """
            <TcSmItem><Box><Name>Term 9</Name></Box><Mappings><OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="">
              <Link VarA="PlcTask Outputs^MAIN.bLamp" VarB="Channel 1^Output"/></OwnerB></OwnerA></Mappings></TcSmItem>
            """);
        var snapshot = IoTree.Load(Path.Combine(dir, "Sys.tsproj"), null);
        Assert.Empty(snapshot.Warnings);
        Assert.Equal(string.Join('\n',
            "Device 1 (EtherCAT):",
            "  B1:",
            "    Term 2 (EL1008):",
            "      Channel 1^Input:",
            "        - PLC1^MAIN.bStart",
            "        - PLC1^MAIN.bStart2",
            "      Channel 2: PLC1^MAIN.bNamed [Size=1 OffsIO=3]",
            "      Channel 10^Input: PLC1^MAIN.yes",
            "    Term 9:",
            "      Channel 1^Output: PLC1^MAIN.bLamp",
            ""), IoTree.ToYaml(snapshot));
        Assert.Equal("'yes'", IoTree.YamlScalar("yes"));
        Assert.Equal("-KF2.0 (EK1100)", IoTree.YamlScalar("-KF2.0 (EK1100)"));
        Assert.Equal("'a: it''s'", IoTree.YamlScalar("a: it's"));
    }

    private void Git(params string[] args)
    {
        var psi = new ProcessStartInfo("git") { WorkingDirectory = _ws["Repo"], RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        p.WaitForExit();
        Assert.True(p.ExitCode == 0, $"git {string.Join(' ', args)}: {p.StandardError.ReadToEnd()}");
    }
}
