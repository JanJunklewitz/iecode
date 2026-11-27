# Plan G: Build Without the Test Project (`--exclude-plc` / `--no-tests`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode build` and `iecode check` can leave out PLC projects by name (`--exclude-plc <name>`, repeatable) or by the test folder convention (`--no-tests`), so a library solution builds although its test project pins the library version that is being built.

**Architecture:** A pure Core class `PlcSelection` resolves the options against the `.sln` files (names, folder rule, errors) and filters diagnostics of excluded PLC projects. `check` skips excluded PLC handles (it already runs per PLC). How `build` leaves projects out depends on the spike (Task 1): `SolutionBuild.BuildProject`, `ShouldBuild` per solution context, or a `.sln` edit inside the `--isolate` copy. `lib save` needs no change.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, COM late binding to the XAE shell (EnvDTE `SolutionBuild`, TwinCAT `ITcSmTreeItem` / `ITcPlcIECProject`).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 row "Build without the test project" and answer Q7; [TODO.md](../../../TODO.md) "CLI: build and library workflow at scale", item "Build without the test project". Round-1 conventions: [master plan](2026-11-24-cli-build-workflow-master-plan.md) (Global Constraints, Decisions, R1 to R44).

**Review changes** (round-2 master plan, section "Review", Decision ledger; the rows win over older text, and the text below is already corrected):

- R2: Task 1 title and intro (session A, gates only this plan). R3: Touches, Task 2 Files and Interfaces (G creates `TestProjects.cs`).
- R4: Task 5 step 2 and Size (manual PC check, about 0.5 day). R29: Touches conflict notes, Task 5 step 2 (joint run with F).
- R31: Decision 8, Premise 13, Task 2 interfaces and tests, Task 3 Files. R32: Decision 9, Premise 16, Task 2 `ResolveOnCopyRootedSolution`, Task 4 steps 3 and 5.
- R33: Premise 14, spike table, Touches, Task 4 path C. R34: Premise 15, Review Focus 4, Task 4 path B and step 5. R35: Premise 17, Task 4 path A.
- R36: Global Constraints, Task 2 steps 1 and 4. R37: Task 2 `TestFolderRule` rows, Task 5 README row. R38: Decision 3, Task 2 tests.
- R39: Decision 4, Touches, Task 4 Files. R40: Task 1 step 5, Task 5, Known limits. R41: Task 3 intro and step 1, Task 5 step 2.

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`; test folders `Tc3_MotorLib.Test`, `UnitTest`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`. Windows-only tests use `Assert.SkipUnless(WindowsOnly.IsWindows, …)`.
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel.
- JSON output changes are additive; existing exit codes keep their meaning. This plan adds **no** exit code: usage errors are exit 2 (`ExitCodes.Usage`).
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`; new options a row change in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` (GitHub noreply address).
- All sizes `[estimated]`. Steps that need a TwinCAT PC (4024 and 4026 installed) are marked **manual**.
- Plain `build` / `check` without the new options behave exactly as before (no selection object, no filter, same COM calls).
- Test fixture paths are built with `Path.Combine` (or `TempWorkspace[...]`), never with backslash literals, so the tests also pass on ubuntu CI; path values a user types are accepted with both separators (R36).

## Premises checked (static read of `main` at `f817efe`; line numbers remapped from the earlier base `0515a61` on 2026-11-27)

1. `XaeShell.BuildCore` builds the whole solution with `Solution.SolutionBuild.Build(false)` and polls `BuildState`; failure comes from `LastBuildInfo`, raw diagnostics and the summary line (`cli/src/IECode.Automation/XaeShell.Build.cs:91-108`).
2. `build` saves first unless `--no-save` (`XaeShell.Build.cs:84-85`); no-save sets `DiscardChanges`, which closes the solution with `Close(false)` before another open and before quit (`XaeShell.cs:411-421`; `Runner.WithShell` also sets `DiscardChanges = !saves || discard`, `Runner.cs:93`).
3. `check` runs `nested.CheckAllObjects()` once per PLC handle from `PlcProjects()` (`XaeShell.Build.cs:122-134`), so a per-PLC skip needs no spike.
4. `PlcProjects()` walks `TIPC` children of every `.tsproj` / `.tspproj` and yields `PlcHandle(Name, NestedName, TreePath, …)` (`XaeShell.Plc.cs:8-34`); `FindPlc` matches `Name` or `NestedName` case-insensitively (`XaeShell.Plc.cs:45`).
5. File side: `SolutionFile.Load` keeps only `.tsproj` / `.tspproj` from the `.sln` (`cli/src/IECode.Core/Projects/SolutionFile.cs:26-32`); each `TwinCatProjectFile` lists its `.plcproj` files, inline and through `_Config\PLC\*.xti` (`SolutionFile.cs:78-93`). `PlcProjectFile.Name` is the `<Name>` property, else the file name (`PlcProjectFile.cs:72`).
6. The first build after opening also reports what opening wrote to the Build pane (`_loadOutputPending`, `XaeShell.Build.cs:188-208`, `XaeShell.cs:443`): the test project's "library not found" lines land in the build's raw diagnostics and fail it even when the test PLC is not compiled. So a diagnostics filter is needed on every path.
7. Pane diagnostics carry the owner: `"<plc>.Library Manager"` origin sets `Project` to the PLC name, otherwise the last `Build started: Project: X` line (`cli/src/IECode.Core/Diagnostics.cs:62-81`). Error List items carry `item.Project` (`XaeShell.Build.cs:181`).
8. `BuildOutcome.Ok(failedProjects, raw, summary)` (`cli/src/IECode.Core/BuildTriage.cs:29-30`); exit 10 aggregation in `BuildOutcome.ExitCode` (`BuildTriage.cs:33`).
9. `build` and `check` run the pre-flight on all PLC projects of the solution (`cli/src/IECode.Cli/Commands/ProjectCommands.cs:99`, `:212`); the test project's pinned, not yet installed library version would be warned about.
10. `--isolate` copies the repository and builds `copy.Solution` with `save: false` (`ProjectCommands.cs:126-166`, `Isolation.Create` at `cli/src/IECode.Core/Isolation.cs:177`).
11. `lib save` only exports the chosen PLC through `Runner.StageExport` -> `shell.SaveAsLibrary(plcName ?? meta?.Name, …)` on its nested project, no solution build (`cli/src/IECode.Cli/Commands/LibraryCommands.cs:66-79`, `Runner.cs:148-153`, `XaeShell.Plc.cs:53-62`); `meta` picks the first project with library metadata, which a test project normally lacks.
12. `ws build` builds whole solutions with `shell.Build(null, save)` (`cli/src/IECode.Cli/Commands/WorkspaceCommands.cs:136`); it has the same problem, but is out of scope here (Decision 6).
13. Three different names exist for one PLC project: the `.plcproj` `<Name>`, the COM tree name (`PlcHandle.Name`, the `TIPC` child, default `PLC`) and the nested project name (`PlcHandle.NestedName`); `PlcHandle.TreePath` is the nested project's `PathName` (`XaeShell.Plc.cs:27-30`), which should be the `.plcproj` path. Error List `Project` (`XaeShell.Build.cs:181`) and `Diagnostic.Project` (premise 7) carry one of them. With a default tree name `PLC` in both PLCs a name match would also drop the library PLC's errors (R31), so runtime matching is by path identity (Decision 8).
14. `.sln` project lines exist only for `.tsproj` / `.tspproj`; a nested `.plcproj` has no `.sln` line (`SolutionFile.cs:15` regex, `:26-32` filter; `Isolation.cs:88`), so `SolutionContexts` and `.Build.0` lines are `.tsproj`-level and paths B and C cannot split a shared layout (R33). `<ProjectGuid>` inside a `.plcproj` is a different GUID from the `.sln` line's.
15. `DiscardChanges` is sticky: `BuildCore` sets it for a no-save build (`XaeShell.Build.cs:85`) and nothing resets it, so a path B that set it would also drop the later writes of a saving build; `SelectPlatform` (`XaeShell.Build.cs:30-46`) can make a different, untoggled solution context active (R34).
16. With `--isolate` the shell opens `copy.Solution` (`ProjectCommands.cs:142`), so `PlcHandle.TreePath` and `Diagnostic.File` are copy-rooted; `Filter` runs inside `BuildCore` (`XaeShell.Build.cs:106-110`) before `Reporter.Mapped` maps them back (`Reporter.cs:67`, `ProjectCommands.cs:139`). A selection resolved from the original solution would never match (R32).
17. `BuildSummary.TryParse` takes only the last summary line of the pane (`Diagnostics.cs:100`) and `ClearErrorList` clears the pane once per build (`XaeShell.Build.cs:86`, `:195-208`), so several `BuildProject` calls need a summary per call (R35). `BuildResult` is a positional record (`XaeShell.Build.cs:12-13`); `CheckAllObjects` returns a three-element tuple (`:120`), its only caller is `ProjectCommands.cs:213`.

**Unverified (TwinCAT PC only) -> Task 1:** (U1) whether `SolutionBuild.BuildProject` accepts a `.tsproj` and/or a nested PLC project unique name and builds only that, and whether the Error List is reset between two calls; (U2) whether `SolutionContexts` list `.tsproj` projects (premise 14) and `ShouldBuild = false` skips them, whether the change reaches the `.sln` on disk, and whether the list changes when another target platform is active; (U3) whether removing the excluded `.tsproj`'s `.Build.0` lines from the `.sln` (in a copy) skips it; (U4) which names appear in Error List `Project` and in `Build started: Project:` for each PLC project (tree name, nested name, `.plcproj` name), and whether `PlcHandle.TreePath` equals the `.plcproj` path (premise 13); (U5) whether `lib save` succeeds (exit code) while the test project cannot resolve its pinned library; (U6) whether removing the excluded PLC's project entry from a copy of a shared `.tsproj` skips it.

## Depends on (round-1 symbols, real signatures)

- `public BuildResult XaeShell.Build(string? platform, bool save = true)` (`XaeShell.Build.cs:75`); `public (int Errors, int Warnings, bool Ok) XaeShell.CheckAllObjects()` (`:120`).
- `internal IEnumerable<PlcHandle> XaeShell.PlcProjects()`, `internal sealed record PlcHandle(string Name, string NestedName, string TreePath, object SysManager, object Project, object Nested)` (`XaeShell.Plc.cs:8-12`).
- `internal IEnumerable<(dynamic Project, dynamic SysManager, string File)> XaeShell.TwinCatProjects(bool includePlcOnly = true)` (`XaeShell.cs:447`); `public bool DiscardChanges { get; set; }` (`XaeShell.cs:411`).
- `public static BuildDiagnostics BuildTriage.Combine(IReadOnlyList<Diagnostic>? errorList, IReadOnlyList<Diagnostic> pane)`; `public sealed record BuildDiagnostics(IReadOnlyList<Diagnostic> Raw, IReadOnlyList<Diagnostic> Shown)` (`BuildTriage.cs:6`, `:111`; with a readable Error List, `Raw` now also holds the pane's generic last line, which has no `Project`).
- `public static bool BuildOutcome.Ok(int failedProjects, IReadOnlyList<Diagnostic> raw, BuildSummary? summary)`, `public static int BuildOutcome.ExitCode(IEnumerable<bool> buildsOk)` (`BuildTriage.cs:29-33`).
- `public static SolutionFile SolutionFile.Load(string path)`, `TwinCatProjectFile.PlcProjects`, `PlcProjectFile.Name` / `.Path`.
- `public static IsolatedCopy Isolation.Create(string solution, string isolateDir, int? pid = null)`, `IsolatedCopy.Solution` (`Isolation.cs:10-15`, `:177`).
- `public static T Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false, Action? beforeOpen = null)` (`cli/src/IECode.Cli/Runner.cs:88`).
- `internal static void LibraryCommands.Preflight(Context ctx, IEnumerable<PlcProjectFile> projects)` (`LibraryCommands.cs:365`; the stage overload `Preflight(Context, IReadOnlyList<BuildStage>)` at `:368` is for `ws build`).

## Touches

- Create: `cli/src/IECode.Core/Projects/PlcSelection.cs`, `cli/tests/IECode.Core.Tests/PlcSelectionTests.cs`; create `cli/src/IECode.Core/Projects/TestProjects.cs` and `cli/tests/IECode.Core.Tests/TestProjectsTests.cs` (shared with J, M3: G Task 2 creates both, R3; J only calls `IsTestProject` and keeps its `Select` in its own `TestProjectSelection.cs`).
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`Build`, `CheckAllObjects` get an optional selection; path A/B helpers; `BuildResult` gets an optional trailing field `ExcludedDiagnostics`, R39), `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Build`, `Check`: options, pre-flight input, JSON), `cli/README.md`, `extension/CHANGELOG.md`, `docs/research/cli-build-workflow.md` (spike result under Q7).
- Only on spike path C: `cli/src/IECode.Core/Projects/SolutionFile.cs` (the project-line regex at `:15` also captures the project GUID; `TwinCatProjectFile` at `:59` gets `SolutionGuid`). The `<ProjectGuid>` inside a `.plcproj` is a different GUID with no `.sln` line (premise 14, R33), so `PlcProjectFile.cs` is not touched.
- Conflict notes: F (`--tc` matrix) and J (`iecode test`) also edit `ProjectCommands.Build`; per master plan M4 G lands first and does not restructure `BuildIsolated` (path C adds one call between `Isolation.Create` and `WithShell`), F moves it later; E may edit `XaeShell.Build.cs` around `Build`. G keeps `Build(string? platform, bool save = true, PlcSelection? only = null)` as a trailing optional parameter, so callers in E/F compile unchanged. F's `buildAll` must carry the selection (R29): `ResolveSelection` takes the solution to resolve against, so F can call it once per entry's copy; the joint run with F is Task 5 step 2. J's `TestProjects.Select` goes into its own `TestProjectSelection.cs` and its Task 2 starts after G Task 2 is merged (R3). `LibraryCommands.cs`, `WorkspaceCommands.cs`, `Runner.cs` are **not** touched.

## Decisions (planner; the user delegated design decisions)

1. **`--exclude-plc` matches the PLC name or a path.** A name matches `PlcProjectFile.Name` or the `.plcproj` file name (case-insensitive); a value with `/` or `\` or ending in `.plcproj` matches the `.plcproj` path or any folder above it, relative to the solution folder. A name that matches projects in two places is exit 2 with the relative paths in the hint (test projects are often just named `PLC`). Rejected: name only (ambiguous exactly in the case the spec describes).
2. **`--no-tests` folder rule:** a PLC project is a test project when a folder segment of its `.plcproj` path **below the solution folder** equals `Test`, `Tests`, `UnitTest`, `UnitTests` or ends with `.Test` / `.Tests` (case-insensitive, whole segment). Segments above the solution folder are ignored, so a clone under `C:\Tests\` does not exclude everything. Rejected: detect by a reference to a test framework library (an application can reference test helpers; the folder convention is what the run named).
3. **Errors:** unknown `--exclude-plc` value = exit 2 listing the available PLC names; everything excluded = exit 2 with the hint "Remove --no-tests or name fewer projects"; a solution without any PLC project is its own exit 2 message ("no PLC project found"), never the "everything excluded" one (R38); `--no-tests` that finds nothing is not an error (`Detail` line). `--exclude-plc` and `--no-tests` combine (union).
4. **Diagnostics of excluded projects are dropped, not shown**, on every path (premise 6); the count goes to a `Detail` line and to JSON `excludedDiagnostics` (one number at run level, the sum over the builds; `BuildResult` carries it per build through an optional trailing field, R39). JSON `data.excludedPlc` lists the excluded project names (additive, `build` and `check`). The pre-flight checks only included projects.
5. **`lib save` gets no options.** It already compiles only the chosen PLC (premise 11); Task 1 confirms (U5). The documented workaround for a full build stays `lib save --install` first.
6. **`ws build` is not in G.** It builds every solution of a workspace; a `--no-tests` there belongs to E's rework of `ws build` and can reuse `PlcSelection` unchanged (follow-up line in TODO.md, Task 5).
7. **No silent fallback to a full build.** If the chosen path cannot leave a project out (for example path C without `--isolate`), stop with exit 2 and a hint, never build everything.
8. **Runtime matching is by identity, names only where unique (R31).** `check` skips a handle when `PlcHandle.TreePath` equals an excluded `.plcproj` path (confirmed in spike step 1, U4); the diagnostics filter drops by file path below an excluded `.plcproj` folder, and by `Project` name or `"<plc>.Library Manager:"` prefix only when that name belongs to exactly one PLC project of the solution. A duplicated name (default tree name `PLC` in both PLCs) never matches; when unsure the diagnostic is kept. Rejected: matching every name, which would also drop the library PLC's errors.
9. **With `--isolate` the selection is resolved against `copy.Solution` (R32)**, because the shell works on the copy and `TreePath` / `Diagnostic.File` are copy-rooted (premise 16). The original solution is resolved first as well, only to fail with exit 2 before the copy is made. Rejected: translating paths with the copy roots (a second mapping to keep in step with `Isolation`).

## Review Focus

1. **Test project and library PLC in the same `.tsproj`** (one TwinCAT project, two PLCs): a `.tsproj`-level skip cannot work; the plan must pick a PLC-level path or stop (Task 1 records both layouts; Task 4 test `PartialTwinCatProjectIsMarked`).
2. **Two PLC projects both named `PLC`** in `Tc3_MotorLib/` and `Tc3_MotorLib.Test/`: `--exclude-plc PLC` stops with exit 2 and lists both paths; `--exclude-plc Tc3_MotorLib.Test` works (Task 2 tests `AmbiguousNameStops`, `FolderPathSelects`).
3. **Library-not-found lines written while opening the test project** fail the build although the test PLC is skipped: filtered (Task 2 test `LibraryManagerLineOfExcludedPlcIsDropped`, Task 4 manual step).
4. **`ShouldBuild` change written to the `.sln`** when the default build saves: the value is restored in `finally` and saved again, per `Build` call and per platform, with no sticky `DiscardChanges` (Task 4 path B, manual `git status` check and the multi-platform case in step 5).
5. **Solution cloned below a folder named `Tests`**: `--no-tests` must not exclude every project (Task 2 test `FoldersAboveTheSolutionAreIgnored`).

---

### Task 1: Spike: can the Automation Interface build a subset? (TwinCAT PC, **manual**, 90 min `[estimated]`, spike session A, gates Task 3 from step 1 on and Task 4)

Spike session A of the master plan (R2): read-mostly, on throwaway solutions only, no library install and no change to the library repository, so no restore point is needed. It gates only this plan; the other plans' spikes and lanes do not wait for it.

Use two throwaway solutions (no internal data in the notes): (a) **split** layout: `Tc3_MotorLib/Tc3_MotorLib.tsproj` (library PLC) and `Tc3_MotorLib.Test/Tc3_MotorLib.Test.tsproj` (PLC named `PLC`) in one `.sln`; (b) **shared** layout: one `.tsproj` with both PLCs. In both, the test PLC pins `Tc3_MotorLib` to a version that is not installed. Run every step on 4024 and on 4026 (`TcXaeShell.DTE.15.0` / `.17.0`), visible shell. A PowerShell session with `$dte = New-Object -ComObject TcXaeShell.DTE.15.0; $dte.MainWindow.Visible = $true; $dte.Solution.Open($sln)`; retry a line that fails with `RPC_E_CALL_REJECTED`. `git status` must be clean before each step; record `git status --porcelain` after each.

- [ ] **Step 1 (U4, names):** list `foreach ($p in $dte.Solution.Projects) { $p.Name; $p.UniqueName; $p.FullName }` and, recursively, `$item.SubProject.UniqueName` of every `ProjectItems` entry; for each PLC record tree name (`TIPC` child `.Name`), nested name (with its `PathName`, to compare with the `.plcproj` path: identity matching, Decision 8) and `.plcproj` `<Name>`; note which names are not unique (two PLCs both `PLC`). Also record the project GUID of each `.tsproj` line in the `.sln`. Run a full `$dte.Solution.SolutionBuild.Build($true)`; record `Project` of every `$dte.ToolWindows.ErrorList.ErrorItems` item (4026) and every `Build started: Project:` line of the Build pane.
- [ ] **Step 2 (U1, BuildProject):** `$sb = $dte.Solution.SolutionBuild; $cfg = $sb.ActiveConfiguration.Name + '|' + $sb.ActiveConfiguration.PlatformName`; `$sb.BuildProject($cfg, '<library .tsproj UniqueName>', $true)`, then the same with the library PLC's nested `UniqueName` from step 1 (if any). Record: `LastBuildInfo`, the summary line, whether the test PLC appears in the pane (it must not), and whether `_CompileInfo` / `.tmc` of the library PLC were written. Call `BuildProject` twice in a row (two units) and record the pane text and summary line after each call, and whether the Error List is reset by the second call (R35: summary per call, pane cleared between calls).
- [ ] **Step 3 (U2, ShouldBuild):** `foreach ($c in $sb.ActiveConfiguration.SolutionContexts) { "$($c.ProjectName) $($c.ShouldBuild)" }`; set `ShouldBuild = $false` on the test project's context (the `.tsproj` in layout a; contexts are `.sln` projects, so in layout b record that no per-PLC entry exists), `$sb.Build($true)`, record as in step 2. With a second target platform active (`ActiveTargetPlatform`), list the contexts again and record whether the active context changes (R34). Then `$dte.Solution.Close($false)` and check whether the `.sln` changed on disk; repeat once with `$dte.Solution.SaveAs($dte.Solution.FullName)` before close to see the save effect.
- [ ] **Step 4 (U3, `.sln` edit):** in a copy, delete the lines `{<test .tsproj GUID from its .sln Project line>}.<cfg>.Build.0 = …` from `GlobalSection(ProjectConfigurationPlatforms)`, open, `Build($true)`, record as in step 2 (layout a). In layout b (U6) remove the test PLC's project entry from the copy's `.tsproj`, open, `Build($true)`, record.
- [ ] **Step 5 (U5, lib save):** `iecode lib save <sln layout a and b> -o <temp>`; record exit code and whether the test project's errors appear. Pass criterion (R40): exit 0 for the library PLC while the test project's pinned library is unresolved; also run `lib save` for the excluded test PLC and record its exit code (the solution, and so the test project, is still opened).
- [ ] **Step 6:** write the table (layout x line x step, anonymised) under Q7 in `docs/research/cli-build-workflow.md` and the chosen path; commit (`git commit -s`, subject "Record whether the Automation Interface can build a subset", body: why).

**What each outcome means (first matching row wins, per layout; both layouts must be covered, else the uncovered layout stops with exit 2 per Decision 7):**

| Outcome | Path for Task 4 |
|---|---|
| `BuildProject` on the nested PLC unique name builds only that PLC | **A-plc:** build each included PLC with `BuildProject`, aggregate per call |
| `BuildProject` works only for a `.tsproj` | **A-ts** for TwinCAT projects whose PLCs are all excluded (split layout); shared layout falls to the next row |
| `SolutionContexts` list the excluded `.tsproj` and `ShouldBuild = false` skips it, `.sln` unchanged after restore and save (**tsproj-level**, split layout only) | **B:** per `Build` call and platform: toggle, build, restore in `finally`, save again; no `DiscardChanges` |
| Only the `.sln` edit of the excluded `.tsproj` GUID skips it (**tsproj-level**, split layout only) | **C:** apply the edit to `copy.Solution` inside `--isolate`, GUID read from the `.tsproj` line of the `.sln`; without `--isolate` exit 2, hint "add --isolate" |
| Shared layout, and only removing the excluded PLC's entry from the `.tsproj` skips it (U6) | **C-ts:** edit the copy's `.tsproj` inside `--isolate`; without `--isolate` exit 2, hint "add --isolate" |
| Nothing skips the test PLC | **D:** `build` gets no new options; only `check` ships (Task 3), README documents `lib save --install` then `build`; Task 4 is dropped |
| Step 5 fails | Decision 5 is reversed: add a follow-up item for `lib save --exclude-plc`, not in this plan |

Paths B and C work per `.tsproj` (R33), because the `.sln` has no line for a nested `.plcproj`: in the shared layout they never apply; there only A-plc, C-ts under `--isolate`, or exit 2 (Decision 7) are possible.

The diagnostics filter (Task 2) matches by identity (Decision 8): by object file path below the excluded `.plcproj` folder (`Diagnostic.File`), and by `Project` name or library manager prefix only for the names step 1 shows to be unique; a name that appears for both PLCs (for example `PLC` as the Error List `Project` in the shared layout) is not used.

### Task 2: Core `PlcSelection` (selection and diagnostics filter)

Runs in parallel with Task 1 (no TwinCAT needed).

**Files:**
- Create: `cli/src/IECode.Core/Projects/PlcSelection.cs`
- Create: `cli/src/IECode.Core/Projects/TestProjects.cs` (shared with plan J, master plan M3 and R3: G creates it here with `IsTestProject`; J only calls it and puts its `Select` into its own `TestProjectSelection.cs`)
- Test: `cli/tests/IECode.Core.Tests/TestProjectsTests.cs` (the folder rule, no fixtures) and `cli/tests/IECode.Core.Tests/PlcSelectionTests.cs` (fixtures written with `TempWorkspace` `ws`: `Lib.sln` referencing `Tc3_MotorLib/Tc3_MotorLib.tsproj` and `Tc3_MotorLib.Test/Tc3_MotorLib.Test.tsproj`, each with an inline `<Project PrjFilePath="…plcproj">`; library PLC `<Name>Tc3_MotorLib</Name>`, test PLC `<Name>PLC</Name>`; further fixtures `SlnBothNamedPlc` (both PLCs `PLC`), `SlnThree` (adds `Tc3_AxisLib`), `SlnOnlyTests` (every PLC in a test folder), `SlnNoPlc` (a `.tsproj` without a PLC), `SlnShared`, `SlnWithoutTests`)

**Interfaces:**
- Produces:
  - `public sealed record PlcSelection(IReadOnlyList<PlcProjectFile> Included, IReadOnlyList<PlcProjectFile> Excluded, IReadOnlyList<TwinCatProjectFile> FullyExcluded, IReadOnlyList<TwinCatProjectFile> PartlyExcluded)`
  - `public static PlcSelection? PlcSelection.Resolve(SolutionFile sln, IReadOnlyList<string> exclude, bool noTests)` (null when both inputs are empty: callers keep today's path; throws `IECodeException(ExitCodes.Usage, …)` per Decisions 1 and 3)
  - `public static bool TestProjects.IsTestProject(string solutionDir, string plcprojPath)` (in `TestProjects.cs`, master plan M3; `PlcSelection` calls it for `--no-tests`)
  - `public bool ExcludesPath(string plcprojPath)` (identity: the full path equals the path of an excluded project; Automation passes `PlcHandle.TreePath`; Decision 8)
  - `public bool ExcludesName(string? projectName)` (true only when the name belongs to exactly one PLC project of the solution and that one is excluded; a duplicated or unknown name is false)
  - `public bool Excludes(Diagnostic d)` (by `File` below an excluded `.plcproj` folder, and by `Project` / the `"<plc>.Library Manager:"` message prefix through `ExcludesName` only; a diagnostic that matches nothing is kept)
  - `public BuildDiagnostics Filter(BuildDiagnostics d, out int dropped)`

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void NoOptionsGivesNull() => Assert.Null(PlcSelection.Resolve(Sln(), [], noTests: false));
[Fact] public void ExcludeByNameIgnoresCase() => Assert.Equal(["Tc3_MotorLib"], Names(PlcSelection.Resolve(Sln(), ["plc"], false)!.Included));
[Fact] public void UnknownNameStops()
{
    var e = Assert.Throws<IECodeException>(() => PlcSelection.Resolve(Sln(), ["Nope"], false));
    Assert.Equal(ExitCodes.Usage, e.ExitCode);
    Assert.Contains("Tc3_MotorLib", e.Hint);
}
[Fact] public void AmbiguousNameStops()   // both PLCs named PLC
    => Assert.Contains("Tc3_MotorLib.Test", Assert.Throws<IECodeException>(() => PlcSelection.Resolve(SlnBothNamedPlc(), ["PLC"], false)).Hint);
[Theory]   // a path value is accepted with either separator (R36)
[InlineData("Tc3_MotorLib.Test/")]
[InlineData("Tc3_MotorLib.Test\\")]
public void FolderPathSelects(string value) => Assert.Single(PlcSelection.Resolve(SlnBothNamedPlc(), [value], false)!.Excluded);
[Fact] public void EverythingExcludedStops() => Assert.Equal(ExitCodes.Usage,
    Assert.Throws<IECodeException>(() => PlcSelection.Resolve(Sln(), ["PLC", "Tc3_MotorLib"], false)).ExitCode);
[Fact] public void NoTestsExcludingEverythingStops()   // every PLC sits in a test folder (R38)
{
    var e = Assert.Throws<IECodeException>(() => PlcSelection.Resolve(SlnOnlyTests(), [], noTests: true));
    Assert.Equal(ExitCodes.Usage, e.ExitCode);
    Assert.Contains("Remove --no-tests or name fewer projects", e.Hint);
}
[Fact] public void NoPlcFoundIsItsOwnMessage()
{
    var e = Assert.Throws<IECodeException>(() => PlcSelection.Resolve(SlnNoPlc(), ["PLC"], false));
    Assert.Equal(ExitCodes.Usage, e.ExitCode);
    Assert.Contains("no PLC project", e.Message);
    Assert.DoesNotContain("--no-tests", e.Hint);   // not the "everything excluded" hint
}
[Fact] public void UnionOfNameAndNoTests()   // Tc3_MotorLib, Tc3_AxisLib and the test PLC
{
    var s = PlcSelection.Resolve(SlnThree(), ["Tc3_AxisLib"], noTests: true)!;
    Assert.Equal(["PLC", "Tc3_AxisLib"], Names(s.Excluded).Order());
    Assert.Equal(["Tc3_MotorLib"], Names(s.Included));
}
[Fact] public void NoTestsWithoutTestProjectsIsNotAnError() => Assert.Empty(PlcSelection.Resolve(SlnWithoutTests(), [], noTests: true)!.Excluded);
[Fact] public void SplitLayoutMarksFullyExcluded() => Assert.Equal("Tc3_MotorLib.Test", Assert.Single(PlcSelection.Resolve(Sln(), [], true)!.FullyExcluded).Name);
[Fact] public void PartialTwinCatProjectIsMarked() => Assert.Single(PlcSelection.Resolve(SlnShared(), [], true)!.PartlyExcluded);
[Fact] public void LibraryManagerLineOfExcludedPlcIsDropped()
{
    var s = PlcSelection.Resolve(Sln(), [], true)!;
    var d = new BuildDiagnostics(
        [new(Severity.Error, "PLC.Library Manager: Library 'Tc3_MotorLib, 1.3.0.0 (Example)' could not be found", Project: "PLC"),
         new(Severity.Error, "C0077: Unknown type 'FB_Axis'", Project: "Tc3_MotorLib")], []);
    var kept = s.Filter(d, out var dropped);
    Assert.Equal(1, dropped);
    Assert.Equal("Tc3_MotorLib", Assert.Single(kept.Raw).Project);
}
[Fact] public void DiagnosticWithoutProjectIsKept()   // the generic last line still fails (R36)
    => Assert.Single(PlcSelection.Resolve(Sln(), [], true)!.Filter(new([new(Severity.Error, "The operation could not be completed.")], []), out _).Raw);
[Fact] public void DuplicateTreeNameKeepsTheLibraryPlcsDiagnostics()   // both PLCs are named PLC (R31)
{
    var s = PlcSelection.Resolve(SlnBothNamedPlc(), [], true)!;
    var d = new BuildDiagnostics([new(Severity.Error, "C0077: Unknown type 'FB_Axis'", Project: "PLC")], []);
    Assert.Single(s.Filter(d, out var dropped).Raw);
    Assert.Equal(0, dropped);   // the name is not unique, so it proves nothing: kept when unsure
}
[Fact] public void DiagnosticOfExcludedFileIsDroppedWhenNamesCollide()
{
    var s = PlcSelection.Resolve(SlnBothNamedPlc(), [], true)!;
    var inTest = new Diagnostic(Severity.Error, "C0077: Unknown type 'X'", File: ws["Tc3_MotorLib.Test/PLC/POUs/MAIN.TcPOU"], Project: "PLC");
    var inLib = new Diagnostic(Severity.Error, "C0077: Unknown type 'Y'", File: ws["Tc3_MotorLib/PLC/POUs/MAIN.TcPOU"], Project: "PLC");
    var kept = s.Filter(new([inTest, inLib], []), out var dropped);
    Assert.Equal(1, dropped);
    Assert.Equal(inLib, Assert.Single(kept.Raw));
}
[Fact] public void ExcludesPathByIdentity()
{
    var s = PlcSelection.Resolve(SlnBothNamedPlc(), [], true)!;
    Assert.True(s.ExcludesPath(ws["Tc3_MotorLib.Test/PLC/PLC.plcproj"]));
    Assert.False(s.ExcludesPath(ws["Tc3_MotorLib/PLC/PLC.plcproj"]));
}
[Fact] public void ExcludesNameOnlyWhenUnique()
{
    var s = PlcSelection.Resolve(Sln(), [], true)!;
    Assert.True(s.ExcludesName("PLC"));
    Assert.False(s.ExcludesName("Tc3_MotorLib"));
    Assert.False(s.ExcludesName("Nope"));
    Assert.False(PlcSelection.Resolve(SlnBothNamedPlc(), [], true)!.ExcludesName("PLC"));   // duplicated name
}
[Fact] public void ResolveOnCopyRootedSolution()   // --isolate: the shell works on the copy (R32)
{
    var copy = CopyOfSln();   // the fixture workspace `ws` copied to another root (a plain folder copy); copy.Root, copy.Solution
    var s = PlcSelection.Resolve(SolutionFile.Load(copy.Solution), [], true)!;
    Assert.True(s.ExcludesPath(Path.Combine(copy.Root, "Tc3_MotorLib.Test", "PLC", "PLC.plcproj")));
    Assert.False(s.ExcludesPath(ws["Tc3_MotorLib.Test/PLC/PLC.plcproj"]));   // original path: no hit
    var d = new Diagnostic(Severity.Error, "C0077: Unknown type 'X'", File: Path.Combine(copy.Root, "Tc3_MotorLib.Test", "PLC", "POUs", "MAIN.TcPOU"));
    s.Filter(new([d], []), out var dropped);
    Assert.Equal(1, dropped);
}
```

`TestProjectsTests.cs` (the folder rule, M3; every path through `Path.Combine`, so it passes on ubuntu, R36 and R37):

```csharp
public sealed class TestProjectsTests
{
    private static readonly string Root = Path.Combine(Path.GetTempPath(), "r");
    private static string P(string relative) => Path.Combine(Root, Path.Combine(relative.Split('/')));

    [Theory]
    [InlineData("Tc3_MotorLib.Test/PLC/PLC.plcproj", true)]
    [InlineData("UnitTest/PLC/PLC.plcproj", true)]
    [InlineData("tests/PLC/PLC.plcproj", true)]
    [InlineData("Tc3_MotorLib/PLC/PLC.plcproj", false)]
    [InlineData("Testbench/PLC/PLC.plcproj", false)]
    [InlineData("Lib.UnitTests/PLC/PLC.plcproj", false)]   // R37: not detected, only the documented pattern is
    [InlineData("Lib_Test/PLC/PLC.plcproj", false)]        // R37: not detected
    [InlineData("Samples/Tests/Demo/Demo.plcproj", true)]  // R37: any whole segment named Tests counts, documented; --exclude-plc is the exact tool
    public void TestFolderRule(string relative, bool expected) => Assert.Equal(expected, TestProjects.IsTestProject(Root, P(relative)));

    [Fact] public void FoldersAboveTheSolutionAreIgnored()
        => Assert.False(TestProjects.IsTestProject(Path.Combine(Root, "Tests", "r"), Path.Combine(Root, "Tests", "r", "Tc3_MotorLib", "Tc3_MotorLib.plcproj")));

    [Fact] public void BothSeparatorsAreNormalised()   // R36
    {
        Assert.True(TestProjects.IsTestProject(Root, Root + "/Tc3_MotorLib.Test\\PLC/PLC.plcproj"));
        Assert.False(TestProjects.IsTestProject(Root, Root + "\\Tc3_MotorLib/PLC\\PLC.plcproj"));
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*PlcSelectionTests"` (and once with `"*TestProjectsTests"`)
Expected: build error, `PlcSelection` and `TestProjects` not defined.

- [ ] **Step 3: Implement `TestProjects.IsTestProject`** in `TestProjects.cs` (both separators normalised before the segments are compared; the documented pattern only, the README says so, R37), then **`PlcSelection`** in `PlcSelection.cs`. Paths are compared with `OrdinalIgnoreCase` on Windows, `Ordinal` elsewhere (the same rule as the private `Isolation.PathComparison`, `Isolation.cs:67`; repeat it, do not make it public); the `Testbench` case pins whole-segment matching. `Filter` applies to `Raw` and `Shown` alike and matches by identity (Decision 8: file path, unique names only).

- [ ] **Step 4: Run to verify they pass** (commands of step 2). Expected: all green, also on ubuntu (all fixture paths come from `Path.Combine` / `ws[...]`, no drive-letter or backslash literal runs there, R36).

- [ ] **Step 5: Commit**

```bash
git add cli/src/IECode.Core/Projects/PlcSelection.cs cli/src/IECode.Core/Projects/TestProjects.cs cli/tests/IECode.Core.Tests/PlcSelectionTests.cs cli/tests/IECode.Core.Tests/TestProjectsTests.cs
git commit -s -m "Add PlcSelection to leave PLC projects out of a build" -m "Library solutions carry a test project that pins the library version being built, so the full build fails. The selection rules (names, test folders, ambiguity) live in Core where they can be tested without TwinCAT."
```

### Task 3: `check --exclude-plc` / `--no-tests`

Starts only after Task 2 and Task 1 step 1 (the recorded names and `PathName`, R41); no name-suffix guess is coded before that record exists. Independent of the build path outcome.

**Files:**
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`CheckAllObjects(PlcSelection? only = null)`: skip handles with `only.ExcludesPath(plc.TreePath)` (identity, Decision 8; `XaeShell.Plc.cs:27-30`), log `Skipping <name> (excluded)`; filter `diags` with `only.Filter` before `BuildOutcome.Ok`)
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Check`: options `--exclude-plc` (`Option<string[]>`, "PLC project to leave out (name or path); repeat for several") and `--no-tests` ("Leave out PLC projects in test folders (*.Test, Test(s), UnitTest(s))"); resolve once from `SolutionFile.Load(path)`; pre-flight on `selection?.Included ?? all`; JSON adds `excludedPlc`, `excludedDiagnostics`)

**Interfaces:**
- Consumes: `PlcSelection.Resolve`, `ExcludesPath`, `Filter` (Task 2).
- Produces: `public (int Errors, int Warnings, bool Ok, int ExcludedDiagnostics) XaeShell.CheckAllObjects(PlcSelection? only = null)` (the one caller, `ProjectCommands.cs:213`, is adapted); a shared private `static PlcSelection? ProjectCommands.ResolveSelection(Context ctx, SolutionFile sln, string[] exclude, bool noTests)` helper (calls `Resolve`, logs `Excluding: …` or the `Detail` line of Decision 3) reused by Task 4.

- [ ] **Step 1:** add a test to `PlcSelectionTests`: `ExcludesTreePathOfTheNestedProject` (`ExcludesPath(<the nested `PathName` as recorded in Task 1 step 1, rebuilt with `ws[...]`>)` is true for the excluded `.plcproj` and false for the library's; if step 1 shows that `PathName` is not the `.plcproj` path, the test pins the recorded form instead, and `ExcludesName` for the names step 1 shows to be unique). `ExcludesPathByIdentity` and `ExcludesNameOnlyWhenUnique` of Task 2 already cover the Core rule.
- [ ] **Step 2:** run it, see it fail; implement; run the class, green.
- [ ] **Step 3:** wire `check`; `dotnet build cli/IECode.slnx`, expected: builds without warnings.
- [ ] **Step 4 (manual, TwinCAT PC, 10 min):** `iecode check <layout a> --no-tests --json` exits 0, `excludedPlc: ["PLC"]`; without `--no-tests` it exits 10 with the library-not-found root cause; same on layout b, 4024 and 4026.
- [ ] **Step 5: Commit** (`git commit -s`, subject "Let check leave out the test project", body: why; check runs per PLC, so no build-level support is needed).

### Task 4: `build --exclude-plc` / `--no-tests` (path from Task 1)

Dropped when Task 1 chose path D.

**Files:**
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`Build(string? platform, bool save = true, PlcSelection? only = null)`; `BuildResult` gets the optional trailing field `int ExcludedDiagnostics = 0`, set from `Filter`'s `dropped`, R39)
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Build`: same two options, validator, `BuildAll` passes the selection, `BuildIsolated` resolves against `copy.Solution` and applies path C; JSON `excludedPlc` and `excludedDiagnostics` once at run level, the latter the sum of the builds' `ExcludedDiagnostics`, R39)
- Path C only: `cli/src/IECode.Core/Projects/SolutionFile.cs` (`TwinCatProjectFile.SolutionGuid` from the `.sln` project line, R33), `PlcSelection.cs`; path C-ts only: `PlcSelection.cs`
- Test: `cli/tests/IECode.Core.Tests/PlcSelectionTests.cs`; path A: `cli/tests/IECode.Core.Tests/BuildTriageTests.cs`

**Interfaces:**
- Consumes: Task 2 and 3 symbols.
- Produces (per path, only the chosen one is built):
  - A: private `BuildProjectsCore(IReadOnlyList<string> uniqueNames, string solutionConfig)`: one `b.BuildProject(cfg, name, false)` per included unit with the existing `BuildState` poll, timeout and dialog check; `failedProjects` summed over `LastBuildInfo` after each call. Unique names come from the live `Project.UniqueName` (A-ts) or the nested names of step 1 (A-plc). The pane is cleared before each call (`ClearErrorList`, which already skips the first one after open so the load output is kept) and its summary is parsed per call; `public static BuildSummary BuildSummary.Sum(IEnumerable<BuildSummary?> parts)` adds the parts into the one summary of the `BuildResult` (R35, premise 17). If step 2 showed the Error List is not reset by the second call, its items are de-duplicated by (project, code, file, line, text) before `BuildTriage.Combine`.
  - B (tsproj-level, split layout only): private `ShouldBuildScope(PlcSelection only) : IDisposable`, created inside each `BuildCore` call after `SelectPlatform` and `SaveAll`, so it reads the contexts of the platform that is active for that call. It sets `ShouldBuild = false` on the contexts of the fully excluded `.tsproj` entries and in `Dispose` (a `finally`) restores the old values and saves again, so the `.sln` ends as it began. No sticky `DiscardChanges`: a saving build keeps saving, a no-save build keeps its existing flag (R34, premise 15).
  - C (tsproj-level, split layout only): `public static string PlcSelection.DisableBuild(string slnText, IEnumerable<string> tsprojGuids)` removes `{GUID}.*.Build.0 = …` lines (case-insensitive GUID); the GUIDs are `FullyExcluded[i].SolutionGuid`, read from the `.sln` project line (premise 14). `ProjectCommands.BuildIsolated` applies it to `copy.Solution` before `WithShell`. Without `--isolate`: exit 2, `"--exclude-plc / --no-tests need --isolate on this TwinCAT version."`, hint names `--isolate`.
  - C-ts (shared layout under `--isolate`, only if U6 passed): `public static string PlcSelection.RemovePlcEntry(string tsprojText, string plcprojFileName)` removes the inline `<Project PrjFilePath="…plcproj">` entry of that PLC from the copy's `.tsproj`; a PLC that is referenced through `_Config\PLC\*.xti` instead is exit 2 with the same hint.

- [ ] **Step 1: Write the failing test** for the Core part of the chosen path. Path C: `DisableBuildRemovesOnlyBuildLinesOfTheGuid` (input `.sln` text with `ActiveCfg` and `Build.0` lines for two GUIDs; output keeps both `ActiveCfg` lines and the other GUID's `Build.0`), `DisableBuildIgnoresGuidCase`, `SolutionGuidComesFromTheSlnLine` (the `.sln` line `Project("{…}") = "Tc3_MotorLib.Test", "Tc3_MotorLib.Test/Tc3_MotorLib.Test.tsproj", "{AAAA…}"` gives `SolutionGuid == "{AAAA…}"`, not the GUID inside the `.plcproj`). Path C-ts: `RemovePlcEntryRemovesOnlyThatProject` (a `.tsproj` text with two inline `<Project PrjFilePath>` entries keeps the other one and everything else byte for byte) and `RemovePlcEntryOfXtiReferenceStops` (exit 2). Path A: `SummariesAreSummed` in `BuildTriageTests` (`BuildSummary.Sum([new(1, 0, 0, 0), new(2, 1, 0, 3), null])` equals `new(3, 1, 0, 3)`). Paths A / B: `UniqueNamesOfIncludedProjects` (A-ts: `FullyExcluded` maps to the `.sln`-relative `.tsproj` paths that are left out, the rest stay, `/` and `\` normalised) as a pure `public IReadOnlyList<string> PlcSelection.BuildUnits(string solutionDir)`.
- [ ] **Step 2:** run, see it fail (`--filter-class "*PlcSelectionTests"`, and `"*BuildTriageTests"` for path A).
- [ ] **Step 3:** implement the Core part, then the Automation part; `diags` go through `only.Filter` before `BuildOutcome.Ok` in every path (premise 6), and `dropped` goes into `BuildResult.ExcludedDiagnostics`. `BuildIsolated` resolves the selection against `SolutionFile.Load(copy.Solution)` after `Isolation.Create` and before `WithShell` (Decision 9, R32); `ResolveSelection` has already run once on the original solution, so a usage error stops before the copy is made. For path A, a shared-layout `PartlyExcluded` entry that path A cannot split throws exit 2 (Decision 7) unless path B also passed in Task 1 for that layout, then B handles it. The selection is resolved before `WithShell` (exit 2 needs no shell); `excludedPlc` also goes into the `ctx.Log.PartialData` object of the normal path (`ProjectCommands.cs:121`), so an error result still names what was left out.
- [ ] **Step 4:** run the class, green; `dotnet build cli/IECode.slnx`, no warnings.
- [ ] **Step 5 (manual, TwinCAT PC, 20 min):** on layouts a and b, 4024 and 4026: `iecode build <sln> --no-tests --json` exits 0 with `excludedPlc: ["PLC"]` and no `PLC` diagnostics; `--exclude-plc Tc3_MotorLib` alone exits 10 (test PLC still fails); `git status` after a default (saving) build shows no `.sln` change from the selection (path B); `--isolate --no-tests` gives the same result (the selection is effective on the copy, R32), and `--isolate --no-tests` with `--no-save` too; with two `--platform` values (path B) both builds skip the test PLC and `git status` stays clean after the second (R34).
- [ ] **Step 6: Commit** (`git commit -s`, subject "Let build leave out PLC projects", body: why plus the path Task 1 chose and the rejected ones in one sentence).

### Task 5: Docs

**Files:** `cli/README.md` (`build` and `check` rows: `--exclude-plc <name|path>`, `--no-tests`, the folder rule, "exit 2 when a name is unknown or ambiguous or nothing is left"; the `--no-tests` pattern stated as exactly what `TestProjects.IsTestProject` detects, so `Lib.UnitTests` and `Lib_Test` are not detected and a sample inside a folder named `Tests` is (use `--exclude-plc`, R37); `--clean` known limit (R40); under `lib save` one sentence that it compiles only the saved PLC and still opens the solution including the test project), `extension/CHANGELOG.md` (`## Unreleased`: "`iecode build` / `check`: `--exclude-plc` and `--no-tests` leave out PLC projects, e.g. the test project of a library"), `TODO.md` (tick the item; add "`ws build --no-tests` (reuse `PlcSelection`, with plan E)").

- [ ] **Step 1:** write the three changes (path D: only `check` rows, plus the `lib save --install` then `build` workaround).
- [ ] **Step 2 (manual regression checklist, TwinCAT PC with 4024 and 4026, about 0.5 day `[estimated]`, R4 and R41):** run once the code of Tasks 3 and 4 is on the branch, and again on `main` if the pull request changed. For each layout (a split, b shared) and each line (4024, 4026), with `git status --porcelain` clean before and recorded after every run:
  1. `iecode check --no-tests --json`, `iecode build --no-tests --json` and `iecode build --exclude-plc <name> --json`: exit codes and `excludedPlc` as in Tasks 3 and 4; no `.sln`, `.tsproj` or `.plcproj` change in `git status` after the saving default build and after `--no-save`.
  2. Without the options, `build` and `check` behave as before (same exit codes, same output lines).
  3. `--isolate --no-tests` and `--isolate --no-tests --no-save`: same result as without `--isolate`, the original repository untouched (R32).
  4. Two `--platform` values with the path that toggles `ShouldBuild` (path B): both builds skip the test PLC, the `.sln` is unchanged afterwards (R34).
  5. Layout b with the chosen path: it either builds the subset or stops with exit 2 and the hint (Decision 7), never a full build.
  6. `lib save` of the library PLC succeeds with the test project unresolved (U5), and its exit code with `--no-tests` is unchanged (R40).
  7. Joint run with plan F: owned by F's Task 6 (it runs once both are merged, by whichever lands second); nothing to do here beyond keeping `PlcSelection` usable from `BuildIsolated` (R29).
- [ ] **Step 3: Commit** (`git commit -s`, subject "Document leaving PLC projects out of build and check", body: why; findings of step 2 that change the README go in as well).

## Size

Task 1 1.5 h on a TwinCAT PC; Task 2 0.5 day; Task 3 0.25 day plus 10 min PC; Task 4 0.5 to 1 day depending on the path plus 20 min PC; Task 5 1 h plus 0.5 day manual PC check (R4). Total about 2 days plus the 0.5 day check, 2.5 days as an upper bound `[estimated]`.

## Known limits

- The filter drops diagnostics by file path and by project name or prefix only where the name is unique (Decision 8); a diagnostic without any of them (the generic last line) is kept and still fails the build (R36).
- Two PLC projects with the same name in one `.tsproj` cannot be told apart in Error List items if `Project` carries only the `.tsproj` name; the file path rule covers object errors, not library manager lines without a prefix; such a line is kept (when unsure keep) and still fails the build.
- `ws build` keeps building test projects until the follow-up lands (Decision 6).
- `--clean` with `--exclude-plc` / `--no-tests` still cleans the output of the excluded PLC projects (`Clean` runs `SolutionBuild.Clean(true)` on the whole solution, `XaeShell.Build.cs:53`); documented in the README (R40).
- `lib save` of an excluded PLC (or of any PLC) still opens the whole solution including the test project; its exit code with the test project unresolved is a pass criterion of spike step 5 (R40).
- `--no-tests` detects only the documented folder pattern: `Lib.UnitTests` and `Lib_Test` are not found, a sample in a folder named `Tests` is (R37); the README says so.
