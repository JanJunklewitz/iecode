using IECode.Core.Projects;

namespace IECode.Core.Tests;

public sealed class LibrarySelectionTests : IDisposable
{
    private const string Vendor = "Example Machines Ltd";
    private readonly TempWorkspace _ws = new();
    public void Dispose() => _ws.Dispose();

    private string Plc1Path => _ws["Machine/Machine/PLC1/PLC1.plcproj"];
    private PlcProjectFile Plc1 => PlcProjectFile.Load(Plc1Path);

    private static int UsageOf(Action a) => Assert.Throws<IECodeException>(a).ExitCode;

    // ------------------------------------------------------------------ ParseUpdate

    [Fact]
    public void PairsAndBareNames() =>
        Assert.Equal([new UpdateItem("Tc3_MotorLib", "1.2.0.0"), new UpdateItem("Tc3_AxisLib", null)],
            LibrarySelection.ParseUpdate(["Tc3_MotorLib=1.2.0.0", "Tc3_AxisLib"], null, null, []));

    [Fact]
    public void PairAndToConflict() =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate(["Tc3_MotorLib=1.2.0.0"], "2.0.0.0", null, [])));

    [Fact]
    public void BareNamesTakeTo() =>
        Assert.Equal([new UpdateItem("Tc3_MotorLib", null), new UpdateItem("Tc3_AxisLib", null)],
            LibrarySelection.ParseUpdate(["Tc3_MotorLib", "Tc3_AxisLib"], "2.0.0.0", null, []));

    [Fact]
    public void SameLibraryTwiceIsAUsageError() =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate(["Tc3_MotorLib=1.0.0.0", "tc3_motorlib=2.0.0.0"], null, null, [])));

    [Theory]
    [InlineData("=1.0.0.0")]
    [InlineData("Tc3_MotorLib=")]
    public void EmptyNameOrVersionInAPairIsAUsageError(string pair) =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate([pair], null, null, [])));

    [Fact]
    public void VendorWithoutLibTakesAllReferencedLibrariesOfThatVendor() =>
        Assert.Equal(["Tc3_Logging", "Tc3_MotorLib"],
            LibrarySelection.ParseUpdate([], "latest", "example machines ltd", [Plc1]).Select(i => i.Library).Order());

    [Fact]
    public void VendorWithoutLibAndWithoutToMeansLatest() =>
        Assert.All(LibrarySelection.ParseUpdate([], null, Vendor, [Plc1]), i => Assert.Null(i.Version));

    [Fact]
    public void VendorWithFixedVersionIsAUsageError() =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate([], "1.2.0.0", Vendor, [Plc1])));

    [Fact]
    public void VendorWithStarUnpinsEveryLibraryOfThatVendor() =>
        Assert.Equal(2, LibrarySelection.ParseUpdate([], "*", Vendor, [Plc1]).Count);

    [Fact]
    public void VendorWithNoReferencedLibraryIsNotFound() =>
        Assert.Equal(ExitCodes.NotFound, UsageOf(() => LibrarySelection.ParseUpdate([], "latest", "Someone Else", [Plc1])));

    [Fact]
    public void NothingSelectedIsAUsageError() =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate([], "2.0.0.0", null, [])));

    [Fact]
    public void FromProjectWithAPairIsAUsageError() =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate(["Tc3_MotorLib=1.0.0.0"], null, null, [], fromProject: true)));

    [Fact]
    public void FromProjectNeedsExactlyOneLib()
    {
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate(["Tc3_MotorLib", "Tc3_AxisLib"], null, null, [], fromProject: true)));
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.ParseUpdate([], null, Vendor, [Plc1], fromProject: true)));
        Assert.Equal([new UpdateItem("Tc3_MotorLib", null)], LibrarySelection.ParseUpdate(["Tc3_MotorLib"], null, null, [], fromProject: true));
    }

    // ------------------------------------------------------------------ ApplyUpdate

    [Fact]
    public void ApplyUpdateSetsSeveralLibraries()
    {
        var changes = LibrarySelection.ApplyUpdate([new("Tc3_MotorLib", "1.3.0"), new("Tc3_Logging", "1.0.0")], [Plc1], null, dryRun: false);
        Assert.Equal(["Tc3_Logging", "Tc3_MotorLib"], changes.Select(c => c.Library).Order());
        var refs = Plc1.References.ToDictionary(r => r.Effective.Name);
        Assert.Equal("1.3.0", refs["Tc3_MotorLib"].Effective.Version);
        Assert.Equal("1.0.0", refs["Tc3_Logging"].Effective.Version);
    }

    [Fact]
    public void ApplyUpdateWritesNothingWhenALaterItemIsInvalid()
    {
        var before = File.ReadAllText(Plc1Path);
        Assert.Equal(ExitCodes.Usage, UsageOf(() =>
            LibrarySelection.ApplyUpdate([new("Tc3_MotorLib", "1.3.0"), new("Tc3_Logging", "1")], [Plc1], null, dryRun: false)));
        Assert.Equal(before, File.ReadAllText(Plc1Path));
    }

    [Fact]
    public void ApplyUpdateWritesNothingWhenAFileCannotBeWritten()
    {
        Assert.SkipUnless(WindowsOnly.IsWindows, "the read-only attribute blocks writing only on Windows");
        var lib = _ws["Machine/MotorLib/MotorLib/MotorLib.plcproj"];
        var before = File.ReadAllText(Plc1Path);
        File.SetAttributes(lib, FileAttributes.ReadOnly);
        try
        {
            var e = Assert.Throws<IECodeException>(() =>
                LibrarySelection.ApplyUpdate([new("Tc3_MotorLib", "1.3.0"), new("Tc3_Logging", "1.1.0")], [Plc1, PlcProjectFile.Load(lib)], null, dryRun: false));
            Assert.Contains("MotorLib.plcproj", e.Message);
            Assert.Equal(before, File.ReadAllText(Plc1Path));
        }
        finally { File.SetAttributes(lib, FileAttributes.Normal); }
    }

    [Fact]
    public void ApplyUpdateDryRunWritesNothing()
    {
        var before = File.ReadAllText(Plc1Path);
        Assert.Equal(2, LibrarySelection.ApplyUpdate([new("Tc3_MotorLib", "1.3.0"), new("Tc3_Logging", "1.0.0")], [Plc1], null, dryRun: true).Count);
        Assert.Equal(before, File.ReadAllText(Plc1Path));
    }

    // ------------------------------------------------------------------ NameMatches / Select / uninstall --all

    private static readonly InstalledLibrary[] Repo =
    [
        new("tc3_axislib", "1.3.1.0", "example", "r/a/1"),
        new("tc3_motorlib", "1.3.1.0", "example", "r/m/1"),
        new("tc3_motorlib", "1.4.0.0", "example", "r/m/2"),
        new("tc2_system", "1.3.1.0", "beckhoff automation gmbh", "r/s/1"),
    ];

    [Theory]
    [InlineData("Tc3_*", "Tc3_MotorLib", true)]
    [InlineData("tc3_motor?ib", "Tc3_MotorLib", true)]
    [InlineData("Tc2_*", "Tc3_MotorLib", false)]
    [InlineData("Tc3_MotorLib", "tc3_motorlib", true)]
    [InlineData("MotorLib", "Tc3_MotorLib", false)]
    public void Wildcards(string p, string n, bool m) => Assert.Equal(m, LibrarySelection.NameMatches(p, n));

    [Fact]
    public void DotIsLiteral() => Assert.False(LibrarySelection.NameMatches("Tc3_Motor.Lib", "Tc3_MotorXLib"));

    [Fact]
    public void SelectByVendorAndVersion() =>
        Assert.Equal(["tc3_axislib", "tc3_motorlib"], LibrarySelection.Select(Repo, null, "Example", "1.3.1.0").Select(i => i.Name).Order());

    [Fact]
    public void SelectByPatternAnyVersion() =>
        Assert.Equal(2, LibrarySelection.Select(Repo, "Tc3_Motor*", null, "all").Count);

    [Fact]
    public void SelectNothingIsEmpty() => Assert.Empty(LibrarySelection.Select(Repo, null, "example", "9.9.9.9"));

    [Fact]
    public void UninstallAllTakesTheNamesFromTheRepository() =>
        Assert.Equal(["tc3_axislib", "tc3_motorlib"], LibrarySelection.UninstallAll(Repo, [], "example", "1.3.1.0").Select(i => i.Name).Order());

    [Fact]
    public void UninstallAllPassesTheInstalledVersionNotTheTypedOne() =>
        Assert.All(LibrarySelection.UninstallAll(Repo, [], "example", "1.3.1"), i => Assert.Equal("1.3.1.0", i.Version));

    [Theory]
    [InlineData("x")]
    [InlineData("1.x")]
    [InlineData("")]
    public void UninstallAllNeedsANumericVersion(string version) =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.UninstallAll(Repo, [], "example", version)));

    [Theory]
    [InlineData("1.3.1.2147483648")]   // overflows int: must not read as 1.3.1.0
    [InlineData("99999999999")]
    public void UninstallAllRejectsAVersionComponentOutOfRange(string version) =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.UninstallAll(Repo, [], "example", version)));

    [Fact]
    public void AMalformedInstalledVersionIsNeverAMatch()
    {
        InstalledLibrary[] repo = [.. Repo, new("tc3_bad", "1.3.1.99999999999", "example", "r/b/1"), new("tc3_bad2", "1.x", "example", "r/b/2")];
        Assert.DoesNotContain(LibrarySelection.Select(repo, null, "example", "1.3.1.0"), i => i.Name.StartsWith("tc3_bad"));
        Assert.DoesNotContain(LibrarySelection.UninstallAll(repo, [], "example", "1.3.1.0"), i => i.Name.StartsWith("tc3_bad"));
    }

    [Fact]
    public void UninstallAllMatchingNothingIsNotFound()
    {
        var e = Assert.Throws<IECodeException>(() => LibrarySelection.UninstallAll(Repo, [], "example", "9.9.9.9"));
        Assert.Equal(ExitCodes.NotFound, e.ExitCode);
        Assert.Contains("no installed library of vendor example at version 9.9.9.9", e.Message);
    }

    [Theory]
    [InlineData("Tc3_MotorLib", "example", "1.3.1.0")]   // names and --all
    [InlineData(null, null, "1.3.1.0")]                  // no vendor
    [InlineData(null, "example", "all")]                 // every version by accident
    public void UninstallAllUsageErrors(string? name, string? vendor, string version) =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.UninstallAll(Repo, name is null ? [] : [name], vendor, version)));

    [Fact]
    public void OneRepositoryIsTaken() => Assert.Equal("A", LibrarySelection.SingleRepository(null, ["A"]));

    [Fact]
    public void AnExplicitRepositoryWins() => Assert.Equal("X", LibrarySelection.SingleRepository("X", ["A", "B"]));

    [Fact]
    public void SeveralRepositoriesNeedAChoice() =>
        Assert.Equal(ExitCodes.Usage, UsageOf(() => LibrarySelection.SingleRepository(null, ["A", "B"])));

    [Fact]
    public void NoRepositoryIsNotFound() =>
        Assert.Equal(ExitCodes.NotFound, UsageOf(() => LibrarySelection.SingleRepository(null, [])));
}
