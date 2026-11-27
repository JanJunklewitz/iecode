# `iecode lib verify` Implementation Plan (round 2, plan I)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproduce the lost library install, then add `iecode lib verify`, which tells whether TwinCAT itself sees a library version (not only whether its folder exists), and check TwinCAT's view after the repository writes of the save paths (`lib save`, `lib save-all`, `ws build`, `ws release`) and `lib uninstall`.

**Architecture:** A spike on a TwinCAT PC (Task 1) decides where TwinCAT's own view of the repository lives. The most likely answer is the repository index file `cache` in the root of `Managed Libraries`. Core gets a pure parser for that index (`RepositoryIndex`) and a pure comparison of references, version folders and index (`LibraryVerify`). The CLI only wires them: a new `lib verify` command and a check after RepTool installs and uninstalls. A shell query through the library manager (Task 6) is built only for the outcomes that need it.

**Tech Stack:** C# .NET, xUnit, System.CommandLine, System.Xml.Linq, COM late binding to the XAE shell (Task 6 only).

**Spec:** `docs/research/cli-build-workflow.md` section 2 and Q4; `TODO.md` "CLI: build and library workflow at scale" (`lib verify`, only after the lost install is reproduced).

**Review changes** (master plan, "Decision ledger"; the rows win over older text here):
- R2: Task 1 (two sessions, backup of both repository candidates, spike gates only this plan), Global Constraints. R3: Touches (E/I order of the `expected` argument). R4: "Manual PC check after merge", Size.
- R53: Task 1 S1 and the gate table, premise 10(d), decision 6, Task 5 step 3. R54: Task 5 (`InstallVerdict`, `InstallVerdictTests`, `FinishExport`). R55: Task 1 snapshot helper, S1, restore.
- R56: decisions 2 and 5, Task 3 (`ForLine`), Task 4 (global `--tc`). R57: Task 5 (`RepTool` reads under one lock hold, `AfterInstall_*Unreadable_*`, concurrent writer), decision 6. R58: Touches (`SaveReleased`), Task 5 (`ExpectedId`).
- R59: Task 2 (`Lost` with `all`), Task 5 (`StillIndexed`). R60: Task 1 S1, premise 10(e), Task 3 system-library tests. R61: "Run only if O1/O2" line at the top of Tasks 2 to 5 (the O3 gate row follows). R62: Task 1 S0 and S1. R63: Goal, Task 5 title, README note, Open risks.

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
- Plan-specific: the spike runs only with throwaway libraries of vendor `Example`, on a PC without a connected machine, after copying the whole `Managed Libraries` folder of **both** repository candidates (`LibraryRepository.Candidates`: ProgramData and `<TwinCAT>\Components\Plc\Managed Libraries`) aside and after creating a restore point; both copies are restored at the end (M9, R2). The spike changes the machine, so it is session B (after the read-mostly session A of the other plans) and gates only this plan; lanes start per plan.
- Plan-specific (M11): the outcome of spike S1 decides right after the spike, not during implementation, whether Tasks 2 to 5 run as written or `lib verify` shrinks to Task 6 or is dropped.

## Premises checked (`main` at `f817efe`)

1. `lib installed` only scans folders `<vendor>/<library>/<version>/`: `cli/src/IECode.Core/Projects/LibraryRepository.cs:40` (`Scan`), used by `LibraryCommands.cs:333-348`. It cannot see TwinCAT's index.
2. Since round 1 every library export goes through `Runner.StageExport` (XAE `SaveAsLibrary(..., install: false)` to a private path, `cli/src/IECode.Cli/Runner.cs:148-153`) and `Runner.FinishExport` (`Runner.cs:161-184`: waits for the file, calls `InstallSaved` when `installAs` is given, publishes). `InstallSaved` (`Runner.cs:192-203`) calls `RepTool.Install` under `RepositoryLock` (`cli/src/IECode.Automation/RepTool.cs:88-90`, lock name `RepTool.LockName`, default `RepositoryLock.Name` = `Local\iecode-library-repository`, `cli/src/IECode.Core/RepositoryLock.cs:18`). Installing callers of `FinishExport`: `lib save` (`LibraryCommands.cs:77-78`), `lib save-all` (`:126`), `ws build` (`WorkspaceCommands.cs:148`), `ws release` (`WorkspaceCommands.cs:231`).
3. The lock, the RepTool install switch and the writer record came in one commit, now `745ca7f Serialise writes to the library repository` on the new base (it was `4a72d73` before the rebase; that hash is not an ancestor of the current base). Its parent `311ca62` (= `745ca7f^`) is the state of the incident (`lib save` passes `install` to XAE `SaveAsLibrary`, checked at `311ca62:cli/src/IECode.Cli/Commands/LibraryCommands.cs:69`, no lock). There is **no** runtime switch to turn the lock off: `RepTool.LockName` is `internal init` and `RepTool.At(exe, profile, timeout, lockName)` (`RepTool.cs:25-28`) exists for tests only. The spike therefore builds `311ca62`.
4. RepTool has no list or query action (measured: `RepTool.exe --help` of 4024.66 lists create/remove/move repos, install, uninstall, compile, visu and device actions only). "Ask RepTool" is not possible; a TwinCAT view comes from an index file or from a shell.
5. The repository root holds, next to the vendor folders, `cache` (UTF-16 XML `<LibraryRepository TimestampLegacyCache="…"><Library Path="<vendor>\<library>\<version>\<file>" Title=… Version=… Company=… /> <LibraryCategory …/>`), `profile` (placeholder resolutions) and `LibraryCategoryBase.libcat.xml` (measured on the planning PC, 2026-11-26: 565 `<Library>` entries, 565 version folders). Each version folder holds the library file, `browsercache`, `dependencies`, `projectinfo`; these four are what the Q4 answer compared, the root `cache` was **not** checked then.
6. The Automation layer has no library manager access today: no `ITcPlcLibraryManager`, `References` or `ScanLibraries` in `cli/src/IECode.Automation` (only `LookupTreeItem("TIPC")` in `XaeShell.Plc.cs:17`). Beckhoff documents `ITcPlcLibraryManager.ScanLibraries()` (all libraries of all repositories) on the `References` tree item; **unverified** here (spike step S4).
7. `lib check` (`LibraryCommands.cs:383-405`) uses `Restore.Check` (`cli/src/IECode.Core/Projects/Restore.cs:93`) and exits 3 when something is missing; automatic candidates are scanned with `ScanAll`, folders named with `--repository` with `ScanExplicit` (`LibraryRepository.cs:68`, fails with exit 3 on a missing or unreadable folder). Its success line already says "file check; XAE may still fail to resolve them" (`LibraryCommands.cs:401`). `DefaultRepositories()` is at `LibraryCommands.cs:353-355`.
8. `ExitCodes` and `HelpText` live in `cli/src/IECode.Core/Errors.cs:4-28` and end at 20; master plan M1 gives 21 to plan J (`TestsFailed`), plan I adds none.
9. The repository a RepTool writes is known since round 1: `RepTool.Line` (`RepTool.cs:22`) and `LibraryRepository.ForLine(int line, string? twinCatDir, string? programData)` (`LibraryRepository.cs:35`). `lib uninstall` already computes it as `repoPath` (`LibraryCommands.cs:530-551`, `--all` through `LibrarySelection.UninstallRepository`), and calls `tool.Uninstall` at `:555`.
10. **Unverified (Task 1 answers):** (a) a fresh shell's library manager trusts `cache` and does not rescan folders; (b) an XAE shell that started before an install writes its stale index back (on `SaveAsLibrary(install: true)`, on library manager actions or on exit); (c) a RepTool `--uninstallLibs` of many libraries while a shell is open loses other entries; (d) a clean RepTool install of a new version adds its `cache` entry at once, with no shell running, on both lines (4024 and 4026); the post-install check of Task 5 depends on it; (e) Beckhoff system libraries and placeholder references appear in `cache` like other libraries (`Tc2_Standard`, vendor `Beckhoff Automation GmbH`), or not at all.

## Depends on (round-1 symbols, real signatures)

- `RepTool.Install(string path, bool overwrite, Reporter log) : int`, `RepTool.Uninstall(IEnumerable<string> libraries, Reporter log) : int` (`RepTool.cs:73`, `:84`); `RepTool.Line : int?` (`:22`)
- `Runner.InstallSaved(Context ctx, string file, TwinCatVersion version) : void` (`Runner.cs:192`); `Runner.FinishExport(Context ctx, StagedExport export, TwinCatVersion? installAs) : string` (`Runner.cs:161`)
- `Runner.WithShell<T>(Context ctx, string solution, bool saves, Func<XaeShell, T> body, bool discard = false, Action? beforeOpen = null)` (`Runner.cs:88`), Task 6 only
- `LibraryRepository.Scan(string root)`, `ScanAll(IEnumerable<string>)`, `ScanExplicit(IEnumerable<string>)`, `ForLine(int, string?, string?)`, `Candidates(...)`, `Newest(...)`, `Compare(string a, string b)`; `InstalledLibrary(Name, Version, Vendor, Path)`; `LibraryId(Name, Version, Vendor)` with `IsNewest`; `LibraryReference.Effective`; `PlcProjectFile.References`, `.Title`, `.Company`, `.ProjectVersion`
- `LibraryCommands.DefaultRepositories()`, `LoadProjects(string[]?)`, `PathsArg(string)`; `XaeShell.FindPlc(string?) : PlcHandle` (Task 6)

## Touches (existing files)

- `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (new `Verify()` in the subcommand list at `:16`, summary at `:10`; `lib check` success line `:401` gets a pointer to `lib verify`; check around `tool.Uninstall` at `:555`; `FinishExport` callers `:78`, `:126`). **Conflicts with plan H** (`lib project-folder sync` adds a subcommand in the same list): master plan order H before I, one-line conflict.
- `cli/src/IECode.Cli/Runner.cs`: `FinishExport` and `InstallSaved` each get the optional last parameter `LibraryId? expected = null` (M2), so existing calls compile unchanged; `null` means no check (R58). `InstallSaved` now returns `string?` (the index problem, `null` when fine) instead of `void`, and `FinishExport` hands it to `InstallVerdictRules.Decide` (R54).
- `cli/src/IECode.Automation/RepTool.cs`: `Install` and `Uninstall` get an overload that reads the index before and after the RepTool run inside the same lock hold as the write (`Run`, `:88-90`; R57).
- `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs:148` (`ws build`) and `:231` (`ws release`): pass the expected id (one argument each). `SaveReleased` (`:219`) gets a parameter `Func<LibraryId?> expected`, evaluated after `writeVersion()` so it holds the version that was written, and passes it to `FinishExport` (R58). **Overlaps plan E**, which rewrites the `ws build` install loop: E moves that loop in its own pure-move commit first (R3); whichever of E and I lands second adds the `expected` argument (M2) at E's call site.
- `cli/README.md`, `extension/CHANGELOG.md`.
- Task 6 only: new `cli/src/IECode.Automation/XaeShell.Libraries.cs` (new partial, no edit of existing Automation files).

## Decisions

1. **Truth source = TwinCAT's repository index, read from the file** (if Task 1 confirms). Cheap, any OS, no shell. Rejected: always starting a shell (minutes per call, needs a solution, cannot run in CI).
2. **CLI shape:** `iecode lib verify [paths…] [--lib <name>[=<version>]]… [--vendor <vendor>] [--all] [--repository <dir>]…`. Paths read the references (effective version, `*` resolved to the highest folder version); `--lib` names libraries directly (bare name = `*`, needs `--vendor` or matches any vendor); `--all` checks every version folder against the index (the bulk-uninstall case). `--lib`/`--all` and paths are exclusive (usage, exit 2). The global `--tc` picks the TwinCAT line (`ctx.Version.Line`) and with it the one repository that line builds from (`LibraryRepository.ForLine`, R56); without `--tc` the line is unknown. Rejected: `lib verify <name> <version>` positional (cannot read projects; the incident started from a project).
3. **States per item:** `ok` (folder and index entry), `notIndexed` (folder, no index entry: the incident), `indexOnly` (index entry, no folder), `missing` (neither). For `*`: `notIndexed` when the highest folder version is not indexed, with `indexedVersion` = what TwinCAT will pick.
4. **Exit codes, no new code:** 0 all `ok`; 3 any other state (same as `lib check`); 1 when no index file exists in any repository checked (hint: open the repository once in XAE, or run `lib verify --shell` where Task 6 exists); 2 usage. Rejected: a new code (M1 reserves 21 for J and keeps the other lanes at none; JSON `state` already tells the cases apart).
5. **Several repositories:** with `--tc` (line known) only that line's repository counts, so a library that is `ok` only in the other line's repository is `notIndexed` (a false OK for the line that builds is the worse error, R56). Only when the line is unknown, an item is `ok` when one repository has folder and entry, else the worst state found, with `repository` naming where. Same rule as decision 1 of round 1 (4024 and 4026 can differ).
6. **Check after writes, warn-then-fail:** after a RepTool install of a saved library (`FinishExport`, so `lib save`, `save-all`, `ws build` and `ws release` alike; `lib restore`, `lib install` and `lib install-project` do not go through `InstallSaved` and are not checked, R63), the expected entry must be in the index of the repository RepTool wrote (`LibraryRepository.ForLine(tool.Line, …)`; every existing default repository when `Line` is null), else exit 12 (`LibraryFailed`) with the message "installed, but not in TwinCAT's index" and hint "uninstall and install again" (not "not installed": the install succeeded, R54); after `lib uninstall`, entries that vanished but were not uninstalled, and removed entries that are still in the index, are printed as errors and exit 12 (R59). Only when the index was read (`Read`) before and after the write, both reads taken under the same repository lock hold as RepTool's run; a read that is not `Read` only warns (R57). If spike gate (d) fails (RepTool does not write the entry at once), the install check is warn-only (R53). `expected = null` means no check; non-library units are never checked (R58). Rejected: a separate `--verify` flag (the incident was exactly an "installed" claim that was false).
7. **No `--repair`.** The observed fix (uninstall + install) needs the original library file, which the repository keeps under a renamed extension. The hint names the commands. YAGNI until someone asks.

## Review Focus

1. Index file written by XAE while `lib verify` reads it (partial XML): expect one retry after 500 ms, then exit 1 "index unreadable", never a crash. Test in Task 2 (`Read_TruncatedXml_ReturnsUnreadable`).
2. Folder names in other case than `Title`/`Company` (`LibraryRepository` says names are lower-case on disk on some installs): match by the path segments case-insensitively. Test in Task 2.
3. Version typed as `1.3.0` against `1.3.0.0` on disk: equal via `LibraryRepository.Compare`. Test in Task 3.
4. `*` reference whose highest folder is not indexed but a lower one is: `notIndexed` with `indexedVersion`, not `ok`. Test in Task 3.
5. Repository without `cache` (fresh install, older layout `Components\Plc\Managed Libraries`): exit 1 with hint, not "everything missing". Test in Task 3 (`ExitCode_NoIndex_IsFailed`).

---

### Task 1: Reproduction spike (manual, TwinCAT PC) `[estimated: 3.5 h]`

Gates every later task of this plan (and only this plan). It changes the machine (installs and uninstalls libraries), so it is session B: it runs after the read-mostly session A of the other plans, with a backup of both library repository candidates and a restore point made first (R2). Records go into the plan's "Spike result" section (create a "Spike result" section at the end of this plan) and into `docs/research/cli-build-workflow.md` Q4.

- [ ] **S0 setup.** Outside any repository (`C:\Temp\verify-spike`): in XAE 4024 create two library solutions `Tc3_MotorLib` and `Tc3_AxisLib` (Company `Example`, Version `1.0.0.0`) and a `Consumer` solution whose PLC pins both; for S1 a second solution `Consumer1` pins only `Tc3_MotorLib` (one test reference, R62). Build iecode at the incident state in a temporary worktree of the main clone: `git worktree add C:\Temp\iecode-prelock 311ca62` (= `745ca7f^` in the history of `main`; the old hash `4a72d73^` only lives on the pre-rebase branch), then `dotnet build C:\Temp\iecode-prelock\cli\src\IECode.Cli -c Release`. Current iecode = the branch build.
- [ ] **Snapshot helper** (PowerShell, before and after every scenario; 4024 keeps its repository below `$env:TWINCAT3DIR`, 4026 in ProgramData, so the helper covers both `LibraryRepository.Candidates`, R55): `$roots=@("$env:ProgramData\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries","$env:TWINCAT3DIR\Components\Plc\Managed Libraries"); $i=0; foreach($r in $roots){ $i++; Get-ChildItem $r -Recurse -File | Get-FileHash | Export-Csv snap-N-$i.csv }`; diff with `Compare-Object (Import-Csv a) (Import-Csv b) -Property Path,Hash`; index entries: `Select-String -Path "$r\cache" -Pattern 'Example'` per root. Before S1, with every XAE closed, create a restore point and copy **both** folders aside (M9): `robocopy $roots[0] C:\Temp\verify-spike\repo-backup-1 /MIR` and `robocopy $roots[1] C:\Temp\verify-spike\repo-backup-2 /MIR`.
- [ ] **S1 index decides? (deterministic), once per line (4024 and 4026, R55).** Proven control first: with the entry present, `iecode build Consumer1.sln --tc <line>` on a fresh copy of `Consumer1` is green; a failing control stops the spike (R62). Then per variant, each in a fresh copy of `Consumer1` and a fresh shell: install `Tc3_MotorLib 1.0.0.0` with current iecode; remove only its `<Library …/>` line from `cache` (backup kept), run `iecode build Consumer1.sln --tc <line>`; record: library manager error yes/no; did the shell rewrite `cache` (entry back?). Restore `cache`. Inverse variant (fresh copy, fresh shell): keep the entry, rename the version folder, build, record, rename back. After the variants, restore and repeat the control build: it must be green again before O1/O2/O3 is recorded. Also record in S1 (R60) whether Beckhoff system libraries (`Tc2_Standard`) and placeholder references appear in `cache` and in what form, and (R53, gate d) after a clean RepTool install of a new version (`iecode lib install` of a fresh `Tc3_MotorLib 1.0.9.0`, no shell running) whether its `cache` entry is there immediately, both lines.
- [ ] **S2 parallel installs (hypothesis a).** Bump both libraries to `1.0.1.0`. Start both `C:\Temp\iecode-prelock\…\iecode.exe lib save <sln> --install --tc 4024` at once (`Start-Process` twice); 3 rounds with new versions each. After each round: snapshot diff, both entries in `cache`?, Consumer build result. Repeat one round with current iecode (lock): expect clean.
- [ ] **S3 bulk uninstall (hypothesis b).** Install `1.0.2.0` of both plus `1.0.3.0` of `Tc3_MotorLib`. Open XAE GUI with `Consumer` (a shell with an old index), then `iecode lib uninstall --all --vendor Example --version 1.0.2.0 --yes`, then close XAE. Record which entries are in `cache` after the uninstall and after XAE closed; Consumer build with `1.0.3.0`. Repeat without the open XAE.
- [ ] **S4 shell query.** In a script against a visible shell (or a scratch C# test), `LookupTreeItem("TIPC^<plc>^<plc> Project^References")`, call `ScanLibraries()`, list `Name`/`Version`/`Distributor` of the result. Record whether it exists, how long it takes, and whether its list follows `cache` after S1's edit.
- [ ] **Restore** with every XAE closed: `robocopy C:\Temp\verify-spike\repo-backup-1 $roots[0] /MIR` and `robocopy C:\Temp\verify-spike\repo-backup-2 $roots[1] /MIR`, then a snapshot diff of each root against its first snapshot must be empty; delete the temp worktree (`git worktree remove C:\Temp\iecode-prelock`).
- [ ] **Decide (M11)** right here: record O1/O2/O3 and the S4 result, and strike the tasks the gate below removes before any implementation starts.

**Gate (what each outcome means):**

| Outcome | Meaning | Tasks |
|---|---|---|
| O1 (expected): S1 shows "not installed" with the entry removed and the folder present | `cache` is TwinCAT's truth | Tasks 2 to 5 as written; Task 6 skipped |
| O1 + S2 or S3 reproduces | cause known; write it into Q4; if only S3 reproduces, note in the CHANGELOG that the lock was not the fix and Task 5's uninstall check is the guard | as O1 |
| O2: S1 has no effect, but S2/S3 diffs show another changed file (e.g. `profile`, a file in `PlcEngineering\Build_*`) | the index lives elsewhere | Task 2 parses that file instead (same `IndexEntry` record, new `FileName`); Tasks 3 to 5 unchanged |
| O3: S1 has no effect and nothing reproduces | no file-based truth known | Skip Tasks 2 and 5; Tasks 3 and 4 do not run as written (they carry the "Run only if O1/O2" line); Task 3 is rewritten after the spike and compares references with a `ScanLibraries` list instead of the index; Task 6 becomes the default mode of `lib verify` (needs paths, Windows, exit 20 elsewhere); the lock stays the fix |
| O3 and S4: `ScanLibraries` missing | neither an index nor a shell query | drop `lib verify` (a probe build per reference is too slow to be a check), keep `lib check` and the lock, close the TODO item with the finding |
| O1 and S4: `ScanLibraries` missing | index mode suffices | Task 6 is dropped for good |
| O1/O2 and gate (d) fails: a clean RepTool install does not add the `cache` entry at once (on either line) | the post-install check would fail every first install with exit 12 | Task 5's install check is warn-only (a warning, never exit 12); `lib verify` and the uninstall check stay |
| O1 and S1 shows a difference between the lines (R55) | the index rule holds for one line only | the other line's tasks follow its own outcome row; note the difference in Q4 and under "Open risks" |

### Task 2: `RepositoryIndex` parser `[estimated: 2 h]`

**Run only if O1/O2** (Task 1 gate); otherwise strike this task.

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
  - `Lost_RemovedAllVersions_MatchesByNameAndVendor` (R59, `lib uninstall` defaults to `--version all`, which has no concrete ids): removed `LibraryId("Tc3_MotorLib","all","Example")`; before {Motor 1.0.1.0, Motor 1.0.2.0, Axis 1.0.2.0, Motor 1.0.1.0 of vendor `Other`}, after {Other's Motor 1.0.1.0} → `[Axis 1.0.2.0]` (both Example Motor versions count as removed; same name of another vendor does not; name and vendor compare case-insensitively).
- [ ] **Step 2:** `dotnet test --project cli/tests/IECode.Core.Tests --filter-class IECode.Core.Tests.RepositoryIndexTests` → FAIL (type missing).
- [ ] **Step 3: Implement.** `XDocument.Load` on a `FileStream` opened with `FileShare.ReadWrite | FileShare.Delete` (BOM detection gives UTF-16); `Unreadable` after one retry 500 ms later on `XmlException`/`IOException`. Key = first three `\`-segments of `Path`; versions compared with `LibraryRepository.Compare`. In `Lost`, a removed id whose `Version` is `all` matches every version of that name and vendor.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `Read TwinCAT's library repository index` (body: `lib installed` only sees folders; the spike showed TwinCAT trusts the `cache` index, so a check has to read it).

### Task 3: `LibraryVerify` decision `[estimated: 3 h]`

**Run only if O1/O2** (Task 1 gate); under O3 it is rewritten after the spike instead.

**Files:**
- Create: `cli/src/IECode.Core/Projects/LibraryVerify.cs`
- Test: `cli/tests/IECode.Core.Tests/LibraryVerifyTests.cs`

**Interfaces:**
- Consumes: Task 2's `IndexEntry`, `IndexRead`, `RepositoryIndex.Contains`.
- Produces: `public enum VerifyState { Ok, NotIndexed, IndexOnly, Missing }` (JSON camelCase `ok`, `notIndexed`, `indexOnly`, `missing`)
- `public sealed record VerifyRequest(LibraryId Id, IReadOnlyList<string> Projects);`
- `public sealed record RepositoryView(string Root, IReadOnlyList<InstalledLibrary> Folders, IndexRead Index);`
- `public sealed record VerifyItem(string Name, string Version, string Vendor, VerifyState State, string? Repository, string? IndexedVersion, IReadOnlyList<string> Projects);`
- `public static class LibraryVerify { public static IReadOnlyList<VerifyRequest> FromProjects(IEnumerable<PlcProjectFile> projects); public static IReadOnlyList<VerifyRequest> FromNames(IReadOnlyList<string> libs, string? vendor, IReadOnlyList<RepositoryView> repos); public static IReadOnlyList<VerifyRequest> All(IReadOnlyList<RepositoryView> repos, string? vendor); public static IReadOnlyList<VerifyItem> Check(IReadOnlyList<VerifyRequest> wanted, IReadOnlyList<RepositoryView> repos); public static IReadOnlyList<RepositoryView> ForLine(IReadOnlyList<RepositoryView> repos, int? line, string? twinCatDir, string? programData); public static int ExitCode(IReadOnlyList<VerifyItem> items, IReadOnlyList<RepositoryView> repos); }`

- [ ] **Step 1: Write the failing tests** (project XML as in `ReferenceCheckTests`, `TempWorkspace`):
  - `Pinned_FolderAndEntry_IsOk`; `Pinned_FolderWithoutEntry_IsNotIndexed` (the incident); `EntryWithoutFolder_IsIndexOnly`; `Neither_IsMissing`.
  - `Star_HighestFolderNotIndexed_ReportsIndexedVersion`: folders 1.0.1.0 and 1.0.2.0, index only 1.0.1.0 → `NotIndexed`, `Version == "1.0.2.0"`, `IndexedVersion == "1.0.1.0"`.
  - `TypedShortVersion_MatchesFourPartFolder`: `--lib Tc3_MotorLib=1.0.1` against folder `1.0.1.0` → `Ok`.
  - `TwoRepositories_OkInOne_IsOk`; `TwoRepositories_NotIndexedInBoth_NamesFirstRepository`.
  - `ForLine_4024_KeepsOnlyTheTwinCatFolderRepository` and `ForLine_4026_KeepsOnlyProgramData` (R56): `ForLine(repos, 4024, twinCatDir, programData)` returns only the view whose `Root` equals `LibraryRepository.ForLine(4024, …)`; `ForLine_UnknownLine_KeepsAll` (`line == null`); `ForLine_LineRepositoryNotScanned_ReturnsEmpty` (then `Check` reports every item `Missing` and `ExitCode` is 1, never a false OK from the other repository).
  - `Line4024_OkOnlyInProgramData_IsNotIndexed` (R56): folder and entry in the 4026 repository, folder without entry in the 4024 repository, after `ForLine(…, 4024, …)` the item is `NotIndexed`; without the filter (`line == null`) the same input is `Ok` (the "any repository" rule).
  - `Pinned_SystemLibraryWithEntry_IsOk` (R60): `Tc2_Standard 3.4.4.0`, vendor `Beckhoff Automation GmbH` (a vendor with spaces, path segment `Beckhoff Automation GmbH\Tc2_Standard\3.4.4.0`), folder and entry → `Ok`; `Pinned_SystemLibraryFolderOnly_FollowsSpikeS1`: the assertion (`Ok` when S1 shows system libraries are not in `cache`, `NotIndexed` when they are) is fixed from the S1 record before this test is written.
  - `GroupsProjectsPerLibrary`: two projects pinning the same version → one item, `Projects` both names.
  - `FromNames_PairAndBareName`: `["Tc3_MotorLib=1.0.1.0","Tc3_AxisLib"]` → pinned and `*`; `FromNames_EmptyName_IsUsage` (exit 2).
  - `All_ListsEveryFolderAndOrphanEntry` (vendor filter applied).
  - `ExitCode_AllOk_IsZero`, `ExitCode_AnyProblem_IsNotFound` (3), `ExitCode_NoIndex_IsFailed` (1, every repo `Missing`/`Unreadable`).
- [ ] **Step 2:** `--filter-class IECode.Core.Tests.LibraryVerifyTests` → FAIL.
- [ ] **Step 3: Implement** in `LibraryVerify.cs`. Repositories whose index is not `Read` count only for `Missing` vs folder presence, never for `Ok`. `ForLine` is the only place the line narrows the repositories (R56).
- [ ] **Step 4:** → PASS; then the whole suite → all green.
- [ ] **Step 5: Commit** `Decide whether TwinCAT sees each referenced library version`.

### Task 4: `iecode lib verify` command and docs `[estimated: 2 h]`

**Run only if O1/O2** (Task 1 gate); under O3 it is rewritten after the spike instead.

**Files:**
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`Verify()`, list at `:16`, summary at `:10`)
- Modify: `cli/README.md` (commands table after the `lib check` row; JSON section), `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 3 (`FromProjects`, `FromNames`, `All`, `Check`, `ExitCode`), Task 2 (`RepositoryIndex.Read`), `DefaultRepositories()`, `LoadProjects`, `LibraryRepository.Scan`.
- Produces: JSON `data = { repositories: [{ path, index: "read"|"missing"|"unreadable", entries, folders }], items: [VerifyItem…], problems: <count> }`.

- [ ] **Step 1:** Add the command: options `--lib`/`-l` (`string[]`), `--vendor`, `--all`, `--repository` (`string[]`, default `DefaultRepositories()` that exist). Folders follow `lib check` (`LibraryCommands.cs:391-398`): automatic candidates through `ScanAll` (missing ones skipped), named folders through `ScanExplicit` (a missing one is exit 3 with its path). Usage errors (exit 2): paths together with `--lib`/`--all`; `--all` with `--lib`. Runs on any OS (no `windowsOnly`). The global `--tc` gives the line (`ctx.Version.Line`, `null` for auto) and the loaded repositories go through `LibraryVerify.ForLine(…, ctx.Version.Line, twinCatDir, programData)` before `Check` (R56); the human output names the repository that was checked.
- [ ] **Step 2:** Human output: one line per problem, `✖ Tc3_MotorLib 1.0.1.0 (Example): folder present, not in TwinCAT's index · used by PLC1` (`notIndexed`), `… in TwinCAT's index, folder missing` (`indexOnly`), `… not installed` (`missing`), `* resolves to 1.0.1.0 in TwinCAT, 1.0.2.0 is not indexed`; hint for `notIndexed`: `iecode lib uninstall <name> --vendor <v> --version <ver>` then install again. Success line: `All N library version(s) are known to TwinCAT`.
- [ ] **Step 3:** `dotnet build cli/src/IECode.Cli`, then run on the fixture folder `cli/tests/IECode.Core.Tests/Fixtures/Machine` with `--repository` pointing at a temp folder holding one `Example` version folder and a `cache` without its entry → exit 3 and the `notIndexed` line; with `--json` the fields above; with `--tc 4024` and `--tc 4026` and a second repository that has the entry, only the line's own repository decides.
- [ ] **Step 4:** README row `lib verify [paths…] [--lib <name>[=<version>]]… [--vendor <v>] [--all] [--repository <dir>]… [--tc <ver>]` ("whether TwinCAT itself knows each version: reads its repository index; with `--tc` only that line's repository counts, without it any repository; exit 3 on problems, 1 without index; JSON `data.items[].state`"); CHANGELOG line under `## Unreleased`. The `lib check` success line (`LibraryCommands.cs:401`, "file check; XAE may still fail to resolve them") gets the pointer `; run iecode lib verify to ask TwinCAT's index` (text only, same exit code).
- [ ] **Step 5: Commit** `Add lib verify` (body: a folder scan said "installed" while the library manager said "not installed"; this reads what TwinCAT reads).

### Task 5: Check TwinCAT's index after the save paths' installs and after uninstalls `[estimated: 3.5 h]`

**Run only if O1/O2** (Task 1 gate); skipped under O3. If spike gate (d) failed, the install check is warn-only (the uninstall check stays).

**Files:**
- Modify: `cli/src/IECode.Cli/Runner.cs` (`FinishExport(Context, StagedExport, TwinCatVersion?, LibraryId? expected = null)` passes it on to `InstallSaved(Context, string, TwinCatVersion, LibraryId? expected = null)`, M2; `InstallSaved` reads the index of `LibraryRepository.ForLine(tool.Line, …)` before and after the install through the new `RepTool` overload, returns the index problem as `string?` instead of throwing it, and `FinishExport` decides through `InstallVerdictRules.Decide`; the install path `Runner.cs:169-180` is the one that changes)
- Modify: `cli/src/IECode.Automation/RepTool.cs` (R57: `Install(path, overwrite, log, indexRoot)` and `Uninstall(libraries, log, indexRoot)` overloads returning `RepToolResult(int ExitCode, IndexRead? Before, IndexRead? After)`; `Run` reads `RepositoryIndex.Read` right after taking the lock and again right after the process ended, before `held` is released, so no other iecode writer can change the repository between the two reads; a writer outside iecode (an open XAE) is not covered, see Open risks)
- Modify: `cli/src/IECode.Cli/Commands/LibraryCommands.cs` (`:78`, `:126` pass `RepositoryIndex.ExpectedId(plc)`; `Uninstall` uses the overload for `tool.Uninstall` at `:555` with the index root `repoPath`)
- Modify: `cli/src/IECode.Cli/Commands/WorkspaceCommands.cs` (`:148` `ws build` from `lib.Plc`, `:231` `ws release` through `SaveReleased(…, Func<LibraryId?> expected)` evaluated after `writeVersion()`, R58; if plan E landed first, at E's install call instead)
- Create: `cli/src/IECode.Core/Projects/InstallVerdict.cs` (R54): `public sealed record InstallVerdict(int ExitCode, string Message, string? Hint); public static class InstallVerdictRules { public static InstallVerdict? Decide(int? installExit, string? installMessage, string? indexProblem, string? published, string? publishError); }` — pure: decides message, hint and exit code from (failed install, failed index check, publish result); `null` when everything went well
- Create (Core helpers, tested) in `RepositoryIndex.cs`: `public static string? AfterInstall(IndexRead before, IndexRead after, LibraryId? expected)`, `public static IReadOnlyList<IndexEntry> AfterUninstall(IndexRead before, IndexRead after, IReadOnlyCollection<LibraryId> removed)`, `public static IReadOnlyList<IndexEntry> StillIndexed(IndexRead after, IReadOnlyCollection<LibraryId> removed)`, `public static LibraryId? ExpectedId(PlcProjectFile plc)`
- Test: `cli/tests/IECode.Core.Tests/RepositoryIndexTests.cs`, `cli/tests/IECode.Core.Tests/InstallVerdictTests.cs`, `cli/tests/IECode.Automation.Tests/RepToolRunTests.cs` (existing file, test double `RepTool.At`)

**Interfaces:**
- Consumes: Task 2 (`Read`, `Contains`, `Lost`).
- Produces: JSON additive field `indexChecked: true|false` on `lib save`, `save-all` items, `ws build` / `ws release` results and `lib uninstall`; `lostEntries: [...]` and `stillIndexed: [...]` on `lib uninstall` when not empty.

- [ ] **Step 1: Failing tests.**
  - `RepositoryIndexTests`: `AfterInstall_EntryPresent_ReturnsNull`; `AfterInstall_EntryMissing_ReturnsMessage` (contains `not in TwinCAT's index`); `AfterInstall_NoIndexBefore_ReturnsNull` (no false alarm on a repository without `cache`); `AfterInstall_ExpectedNull_ReturnsNull` (R58: `null` means no check, even with the entry missing); `AfterInstall_AfterUnreadable_ReturnsNull` (R57: `after.State == Unreadable` only warns, a good install is never turned into a failure); `AfterInstall_BeforeUnreadable_ReturnsNull`; `AfterInstall_OtherWriterAddedEntryMeanwhile_StillPasses` (R57: `after` holds the expected entry plus one the `before` did not have → `null`); `AfterUninstall_OtherEntriesLost_ReturnsThem`; `AfterUninstall_OnlyRemovedGone_ReturnsEmpty`; `AfterUninstall_OtherWriterAddedEntry_IsNotReported` (an entry only in `after` is never a loss); `AfterUninstall_VersionAll_DoesNotReportSameNameAndVendor` (R59: removed `("Tc3_MotorLib","all","Example")`, before {Motor 1.0.1.0, Motor 1.0.2.0}, after {} → `[]`); `StillIndexed_RemovedEntryPresent_ReturnsIt` (R59: removed Motor 1.0.2.0, after still holds it → that entry); `StillIndexed_VersionAll_ReturnsEveryVersionOfNameAndVendor`; `StillIndexed_AfterUnreadable_ReturnsEmpty`; `ExpectedId_Library_ReturnsTitleVersionCompany` and `ExpectedId_Application_ReturnsNull` (R58: a project without `Title`/`Company`/`ProjectVersion`, i.e. `!PlcProjectFile.IsLibrary`, is never checked; project XML as in `ReferenceCheckTests`).
  - `InstallVerdictTests` (R54): `Decide_AllWell_ReturnsNull`; `Decide_InstallFailed_Published_SaysNotInstalled` (exit 12, message contains `The library was saved as` and `is not installed`, hint `iecode lib install <file>`); `Decide_IndexCheckFailed_Published_SaysInstalledButNotInIndex` (exit 12, message contains `installed, but not in TwinCAT's index` and does **not** contain `is not installed`, hint names `iecode lib uninstall` then `iecode lib install`); `Decide_InstallFailedAndIndexProblem_InstallWins` (message and hint are the install's); `Decide_IndexUnreadable_ReturnsNull` (`indexProblem == null` is how a warn-only read is passed in; no verdict); `Decide_InstallFailed_PublishFailed_JoinsBothMessages`; `Decide_IndexCheckFailed_PublishFailed_JoinsBothMessages`; `Decide_InstallFailed_KeepsInstallExitCode` (a `RepTool` timeout exit stays the exit code).
  - `RepToolRunTests` (Windows-only, guarded `Assert.SkipUnless(WindowsOnly.IsWindows, …)`, R57): `Install_WithIndexRoot_ReadsBeforeAndAfterUnderOneLock` (the test RepTool writes a `cache` entry; `Before` lacks it, `After` has it; a second `RepositoryLock.Acquire` with the same `lockName` from another thread started between the two reads waits until the result is returned); `Install_WithIndexRoot_NoCacheFile_IsMissingBothTimes`.
- [ ] **Step 2:** `--filter-class IECode.Core.Tests.RepositoryIndexTests` and `--filter-class IECode.Core.Tests.InstallVerdictTests` → FAIL; implement; → PASS. Then `dotnet test --project cli/tests/IECode.Automation.Tests --filter-class IECode.Automation.Tests.RepToolRunTests` (a separate command, PowerShell tool) → FAIL; implement the `RepTool` overloads; → PASS.
- [ ] **Step 3: Wire.** The repository to read is the one RepTool writes: `LibraryRepository.ForLine(tool.Line, twinCatDir, programData)` for installs, the existing `repoPath` for `lib uninstall`; when that is null (`Line` unknown), read every existing default repository and accept the entry in either. The two reads happen inside `RepTool.Run`'s lock hold (R57), never around the call. A read that is not `Read` before or after prints a warning (`Detail`/`Warn`), sets `indexChecked: false` and changes no exit code. `FinishExport` keeps the structure of `Runner.cs:169-180`: `InstallSaved` throws only for install failures (exit 12, "Installing … failed"); an index problem is returned, never thrown; `InstallVerdictRules.Decide` turns (install error, index problem, publish result) into the one `IECodeException` — a failed index check is "installed, but not in TwinCAT's index" with hint "uninstall and install again" (`iecode lib uninstall <name> --vendor <v> --version <ver>`, then install again), the file is still published, and the message does not say "not installed". With `expected == null` no check runs; `ws build` and `lib save-all` units that are not libraries get no expected id (R58). For uninstall also list `lostEntries` and `stillIndexed` (R59: the removed entry is still in the index → exit 12); the removed ids come from the `items` list, `--version all` as `LibraryId(name, "all", vendor)`. If gate (d) failed in the spike, this check only warns and never changes the exit code (R53).
- [ ] **Step 4:** whole suite green; `dotnet build cli/src/IECode.Cli` clean. CHANGELOG line ("`lib save --install`, `lib save-all --install`, `ws build`, `ws release` and `lib uninstall` check TwinCAT's repository index afterwards; `lib restore`, `lib install` and `lib install-project` are not checked, run `iecode lib verify`"). README: a note next to the `lib verify` row with the same scope sentence (R63: the check covers the save paths and uninstall, not `lib restore`, `lib install` or `lib install-project`).
- [ ] **Step 5: Commit** `Check the library index after installs and uninstalls` (body: both hypotheses of the lost install end in a missing index entry; checking right after the write turns a later build failure into an immediate exit 12).
- [ ] **Step 6 (manual, TwinCAT PC, 15 min):** repeat Task 1 S1 (entry removed by hand) and run `iecode lib verify C:\Temp\verify-spike\Consumer --tc 4024` → exit 3 `notIndexed`; restore and repeat → exit 0. Run S3 with current iecode → `lib uninstall` reports lost entries if the spike reproduced them, else exit 0.

### Task 6 (only for O3, or if O1 wants a second opinion): shell query `--shell` `[estimated: 4 h + 30 min manual]`

**Files:**
- Create: `cli/src/IECode.Automation/XaeShell.Libraries.cs` (`public IReadOnlyList<LibraryId> ScanLibraries(string? plcName)`: `FindPlc`, `LookupTreeItem($"{plc.TreePath}^References")` on the nested project, `ScanLibraries()`, map `Name`, `Version`, `Distributor`)
- Modify: `LibraryCommands.cs` `Verify()` (`--shell`, needs paths, `windowsOnly` path, exit 20 elsewhere)
- Core: `LibraryVerify.CheckAgainst(IReadOnlyList<VerifyRequest> wanted, IReadOnlyList<RepositoryView> repos, IReadOnlyList<LibraryId> seenByShell)`; the shell list replaces the index (state `notIndexed` = folder present, shell does not list it).
- Test: `LibraryVerifyTests.ShellList_*` (same four state tests against a list).

- [ ] Steps as Task 3 (test, fail, implement, pass), then wiring with `WithShell(ctx, solution, saves: false, …)`, `discard: true`; one shell per solution; README/CHANGELOG rows; commit `Ask a fresh XAE shell which libraries it sees`.
- [ ] **Manual:** S1 edit plus `lib verify <Consumer> --shell` shows the same state as the index mode (O1) or the only correct one (O3).

## Manual PC check after merge `[estimated: 0.5 day]`

Budgeted separately (R4), TwinCAT PC with 4024 and 4026, throwaway `Example` libraries, repositories backed up as in Task 1:
- [ ] `lib save --install` of `Tc3_MotorLib` with a new version, then `lib verify --lib Tc3_MotorLib=<version> --tc 4024` and `--tc 4026` → exit 0 on the line that was installed to, exit 3 `notIndexed` on the other line.
- [ ] `ws release` of a workspace library: the check line shows the version `writeVersion` wrote (R58); `ws build` of a workspace with a library and an application: the application is not checked.
- [ ] `lib uninstall Tc3_MotorLib --vendor Example` (`--version all`) and `lib uninstall --all --vendor Example --version <v> --yes` with an XAE GUI open: no false `lostEntries`, no `stillIndexed`; with the index edited by hand `stillIndexed` reports exit 12 (R59).
- [ ] `lib restore`, `lib install` and `lib install-project` print no index line (R63) and `lib verify` after them tells the truth.
- [ ] One `lib save-all --install` with a system-library reference in a consumer: `lib verify` result matches the S1 record (R60).

## Size

Task 1 3.5 h, Task 2 2 h, Task 3 3 h, Task 4 2 h, Task 5 3.5 h (four install callers since round 1, a `RepTool` overload and the verdict function) plus 15 min manual; Task 6 4.5 h only for O3; the manual PC check after merge about 0.5 day. Total at most about 2 days plus the 0.5-day check (O1), the same with Task 6 instead of Tasks 2 and 5 (O3); the upper bound, E and I being conditional (M8, M11). All `[estimated]`.

## Open risks

- The index format may differ in 4026 or a later build (attribute names, `TimestampLegacyCache` triggering a rescan). Task 1 checks both lines; the parser ignores unknown attributes.
- An XAE GUI the user keeps open may rewrite `cache` after iecode's check passed; `lib verify` before a build is the answer, the post-write check cannot see the future.
- Scope of the write check (R63): only the save paths (`lib save`, `lib save-all`, `ws build`, `ws release`, all through `InstallSaved`) and `lib uninstall` are checked; `lib restore`, `lib install` and `lib install-project` write through `RepTool.Install` directly and are not. The README says so; `lib verify` after them is the check.
- The two index reads share one lock hold with RepTool's run, so no other iecode writer can fall between them; an XAE GUI or another tool that writes the index outside the lock still can, and a read that is not `Read` only warns (R57).
- If O2 points to a per-build file under `PlcEngineering\Build_*`, the check depends on `--tc`; Task 2 then takes the build from `ChooseVersion`.
