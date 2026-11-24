# CLI Build Workflow Master Plan (2026-11-24)

> **Status: master plan, eng-reviewed 2026-11-24 (amendments R1 to R30 below; where a sub-plan task and an R entry differ, the R entry wins).** The sub-plans A to D are TDD plans. Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Branch: `plan/cli-build-workflow` for the plans; implementation on `feature/cli-build-workflow` from `origin/main` after the docs pull request #69 is merged.

**Goal:** Make `iecode build` and the library commands cheap to run on many repositories: find missing libraries before a build, show the root cause first, leave the working tree alone, refuse silent TwinCAT line changes, and make library repository writes and the hidden XAE shell safe.

**Architecture:** Decisions live in `IECode.Core` (pure, xUnit-tested on any OS); `IECode.Cli` commands and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`, so a command adds no logic that a Core test does not cover. JSON output changes are additive (new optional fields, no renamed ones); new exit codes get a row in the README table.

**Tech Stack:** C# .NET (xUnit), System.CommandLine, COM late binding to the XAE shell, Win32 P/Invoke (Plan D only).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) (findings, verdicts, answered questions Q1 to Q9) and the section "CLI: build and library workflow at scale" in [TODO.md](../../../TODO.md).

## Global Constraints

- Public repository: no internal names, paths or data in code, tests, fixtures, docs or commits. Test fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example` (as the existing `BuildOutputTests`).
- Commits: English subject plus a 1-3 sentence why-body, author and `Signed-off-by` with the GitHub noreply address (`git commit -s`). Cosmetic changes in separate commits.
- C# build and tests only through the PowerShell tool, `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel. A running `iecode mcp` locks `cli/src/IECode.Cli/bin`; stop it first.
- Test command (all tasks): `dotnet test --project cli/tests/IECode.Core.Tests` (filter with `--filter-class` / `--filter-method` per step). Expected: all green, no skipped test that was green before.
- Existing JSON fields and existing exit codes keep their meaning; no new exit code for a failed build (R2: a static-analysis-only failure stays exit 10 with `staticAnalysisOnly: true` in JSON).
- Every decision the CLI makes lives in a Core function with a test, including exit code aggregation, pre-flight skip rules and the `--tc` fallback (R25).
- Every user-visible change gets a line under `## Unreleased` in `extension/CHANGELOG.md` (the CLI ships with the extension) and, for new options or commands, a row in `cli/README.md`.
- The VS Code extension calls `iecode build --json` (`extension/src/commands/engineering.ts`) with `--tc` only when `iecode.tcVersion` is not `auto`. Every plan names what the extension sees.

## Sub-plans

| Plan | Items (TODO.md) | Needs TwinCAT to verify | Size `[estimated]` |
|---|---|---|---|
| [A](2026-11-24-cli-build-workflow-a-failure-output.md) | pre-flight `lib check`, root causes first, `--max-errors`, static-analysis-only marker, generic last error, exit codes in `--help` | no (one manual look at a 4024 and a 4026 log) | 1.5 days (grew with R18 to R21, R25, R28) |
| [B](2026-11-24-cli-build-workflow-b-side-effect-free-build.md) | save spike, `build` without `SaveAll`, `--tc auto` guard, changed files, long-path warning, `--isolate` | yes (spike and final check) | 2.5 days (grew with R1, R3 to R5, R13 to R17) |
| [C](2026-11-24-cli-build-workflow-c-library-repository.md) | repository lock with RepTool installs, `lib update` for several libraries, `lib uninstall --all`, `lib installed` filters, `lib save` to `dist/`, resolved `*` and stray versions | no (one manual parallel install) | 1.5 days (grew with R12, R22 to R24, R26) |
| [D](2026-11-24-cli-build-workflow-d-shell-robustness.md) | modal dialog watcher, shell registry, job object, `iecode shells list / kill` | yes | 1.5 days plus 1.5 h on a TwinCAT PC (grew with R6 to R11, R27) |

All sizes are `[estimated]` (human work, no measurement).

Not in this master plan (TODO.md "Medium" / "Large"): `ws build --parallel`, `--tc 4024,4026` matrix (both need B's isolation first), `build --exclude-plc` / `--no-tests` (needs a spike whether the Automation Interface can build a subset), `lib project-folder sync`, `lib verify` (waits for a reproduction), `iecode test`.

## Order

```
1. Plan A   Core: Diagnostics.cs, new BuildTriage.cs, Restore.cs, LibraryRepository.cs, Reporter.cs; CLI: ProjectCommands.cs, LibraryCommands.cs, WorkspaceCommands.cs, Program.cs
2. Plan B   Task 1 spike first (TwinCAT PC, 30 min), then Core: new TcLineGuard.cs, GitChanges.cs, Isolation.cs, PathLength.cs; CLI: Runner.cs, ProjectCommands.cs; Automation: XaeShell.Build.cs
3. Plan C   Core: new RepositoryLock.cs, LibraryRepository.cs, new LibrarySelection.cs; CLI: LibraryCommands.cs, WorkspaceCommands.cs
4. Plan D   Automation: XaeShell.cs, Interop/DialogConfirmer.cs -> DialogWatch.cs, new ShellRegistry (Core) and JobObject (Automation); CLI: new ShellCommands.cs
```

Why this order: A and B carry the three items the user of the run named as the largest time savers (pre-flight, root cause first, no side effects). A first because it needs no TwinCAT and B's `build` changes sit on top of A's `build` output changes (both edit `ProjectCommands.Build`). C touches `LibraryCommands.cs` like A's `lib check`, so it follows A. D is independent of C and can run in parallel in a second worktree after B (both edit `XaeShell.Build.cs`).

## Pull requests

One pull request per sub-plan, stacked in the order above (A, B, C; D on top of B). Each one is small enough to review (target under 600 changed lines).

## Decisions (planner, 2026-11-24; the user delegated every decision)

1. **Pre-flight warns, never blocks.** The default library repository differs between 4024 and 4026 (`LibraryRepository.Candidates`), and `auto` may not know the line before the shell starts. A false "missing" must not stop a build. The check scans every existing candidate repository and reports a version only when it is missing in all of them. `lib check` (new, any OS) exits 3 on problems; the pre-flight inside `build` only prints.
2. **Root cause detection by origin and text, not by source.** The Error List path (`ReadErrorList`) and the Build pane path (`BuildOutput.Parse`) both feed `Diagnostic`. A root cause is an error whose message starts with `<plc>.Library Manager:` (Build pane) or matches the library-not-installed / not-found / no-license texts (both paths). New optional field `Diagnostic.RootCause` (`bool?`, JSON `rootCause: true`, omitted otherwise).
3. **`--max-errors` default 50** in human mode, `0` = all; JSON always holds all diagnostics. The root-cause block is always printed after a failed build, whatever the limit.
4. **Static analysis only = exit 21.** When every error has a code starting with `SA`, the build exits 21 instead of 10. The extension treats any non-zero exit as a failure and still lists the errors.
5. **`build` stops saving.** `XaeShell.Build()` gets a `save` parameter; `build` passes `false` unless `--save` is given; `activate` keeps saving. Gated by the spike (Plan B Task 1): if XAE writes the same files on `SolutionBuild.Build` anyway, B keeps the option but the default stays and `--isolate` becomes the answer.
6. **`--tc auto` never changes the line silently.** Saved stamp present: use its exact build, else its line, else stop with exit 15. No stamp and both lines installed: stop with exit 2 and ask for `--tc`. Explicit `--tc` is never second-guessed.
7. **`--isolate` copies the folder as it is.** Root = git top level of the solution, else the solution folder. Excluded: `.git`, `.vs`, `_CompileInfo`, `_Boot`. Ignored and untracked files are copied (Q2: a git-ignored generated folder was needed). Diagnostics paths are mapped back to the original folder so the extension's Problems view opens the real files.
8. **Repository lock is a named mutex `Local\iecode-library-repository`** (`Global\` needs a privilege normal users lack; parallel runs are in one session). Waits with a log line, times out with exit 17 after `--timeout` (default 1800 s), an abandoned mutex counts as acquired.
9. **`lib save` defaults to `dist/` next to the solution**, as `save-all`. Behaviour change, CHANGELOG line.
10. **Dialog watcher cancels unknown dialogs.** A COM call blocks while a modal dialog is open, so failing fast needs the dialog closed: after 10 s an unknown dialog of the shell process is answered with Cancel, its title and text are recorded, and the command fails with them (exit 1, hint `--visible --show-ui`). Known dialogs keep their current handling.
11. **Shell lifetime by job object.** The shell is a DCOM server, not a child process. Its PID comes from `DTE.MainWindow.HWnd`; the process is put into a job with kill-on-close, so a killed `iecode` takes its shell with it. `iecode shells list | kill` only touches PIDs recorded by iecode (with process start time, so a reused PID is never killed).

Decisions 1 to 11 as amended below; amended text wins (decision 4 by R2, 6 by R1 and R14, 7 by R3, R4 and R16, 8 by R12, 10 by R7 to R9).

## Eng review amendments (2026-11-24)

Sources: the planner's code check (P) and an independent plan-review subagent (O, Claude Plan agent as fallback, Codex not installed). The user delegated every decision ("du entscheidest was sinnvoll ist"), so each row below is decided by the reviewer, not asked. Confidence 1 to 10; evidence is a static read of the named code unless noted.

| ID | Src | Plan / task | Finding (evidence) | Decision |
|---|---|---|---|---|
| R1 | P | B T2 | `CandidateProgIds` lists `VisualStudio.DTE.17.0` for 4026 (`XaeShell.cs:28`), so a plain VS 2022 install reads as TwinCAT 4026 and every unstamped build would stop (9) | Installed builds come from the `Components\Plc\Build_*` folders RepTool already uses (`RepTool.cs:35-37`; measured on this PC: 4024.10, 4024.47, 4024.66, 4026.28). New Core `TwinCatInstall.Builds(string twinCatDir)`; `TcLineGuard` always gets the list (never `null`), so the exact-build fallback is decided and tested in Core |
| R2 | P | A T3 | Exit 21 breaks the stability promise "Stable: scripts and the VS Code extension rely on them" (`Errors.cs:3`) (8) | Keep exit 10; add `staticAnalysisOnly` to each `builds[]` entry in JSON and the summary line. Deviates from the run's wish for an own code (spec Q6): the user can overrule this in review |
| R3 | P | B T5 | `--isolate` deletes the copy with its `<PLC>.tmc`; `ads symbols` and the extension read the `.tmc` next to the `.plcproj` (`cli/README.md` "ADS interface without a running PLC") (8) | After a build in the copy, copy every `*.tmc` of the solution's PLC projects back next to the original `.plcproj` (overwrite). Test `CopiesTmcBack` |
| R4 | P | B T5 | Copy folder per path hash: "An existing copy folder of the same hash is deleted first" deletes a concurrent run's copy (8) | Folder `<hash>-<pid>`; before creating, delete `<hash>-*` folders whose PID is not alive. Test `ConcurrentCopiesDoNotCollide` |
| R5 | P | B T5 | `MapsDiagnosticPathsBack` compares case-insensitively; Core tests also run on `ubuntu-26.04` (`.github/workflows/ci.yml:60`) (7) | Case-insensitive mapping on Windows only; the upper-case part of the test is guarded by `WindowsOnly.IsWindows` |
| R6 | P | D T2 | A cancelled dialog makes the blocked COM call throw; `Runner` reports it as "TwinCAT reported an error" (`Runner.cs:46-50`), so the dialog text never shows (7) | `XaeShell` converts a `COMException` into the dialog `IECodeException` when `DialogWatch.Cancelled` is set (one helper used by every shell call that can block) |
| R7 | O | D T2 | The hint says "Run with --visible --show-ui to see and answer it", but the policy cancels there too (8) | No Cancel when `Visible` or `ShowUi`; `DialogPolicy.Decide` gets a `bool userCanAnswer` |
| R8 | O | D T2 | "Any `#32770` for 10 s" also hits long progress windows; Yes/No boxes ignore `IDCANCEL` (7) | Act only on windows that are visible and own-disabled their owner (modal: `IsWindowVisible` and `!IsWindowEnabled(GetWindow(h, GW_OWNER))`); escalation: `IDCANCEL`, after 5 s more `WM_CLOSE`, after 5 s more mark the shell as hung, fail the command and terminate the shell process in `Dispose`. Tests for each step in `DialogPolicyTests` |
| R9 | O | D T3 | No check that the known activation dialog belongs to the shell process (6) | Manual step: `iecode activate` on a TwinCAT PC that triggers "Potential symbol type change detected"; if the dialog belongs to another process (e.g. the system service), keep the global title match for known titles only |
| R10 | O | D T3 | `shells kill` would end shells of concurrent live runs; `OwnerPid` unused (8) | Skip entries whose owner process is alive (PID and start time, stored as `OwnerStartedUtc`) unless `--force`; `list` shows the owner state |
| R11 | O | D T3 | Kill-on-close fires right after `Quit` returns while the shell still writes its settings (6) | `Dispose` waits up to 30 s for the shell process to exit before the job handle may close |
| R12 | O | C T1 | The lock covers the install call, but a shell that loaded the repository state at start can still write a stale copy (spec section 2 hypothesis) (6) | `lib save --install` and the other XAE installs save with `install: false` and install the file with RepTool (`RepTool.Install`, a fresh process) under the lock. Same for `lib save-all --install`, `ws build`, `ws release` |
| R13 | O | B T4 | Without `SaveAll` the dirty solution may prompt or save at `Dte.Quit()` (`XaeShell.cs:245`) (7) | With `save: false`, call `Solution.Close(false)` before `Quit`. The spike (B T1) also records whether files change at build time or at quit, and how long `Quit` takes |
| R14 | O | B T2 | Global `MixedLinesStop` in `StartShell` breaks `ws build` / `lib save-all` on mixed workspaces; a 4024-stamped project on a 4026-only PC would stop every `build` (8) | `TcLineGuard.Choose(..., bool saves)`: a line change stops only commands that write project files (`activate`, `lib save`, `lib save-all`, `encrypt`, `ws release`, and `build --save`); `build`, `check`, `clean` and `ws build` warn and continue. Mixed lines in `StartShell`: decided per solution when it is opened, not once for all |
| R15 | O | B T3, T5 | `Git.Run` throws exit 3 when git is missing (`Git.cs:109-112`); snapshot and `RootOf` would fail the build (8) | `WorkingTreeSnapshot.Take` returns null and `Isolation.RootOf` falls back to the solution folder when git is missing. Tests with a `PATH` without git are not portable; the catch is covered by a test that passes a non-existent git executable through an internal `Git.Executable` setting |
| R16 | O | B T4, T5 | A copy under `%TEMP%\iecode\b\...` can be longer than the original (6) | `--isolate-dir <dir>` (default `%TEMP%\iecode\b`); the long-path warning suggests `--isolate` only when `PathLength.Longest` of the planned copy is shorter |
| R17 | O | B T5 | `OutsideRoot` sees only `.sln`/`.tsproj`/`.plcproj` paths (`SolutionFile.cs:26-29` drops other projects and missing files) (7) | Scan every project path of the `.sln` (any extension, missing ones included), every `Include="…"` of each `.plcproj` and `File="…"` of each `.tsproj` / `.xti`; any path outside the root stops `--isolate` with the list |
| R18 | O | A T3 | `ws build` pre-flight warns about workspace libraries it installs itself (`WorkspaceCommands.cs:137-142`) (8) | Pre-flight skips references satisfied by a workspace link (`l.IsWorkspace`) |
| R19 | O | A T3 | One `--max-errors` counter for several builds; `Summarize` merges groups across solutions (7) | `Reporter.BeginBuild()` resets the printed count; `Summarize` gets the triage of one build only |
| R20 | P | A T3 | `--max-errors 50` cuts the logs the run grepped for `✖` (spec section 8) (6) | Default: 50 on a console, unlimited when stderr is redirected (`Console.IsErrorRedirected`) |
| R21 | O | A T1, T5 | On 4026 the Error List is readable (`XaeShell.Build.cs:86`), and the library manager lines written while opening may be missing from it (6) | Always also parse the Build pane for `.Library Manager` lines and merge them (dedupe by message); Task 5 adds a 4026 run |
| R22 | P | C T2 | `lib update` JSON switches between a value and an array (7) | Keep `library` / `version` (first item, unchanged for one item) and always add `items` |
| R23 | O | C T2 | `--vendor X --to V` pins independent libraries to one version (7) | Without `--lib`, `--vendor` is allowed only with `--to latest` (newest per library); otherwise exit 2 |
| R24 | P | C T4 | `SaveLibrary` is shared with `encrypt --compiled-library` (`ProjectCommands.cs:211`), whose help says "default: next to the solution" (8) | Both default to `dist/`; update the `encrypt --out` help and README row |
| R25 | O | all | CLI-only logic (exit aggregation, pre-flight skips, lock wiring) has no test (7) | New Core helpers: `BuildOutcome.ExitCode(IEnumerable<BuildResultInfo>)`, `Preflight.Problems(...)` (with R18), `TcLineGuard` with R1 |
| R26 | O | C T3, T4 | `uninstall --all` names and `*` resolution read a repository that may differ from the one RepTool uses with `--tc` (6) | `*` resolution and stray warnings use the same single repository as `lib outdated` (`RepositoryPath`), not the merged scan; `ScanAll` stays for "missing" only. `uninstall --all` prints the repository it read; known limit when both repositories exist |
| R27 | O | D T2 | `DialogWatch` logs from a background thread; `Reporter` is not thread-safe (`Reporter.cs:17`) (6) | `Reporter.Line` and `Add` take a lock |
| R28 | O | A T4 | `ExitCodes.HelpText` is a hand-synced copy (6) | Generate the help line from the constants by reflection, with a test that every constant has a description |
| R29 | O | D | Dialogs during `CreateInstance` are not watched (6) | Deferred: known limit (no PID before `CreateInstance` returns; watching every new shell process could touch another run's shell) |
| R30 | O | A T2 | `lib check` uses exit 3 for "no project" and "missing libraries" (5) | Keep exit 3 (both are "not found"); JSON `problems` tells them apart. No change |

Factual correction (no decision): decision 1 says the default repository differs between 4024 and 4026. On this PC with both lines, only `%ProgramData%\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries` exists (measured 2026-11-24), so both lines share it here; the merged scan stays because older installations keep `Components\Plc\Managed Libraries`.

## Eng review body (2026-11-24)

**Scope Challenge:** 23 planned changed files and 13 new classes cross the complexity gate. Structure decided by the reviewer under the user's delegation: original arrangement kept (one small, single-purpose Core class per decision, because the CLI has no test project and every decision must be testable in Core). No feature cut; `build --exclude-plc`, the 4024/4026 matrix, `ws build --parallel`, `lib project-folder sync`, `lib verify` and `iecode test` were already out of scope. Result: scope accepted as-is.

**Reality rows:**
- REALITY: premise-table pass 9 premises checked (SaveAll at cli/src/IECode.Automation/XaeShell.Build.cs:66, effective resolution at cli/src/IECode.Core/Projects/LibraryReference.cs:43, ProgID list at cli/src/IECode.Automation/XaeShell.cs:28, `Build_*` folders measured, single ProgramData repository measured, git throws at cli/src/IECode.Core/Git.cs:109-112, Core tests on ubuntu at .github/workflows/ci.yml:60, severity map has `info` at extension/src/commands/engineering.ts:14, stable exit codes at cli/src/IECode.Core/Errors.cs:3); unverified=2 (whether XAE saves on `SolutionBuild.Build` and at `Quit`: spike B T1; owner process of the activation dialog: R9)
- REALITY: already-done pass `origin/main` at 2bc4bff has no change to the named CLI files since the plan's base; no symbol of the plan exists yet
- REALITY: surface-check pass `iecode lib --help` lists no `check` (cli/src/IECode.Cli/Commands/LibraryCommands.cs:16); `--timeout` exists as a global option (cli/src/IECode.Cli/Globals.cs:24); no name clash for `--max-errors`, `--save`, `--isolate`, `shells`
- REALITY: binding-decisions pass no recorded decision on this branch (gstack-decision-search empty at 7cd01ac); the user's delegation is the only binding input
- REALITY: numbers pass every size is tagged `[estimated]` (docs/superpowers/plans/2026-11-24-cli-build-workflow-master-plan.md:33); the 20 libraries / 12 repositories come from the run (docs/research/cli-build-workflow.md:3)
- REALITY: deferred-asks pass no linked issue; the spec's deferred items are listed under "Not in this master plan" (docs/superpowers/plans/2026-11-24-cli-build-workflow-master-plan.md:35)
- REALITY: pr-count finding four stacked PRs instead of one per wave (docs/superpowers/plans/2026-11-24-cli-build-workflow-master-plan.md:50): each extra PR costs one review and one rebase of the PRs above it; accepted because one PR would be about 2500 changed lines `[estimated]`

**Architecture (build path after the plans):**

```
iecode build <sln> [--isolate] [--save]
  │
  ├─ Preflight.Problems ── LibraryRepository.ScanAll ──► warnings only (A, R18)
  ├─ PathLength.Longest ──► warning, suggest --isolate if the copy is shorter (B, R16)
  ├─ WorkingTreeSnapshot.Take (null without git / repo) (B, R15)
  ├─ [--isolate] Isolation.Create ── OutsideRoot check ──► stop exit 2 (B, R17)
  │
  ├─ Runner.WithShell
  │    ├─ TwinCatInstall.Builds + TcLineGuard.Choose(saves) ──► stop / warn (B, R1, R14)
  │    ├─ XaeShell.Start ── PID ── JobObject + ShellRegistry + DialogWatch (D)
  │    ├─ OpenSolution
  │    ├─ Build(save:false) ── Error List or Build pane + Library Manager merge (A, R21)
  │    │      └─ BuildTriage.Classify ──► Reporter.Add (limit, lock) (A, R19, R27)
  │    └─ Dispose: Close(false) ─ Quit ─ wait for exit ─ registry remove (B R13, D R11)
  │
  ├─ [--isolate] copy *.tmc back, map paths back, delete copy (B, R3, R5)
  ├─ Reporter.Summarize(triage) ── root causes, follow-ups, SA-only line (A)
  ├─ changed files (B)
  └─ BuildOutcome.ExitCode ──► 0 / 10 (A, R2, R25)
```

Two shapes: the alternative was one `BuildPipeline` class owning pre-flight, snapshot, isolation and triage. Rejected: it would be a shallow orchestrator over the same pieces and would put CLI wiring (options, reporter) into Core; the chosen shape keeps each decision in a small pure class and the order in `ProjectCommands.Build`. Red flags checked: hand-synced list (exit code help text, fixed by R28); two ways to install (XAE install and RepTool, unified by R12); split ownership of the shell lifetime (registry, job, watch all owned by `XaeShell.Start`/`Dispose`).

**Code quality:** findings R6, R13, R22 to R24, R27, R28 (table above). Shared code: `Restore.Plan` and `Restore.Check` share the pinned grouping (planned as a private helper, Plan A Task 2); no other extraction.

**Tests (coverage of the planned paths):**

```
CODE PATHS (Core, xUnit)                                   STATE
BuildTriage.Classify / Merge                               [★★★ planned] root, follow-up, noise, SA-only, merge (A T1, R21)
Restore.Check / Preflight.Problems                         [★★★ planned] pinned, *, case, repos, workspace links (A T2, R18)
Reporter limit / BeginBuild / Summarize / JSON             [★★★ planned] (A T3, R19, R20)
BuildOutcome.ExitCode                                      [★★  planned] (R25)
ExitCodes help text                                        [★★  planned] (R28)
TwinCatInstall.Builds / TcLineGuard.Choose                 [★★★ planned] stamp, fallback, mixed, saves, VS-only (B T2, R1, R14)
WorkingTreeSnapshot                                        [★★★ planned] new, dirty-again, no repo, no git (B T3, R15)
PathLength / Isolation                                     [★★★ planned] copy, exclude, tmc back, collide, outside root (B T4-5)
RepositoryLock                                             [★★★ planned] wait, timeout, abandoned (Windows) (C T1)
LibrarySelection / LibraryRepository.Stray                 [★★★ planned] (C T2-4, R23)
ShellRegistry / DialogPolicy                               [★★★ planned] (D T1-2, R7, R8, R10)
AUTOMATION / INTEROP (manual on a TwinCAT PC)
XaeShell.Build(save:false) + Close(false) at Quit          [GAP→manual] B T1 spike, B T6
DialogWatch + COMException mapping                         [GAP→manual] D T3 (R6, R9)
JobObject kill-on-close                                    [GAP→manual] D T3
RepTool install under the lock                             [GAP→manual] C T5
USER FLOWS
build with a missing library → root cause on top           [→E2E manual] A T5 (4024 and 4026)
build in VS Code (extension, --json)                       [★★ existing] engineering.ts consumes additive fields only
two parallel lib save --install                            [→E2E manual] C T5
```

**Performance:** `PathLength.Longest`, `ScanAll` and two `git status` runs add file system scans per build (tens of thousands of entries for a large repository `[estimated]`, well under the build time of minutes). `--isolate` copies the whole repository per run; known limit, no cache. No other finding.

**Failure modes:** shell hangs on a dialog that is not modal or not `#32770` (WPF): not detected, the timeout (`--timeout`, 1800 s) still ends it, error text then generic: covered by the existing timeout, not silent. Pre-flight against the wrong repository: warnings only, never blocks. RepTool install fails under the lock: exit 12 with the RepTool exit code (existing path). No silent failure without handling found: 0 critical gaps.

**Worktree parallelization:** Lane 1: A → B → D (shared `XaeShell.Build.cs`, `ProjectCommands.cs`, `Reporter.cs`). Lane 2: C after A's Task 2 (shared `LibraryCommands.cs`). Launch A; after A merges, run B and C in parallel worktrees; D after B.

**Implementation tasks:** the R entries are folded into the sub-plans' "Eng review amendments" blocks; no separate task list.

**Unresolved decisions:** none. Every finding was decided by the reviewer under the user's delegation; the user can overrule any R entry, most likely R2 (exit code stays 10).

**Completion summary**
- Step 0: Scope Challenge: scope accepted as-is
- Reality rows: 7/7 applicable rows emitted (PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=2 verdict=complete), 2 unverified premises
- Architecture Review: 5 issues found (R1, R3, R12, R14, R17)
- Code Quality Review: 8 issues found (R6, R13, R22, R23, R24, R26, R27, R28)
- Test Review: diagram produced, 4 gaps identified (all manual, on a TwinCAT PC)
- Performance Review: 0 issues found
- NOT in scope: written (master plan "Not in this master plan")
- What already exists: written (spec verdicts, `lib restore --dry-run`, `ws release`, `lib save -o`)
- TODOS.md updates: 0 items proposed (R29 recorded as known limit in Plan D)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: Codex not installed; native fallback (Claude Plan agent) completed within the 5-minute timer, 21 findings, folded into R7 to R30; no cross-model coverage yet (Copilot second opinion follows)
- Parallelization: 2 lanes, 1 parallel / 3 sequential
- Lake Score: N/A (no question asked; all decisions delegated)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native fallback (Claude Plan agent; Codex not installed) | Independent 2nd opinion | 1 | unavailable (native completed, issues_found) | 21 findings, all dispositioned (R7 to R30) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (mapped into plan amendments) | 17 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** Codex plan review unavailable (CLI not installed); native Claude Plan agent completed in time with 21 findings. Native results do not count as outside coverage.
- **VERDICT:** No review CLEAR; findings are folded into the plans as R1 to R30. Eng review required before implementation is satisfied in substance, the status stays ISSUES OPEN by definition (issues_found > 0).

NO UNRESOLVED DECISIONS
