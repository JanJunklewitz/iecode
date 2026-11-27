# Plan F: `--tc 4024,4026` Build Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode build <sln> --tc 4024,4026` (and `iecode check`) runs once per TwinCAT version, each in a fresh isolated copy, and prints one table (line, build used, errors, warnings, root causes, exit) plus an additive JSON `matrix[]`.

**Architecture:** Parsing, option rules, the install pre-check, the matrix loop (`TcMatrix.Run`), the exit-code aggregation and the table live in a new pure `IECode.Core/TcMatrix.cs`. `Context` (in `Globals.cs`) learns a per-run version override, so the existing `Runner.WithShell` / `TcLineGuard` path is reused unchanged for each entry. `ProjectCommands.Build` / `Check` hand one entry's work to `TcMatrix.Run` and always build in an `Isolation` copy, so no line ever writes the original tree.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, COM late binding (unchanged).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 1c, section 6 last row, Q3; TODO.md "CLI: build and library workflow at scale" (`--tc 4024,4026` matrix).

**Review changes (master plan decision ledger):** R2: Task 1 header (session A, gates only this plan). R3: not applicable (F creates none of the shared files), see Touches. R4: Task 4b Step 8, Task 5 Step 3, Task 6, Self-review notes (about 0.5 day PC check). R15: Known limits, Task 4b Step 7 (README, CHANGELOG), Premise 18. R20: Decision 7, Task 3 (`ImpliesIsolate`), Task 4b Step 1, Premise 17. R21: Review Focus 4, Task 3 (no Ctrl+C test). R22: Task 3 (`TcMatrix.Run`), Task 4 split into 4a and 4b. R23: Decision 3, Task 3 (`RejectList`), Task 4b Step 2. R24: Task 3 (`DialogError`), Task 4b Step 4. R25: Task 2 and Task 3 tests. R26: Decision 8, Task 3 (`MatrixRun.TwinCat`, `ErrorSummary`), Task 4b Step 5. R27: Task 4b Step 3 (`PrepareIsolated`), Task 5, README. R28: Decision 6, Task 3 exit-code tests. R29: Task 1 Step 4 note, Task 4a/4b `buildAll`, Task 5, Task 6. R30: Decision 5, Premises 5, 15, Task 1 Step 3.

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`. Windows-only tests are guarded (`WindowsOnly` helper).
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands.
- JSON output changes are additive; existing exit codes keep their meaning; this plan adds **no** new exit code.
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`; new options/behaviour a row or row change in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s`.
- All sizes tagged `[estimated]`.
- Steps that need a TwinCAT PC (4024 and 4026 installed) are marked manual and kept short and exact.
- Plan-specific: a single `--tc` value (`4024`, `4026.28`, `auto`) behaves byte-for-byte as before (output, JSON, exit code). The VS Code extension never sends a list and needs no code change.
- Plan-specific: a matrix run never writes the original working tree: every entry builds in its own fresh `Isolation.Create` copy with `saves: false`.

## Premises checked (`main` at `f817efe`)

1. `--tc` is a global recursive `Option<string>`, default `"auto"`: `cli/src/IECode.Cli/Globals.cs:15-20`.
2. The only reader is `Context.Version => TwinCatVersion.Parse(Parse.GetValue(Globals.Tc))`: `Globals.cs:46`; `Context` is a `sealed record`, so `with { … }` works: `Globals.cs:44`. Users of `ctx.Version`: `Runner.cs:128,232,269`, `ProjectCommands.cs:46,342`, `LibraryCommands.cs:429,455,499,537,551`, `DoctorCommand.cs:31`.
3. `TwinCatVersion.Parse("4024,4026")` throws `IECodeException(Usage, "Invalid TwinCAT version …")` today (regex `^(?:3\.1\.)?\d{4}(?:\.\d+)?$`): `TwinCatVersion.cs:18-30`. A command rejects a list this way only when it reads `ctx.Version` (`ProjectCommands.cs:46,342` and the `LibraryCommands` / `DoctorCommand` readers of Premise 2); a command that never reads the version (for example `clean`) ignores `--tc` today and would silently accept a list. So the plan adds one central check (Decision 3) and improves the message.
4. An explicit version is never second-guessed: `TcLineGuard.Choose` returns it with no note: `TcLineGuard.cs:48`. The exact-build fallback in `Runner.SelectVersion` applies only to `auto`: `Runner.cs:232`.
5. `TwinCatInstall.Builds(string?)` lists installed builds oldest first, empty when unknown: `TcLineGuard.cs:109-123`; `RepTool.TwinCatDir` is its input: `Runner.cs:128`. It lists only `Components\Plc\Build_*` folders that contain `Common\RepTool.exe` (`TcLineGuard.cs:114-118`), so it is a hint, not the complete set of lines XAE can select (a mixed install layout can hide one).
6. `build --isolate`: `OutsideRoot` check, `Isolation.Create`, `MapDiagnostic = d => Isolation.MapBack(d, copy)`, `WithShell(ctx, copy.Solution, saves: false, …)`, `TryDelete(15 s)` in `finally`: `ProjectCommands.cs:126-166`. Without `--isolate`, build counts as saving (`saves: true`, with `beforeOpen` and `Reporter.PartialData` for the changed-files report): `ProjectCommands.cs:115-124`. `OutsideRoot` now also refuses projects of an unsupported type (only `.plcproj`, `.tsproj`, `.tspproj` are accepted in a copy): `ProjectCommands.cs:128-131`.
7. The copy folder is `<hash>-<pid>` (`Isolation.cs:81-85`), but `Create` no longer deletes it: `Allocate` claims the first free `<hash>-<pid>`, `<hash>-<pid>-2`, … with a marker file (`Isolation.cs:177-199,252-270`). One process can therefore hold several copies at once; a kept copy of one entry does not block the next.
8. `BuildOutcome.ExitCode(IEnumerable<bool>)` gives 0 or 10: `BuildTriage.cs:33`. Exit codes: `Usage = 2`, `BuildFailed = 10`, `VersionNotInstalled = 15`, `Cancelled = 130`: `Errors.cs:8-21`.
9. `Reporter.TwinCatVersion` (JSON `twinCat`) is set by `XaeShell.SelectVersion` together with the new `XaeShell.SelectedVersion`: `XaeShell.cs:43,354-355`, `Reporter.cs:29,158`. `TwinCatVersion.UsedBy(string? selected, TwinCatVersion requested)` turns it into a version: `TwinCatVersion.cs:90`. `Reporter.PartialData` is written as `data` of an error result: `Reporter.cs:147,159`. `Reporter.MapDiagnostic` is applied to every recorded diagnostic, also root causes: `Reporter.cs:65-67,107,111`. `Reporter.Diagnostics` is the flat list: `Reporter.cs:30`. `Reporter.TwinCatVersion` has a public setter (`Reporter.cs:29`) and keeps the value of the last shell start, so a later entry that never starts a shell would leave the previous entry's line in it; the matrix sets it explicitly (Decision 8).
10. `Diagnostic` is a positional record with trailing optional members; `RootCause` is the last: `Diagnostics.cs:8-16`. JSON omits nulls: `Reporter.cs:170`.
11. `check` opens with `saves: false` and returns `{ solution, errors, warnings }`: `ProjectCommands.cs:205-218`.
12. Extension: `globalArgs()` passes `--tc <value>` only when `iecode.tcVersion` is not `auto`: `extension/src/cli/iecode.ts:58-59`; the input box rejects a list (`/^(auto|(3\.1\.)?\d{4}(\.\d+)?)$/`): `extension/src/commands/engineering.ts:145`; it reads only `builds[]`: `engineering.ts:100`.
13. **Unverified (TwinCAT PC):** opening a 4024-stamped project with an explicit `--tc 4026` in a hidden shell raises no modal upgrade dialog (or one `DialogWatch` cancels cleanly, `DialogPolicy.cs:82-86`), and the build then runs. Spike Task 1 (a).
14. **Unverified:** opening a 4026-saved project with `--tc 4024` fails fast with a readable error (exit 1 or a dialog), not a hang. Spike Task 1 (b).
15. **Unverified:** `--tc <line not installed>` with `Builds()` empty (old install layout) fails in `SelectVersion` with exit 15 within seconds. Spike Task 1 (c). The same spike step checks the opposite case (R30): a line XAE can select although `Builds()` does not list it (mixed install layout), which a pre-check would wrongly report as exit 15.
16. **Unverified:** two isolated builds of different lines one after the other in one `iecode` process work (shell quit, copy delete within 15 s, second shell start). `ShellSession` already switches lines in code (`Runner.cs:251-306`), but not with copy deletion in between. Spike Task 1 (d) can only run two processes one after the other (the matrix does not exist yet); it covers shell quit and leftover folders, and the one-process case is checked by Task 4b Step 8 (1) and, with the selection, by Task 6.
17. `ProjectCommands.Build` rejects `--keep-isolated`, `--isolate-dir` and `--copy-tmc` without `--isolate` in a validator: `ProjectCommands.cs:91-94`; the action reads `ctx.Get(isolate)` for `WarnLongPath` and the isolated path: `ProjectCommands.cs:103-104`. A list implies isolation without that flag, so these options need a shared predicate (R20). `check` has only the solution argument, no `--isolate`, `--isolate-dir` or `--keep-isolated`: `ProjectCommands.cs:205-209`.
18. Exit 130 (`ExitCodes.Cancelled`, `Errors.cs:21`) is produced only by a declined confirmation (`LibraryCommands.cs:554`). `IECode.Cli` registers no `Console.CancelKeyPress` handler (grep over `cli/src`), so Ctrl+C ends the process with no `finally`: a matrix run cannot promise exit 130, its copy stays until the 24 h sweep and the shell can be orphaned (R15, R21; Known limits).
19. `Runner.Run` is the one place every command passes before `body(new Context(parse, log))`: `Runner.cs:39`; `Runner.FullName(command)` gives the name (`"build"`, `"lib install"`): `Runner.cs:72`. Commands that never read `ctx.Version` do not fail on a list by themselves (Premise 3).
20. `XaeShell.DialogFailed` (a dialog was cancelled or the shell ended) and `XaeShell.BlockingDialog` (its title) are public: `XaeShell.cs:213-216`; `ThrowIfDialogCancelled` is internal (`XaeShell.cs:281`) and only fires inside `Watched` calls, so a dialog cancelled between calls (an upgrade or conversion dialog on a 4024 project opened in 4026) can end the build body without an exception (R24).

## Depends on (round-1 symbols, real signatures)

- `public static TcChoice TcLineGuard.Choose(TwinCatVersion requested, IReadOnlyList<string?> savedStamps, IReadOnlyList<string> installedBuilds, bool saves)`
- `public static IReadOnlyList<string> TwinCatInstall.Builds(string? twinCatDir)`
- `public static IsolatedCopy Isolation.Create(string solution, string isolateDir, int? pid = null)`, `Isolation.OutsideRoot(string solution, string root)`, `Isolation.RootOf(string)`, `Isolation.CopyRootFor(string root, string isolateDir, int pid)`, `Isolation.MapBack(Diagnostic d, IsolatedCopy copy)`, `Isolation.DefaultDir`, `IsolatedCopy.TryDelete(TimeSpan)`
- `public static int BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)`
- `Reporter.MapDiagnostic`, `Reporter.TwinCatVersion`, `Reporter.Diagnostics`, `Reporter.Info/Step/Warn`
- `Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false, Action? beforeOpen = null)` (`Runner.cs:88`)
- Plan G (lands first, M4): `PlcSelection` and the `--exclude-plc` / `--no-tests` options on `build` and `check`; `Build(string? platform, bool save = true, PlcSelection? only = null)`. F's `buildAll` and the check body carry the selection unchanged (Task 4a, Task 5).
- `XaeShell.SelectedVersion` (`string?`, `XaeShell.cs:43`), `TwinCatVersion.UsedBy(string? selected, TwinCatVersion requested)` (`TwinCatVersion.cs:90`), `Reporter.PartialData` (`object?`, `Reporter.cs:147`)
- `LibraryCommands.Preflight(Context ctx, IEnumerable<PlcProjectFile> projects)` (`LibraryCommands.cs:365`), `ProjectCommands.WarnLongPath(Context ctx, string folder, string root, string copyRoot, bool isolating)` (`ProjectCommands.cs:188`)
- `BuildResult(string Platform, bool Ok, int FailedProjects, int Errors, int Warnings, BuildSummary? Summary, double Seconds, bool StaticAnalysisOnly = false)` (G adds a trailing optional `ExcludedDiagnostics` after it; F does not touch `BuildResult`)

## Touches

- Create: `cli/src/IECode.Core/TcMatrix.cs`, `cli/tests/IECode.Core.Tests/TcMatrixTests.cs`
- Modify: `cli/src/IECode.Cli/Globals.cs` (`--tc` description, `Context.TcOverride`, `Context.Versions`), `cli/src/IECode.Core/Diagnostics.cs` (`Diagnostic.Tc`), `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Build`, `Check`; `BuildIsolated` extracted), `cli/src/IECode.Cli/Runner.cs` (one call in `Runner.Run`: `TcMatrix.RejectList`), `cli/README.md` (`--tc` row, build and check sections), `extension/CHANGELOG.md`, `docs/research/cli-build-workflow.md` (spike results under Q3).
- Conflict watch: plan G also edits `ProjectCommands.Build` (options, `BuildAll`); per master plan M4, G lands first and does not restructure `BuildIsolated`, F moves it afterwards (Task 4a, a pure move; `buildAll` keeps carrying G's `PlcSelection`). Plan E may edit `Runner`/`Context` for `ws build --parallel`; F's only `Runner.cs` change is the one `TcMatrix.RejectList` call before `body(...)` in `Runner.Run`, so it merges either way. F does not touch `Isolation.cs` or `WorkspaceCommands.cs`, and creates none of the shared new files of G, J, E and I (`TestProjects.cs`, `TestProjectSelection.cs`; master plan R3). Per M5, `Diagnostic.Tc` is the trailing field and any later field goes after it.

## Decisions

1. **A list implies `--isolate`, one fresh copy per entry.** A 4026 open can upgrade files even without saving (R35), so `--no-save` is not enough; a shared copy would let 4026 leave upgraded files for the next entry. Rejected: requiring the user to type `--isolate` (no other safe mode exists, so asking adds nothing). An info line says so.
2. **Sequential only.** Rejected: parallel per line (two shells double memory, plan E owns parallelism and its spike U1, M8).
3. **`build` and `check` only.** Every other command keeps a single version; a list gives exit 2 "`--tc` takes a list only for build and check". The check is central, not per command: `Runner.Run` calls `TcMatrix.RejectList(commandName, tcText)` before the command body, so a command that never reads `ctx.Version` rejects a list too (Premise 3); `Context.Version` keeps `TcMatrix.Single` as a second line of defence. Rejected: `ws build` matrix (combines with E, too large); relying on each command's `ctx.Version` read.
4. **Entries are explicit versions:** `auto` in a list, empty entries and duplicates (same `ToString()`) are exit 2. `4024,4024.66` is allowed (two builds of one line). Separators: comma, optional spaces.
5. **Line not installed: entry fails with 15, others still run.** `TwinCatInstall.Builds` is a hint, not the truth (Premise 5): when it is not empty and lacks the entry, `TcMatrix.Run` logs a note and still runs the entry, so the shell's own version selection (`SelectVersion`) makes the final call; the entry is `notInstalled` / 15 only when the shell reports 15 (or `Builds()` is empty and the shell says so). Rejected: reporting 15 from the list alone (a mixed install layout can hide a line XAE can select; this costs one wasted copy for a truly missing line). The mixed layout goes into the spike (Task 1 Step 3). Rejected: skip with exit 0 (a CI matrix that silently drops a line goes falsely green).
6. **Exit code:** stop codes first (an entry that returned 2 or 130 ended the matrix, and that code is the result); otherwise 10 when any entry failed to build (a real compile error must not hide behind an environment failure of another entry); otherwise the first other non-zero code in matrix order; else 0. The table and `matrix[].exitCode` still show every entry's own code, so an environment failure stays visible. Exit 2 and 130 from an entry stop the matrix at once.
7. **`--copy-tmc` with a list is exit 2** (which line's `.tmc` would win is ambiguous); use a single `--tc` for it. **`--keep-isolated` and `--isolate-dir` work with a list**: the build validator treats a list as isolating (`TcMatrix.ImpliesIsolate`) instead of demanding `--isolate`; each entry keeps its own copy (`Allocate` gives each its own folder, Premise 7) and `matrix[].isolatedCopy` names it.
8. **JSON, additive:** `builds[]` stays (all builds of all entries, in order), new `matrix[]` (`tc`, `twinCat`, `status`, `errors`, `warnings`, `rootCauses`, `exitCode`, `error`, `seconds`, `builds`, `isolatedCopy` only with `--keep-isolated`), and each diagnostic of a matrix run gets `tc` (omitted otherwise). Top-level `twinCat` is the build of the last entry that actually ran (an entry that never started a shell does not count), null when none did; it is set explicitly from `MatrixRun.TwinCat`, not left to `Reporter.TwinCatVersion` (Premise 9). `Outcome.Error` carries `TcMatrix.ErrorSummary` for a non-zero matrix exit, so the JSON `error` field is set. Rejected: index ranges into `diagnostics` (hard to consume).
9. **Extension unchanged.** Its setting validator already rejects lists; the CHANGELOG line names the CLI feature only.
10. **A matrix accepts only what `--isolate` accepts.** Because a list always isolates, a solution with a project type `OutsideRoot` refuses (Premise 6) cannot run a matrix; the exit-2 message from `OutsideRoot` is kept and the README says so. Rejected: a non-isolated matrix for such solutions (it would write the original with each line).
11. **A hidden dialog is an entry error.** After each entry's body the shell's dialog state is checked (`XaeShell.DialogFailed`); if `DialogPolicy` cancelled an upgrade or conversion dialog without an exception, the entry becomes `error` with the dialog title as message (R24, Premise 20).
12. **Ctrl+C is a known limit, not a feature.** There is no `CancelKeyPress` handler in round 2 (Premise 18), so the plan promises no exit 130 for it and no cleanup; see Known limits.

## Review Focus

1. **`--tc 4024` alone after this change** produces the same JSON and the same output as before: no `matrix`, no `tc` on diagnostics, no isolation (Task 2 test `SingleValueIsNotAMatrix`; Task 4a Step 4 and Task 4b Step 8 (3) compare JSON).
2. **`--tc 4024,4026` on a non-build command** (`activate`, `lib install`, `ws build`, and `clean`, which never reads the version): exit 2 with a message naming build and check, never a parse error about "Invalid TwinCAT version '4024,4026'" (Task 2 test `SingleRejectsListWithCommandHint`, Task 3 test `RejectListOutsideBuildAndCheck`).
3. **One line fails to open the project** (4026-saved project, `--tc 4024,4026`): the 4024 entry is recorded as an error with its message, 4026 still runs, the table shows both (Task 3 tests `RunContinuesAfterAFailedEntry` and `ExitCodeBuildFailureOutranksToolFailure`, Task 4b Step 8 (2)).
4. **Ctrl+C is not handled** (no `CancelKeyPress` handler in `IECode.Cli`, Premise 18): the plan makes no exit-130 promise for it and has no test for it; the matrix's own stop codes (2 and 130 returned by an entry) are tested in `RunStopsOnUsageAndCancelledCodes`; the limit is named in the README and CHANGELOG (Known limits).
5. **Errors of both lines in one JSON document**: each diagnostic carries `tc`, so the same message from two lines stays distinguishable (Task 3 test `DiagnosticTcSerializedOnlyWhenSet`).

---

### Task 1: Spike on a TwinCAT PC (manual, 45 min `[estimated]`, gates Tasks 4b and 5)

Runs in master plan session A (read-mostly: throwaway clones and isolated copies, no change to the machine; the machine-changing spikes of other plans go in session B, R2). It gates only this plan: Tasks 2, 3 and 4a (pure Core code and a pure refactor) start without it, and other plans' lanes do not wait for it.

Use a throwaway clone of a public sample with one PLC project stamped 4024 and a second clone saved once by 4026. Current CLI built from `main`.

- [ ] **Step 1 (a):** `iecode build <4024-sln> --tc 4026 --isolate -v`; record exit, any dialog (`DialogWatch` log line), duration, and `git status --porcelain` of the original (must be empty). Also record whether a dialog was cancelled without an exception (exit 0 with a `DialogWatch` line, or `XaeShell.DialogFailed` set): Task 4b Step 4 turns that into an entry error either way (R24).
- [ ] **Step 2 (b):** `iecode build <4026-sln> --tc 4024 --isolate -v`; record exit, message, duration.
- [ ] **Step 3 (c):** run `iecode build <sln> --tc 4022 --isolate` (a line that is not installed; do not rename install folders); record exit and duration. Then list `TwinCatInstall.Builds` (`iecode info --installed`, which reads the shells' versions) next to the folders under `Components\Plc` and note any line a shell exists for but `Builds()` does not list (mixed layout; `Builds()` counts only `Build_*` folders with `RepTool.exe`, R30).
- [ ] **Step 4 (d):** in one PowerShell line, run Step 1 and then `iecode build <4024-sln> --tc 4024 --isolate`; check `%TEMP%\iecode\b` holds no leftover folder of this PID. This is two processes, not two entries of one process; the one-process case is Task 4b Step 8 (1) and Task 6.
- [ ] **Step 5:** write the anonymised results under Q3 in `docs/research/cli-build-workflow.md`; commit `docs: record the TwinCAT matrix spike` with a why-body.

Gates: (a) runs or fails with a cancelled-dialog message: continue. (a) hangs past `--timeout`: stop; add the upgrade dialog title to `DialogPolicy.KnownTitles` with the right answer as a new Task 1b (owner: this plan) before Task 4b. (b) fails with exit 1 and a message: continue, the README states that an older line cannot build a project saved by a newer one. (b) hangs: same as (a) hangs. (c) not 15: Task 4b maps the observed code into the entry unchanged and Decision 5 notes it. (c) a line a shell can select but `Builds()` does not list: Decision 5 already lets the shell decide; the README names the mixed-layout case. (d) leftover folder: Task 4b waits up to 30 s in `TryDelete` between entries instead of 15 s.

### Task 2: `TcMatrix.Parse` and `Context` wiring (2 h `[estimated]`)

**Files:**
- Create: `cli/src/IECode.Core/TcMatrix.cs`
- Modify: `cli/src/IECode.Cli/Globals.cs:15-20,44-50`
- Test: `cli/tests/IECode.Core.Tests/TcMatrixTests.cs`

**Interfaces:**
- Produces:
  - `public static IReadOnlyList<TwinCatVersion> TcMatrix.Parse(string? text)`: `null`/blank/`auto` gives `[TwinCatVersion.Auto]`; throws `IECodeException(ExitCodes.Usage, …)` per Decision 4.
  - `public static TwinCatVersion TcMatrix.Single(IReadOnlyList<TwinCatVersion> versions)`: the only entry; for 2+ throws Usage with message `"--tc takes a list of versions only for 'build' and 'check'."` and hint `"Pass one version, e.g. --tc 4024."`
  - `Context`: `public TwinCatVersion? TcOverride { get; init; }`, `public IReadOnlyList<TwinCatVersion> Versions => TcMatrix.Parse(Parse.GetValue(Globals.Tc))`, `public TwinCatVersion Version => TcOverride ?? TcMatrix.Single(Versions)`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void SingleValueIsNotAMatrix() { var v = TcMatrix.Parse("4024.66"); Assert.Single(v); Assert.Equal(new TwinCatVersion(4024, 66), v[0]); }
[Fact] public void AutoAndBlankGiveAuto() { Assert.Equal(new[] { TwinCatVersion.Auto }, TcMatrix.Parse("auto").ToArray()); Assert.Equal(new[] { TwinCatVersion.Auto }, TcMatrix.Parse(null).ToArray()); }
[Fact] public void ParsesListInOrderWithSpaces() => Assert.Equal(new[] { new TwinCatVersion(4026, null), new TwinCatVersion(4024, 66) }, TcMatrix.Parse("4026, 3.1.4024.66").ToArray());
[Fact] public void TwoBuildsOfOneLineAreAllowed() => Assert.Equal(2, TcMatrix.Parse("4024,4024.66").Count);
[Theory, InlineData("4024,auto"), InlineData("4024,,4026"), InlineData("4024,"), InlineData("4024,4024"), InlineData("4024,3.1.4024"), InlineData("4024,40x6")]
public void RejectsBadLists(string text) => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => TcMatrix.Parse(text)).ExitCode);
[Fact] public void SingleRejectsListWithCommandHint() { var e = Assert.Throws<IECodeException>(() => TcMatrix.Single(TcMatrix.Parse("4024,4026"))); Assert.Equal(ExitCodes.Usage, e.ExitCode); Assert.Contains("'build' and 'check'", e.Message); }
```
The duplicate message names the entry (`"--tc lists 3.1.4024 twice."`); the auto message says `"auto cannot be part of a --tc list."`. (Explicit arrays and `.ToArray()`: `Assert.Equal` on a collection expression against an `IReadOnlyList<T>` does not bind reliably, R25.)

- [ ] **Step 2:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class *TcMatrixTests`; expected: FAIL, `TcMatrix` does not exist.
- [ ] **Step 3:** Implement `Parse` (split on `,`, trim, each through `TwinCatVersion.Parse`) and `Single` in `TcMatrix.cs`; wire `Context` as in Interfaces; extend the `--tc` description with `"; build and check also take a list such as 4024,4026 (one isolated build per version)"`.
- [ ] **Step 4:** Run the class again; expected: PASS. Then the full test command; expected: all green.
- [ ] **Step 5:** Commit `Parse a list of TwinCAT versions in --tc` (body: the matrix needs several versions in one option; other commands now name build/check instead of failing on an invalid version).

### Task 3: Matrix decisions in Core: loop, install check, exit code, table, `Diagnostic.Tc` (5 h `[estimated]`)

**Files:**
- Modify: `cli/src/IECode.Core/TcMatrix.cs`, `cli/src/IECode.Core/Diagnostics.cs:8-16`
- Test: `cli/tests/IECode.Core.Tests/TcMatrixTests.cs`

**Interfaces:**
- Consumes: `TcMatrix.Parse` (Task 2).
- Produces:
  - `public enum MatrixStatus { Ok, Failed, NotInstalled, Error }` (JSON camelCase: `ok`, `failed`, `notInstalled`, `error`)
  - `public sealed record MatrixEntry(string Tc, string? TwinCat, MatrixStatus Status, int Errors, int Warnings, int RootCauses, int ExitCode, string? Error, double Seconds, string? IsolatedCopy = null)`
  - `public sealed record EntryResult(string? TwinCat, int Errors, int Warnings, int RootCauses, int ExitCode, string? Error = null, string? IsolatedCopy = null)`: what the CLI hands back for one entry.
  - `public sealed record MatrixRun(IReadOnlyList<MatrixEntry> Entries, int ExitCode, IECodeException? Stopped)` with `public string? TwinCat => Entries.LastOrDefault(e => e.Status != MatrixStatus.NotInstalled)?.TwinCat` (Decision 8).
  - `public static MatrixRun TcMatrix.Run(IReadOnlyList<TwinCatVersion> versions, Func<TwinCatVersion, EntryResult> runOne, IReadOnlyList<string> installedBuilds, IReadOnlyList<string?> savedStamps, Action<string>? note = null)`: per entry, `note` gets `LineChangeNote` and, when `NotInstalled` is true, `"TwinCAT {v} is not in the installed build list; asking XAE to select it."` (Decision 5); `runOne` is always called; an `IECodeException` (its code and message) or a `COMException` (`ExitCodes.Failed`, its message) thrown by `runOne` becomes an entry; `Status` comes from `StatusOf`; a code for which `StopsMatrix` is true ends the loop, with `Stopped` set to the exception (or a new `IECodeException` with that code and the entry's error); `ExitCode` is `TcMatrix.ExitCode` of the entries so far; `Seconds` is measured around `runOne`.
  - `public static MatrixStatus TcMatrix.StatusOf(int exitCode)`: 0 `Ok`, 10 `Failed`, 15 `NotInstalled`, else `Error`.
  - `public static string? TcMatrix.ErrorSummary(IReadOnlyList<MatrixEntry> entries)`: null when every entry is `Ok`, else `"{n} of {m} TwinCAT versions did not build: 3.1.4026 (not installed), ..."` listing every non-ok entry with its status text.
  - `public static string? TcMatrix.DialogError(string? dialogTitle)`: null for null or blank, else `"TwinCAT showed a dialog that was cancelled: {title}."` (R24; the CLI throws it as `IECodeException(ExitCodes.Failed, …)` when `XaeShell.DialogFailed` is set after an entry's body).
  - `public static bool TcMatrix.NotInstalled(TwinCatVersion entry, IReadOnlyList<string> installedBuilds)`: false when the list is empty (unknown), else true when no build `Matches` the entry. A hint only (Decision 5).
  - `public static bool TcMatrix.ImpliesIsolate(int entries)`: true for 2+ entries; the build validator and the action use it instead of reading `--isolate` alone (R20).
  - `public static string? TcMatrix.OptionError(int entries, bool copyTmc)`: null for one entry; for 2+ with `copyTmc` `"--copy-tmc works with a single --tc version only."`
  - `public static void TcMatrix.RejectList(string commandName, string? tcText)`: central check for `Runner.Run` (Decision 3): when `tcText` holds a list (`TcMatrix.Parse(tcText).Count > 1`) and `commandName` is neither `build` nor `check`, throws the `Single` Usage error; a single value, `null` or `auto` never throws.
  - `public static bool TcMatrix.StopsMatrix(int exitCode)`: true for `Usage` and `Cancelled`.
  - `public static int TcMatrix.ExitCode(IEnumerable<int> entryCodes)` (Decision 6): the first stop code if any; else 10 if any entry is 10; else the first other non-zero code; else 0.
  - `public static string? TcMatrix.LineChangeNote(TwinCatVersion entry, IReadOnlyList<string?> savedStamps)`: when the first stamp has another line, `"TwinCAT {entry} differs from the saved line {stamp.Line}; built in an isolated copy only."`, else null.
  - `public static IReadOnlyList<string> TcMatrix.Table(IReadOnlyList<MatrixEntry> entries)`: header `TwinCAT  Build used  Result  Errors  Warnings  Root causes  Exit`, one row per entry, columns left-aligned, padded to the widest cell, separated by two spaces, trailing spaces trimmed, `-` for a missing build, result text `ok` / `failed` / `not installed` / `error`.
  - `Diagnostic` gains trailing `string? Tc = null`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void NotInstalledOnlyWhenListKnown() { Assert.False(TcMatrix.NotInstalled(new(4026, null), [])); Assert.True(TcMatrix.NotInstalled(new(4026, null), ["3.1.4024.66"])); Assert.False(TcMatrix.NotInstalled(new(4024, null), ["3.1.4024.66"])); Assert.True(TcMatrix.NotInstalled(new(4024, 47), ["3.1.4024.66"])); }
[Fact] public void OptionErrorOnlyForCopyTmcWithLists() { Assert.Null(TcMatrix.OptionError(1, true)); Assert.NotNull(TcMatrix.OptionError(2, true)); Assert.Null(TcMatrix.OptionError(2, false)); }
[Fact] public void ImpliesIsolateOnlyForLists() { Assert.False(TcMatrix.ImpliesIsolate(1)); Assert.True(TcMatrix.ImpliesIsolate(2)); }
[Fact] public void StopsMatrixOnCancelledAndUsageCodes() { Assert.True(TcMatrix.StopsMatrix(130)); Assert.True(TcMatrix.StopsMatrix(2)); Assert.False(TcMatrix.StopsMatrix(10)); Assert.False(TcMatrix.StopsMatrix(15)); Assert.False(TcMatrix.StopsMatrix(1)); }
[Fact] public void ExitCodeAllOkIsZero() => Assert.Equal(0, TcMatrix.ExitCode([0, 0]));
[Fact] public void ExitCodeBuildFailedIsTen() => Assert.Equal(10, TcMatrix.ExitCode([0, 10]));
[Fact] public void ExitCodeBuildFailureOutranksToolFailure() { Assert.Equal(10, TcMatrix.ExitCode([10, 1])); Assert.Equal(10, TcMatrix.ExitCode([1, 10])); Assert.Equal(10, TcMatrix.ExitCode([10, 15])); }
[Fact] public void ExitCodeFirstOtherNonZeroWins() { Assert.Equal(15, TcMatrix.ExitCode([0, 15, 1])); Assert.Equal(1, TcMatrix.ExitCode([1, 15])); }
[Fact] public void ExitCodeStopCodesComeFirst() { Assert.Equal(2, TcMatrix.ExitCode([10, 2])); Assert.Equal(130, TcMatrix.ExitCode([1, 130])); }
[Fact] public void StatusOfMapsExitCodes() { Assert.Equal(MatrixStatus.Ok, TcMatrix.StatusOf(0)); Assert.Equal(MatrixStatus.Failed, TcMatrix.StatusOf(10)); Assert.Equal(MatrixStatus.NotInstalled, TcMatrix.StatusOf(15)); Assert.Equal(MatrixStatus.Error, TcMatrix.StatusOf(1)); }
[Theory, InlineData("activate"), InlineData("lib install"), InlineData("ws build"), InlineData("clean")]
public void RejectListOutsideBuildAndCheck(string command)
{
    var e = Assert.Throws<IECodeException>(() => TcMatrix.RejectList(command, "4024,4026"));
    Assert.Equal(ExitCodes.Usage, e.ExitCode); Assert.Contains("'build' and 'check'", e.Message);
}
[Fact] public void RejectListAllowsBuildCheckAndSingleValues()
{
    TcMatrix.RejectList("build", "4024,4026"); TcMatrix.RejectList("check", "4024, 4026");
    TcMatrix.RejectList("clean", "4024"); TcMatrix.RejectList("clean", "auto"); TcMatrix.RejectList("clean", null);
}
[Fact] public void DialogErrorNamesTheTitle() { Assert.Null(TcMatrix.DialogError(null)); Assert.Null(TcMatrix.DialogError(" ")); Assert.Contains("Upgrade Project", TcMatrix.DialogError("Upgrade Project")); }

static EntryResult Ran(string build, int code = 0, int rootCauses = 0) => new(build, 0, 0, rootCauses, code);
[Fact] public void RunContinuesAfterAFailedEntry()
{
    var run = TcMatrix.Run([new(4024, null), new(4026, null)], v => v.Line == 4024 ? throw new IECodeException(ExitCodes.Failed, "cannot open the project") : Ran("3.1.4026.12"), ["3.1.4024.66", "3.1.4026.12"], [null]);
    Assert.Equal(2, run.Entries.Count);
    Assert.Equal(MatrixStatus.Error, run.Entries[0].Status); Assert.Equal("cannot open the project", run.Entries[0].Error); Assert.Equal(1, run.Entries[0].ExitCode);
    Assert.Equal(MatrixStatus.Ok, run.Entries[1].Status);
    Assert.Equal(1, run.ExitCode); Assert.Null(run.Stopped);
}
[Theory, InlineData(2), InlineData(130)]
public void RunStopsOnUsageAndCancelledCodes(int code)
{
    var calls = 0;
    var run = TcMatrix.Run([new(4024, null), new(4026, null), new(4022, null)], v => { calls++; throw new IECodeException(code, "stop"); }, [], [null]);
    Assert.Equal(1, calls); Assert.Single(run.Entries); Assert.Equal(code, run.ExitCode); Assert.Equal(code, run.Stopped!.ExitCode);
}
[Fact] public void RunTakesExit15FromTheShellAndGoesOn()
{
    var run = TcMatrix.Run([new(4022, null), new(4024, null)], v => v.Line == 4022 ? new(null, 0, 0, 0, 15, "TwinCAT 4022 is not installed") : Ran("3.1.4024.66"), [], [null]);
    Assert.Equal(MatrixStatus.NotInstalled, run.Entries[0].Status); Assert.Equal(MatrixStatus.Ok, run.Entries[1].Status); Assert.Equal(15, run.ExitCode);
}
[Fact] public void RunAsksTheShellEvenWhenTheInstallListLacksTheLine()
{
    var calls = 0; var notes = new List<string>();
    var run = TcMatrix.Run([new(4026, null)], v => { calls++; return Ran("3.1.4026.12"); }, ["3.1.4024.66"], [null], notes.Add);
    Assert.Equal(1, calls); Assert.Equal(MatrixStatus.Ok, run.Entries[0].Status); Assert.Contains(notes, n => n.Contains("not in the installed build list"));
}
[Fact] public void RunKeepsTheRootCauseCountOfTheEntry() => Assert.Equal(2, TcMatrix.Run([new(4024, null)], v => Ran("3.1.4024.66", 10, rootCauses: 2), [], [null]).Entries[0].RootCauses);
[Fact] public void RunTwinCatIsTheLastEntryThatRan()
{
    var run = TcMatrix.Run([new(4024, null), new(4022, null)], v => v.Line == 4024 ? Ran("3.1.4024.66") : new(null, 0, 0, 0, 15, "not installed"), [], [null]);
    Assert.Equal("3.1.4024.66", run.TwinCat);
    Assert.Null(TcMatrix.Run([new(4022, null)], v => new(null, 0, 0, 0, 15, "not installed"), [], [null]).TwinCat);
}
[Fact] public void ErrorSummaryIsNullWhenAllOkAndNamesFailures()
{
    Assert.Null(TcMatrix.ErrorSummary([new("3.1.4024", "3.1.4024.66", MatrixStatus.Ok, 0, 0, 0, 0, null, 1)]));
    var text = TcMatrix.ErrorSummary([new("3.1.4024", "3.1.4024.66", MatrixStatus.Ok, 0, 0, 0, 0, null, 1), new("3.1.4026", null, MatrixStatus.NotInstalled, 0, 0, 0, 15, "not installed", 0)]);
    Assert.Contains("1 of 2", text); Assert.Contains("3.1.4026 (not installed)", text);
}
[Fact] public void LineChangeNoteOnlyForOtherLine() { Assert.Null(TcMatrix.LineChangeNote(new(4024, null), ["3.1.4024.66"])); Assert.Contains("4024", TcMatrix.LineChangeNote(new(4026, null), ["3.1.4024.66"])); Assert.Null(TcMatrix.LineChangeNote(new(4026, null), [null])); }
[Fact] public void TableHasOneRowPerEntryAndDashForMissingBuild()
{
    var rows = TcMatrix.Table([new("3.1.4024", "3.1.4024.66", MatrixStatus.Ok, 0, 12, 0, 0, null, 41.2), new("3.1.4026", null, MatrixStatus.NotInstalled, 0, 0, 0, 15, "not installed", 0)]);
    Assert.Equal(new[]
    {
        "TwinCAT   Build used   Result         Errors  Warnings  Root causes  Exit",
        "3.1.4024  3.1.4024.66  ok             0       12        0            0",
        "3.1.4026  -            not installed  0       0         0            15",
    }, rows.ToArray());
}
[Fact] public void DiagnosticTcSerializedOnlyWhenSet()
{
    Assert.DoesNotContain("\"tc\"", JsonSerializer.Serialize(new Diagnostic(Severity.Error, "x"), Reporter.JsonOptions));
    Assert.Contains("\"tc\":\"3.1.4026\"", JsonSerializer.Serialize(new Diagnostic(Severity.Error, "x", Tc: "3.1.4026"), Reporter.JsonOptions));
}
```

- [ ] **Step 2:** Run `--filter-class *TcMatrixTests`; expected: FAIL (missing members).
- [ ] **Step 3:** Implement the members listed in Interfaces in `TcMatrix.cs`; append `string? Tc = null` to `Diagnostic`. `Run` holds the whole loop (continue after a failed entry, stop codes, 15 from the shell, entry timing) so that `ProjectCommands` only supplies `runOne`.
- [ ] **Step 4:** Run the class, then the full test command (existing `Diagnostic` constructions must still compile and pass); expected: all green.
- [ ] **Step 5:** Commit `Decide the matrix loop, exit codes, install checks and the result table in Core` (body: the CLI has no test project, so every matrix rule, the loop included, lives in Core with fakes; a real compile error outranks an environment failure of another line in the exit code).

### Task 4a: Extract `BuildIsolated` and `CheckOutsideRoot` (pure refactor, 1.5 h `[estimated]`, not gated by Task 1)

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs:72-186`

**Interfaces:**
- Consumes: Depends-on symbols above; plan G's `BuildAll` (the local function at `ProjectCommands.cs:168`, which carries G's `PlcSelection` after G landed).
- Produces: `private static void CheckOutsideRoot(string path, string root)` (the `OutsideRoot` check and its exit-2 message, moved out of the local function unchanged); `private static Outcome BuildIsolated(Context ctx, string path, string root, string dir, Func<XaeShell, List<BuildResult>> buildAll, bool keep, bool copyTmc, string? tcLabel)` extracted from the local function. `buildAll` is the same delegate the non-isolated path passes to `WithShell` (`shell => BuildAll(shell, save: false)`); it already carries G's selection, and F adds no selection parameter of its own (R29). For a single version nothing changes: `tcLabel: null`, no `Tc` on diagnostics.

- [ ] **Step 1:** Move the `OutsideRoot` check into `CheckOutsideRoot`; the single-version `--isolate` path calls it right before `BuildIsolated`, exactly where the check ran before (nothing happens between the two).
- [ ] **Step 2:** Extract `BuildIsolated` as in Interfaces; `MapDiagnostic = tcLabel is null ? d => Isolation.MapBack(d, copy) : d => Isolation.MapBack(d, copy) with { Tc = tcLabel }` (the `Tc` field exists from Task 3). The single-version path passes `tcLabel: null`. Do not change any message, order or exit code.
- [ ] **Step 3:** `dotnet build cli/src/IECode.Cli`; expected: 0 errors, 0 new warnings. Then the full test command; expected: all green.
- [ ] **Step 4 (manual, TwinCAT PC, 5 min):** `iecode build <4024-sln> --tc 4024 --isolate --json` on `main` (or the parent commit) and on this branch; the two documents are identical apart from `durationMs`, the `isolatedCopy` path and timings.
- [ ] **Step 5:** Commit `Extract BuildIsolated from the build action` (body: pure move so the matrix can reuse one isolated build per version; no behaviour change, checked by a before/after JSON compare).

### Task 4b: `build --tc <list>` (4 h `[estimated]`, gated by Task 1 and Tasks 2-4a)

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs:72-186`, `cli/src/IECode.Cli/Runner.cs` (one call in `Runner.Run`), `cli/README.md` (`--tc` row at line 56, build section near line 72), `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: `Context.Versions`, `Context.TcOverride` (Task 2); all `TcMatrix` members (`Run`, `ImpliesIsolate`, `OptionError`, `RejectList`, `DialogError`, `ErrorSummary`, `Table`, `ExitCode`), `MatrixEntry`, `EntryResult`, `MatrixRun`, `Diagnostic.Tc` (Task 3); `BuildIsolated`, `CheckOutsideRoot` (Task 4a); Depends-on symbols above.
- Produces: `private static (string Root, string Dir) PrepareIsolated(Context ctx, string path, string? isolateDir)` (shared with Task 5: `CheckOutsideRoot`, then `WarnLongPath(ctx, folder, root, Isolation.CopyRootFor(root, dir, Environment.ProcessId), isolating: true)`, returns the repository root and the copy parent folder); `private static Outcome BuildMatrix(Context ctx, string path, IReadOnlyList<TwinCatVersion> versions, string? isolateDir, bool keep, Func<XaeShell, List<BuildResult>> buildAll)`. JSON `matrix[]` element: `{ tc, twinCat, status, errors, warnings, rootCauses, exitCode, error, seconds, builds, isolatedCopy }`. The loop itself is `TcMatrix.Run` (Task 3), already tested with fakes; this task only wires it.

- [ ] **Step 1:** Validator of `build` (`ProjectCommands.cs:91-94`): parse `--tc` with `TcMatrix.Parse` (on `IECodeException` add its message as the error) and add `TcMatrix.OptionError(count, copyTmc)` when not null; the "need --isolate" rule becomes `!(r.GetValue(isolate) || TcMatrix.ImpliesIsolate(count)) && (keepIsolated || isolateDir || copyTmc)`, so `--keep-isolated` and `--isolate-dir` with a list no longer fail with a misleading message (R20; `--copy-tmc` with a list is caught by `OptionError`).
- [ ] **Step 2:** `Runner.Run` (`Runner.cs:39`): before `body(new Context(parse, log))` call `TcMatrix.RejectList(name, parse.GetValue(Globals.Tc))`, inside the existing `try`, so every command but `build` and `check` answers a list with the Usage error and the JSON result, whether or not it reads `ctx.Version` (R23).
- [ ] **Step 3:** In the `build` action, right after `Preflight` and before the `folder` / `WarnLongPath` lines: when `ctx.Versions.Count > 1` return `BuildMatrix(...)`. `BuildMatrix` first calls `PrepareIsolated` (one `OutsideRoot` check, exit 2 before any entry, and one long-path warning), then logs `"Building for {n} TwinCAT versions, each in its own isolated copy"` (Decision 1). `check` uses the same `PrepareIsolated` (Task 5), so neither command repeats the two checks inline (R27).
- [ ] **Step 4:** `BuildMatrix` calls `TcMatrix.Run(versions, runOne, TwinCatInstall.Builds(RepTool.TwinCatDir), SavedStamps, ctx.Log.Warn)`, where `SavedStamps` are the stamps `Runner.WithShell` reads for the line guard (`solution.TwinCatProjects.Select(p => p.TcVersion)`, `Runner.cs:127`). `runOne(v)`: `ctx.Log.Step($"TwinCAT {v}")`; a recording start (`var first = ctx.Log.Diagnostics.Count`); `BuildIsolated(ctx with { TcOverride = v }, …, tcLabel: v.ToString())` with a `buildAll` wrapper that, inside the shell body, after the build, (a) reads `XaeShell.SelectedVersion` for the build-used column (via `TwinCatVersion.UsedBy`, null when the shell never selected one; not `Reporter.TwinCatVersion`, which keeps the previous entry's value) and (b) throws `new IECodeException(ExitCodes.Failed, TcMatrix.DialogError(shell.BlockingDialog))` when `shell.DialogFailed` is set (a dialog cancelled without an exception makes the entry an error with the dialog's title, R24). Root causes = diagnostics recorded since `first` with `RootCause == true`; errors and warnings = sums over the entry's `BuildResult`s; the isolated copy path only with `--keep-isolated`. The wrapper returns the `EntryResult`; `Run` turns an `IECodeException` or `COMException` into the entry.
- [ ] **Step 5:** After `Run`: set `ctx.Log.PartialData = new { solution = path, matrix = run.Entries }` before rethrowing `run.Stopped` (so an error result still carries the entries so far); set `ctx.Log.TwinCatVersion = run.TwinCat` (R26, Decision 8); print `TcMatrix.Table(run.Entries)` through `ctx.Log.Info`; return `new Outcome(run.ExitCode, new { solution = path, builds = all, matrix = run.Entries }, Error: TcMatrix.ErrorSummary(run.Entries))` (`Error` is null when every entry is ok, so the exit-0 document is unchanged).
- [ ] **Step 6:** `dotnet build cli/src/IECode.Cli`; expected: 0 errors, 0 new warnings. Then the full test command; expected: all green.
- [ ] **Step 7:** README: `--tc` row gains the list form; build section gets one example `iecode build Machine.sln --tc 4024,4026` with a two-row sample table and one sentence each on Decisions 1, 5, 6, 7 and 10, plus the known limits (below). CHANGELOG under `## Unreleased`: "`iecode build` and `iecode check` take `--tc 4024,4026`: one isolated build per TwinCAT version and a result table (JSON `matrix`). Ctrl+C is not handled: an interrupted matrix can leave its isolated copy (removed after 24 h) and a running XAE shell."
- [ ] **Step 8 (manual, TwinCAT PC, 15 min; part of the plan's PC check budget of about 0.5 day with Task 5 and Task 6, R4):** (1) `iecode build <4024-sln> --tc 4024,4026`: table with two rows (one process, so this is the in-process line switch of Premise 16), original `git status --porcelain` empty, no folder left in `%TEMP%\iecode\b`. (2) Same on the 4026-saved clone: 4024 row `error`, 4026 row runs, exit 1 (10 if the 4026 build fails). (3) `iecode build <4024-sln> --tc 4024 --json` before and after this branch: identical apart from `durationMs`. (4) `iecode build <sln> --tc 4024,4026 --copy-tmc`: exit 2; with `--keep-isolated` instead: two kept folders, both named in `matrix[].isolatedCopy`; with `--isolate-dir <folder>` the copies are created there. (5) `iecode clean --artifacts --tc 4024,4026 <folder>`: exit 2 naming build and check. (6) `--tc 4024,4022` with 4022 not installed: 4022 row `not installed`, exit 15, JSON `twinCat` is the 4024 build.
- [ ] **Step 9:** Commit `Build once per TwinCAT version with --tc 4024,4026` (body: a 4026 open makes a project unreadable for 4024, so each version gets its own throwaway copy; parallel shells were rejected for memory and the one-copy-per-process folder rule).

### Task 5: `check --tc <list>` (2 h `[estimated]`, gated by Task 1 and Task 4b)

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs:205-218`, `cli/README.md` (check row), `extension/CHANGELOG.md` (same line as Task 4b, no new line)

**Interfaces:**
- Consumes: Task 3 members (`Run`, `ErrorSummary`, `Table`); `PrepareIsolated` (Task 4b); `Isolation.Create`, `MapBack`, `TryDelete`; the check call plan G gives `check` (carries `PlcSelection`).
- Produces: `check` JSON for a list: `{ solution, errors, warnings, matrix }` with `errors` / `warnings` summed over the entries and `matrix[]` as in Task 4b without `builds` and without `isolatedCopy`. A single version keeps `{ solution, errors, warnings }`.

- [ ] **Step 1:** In `Check`, for `ctx.Versions.Count > 1`: call `PrepareIsolated(ctx, path, null)` (the `OutsideRoot` check and the long-path warning for a command that has no isolation options of its own, R27), then `TcMatrix.Run` with a `runOne` that creates a fresh `Isolation.Create` copy, sets `MapDiagnostic` with `Tc = v.ToString()`, runs `WithShell(ctx with { TcOverride = v }, copy.Solution, saves: false, s => …)` with G's check call (so the selection is effective in every entry, R29) and the same dialog check as Task 4b Step 4, and deletes the copy in `finally` (`TryDelete`). `check` has no `--keep-isolated` and no `--isolate-dir`: copies always go to `Isolation.DefaultDir` and are removed (the README says so). Rationale in a comment: check-all-objects compiles and may let 4026 touch files, so a list never opens the original. The result handling (`PartialData`, `twinCat`, table, `Outcome.Error`) is the same as in Task 4b Step 5; share the private helper that does it instead of copying it.
- [ ] **Step 2:** `dotnet build cli/src/IECode.Cli`; expected: 0 errors. Full test command; expected: all green.
- [ ] **Step 3 (manual, TwinCAT PC, 5 min; part of the PC check budget, R4):** `iecode check <4024-sln> --tc 4024,4026`: two rows, original tree unchanged.
- [ ] **Step 4:** README check row: "also takes a `--tc` list (isolated per version; no `--keep-isolated` or `--isolate-dir` for `check`)". Commit `Check once per TwinCAT version with --tc 4024,4026` (body: same isolation reason as build; check without a list keeps opening the original read-only).

### Task 6: Joint acceptance with plan G (manual, TwinCAT PC, 15 min `[estimated]`; runs once both F and G are merged, by whichever lands second)

Needed because F's `buildAll` and check body must carry G's `PlcSelection`, and F's spike (Task 1) only starts separate processes (R29).

- [ ] **Step 1:** On a public library sample with a test PLC project, in one process: `iecode build <lib-sln> --tc 4024,4026 --no-tests --json`; expected: two rows, a fresh isolated copy per entry (two "Isolated copy" lines), the test project absent from the results of both entries (`excludedPlc` in the JSON), original `git status --porcelain` empty.
- [ ] **Step 2:** `iecode check <lib-sln> --tc 4024,4026 --no-tests --json`; expected: the same, with the selection effective in each entry.
- [ ] **Step 3:** Record the outcome in the Q3 notes of `docs/research/cli-build-workflow.md`. If the selection is lost in a later entry, fix the `buildAll` / check wrapper and rerun; no new plan row needed.

## Known limits

- **No Ctrl+C handling** (R15): `IECode.Cli` has no `CancelKeyPress` handler, so an interrupted matrix run skips its `finally`: the current isolated copy stays until the 24 h sweep, an XAE shell can be left running, and there is no exit-130 promise (Premise 18). Named in the README build section and the CHANGELOG line; a handler, a per-job watchdog and a copy-size warning go to the TODO list.
- **An older line cannot build a project saved by a newer one** (spike (b)); the entry shows `error` with the shell's message.
- **`check` has no keep option**; `--copy-tmc` needs a single `--tc`.
- **The install list is a hint**: a line missing from `TwinCatInstall.Builds` is still asked of XAE (Decision 5).

## Self-review notes

- Spec coverage: one build per line (Task 4b), table (Task 3/4b), isolation required (Decision 1, Task 4b), line change never writes the original (Decisions 1, Premise 4), extension single value (Premise 12, Review Focus 1), not installed (Decision 5), exit (Decision 6), JSON (Decision 8), loop tested in Core (Task 3 `Run`), selection in a matrix (Task 6).
- Total size: about 14.5 h of coding, about 2 days `[estimated]`, plus about 0.5 day on a TwinCAT PC (spike 45 min, manual checks of Tasks 4a, 4b, 5 and 6; R4).
