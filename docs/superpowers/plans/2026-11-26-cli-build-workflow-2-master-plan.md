# CLI Build Workflow Master Plan, Round 2 (2026-11-26)

> **Status: master plan, not yet reviewed.** The sub-plans E to J are TDD plans. Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Where a sub-plan and an M entry below differ, the M entry wins. Plans live on `plan/cli-build-workflow-2`; implementation starts after round 1 (plans A to D, [master plan](2026-11-24-cli-build-workflow-master-plan.md)) is merged, see "Prerequisites".

**Goal:** Close the items round 1 left open in the TODO section "CLI: build and library workflow at scale": build many repositories in parallel, build for several TwinCAT lines in one call, build without the test PLC project, keep a tracked project library folder in step with the references, check that an installed library is really known to TwinCAT, and run PLC unit tests from the CLI.

**Architecture:** Same rules as round 1: every decision lives in a small pure class in `IECode.Core` with xUnit tests (Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire it. Each plan starts with a spike on a TwinCAT PC wherever its premise cannot be read from the code, and each spike names what its outcome means for the tasks after it.

**Tech Stack:** C# .NET (xUnit), System.CommandLine, COM late binding to the XAE shell (STA threads), RepTool, the existing ADS stack (`AdsWatchBackend`).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) (sections 2 and 6, answers Q4 and Q7) and the "Medium" / "Large" items of the section "CLI: build and library workflow at scale" in [TODO.md](../../../TODO.md).

## Global Constraints

Round 1's Global Constraints apply unchanged (public repository, fixtures `Tc3_MotorLib` / `Tc3_AxisLib` / vendor `Example`, commits with why-body and `git commit -s` with the noreply address, `dotnet build` and `dotnet test` separately through the PowerShell tool, additive JSON, a README row and a CHANGELOG line for every user-visible change, decisions in Core). In addition:

- Line numbers in the sub-plans refer to `feature/cli-build-workflow-d` at `365af0f` (the tip of the round-1 stack). Round 1 is still changing; before each task, re-check that task's "Premises checked" entries against the current base.
- Exit code 21 is reserved for plan J (`TestsFailed`). No other round-2 plan adds an exit code.
- Spikes that change the library repository or the local runtime run only on a PC without a connected machine, with a backup first (M9).

## Sub-plans

| Plan | Item (TODO.md) | Spike on a TwinCAT PC first | Tasks | Size `[estimated]` |
|---|---|---|---|---|
| [E](2026-11-26-cli-build-workflow-2-e-parallel-ws-build.md) | `ws build --parallel N` | U1 two STA shells in one process, U2 peak memory per shell, U3 does a running shell see a library installed after its start | 6 | 2.5 days + 75 min PC |
| [F](2026-11-26-cli-build-workflow-2-f-tc-matrix.md) | `build` / `check --tc 4024,4026` | 4024 project in 4026 and back (hidden dialogs), missing line, two isolated builds in a row | 5 | 1.5 days + 1 h PC |
| [G](2026-11-26-cli-build-workflow-2-g-build-subset.md) | `build --exclude-plc` / `--no-tests` | which COM path builds a subset (`BuildProject` per PLC or per `.tsproj`, `ShouldBuild`, `.sln` lines in the copy, none) | 5 | 2 days (1.5 h PC) |
| [H](2026-11-26-cli-build-workflow-2-h-project-folder-sync.md) | `lib project-folder sync [--prune]` | file set of a version folder in a tracked `_Libraries` | 4 | 1 to 1.5 days |
| [I](2026-11-26-cli-build-workflow-2-i-lib-verify.md) | `lib verify` | reproduce the lost install; does the repository index file `cache` decide what the library manager sees | 6 | 1.5 days |
| [J](2026-11-26-cli-build-workflow-2-j-iecode-test.md) | `iecode test` | what the named test framework is, activation without save, TcUnit result symbols and ADS port on 4024 and 4026 | 8 | 3 days + 0.5 day PC |

Total about 12 days of work plus one spike day on a TwinCAT PC `[estimated]`.

## Prerequisites

1. Round 1 merged (A to D pull requests). If it is not merged when round 2 starts, base the lanes on the tip of the round-1 stack and rebase after each round-1 merge.
2. One TwinCAT PC with 4024 and 4026, no connected machine, for the spike day.

## Order and lanes

```
Spike day (one PC session, gates every lane):
  G T1, F T1, E T1 (U1-U3), H T0, I T1 (S1-S4, backup first), J T1 (S0-S2)

Lane 1 build path:  G ──► F ──► E          (ProjectCommands.cs, XaeShell.Build.cs, Runner.cs, Reporter.cs, WorkspaceCommands.cs)
Lane 2 library:     H ──► I                 (LibraryCommands.cs, Runner.InstallSaved)
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
| M2 | E, I | `Runner.InstallSaved` gets I's new parameter as an optional last parameter (`LibraryId? expected = null`), so E's call `InstallSaved(childCtx, file, session.Request)` compiles unchanged. Whichever lane lands second rebases. |
| M3 | G, J | One test-project rule: `TestProjects.IsTestProject(string solutionDir, string plcprojPath)` in `cli/src/IECode.Core/Projects/TestProjects.cs`. A whole folder segment below the solution folder equal to `Test`, `Tests`, `UnitTest`, `UnitTests` or ending in `.Test` / `.Tests`, case-insensitive. The lane that lands first creates the file; `PlcSelection` (G) and `TestProjects.Select` (J) call it. Both plans are already edited to this. |
| M4 | F, G | `ProjectCommands.cs`: G lands first and does not restructure `BuildIsolated`; F moves it. |
| M5 | F, all | `Diagnostic` gets the trailing optional field `Tc` (F). A later field goes after it. |
| M6 | E | E owns the fix for two isolated copies of one repository in one process (copy folder name `<hash>-<pid>`, `Isolation.cs:70-74`, `Create` deletes an existing folder of that name, `:164`): a slot number in the name (E Task 3). F builds its copies one after the other and does not need it. |
| M7 | E, TODO | Gap found while planning, confirmed in the code: `ws build` skips every unit after the first one of a solution (`WorkspaceCommands.cs:133`, `continue` before the install block). A second library PLC project in the same solution is therefore never installed for its users. E's job model fixes it. Until then it is a known limit and gets a TODO line. It is older than round 1, so the round-1 lane does not have to fix it. |
| M8 | E | E depends on spike U1. If two STA threads in one process cannot each drive a shell, E stops after Task 4, which is still usable as Core plus scheduling. A child process per worker then needs its own plan; no fallback is improvised inside E. |
| M9 | I, J | Spike safety: before I's spike, copy the whole `Managed Libraries` folder aside and restore it afterwards, because S1 edits the `cache` index by hand and S3 uninstalls in bulk. J's spike activates a configuration on the local runtime: only on a PC with no machine and nothing in Run that matters. |
| M10 | J | Symbol paths and names of the project-specific test framework found in spike S0 stay in a private file outside the repository. The repository only gets the generic symbol-map format (`iecode-test-adapter/1`) and the TcUnit adapter. |
| M11 | I | If spike S1 shows that the `cache` index decides what the library manager sees, I Tasks 2 to 5 run as written. If nothing reproduces and `cache` has no effect (outcome O3), the lock from round 1 stays the fix. `lib verify` then shrinks to the shell-based check (Task 6) or is dropped; this is decided right after the spike, not during implementation. |

## Not in this master plan

- `ws build --no-tests` and `ws build --tc <list>`: follow-ups once E, F and G have landed. Each wires an existing Core rule into the job loop.
- `--isolate --from-head` (research Q2), indirect dependencies in `project-folder sync` (format of the `dependencies` file unknown), `lib verify --repair`.
- A built-in adapter for the project-specific test framework (M10). It goes through the symbol map.
- A supervisor process with a hard deadline (kept out in round 1, still out).

## Review

Not reviewed yet. Next step: `/plan-eng-review` on this master plan with the six sub-plans, and a second opinion (Copilot) like round 1. The reviews add R entries to this file.
