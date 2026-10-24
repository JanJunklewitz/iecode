using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class WorkspaceTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    // Fixture: Machine.sln contains PLC1 (application) and the library MotorLib (Tc3_MotorLib 1.3.0).
    // PLC1 pins Tc3_MotorLib 1.2.0 → a pinned (not workspace) link.
    private Workspace Load() => Workspace.Load(_ws.Root);

    [Fact]
    public void GroupsUnitsBySolution()
    {
        var w = Load();
        // the solution holds a library project, so the whole solution counts as library group
        Assert.Equal(["Machine/MotorLib", "Machine/PLC1"], w.Units.Select(u => u.Id).Order());
        Assert.All(w.Units, u => Assert.Equal(UnitGroup.Library, u.Group));
    }

    [Fact]
    public void LooseProjectsAreStandaloneAndLinked()
    {
        _ws.Touch("Tools/Runner/Runner.plcproj", 0);
        File.WriteAllText(_ws["Tools/Runner/Runner.plcproj"], """
            <Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
              <PropertyGroup><Name>Runner</Name></PropertyGroup>
              <ItemGroup>
                <PlaceholderReference Include="Tc3_MotorLib"><DefaultResolution>Tc3_MotorLib, * (Example Machines Ltd)</DefaultResolution></PlaceholderReference>
              </ItemGroup>
            </Project>
            """);
        var w = Load();
        Assert.Equal(UnitGroup.Standalone, w["Runner"].Group);
        var link = Assert.Single(w.Links, l => l.From == "Runner");
        Assert.True(link.IsWorkspace);
        Assert.Contains(w.Links, l => l.From == "Machine/PLC1" && !l.IsWorkspace);
        Assert.Equal(["Machine/MotorLib", "Machine/PLC1", "Runner"], w.BuildOrder());
        Assert.Equal(["Machine/MotorLib", "Runner"], w.Affected(["Machine/MotorLib"]).Order());
        Assert.Equal("Runner", w.UnitOf(_ws["Tools/Runner/POUs/MAIN.TcPOU"])?.Id);
        Assert.Contains("-.->|pinned 1.2.0|", w.ToMermaid());
    }

    [Theory]
    [InlineData("1.3.0", "minor", "1.4.0")]
    [InlineData("1.3.7", "major", "2.0.0")]
    [InlineData("1.3", "patch", "1.3.1")]
    [InlineData("1.3.0.5", "patch", "1.3.1.0")]
    [InlineData("1.3.0", "2.0.1", "2.0.1")]
    public void Bumps(string from, string bump, string to) => Assert.Equal(to, Workspace.Bump(from, bump));

    [Fact]
    public void SetsProjectVersionInPlace()
    {
        var path = _ws["Machine/MotorLib/MotorLib/MotorLib.plcproj"];
        var before = File.ReadAllText(path);
        Workspace.SetProjectVersion(path, "1.4.0");
        Assert.Equal(before.Replace("<ProjectVersion>1.3.0</ProjectVersion>", "<ProjectVersion>1.4.0</ProjectVersion>"), File.ReadAllText(path));
    }

    [Fact]
    public void RestorePlansMissingPinnedVersions()
    {
        _ws.Touch("Repo/beckhoff automation gmbh/tc2_system/3.4.22.0/x.library");
        _ws.Touch("Feed/Tc3_MotorLib_1.2.0.library");
        var projects = Load().Units.Select(u => u.Plc);
        var missing = Restore.Plan(projects, LibraryRepository.Scan(_ws["Repo"]), [_ws["Feed"]]);
        // Tc2_System 3.4.22.0 is installed; Tc2_Standard is '*' (not restored); Tc3_MotorLib 1.2.0 + Tc3_Logging 0.9.1 / 1.0.0 are missing
        Assert.Equal(["Tc3_Logging 0.9.1", "Tc3_Logging 1.0.0", "Tc3_MotorLib 1.2.0"], missing.Select(m => $"{m.Name} {m.Version}").Order());
        Assert.EndsWith("Tc3_MotorLib_1.2.0.library", missing.Single(m => m.Name == "Tc3_MotorLib").Source);
        Assert.Null(missing.First(m => m.Name == "Tc3_Logging").Source);
    }
}
