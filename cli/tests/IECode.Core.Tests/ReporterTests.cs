using System.Text.Json;

namespace IECode.Core.Tests;

public class ReporterTests
{
    private const string RootCauseText =
        "PLC1.Library Manager: Could not open library 'X'. (Reason: The library 'X, 1.0.0.0 (Example)' has not been installed to the system.)";

    private static Reporter Human(out StringWriter err)
    {
        err = new StringWriter();
        var r = new Reporter(json: false, verbose: false, stdout: new StringWriter(), stderr: err);
        r.DisableColor();
        return r;
    }

    private static Triage Errors(params string[] messages) =>
        BuildTriage.Classify([.. messages.Select(m => new Diagnostic(Severity.Error, m, Project: "PLC1"))]);

    [Fact]
    public void PrintsOnlyTheFirstErrorsAndCountsTheRest()
    {
        var r = Human(out var err); r.MaxErrors = 2;
        r.Report(Errors("e1", "e2", "e3", "e4", "e5"), failed: true);
        var text = err.ToString();
        Assert.Contains("e2", text); Assert.DoesNotContain("e3", text);
        Assert.Contains("3 more error(s) not shown (--max-errors 0 shows all)", text);
        Assert.Equal(5, r.Diagnostics.Count);
    }

    [Fact]
    public void ZeroMeansUnlimited()
    {
        var r = Human(out var err); r.MaxErrors = 0;
        r.Report(Errors("e1", "e2", "e3"), failed: true);
        Assert.Contains("e3", err.ToString());
        Assert.DoesNotContain("not shown", err.ToString());
    }

    [Fact]
    public void RootCausesArePrintedFirstAndEvenBeyondTheLimit()
    {
        var r = Human(out var err); r.MaxErrors = 1;
        r.Report(Errors("e1", "e2 [x, 1.0.0.0 (example)]", RootCauseText), failed: true);
        var text = err.ToString();
        Assert.Contains("Root causes", text);
        Assert.True(text.IndexOf("has not been installed", StringComparison.Ordinal) < text.IndexOf("e1", StringComparison.Ordinal));
        Assert.Contains("Follow-up errors", text);
        Assert.Contains("x, 1.0.0.0 (example)", text);
        Assert.Single(text.Split('\n'), l => l.Contains("has not been installed"));
    }

    [Fact]
    public void CountResetsPerBuild()
    {
        var r = Human(out var err); r.MaxErrors = 1;
        r.Report(Errors("a1", "a2"), failed: true);
        r.Report(Errors("b1", "b2"), failed: true);
        var text = err.ToString();
        Assert.Contains("b1", text);
        Assert.DoesNotContain("b2", text);
    }

    [Theory]
    [InlineData(false, 50)]
    [InlineData(true, 0)]
    public void RedirectedDefaultIsUnlimited(bool redirected, int expected) =>
        Assert.Equal(expected, Reporter.DefaultMaxErrors(redirected));

    [Fact]
    public void StaticAnalysisOnlyHasItsOwnLine()
    {
        var r = Human(out var err);
        r.Report(BuildTriage.Classify([
            new Diagnostic(Severity.Error, "name already used", "SA0027"),
            new Diagnostic(Severity.Error, "name already used again", "SA0027"),
            new Diagnostic(Severity.Error, "unused variable", "SA0033")]), failed: true);
        Assert.Contains("Build failed only on static analysis: 3 finding(s) (SA0027, SA0033).", err.ToString());
    }

    [Fact]
    public void GenericLineAloneSaysNoCompilerErrors()
    {
        var r = Human(out var err);
        r.Report(Errors("The operation could not be completed. Unbekannter Fehler"), failed: true);
        Assert.Contains("No compiler errors; see the shell output (-v).", err.ToString());
    }

    [Fact]
    public void JsonKeepsAllDiagnosticsAndMarksRootCauses()
    {
        var stdout = new StringWriter();
        var r = new Reporter(json: true, verbose: false, stdout: stdout, stderr: new StringWriter()) { MaxErrors = 1 };
        r.Report(Errors("e1", "e2", RootCauseText), failed: true);
        r.Finish("build", 10, null);
        using var doc = JsonDocument.Parse(stdout.ToString());
        var diags = doc.RootElement.GetProperty("diagnostics").EnumerateArray().ToList();
        Assert.Equal(3, diags.Count);
        Assert.True(diags[2].GetProperty("rootCause").GetBoolean());
        Assert.False(diags[0].TryGetProperty("rootCause", out _));
    }
}

public class BuildOutcomeTests
{
    [Fact]
    public void CheckWithOnlyTheGenericLineStillFails() =>
        Assert.False(BuildOutcome.Ok(0, [new Diagnostic(Severity.Error, "The operation could not be completed. Unbekannter Fehler")], null));

    [Fact]
    public void FailedProjectsFailEvenWithoutErrors() =>
        Assert.False(BuildOutcome.Ok(1, [], null));

    [Fact]
    public void SummaryFailureFails() =>
        Assert.False(BuildOutcome.Ok(0, [], new BuildSummary(1, 1, 0, 0)));

    [Fact]
    public void WarningsAloneAreOk() =>
        Assert.True(BuildOutcome.Ok(0, [new Diagnostic(Severity.Warning, "w")], new BuildSummary(2, 0, 0, 0)));

    [Fact]
    public void ExitCodeIsBuildFailedWhenAnyBuildFailed()
    {
        Assert.Equal(ExitCodes.Ok, BuildOutcome.ExitCode([true, true]));
        Assert.Equal(ExitCodes.BuildFailed, BuildOutcome.ExitCode([true, false]));
        Assert.Equal(ExitCodes.Ok, BuildOutcome.ExitCode([]));
    }
}
