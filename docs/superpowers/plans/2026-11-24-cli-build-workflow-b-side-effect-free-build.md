# Plan B: Side-effect-free Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `iecode build` leaves the working tree as it was (or says exactly what changed), never moves a project to another TwinCAT line without being told, and can build in a short temporary copy.

**Architecture:** Pure decisions in `IECode.Core`: `TcLineGuard` (which version to use for `auto`), `WorkingTreeSnapshot` (what a build changed), `PathLength` (long-path warning), `Isolation` (copy plan and path mapping). `Runner.WithShell` and `ProjectCommands.Build` wire them; `XaeShell.Build` gets a `save` switch.

**Tech Stack:** C# .NET 10, xUnit v3, git command line (through `IECode.Core.Git`), COM late binding.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 1, 5 (long paths) and answers Q1 to Q3; master plan [decisions 5 to 7](2026-11-24-cli-build-workflow-master-plan.md#decisions-planner-2026-11-24-the-user-delegated-every-decision).

## Eng review amendments (2026-11-24)

The [master plan table](2026-11-24-cli-build-workflow-master-plan.md#eng-review-amendments-2026-11-24) wins over the task text below:
- **Task 1 (R13):** the spike also records whether the noise is written at build time or at `Quit` (check `git status` before closing the shell, with `--visible` and a pause) and how long `Quit` takes.
- **Task 2 (R1, R14):** no `XaeShell.InstalledLines()`. New Core `TwinCatInstall.Builds(string twinCatDir)` lists `Components\Plc\Build_*` (same rule as `RepTool.Find`); `TcLineGuard.Choose(requested, savedStamps, installedBuilds, bool saves)` always gets the list. A line change throws only when `saves` is true; otherwise it returns the stamped or newest build with a `Note` that is printed as a warning. Mixed lines are decided per solution when `StartShell` users open it. Extra tests: `NonSavingCommandWarnsInsteadOfStopping`, `VisualStudioAloneIsNotTwinCat` (no `Build_4026*` folder means no 4026, whatever ProgIDs exist), `BuildsFromFolders`. The stop hint names `--tc` and the VS Code setting `iecode.tcVersion`.
- **Task 3 (R15):** `WorkingTreeSnapshot.Take` returns null when git is missing; test through an internal `Git.Executable` override pointing at a file that does not exist.
- **Task 4 (R13, R16):** with `save: false`, `Dispose` calls `Solution.Close(false)` before `Quit`. The long-path warning suggests `--isolate` only when the planned copy path is shorter.
- **Task 5 (R3, R4, R5, R15, R16, R17):** copy `*.tmc` back after a build (test `CopiesTmcBack`); copy folder `<hash>-<pid>` and cleanup of dead-PID siblings (test `ConcurrentCopiesDoNotCollide`); case-insensitive mapping on Windows only; `RootOf` falls back to the solution folder without git; `--isolate-dir <dir>`; `OutsideRoot` checks every `.sln` project path, every `Include="…"` in `.plcproj` files and every `File="…"` in `.tsproj` / `.xti` files (tests `PlcprojItemOutsideRootIsReported`, `NonTwinCatProjectOutsideRootIsReported`).

**Second opinion (R33, R35, R40):** no `.tmc` copy-back by default (`--copy-tmc` opt-in, only files written after the build started; replaces R3); stop `--isolate` on absolute paths into the source and on `PrjFilePath` / `.tspproj` / `.xti` references leaving the root, skip reparse points, refuse an `--isolate-dir` inside the source, delete sibling copies only when their PID is dead and older than 24 h; `saves` from the effective mode, guard before the first write (`ws release` before `SetProjectVersion`), `Solution.Close(false)` before every solution switch in no-save mode, one shell per line in `ws build` / `save-all`; snapshot compares both sides, parses rename records, hashes listed files, runs after failed builds too; `PathLength` scans project files only.

## Global Constraints

See the [master plan](2026-11-24-cli-build-workflow-master-plan.md#global-constraints). Plan A is merged first; its `build` changes (pre-flight, summary, exit 21) stay intact.

## Review Focus

1. **Solution with projects stamped on different lines** (one `.tsproj` 4024, one 4026): `auto` stops with exit 2 and names both (Task 2 test `MixedLinesStop`).
2. **Exact stamped build not installed but the line is** (stamp `3.1.4024.62`, installed `4024.66`): use `4024.66`, do not fall to the shell default (Task 2 test `StampedBuildMissingFallsBackToLine`). Today this path warns and uses the default shell, which may be 4026.
3. **Isolated build of a solution that references files outside its repository** (`..\shared\Lib.plcproj`): the copy cannot see them; detect references that leave the copy root and stop with a clear message instead of a confusing compile error (Task 5 test `ReferenceOutsideRootIsReported`).
4. **Isolated build: diagnostics point at the temp copy**: every `Diagnostic.File` is mapped back to the original path, also for paths with different case (Task 5 test `MapsDiagnosticPathsBack`).
5. **Build in a folder that is not a git repository**: the changed-files report is skipped silently, no error (Task 3 test `NotARepositoryGivesNull`).

---

### Task 1: Spike: where does the save noise come from? (TwinCAT PC, 30 min, no commit of code)

Decides master plan decision 5. Use a throwaway clone of any repository that showed the noise (`.sln` configuration lines, `Target64Bit`, visualization `DevId`).

- [ ] **Step 1:** `git status` clean; run `iecode build <sln> --tc 4024 -p "TwinCAT RT (x64)"`; record `git status --porcelain` and `git diff --stat`.
- [ ] **Step 2:** `git checkout -- . && git clean -fd`; comment out the `SaveAll();` line in `XaeShell.Build` locally (do not commit), rebuild the CLI, run the same build; record the same output.
- [ ] **Step 3:** Run `iecode check <sln> --tc 4024` on a clean tree (it never saves); record the same output.
- [ ] **Step 4:** Write the three results into `docs/research/cli-build-workflow.md` under Q1 (anonymised file kinds only) and commit that doc change. Decision rule: if step 2 shows none of the `.sln` / `.tspproj` / `.TcVMO` changes, Task 4 makes no-save the default; if it still shows them, Task 4 adds `--no-save` as an option only, keeps the default, and the CHANGELOG points at `--isolate`.

### Task 2: `TcLineGuard`: `auto` never changes the line silently

**Files:**
- Create: `cli/src/IECode.Core/TcLineGuard.cs`
- Modify: `cli/src/IECode.Cli/Runner.cs` (`WithShell`, `StartShell`)
- Modify: `cli/src/IECode.Automation/XaeShell.cs` (new `public static IReadOnlyList<int> InstalledLines()`: lines whose candidate ProgIDs resolve with `Type.GetTypeFromProgID`, no shell start)
- Test: `cli/tests/IECode.Core.Tests/TcLineGuardTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record TcChoice(TwinCatVersion Request, string? Note);`
  - `public static class TcLineGuard { public static TcChoice Choose(TwinCatVersion requested, IReadOnlyList<string?> savedStamps, IReadOnlyList<int> installedLines, IReadOnlyList<string>? installedBuilds); }` throws `IECodeException` with exit 2 or 15. `installedBuilds` is null when unknown before the shell starts (then the exact-build fallback happens in `XaeShell.SelectVersion` as today).

- [ ] **Step 1: Write the failing tests**

```csharp
static readonly int[] Both = [4024, 4026];

[Fact] public void ExplicitRequestIsKept() =>
    Assert.Equal(4026, TcLineGuard.Choose(TwinCatVersion.Parse("4026"), ["3.1.4024.66"], Both, null).Request.Line);

[Fact] public void AutoUsesTheStamp() =>
    Assert.Equal("3.1.4024.66", TcLineGuard.Choose(TwinCatVersion.Auto, ["3.1.4024.66"], Both, null).Request.ToString());

[Fact] public void StampedBuildMissingFallsBackToLine() =>
    Assert.Equal("3.1.4024.66", TcLineGuard.Choose(TwinCatVersion.Auto, ["3.1.4024.62"], Both, ["3.1.4024.66", "3.1.4026.12"]).Request.ToString());

[Fact] public void StampedLineNotInstalledStops() =>
    Assert.Equal(ExitCodes.VersionNotInstalled, Assert.Throws<IECodeException>(() =>
        TcLineGuard.Choose(TwinCatVersion.Auto, ["3.1.4024.66"], [4026], null)).ExitCode);

[Fact] public void NoStampAndBothLinesStops()
{
    var e = Assert.Throws<IECodeException>(() => TcLineGuard.Choose(TwinCatVersion.Auto, [null], Both, null));
    Assert.Equal(ExitCodes.Usage, e.ExitCode);
    Assert.Contains("--tc", e.Hint);
}

[Fact] public void NoStampAndOneLineIsFine() =>
    Assert.True(TcLineGuard.Choose(TwinCatVersion.Auto, [null], [4024], null).Request.IsAuto);

[Fact] public void MixedLinesStop() =>
    Assert.Contains("4024", Assert.Throws<IECodeException>(() =>
        TcLineGuard.Choose(TwinCatVersion.Auto, ["3.1.4024.66", "3.1.4026.12"], Both, null)).Message);
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*TcLineGuardTests"`
Expected: build error, `TcLineGuard` not defined.

- [ ] **Step 3: Implement `TcLineGuard.Choose` and wire it**

In `Runner.WithShell` replace the stamp block: `var choice = TcLineGuard.Choose(ctx.Version, slnFile.TwinCatProjects.Select(p => p.TcVersion).ToList(), XaeShell.InstalledLines(), null);`, log `choice.Note` with `Detail`. Remove the `catch (... VersionNotInstalled)` fallback that used the shell default when `auto` was given; instead, when `SelectVersion` fails for an exact stamped build, retry with the line only (`new TwinCatVersion(build, null)`), and only then fail with exit 15. `StartShell` (several solutions, `ws build`, `lib save-all`) with `auto`: apply the guard to the stamps of all solutions it will open (pass them in as a new parameter `IReadOnlyList<string?> stamps`).

- [ ] **Step 4: Run to verify they pass**

Run: the commands of step 2, then `dotnet build cli/IECode.slnx`. Expected: pass, solution builds.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Stop when --tc auto would move a project to another TwinCAT line" -m "A build without --tc saved three projects with 4026 and the 4024 shell could not open them again; auto now uses the stamped line or asks for --tc instead of falling back to the newest shell."
```

### Task 3: Report what a build changed (`WorkingTreeSnapshot`)

**Files:**
- Create: `cli/src/IECode.Core/WorkingTreeSnapshot.cs`
- Modify: `cli/src/IECode.Core/Git.cs` (make the private `Run` reachable through a new `public IReadOnlyList<(string Code, string Path)> StatusEntries()` that parses `git status --porcelain=v1 -z --untracked-files=all`)
- Test: `cli/tests/IECode.Core.Tests/WorkingTreeSnapshotTests.cs` (creates a temp git repository with `git init`; skip with the existing `WindowsOnly`-style attribute pattern if git is missing)

**Interfaces:**
- Produces:
  - `public sealed class WorkingTreeSnapshot { public static WorkingTreeSnapshot? Take(string folder); public IReadOnlyList<string> ChangedSince(WorkingTreeSnapshot before); }`
  - A snapshot holds, for every path in `StatusEntries()`, the status code plus file length and last write time (UTC). `ChangedSince` returns repository-relative paths (`/`) that are new in the status list or whose code, length or time differ; sorted.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void NotARepositoryGivesNull() => Assert.Null(WorkingTreeSnapshot.Take(Path.GetTempPath()));

[Fact] public void ReportsNewAndModifiedFiles()
{
    using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
    var before = WorkingTreeSnapshot.Take(repo.Root)!;
    File.WriteAllText(repo["a.TcPOU"], "y");
    File.WriteAllText(repo["b.sln"], "z");
    Assert.Equal(["a.TcPOU", "b.sln"], WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
}

[Fact] public void FileDirtyBeforeAndTouchedAgainIsReported()
{
    using var repo = TempRepo.WithCommittedFile("a.TcPOU", "x");
    File.WriteAllText(repo["a.TcPOU"], "y");
    var before = WorkingTreeSnapshot.Take(repo.Root)!;
    File.WriteAllText(repo["a.TcPOU"], "yy");
    Assert.Equal(["a.TcPOU"], WorkingTreeSnapshot.Take(repo.Root)!.ChangedSince(before));
}

[Fact] public void UnchangedTreeGivesEmptyList() { /* take twice, assert empty */ }
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*WorkingTreeSnapshotTests"`
Expected: build error.

- [ ] **Step 3: Implement**, then in `ProjectCommands.Build`: take a snapshot of the solution folder before `WithShell`, compare after; print `Changed files: N` (`Info`) and the list with `-v`; add `changedFiles` (list of paths) to the JSON `data`. Skip both when `Take` returns null.

- [ ] **Step 4: Run to verify they pass**

Run: the commands of step 2. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "List the files a build changed" -m "Builds left tracked files modified without saying so; the list makes the side effects visible before they are committed by accident."
```

### Task 4: `build` without `SaveAll` and the long-path warning

**Files:**
- Modify: `cli/src/IECode.Automation/XaeShell.Build.cs` (`public BuildResult Build(string? platform, bool save = true)`)
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`--save` or `--no-save` per the Task 1 decision; `activate` keeps `save: true`)
- Modify: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs` (`ws build` follows `build`)
- Create: `cli/src/IECode.Core/PathLength.cs`
- Test: `cli/tests/IECode.Core.Tests/PathLengthTests.cs`

**Interfaces:**
- Produces: `public static class PathLength { public const int WarnAt = 200; public static string? Longest(string root); }` (the longest full file path below `root`, or null if none is `>= WarnAt`; skips `.git`).

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void ShortTreeGivesNull() { using var ws = new TempWorkspace(); ws.Touch("a/b.TcPOU"); Assert.Null(PathLength.Longest(ws.Root)); }

[Fact] public void ReportsThePathAtTheLimit()
{
    using var ws = new TempWorkspace();
    var deep = ws.Touch(string.Join('/', Enumerable.Repeat("folder_name_x", 20)) + "/Visualization Manager.TcVMO");
    Assert.Equal(deep, PathLength.Longest(ws.Root));
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*PathLengthTests"`
Expected: build error.

- [ ] **Step 3: Implement** `PathLength.Longest`; in `ProjectCommands.Build` warn before the shell starts: `Path of <n> characters: <path>. Hidden shells may show dialogs for long paths; try --isolate.` Then the save switch per Task 1.

- [ ] **Step 4: Run to verify**

Run: the commands of step 2, then `dotnet build cli/IECode.slnx`. Expected: pass, solution builds.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Build without saving the solution first" -m "The explicit SaveAll before every build wrote configuration lines and machine-dependent IDs into tracked files although the CLI changed nothing; activate still saves because it needs the target settings on disk."
```

(If Task 1 kept the default, the subject is "Add --no-save to build" and the body says why the default stays.)

### Task 5: `build --isolate`

**Files:**
- Create: `cli/src/IECode.Core/Isolation.cs`
- Modify: `cli/src/IECode.Cli/Commands/ProjectCommands.cs` (`--isolate`, `--keep-isolated`)
- Test: `cli/tests/IECode.Core.Tests/IsolationTests.cs`

**Interfaces:**
- Consumes: `Git.Open` (root), `SolutionFile.Load`, `PlcProjectFile` paths.
- Produces:
  - `public sealed record IsolatedCopy(string SourceRoot, string CopyRoot, string Solution) : IDisposable;` (`Dispose` deletes `CopyRoot` unless `Keep` is set; `public bool Keep { get; init; }`)
  - `public static class Isolation { public static readonly string[] Excluded = [".git", ".vs", "_CompileInfo", "_Boot"]; public static string RootOf(string solution); public static IReadOnlyList<string> OutsideRoot(string solution, string root); public static IsolatedCopy Create(string solution, string tempBase); public static Diagnostic MapBack(Diagnostic d, IsolatedCopy copy); }`
  - Copy folder: `Path.Combine(tempBase, "b", <first 8 hex chars of SHA-256 of the lower-case source root>)`; `tempBase` default `%TEMP%\iecode` in the command, a temp folder in tests. An existing copy folder of the same hash is deleted first.

- [ ] **Step 1: Write the failing tests** (`TempWorkspace` with a small tree: `sln/Machine.sln`, `sln/PLC1/PLC1.plcproj`, `sln/PLC1/Gen/Generated.TcGVL` as an ignored file, `sln/.vs/x`, `sln/PLC1/_CompileInfo/y`)

```csharp
[Fact] public void CopiesIgnoredFilesButNotBuildOutput()
{
    using var copy = Isolation.Create(ws["sln/Machine.sln"], tempBase);
    Assert.True(File.Exists(Path.Combine(copy.CopyRoot, "PLC1", "Gen", "Generated.TcGVL")));
    Assert.False(Directory.Exists(Path.Combine(copy.CopyRoot, ".vs")));
    Assert.False(Directory.Exists(Path.Combine(copy.CopyRoot, "PLC1", "_CompileInfo")));
    Assert.Equal(Path.Combine(copy.CopyRoot, "Machine.sln"), copy.Solution);
}

[Fact] public void CopyIsDeletedOnDispose() { /* Create, Dispose, assert CopyRoot does not exist */ }

[Fact] public void MapsDiagnosticPathsBack()
{
    using var copy = Isolation.Create(ws["sln/Machine.sln"], tempBase);
    var d = new Diagnostic(Severity.Error, "x", File: Path.Combine(copy.CopyRoot.ToUpperInvariant(), "PLC1", "POUs", "FB_A.TcPOU"));
    Assert.Equal(ws["sln/PLC1/POUs/FB_A.TcPOU"], Isolation.MapBack(d, copy).File, ignoreCase: true);
}

[Fact] public void ReferenceOutsideRootIsReported()
{
    // the .sln references ..\shared\Lib\Lib.tsproj
    Assert.Single(Isolation.OutsideRoot(ws["sln/Machine.sln"], ws["sln"]));
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `dotnet build cli/tests/IECode.Core.Tests` then `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*IsolationTests"`
Expected: build error.

- [ ] **Step 3: Implement** `Isolation`; `RootOf` = git top level of the solution folder if inside a repository, else the solution folder. `OutsideRoot` lists project paths from the `.sln` (and `.tsproj` / `.plcproj` paths known to `SolutionFile`) that resolve outside `root`. In `ProjectCommands.Build` with `--isolate`: stop with exit 2 when `OutsideRoot` is not empty (message lists the paths); `using var copy = Isolation.Create(...)`; build `copy.Solution` with `save: false`; map every diagnostic with `MapBack` before it reaches the reporter (pass a mapper into `XaeShell.Build` or map in `Reporter.Add` through a `Func<Diagnostic, Diagnostic>` property; choose the reporter property, `Reporter.MapDiagnostic`, so `check` can reuse it); skip the changed-files report (nothing in the source changes); `--keep-isolated` sets `Keep` and prints the copy path. Log `Isolated copy: <path> (<n> files, <s> s)`.

- [ ] **Step 4: Run to verify they pass**

Run: the commands of step 2. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src cli/tests
git commit -s -m "Add build --isolate to build in a temporary copy" -m "Generated library caches and external resources change the tree on every build and long paths make hidden shells show dialogs; a short copy avoids both. The copy includes ignored files because one project needed a generated folder that git archive left out."
```

### Task 6: Docs and the check on a TwinCAT PC

**Files:** `cli/README.md` (`build` row: `--save`/`--no-save`, `--isolate`, `--keep-isolated`; `--tc auto` text in Global options), `extension/CHANGELOG.md`.

- [ ] **Step 1:** Update README and CHANGELOG (name the `auto` behaviour change: the extension's default `iecode.tcVersion: auto` now stops on unstamped projects when both lines are installed and says to set the version).
- [ ] **Step 2 (TwinCAT PC, 20 min):** on the repository of Task 1: `iecode build <sln> --tc 4024` gives `Changed files: 0` (or only the generated files Task 1 found); `iecode build <sln> --isolate` gives the same diagnostics as a normal build and `git status` stays clean; an unstamped project with both lines installed stops with exit 2.
- [ ] **Step 3:** Commit docs (`git commit -s`, subject "Document side-effect-free build options", body: why).

## Known limits

- `--isolate` copies the whole repository on every run (no cache); large repositories take seconds to minutes.
- `--isolate` refuses solutions whose projects live outside the copy root; a later option could widen the root.
- The changed-files report compares status, length and write time, not content: a file rewritten with identical bytes and an unchanged time is not reported.
