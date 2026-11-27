# Plan J: `iecode test <sln>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode test <sln>` builds a solution, activates it on the local runtime, waits until the PLC unit test framework says it is finished, reads the result over ADS, prints one line per test case, can write a JUnit XML file, and exits with a dedicated code when a test failed.

**Architecture:** Core owns every decision: which PLC project is the test project, which framework adapter applies (`ITestFrameworkAdapter`, one implementation per framework, reading through a tiny `ITestSymbolReader`), when to stop waiting, whether to ask before activating, the exit code and the JUnit text. Automation adds one reader over the existing ADS backend and a `save` switch on `Activate`. The CLI command only wires `WithShell` (which already brings `ShellRegistry`, the job object and `DialogWatch`), `--isolate`, the adapter and the reader.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, Beckhoff ADS client (`AdsWatchBackend`), COM late binding to XAE.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 (row "Run the project test framework tests"), Q7; TODO.md "CLI: build and library workflow at scale", item "Large". Round-1 master plan: [2026-11-24-cli-build-workflow-master-plan.md](2026-11-24-cli-build-workflow-master-plan.md).

**Review changes** (master plan, "Decision ledger"; each pointer names where the row is folded in):
- R2: Task 1 (session B, restore point), Global Constraints. R3: Depends on, Touches, Decision 3, Task 2. R4: Task 10 Step 3 (budget), Size line. R5: checked, no framework library name remains (Premise 1).
- R15: Known limits, Task 10 docs. R37: Decision 3, Task 2. R64: Decision 8, Premise 12, Task 10 order. R65: Premise 7, Task 5, Task 7. R66: Decision 4, Known limits, Task 5, Task 10 docs.
- R67: Task 1 S2, Task 3, Task 4, Task 7. R68: Task 4. R69: Decision 4, Task 5, Task 10 order. R70: Decision 9, Premise 10, Task 1 S2, Task 3, Task 5, Task 10 order. R71: Premise 11, Task 5. R72: Task 8, Task 9, Task 10. R73: Touches, Premise 4, Task 9.

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs, commits. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`. Symbol names of a non-public test framework never land in the repository (see decision 2).
- Decisions live in `IECode.Core` (pure, xUnit, Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. No test project for `IECode.Cli`. Windows-only tests use `WindowsOnly` (`cli/tests/IECode.Core.Tests/WindowsOnly.cs:4`).
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), Automation tests `dotnet test --project cli/tests/IECode.Automation.Tests`, through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel.
- JSON output changes are additive; existing exit codes keep their meaning; the new exit code gets a README row, a `HelpText` entry (test `EveryExitCodeHasADescription`, `ReporterTests.cs:198`).
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, the new command a row in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` with the GitHub noreply address.
- All sizes `[estimated]`. Steps that need a TwinCAT PC (4024 and 4026) are marked **manual**.
- Activating a configuration stops whatever runs on that runtime: never without a decision in Core (`TestSafety`) and never on a remote target without `--yes`.
- Spike safety (master plan M9): the spikes activate configurations on the local runtime; only on a PC with no connected machine and nothing in Run that matters. They run as session B of the round (the one that changes the machine), after the read-only sessions, and only after a restore point: a backup of both library repository candidates (`LibraryRepository.Candidates`) and a clean git clone of the spike solution (R2). A spike gates only this plan; the other lanes start on their own.

## Premises checked (base `main` at `f817efe`)

1. The project test framework (named by its library in the research doc and TODO) appears only in the research doc and TODO; no code, fixture or doc in the repository defines it (grep over `cli/`, `docs/`, `extension/`). No public source is known. **Unverified:** what it is, which vendor, which symbols. Spike S0.
2. TcUnit (public, MIT, github.com/tcunit/TcUnit, master read 2026-11-26): `GVL_TcUnit` is `{attribute 'qualified_only'}` and holds `TcUnitRunner : FB_TcUnitRunner`; the runner has `AllTestSuitesFinished : BOOL` and `TestResults : FB_TestResults`; that FB has `TestSuiteResults : ST_TestSuiteResults`, `StoredTestSuiteResults : BOOL`, `StoredGeneralTestResults : BOOL`. `ST_TestSuiteResults`: `NumberOfTestSuites`, `NumberOfTestCases`, `NumberOfSuccessfulTestCases`, `NumberOfFailedTestCases` (UINT), `Duration` (LREAL), `TestSuiteResults : ARRAY[1..MaxNumberOfTestSuites] OF ST_TestSuiteResult` (`Name`, `Identity`, `NumberOfTests`, `NumberOfFailedTests`, `Duration`, `TestCaseResults : ARRAY[1..MaxNumberOfTestsForEachTestSuite] OF ST_TestCaseResult`); `ST_TestCaseResult`: `TestName`, `TestClassName`, `TestIsFailed`, `TestIsSkipped`, `FailureMessage`, `FailureType`, `NumberOfAsserts`, `Duration`. **Unverified:** the ADS instance path prefix of library GVLs (e.g. `TcUnit.GVL_TcUnit...`), whether these symbols are in the `.tmc` and online at all, and which TcUnit versions keep the names. Spike S2.
3. `iecode activate` = `WithShell(ctx, path, saves: true, …)` then `shell.Build(null)` then `shell.Activate(id, restart, project)` (`ProjectCommands.cs:256-291`); remote targets need `ctx.Log.Confirm(…, ctx.Yes)` or exit 130 (`ProjectCommands.cs:269-272`).
4. `XaeShell.Activate(AmsNetId target, bool restart, string? projectName)` (`XaeShell.Plc.cs:147`) is a wrapper (`Watched(() => ActivateCore(…))`) over `ActivateCore` (`:149`), which calls `SaveAll()` (`:169`) before and `project.Save()` (`:190`) right after `ActivateConfiguration` (`:189`). Known dialogs are confirmed by the shell's own watch and by `DialogWatch.Start(null, userCanAnswer: false, _log, isHelper: confirmable)` (`:185`; `confirmable` accepts a verified TwinCAT helper process and, when the shell has no watch of its own, the process serving this DTE object), only in verified TwinCAT helper processes (`Interop/HelperProcess.cs:18`); without `TWINCAT3DIR` (`RepTool.TwinCatDir`) helper dialogs are not confirmed and only a `Detail` line says so (`:175-176`). **Unverified:** whether `ActivateConfiguration` works without the save. Spike S1.
5. `Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false, Action? beforeOpen = null)` (`Runner.cs:88`) starts the shell through `XaeShell.Start`; the server PID comes from the running object table (`XaeShell.cs:120-146`), then the shell is registered (`ShellRegistry`, job object) and watched (`DialogWatch`, `XaeShell.cs:136-137`). After the body, `shell.Close()` runs and a dialog at shutdown turns a successful body into an exception (`Runner.cs:103-108`). `--tc` is honoured by `ChooseVersion` / `TcLineGuard` (`Runner.cs:125`); a build counts as saving for the line guard even with `--no-save` (`ProjectCommands.cs:115`).
6. `Isolation.Create(string solution, string isolateDir, int? pid = null)`, `Isolation.RootOf`, `Isolation.OutsideRoot`, `Isolation.DefaultDir`, `IsolatedCopy.TryDelete` (`Isolation.cs:31-177`); used by `build --isolate` (`ProjectCommands.cs:126-133` ff.).
7. `AdsWatchBackend(Core.AmsNetId target, int port, Action<string>? log = null)` (`AdsWatchBackend.cs:39`), `Connect()` (`:65`), `ReadOnce(string symbol) -> (string Type, string Value)` (`:195`) throws `IECodeException(ExitCodes.NotFound)` for a missing symbol (`:539-544`) and `AdsFault` on ADS errors; `ReadPlcState(int task) -> PlcState(string? AdsState, …, string? PlcError, uint? PlcAdsCode, bool PlcConnectionLost)` (`:380`, `IECode.Core/Ads/WatchProtocol.cs:62`). `ReadPlcState` turns an `AdsFault` into a state with null `AdsState` and `PlcConnectionLost` (`:392-395`) when the router answered; a loop that only looks at `AdsState` would poll a lost connection for the whole start window. `Connect()` throws a connection-lost `AdsFault` for any failure, also while the PLC port does not exist yet (`:75-81`). Internal ctor with `Func<IAdsLink>` for `FakeLink` tests (`:45`, `tests/IECode.Automation.Tests/FakeLink.cs`).
8. `AdsInterface.FindTmc(string plcproj)`, `AdsInterface.Load(string file, bool members)`, `AdsSymbol(string Name, string Type, …)` (`AdsInterface.cs:12,160,182`): symbols from `.tmc` without a running PLC; `--members` expands FB members to depth 8 (`:41`).
9. `ExitCodes` ends at 20, 21 is free (`Errors.cs:6-22`; round 1 dropped its exit 21, master plan R2/R43; round 2 reserves 21 for this plan, M1). README table at `cli/README.md:190-210`, command table starts `:11`.
10. `PlcProjectFile.Discover`, `SolutionFile.Load(path).PlcProjects`, `PlcProjectFile.IsLibrary` (`PlcProjectFile.cs:21`). `TwinCatProjectFile.PlcProjects` ties each PLC project to its system project (`SolutionFile.cs:59-62`); `Activate` picks the system project by name or the first one, and warns when there are several (`XaeShell.Plc.cs:151-158`). Nothing ties the activated system project, the test PLC and the ADS port together today. **Unverified:** where the ADS port of a PLC instance is stored (`.tsproj` / `.xti` / `.tmc`). Spike S2.
11. `AmsNetId.IsLocal` is only `127.0.0.1.1.1` (`AmsNetId.cs:11`); `LocalTarget.Resolve` maps it to the real local NetId (`LocalTarget.cs:14`), so a remote NetId equal to the local one must be compared after `Resolve`. `LocalTarget` lives in `IECode.Automation`, not in Core: the CLI resolves the ids (and reads `Target.State(AmsNetId)`, `Target.cs:21`) and passes resolved values into the Core decisions.
12. `AdsInterface.FindTmc` returns null in a fresh clone or an isolated copy that was never built, and `AdsInterface.IsStale(tmc, plcproj)` (`:170`) compares the `.tmc` time with the sources; the `.tmc` is therefore only meaningful after the build, in the copy before it is deleted.
13. `IECode.Cli` has no `CancelKeyPress` handler (grep over `cli/src`) and nothing restores the runtime after a run; `iecode test` leaves the new configuration active.

## Depends on

- Round 1: `Runner.WithShell` (5), `Isolation.*` (6), `WorkingTreeSnapshot.Take(folder)` / `ChangedSince` and `ReportChanges` (as `ProjectCommands.cs:107,196-203`), `internal static void LibraryCommands.Preflight(Context ctx, IEnumerable<PlcProjectFile> projects)` (`LibraryCommands.cs:365`, called at `ProjectCommands.cs:99`), `XaeShell.Build(string? platform, bool save = true)` (`XaeShell.Build.cs:75`), `BuildOutcome`.
- Plan G (parallel): the `*.Test` / `UnitTest` rule `TestProjects.IsTestProject(string solutionDir, string plcprojPath)` (master plan M3). Not in the base yet (no `TestProjects.cs` in `cli/src/IECode.Core/Projects`). G Task 2 creates `TestProjects.cs` with its tests; J Task 2 starts after G Task 2 is merged and only calls `IsTestProject` (R3). J's own `Select` lives in `TestProjectSelection.cs`.

## Touches (existing files)

`cli/src/IECode.Core/Errors.cs` (new code 21), `cli/src/IECode.Automation/XaeShell.Plc.cs` (`Activate` and `ActivateCore` get `save`, Task 9), `cli/src/IECode.Cli/Program.cs` (register command), `cli/README.md` (command row, exit-code row), `extension/CHANGELOG.md`, `cli/tests/IECode.Core.Tests/ReporterTests.cs` only if the help-text test needs the new code listed (it reads `HelpText`). New files are listed per task.

## Decisions (delegated to the planner)

1. **Adapter interface, TcUnit built in.** `ITestFrameworkAdapter` with `TcUnitAdapter` first (public, documented). Rejected: hard-coding one framework in the command.
2. **Every other framework, the project test framework included, through a symbol map file** (`--adapter <file.json>`, format `iecode-test-adapter/1`, kept in the user's own repository). It names the finished flag, counters and per-case paths. If S0 shows the project test framework is not public, its names stay out of this repository; if it is public, a built-in adapter is a follow-up of one class. Rejected: a built-in adapter for an unknown, possibly internal framework.
3. **Test PLC selection:** `--plc <name>` wins; else the single PLC project that `TestProjects.IsTestProject` marks (folder segment `Test`, `Tests`, `UnitTest`, `UnitTests`, `*.Test`, `*.Tests` between the solution folder and the `.plcproj`, case-insensitive; one rule shared with plan G, master plan M3; only this documented pattern is detected, so `Lib.UnitTests` and `Lib_Test` are not, R37: `--plc` or the adapter detection covers them); else the single PLC project whose `.tmc` an adapter detects; else exit 2 listing candidates. The whole TwinCAT project is activated (the library PLC runs too); only the result source is selected.
4. **Local runtime by default.** `--target` defaults to `local`; a remote target needs `--yes` (no interactive prompt either: tests run unattended). Local: confirm (or `--yes`) when the runtime is in Run, because activation replaces what runs; Config/Stop/unreachable-service needs no prompt. The check runs twice: early (before the build, so a refusal costs nothing) and again right before `Activate`, because the state may have changed during the build (R69). With `--yes` on a remote target the state is read and a warning is logged when it is in Run. The confirmation text and the `--yes` log line say that the runtime is **not restored** after the test: the test configuration stays active (R66). Rejected: refusing remote targets (a test PC with a route is a valid CI setup); a restore of the old configuration (`--stop-after` and restoring go to the TODO list).
5. **Finished detection:** poll the adapter every 500 ms after the restart; `--test-timeout <s>` (default 300) ends with exit 17; a PLC that leaves Run (or never reaches it within 60 s after activation) ends with exit 16 and the PLC state, and so does a lost ADS connection (`PlcConnectionLost`, at once, not after the window, R65). `Decide` takes the whole `PlcState` and a "reached Run" flag, so "never in Run" and "left Run" differ; the connect after activation retries inside the 60 s start window because the PLC port does not exist right after the restart. A finished flag wins when the PLC is no longer in Run (a framework may stop the PLC itself, R71). The global `--timeout` stays for build/activation.
6. **Exit codes:** new `21 TestsFailed` = at least one failed test case, or zero test cases ran (an empty run in CI is a broken test project; `--allow-empty` turns it into exit 0). Timeout 17, PLC stopped / ADS error 16, build failed 10, activation failed 11. Rejected: reusing 1 (scripts could not tell a red test from a broken tool).
7. **Output:** one line per case `✔|✖|○ Suite.Test (0.012 s)` plus the failure message indented; summary `Tests: N · passed P · failed F · skipped S · D s`. `--junit <file>` writes JUnit XML (one `<testsuite>` per suite). JSON: `{ solution, plc, framework, target, total, passed, failed, skipped, seconds, cases: [{ suite, name, status, message, seconds }] }`.
8. **Side effects:** `test` activates with `save: false` if S1 allows it, else as `activate` does and prints `Git status changes` like `build`. The ADS wait runs after `WithShell` returned: the shell is not kept open for the test run, so its lifetime and its dialog watch stay as round 1 built them. Activation dialogs keep round 1's handling (known title, verified TwinCAT helper process only); `test` adds no dialog rule of its own. `--isolate` (same options as `build`) runs the whole build/activate in a temp copy; recommended for CI in the README. `--no-build` as in `activate`. The adapter is detected **after** the build (or in the isolated copy before it is deleted), never from a `.tmc` that may not exist yet: a fresh clone has none. A stale `.tmc` (`AdsInterface.IsStale`) is only a warning (with `--no-build`); exit 3 ("No test framework found", hint "build first, or pass --adapter") comes only after the build (R64).
9. **Test PLC, system project and port are resolved together before activation (R70).** `TestTarget.Resolve` (Core) returns `(system project, PLC project, port)` from the solution: the system project is the one that holds the test PLC; a conflicting `--project` is exit 2; `--port` is required (exit 2) when the solution has more than one PLC project, the default 851 applies only with a single PLC (or the value `PlcPort.Read` returns, only if S2 finds a readable file). After the restart the program is verified: the adapter's framework symbols must exist on that port (`ITestFrameworkAdapter.IsLoaded`), else exit 3 naming the port. Rejected: defaulting to 851 in a solution with a library PLC that may answer on it.

## Known limits (named in the README, the CHANGELOG and the command help)

- No Ctrl+C handler in round 2 (R15): an interrupted `iecode test` leaves its isolated copy for 24 h, may orphan the XAE shell and leaves the test configuration active; a `CancelKeyPress` handler and a watchdog go to the TODO list.
- The runtime is not restored after the run (R66): the test configuration stays active and in Run; `--stop-after` goes to the TODO list.
- Only the documented test folder pattern is detected (R37); other names need `--plc`.

## Review Focus

1. **A machine runtime or a running simulation on the same PC**: `iecode test` must not silently replace a running configuration (Task 5 test `RunningLocalRuntimeNeedsConfirmation`, `RemoteNeedsYes`).
2. **Results read before the framework stored them** (TcUnit sets `AllTestSuitesFinished` before `StoredGeneralTestResults`): counts would be 0 and the run "empty" (Task 3 test `NotFinishedUntilResultsStored`).
3. **Stale `.tmc` / framework not detected** (test project never built, or adapter symbols hidden): clear exit 3 with the hint to build or pass `--adapter`, never a hang until the timeout (Task 3 test `DetectReturnsNullWithoutFrameworkSymbols`, Task 10 manual step; the adapter is detected after the build, R64).
4. **Counters and per-case records disagree** (array limit of the framework reached, or a suite crashed): the summary uses the counters, a warning names the gap (Task 3 test `CaseCountMismatchIsReported`).
5. **Failure messages with XML-special or non-ASCII characters** in the JUnit file: escaped, file still valid (Task 6 test `MessageIsEscaped`).

---

### Task 1: Spikes on a TwinCAT PC (manual, gates everything) `[estimated 0.5 day]`

**Files:** none in the repository. Notes go to the PR description; framework-internal names only to a private scratch file. S0 to S2 are session B of the round (they change the machine): they run last, after the restore point named under Global Constraints (R2).

- [ ] **S0, framework identity (15 min):** on a PC where the project test framework is used, `iecode lib installed --lib <framework library> --json` and open one test project: record vendor, whether the library is public, and (privately) the symbol paths of finished flag, counters, per-case records via `iecode ads symbols <test.plcproj> --members --filter <framework prefix>`. **Gate:** public → open a follow-up for a built-in adapter; not public → it uses the symbol map (Task 4) and the map file stays in the user's repository; its paths and names go only to a private file outside the repository (M10). Plan unchanged either way.
- [ ] **S1, activation without save (20 min, PC without a connected machine, M9):** in a clean git clone of a small solution, run `activate` with a temporary build whose `Activate` skips `SaveAll()` and `project.Save()`; then `git status` and `iecode target state`. **Gate:** runtime in Run with the new configuration → Task 9 is done and Task 10 passes `save: false` from `test`; activation fails or activates the old state → `test` saves like `activate` (decision 8 fallback) and `--isolate` is recommended.
- [ ] **S2, TcUnit symbols and port (40 min, 4024 and 4026):** a solution with a library PLC and a test PLC in `PLC.Test\` using TcUnit (latest public release, one passing, one failing, one skipped test). `iecode build`, then `iecode ads symbols <test.plcproj> --members --filter TcUnitRunner` and after `iecode activate`: `iecode ads symbols --online --filter AllTestSuitesFinished --port <p>`, `iecode ads read <path>.AllTestSuitesFinished`. Also read one **indexed** path (`iecode ads read <path>.TestResults.TestSuiteResults.TestSuiteResults[1].TestCaseResults[1].TestName`, and a case path of the second suite) to prove that array element paths resolve over ADS (R67). Record: exact instance paths (prefix), whether they are in the `.tmc`, whether the indexed paths resolve, time to finished, the ADS port of the test PLC and the file it is stored in; run it once in a solution with two PLC projects to see which port each answers on (R70). **Gates:** paths in `.tmc` → `TcUnitAdapter.Detect` works offline (Task 3 as written); only online → Detect falls back to `ReadOnce(<finished path>)` after activation (one extra test `DetectOnlineWhenNotInTmc`); hidden everywhere → TcUnit is unsupported over ADS, Task 3 is dropped and the plan ships the symbol map only. Port in a readable file → Task 2 adds `PlcPort.Read`; else `--port` (default 851 only for a solution with a single PLC project, R70). Indexed paths do not resolve → stop and re-plan how Tasks 3 and 4 read case records before any code is written.

### Task 2: Test PLC selection (Core; starts after G Task 2 is merged) `[estimated 2 h]`

**Files:**
- Create: `cli/src/IECode.Core/Projects/TestProjectSelection.cs`
- Test: `cli/tests/IECode.Core.Tests/TestProjectSelectionTests.cs`

**Interfaces:**
- Consumes: `TestProjects.IsTestProject(string solutionDir, string plcprojPath)` from plan G Task 2 (`TestProjects.cs` and its tests belong to G, including the rows for `Lib.UnitTests`, `Lib_Test` and a sample in a `Tests` folder, R37; J does not create or edit that file, R3).
- Produces: `public static class TestProjectSelection { public static PlcProjectFile Select(IReadOnlyList<PlcProjectFile> projects, string solutionDir, string? plcName, Func<PlcProjectFile, bool> frameworkDetected); }` `Select` throws `IECodeException(ExitCodes.NotFound)` for an unknown `--plc` (hint lists names) and `IECodeException(ExitCodes.Usage, …, "Choose with --plc <name>: A, B")` when the rule leaves 0 or several.

- [ ] **Step 1: Write the failing tests** (`TempWorkspace` fixtures, project names `Tc3_MotorLib`, `PLC`; paths built with `Path.Combine`, not backslash literals, so they pass on ubuntu):
  `FolderRuleChoosesTheTestProject` (`Lib/Tc3_MotorLib.Test/PLC/PLC.plcproj` next to a library PLC → that project, `frameworkDetected` never called), `PlcOptionWins`, `UnknownPlcIsNotFound` (exit 3, hint contains both names), `SingleDetectedProjectIsChosenWithoutFolderRule`, `TwoCandidatesIsUsage` (exit 2, message lists both), `NothingMatchingIsUsage` (rule and detection find none → exit 2, message lists all PLC projects), and `UndocumentedNamesAreNotTheFolderRule` (theory, R37: `Lib.UnitTests` and `Lib_Test` are not marked by the rule, so only `frameworkDetected` or `--plc` selects them; the test asserts the detection path is taken).
- [ ] **Step 2: Run** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*TestProjectSelectionTests"`; expected: build error.
- [ ] **Step 3: Implement** in `TestProjectSelection.cs`: `--plc` (match by name or file name, case-insensitive) → else the single project with `TestProjects.IsTestProject` → else the single project with `frameworkDetected` → else exit 2. The folder rule itself is not re-implemented here.
- [ ] **Step 4: Run** the filter again; expected: PASS.
- [ ] **Step 5: Commit** `Select the test PLC project for iecode test` / body: "iecode test needs the one PLC project to read results from; the folder rule stays in plan G's shared TestProjects, this class only combines it with --plc and framework detection."

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
  - `public interface ITestFrameworkAdapter { string Name { get; } bool Detect(IReadOnlyList<AdsSymbol> tmcSymbols); bool IsLoaded(ITestSymbolReader r); bool IsFinished(ITestSymbolReader r); TestReport Read(ITestSymbolReader r); }` (`IsLoaded`: the framework's marker symbol exists on this port, so the program of the activated system project is the test PLC, R70; `IsLoaded` and `IsFinished` treat a missing symbol as false. `Read` runs only after `IsFinished` proved the framework exists, so a missing symbol there is an error: `IECodeException(ExitCodes.NotFound)` naming the path and a framework-version hint, never `null`, R67)
  - `public static class TestFrameworks { public static ITestFrameworkAdapter? Detect(IReadOnlyList<AdsSymbol> symbols, IReadOnlyList<ITestFrameworkAdapter> adapters); public static IReadOnlyList<ITestFrameworkAdapter> BuiltIn { get; } }`
  - `public sealed class TcUnitAdapter : ITestFrameworkAdapter` with `public const string Runner = "TcUnit.GVL_TcUnit.TcUnitRunner";` (value pinned by S2; every other path is relative to it)

- [ ] **Step 1: Write the failing tests:**
  - `DetectsRunnerInTmc`: symbols contain `TcUnit.GVL_TcUnit.TcUnitRunner.AllTestSuitesFinished` → `TestFrameworks.Detect` returns the TcUnit adapter.
  - `DetectReturnsNullWithoutFrameworkSymbols`.
  - `IsLoadedFollowsTheRunnerSymbol`: reader holds `AllTestSuitesFinished=FALSE` → `IsLoaded` true; empty reader → `IsLoaded` false and `IsFinished` false (no exception).
  - `NotFinishedUntilResultsStored`: `AllTestSuitesFinished=TRUE`, `TestResults.StoredGeneralTestResults=FALSE` → `IsFinished` false; all three TRUE → true.
  - `ReadsCountsAndCases`: 1 suite `FB_MotorTest` with 3 cases (passed; failed with `FailureMessage` `"Expected 5, got 4"`; skipped) → `Total 3, Passed 1, Failed 1, Skipped 1`, cases in order, `Cases[1].Message == "Expected 5, got 4"`, `Seconds` from `Duration`.
  - `ReadsOnlyUpToTheCounters`: suite count 1 → no read of `TestSuiteResults[2]` (fake records read paths; assert none contains `[2]`).
  - `CaseCountMismatchIsReported`: counters say 4, records hold 3 → `Total 4`, one entry in `Warnings` naming the suite.
  - `MissingSymbolAfterFinishedFails`: finished and stored flags TRUE, the counter symbols present, `TestSuiteResults[1].TestCaseResults[1].TestName` absent → `Read` throws `IECodeException` with exit 3 and a message that contains the missing path (not a report with a hole).
  - `IndexedPathsUseTheArraySyntax`: the fake records the paths read; assert the case path is `…TestSuiteResults[1].TestCaseResults[2].TestName` (the form S2 proved to resolve).
- [ ] **Step 2: Run** `--filter-class "*TcUnitAdapterTests"`; expected: build error.
- [ ] **Step 3: Implement.** Read counters first, then suites `1..NumberOfTestSuites`, then cases `1..NumberOfTests` (never the whole array: `T_MaxString` arrays are large). `Passed = Total - Failed - Skipped`.
- [ ] **Step 4: Run**; expected: PASS. **Step 5: Commit** `Read TcUnit results through a framework adapter` / body: "The CLI must not hard-code one test framework; TcUnit is public and documented, so it is the first adapter."

### Task 4: Symbol map adapter (Core) `[estimated 3 h]`

**Files:**
- Create: `cli/src/IECode.Core/Testing/SymbolMapAdapter.cs`
- Test: `cli/tests/IECode.Core.Tests/SymbolMapAdapterTests.cs`

**Interfaces:**
- Produces: `public sealed class SymbolMapAdapter : ITestFrameworkAdapter { public const string Format = "iecode-test-adapter/1"; public static SymbolMapAdapter Load(string file); public static SymbolMapAdapter Parse(string json, string file); }`. JSON fields: `format`, `name`, `detect` (symbol path), `finished` (array of BOOL paths, all TRUE = finished), `total`, `failed`, `skipped?`, `seconds?`, `cases?` `{ count, suite?, name, failed, skipped?, message?, seconds? }` where case paths contain `{i}` (1-based index up to the value of `count`). `count` is either a JSON integer literal or a string: the path of a counter symbol read through the reader (R68). `count` is capped at `SymbolMapAdapter.MaxCases = 10000`: a larger value reads 10000 cases and adds a warning. Malformed JSON and wrong JSON types are `IECodeException(ExitCodes.Usage)` naming the file and the field. `IsLoaded` reads the `detect` path; like the TcUnit adapter, `Read` fails with exit 3 on a missing mapped path once `finished` was TRUE (R67).

- [ ] **Step 1: Write the failing tests:** `ParsesMinimalMap` (no `cases` → report with counters only, empty `Cases`), `ReadsCasesByIndex` (`{i}` replaced 1..2), `AllFinishedFlagsMustBeTrue`, `UnknownFormatIsFailed` (exit 1, message names `iecode-test-adapter/1`), `MissingRequiredFieldIsUsage` (no `finished` → exit 2 naming the field), `DetectUsesDetectPath`, `MalformedJsonIsUsage` (`{ "format": ` → exit 2, message names the file), `WrongTypeIsUsage` (`finished` as a string → exit 2 naming `finished`), `CountLiteralIsUsed` (`"count": 2` → two cases read), `CountFromCounterPath` (`"count": "GVL_Tests.nCases"` with the reader returning `2`), `CountIsCapped` (counter returns `50000` → no path with index 10001 is read, one warning in the report), `PlaceholderMissingIsUsage` (`cases` path without `{i}` → exit 2), `MissingMappedPathFailsAfterFinished` (R67: exit 3 naming the path), `IsLoadedFollowsTheDetectPath`. Paths in fixtures use `GVL_Tests.stResult…` (neutral names).
- [ ] **Step 2: Run**; expected: build error. **Step 3: Implement** with `System.Text.Json` and `Reporter.JsonOptions`. **Step 4: Run**; expected: PASS.
- [ ] **Step 5: Commit** `Add a symbol map adapter for other test frameworks` / body: "Project-specific frameworks can be run without adding their symbol names to this public repository."

### Task 5: Wait, safety, target and exit code decisions (Core) `[estimated 5 h]`

**Files:**
- Create: `cli/src/IECode.Core/Testing/TestRun.cs`, `cli/src/IECode.Core/Testing/TestTarget.cs`, `cli/src/IECode.Core/Testing/TestSafety.cs`
- Modify: `cli/src/IECode.Core/Errors.cs` (`public const int TestsFailed = 21;`, `HelpText` gains `21 tests failed`)
- Test: `cli/tests/IECode.Core.Tests/TestRunTests.cs`, `cli/tests/IECode.Core.Tests/TestTargetTests.cs`

**Interfaces:**
- Produces:
  - `public enum WaitVerdict { Poll, Finished, TimedOut, PlcStopped, ConnectionLost, NotLoaded }`
  - `public static WaitVerdict TestRun.Decide(PlcState state, bool reachedRun, bool loaded, bool finished, DateTime nowUtc, DateTime deadlineUtc, DateTime runDeadlineUtc)`; `PlcState` is `IECode.Core.Ads.PlcState`; `reachedRun` is true when an earlier poll saw `Run` (the caller keeps it; a `Run` in `state` counts too). Order: (1) `state.PlcConnectionLost` → `ConnectionLost`; (2) `finished` → `Finished` (wins over a deadline and over a PLC that is no longer in Run, R71); (3) not `Run`: `reachedRun` → `PlcStopped`, never reached and `nowUtc >= runDeadlineUtc` → `PlcStopped`, else continue; (4) `nowUtc > deadlineUtc` → `TimedOut`; (5) `Run` but not `loaded` at or after `runDeadlineUtc` → `NotLoaded` (wrong port or other program, R70); (6) `Poll`.
  - `public static void TestRun.ConnectWithRetry(Action connect, Func<DateTime> utcNow, Action<TimeSpan> delay, DateTime runDeadlineUtc)`: retries every 500 ms on `AdsFault` while `utcNow() < runDeadlineUtc`; the last fault propagates after the window (the CLI maps it to exit 16; R65: the PLC port does not exist right after the restart).
  - `public static bool TestSafety.NeedsConfirmation(AmsNetId resolvedTarget, AmsNetId resolvedLocal, string? localSystemState)`, `public static string? TestSafety.Refusal(bool remote, bool yes)` (remote without `--yes` → message, exit 130 by the caller), `public static string? TestSafety.RemoteWarning(string? remoteSystemState)` (state `Run` or unreadable → warning text, else null; used with `--yes`, R69) and `public static string TestSafety.ConfirmationText(string target, bool running)` (always says the runtime is not restored after the test, R66). The CLI resolves ids with `LocalTarget.Resolve` (Automation) and passes the resolved values (R71).
  - `public static int TestRun.ExitCode(TestReport report, bool allowEmpty)` (failed > 0 → 21; total 0 → 21 unless `allowEmpty`; else 0)
  - `public sealed record TestTargetInfo(TwinCatProjectFile System, PlcProjectFile Plc, int Port)`; `public static TestTargetInfo TestTarget.Resolve(SolutionFile solution, PlcProjectFile plc, string? systemProject, int? port, int? readablePort)` (R70; rules in Decision 9; `readablePort` is `PlcPort.Read` when S2 found one, else null).

- [ ] **Step 1: Write the failing tests** (`TestRunTests`; a `PlcState` helper builds states, `Run` / `Stop` / `Config` as `AdsState`):
  - `FinishedBeatsDeadline`, `TimeoutAfterDeadline` (Run, loaded, not finished, now > deadline → `TimedOut`), `NotRunYetIsPollUntilRunDeadline`.
  - `NeverInRunAfterTheStartWindowIsPlcStopped` (never reached Run, now = runDeadline → `PlcStopped`).
  - `RunThenStopIsPlcStopped` (R65): poll 1 `Run` with `reachedRun = false` → `Poll`; poll 2 `Stop` with `reachedRun = true`, before the run deadline → `PlcStopped` (not `Poll`).
  - `ConnectionLostIsExit16AtOnce` (R65): state with `AdsState = null`, `PlcConnectionLost = true`, far before any deadline → `ConnectionLost`, and `finished = true` does not change that.
  - `FinishedWhileStoppedIsFinished` (R71): state `Stop`, `reachedRun = true`, `finished = true` → `Finished`.
  - `RunButProgramNotLoadedIsNotLoaded` (R70): `Run`, `loaded = false`, now >= runDeadline → `NotLoaded`; before the run deadline → `Poll`.
  - `ConnectRetriesUntilThePortExists` (R65): `connect` throws `AdsFault` twice then succeeds → returns, `delay` called twice with 500 ms; `ConnectFaultAfterTheWindowPropagates`: always throws, clock past `runDeadlineUtc` → the `AdsFault` is rethrown.
  - `RunningLocalRuntimeNeedsConfirmation` (state `Run` → true; `Config`, `Stop`, `null` → false), `LocalNetIdGivenExplicitlyCountsAsLocal` (target equals resolved local → treated as local), `RemoteNeedsYes` (remote, no yes → non-null; with yes → null).
  - `RuntimeThatStartedRunningDuringTheBuildNeedsConfirmation` (R69): the same call with `Config` (before the build) is false and with `Run` (right before `Activate`) is true; documents that the CLI calls it twice.
  - `RemoteWithYesWarnsWhenRunning` (R69): `Run` → warning text containing the state; `null` (unreadable) → a warning that the state is unknown; `Config` → null.
  - `ConfirmationTextSaysNoRestore` (R66): the text contains "not restored" and the target.
  - `FailedTestIs21`, `EmptyRunIs21UnlessAllowed`, `AllPassedIs0`.
  - `TestTargetTests` (R70, fixtures: two `.tsproj` projects, one with a library PLC, one with the test PLC): `SystemProjectIsTheOneHoldingTheTestPlc`, `ConflictingProjectOptionIsUsage` (`systemProject` names the other `.tsproj` → exit 2, message names both), `SeveralPlcProjectsNeedAPort` (two PLC projects, no port → exit 2, "Pass --port"), `SinglePlcDefaultsTo851`, `ReadablePortIsUsedWhenNoOptionIsGiven`, `PortConflictIsUsage` (an explicit port that differs from the readable one → exit 2), `PortOutOfRangeIsUsage` (0 and 70000).
  - The existing `EveryExitCodeHasADescription` must stay green with 21 in `HelpText`.
- [ ] **Step 2: Run** `--filter-class "*TestRunTests"` and `--filter-class "*TestTargetTests"`; expected: build error. **Step 3: Implement.** **Step 4: Run** both filters plus `--filter-class "*ReporterTests"`; expected: PASS.
- [ ] **Step 5: Commit** `Decide test waits, activation safety, target and the test exit code` / body: "Activation on the local runtime stops whatever runs there, a lost connection must not look like a slow start, and CI must tell a red test from a broken tool; the decisions need tests, so they live in Core."

### Task 6: JUnit XML (Core) `[estimated 1.5 h]`

**Files:** Create `cli/src/IECode.Core/Testing/JUnitXml.cs`; Test `cli/tests/IECode.Core.Tests/JUnitXmlTests.cs`.

**Interfaces:** Produces `public static string JUnitXml.Write(TestReport report, string suitePrefix)` (`<testsuites tests failures skipped time>`, one `<testsuite name="{prefix}.{Suite}">` per suite, `<testcase classname name time>`, `<failure message>` text = message, `<skipped/>`; invariant culture for times).

- [ ] **Step 1: Failing tests:** `OneSuitePerSuiteName`, `FailureAndSkippedElements`, `MessageIsEscaped` (`a < b & "c" ü` round-trips through `XDocument.Parse`), `TimesUseInvariantCulture` (run under `de-DE`, expect `0.012`).
- [ ] **Step 2-4:** run (build error), implement with `XDocument`, run (PASS).
- [ ] **Step 5: Commit** `Write test results as JUnit XML` / body: "CI servers read JUnit XML; writing it from the Core report keeps the format testable."

### Task 7: Automation: ADS reader `[estimated 1.5 h]`

**Files:**
- Create: `cli/src/IECode.Automation/AdsTestReader.cs`
- Test: `cli/tests/IECode.Automation.Tests/AdsTestReaderTests.cs` (with `FakeLink`)

**Interfaces:**
- Consumes: `AdsWatchBackend` internal ctor (`string where, Func<IAdsLink> newLink, …`), `ReadOnce`.
- Produces: `[SupportedOSPlatform("windows")] public sealed class AdsTestReader(AdsWatchBackend backend) : ITestSymbolReader` (`Read`: `ReadOnce(path).Value`; `IECodeException` with `ExitCodes.NotFound` → `null`, the adapters decide whether a missing symbol is an error, Task 3, R67; `AdsFault` propagates and the CLI maps it to exit 16, also while connecting, R65: `TestRun.ConnectWithRetry` wraps `AdsWatchBackend.Connect`).

- [ ] **Step 1: Failing tests:** `MissingSymbolReadsNull`, `ValueIsCanonicalText` (BOOL → `TRUE`), `ConnectionLossPropagates`, `OtherErrorsPropagate` (an `IECodeException` that is not `NotFound` is not turned into `null`).
- [ ] **Step 2-4:** run `dotnet test --project cli/tests/IECode.Automation.Tests --filter-class "*AdsTestReaderTests"` (build error), implement, run (PASS).
- [ ] **Step 5: Commit** `Read test framework symbols over ADS` / body: "The test command reads a handful of symbols once per poll; reusing the watch backend keeps its fault handling."

### Task 8: Test output (Core) `[estimated 1.5 h]`

**Files:** Create `cli/src/IECode.Core/Testing/TestOutput.cs`; Test `cli/tests/IECode.Core.Tests/TestOutputTests.cs`.

**Interfaces:**
- Consumes: `TestReport`, `WaitVerdict`, `TestRun.ExitCode` (Tasks 3 and 5).
- Produces: `public static class TestOutput { public static IReadOnlyList<string> Lines(TestReport report); public static string Summary(TestReport report); public static object Json(string solution, string plc, string target, TestReport report); public static int ExitCode(WaitVerdict verdict, TestReport? report, bool allowEmpty); }`. `Lines`: one line per case `✔|✖|○ Suite.Test (0.012 s)`, a failure message indented under its line, warnings last. `Json`: `{ solution, plc, framework, target, total, passed, failed, skipped, seconds, cases: [{ suite, name, status, message, seconds }] }` (Decision 7). `ExitCode`: `Finished` → `TestRun.ExitCode(report, allowEmpty)`, `TimedOut` → 17, `PlcStopped`, `ConnectionLost` → 16, `NotLoaded` → 3, `Poll` is a programming error (throws `InvalidOperationException`).

- [ ] **Step 1: Write the failing tests:** `LinesUseOneMarkerPerStatus` (`✔`, `✖`, `○`), `FailureMessageIsIndentedUnderItsCase`, `TimesUseInvariantCulture` (run under `de-DE`: `0.012 s`), `SummaryLine` (`Tests: 3 · passed 1 · failed 1 · skipped 1 · 0.5 s`), `JsonShape` (serialised with `Reporter.JsonOptions`: the property names are exactly the Decision 7 list, `cases[1].status` is `failed`, a null message is omitted as elsewhere), `WarningsAreListedAfterTheCases`, `ExitCodeFollowsTheVerdict` (theory: `Finished` with a failed case → 21, `TimedOut` → 17, `PlcStopped` → 16, `ConnectionLost` → 16, `NotLoaded` → 3, `Finished` all passed → 0, `Poll` throws).
- [ ] **Step 2: Run** `--filter-class "*TestOutputTests"`; expected: build error. **Step 3: Implement.** **Step 4: Run**; expected: PASS.
- [ ] **Step 5: Commit** `Format iecode test results and map the run to an exit code` / body: "The per-case lines, the JSON shape and the exit-code mapping are what CI scripts depend on; in Core they are tested instead of living untested in the command."

### Task 9: Activation without save (Automation; only if spike S1 allowed it) `[estimated 1 h]`

**Files:**
- Modify: `cli/src/IECode.Automation/XaeShell.Plc.cs:147-190`: the wrapper `Activate(AmsNetId target, bool restart, string? projectName, bool save = true)` (`:147`) and `ActivateCore` (`:149`) both get `save`, and the wrapper passes it on; with `save: false` skip `SaveAll()` (`:169`) and `project.Save()` (`:190`) only; the target switch, the helper-process `DialogWatch` (`:171-185`) and the `COMException` mapping stay untouched. The only other caller, `activate` (`ProjectCommands.cs:284`), keeps the default `true`. If S1 did not allow it, this task is dropped and `test` saves like `activate` (Decision 8).

There is no unit test: both methods go through COM late binding on a running XAE. The check is S1's own result plus Task 10 Step 3 (f) (`git status` clean with `--isolate`, and without it after a run).

- [ ] **Step 1: Implement** the parameter on both methods, default `true`, so no existing call changes.
- [ ] **Step 2: Build** `dotnet build cli/src/IECode.Automation`; expected: 0 errors; the Automation tests stay green.
- [ ] **Step 3: Commit** `Allow activation without saving the project` / body: "Activation saves the solution and the project, which dirties the working tree of a test run; spike S1 showed TwinCAT activates without it, so a caller may now ask for that."

### Task 10: `iecode test` command, docs, end-to-end check `[estimated 0.5 day]`

**Files:**
- Create: `cli/src/IECode.Cli/Commands/TestCommand.cs`
- Modify: `cli/src/IECode.Cli/Program.cs:19-27` (`root.Subcommands.Add(TestCommand.Create());`), `cli/README.md` (command row after `activate` at `:20`; exit-code row `| 21 | Tests failed or no test ran (`test`) |`; CI example with `--isolate --yes --junit`; a "Known limits" paragraph under the command: the runtime is **not restored** after the run and stays in Run with the test configuration (R66), Ctrl+C is not handled and can leave an isolated copy for 24 h and an XAE shell behind (R15), only the documented test folder pattern is detected, otherwise `--plc` (R37), `--port` is required when the solution has more than one PLC project (R70)), `extension/CHANGELOG.md` (`## Unreleased`: "CLI: `iecode test` runs PLC unit tests (TcUnit, or any framework through a symbol map) on the local runtime and reports each test case; exit 21 when a test fails. The runtime is not restored afterwards and Ctrl+C is not handled (known limits).").

**Interfaces:**
- Consumes: everything above. Options: `[sln]`, `--plc`, `--adapter <file>`, `--target` (default `local`), `--port` (required with more than one PLC project, else 851 or the value S2 made readable; Decision 9), `--test-timeout` (300), `--junit <file>`, `--allow-empty`, `--no-build`, `--isolate`, `--keep-isolated`, `--isolate-dir`, `--project` (TwinCAT project as in `activate`).
- Order inside the action: find solution → `Preflight` → early safety check (`TestSafety`, ids resolved with `LocalTarget.Resolve`, `Target.State` of the resolved local runtime; confirm with `TestSafety.ConfirmationText` or exit 130) → `WithShell(ctx, path, saves: true, body, discard: !save)` with, inside the body: build (`--no-build` skips it, and a stale `.tmc` then only warns, R64) → read the `.tmc` of the candidate PLC projects (from the copy when isolated, before it is deleted) → `TestProjectSelection.Select` and `TestFrameworks.Detect` (none → exit 3 "No test framework found in <plc>.tmc", hint "build first, or pass --adapter"; this exit can only follow a build, R64) → `TestTarget.Resolve` (system project, PLC, port; exit 2 on a conflict, R70) → **re-check** `TestSafety.NeedsConfirmation` with a fresh `Target.State` right before `Activate` (R69; with `--yes` on a remote target read the state and log `TestSafety.RemoteWarning`) → `Activate(…, restart: true, save)` (`saves: true` as `build --no-save` does, because XAE may write a project while building, `ProjectCommands.cs:115`; `discard` closes without saving when S1 allowed `save: false`) → `WithShell` returns, so the shell is closed and a shutdown dialog has failed the command (exit 1) before any test result is read → `TestRun.ConnectWithRetry(backend.Connect, …)` inside the 60 s start window (R65) → loop every 500 ms: `ReadPlcState(0)`, `adapter.IsLoaded`, `adapter.IsFinished`, `TestRun.Decide(state, reachedRun, loaded, finished, …)` (the loop keeps `reachedRun`; no `AdsState`-only check) → `adapter.Read` → `TestOutput.Lines` / `Summary` / `Json`, `--junit` → `TestOutput.ExitCode`. With `--isolate`: same as `build --isolate` (copy, run, `TryDelete`).

- [ ] **Step 1: Implement** `TestCommand.Create()` with `Action(cmd, …, windowsOnly: true)`; no logic beyond the order above (every decision, the output and the exit code come from Core, Tasks 2, 3, 5 and 8).
- [ ] **Step 2: Build** `dotnet build cli/src/IECode.Cli`; expected: 0 errors. Then the full Core and Automation test runs; expected: all green.
- [ ] **Step 3: Manual (TwinCAT PC, 4024 and 4026, the S2 solution; budget about 0.5 day after merge, R4; a PC with no connected machine, M9):** (j) a fresh clone without any `.tmc`: `iecode test <sln> --yes` builds first and detects the framework afterwards (R64); `--no-build` in that clone → exit 3 with the build hint; (k) a solution with a library PLC and the test PLC and no `--port` → exit 2 asking for `--port`; with a wrong `--port` → exit 3 after activation ("framework symbols not on port"), nothing hangs (R70); (l) stop the TwinCAT service from outside while the tests run → exit 16 within seconds, not after 60 s (R65); (m) start the local runtime in Run while the build runs (second shell) → the re-check asks again, with no `--yes` and redirected input exit 130 (R69); (n) the confirmation text and the log line say the runtime is not restored (R66); (a) `iecode test <sln> --yes --junit out.xml` → three case lines, exit 21, `out.xml` valid; (b) fix the failing test, again → exit 0; (c) with the local runtime in Run and no `--yes`, input redirected → exit 130, nothing activated; (d) `--plc` unknown → exit 3; (e) a suite that never reports finished (not a `WHILE TRUE` loop: that trips the watchdog and is case (h)) with `--test-timeout 20` → exit 17; (h) a test that stops the PLC (division by zero or watchdog) → exit 16 with the PLC state; (i) `TWINCAT3DIR` unset in the calling shell and a test PLC whose data types changed since the last activation → the "symbol type change" dialog of the helper process is not confirmed: record whether activation hangs until `--timeout` or fails, and add the README hint "set TWINCAT3DIR" if it hangs; (f) `--isolate` → `git status` clean afterwards; (g) `--adapter` map for a project-specific framework (S0 PC only, map kept outside the repo) → cases listed.
- [ ] **Step 4: Commit** `Add iecode test for PLC unit tests` / body: "Unit tests of a library ran only by hand in XAE; the command activates the test PLC locally, waits for the framework and reports each case with an exit code CI can use."

## Self-review notes

- Spec coverage: activate on local runtime (T9, T10), read result over ADS (T3, T4, T7), per test case (T8, T10), exit code (T5, T8), the project test framework (S0 + T4), JUnit (T6), test PLC rule shared with G (T2), safety (T5), timeout and finished detection (T5), test PLC, system project and port (T5, T10).
- Size: 10 tasks, about 3.5 days plus 0.5 day of spikes and about 0.5 day for the manual PC check after merge (R4), an upper bound `[estimated]`.
