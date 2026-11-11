# Changelog

All notable changes to the IECode extension. Odd minor versions (0.1.x, 0.3.x …) are pre-releases.

## Unreleased

### Claude Code and ADS
- New tool `ads_wait` (Copilot: `adsWait`) waits until a PLC variable meets a condition (=, <>, <, <=, >, >=, changes, contains), with a timeout of up to 120 s. The variable shows in the **ADS Watch** view while the wait runs, and removing it there ends the wait. When an enum compared by name times out, the result lists the enum names seen, so a misspelled member is easy to spot.
- `ads_scope` no longer drops value changes when it thins a long window: both rows around every change stay, and a line such as `200 of 1990 samples shown, 14 value changes kept` says when the table shows fewer rows than were sampled. A signal that changes in almost every sample (a ramp, a noisy analog value) is thinned evenly instead, and the line names it.
- `ads_scope` has new options. `changesOnly` lists one row per value change with the value at the start of the window, never thinned, and also shows STRING values; `edges` lists rising and falling edges of BOOL symbols with their times; `maxRows` and `decimals` shorten the table. The summary line says how often a symbol changed and when, and a scope that has stopped getting samples names the last host message.
- `ads_watch` (Copilot: `adsWatch`) answers an add or remove with only what changed and the count (`Watch list: 57 symbols`) instead of the whole list; call it with no arguments or `list: true` for the full list.
- Results of `ads_watch`, `ads_write` and `ads_wait` end with the line `ADS target: <target>`, so a result always says which PLC it came from.
- `ads_watch` can clear everything the AI added (`clearAi`) in one call, and can remove entries you added after you confirm a dialog (`remove` with `force`). Without the confirmation your entries stay.
- `ads_watch` supports named groups: symbols added with `group` can be switched off (`enable: false`) to keep the sample rate for the few that matter, switched on again, or removed in one call. Only entries the AI added can be in a group; the list shows the switched-off ones.
- `ads_watch` says once which saved entries no longer resolve on the target (for example after a rebuild renamed a variable), and keeps them in the list.

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
