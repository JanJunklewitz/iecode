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
}
