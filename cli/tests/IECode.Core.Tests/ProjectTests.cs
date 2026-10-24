using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class ProjectTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    [Fact]
    public void ReadsSolutionWithTwinCatAndPlcOnlyProjects()
    {
        var sln = SolutionFile.Load(_ws["Machine/Machine.sln"]);
        Assert.Equal(["Machine", "MotorLib"], sln.TwinCatProjects.Select(p => p.Name));
        Assert.Equal("3.1.4024.66", sln.TwinCatProjects[0].TcVersion);
        Assert.False(sln.TwinCatProjects[0].IsPlcOnly);
        Assert.True(sln.TwinCatProjects[1].IsPlcOnly);
        Assert.Equal(["PLC1", "MotorLib"], sln.PlcProjects.Select(p => p.Name));
    }

    [Fact]
    public void FindsSolutionInFolder() =>
        Assert.Equal(_ws["Machine/Machine.sln"], SolutionFile.Find(_ws["Machine"]));

    [Fact]
    public void ReadsLibraryMetadata()
    {
        var lib = PlcProjectFile.Load(_ws["Machine/MotorLib/MotorLib/MotorLib.plcproj"]);
        Assert.True(lib.IsLibrary);
        Assert.Equal(("Tc3_MotorLib", "Example Machines Ltd", "1.3.0"), (lib.Title, lib.Company, lib.ProjectVersion));
        Assert.False(PlcProjectFile.Load(_ws["Machine/Machine/PLC1/PLC1.plcproj"]).IsLibrary);
    }

    [Fact]
    public void ResolvesEffectiveReferences()
    {
        var refs = PlcProjectFile.Load(_ws["Machine/Machine/PLC1/PLC1.plcproj"]).References.ToDictionary(r => r.Effective.Name);
        Assert.False(refs["Tc2_Standard"].IsPinned);
        Assert.Equal("1.2.0", refs["Tc3_MotorLib"].Effective.Version);
        Assert.Equal("3.4.22.0", refs["Tc2_System"].Effective.Version);       // PlaceholderResolution wins over DefaultResolution *
        Assert.True(refs["Tc2_System"].IsPinned);
        Assert.Equal(ReferenceKind.Library, refs["Tc3_Logging"].Kind);
        Assert.Equal("0.9.1", refs["Tc3_Logging"].Effective.Version);
    }

    [Fact]
    public void UpdatesOnlyTheVersionAndKeepsBomAndCrlf()
    {
        var path = _ws["Machine/Machine/PLC1/PLC1.plcproj"];
        var before = File.ReadAllBytes(path);
        var project = PlcProjectFile.Load(path);

        var changes = project.SetLibraryVersion("tc3_motorlib", "1.3.0");

        Assert.Equal([new ReferenceChange("PLC1", "Tc3_MotorLib", "Example Machines Ltd", "1.2.0", "1.3.0")], changes);
        var after = File.ReadAllBytes(path);
        Assert.Equal(before.Take(3), after.Take(3));                        // BOM kept
        var text = System.Text.Encoding.UTF8.GetString(after);
        Assert.DoesNotMatch("[^\r]\n", text);                               // CRLF kept
        Assert.Equal(System.Text.Encoding.UTF8.GetString(before).Replace("Tc3_MotorLib, 1.2.0", "Tc3_MotorLib, 1.3.0"), text);
    }

    [Fact]
    public void UpdatesPinnedResolutionAndDirectLibraryReference()
    {
        var path = _ws["Machine/Machine/PLC1/PLC1.plcproj"];
        var p = PlcProjectFile.Load(path);
        Assert.Equal(2, p.SetLibraryVersion("Tc2_System", "3.4.26.0").Count);   // default * and pinned 3.4.22.0
        Assert.Single(p.SetLibraryVersion("Tc3_Logging", "1.0.0"));
        var reloaded = PlcProjectFile.Load(path).References.ToDictionary(r => r.Effective.Name);
        Assert.Equal("3.4.26.0", reloaded["Tc2_System"].Effective.Version);
        Assert.Equal("1.0.0", reloaded["Tc3_Logging"].Effective.Version);
    }

    [Fact]
    public void DryRunAndVendorFilterDontWrite()
    {
        var path = _ws["Machine/Machine/PLC1/PLC1.plcproj"];
        var before = File.ReadAllText(path);
        var p = PlcProjectFile.Load(path);
        Assert.Single(p.SetLibraryVersion("Tc3_MotorLib", "2.0.0", dryRun: true));
        Assert.Empty(p.SetLibraryVersion("Tc3_MotorLib", "2.0.0", vendor: "Someone Else"));
        Assert.Empty(p.SetLibraryVersion("Tc3_MotorLib", "1.2.0"));            // already there
        Assert.Equal(before, File.ReadAllText(path));
    }

    [Theory]
    [InlineData("latest")]
    [InlineData("1")]
    [InlineData("1.2.3.4.5")]
    public void RejectsInvalidVersion(string v) =>
        Assert.Throws<IECodeException>(() => PlcProjectFile.Load(_ws["Machine/Machine/PLC1/PLC1.plcproj"]).SetLibraryVersion("Tc3_MotorLib", v));

    [Fact]
    public void DiscoverSkipsOutputFolders()
    {
        _ws.Touch("Machine/Machine/PLC1/_Libraries/x/Copy.plcproj");
        var found = PlcProjectFile.Discover([_ws.Root]).Select(Path.GetFileName).Order().ToList();
        Assert.Equal(["MotorLib.plcproj", "PLC1.plcproj"], found);
    }

    [Fact]
    public void FindsArtifactsButNotInGit()
    {
        _ws.Touch("Machine/Machine/PLC1/_CompileInfo/a.bin");
        _ws.Touch("Machine/Machine/PLC1/_Boot/b.bin");
        _ws.Touch("Machine/.git/_CompileInfo/c.bin");
        var found = Artifacts.Find(_ws.Root, Artifacts.DefaultFolders);
        Assert.Equal([_ws["Machine/Machine/PLC1/_CompileInfo"]], found);
        Assert.Equal(2, Artifacts.Find(_ws.Root, Artifacts.AllFolders).Count);
    }
}

public sealed class LibraryRepositoryTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    private string Repo()
    {
        foreach (var v in new[] { "1.2.0", "1.3.0", "1.10.0" }) _ws.Touch($"Repo/example machines ltd/tc3_motorlib/{v}/tc3_motorlib.library");
        _ws.Touch("Repo/example machines ltd/tc3_motorlib/temp/x");
        _ws.Touch("Repo/beckhoff automation gmbh/tc2_system/3.4.26.0/tc2_system.library");
        return _ws["Repo"];
    }

    [Fact]
    public void ScansVendorLibraryVersionFolders()
    {
        var all = LibraryRepository.Scan(Repo());
        Assert.Equal(4, all.Count);                                          // "temp" isn't a version
    }

    [Fact]
    public void NewestComparesNumerically() =>
        Assert.Equal("1.10.0", LibraryRepository.Newest(LibraryRepository.Scan(Repo()), "Tc3_MotorLib", "Example Machines Ltd")!.Version);

    [Fact]
    public void UnknownLibraryHasNoNewest() =>
        Assert.Null(LibraryRepository.Newest(LibraryRepository.Scan(Repo()), "Tc3_Nope", null));
}
