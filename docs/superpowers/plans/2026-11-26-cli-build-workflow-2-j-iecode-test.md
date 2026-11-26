# Plan J: `iecode test <sln>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode test <sln>` builds a solution, activates it on the local runtime, waits until the PLC unit test framework says it is finished, reads the result over ADS, prints one line per test case, can write a JUnit XML file, and exits with a dedicated code when a test failed.

**Architecture:** Core owns every decision: which PLC project is the test project, which framework adapter applies (`ITestFrameworkAdapter`, one implementation per framework, reading through a tiny `ITestSymbolReader`), when to stop waiting, whether to ask before activating, the exit code and the JUnit text. Automation adds one reader over the existing ADS backend and a `save` switch on `Activate`. The CLI command only wires `WithShell` (which already brings `ShellRegistry`, the job object and `DialogWatch`), `--isolate`, the adapter and the reader.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, Beckhoff ADS client (`AdsWatchBackend`), COM late binding to XAE.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 (row "Run `Tc3_PlcTestFramework` tests"), Q7; TODO.md "CLI: build and library workflow at scale", item "Large". Round-1 master plan: [2026-11-24-cli-build-workflow-master-plan.md](2026-11-24-cli-build-workflow-master-plan.md).

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs, commits. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`. Symbol names of a non-public test framework never land in the repository (see decision 2).
- Decisions live in `IECode.Core` (pure, xUnit, Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. No test project for `IECode.Cli`. Windows-only tests use `WindowsOnly` (`cli/tests/IECode.Core.Tests/WindowsOnly.cs:4`).
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), Automation tests `dotnet test --project cli/tests/IECode.Automation.Tests`, through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel.
- JSON output changes are additive; existing exit codes keep their meaning; the new exit code gets a README row, a `HelpText` entry (test `EveryExitCodeHasADescription`, `ReporterTests.cs:177`).
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, the new command a row in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` with the GitHub noreply address.
- All sizes `[estimated]`. Steps that need a TwinCAT PC (4024 and 4026) are marked **manual**.
- Activating a configuration stops whatever runs on that runtime: never without a decision in Core (`TestSafety`) and never on a remote target without `--yes`.

## Premises checked (in `iecode-cli-build`)

1. `Tc3_PlcTestFramework` appears only in the research doc and TODO; no code, fixture or doc in the repository defines it (grep over `cli/`, `docs/`, `extension/`). No public source is known. **Unverified:** what it is, which vendor, which symbols. Spike S0.
2. TcUnit (public, MIT, github.com/tcunit/TcUnit, master read 2026-11-26): `GVL_TcUnit` is `{attribute 'qualified_only'}` and holds `TcUnitRunner : FB_TcUnitRunner`; the runner has `AllTestSuitesFinished : BOOL` and `TestResults : FB_TestResults`; that FB has `TestSuiteResults : ST_TestSuiteResults`, `StoredTestSuiteResults : BOOL`, `StoredGeneralTestResults : BOOL`. `ST_TestSuiteResults`: `NumberOfTestSuites`, `NumberOfTestCases`, `NumberOfSuccessfulTestCases`, `NumberOfFailedTestCases` (UINT), `Duration` (LREAL), `TestSuiteResults : ARRAY[1..MaxNumberOfTestSuites] OF ST_TestSuiteResult` (`Name`, `Identity`, `NumberOfTests`, `NumberOfFailedTests`, `Duration`, `TestCaseResults : ARRAY[1..MaxNumberOfTestsForEachTestSuite] OF ST_TestCaseResult`); `ST_TestCaseResult`: `TestName`, `TestClassName`, `TestIsFailed`, `TestIsSkipped`, `FailureMessage`, `FailureType`, `NumberOfAsserts`, `Duration`. **Unverified:** the ADS instance path prefix of library GVLs (e.g. `TcUnit.GVL_TcUnit...`), whether these symbols are in the `.tmc` and online at all, and which TcUnit versions keep the names. Spike S2.
3. `iecode activate` = `WithShell(ctx, path, saves: true, …)` then `shell.Build(null)` then `shell.Activate(id, restart, project)` (`ProjectCommands.cs:239-274`); remote targets need `ctx.Log.Confirm(…, ctx.Yes)` or exit 130 (`ProjectCommands.cs:252-255`).
4. `XaeShell.Activate(AmsNetId target, bool restart, string? projectName)` (`XaeShell.Plc.cs:147`) calls `SaveAll()` (`:169`) and `project.Save()` (`:178`) and confirms known dialogs via `DialogWatch.Start(null, …)` (`:173`). **Unverified:** whether `ActivateConfiguration` works without the save. Spike S1.
5. `Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false)` (`Runner.cs:84`) starts the shell through `XaeShell.Start`, which registers the shell (`ShellRegistry`, job object) and starts `DialogWatch` (`XaeShell.cs:84-90`); `--tc` is honoured by `ChooseVersion` / `TcLineGuard` (`Runner.cs:99-109`).
6. `Isolation.Create(string solution, string isolateDir, int? pid = null)`, `Isolation.RootOf`, `Isolation.OutsideRoot`, `Isolation.DefaultDir`, `IsolatedCopy.TryDelete` (`Isolation.cs:52-174`); used by `build --isolate` (`ProjectCommands.cs:117-150`).
7. `AdsWatchBackend(Core.AmsNetId target, int port, Action<string>? log = null)` (`AdsWatchBackend.cs:39`), `Connect()` (`:65`), `ReadOnce(string symbol) -> (string Type, string Value)` (`:195`) throws `IECodeException(ExitCodes.NotFound)` for a missing symbol (`:539-547`) and `AdsFault` on ADS errors; `ReadPlcState(int task) -> PlcState(string? AdsState, …)` (`:380`, `WatchProtocol.cs:62`). Internal ctor with `Func<IAdsLink>` for `FakeLink` tests (`:45`, `tests/IECode.Automation.Tests/FakeLink.cs`).
8. `AdsInterface.FindTmc(string plcproj)`, `AdsInterface.Load(string file, bool members)`, `AdsSymbol(string Name, string Type, …)` (`AdsInterface.cs:12,160,182`): symbols from `.tmc` without a running PLC; `--members` expands FB members to depth 8 (`:41`).
9. `ExitCodes` ends at 20, 21 is free (`Errors.cs:4-22`; round 1 dropped its exit 21, master plan R2/R43). README table at `cli/README.md:190-210`, command table starts `:11`.
10. `PlcProjectFile.Discover`, `SolutionFile.Load(path).PlcProjects`, `PlcProjectFile.IsLibrary` (`PlcProjectFile.cs:21`). **Unverified:** where the ADS port of a PLC instance is stored (`.tsproj` / `.xti` / `.tmc`). Spike S2.
11. `AmsNetId.IsLocal` is only `127.0.0.1.1.1` (`AmsNetId.cs:11`); `LocalTarget.Resolve` maps it to the real local NetId (`LocalTarget.cs:14`), so a remote NetId equal to the local one must be compared after `Resolve`.

## Depends on

- Round 1: `Runner.WithShell` (5), `Isolation.*` (6), `WorkingTreeSnapshot.Take(folder)` / `ChangedSince` (as `ProjectCommands.cs:107,179-186`), `LibraryCommands.Preflight(ctx, plcProjects, [])` (`ProjectCommands.cs:99`), `XaeShell.Build(string? platform, bool save = true)` (`XaeShell.Build.cs:75`), `BuildOutcome`.
- Plan G (parallel): the `*.Test` / `UnitTest` rule. **This plan defines it** (`TestProjects.IsTestProject`, Task 2); G reuses it for `--no-tests`. Whichever lane lands first creates the file; the second only adds call sites (master plan orders it).

## Touches (existing files)

`cli/src/IECode.Core/Errors.cs` (new code 21), `cli/src/IECode.Automation/XaeShell.Plc.cs` (`Activate` gets `save`), `cli/src/IECode.Cli/Program.cs` (register command), `cli/README.md` (command row, exit-code row), `extension/CHANGELOG.md`, `cli/tests/IECode.Core.Tests/ReporterTests.cs` only if the help-text test needs the new code listed (it reads `HelpText`). New files are listed per task.

## Decisions (delegated to the planner)

1. **Adapter interface, TcUnit built in.** `ITestFrameworkAdapter` with `TcUnitAdapter` first (public, documented). Rejected: hard-coding one framework in the command.
2. **Every other framework, `Tc3_PlcTestFramework` included, through a symbol map file** (`--adapter <file.json>`, format `iecode-test-adapter/1`, kept in the user's own repository). It names the finished flag, counters and per-case paths. If S0 shows `Tc3_PlcTestFramework` is not public, its names stay out of this repository; if it is public, a built-in adapter is a follow-up of one class. Rejected: a built-in adapter for an unknown, possibly internal framework.
3. **Test PLC selection:** `--plc <name>` wins; else the single PLC project that `TestProjects.IsTestProject` marks (folder segment `Test`, `Tests`, `UnitTest`, `UnitTests`, `*.Test`, `*.Tests` between the solution folder and the `.plcproj`, case-insensitive; shared with plan G, master plan M3); else the single PLC project whose `.tmc` an adapter detects; else exit 2 listing candidates. The whole TwinCAT project is activated (the library PLC runs too); only the result source is selected.
4. **Local runtime by default.** `--target` defaults to `local`; a remote target needs `--yes` (no interactive prompt either: tests run unattended). Local: confirm (or `--yes`) when the runtime is in Run, because activation replaces what runs; Config/Stop/unreachable-service needs no prompt. Rejected: refusing remote targets (a test PC with a route is a valid CI setup).
5. **Finished detection:** poll the adapter every 500 ms after the restart; `--test-timeout <s>` (default 300) ends with exit 17; a PLC that leaves Run (or never reaches it within 60 s after activation) ends with exit 16 and the PLC state. The global `--timeout` stays for build/activation.
6. **Exit codes:** new `21 TestsFailed` = at least one failed test case, or zero test cases ran (an empty run in CI is a broken test project; `--allow-empty` turns it into exit 0). Timeout 17, PLC stopped / ADS error 16, build failed 10, activation failed 11. Rejected: reusing 1 (scripts could not tell a red test from a broken tool).
7. **Output:** one line per case `✔|✖|○ Suite.Test (0.012 s)` plus the failure message indented; summary `Tests: N · passed P · failed F · skipped S · D s`. `--junit <file>` writes JUnit XML (one `<testsuite>` per suite). JSON: `{ solution, plc, framework, target, total, passed, failed, skipped, seconds, cases: [{ suite, name, status, message, seconds }] }`.
8. **Side effects:** `test` activates with `save: false` if S1 allows it, else as `activate` does and prints `Git status changes` like `build`. `--isolate` (same options as `build`) runs the whole build/activate in a temp copy; recommended for CI in the README. `--no-build` as in `activate`.

## Review Focus

1. **A machine runtime or a running simulation on the same PC**: `iecode test` must not silently replace a running configuration (Task 5 test `RunningLocalRuntimeNeedsConfirmation`, `RemoteNeedsYes`).
2. **Results read before the framework stored them** (TcUnit sets `AllTestSuitesFinished` before `StoredGeneralTestResults`): counts would be 0 and the run "empty" (Task 3 test `NotFinishedUntilResultsStored`).
3. **Stale `.tmc` / framework not detected** (test project never built, or adapter symbols hidden): clear exit 3 with the hint to build or pass `--adapter`, never a hang until the timeout (Task 3 test `DetectReturnsNullWithoutFrameworkSymbols`, Task 8 manual step).
4. **Counters and per-case records disagree** (array limit of the framework reached, or a suite crashed): the summary uses the counters, a warning names the gap (Task 3 test `CaseCountMismatchIsReported`).
5. **Failure messages with XML-special or non-ASCII characters** in the JUnit file: escaped, file still valid (Task 6 test `MessageIsEscaped`).

---

### Task 1: Spikes on a TwinCAT PC (manual, gates everything) `[estimated 0.5 day]`

**Files:** none in the repository. Notes go to the PR description; framework-internal names only to a private scratch file.

- [ ] **S0, framework identity (15 min):** on a PC where `Tc3_PlcTestFramework` is used, `iecode lib installed --lib Tc3_PlcTestFramework --json` and open one test project: record vendor, whether the library is public, and (privately) the symbol paths of finished flag, counters, per-case records via `iecode ads symbols <test.plcproj> --members --filter <framework prefix>`. **Gate:** public → open a follow-up for a built-in adapter; not public → it uses the symbol map (Task 4) and the map file stays in the user's repository. Plan unchanged either way.
- [ ] **S1, activation without save (20 min):** in a clean git clone of a small solution, run `activate` with a temporary build whose `Activate` skips `SaveAll()` and `project.Save()`; then `git status` and `iecode target state`. **Gate:** runtime in Run with the new configuration → Task 7 passes `save: false` from `test`; activation fails or activates the old state → `test` saves like `activate` (decision 8 fallback) and `--isolate` is recommended.
- [ ] **S2, TcUnit symbols and port (40 min, 4024 and 4026):** a solution with a library PLC and a test PLC in `PLC.Test\` using TcUnit (latest public release, one passing, one failing, one skipped test). `iecode build`, then `iecode ads symbols <test.plcproj> --members --filter TcUnitRunner` and after `iecode activate`: `iecode ads symbols --online --filter AllTestSuitesFinished --port <p>`, `iecode ads read <path>.AllTestSuitesFinished`. Record: exact instance paths (prefix), whether they are in the `.tmc`, time to finished, the ADS port of the test PLC and the file it is stored in. **Gates:** paths in `.tmc` → `TcUnitAdapter.Detect` works offline (Task 3 as written); only online → Detect falls back to `ReadOnce(<finished path>)` after activation (one extra test `DetectOnlineWhenNotInTmc`); hidden everywhere → TcUnit is unsupported over ADS, Task 3 is dropped and the plan ships the symbol map only. Port in a readable file → Task 2 adds `PlcPort.Read`; else `--port` (default 851) with a warning when the solution has more than one PLC instance.

### Task 2: Test PLC selection (Core, shared with plan G) `[estimated 2 h]`

**Files:**
- Create: `cli/src/IECode.Core/Projects/TestProjects.cs`
- Test: `cli/tests/IECode.Core.Tests/TestProjectsTests.cs`

**Interfaces:**
- Produces: `public static class TestProjects { public static bool IsTestProject(string solutionDir, string plcprojPath); public static PlcProjectFile Select(IReadOnlyList<PlcProjectFile> projects, string solutionDir, string? plcName, Func<PlcProjectFile, bool> frameworkDetected); }` `Select` throws `IECodeException(ExitCodes.NotFound)` for an unknown `--plc` (hint lists names) and `IECodeException(ExitCodes.Usage, …, "Choose with --plc <name>: A, B")` when the rule leaves 0 or several.

- [ ] **Step 1: Write the failing tests** (`TempWorkspace` fixtures, project names `Tc3_MotorLib`, `PLC`):
  `FolderDotTestIsTestProject` (`Lib/Tc3_MotorLib.Test/PLC/PLC.plcproj` → true), `UnitTestFolderIsTestProject`, `CaseInsensitive` (`unittests`), `FolderAboveSolutionDoesNotCount` (solution itself in `X.Test\` → false for its projects), `LibraryProjectIsNot`, `PlcOptionWins`, `UnknownPlcIsNotFound` (exit 3, hint contains both names), `SingleDetectedProjectIsChosenWithoutFolderRule`, `TwoCandidatesIsUsage` (exit 2, message lists both).
- [ ] **Step 2: Run** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*TestProjectsTests"`; expected: build error.
- [ ] **Step 3: Implement** in `TestProjects.cs`: segments of `Path.GetRelativePath(solutionDir, dir of plcproj)`; a whole segment (case-insensitive) equal to `Test`, `Tests`, `UnitTest`, `UnitTests` or ending with `.Test` / `.Tests` (the rule of plan G Decision 2; master plan M3). If plan G landed first, `IsTestProject` exists: add only `Select` and its tests.
- [ ] **Step 4: Run** the filter again; expected: PASS.
- [ ] **Step 5: Commit** `Add the test PLC project rule` / body: "iecode test and build --no-tests both need to know which PLC project holds the unit tests; one Core rule keeps them in step."

### Task 3: Test model, adapter interface and TcUnit adapter (Core) `[estimated 0.5 day]`

**Files:**
- Create: `cli/src/IECode.Core/Testing/TestReport.cs`, `cli/src/IECode.Core/Testing/ITestFrameworkAdapter.cs`, `cli/src/IECode.Core/Testing/TcUnitAdapter.cs`
- Test: `cli/tests/IECode.Core.Tests/TcUnitAdapterTests.cs` (fake reader: `Dictionary<string,string>`; missing key = `null`)

**Interfaces:**
- Produces:
  - `public enum TestStatus { Passed, Failed, Skipped }`
  - `public sealed record TestCase(string Suite, string Name, TestStatus Status, string? Message, double? Seconds);`
  - `public sealed record TestReport(string Framework, int Suites, int Total, int Passed, int Failed, int Skipped, double? Seconds, IReadOnlyList<TestCase> Cases, IReadOnlyList<string> Warnings);`
  - `public interface ITestSymbolReader { string? Read(string path); }` (canonical value text as `PlcValueText`; `null` = no such symbol; ADS faults propagate)
  - `public interface ITestFrameworkAdapter { string Name { get; } bool Detect(IReadOnlyList<AdsSymbol> tmcSymbols); bool IsFinished(ITestSymbolReader r); TestReport Read(ITestSymbolReader r); }`
  - `public static class TestFrameworks { public static ITestFrameworkAdapter? Detect(IReadOnlyList<AdsSymbol> symbols, IReadOnlyList<ITestFrameworkAdapter> adapters); public static IReadOnlyList<ITestFrameworkAdapter> BuiltIn { get; } }`
  - `public sealed class TcUnitAdapter : ITestFrameworkAdapter` with `public const string Runner = "TcUnit.GVL_TcUnit.TcUnitRunner";` (value pinned by S2; every other path is relative to it)

- [ ] **Step 1: Write the failing tests:**
  - `DetectsRunnerInTmc`: symbols contain `TcUnit.GVL_TcUnit.TcUnitRunner.AllTestSuitesFinished` → `TestFrameworks.Detect` returns the TcUnit adapter.
  - `DetectReturnsNullWithoutFrameworkSymbols`.
  - `NotFinishedUntilResultsStored`: `AllTestSuitesFinished=TRUE`, `TestResults.StoredGeneralTestResults=FALSE` → `IsFinished` false; all three TRUE → true.
  - `ReadsCountsAndCases`: 1 suite `FB_MotorTest` with 3 cases (passed; failed with `FailureMessage` `"Expected 5, got 4"`; skipped) → `Total 3, Passed 1, Failed 1, Skipped 1`, cases in order, `Cases[1].Message == "Expected 5, got 4"`, `Seconds` from `Duration`.
  - `ReadsOnlyUpToTheCounters`: suite count 1 → no read of `TestSuiteResults[2]` (fake records read paths; assert none contains `[2]`).
  - `CaseCountMismatchIsReported`: counters say 4, records hold 3 → `Total 4`, one entry in `Warnings` naming the suite.
- [ ] **Step 2: Run** `--filter-class "*TcUnitAdapterTests"`; expected: build error.
- [ ] **Step 3: Implement.** Read counters first, then suites `1..NumberOfTestSuites`, then cases `1..NumberOfTests` (never the whole array: `T_MaxString` arrays are large). `Passed = Total - Failed - Skipped`.
- [ ] **Step 4: Run**; expected: PASS. **Step 5: Commit** `Read TcUnit results through a framework adapter` / body: "The CLI must not hard-code one test framework; TcUnit is public and documented, so it is the first adapter."

### Task 4: Symbol map adapter (Core) `[estimated 3 h]`

**Files:**
- Create: `cli/src/IECode.Core/Testing/SymbolMapAdapter.cs`
- Test: `cli/tests/IECode.Core.Tests/SymbolMapAdapterTests.cs`

**Interfaces:**
- Produces: `public sealed class SymbolMapAdapter : ITestFrameworkAdapter { public const string Format = "iecode-test-adapter/1"; public static SymbolMapAdapter Load(string file); public static SymbolMapAdapter Parse(string json, string file); }`. JSON fields: `format`, `name`, `detect` (symbol path), `finished` (array of BOOL paths, all TRUE = finished), `total`, `failed`, `skipped?`, `seconds?`, `cases?` `{ count, suite?, name, failed, skipped?, message?, seconds? }` where case paths contain `{i}` (1-based index up to the value of `count`).

- [ ] **Step 1: Write the failing tests:** `ParsesMinimalMap` (no `cases` → report with counters only, empty `Cases`), `ReadsCasesByIndex` (`{i}` replaced 1..2), `AllFinishedFlagsMustBeTrue`, `UnknownFormatIsFailed` (exit 1, message names `iecode-test-adapter/1`), `MissingRequiredFieldIsUsage` (no `finished` → exit 2 naming the field), `DetectUsesDetectPath`. Paths in fixtures use `GVL_Tests.stResult…` (neutral names).
- [ ] **Step 2: Run**; expected: build error. **Step 3: Implement** with `System.Text.Json` and `Reporter.JsonOptions`. **Step 4: Run**; expected: PASS.
- [ ] **Step 5: Commit** `Add a symbol map adapter for other test frameworks` / body: "Project-specific frameworks can be run without adding their symbol names to this public repository."

### Task 5: Wait, safety and exit code decisions (Core) `[estimated 3 h]`

**Files:**
- Create: `cli/src/IECode.Core/Testing/TestRun.cs`
- Modify: `cli/src/IECode.Core/Errors.cs` (`public const int TestsFailed = 21;`, `HelpText` gains `21 tests failed`)
- Test: `cli/tests/IECode.Core.Tests/TestRunTests.cs`

**Interfaces:**
- Produces:
  - `public enum WaitVerdict { Poll, Finished, TimedOut, PlcStopped }`
  - `public static WaitVerdict TestRun.Decide(bool finished, string? plcAdsState, DateTime nowUtc, DateTime deadlineUtc, DateTime runDeadlineUtc)` (`Run` expected; not `Run` before `runDeadlineUtc` = `Poll`, after = `PlcStopped`; finished wins over a deadline in the same poll)
  - `public static bool TestSafety.NeedsConfirmation(AmsNetId resolvedTarget, AmsNetId resolvedLocal, string? localSystemState)` and `public static string? TestSafety.Refusal(bool remote, bool yes)` (remote without `--yes` → message, exit 130 by the caller)
  - `public static int TestRun.ExitCode(TestReport report, bool allowEmpty)` (failed > 0 → 21; total 0 → 21 unless `allowEmpty`; else 0)

- [ ] **Step 1: Write the failing tests:** `FinishedBeatsDeadline`, `TimeoutAfterDeadline`, `NotRunYetIsPollUntilRunDeadline`, `LeavingRunIsPlcStopped`, `RunningLocalRuntimeNeedsConfirmation` (state `Run` → true; `Config`, `Stop`, `null` → false), `RemoteNeedsYes` (remote, no yes → non-null; with yes → null), `LocalNetIdGivenExplicitlyCountsAsLocal` (target equals resolved local → treated as local), `FailedTestIs21`, `EmptyRunIs21UnlessAllowed`, `AllPassedIs0`. The existing `EveryExitCodeHasADescription` must stay green with 21 in `HelpText`.
- [ ] **Step 2: Run** `--filter-class "*TestRunTests"`; expected: build error. **Step 3: Implement.** **Step 4: Run** the filter plus `--filter-class "*ReporterTests"`; expected: PASS.
- [ ] **Step 5: Commit** `Decide test waits, activation safety and the test exit code` / body: "Activation on the local runtime stops whatever runs there, and CI must tell a red test from a broken tool; both decisions need a test, so they live in Core."

### Task 6: JUnit XML (Core) `[estimated 1.5 h]`

**Files:** Create `cli/src/IECode.Core/Testing/JUnitXml.cs`; Test `cli/tests/IECode.Core.Tests/JUnitXmlTests.cs`.

**Interfaces:** Produces `public static string JUnitXml.Write(TestReport report, string suitePrefix)` (`<testsuites tests failures skipped time>`, one `<testsuite name="{prefix}.{Suite}">` per suite, `<testcase classname name time>`, `<failure message>` text = message, `<skipped/>`; invariant culture for times).

- [ ] **Step 1: Failing tests:** `OneSuitePerSuiteName`, `FailureAndSkippedElements`, `MessageIsEscaped` (`a < b & "c" ü` round-trips through `XDocument.Parse`), `TimesUseInvariantCulture` (run under `de-DE`, expect `0.012`).
- [ ] **Step 2-4:** run (build error), implement with `XDocument`, run (PASS).
- [ ] **Step 5: Commit** `Write test results as JUnit XML` / body: "CI servers read JUnit XML; writing it from the Core report keeps the format testable."

### Task 7: Automation: ADS reader and activation without save `[estimated 2 h]`

**Files:**
- Create: `cli/src/IECode.Automation/AdsTestReader.cs`
- Modify: `cli/src/IECode.Automation/XaeShell.Plc.cs:147-178` (`Activate(AmsNetId target, bool restart, string? projectName, bool save = true)`; with `save: false` skip `SaveAll()` and `project.Save()`; only if S1 allowed it)
- Test: `cli/tests/IECode.Automation.Tests/AdsTestReaderTests.cs` (with `FakeLink`)

**Interfaces:**
- Consumes: `AdsWatchBackend` internal ctor (`string where, Func<IAdsLink> newLink, …`), `ReadOnce`.
- Produces: `[SupportedOSPlatform("windows")] public sealed class AdsTestReader(AdsWatchBackend backend) : ITestSymbolReader` (`Read`: `ReadOnce(path).Value`; `IECodeException` with `ExitCodes.NotFound` → `null`; `AdsFault` propagates and the CLI maps it to exit 16).

- [ ] **Step 1: Failing tests:** `MissingSymbolReadsNull`, `ValueIsCanonicalText` (BOOL → `TRUE`), `ConnectionLossPropagates`.
- [ ] **Step 2-4:** run `dotnet test --project cli/tests/IECode.Automation.Tests --filter-class "*AdsTestReaderTests"` (build error), implement, run (PASS).
- [ ] **Step 5: Commit** `Read test framework symbols over ADS and allow activation without saving` / body: "The test command reads a handful of symbols once per poll; reusing the watch backend keeps its fault handling. Activation without the save keeps the working tree clean where TwinCAT allows it (spike S1)."

### Task 8: `iecode test` command, docs, end-to-end check `[estimated 0.5 day]`

**Files:**
- Create: `cli/src/IECode.Cli/Commands/TestCommand.cs`
- Modify: `cli/src/IECode.Cli/Program.cs:19-27` (`root.Subcommands.Add(TestCommand.Create());`), `cli/README.md` (command row after `activate` at `:20`; exit-code row `| 21 | Tests failed or no test ran (`test`) |`; CI example with `--isolate --yes --junit`), `extension/CHANGELOG.md` (`## Unreleased`: "CLI: `iecode test` runs PLC unit tests (TcUnit, or any framework through a symbol map) on the local runtime and reports each test case; exit 21 when a test fails.").

**Interfaces:**
- Consumes: everything above. Options: `[sln]`, `--plc`, `--adapter <file>`, `--target` (default `local`), `--port` (default from S2 or 851), `--test-timeout` (300), `--junit <file>`, `--allow-empty`, `--no-build`, `--isolate`, `--keep-isolated`, `--isolate-dir`, `--project` (TwinCAT project as in `activate`).
- Order inside the action: find solution → `Preflight` → select PLC and adapter from the `.tmc` (`TestProjects.Select`, `TestFrameworks.Detect`; none → exit 3 "No test framework found in <plc>.tmc", hint "build first, or pass --adapter") → safety (`TestSafety`, `Target.State` of the resolved local runtime; confirm or exit 130) → `WithShell(saves: true or false per S1)` build + `Activate(…, restart: true, save)` → `AdsWatchBackend.Connect` → loop `TestRun.Decide` every 500 ms with `ReadPlcState(0).AdsState` → `adapter.Read` → print, `--junit`, JSON → `TestRun.ExitCode`. With `--isolate`: same as `build --isolate` (copy, run, `TryDelete`), `.tmc` read from the copy after the build.

- [ ] **Step 1: Implement** `TestCommand.Create()` with `Action(cmd, …, windowsOnly: true)`; no logic beyond the order above.
- [ ] **Step 2: Build** `dotnet build cli/src/IECode.Cli`; expected: 0 errors. Then the full Core and Automation test runs; expected: all green.
- [ ] **Step 3: Manual (TwinCAT PC, 4024 and 4026, the S2 solution):** (a) `iecode test <sln> --yes --junit out.xml` → three case lines, exit 21, `out.xml` valid; (b) fix the failing test, again → exit 0; (c) with the local runtime in Run and no `--yes`, input redirected → exit 130, nothing activated; (d) `--plc` unknown → exit 3; (e) an endless test (`WHILE TRUE` in a suite step, or a never-finishing suite) with `--test-timeout 20` → exit 17; (f) `--isolate` → `git status` clean afterwards; (g) `--adapter` map for a project-specific framework (S0 PC only, map kept outside the repo) → cases listed.
- [ ] **Step 4: Commit** `Add iecode test for PLC unit tests` / body: "Unit tests of a library ran only by hand in XAE; the command activates the test PLC locally, waits for the framework and reports each case with an exit code CI can use."

## Self-review notes

- Spec coverage: activate on local runtime (T7, T8), read result over ADS (T3, T4, T7), per test case (T8), exit code (T5), `Tc3_PlcTestFramework` (S0 + T4), JUnit (T6), test PLC rule shared with G (T2), safety (T5), timeout and finished detection (T5).
- Size: 8 tasks, about 3 days plus 0.5 day on a TwinCAT PC `[estimated]`.
