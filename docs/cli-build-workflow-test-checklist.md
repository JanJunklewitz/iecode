# CLI build workflow: checklist for a real TwinCAT PC

What the unit tests could not cover (background: [open-tests.md](open-tests.md), plans: [master plan](superpowers/plans/2026-11-24-cli-build-workflow-master-plan.md)).
Run it on a PC with TwinCAT XAE, best with both lines (4024 and 4026) and a small test solution with one library project and one application project that references it.
Order: riskiest first. Tick a box only when you saw the expected result. Write what you saw next to every failed box.

Prepare once:

- [ ] Build the CLI from this branch and put it on `PATH`; `iecode --version` shows the branch build.
- [ ] `iecode doctor` is green; note the installed TwinCAT builds (`iecode info --installed`).
- [ ] Copy the test solution to a short path and commit it, so `git status` shows what a build changes.
- [ ] `iecode shells list` is empty (end leftovers with `iecode shells kill`).

## 1. Shell ownership and job (D, risk: high)

- [ ] Run `iecode build <sln> --tc 4026 -v`. Verbose output says the shell was proven as the COM server (no "not proven" warning).
- [ ] While the build runs, `iecode shells list` in a second console shows exactly one shell with the right solution and "owner running".
- [ ] Start a long build (`--timeout 600`), kill the `iecode` process in Task Manager. The XAE shell ends within a few seconds (job object). `shells list` is empty afterwards.
- [ ] Start Visual Studio / XAE by hand right before an `iecode build` starts. The hand-started window is still open after the build ends.
- [ ] Same three checks with `--tc 4024`.
- [ ] If the proof fails on your PC (verbose warning): note the TwinCAT build and the ROT entry names; the shell then runs without watcher and job, which is worse than before.
- [ ] Start a hand-opened XAE right before `iecode build -v`, so the new process is not the COM server: the verbose line reads "is not the COM server behind this shell (served by PID …)".
- [ ] A shell that does not take `Quit` (end the command while a dialog is open): the exit message names 5 s, not 30 s; after a normal close it names 30 s.
- [ ] Stale record that cannot be removed: end an `iecode build` and its shell hard (Task Manager, both processes), so the record in `%LOCALAPPDATA%\iecode\shells` stays. Hold that `.json` open from PowerShell (`$f = [IO.File]::Open('<record>.json', 'Open', 'Read', 'None')`), then run `iecode shells list -v` and `iecode shells kill -v`. Both finish (no exit 99), `-v` says the record was not removed. After `$f.Close()` the next `shells list` removes it.

## 2. Dialog handling (D)

- [ ] Open a project whose activation raises a modal dialog the CLI does not know (or hold one open from a script). `iecode activate` fails after about 10 s with the dialog title instead of hanging.
- [ ] Provoke the "possible symbol type change" dialog if you can (change the type of a linked variable on one side and activate on a real target). It is confirmed with OK and the links stay. German 4026 title: "Mögliche Typänderung des Symbols erkannt".
- [ ] Same dialog in a shell iecode could not tell apart (the warning "could not be told apart from other shells" at start; provoke it by starting two `iecode activate` at the same moment, or with a hand-opened XAE as in section 1). The dialog is still confirmed with OK and `activate` does not hang. If `-v` says "The shell serving this activation could not be told", note the TwinCAT build.
- [ ] An activation that shows a dialog from a TwinCAT helper process does not hang.
- [ ] A dialog during shutdown (`Quit`) makes the command fail instead of exiting 0.
- [ ] `CoCancelCall`: a dialog blocks a DTE call; the command ends within the timeout, not after 30 minutes.

## 3. Library repository and RepTool (C)

- [ ] `iecode lib save <lib.sln> --install -v` installs the library; the file ends up in `dist/` and in the repository; no `.iecode-*` folder is left in `dist/`.
- [ ] While the export runs, a hidden `.iecode-<guid>` folder exists next to the target and RepTool installed from there (verbose output names the path).
- [ ] Locked target: hold the existing `dist/<lib>.library` open from PowerShell (`$f = [IO.File]::Open('<file>', 'Open', 'Read', 'None')`), then run `iecode lib save <lib.sln> --install`. Exit 12. The message names the kept `.iecode-*\<lib>.library`, that file is still there, and the library is installed. After `$f.Close()` move the kept file over the final name by hand and delete the `.iecode-*` folder.
- [ ] `iecode lib save-all --json` where the last project stops on an unknown dialog: the error appears once (on the item), and `shutdownError` stays empty.
- [ ] `iecode lib save-all --fail-fast --json` where the first project fails: the JSON has `error` (and `hint`, if there is one) set, besides `results` and `notStarted`.
- [ ] Two `lib save --install` of the same library in two consoles: the second waits for the first, both end with exit 0, the repository has the library once.
- [ ] Kill `iecode` while RepTool runs: RepTool ends too (job), the next install starts without "writer" errors.
- [ ] On a PC with both lines: `iecode lib uninstall --all --vendor <vendor> --version <ver> --tc 4026` lists the libraries of the 4026 repository (`ProgramData`), deletes only there, and the 4024 repository (`TWINCAT3DIR\Components\Plc\Managed Libraries`) is untouched. Repeat with `--tc 4024`.
- [ ] `--repository` that does not match the RepTool target is refused with a usage error.
- [ ] After a Remote Manager fallback to another build of a line (a build is listed but cannot be selected), the library is installed with the build XAE selected (`-v` shows it).

## 4. Build without side effects (B)

- [ ] `iecode build <sln> --no-save` leaves `git status` clean; plain `iecode build` lists the changed files (`changedFiles` in `--json`).
- [ ] `--tc auto` on a project saved with 4024 never opens it with 4026 (exit 2, asks for `--tc`).
- [ ] `--tc auto` when the Remote Manager knows neither the stamped build nor its line (e.g. a project stamped with a line that is installed as a folder but not registered in the Remote Manager, or a PC without `Build_*` folders): `iecode check` warns "Using the shell's default version; this command does not save" and goes on; `iecode build` (saves) fails with exit 15.
- [ ] `iecode build <sln> --isolate`: working tree clean afterwards, the temp copy is removed; with `--keep-isolated` it stays and is never removed by the next run.
- [ ] `--isolate` on a solution with a helper `.csproj` is refused with the reason.
- [ ] `--isolate --copy-tmc`: only a changed `.tmc` is copied back after a successful build; after a failed build nothing is copied and a warning says so.
- [ ] Build that times out (`--timeout 5`): the JSON error result still carries `changedFiles`.
- [ ] Half-failed open (a solution with a missing referenced project): the shell ends without saving; `git status` is clean. If discarding fails, a warning appears and the shell is ended by process, not by `Quit`.
- [ ] `ws release <lib> --bump patch` on a PC without the required TwinCAT build fails before the version in the project file changed.

## 5. Failure output (A)

- [ ] `iecode lib check` finds a pinned library that is not installed and a `*` reference without any installed version; exit code is not 0.
- [ ] A build that fails because of that library prints a "Root causes" block first; `--max-errors 5` shortens the rest, root causes stay.
- [ ] Error List: on both lines check whether it is readable now ("Specified cast is not valid" was seen on 4024.66 and 4026.28). If it is readable, `check` and `build` show each compiler error with file and line and two equal messages in different POUs both appear.
- [ ] `iecode check` on a project with a failure shown only in the build pane returns a non-zero exit code.
- [ ] A build whose errors are all static analysis findings says so and uses its own exit code; in VS Code the popup says so only when every failed platform is such a case.
- [ ] `ws build <folder>` with a library that is used by a later solution: the library is installed before that solution builds (no "not installed" warning for it).

## Result

- [ ] All boxes ticked, or every failed box has a note and a TODO entry.
- [ ] `docs/open-tests.md`, section "CLI build workflow", updated (tick or move the failed items).
