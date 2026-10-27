# Changelog

All notable changes to the IECode extension. Odd minor versions (0.1.x, 0.3.x …) are pre-releases.

## Unreleased

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
