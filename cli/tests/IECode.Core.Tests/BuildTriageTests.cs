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
