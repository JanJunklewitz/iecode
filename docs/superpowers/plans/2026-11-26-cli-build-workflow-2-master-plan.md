# CLI Build Workflow Master Plan, Round 2 (2026-11-26)

> **Status: master plan, not yet reviewed.** The sub-plans E to J are TDD plans. Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Where a sub-plan and an M entry below differ, the M entry wins. Plans live on `plan/cli-build-workflow-2`; implementation is based on `feature/cli-build-workflow-master` (round 1, plans A to D, [master plan](2026-11-24-cli-build-workflow-master-plan.md), implemented and reviewed there), see "Prerequisites". All six sub-plans were re-checked against that base on 2026-11-26.

**Goal:** Close the items round 1 left open in the TODO section "CLI: build and library workflow at scale": build many repositories in parallel, build for several TwinCAT lines in one call, build without the test PLC project, keep a tracked project library folder in step with the references, check that an installed library is really known to TwinCAT, and run PLC unit tests from the CLI.

**Architecture:** Same rules as round 1: every decision lives in a small pure class in `IECode.Core` with xUnit tests (Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire it. Each plan starts with a spike on a TwinCAT PC wherever its premise cannot be read from the code, and each spike names what its outcome means for the tasks after it.

**Tech Stack:** C# .NET (xUnit), System.CommandLine, COM late binding to the XAE shell (STA threads), RepTool, the existing ADS stack (`AdsWatchBackend`).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) (sections 2 and 6, answers Q4 and Q7) and the "Medium" / "Large" items of the section "CLI: build and library workflow at scale" in [TODO.md](../../../TODO.md).

## Global Constraints

Round 1's Global Constraints apply unchanged (public repository, fixtures `Tc3_MotorLib` / `Tc3_AxisLib` / vendor `Example`, commits with why-body and `git commit -s` with the noreply address, `dotnet build` and `dotnet test` separately through the PowerShell tool, additive JSON, a README row and a CHANGELOG line for every user-visible change, decisions in Core). In addition:

- Line numbers in the sub-plans refer to `feature/cli-build-workflow-master` at `0515a61` (`8834930` on top only adds a checklist, nothing under `cli/`). Before each task, re-check that task's "Premises checked" entries against the current base.
- Exit code 21 is reserved for plan J (`TestsFailed`). No other round-2 plan adds an exit code.
- Spikes that change the library repository or the local runtime run only on a PC without a connected machine, with a backup first (M9).

## Sub-plans

| Plan | Item (TODO.md) | Spike on a TwinCAT PC first | Tasks | Size `[estimated]` |
|---|---|---|---|---|
| [E](2026-11-26-cli-build-workflow-2-e-parallel-ws-build.md) | `ws build --parallel N` | U1 two STA shells in one process, U2 peak memory per shell, U3 does a running shell see a library installed after its start | 6 | 2.25 days + 75 min PC |
| [F](2026-11-26-cli-build-workflow-2-f-tc-matrix.md) | `build` / `check --tc 4024,4026` | 4024 project in 4026 and back (hidden dialogs), missing line, two isolated builds in a row | 5 | 1.5 days + 1 h PC |
| [G](2026-11-26-cli-build-workflow-2-g-build-subset.md) | `build --exclude-plc` / `--no-tests` | which COM path builds a subset (`BuildProject` per PLC or per `.tsproj`, `ShouldBuild`, `.sln` lines in the copy, none) | 5 | 2 days (1.5 h PC) |
| [H](2026-11-26-cli-build-workflow-2-h-project-folder-sync.md) | `lib project-folder sync [--prune]` | file set of a version folder in a tracked `_Libraries` | 4 | 1 to 1.5 days |
| [I](2026-11-26-cli-build-workflow-2-i-lib-verify.md) | `lib verify` | reproduce the lost install; does the repository index file `cache` decide what the library manager sees | 6 | 1.75 days |
| [J](2026-11-26-cli-build-workflow-2-j-iecode-test.md) | `iecode test` | what the named test framework is, activation without save, TcUnit result symbols and ADS port on 4024 and 4026 | 8 | 3 days + 0.5 day PC |

Total about 12 days of work plus one spike day on a TwinCAT PC `[estimated]`.

## Prerequisites

1. Base: `feature/cli-build-workflow-master`. When round 1 goes to `main` as stacked pull requests, rebase each lane after the round-1 merge.
2. One TwinCAT PC with 4024 and 4026, no connected machine, for the spike day.

## Order and lanes

```
Spike day (one PC session, gates every lane):
  G T1, F T1, E T1 (U1-U3), H T0, I T1 (S1-S4, backup first), J T1 (S0-S2)

Lane 1 build path:  G ──► F ──► E          (ProjectCommands.cs, XaeShell.Build.cs, Runner.cs, Reporter.cs, WorkspaceCommands.cs)
Lane 2 library:     H ──► I                 (LibraryCommands.cs, Runner.StageExport / FinishExport / InstallSaved, WorkspaceCommands.cs one argument)
Lane 3 test:        J                       (new files; Errors.cs, XaeShell.Plc.cs, Program.cs)
```

Why this order:
- **G before F:** both edit `ProjectCommands.Build` and `Check`. G is the smaller change (one optional parameter on `XaeShell.Build`). F then moves `BuildIsolated` out of its local function on top of it.
- **F before E:** E touches `Runner`, `Reporter` and `WorkspaceCommands`, and its own plan asks for F first. E's follow-up `ws build --no-tests` needs G's `PlcSelection`.
- **H before I:** both add a line to the `lib` subcommand list. I also changes `Runner.InstallSaved` (M2) and checks after install and uninstall, so it should land on a quiet library command file.
- **J alone:** almost everything in J is a new file. It shares only `TestProjects` with G (M3).

The three lanes run in parallel in three worktrees after the spike day. One pull request per plan, stacked inside a lane, each under about 600 changed lines; E and J may need two pull requests each (Core first, then wiring).

## Master decisions (M)

The user delegated the design decisions; each row is decided by the planner and can be overruled in review.

| ID | Plans | Decision |
|---|---|---|
| M1 | J, all | Exit 21 = `TestsFailed` (J). E, F, G, H, I add no exit code (checked in each plan). `Errors.cs` ends at 20 today (`Errors.cs:6-22`). |
| M2 | E, I | Round 1 installs through `Runner.StageExport` / `FinishExport` (`Runner.cs:145-176`; callers `lib save`, `save-all`, `ws build`, `ws release`). I adds `LibraryId? expected = null` as the optional last parameter of both `FinishExport` and `InstallSaved`, so E's call `FinishExport(childCtx, StageExport(...), session.Request)` compiles unchanged. I also passes the argument in `WorkspaceCommands.cs` (E's file): whichever lane lands second adds it at the other's call sites. |
| M3 | G, J | One test-project rule: `TestProjects.IsTestProject(string solutionDir, string plcprojPath)` in `cli/src/IECode.Core/Projects/TestProjects.cs`. A whole folder segment below the solution folder equal to `Test`, `Tests`, `UnitTest`, `UnitTests` or ending in `.Test` / `.Tests`, case-insensitive. The lane that lands first creates the file; `PlcSelection` (G) and `TestProjects.Select` (J) call it. Both plans are already edited to this. |
| M4 | F, G | `ProjectCommands.cs`: G lands first and does not restructure `BuildIsolated`; F moves it. |
| M5 | F, all | `Diagnostic` gets the trailing optional field `Tc` (F). A later field goes after it. |
| M6 | E | Done in round 1 (re-check 2026-11-26): `Isolation.Create` claims a free `<hash>-<pid>`, `-2`, `-3` … folder with a marker file (`Isolation.cs:177-199`, `:252-270`). E Task 3 only pins it with the test `TwoThreadsOfOneProcessGetTwoCopies`; `Isolation.cs` is no longer in E's Touches. |
| M7 | E | Done in round 1 (re-check 2026-11-26, confirmed in the code): `ws build` installs every export of a solution's stage (`Workspace.BuildStages`, `WorkspaceCommands.cs:122`, `:145-150`); the `continue` at `:133` only skips a second build of the same solution. E's job is a `WorkspaceStage`, so E adds no second grouping rule. |
| M8 | E | E depends on spike U1. If two STA threads in one process cannot each drive a shell, E stops after Task 4, which is still usable as Core plus scheduling. A child process per worker then needs its own plan; no fallback is improvised inside E. |
| M9 | I, J | Spike safety: before I's spike, copy the whole `Managed Libraries` folder aside and restore it afterwards, because S1 edits the `cache` index by hand and S3 uninstalls in bulk. J's spike activates a configuration on the local runtime: only on a PC with no machine and nothing in Run that matters. |
| M10 | J | Symbol paths and names of the project-specific test framework found in spike S0 stay in a private file outside the repository. The repository only gets the generic symbol-map format (`iecode-test-adapter/1`) and the TcUnit adapter. |
| M11 | I | If spike S1 shows that the `cache` index decides what the library manager sees, I Tasks 2 to 5 run as written. If nothing reproduces and `cache` has no effect (outcome O3), the lock from round 1 stays the fix. `lib verify` then shrinks to the shell-based check (Task 6) or is dropped; this is decided right after the spike, not during implementation. |
| M12 | E, F, J | `--isolate` refuses a solution with any project type other than `.plcproj`, `.tsproj` and `.tspproj` (`Isolation.OutsideRoot`, `ProjectCommands.cs:128-131`), so such a solution cannot use `ws build --parallel` (E), a `--tc` list (F) or `test --isolate` (J). E checks every job's solution before the first build and stops with exit 2 listing the refused solutions and the hint "run without --parallel" (not a job failure in the middle of a run). F and J keep the existing exit-2 message; the README rows of all three name the limit. |
| M13 | round 1 | Findings in the round-1 code from the re-check, for the round-1 lane (no round-2 task depends on a fix): (a) `activate` confirms dialogs of the TwinCAT helper process only when `TWINCAT3DIR` is set (`XaeShell.Plc.cs:174-176`), otherwise it logs a detail line, so an unattended `activate` (and J) may hang on "symbol type change"; J's manual step (i) checks it, the open-test checklist should too. (b) The sequential `ws build` builds a stage that needs an export of a later stage (a cycle across solutions) without a warning; E's scheduler stops it with exit 2 (known limit in E, CHANGELOG line). (c) I's spike builds the commit before the lock as `311ca62` (the lock commit is `745ca7f` after the rebase). |

## Not in this master plan

- `ws build --no-tests` and `ws build --tc <list>`: follow-ups once E, F and G have landed. Each wires an existing Core rule into the job loop.
- `--isolate --from-head` (research Q2), indirect dependencies in `project-folder sync` (format of the `dependencies` file unknown), `lib verify --repair`.
- A built-in adapter for the project-specific test framework (M10). It goes through the symbol map.
- A supervisor process with a hard deadline (kept out in round 1, still out).

## Review

Not reviewed yet. Re-checked against `feature/cli-build-workflow-master` on 2026-11-26 (all six sub-plans; M6 and M7 turned out to be done in round 1, M12 and M13 are new). Next step: `/plan-eng-review` on this master plan with the six sub-plans, and a second opinion (Copilot) like round 1. The reviews add R entries to this file.
