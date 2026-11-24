# Changelog

All notable changes to the IECode extension. Odd minor versions (0.1.x, 0.3.x …) are pre-releases.

## Unreleased

### Build
- **Build and Check name the cause:** a failed build reports its first root cause (e.g. a library that is not installed) in the message, a build that fails only on static analysis says so, and the IECode output lists root causes before the other errors.
- When the CLI stops before it builds (for example the TwinCAT version is not installed), the Problems view keeps the last results and the message points to the TwinCAT version setting.

### CLI
- **`iecode lib check`** finds library references that cannot resolve before a build: pinned versions that are not installed and `*` references with no version installed, in every library repository of the PC. `build`, `check` and `ws build` run the same check first and warn (they never stop on it).
- A failed build prints its **root causes first**: the library manager errors (a library that is not installed or cannot be opened), then the other errors, then the follow-up errors counted per library. In `--json` these diagnostics carry `rootCause: true`.
- **`--max-errors <n>`** limits the printed errors and warnings per build (default 50 on a console, all when stderr goes to a file; `0` = all). JSON always has every diagnostic.
- A build that fails only on static analysis (`SAxxxx`) says so, and its `builds[]` entry in JSON has `staticAnalysisOnly: true`; the exit code stays 10.
- The generic last line of a failed build ("The operation could not be completed" on 4024, "HRESULT E_FAIL" on 4026) no longer counts as a compiler error: in `--json` it has `severity: "info"` and `builds[].errors` leaves it out. A build with no other error still fails (exit 10) and says "No compiler errors; see the shell output (-v)". `check` counts the same way (`errors` in its JSON) and still fails on that line alone.
- `iecode --help` lists the exit codes.

## 0.2.23

0.2.22 was not published; its change is part of this release.

### Structured Text view
- **Blame per method:** the new setting `iecode.blame.enabled` (off by default, toggle with **IECode: Toggle Blame per Method**) shows above every method, property, action and accessor who last changed it, and the author, date and commit of a line on hover. It counts on the lines of the view, so an appended line does not take over the line before it, and whitespace and line-ending changes are ignored. A view with unsaved edits shows nothing until it is saved.
- Blame and the line history also work for object files with non-ASCII characters in their name.
- **History of one object or member:** **IECode: Show History of Object or Member** (project tree, editor context menu of the ST view) lists the commits that changed a method, property, action or the whole object and opens the change of one commit as a diff. It follows renames of members and files, compares each commit with its first parent and shows an unreadable commit as such. Uncommitted changes appear as a *Working copy* entry.
- The history entry in the project tree is offered on objects and members only, not on member folders or groups. The working copy row of a whole object also shows changes of CFC, FBD and SFC bodies, and a similar new member no longer takes over the history of a member that an exact replacement continues.
- **Stage single methods:** a changed method, property, action or the main declaration shows **Stage Method** above it in the ST view and stages only that section of the object file, so unrelated method edits no longer end up in one commit. The XML is spliced node by node: bytes outside the section and the `Id` of a new method stay as they are. The index write is checked right before it happens but is not atomic (git has no compare-and-swap for one entry); if the index changed in between, staging stops and asks to try again. Turn the lens off with `iecode.stage.codeLens`.
- Stage Method also works for object files with a byte order mark, keeps the LineIds of a renamed object consistent, puts a new GET before an existing SET, and stops with a message instead of writing broken XML or silently doing nothing when a section gains a part the staged version lacks.
- **Discard single methods:** next to **Stage Method**, **Discard Method** restores one changed method, property, action or the main declaration to its staged version (the index, not HEAD) and drops your changes to it, after a modal confirmation that cannot be undone; a method that exists only in the working file is deleted, and the question says so. It refuses while the ST view or the raw XML of the file has unsaved changes (also if they appear while the question is open) and when the file changed on disk meanwhile; the file is replaced through a temporary file, so a failed write leaves the original. The setting `iecode.stage.codeLens` hides both lenses.

### Object analysis
- **Object analysis (groundwork):** the extension now builds, per PLC project, a graph of which object or member references which, with the PLC tasks, visualizations, pragmas such as `TcRpcEnable` and `call_after_init`, IO-linked variables and the new settings `iecode.analysis.rootObjects` and `iecode.analysis.rootPragmas` as entry points. Interface calls, overrides and `FB_init` are followed. Nothing is shown yet; the unused-object and impact features build on it.
- The object analysis no longer keeps a result computed from files that changed meanwhile, does not hand a partial result of an aborted run to other callers, and marks itself incomplete (no unused findings) when a task, visualization or library file cannot be read or indexed. An exposure pragma on a variable of a GVL keeps the GVL used.
- The unused marks in the tree and the faded hints follow file changes, the **iecode.analysis.markUnused** setting and an undo back to the saved text, and a failed analysis is written to the log.
- **Unused objects:** objects and members that no PLC task, visualization, pragma entry point or configured root can reach are marked **unused** in the project tree and shown faded in the Structured Text view (a hint, not a warning). **IECode: Show Unused Objects** lists them with the reason (not referenced at all, or only used by unused objects) and jumps to the declaration. Interface implementations, overrides and library code are never marked, and nothing is reported for a project without a task or with files (including task files) that cannot be analysed. The setting `iecode.analysis.markUnused` turns it off.
- **Mermaid export:** **IECode: Export Project or Object Graph as Mermaid** copies the library dependencies of the workspace or the object graph of one PLC project as Mermaid text, or saves it as `.mmd`. The object graph folds members into their object, marks unused objects with a dashed border and is exported per task when the project has more than 300 objects. Node ids are generated, so names with dots, spaces, quotes or umlauts stay valid.
- **Impact of a change:** **IECode: Show Impact of Object, Member or Variable** (project tree, editor context menu, command palette with the cursor on a name) lists the tasks that reach it, its callers (a call through an interface counts for the implementations) and the IO links that name a variable, a GVL or a program, including array elements and struct members. Only task entry points count as tasks; an object reached only from a visualization, pragma or IO entry point says so. It says what it could not check: no tasks, IO links not read, IO links not checked for the kind of target, or a member of a function block or struct (instance paths are not analysed). Choosing a row jumps to the code or opens the IO links view.
- Show Impact explains a local variable or a symbol from a library or another project instead of showing a wrong result, names IO link files that could not be read, and the export of one task shows exactly what the task reaches.
- **Config Changes** shows a renamed task, symbol, parameter or type as one `renamed Old → New` entry (plus the fields that changed besides the name) instead of a full removal and addition. Items with too few or too different fields, items that move to another data area, and bulk changes of thousands of items in one data area still show as removed and added.
- The history of an object or member (**Show History**) can be cancelled from its progress notification; the git processes are stopped.

### Object checks
- **Object lint:** PLC object files are checked when opened (also in the Structured Text view) or saved, and again when an `iecode.lint` setting changes; the findings appear in the Problems panel; **IECode: Lint Objects** checks the whole workspace. Structure rules read the raw XML: bad or duplicate GUIDs, a method or property name that differs from its declaration, an object name that differs from the file name, methods and properties without declaration, methods without implementation, orphaned LineIds and merge conflict markers. Object-oriented rules read the decoded code of each PLC project: an override or interface implementation with another return type or parameters, extending a FINAL block, instantiating an ABSTRACT block, and a note where a base or interface is not in the project. Quick fixes remove an orphaned LineIds entry or give a duplicate Id a new value; they are offered only while the file is unchanged since the check. Protected (encrypted) objects are skipped. Severities are set with `iecode.lint.rules`, the whole feature with `iecode.lint.enabled`, and `iecode.lint.namingPrefixes` turns on a naming hint.
- The object lint runs again when the libraries have loaded, treats `Lib.T` and `T` and `STRING[80]` and `STRING(80)` as the same type, checks struct fields of an abstract block, ignores a mistyped level in `iecode.lint.rules` and removes the findings of a project that left the workspace.
- **IO link checks:** the links of a system project are compared with the symbols of the built PLC (the `.tmc`) and the findings appear in the Problems panel on the `.tsproj` / `.xti` that stores the link and as a **Checks** group at the top of the IO links view; **IECode: Lint IO Links** runs them on demand. A link whose PLC variable is gone is an error (array elements and sub-paths resolve through their parent), a changed type a warning, two PLC variables on one IO channel range a warning on outputs and an info on inputs. Variables of an input or output area without a link are one hint per area (the first names, then a count), because it is not verified that all of them are gaps. Without a build, or with a build older than the sources, one info says the checks were skipped instead of reporting dead links. Safety links are not checked.
- The IO link checks name the area as the build spells it, say when a system project file cannot be read or the build has no data areas, and give the **Lint IO Links** command the result of a run that started after the request.

### Project tree
- **Filter Project Tree…** (filter button of the IECode view) narrows the tree to the objects whose name contains the typed words, optionally limited to kinds such as `@fb` or `@gvl`; folders with hits open by themselves. Methods and library sources are not searched yet.
- Filter Project Tree keeps its filter when the command is run again while the box is open, keeps the filter button while a filter is active, treats the same words and kinds in another case or order as the same filter, and **Clear** closes an open box without restoring the old filter. Closing the box (Escape, or the dialog of another command such as New Object) keeps the filter you see; before, it went back to the filter from before typing, so the filter vanished when you created an object. Projects and folders you had open come back open after Clear, also when the filter had hidden them.

### Claude Code and ADS
- Auto-approved AI writes now end after `iecode.ads.aiWritesAutoMinutes` (default 60) from the moment you choose Auto-approve in **IECode: Set AI Write Access…**; afterwards every AI write is confirmed again. An `auto` setting from an earlier version is not armed until you choose it again, and the arming is not synced to other PCs. The ADS Watch view shows the minutes left.
- `ads_symbols` lists the symbols of a project without a build output from the running PLC (needs a filter or prefix, at most 500 matches) or from the source code, and says which. New input `source` picks the source explicitly. The online list needs the iecode CLI of this release; with an older CLI the result says so and shows the source code.
- `ads_read` returns a structure, function block instance or array as a list of its members (`depth` 1-5, default 3; at most 200 members and 20 array elements, the result says what was left out), and `ads_watch { expand: true }` watches the members of a structure. Both need the iecode CLI of this release; an older CLI keeps working for single values and says what to update.
- `ads_write` with `journal: true` lists what the AI wrote in this window (time, symbol, old and new value, pulses, unknown outcomes), without a confirmation. With `restore: true` it writes the old values of this session's writes back after one confirmation (newest write first, at most 20 per call) and lists what could not be restored, for example a variable that no longer exists after a rebuild. The old value is read just before each write; it is a best-effort "before", not atomic with the write.
- Writes to PERSISTENT data need `confirmPersistent: true`. The build output (`.tmc`) marks persistent variables (`TcPersistent`, also for the members of a persistent variable), so they are guarded without any setup; the new setting `iecode.ads.persistentPaths` adds path prefixes the build output does not mark. The confirmation names them `PERSISTENT`.
- `ads_write` can pulse a command bit: `pulseMs` (10-5000) writes a BOOL, waits, then writes the opposite value after one confirmation, so a start does not depend on the PLC resetting the bit. The timing is kept by the extension and is not cycle-exact; the result says how long the bit was held and, if the reset failed, that it may still be set.
- `ads_write` takes `writes` (up to 20 symbol and value pairs) to set several values after one confirmation. They are sent in one ADS request (not guaranteed to land in the same PLC cycle) and the result lists every item: written, not written or outcome unknown. If any value is invalid nothing is sent. Needs the matching iecode CLI release (ADS host protocol 2); with an older CLI the single write keeps working and the batch says "needs a newer iecode CLI".
- The reset of an `ads_write` pulse is no longer sent to another PLC when the ADS target changes during the hold, a restore with more than 200 journal entries reads them in several requests, and the online symbol list says when it was cut before the prefix and type filters.
- `ads_watch`, `ads_read`, `ads_scope` and `ads_wait` start (wait: end) with a notice when the connection to the PLC was lost and restored, when the symbols were reloaded after a download, online change or PLC restart, or when sampling had stopped. `ads_scope` also warns on every call when its time window contains such a hole. The ADS Watch view and the ADS Scope show the notice for two minutes, also while the scope is paused. The reload notice needs the iecode CLI of this release.
- A watched symbol that is in the symbol table but not in the running program no longer produces a "symbols were reloaded" notice every 5 seconds, and the confirmation does not claim that auto-approve does not apply when it was never chosen.
- `ads_symbols` with the online list finds the members below a path (filter `MAIN.fb.stSet.`) that the table walk did not list. Needs the iecode CLI of this release.
- New tool `ads_state` (Copilot: `adsState`) reports the PLC run state, the cycle time and cycle counter of a task and the online change count, compares the counters with its previous call to show a PLC restart or an online change, and tells config mode and an unreachable PLC apart. Needs the iecode CLI of this release. The counter symbol names are not yet checked against a PLC.

### Log viewer
- **Log Viewer** for `.log` files (right-click a file: **Open in Log Viewer**, or **Reopen Editor With…**): a read-only table with time, level, source and message, colors per level, a detail pane for multi-line entries, gap marks between entries (`iecode.logViewer.gapSeconds`) and repeated entries grouped into one row with a count (`iecode.logViewer.groupRepeats`).
- Filters for level, time range, source and free text or regex, each with the number of entries it hides; next / previous error, bookmarks and **Export** of the filtered view as the original lines.
- Formats: the TwinCAT logger, tab-separated logs and plain text are built in and detected per file; add your own with a regular expression in `iecode.logViewer.formats`.
- **Live** follows a growing file (also when it is replaced or rewritten), **Open Logs Merged on One Timeline** shows several files sorted by time.
- Tested with 100 MB files: about one million entries load in under 2 s without freezing VS Code, a text search takes about 1 s. Files with more than 5,000,000 entries or 1,000,000 distinct sources get a clear message to open them as text.
- **Live** off now also holds a refresh that was queued behind the running one, and the years 0000 to 0099 are read as years.

### Editor
- Comments (`//` and `(* *)`) in the ST view stay green in themes that render them grey. Your own `editor.tokenColorCustomizations` still win (#64).

## 0.2.21

### Fixes
- The context menu entries for `.plcproj`, `.xti`, `.tsproj`, `.TcVIS` and the object files in the Explorer, the editor title and the diff editor appear again: their file extension conditions were escaped twice and never matched (#60).

### CLI
- Built on System.CommandLine 3.0.0 (#53). Commands, options, help and output are unchanged.

## 0.2.20

### CLI
- `iecode build` (and `info`, `lib`, `ws`) works on a solution whose PLC project is encrypted with `iecode encrypt --protect "<plc project>,encrypted=true"`: the binary `.plcproj` no longer stops it with `Data at the root level is invalid`. `iecode info` shows such a project as encrypted.
- `iecode encrypt` applies an item again (up to 5 times, 5 s apart) when TwinCAT reports a file of it as used by another process, instead of ending with an unexpected error (exit 99).
## 0.2.19

### Project tree
- The tree follows the editor: opening or switching to an object (ST view or XML, also visualizations, text lists and image pools), a `.plcproj` or a library object selects it in the IECode project tree and expands its folders. Keyboard focus stays in the editor. Turn it off with `iecode.projects.autoReveal`.

## 0.2.18

### CLI
- In the classic Windows console (`cmd.exe`, a double-clicked `iecode.exe`) the output shows colors instead of raw escape codes such as `[2K[2m`: `iecode` now switches the console into ANSI mode itself. Consoles that refuse it get plain lines.

## 0.2.17

### Libraries
- **Install Project Libraries** and **Install Project Libraries (Unknown Versions)** (right-click **References** of a PLC project, Command Palette; Windows): install the libraries kept in the project's `_Libraries` folder into the local library repository, as in TwinCAT XAE. The second one installs only the versions that are missing on this PC. CLI: `iecode lib install-project [--missing-only]`.

### ADS
- `local` now also reaches a TwinCAT user mode runtime (UMRT): it resolves to the real NetId of this PC (registry, then the `TcRegistry.xml` of the UMRT instance) instead of always `127.0.0.1.1.1`. Tool headers show the resolved NetId.
- "Symbol not found" for an index outside an array names the array and its bounds, e.g. `'afb' is ARRAY [1..6] OF FB_X: index 999 is outside 1..6`.
- `iecode mcp` offers an `ads_help` tool when it has no ADS tools to list (no VS Code window for the folder, two windows, version mismatch …); calling it returns the steps to connect.

### CLI
- The `iecode` CLI is on nuget.org as a .NET tool: `dotnet tool install -g IECode.Cli` (needs the .NET 10 SDK; the file-based commands also run on Linux and macOS).

## 0.2.16

### Function blocks
- Folders inside a function block, program or interface can be renamed and deleted from the project tree (**Rename…**, **Delete…** on the folder). Renaming moves everything in it along; deleting asks whether to keep the members (they and any sub folders move up one level) or delete them with the folder. The ST view does not change, since folders only exist in the XML.

### PLC projects
- A `.plcproj` that is out of step with the files on disk (for example when TwinCAT XAE didn't save the project properly) is now checked, in the open editor and for every PLC project of the workspace in the Problems panel. Underlined are `<Compile>` and `<None>` entries whose file doesn't exist, `<Folder>` entries whose folder doesn't exist, duplicate entries, and paths whose case differs from the file on disk (matched case-insensitively like Windows, reported as warnings). Object files below the project folder that no `<Compile>` entry lists are reported at the `<ItemGroup>`; TwinCAT output folders (`_*`) are skipped. The check updates while you type, on save and when files are created, deleted or renamed.
- Quick fixes per entry: remove it, add the missing `<Compile>` with its parent folders, fix the case of the path, or point a missing entry to the file of the same name it was moved to.
- **IECode: Resolve Project File** (editor title and context menu of a `.plcproj`, the project in the IECode view, command palette) repairs the whole file in one go: removes stale and duplicate entries, follows moved files, fixes the case and adds unlisted object files with the folders they need. It shows a summary and a diff before writing and leaves everything else byte-identical (BOM, line endings, element order, `SubType`).
- The new setting `iecode.checkProjectFiles` (on by default) turns the check off. `.plcproj` files now open with XML highlighting.

## 0.2.15

### Function blocks
- A function block that does not implement every abstract method / property of its base classes, or every member of the interfaces it (or a base class) implements, is underlined at its name with the list of what is missing. Interfaces extended by other interfaces and base classes from referenced libraries count too; abstract function blocks are not checked.
- Quick fix **Implement missing members** (also in the editor context menu and on function blocks in the project tree) adds stubs for them: declarations copied from the interface or base class, `ABSTRACT` removed, `PUBLIC` added where an interface member has no access, properties with their GET / SET.
- **Extend Function Block…** on a function block (workspace or library) creates a function block that `EXTENDS` it, with stubs for its abstract members and interfaces. The Add Object wizard does the same for the base class and interfaces picked there, and now offers base classes and interfaces from referenced libraries and other projects.
- The project tree shows the folders inside a function block, program or interface (TwinCAT `FolderPath`). **Add Folder…** on a POU or one of its folders and **Move to Folder…** on a member edit them; new members added from a folder go into it. Setting `iecode.memberGrouping` shows members grouped by kind (Methods, Properties …) or as one list instead.
- **UML Class Diagram** (project tree title bar and context menu, editor context menu, command palette) draws the function blocks and interfaces of a project, folder or the whole workspace, or the hierarchy around one function block: inheritance, implemented interfaces and composed function blocks. Click a class to open it; export as Mermaid, PlantUML or SVG.

### PLC projects
- Files added in the VS Code Explorer now get an entry in the `.plcproj`. New, pasted and dragged object files (`.TcPOU`, `.TcDUT`, `.TcGVL`, `.TcIO`, `.TcTTO`, `.TcVIS`, `.TcGTLO`, `.TcTLO`, `.TcIPO`, `.TcGIPO`, `.TcVMO`) and folders are added together with their parent folders. Renaming or moving one updates its entry, and deleting one removes it. Before, only objects added from the IECode view got an entry, and TwinCAT did not show files added any other way.
- An empty new `.TcPOU`, `.TcDUT`, `.TcGVL` or `.TcIO` (Explorer › New File) gets a template named after the file. For a POU or DUT you pick the kind. A pasted copy gets the file's name and new GUIDs, so it no longer clashes with the original. Renaming such a file in the Explorer also renames the object inside it.
- The new setting `iecode.syncProjectFiles` (on by default) turns this off. Changes made outside VS Code (git, TwinCAT) are never synced.

## 0.2.14

### Release
- No changes to the extension or the CLI. This release is the first one published to the VS Code Marketplace from the release workflow (trusted publishing), not uploaded by hand.

## 0.2.13

### Claude Code and ADS
- `ads_scope` no longer drops value changes when it thins a long window: both rows around every change stay, and a line such as `200 of 1990 samples shown, 14 value changes kept` says when the table shows fewer rows than were sampled. A signal that changes in almost every sample (a ramp, a noisy analog value) is thinned evenly instead, and the line names it.
- `ads_scope` has new options. `changesOnly` lists one row per value change with the value at the start of the window, never thinned, and also shows STRING values; `edges` lists rising and falling edges of BOOL symbols with their times; `maxRows` and `decimals` shorten the table. The summary line says how often a symbol changed and when, and a scope that has stopped getting samples names the last host message.
- `ads_write` tells a bit the PLC reset from a plain read-back: when a BOOL reads back as the opposite of what was written (TRUE against FALSE), the result says "accepted by ADS" and that the value changed after the write.
- New setting `iecode.ads.aiWritePaths` limits AI writes to the path prefixes you list (for example `MAIN.Sim`). A write outside the list is refused before any dialog opens; empty (default) keeps today's behaviour. The list limits symbol names, not machines.
- `ads_symbols` says where its list comes from and when the build output was made, and warns when source files are newer than the build output (more than 2 s). A retest that ran code built before the fix is easy to spot now. The stale warning of the ADS Interface view uses the same 2 s tolerance.
- `ads_symbols` lists the members of an enum type (`enumType`), so valid values for `ads_write` and `ads_wait` are known, and with `hidden: true` the variables marked `{attribute 'hide'}` that have no ADS symbol. Before, the agent had to open the source for both.
- `ads_symbols` says why a library project gives no symbols: a library without build output is listed as "not built" with a hint that it has symbols only with its own MAIN and that the PLC project may be in another workspace, instead of an answer that looks like an empty filter result.
- `ads_symbols` lists the members of one array element when the prefix names it (`MAIN.afbMotor[2].`, several indexes as `[1,2]`), so a function block in an array can be found without guessing; an index outside the array bounds gives nothing. Without such a prefix the list stays as before and does not repeat the members for every element.
- `ads_symbols` takes `limit` (1 to 100 rows per page, default 100), so a narrow look-up does not fill the context with 100 rows; the page note continues with the right `offset`.
- When `ads_read` or `ads_watch` cannot find a symbol, the result names a matching property of the function block from the source (a hidden `MAIN.fbDrive.bBusy` and a property `Busy` with `{attribute 'monitoring' := 'call'}`), so the agent does not guess other paths.
- New tool `ads_config` (Copilot: `adsConfig`) shows or sets the poll interval and the buffer length for the session, with the memory the buffer needs; a change that makes the buffer larger than about 128 MB asks you to confirm. The buffer stores at most 2 million values in total, so many symbols at a fast poll keep fewer seconds than the setting says, and the tool says so.
- New tool `ads_preset` (Copilot: `adsPreset`) reads a named group of members below a path in one call (for example step, step text, error text and busy flag of a state machine). You define the groups in the setting `iecode.ads.presets`; no naming convention is built in.
- New tool `ads_capture` (Copilot: `adsCapture`) waits for a condition like `ads_wait` and returns the value changes of the watched symbols from a few seconds before to a few seconds after it, with the trigger as time 0. It needs a buffer at least as long as the window; `ads_config` can raise it.
- New tool `ads_log` (Copilot: `adsLog`) reads the TwinCAT log file since a marker, with plain-text filter and exclude, and continues into a newer log file (for example after a PLC restart). It needs the user setting `iecode.ads.logDirectory`.
- New **IECode: Settings…** panel (in the `...` menu of the ADS Watch view) edits all `iecode.*` settings in the groups General, IO-Link and ADS Watch.
- `ads_watch` (Copilot: `adsWatch`) answers an add or remove with only what changed and the count (`Watch list: 57 symbols`) instead of the whole list; call it with no arguments or `list: true` for the full list.
- Results of `ads_watch`, `ads_write` and `ads_wait` end with the line `ADS target: <target>`, so a result always says which PLC it came from.
- `ads_watch` can clear everything the AI added (`clearAi`) in one call, and can remove entries you added after you confirm a dialog (`remove` with `force`). Without the confirmation your entries stay.
- `ads_watch` supports named groups: symbols added with `group` can be switched off (`enable: false`) to keep the sample rate for the few that matter, switched on again, or removed in one call. Only entries the AI added can be in a group; the list shows the switched-off ones.
- `ads_watch` says once which saved entries no longer resolve on the target (for example after a rebuild renamed a variable), and keeps them in the list.
- `adsWatch` (Copilot) now checks its arguments like the Claude Code tool does and answers `Invalid arguments: ...` instead of guessing.

## 0.2.12

### Claude Code and ADS
- New tool `ads_wait` (Copilot: `adsWait`) waits until a PLC variable meets a condition (=, <>, <, <=, >, >=, changes, contains), with a timeout of up to 120 s. The variable shows in the **ADS Watch** view while the wait runs, and removing it there ends the wait. When an enum compared by name times out, the result lists the enum names seen, so a misspelled member is easy to spot.

## 0.2.11

### Setup
- **IECode: Set up this PC** and the `install.ps1` one-liner install the CLI when VS Code was started from PowerShell 7: Windows PowerShell inherited PowerShell 7's module path and stopped with "Get-FileHash was not recognized". The installer no longer needs `Get-FileHash` or `Expand-Archive`, and the extension starts it without the inherited module path.
- The installer's log in the **IECode** output shows "●", "…" and umlauts instead of `�??`.

### Claude Code and ADS
- Installing or updating the CLI no longer disconnects Claude Code. The installer deleted the connect state together with the old CLI, so every window stopped serving the ADS tools ("No VS Code window with IECode is open") until **IECode: Connect Claude Code** ran again.
- `ads_symbols`, `adsSymbols` and **Add Variable to ADS Watch…** list the symbols of library projects that were built, e.g. a module with its own `MAIN`. Before, a workspace with only library projects got "No PLC projects in this workspace".

### ADS watch
- "Symbol not found" in the ADS watch, the ADS tools and `iecode ads` now says that a variable with `{attribute 'hide'}` has no ADS symbol and can be read through a property with `{attribute 'monitoring' := 'call'}`. Before, a hidden variable looked like a typo.

## 0.2.10

### Editor
- **Show Raw Changes (XML)**: a button in the diff editor of `.TcPOU/.TcDUT/.TcGVL/.TcIO/.TcVIS/.TcGTLO/.TcIPO/.TcVMO` objects switches from the ST / YAML view to the raw file content and back (**Show Changes as ST / YAML**). The raw diff is read-only.

### System project
- **Config Changes**: **Open Raw XML** opens both selected versions of the `.xti` as raw XML in the diff editor.

### Tasks and global image pools
- **Tasks** (`.TcTTO`) open in a form: cycle time, priority and the names of the POU calls can be edited. Everything else in the file stays as it was. The system project (`.tsproj`) keeps its own cycle time and priority for the task, and they can differ. Adding or removing POU calls stays in TwinCAT.
- **Global image pools** (`.TcGIPO`) open in the image pool editor and show in the IECode view with the image pool icon.
- Both compare as YAML (HEAD, commits, Source Control, `git diff` / `iecode-st decode`), and can switch to raw XML in the diff editor. Run **Show ST in git diff** again to add them to an existing repository's `.gitattributes`.

### Filters
- **Module class viewer** (`.tmc`): a **regex** checkbox next to the filter of the symbols and data types treats it as one case-insensitive regular expression, tested on each column. Without it, words separated by spaces must all match. An invalid expression is reported and hides nothing.
- **ADS Interface**: the filter accepts several words separated by spaces (all must match, in any column), or one regular expression with the new **regex** checkbox. An invalid expression is reported and hides nothing.

## 0.2.9

### Claude Code
- **Claude Code** can use the ADS tools (`ads_symbols`, `ads_watch`, `ads_read`, `ads_scope`, `ads_write`): **Connect Claude Code** registers the CLI's `iecode mcp` bridge once per user, and each VS Code window serves its folders over a named pipe with a per-window secret. The bridge picks the window per call; no window, a window that does not answer, or two windows on one folder give an error, never a guess. Writes follow `iecode.ads.aiWrites`: with `confirm`, or when the workspace sets the ADS target, IECode's confirmation dialog always shows; `auto` writes without asking; `off` refuses. **Disconnect Claude Code** undoes it.
- CLI: `iecode mcp` is the stdio MCP bridge Claude Code starts.

## 0.2.8

### Build output
- **Module class viewer**: `.tmc` files (the build output of PLC projects and TcCOM modules) open in a read-only viewer (**Open as XML** or **Reopen Editor With…** for the text). **Overview**: tasks with cycle times, data areas with their sizes, parameters, interfaces, properties and licenses. **Symbols** and **Data types**: filter, expand members, enum values and methods, jump from a type name to its definition. Reloads after each build.

## 0.2.7

Requires VS Code 1.95 or later (language model tools).

### ADS watchlist
- **ADS Watch** view: live values of PLC variables on the local runtime or a remote target (`iecode.ads.target`, `iecode.ads.port`). Add variables from the build output, by name or from the ST editor; write a value (always confirmed) or copy it. Connects only while the view shows variables.
- **ADS Scope** (graph icon in the view title): a mini scope that plots the numeric watched variables over 10 s to 5 min, with pause, per-variable show/hide and a cursor readout.
- **AI tools** for GitHub Copilot Chat in agent mode (`iecode_ads_*`: find symbols, watch, read, scope summary, write) and **Add to AI Chat** for the last 60 s of all watched values. AI writes follow `iecode.ads.aiWrites` (`off` by default, `confirm`, `auto`; user settings only). With `auto` IECode asks nothing, but VS Code's own tool approval rules may still ask.
- Settings: `iecode.ads.target`, `iecode.ads.port`, `iecode.ads.sampleIntervalMs`, `iecode.ads.bufferSeconds`, `iecode.ads.aiWrites`.
- CLI: `iecode ads serve` is the long-running connection the extension talks to.
- CLI: `iecode ads read|write` accept TIME, LTIME, TOD, DATE, DT and enum values, `ads read --json` has a new `text` field, and both resolve nested symbol paths such as `MAIN.fb.x` (formerly "not found").

### Projects
- PLC projects kept in their own `.xti` file (XAE 4024: `<Plc><Project File="X.xti"/>` in the `.tsproj`) are found in the IECode view and by `.sln`-based CLI commands such as `iecode ads symbols` (formerly "No PLC project found").

## 0.2.6

### Editor
- **Merge conflicts in `.TcPOU/.TcDUT/.TcGVL/.TcIO`**: a conflicted object file gets a conflict bar (editor title and Source Control context menu): **Auto-resolve XML Conflicts** (also in the Source Control merge context menu), **Open XML Merge Editor** (VS Code's built-in) and **Open as XML**.
- **Auto-resolve** merges the ST views of git's index stages and writes the result into the XML of the current side (XML-only differences such as `Id` or `FolderPath`: ours wins). It refuses on delete/modify conflicts, structural conflicts and changed graphical implementations, and asks before overwriting hand edits.
- Remaining code conflicts show in the ST view with colored blocks and **Accept Current / Incoming / Both Changes** CodeLens.

### System project
- **Config Changes** for `.xti` files (right-click an `.xti` in the Explorer, editor tab or Source Control: **Compare Config with HEAD**; pick another version in the panel): the changes of a PLC instance `.xti` by meaning instead of by XML line, grouped into tasks, settings, licenses, parameters, symbols, types and more. Checkboxes hide categories (layout, metadata) and noise (GUID churn, build timestamps, whitespace); the choice is the setting `iecode.configDiff.hidden`. **Open as YAML** shows both versions as YAML in the diff editor.
- CLI: `iecode-st config-diff --rev <ref> [--to <ref>] <file.xti> [--all] [--hide <ids>]`.

## 0.2.5

### Output
- The **IECode** output channel shows every CLI run (Build, Check All Objects, Clean, Activate, Save as library, Encrypt …) with levels: progress as info, `⚠` lines as warnings, `✖` lines as errors. After the run it lists the compiler errors, warnings and messages (code, file and line, project) and a result line with the counts; filter by level in the Output view.
- `iecode.revealOutput`: the channel opens by itself when a command starts (`always`, default), only on failures or warnings (`onProblems`), or `never`.

### Projects
- **Project Settings (Title, Version…)** (right-click a PLC project in the IECode view or a `.plcproj` in the Explorer, Command Palette): edits title, company, version, released, default namespace, placeholder, author, description and compiler defines in the `.plcproj`. Only changed lines are written; undo works in the project file.
- A new title or version also updates `Global_Version.TcGVL` (`stLibVersion_<Title> : ST_LibVersion`, four-part version), which TwinCAT otherwise regenerates only on build. Library projects without one get `Version/Global_Version.TcGVL` and its `.plcproj` entry.

### Visualizations
- With no element selected, the property panel edits the visualization's **width, height and background color**.
- Edit errors in the property panel stay visible in the status bar of the editor (they were cleared right away).
- **Global text lists** (`.TcGTLO`), **image pools** (`.TcIPO`) and the **visualization manager** (`.TcVMO`) open in an editor (**Reopen Editor With…** for XML): the texts with their translations as a table (translations editable), the images with previews (file editable), and the visualization manager's settings as a form (start visualization from the workspace's visualizations, client size, style, dialogs, user management, memory; every other stored value under **All other settings**). Values are changed in place; everything else in the file stays as it was.
- They show in the IECode view with their own icons, and compare (HEAD, commits, Source Control, `git diff` / `iecode-st decode`) as YAML instead of XML.

### AI chat
- **Add to AI Chat** and **Comment for AI…**: right-click code in the ST view (the selection, or the method / action / property at the cursor) or an element in the visualization editor (canvas, element list, Simplified view; also buttons in the property panel). The context names the POU section or element and the file; elements are sent as their YAML summary. Elements can also be dragged from the element list into a chat input.
- `iecode.aiChat`: `auto` (Claude Code if installed, else GitHub Copilot Chat), `copilot` (opens Copilot Chat prefilled), `claude` (copies the context and opens Claude Code to paste it), `clipboard`.

## 0.2.4

### Language features
- Live check of ARRAY initializers in declarations: the number of elements is compared with the declared bounds ("ARRAY[0..273] has 274 elements, initializer has 272"; more elements are an error, fewer a warning), and missing commas between elements, double commas and a trailing comma before `]` are reported. Comments and strings, structs `(a := 1)`, nested and multi-dimensional arrays and repetitions `n(value)` are understood; bounds or repetition counts that are constants aren't checked.
- Hovering an element of an ARRAY initializer shows the index it initializes, e.g. `aDevices[17] — element 18 of 274`, to find where a long list goes off.

## 0.2.3

### Installation
- `install.ps1` (the PowerShell one-liner, **IECode: Set up this PC** and the `setup-iecode` action) installs the CLI: it read the release's `SHA256SUMS` as bytes instead of text and reported "No win-x64 zip listed in SHA256SUMS". Its messages show the repository and file names in Windows PowerShell 5.1 too.

## 0.2.2

### CLI
- `iecode build` and `iecode check` report the compiler errors and warnings with file, line and project. TcXaeShell 15 (4024) doesn't expose its Error List through automation, so they are read from the Build output; libraries that can't be loaded when the solution opens are reported too, and the build summary line is read.
- TwinCAT 4026 and the Remote Manager: RepTool and its profiles are found in the folder of the build selected with `--tc` (`Components\Plc\Build_<build>`), and the default library repository is `%ProgramData%\Beckhoff\TwinCAT\PlcEngineering\Managed Libraries`. `iecode doctor`, `lib installed`, `lib outdated` and `lib restore` work without `--repository`.
- `lib install`, `lib uninstall` and `lib restore` pass the RepTool profile so RepTool accepts it (it reported "No profile name specified").

## 0.2.1

### Documentation
- The README shows the main features as animated GIFs (ST view of the TwinCAT XML, completion and go to definition, project view and ST diffs), plus badges for CI, the latest release, the Marketplace version and the license.

## 0.2.0

First stable release, with everything from the 0.1.x pre-releases.

### Security
- Git refs that start with `-` (compare with a commit, `iecode-st --rev`, `iecode build --affected --since`) are refused instead of being passed to git, where they would be read as options.
- `iecode.cliPath` can only be set in user (machine) settings, not by a workspace's `.vscode/settings.json`; the extension states that it doesn't run in Restricted Mode.
- `.library` archives are inflated only up to the size they declare.

## 0.1.2 (pre-release)

### Libraries
- **Navigate into libraries**: the sources of referenced, non-compiled `.library` files are read directly (no TwinCAT needed) from the library repository (`iecode.libraryRepository`) and the library folders (`iecode.librarySources`), including the libraries they reference. Go to definition, find references, hover, completion and workspace symbols cover their POUs (with methods, properties, actions), DUTs, GVLs and interfaces; namespace-qualified names like `Tc2_Standard.TON` resolve too. Library objects open as read-only ST views (`iecode-lib:`); rename refuses symbols declared in a library. Workspace objects win over library objects of the same name.
- **References** in the IECode view expand to the library's folders, objects and members when its sources are found; the description shows the version used for `*` and marks compiled libraries.
- **Save All PLC Projects as Libraries…** (Projects view title menu, Command Palette): saves every PLC project in the workspace, or only the library projects, as `.library` or `.compiled-library` with one TwinCAT XAE session, optionally installing them. Uses `iecode lib save-all` (new); files go to `iecode.libraryOutput` next to each solution.

### Visualizations
- **Visualization editor** for `.TcVIS` (opens by default; **Reopen Editor With…** for XML): draws the elements with their positions, colors, fonts and texts, and the visualizations shown in frames and tab controls when they are in the workspace (click a tab to switch). Drag to move, drag the corner handle to resize, arrow keys nudge. The property panel edits position, texts, text / tooltip variables, plain colors, frame parameters and the variables of input actions; **All properties** lists every stored value.
- **Simplified** view: one card per element with its text, variable, shown visualization, parameters and input actions, editable inline and filterable. **Wireframe** draws outlines, kinds and variables only; **Variables** shows `‹rSpeed›` instead of `%.2f`.
- **YAML summary** (**Open Visualization as Text**): the interface and every element with what it shows and does. Compare with HEAD / a commit, Source Control diffs and **Show ST in git diff** show visualizations this way instead of XML; `iecode-st decode` prints it.

### IO-Link
- **IO-Link view** in the IECode activity bar: every IO-Link master (EL6224, EP6224 …) of the system projects with its ports. Each port shows its name, mode and the configured device (vendor, device name, vendor / device ID, IODD file); expanding it lists the process data with type and linked variables.
- **IO-Link Explorer** (view title, clicking a master, or right-click a system project): the same structure as a collapsible tree on the left, with filter (port, device, variable) and keyboard navigation, and the details of the selected master, port or process data entry on the right: device data and IDs, linked share per port, the process data table with its links, and the save actions.
- **Save as Independent Project File** (right-click or inline on a master) moves the master box into its own `.xti` next to its parent file, as TwinCAT XAE does: the parent keeps `<Box File=…>` with the port info, the new file gets the box with the images and data types it uses. **Save All Devices as Independent Project Files** (view title, or right-click a project) does this for every master still stored inline. Links stay where they are; an existing target file is never overwritten.

### ADS interface
- **ADS Interface**: compare with a saved JSON snapshot or another build's `.tmc` (e.g. of the released version): **Snapshot or .tmc file…** at the end of the "compared with" list, like `iecode ads diff --against`.

## 0.1.1 (pre-release)

### ADS interface
- **ADS Interface** (Projects view title menu, or right-click a project): the symbols an HMI or other ADS client can access by name, without running the PLC. From the build output (`<PLC>.tmc`, exact, reloads when a build finishes, warns when the sources are newer) or straight from the source code (working copy or any commit). Compare any two, filter, expand members, export CSV, save a JSON snapshot for `iecode ads diff --fail-on-change`.

### IO links
- **Hardware tree**: the IO Links view groups the links by device, box, terminal and channel with short names (`Plc^MAIN.x`, `NC^…`). Comparisons mark added, removed and moved values in the tree; **Open as YAML** shows both versions in the diff editor.
- **Compare IO Links with HEAD / with Commit… (YAML)** in the context menu of a `.tsproj` / `.xti` (Explorer, editor tab). Running a compare again shows the current state, not the result of the first run.
- **Only the files the project uses**: links are read from the `.xti` files the `.tsproj` references, with owner names resolved along that chain; unreferenced leftovers and `<UnrestoredVarLinks>` no longer count. `.xti` files with non-ASCII names (e.g. `Gerät 1.xti`) are now also read at HEAD and other commits instead of showing all their links as added.
- **System projects without a PLC** (e.g. an IO-only `*.Sys` repo) show up under **System Projects** in the Projects view instead of "No TwinCAT projects found"; clicking one opens its IO links.

### Compare and Source Control
- **Source Control diffs as ST**: clicking a changed `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` in the Source Control view shows both sides as Structured Text instead of XML (follows `iecode.openAsST`). This also works for diffs opened from the Git Graph extension and for diff tabs restored after a reload. Umlauts stay intact with `files.encoding` set to e.g. `windows1252`.
- **IECode: Compare** submenu on changed files in the Source Control view: compares with HEAD or a commit as ST for TwinCAT objects and as IO links YAML for `.tsproj` / `.xti`, and opens the IO Links view.
- **Show ST in git diff** also sets up `git difftool -t iecode`, which opens the ST views in your graphical diff tool (e.g. KDiff3). The tool is found the way git difftool finds it: `diff.tool`, else `merge.tool`, with its configured path or on PATH; `.cmd` / `.bat` tools work too. The git config points to a copy of the CLI outside the versioned extension folder, so it keeps working after extension updates; run the command again once in clones set up with 0.1.0.

### Editor
- **Green ST comments** (`iecode.greenComments`, on by default): comments in the ST view are green also in themes that render them grey, close to code. Not applied in high contrast themes; turn the setting off to get the theme's or your own token colors back.
- **Merge conflicts in the XML**: a `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` whose conflict markers sit in the XML structure (e.g. a method's `Id` or `FolderPath`) now stays open as XML, with a hint, so the conflict can be resolved there (Accept Current / Incoming). Before, the ST view closed the XML tab and only showed a parse error. Conflicts inside ST code still show up in the ST view and can be resolved there.

### Setup and CLI
- **Set up this PC…** (Projects view menu, also offered once to new users when the CLI is missing): installs the iecode CLI and checks TwinCAT with `iecode doctor` in one step. If `iecode.cliPath` points to a CLI that doesn't start, it says so instead of reinstalling.
- **Install CLI** installs in the background instead of a terminal, and a CLI installed while VS Code runs is found without a restart. An `iecode` already on PATH (e.g. the NuGet tool or a dev build) takes precedence over that install.
- **iecode CLI**: `iecode io links --yaml` prints the IO links as the same hardware tree; `io links` and `io diff` read the links the same way as the extension (referenced `.xti` chain, non-ASCII file names, names differing only in case). `--csv` together with `--yaml` writes a sorted CSV.

## 0.1.0 (pre-release)

First public pre-release.

### Editing
- Edit `.TcPOU`, `.TcDUT`, `.TcGVL` and `.TcIO` files as plain Structured Text; the TwinCAT XML stays the source of truth and only changed code is written back.
- Outline, folding, syntax highlighting and snippets for the ST view; **Open as XML** / **Open as Structured Text**.

### Projects and workspace
- **IECode** view in the activity bar: libraries, applications and standalone PLC projects with references, folders, objects and members.
- Add Function Blocks (with EXTENDS / IMPLEMENTS and interface stubs), Programs, Functions, Interfaces, Structs, Enums, Unions, Aliases, GVLs and folders; add methods, properties and actions; rename and delete.
- Workspaces with several solutions and loose `.plcproj` files: library links (workspace / pinned), dependency graph, build order.

### Language features
- Go to definition, find references, rename symbol, hover, completion after `.`, workspace symbols.
- Live checks: unclosed IF / CASE / FOR / WHILE / REPEAT, missing END_VAR, duplicate variables.

### Libraries
- Library manager (Installed / Updates / Consolidate / Browse) on the `.plcproj` files, with the workspace, the TwinCAT library repository and folders as sources.

### Compare
- Compare TwinCAT objects as ST (no XML) with HEAD, a commit, two commits or another file; set up git to show ST in `git diff`.
- IO Links: list the variable ↔ channel mappings of a TwinCAT project and compare them between the working copy and any commit.

### With the iecode CLI (Windows + TwinCAT XAE)
- Build, check, clean, activate, save as library, encrypt / protect with a user database; compiler messages in Problems on the ST view lines.
- Build the workspace in dependency order or only the projects affected by changes.

### Known limits
- The CLI-driven features have not been tested against every TwinCAT version yet; please report issues with your TwinCAT version.
- Symbols from installed libraries (e.g. Tc2_Standard) are not known to the language features yet.
