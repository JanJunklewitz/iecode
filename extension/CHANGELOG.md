# Changelog

All notable changes to the IECode extension. Odd minor versions (0.1.x, 0.3.x …) are pre-releases.

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
