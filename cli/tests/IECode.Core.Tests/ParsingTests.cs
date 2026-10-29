namespace IECode.Core.Tests;

public class AmsNetIdTests
{
    [Theory]
    [InlineData("5.80.201.232.1.1", "5.80.201.232.1.1")]
    [InlineData("local", "127.0.0.1.1.1")]
    [InlineData(" <Local> ", "127.0.0.1.1.1")]
    public void Parses(string text, string expected) => Assert.Equal(expected, AmsNetId.Parse(text).ToString());

    [Theory]
    [InlineData("1.2.3.4.5")]
    [InlineData("1.2.3.4.5.256")]
    [InlineData("a.b.c.d.e.f")]
    [InlineData("")]
    public void RejectsInvalid(string text)
    {
        var e = Assert.Throws<IECodeException>(() => AmsNetId.Parse(text));
        Assert.Equal(ExitCodes.Usage, e.ExitCode);
    }

    [Fact]
    public void LocalIsLocal() => Assert.True(AmsNetId.Parse("127.0.0.1.1.1").IsLocal);
}

public class TwinCatVersionTests
{
    private static readonly string[] Installed = ["3.1.4024.62", "3.1.4024.66", "3.1.4026.12"];

    [Theory]
    [InlineData("4024", "3.1.4024.66")]
    [InlineData("4024.62", "3.1.4024.62")]
    [InlineData("3.1.4024.62", "3.1.4024.62")]
    [InlineData("4026", "3.1.4026.12")]
    [InlineData("auto", "3.1.4026.12")]
    public void ResolvesNewestMatching(string request, string expected) =>
        Assert.Equal(expected, TwinCatVersion.Parse(request).Resolve(Installed));

    [Fact]
    public void MissingBuildResolvesToNull() => Assert.Null(TwinCatVersion.Parse("4024.70").Resolve(Installed));

    [Theory]
    [InlineData("4.0")]
    [InlineData("TC3")]
    [InlineData("3.1.4024.x")]
    public void RejectsInvalid(string text) => Assert.Throws<IECodeException>(() => TwinCatVersion.Parse(text));

    [Fact]
    public void PicksRepToolProfileForVersion()
    {
        string[] profiles = ["TwinCAT PLC Control", "TwinCAT PLC Control_Build_4024.62", "TwinCAT PLC Control_Build_4024.66", "TwinCAT PLC Control_Build_4026.12"];
        Assert.Equal("TwinCAT PLC Control_Build_4024.66", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Parse("4024")));
        Assert.Equal("TwinCAT PLC Control_Build_4024.62", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Parse("4024.62")));
        Assert.Equal("TwinCAT PLC Control_Build_4026.12", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Auto));
        Assert.Equal("TwinCAT PLC Control", TwinCatVersion.PickRepToolProfile(profiles, TwinCatVersion.Parse("4022")));
    }

    [Theory]
    [InlineData("TwinCAT PLC Control_Build_4024.66.profile", "TwinCAT PLC Control_Build_4024.66")]
    [InlineData("TwinCAT PLC Control_Build_4026.24.profile.xml", "TwinCAT PLC Control_Build_4026.24")]
    [InlineData("TwinCAT PLC Control.xml", null)]
    [InlineData("GLOBAL.dependencies", null)]
    public void ReadsRepToolProfileFileNames(string file, string? expected) =>
        Assert.Equal(expected, TwinCatVersion.RepToolProfileName(file));
}

public class ProtectionSpecTests
{
    [Fact]
    public void ParsesKeyValues()
    {
        var s = ProtectionSpec.Parse("TIPC^PLC1^PLC1 Project^POUs, encrypted=true, signed=false, level=Service");
        Assert.Equal(new ProtectionSpec("TIPC^PLC1^PLC1 Project^POUs", true, false, "Service"), s);
    }

    [Fact]
    public void BareTokenIsTheLevel()
    {
        var s = ProtectionSpec.Parse("TIPC^PLC1^PLC1 Project^POUs,encrypted=True,Service");
        Assert.Equal("Service", s.Level);
        Assert.True(s.Encrypted);
        Assert.Null(s.Signed);
    }

    [Theory]
    [InlineData("TIPC^PLC1")]                       // nothing to change
    [InlineData("encrypted=true")]                   // no item path
    [InlineData("TIPC^PLC1,encrypted=maybe")]        // not a bool
    [InlineData("TIPC^PLC1,colour=red")]             // unknown key
    [InlineData("TIPC^PLC1,Service,Developer")]      // level twice
    public void RejectsInvalid(string text) => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => ProtectionSpec.Parse(text)).ExitCode);
}

public class BuildSummaryTests
{
    [Fact]
    public void ParsesEnglish() =>
        Assert.Equal(new BuildSummary(2, 1, 0, 0),
            BuildSummary.TryParse("...\n========== Build: 2 succeeded, 1 failed, 0 up-to-date, 0 skipped =========="));

    [Fact]
    public void ParsesGerman() =>
        Assert.Equal(new BuildSummary(1, 0, 3, 0),
            BuildSummary.TryParse("========== Erstellen: 1 erfolgreich, 0 fehlerhaft, 3 aktuell, 0 übersprungen =========="));

    [Fact]
    public void TakesTheLastSummary() =>
        Assert.Equal(0, BuildSummary.TryParse("========== Build: 0 succeeded, 1 failed, 0 up-to-date, 0 skipped ==========\n" +
                                               "========== Build: 1 succeeded, 0 failed, 0 up-to-date, 0 skipped ==========")!.Failed);

    [Fact]
    public void ParsesSucceededOrUpToDate() =>
        Assert.Equal(new BuildSummary(1, 2, 0, 0),
            BuildSummary.TryParse("========== Build: 1 succeeded or up-to-date, 2 failed, 0 skipped =========="));

    [Fact]
    public void NoSummaryIsNull() => Assert.Null(BuildSummary.TryParse("Build started..."));
}

public class BuildOutputTests
{
    // Line formats of the TcXaeShell 15 (TwinCAT 3.1.4024) Build pane
    private const string Output =
        "------ Build started: Project: PLC1, Configuration: Debug TwinCAT RT (x64) ------\r\n" +
        "------ Build started: Application: MachineX.PLC1 -------\r\n" +
        "typify code ...\r\n" +
        "PLC1.Library Manager : error: Could not open library '#Tc3_MotorLib'. (Reason: The library 'Tc3_MotorLib, 1.2.0.0 (Example)' has not been installed to the system.)\r\n" +
        "PLC1.Library Manager : warning: Library tc3_motorlib, 1.2.0.0 (example) has not been added to the Library Manager, or no valid license could be found\r\n" +
        "FB_Axis(46) : error: Unknown type: 'Tc3_MotorLib.FB_Motor' [tc3_axislib, 1.0.0.0 (example)]\r\n" +
        @"C:\W\MachineX\PLC1\VISUs\Visu.TcVIS : error: Unknown type: 'Tc3_MotorLib.VI_Motor__vis'" + "\r\n" +
        @"C:\W\MachineX\PLC1\POUs\FB_Motor.TcPOU;FB_Motor\M_Start(4) : error: C0077: Unknown type: 'fSped'" + "\r\n" +
        @"C:\W\MachineX\PLC1\POUs\FB_Motor.TcPOU(47) : message: Related Position" + "\r\n" +
        "PLC.PLC1 : message: generate boot information...\r\n" +
        "Compile complete -- 3 errors, 1 warnings\r\n" +
        "Build complete -- 3 errors, 1 warnings : no download possible!\r\n" +
        "------ Build started: Project: MachineX, Configuration: Debug TwinCAT RT (x64) ------\r\n" +
        "Error: The operation could not be completed. Unbekannter Fehler \r\n" +
        "========== Build: 1 succeeded or up-to-date, 2 failed, 0 skipped ==========\r\n";

    private static readonly List<Diagnostic> Parsed = BuildOutput.Parse(Output);

    [Fact]
    public void FindsErrorsAndWarningsButNotMessagesOrSummaries()
    {
        Assert.Equal(5, Parsed.Count(d => d.Severity == Severity.Error));
        Assert.Equal(1, Parsed.Count(d => d.Severity == Severity.Warning));
        Assert.Equal(6, Parsed.Count);
    }

    [Fact]
    public void LibraryManagerKeepsItsOrigin()
    {
        var d = Parsed[0];
        Assert.StartsWith("PLC1.Library Manager: Could not open library '#Tc3_MotorLib'.", d.Message);
        Assert.Null(d.File);
        Assert.Equal("PLC1", d.Project);
    }

    [Fact]
    public void ObjectWithLine() =>
        Assert.Equal(new Diagnostic(Severity.Error, "FB_Axis: Unknown type: 'Tc3_MotorLib.FB_Motor' [tc3_axislib, 1.0.0.0 (example)]",
            Project: "PLC1", Line: 46), Parsed[2]);

    [Fact]
    public void FileWithoutLine() =>
        Assert.Equal(new Diagnostic(Severity.Error, "Unknown type: 'Tc3_MotorLib.VI_Motor__vis'",
            File: @"C:\W\MachineX\PLC1\VISUs\Visu.TcVIS", Project: "PLC1"), Parsed[3]);

    [Fact]
    public void FileWithObjectLineAndCode() =>
        Assert.Equal(new Diagnostic(Severity.Error, @"FB_Motor\M_Start: Unknown type: 'fSped'", "C0077",
            @"C:\W\MachineX\PLC1\POUs\FB_Motor.TcPOU", "PLC1", 4), Parsed[4]);

    [Fact]
    public void BareErrorBelongsToTheNextProject()
    {
        Assert.Equal("The operation could not be completed. Unbekannter Fehler", Parsed[5].Message);
        Assert.Equal("MachineX", Parsed[5].Project);
    }

    [Fact]
    public void LibraryManagerBelongsToItsProjectEvenBeforeItsHeader()
    {
        var d = BuildOutput.Parse(
            "------ Build started: Project: PLC2, Configuration: Debug TwinCAT RT (x64) ------\r\n" +
            "PLC1.Library Manager : error: Could not open library '#Tc3_MotorLib'.\r\n" +
            "------ Build started: Project: PLC1, Configuration: Debug TwinCAT RT (x64) ------\r\n");
        Assert.Equal("PLC1", Assert.Single(d).Project);
    }

    [Fact]
    public void SplitsCode() => Assert.Equal(("C0032", "Cannot convert type"), BuildOutput.SplitCode("C0032: Cannot convert type"));
}
