namespace IECode.Core.Tests;

public class BuildTriageTests
{
    private static Triage T(string output) => BuildTriage.Classify(BuildOutput.Parse(output));

    [Fact]
    public void LibraryManagerErrorIsARootCause()
    {
        var t = T(BuildOutputTests.Output);
        var root = Assert.Single(t.RootCauses);
        Assert.Contains("Tc3_MotorLib, 1.2.0.0 (Example)", root.Message);
        Assert.True(root.RootCause);
        Assert.True(t.All.Single(d => d.Message == root.Message).RootCause);
    }

    [Fact]
    public void LibraryManagerWarningIsNotARootCause() =>
        Assert.DoesNotContain(T(BuildOutputTests.Output).RootCauses, d => d.Severity == Severity.Warning);

    // TcXaeShell 4024.66, a used type of a library that is not installed: the library manager only warns
    private const string WarningOnlyLog =
        "------ Build started: Project: PLC, Configuration: Debug TwinCAT RT (x64) ------\r\n" +
        "PLC.Library Manager : warning: Library tc3_motorlib, 1.2.0.0 (example) has not been added to the Library Manager, or no valid license could be found\r\n" +
        "MAIN(15) : error: Unknown type: 'Tc3_MotorLib.FB_Motor'\r\n" +
        "Fehler: Der Vorgang konnte nicht abgeschlossen werden. Unbekannter Fehler\r\n";

    [Fact]
    public void LibraryManagerWarningIsTheRootCauseWhenNoErrorNamesOne()
    {
        var t = T(WarningOnlyLog);
        var root = Assert.Single(t.RootCauses);
        Assert.Equal(Severity.Warning, root.Severity);
        Assert.Contains("tc3_motorlib, 1.2.0.0 (example)", root.Message);
        Assert.Equal(1, t.Errors);
        Assert.Equal([new FollowUpGroup("project PLC", 1)], t.FollowUps);
    }

    [Fact]
    public void LibraryManagerWarningOfABuildWithoutErrorsIsNoRootCause() =>
        Assert.Empty(T(WarningOnlyLog.Replace("MAIN(15) : error:", "MAIN(15) : warning:").Replace("Fehler: Der Vorgang", "Info")).RootCauses);

    [Fact]
    public void RootCauseFromTextWithoutOrigin()
    {
        var d = new Diagnostic(Severity.Error, "Library 'Tc2_MC2_Camming, 3.3.15.0' is not installed", Project: "PLC1");
        Assert.Single(BuildTriage.Classify([d]).RootCauses);
    }

    [Fact]
    public void FollowUpsAreGroupedByLibrarySuffix()
    {
        var t = T(BuildOutputTests.Output);
        Assert.Contains(new FollowUpGroup("tc3_axislib, 1.0.0.0 (example)", 1), t.FollowUps);
        Assert.Contains(new FollowUpGroup("project PLC1", 2), t.FollowUps);
        Assert.Equal(2, t.FollowUps.Count);
    }

    [Fact]
    public void GenericLastLineIsNotCounted()
    {
        var t = T(BuildOutputTests.Output);
        Assert.Equal(4, t.Errors);   // 5 parsed errors minus the generic line
        Assert.Equal(Severity.Info, t.All.Single(d => d.Message.StartsWith("The operation could not be completed")).Severity);
    }

    [Theory]
    [InlineData("Error: The operation could not be completed. Unbekannter Fehler")]
    [InlineData("Fehler: Der Vorgang konnte nicht abgeschlossen werden. Unbekannter Fehler")]
    // TcXaeShell 4026.28 ends a failed build with this line instead
    [InlineData("Fehler: Beim Aufruf einer COM-Komponente wurde ein HRESULT E_FAIL-Fehler zurückgegeben.")]
    [InlineData("Error: Error HRESULT E_FAIL has been returned from a call to a COM component.")]
    public void GenericLineAloneStillFails(string line)
    {
        var t = T(line);
        Assert.Equal(0, t.Errors);
        Assert.Empty(t.RootCauses);
        Assert.False(t.StaticAnalysisOnly);
    }

    [Fact]
    public void StaticAnalysisOnly()
    {
        var sa = new Diagnostic(Severity.Error, "object name already used in a referenced library", "SA0027", Project: "PLC1");
        Assert.True(BuildTriage.Classify([sa]).StaticAnalysisOnly);
        Assert.False(BuildTriage.Classify([sa, sa with { Code = "C0077" }]).StaticAnalysisOnly);
        Assert.False(BuildTriage.Classify([]).StaticAnalysisOnly);
    }

    [Fact]
    public void LibraryManagerLinesFromThePaneAreMerged()
    {
        var errorList = new List<Diagnostic> { new(Severity.Error, "Unknown type: 'FB_Motor'", "C0077", Project: "PLC1") };
        var merged = BuildTriage.Merge(errorList, BuildOutput.Parse(BuildOutputTests.Output));
        Assert.Equal(3, merged.Count);   // the Error List item plus the library manager error and warning
        Assert.Contains(merged, d => d.Message.StartsWith("PLC1.Library Manager: Could not open library"));
        Assert.DoesNotContain(merged, d => d.Message.StartsWith("FB_Axis"));
    }

    [Fact]
    public void SameLineFromTwoSourcesOnce()
    {
        const string text = "Could not open library '#Tc3_MotorLib'.";
        var errorList = new List<Diagnostic> { new(Severity.Error, text, Project: "PLC1") };
        var pane = new List<Diagnostic> { new(Severity.Error, $"PLC1.Library Manager: {text}", Project: "PLC1") };
        Assert.Single(BuildTriage.Merge(errorList, pane));
    }

    [Fact]
    public void SameTextInTwoProjectsTwice()
    {
        const string text = "Could not open library '#Tc3_MotorLib'.";
        var errorList = new List<Diagnostic> { new(Severity.Error, text, Project: "PLC1") };
        var pane = new List<Diagnostic> { new(Severity.Error, $"PLC2.Library Manager: {text}", Project: "PLC2") };
        Assert.Equal(2, BuildTriage.Merge(errorList, pane).Count);
    }
}
