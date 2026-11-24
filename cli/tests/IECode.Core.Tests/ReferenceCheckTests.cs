using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class ReferenceCheckTests : IDisposable
{
    private readonly TempWorkspace _ws = new();
    private readonly PlcProjectFile _project;

    public ReferenceCheckTests()
    {
        var path = _ws["Check/PLC1/PLC1.plcproj"];
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, """
            <?xml version="1.0" encoding="utf-8"?>
            <Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
              <PropertyGroup><Name>PLC1</Name></PropertyGroup>
              <ItemGroup>
                <PlaceholderReference Include="Tc3_MotorLib">
                  <DefaultResolution>Tc3_MotorLib, * (Example)</DefaultResolution>
                </PlaceholderReference>
                <PlaceholderReference Include="Tc3_AxisLib">
                  <DefaultResolution>Tc3_AxisLib, * (Example)</DefaultResolution>
                </PlaceholderReference>
              </ItemGroup>
              <ItemGroup>
                <PlaceholderResolution Include="Tc3_MotorLib">
                  <Resolution>Tc3_MotorLib, 1.2.0.0 (Example)</Resolution>
                </PlaceholderResolution>
              </ItemGroup>
            </Project>
            """);
        _project = PlcProjectFile.Load(path);
    }

    public void Dispose() => _ws.Dispose();

    private static InstalledLibrary Installed(string name, string version, string vendor = "Example") =>
        new(name, version, vendor, Path.Combine("repo", vendor, name, version));

    [Fact]
    public void PinnedVersionMissing()
    {
        var problem = Assert.Single(Restore.Check([_project], [Installed("Tc3_AxisLib", "1.0.0.0")]));
        Assert.Equal(("Tc3_MotorLib", "1.2.0.0", "Example", ReferenceProblemKind.VersionMissing),
            (problem.Name, problem.Version, problem.Vendor, problem.Kind));
        Assert.Equal(["PLC1"], problem.Projects);
    }

    [Fact]
    public void StarReferenceWithoutAnyVersion() =>
        Assert.Contains(Restore.Check([_project], [Installed("Tc3_MotorLib", "1.2.0.0")]),
            p => p is { Name: "Tc3_AxisLib", Version: "*", Kind: ReferenceProblemKind.NoVersionInstalled });

    [Fact]
    public void StarReferenceMatchesCaseInsensitively() =>
        Assert.Empty(Restore.Check([_project], [Installed("tc3_motorlib", "1.2.0.0", "example"), Installed("tc3_axislib", "0.9.0.0", "example")]));

    [Fact]
    public void OtherVendorDoesNotSatisfyAReference()
    {
        var problems = Restore.Check([_project], [Installed("Tc3_MotorLib", "1.2.0.0", "Other"), Installed("Tc3_AxisLib", "1.0.0.0", "Other")]);
        Assert.Equal(["Tc3_AxisLib *", "Tc3_MotorLib 1.2.0.0"], problems.Select(p => $"{p.Name} {p.Version}"));
    }

    [Fact]
    public void VersionInAnyRepositoryIsNotMissing()
    {
        _ws.Touch("Repo4024/example/tc3_axislib/1.0.0.0/tc3_axislib.library");
        _ws.Touch("Repo4026/example/tc3_motorlib/1.2.0.0/tc3_motorlib.library");
        var all = LibraryRepository.ScanAll([_ws["Repo4024"], _ws["Repo4026"], _ws["does-not-exist"]]);
        Assert.Equal(2, all.Count);
        Assert.Empty(Restore.Check([_project], all));
    }

    [Fact]
    public void ScanAllWithoutAnyRepositoryIsEmpty() =>
        Assert.Empty(LibraryRepository.ScanAll([_ws["nope1"], _ws["nope2"]]));
}
