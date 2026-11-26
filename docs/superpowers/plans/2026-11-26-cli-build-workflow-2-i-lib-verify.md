# `iecode lib verify` Implementation Plan (round 2, plan I)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the lost library install, then add `iecode lib verify`, which tells whether TwinCAT itself sees a library version (not only whether its folder exists), and check TwinCAT's view after every repository write iecode makes.

**Architecture:** A spike on a TwinCAT PC (Task 1) decides where TwinCAT's own view of the repository lives. The most likely answer is the repository index file `cache` in the root of `Managed Libraries`. Core gets a pure parser for that index (`RepositoryIndex`) and a pure comparison of references, version folders and index (`LibraryVerify`). The CLI only wires them: a new `lib verify` command and a check after RepTool installs and uninstalls. A shell query through the library manager (Task 6) is built only for the outcomes that need it.

**Tech Stack:** C# .NET, xUnit, System.CommandLine, System.Xml.Linq, COM late binding to the XAE shell (Task 6 only).

**Spec:** `docs/research/cli-build-workflow.md` section 2 and Q4; `TODO.md` "CLI: build and library workflow at scale" (`lib verify`, only after the lost install is reproduced).

## Global Constraints

- Public repository: no internal company names, paths or data in code, tests, fixtures, docs. Fixtures use `Tc3_MotorLib`, `Tc3_AxisLib`, vendor `Example`.
- Decisions live in `IECode.Core` (pure, xUnit, runs on Windows and ubuntu CI); `IECode.Cli` and `IECode.Automation` only wire them. There is no test project for `IECode.Cli`. Windows-only tests are guarded with `Assert.SkipUnless(WindowsOnly.IsWindows, …)`.
- Test command: `dotnet test --project cli/tests/IECode.Core.Tests` (with `--filter-class` / `--filter-method`), through the PowerShell tool; `dotnet build` and `dotnet test` as separate commands.
- JSON output changes are additive; existing exit codes keep their meaning; this plan adds no exit code.
- Every user-visible change: a line under `## Unreleased` in `extension/CHANGELOG.md`, new options/commands a row in `cli/README.md`.
- Commits: English subject plus 1-3 sentence why-body, `git commit -s` with the GitHub noreply address.
- All sizes tagged `[estimated]`.
- Steps that need a TwinCAT PC (4024 and 4026 installed) are marked **manual** and kept short and exact.
- Plan-specific: `lib verify` never writes the repository (no RepTool call, no repository lock). The index file is read with `FileShare.ReadWrite | FileShare.Delete`, so a running XAE is never blocked.
- Plan-specific: the spike runs only with throwaway libraries of vendor `Example` and restores every repository file it touches from a backup.

## Premises checked (tree `iecode-cli-build`, branch `feature/cli-build-workflow-d`)

1. `lib installed` only scans folders `<vendor>/<library>/<version>/`: `cli/src/IECode.Core/Projects/LibraryRepository.cs:33-47`, used by `LibraryCommands.cs:313-328`. It cannot see TwinCAT's index.
2. Since round 1, `lib save --install` and `save-all --install` save with `install: false` (`LibraryCommands.cs:75`, `:125`) and install through `Runner.InstallSaved` (`cli/src/IECode.Cli/Runner.cs:122-131`), which calls `RepTool.Install` under `RepositoryLock` (`cli/src/IECode.Automation/RepTool.cs:78-105`, lock `cli/src/IECode.Core/RepositoryLock.cs:15`, `Local\iecode-library-repository`).
3. The lock, the RepTool install switch and the writer record came in one commit, `4a72d73 Serialise writes to the library repository`. Its parent is the state of the incident (XAE `SaveAsLibrary(file, install: true)`, no lock). There is **no** env or test switch to turn the lock off (`RepositoryLock.Acquire(..., string name = Name)` takes a name, but `RepTool.Run` always passes the default). The spike therefore builds `4a72d73^`.
4. RepTool has no list or query action (measured: `RepTool.exe --help` of 4024.66 lists create/remove/move repos, install, uninstall, compile, visu and device actions only). "Ask RepTool" is not possible; a TwinCAT view comes from an index file or from a shell.
5. The repository root holds, next to the vendor folders, `cache` (UTF-16 XML `<LibraryRepository TimestampLegacyCache="…"><Library Path="<vendor>\<library>\<version>\<file>" Title=… Version=… Company=… /> <LibraryCategory …/>`), `profile` (placeholder resolutions) and `LibraryCategoryBase.libcat.xml` (measured on the planning PC, 2026-11-26: 565 `<Library>` entries, 565 version folders). Each version folder holds the library file, `browsercache`, `dependencies`, `projectinfo`; these four are what the Q4 answer compared, the root `cache` was **not** checked then.
6. The Automation layer has no library manager access today: no `ITcPlcLibraryManager`, `References` or `ScanLibraries` in `cli/src/IECode.Automation` (only `LookupTreeItem("TIPC")` in `XaeShell.Plc.cs:17`). Beckhoff documents `ITcPlcLibraryManager.ScanLibraries()` (all libraries of all repositories) on the `References` tree item; **unverified** here (spike step S4).
7. `lib check` (`LibraryCommands.cs:360-379`) uses `Restore.Check` (`cli/src/IECode.Core/Projects/Restore.cs:71-93`) and exits 3 when something is missing; `DefaultRepositories()` is at `LibraryCommands.cs:333-335`.
8. `ExitCodes` and `HelpText` live in `cli/src/IECode.Core/Errors.cs:4-28`; code 21 is unused (R2 dropped it).
9. **Unverified (Task 1 answers):** (a) a fresh shell's library manager trusts `cache` and does not rescan folders; (b) an XAE shell that started before an install writes its stale index back (on `SaveAsLibrary(install: true)`, on library manager actions or on exit); (c) a RepTool `--uninstallLibs` of many libraries while a shell is open loses other entries.

## Depends on (round-1 symbols, real signatures)

- `RepTool.Install(string path, bool overwrite, Reporter log) : int`, `RepTool.Uninstall(IEnumerable<string> libraries, Reporter log) : int` (`RepTool.cs:63`, `:74`)
- `Runner.InstallSaved(Context ctx, string file, TwinCatVersion version) : void` (`Runner.cs:122`)
- `Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false)` (`Runner.cs:84`), Task 6 only
- `LibraryRepository.Scan(string root)`, `Candidates(...)`, `Newest(...)`, `Compare(string a, string b)`; `InstalledLibrary(Name, Version, Vendor, Path)`; `LibraryId(Name, Version, Vendor)` with `IsNewest`; `LibraryReference.Effective`; `PlcProjectFile.References`, `.Title`, `.Company`, `.ProjectVersion`
- `LibraryCommands.DefaultRepositories()`, `LoadProjects(string[]?)`, `PathsArg(string)`; `XaeShell.FindPlc(string?) : PlcHandle` (Task 6)

## Touches (existing files)

- `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (new `Verify()` in the subcommand list at `:16`, summary at `:10`; check after `Uninstall` at `:523`). **Conflicts with plan H** (`lib project-folder sync` adds a subcommand in the same list): merge order H then I or I then H, one-line conflict.
- `cli/src/IECode.Cli/Runner.cs` (`InstallSaved` gets an optional expected `LibraryId`), and its two callers in `LibraryCommands.cs:76`, `:126`.
- `cli/README.md`, `extension/CHANGELOG.md`.
- Task 6 only: new `cli/src/IECode.Automation/XaeShell.Libraries.cs` (new partial, no edit of existing Automation files).

## Decisions

1. **Truth source = TwinCAT's repository index, read from the file** (if Task 1 confirms). Cheap, any OS, no shell. Rejected: always starting a shell (minutes per call, needs a solution, cannot run in CI).
2. **CLI shape:** `iecode lib verify [paths…] [--lib <name>[=<version>]]… [--vendor <vendor>] [--all] [--repository <dir>]…`. Paths read the references (effective version, `*` resolved to the highest folder version); `--lib` names libraries directly (bare name = `*`, needs `--vendor` or matches any vendor); `--all` checks every version folder against the index (the bulk-uninstall case). `--lib`/`--all` and paths are exclusive (usage, exit 2). Rejected: `lib verify <name> <version>` positional (cannot read projects; the incident started from a project).
3. **States per item:** `ok` (folder and index entry), `notIndexed` (folder, no index entry: the incident), `indexOnly` (index entry, no folder), `missing` (neither). For `*`: `notIndexed` when the highest folder version is not indexed, with `indexedVersion` = what TwinCAT will pick.
4. **Exit codes, no new code:** 0 all `ok`; 3 any other state (same as `lib check`); 1 when no index file exists in any repository checked (hint: run `lib verify --shell` / open the repository once in XAE); 2 usage. Rejected: new code 21 (parallel lanes E, F, J may claim codes; JSON `state` already tells the cases apart).
5. **Several repositories:** an item is `ok` when one repository has folder and entry, else the worst state found, with `repository` naming where. Same rule as decision 1 of round 1 (4024 and 4026 can differ).
6. **Check after writes, warn-then-fail:** after a RepTool install of a saved library, the expected entry must be in the index, else exit 12 (`LibraryFailed`) with hint "uninstall and install again"; after `lib uninstall`, entries that vanished but were not uninstalled are printed as errors and exit 12. Only when an index file exists before the write; otherwise silent. Rejected: a separate `--verify` flag (the incident was exactly an "installed" claim that was false).
7. **No `--repair`.** The observed fix (uninstall + install) needs the original library file, which the repository keeps under a renamed extension. The hint names the commands. YAGNI until someone asks.

## Review Focus

1. Index file written by XAE while `lib verify` reads it (partial XML): expect one retry after 500 ms, then exit 1 "index unreadable", never a crash. Test in Task 2 (`Read_TruncatedXml_ReturnsUnreadable`).
2. Folder names in other case than `Title`/`Company` (`LibraryRepository` says names are lower-case on disk on some installs): match by the path segments case-insensitively. Test in Task 2.
3. Version typed as `1.3.0` against `1.3.0.0` on disk: equal via `LibraryRepository.Compare`. Test in Task 3.
4. `*` reference whose highest folder is not indexed but a lower one is: `notIndexed` with `indexedVersion`, not `ok`. Test in Task 3.
5. Repository without `cache` (fresh install, older layout `Components\Plc\Managed Libraries`): exit 1 with hint, not "everything missing". Test in Task 3 (`ExitCode_NoIndex_IsFailed`).

---

### Task 1: Reproduction spike (manual, TwinCAT PC) `[estimated: 2.5 h]`

Gates every later task. Records go into the plan's "Spike result" section (append below Task 6) and into `docs/research/cli-build-workflow.md` Q4.

- [ ] **S0 setup.** Outside any repository (`C:\Temp\verify-spike`): in XAE 4024 create two library solutions `Tc3_MotorLib` and `Tc3_AxisLib` (Company `Example`, Version `1.0.0.0`) and a `Consumer` solution whose PLC pins both. Build iecode at the incident state in a temporary worktree of the main clone: `git worktree add C:\Temp\iecode-prelock 4a72d73^`, then `dotnet build C:\Temp\iecode-prelock\cli\src\IECode.Cli -c Release`. Current iecode = the branch build.
- [ ] **Snapshot helper** (PowerShell, before and after every scenario): `$r="$env:ProgramData\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries"; Get-ChildItem $r -Recurse -File | Get-FileHash | Export-Csv snap-N.csv`; diff with `Compare-Object (Import-Csv a) (Import-Csv b) -Property Path,Hash`; index entries: `Select-String -Path "$r\cache" -Pattern 'Example'`. Back up `cache` and `profile` before S1.
- [ ] **S1 index decides? (deterministic).** Install `Tc3_MotorLib 1.0.0.0` with current iecode. Remove only its `<Library …/>` line from `cache` (backup kept), run `iecode build Consumer.sln --tc 4024`. Record: library manager error yes/no; did the shell rewrite `cache` (entry back?). Restore `cache`. Inverse: keep the entry, rename the version folder, build, record, rename back.
- [ ] **S2 parallel installs (hypothesis a).** Bump both libraries to `1.0.1.0`. Start both `C:\Temp\iecode-prelock\…\iecode.exe lib save <sln> --install --tc 4024` at once (`Start-Process` twice); 3 rounds with new versions each. After each round: snapshot diff, both entries in `cache`?, Consumer build result. Repeat one round with current iecode (lock): expect clean.
- [ ] **S3 bulk uninstall (hypothesis b).** Install `1.0.2.0` of both plus `1.0.3.0` of `Tc3_MotorLib`. Open XAE GUI with `Consumer` (a shell with an old index), then `iecode lib uninstall --all --vendor Example --version 1.0.2.0 --yes`, then close XAE. Record which entries are in `cache` after the uninstall and after XAE closed; Consumer build with `1.0.3.0`. Repeat without the open XAE.
- [ ] **S4 shell query.** In a script against a visible shell (or a scratch C# test), `LookupTreeItem("TIPC^<plc>^<plc> Project^References")`, call `ScanLibraries()`, list `Name`/`Version`/`Distributor` of the result. Record whether it exists, how long it takes, and whether its list follows `cache` after S1's edit.
- [ ] **Restore** `cache`/`profile` from backup if any scenario left a difference outside vendor `Example`; uninstall all `Example` versions; delete the temp worktree (`git worktree remove C:\Temp\iecode-prelock`).

**Gate (what each outcome means):**

| Outcome | Meaning | Tasks |
|---|---|---|
| O1 (expected): S1 shows "not installed" with the entry removed and the folder present | `cache` is TwinCAT's truth | Tasks 2 to 5 as written; Task 6 skipped |
| O1 + S2 or S3 reproduces | cause known; write it into Q4; if only S3 reproduces, note in the CHANGELOG that the lock was not the fix and Task 5's uninstall check is the guard | as O1 |
| O2: S1 has no effect, but S2/S3 diffs show another changed file (e.g. `profile`, a file in `PlcEngineering\Build_*`) | the index lives elsewhere | Task 2 parses that file instead (same `IndexEntry` record, new `FileName`); Tasks 3 to 5 unchanged |
| O3: S1 has no effect and nothing reproduces | no file-based truth known | Skip Tasks 2 and 5; Task 3 compares references with a `ScanLibraries` list instead of the index; Task 6 becomes the default mode of `lib verify` (needs paths, Windows, exit 20 elsewhere); the lock stays the fix |
| O3 and S4: `ScanLibraries` missing | neither an index nor a shell query | drop `lib verify` (a probe build per reference is too slow to be a check), keep `lib check` and the lock, close the TODO item with the finding |
| O1 and S4: `ScanLibraries` missing | index mode suffices | Task 6 is dropped for good |

### Task 2: `RepositoryIndex` parser `[estimated: 2 h]`

**Files:**
- Create: `cli/src/IECode.Core/Projects/RepositoryIndex.cs`
- Test: `cli/tests/IECode.Core.Tests/RepositoryIndexTests.cs`

**Interfaces:**
- Produces: `public sealed record IndexEntry(string Vendor, string Name, string Version, string? Title, string? Company);`
- `public enum IndexReadState { Read, Missing, Unreadable }`; `public sealed record IndexRead(IndexReadState State, IReadOnlyList<IndexEntry> Entries, string? Error);`
- `public static class RepositoryIndex { public const string FileName = "cache"; public static IReadOnlyList<IndexEntry> Parse(string xml); public static IndexRead Read(string repositoryRoot); public static bool Contains(IReadOnlyList<IndexEntry> index, string name, string version, string vendor); public static IReadOnlyList<IndexEntry> Lost(IReadOnlyList<IndexEntry> before, IReadOnlyList<IndexEntry> after, IReadOnlyCollection<LibraryId> removed); }`

- [ ] **Step 1: Write the failing tests** (fixture XML in the test, vendor `Example`):
  - `Parse_TakesVendorNameVersionFromPath`: `<Library Path="Example\Tc3_MotorLib\1.0.1.0\Tc3_MotorLib.library" Title="Tc3_MotorLib" Version="1.0.1.0" Company="Example" />` gives `IndexEntry("Example","Tc3_MotorLib","1.0.1.0","Tc3_MotorLib","Example")`.
  - `Parse_IgnoresCategoriesAndShortPaths`: `<LibraryCategory …/>` and `Path="x.library"` give no entry.
  - `Contains_IgnoresCaseAndTrailingZeros`: entry `example\tc3_motorlib\1.0.1.0` contains `("Tc3_MotorLib","1.0.1","Example")`.
  - `Read_NoFile_IsMissing`, `Read_Utf16File_IsRead` (write with `Encoding.Unicode`), `Read_TruncatedXml_ReturnsUnreadable` (state `Unreadable`, `Error` not null, no exception).
  - `Lost_ReportsOnlyEntriesNotRemoved`: before {Motor 1.0.1.0, Motor 1.0.2.0, Axis 1.0.2.0}, after {Motor 1.0.1.0}, removed {Motor 1.0.2.0} → `[Axis 1.0.2.0]`.
- [ ] **Step 2:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class IECode.Core.Tests.RepositoryIndexTests` → FAIL (type missing).
- [ ] **Step 3: Implement.** `XDocument.Load` on a `FileStream` opened with `FileShare.ReadWrite | FileShare.Delete` (BOM detection gives UTF-16); `Unreadable` after one retry 500 ms later on `XmlException`/`IOException`. Key = first three `\`-segments of `Path`; versions compared with `LibraryRepository.Compare`.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `Read TwinCAT's library repository index` (body: `lib installed` only sees folders; the spike showed TwinCAT trusts the `cache` index, so a check has to read it).

### Task 3: `LibraryVerify` decision `[estimated: 3 h]`

**Files:**
- Create: `cli/src/IECode.Core/Projects/LibraryVerify.cs`
- Test: `cli/tests/IECode.Core.Tests/LibraryVerifyTests.cs`

**Interfaces:**
- Consumes: Task 2's `IndexEntry`, `IndexRead`, `RepositoryIndex.Contains`.
- Produces: `public enum VerifyState { Ok, NotIndexed, IndexOnly, Missing }` (JSON camelCase `ok`, `notIndexed`, `indexOnly`, `missing`)
- `public sealed record VerifyRequest(LibraryId Id, IReadOnlyList<string> Projects);`
- `public sealed record RepositoryView(string Root, IReadOnlyList<InstalledLibrary> Folders, IndexRead Index);`
- `public sealed record VerifyItem(string Name, string Version, string Vendor, VerifyState State, string? Repository, string? IndexedVersion, IReadOnlyList<string> Projects);`
- `public static class LibraryVerify { public static IReadOnlyList<VerifyRequest> FromProjects(IEnumerable<PlcProjectFile> projects); public static IReadOnlyList<VerifyRequest> FromNames(IReadOnlyList<string> libs, string? vendor, IReadOnlyList<RepositoryView> repos); public static IReadOnlyList<VerifyRequest> All(IReadOnlyList<RepositoryView> repos, string? vendor); public static IReadOnlyList<VerifyItem> Check(IReadOnlyList<VerifyRequest> wanted, IReadOnlyList<RepositoryView> repos); public static int ExitCode(IReadOnlyList<VerifyItem> items, IReadOnlyList<RepositoryView> repos); }`

- [ ] **Step 1: Write the failing tests** (project XML as in `ReferenceCheckTests`, `TempWorkspace`):
  - `Pinned_FolderAndEntry_IsOk`; `Pinned_FolderWithoutEntry_IsNotIndexed` (the incident); `EntryWithoutFolder_IsIndexOnly`; `Neither_IsMissing`.
  - `Star_HighestFolderNotIndexed_ReportsIndexedVersion`: folders 1.0.1.0 and 1.0.2.0, index only 1.0.1.0 → `NotIndexed`, `Version == "1.0.2.0"`, `IndexedVersion == "1.0.1.0"`.
  - `TypedShortVersion_MatchesFourPartFolder`: `--lib Tc3_MotorLib=1.0.1` against folder `1.0.1.0` → `Ok`.
  - `TwoRepositories_OkInOne_IsOk`; `TwoRepositories_NotIndexedInBoth_NamesFirstRepository`.
  - `GroupsProjectsPerLibrary`: two projects pinning the same version → one item, `Projects` both names.
  - `FromNames_PairAndBareName`: `["Tc3_MotorLib=1.0.1.0","Tc3_AxisLib"]` → pinned and `*`; `FromNames_EmptyName_IsUsage` (exit 2).
  - `All_ListsEveryFolderAndOrphanEntry` (vendor filter applied).
  - `ExitCode_AllOk_IsZero`, `ExitCode_AnyProblem_IsNotFound` (3), `ExitCode_NoIndex_IsFailed` (1, every repo `Missing`/`Unreadable`).
- [ ] **Step 2:** `--filter-class IECode.Core.Tests.LibraryVerifyTests` → FAIL.
- [ ] **Step 3: Implement** in `LibraryVerify.cs`. Repositories whose index is not `Read` count only for `Missing` vs folder presence, never for `Ok`.
- [ ] **Step 4:** → PASS; then the whole suite → all green.
- [ ] **Step 5: Commit** `Decide whether TwinCAT sees each referenced library version`.

### Task 4: `iecode lib verify` command and docs `[estimated: 2 h]`

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`Verify()`, list at `:16`, summary at `:10`)
- Modify: `cli/README.md` (commands table after the `lib check` row; JSON section), `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 3 (`FromProjects`, `FromNames`, `All`, `Check`, `ExitCode`), Task 2 (`RepositoryIndex.Read`), `DefaultRepositories()`, `LoadProjects`, `LibraryRepository.Scan`.
- Produces: JSON `data = { repositories: [{ path, index: "read"|"missing"|"unreadable", entries, folders }], items: [VerifyItem…], problems: <count> }`.

- [ ] **Step 1:** Add the command: options `--lib`/`-l` (`string[]`), `--vendor`, `--all`, `--repository` (`string[]`, default `DefaultRepositories()` that exist). Usage errors (exit 2): paths together with `--lib`/`--all`; `--all` with `--lib`. Runs on any OS (no `windowsOnly`).
- [ ] **Step 2:** Human output: one line per problem, `✖ Tc3_MotorLib 1.0.1.0 (Example): folder present, not in TwinCAT's index · used by PLC1` (`notIndexed`), `… in TwinCAT's index, folder missing` (`indexOnly`), `… not installed` (`missing`), `* resolves to 1.0.1.0 in TwinCAT, 1.0.2.0 is not indexed`; hint for `notIndexed`: `iecode lib uninstall <name> --vendor <v> --version <ver>` then install again. Success line: `All N library version(s) are known to TwinCAT`.
- [ ] **Step 3:** `dotnet build cli/src/IECode.Cli`, then run on the fixture folder `cli/tests/IECode.Core.Tests/Fixtures/Machine` with `--repository` pointing at a temp folder holding one `Example` version folder and a `cache` without its entry → exit 3 and the `notIndexed` line; with `--json` the fields above.
- [ ] **Step 4:** README row `lib verify [paths…] [--lib <name>[=<version>]]… [--vendor <v>] [--all] [--repository <dir>]…` ("whether TwinCAT itself knows each version: reads its repository index; exit 3 on problems, 1 without index; JSON `data.items[].state`"); CHANGELOG line under `## Unreleased`.
- [ ] **Step 5: Commit** `Add lib verify` (body: a folder scan said "installed" while the library manager said "not installed"; this reads what TwinCAT reads).

### Task 5: Check TwinCAT's index after iecode's repository writes `[estimated: 2.5 h]`

**Files:**
- Modify: `cli/src/IECode.Cli/Runner.cs` (`InstallSaved` gets `LibraryId? expected = null`)
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`:76`, `:126` pass the expected id from `PlcProjectFile.Title/ProjectVersion/Company`; `Uninstall` at `:523` reads the index before and after)
- Create (Core helper, tested): `public static string? AfterInstall(IndexRead before, IndexRead after, LibraryId expected)` and `public static IReadOnlyList<IndexEntry> AfterUninstall(IndexRead before, IndexRead after, IReadOnlyCollection<LibraryId> removed)` in `RepositoryIndex.cs`
- Test: `cli/tests/IECode.Core.Tests/RepositoryIndexTests.cs`

**Interfaces:**
- Consumes: Task 2 (`Read`, `Contains`, `Lost`).
- Produces: JSON additive field `indexChecked: true|false` on `lib save`, `save-all` items and `lib uninstall`; `lostEntries: [...]` on `lib uninstall` when not empty.

- [ ] **Step 1: Failing tests:** `AfterInstall_EntryPresent_ReturnsNull`; `AfterInstall_EntryMissing_ReturnsMessage` (contains `not in TwinCAT's index`); `AfterInstall_NoIndexBefore_ReturnsNull` (no false alarm on a repository without `cache`); `AfterUninstall_OtherEntriesLost_ReturnsThem`; `AfterUninstall_OnlyRemovedGone_ReturnsEmpty`.
- [ ] **Step 2:** `--filter-class IECode.Core.Tests.RepositoryIndexTests` → FAIL; implement; → PASS.
- [ ] **Step 3: Wire.** The repository to read is the one RepTool's profile writes: `LibrarySelection.SingleRepository(null, existing)` when one exists; with two, read both and accept the entry in either. On a problem: exit 12 (`LibraryFailed`) with the message; for uninstall also list `lostEntries`.
- [ ] **Step 4:** whole suite green; `dotnet build cli/src/IECode.Cli` clean. CHANGELOG line ("`lib save --install` and `lib uninstall` check TwinCAT's repository index afterwards").
- [ ] **Step 5: Commit** `Check the library index after installs and uninstalls` (body: both hypotheses of the lost install end in a missing index entry; checking right after the write turns a later build failure into an immediate exit 12).
- [ ] **Step 6 (manual, TwinCAT PC, 15 min):** repeat Task 1 S1 (entry removed by hand) and run `iecode lib verify C:\Temp\verify-spike\Consumer` → exit 3 `notIndexed`; restore and repeat → exit 0. Run S3 with current iecode → `lib uninstall` reports lost entries if the spike reproduced them, else exit 0.

### Task 6 (only for O3, or if O1 wants a second opinion): shell query `--shell` `[estimated: 4 h + 30 min manual]`

**Files:**
- Create: `cli/src/IECode.Automation/XaeShell.Libraries.cs` (`public IReadOnlyList<LibraryId> ScanLibraries(string? plcName)`: `FindPlc`, `LookupTreeItem($"{plc.TreePath}^References")` on the nested project, `ScanLibraries()`, map `Name`, `Version`, `Distributor`)
- Modify: `LibraryCommands.cs` `Verify()` (`--shell`, needs paths, `windowsOnly` path, exit 20 elsewhere)
- Core: `LibraryVerify.CheckAgainst(IReadOnlyList<VerifyRequest> wanted, IReadOnlyList<RepositoryView> repos, IReadOnlyList<LibraryId> seenByShell)`; the shell list replaces the index (state `notIndexed` = folder present, shell does not list it).
- Test: `LibraryVerifyTests.ShellList_*` (same four state tests against a list).

- [ ] Steps as Task 3 (test, fail, implement, pass), then wiring with `WithShell(ctx, solution, saves: false, …)`, `discard: true`; one shell per solution; README/CHANGELOG rows; commit `Ask a fresh XAE shell which libraries it sees`.
- [ ] **Manual:** S1 edit plus `lib verify <Consumer> --shell` shows the same state as the index mode (O1) or the only correct one (O3).

## Size

Task 1 2.5 h, Task 2 2 h, Task 3 3 h, Task 4 2 h, Task 5 2.5 h plus 15 min manual; Task 6 4.5 h only for O3. Total about 1.5 days (O1) or 1.5 days with Task 6 instead of Tasks 2 and 5 (O3). All `[estimated]`.

## Open risks

- The index format may differ in 4026 or a later build (attribute names, `TimestampLegacyCache` triggering a rescan). Task 1 checks both lines; the parser ignores unknown attributes.
- An XAE GUI the user keeps open may rewrite `cache` after iecode's check passed; `lib verify` before a build is the answer, the post-write check cannot see the future.
- If O2 points to a per-build file under `PlcEngineering\Build_*`, the check depends on `--tc`; Task 2 then takes the build from `ChooseVersion`.
