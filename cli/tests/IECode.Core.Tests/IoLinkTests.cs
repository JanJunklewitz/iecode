using System.Diagnostics;
using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class IoLinkTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    private static string Tsproj(string links) => $"""
        <?xml version="1.0"?>
        <TcSmProject TcVersion="3.1.4024.66">
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
    public void LoadsFromGitHistoryAndWorkingCopyIncludingXti()
    {
        var dir = _ws["Repo/Sys"];
        Directory.CreateDirectory(Path.Combine(dir, "_Config", "IO"));
        File.WriteAllText(Path.Combine(dir, "Sys.tsproj"), Tsproj(Old));
        Directory.CreateDirectory(Path.Combine(dir, "IO"));
        File.WriteAllText(Path.Combine(dir, "IO", "Device 2.xti"), Tsproj("""<Link VarA="PlcTask Inputs^MAIN.bExtra" VarB="Channel 5^Input"/>"""));
        Git("init", "-q"); Git("add", "-A"); Git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "one");
        File.WriteAllText(Path.Combine(dir, "Sys.tsproj"), Tsproj(New));

        var head = IoLinks.Load(Path.Combine(dir, "Sys.tsproj"), "HEAD");
        var work = IoLinks.Load(Path.Combine(dir, "Sys.tsproj"), null);
        Assert.Equal(6, head.Count);                                           // 4 in .tsproj + 2 in .xti
        Assert.Contains(head, l => l.File == "IO/Device 2.xti");
        Assert.Equal(4, IoLinks.Diff(head, work).Count);
        Assert.Equal([Path.Combine(dir, "Sys.tsproj")], IoLinks.FindProjects(_ws["Repo"]));
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
