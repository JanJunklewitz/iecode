# Plan E: `iecode ws build --parallel N` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode ws build --parallel N` builds the solutions of a workspace on up to N XAE shells at once. A consumer starts only after its workspace producers are built and installed. Each parallel build runs in its own isolated copy, and the output carries a per-solution prefix and ends with a summary table.

**Architecture:** A pure Core scheduler (`BuildSchedule`) turns the workspace graph into solution jobs with dependencies and decides which job a free worker takes next, what happens after a failure, and the exit code. `ParallelLimit` caps N by memory. `Reporter.Child` gives every worker a prefixed reporter that shares the parent's lock. The CLI (`WorkspaceBuild.cs`, new) runs one STA thread per worker, each with its own `ShellSession`. `--parallel 1` (the default) goes through the same scheduler on the main thread, so there is one code path.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, COM late binding (STA threads), named mutexes from round 1.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 (row "Build many repositories in waves": "`--parallel N` only together with isolation (1b) and the repository mutex (2)"), section 2, Q4; [TODO.md](../../../TODO.md) "Large": "`ws build --parallel N` (needs isolation and the mutex)". Round 1: [master plan](2026-11-24-cli-build-workflow-master-plan.md) (R12, R27, R32, R35 apply here).

**Review changes (round-2 decision ledger, master plan "Review"):** R2: Task 1 (two sessions). R3: Task 5 Step 0 (pure-move commit first, `expected` argument by whoever lands second). R4: Task 6 Step 2 (manual check, about 0.5 day). R7: decision 12, premise 14, Task 4 (`BeginJob`), Task 5 Step 1. R8: Task 2 (`Pick`), Task 4b (`ParallelBuild`). R9: decision 3, Task 2 (`SingleWorkerFollowsBuildOrder`). R10: decision 4, Task 5 Step 1 (warning line), Task 6 (README, CHANGELOG, TODO). R11: Task 4b. R12: decision 7, Task 2 (`JobsExitCode`). R13: Task 5 Step 4. R14: decision 11, Task 4. R15: premise 15, Known limits, Task 6. R16: Task 5 Step 0. R17: decision 13, premise 17, Task 4b, Task 1 Step 3b. R18: decision 9, premise 16, Task 4b. R19: Task 1 Step 1.

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`. Windows-only tests are guarded with `WindowsOnly.IsWindows` (`cli/tests/IECode.Core.Tests/WindowsOnly.cs`).
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel.
- JSON output changes are additive; existing exit codes keep their meaning. This plan adds **no** exit code.
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, new options a row in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` with the GitHub noreply address.
- All sizes `[estimated]`. Steps that need a TwinCAT PC (4024 and 4026 installed) are marked manual.
- Plan-specific rules: the default (`--parallel` not given) behaves like today: one worker, no forced isolation, stop at the first failure. Never more than one interactive prompt: credentials are resolved before workers start.

## Premises checked (base `main` at `f817efe`)

1. `ws build` is sequential with one `ShellSession`: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs:128-153`. It already groups by solution through `Workspace.BuildStages(order)` (`:122`; `cli/src/IECode.Core/Projects/Workspace.cs:111-117`, record `WorkspaceStage(string Solution, IReadOnlyList<Unit> Units, IReadOnlyList<Unit> Exports)` at `:12`). After a stage is built it exports **every** library of the solution that a later unit uses (`WorkspaceCommands.cs:145-150`). The old gap (second library of a solution never installed, M7) is fixed in round 1, so E does not need to fix it.
2. A library export goes `Runner.StageExport(XaeShell, string? plcName, string finalFile)` → `Runner.FinishExport(Context, StagedExport, TwinCatVersion? installAs)` → `Runner.InstallSaved(Context, string file, TwinCatVersion)` (`cli/src/IECode.Cli/Runner.cs:148-204`). XAE writes into a private `.iecode-<guid>` folder next to the final file (`cli/src/IECode.Core/StagedExport.cs:28-34`), so two exports never share a file.
3. RepTool installs take `RepositoryLock.Acquire(log, Timeout, LockName)` (`cli/src/IECode.Automation/RepTool.cs:90`). The lock is a named mutex `Local\iecode-library-repository` (`cli/src/IECode.Core/RepositoryLock.cs:18`). Named mutexes are owned per thread, so two worker threads of one process are serialised too. Acquire and release happen on the same thread inside `RepTool.Install` (`RepositoryLock.cs:34`).
4. Shell start is gated by the named mutex `Local\iecode-shell-start` around `CreateInstance` and the candidate PID diff (`cli/src/IECode.Automation/XaeShell.cs:68-82`, `:249-278`). The process is adopted only after the running object table names it as the server of this DTE object (`XaeShell.cs:139-150`, `RunningObjects.ServerPidOf`). The gate is thread-owned, so parallel starts in one process stay identifiable. Adoption happens **after** the gate is released, which is safe because it is proven per DTE object.
5. `XaeShell.Start` must run on an STA thread: `ComMessageFilter.Register` checks it (`cli/src/IECode.Automation/Interop/ComMessageFilter.cs:29`); only `Main` is `[STAThread]` (`cli/src/IECode.Cli/Program.cs:10`).
6. `ShellSession` decides per item with `TcLineGuard.PlanFor(open, request, saves, shellFailed, openSolution, solution)` → `ShellPlan.Keep | OpenHere | Replace` (`cli/src/IECode.Core/TcLineGuard.cs:4-12, 36-39`; `Runner.cs:251-322`). It restarts on a line change and after a dialog. `ShellSession.Close()` returns the dialog failure of the shutdown (`Runner.cs:314-319`), and `ws build` throws it (`WorkspaceCommands.cs:153`). `Request` is now `TwinCatVersion.UsedBy(shell.SelectedVersion, …)` (`Runner.cs:269`).
7. `Reporter` is thread-safe per instance (`_sync`, `cli/src/IECode.Core/Reporter.cs:19`, R27). Shared per-build state that parallel builds would clash on: `MapDiagnostic` (`:65`), the `BeginBuild` counters (`:59-62`), `TwinCatVersion` (`:29`, set by `XaeShell.SelectVersion`, `XaeShell.cs:355`), and the overwriting status line (`:40`, called every 300 ms from `XaeShell.Build.cs:99`). There is no child or prefix support yet.
8. Isolation copies are **allocated, never replaced**: `Isolation.Create` takes `<hash>-<pid>`, then `-2`, `-3` …, and claims a folder with a marker file opened `FileMode.CreateNew` (`cli/src/IECode.Core/Isolation.cs:177-199, 252-270`). Stale cleanup goes by marker (owner PID plus start time, 24 h; `:288-299`). Two isolated builds of one repository root in one process (two threads) therefore get two folders already. M6 is fixed in round 1 (see Task 3).
9. Exit aggregation exists as `BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)` (`cli/src/IECode.Core/BuildTriage.cs:33`).
10. Build order and links: `Workspace.BuildOrder(ISet<string>? only)` (`Workspace.cs:84`), `Link(From, To, Reference, IsWorkspace)` (`:15`, built at `:67-79`).
11. `StartShell` may prompt for a password (`Runner.Credentials`, called at `Runner.cs:216`, defined at `:325`). With parallel workers that would mean several prompts at once.
12. `Context(ParseResult Parse, Reporter Log)` is a record (`cli/src/IECode.Cli/Globals.cs:44`), so a worker context is `ctx with { Log = child }`.
13. The extension does not call `ws build` (no match in `extension/src`), so the JSON change only reaches scripts.
14. (R7) A session captures its context once: `ShellSession(Context ctx, bool saves, bool discard = false)` (`Runner.cs:251`) uses `ctx.Log` for every shell start and version note (`Runner.cs:262, 286-289, 306`), and `XaeShell` keeps `private readonly Reporter _log` from its constructor (`XaeShell.cs:33, 47`). A reporter created per job would therefore never reach the shell from the second job on; the reporter has to be one per worker and re-targeted per job (decision 12). `XaeShell` is not changed for this.
15. (R15) There is no `CancelKeyPress` handler in `cli/src` (grep). Ctrl+C ends the process without `finally` blocks, so copies stay for the 24 h cleanup and shells end only through the kill-on-close job (`XaeShell.cs:161`); no job has a watchdog. Round 2 adds no handler (Known limits).
16. (R18) `XaeShell.CloseWithoutSaving()` is private and runs only at the next `OpenSolutionCore` or at shutdown, and only when `DiscardChanges` is set (`XaeShell.cs:413-419, 427`). So the solution of a job is still open in the worker's shell when the job's `finally` deletes the copy, unless a step closes it first (Task 4b `IsolatedJob`, Task 5 Step 1).
17. (R17) A library is installed for the TwinCAT line of the producer's shell: `FinishExport(ctx, staged, session.Request)` (`WorkspaceCommands.cs:149`, `Runner.cs:148-204`). A consumer on another line may not see that install, so a finished producer is not proof that the edge works. Sequential `ws build` has the same limit; the scheduler would hide it (decision 13).

**Unverified (TwinCAT PC only) → Task 1 spike:**
- U1: two hidden shells in one iecode process, started from two STA threads, can build two isolated solutions at the same time (no COM cross-talk, both PIDs owned). (R19) The start gate calls `CreateInstance` before the dialog watch exists (`XaeShell.cs:68-82` against `:137`), so U1 also covers one worker with a blocked start and one with a modal dialog.
- U2: peak working set of a building shell (4024 and 4026). This sets `ParallelLimit.PerShellBytes`.
- U3: a shell started **before** RepTool installed a new library version sees that version when it opens a consumer afterwards. Sequential `ws build` already relies on this today (same shell, RepTool in a fresh process), but nobody has measured it.
- U4: (R17) a library installed through a 4024 shell is visible to a consumer opened in a 4026 shell, and the reverse. This sets whether the line edge pre-check (decision 13) is only a guard or a hard limit.

## Depends on (round-1 symbols, real signatures)

- `public static IsolatedCopy Isolation.Create(string solution, string isolateDir, int? pid = null)` (allocates a free folder), `Isolation.RootOf(string)`, `Isolation.OutsideRoot(string solution, string root)`, `Isolation.MapBack(Diagnostic, IsolatedCopy)`, `Isolation.DefaultDir`, `IsolatedCopy.TryDelete(TimeSpan)`.
- `public static RepositoryLock RepositoryLock.Acquire(Reporter log, TimeSpan timeout, string name = Name)` (indirectly through `RepTool.Install`).
- `public static ShellPlan TcLineGuard.PlanFor(TwinCatVersion? open, TwinCatVersion request, bool saves, bool shellFailed, string? openSolution, string solution)`, `TcLineGuard.Choose(...)`, `Runner.ChooseVersion(Context, SolutionFile, bool saves, bool quiet = false)`.
- `Runner.ShellSession(Context ctx, bool saves, bool discard = false)` with `Prepare(string)`, `Open(string solution)`, `Request`, `IECodeException? Close()`.
- `Runner.StageExport(XaeShell, string? plcName, string finalFile)`, `Runner.FinishExport(Context, StagedExport, TwinCatVersion? installAs)` (M2: I's optional `expected` parameter on `InstallSaved` does not change these calls).
- `public IReadOnlyList<WorkspaceStage> Workspace.BuildStages(IEnumerable<Unit> order)`.
- `public static int BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)`; `XaeShell.Build(string? platform, bool save = true)` returning `BuildResult(..., bool StaticAnalysisOnly)`.
- `LibraryCommands.Preflight(Context ctx, IReadOnlyList<BuildStage> stages)` (`LibraryCommands.cs:368`; `BuildStage(IReadOnlyList<PlcProjectFile> Projects, IReadOnlyList<LibraryId> Exports)`, `Restore.cs:14`).
- `Reporter(bool json, bool verbose, TextWriter? stdout, TextWriter? stderr)`, `Reporter.MapDiagnostic`, `Reporter.Report(Triage, bool)`.

## Touches (existing files)

- `cli/src/IECode.Core/Reporter.cs` (new `Child`, `BeginJob`, status suppressed for children)
- `cli/src/IECode.Core/Diagnostics.cs` (`Diagnostic` gets the trailing optional field `Job`, after `Tc` once F has landed, M5; R14)
- `cli/src/IECode.Core/BuildTriage.cs` (`BuildOutcome.JobsExitCode` for job results)
- `cli/src/IECode.Cli/Runner.cs` (`ShellSession` takes pre-resolved credentials and gets `CloseSolution()`; `StartShell` uses the credentials; re-check I's `expected` argument on `FinishExport` / `InstallSaved` (M2) before Task 5, R16)
- `cli/src/IECode.Automation/XaeShell.cs` (`CloseWithoutSaving` becomes public `CloseSolutionWithoutSaving`, visibility only; R18)
- `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs` (`Build()` options; body moves to the new `WorkspaceBuild.cs`; I's `expected` argument at the `FinishExport` call by whichever of E and I lands second, M2)
- `cli/README.md`, `extension/CHANGELOG.md`, `TODO.md` (deferred items, R10 and R15)
- Possible conflicts: F (`--tc` matrix) and G (`--exclude-plc`) likely edit `Runner.cs` / `ProjectCommands.cs` and maybe `ws build`. E does not touch `ProjectCommands.cs`. F's only `Runner.cs` change is one `TcMatrix.RejectList` call, so E does not depend on F's `ShellSession`; E needs no change from F or G to start (E's follow-up `ws build --no-tests` needs G's `PlcSelection`).

New: `cli/src/IECode.Core/BuildSchedule.cs`, `cli/src/IECode.Core/ParallelLimit.cs`, `cli/src/IECode.Core/ParallelBuild.cs` (worker loop, `IsolatedJob`, `BuildPreCheck`; R11), `cli/src/IECode.Cli/Commands/WorkspaceBuild.cs`, tests `BuildScheduleTests.cs`, `ParallelLimitTests.cs`, `ParallelBuildTests.cs`, additions to `ReporterTests.cs`, `IsolationTests.cs` (test only; `Isolation.cs` is no longer touched, see premise 8).

## Decisions (delegated)

1. **Jobs are the existing `WorkspaceStage`s.** A job is one stage from `Workspace.BuildStages(order)`: all units of one `.sln` plus its `Exports`. Its dependencies are the stages that own a workspace-link producer (`Link.IsWorkspace`) of any of its units, without counting links inside the same solution. Rejected: units as jobs (two shells would open the same solution), and a second grouping next to `BuildStages` (two rules for one thing).
2. **Ready queue, not strict waves.** A job starts as soon as all its producers are done and installed. "Waves" (dependency levels) are only computed for `--dry-run` and JSON. Rejected: strict waves, where idle workers wait for the slowest build of a wave.
3. **Line affinity.** A free worker prefers a ready job with the same TwinCAT line as its open shell, then the job with the longest chain of dependents behind it, then build order. This keeps restarts (R35: one shell per line) rare. Rejected: plain FIFO, which makes mixed-line workspaces restart shells all the time. (R9) With **one** worker the rule is pure build order: no affinity, no chain length, and `lineOf` is never called (so no `ChooseVersion(saves: true)` for every solution up front, and `--parallel 1` behaves like today). With more workers `lineOf` is evaluated lazily and a failure inside it means "unknown line" (`null`), never an exception.
4. **`--parallel N` with N > 1 always isolates.** Every job builds in its own copy (`--isolate` semantics, `saves: false`), because parallel shells would otherwise write `_Libraries` caches and generated files into a shared tree, and two solutions of one monorepo share a root. With N > 1, `--no-save` is implied and a given `--isolate` is accepted. Rejected: an opt-out `--no-isolate`. `--isolate` also works with N = 1 (new for `ws build`). (R10) The result therefore differs from `--parallel 1`: solutions are not saved and no `.tmc` returns to the source tree. This is stated in the README row, the CHANGELOG line and one warning line at the start of every run with more than one effective worker; a per-job `--copy-tmc` is deferred (TODO.md, Task 6).
5. **Memory cap.** `ParallelLimit.Effective(requested, totalMemoryBytes, readyWidth)`: 2 GiB per shell plus 4 GiB reserve, at least 1, hard cap 8, and never more than the widest dependency level. `--parallel 0` means "auto" (the cap). A request above the cap is lowered with a warning, never refused. Spike U2 may change `PerShellBytes`. Rejected: free-memory probing via P/Invoke (it moves during the run and is not portable to the Core tests).
6. **Failure: stop new work, finish running work.** Without `--keep-going`, the first failure starts nothing new; running builds finish and are reported; the rest is `notStarted`. With `--keep-going`, only jobs that depend (transitively) on a failed job are `blocked`; everything else runs. Rejected: killing running shells (the kill path is the dialog-abort path; their diagnostics are still useful).
7. **Exit code: the first non-ok job in build order.** A failed build gives 10. A job that threw `IECodeException` gives its code (12 install, 15 version, 17 timeout …), an unexpected exception gives 99. `blocked` / `notStarted` never decide the code. This is deterministic among the jobs that ran, and then matches sequential today, which stops at the earliest failure (R12: with `--keep-going` or a stop, jobs after a failure may have run or not, so the claim holds only for the set of jobs that ran). The overload has its own name, `BuildOutcome.JobsExitCode`, because `ExitCode([])` is ambiguous between the `bool` and the job-result overloads. Rejected: completion order (not deterministic) and "highest code wins" (no meaning).
8. **Output.** Each worker logs through one `Reporter.Child` (re-targeted per job, decision 12) with the prefix `[<job id>] `, which shares the parent's lock: a build's diagnostic block (`Report`) prints as one unit, without lines of other builds in between. No overwriting status line in children; the parent prints `● 2 running: A, B · 3 done · 4 waiting` when a job starts or ends. At the end comes a summary table (status, job, duration, errors, installed libraries, reason). Job id = solution name, `#2` for duplicates.
9. **One shell per worker, kept across that worker's jobs** (its own `ShellSession`, restarts on line change or after a dialog through `PlanFor`). The worker calls `session.Close()` at the end; a shutdown dialog failure becomes an `Error` of that worker's last job. (R18) The job's copy is deleted only after the worker's shell has closed that solution without saving (`ShellSession.CloseSolution()`); if the close fails, the copy is kept and its path is reported. If spike U3 fails, a job whose producer was installed after the worker's shell started gets a fresh shell (Task 5 alternative).
10. **Credentials are resolved once** on the main thread before workers start and passed to each `ShellSession`.
11. **JSON (additive).** `data` keeps `order` and `results` (built jobs, existing fields `unit, ok, errors, warnings, seconds, staticAnalysisOnly`). Each result gains `solution, status ("ok"|"failed"|"error"), exitCode, worker, twinCat, installed: [{library, version}], error`. New: `data.parallel` (effective workers), `data.waves` (list of lists of job ids), `data.skipped: [{unit, solution, status: "blocked"|"notStarted", reason}]`. The top-level `twinCat` is set only when all jobs used one version. Rejected: a `unit` field per diagnostic (the paths are mapped back, so the file shows the solution). (R14) Instead `Diagnostic` gets one additive trailing field `Job` (the job id, after `Tc` per M5 once F has landed), set by the child reporter, so diagnostics of several jobs in one JSON list can be told apart; a sequential run leaves it null.
12. **One child reporter per worker, re-targeted per job (R7).** `ShellSession` and `XaeShell` take their reporter once (premise 14), so the worker creates one `Reporter.Child` and passes it to its `ShellSession` through `ctx with { Log = child }` once. Before each job the worker calls `child.BeginJob(jobId, map)`: it sets the prefix and the `Job` stamp, installs the job's `MapDiagnostic` (or null) and resets the print counters. `XaeShell` is not changed for this. Rejected: a new child per job (the shell would keep the first one) and changing `XaeShell` to accept a reporter per call.
13. **Pre-check before the first build (R17, M12).** With more than one effective worker, before any shell starts: (a) every job's solution passes `Isolation.OutsideRoot` (M12); (b) no workspace edge joins a producer and a consumer whose TwinCAT lines differ (lines from `lineOf`, unknown lines are skipped). Any hit stops with exit 2, lists the solutions or edges and gives the hint "run without --parallel". Rejected: building anyway and letting the consumer fail in the middle of a run. Spike U4 decides whether (b) can later be relaxed.

## Review Focus

1. **Two solutions of one repository built at the same time** (monorepo): each needs its own copy folder; neither may delete the other's. Round 1 already allocates free folders; Task 3 pins it for two threads of one process (test `TwoThreadsOfOneProcessGetTwoCopies`).
2. **A consumer in a solution that also contains a library used elsewhere** (cross-solution cycle on solution level although units are acyclic): stop with exit 2 before any build and name the cycle (Task 2 test `SolutionLevelCycleStops`).
3. **Library build fails with `--keep-going`**: its consumers are `blocked` with reason "needs <job>", independent jobs still run, exit is 10 (Task 2 test `KeepGoingBlocksOnlyDependents`).
4. **`--parallel 6` on a 16 GB machine**: lowered to 5 with one warning line, not refused (Task 2 test `RequestAboveTheCapIsLowered`).
5. **Two builds print root causes at the same time**: the two blocks do not interleave line by line (Task 4 test `ChildReportsDoNotInterleave`).

---

### Task 1: Spike on a TwinCAT PC (manual, two sessions, about 1.5 h in total, no code commit) — gates Tasks 5 and 6

(R2) Session A (read-mostly, early with the other lanes' read-mostly spikes): Steps 1 and 2. Session B (changes the machine, last of all lanes): Steps 3 and 3b, after a backup of both library repository candidates and a restore point. This spike gates only this plan; the other lanes start on their own gates.

- [ ] **Step 1 (U1):** Temporary branch only: in `ws build`, run two jobs on two `Thread`s with `SetApartmentState(ApartmentState.STA)`, each `ShellSession` + `Isolation.Create(...)`, on a throwaway workspace with two independent solutions. Record: both builds finish, both PIDs show in `iecode shells list` (each adopted through the running object table, no "could not be told apart" warning), no `RPC_E_*` error beyond `ComCall.Retry`, and each `DialogWatch` stays with its own shell. (R19) Then two failure runs under an outer deadline (the harness kills the spike process after 10 minutes): (a) one worker whose start is blocked (another console holds `Local\iecode-shell-start`, or the shell start hangs): the other worker's build still ends, the blocked one ends by its own timeout or by the deadline, and the start gate is not held forever; (b) one worker whose project raises a modal dialog (for example the upgrade dialog of a 4024 project opened in 4026): its `DialogWatch` cancels it and fails that job, while the other worker's build is unaffected. A hang or a cross-effect counts as an U1 failure (M8).
- [ ] **Step 2 (U2):** During those builds, record the peak `WorkingSet64` of each `TcXaeShell` process (Task Manager or `Get-Process TcXaeShell | select Id,PeakWorkingSet64`), for 4024 and 4026.
- [ ] **Step 3 (U3, session B):** `--visible`, one shell opens solution A; from another console `iecode lib install Tc3_AxisLib_<new>.library`; then the same shell opens consumer B, which pins the new version, and builds. Record: library manager error or clean build.
- [ ] **Step 3b (U4, session B):** (R17) install a library through a 4024 shell (`lib install`), then open a consumer in a 4026 shell that pins it and build; then the same in the other direction. Record: clean build or library manager error for each direction.
- [ ] **Step 4:** Write the four results (anonymised) under a new "Q10 parallel ws build" in `docs/research/cli-build-workflow.md` and commit that doc change.

Gates (M8): U1 fails (including the blocked-start and modal-dialog runs) → stop the plan after Task 4b (Core, worker loop and reporter stay useful) and record the reason in TODO.md; the alternative (one iecode child process per worker) needs a new plan and is not improvised inside E. U2 > 2 GiB → set `ParallelLimit.PerShellBytes` to the measured peak rounded up to 0.5 GiB in Task 2. U3 fails → Task 5 includes the fresh-shell rule (decision 9), and the same rule fixes sequential `ws build`. U3 is known only after session B, so that rule is a late step of Task 5 (Step 1), not a precondition of Tasks 2 to 4b. U4 fails (a cross-line install is not seen) → the line edge pre-check stays a hard stop; U4 passes → it stays as a guard until a later plan relaxes it.

### Task 2: `BuildSchedule` and `ParallelLimit` (Core)

**Files:**
- Create: `cli/src/IECode.Core/BuildSchedule.cs`, `cli/src/IECode.Core/ParallelLimit.cs`
- Modify: `cli/src/IECode.Core/BuildTriage.cs` (`BuildOutcome.JobsExitCode`)
- Test: `cli/tests/IECode.Core.Tests/BuildScheduleTests.cs`, `ParallelLimitTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record BuildJob(string Id, WorkspaceStage Stage, IReadOnlyList<string> DependsOn, int? Line);` (`Stage` from `Workspace.BuildStages`; its `Exports` are what the job installs)
  - `public enum JobStatus { Waiting, Running, Ok, Failed, Error, Blocked, NotStarted }`
  - `public sealed record JobResult(string Id, JobStatus Status, int ExitCode, string? Reason);`
  - `public enum PickKind { Ready, Wait, Drained }` and `public readonly record struct Pick(PickKind Kind, BuildJob? Job)` (R8: `Wait` = nothing ready yet but jobs still running or waiting on running ones; `Drained` = nothing left to start)
  - `public sealed class BuildSchedule { public static BuildSchedule From(Workspace w, IReadOnlyList<Unit> order, Func<string, int?> lineOf, bool keepGoing, bool lineAffinity); public IReadOnlyList<BuildJob> Jobs { get; } public IReadOnlyList<IReadOnlyList<string>> Waves { get; } public Pick Next(int? workerLine); public void Amend(string id, JobStatus status, int exitCode, string? reason); public void Finished(string id, JobStatus status, int exitCode, string? reason = null); public bool Done { get; } public IReadOnlyList<JobResult> Results(); }` (not thread-safe; the CLI calls it under one lock). `lineAffinity: false` (one worker) means pure build order and `lineOf` is never called (R9); with `true`, `lineOf` is called lazily and an exception from it counts as `null` (unknown).
  - `public static int BuildOutcome.JobsExitCode(IReadOnlyList<JobResult> resultsInBuildOrder)` (R12: own name, no overload clash with `ExitCode(IEnumerable<bool>)`)
  - `public static class ParallelLimit { public const long PerShellBytes = 2L << 30, ReserveBytes = 4L << 30; public const int HardCap = 8; public static (int Workers, string? Note) Effective(int requested, long totalMemoryBytes, int widestWave); }`

- [ ] **Step 1: Write the failing tests** (build `Workspace` objects in memory from `Unit` / `Link` records with the required init properties; the `PlcProjectFile` instances come from `TempWorkspace` fixtures as in `WorkspaceTests`)

```csharp
[Fact] public void JobsAreTheBuildStages()                     // Jobs.Select(j => j.Stage) equals w.BuildStages(order), same order
[Fact] public void LinksInsideOneSolutionAreNoDependency()     // Assert.Empty(job.DependsOn)
[Fact] public void ConsumerWaitsForItsProducer()
{   // AxisLib.sln (Tc3_AxisLib) ← Machine.sln uses it via workspace link
    var s = Schedule();
    Assert.Equal("AxisLib", s.Next(null).Job!.Id);
    Assert.Equal(PickKind.Wait, s.Next(null).Kind);            // Machine is not ready yet, AxisLib still runs
    s.Finished("AxisLib", JobStatus.Ok, 0);
    Assert.Equal("Machine", s.Next(null).Job!.Id);
}
[Fact] public void NextIsDrainedWhenNothingIsLeft()            // (R8) after the last job is picked and finished: Kind == Drained, not Wait
[Fact] public void SingleWorkerFollowsBuildOrder()             // (R9) lineAffinity false; ready A(4026), B(4024): Next(4024) is A; the lineOf spy was never called
[Fact] public void AmendReplacesAFinishedResult()             // (R18) Finished(A, Ok) then Amend(A, Error, 1, "close failed"): Results() shows Error/1 for A, the exit code follows it, other jobs unchanged
[Fact] public void LineLookupThatThrowsMeansUnknown()          // (R9) lineAffinity true, lineOf throws → no exception from From/Next, jobs picked in chain/build order
[Fact] public void WavesNeedNoLines()                          // (R13) From(..., lineOf: _ => null, ...).Waves is computed, no exception
[Fact] public void PinnedLinkIsNoDependency()                  // IsWorkspace false → independent jobs
[Fact] public void SameLineIsPreferred()                       // ready: A(4026), B(4024); Next(4024) == B
[Fact] public void LongerChainFirstWhenLinesTie()
[Fact] public void SolutionLevelCycleStops() =>
    Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => CrossSchedule()).ExitCode);   // message names both solutions, hint "without --parallel"
[Fact] public void FailureStopsNewWork()
{   // A fails while B runs; C (independent) waiting
    s.Finished("A", JobStatus.Failed, ExitCodes.BuildFailed);
    Assert.Equal(PickKind.Wait, s.Next(null).Kind);            // B still runs; C is not handed out
    s.Finished("B", JobStatus.Ok, 0);
    Assert.Equal(PickKind.Drained, s.Next(null).Kind);
    Assert.True(s.Done);
    Assert.Equal(JobStatus.NotStarted, s.Results().Single(r => r.Id == "C").Status);
}
[Fact] public void KeepGoingBlocksOnlyDependents()             // Machine Blocked, Reason "needs AxisLib"; Other runs
[Fact] public void WavesAreDependencyLevels()                  // [["AxisLib","MotorLib"],["Machine"]]
[Fact] public void ExitCodeIsTheFirstFailureInBuildOrder() =>
    Assert.Equal(ExitCodes.LibraryFailed, BuildOutcome.JobsExitCode([Ok("A"), Err("B", 12), Failed("C"), Blocked("D")]));
[Fact] public void BlockedAndNotStartedNeverDecideTheCode() =>  // (R12) Blocked/NotStarted mixed with a failure, in front of it and behind it
    Assert.Equal(ExitCodes.BuildFailed, BuildOutcome.JobsExitCode([NotStarted("A"), Blocked("B"), Failed("C"), NotStarted("D")]));
[Fact] public void NoJobsIsOk() => Assert.Equal(0, BuildOutcome.JobsExitCode([]));   // (R12) unambiguous with the bool overload
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
- [ ] **Step 3: Implement.** Jobs from `w.BuildStages(order)`, dependency edges from `w.Links` restricted to `order`; cycle check by DFS over jobs (the same shape as `Workspace.BuildOrder`). Tie-break order for `Next`: same line, then more transitive dependents, then position in `order` (with `lineAffinity: false`: only position in `order`). `Next` answers `Ready`, `Wait` (something is still running or blocked on running jobs) or `Drained` (R8).
- [ ] **Step 4: Run to verify they pass** (same commands). Expected: PASS, the existing `WorkspaceTests` and `BuildOutcomeTests` stay green.
- [ ] **Step 5: Commit** `git commit -s -m "Schedule workspace builds as dependent solution jobs" -m "Parallel ws build needs to know which solution may start, what a failure cancels and which exit code wins; keeping that pure makes it testable without TwinCAT. Jobs are solutions because two shells must not open the same .sln."`

### Task 3: Pin isolated copies of one repository from two threads (test only)

Round 1 already allocates a free folder per copy (premise 8), so M6 needs no code change. This task only pins the behaviour E relies on.

**Files:** Test `cli/tests/IECode.Core.Tests/IsolationTests.cs` (no change to `Isolation.cs`).

- [ ] **Step 1: Test:** `TwoThreadsOfOneProcessGetTwoCopies`: two threads start together (`Barrier`), each runs `Isolation.Create(ws["src/sln/Machine.sln"], TempBase)` with the same process PID. Assert two different `CopyRoot`s, both existing; disposing one leaves the other.
- [ ] **Step 2:** Run `--filter-method "*TwoThreadsOfOneProcessGetTwoCopies"`; expected PASS at once. If it fails, the `Allocate` claim (`Isolation.cs:252-270`) has a race: fix it there and name it in the commit body.
- [ ] **Step 3: Commit** "Pin that parallel copies of one repository get their own folders" (body: parallel ws build creates copies of one monorepo from several threads of one process; the test keeps the round-1 allocation from regressing).

### Task 4: `Reporter.Child` (prefixed, shared lock)

**Files:** Modify `cli/src/IECode.Core/Reporter.cs`, `cli/src/IECode.Core/Diagnostics.cs` (trailing optional `Job`); Test `ReporterTests.cs`.

**Interfaces:** Produces `public Reporter Child(string prefix)`. The child has the same `Json`, `Verbose`, `MaxErrors` and color, its own `MapDiagnostic`, `TwinCatVersion` and limit counters. It writes every line with the prefix through the parent's writers under the **parent's** `_sync` (`System.Threading.Lock` is reentrant), and forwards diagnostics and JSON messages to the parent's lists. `Status` / `ClearStatus` do nothing on a child. `Finish` on a child throws `InvalidOperationException`. (R7) Also produces `public void BeginJob(string jobId, Func<Diagnostic, Diagnostic>? map)` on a child: it sets the prefix `[<jobId>] ` and the `Job` stamp, replaces `MapDiagnostic` with `map` and resets the print counters (the `BeginBuild` fields, `Reporter.cs:59-62`), so one child serves all jobs of a worker. (R14) Every diagnostic a child records or forwards gets `Job = <jobId>` (new trailing optional field `Job` on `Diagnostic`, `Diagnostics.cs:8-16`, after `Tc` once F has landed, M5).

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
[Fact] public void BeginJobRetargetsTheChild()       // (R7) BeginJob("A", mapA); Add(d) → parent has mapA(d), prefix "[A] "; BeginJob("B", null); Add(d) → parent has the unmapped d, prefix "[B] "
[Fact] public void BeginJobResetsTheCounters()       // (R7) MaxErrors 1: first error of job A printed, second hidden; after BeginJob("B") the first error of B prints again
[Fact] public void ChildStampsTheJobOnDiagnostics()  // (R14) after BeginJob("A", null) and BeginJob("B", null): parent.Diagnostics Job values are "A" then "B"; a diagnostic of the parent itself has Job null
```

- [ ] **Step 2:** Run `--filter-class "*ReporterTests"`; expected FAIL.
- [ ] **Step 3:** Implement with a private constructor `(Reporter parent, string prefix)`; the existing public constructor and behaviour stay as they are.
- [ ] **Step 4:** Run; expected PASS, including `LinesFromSeveralThreadsAreAllKept`.
- [ ] **Step 5: Commit** "Add prefixed child reporters for parallel builds" (body: parallel shells share one console; a shared lock keeps each build's error block together, and per-child state keeps one build's path mapping and error limit away from the others).

### Task 4b: Worker loop, isolated job step and pre-check (Core, R8, R11, R17, R18)

There is no `IECode.Cli` test project, so everything that decides something in the worker moves to Core as a generic runner over delegates; the CLI only supplies the COM-backed delegates.

**Files:** Create `cli/src/IECode.Core/ParallelBuild.cs`; Test `cli/tests/IECode.Core.Tests/ParallelBuildTests.cs`.

**Interfaces:**
- Produces:
  - `public sealed record JobOutcome(JobStatus Status, int ExitCode, string? Reason);`
  - `public interface IBuildWorker : IDisposable { int? Line { get; } JobOutcome Run(BuildJob job); IECodeException? Close(); }` (`Line` = TwinCAT line of the worker's open shell; `Close` = `ShellSession.Close()`)
  - `public static class ParallelBuild { public static void Run<TShared>(BuildSchedule schedule, object gate, int workers, Func<TShared> resolveShared, Func<int, TShared, IBuildWorker> createWorker, Func<ThreadStart, Thread>? threadFactory = null); }`: resolves the shared value (credentials) once on the calling thread before any worker exists; with one worker it runs on the calling thread, otherwise on `threadFactory` threads (the CLI passes STA threads). Each worker loops: under `gate` call `Next(worker.Line)`; `Ready` → run the job outside the lock, then `Finished(...)` under the lock and pulse; `Wait` → `Monitor.Wait(gate)` until a pulse; `Drained` → leave the loop. After the loop it calls `Close()`; a returned failure becomes an `Error` outcome of the worker's last job (`Finished` is not repeated: `BuildSchedule.Amend(id, Error, exitCode, reason)` replaces the stored result of that job, decision 9). An exception from `Run` becomes `Finished(id, Error, e is IECodeException x ? x.ExitCode : ExitCodes.Unexpected, e.Message)` and never ends the worker.
  - `public static class IsolatedJob { public static JobOutcome Run<TCopy>(Func<TCopy> create, Func<TCopy, JobOutcome> work, Action closeSolution, Action<TCopy> delete, Action<TCopy> keep); }`: `create` failing gives an `Error` outcome with the exception's code and nothing else runs; otherwise `work`, then `closeSolution()` (the shell closes the copy's solution without saving), then `delete`; a failing `closeSolution` skips `delete`, calls `keep(copy)` (the CLI warns with the copy path) and leaves the outcome of `work` unchanged.
  - `public static class BuildPreCheck { public static IReadOnlyList<string> Problems(BuildSchedule schedule, Func<string, IReadOnlyList<string>> outsideRootOf, Func<string, int?> lineOf); }`: lines such as `<solution>: <reason>` for solutions a copy cannot contain (M12) and `<producer> (<line>) -> <consumer> (<line>)` for edges across lines (R17); unknown lines are skipped; empty means go.

- [ ] **Step 1: Failing tests** (`ParallelBuildTests`, fakes for `IBuildWorker`, `Isolation`, shell and credentials; schedules from in-memory workspaces as in Task 2)

```csharp
[Fact] public void SecondWorkerWaitsInsteadOfLeaving()          // (R8) jobs A, B(depends A), C(depends A), 2 workers; the fake Run of B and C each signal a Barrier(2) with a 5 s timeout, so it passes only when both run at the same time, i.e. the worker that saw Wait stayed and was pulsed after A; all three jobs Ok
[Fact] public void EveryJobRunsExactlyOnce()                     // (R8) 3 workers, 6 jobs with a diamond; a counter per job id equals 1
[Fact] public void SharedValueIsResolvedOnceBeforeTheWorkers()   // (R11, credentials once) 3 workers: resolveShared called once, and before the first createWorker call
[Fact] public void CloseFailureBecomesAnErrorOfTheLastJob()      // (R11) fake Close() returns IECodeException(ExitCodes.Timeout...); the worker's last job is Error with that exit code and the message as Reason
[Fact] public void ExceptionInAJobDoesNotEndTheWorker()          // (R11) first job throws InvalidOperationException → Error/ExitCodes.Unexpected; the same worker still runs the independent next job
[Fact] public void FailureStopsNewWorkAcrossWorkers()            // (R11) job A Failed; waiting jobs end NotStarted, no worker starts them
[Fact] public void IsolationCreateFailureIsAnErrorOutcome()      // (R11) IsolatedJob: create throws IECodeException(12) → Error, ExitCode 12, work/closeSolution/delete never called
[Fact] public void CopyIsClosedBeforeItIsDeleted()               // (R18) call log is work, closeSolution, delete; also for the only/last job of a worker (a single IsolatedJob.Run call)
[Fact] public void CloseFailureKeepsTheCopy()                    // (R18) closeSolution throws → delete not called, keep called once with the copy, outcome of work unchanged
[Fact] public void PreCheckListsSolutionsACopyCannotContain()    // (R11, M12) outsideRootOf returns one entry for solution X → Problems has one line naming X; run before any worker exists
[Fact] public void PreCheckListsEdgesAcrossLines()               // (R17) producer 4024, consumer 4026 via workspace link → one line "AxisLib (4024) -> Machine (4026)"
[Fact] public void PreCheckSkipsUnknownLinesAndPinnedLinks()     // (R17) lineOf null for one side, or IsWorkspace false → no problem
```

- [ ] **Step 2:** Run `--filter-class "*ParallelBuildTests"`; expected build error, types missing.
- [ ] **Step 3: Implement** in `ParallelBuild.cs` as described; `gate` is the same object the CLI uses for the schedule and for the summary line.
- [ ] **Step 4:** Run; expected PASS (a hang is a failure of the `Wait` logic: the barrier tests have timeouts).
- [ ] **Step 5: Commit** "Add the worker loop, isolated job step and pre-check for parallel builds" (body: the worker logic decides failure attribution, copy lifetime and early stops, and the CLI has no test project; as pure Core code over delegates it is tested without TwinCAT).

### Task 5: `ws build --parallel` wiring (CLI)

**Files:**
- Create: `cli/src/IECode.Cli/Commands/WorkspaceBuild.cs` (`internal static class WorkspaceBuild { public static Outcome Run(Context ctx, Workspace w, IReadOnlyList<Unit> order, WorkspaceBuildOptions o); }` with `internal sealed record WorkspaceBuildOptions(int Parallel, bool KeepGoing, bool Isolate, string IsolateDir, bool Save);`)
- Modify: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs:91-157` (options `--parallel <N>` (`int`, default 1, 0 = auto), `--keep-going`, `--isolate`, `--isolate-dir`; the dry run prints `Waves` and the effective worker count; the body after the stage preflight (`:122-124`, unchanged) calls `WorkspaceBuild.Run`)
- Modify: `cli/src/IECode.Cli/Runner.cs:208-220, 251-322` (`ShellSession(Context ctx, bool saves, bool discard = false, (string User, string Password)? credentials = null)`; `StartShell(Context ctx, TwinCatVersion request, bool saves)` takes the credentials as one more parameter instead of calling `Credentials(ctx)` when they are given; keep its `saves` parameter, round 1 added it for `SelectVersion`). `ws release` (`WorkspaceCommands.cs:221`) keeps the old call. `ShellSession` also gets `public void CloseSolution()` (calls `XaeShell.CloseSolutionWithoutSaving()`, forgets the opened solution so the next `Open` reopens; R18).
- Modify: `cli/src/IECode.Automation/XaeShell.cs:413` (`CloseWithoutSaving` → public `CloseSolutionWithoutSaving`; visibility only).

**Interfaces:** Consumes everything from Tasks 2 to 4b and the round-1 symbols under "Depends on".

- [ ] **Step 0 (R3, R16): pure-move commit first.** Before any behaviour change, move the loop body of `ws build` (`WorkspaceCommands.cs:122-155`) unchanged into `WorkspaceBuild.Run` (no new options, no scheduler) and commit it alone ("Move the ws build loop into its own file", body: a pure move keeps the next diff reviewable and keeps conflicts with I and F, which edit the same call sites, small). Then re-check against the current `main`: if I has landed, the `FinishExport` call already carries `expected` (M2); if E lands second, add I's `expected` argument at this call site (and the other way round for I) instead of the one written here.
- [ ] **Step 1:** Wiring rules (the decisions live in Core, Tasks 2 to 4b; this only supplies the COM-backed delegates): `lineOf` = `ChooseVersion(ctx, SolutionFile.Load(sln), saves: !isolated, quiet: true).Request.Line` inside a `try` that returns `null` on any exception, used only with more than one worker (R9); with one worker, `BuildSchedule.From(..., lineAffinity: false)` and no `ChooseVersion` runs up front, `saves: true`, no isolation unless `--isolate` is given, behaviour as today. With more than one effective worker: run `BuildPreCheck.Problems(...)` first (decision 13: `Isolation.OutsideRoot` per solution as `ProjectCommands.cs:128-131`, lines through `lineOf`) and stop with exit 2 before any shell starts when it returns lines. Workers = `ParallelLimit.Effective(o.Parallel, GC.GetGCMemoryInfo().TotalAvailableMemoryBytes, schedule.Waves.Max(w => w.Count))`; print its `Note` as a warning. With more than one effective worker also print one warning line (R10): "--parallel builds in isolated copies without saving: solutions are not saved and no .tmc returns to the source tree; run without --parallel for that." Call `ParallelBuild.Run` with a `threadFactory` that makes `new Thread(...)` with `SetApartmentState(ApartmentState.STA)` (one worker runs on the calling thread). Each worker creates its `IBuildWorker` once: one `Reporter.Child` (R7) and `ctx with { Log = child }` passed to one `ShellSession` per worker (`saves: !isolated`, `discard: !o.Save || isolated`, the credentials resolved once as the `resolveShared` value through `Runner.Credentials(ctx)`). Per job the worker calls `child.BeginJob(job.Id, ...)` and then `IsolatedJob.Run`: with isolation `Isolation.Create(job.Stage.Solution, dir)` as `create`, `map = d => Isolation.MapBack(d, copy)` for `BeginJob`, `session.CloseSolution()` as `closeSolution` (R18), `copy.TryDelete` as `delete`, and a `keep` that sets `copy.Keep` and warns with the copy path. Then `session.Open(...).Build(null, save)`, then for each `job.Stage.Exports` unit `FinishExport(childCtx, StageExport(shell, lib.Plc.Name, file), session.Request)`, the same calls as `WorkspaceCommands.cs:145-150`. `file` is `<source solution folder>\dist\<Title>_<Version>.library`, not inside the copy: `StagedExport` writes into a private `.iecode-<guid>` folder, so parallel exports never share a file, and `dist/` keeps today's result. `BuildSchedule` calls go under the shared `gate`. Exception attribution, the `session.Close()` failure of a worker's last job (decision 9), waiting on `Wait` and the exit of a drained worker are `ParallelBuild`'s (Task 4b), not repeated here; the worker disposes its session at the end. If spike U3 failed (known after session B): the worker restarts its shell when a producer of the next job finished after its shell started (`BuildSchedule` records the finish order; add `public bool InstalledAfter(string jobId, int sequence)` with test `ProducerInstalledAfterShellStartNeedsFreshShell` in Task 2's test file).
- [ ] **Step 2:** Summary table at the end (human mode, `Info`): one line per job, `ok|failed|error|blocked|not started`, id, `m:ss`, errors, installed `Title Version`, reason. Exit = `BuildOutcome.JobsExitCode(schedule.Results())`. JSON per decision 11.
- [ ] **Step 3:** `dotnet build cli/IECode.slnx`; expected: builds without warnings. Then `dotnet test --project cli/tests/IECode.Core.Tests`; expected: all green.
- [ ] **Step 4 (any OS):** `iecode ws build <fixture workspace> --parallel 0 --dry-run --json` prints `data.waves` and `data.parallel`, exit 0. (R13) The dry run passes `lineOf: _ => null`, so it never reads `TWINCAT3DIR`, never exits 15 or 2 for a missing TwinCAT, and prints the waves only (no line information, no pre-check).
- [ ] **Step 5: Commit** "Add ws build --parallel to build independent solutions at once" (body: twelve repositories built one after another took most of a day; consumers still wait for their producer's install, and every parallel build works in its own copy because parallel shells would write into the same tree).

### Task 6: Docs and the check on a TwinCAT PC

**Files:** `cli/README.md` (`ws build` row at line 39: `[--parallel N] [--keep-going] [--isolate [--isolate-dir <dir>]]`, text "N > 1 builds in isolated copies, capped by memory (2 GiB per shell)"), `extension/CHANGELOG.md` (`## Unreleased`: `--parallel`, `--keep-going`, `--isolate` for `ws build`), `TODO.md`.

- [ ] **Step 1:** Update README and CHANGELOG. The README row and the CHANGELOG line both say: `--parallel N` with N > 1 builds in isolated copies and does not save solutions, so no `.tmc` returns to the source tree (R10); it refuses solutions a copy cannot contain and workspace edges across TwinCAT lines with exit 2 (R17, M12); Ctrl+C is not handled: leftover copies stay for 24 h and shells end only with the process (R15).
- [ ] **Step 1b:** Add to `TODO.md` (R10, R15): a per-job `--copy-tmc` for parallel builds; a `CancelKeyPress` handler that closes shells and removes copies; a per-job watchdog; a copy-size warning for large repository roots.
- [ ] **Step 2 (TwinCAT PC, about 0.5 day after merge, R4):** throwaway workspace with `Tc3_AxisLib` ← `Machine`, plus an independent `Tc3_MotorLib`: `iecode ws build --parallel 2` builds `Tc3_AxisLib` and `Tc3_MotorLib` at the same time, `Machine` after the install, and `git status` stays clean in all three. Make `Tc3_AxisLib` fail on purpose: without `--keep-going`, `Machine` is `not started`; with it, `Machine` is `blocked` and `Tc3_MotorLib` ok; exit 10 both times. `iecode shells list` is empty afterwards. Also check: the warning line about isolation without saving appears; the last job of each worker leaves no copy folder behind (the solution was closed first, R18) and, with a forced close failure, the copy is kept and its path is printed; a workspace with a 4024 producer and a 4026 consumer stops with exit 2 before any shell starts (R17); `--json` diagnostics carry a `job` value (R14); `--parallel 1` builds in plain build order, saves solutions and behaves as before (R9, R10).
- [ ] **Step 3: Commit** docs (`git commit -s`, subject "Document parallel workspace builds", body: why).

## Known limits

- Every parallel job copies its whole repository root; a monorepo with many solutions is copied once per solution (no shared copy).
- An isolated parallel build still writes `dist/*.library` (and briefly a `dist/.iecode-<guid>` staging folder) into the source solution folder, as sequential `ws build` does today.
- Sequential `ws build` today builds a stage that depends on a later stage's export (cross-solution cycle) without a warning; only the scheduler path detects it. Once N = 1 also goes through the scheduler, that case stops with exit 2 (CHANGELOG line).
- The memory cap uses total physical memory, not free memory; other heavy programs during the run are not taken into account.
- Ctrl+C ends iecode; the kill-on-close job ends the shells, and leftover copies are cleaned up after 24 h by a later isolated build. (R15) There is no `CancelKeyPress` handler in round 2, no per-job watchdog and no copy-size warning; the README row and the CHANGELOG line name the limit, and the three items are in `TODO.md`.
- (R10) `--parallel N` with N > 1 does not save solutions and copies no `.tmc` back; a per-job `--copy-tmc` is deferred.
- (R17) A workspace edge between two TwinCAT lines is refused with exit 2 under `--parallel`; sequential `ws build` still builds it and has the same install-line limit.

Size: 2.75 days plus about 1.5 h of spike on a TwinCAT PC (two sessions) and about 0.5 day of manual check after merge `[estimated]` (Task 3 shrank to a test, the stage model already existed; Task 4b is the added worker-loop task).
