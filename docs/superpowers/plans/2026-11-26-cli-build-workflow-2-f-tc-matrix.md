# Plan F: `--tc 4024,4026` Build Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode build <sln> --tc 4024,4026` (and `iecode check`) runs once per TwinCAT version, each in a fresh isolated copy, and prints one table (line, build used, errors, warnings, root causes, exit) plus an additive JSON `matrix[]`.

**Architecture:** Parsing, option rules, the install pre-check, the exit-code aggregation and the table live in a new pure `IECode.Core/TcMatrix.cs`. `Context` (in `Globals.cs`) learns a per-run version override, so the existing `Runner.WithShell` / `TcLineGuard` path is reused unchanged for each entry. `ProjectCommands.Build` / `Check` loop over the entries and always build in an `Isolation` copy, so no line ever writes the original tree.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, COM late binding (unchanged).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 1c, section 6 last row, Q3; TODO.md "CLI: build and library workflow at scale" (`--tc 4024,4026` matrix).

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

## Premises checked (tree `iecode-cli-build`, branch `feature/cli-build-workflow-d`)

1. `--tc` is a global recursive `Option<string>`, default `"auto"`: `cli/src/IECode.Cli/Globals.cs:15-20`.
2. The only reader is `Context.Version => TwinCatVersion.Parse(Parse.GetValue(Globals.Tc))`: `Globals.cs:46`; `Context` is a `sealed record`, so `with { … }` works: `Globals.cs:44`. Users of `ctx.Version`: `Runner.cs:102,157,176`, `ProjectCommands.cs:46,325`, `LibraryCommands.cs:403,429,473,522`, `DoctorCommand.cs:31`, `WorkspaceCommands.cs:178`.
3. `TwinCatVersion.Parse("4024,4026")` throws `IECodeException(Usage, "Invalid TwinCAT version …")` today (regex `^(?:3\.1\.)?\d{4}(?:\.\d+)?$`): `TwinCatVersion.cs:18-30`. So every command already rejects a list with exit 2; the plan only improves the message.
4. An explicit version is never second-guessed: `TcLineGuard.Choose` returns it with no note: `TcLineGuard.cs:27`. The exact-build fallback in `Runner.SelectVersion` applies only to `auto`: `Runner.cs:157`.
5. `TwinCatInstall.Builds(string?)` lists installed builds oldest first, empty when unknown: `TcLineGuard.cs:88-102`; `RepTool.TwinCatDir` is its input: `Runner.cs:102`.
6. `build --isolate`: `OutsideRoot` check, `Isolation.Create`, `MapDiagnostic = d => Isolation.MapBack(d, copy)`, `WithShell(ctx, copy.Solution, saves: false, …)`, `TryDelete(15 s)` in `finally`: `ProjectCommands.cs:117-150`. Without `--isolate`, build counts as saving (`saves: true`): `ProjectCommands.cs:113`.
7. The copy folder is `<hash>-<pid>`: `Isolation.cs:70-74`, and `Create` deletes an existing folder of that name first: `Isolation.cs:164`. One process can therefore hold only one copy at a time, which fits a sequential matrix and rules out `--keep-isolated` for more than one entry.
8. `BuildOutcome.ExitCode(IEnumerable<bool>)` gives 0 or 10: `BuildTriage.cs:33`. Exit codes: `Usage = 2`, `BuildFailed = 10`, `VersionNotInstalled = 15`, `Cancelled = 130`: `Errors.cs:8-21`.
9. `Reporter.TwinCatVersion` (JSON `twinCat`) is set by `XaeShell.SelectVersion`: `XaeShell.cs:302`, `Reporter.cs:29,152`. `Reporter.MapDiagnostic` is applied to every recorded diagnostic, also root causes: `Reporter.cs:65-67,107,111`. `Reporter.Diagnostics` is the flat list: `Reporter.cs:30`.
10. `Diagnostic` is a positional record with trailing optional members; `RootCause` is the last: `Diagnostics.cs:8-16`. JSON omits nulls: `Reporter.cs:164`.
11. `check` opens with `saves: false` and returns `{ solution, errors, warnings }`: `ProjectCommands.cs:188-202`.
12. Extension: `globalArgs()` passes `--tc <value>` only when `iecode.tcVersion` is not `auto`: `extension/src/cli/iecode.ts:58-59`; the input box rejects a list (`/^(auto|(3\.1\.)?\d{4}(\.\d+)?)$/`): `extension/src/commands/engineering.ts:145`; it reads only `builds[]`: `engineering.ts:100`.
13. **Unverified (TwinCAT PC):** opening a 4024-stamped project with an explicit `--tc 4026` in a hidden shell raises no modal upgrade dialog (or one `DialogWatch` cancels cleanly, `DialogPolicy.cs:57-61`), and the build then runs. Spike Task 1 (a).
14. **Unverified:** opening a 4026-saved project with `--tc 4024` fails fast with a readable error (exit 1 or a dialog), not a hang. Spike Task 1 (b).
15. **Unverified:** `--tc <line not installed>` with `Builds()` empty (old install layout) fails in `SelectVersion` with exit 15 within seconds. Spike Task 1 (c).
16. **Unverified:** two isolated builds of different lines one after the other in one `iecode` process work (shell quit, copy delete within 15 s, second shell start). `ShellSession` already switches lines in code (`Runner.cs:183-195`), but not with copy deletion in between. Spike Task 1 (d).

## Depends on (round-1 symbols, real signatures)

- `public static TcChoice TcLineGuard.Choose(TwinCatVersion requested, IReadOnlyList<string?> savedStamps, IReadOnlyList<string> installedBuilds, bool saves)`
- `public static IReadOnlyList<string> TwinCatInstall.Builds(string? twinCatDir)`
- `public static IsolatedCopy Isolation.Create(string solution, string isolateDir, int? pid = null)`, `Isolation.OutsideRoot(string solution, string root)`, `Isolation.RootOf(string)`, `Isolation.CopyRootFor(string root, string isolateDir, int pid)`, `Isolation.MapBack(Diagnostic d, IsolatedCopy copy)`, `Isolation.DefaultDir`, `IsolatedCopy.TryDelete(TimeSpan)`
- `public static int BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)`
- `Reporter.MapDiagnostic`, `Reporter.TwinCatVersion`, `Reporter.Diagnostics`, `Reporter.Info/Step/Warn`
- `Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false)`
- `LibraryCommands.Preflight(Context, IEnumerable<PlcProjectFile>, IReadOnlyCollection<LibraryId>)`, `ProjectCommands.WarnLongPath(...)`
- `BuildResult(string Platform, bool Ok, int FailedProjects, int Errors, int Warnings, BuildSummary? Summary, double Seconds, bool StaticAnalysisOnly = false)`

## Touches

- Create: `cli/src/IECode.Core/TcMatrix.cs`, `cli/tests/IECode.Core.Tests/TcMatrixTests.cs`
- Modify: `cli/src/IECode.Cli/Globals.cs` (`--tc` description, `Context.TcOverride`, `Context.Versions`), `cli/src/IECode.Core/Diagnostics.cs` (`Diagnostic.Tc`), `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Build`, `Check`; `BuildIsolated` extracted), `cli/README.md` (`--tc` row, build section), `extension/CHANGELOG.md`, `docs/research/cli-build-workflow.md` (spike results under Q3).
- Conflict watch: plan G also edits `ProjectCommands.Build` (options, `BuildAll`); plan E may edit `Runner`/`Context` for `ws build --parallel`. F does not touch `Runner.cs` or `WorkspaceCommands.cs`. Any plan adding a member to `Diagnostic` must append after `Tc` (or rebase on it).

## Decisions

1. **A list implies `--isolate`, one fresh copy per entry.** A 4026 open can upgrade files even without saving (R35), so `--no-save` is not enough; a shared copy would let 4026 leave upgraded files for the next entry. Rejected: requiring the user to type `--isolate` (no other safe mode exists, so asking adds nothing). An info line says so.
2. **Sequential only.** Rejected: parallel per line (two shells double memory, one copy folder per PID, plan E owns parallelism).
3. **`build` and `check` only.** Every other command keeps a single version; a list gives exit 2 "`--tc` takes a list only for build and check". Rejected: `ws build` matrix (combines with E, too large).
4. **Entries are explicit versions:** `auto` in a list, empty entries and duplicates (same `ToString()`) are exit 2. `4024,4024.66` is allowed (two builds of one line). Separators: comma, optional spaces.
5. **Line not installed: entry fails with 15, others still run.** Pre-checked with `TwinCatInstall.Builds` when it is not empty (no copy, no shell); when it is empty the shell decides. Rejected: skip with exit 0 (a CI matrix that silently drops a line goes falsely green).
6. **Exit code:** all 0 gives 0; any code other than 0 and 10 gives the first such code in matrix order (an environment failure is more actionable than a compile error); else 10. Exit 2 and 130 from an entry stop the matrix at once.
7. **`--keep-isolated` and `--copy-tmc` with a list are exit 2** (one copy folder per process; which line's `.tmc` would win is ambiguous). Use a single `--tc` for those.
8. **JSON, additive:** `builds[]` stays (all builds of all entries, in order), new `matrix[]` (`tc`, `twinCat`, `status`, `errors`, `warnings`, `rootCauses`, `exitCode`, `error`, `seconds`, `builds`), and each diagnostic of a matrix run gets `tc` (omitted otherwise). Top-level `twinCat` is the last entry's build. Rejected: index ranges into `diagnostics` (hard to consume).
9. **Extension unchanged.** Its setting validator already rejects lists; the CHANGELOG line names the CLI feature only.

## Review Focus

1. **`--tc 4024` alone after this change** produces the same JSON and the same output as before: no `matrix`, no `tc` on diagnostics, no isolation (Task 2 test `SingleValueIsNotAMatrix`; Task 4 manual step 3 compares JSON).
2. **`--tc 4024,4026` on a non-build command** (`activate`, `lib install`, `ws build`): exit 2 with a message naming build and check, never a parse error about "Invalid TwinCAT version '4024,4026'" (Task 2 test `SingleRejectsListWithCommandHint`).
3. **One line fails to open the project** (4026-saved project, `--tc 4024,4026`): the 4024 entry is recorded as an error with its message, 4026 still runs, the table shows both (Task 3 test `ExitCodeToolFailureWinsOverBuildFailure`, Task 4 manual step 2).
4. **Ctrl+C during the first entry**: the matrix stops, the copy is deleted, exit 130 (Task 3 test `StopsMatrixOnCancelAndUsage`).
5. **Errors of both lines in one JSON document**: each diagnostic carries `tc`, so the same message from two lines stays distinguishable (Task 3 test `DiagnosticTcSerializedOnlyWhenSet`).

---

### Task 1: Spike on a TwinCAT PC (manual, 45 min `[estimated]`, gates Tasks 4 and 5)

Use a throwaway clone of a public sample with one PLC project stamped 4024 and a second clone saved once by 4026. Current CLI from `feature/cli-build-workflow-d`.

- [ ] **Step 1 (a):** `iecode build <4024-sln> --tc 4026 --isolate -v`; record exit, any dialog (`DialogWatch` log line), duration, and `git status --porcelain` of the original (must be empty).
- [ ] **Step 2 (b):** `iecode build <4026-sln> --tc 4024 --isolate -v`; record exit, message, duration.
- [ ] **Step 3 (c):** run `iecode build <sln> --tc 4022 --isolate` (a line that is not installed; do not rename install folders); record exit and duration.
- [ ] **Step 4 (d):** in one PowerShell line, run Step 1 and then `iecode build <4024-sln> --tc 4024 --isolate`; check `%TEMP%\iecode\b` holds no leftover folder of this PID.
- [ ] **Step 5:** write the anonymised results under Q3 in `docs/research/cli-build-workflow.md`; commit `docs: record the TwinCAT matrix spike` with a why-body.

Gates: (a) runs or fails with a cancelled-dialog message: continue. (a) hangs past `--timeout`: stop; add the upgrade dialog title to `DialogPolicy.KnownTitles` with the right answer as a new Task 1b (owner: this plan) before Task 4. (b) fails with exit 1 and a message: continue, the README states that an older line cannot build a project saved by a newer one. (b) hangs: same as (a) hangs. (c) not 15: Task 4 maps the observed code into the entry unchanged and Decision 5 notes it. (d) leftover folder: Task 4 waits up to 30 s in `TryDelete` between entries instead of 15 s.

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
[Fact] public void AutoAndBlankGiveAuto() { Assert.Equal([TwinCatVersion.Auto], TcMatrix.Parse("auto")); Assert.Equal([TwinCatVersion.Auto], TcMatrix.Parse(null)); }
[Fact] public void ParsesListInOrderWithSpaces() => Assert.Equal([new(4026, null), new(4024, 66)], TcMatrix.Parse("4026, 3.1.4024.66"));
[Fact] public void TwoBuildsOfOneLineAreAllowed() => Assert.Equal(2, TcMatrix.Parse("4024,4024.66").Count);
[Theory, InlineData("4024,auto"), InlineData("4024,,4026"), InlineData("4024,"), InlineData("4024,4024"), InlineData("4024,3.1.4024"), InlineData("4024,40x6")]
public void RejectsBadLists(string text) => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => TcMatrix.Parse(text)).ExitCode);
[Fact] public void SingleRejectsListWithCommandHint() { var e = Assert.Throws<IECodeException>(() => TcMatrix.Single(TcMatrix.Parse("4024,4026"))); Assert.Equal(ExitCodes.Usage, e.ExitCode); Assert.Contains("'build' and 'check'", e.Message); }
```
The duplicate message names the entry (`"--tc lists 3.1.4024 twice."`); the auto message says `"auto cannot be part of a --tc list."`.

- [ ] **Step 2:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class *TcMatrixTests`; expected: FAIL, `TcMatrix` does not exist.
- [ ] **Step 3:** Implement `Parse` (split on `,`, trim, each through `TwinCatVersion.Parse`) and `Single` in `TcMatrix.cs`; wire `Context` as in Interfaces; extend the `--tc` description with `"; build and check also take a list such as 4024,4026 (one isolated build per version)"`.
- [ ] **Step 4:** Run the class again; expected: PASS. Then the full test command; expected: all green.
- [ ] **Step 5:** Commit `Parse a list of TwinCAT versions in --tc` (body: the matrix needs several versions in one option; other commands now name build/check instead of failing on an invalid version).

### Task 3: Matrix decisions in Core: install check, exit code, table, `Diagnostic.Tc` (3 h `[estimated]`)

**Files:**
- Modify: `cli/src/IECode.Core/TcMatrix.cs`, `cli/src/IECode.Core/Diagnostics.cs:8-16`
- Test: `cli/tests/IECode.Core.Tests/TcMatrixTests.cs`

**Interfaces:**
- Consumes: `TcMatrix.Parse` (Task 2).
- Produces:
  - `public enum MatrixStatus { Ok, Failed, NotInstalled, Error }` (JSON camelCase: `ok`, `failed`, `notInstalled`, `error`)
  - `public sealed record MatrixEntry(string Tc, string? TwinCat, MatrixStatus Status, int Errors, int Warnings, int RootCauses, int ExitCode, string? Error, double Seconds)`
  - `public static bool TcMatrix.NotInstalled(TwinCatVersion entry, IReadOnlyList<string> installedBuilds)`: false when the list is empty (unknown), else true when no build `Matches` the entry.
  - `public static string? TcMatrix.OptionError(int entries, bool keepIsolated, bool copyTmc)`: null for one entry; for 2+ with either flag `"--keep-isolated and --copy-tmc work with a single --tc version only."`
  - `public static bool TcMatrix.StopsMatrix(int exitCode)`: true for `Usage` and `Cancelled`.
  - `public static int TcMatrix.ExitCode(IEnumerable<int> entryCodes)` (Decision 6).
  - `public static string? TcMatrix.LineChangeNote(TwinCatVersion entry, IReadOnlyList<string?> savedStamps)`: when the first stamp has another line, `"TwinCAT {entry} differs from the saved line {stamp.Line}; built in an isolated copy only."`, else null.
  - `public static IReadOnlyList<string> TcMatrix.Table(IReadOnlyList<MatrixEntry> entries)`: header `TwinCAT  Build used  Result  Errors  Warnings  Root causes  Exit`, one row per entry, columns padded to the widest cell, `-` for a missing build, result text `ok` / `failed` / `not installed` / `error`.
  - `Diagnostic` gains trailing `string? Tc = null`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void NotInstalledOnlyWhenListKnown() { Assert.False(TcMatrix.NotInstalled(new(4026, null), [])); Assert.True(TcMatrix.NotInstalled(new(4026, null), ["3.1.4024.66"])); Assert.False(TcMatrix.NotInstalled(new(4024, null), ["3.1.4024.66"])); Assert.True(TcMatrix.NotInstalled(new(4024, 47), ["3.1.4024.66"])); }
[Fact] public void OptionErrorOnlyForLists() { Assert.Null(TcMatrix.OptionError(1, true, true)); Assert.NotNull(TcMatrix.OptionError(2, true, false)); Assert.NotNull(TcMatrix.OptionError(2, false, true)); Assert.Null(TcMatrix.OptionError(2, false, false)); }
[Fact] public void StopsMatrixOnCancelAndUsage() { Assert.True(TcMatrix.StopsMatrix(130)); Assert.True(TcMatrix.StopsMatrix(2)); Assert.False(TcMatrix.StopsMatrix(10)); Assert.False(TcMatrix.StopsMatrix(15)); Assert.False(TcMatrix.StopsMatrix(1)); }
[Fact] public void ExitCodeAllOkIsZero() => Assert.Equal(0, TcMatrix.ExitCode([0, 0]));
[Fact] public void ExitCodeBuildFailedIsTen() => Assert.Equal(10, TcMatrix.ExitCode([0, 10]));
[Fact] public void ExitCodeToolFailureWinsOverBuildFailure() { Assert.Equal(15, TcMatrix.ExitCode([10, 15])); Assert.Equal(1, TcMatrix.ExitCode([1, 15, 10])); }
[Fact] public void LineChangeNoteOnlyForOtherLine() { Assert.Null(TcMatrix.LineChangeNote(new(4024, null), ["3.1.4024.66"])); Assert.Contains("4024", TcMatrix.LineChangeNote(new(4026, null), ["3.1.4024.66"])); Assert.Null(TcMatrix.LineChangeNote(new(4026, null), [null])); }
[Fact] public void TableHasOneRowPerEntryAndDashForMissingBuild()
{
    var rows = TcMatrix.Table([new("3.1.4024", "3.1.4024.66", MatrixStatus.Ok, 0, 12, 0, 0, null, 41.2), new("3.1.4026", null, MatrixStatus.NotInstalled, 0, 0, 0, 15, "not installed", 0)]);
    Assert.Equal(3, rows.Count); Assert.StartsWith("TwinCAT", rows[0]); Assert.Contains("ok", rows[1]); Assert.Matches(@"3\.1\.4026\s+-\s+not installed", rows[2]); Assert.EndsWith("15", rows[2].TrimEnd());
}
[Fact] public void DiagnosticTcSerializedOnlyWhenSet()
{
    Assert.DoesNotContain("\"tc\"", JsonSerializer.Serialize(new Diagnostic(Severity.Error, "x"), Reporter.JsonOptions));
    Assert.Contains("\"tc\":\"3.1.4026\"", JsonSerializer.Serialize(new Diagnostic(Severity.Error, "x", Tc: "3.1.4026"), Reporter.JsonOptions));
}
```

- [ ] **Step 2:** Run `--filter-class *TcMatrixTests`; expected: FAIL (missing members).
- [ ] **Step 3:** Implement the members listed in Interfaces in `TcMatrix.cs`; append `string? Tc = null` to `Diagnostic`.
- [ ] **Step 4:** Run the class, then the full test command (existing `Diagnostic` constructions must still compile and pass); expected: all green.
- [ ] **Step 5:** Commit `Decide matrix exit codes, install checks and the result table in Core` (body: the CLI has no test project, so every matrix rule lives in Core; a tool failure outranks a compile error in the exit code).

### Task 4: `build --tc <list>` (4 h `[estimated]`, gated by Task 1)

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs:72-169`, `cli/README.md` (`--tc` row at line 56, build section near line 72), `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: `Context.Versions`, `Context.TcOverride` (Task 2); all `TcMatrix` members, `MatrixEntry`, `Diagnostic.Tc` (Task 3); Depends-on symbols above.
- Produces: `private static Outcome BuildIsolated(Context ctx, string path, string root, string dir, Func<XaeShell, List<BuildResult>> buildAll, bool keep, bool copyTmc, string? tcLabel)` extracted from the local function (behaviour for a single version unchanged); `private static Outcome BuildMatrix(Context ctx, string path, IReadOnlyList<TwinCatVersion> versions, string root, string dir, Func<XaeShell, List<BuildResult>> buildAll)`. JSON `matrix[]` element: `{ tc, twinCat, status, errors, warnings, rootCauses, exitCode, error, seconds, builds }`.

- [ ] **Step 1:** Add to the `build` validator: parse `--tc` with `TcMatrix.Parse` (on `IECodeException` add its message as the error) and add `TcMatrix.OptionError(count, keepIsolated, copyTmc)` when not null.
- [ ] **Step 2:** Extract `BuildIsolated` as in Interfaces; when `tcLabel` is set, `MapDiagnostic = d => Isolation.MapBack(d, copy) with { Tc = tcLabel }`. Single-version path calls it with `tcLabel: null`.
- [ ] **Step 3:** In the action, after `Preflight` and `WarnLongPath(…, isolating: true)` for a list: when `ctx.Versions.Count > 1` call `BuildMatrix`. It runs the `OutsideRoot` check once (exit 2 before any entry), logs `"Building for {n} TwinCAT versions, each in its own isolated copy"`, then per entry: `ctx.Log.Step($"TwinCAT {v}")`, warn `LineChangeNote`, skip with `MatrixStatus.NotInstalled` / 15 when `TcMatrix.NotInstalled(v, TwinCatInstall.Builds(RepTool.TwinCatDir))`, else reset `ctx.Log.TwinCatVersion = null`, call `BuildIsolated(ctx with { TcOverride = v }, …, tcLabel: v.ToString())` inside `try`; an `IECodeException` or `COMException` becomes `MatrixStatus.Error` with its message and code (`ExitCodes.Failed` for COM), rethrown when `TcMatrix.StopsMatrix(code)`. Root causes = diagnostics recorded during the entry with `RootCause == true`. Afterwards print `TcMatrix.Table` through `ctx.Log.Info` and return `new Outcome(TcMatrix.ExitCode(codes), new { solution, builds = all, matrix })`.
- [ ] **Step 4:** `dotnet build cli/src/IECode.Cli`; expected: 0 errors, 0 new warnings. Then the full test command; expected: all green.
- [ ] **Step 5:** README: `--tc` row gains the list form; build section gets one example `iecode build Machine.sln --tc 4024,4026` with a two-row sample table and one sentence each on Decisions 1, 5, 6 and 7. CHANGELOG under `## Unreleased`: "`iecode build` and `iecode check` take `--tc 4024,4026`: one isolated build per TwinCAT version and a result table (JSON `matrix`)."
- [ ] **Step 6 (manual, TwinCAT PC, 15 min):** (1) `iecode build <4024-sln> --tc 4024,4026`: table with two rows, original `git status --porcelain` empty, no folder left in `%TEMP%\iecode\b`. (2) Same on the 4026-saved clone: 4024 row `error`, 4026 row runs, exit 1. (3) `iecode build <4024-sln> --tc 4024 --json` before and after this branch: identical apart from `durationMs`. (4) `iecode build <sln> --tc 4024,4026 --keep-isolated`: exit 2.
- [ ] **Step 7:** Commit `Build once per TwinCAT version with --tc 4024,4026` (body: a 4026 open makes a project unreadable for 4024, so each version gets its own throwaway copy; parallel shells were rejected for memory and the one-copy-per-process folder rule).

### Task 5: `check --tc <list>` (2 h `[estimated]`, gated by Task 1)

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs:188-202`, `cli/README.md` (check row), `extension/CHANGELOG.md` (same line as Task 4, no new line)

**Interfaces:**
- Consumes: Task 3 members; `Isolation.Create`, `MapBack`, `TryDelete`.
- Produces: `check` JSON for a list: `{ solution, errors, warnings, matrix }` with `errors` / `warnings` summed over the entries and `matrix[]` as in Task 4 without `builds`. A single version keeps `{ solution, errors, warnings }`.

- [ ] **Step 1:** In `Check`, for `ctx.Versions.Count > 1`: same loop as `BuildMatrix` (reuse it by passing a body `Func<Context, string copySolution, (int Errors, int Warnings, bool Ok)>`; one shared private loop, not a copy), each entry in a fresh `Isolation.Create` copy with `WithShell(…, saves: false, s => s.CheckAllObjects())`. Rationale in a comment: check-all-objects compiles and may let 4026 touch files, so a list never opens the original.
- [ ] **Step 2:** `dotnet build cli/src/IECode.Cli`; expected: 0 errors. Full test command; expected: all green.
- [ ] **Step 3 (manual, TwinCAT PC, 5 min):** `iecode check <4024-sln> --tc 4024,4026`: two rows, original tree unchanged.
- [ ] **Step 4:** README check row: "also takes a `--tc` list (isolated per version)". Commit `Check once per TwinCAT version with --tc 4024,4026` (body: same isolation reason as build; check without a list keeps opening the original read-only).

## Self-review notes

- Spec coverage: one build per line (Task 4), table (Task 3/4), isolation required (Decision 1, Task 4), line change never writes the original (Decisions 1, Premise 4), extension single value (Premise 12, Review Focus 1), not installed (Decision 5), exit (Decision 6), JSON (Decision 8).
- Total size: about 1.5 days `[estimated]` plus about 1 h on a TwinCAT PC.
