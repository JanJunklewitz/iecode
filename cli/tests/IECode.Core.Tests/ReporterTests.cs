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
    public void MapDiagnosticRewritesEveryRecordedDiagnostic()
    {
        var r = Human(out var err);
        r.MapDiagnostic = d => d with { File = d.File?.Replace("copy", "source") };
        var ds = new[] { new Diagnostic(Severity.Error, RootCauseText, File: "copy/a.TcPOU", Project: "PLC1"), new Diagnostic(Severity.Error, "e", File: "copy/b.TcPOU") };
        r.Report(BuildTriage.Classify(ds), failed: true);
        r.Add(new Diagnostic(Severity.Warning, "w", File: "copy/c.TcPOU"));
        Assert.Equal(["source/a.TcPOU", "source/b.TcPOU", "source/c.TcPOU"], r.Diagnostics.Select(d => d.File).Order());
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

    [Fact]
    public void ErrorResultKeepsThePartialDataTheCommandRecorded()
    {
        var stdout = new StringWriter();
        var r = new Reporter(json: true, verbose: false, stdout: stdout, stderr: new StringWriter()) { PartialData = new { changedFiles = new[] { "a.TcPOU" } } };
        r.Finish("build", 17, null, "Timed out");
        using var doc = JsonDocument.Parse(stdout.ToString());
        Assert.Equal("a.TcPOU", doc.RootElement.GetProperty("data").GetProperty("changedFiles")[0].GetString());
        Assert.Equal("Timed out", doc.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public void PartialDataNeverReplacesTheResultOfASuccessfulCommand()
    {
        var stdout = new StringWriter();
        var r = new Reporter(json: true, verbose: false, stdout: stdout, stderr: new StringWriter()) { PartialData = new { stale = 1 } };
        r.Finish("build", 0, new { fresh = 1 });
        using var doc = JsonDocument.Parse(stdout.ToString());
        Assert.True(doc.RootElement.GetProperty("data").TryGetProperty("fresh", out _));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LinesFromSeveralThreadsAreAllKept(bool json)
    {
        // the dialog watcher logs from its own thread while the command thread logs too
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        var r = new Reporter(json, verbose: false, stdout: stdout, stderr: stderr);
        r.DisableColor();
        const int perThread = 3000;
        var threads = Enumerable.Range(0, 4).Select(i => new Thread(() =>
        {
            for (var n = 0; n < perThread; n++)
            {
                r.Warn($"t{i} line {n}");
                r.Add(new Diagnostic(Severity.Info, $"t{i} d{n}", null, null, null, null, null));
            }
        })).ToList();
        threads.ForEach(t => t.Start());
        threads.ForEach(t => t.Join());
        Assert.Equal(4 * perThread, r.Diagnostics.Count);
        if (json)
        {
            r.Finish("x", 0, null);
            using var doc = JsonDocument.Parse(stdout.ToString());
            Assert.Equal(4 * perThread, doc.RootElement.GetProperty("messages").GetArrayLength());
        }
        else Assert.Equal(4 * perThread, stderr.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
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

public class ExitCodeHelpTests
{
    [Fact]
    public void EveryExitCodeHasADescription()
    {
        var codes = typeof(ExitCodes).GetFields().Where(f => f.IsLiteral && f.FieldType == typeof(int)).Select(f => (int)f.GetRawConstantValue()!).ToList();
        var listed = System.Text.RegularExpressions.Regex.Matches(ExitCodes.HelpText, @"(?<=[:,] )(\d+) ").Select(m => int.Parse(m.Groups[1].Value)).ToList();
        Assert.Equal(codes.Order(), listed.Order());
    }
}
