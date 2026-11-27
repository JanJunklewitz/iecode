# CLI Build Workflow Master Plan, Round 2 (2026-11-26)

> **Status: master plan, engineering review done 2026-11-27 (section "Review"; its R entries add to the M entries).** The sub-plans E to J are TDD plans. Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Where a sub-plan and an M or R entry below differ, the M or R entry wins; the R entries were folded into the sub-plan texts on 2026-11-27 (each sub-plan lists its rows under "Review changes"), so the sub-plans and this file should agree. Plans live on `plan/cli-build-workflow-2`; implementation is based on `main` (round 1, plans A to D, [master plan](2026-11-24-cli-build-workflow-master-plan.md), merged as pull requests #70 to #73), see "Prerequisites". All six sub-plans were re-checked against `main` at `f817efe` on 2026-11-27.

**Goal:** Close the items round 1 left open in the TODO section "CLI: build and library workflow at scale": build many repositories in parallel, build for several TwinCAT lines in one call, build without the test PLC project, keep a tracked project library folder in step with the references, check that an installed library is really known to TwinCAT, and run PLC unit tests from the CLI.

**Architecture:** Same rules as round 1: every decision lives in a small pure class in `IECode.Core` with xUnit tests (Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire it. Each plan starts with a spike on a TwinCAT PC wherever its premise cannot be read from the code, and each spike names what its outcome means for the tasks after it.

**Tech Stack:** C# .NET (xUnit), System.CommandLine, COM late binding to the XAE shell (STA threads), RepTool, the existing ADS stack (`AdsWatchBackend`).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) (sections 2 and 6, answers Q4 and Q7) and the "Medium" / "Large" items of the section "CLI: build and library workflow at scale" in [TODO.md](../../../TODO.md).

## Global Constraints

Round 1's Global Constraints apply unchanged (public repository, fixtures `Tc3_MotorLib` / `Tc3_AxisLib` / vendor `Example`, commits with why-body and `git commit -s` with the noreply address, `dotnet build` and `dotnet test` separately through the PowerShell tool, additive JSON, a README row and a CHANGELOG line for every user-visible change, decisions in Core). In addition:

- Line numbers in the sub-plans refer to `main` at `f817efe` (round 1 merged; the numbers were remapped from `0515a61` on 2026-11-27 and the changed passages re-read). Before each task, re-check that task's "Premises checked" entries against the current base.
- Exit code 21 is reserved for plan J (`TestsFailed`). No other round-2 plan adds an exit code.
- Spikes that change the library repository or the local runtime run only on a PC without a connected machine, with a backup first (M9).

## Sub-plans

| Plan | Item (TODO.md) | Spike on a TwinCAT PC first | Tasks | Size `[estimated]` |
|---|---|---|---|---|
| [E](2026-11-26-cli-build-workflow-2-e-parallel-ws-build.md) | `ws build --parallel N` | U1 two STA shells in one process (and a blocked start), U2 peak memory per shell, U3 does a running shell see a library installed after its start, U4 a library edge across two TwinCAT lines | 7 | 2.75 days + 1.5 h spike + 0.5 day check on a PC |
| [F](2026-11-26-cli-build-workflow-2-f-tc-matrix.md) | `build` / `check --tc 4024,4026` | 4024 project in 4026 and back (hidden dialogs), missing line, two isolated builds in a row | 7 | 2 days + 45 min spike + 0.5 day check on a PC |
| [G](2026-11-26-cli-build-workflow-2-g-build-subset.md) | `build --exclude-plc` / `--no-tests` | which COM path builds a subset (`BuildProject` per PLC or per `.tsproj`, `ShouldBuild`, `.sln` lines in the copy, none) | 5 | 2.5 days + 1.5 h spike + 0.5 day check on a PC |
| [H](2026-11-26-cli-build-workflow-2-h-project-folder-sync.md) | `lib project-folder sync [--prune]` | file set of a version folder in a tracked `_Libraries` | 5 | 1.5 to 2 days + 0.5 day check on a PC |
| [I](2026-11-26-cli-build-workflow-2-i-lib-verify.md) | `lib verify` | reproduce the lost install; does the repository index file `cache` decide what the library manager sees | 6 | 2 days + 3.5 h spike + 0.5 day check on a PC |
| [J](2026-11-26-cli-build-workflow-2-j-iecode-test.md) | `iecode test` | what the project test framework is, activation without save, TcUnit result symbols and ADS port on 4024 and 4026 | 10 | 3.5 days + 0.5 day spike + 0.5 day check on a PC |

Total about 15 days of work (an upper bound if every gate passes) plus about 4 days on a TwinCAT PC (two spike sessions, and the manual check after each merge) `[estimated]` (R4).

## Prerequisites

1. Base: `main` (round 1 is merged, pull requests #70 to #73). Each lane branches from the current `main`.
2. One TwinCAT PC with 4024 and 4026, no connected machine, for the two spike sessions (R2).

## Order and lanes

```
Spike session A (read-mostly, first; R2):  G T1, F T1, H T0, E T1 (U1, U2)
Spike session B (changes the machine, last, backup and restore point first; R2):  E T1 (U3), I T1 (S1-S4), J T1 (S0-S2)
Each spike gates only its own plan (R2); the lanes below start per plan once its spike is read.

Lane 1 build path:  G ──► F ──► E          (ProjectCommands.cs, XaeShell.Build.cs, Runner.cs, Reporter.cs, WorkspaceCommands.cs)
Lane 2 library:     H ──► I                 (LibraryCommands.cs, Runner.StageExport / FinishExport / InstallSaved, WorkspaceCommands.cs one argument)
Lane 3 test:        J                       (new files; Errors.cs, XaeShell.Plc.cs, Program.cs)
```

Why this order:
- **G before F:** both edit `ProjectCommands.Build` and `Check`. G is the smaller change (one optional parameter on `XaeShell.Build`). F then moves `BuildIsolated` out of its local function on top of it.
- **F before E:** E touches `Runner`, `Reporter` and `WorkspaceCommands` like F, so F first keeps the diffs small (E has no hard dependency on F). E's follow-up `ws build --no-tests` needs G's `PlcSelection`.
- **H before I:** both add a line to the `lib` subcommand list. I also changes `Runner.InstallSaved` (M2) and checks after install and uninstall, so it should land on a quiet library command file.
- **J alone:** almost everything in J is a new file. It shares only `TestProjects` with G (M3).

The three lanes run in parallel in three worktrees after the spike day. One pull request per plan, stacked inside a lane, each under about 600 changed lines; E and J may need two pull requests each (Core first, then wiring).

## Master decisions (M)

The user delegated the design decisions; each row is decided by the planner and can be overruled in review.

| ID | Plans | Decision |
|---|---|---|
| M1 | J, all | Exit 21 = `TestsFailed` (J). E, F, G, H, I add no exit code (checked in each plan). `Errors.cs` ends at 20 today (`Errors.cs:6-22`). |
| M2 | E, I | Round 1 installs through `Runner.StageExport` / `FinishExport` (`Runner.cs:148-184`; callers `lib save`, `save-all`, `ws build`, `ws release`). I adds `LibraryId? expected = null` as the optional last parameter of both `FinishExport` and `InstallSaved`, so E's call `FinishExport(childCtx, StageExport(...), session.Request)` compiles unchanged. I also passes the argument in `WorkspaceCommands.cs` (E's file): whichever lane lands second adds it at the other's call sites. |
| M3 | G, J | One test-project rule: `TestProjects.IsTestProject(string solutionDir, string plcprojPath)` in `cli/src/IECode.Core/Projects/TestProjects.cs`. A whole folder segment below the solution folder equal to `Test`, `Tests`, `UnitTest`, `UnitTests` or ending in `.Test` / `.Tests`, case-insensitive. The lane that lands first creates the file; `PlcSelection` (G) and `TestProjects.Select` (J) call it. Both plans are already edited to this. |
| M4 | F, G | `ProjectCommands.cs`: G lands first and does not restructure `BuildIsolated`; F moves it. |
| M5 | F, all | `Diagnostic` gets the trailing optional field `Tc` (F). A later field goes after it. |
| M6 | E | Done in round 1 (re-check 2026-11-26): `Isolation.Create` claims a free `<hash>-<pid>`, `-2`, `-3` … folder with a marker file (`Isolation.cs:177-199`, `:252-270`). E Task 3 only pins it with the test `TwoThreadsOfOneProcessGetTwoCopies`; `Isolation.cs` is no longer in E's Touches. |
| M7 | E | Done in round 1 (re-check 2026-11-26, confirmed in the code): `ws build` installs every export of a solution's stage (`Workspace.BuildStages`, `WorkspaceCommands.cs:122`, `:145-150`); the `continue` at `:133` only skips a second build of the same solution. E's job is a `WorkspaceStage`, so E adds no second grouping rule. |
| M8 | E | E depends on spike U1. If two STA threads in one process cannot each drive a shell, E stops after Task 4b, which is still usable as Core plus scheduling. A child process per worker then needs its own plan; no fallback is improvised inside E. |
| M9 | I, J | Spike safety: before I's spike, copy the whole `Managed Libraries` folder aside and restore it afterwards, because S1 edits the `cache` index by hand and S3 uninstalls in bulk. J's spike activates a configuration on the local runtime: only on a PC with no machine and nothing in Run that matters. |
| M10 | J | Symbol paths and names of the project-specific test framework found in spike S0 stay in a private file outside the repository. The repository only gets the generic symbol-map format (`iecode-test-adapter/1`) and the TcUnit adapter. |
| M11 | I | If spike S1 shows that the `cache` index decides what the library manager sees, I Tasks 2 to 5 run as written. If nothing reproduces and `cache` has no effect (outcome O3), the lock from round 1 stays the fix. `lib verify` then shrinks to the shell-based check (Task 6) or is dropped; this is decided right after the spike, not during implementation. |
| M12 | E, F, J | `--isolate` refuses a solution with any project type other than `.plcproj`, `.tsproj` and `.tspproj` (`Isolation.OutsideRoot`, `ProjectCommands.cs:128-131`), so such a solution cannot use `ws build --parallel` (E), a `--tc` list (F) or `test --isolate` (J). E checks every job's solution before the first build and stops with exit 2 listing the refused solutions and the hint "run without --parallel" (not a job failure in the middle of a run). F and J keep the existing exit-2 message; the README rows of all three name the limit. |
| M13 | round 1 | Findings in the round-1 code from the re-check, for the round-1 lane (no round-2 task depends on a fix): (a) `activate` confirms dialogs of the TwinCAT helper process only when `TWINCAT3DIR` is set (`XaeShell.Plc.cs:175-176`), otherwise it logs a detail line, so an unattended `activate` (and J) may hang on "symbol type change"; J's manual step (i) checks it, the open-test checklist should too. (b) The sequential `ws build` builds a stage that needs an export of a later stage (a cycle across solutions) without a warning; E's scheduler stops it with exit 2 (known limit in E, CHANGELOG line). (c) I's spike builds the commit before the lock as `311ca62` (the lock commit is `745ca7f` after the rebase). |

## Not in this master plan

- `ws build --no-tests` and `ws build --tc <list>`: follow-ups once E, F and G have landed. Each wires an existing Core rule into the job loop.
- `--isolate --from-head` (research Q2), indirect dependencies in `project-folder sync` (format of the `dependencies` file unknown), `lib verify --repair`.
- A built-in adapter for the project-specific test framework (M10). It goes through the symbol map.
- A supervisor process with a hard deadline (kept out in round 1, still out).

## Review

Engineering review of this master plan and the six sub-plans on 2026-11-27, against `main` at `f817efe` (worktree `iecode-plan2`). Evidence is a static read of the plans and the code; nothing was built or run, and no TwinCAT PC was available, so every claim about XAE, RepTool or ADS behaviour stays unverified until its spike. Reviewers: six read-only reviews (one per sub-plan, each checked against the code), an outside voice (native fallback, the Codex CLI is not installed), and a second opinion from the GitHub Copilot CLI. Findings marked `[S]` come from the per-plan review, `[O]` from the outside voice, `[C]` from Copilot.

**Decisions.** The user delegated every decision ("you decide, take the slower but better option"). Each row below was decided by the reviewer; the answer reference is "delegated by the user, 2026-11-27". The rows are independent choices; accepting one does not accept another. The M and R entries win over sub-plan text (see the status line); the rows were folded into the sub-plans on 2026-11-27.

**Scope Challenge.** Seven plans, about 30 new classes or files across them, so the complexity gate applies. Result: scope accepted as-is. Structure: the original arrangement (pure decisions in `IECode.Core`, wiring in `IECode.Cli` / `IECode.Automation`) stays; R11, R22 and R57 move more loop logic into Core so it can be tested, which is the same arrangement, not a smaller one. E and I stay in the round as conditional plans (M8, M11), not as committed deliverables (R4).

**Reality rows.**
- REALITY: premise-table pass premises re-read by six reviewers against the code (file:line receipts in their reports); the unverified ones are labelled in the plans: all XAE, RepTool and ADS behaviour is marked unverified in the plans and gated by its spike `cli/src/IECode.Core/Projects/LibraryRepository.cs:51`
- REALITY: already-done pass no round-2 symbol exists on `main` (`--parallel`, `--exclude-plc`, `--no-tests`, `project-folder`, `lib verify`, `TestsFailed`, `TestProjects`; grep over `cli/src`) `cli/src/IECode.Core/Errors.cs:6-22`
- REALITY: surface-check finding `--keep-isolated` / `--isolate-dir` / `--copy-tmc` are rejected without `--isolate`, which a `--tc` list does not set (R20) `cli/src/IECode.Cli/Commands/ProjectCommands.cs:93-94`
- REALITY: binding-decisions pass round-1 decisions (lock, isolation, no supervisor) are kept; M12/M13 stand `docs/superpowers/plans/2026-11-26-cli-build-workflow-2-master-plan.md:70-77`
- REALITY: numbers pass 11.75 days of plan work sums correctly `[estimated]`; 12 days holds only if every gate passes (R4) `docs/superpowers/plans/2026-11-26-cli-build-workflow-2-master-plan.md:23-32`
- REALITY: deferred-asks pass the TODO items "exclude PLC", "--tc matrix", "project-folder sync", "lib verify", "ws build --parallel", "iecode test" are all covered; deferrals listed under "Not in this master plan" `TODO.md:131-136`
- REALITY: pr-count finding 6 to 8 pull requests (E and J two each, R4); each extra gate costs one review round, now stated `docs/superpowers/plans/2026-11-26-cli-build-workflow-2-master-plan.md:57`

### Decision ledger

State of every row: approved by delegation, as described in the "Accept" or "Reject" column. Kind: A architecture, Q code quality, T tests, P performance. Severity C = CRITICAL, I = INFORMATIONAL; the number is the confidence (1-10).

| ID | Plan | Kind | Sev | Finding | Decision and accepted change |
|---|---|---|---|---|---|
| R1 | all | A | I 10 | The base statement was stale: round 1 is merged to `main` (#70 to #73), line numbers cited `0515a61`. | Accept, done: statements, prerequisites and line numbers are now on `main f817efe`. |
| R2 | all | A | C 8 `[O][C]` | One spike day gates every lane, is about two days of PC time, and mixes read-only checks with ones that change the machine (I bulk uninstall, J activation, E library install). | Accept: session A (read-mostly: G T1, F T1, H T0, E U1/U2), session B (changes the machine: E U3, I S1-S4, J S0-S2) last, with a backup of both library repository candidates and a restore point first. A spike gates only its own plan; lanes start per plan. |
| R3 | G, J, E, I | A | I 7 `[O][S]` | Shared new files and call sites (`TestProjects.cs`, `WorkspaceCommands.cs`) are created by whichever lane lands first. | Accept: G Task 2 creates `TestProjects.cs` and its tests; J's `Select` goes into its own `TestProjectSelection.cs` and `TestProjectSelectionTests.cs` and J Task 2 starts after G Task 2 is merged; E's move of the `ws build` loop is its own pure-move commit first; whichever of E and I lands second adds the `expected` argument (M2). |
| R4 | all | A | I 7 `[O]` | 12 days is the case where every gate passes; five plans need a second PC session after merge; PR counts exceed the stated ones. | Accept: the estimate is stated as an upper bound, each of E, F, G, I and J gets a manual PC check budgeted at about 0.5 day, E and I are conditional (M8, M11). Reject dropping E or I now: their gates already stop them after one cheap spike. |
| R5 | J | Q | I 7 `[O]` | A framework library name sits five times in J and once each in `TODO.md` and `docs/research/cli-build-workflow.md` of a public repository; it is unknown whether it is public. | Accept for J (done: the name is replaced by "the project test framework" and `--lib <framework library>`); `TODO.md` and the research doc are left for the owner to decide because their history is already public. |
| R6 | all | Q | I 7 `[O]` | "M entry wins" with no divergence list invites following stale text. | Accept: R entries are added to the rule (status line) and the rows were folded into each sub-plan on 2026-11-27 (T1). |
| R7 | E | A | C 9 `[S]` | The per-job reporter never reaches the shell: `ShellSession(Context ctx, ...)` captures `ctx` once (`Runner.cs:251`) and `XaeShell` keeps `private readonly Reporter _log` (`XaeShell.cs:33`), so from the second job on, diagnostics, `MapDiagnostic` and counters belong to the first job. | Accept: one child reporter per worker that is re-targeted per job (prefix, diagnostic mapper, counters reset in a `BeginJob`), passed to the session once; `XaeShell` is not changed. Core test for the re-targeting. |
| R8 | E | A | C 8 `[S]` | `BuildSchedule.Next` returns null for "nothing ready yet" and for "nothing left"; a second worker would exit at the start. | Accept: `Next` returns `Ready(job)`, `Wait` or `Drained`; the runner waits on a pulse after each finished job. Core test with a thread-based fake. |
| R9 | E | A | C 8 `[S]` | The default `--parallel 1` goes through line affinity and chain-length ordering and calls `ChooseVersion(saves: true)` for every solution up front, so it no longer behaves like today. | Accept: with one worker, pure build order; `lineOf` is computed lazily and never throws. Test `SingleWorkerFollowsBuildOrder`. |
| R10 | E | A | C 7 `[S]` | `--parallel N>1` forces isolation and `saves: false`, so solutions are not saved and no `.tmc` returns: a different result than `--parallel 1`. | Accept: documented in README, CHANGELOG and a warning line; a per-job `--copy-tmc` is deferred (TODO). |
| R11 | E | T | I 8 `[S]` | The worker loop, session close, failure attribution, credentials and the M12 pre-check have no test (there is no `IECode.Cli` test project). | Accept: the loop body moves to Core as a generic runner over `Func<BuildJob, JobOutcome>`; tests with fakes for close failure, credentials once, an `Isolation.Create` failure and the pre-check. |
| R12 | E | T | I 8 `[S]` | "The exit code is deterministic and matches sequential" holds only among the jobs that ran; `ExitCode([])` is ambiguous between overloads. | Accept: the claim is weakened to "among the jobs that ran"; the new overload gets its own name; test with `Blocked` and `NotStarted` mixed with a failure. |
| R13 | E | Q | I 7 `[S]` | `--dry-run` needs `lineOf`, which reads `TWINCAT3DIR` and may be null off Windows; it must not exit 15 or 2. | Accept: the dry run passes `lineOf: _ => null` and prints the waves only. |
| R14 | E | Q | I 7 `[S]` | In JSON mode, diagnostics of several jobs interleave with no way to tell them apart. | Accept: an additive `Job` field on `Diagnostic` after `Tc` (M5 order). |
| R15 | E, F, J | A | I 6 `[S]` | No `CancelKeyPress` handler exists in `IECode.Cli`; Ctrl+C kills the process with no `finally`, leaves copies for 24 h, orphans shells, and no job has a watchdog. | Accept as known limit, no handler in round 2 (named in the README rows and CHANGELOG of E, F and J); a handler, a per-job watchdog and a copy-size warning go to the TODO list. |
| R16 | E | Q | I 6 `[S]` | E's `Touches` omit I's `expected` argument and F's `ShellSession` signature. | Accept: E Task 5 premises re-check M2 and F's signature (see also R3). |
| R17 | E | A | C 6 `[C]` | An exported library is installed through the producer's TwinCAT line; a consumer on another line may not see it, so a satisfied edge is not proof. Sequential `ws build` has the same limit; the scheduler would hide it. | Accept: the pre-check lists edges whose producer and consumer lines differ and stops `--parallel` with exit 2 before the first build ("run without --parallel"). A 4024 to 4026 edge is added to spike session B. |
| R18 | E | A | C 7 `[C]` | The copy is deleted in the job's `finally` while the worker's shell still has that solution open (it closes it at the next `Open`). | Accept: an explicit close-without-saving step before the delete; if the close fails the copy is kept and its path reported. Test the last job of a worker. |
| R19 | E | T | I 7 `[C]` | Spike U1 only proves two successful builds; the start gate calls `CreateInstance` before the dialog watch exists. | Accept: U1 adds one worker with a blocked start and one with a modal dialog, under an outer deadline; failure applies M8. |
| R20 | F | A | C 9 `[S]` | `--keep-isolated`, `--isolate-dir` and `--copy-tmc` are rejected without `--isolate` (`ProjectCommands.cs:93-94`); a `--tc` list only implies isolation, so these combinations fail with a misleading message. | Accept: a Core predicate `TcMatrix.ImpliesIsolate`; the validator uses it; test. |
| R21 | F | A | C 8 `[S]` | The plan promises exit 130 on Ctrl+C in a matrix, but 130 exists only for declined confirmations. | Accept: the claim and the test are dropped; see R15. |
| R22 | F | T | C 8 `[S]` | The matrix loop (continue after failure, stop codes, partial data, root-cause count) lives in `ProjectCommands.BuildMatrix` with no test. | Accept: `TcMatrix.Run(versions, runOne, installed, stamps)` in Core with fakes; Task 4 splits into 4a (extract `BuildIsolated`, pure refactor, before/after JSON compare) and 4b (the loop). |
| R23 | F | A | C 7 `[S]` | "Every other command rejects a list" is true only for commands that read `ctx.Version`. | Accept: one central check (root validator or `Runner.Run`) rejects a list for every command but `build` and `check`; test with a command that never reads the version. |
| R24 | F | A | I 6 `[S]` | A hidden upgrade or conversion dialog on a 4024 project in 4026 may be cancelled without an exception. | Accept: after each entry check the shell's dialog state and record the dialog title as the entry's error. |
| R25 | F | T | I 7 `[S]` | The test expressions `Assert.Equal([new(..)], ..)` probably do not compile; the table test only asserts `Contains("ok")`. | Accept: explicit arrays and an exact-text assertion. |
| R26 | F | Q | I 7 `[S]` | Top-level `twinCat` is set by the last shell start, so a not-installed last entry reports the previous line; `Outcome.Error` is not set for a non-zero matrix exit. | Accept: `twinCat` is the last entry that actually ran or null; `Outcome.Error` is set; test. |
| R27 | F | Q | I 6 `[S]` | `check` has no `--isolate-dir` or `--keep-isolated`; the plan does not say who repeats `OutsideRoot` and the long-path check for it. | Accept: a shared `PrepareIsolated(ctx, path)`; README states that `check` has no keep option. |
| R28 | F | A | I 6 `[S]` | "First code other than 0 and 10 wins" hides a real compile error (10) behind an environmental failure (1). | Accept: stop codes (2, 130) first; otherwise 10 if any entry failed to build; otherwise the first other non-zero code. Test `[10, 1]` gives 10. |
| R29 | F, G | A | C 6 `[S][C]` | `buildAll` must carry G's selection; F's spike starts two CLI processes instead of two entries in one process; `check` is described without the selection. | Accept: F says `buildAll` carries `PlcSelection`; after G lands there is one joint acceptance run in one process (`--tc 4024,4026 --no-tests` and `check`, a fresh copy per entry, selection effective in each). |
| R30 | F | A | I 6 `[C]` | `TwinCatInstall.Builds` lists only `Build_*` folders with `RepTool.exe`; a non-empty list is treated as complete and may report exit 15 for a line XAE could select. | Accept: the list is a hint; a negative result is confirmed by the shell's version selection; a mixed layout goes into the spike. |
| R31 | G | A | C 6 `[S]` | Names of the `.plcproj`, the COM tree and `Diagnostic.Project` are mixed; a default tree name `PLC` in both PLCs makes `Excludes("PLC")` match the library PLC too. | Accept: match by identity (`PlcHandle.TreePath` to the excluded project path, confirmed in spike step 1), names only where the spike shows they are unique; when unsure keep the diagnostic. |
| R32 | G | A | C 7 `[S]` | With `--isolate` the selection is resolved from the original solution but the shell works on the copy, so file and tree matching never hits. | Accept: resolve against `copy.Solution` or translate with the copy roots; Core test with copy-rooted paths; `--isolate --no-tests` is a manual step. |
| R33 | G | A | C 6 `[S]` | `.sln` lines exist only for `.tsproj`, not for nested `.plcproj` (`SolutionFile.cs:26-32`), so paths B and C work only for the split layout; `ProjectGuid` is a `.plcproj` GUID. | Accept: the spike table marks B and C as tsproj-level, C reads the `.tsproj` GUID from the `.sln` line, the shared layout uses path A, exit 2, or a copy-edited `.tsproj` under `--isolate`; `Touches` corrected. |
| R34 | G | A | C 6 `[S]` | `DiscardChanges` is sticky (`XaeShell.Build.cs:84-85`), so path B would drop a saving build's later writes; `SelectPlatform` can switch to an untoggled context. | Accept: `ShouldBuild` is restored in a `finally` and saved again, per `Build` call and per platform; no sticky flag; the multi-platform case joins manual step 5. |
| R35 | G | Q | I 5 `[S]` | `BuildProject` per unit parses the summary and clears the pane only once. | Accept: sum a summary per call or clear the pane between calls; the plan says which. |
| R36 | G | T | I 7 `[S]` | Test paths use backslash literals and fail on ubuntu. | Accept: all fixture paths through `Path.Combine`; `IsTestProject` normalises both separators. |
| R37 | G, J | T | I 5 `[S]` | The test-folder rule misses `Lib.UnitTests` and `Lib_Test`, and wrongly drops a sample in a `Tests` folder. | Accept: theory rows for both, README states that only the documented pattern is detected; one rule for G and J (M3). |
| R38 | G | T | I 6 `[S]` | "Everything excluded" is underspecified and indistinguishable from "no PLC found". | Accept: tests `NoTestsExcludingEverythingStops` and `UnionOfNameAndNoTests`; hint "Remove --no-tests or name fewer projects"; "no PLC found" is its own message. |
| R39 | G | Q | I 7 `[S]` | `excludedDiagnostics` per build needs a new `BuildResult` field not listed in `Touches`. | Accept: `BuildResult` joins `Touches` with an optional trailing field; the count stays at run level in JSON. |
| R40 | G | A | I 5 `[S]` | `--clean` cleans the excluded PLC's outputs; `lib save` of an excluded PLC still opens the test project. | Accept: `--clean` is a known limit in the README; the `lib save` exit code with the test project unresolved joins the U5 pass criteria. |
| R41 | G | T | I 6 `[S]` | Task 3 encodes an unverified name-suffix guess before the spike; Task 4's COM path has no test. | Accept: Task 3 starts after spike step 1; Task 5 gets a manual regression checklist (each layout, `git status`, both lines). |
| R42 | H | A | C 9 `[S]` | Premise 3 is false: `LibraryRepository.Scan` applies the library-file rule (`LibraryRepository.cs:51`), so the planned "no library file" reason can never occur. | Accept, done in the plan: premise 3, decision 3 and the test are corrected; `Plan` has no repository re-check; for `*` the next older installed version is used and the test pins that. |
| R43 | H | A | C 8 `[S]` | The prune guard checks only the version folder; a junction at `_Libraries`, the vendor or the library folder sends `Isolation.DeleteFolder` (`:401-406`) outside the project; `Apply` re-checks only the prefix. | Accept: `Apply` checks every component from `_Libraries` down for reparse points and refuses the whole project (exit 12) before any write; tests for linked `_Libraries`, vendor and library folders. |
| R44 | H | A | C 7 `[S][C]` | The swap deletes the old version folder, then moves the stage in; a failure between leaves the version missing, and a cleanup could remove the finished stage. | Accept: rename the old folder aside (`.<version>.iecode-old`), move the stage in, then delete the old one; the next run restores a leftover `.iecode-old` when the version folder is missing; unselected files are carried over by design; the README says atomicity holds per version, not across projects. Tests for a failure between the renames. |
| R45 | H | A | C 7 `[S]` | Sync overwrites or deletes files in a git-tracked folder with no way to notice local edits. | Accept: when the folder is in a git work tree and `git status --porcelain` shows changes there, Update and Prune skip that folder and report it, unless `--force`; no git, no check. Task 0 stays a hard gate for the "every file" default. |
| R46 | H | A | C 8 `[S]` | The repository lock is held for the whole run and blocks every install for up to 1800 s. | Accept: the lock covers the scan and the copy of all sources into stage folders only; the swap runs after the release. |
| R47 | H | T | I 8 `[S]` | No path-length check before writing; version folder case collisions are untested. | Accept: a pre-write length check over all planned targets (a missing-style failure before any write); test for a case-insensitive collision. |
| R48 | H | T | I 7 `[S]` | Test gaps: `Apply` failure, two projects with different versions of one library, a target that is a file, a leftover `.iecode-old` or stage folder, weak link tests. | Accept: add each; the link tests use the `mklink /J` fallback of `IsolationTests.cs`. |
| R49 | H | Q | I 6 `[S]` | Exit 12 and exit 3 stretch their meaning. | Accept: the mapping is written in the README row and kept consistent with `lib check`. |
| R50 | H | Q | I 6 `[S]` | Task 1 holds 12 tests and two jobs; its reparse test lives in Task 2. | Accept: Task 1 splits into "wanted set and Add/Missing" and "existing-folder classification"; the reparse test moves to Task 1. |
| R51 | H | A | C 6 `[C]` | `--prune` treats a second version of a directly referenced library as unneeded although a dependency may need it. | Accept: the README names the limit; `--prune` runs only after the dry-run list is shown and is guarded by R45; spike Task 0 adds a direct plus indirect version case. |
| R52 | H | A | I 6 `[C]` | Two `.plcproj` files can share one `_Libraries` folder; separate plans run in sequence. | Accept: group by physical target folder, merge the wanted sets, apply one plan per folder; when a partial selection cannot name the sharers, do not prune. |
| R53 | I | A | C 7 `[S]` | The post-install check assumes RepTool writes the `cache` entry at once; the spike never proves it, so every first install could fail with exit 12. | Accept: spike gate adds "a clean RepTool install of a new version adds the entry immediately, no shell running, both lines"; otherwise Task 5 is warn-only. |
| R54 | I | A | C 8 `[S]` | `FinishExport` catches the index check as an install failure and writes "not installed" with the wrong hint. | Accept: a distinct result, and a pure Core function that decides message and exception from (failed install, failed index check, publish result); `FinishExport` says "installed, but not in TwinCAT's index". |
| R55 | I | A | C 8 `[S]` | The spike snapshot and backup cover the ProgramData repository, but 4024 uses `<TwinCAT>\Components\Plc\Managed Libraries` (`LibraryRepository.ForLine`). | Accept: back up and restore both `Candidates`; run S1 once per line. |
| R56 | I | A | C 6 `[S]` | `lib verify` has no `--tc`; "ok in one repository" gives a false OK for the line that builds. | Accept: add `--tc` (line to `ForLine`); the "any repository" rule only when the line is unknown. |
| R57 | I | A | C 7 `[S][C]` | The before/after reads happen outside the repository lock (`RepTool.Run` releases it); a concurrent writer is blamed or hidden; an unreadable index could turn a good install into exit 12. | Accept: the reads share one lock hold with the operation, or the check takes the lock for the read; a read that is not `Read` only warns; tests `AfterInstall_AfterUnreadable_ReturnsNull` and a concurrent writer. |
| R58 | I | Q | I 8 `[S]` | `expected = null` has no rule; non-library units, `SaveReleased` and the version written by `writeVersion` are unclear. | Accept: null means no check, non-library units are never checked, `SaveReleased` gets the parameter (in `Touches`), the version is read after `writeVersion`. |
| R59 | I | Q | I 7 `[S]` | `lib uninstall` defaults to `--version all`, which has no concrete ids, and "removed entry still present" is never checked. | Accept: name and vendor matching for "all"; add the removed-entry check. |
| R60 | I | A | I 6 `[S]` | Beckhoff system libraries and placeholder references may not appear in `cache` as the plan expects. | Accept: spike S1 records them; a test with a system library. |
| R61 | I | Q | I 6 `[S]` | Tasks 2 to 5 do not say they run only if O1 or O2. | Accept: a "Run only if O1/O2" line at the top of Tasks 2 to 5. |
| R62 | I | A | I 6 `[C]` | S1 installs one of two pinned libraries and judges "manager error yes/no"; the control build may fail on the second one. | Accept: one test reference, a proven green control build, a fresh consumer copy and shell per variant, restore and green again before O1/O2/O3. |
| R63 | I | A | I 6 `[C]` | `lib restore`, `lib install` and `install-project` do not go through `InstallSaved`, so "after every write" is not true. | Accept: scope is the save paths and uninstall; the README says so. |
| R64 | J | A | C 8 `[S]` | The adapter is detected from the `.tmc` before the build; a fresh clone or an isolated copy has no `.tmc` yet. | Accept: detect after the build (or from the copy before it is deleted); `IsStale` is a warning; exit 3 only after the build. |
| R65 | J | A | C 8 `[S][C]` | `ReadPlcState` turns an ADS fault into a state with null `AdsState` (`AdsWatchBackend.cs:392-395`), so a lost connection polls for 60 s; `Connect()` throws before the PLC port exists; `Decide` is stateless and cannot tell "never in Run" from "left Run". | Accept: `Decide` takes the whole `PlcState` and a "reached Run" flag; connect with retries inside the start window; tests for connection lost (exit 16), a late port, and Run then Stop. |
| R66 | J | A | C 7 `[S]` | Nothing restores the runtime after the test; Ctrl+C is not handled. | Accept: no restore in round 2, stated in the README and in the confirmation text; `--stop-after` and Ctrl+C (R15) go to the TODO list. |
| R67 | J | T | C 7 `[S]` | Indexed paths like `TestCaseResults[2].TestName` are not shown to resolve; a missing symbol is mapped to null. | Accept: spike S2 reads one indexed path (PC-only); once the finished flag proved the framework exists, a missing symbol fails instead of returning null. |
| R68 | J | T | C 6 `[S]` | The symbol map is parsed without limits (`count`, `{i}`, malformed JSON, wrong types). | Accept: cap on `count` (10000, warning), malformed JSON is exit 2, `count` as a literal or a counter path is stated; tests for each. |
| R69 | J | A | I 7 `[S]` | The safety check runs once before the build; the state may change, and a remote target's state is never read. | Accept: re-check right before `Activate`; with `--yes` on a remote target read the state and log a warning. |
| R70 | J | A | C 7 `[S][C]` | The test PLC, the activated system project and the ADS port are not tied together; the default port 851 may read the library PLC. | Accept: resolve `(system project, PLC instance, port)` before activation, reject conflicting overrides, verify the loaded program after the restart; `--port` is required when the solution has more than one PLC; `PlcPort.Read` only if S2 finds a readable file; negative tests for two system projects and a wrong port. |
| R71 | J | T | I 7 `[S]` | `Decide` lacks the "finished while not in Run" case; `LocalTarget.Resolve` is in Automation, not Core. | Accept: add the case; the Cli resolves ids and passes resolved values. |
| R72 | J | Q | I 7 `[S]` | Task 8 carries wiring, `--isolate`, JSON, JUnit and eight manual checks with no test. | Accept: exit-code mapping, JSON shape and per-case formatting move to a Core `TestOutput` with tests; the `Activate(save)` change becomes its own task after S1. |
| R73 | J | Q | I 6 `[S]` | `Activate` is a wrapper over `ActivateCore`; `save` must reach both. | Accept: `Touches` names `ActivateCore`; line numbers are the ones on `main`. |

Approval readiness: PASS. All 73 rows cite the delegated answer above; no row is pending.

### What already exists
- Round 1 on `main`: the repository lock (`RepositoryLock`), `Isolation.Create` with its per-process allocation (M6), the staged export and the shell registry. Round 2 reuses them; R7, R18 and R57 are about how the new plans attach to them, not about replacing them.
- `LibraryRepository.Scan` already drops half-installed version folders (R42), so H needs no second rule.
- `AdsWatchBackend.ReadPlcState`, `ReadOnce` and `Connect` exist for J; R65 changes how J uses them, not the backend.
- No shared-code extraction is proposed beyond the Core loop and decision classes named in R11, R22, R54 and R57; each has the real caller in this round.

### Not in scope (decided in this review)
- A `CancelKeyPress` handler, a per-job watchdog and a copy-size warning for parallel builds: known limits now (R15), TODO items.
- `--copy-tmc` per parallel job (R10) and `--stop-after` for `iecode test` (R66): deferred, TODO items.
- A warning when `*` skips a newer half-installed version (R42): deferred, no existing signal for it.
- Scrubbing `TODO.md` and `docs/research/cli-build-workflow.md` for the framework name (R5): owner's call.

### Failure modes (new paths)
- E, two workers: a job's diagnostics land in the wrong job (R7, fixed), a worker exits early (R8, fixed), a hung COM call blocks `Done` (R15, known limit, named; not silent: the run times out only by the user).
- F: a hidden upgrade dialog (R24, fixed), a `--tc` list on a command that ignores it (R23, fixed).
- G: a name collision drops a real error (R31, fixed); an isolated copy ignores the selection (R32, fixed).
- H: a linked folder is deleted (R43, fixed); a crash between delete and move (R44, fixed); local git edits overwritten (R45, fixed).
- I: a good install reports exit 12 because the index is slow or unreadable (R53, R57, fixed).
- J: the wrong PLC's results are read (R70, fixed); the runtime stays in Run (R66, documented, no restore).
- Critical gaps (no test, no handling, silent): none left after the rows above; R15 and R66 are visible limits, not silent.

### Test coverage (the plans' paths against the review)
```
CORE (CI, xUnit)                                  PC ONLY (manual step per plan)
E  schedule, tri-state Next, runner fakes [R8,R11]  E  U1-U3, parallel run, close/delete [R18,R19]
F  TcMatrix.Run, ImpliesIsolate, table [R20-R28]    F  4024-in-4026 dialogs, two entries in one process [R24,R29]
G  PlcSelection, TestProjects, filter [R31-R38]     G  COM path A/B/C per layout, isolate [R32-R34]
H  Plan, Apply, swap, reparse [R42-R52]             H  real _Libraries in git, Task 0 file set
I  RepositoryIndex, decision fn [R54,R57-R59]       I  index behaviour, both lines [R53,R55,R60,R62]
J  TestRun, adapter, TestOutput [R65,R68,R71,R72]   J  ADS read, indexed paths, activation [R67,R70]
COVERAGE: every Core branch named in a row gets a planned test; the PC-only column is the manual-check list
GAPS: the PC-only column; no PC-only path is claimed as tested
```

### Worktree parallelization
| Step | Modules | Depends on |
|---|---|---|
| G | Core Projects, Automation Build, Cli ProjectCommands | spike A |
| F | Core, Cli ProjectCommands/Runner/Reporter | G |
| E | Core, Cli Runner/Workspace/Reporter | F, spike A and B |
| H | Core Projects, Cli LibraryCommands | spike A |
| I | Core, Cli LibraryCommands/Runner, Automation RepTool | H, spike B |
| J | Core Ads/Projects (new files), Automation Plc, Cli Program | G Task 2, spike B |

Lane 1: G, F, E (shared `ProjectCommands`, `Runner`). Lane 2: H, I (shared `LibraryCommands`, `Runner.FinishExport`). Lane 3: J (starts after G Task 2). Launch lanes 1 and 2 together after spike A; J after G Task 2 and spike B. Conflict flags: `WorkspaceCommands.cs` (E, I, R3), `Errors.cs` and `HelpText` (J only), `TestProjects.cs` (G, R3).

### Implementation tasks
- [x] **T1 (P1, human: ~1h / CC: ~10min)**: fold the rows of each plan into its sub-plan text before its first task (R6).
- [x] **T2 (P1, human: ~4h / CC: ~30min)**: plan E: R7, R8, R9, R11, R17, R18 into Tasks 2 to 5; spike U1 additions (R19).
- [x] **T3 (P1, human: ~3h / CC: ~25min)**: plan F: R20 to R23 into Tasks 3 to 5, split Task 4 (R22).
- [x] **T4 (P1, human: ~3h / CC: ~25min)**: plan G: R31 to R34 into the spike table and Tasks 2 to 4.
- [x] **T5 (P1, human: ~3h / CC: ~25min)**: plan H: R43 to R46, R51, R52 into Tasks 1 to 3.
- [x] **T6 (P1, human: ~3h / CC: ~25min)**: plan I: R53 to R57 into the spike gate and Tasks 3 to 5.
- [x] **T7 (P1, human: ~3h / CC: ~25min)**: plan J: R64, R65, R67, R70 into Tasks 4 to 8.
- [ ] **T8 (P2, human: ~30min / CC: ~5min)**: add the TODO items from "Not in scope" to `TODO.md`.

### Outside voice
Native fallback (the Codex CLI is not installed): a Plan agent found 10 further points; the ones kept are R2, R3, R4, R5 and R6. Rejected: dropping E and I now (R4), and a breaking-change claim for `ws build` exit codes (with one worker the order and codes match today's, R9). A second opinion from the GitHub Copilot CLI added R17, R18, R19, R29, R30, R44, R51, R52, R57, R62, R63 and R65 (Copilot's own findings on H's swap, E's ownership, I's spike and J's start window overlap the per-plan reviews and were merged). No outside finding is open.

### Completion summary
- Step 0: Scope Challenge: scope accepted as-is
- Reality rows: 7/7 applicable rows emitted, unverified premises are the spike-gated XAE, RepTool and ADS behaviours
- Architecture Review: 43 issues found
- Code Quality Review: 16 issues found
- Test Review: coverage diagram produced, 14 gaps identified
- Performance Review: 0 issues found (parallel copy size is R15, a known limit)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 5 items proposed (T8)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: native fallback completed; Copilot second opinion completed
- Parallelization: 3 lanes, 2 parallel / 1 sequential
- Lake Score: N/A (all choices were decided by delegation, not scored)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | - | - |
| Outside Review | native Plan agent + GitHub Copilot CLI | Independent 2nd opinion | 1 | completed (native fallback; Codex not installed) | 10 plus 12 findings, all dispositioned |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 73 rows, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | - | - |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | - | - |

**OUTSIDE COVERAGE:** native Plan agent (in-host, not an outside provider) and the Copilot CLI, both completed; the Codex CLI is not installed, so no Codex coverage.
**CROSS-MODEL:** the native reviews and Copilot agree on H's swap safety, I's lock and spike, and J's start window; Copilot alone found the cross-line edge (R17) and the close-before-delete order (R18).
**VERDICT:** ENG REVIEW DONE, issues open as mapped work (73 rows accepted with plan changes); implementation waits for the two spike sessions and the two spike sessions.

NO UNRESOLVED DECISIONS
