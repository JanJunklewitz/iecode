# CLI: build and library workflow at scale

Feedback from one real run: about 20 libraries and 12 PLC repositories were built, saved, installed and re-pinned with
`iecode` under TwinCAT 4024.66 (`TwinCAT RT (x64)`), partly in parallel, as preparation for a move to 4026.
Each item below was checked against the CLI code (state of 0.2.23, 2026-11-24). Verdicts:

- **Confirmed**: the code explains the behaviour.
- **Exists**: the command or option is already there; the gap is that it was not found (docs, naming, `--help`).
- **Partly**: something close exists; the rest is a real gap.
- **Open**: plausible, but the code does not prove the cause; needs a reproduction.

The open questions are collected at the end; they decide the scope of several items.

## Summary

| # | Topic | Verdict | Effort | Proposal |
|---|---|---|---|---|
| 1a | `build` writes the solution and projects | Confirmed (`SaveAll`); whether it is the only source is open (Q1) | small | `build --no-save` (skip `SaveAll`) |
| 1b | Build output (`_Libraries`, external resources) dirties the tree | Confirmed (by design of XAE) | medium | `build --isolate` (build in a temp copy, including ignored files, Q2) |
| 1c | `--tc auto` opened projects in 4026; 4024 could no longer open them | Confirmed | small | stop with exit 2 when `auto` would change the line (Q3) |
| 1d | Report what the build changed | Gap | small | `changed files: N` after a build in a git tree |
| 2 | A library install was lost (parallel run or a bulk uninstall) | Open (Q4) | small (mutex) / medium (verify) | named mutex around installs; `lib verify` after a reproduction |
| 3a | Root cause hidden under hundreds of follow-up errors | Confirmed | small | print library manager errors first, then grouped counts |
| 3b | Pre-flight check of references | Exists (`lib restore --dry-run`, also covers `PlaceholderResolution`, Q9) | small | run it before `build`, hint after a failure, `lib check` alias; also `*` without any installed version |
| 4 | Static analysis fails `build`, `lib save` passes | Confirmed (different code path) | small | clear message and own exit code for `SAxxxx`; no switch (Q6) |
| 5a | Hidden modal dialog blocks a build | Confirmed (no watcher during build) | medium | detect modal dialogs during build, fail with their text |
| 5b | Long paths | Gap | small | warn above ~200 characters, suggest `--isolate` |
| 5c | Orphaned `TcXaeShell` processes | Confirmed | medium | track started shells; `iecode shells list/kill`; job object |
| 6 | Missing commands | mixed | see section 6 | |
| 7 | Smaller items | mixed | small each | see section 7 |

## 1. Builds change the repository

**1a, confirmed.** `XaeShell.Build()` calls `SaveAll()` before every build
([XaeShell.Build.cs](../../cli/src/IECode.Automation/XaeShell.Build.cs), `SaveAll()` in
[XaeShell.cs](../../cli/src/IECode.Automation/XaeShell.cs)): `Solution.SaveAs(<same path>)` plus `project.Save()` for
every TwinCAT project. `activate` does the same. In a fresh CLI shell nothing is pending except what XAE itself changed
while loading, so this save is exactly what writes the `.sln` configuration lines, `Target64Bit` in `.tspproj` and the
`DevId` of the visualization manager. The comment says the save "picks up pending changes before build/activate"; that
only matters when a command changed something in the shell first (`encrypt`, `--configuration`).

Proposal: `build --no-save` (or make no-save the default for `build` and `check` and keep the save for `activate`,
see Q1). Caveat: XAE may still save dirty documents on `SolutionBuild.Build` ("save all changes before building" is a
VS option); test whether the noise is gone with the explicit save removed.

**1b, confirmed by design.** `_Libraries` cache folders and generated external resources come from the compile itself,
not from the save. `--no-save` will not remove them. Only building somewhere else does:

- `build --isolate`: copy the solution's repository to a short temp path (`%TEMP%\iecode\b\<hash>`), build there,
  copy back nothing but the result data (diagnostics, `.tmc` if asked), delete the copy.
- Source of the copy: the folder as it is, including untracked **and ignored** files. In the run `git archive HEAD`
  failed once because a git-ignored folder of generated files was needed (Q2). Leave out only known build outputs.
- Solves 5b (long paths) on the way.

**1c, confirmed.** `--tc auto` resolves in `Runner.WithShell`: the version the first TwinCAT project was saved with,
if installed; else the shell default. When no project carries a version, `XaeShell.CandidateProgIds` tries
`TcXaeShell.DTE.17.0` (4026) first. On a PC with both lines a project without a stamp therefore opens in 4026 and is
upgraded on save. In the run this made three projects unreadable for the 4024 shell (Q3). Proposal: when `auto`
would open a project in another line than its stamp, or there is no stamp and both lines are installed, stop with
exit 2 and ask for `--tc`; with `--no-save` the upgrade would not be written anyway.

**1d.** After a build in a git working tree, print `changed files: N` (`git status --porcelain` before / after) and
list them with `-v`. A `--restore` that reverts "noise only" files needs the noise rules of the config diff; leave it
for later.

## 2. Parallel library installs

`lib save --install` does not use RepTool: it calls the Automation Interface `SaveAsLibrary(file, install: true)`
inside the XAE shell ([XaeShell.Plc.cs](../../cli/src/IECode.Automation/XaeShell.Plc.cs)). Several shells installing at
the same time each work on the same library repository; there is no lock in iecode (no `Mutex` anywhere in the CLI).
The observed result (files present, `lib installed` lists the version, but the library manager reports "not installed"
until uninstall + install) fits a repository index that one shell overwrote with its stale copy. Not proven.

Proposals:
- A named mutex (`Global\iecode-library-repository`) around every operation that writes the repository: `lib save
  --install`, `lib save-all --install`, `lib install`, `lib install-project`, `lib restore`, `lib uninstall`,
  `ws build`, `ws release`. Small and safe; it only serialises the install step, not the build.
- `lib verify <name> <version>`: a scan of the folder is not enough (that is what `lib installed` does and it said
  "installed"). A real check has to ask TwinCAT, e.g. RepTool or the library manager of an open shell. See Q4.

## 3. Root causes buried in follow-up errors

**3a, confirmed.** `BuildOutput.Parse` already recognises `<PLC>.Library Manager` origins and assigns them to the PLC
project ([Diagnostics.cs](../../cli/src/IECode.Core/Diagnostics.cs)), but `Reporter.Add` prints every diagnostic in
arrival order and nothing marks library manager messages.

Proposal:
1. Mark diagnostics from the library manager (new `Diagnostic.Source = LibraryManager`).
2. At the end of a failed build print a short block "Root causes": every library manager error (not installed, no
   license, version missing), then "N follow-up errors" grouped by object or library.
3. `--max-errors N` (default maybe 50 on a terminal, unlimited with `--json`): print the first N, count the rest.

**3b, partly exists.** `iecode lib restore <paths> --dry-run` lists every *pinned* reference whose version is not in
the library repository and exits with 3 when one cannot be found, without TwinCAT. It would have found the four missing
Beckhoff versions in a second. Gaps:
- It is not discoverable as a "check" (the name says restore). A `lib check` alias or a line in the `build` failure
  hint ("run `iecode lib restore --dry-run` to find missing libraries") would help.
- `*` references are skipped (`Restore.Plan` uses `IsPinned` only); a `*` reference with no installed version at all is
  also a missing library.
- Run it automatically before `build` (cheap, file based) and warn.

## 4. Static analysis blocks `build`, not `lib save`

`build` runs the full solution build; if static analysis runs automatically on build (project setting), `SAxxxx`
findings arrive as errors and the build fails with exit 10. `lib save` goes through `SaveAsLibrary`, a different path
that does not run it. Both are "right" for their purpose; the confusing part is that the output does not say so.

Proposals:
- When all errors carry an `SA` code, say "build failed only on static analysis (N findings, rules SA0027 …)" and use
  a distinct exit code (new code, e.g. 21) so scripts can tell it apart.
- No `--no-static-analysis` switch: the clear message was enough in the run, the finding was fixed in the code (Q6).

## 5. Hidden shells, dialogs, long paths

- **Modal dialogs**: the shell runs with `SuppressUI` and the silent mode of the automation settings, yet a "Save As"
  dialog appeared. `DialogConfirmer` already watches for one known dialog title during `activate`
  ([Interop/DialogConfirmer.cs](../../cli/src/IECode.Automation/Interop/DialogConfirmer.cs)). The same loop can run during
  open, build and save: any modal window of the shell process that stays for more than a few seconds ends the command
  with its title and text (exit 1, hint `--visible`).
- **Long paths**: warn when the solution path plus the deepest object path is over ~200 characters; suggest `--isolate`.
- **Orphaned shells**: `Dispose` quits the shell, but a killed `iecode` leaves it running. The shell is a COM
  out-of-process server, not a child process. Proposal: record the PID of the shell started by iecode (new process
  after `CreateInstance`) in `%LOCALAPPDATA%\iecode\shells\`, put it into a job object with
  `KILL_ON_JOB_CLOSE`, and offer `iecode shells list | kill` for the recorded PIDs only.

## 6. Missing commands

| Need | What exists | Gap / proposal | Effort |
|---|---|---|---|
| Pin references of a project to versions | `lib update <paths> --lib X --to V [--vendor] [--dry-run]` (one library per call) | allow several: `--lib A=1.2.0.0 --lib B=*`, and `--vendor X --to V` without `--lib` for all of a vendor | small |
| Raise `ProjectVersion` of a library | `ws release <lib> --bump patch --no-save` (any OS) | document it; maybe `lib version set|bump` as a plain alias that needs no workspace | small |
| Remove one version of many libraries | `lib uninstall <names…> --vendor V --version X` | allow no names with `--all`: take the names from the repository scan for vendor + version | small |
| Build many repositories in waves | `ws build` (dependency order, one shell, sequential) | `--parallel N` only together with isolation (1b) and the repository mutex (2) | large |
| Build without the test project | `check` runs "check all objects" on every PLC | `build --exclude-plc <name>` / `--no-tests` (Q7); depends on what the Automation Interface offers | medium |
| Sync tracked `_Libraries` with the resolutions | `lib install-project` (the other direction) | `lib project-folder sync [--prune]`: copy the referenced versions from the repository, drop the others | medium |
| Run `Tc3_PlcTestFramework` tests | nothing | `iecode test <sln>`: activate on the local runtime, read the test controller result over ADS, print per test case. Builds on the ADS stack | large |
| Build for 4024 and 4026 | two runs | `--tc 4024,4026` runs the build once per line and prints a table; needs `--isolate` because each line saves differently | medium |

## 7. Smaller items

| Item | Verdict | Proposal |
|---|---|---|
| Mixed German / English messages | Confirmed: the parser already handles both languages | no language override (Q8); mark library manager diagnostics in `--json` instead |
| Last error "Der Vorgang konnte nicht abgeschlossen werden. Unbekannter Fehler" counted | Confirmed: `BuildOutput.Bare()` matches `Fehler: …` / `Error: …` | treat this generic line as info, not as an error, and do not count it |
| `lib save` writes into the project folder | **Exists**: `lib save -o <dir>` | default to `dist/` like `save-all` (Q5), with a CHANGELOG note |
| Exit codes not in `--help` | Partly: table in [cli/README.md](../../cli/README.md#exit-codes) | add the table to the root `--help` text |
| `lib installed` filters | Partly: `--lib <exact name>`, global `--json` | wildcards for `--lib` (`Tc3_*`), `--vendor` |
| Show what a `*` reference resolves to | Gap: `info` prints only the count, `lib list` prints `newest (*)` | resolve `*` against the repository scan in `lib list` and `info`: `* → 1.5.2.0` |
| Warn when `*` resolves to a suspicious version | Open: "release notes" are a project convention | generic rule instead: warn when the newest installed version is far above the second newest (e.g. a stray `10.0.0.0` dev build) |

## What worked well (keep)

- `--tc 4024` with `-p "TwinCAT RT (x64)"` is predictable.
- `lib save --install` skips the full solution build, which makes libraries with self-pinning test projects possible.
- The `[library, version]` suffix on compile errors (written by TwinCAT) makes the broken library easy to find.
- `build -v --no-color` logs are easy to filter with `grep "✖"`.

## Open questions and answers (2026-11-24)

The person who did the run answered these questions. "Unknown" means it was not recorded.

1. **Where does the save noise come from?** Unknown. Only `build` and `lib save` were used, never `check`, and no build
   ran without `SaveAll()`. Next step: build one affected solution twice, once as today and once with `SaveAll()` removed,
   and compare `git status`.

   **Spike (2026-11-24, TwinCAT 4024.66, `--tc 4024`, throwaway copies, clean `git status` before each run):**

   | Run | Small PLC-only solution | Module solution with an external-resources helper project (two `.tspproj`) |
   |---|---|---|
   | `build` as today (`SaveAll()`) | `.tmc` and `.xti` (`TmcHash`, `TmcPath`) | both `.tspproj` gain `Target64Bit="true"` |
   | `build` without `SaveAll()` | same two files, written during the build | one `.tspproj` written during the build, the other one at `Quit` |
   | as above plus `Solution.Close(false)` before `Quit` | not run | only the `.tspproj` written during the build |
   | `check` | not run | nothing changed |

   `Quit` returned in under 0.1 s every time. Conclusions: XAE saves a project it made dirty itself before building
   (the "save all changes before build" behaviour), so removing `SaveAll()` does not remove the `.tspproj` noise;
   `Solution.Close(false)` removes the part written at `Quit`. `.tmc` / `.xti` hash changes are build output. Decision
   (plan B decision rule): `build --no-save` is an option, the default keeps saving, and `--isolate` is the answer to a
   clean tree. Not tested: switching off the shell's save-before-build option, because each build of the module
   solution runs its after-compile batch file, which outside its usual folder layout waits for a key press and asks
   for elevation (a side effect a hidden build cannot answer; see section 5).
2. **Isolation source.** Mostly `git archive HEAD`; twice the working tree (tracked plus untracked) because a fix was
   not committed yet. In one PLC project `HEAD` was **not enough**: a folder of generated, git-ignored files was missing,
   and the build failed with `Unknown type` errors until that folder was copied from the original. Consequence:
   `--isolate` copies the folder as it is (tracked, untracked and ignored), and leaves out only known build outputs
   (`_CompileInfo`, `_Boot`, `.vs`, `*.tmc`?). A `--from-head` variant can come later.
3. **`--tc auto`.** The stamp and the chosen shell were not recorded. Observed: after a `build` without `--tc`, three
   projects were saved by 4026, and the 4024 shell could no longer open them ("unknown error" / "not compatible").
   This is the most expensive side effect in the list. Proposal: if `auto` would open a project in a different line
   than its stamp, or there is no stamp and both lines are installed, stop with exit 2 and ask for `--tc`. Do not just
   warn. Together with `--no-save` the project is never rewritten.
4. **Parallel install.** All three ran with `--tc 4024`, three shells, each on its own copy. Before and after the
   reinstall the same four files existed (`.library` with the same size, `browsercache`, `dependencies`,
   `projectinfo`), only with new timestamps. RepTool reported no error, `lib installed` listed the version,
   `lib save --install` said "installed". The error only came in a later build. **Alternative hypothesis:** between
   the installs the old versions of 20 libraries were uninstalled in one call, so the cause can also be that
   uninstall, not the parallel installs. The mutex stays (cheap). `lib verify` waits until the problem is reproduced.
5. **`lib save` output.** `-o` was not known. A git-ignored default folder such as `dist/` (as `save-all` does) is
   preferred. This changes the default behaviour, so it needs a CHANGELOG note.
6. **Static analysis.** Unknown whether the project setting caused it. The fix was in the code (duplicate object
   removed). A clear message plus its own exit code is enough; **no `--no-static-analysis` switch**.
7. **`build --plc`.** The real need is "build without the test project". A library solution holds the library PLC
   project and a test PLC project (folder `*.Test` / `UnitTest`, project often just named `PLC`), and the test project
   pins the version that is just being built. An application solution has one PLC project plus a small helper project
   for external resources (ERC). Proposal: `build --exclude-plc <name>` (repeatable), and maybe a `--no-tests` that
   skips PLC projects in `*.Test` / `UnitTest` folders. Open: whether the Automation Interface can build one PLC
   project without the others, or whether the excluded ones have to be unloaded from the solution for the run.
8. **Language.** Not worth a different shell UI language: filtering by `✖` and `Library Manager` worked. Fixed codes in
   `--json` are more useful. `--json` already carries `code` per diagnostic; add a field that marks library
   manager diagnostics (see 3a).
9. **`lib restore --dry-run`.** Not known and never run. The missing Beckhoff versions were fixed versions in
   `<PlaceholderResolution>` with `*` as the default resolution. The code takes the `PlaceholderResolution` as the
   effective version (`LibraryReference.Effective`), so **the command would have found them**. This confirms 3b:
   the check exists, but nobody can find it.

**What would save the most time next run** (from the answers):
1. Pre-flight check of the pinned versions against the installed ones, before the build (3b): several build runs per
   repository were lost.
2. Error summary with the root cause first: library manager errors on top, follow-up errors counted per
   `[library, version]` (3a).
3. A build without side effects in the repository (`--no-save` or `--isolate`) with a list of the changed files at the end
   (1a, 1b, 1d).
