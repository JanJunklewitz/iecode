# Plan A: Failure Output and Pre-flight Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed build shows the missing library first, and `iecode lib check` finds missing library versions before any build.

**Architecture:** New pure class `BuildTriage` in `IECode.Core` classifies diagnostics (root cause, follow-up per library, noise, static analysis). `Restore` gains a check that also covers `*` references. `Reporter` gets a print limit. CLI commands only call these.

**Tech Stack:** C# .NET 10, xUnit v3 (Microsoft Testing Platform), System.CommandLine.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) sections 3, 4, 7 and answers Q6, Q8, Q9; master plan [decisions 1 to 4](2026-11-24-cli-build-workflow-master-plan.md#decisions-planner-2026-11-24-the-user-delegated-every-decision).

## Eng review amendments (2026-11-24)

The [master plan table](2026-11-24-cli-build-workflow-master-plan.md#eng-review-amendments-2026-11-24) wins over the task text below:
- **Task 1 (R21):** `XaeShell.Build` and `CheckAllObjects` always also parse the Build pane for `.Library Manager` lines, even when the Error List was read, and merge them (dedupe by message). Test `LibraryManagerLinesFromThePaneAreMerged` with a Core helper `BuildTriage.Merge(IReadOnlyList<Diagnostic> errorList, IReadOnlyList<Diagnostic> pane)`.
- **Task 3 (R2):** no `StaticAnalysisFailed = 21`; exit stays 10. `BuildResult.StaticAnalysisOnly` goes into JSON `builds[]` and the summary line. Drop the `Errors.cs` change.
- **Task 3 (R18, R25):** pre-flight logic moves into Core `Preflight.Problems(IEnumerable<PlcProjectFile> projects, IReadOnlyList<InstalledLibrary> installed, ISet<string> workspaceLibraries)`; `ws build` passes the titles of libraries it builds itself. Exit aggregation moves into `BuildOutcome.ExitCode(...)`. Both get tests.
- **Task 3 (R19, R20):** `Reporter.BeginBuild()` resets the printed counts per build; `MaxErrors` default is 50 on a console and 0 (unlimited) when stderr is redirected. Tests `CountResetsPerBuild`, `RedirectedDefaultIsUnlimited` (the default decision as a pure function `Reporter.DefaultMaxErrors(bool errorRedirected)`).
- **Task 4 (R28):** generate the exit code help line from the `ExitCodes` constants (reflection) plus a description table; test `EveryExitCodeHasADescription`.
- **Task 5 (R21):** add a 4026 run (Error List path) to steps 1 and 2.

**Second opinion (R36 to R39, R43, R44):** exit code and `ok` from the raw signals, triage only for display (Task 3 test `CheckWithOnlyTheGenericLineStillFails`); print root causes before the list, merge by (project, message without origin prefix) with tests `SameLineFromTwoSourcesOnce` and `SameTextInTwoProjectsTwice` (Tasks 1, 3); `Restore.Check` groups by name, version and vendor, `ws build` skips exact identities only, a failed scan says "not checked" (Tasks 2, 3); new Task 6 for the extension (root causes first, static-analysis text, keep Problems when the CLI stopped before building); Task 4 keeps the literal help text plus a reflection test; CI smoke for `lib check --json`; Task 5 on 4026 builds two platforms, the first failing.

## Global Constraints

See the [master plan](2026-11-24-cli-build-workflow-master-plan.md#global-constraints). In short: public repo, example names only; `dotnet build` and `dotnet test` as separate PowerShell calls; additive JSON; CHANGELOG and README rows.

## Review Focus

1. **Error List path without origin**: `ReadErrorList` gives the library manager message without the `PLC1.Library Manager:` prefix. Root-cause detection must still work from the text alone (Task 1 test `RootCauseFromTextWithoutOrigin`).
2. **German shell**: the same library manager error in a German XAE. The exact German text is not known; detection by origin prefix covers the Build pane, and the English texts cover the Error List. Task 1 adds the German origin form (`Bibliotheksverwalter`) only if Task 5 step 1 finds it in a real log; otherwise it is listed under known limits.
3. **A build that fails with zero errors after the noise filter** (only the generic "operation could not be completed" line): the exit code stays 10 because `failedProjects > 0`, and the summary says "no compiler errors; see the shell output (`-v`)" (Task 3 test `GenericLineAloneStillFails` in `BuildTriageTests`).
4. **`*` reference whose library exists under another vendor spelling** (case): vendor and name compare case-insensitively (Task 2 test `StarReferenceMatchesCaseInsensitively`).
5. **Several repositories (4024 and 4026 on one PC)**: a version installed in only one of them is not reported (Task 2 test `VersionInAnyRepositoryIsNotMissing`).

---

### Task 1: Classify diagnostics (`BuildTriage`)

**Files:**
- Create: `cli/src/IECode.Core/BuildTriage.cs`
- Modify: `cli/src/IECode.Core/Diagnostics.cs` (record `Diagnostic`: add last optional parameter `bool? RootCause = null`)
- Test: `cli/tests/IECode.Core.Tests/BuildTriageTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record FollowUpGroup(string Key, int Errors);` (`Key` = the bracket suffix text such as `tc3_axislib, 1.0.0.0 (example)`, else `project <name>`, else `other`)
  - `public sealed record Triage(IReadOnlyList<Diagnostic> All, IReadOnlyList<Diagnostic> RootCauses, IReadOnlyList<FollowUpGroup> FollowUps, bool StaticAnalysisOnly, int Errors);`
  - `public static class BuildTriage { public static Triage Classify(IReadOnlyList<Diagnostic> diagnostics); }`
  - `All` is the input with `RootCause = true` set on root causes and the generic noise line turned into `Severity.Info`; `Errors` counts errors in `All`.

- [ ] **Step 1: Write the failing tests** (reuse the `Output` text of `BuildOutputTests`; make it `internal` there or copy it)

```csharp
public class BuildTriageTests
{
    private static Triage T(string output) => BuildTriage.Classify(BuildOutput.Parse(output));

    [Fact] public void LibraryManagerErrorIsARootCause()
    {
        var t = T(BuildOutputTests.Output);
        var root = Assert.Single(t.RootCauses);
        Assert.Contains("Tc3_MotorLib, 1.2.0.0 (Example)", root.Message);
        Assert.True(root.RootCause);
    }

    [Fact] public void LibraryManagerWarningIsNotARootCause() =>
        Assert.DoesNotContain(T(BuildOutputTests.Output).RootCauses, d => d.Severity == Severity.Warning);

    [Fact] public void RootCauseFromTextWithoutOrigin()
    {
        var d = new Diagnostic(Severity.Error, "Library 'Tc2_MC2_Camming, 3.3.15.0' is not installed", Project: "PLC1");
        Assert.Single(BuildTriage.Classify([d]).RootCauses);
    }

    [Fact] public void FollowUpsAreGroupedByLibrarySuffix()
    {
        var t = T(BuildOutputTests.Output);
        Assert.Contains(new FollowUpGroup("tc3_axislib, 1.0.0.0 (example)", 1), t.FollowUps);
        Assert.Contains(new FollowUpGroup("project PLC1", 2), t.FollowUps);
    }

    [Fact] public void GenericLastLineIsNotCounted()
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
    }

    [Fact] public void StaticAnalysisOnly()
    {
        var sa = new Diagnostic(Severity.Error, "object name already used in a referenced library", "SA0027", Project: "PLC1");
        Assert.True(BuildTriage.Classify([sa]).StaticAnalysisOnly);
        Assert.False(BuildTriage.Classify([sa, sa with { Code = "C0077" }]).StaticAnalysisOnly);
        Assert.False(BuildTriage.Classify([]).StaticAnalysisOnly);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*BuildTriageTests"`
Expected: build error, `BuildTriage` not defined.

- [ ] **Step 3: Implement `BuildTriage.Classify(IReadOnlyList<Diagnostic>) -> Triage`**

Root cause = `Severity.Error` and (message starts with a `<x>.Library Manager:` prefix, or matches one of these case-insensitive patterns):
`has not been installed`, `is not installed`, `could not be found` together with `library`, `no valid license`. Generic noise = message matches `^(The operation could not be completed|Der Vorgang konnte nicht abgeschlossen werden)`. Follow-up key = trailing `\[(?<k>[^\]]+)\]\s*$` group, else `project <Project>`, else `other`; root causes and noise are not follow-ups. `StaticAnalysisOnly` = at least one error and every error has a code starting with `SA`.

- [ ] **Step 4: Run to verify they pass**

Run: the two commands of step 2. Expected: all `BuildTriageTests` pass, `BuildOutputTests` still pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/IECode.Core/BuildTriage.cs cli/src/IECode.Core/Diagnostics.cs cli/tests/IECode.Core.Tests/
git commit -s -m "Classify build diagnostics into root causes and follow-ups" -m "A missing library produced hundreds of follow-up errors that hid the one real message; the triage is pure so both the Error List and the Build pane path use it."
```

### Task 2: Reference check (`Restore.Check`) and `iecode lib check`

**Files:**
- Modify: `cli/src/IECode.Core/Projects/Restore.cs`
- Modify: `cli/src/IECode.Core/Projects/LibraryRepository.cs` (add `ScanAll`)
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (new `Check()` command, registered in `Create()`)
- Test: `cli/tests/IECode.Core.Tests/ProjectTests.cs` (new class `ReferenceCheckTests` in the same file or a new `ReferenceCheckTests.cs`)

**Interfaces:**
- Produces:
  - `public enum ReferenceProblemKind { VersionMissing, NoVersionInstalled }`
  - `public sealed record ReferenceProblem(string Name, string Version, string Vendor, ReferenceProblemKind Kind, IReadOnlyList<string> Projects);` (`Version` is `*` for `NoVersionInstalled`)
  - `public static IReadOnlyList<ReferenceProblem> Restore.Check(IEnumerable<PlcProjectFile> projects, IReadOnlyList<InstalledLibrary> installed)`
  - `public static IReadOnlyList<InstalledLibrary> LibraryRepository.ScanAll(IEnumerable<string> roots)` (skips roots that do not exist; empty list if none exists)
  - CLI: `iecode lib check [paths…] [--repository <dir>]…` (repeatable; default: every existing entry of `LibraryRepository.Candidates`), exit 0 or 3, JSON `data.problems`.

- [ ] **Step 1: Write the failing tests** (build the fixture with `TempWorkspace`; a `.plcproj` with one pinned `PlaceholderResolution` `Tc3_MotorLib, 1.2.0.0 (Example)` and one `*` reference `Tc3_AxisLib, * (Example)`)

```csharp
[Fact] public void PinnedVersionMissing() =>
    Assert.Equal(ReferenceProblemKind.VersionMissing,
        Assert.Single(Restore.Check([project], [Installed("Tc3_AxisLib", "1.0.0.0")]), p => p.Name == "Tc3_MotorLib").Kind);

[Fact] public void StarReferenceWithoutAnyVersion() =>
    Assert.Contains(Restore.Check([project], [Installed("Tc3_MotorLib", "1.2.0.0")]),
        p => p is { Name: "Tc3_AxisLib", Version: "*", Kind: ReferenceProblemKind.NoVersionInstalled });

[Fact] public void StarReferenceMatchesCaseInsensitively() =>
    Assert.Empty(Restore.Check([project], [Installed("tc3_motorlib", "1.2.0.0", "example"), Installed("tc3_axislib", "0.9.0.0", "example")]));

[Fact] public void VersionInAnyRepositoryIsNotMissing()
{
    // two repository folders under the TempWorkspace, the pinned version only in the second
    var all = LibraryRepository.ScanAll([repo4024, repo4026, ws["does-not-exist"]]);
    Assert.DoesNotContain(Restore.Check([project], all), p => p.Name == "Tc3_MotorLib");
}
```

`Installed(name, version, vendor = "Example")` is a local helper building `InstalledLibrary` with a dummy path.

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ReferenceCheckTests"`
Expected: build error, `Restore.Check` not defined.

- [ ] **Step 3: Implement `Restore.Check` and `LibraryRepository.ScanAll`**

`Check` reuses the pinned grouping of `Plan` (extract it into a private helper so `Plan` keeps its behaviour); a `*` reference is a problem when `LibraryRepository.Newest(installed, name, vendor)` is null. Sort by name. Then the `lib check` command in `LibraryCommands.cs`: load projects like `Restore()`, print one line per problem (`✖ Tc3_MotorLib 1.2.0.0 (Example) not installed · used by PLC1` / `✖ Tc3_AxisLib * (Example): no version installed`), print the scanned repository folders with `-v`, exit 3 on problems.

- [ ] **Step 4: Run to verify they pass**

Run: the two commands of step 2. Expected: pass; existing `Restore` tests unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add cli/src/IECode.Core/Projects/ cli/src/IECode.Cli/Commands/LibraryCommands.cs cli/tests/IECode.Core.Tests/
git commit -s -m "Add iecode lib check for missing library versions" -m "lib restore --dry-run already found missing pinned versions but nobody looked for a check under that name; the new command also reports star references with no installed version and looks in every library repository of the PC."
```

### Task 3: Print limit and the root-cause block in `build`, `check` and `ws build`

**Files:**
- Modify: `cli/src/IECode.Core/Reporter.cs` (print limit and `Triage` summary)
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`Build` and `CheckAllObjects` classify before `_log.Add`)
- Modify: `cli/src/IECode.Cli/Globals.cs` (`--max-errors`, `Option<int>`, default 50, recursive)
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs`, `WorkspaceCommands.cs` (exit 10 with `staticAnalysisOnly`, pre-flight call, summary)
- Test: `cli/tests/IECode.Core.Tests/ReporterTests.cs` (new)

**Interfaces:**
- Consumes: `BuildTriage.Classify`, `Triage` (Task 1); `Restore.Check`, `LibraryRepository.ScanAll` (Task 2).
- Produces:
  - `Reporter.MaxErrors { get; set; }` (`int`, `0` = unlimited) and `Reporter.Summarize(Triage t)` (human mode only; prints nothing in JSON mode)
  - `BuildResult` gains `bool StaticAnalysisOnly` (last positional parameter)

- [ ] **Step 1: Write the failing tests** (construct `Reporter(json: false, verbose: false, stdout: out, stderr: err)` with `StringWriter`s)

```csharp
[Fact] public void PrintsOnlyTheFirstErrorsAndCountsTheRest()
{
    var r = Human(out var err); r.MaxErrors = 2;
    foreach (var i in Enumerable.Range(1, 5)) r.Add(new Diagnostic(Severity.Error, $"e{i}"));
    r.Summarize(BuildTriage.Classify(r.Diagnostics));
    var text = err.ToString();
    Assert.Contains("e2", text); Assert.DoesNotContain("e3", text);
    Assert.Contains("3 more error(s) not shown (--max-errors 0 shows all)", text);
}

[Fact] public void RootCausesArePrintedEvenBeyondTheLimit()
{
    var r = Human(out var err); r.MaxErrors = 1;
    r.Add(new Diagnostic(Severity.Error, "e1"));
    r.Add(new Diagnostic(Severity.Error, "PLC1.Library Manager: Could not open library 'X'. (Reason: The library 'X, 1.0.0.0 (Example)' has not been installed to the system.)", Project: "PLC1"));
    r.Summarize(BuildTriage.Classify(r.Diagnostics));
    Assert.Contains("Root causes", err.ToString());
    Assert.Contains("has not been installed", err.ToString());
}

[Fact] public void JsonKeepsAllDiagnosticsAndMarksRootCauses()
{
    var r = new Reporter(json: true, verbose: false, stdout: new StringWriter(), stderr: new StringWriter()) { MaxErrors = 1 };
    // add 3 errors, one of them a root cause; Finish; parse stdout
    // Assert: diagnostics.Length == 3; the root cause has "rootCause": true; the others have no rootCause field
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ReporterTests"`
Expected: build error, `MaxErrors` not defined.

- [ ] **Step 3: Implement**

- `Reporter.Add` keeps every diagnostic, prints errors only while the printed error count is below `MaxErrors` (warnings follow the same limit separately).
- `Reporter.Summarize`: when there are root causes, print a block `Root causes:` with each one (`✖`), then `Follow-up errors:` with one line per `FollowUpGroup` (`  12  tc3_axislib, 1.0.0.0 (example)`), then the "more not shown" line. With `StaticAnalysisOnly` print `Build failed only on static analysis: <n> finding(s) (<codes, distinct, comma-separated>).` With zero errors after triage on a failed build print `No compiler errors; see the shell output (-v).`
- In `XaeShell.Build` / `CheckAllObjects`: `var triage = BuildTriage.Classify(diags); foreach (var d in triage.All) _log.Add(d);` and use `triage.Errors` for the counts and `ok`. Keep `ok` false when `failedProjects > 0`.
- `ProjectCommands.Build`: before `WithShell`, load the solution's PLC projects (`SolutionFile.Load(path).PlcProjects`), run `Restore.Check` against `LibraryRepository.ScanAll(LibraryRepository.Candidates(TWINCAT3DIR, ProgramData))` and print each problem as a warning plus the hint `iecode lib check` (never fail; skip silently when no repository exists). After the build call `ctx.Log.Summarize(...)`. Exit code: as before (10); `staticAnalysisOnly` goes into JSON (R2). Same summary in `check` and `ws build`.
- `Globals`: add `MaxErrors` and set `log.MaxErrors` in `Runner.Run`.

- [ ] **Step 4: Run all Core tests**

Run: `dotnet build cli/IECode.slnx` then `dotnet test --solution cli/IECode.slnx`
Expected: all green (the Automation project only compiles the change).

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Show root causes first and limit printed build errors" -m "The library manager message was one line among hundreds; it is now repeated in a summary block, follow-ups are counted per library, and a static-analysis-only failure gets its own exit code so scripts can tell it from a compile error."
```

### Task 4: Exit codes in `--help`, README and CHANGELOG

**Files:**
- Modify: `cli/src/IECode.Cli/Program.cs` (root description)
- Modify: `cli/README.md` (command table: `lib check`; global options: `--max-errors`)
- Modify: `extension/CHANGELOG.md` (`## Unreleased`)
- Test: none (text only); verified by step 2.

- [ ] **Step 1: Append to the root command description** a compact exit code list generated from `ExitCodes` (one line: `Exit codes: 0 ok, 1 failed, 2 usage, 3 not found, 10 build failed, 11 activation, 12 library, 13 protection, 14 user management, 15 TwinCAT version missing, 16 target, 17 timeout, 18 IO links changed, 19 ADS interface changed, 20 needs Windows, 99 unexpected, 130 cancelled.`). Keep it as one constant string next to `ExitCodes` (`ExitCodes.HelpText`) so README and code are compared in review.

- [ ] **Step 2: Verify**

Run: `dotnet run --project cli/src/IECode.Cli -- --help`
Expected: the exit code line is shown; `iecode lib check --help` lists `--repository`.

- [ ] **Step 3: Commit**

```bash
git add cli/src/IECode.Cli/Program.cs cli/README.md extension/CHANGELOG.md
git commit -s -m "Document exit codes in --help and the new check options" -m "Exit code 10 for a failed build was only in the README; scripts are written from --help."
```

### Task 5: Check against a real failing build log

Needs a TwinCAT PC (about 30 min). No code unless a step fails.

- [ ] **Step 1:** Build a solution that references a library version that is not installed, once with an English and once with a German XAE if available: `iecode build <sln> --tc 4024 -v --no-color > build.log 2>&1`. Expected: `Root causes:` block names the library; `--json` has exactly the library manager errors with `rootCause: true`.
- [ ] **Step 2:** Run `iecode lib check <sln>` on the same solution. Expected: exit 3, the missing version is listed.
- [ ] **Step 3:** If the German log shows a different origin than `.Library Manager` (e.g. `Bibliotheksverwalter`), add that text to the root-cause patterns with a test in `BuildTriageTests` built from the anonymised log line, and commit. Otherwise record "German origin not seen" under known limits in `docs/open-tests.md`.

## Known limits

- Root-cause texts are English plus the origin prefix; German message texts are added only after Task 5 shows them.
- `lib check` does not resolve placeholders the way the library manager does for nested library dependencies (a library that references another missing library is only found when the build reports it).
