# Plan G: Build Without the Test Project (`--exclude-plc` / `--no-tests`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode build` and `iecode check` can leave out PLC projects by name (`--exclude-plc <name>`, repeatable) or by the test folder convention (`--no-tests`), so a library solution builds although its test project pins the library version that is being built.

**Architecture:** A pure Core class `PlcSelection` resolves the options against the `.sln` files (names, folder rule, errors) and filters diagnostics of excluded PLC projects. `check` skips excluded PLC handles (it already runs per PLC). How `build` leaves projects out depends on the spike (Task 1): `SolutionBuild.BuildProject`, `ShouldBuild` per solution context, or a `.sln` edit inside the `--isolate` copy. `lib save` needs no change.

**Tech Stack:** C# .NET 10, xUnit v3, System.CommandLine, COM late binding to the XAE shell (EnvDTE `SolutionBuild`, TwinCAT `ITcSmTreeItem` / `ITcPlcIECProject`).

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 row "Build without the test project" and answer Q7; [TODO.md](../../../TODO.md) "CLI: build and library workflow at scale", item "Build without the test project". Round-1 conventions: [master plan](2026-11-24-cli-build-workflow-master-plan.md) (Global Constraints, Decisions, R1 to R44).

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`; test folders `Tc3_MotorLib.Test`, `UnitTest`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`. Windows-only tests use `Assert.SkipUnless(WindowsOnly.IsWindows, …)`.
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands, nothing heavy in parallel.
- JSON output changes are additive; existing exit codes keep their meaning. This plan adds **no** exit code: usage errors are exit 2 (`ExitCodes.Usage`).
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`; new options a row change in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` (GitHub noreply address).
- All sizes `[estimated]`. Steps that need a TwinCAT PC (4024 and 4026 installed) are marked **manual**.
- Plain `build` / `check` without the new options behave exactly as before (no selection object, no filter, same COM calls).

## Premises checked (static read of `iecode-cli-master`, branch `feature/cli-build-workflow-master` at `0515a61`; re-checked 2026-11-26, no `cli/` change up to `8834930`)

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

**Unverified (TwinCAT PC only) -> Task 1:** (U1) whether `SolutionBuild.BuildProject` accepts a `.tsproj` and/or a nested PLC project unique name and builds only that; (U2) whether `SolutionContexts` list PLC projects and `ShouldBuild = false` skips them, and whether the change reaches the `.sln` on disk; (U3) whether removing the excluded PLC's `.Build.0` lines from the `.sln` (in a copy) skips it; (U4) which names appear in Error List `Project` and in `Build started: Project:` for each PLC project (tree name, nested name, `.plcproj` name); (U5) whether `lib save` succeeds while the test project cannot resolve its pinned library.

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

- Create: `cli/src/IECode.Core/Projects/PlcSelection.cs`, `cli/tests/IECode.Core.Tests/PlcSelectionTests.cs`; create or reuse `cli/src/IECode.Core/Projects/TestProjects.cs` (shared with J, M3: first lane creates it).
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`Build`, `CheckAllObjects` get an optional selection; path B/C helpers), `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Build`, `Check`: options, pre-flight input, JSON), `cli/README.md`, `extension/CHANGELOG.md`, `docs/research/cli-build-workflow.md` (spike result under Q7).
- Only on spike path C: `cli/src/IECode.Core/Projects/PlcProjectFile.cs` (read `<ProjectGuid>`).
- Conflict notes: F (`--tc` matrix) and J (`iecode test`) also edit `ProjectCommands.Build`; per master plan M4 G lands first and does not restructure `BuildIsolated` (path C adds one call between `Isolation.Create` and `WithShell`), F moves it later; E may edit `XaeShell.Build.cs` around `Build`. G keeps `Build(string? platform, bool save = true, PlcSelection? only = null)` as a trailing optional parameter, so callers in E/F compile unchanged. `LibraryCommands.cs`, `WorkspaceCommands.cs`, `Runner.cs` are **not** touched.

## Decisions (planner; the user delegated design decisions)

1. **`--exclude-plc` matches the PLC name or a path.** A name matches `PlcProjectFile.Name` or the `.plcproj` file name (case-insensitive); a value with `/` or `\` or ending in `.plcproj` matches the `.plcproj` path or any folder above it, relative to the solution folder. A name that matches projects in two places is exit 2 with the relative paths in the hint (test projects are often just named `PLC`). Rejected: name only (ambiguous exactly in the case the spec describes).
2. **`--no-tests` folder rule:** a PLC project is a test project when a folder segment of its `.plcproj` path **below the solution folder** equals `Test`, `Tests`, `UnitTest`, `UnitTests` or ends with `.Test` / `.Tests` (case-insensitive, whole segment). Segments above the solution folder are ignored, so a clone under `C:\Tests\` does not exclude everything. Rejected: detect by a reference to a test framework library (an application can reference test helpers; the folder convention is what the run named).
3. **Errors:** unknown `--exclude-plc` value = exit 2 listing the available PLC names; everything excluded = exit 2; `--no-tests` that finds nothing is not an error (`Detail` line). `--exclude-plc` and `--no-tests` combine (union).
4. **Diagnostics of excluded projects are dropped, not shown**, on every path (premise 6); the count goes to a `Detail` line and to JSON `excludedDiagnostics`. JSON `data.excludedPlc` lists the excluded project names (additive, `build` and `check`). The pre-flight checks only included projects.
5. **`lib save` gets no options.** It already compiles only the chosen PLC (premise 11); Task 1 confirms (U5). The documented workaround for a full build stays `lib save --install` first.
6. **`ws build` is not in G.** It builds every solution of a workspace; a `--no-tests` there belongs to E's rework of `ws build` and can reuse `PlcSelection` unchanged (follow-up line in TODO.md, Task 5).
7. **No silent fallback to a full build.** If the chosen path cannot leave a project out (for example path C without `--isolate`), stop with exit 2 and a hint, never build everything.

## Review Focus

1. **Test project and library PLC in the same `.tsproj`** (one TwinCAT project, two PLCs): a `.tsproj`-level skip cannot work; the plan must pick a PLC-level path or stop (Task 1 records both layouts; Task 4 test `PartialTwinCatProjectIsMarked`).
2. **Two PLC projects both named `PLC`** in `Tc3_MotorLib/` and `Tc3_MotorLib.Test/`: `--exclude-plc PLC` stops with exit 2 and lists both paths; `--exclude-plc Tc3_MotorLib.Test` works (Task 2 tests `AmbiguousNameStops`, `FolderPathSelects`).
3. **Library-not-found lines written while opening the test project** fail the build although the test PLC is skipped: filtered (Task 2 test `LibraryManagerLineOfExcludedPlcIsDropped`, Task 4 manual step).
4. **`ShouldBuild` change written to the `.sln`** when the default build saves: the value is restored in `finally` and the toggle forces discard on close (Task 4 path B, manual `git status` check).
5. **Solution cloned below a folder named `Tests`**: `--no-tests` must not exclude every project (Task 2 test `FoldersAboveTheSolutionAreIgnored`).

---

### Task 1: Spike: can the Automation Interface build a subset? (TwinCAT PC, **manual**, 90 min `[estimated]`, gates Tasks 3 and 4)

Use two throwaway solutions (no internal data in the notes): (a) **split** layout: `Tc3_MotorLib/Tc3_MotorLib.tsproj` (library PLC) and `Tc3_MotorLib.Test/Tc3_MotorLib.Test.tsproj` (PLC named `PLC`) in one `.sln`; (b) **shared** layout: one `.tsproj` with both PLCs. In both, the test PLC pins `Tc3_MotorLib` to a version that is not installed. Run every step on 4024 and on 4026 (`TcXaeShell.DTE.15.0` / `.17.0`), visible shell. A PowerShell session with `$dte = New-Object -ComObject TcXaeShell.DTE.15.0; $dte.MainWindow.Visible = $true; $dte.Solution.Open($sln)`; retry a line that fails with `RPC_E_CALL_REJECTED`. `git status` must be clean before each step; record `git status --porcelain` after each.

- [ ] **Step 1 (U4, names):** list `foreach ($p in $dte.Solution.Projects) { $p.Name; $p.UniqueName; $p.FullName }` and, recursively, `$item.SubProject.UniqueName` of every `ProjectItems` entry; for each PLC record tree name (`TIPC` child `.Name`), nested name and `.plcproj` `<Name>`. Run a full `$dte.Solution.SolutionBuild.Build($true)`; record `Project` of every `$dte.ToolWindows.ErrorList.ErrorItems` item (4026) and every `Build started: Project:` line of the Build pane.
- [ ] **Step 2 (U1, BuildProject):** `$sb = $dte.Solution.SolutionBuild; $cfg = $sb.ActiveConfiguration.Name + '|' + $sb.ActiveConfiguration.PlatformName`; `$sb.BuildProject($cfg, '<library .tsproj UniqueName>', $true)`, then the same with the library PLC's nested `UniqueName` from step 1 (if any). Record: `LastBuildInfo`, the summary line, whether the test PLC appears in the pane (it must not), and whether `_CompileInfo` / `.tmc` of the library PLC were written.
- [ ] **Step 3 (U2, ShouldBuild):** `foreach ($c in $sb.ActiveConfiguration.SolutionContexts) { "$($c.ProjectName) $($c.ShouldBuild)" }`; set `ShouldBuild = $false` on the test project's context (the `.tsproj` in layout a, the PLC entry in layout b if listed), `$sb.Build($true)`, record as in step 2. Then `$dte.Solution.Close($false)` and check whether the `.sln` changed on disk; repeat once with `$dte.Solution.SaveAs($dte.Solution.FullName)` before close to see the save effect.
- [ ] **Step 4 (U3, `.sln` edit):** in a copy, delete the lines `{<test plcproj or tsproj GUID>}.<cfg>.Build.0 = …` from `GlobalSection(ProjectConfigurationPlatforms)`, open, `Build($true)`, record as in step 2.
- [ ] **Step 5 (U5, lib save):** `iecode lib save <sln layout a and b> -o <temp>`; record exit code and whether the test project's errors appear.
- [ ] **Step 6:** write the table (layout x line x step, anonymised) under Q7 in `docs/research/cli-build-workflow.md` and the chosen path; commit (`git commit -s`, subject "Record whether the Automation Interface can build a subset", body: why).

**What each outcome means (first matching row wins, per layout; both layouts must be covered, else the uncovered layout stops with exit 2 per Decision 7):**

| Outcome | Path for Task 4 |
|---|---|
| `BuildProject` on the nested PLC unique name builds only that PLC | **A-plc:** build each included PLC with `BuildProject`, aggregate per call |
| `BuildProject` works only for a `.tsproj` | **A-ts** for TwinCAT projects whose PLCs are all excluded (split layout); shared layout falls to the next row |
| `SolutionContexts` list the excluded project (or PLC) and `ShouldBuild = false` skips it, `.sln` unchanged after `Close(false)` | **B:** toggle, build, restore in `finally`, `DiscardChanges = true` |
| Only the `.sln` edit skips it | **C:** apply the edit to `copy.Solution` inside `--isolate`; without `--isolate` exit 2, hint "add --isolate" |
| Nothing skips the test PLC | **D:** `build` gets no new options; only `check` ships (Task 3), README documents `lib save --install` then `build`; Task 4 is dropped |
| Step 5 fails | Decision 5 is reversed: add a follow-up item for `lib save --exclude-plc`, not in this plan |

The diagnostics filter (Task 2) matches the names found in step 1; if the Error List `Project` is the `.tsproj` name for both PLCs in the shared layout, the filter also drops by object file path below the excluded `.plcproj` folder (`Diagnostic.File`).

### Task 2: Core `PlcSelection` (selection and diagnostics filter)

Runs in parallel with Task 1 (no TwinCAT needed).

**Files:**
- Create: `cli/src/IECode.Core/Projects/PlcSelection.cs`
- Create or reuse: `cli/src/IECode.Core/Projects/TestProjects.cs` (shared with plan J, master plan M3: whichever lane lands first creates it with `IsTestProject`; the other only calls it)
- Test: `cli/tests/IECode.Core.Tests/PlcSelectionTests.cs` (fixtures written with `TempWorkspace`: `Lib.sln` referencing `Tc3_MotorLib\Tc3_MotorLib.tsproj` and `Tc3_MotorLib.Test\Tc3_MotorLib.Test.tsproj`, each with an inline `<Project PrjFilePath="…plcproj">`; library PLC `<Name>Tc3_MotorLib</Name>`, test PLC `<Name>PLC</Name>`)

**Interfaces:**
- Produces:
  - `public sealed record PlcSelection(IReadOnlyList<PlcProjectFile> Included, IReadOnlyList<PlcProjectFile> Excluded, IReadOnlyList<TwinCatProjectFile> FullyExcluded, IReadOnlyList<TwinCatProjectFile> PartlyExcluded)`
  - `public static PlcSelection? PlcSelection.Resolve(SolutionFile sln, IReadOnlyList<string> exclude, bool noTests)` (null when both inputs are empty: callers keep today's path; throws `IECodeException(ExitCodes.Usage, …)` per Decisions 1 and 3)
  - `public static bool TestProjects.IsTestProject(string solutionDir, string plcprojPath)` (in `TestProjects.cs`, master plan M3; `PlcSelection` calls it for `--no-tests`)
  - `public bool Excludes(string? projectName)` (matches excluded `Name`, `.plcproj` file name and the tree / nested names passed in by Automation, case-insensitive)
  - `public bool Excludes(Diagnostic d)` (by `Project`, by the `"<plc>.Library Manager:"` message prefix, and by `File` below an excluded `.plcproj` folder)
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
[Fact] public void FolderPathSelects() => Assert.Single(PlcSelection.Resolve(SlnBothNamedPlc(), [@"Tc3_MotorLib.Test\"], false)!.Excluded);
[Fact] public void EverythingExcludedStops() => Assert.Equal(ExitCodes.Usage,
    Assert.Throws<IECodeException>(() => PlcSelection.Resolve(Sln(), ["PLC", "Tc3_MotorLib"], false)).ExitCode);
[Theory]
[InlineData(@"Tc3_MotorLib.Test\PLC\PLC.plcproj", true)]
[InlineData(@"UnitTest\PLC\PLC.plcproj", true)]
[InlineData(@"tests\PLC\PLC.plcproj", true)]
[InlineData(@"Tc3_MotorLib\PLC\PLC.plcproj", false)]
[InlineData(@"Testbench\PLC\PLC.plcproj", false)]
public void TestFolderRule(string relative, bool expected) => Assert.Equal(expected, TestProjects.IsTestProject(@"C:\r", Path.Combine(@"C:\r", relative)));
[Fact] public void FoldersAboveTheSolutionAreIgnored() => Assert.False(TestProjects.IsTestProject(@"C:\Tests\r", @"C:\Tests\r\Tc3_MotorLib\Tc3_MotorLib.plcproj"));
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*PlcSelectionTests"`
Expected: build error, `PlcSelection` not defined.

- [ ] **Step 3: Implement `PlcSelection`** in `PlcSelection.cs`. Paths are compared with `OrdinalIgnoreCase` on Windows, `Ordinal` elsewhere (the same rule as the private `Isolation.PathComparison`, `Isolation.cs:67`; repeat it, do not make it public); the `Testbench` case pins whole-segment matching. `Filter` applies to `Raw` and `Shown` alike.

- [ ] **Step 4: Run to verify they pass** (commands of step 2). Expected: all green, also on ubuntu (no drive-letter test runs there: guard the `C:\` theory with `Assert.SkipUnless(WindowsOnly.IsWindows, …)` or build the paths from `Path.GetTempPath()`).

- [ ] **Step 5: Commit**

```bash
git add cli/src/IECode.Core/Projects/PlcSelection.cs cli/tests/IECode.Core.Tests/PlcSelectionTests.cs
git commit -s -m "Add PlcSelection to leave PLC projects out of a build" -m "Library solutions carry a test project that pins the library version being built, so the full build fails. The selection rules (names, test folders, ambiguity) live in Core where they can be tested without TwinCAT."
```

### Task 3: `check --exclude-plc` / `--no-tests`

Needs Task 2 and Task 1 step 1 (names). Independent of the build path outcome.

**Files:**
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`CheckAllObjects(PlcSelection? only = null)`: skip handles with `only.Excludes(plc.Name) || only.Excludes(plc.NestedName)`, log `Skipping <name> (excluded)`; filter `diags` with `only.Filter` before `BuildOutcome.Ok`)
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Check`: options `--exclude-plc` (`Option<string[]>`, "PLC project to leave out (name or path); repeat for several") and `--no-tests` ("Leave out PLC projects in test folders (*.Test, Test(s), UnitTest(s))"); resolve once from `SolutionFile.Load(path)`; pre-flight on `selection?.Included ?? all`; JSON adds `excludedPlc`, `excludedDiagnostics`)

**Interfaces:**
- Consumes: `PlcSelection.Resolve`, `Excludes(string?)`, `Filter` (Task 2).
- Produces: `public (int Errors, int Warnings, bool Ok) XaeShell.CheckAllObjects(PlcSelection? only = null)`; a shared private `static PlcSelection? ProjectCommands.ResolveSelection(Context ctx, SolutionFile sln, string[] exclude, bool noTests)` helper (calls `Resolve`, logs `Excluding: …` or the `Detail` line of Decision 3) reused by Task 4.

- [ ] **Step 1:** add a test to `PlcSelectionTests`: `ExcludesTreeAndNestedNames` (`Excludes("PLC Project")` is true when the nested name ends with the excluded name plus `" Project"`, per Task 1 step 1; adjust to the recorded naming).
- [ ] **Step 2:** run it, see it fail; implement; run the class, green.
- [ ] **Step 3:** wire `check`; `dotnet build cli/IECode.slnx`, expected: builds without warnings.
- [ ] **Step 4 (manual, TwinCAT PC, 10 min):** `iecode check <layout a> --no-tests --json` exits 0, `excludedPlc: ["PLC"]`; without `--no-tests` it exits 10 with the library-not-found root cause; same on layout b, 4024 and 4026.
- [ ] **Step 5: Commit** (`git commit -s`, subject "Let check leave out the test project", body: why; check runs per PLC, so no build-level support is needed).

### Task 4: `build --exclude-plc` / `--no-tests` (path from Task 1)

Dropped when Task 1 chose path D.

**Files:**
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`Build(string? platform, bool save = true, PlcSelection? only = null)`)
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`Build`: same two options, validator, `BuildAll` passes the selection, `BuildIsolated` path C; JSON `excludedPlc`, `excludedDiagnostics` per build)
- Path C only: `cli/src/IECode.Core/Projects/PlcProjectFile.cs` (`public string? ProjectGuid { get; init; }` from `<ProjectGuid>`), `PlcSelection.cs`

**Interfaces:**
- Consumes: Task 2 and 3 symbols.
- Produces (per path, only the chosen one is built):
  - A: private `BuildProjectsCore(IReadOnlyList<string> uniqueNames, string solutionConfig)`: one `b.BuildProject(cfg, name, false)` per included unit with the existing `BuildState` poll, timeout and dialog check; `failedProjects` summed over `LastBuildInfo` after each call. Unique names come from the live `Project.UniqueName` (A-ts) or the nested names of step 1 (A-plc).
  - B: private `ShouldBuildScope(PlcSelection only) : IDisposable` sets `ShouldBuild = false` on the contexts of excluded entries after `SaveAll` (so the save never sees it), restores the old values in `Dispose`, and sets `DiscardChanges = true`.
  - C: `public static string PlcSelection.DisableBuild(string slnText, IEnumerable<string> projectGuids)` removes `{GUID}.*.Build.0 = …` lines (case-insensitive GUID); `ProjectCommands.BuildIsolated` applies it to `copy.Solution` before `WithShell`. Without `--isolate`: exit 2, `"--exclude-plc / --no-tests need --isolate on this TwinCAT version."`, hint names `--isolate`.

- [ ] **Step 1: Write the failing test** for the Core part of the chosen path. Path C: `DisableBuildRemovesOnlyBuildLinesOfTheGuid` (input `.sln` text with `ActiveCfg` and `Build.0` lines for two GUIDs; output keeps both `ActiveCfg` lines and the other GUID's `Build.0`), `DisableBuildIgnoresGuidCase`. Paths A / B: `UniqueNamesOfIncludedProjects` (A-ts: `FullyExcluded` maps to the `.sln`-relative `.tsproj` paths that are left out, the rest stay, `/` and `\` normalised) as a pure `public IReadOnlyList<string> PlcSelection.BuildUnits(string solutionDir)`.
- [ ] **Step 2:** run, see it fail (`--filter-class "*PlcSelectionTests"`).
- [ ] **Step 3:** implement the Core part, then the Automation part; `diags` go through `only.Filter` before `BuildOutcome.Ok` in every path (premise 6). For path A, a shared-layout `PartlyExcluded` entry that path A cannot split throws exit 2 (Decision 7) unless path B also passed in Task 1 for that layout, then B handles it. The selection is resolved before `WithShell` (exit 2 needs no shell); `excludedPlc` also goes into the `ctx.Log.PartialData` object of the normal path (`ProjectCommands.cs:121`), so an error result still names what was left out.
- [ ] **Step 4:** run the class, green; `dotnet build cli/IECode.slnx`, no warnings.
- [ ] **Step 5 (manual, TwinCAT PC, 20 min):** on layouts a and b, 4024 and 4026: `iecode build <sln> --no-tests --json` exits 0 with `excludedPlc: ["PLC"]` and no `PLC` diagnostics; `--exclude-plc Tc3_MotorLib` alone exits 10 (test PLC still fails); `git status` after a default (saving) build shows no `.sln` change from the selection (path B); `--isolate --no-tests` gives the same result.
- [ ] **Step 6: Commit** (`git commit -s`, subject "Let build leave out PLC projects", body: why plus the path Task 1 chose and the rejected ones in one sentence).

### Task 5: Docs

**Files:** `cli/README.md` (`build` and `check` rows: `--exclude-plc <name|path>`, `--no-tests`, the folder rule, "exit 2 when a name is unknown or ambiguous or nothing is left"; under `lib save` one sentence that it compiles only the saved PLC), `extension/CHANGELOG.md` (`## Unreleased`: "`iecode build` / `check`: `--exclude-plc` and `--no-tests` leave out PLC projects, e.g. the test project of a library"), `TODO.md` (tick the item; add "`ws build --no-tests` (reuse `PlcSelection`, with plan E)").

- [ ] **Step 1:** write the three changes (path D: only `check` rows, plus the `lib save --install` then `build` workaround).
- [ ] **Step 2: Commit** (`git commit -s`, subject "Document leaving PLC projects out of build and check", body: why).

## Size

Task 1 1.5 h on a TwinCAT PC; Task 2 0.5 day; Task 3 0.25 day plus 10 min PC; Task 4 0.5 to 1 day depending on the path plus 20 min PC; Task 5 1 h. Total about 2 days `[estimated]`.

## Known limits

- The filter drops diagnostics by project name, prefix and file path; a diagnostic without any of them (the generic last line) is kept and still fails the build (R36).
- Two PLC projects with the same name in one `.tsproj` cannot be told apart in Error List items if `Project` carries only the `.tsproj` name; the file path rule covers object errors, not library manager lines without a prefix.
- `ws build` keeps building test projects until the follow-up lands (Decision 6).
