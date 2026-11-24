# CLI Build Workflow Master Plan (2026-11-24)

> **Status: master plan, not yet reviewed.** The sub-plans A to D are TDD plans. Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Branch: `plan/cli-build-workflow` for the plans; implementation on `feature/cli-build-workflow` from `origin/main` after the docs pull request #69 is merged.

**Goal:** Make `iecode build` and the library commands cheap to run on many repositories: find missing libraries before a build, show the root cause first, leave the working tree alone, refuse silent TwinCAT line changes, and make library repository writes and the hidden XAE shell safe.

**Architecture:** Decisions live in `IECode.Core` (pure, xUnit-tested on any OS); `IECode.Cli` commands and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`, so a command adds no logic that a Core test does not cover. JSON output changes are additive (new optional fields, no renamed ones); new exit codes get a row in the README table.

**Tech Stack:** C# .NET (xUnit), System.CommandLine, COM late binding to the XAE shell, Win32 P/Invoke (Plan D only).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) (findings, verdicts, answered questions Q1 to Q9) and the section "CLI: build and library workflow at scale" in [TODO.md](../../../TODO.md).

## Global Constraints

- Public repository: no internal names, paths or data in code, tests, fixtures, docs or commits. Test fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example` (as the existing `BuildOutputTests`).
- Commits: English subject plus a 1-3 sentence why-body, author and `Signed-off-by` with the GitHub noreply address (`git commit -s`). Cosmetic changes in separate commits.
- C# build and tests only through the PowerShell tool, `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel. A running `iecode mcp` locks `cli/src/IECode.Cli/bin`; stop it first.
- Test command (all tasks): `dotnet test --project cli/tests/IECode.Core.Tests` (filter with `--filter-class` / `--filter-method` per step). Expected: all green, no skipped test that was green before.
- Existing JSON fields and existing exit codes keep their meaning. New exit code: `21` = build failed only on static analysis (Plan A).
- Every user-visible change gets a line under `## Unreleased` in `extension/CHANGELOG.md` (the CLI ships with the extension) and, for new options or commands, a row in `cli/README.md`.
- The VS Code extension calls `iecode build --json` (`extension/src/commands/engineering.ts`) with `--tc` only when `iecode.tcVersion` is not `auto`. Every plan names what the extension sees.

## Sub-plans

| Plan | Items (TODO.md) | Needs TwinCAT to verify | Size `[estimated]` |
|---|---|---|---|
| [A](2026-11-24-cli-build-workflow-a-failure-output.md) | pre-flight `lib check`, root causes first, `--max-errors`, static-analysis exit code, generic last error, exit codes in `--help` | no (one manual look at a real log) | 1 day |
| [B](2026-11-24-cli-build-workflow-b-side-effect-free-build.md) | save spike, `build` without `SaveAll`, `--tc auto` guard, changed files, long-path warning, `--isolate` | yes (spike and final check) | 1.5 to 2 days |
| [C](2026-11-24-cli-build-workflow-c-library-repository.md) | repository lock, `lib update` for several libraries, `lib uninstall --all`, `lib installed` filters, `lib save` to `dist/`, resolved `*` and stray versions | no (one manual parallel install) | 1 day |
| [D](2026-11-24-cli-build-workflow-d-shell-robustness.md) | modal dialog watcher, shell registry, job object, `iecode shells list / kill` | yes | 1 day plus 1 h on a TwinCAT PC |

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
