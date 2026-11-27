# Plan H: `iecode lib project-folder sync [--prune]` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring each PLC project's tracked `_Libraries` folder in line with the project's library resolutions: copy the referenced versions from the library repository, and with `--prune` drop other versions of those libraries. No TwinCAT needed.

**Architecture:** `ProjectFolderSync` (pure Core, `IECode.Core.Projects`) plans per project (add / update / unchanged / missing / prune / stale / kept) and applies a plan to the file system. `LibraryCommands` adds the `project-folder sync` command and only wires scan, plan, lock, apply and output. It is the reverse of `lib install-project` (project folder into repository).

**Tech Stack:** C# .NET 10, xUnit v3, `System.IO` only.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 (row "Sync tracked `_Libraries` with the resolutions"); [TODO.md](../../../TODO.md) "CLI: build and library workflow at scale".

**Size:** 4 tasks, about 450 lines of code and tests `[estimated]`, 1 to 1.5 days `[estimated]`.

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` only wires them. There is no test project for `IECode.Cli`. Windows-only tests use `Assert.SkipUnless(WindowsOnly.IsWindows, ...)`.
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ProjectFolderSyncTests"` through the PowerShell tool; `dotnet build cli/tests/IECode.Core.Tests` and `dotnet test` as separate commands.
- JSON output changes are additive; existing exit codes keep their meaning. This plan adds **no** exit code: missing versions are 3 (`NotFound`), a failed copy or delete is 12 (`LibraryFailed`), a lock timeout stays 17.
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, a row in the command table of `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s`.
- All sizes tagged `[estimated]`.
- Sync never writes outside `<project>/_Libraries`, never creates a `_Libraries` folder that does not exist, and never deletes anything that is not a library version folder (see decision 5).

## Premises checked (branch `feature/cli-build-workflow-master`, tip `0515a61`)

Re-checked against `0515a61`: every file cited below is byte-identical to the earlier base (`FileReady.cs` differs only in line endings), so all line numbers hold. Exit codes live in `cli/src/IECode.Core/Errors.cs` (`NotFound = 3` `:9`, `LibraryFailed = 12` `:12`, `Timeout = 17` `:17`). New for this plan: `Isolation.DeleteFolder(string dir)` (`cli/src/IECode.Core/Isolation.cs:400-406`, `internal static`, clears read-only, skips reparse points) is reused by Task 2.

1. `_Libraries` layout is `<vendor>/<library>/<version>/<file>` next to the .plcproj: `cli/src/IECode.Core/Projects/ProjectLibraries.cs:7-10`, `FolderOf` `:17-18`, `FolderName` `:14`.
2. A project-folder version counts only when its folder name starts with a digit and holds a library file (`.library`, `.compiled-library*`): `ProjectLibraries.cs:30-32`, `IsLibraryFile` `:39-44`; pinned by `WorkspaceTests.cs:100,106` (`Tc3_Empty/1.0.0/readme.txt` skipped). This is "the round-1 rule". Fixtures mix case (`Acme/Tc3_MotorLib` and `acme/tc3_motorlib`): `WorkspaceTests.cs:98-99`.
3. `LibraryRepository.Scan` applies the same round-1 rule: it skips a version folder without a library file (`LibraryRepository.cs:51`, comment "an empty folder is what an interrupted install or removal leaves"), so a half-installed repository version never appears in `installed`. `InstalledLibrary.Path` is the version folder. Names are lower-case on disk in the repository: `:8`. (Corrected in review, R39: this premise said the opposite.)
4. `*` resolution as in `lib list`: `LibraryRepository.HighestFor(installed, reference)` `LibraryRepository.cs:68-69` (via `Newest`, `:57-62`, numeric order `:72-78`); `lib list` uses it at `LibraryCommands.cs:171-172`.
5. What applies: `LibraryReference.Effective => PinnedResolution ?? Default` `LibraryReference.cs:43`, `IsPinned` `:46`, `LibraryId.IsNewest` `:18`.
6. Versions match by exact string, names and vendors case-insensitively: `Restore.cs:58-60,87-89`.
7. One repository resolver for single-repository commands: `RepositoryPath(string?)` `LibraryCommands.cs:296-298` (exit 3 when unknown). Project loading: `LoadProjects` `:41-46`. Subcommand list: `:16`. `install-project` (the other direction, the pattern to mirror for "no `_Libraries` folder"): `:449-498`.
8. `RepositoryLock.Acquire(Reporter log, TimeSpan timeout, string name = Name)` `RepositoryLock.cs:33`; RepTool holds it around every install and uninstall `cli/src/IECode.Automation/RepTool.cs:80`; the named mutex also works on Linux (`RepositoryLockTests.cs:18-44` run unguarded). `--timeout` to `TimeSpan?`: `TimeoutSetting.FromSeconds(ctx.Get(Globals.Timeout))` `Runner.cs:117`, `FileReady.cs:38`; default `RepositoryLock.DefaultTimeout` (1800 s) `RepositoryLock.cs:16`.
9. JSON: camelCase properties and camelCase enum strings: `Reporter.cs:163-165`.
10. `PlcProjectFile.Discover` already skips `_Libraries` (copied .plcproj files are not loaded as projects): `ProjectTests.cs:159`.
11. Exit code table `cli/README.md:190-210`; `install-project` row `:34`; `## Unreleased` `extension/CHANGELOG.md:5`.

**Unverified (only a real tracked `_Libraries` or a TwinCAT PC can answer):**
- U1: which files a `_Libraries` version folder holds. The repository version folder holds the library file plus `browsercache`, `dependencies`, `projectinfo` (research Q4, `cli-build-workflow.md:175-177`). Whether XAE's "Update Project Library Folder" copies all of them or only the library file is not known. Spike task 0.
- U2: whether XAE writes `_Libraries` names in repository spelling (lower-case) or as referenced. Spike task 0 (only affects new vendor/library folders, decision 3).
- U3: whether `_Libraries` holds indirect dependencies. The doc comment says it does (`ProjectLibraries.cs:7-8`); decision 5 assumes it and is safe either way.

## Depends on

- `ProjectLibraries.FolderName`, `FolderOf(string plcProjectFile)`, `IsLibraryFile(string file)`, `Scan(string folder) -> IReadOnlyList<(string Name, string Version, string Vendor, string File)>`.
- `LibraryRepository.Scan(string root) -> IReadOnlyList<InstalledLibrary>`, `HighestFor(IEnumerable<InstalledLibrary>, LibraryReference) -> string?`, `Compare(string, string) -> int`.
- `record InstalledLibrary(string Name, string Version, string Vendor, string Path)`, `PlcProjectFile` (`Name`, `Path`, `References`), `LibraryReference.Effective`, `IsPinned`.
- `RepositoryLock.Acquire(Reporter, TimeSpan, string = Name)`, `RepositoryLock.DefaultTimeout`, `TimeoutSetting.FromSeconds(int?) -> TimeSpan?`.
- `Isolation.DeleteFolder(string dir)` (`internal static`, same assembly): removes old version folders and stage folders, read-only files included.
- Round-2 neighbours: none. Plan I (`lib verify`) may tighten what counts as installed; sync keeps its own "version folder needs a library file" check and does not wait for I.

## Touches

- Create: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`, `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`.
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (line 10 summary, line 16 subcommand list, one new method after `InstallProject`), `cli/README.md` (one row after line 34), `extension/CHANGELOG.md` (one line under `## Unreleased`).
- Conflict note for the master plan: only I also edits `LibraryCommands.cs:10,16` and the README command table (G does not touch `LibraryCommands.cs`); one-line insertions, master lane order H then I.

## Decisions (delegated)

1. **Scope per project, existing folders only.** Each project syncs its own `FolderOf(p.Path)`. A project without `_Libraries` is skipped with a detail line; none at all is exit 3 with the same hint as `install-project`. Rejected: creating the folder (that is a repository-layout decision XAE's "Update Project Library Folder" should make).
2. **Wanted set = direct references, `Effective`, `*` resolved with `HighestFor` against the one repository from `RepositoryPath(--repository)`** (same rule and same repository as `lib list`). Rejected: scanning all candidate repositories (a 4024/4026 PC would mix lines).
3. **Layout written:** `<vendor>/<library>/<version>/` with the version string as in the repository. For vendor and library folders an existing folder with the same name (case-insensitive) is reused; else the repository's on-disk spelling. Rejected: always the reference spelling (would create a second folder next to an existing lower-case one on Linux).
4. **Files copied:** every file in the repository version folder, recursively, relative paths kept (default until spike U1 says otherwise; then only `IsLibraryFile` files). The filter is one function `ProjectFolderSync.Selects(string relativePath)`. Update = target holds a different set of selected files or any byte differs; unchanged versions are not rewritten (no git noise). Extra selected files in a wanted target folder are deleted; non-selected files are left alone.
5. **`--prune` safety:** deletes only `_Libraries/<v>/<n>/<ver>` folders that pass the round-1 rule (digit name, library file inside), whose vendor+name is directly referenced, whose version is not wanted, that are not reparse points, and whose full path is under the `_Libraries` folder. Vendor and library folders are removed only when empty afterwards. Libraries not referenced directly are `kept` (they may be indirect dependencies, U3). Without `--prune` the deletable ones are reported as `stale`. Rejected: prune everything unreferenced (would delete indirect dependencies; their list lives in the binary-or-unknown `dependencies` file).
6. **A wanted version missing in the repository** (no folder, or a folder without library file = half-installed): report every missing one across all projects, write nothing, exit 3. Rejected: partial sync (a half-synced tracked folder is worse than an unchanged one).
7. **`--dry-run`:** full plan and JSON, no lock, no writes, same exit code (3 when something is missing).
8. **Lock:** the write run takes `RepositoryLock` (timeout `--timeout` or 1800 s) before the repository scan and holds it until the last copy, so it never copies a version a parallel `iecode` RepTool install is writing. It does not cover installs made in XAE by hand (stated in the README row). Rejected: no lock (sync is read-only on the repository, but a half-written folder would be committed).
9. **Atomic per version:** copy into a sibling stage folder `.<version>.iecode-sync`, then delete the old version folder and move the stage folder in. Stage folders left by a killed run are removed at the start of the next apply. Read-only attributes are cleared on copied files and before deleting.
10. **Any OS, no `windowsOnly`.** Placed as `lib project-folder sync` (a `project-folder` group with one `sync` subcommand) so later `project-folder` verbs fit.

## Review Focus

1. **Folder with different case than the repository** (`Example/Tc3_MotorLib/1.2.0.0` in `_Libraries`, `example/tc3_motorlib/1.2.0.0` in the repository) on Linux: same version, updated in place, no second folder (Task 1 test `ExistingFolderSpellingIsReused`).
2. **A non-library folder at version depth** (`_Libraries/Example/Tc3_MotorLib/docs/`, or `1.0.0.0/` with only `readme.txt`): never pruned (Task 1 test `PruneSkipsFoldersWithoutLibraryFile`).
3. **Repository version folder without library file** (RepTool killed mid-install): `Scan` does not list it, so the version is `missing` (reason "not installed"), nothing is written. For `*`, `HighestFor` then silently resolves to the next older installed version; Task 1 pins that with a test (R39).
4. **Read-only files in the target** (copied from a repository with read-only files, then updated): update and prune succeed (Task 2 test `ReadOnlyTargetFilesAreReplaced`, Windows only).
5. **A version folder that is a junction/symlink**: not pruned, not followed (Task 2 test `LinkedVersionFolderIsNotPruned`).

---

### Task 0: Spike, what a tracked `_Libraries` version folder holds (manual, gates Task 1 decision 4)

No code. Needs any repository with a tracked `_Libraries` and the PC's library repository; a TwinCAT PC with 4024 and 4026 for step 3.

- [ ] **Step 1:** For three libraries (one Beckhoff, one own, one `.compiled-library-ge33`) list `git ls-files <project>/_Libraries/<vendor>/<lib>/<version>` and the repository version folder (`Get-ChildItem -Recurse -Name`). Record file names only (no internal names in the repo).
- [ ] **Step 2:** Compare spelling of vendor and library folders with the repository (U2).
- [ ] **Step 3:** In XAE 4024 and 4026: References, "Update Project Library Folder…" on a scratch project; record which files and which spelling appear.
- [ ] **Step 4:** Write the result as two lines in this plan under Decisions 3 and 4.

Gate: same file set as the repository → keep "all files". Only the library file → `Selects` returns `ProjectLibraries.IsLibraryFile(path)` and the tests in Task 1 use that. Lower-case written by XAE → new folders use repository spelling (already the default). Mixed → no change.

### Task 1: `ProjectFolderSync.Plan`

**Files:**
- Create: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`
- Test: `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`

**Interfaces:**
- Produces:
  - `public enum FolderSyncAction { Add, Update, Unchanged, Missing, Prune, Stale, Kept }`
  - `public sealed record FolderSyncItem(string Name, string Version, string Vendor, FolderSyncAction Action, string Target, string? Source, string? Requested, string? Reason)`; `Requested` is `"*"` for a resolved `*` reference, else null; `Source` is the repository version folder.
  - `public sealed record FolderSyncPlan(string Project, string Folder, IReadOnlyList<FolderSyncItem> Items) { public bool HasMissing { get; } public bool HasChanges { get; } }`
  - `public static class ProjectFolderSync { public static FolderSyncPlan Plan(PlcProjectFile project, IReadOnlyList<InstalledLibrary> installed, bool prune); public static bool Selects(string relativePath); }`
  - Items ordered vendor, name, version (`LibraryRepository.Compare`), as `ProjectLibraries.Plan`.

- [ ] **Step 1: Write the failing tests.** Fixture: `_ws["P/PLC1/PLC1.plcproj"]` with the XML of `ReferenceCheckTests.cs:14-32` (MotorLib pinned `1.2.0.0`, AxisLib `*`), repository `_ws["Repo"]` with `example/tc3_motorlib/1.2.0.0/Tc3_MotorLib.library` + `projectinfo`, `example/tc3_axislib/1.0.0.0/…library` and `…/2.0.0.0/…library`; helper `Lib(root, vendor, name, version, params string[] files)`.

```csharp
[Fact] public void PinnedVersionNotInFolderIsAdded()          // Add, Target = <P/PLC1/_Libraries>/example/tc3_motorlib/1.2.0.0
[Fact] public void StarResolvesToHighestInstalled()            // AxisLib: Add 2.0.0.0, Requested == "*"
[Fact] public void IdenticalVersionIsUnchanged()               // same files and bytes → Unchanged, HasChanges false
[Fact] public void DifferentBytesOrExtraFileIsUpdate()         // one byte changed → Update; extra projectinfo2 → Update
[Fact] public void ExistingFolderSpellingIsReused()            // _Libraries/Example/Tc3_MotorLib/1.2.0.0 → Target uses "Example/Tc3_MotorLib"
[Fact] public void MissingInRepositoryIsMissing()              // MotorLib 1.2.0.0 absent → Missing, Reason "not in the library repository", HasMissing
[Fact] public void HalfInstalledRepositoryVersionIsMissing()   // repo folder with projectinfo only is not in installed → Missing, Reason "not installed"
[Fact] public void StarWithNothingInstalledIsMissing()         // AxisLib none → Missing, Version "*"
[Fact] public void OtherVersionOfReferencedLibraryIsStaleOrPrune() // _Libraries/example/tc3_motorlib/1.1.0.0 → Stale (prune:false), Prune (prune:true)
[Fact] public void UnreferencedLibraryIsKept()                 // _Libraries/example/tc3_other/1.0.0.0 → Kept with prune:true
[Fact] public void PruneSkipsFoldersWithoutLibraryFile()       // tc3_motorlib/docs/ and tc3_motorlib/1.0.0.0/readme.txt → no item at all
[Fact] public void VendorMattersForPrune()                     // _Libraries/other vendor/tc3_motorlib/1.1.0.0 → Kept, not Prune
```

- [ ] **Step 2:** `dotnet build cli/tests/IECode.Core.Tests`, expected: build error (types missing).
- [ ] **Step 3: Implement `Plan`.** Wanted set from `project.References` (`Effective`; `*` via `LibraryRepository.HighestFor`), deduped by vendor+name (ci) and version (exact). Repository match as `Restore.cs:58-60`; "has library file" = any file under `Source` with `ProjectLibraries.IsLibraryFile`. Existing versions from `ProjectLibraries.Scan(folder)` (round-1 rule for free). Comparison of file sets: `Selects`-filtered relative paths, ordinal-ignore-case, then length, then bytes.
- [ ] **Step 4:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ProjectFolderSyncTests"`, expected: all pass.
- [ ] **Step 5: Commit** `Plan project library folder sync from the resolutions` (body: why direct references only and why missing blocks every write).

### Task 2: `ProjectFolderSync.Apply`

**Files:**
- Modify: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`
- Test: `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`

**Interfaces:**
- Consumes: `FolderSyncPlan`, `FolderSyncItem` (Task 1).
- Produces: `public sealed record FolderSyncResult(int Added, int Updated, int Pruned);` and `public static FolderSyncResult Apply(FolderSyncPlan plan)`. Throws `InvalidOperationException` when `plan.HasMissing` (the CLI checks first). Wraps `IOException` / `UnauthorizedAccessException` in `IECodeException(ExitCodes.LibraryFailed, "<target>: <message>; <n> of <m> applied.")`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void ApplyCopiesAddedVersionWithAllSelectedFiles()   // target holds Tc3_MotorLib.library and projectinfo, bytes equal; Plan again → all Unchanged
[Fact] public void ApplyUpdateReplacesFilesAndDeletesExtraOnes()   // extra selected file gone, a non-selected file (if Selects filters) stays
[Fact] public void ApplyPruneRemovesVersionAndEmptyParents()       // 1.1.0.0 gone; tc3_motorlib folder kept while 1.2.0.0 exists; vendor folder removed when it became empty
[Fact] public void ApplyNeverTouchesStaleOrKept()                  // prune:false plan → 1.1.0.0 and tc3_other still there
[Fact] public void ApplyRefusesPlanWithMissing()                   // Assert.Throws<InvalidOperationException>; folder unchanged (snapshot of file list before/after)
[Fact] public void LeftoverStageFolderIsRemoved()                  // _Libraries/example/tc3_motorlib/.1.2.0.0.iecode-sync exists → gone after Apply, not reported as a version
[Fact] public void ReadOnlyTargetFilesAreReplaced()                // Windows only: target file read-only → Update succeeds, Prune succeeds
[Fact] public void LinkedVersionFolderIsNotPruned()                // Directory.CreateSymbolicLink as 1.1.0.0 → Plan has no Prune item for it (skip when link creation fails, like IsolationTests.cs:213); link target untouched
```

- [ ] **Step 2:** build, expected: build error.
- [ ] **Step 3: Implement `Apply`:** remove `*.iecode-sync` stage folders two levels below `_Libraries` first; per Add/Update copy selected files into `.<version>.iecode-sync` (clear read-only), delete the old version folder with `Isolation.DeleteFolder`, `Directory.Move` stage to target; per Prune assert `Path.GetFullPath(target)` starts with the folder plus separator and is not a reparse point, then `Isolation.DeleteFolder`, then delete the library and vendor folder when empty. (Reparse-point exclusion also goes into `Plan`, Task 1 code, tested here.)
- [ ] **Step 4:** run the filter-class command, expected: all pass (the read-only and link tests skipped on ubuntu where noted).
- [ ] **Step 5: Commit** `Apply project library folder sync with staged copies` (body: why stage folders and why prune re-checks the path).

### Task 3: `iecode lib project-folder sync` command, docs

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs:10,16` and a new `ProjectFolder()` method after `InstallProject` (`:498`)
- Modify: `cli/README.md` (row after `:34`), `extension/CHANGELOG.md` (under `:5`)

**Interfaces:**
- Consumes: `ProjectFolderSync.Plan`, `Apply`, `FolderSyncPlan`, `FolderSyncResult`; `RepositoryPath`, `LoadProjects`, `RepositoryLock.Acquire`, `TimeoutSetting.FromSeconds(ctx.Get(Globals.Timeout)) ?? RepositoryLock.DefaultTimeout`.
- Produces: command `lib project-folder sync [paths…] [--prune] [--repository <folder>] [--dry-run]`.

- [ ] **Step 1: Wire the command.** Order: load projects; skip those without `_Libraries` (detail line), none → exit 3 with the `install-project` hint (`LibraryCommands.cs:465-466`); unless `--dry-run`, acquire the lock; scan `RepositoryPath(--repository)`; plan all projects; print one line per item except `Unchanged`/`Kept` (those with `-v`); any `HasMissing` → error per missing item, `Outcome` exit 3, nothing written; `--dry-run` → `Outcome.Ok`; else `Apply` each plan, success line `N added, N updated, N pruned`, warn "N stale version(s) kept; pass --prune to remove them" when any `Stale`.
- [ ] **Step 2: JSON** (one object, camelCase by `Reporter`): `{ dryRun, prune, repository, projects: [ { project, folder, items: [FolderSyncItem…] } ], added, updated, pruned, missing }`. Exit 3 still writes this object.
- [ ] **Step 3: Docs.** README row: `` `lib project-folder sync [paths…] [--prune] [--dry-run]` | Copy the referenced library versions (pinned, `*` = highest installed) from the library repository into each project's `_Libraries` folder; `--prune` removes other versions of those libraries. Reverse of `install-project`; waits for iecode installs, not for installs made in XAE | files ``. CHANGELOG: `- CLI: \`iecode lib project-folder sync [--prune]\` brings a tracked \`_Libraries\` folder in line with the project's library references, without TwinCAT.`
- [ ] **Step 4:** `dotnet build cli/IECode.slnx`, expected: success, no new warnings. Then on the dev PC against a temp copy of a fixture project (`--repository <temp repo>`): `--dry-run --json` shows `add`; a run writes; a second run prints only unchanged; removing the repository version gives exit 3 and no change (`git status` clean in the temp copy).
- [ ] **Step 5: Commit** `Add lib project-folder sync` (body: tracked `_Libraries` drifted from the resolutions with no way back except XAE's dialog; reverse of install-project).

## Open risks

- U1/U2 unanswered → Task 0 must run before Task 1 is merged; the filter is one function, so a late answer costs one test change.
- Indirect dependencies are neither added nor pruned. A `_Libraries` folder synced by iecode can lack a dependency XAE would have added; a follow-up could read the repository's `dependencies` file once its format is known (Task 0 step 1 can note whether it is text).
- The lock covers iecode-driven RepTool calls only; an install made in XAE during a sync can still be copied half-written. The library-file check catches the empty case, not a truncated file.
