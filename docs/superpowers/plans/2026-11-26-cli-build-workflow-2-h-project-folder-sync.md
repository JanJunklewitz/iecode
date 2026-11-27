# Plan H: `iecode lib project-folder sync [--prune]` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring each PLC project's tracked `_Libraries` folder in line with the project's library resolutions: copy the referenced versions from the library repository, and with `--prune` drop other versions of those libraries. No TwinCAT needed.

**Architecture:** `ProjectFolderSync` (pure Core, `IECode.Core.Projects`) plans per project (add / update / unchanged / missing / prune / stale / kept) and applies a plan to the file system. `LibraryCommands` adds the `project-folder sync` command and only wires scan, plan, lock, apply and output. It is the reverse of `lib install-project` (project folder into repository).

**Tech Stack:** C# .NET 10, xUnit v3, `System.IO` only.

**Spec:** [docs/research/cli-build-workflow.md](../../research/cli-build-workflow.md) section 6 (row "Sync tracked `_Libraries` with the resolutions"); [TODO.md](../../../TODO.md) "CLI: build and library workflow at scale".

**Size:** 5 tasks (Task 0 spike, Tasks 1-4 code), about 650 lines of code and tests `[estimated]`, 1.5 to 2 days plus a manual PC check of about 0.5 day (Task 4 step 5) `[estimated]`. This is an upper bound: it is the case where every gate passes.

**Review changes (round 2):** R2: Task 0 runs in session A (read-mostly) and gates only this plan. R4: manual PC check in Task 4 step 5, estimate stated as an upper bound. R42: Premises 3, Decision 6, Review Focus 3, Task 1 tests. R43: Decision 5, Task 3 `Stage` and the three link tests. R44: Decision 9, Task 3 `Swap` and its tests. R45: Decision 11, Task 3 git tests, Task 4 `--force`, Task 0 gate. R46: Decision 8, Task 3 `Stage`/`Swap` split, Task 4 step 1. R47: Decision 12, Task 1 `TooLongTargetIsMissing`, Task 2 `VersionFolderDifferingOnlyInCaseIsAConflict`. R48: Task 2 and Task 3 tests. R49: Global Constraints, Task 4 step 3. R50: Task 1 and Task 2 split. R51: Decision 5, Task 0 step 4, Task 4 step 3, Open risks. R52: Decision 13, Task 1 `PlanAll`, Task 2 sharing tests.

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` only wires them. There is no test project for `IECode.Cli`. Windows-only tests use `Assert.SkipUnless(WindowsOnly.IsWindows, ...)`.
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ProjectFolderSyncTests"` through the PowerShell tool; `dotnet build cli/tests/IECode.Core.Tests` and `dotnet test` as separate commands.
- JSON output changes are additive; existing exit codes keep their meaning. This plan adds **no** exit code: exit 3 (`NotFound`) means "the wanted state cannot be reached, nothing was written": a wanted version not installed in the repository (same meaning as in `lib check`), a target path too long, a folder-name collision, a file in the way; exit 12 (`LibraryFailed`) means "a write failed or was refused": a failed copy, move or delete, or a link (reparse point) on the way into `_Libraries`; a lock timeout stays 17. The README row states this mapping.
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, a row in the command table of `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s`.
- All sizes tagged `[estimated]`.
- Sync never writes outside `<project>/_Libraries`, never creates a `_Libraries` folder that does not exist, and never deletes anything that is not a library version folder or one of its own `.iecode-sync` / `.iecode-old` helper folders (see decisions 5 and 9).

## Premises checked (`main` at `f817efe`)

Re-checked against `main` at `f817efe` (line numbers remapped from the earlier base `0515a61` through the diff). Exit codes live in `cli/src/IECode.Core/Errors.cs` (`NotFound = 3` `:9`, `LibraryFailed = 12` `:12`, `Timeout = 17` `:17`). New for this plan: `Isolation.DeleteFolder(string dir)` (`cli/src/IECode.Core/Isolation.cs:400-406`, `internal static`, clears read-only, skips reparse points) is reused by Task 3.

1. `_Libraries` layout is `<vendor>/<library>/<version>/<file>` next to the .plcproj: `cli/src/IECode.Core/Projects/ProjectLibraries.cs:7-10`, `FolderOf` `:17-18`, `FolderName` `:14`.
2. A project-folder version counts only when its folder name starts with a digit and holds a library file (`.library`, `.compiled-library*`): `ProjectLibraries.cs:30-32`, `IsLibraryFile` `:39-44`; pinned by `WorkspaceTests.cs:100,106` (`Tc3_Empty/1.0.0/readme.txt` skipped). This is "the round-1 rule". Fixtures mix case (`Acme/Tc3_MotorLib` and `acme/tc3_motorlib`): `WorkspaceTests.cs:98-99`.
3. `LibraryRepository.Scan` applies the same round-1 rule: it skips a version folder without a library file (`LibraryRepository.cs:51`, comment "an empty folder is what an interrupted install or removal leaves"), so a half-installed repository version never appears in `installed`. `InstalledLibrary.Path` is the version folder. Names are lower-case on disk in the repository: `:8`. (Corrected in review, R42: this premise said the opposite.)
4. `*` resolution as in `lib list`: `LibraryRepository.HighestFor(installed, reference)` `LibraryRepository.cs:68-69` (via `Newest`, `:57-62`, numeric order `:72-78`); `lib list` uses it at `LibraryCommands.cs:171-172`.
5. What applies: `LibraryReference.Effective => PinnedResolution ?? Default` `LibraryReference.cs:43`, `IsPinned` `:46`, `LibraryId.IsNewest` `:18`.
6. Versions match by exact string, names and vendors case-insensitively: `Restore.cs:58-60,87-89`.
7. One repository resolver for single-repository commands: `RepositoryPath(string?)` `LibraryCommands.cs:296-298` (exit 3 when unknown). Project loading: `LoadProjects` `:41-46`. Subcommand list: `:16`. `install-project` (the other direction, the pattern to mirror for "no `_Libraries` folder"): `:449-498`.
8. `RepositoryLock.Acquire(Reporter log, TimeSpan timeout, string name = Name)` `RepositoryLock.cs:33`; RepTool holds it around every install and uninstall `cli/src/IECode.Automation/RepTool.cs:80`; the named mutex also works on Linux (`RepositoryLockTests.cs:18-44` run unguarded). `--timeout` to `TimeSpan?`: `TimeoutSetting.FromSeconds(ctx.Get(Globals.Timeout))` `Runner.cs:117`, `FileReady.cs:38`; default `RepositoryLock.DefaultTimeout` (1800 s) `RepositoryLock.cs:16`.
9. JSON: camelCase properties and camelCase enum strings: `Reporter.cs:163-165`.
10. `PlcProjectFile.Discover` already skips `_Libraries` (copied .plcproj files are not loaded as projects): `ProjectTests.cs:159`.
11. Exit code table `cli/README.md:190-210`; `install-project` row `:34`; `## Unreleased` `extension/CHANGELOG.md:5`.
12. `Isolation.DeleteFolder` skips reparse points while clearing read-only, but `Directory.Delete(dir, recursive: true)` (`Isolation.cs:405`) is called on whatever `dir` it gets: a junction at `_Libraries`, at the vendor or at the library folder would send a delete outside the project. The version-folder reparse check alone does not cover that, so `Apply` checks every component from `_Libraries` down (decision 5, R43).
13. The existing git helper: `Git.Open(folder)` `cli/src/IECode.Core/Git.cs:46-51` (throws `IECodeException` exit 3 when the folder is in no git work tree or git is missing), `StatusEntries(folder)` `Git.cs:27-44` (`git status --porcelain=v1 -z --untracked-files=all` below one folder; untracked files count). Tests simulate "no git" with the internal `Git.Executable` override `Git.cs:15`. Used by decision 11 (R45).
14. Link tests in this repo create a symbolic link and fall back to `cmd /c mklink /J` on Windows, skipping when both fail: `IsolationTests.cs:341-350` (`LinksAreNotFollowed`), `:279-286`. The link tests of this plan use that fallback.
15. Two `.plcproj` files in one directory share the `_Libraries` folder next to them; `FolderOf` `ProjectLibraries.cs:17-18` is per project file, so planning per project would run two plans on one folder (decision 13, R52).

**Unverified (only a real tracked `_Libraries` or a TwinCAT PC can answer):**
- U1: which files a `_Libraries` version folder holds. The repository version folder holds the library file plus `browsercache`, `dependencies`, `projectinfo` (research Q4, `cli-build-workflow.md:175-177`). Whether XAE's "Update Project Library Folder" copies all of them or only the library file is not known. Spike task 0.
- U2: whether XAE writes `_Libraries` names in repository spelling (lower-case) or as referenced. Spike task 0 (only affects new vendor/library folders, decision 3).
- U3: whether `_Libraries` holds indirect dependencies. The doc comment says it does (`ProjectLibraries.cs:7-8`); decision 5 assumes it and is safe either way.
- U4: whether `_Libraries` keeps a second version of a directly referenced library because another library depends on it (direct version A plus an indirect need for version B). If it does, `--prune` would delete B (decision 5 limit, R51). Spike task 0 step 4.

## Depends on

- `ProjectLibraries.FolderName`, `FolderOf(string plcProjectFile)`, `IsLibraryFile(string file)`, `Scan(string folder) -> IReadOnlyList<(string Name, string Version, string Vendor, string File)>`.
- `LibraryRepository.Scan(string root) -> IReadOnlyList<InstalledLibrary>`, `HighestFor(IEnumerable<InstalledLibrary>, LibraryReference) -> string?`, `Compare(string, string) -> int`.
- `record InstalledLibrary(string Name, string Version, string Vendor, string Path)`, `PlcProjectFile` (`Name`, `Path`, `References`), `LibraryReference.Effective`, `IsPinned`.
- `RepositoryLock.Acquire(Reporter, TimeSpan, string = Name)`, `RepositoryLock.DefaultTimeout`, `TimeoutSetting.FromSeconds(int?) -> TimeSpan?`.
- `Isolation.DeleteFolder(string dir)` (`internal static`, same assembly): removes old version folders, `.iecode-old` and stage folders, read-only files included.
- `Git.Open(string folder)`, `Git.StatusEntries(string? folder)` (`Git.cs:27,46`): the local-changes check of decision 11.
- Round-2 neighbours: none. Plan I (`lib verify`) may tighten what counts as installed; sync keeps its own "version folder needs a library file" check and does not wait for I.

## Touches

- Create: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`, `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`.
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (line 10 summary, line 16 subcommand list, one new method after `InstallProject`), `cli/README.md` (one row after line 34, with the exit-code mapping and the `--prune` limit), `extension/CHANGELOG.md` (one line under `## Unreleased`).
- Read only (no edit): `cli/src/IECode.Core/Git.cs`, `cli/src/IECode.Core/Isolation.cs`, `cli/src/IECode.Core/RepositoryLock.cs`.
- Conflict note for the master plan: only I also edits `LibraryCommands.cs:10,16` and the README command table (G does not touch `LibraryCommands.cs`); one-line insertions, master lane order H then I.

## Decisions (delegated)

1. **Scope per `_Libraries` folder, existing folders only.** Each project syncs its own `FolderOf(p.Path)`; projects that share one physical folder are planned together (decision 13). A project without `_Libraries` is skipped with a detail line; none at all is exit 3 with the same hint as `install-project`. Rejected: creating the folder (that is a repository-layout decision XAE's "Update Project Library Folder" should make).
2. **Wanted set = direct references, `Effective`, `*` resolved with `HighestFor` against the one repository from `RepositoryPath(--repository)`** (same rule and same repository as `lib list`). Rejected: scanning all candidate repositories (a 4024/4026 PC would mix lines).
3. **Layout written:** `<vendor>/<library>/<version>/` with the version string as in the repository. For vendor and library folders an existing folder with the same name (case-insensitive) is reused; else the repository's on-disk spelling. Rejected: always the reference spelling (would create a second folder next to an existing lower-case one on Linux).
4. **Files copied:** every file in the repository version folder, recursively, relative paths kept (default until spike U1 says otherwise; then only `IsLibraryFile` files). The filter is one function `ProjectFolderSync.Selects(string relativePath)`. Update = target holds a different set of selected files or any byte differs; unchanged versions are not rewritten (no git noise). Extra selected files in a wanted target folder are deleted; non-selected files are left alone and carried over into the new folder by the swap (decision 9, by design). Task 0 is a hard gate for the "every file" default (R45): the default is not merged until Task 0 has answered U1.
5. **`--prune` safety:** deletes only `_Libraries/<v>/<n>/<ver>` folders that pass the round-1 rule (digit name, library file inside), whose vendor+name is directly referenced, whose version is not wanted, that are not reparse points, and whose full path is under the `_Libraries` folder. Before any write `Apply` also checks every component from `_Libraries` down to the target (the `_Libraries` folder, vendor, library and version folder, whichever exist) for reparse points; one link refuses the whole project (exit 12, nothing written for that project), because `Isolation.DeleteFolder` (`Isolation.cs:401-406`) deletes whatever folder it is given (R43). Vendor and library folders are removed only when empty afterwards. `--prune` is guarded by decision 11 (local git changes skip the folder) and runs only after the plan list, with every `Prune` line, has been printed; the README recommends `--dry-run --prune` first. Known limit (R51): a second version of a directly referenced library that another library needs as a dependency looks unneeded and is pruned; the README names this (U4). Libraries not referenced directly are `kept` (they may be indirect dependencies, U3). Without `--prune` the deletable ones are reported as `stale`. Rejected: prune everything unreferenced (would delete indirect dependencies; their list lives in the binary-or-unknown `dependencies` file).
6. **A wanted version missing in the repository** (no folder; a half-installed folder without library file is not listed by `LibraryRepository.Scan`, `LibraryRepository.cs:51`, so it is missing too, reason "not installed"; for `*` the next older installed version is used, no re-check, R42), **or a target that cannot be written** (path too long, folder-name collision, a file in the way: decision 12 and Task 2): report every such item across all projects, write nothing, exit 3. Rejected: partial sync (a half-synced tracked folder is worse than an unchanged one).
7. **`--dry-run`:** full plan and JSON, no lock, no writes, same exit code (3 when something is missing); folders that a real run would skip for local git changes are listed as skipped.
8. **Lock:** the write run takes `RepositoryLock` (timeout `--timeout` or 1800 s) before the repository scan and holds it only while reading the repository: the scan and the copy of all sources into stage folders (`Stage`). It is released before the swap (`Swap`), which touches only the project folder, so a long sync does not block installs (R46). It never copies a version a parallel `iecode` RepTool install is writing. It does not cover installs made in XAE by hand (stated in the README row). Rejected: no lock (sync is read-only on the repository, but a half-written folder would be committed); holding it for the whole run (blocks every install for up to 1800 s).
9. **Atomic per version, in two phases:** `Stage` copies into a sibling stage folder `.<version>.iecode-sync`; `Swap` renames the old version folder aside to `.<version>.iecode-old`, moves the stage folder in, carries non-selected files of the old folder over, then deletes the old folder. A failure between the renames leaves `.<version>.iecode-old`; the next run first restores it when the version folder is missing (and deletes it when the version folder exists), so a version is never lost (R44). Stage folders left by a killed run are removed at the start of the next apply. Read-only attributes are cleared on copied files and before deleting. Atomicity holds per version, not across versions or projects (README). Rejected: delete the old folder first (a failure leaves the version missing, and a cleanup could remove the finished stage).
10. **Any OS, no `windowsOnly`.** Placed as `lib project-folder sync` (a `project-folder` group with one `sync` subcommand) so later `project-folder` verbs fit.
11. **Local changes are not overwritten (R45).** For an Update or a Prune the swap first checks the version folder: when it is in a git work tree and `Git.StatusEntries(folder)` (`Git.cs:27`) is not empty, the folder is skipped and reported ("local changes, pass --force"), unless `--force`. No git work tree or no git: no check (`Git.Open` throws exit 3, caught and read as "no check"). Adds are never skipped (the folder does not exist). A skip is a warning, exit stays 0. Consequence: a version synced but not yet committed is also "changed" on the next run; that is intended. Rejected: always overwrite (a tracked folder is the one place where a lost edit is expensive).
12. **Path-length and name checks before any write (R47).** `Plan` takes a `maxPath` (259 on Windows, unlimited elsewhere); any planned file whose stage path (`<target parent>/.<version>.iecode-sync/<relative>`, the longest one) exceeds it makes the item `Missing`, reason "path too long (N > 259)", so the run stops with exit 3 before any write. A wanted version folder that differs only in case from an existing one, or a path component that is a file, is `Missing` as well (Task 2).
13. **One plan per physical folder (R52).** `PlanAll` groups projects by the full `_Libraries` path (case-insensitive on Windows), merges their wanted sets (a union of the `Effective` references) and returns one plan per folder (`FolderSyncPlan.Projects` lists the sharers). With `--prune` and a partial selection (explicit paths) a folder that is shared with a project that was not selected is not pruned: its prune candidates become `Stale`, reason "shared with <project>, not selected". The CLI names the sharers by also loading the other `.plcproj` files below the current folder; sharers outside it cannot be named (README limit).

## Review Focus

1. **Folder with different case than the repository** (`Example/Tc3_MotorLib/1.2.0.0` in `_Libraries`, `example/tc3_motorlib/1.2.0.0` in the repository) on Linux: same version, updated in place, no second folder (Task 2 test `ExistingFolderSpellingIsReused`).
2. **A non-library folder at version depth** (`_Libraries/Example/Tc3_MotorLib/docs/`, or `1.0.0.0/` with only `readme.txt`): never pruned (Task 2 test `PruneSkipsFoldersWithoutLibraryFile`).
3. **Repository version folder without library file** (RepTool killed mid-install): `Scan` does not list it, so the version is `missing` (reason "not installed"), nothing is written. For `*`, `HighestFor` then silently resolves to the next older installed version; Task 1 pins that with the test `StarWithHalfInstalledHighestUsesNextOlder` (R42).
4. **Read-only files in the target** (copied from a repository with read-only files, then updated): update and prune succeed (Task 3 test `ReadOnlyTargetFilesAreReplaced`, Windows only).
5. **A version folder that is a junction/symlink**: not pruned, not followed (Task 2 test `LinkedVersionFolderIsNotPruned`; links higher up: Task 3 tests).

---
### Task 0: Spike, what a tracked `_Libraries` version folder holds (manual, hard gate for decision 4 and for the merge of Task 2)

No code. Needs any repository with a tracked `_Libraries` and the PC's library repository; a TwinCAT PC with 4024 and 4026 for steps 3 and 4. Runs in session A of the master plan (read-mostly, together with the other read-mostly spikes) and gates only this plan; the other lanes do not wait for it (R2). It changes nothing on the PC beyond a scratch project.

- [ ] **Step 1:** For three libraries (one Beckhoff, one own, one `.compiled-library-ge33`) list `git ls-files <project>/_Libraries/<vendor>/<lib>/<version>` and the repository version folder (`Get-ChildItem -Recurse -Name`). Record file names only (no internal names in the repo).
- [ ] **Step 2:** Compare spelling of vendor and library folders with the repository (U2).
- [ ] **Step 3:** In XAE 4024 and 4026: References, "Update Project Library Folder…" on a scratch project; record which files and which spelling appear.
- [ ] **Step 4:** Direct plus indirect version case (U4, R51): on the scratch project reference library A directly in version 1 and let another referenced library need A in version 2 (or the other way round). After "Update Project Library Folder…" record whether `_Libraries/<vendor>/<A>/` holds both versions. If it does, `--prune` would delete the version only the dependency needs; the README limit stays and `--prune` stays opt-in.
- [ ] **Step 5:** Write the result as three lines in this plan under Decisions 3, 4 and 5.

Gate: same file set as the repository → keep "all files". Only the library file → `Selects` returns `ProjectLibraries.IsLibraryFile(path)` and the tests in Task 2 use that. Lower-case written by XAE → new folders use repository spelling (already the default). Mixed → no change. Task 1 does not depend on the answer; Task 2 (first use of `Selects`) is not merged before Task 0 has answered U1, so the "every file" default is never shipped unchecked (R45).

### Task 1: `ProjectFolderSync.PlanAll`, wanted set and Add / Missing

**Files:**
- Create: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`
- Test: `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`

**Interfaces:**
- Produces:
  - `public enum FolderSyncAction { Add, Update, Unchanged, Missing, Prune, Stale, Kept }`
  - `public sealed record FolderSyncItem(string Name, string Version, string Vendor, FolderSyncAction Action, string Target, string? Source, string? Requested, string? Reason)`; `Requested` is `"*"` for a resolved `*` reference, else null; `Source` is the repository version folder.
  - `public sealed record FolderSyncPlan(IReadOnlyList<string> Projects, string Folder, IReadOnlyList<FolderSyncItem> Items) { public bool HasMissing { get; } public bool HasChanges { get; } }` (`Projects` = the projects that share `Folder`, decision 13).
  - `public static class ProjectFolderSync { public static IReadOnlyList<FolderSyncPlan> PlanAll(IReadOnlyList<PlcProjectFile> selected, IReadOnlyList<PlcProjectFile> others, IReadOnlyList<InstalledLibrary> installed, bool prune, int maxPath = int.MaxValue); public static FolderSyncPlan Plan(PlcProjectFile project, IReadOnlyList<InstalledLibrary> installed, bool prune, int maxPath = int.MaxValue); public static bool Selects(string relativePath); }`. `Plan` is `PlanAll` for one project and no others. `others` = projects that are not selected but may share a folder (decision 13). `Selects` returns `true` for now (Task 2 and Task 0 settle it).
  - Items ordered vendor, name, version (`LibraryRepository.Compare`), as `ProjectLibraries.Plan`.

- [ ] **Step 1: Write the failing tests.** Fixture: `_ws["P/PLC1/PLC1.plcproj"]` with the XML of `ReferenceCheckTests.cs:14-32` (MotorLib pinned `1.2.0.0`, AxisLib `*`), repository `_ws["Repo"]` with `example/tc3_motorlib/1.2.0.0/Tc3_MotorLib.library` + `projectinfo`, `example/tc3_axislib/1.0.0.0/…library` and `…/2.0.0.0/…library`; helper `Lib(root, vendor, name, version, params string[] files)`.

```csharp
[Fact] public void PinnedVersionNotInFolderIsAdded()          // Add, Target = <P/PLC1/_Libraries>/example/tc3_motorlib/1.2.0.0
[Fact] public void StarResolvesToHighestInstalled()            // AxisLib: Add 2.0.0.0, Requested == "*"
[Fact] public void MissingInRepositoryIsMissing()              // MotorLib 1.2.0.0 absent → Missing, Reason "not in the library repository", HasMissing
[Fact] public void HalfInstalledRepositoryVersionIsMissing()   // repo folder with projectinfo only is not in installed → Missing, Reason "not installed"
[Fact] public void StarWithNothingInstalledIsMissing()         // AxisLib none → Missing, Version "*"
[Fact] public void StarWithHalfInstalledHighestUsesNextOlder() // AxisLib 2.0.0.0 has projectinfo only → Add 1.0.0.0 (not Missing), Requested == "*" (R42: no repository re-check, the next older installed version is used)
[Fact] public void TooLongTargetIsMissing()                    // maxPath 40 → Add item becomes Missing, Reason starts "path too long", HasMissing; maxPath default → Add (R47)
[Fact] public void TwoProjectsWithDifferentVersionsOfOneLibrary() // P1 pins MotorLib 1.2.0.0, P2 (other folder) pins 1.3.0.0 → two plans, each Add only its own version (R48)
[Fact] public void TwoProjectsSharingAFolderGetOneMergedPlan() // two .plcproj in one directory: P1 wants MotorLib 1.2.0.0, P2 AxisLib * → one plan, Projects has both names, Items hold both libraries once (R52)
```

- [ ] **Step 2:** `dotnet build cli/tests/IECode.Core.Tests`, expected: build error (types missing).
- [ ] **Step 3: Implement `PlanAll` (wanted set, Add, Missing).** Group `selected` by the full `ProjectLibraries.FolderOf` path (ordinal-ignore-case on Windows, ordinal elsewhere), merge the wanted sets. Wanted set from `project.References` (`Effective`; `*` via `LibraryRepository.HighestFor`), deduped by vendor+name (ci) and version (exact). Repository match as `Restore.cs:58-60`; a version `Scan` did not list is `Missing` ("not installed" or "not in the library repository"). Path-length check (decision 12): the longest planned stage path per item against `maxPath`. Existing folders are not looked at yet (Task 2): every wanted version is `Add` or `Missing` here.
- [ ] **Step 4:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ProjectFolderSyncTests"`, expected: all pass.
- [ ] **Step 5: Commit** `Plan project library folder sync from the resolutions` (body: why direct references only, why missing blocks every write, why one plan per physical folder).

### Task 2: `ProjectFolderSync` existing-folder classification

**Files:**
- Modify: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`
- Test: `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`

**Interfaces:**
- Consumes: `PlanAll`, `FolderSyncPlan`, `FolderSyncItem` (Task 1). Produces: `Unchanged`, `Update`, `Prune`, `Stale`, `Kept` items and the final `Selects`. Merge gate: Task 0 answered (U1).

- [ ] **Step 1: Write the failing tests** (same fixture as Task 1; links as in premise 14, with the `mklink /J` fallback)

```csharp
[Fact] public void IdenticalVersionIsUnchanged()               // same files and bytes → Unchanged, HasChanges false
[Fact] public void DifferentBytesOrExtraFileIsUpdate()         // one byte changed → Update; extra projectinfo2 → Update
[Fact] public void ExistingFolderSpellingIsReused()            // _Libraries/Example/Tc3_MotorLib/1.2.0.0 → Target uses "Example/Tc3_MotorLib"
[Fact] public void OtherVersionOfReferencedLibraryIsStaleOrPrune() // _Libraries/example/tc3_motorlib/1.1.0.0 → Stale (prune:false), Prune (prune:true)
[Fact] public void UnreferencedLibraryIsKept()                 // _Libraries/example/tc3_other/1.0.0.0 → Kept with prune:true
[Fact] public void PruneSkipsFoldersWithoutLibraryFile()       // tc3_motorlib/docs/ and tc3_motorlib/1.0.0.0/readme.txt → no item at all
[Fact] public void VendorMattersForPrune()                     // _Libraries/other vendor/tc3_motorlib/1.1.0.0 → Kept, not Prune
[Fact] public void LinkedVersionFolderIsNotPruned()            // link (symlink, else mklink /J) as 1.1.0.0 → Plan has no Prune item for it; skip when both fail (premise 14); link target untouched (moved here from the Apply task, R50)
[Fact] public void VersionFolderDifferingOnlyInCaseIsAConflict() // _Libraries/example/tc3_motorlib/1.2.0.0-RC exists, wanted "1.2.0.0-rc" → Missing, Reason "differs only in case from 1.2.0.0-RC"; on a case-sensitive FS the same (R47)
[Fact] public void TargetThatIsAFileIsMissing()                // _Libraries/example/tc3_motorlib is a file, or the version path is a file → Missing, Reason "a file is in the way" (R48)
[Fact] public void LeftoverStageOrOldFolderIsNotAVersion()     // .1.2.0.0.iecode-sync and .1.2.0.0.iecode-old (with a library file inside) → no item, never Prune (R48)
[Fact] public void SharedFolderWithUnselectedSharerIsNotPruned() // P1 selected, P2 (other, same folder) not: 1.1.0.0 wanted by P2 is Kept/Stale, never Prune, Reason "shared with P2, not selected"; both selected → P2's wanted version is not stale (R52)
```

- [ ] **Step 2:** build, expected: build error or failing tests.
- [ ] **Step 3: Implement the classification.** Existing versions from `ProjectLibraries.Scan(folder)` (round-1 rule for free), excluding reparse-point folders (Plan side of decision 5). Comparison of file sets: `Selects`-filtered relative paths, ordinal-ignore-case, then length, then bytes. `Selects` becomes final per the Task 0 gate (`true`, or `ProjectLibraries.IsLibraryFile`). Case and file-in-the-way checks as in decision 12; sharers as in decision 13.
- [ ] **Step 4:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class "*ProjectFolderSyncTests"`, expected: all pass.
- [ ] **Step 5: Commit** `Classify existing project library folders for sync` (body: why prune only touches library version folders and why links and shared folders are left alone).

### Task 3: `ProjectFolderSync.Stage`, `Swap`, `Apply`

**Files:**
- Modify: `cli/src/IECode.Core/Projects/ProjectFolderSync.cs`
- Test: `cli/tests/IECode.Core.Tests/ProjectFolderSyncTests.cs`

**Interfaces:**
- Consumes: `FolderSyncPlan`, `FolderSyncItem` (Tasks 1, 2).
- Produces:
  - `public sealed record FolderSyncResult(int Added, int Updated, int Pruned, IReadOnlyList<FolderSyncItem> Skipped);`
  - `public static FolderSyncStage Stage(FolderSyncPlan plan)`: checks the whole path for links (decision 5), removes leftover stage folders, copies every Add/Update source into its stage folder. Reads the repository only; this is the part that runs under the lock (decision 8).
  - `public static FolderSyncResult Swap(FolderSyncStage stage, bool force)`: restores or deletes leftover `.iecode-old` folders, swaps each stage in (decision 9), prunes (decision 5), skips folders with local git changes unless `force` (decision 11). Touches only the project folder; runs after the lock is released.
  - `public static FolderSyncResult Apply(FolderSyncPlan plan, bool force)` = `Stage` then `Swap` (used by tests and one-plan callers).
  - `public static bool HasLocalChanges(string folder)`: `Git.Open(folder)` then `StatusEntries(folder).Count > 0`; no git work tree or no git → `false`.
  - All three throw `InvalidOperationException` when `plan.HasMissing` (the CLI checks first). `IOException` / `UnauthorizedAccessException` become `IECodeException(ExitCodes.LibraryFailed, "<target>: <message>; <n> of <m> applied.")`; a link on the path is `IECodeException(ExitCodes.LibraryFailed, "<path> is a link; sync does not follow links.")`.
  - `internal static Action<string>? Step` (AsyncLocal, like `Git.Executable`, `Git.cs:15`): called with `"aside"` and `"moved"` per version during the swap so tests can fail between the renames.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void ApplyCopiesAddedVersionWithAllSelectedFiles()   // target holds Tc3_MotorLib.library and projectinfo, bytes equal; Plan again → all Unchanged
[Fact] public void ApplyUpdateReplacesFilesAndDeletesExtraOnes()   // extra selected file gone; a non-selected file (if Selects filters) is carried over into the new folder (decision 9)
[Fact] public void ApplyPruneRemovesVersionAndEmptyParents()       // 1.1.0.0 gone; tc3_motorlib folder kept while 1.2.0.0 exists; vendor folder removed when it became empty
[Fact] public void ApplyNeverTouchesStaleOrKept()                  // prune:false plan → 1.1.0.0 and tc3_other still there
[Fact] public void ApplyRefusesPlanWithMissing()                   // Assert.Throws<InvalidOperationException>; folder unchanged (snapshot of file list before/after)
[Fact] public void StageWritesOnlyStageFolders()                   // after Stage, before Swap: every version folder unchanged, `.1.2.0.0.iecode-sync` holds the copy; this is why the lock can end before Swap (R46)
[Fact] public void LeftoverStageFolderIsRemoved()                  // _Libraries/example/tc3_motorlib/.1.2.0.0.iecode-sync exists → gone after Apply, not reported as a version
[Fact] public void FailureBetweenTheRenamesKeepsTheOldVersion()    // Step throws IOException after "aside": Apply throws IECodeException 12, message "… 0 of 1 applied."; `.1.2.0.0.iecode-old` holds the old files (R44)
[Fact] public void FailureAfterTheMoveKeepsTheNewVersion()         // Step throws after "moved": new version in place, old files still in `.iecode-old`; a later Apply deletes it
[Fact] public void LeftoverOldFolderIsRestoredWhenVersionFolderIsMissing() // `.1.2.0.0.iecode-old` and no 1.2.0.0 → after Swap the files are back (renamed), also when the plan has no item for that version
[Fact] public void LeftoverOldFolderIsDeletedWhenVersionFolderExists() // both exist → `.iecode-old` gone, version folder untouched
[Fact] public void ApplyFailureReportsHowManyWereApplied()         // two Update items, Step throws on the second → IECodeException 12, message "… 1 of 2 applied."
[Fact] public void TwoProjectsKeepTheirOwnVersions()               // plans of two projects pinning 1.2.0.0 and 1.3.0.0 applied in turn → each _Libraries holds only its own version (R48)
[Fact] public void ReadOnlyTargetFilesAreReplaced()                // Windows only: target file read-only → Update succeeds, Prune succeeds
[Fact] public void LinkedLibrariesFolderIsRefused()                // _Libraries is a link to an outside folder (symlink, else mklink /J) → Stage throws IECodeException 12 before any write; outside folder unchanged (R43)
[Fact] public void LinkedVendorFolderIsRefused()                   // _Libraries/example is a link → exit 12, nothing written in the project, outside unchanged
[Fact] public void LinkedLibraryFolderIsRefused()                  // _Libraries/example/tc3_motorlib is a link → exit 12, a Prune plan deletes nothing outside
[Fact] public void LinkedWantedVersionFolderIsRefused()            // the wanted version folder itself is a link → exit 12
[Fact] public void UpdateSkipsFolderWithLocalGitChanges()          // git init + commit the version folder, edit a file → Update is skipped, Skipped holds the item, file still edited; skip when git is unavailable (R45)
[Fact] public void PruneSkipsFolderWithLocalGitChanges()           // same for a Prune item: folder still there, in Skipped
[Fact] public void ForceOverwritesLocalGitChanges()                // force: true → the edited file is replaced, nothing skipped
[Fact] public void NoGitMeansNoLocalChangeCheck()                  // Git.Executable = a missing file, or folder outside any work tree → Update runs, Skipped empty
```

Link tests use the helper of premise 14 (symlink, then `cmd /c mklink /J`, then `Assert.Skip`); the `Windows only` test uses `Assert.SkipUnless(WindowsOnly.IsWindows, ...)`.

- [ ] **Step 2:** build, expected: build error.
- [ ] **Step 3: Implement `Stage` / `Swap` / `Apply`.** `Stage`: before any write walk every component from `_Libraries` to each Add/Update/Prune target and throw exit 12 on the first reparse point (`FileAttributes.ReparsePoint`); remove `*.iecode-sync` stage folders two levels below `_Libraries`; per Add/Update copy selected files into `.<version>.iecode-sync` (clear read-only). `Swap`: per library folder, restore (`Directory.Move` back) or delete `.<version>.iecode-old` (decision 9); per Add/Update, unless skipped by `HasLocalChanges` and not `force`: `Directory.Move(old, .<version>.iecode-old)`, `Step("aside")`, `Directory.Move(stage, target)`, `Step("moved")`, move non-selected files of the old folder into the target, `Isolation.DeleteFolder(old)`; per Prune assert `Path.GetFullPath(target)` starts with the folder plus separator (the link check already ran in `Stage`), then `Isolation.DeleteFolder`, then delete the library and vendor folder when empty. Counters feed the `n of m applied` message.
- [ ] **Step 4:** run the filter-class command, expected: all pass (the read-only and link tests skipped on ubuntu where noted).
- [ ] **Step 5: Commit** `Apply project library folder sync with staged copies` (body: why two phases, why rename-aside instead of delete-first, why prune re-checks the whole path, why local git changes skip).

### Task 4: `iecode lib project-folder sync` command, docs

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs:10,16` and a new `ProjectFolder()` method after `InstallProject` (`:498`)
- Modify: `cli/README.md` (row after `:34`), `extension/CHANGELOG.md` (under `:5`)

**Interfaces:**
- Consumes: `ProjectFolderSync.PlanAll`, `Stage`, `Swap`, `HasLocalChanges`, `FolderSyncPlan`, `FolderSyncResult`; `RepositoryPath`, `LoadProjects`, `RepositoryLock.Acquire`, `TimeoutSetting.FromSeconds(ctx.Get(Globals.Timeout)) ?? RepositoryLock.DefaultTimeout`.
- Produces: command `lib project-folder sync [paths…] [--prune] [--repository <folder>] [--dry-run] [--force]`.

- [ ] **Step 1: Wire the command.** Order: load projects (`LoadProjects(paths)`; with explicit paths also load the other `.plcproj` files below the current folder as `others`, decision 13); skip those without `_Libraries` (detail line), none → exit 3 with the `install-project` hint (`LibraryCommands.cs:465-466`); unless `--dry-run`, acquire the lock; scan `RepositoryPath(--repository)`; `PlanAll` (`maxPath` 259 on Windows, else `int.MaxValue`); print one line per item except `Unchanged`/`Kept` (those with `-v`), every `Prune` line included, before any write; any `HasMissing` → error per missing item, `Outcome` exit 3, nothing written; `--dry-run` → list folders that a real run would skip (`HasLocalChanges`), `Outcome.Ok`; else `Stage` every plan, **release the lock**, then `Swap` each plan (`--force` passed through), success line `N added, N updated, N pruned`, warn "N folder(s) skipped: local changes, pass --force" when `Skipped` is not empty, warn "N stale version(s) kept; pass --prune to remove them" when any `Stale`. The lock is a `using` block that ends after the `Stage` loop (R46).
- [ ] **Step 2: JSON** (one object, camelCase by `Reporter`): `{ dryRun, prune, force, repository, folders: [ { projects, folder, items: [FolderSyncItem…] } ], added, updated, pruned, skipped, missing }`. Exit 3 still writes this object.
- [ ] **Step 3: Docs.** README row: `` `lib project-folder sync [paths…] [--prune] [--dry-run] [--force]` | Copy the referenced library versions (pinned, `*` = highest installed) from the library repository into each project's `_Libraries` folder; `--prune` removes other versions of those libraries. Reverse of `install-project`; waits for iecode installs while reading the repository, not for installs made in XAE. Folders with local git changes are skipped unless `--force`. Exit 3: a wanted version is not installed (as in `lib check`), a target path is too long, a name collides or a file is in the way, nothing written; exit 12: a copy, move or delete failed, or a link was found in the `_Libraries` path. Atomic per version, not across versions or projects. `--prune` limit: a second version of a directly referenced library that another library depends on is pruned; run `--dry-run --prune` first | files ``. CHANGELOG: `- CLI: \`iecode lib project-folder sync [--prune]\` brings a tracked \`_Libraries\` folder in line with the project's library references, without TwinCAT.`
- [ ] **Step 4:** `dotnet build cli/IECode.slnx`, expected: success, no new warnings. Then on the dev PC against a temp copy of a fixture project (`--repository <temp repo>`): `--dry-run --json` shows `add`; a run writes; a second run prints only unchanged; removing the repository version gives exit 3 and no change (`git status` clean in the temp copy).
- [ ] **Step 5: Manual PC check (about 0.5 day, R4).** On a TwinCAT PC with a tracked project: dry-run, run, `git diff` shows only the expected version folders; a hand edit in a version folder is skipped and `--force` replaces it; two `.plcproj` files sharing a folder give one plan; a second `iecode` shell holding an install is waited for only during the copy phase. Record the result in this plan.
- [ ] **Step 6: Commit** `Add lib project-folder sync` (body: tracked `_Libraries` drifted from the resolutions with no way back except XAE's dialog; reverse of install-project).

## Open risks

- U1/U2 unanswered → Task 0 must run before Task 2 is merged (Task 1 does not depend on it); the filter is one function, so a late answer costs one test change.
- Indirect dependencies are neither added nor pruned. A `_Libraries` folder synced by iecode can lack a dependency XAE would have added; a follow-up could read the repository's `dependencies` file once its format is known (Task 0 step 1 can note whether it is text). `--prune` can delete a second version of a directly referenced library that a dependency needs (U4, R51); guarded by the dry-run list and decision 11, named in the README.
- The lock covers iecode-driven RepTool calls only; an install made in XAE during a sync can still be copied half-written. The library-file check catches the empty case, not a truncated file.
- Atomicity is per version: a failure on the third of five versions leaves two swapped and three not (the message says `n of m applied`). A rerun finishes it; leftover `.iecode-old` / `.iecode-sync` folders are handled at the start of the next run.
- The 259-character path check is conservative: a PC with long paths enabled is still stopped. Sharers of one `_Libraries` folder outside the current folder cannot be named; with a partial selection they are unknown and `--prune` may remove a version only they need (the README says to select all sharers).
- A synced but uncommitted folder counts as "local changes" on the next run and its Update/Prune is skipped until it is committed or `--force` is given.
