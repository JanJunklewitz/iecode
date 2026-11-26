# Plan E: `iecode ws build --parallel N` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode ws build --parallel N` builds the solutions of a workspace on up to N XAE shells at once. A consumer starts only after its workspace producers are built and installed. Each parallel build runs in its own isolated copy, and the output carries a per-solution prefix and ends with a summary table.

**Architecture:** A pure Core scheduler (`BuildSchedule`) turns the workspace graph into solution jobs with dependencies and decides which job a free worker takes next, what happens after a failure, and the exit code. `ParallelLimit` caps N by memory. `Reporter.Child` gives every worker a prefixed reporter that shares the parent's lock. The CLI (`WorkspaceBuild.cs`, new) runs one STA thread per worker, each with its own `ShellSession`. `--parallel 1` (the default) goes through the same scheduler on the main thread, so there is one code path.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, COM late binding (STA threads), named mutexes from round 1.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 (row "Build many repositories in waves": "`--parallel N` only together with isolation (1b) and the repository mutex (2)"), section 2, Q4; [TODO.md](../../../TODO.md) "Large": "`ws build --parallel N` (needs isolation and the mutex)". Round 1: [master plan](2026-11-24-cli-build-workflow-master-plan.md) (R12, R27, R32, R35 apply here).

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`. Windows-only tests are guarded with `WindowsOnly.IsWindows` (`cli/tests/IECode.Core.Tests/WindowsOnly.cs`).
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel.
- JSON output changes are additive; existing exit codes keep their meaning. This plan adds **no** exit code.
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, new options a row in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` with the GitHub noreply address.
- All sizes `[estimated]`. Steps that need a TwinCAT PC (4024 and 4026 installed) are marked manual.
- Plan-specific rules: the default (`--parallel` not given) behaves like today: one worker, no forced isolation, stop at the first failure. Never more than one interactive prompt: credentials are resolved before workers start.

## Premises checked (base `0515a61`, branch `feature/cli-build-workflow-master`)

1. `ws build` is sequential with one `ShellSession`: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs:128-153`. It already groups by solution through `Workspace.BuildStages(order)` (`:122`; `cli/src/IECode.Core/Projects/Workspace.cs:111-117`, record `WorkspaceStage(string Solution, IReadOnlyList<Unit> Units, IReadOnlyList<Unit> Exports)` at `:12`). After a stage is built it exports **every** library of the solution that a later unit uses (`WorkspaceCommands.cs:145-150`). The old gap (second library of a solution never installed, M7) is fixed in round 1, so E does not need to fix it.
2. A library export goes `Runner.StageExport(XaeShell, string? plcName, string finalFile)` → `Runner.FinishExport(Context, StagedExport, TwinCatVersion? installAs)` → `Runner.InstallSaved(Context, string file, TwinCatVersion)` (`cli/src/IECode.Cli/Runner.cs:145-196`). XAE writes into a private `.iecode-<guid>` folder next to the final file (`cli/src/IECode.Core/StagedExport.cs:28-34`), so two exports never share a file.
3. RepTool installs take `RepositoryLock.Acquire(log, Timeout, LockName)` (`cli/src/IECode.Automation/RepTool.cs:90`). The lock is a named mutex `Local\iecode-library-repository` (`cli/src/IECode.Core/RepositoryLock.cs:18`). Named mutexes are owned per thread, so two worker threads of one process are serialised too. Acquire and release happen on the same thread inside `RepTool.Install` (`RepositoryLock.cs:34`).
4. Shell start is gated by the named mutex `Local\iecode-shell-start` around `CreateInstance` and the candidate PID diff (`cli/src/IECode.Automation/XaeShell.cs:68-82`, `:248-277`). The process is adopted only after the running object table names it as the server of this DTE object (`XaeShell.cs:139-150`, `RunningObjects.ServerPidOf`). The gate is thread-owned, so parallel starts in one process stay identifiable. Adoption happens **after** the gate is released, which is safe because it is proven per DTE object.
5. `XaeShell.Start` must run on an STA thread: `ComMessageFilter.Register` checks it (`cli/src/IECode.Automation/Interop/ComMessageFilter.cs:29`); only `Main` is `[STAThread]` (`cli/src/IECode.Cli/Program.cs:10`).
6. `ShellSession` decides per item with `TcLineGuard.PlanFor(open, request, saves, shellFailed, openSolution, solution)` → `ShellPlan.Keep | OpenHere | Replace` (`cli/src/IECode.Core/TcLineGuard.cs:4-12, 36-39`; `Runner.cs:235-306`). It restarts on a line change and after a dialog. `ShellSession.Close()` returns the dialog failure of the shutdown (`Runner.cs:298-303`), and `ws build` throws it (`WorkspaceCommands.cs:153`). `Request` is now `TwinCatVersion.UsedBy(shell.SelectedVersion, …)` (`Runner.cs:253`).
7. `Reporter` is thread-safe per instance (`_sync`, `cli/src/IECode.Core/Reporter.cs:19`, R27). Shared per-build state that parallel builds would clash on: `MapDiagnostic` (`:65`), the `BeginBuild` counters (`:59-62`), `TwinCatVersion` (`:29`, set by `XaeShell.SelectVersion`, `XaeShell.cs:354`), and the overwriting status line (`:40`, called every 300 ms from `XaeShell.Build.cs:99`). There is no child or prefix support yet.
8. Isolation copies are **allocated, never replaced**: `Isolation.Create` takes `<hash>-<pid>`, then `-2`, `-3` …, and claims a folder with a marker file opened `FileMode.CreateNew` (`cli/src/IECode.Core/Isolation.cs:177-199, 252-270`). Stale cleanup goes by marker (owner PID plus start time, 24 h; `:288-299`). Two isolated builds of one repository root in one process (two threads) therefore get two folders already. M6 is fixed in round 1 (see Task 3).
9. Exit aggregation exists as `BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)` (`cli/src/IECode.Core/BuildTriage.cs:33`).
10. Build order and links: `Workspace.BuildOrder(ISet<string>? only)` (`Workspace.cs:84`), `Link(From, To, Reference, IsWorkspace)` (`:15`, built at `:67-79`).
11. `StartShell` may prompt for a password (`Runner.Credentials`, called at `Runner.cs:208`, defined at `:309`). With parallel workers that would mean several prompts at once.
12. `Context(ParseResult Parse, Reporter Log)` is a record (`cli/src/IECode.Cli/Globals.cs:44`), so a worker context is `ctx with { Log = child }`.
13. The extension does not call `ws build` (no match in `extension/src`), so the JSON change only reaches scripts.

**Unverified (TwinCAT PC only) → Task 1 spike:**
- U1: two hidden shells in one iecode process, started from two STA threads, can build two isolated solutions at the same time (no COM cross-talk, both PIDs owned).
- U2: peak working set of a building shell (4024 and 4026). This sets `ParallelLimit.PerShellBytes`.
- U3: a shell started **before** RepTool installed a new library version sees that version when it opens a consumer afterwards. Sequential `ws build` already relies on this today (same shell, RepTool in a fresh process), but nobody has measured it.

## Depends on (round-1 symbols, real signatures)

- `public static IsolatedCopy Isolation.Create(string solution, string isolateDir, int? pid = null)` (allocates a free folder), `Isolation.RootOf(string)`, `Isolation.OutsideRoot(string solution, string root)`, `Isolation.MapBack(Diagnostic, IsolatedCopy)`, `Isolation.DefaultDir`, `IsolatedCopy.TryDelete(TimeSpan)`.
- `public static RepositoryLock RepositoryLock.Acquire(Reporter log, TimeSpan timeout, string name = Name)` (indirectly through `RepTool.Install`).
- `public static ShellPlan TcLineGuard.PlanFor(TwinCatVersion? open, TwinCatVersion request, bool saves, bool shellFailed, string? openSolution, string solution)`, `TcLineGuard.Choose(...)`, `Runner.ChooseVersion(Context, SolutionFile, bool saves, bool quiet = false)`.
- `Runner.ShellSession(Context ctx, bool saves, bool discard = false)` with `Prepare(string)`, `Open(string solution)`, `Request`, `IECodeException? Close()`.
- `Runner.StageExport(XaeShell, string? plcName, string finalFile)`, `Runner.FinishExport(Context, StagedExport, TwinCatVersion? installAs)` (M2: I's optional `expected` parameter on `InstallSaved` does not change these calls).
- `public IReadOnlyList<WorkspaceStage> Workspace.BuildStages(IEnumerable<Unit> order)`.
- `public static int BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)`; `XaeShell.Build(string? platform, bool save = true)` returning `BuildResult(..., bool StaticAnalysisOnly)`.
- `LibraryCommands.Preflight(Context ctx, IReadOnlyList<BuildStage> stages)` (`LibraryCommands.cs:358`; `BuildStage(IReadOnlyList<PlcProjectFile> Projects, IReadOnlyList<LibraryId> Exports)`, `Restore.cs:14`).
- `Reporter(bool json, bool verbose, TextWriter? stdout, TextWriter? stderr)`, `Reporter.MapDiagnostic`, `Reporter.Report(Triage, bool)`.

## Touches (existing files)

- `cli/src/IECode.Core/Reporter.cs` (new `Child`, status suppressed for children)
- `cli/src/IECode.Core/BuildTriage.cs` (`BuildOutcome.ExitCode` overload for job results)
- `cli/src/IECode.Cli/Runner.cs` (`ShellSession` takes pre-resolved credentials; `StartShell` uses them)
- `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs` (`Build()` options; body moves to the new `WorkspaceBuild.cs`)
- `cli/README.md`, `extension/CHANGELOG.md`
- Possible conflicts: F (`--tc` matrix) and G (`--exclude-plc`) likely edit `Runner.cs` / `ProjectCommands.cs` and maybe `ws build`. E does not touch `ProjectCommands.cs`. J may touch `Reporter.cs`. Order E after F if F changes `ShellSession`.

New: `cli/src/IECode.Core/BuildSchedule.cs`, `cli/src/IECode.Core/ParallelLimit.cs`, `cli/src/IECode.Cli/Commands/WorkspaceBuild.cs`, tests `BuildScheduleTests.cs`, `ParallelLimitTests.cs`, additions to `ReporterTests.cs`, `IsolationTests.cs` (test only; `Isolation.cs` is no longer touched, see premise 8).

## Decisions (delegated)

1. **Jobs are the existing `WorkspaceStage`s.** A job is one stage from `Workspace.BuildStages(order)`: all units of one `.sln` plus its `Exports`. Its dependencies are the stages that own a workspace-link producer (`Link.IsWorkspace`) of any of its units, without counting links inside the same solution. Rejected: units as jobs (two shells would open the same solution), and a second grouping next to `BuildStages` (two rules for one thing).
2. **Ready queue, not strict waves.** A job starts as soon as all its producers are done and installed. "Waves" (dependency levels) are only computed for `--dry-run` and JSON. Rejected: strict waves, where idle workers wait for the slowest build of a wave.
3. **Line affinity.** A free worker prefers a ready job with the same TwinCAT line as its open shell, then the job with the longest chain of dependents behind it, then build order. This keeps restarts (R35: one shell per line) rare. Rejected: plain FIFO, which makes mixed-line workspaces restart shells all the time.
4. **`--parallel N` with N > 1 always isolates.** Every job builds in its own copy (`--isolate` semantics, `saves: false`), because parallel shells would otherwise write `_Libraries` caches and generated files into a shared tree, and two solutions of one monorepo share a root. With N > 1, `--no-save` is implied and a given `--isolate` is accepted. Rejected: an opt-out `--no-isolate`. `--isolate` also works with N = 1 (new for `ws build`).
5. **Memory cap.** `ParallelLimit.Effective(requested, totalMemoryBytes, readyWidth)`: 2 GiB per shell plus 4 GiB reserve, at least 1, hard cap 8, and never more than the widest dependency level. `--parallel 0` means "auto" (the cap). A request above the cap is lowered with a warning, never refused. Spike U2 may change `PerShellBytes`. Rejected: free-memory probing via P/Invoke (it moves during the run and is not portable to the Core tests).
6. **Failure: stop new work, finish running work.** Without `--keep-going`, the first failure starts nothing new; running builds finish and are reported; the rest is `notStarted`. With `--keep-going`, only jobs that depend (transitively) on a failed job are `blocked`; everything else runs. Rejected: killing running shells (the kill path is the dialog-abort path; their diagnostics are still useful).
7. **Exit code: the first non-ok job in build order.** A failed build gives 10. A job that threw `IECodeException` gives its code (12 install, 15 version, 17 timeout …), an unexpected exception gives 99. `blocked` / `notStarted` never decide the code. This is deterministic and matches sequential today, which stops at the earliest failure. Rejected: completion order (not deterministic) and "highest code wins" (no meaning).
8. **Output.** Each worker logs through `Reporter.Child("[<job id>] ")`, which shares the parent's lock: a build's diagnostic block (`Report`) prints as one unit, without lines of other builds in between. No overwriting status line in children; the parent prints `● 2 running: A, B · 3 done · 4 waiting` when a job starts or ends. At the end comes a summary table (status, job, duration, errors, installed libraries, reason). Job id = solution name, `#2` for duplicates.
9. **One shell per worker, kept across that worker's jobs** (its own `ShellSession`, restarts on line change or after a dialog through `PlanFor`). The worker calls `session.Close()` at the end; a shutdown dialog failure becomes an `Error` of that worker's last job. If spike U3 fails, a job whose producer was installed after the worker's shell started gets a fresh shell (Task 5 alternative).
10. **Credentials are resolved once** on the main thread before workers start and passed to each `ShellSession`.
11. **JSON (additive).** `data` keeps `order` and `results` (built jobs, existing fields `unit, ok, errors, warnings, seconds, staticAnalysisOnly`). Each result gains `solution, status ("ok"|"failed"|"error"), exitCode, worker, twinCat, installed: [{library, version}], error`. New: `data.parallel` (effective workers), `data.waves` (list of lists of job ids), `data.skipped: [{unit, solution, status: "blocked"|"notStarted", reason}]`. The top-level `twinCat` is set only when all jobs used one version. Rejected: a `unit` field per diagnostic (the paths are mapped back, so the file shows the solution).

## Review Focus

1. **Two solutions of one repository built at the same time** (monorepo): each needs its own copy folder; neither may delete the other's. Round 1 already allocates free folders; Task 3 pins it for two threads of one process (test `TwoThreadsOfOneProcessGetTwoCopies`).
2. **A consumer in a solution that also contains a library used elsewhere** (cross-solution cycle on solution level although units are acyclic): stop with exit 2 before any build and name the cycle (Task 2 test `SolutionLevelCycleStops`).
3. **Library build fails with `--keep-going`**: its consumers are `blocked` with reason "needs <job>", independent jobs still run, exit is 10 (Task 2 test `KeepGoingBlocksOnlyDependents`).
4. **`--parallel 6` on a 16 GB machine**: lowered to 5 with one warning line, not refused (Task 2 test `RequestAboveTheCapIsLowered`).
5. **Two builds print root causes at the same time**: the two blocks do not interleave line by line (Task 4 test `ChildReportsDoNotInterleave`).

---

### Task 1: Spike on a TwinCAT PC (manual, 45 min, no code commit) — gates Tasks 5 and 6

- [ ] **Step 1 (U1):** Temporary branch only: in `ws build`, run two jobs on two `Thread`s with `SetApartmentState(ApartmentState.STA)`, each `ShellSession` + `Isolation.Create(...)`, on a throwaway workspace with two independent solutions. Record: both builds finish, both PIDs show in `iecode shells list` (each adopted through the running object table, no "could not be told apart" warning), no `RPC_E_*` error beyond `ComCall.Retry`, and each `DialogWatch` stays with its own shell.
- [ ] **Step 2 (U2):** During those builds, record the peak `WorkingSet64` of each `TcXaeShell` process (Task Manager or `Get-Process TcXaeShell | select Id,PeakWorkingSet64`), for 4024 and 4026.
- [ ] **Step 3 (U3):** `--visible`, one shell opens solution A; from another console `iecode lib install Tc3_AxisLib_<new>.library`; then the same shell opens consumer B, which pins the new version, and builds. Record: library manager error or clean build.
- [ ] **Step 4:** Write the three results (anonymised) under a new "Q10 parallel ws build" in `docs/research/cli-build-workflow.md` and commit that doc change.

Gates (M8): U1 fails → stop the plan after Task 4 (Core plus reporter stay useful) and record the reason in TODO.md; the alternative (one iecode child process per worker) needs a new plan and is not improvised inside E. U2 > 2 GiB → set `ParallelLimit.PerShellBytes` to the measured peak rounded up to 0.5 GiB in Task 2. U3 fails → Task 5 includes the fresh-shell rule (decision 9), and the same rule fixes sequential `ws build`.

### Task 2: `BuildSchedule` and `ParallelLimit` (Core)

**Files:**
- Create: `cli/src/IECode.Core/BuildSchedule.cs`, `cli/src/IECode.Core/ParallelLimit.cs`
- Modify: `cli/src/IECode.Core/BuildTriage.cs` (`BuildOutcome.ExitCode` overload)
- Test: `cli/tests/IECode.Core.Tests/BuildScheduleTests.cs`, `ParallelLimitTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record BuildJob(string Id, WorkspaceStage Stage, IReadOnlyList<string> DependsOn, int? Line);` (`Stage` from `Workspace.BuildStages`; its `Exports` are what the job installs)
  - `public enum JobStatus { Waiting, Running, Ok, Failed, Error, Blocked, NotStarted }`
  - `public sealed record JobResult(string Id, JobStatus Status, int ExitCode, string? Reason);`
  - `public sealed class BuildSchedule { public static BuildSchedule From(Workspace w, IReadOnlyList<Unit> order, Func<string, int?> lineOf, bool keepGoing); public IReadOnlyList<BuildJob> Jobs { get; } public IReadOnlyList<IReadOnlyList<string>> Waves { get; } public BuildJob? Next(int? workerLine); public void Finished(string id, JobStatus status, int exitCode, string? reason = null); public bool Done { get; } public IReadOnlyList<JobResult> Results(); }` (not thread-safe; the CLI calls it under one lock)
  - `public static int BuildOutcome.ExitCode(IReadOnlyList<JobResult> resultsInBuildOrder)`
  - `public static class ParallelLimit { public const long PerShellBytes = 2L << 30, ReserveBytes = 4L << 30; public const int HardCap = 8; public static (int Workers, string? Note) Effective(int requested, long totalMemoryBytes, int widestWave); }`

- [ ] **Step 1: Write the failing tests** (build `Workspace` objects in memory from `Unit` / `Link` records with the required init properties; the `PlcProjectFile` instances come from `TempWorkspace` fixtures as in `WorkspaceTests`)

```csharp
[Fact] public void JobsAreTheBuildStages()                     // Jobs.Select(j => j.Stage) equals w.BuildStages(order), same order
[Fact] public void LinksInsideOneSolutionAreNoDependency()     // Assert.Empty(job.DependsOn)
[Fact] public void ConsumerWaitsForItsProducer()
{   // AxisLib.sln (Tc3_AxisLib) ← Machine.sln uses it via workspace link
    var s = Schedule();
    Assert.Equal("AxisLib", s.Next(null)!.Id);
    Assert.Null(s.Next(null));                                 // Machine is not ready yet
    s.Finished("AxisLib", JobStatus.Ok, 0);
    Assert.Equal("Machine", s.Next(null)!.Id);
}
[Fact] public void PinnedLinkIsNoDependency()                  // IsWorkspace false → independent jobs
[Fact] public void SameLineIsPreferred()                       // ready: A(4026), B(4024); Next(4024) == B
[Fact] public void LongerChainFirstWhenLinesTie()
[Fact] public void SolutionLevelCycleStops() =>
    Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => CrossSchedule()).ExitCode);   // message names both solutions, hint "without --parallel"
[Fact] public void FailureStopsNewWork()
{   // A fails while B runs; C (independent) waiting
    s.Finished("A", JobStatus.Failed, ExitCodes.BuildFailed);
    Assert.Null(s.Next(null));
    s.Finished("B", JobStatus.Ok, 0);
    Assert.True(s.Done);
    Assert.Equal(JobStatus.NotStarted, s.Results().Single(r => r.Id == "C").Status);
}
[Fact] public void KeepGoingBlocksOnlyDependents()             // Machine Blocked, Reason "needs AxisLib"; Other runs
[Fact] public void WavesAreDependencyLevels()                  // [["AxisLib","MotorLib"],["Machine"]]
[Fact] public void ExitCodeIsTheFirstFailureInBuildOrder() =>
    Assert.Equal(ExitCodes.LibraryFailed, BuildOutcome.ExitCode([Ok("A"), Err("B", 12), Failed("C"), Blocked("D")]));
[Fact] public void BlockedAndNotStartedAloneAreOk()            // can only happen with no failure → 0
```

`ParallelLimitTests`:

```csharp
[Theory]
[InlineData(1, 16L << 30, 10, 1)]   // default stays 1
[InlineData(0, 16L << 30, 10, 6)]   // auto: (16-4)/2
[InlineData(6, 15_700_000_000, 10, 5)]
[InlineData(4, 64L << 30, 2, 2)]    // never more than the widest wave
[InlineData(20, 128L << 30, 20, 8)] // hard cap
[InlineData(3, 4L << 30, 10, 1)]    // at least 1
public void Effective(int req, long mem, int wave, int expected) => Assert.Equal(expected, ParallelLimit.Effective(req, mem, wave).Workers);
[Fact] public void RequestAboveTheCapIsLowered() => Assert.Contains("5", ParallelLimit.Effective(6, 15_700_000_000, 10).Note);
[Fact] public void NegativeRequestIsUsage() => Assert.Throws<IECodeException>(() => ParallelLimit.Effective(-1, 1L << 34, 3));
```

- [ ] **Step 2: Run to verify they fail.** `dotnet build cli/tests/IECode.Core.Tests`, then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*BuildScheduleTests"` and `"*ParallelLimitTests"`. Expected: build error, types missing.
- [ ] **Step 3: Implement.** Jobs from `w.BuildStages(order)`, dependency edges from `w.Links` restricted to `order`; cycle check by DFS over jobs (the same shape as `Workspace.BuildOrder`). Tie-break order for `Next`: same line, then more transitive dependents, then position in `order`.
- [ ] **Step 4: Run to verify they pass** (same commands). Expected: PASS, the existing `WorkspaceTests` and `BuildOutcomeTests` stay green.
- [ ] **Step 5: Commit** `git commit -s -m "Schedule workspace builds as dependent solution jobs" -m "Parallel ws build needs to know which solution may start, what a failure cancels and which exit code wins; keeping that pure makes it testable without TwinCAT. Jobs are solutions because two shells must not open the same .sln."`

### Task 3: Pin isolated copies of one repository from two threads (test only)

Round 1 already allocates a free folder per copy (premise 8), so M6 needs no code change. This task only pins the behaviour E relies on.

**Files:** Test `cli/tests/IECode.Core.Tests/IsolationTests.cs` (no change to `Isolation.cs`).

- [ ] **Step 1: Test:** `TwoThreadsOfOneProcessGetTwoCopies`: two threads start together (`Barrier`), each runs `Isolation.Create(ws["src/sln/Machine.sln"], TempBase)` with the same process PID. Assert two different `CopyRoot`s, both existing; disposing one leaves the other.
- [ ] **Step 2:** Run `--filter-method "*TwoThreadsOfOneProcessGetTwoCopies"`; expected PASS at once. If it fails, the `Allocate` claim (`Isolation.cs:252-270`) has a race: fix it there and name it in the commit body.
- [ ] **Step 3: Commit** "Pin that parallel copies of one repository get their own folders" (body: parallel ws build creates copies of one monorepo from several threads of one process; the test keeps the round-1 allocation from regressing).

### Task 4: `Reporter.Child` (prefixed, shared lock)

**Files:** Modify `cli/src/IECode.Core/Reporter.cs`; Test `ReporterTests.cs`.

**Interfaces:** Produces `public Reporter Child(string prefix)`. The child has the same `Json`, `Verbose`, `MaxErrors` and color, its own `MapDiagnostic`, `TwinCatVersion` and limit counters. It writes every line with the prefix through the parent's writers under the **parent's** `_sync` (`System.Threading.Lock` is reentrant), and forwards diagnostics and JSON messages to the parent's lists. `Status` / `ClearStatus` do nothing on a child. `Finish` on a child throws `InvalidOperationException`.

- [ ] **Step 1: Failing tests**

```csharp
[Fact] public void ChildPrefixesEveryLine()          // child.Warn("x") → parent stderr "[A] ⚠ x"
[Fact] public void ChildDiagnosticsReachTheParentJson()  // json parent, child.Add(d) → parent.Diagnostics contains mapped d
[Fact] public void ChildMapsWithItsOwnMapper()       // two children, different MapDiagnostic, no cross-effect
[Fact] public void ChildLimitIsPerChild()            // MaxErrors 1: each child prints its first error
[Fact] public void ChildReportsDoNotInterleave()
{   // two threads, each child.Report(triage with 50 errors); parent stderr: the 50 lines of each "[A]"/"[B]" block are contiguous
}
[Fact] public void ChildHasNoStatusLine()            // child.Status("x") writes nothing
```

- [ ] **Step 2:** Run `--filter-class "*ReporterTests"`; expected FAIL.
- [ ] **Step 3:** Implement with a private constructor `(Reporter parent, string prefix)`; the existing public constructor and behaviour stay as they are.
- [ ] **Step 4:** Run; expected PASS, including `LinesFromSeveralThreadsAreAllKept`.
- [ ] **Step 5: Commit** "Add prefixed child reporters for parallel builds" (body: parallel shells share one console; a shared lock keeps each build's error block together, and per-child state keeps one build's path mapping and error limit away from the others).

### Task 5: `ws build --parallel` wiring (CLI)

**Files:**
- Create: `cli/src/IECode.Cli/Commands/WorkspaceBuild.cs` (`internal static class WorkspaceBuild { public static Outcome Run(Context ctx, Workspace w, IReadOnlyList<Unit> order, WorkspaceBuildOptions o); }` with `internal sealed record WorkspaceBuildOptions(int Parallel, bool KeepGoing, bool Isolate, string IsolateDir, bool Save);`)
- Modify: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs:91-157` (options `--parallel <N>` (`int`, default 1, 0 = auto), `--keep-going`, `--isolate`, `--isolate-dir`; the dry run prints `Waves` and the effective worker count; the body after the stage preflight (`:122-124`, unchanged) calls `WorkspaceBuild.Run`)
- Modify: `cli/src/IECode.Cli/Runner.cs:200-212, 235-306` (`ShellSession(Context ctx, bool saves, bool discard = false, (string User, string Password)? credentials = null)`; `StartShell` takes the credentials instead of calling `Credentials(ctx)` when they are given). `ws release` (`WorkspaceCommands.cs:221`) keeps the old call.

**Interfaces:** Consumes everything from Tasks 2 to 4 and the round-1 symbols under "Depends on".

- [ ] **Step 1:** Wiring rules (no Core logic here): `lineOf` = `ChooseVersion(ctx, SolutionFile.Load(sln), saves: !isolated, quiet: true).Request.Line`. Workers = `ParallelLimit.Effective(o.Parallel, GC.GetGCMemoryInfo().TotalAvailableMemoryBytes, schedule.Waves.Max(w => w.Count))`; print its `Note` as a warning. With workers > 1, run each worker on `new Thread(...)` with `SetApartmentState(ApartmentState.STA)`; with 1 worker, run on the calling thread. Each worker has `ctx with { Log = ctx.Log.Child($"[{job.Id}] ") }` per job, plus one `ShellSession` per worker (`saves: !isolated`, `discard: !o.Save || isolated`, the credentials resolved once up front through `Runner.Credentials(ctx)`). Per job: with isolation, check `Isolation.OutsideRoot` (as `ProjectCommands.cs:128-131`, failing that job with exit 2), `Isolation.Create(job.Stage.Solution, dir)`, `child.MapDiagnostic = d => Isolation.MapBack(d, copy)`, `TryDelete` in `finally`. Then `session.Open(...).Build(null, save)`, then for each `job.Stage.Exports` unit `FinishExport(childCtx, StageExport(shell, lib.Plc.Name, file), session.Request)`, the same calls as `WorkspaceCommands.cs:145-150`. `file` is `<source solution folder>\dist\<Title>_<Version>.library`, not inside the copy: `StagedExport` writes into a private `.iecode-<guid>` folder, so parallel exports never share a file, and `dist/` keeps today's result. `BuildSchedule` calls go under one `lock`. An exception in a job becomes `Finished(id, Error, e is IECodeException x ? x.ExitCode : ExitCodes.Unexpected, e.Message)` and never kills the worker thread. At the end the worker calls `session.Close()`; a returned failure becomes an `Error` of its last job (decision 9). Then it disposes the session. If spike U3 failed: the worker restarts its shell when a producer of the next job finished after its shell started (`BuildSchedule` records the finish order; add `public bool InstalledAfter(string jobId, int sequence)` with test `ProducerInstalledAfterShellStartNeedsFreshShell` in Task 2's test file).
- [ ] **Step 2:** Summary table at the end (human mode, `Info`): one line per job, `ok|failed|error|blocked|not started`, id, `m:ss`, errors, installed `Title Version`, reason. Exit = `BuildOutcome.ExitCode(schedule.Results())`. JSON per decision 11.
- [ ] **Step 3:** `dotnet build cli/IECode.slnx`; expected: builds without warnings. Then `dotnet test --project cli/tests/IECode.Core.Tests`; expected: all green.
- [ ] **Step 4 (any OS):** `iecode ws build <fixture workspace> --parallel 0 --dry-run --json` prints `data.waves` and `data.parallel`, exit 0.
- [ ] **Step 5: Commit** "Add ws build --parallel to build independent solutions at once" (body: twelve repositories built one after another took most of a day; consumers still wait for their producer's install, and every parallel build works in its own copy because parallel shells would write into the same tree).

### Task 6: Docs and the check on a TwinCAT PC

**Files:** `cli/README.md` (`ws build` row at line 39: `[--parallel N] [--keep-going] [--isolate [--isolate-dir <dir>]]`, text "N > 1 builds in isolated copies, capped by memory (2 GiB per shell)"), `extension/CHANGELOG.md` (`## Unreleased`: `--parallel`, `--keep-going`, `--isolate` for `ws build`).

- [ ] **Step 1:** Update README and CHANGELOG.
- [ ] **Step 2 (TwinCAT PC, 30 min):** throwaway workspace with `Tc3_AxisLib` ← `Machine`, plus an independent `Tc3_MotorLib`: `iecode ws build --parallel 2` builds `Tc3_AxisLib` and `Tc3_MotorLib` at the same time, `Machine` after the install, and `git status` stays clean in all three. Make `Tc3_AxisLib` fail on purpose: without `--keep-going`, `Machine` is `not started`; with it, `Machine` is `blocked` and `Tc3_MotorLib` ok; exit 10 both times. `iecode shells list` is empty afterwards.
- [ ] **Step 3: Commit** docs (`git commit -s`, subject "Document parallel workspace builds", body: why).

## Known limits

- Every parallel job copies its whole repository root; a monorepo with many solutions is copied once per solution (no shared copy).
- An isolated parallel build still writes `dist/*.library` (and briefly a `dist/.iecode-<guid>` staging folder) into the source solution folder, as sequential `ws build` does today.
- Sequential `ws build` today builds a stage that depends on a later stage's export (cross-solution cycle) without a warning; only the scheduler path detects it. Once N = 1 also goes through the scheduler, that case stops with exit 2 (CHANGELOG line).
- The memory cap uses total physical memory, not free memory; other heavy programs during the run are not taken into account.
- Ctrl+C ends iecode; the kill-on-close job ends the shells, and leftover copies are cleaned up after 24 h by a later isolated build.

Size: 2.25 days plus 75 min on a TwinCAT PC `[estimated]` (Task 3 shrank to a test, the stage model already existed).
