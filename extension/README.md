# IECode – Structured Text for TwinCAT

[![CI](https://github.com/JanJunklewitz/iecode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JanJunklewitz/iecode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/JanJunklewitz/iecode?label=release)](https://github.com/JanJunklewitz/iecode/releases/latest)
[![VS Marketplace](https://vsmarketplacebadges.dev/version-short/iecode.iecode.svg)](https://marketplace.visualstudio.com/items?itemName=iecode.iecode)
[![License: MIT](https://img.shields.io/github/license/JanJunklewitz/iecode)](https://github.com/JanJunklewitz/iecode/blob/main/LICENSE)

Edit TwinCAT 3 `.TcPOU`, `.TcDUT`, `.TcGVL` and `.TcIO` files as plain Structured Text in VS Code, browse and extend
PLC projects, work with several libraries and applications in one workspace, and build / deploy through the
[`iecode` CLI](../cli/README.md).

**No export/import, no `.st` files on disk.** The TwinCAT XML file stays the only source of truth;
VS Code shows a live text view of it and saving writes your text back into the XML file.

![A .TcPOU file shown as TwinCAT XML, then opened as plain Structured Text with methods, properties and actions as sections](https://github.com/JanJunklewitz/iecode/raw/HEAD/extension/images/st-view.gif)

Completion after `.`, go to definition across objects, and saving straight back into the `.TcPOU`:

![Typing fbMotor. offers the members of FB_Motor; F12 on Start jumps to the method in FB_Motor](https://github.com/JanJunklewitz/iecode/raw/HEAD/extension/images/language-features.gif)

The **IECode** view shows libraries, applications, objects and members; **Compare with HEAD (ST)** diffs the ST, not the XML:

![The IECode Projects view expanded down to the members of FB_Motor, then an ST diff of MAIN against HEAD](https://github.com/JanJunklewitz/iecode/raw/HEAD/extension/images/projects-compare.gif)

```
FB_Motor.TcPOU (XML on disk)                 Editor (iecode:/…/FB_Motor.TcPOU)
───────────────────────────────              ─────────────────────────────────
<POU Name="FB_Motor" Id="{…}">               FUNCTION_BLOCK FB_Motor
  <Declaration><![CDATA[…]]>       ⇄         VAR_INPUT … END_VAR
  <Implementation><ST><![CDATA[…]]>          //---- IMPLEMENTATION ----
  <Method Name="Start" Id="{…}">             IF bEnable THEN …
    …                                        //==== METHOD Start ====
  <LineIds …>                                METHOD PUBLIC Start : BOOL …
```

## Features

| | Any OS | Windows + TwinCAT XAE + `iecode` CLI |
|---|---|---|
| **Plain-ST editor** for POUs, DUTs, GVLs, interfaces; outline, folding, highlighting, snippets | ✔ | ✔ |
| **IECode view** in the activity bar: Libraries / Applications / Standalone PLC, references, folders, objects, members | ✔ | ✔ |
| **Add** Function Block (EXTENDS, IMPLEMENTS with stubs), Program, Function, Interface, Struct, Enum, Union, Alias, GVL, folder; **add** Method, Property, Action, implement interface; **rename**, **delete** | ✔ | ✔ |
| **Language features**: go to definition, find references, rename symbol, hover, completion after `.`, workspace symbols (Ctrl+T), live checks (unclosed IF/FOR/…, END_VAR, duplicate variables) | ✔ | ✔ |
| **Workspace**: several solutions and loose `.plcproj` files, library links (⇄ workspace / pinned), dependency graph and build order | ✔ | ✔ |
| **Library manager** (Installed / Updates / Consolidate / Browse) on the `.plcproj` files; sources: workspace, TwinCAT library repository, folders | ✔ | ✔ |
| **Library sources**: referenced `.library` files (repository or library folders, and the libraries they reference) are read without TwinCAT: go to definition / find references / hover / completion into library POUs, DUTs, GVLs and interfaces (also `Tc2_Standard.TON`), read-only ST views, objects and members under each reference in the tree | ✔ | ✔ |
| **Build / Check / Clean**, compiler messages in Problems on the ST view lines | – | ✔ |
| **Activate** on local or remote targets, **Save as library** — one or all PLC projects (.library / .compiled-library, install), **Encrypt / protect** with a user DB | – | ✔ |
| **Build workspace** in dependency order, **build affected** projects after saves | – | ✔ |
| **Compare as ST** (no XML): with HEAD, a commit, two commits or another file; Source Control diffs open as ST; **Show ST in git diff** (textconv, `git difftool -t iecode`) | ✔ | ✔ |
| **IO Links**: the PLC / NC / IO links of a TwinCAT project as a hardware tree (device › box › terminal › channel), compared between working copy, HEAD and any commit with added / removed / moved values marked; **Open as YAML** or right-click a `.tsproj` / `.xti` (Explorer, editor tab, Source Control) for a YAML diff in the diff editor; CSV export | ✔ | ✔ |
| **IO-Link** view: the IO-Link masters of the system projects (EL6224, EP6224 …) with their ports, the device on each port (vendor, device, IDs, IODD) and its process data with the linked variables, also as the **IO-Link Explorer** (tree on the left, details of the selection on the right); **Save as Independent Project File** for one master or **Save All Devices as Independent Project Files**, laid out the way TwinCAT stores them | ✔ | ✔ |
| **ADS Interface**: the symbols ADS clients can access, without a running PLC: from the build output (`<PLC>.tmc`, exact, refreshes after each build) or straight from the source code (working copy or any commit); compare any two or with a saved snapshot / another build's `.tmc`, CSV export, JSON snapshot for `iecode ads diff` | ✔ | ✔ |
| **Visualization editor** for `.TcVIS`: the elements drawn on a canvas with the content of frames and tab controls from the workspace; move / resize with the mouse or arrow keys; edit texts, variables, frame parameters, input actions and colors in a property panel; **Simplified** view lists what each element shows and does; wireframe drawing; **YAML** summary, also used to compare visualizations (HEAD, commits, Source Control, `git diff`) | ✔ | ✔ |
| Encrypted objects are shown with a lock and can't be opened as text | ✔ | ✔ |

## Settings

| Setting | Default | |
|---|---|---|
| `iecode.openAsST` | `true` | Open TwinCAT object files as Structured Text instead of XML |
| `iecode.greenComments` | `true` | Show ST comments green, also in themes that render them grey (not in high contrast themes) |
| `iecode.cliPath` | `""` | Path to `iecode`; empty: from PATH. Install with **IECode: Set up this PC** (installs and checks TwinCAT) or **IECode: Install CLI** |
| `iecode.tcVersion` | `auto` | TwinCAT version for build / activate: `auto`, `4024`, `4026`, `4024.66` |
| `iecode.platforms` | `[]` | Target platforms to build, e.g. `TwinCAT RT (x64)` |
| `iecode.targets` | `[]` | AMS NetIds offered when activating |
| `iecode.restartAfterActivate` | `true` | Restart TwinCAT in run mode after activating |
| `iecode.libraryOutput` | `dist` | Folder (relative to the solution) for saved libraries |
| `iecode.libraryRepository` | `""` | Library repository; empty: `%TWINCAT3DIR%\Components\Plc\Managed Libraries` |
| `iecode.librarySources` | `[]` | Extra folders with `<Name>_<Version>.library` files |
| `iecode.showXae` | `false` | Show the XAE window while the CLI works |

## How it works

- A `FileSystemProvider` for the `iecode:` scheme. `readFile` decodes the XML into one ST document,
  and `writeFile` reads the current XML from disk and **splices only the CDATA blocks that changed**.
- A save with no changes leaves the file byte-identical. GUIDs, `FolderPath`, attributes, CRLF line endings, BOM and
  non-ST bodies (CFC/LD/SFC, shown as read-only markers) are all kept.
- If you change a method's code, the extension removes its `<LineIds>` entry, which is stale at that point; TwinCAT rebuilds it.
- Adding a `//==== METHOD X ====` section creates a new `<Method>` with a fresh GUID, and deleting one removes it.
- Invalid views (e.g. a `GET` without a `PROPERTY`) are refused at save time with a line number. The editor stays dirty
  and the file isn't touched.
- When TwinCAT XAE changes the file on disk, the view reloads.

Visualizations (`.TcVIS`) store each element as a list of `{ Id, Value }` pairs, where the id is the CRC-32 of the
property's path in the element's function block (`m_StaticPosition.iX`, `m_StaticTexts.pstText`, …). The editor
decodes the common properties by that hash and frame parameters by the name tree stored next to them; other values
appear as `#<id>` under **All properties**. Edits replace single values in place (undo / redo / save as for text),
so the rest of the file stays byte-identical. Values that are style colors, structured, or missing in an element are
read-only there: set them once in TwinCAT.


The ST view is also available on the command line (`node out/src/cli.js`, installed as `iecode-st`):

```
iecode-st decode <file>                                  # ST view (.TcVIS: YAML summary)
iecode-st diff <a.TcPOU> <b.TcPOU>                       # unified diff of the ST views
iecode-st diff --rev HEAD~3 [--to <ref>] <file>          # ST diff against git history
iecode-st links <x.tsproj> [--csv|--yaml]                # IO links (--yaml: hardware tree)
iecode-st links-diff --rev <ref> [--to <ref>] <x.tsproj> # IO link changes
iecode-st ads <x.plcproj|x.tmc> [--rev <ref>] [--members]  # ADS interface from source / build output
iecode-st ads-diff --rev <ref> [--to <ref>] <x.plcproj>     # ADS interface changes in the source
```

As a git textconv for readable diffs (or use **IECode: Show ST in git diff**):

```
git config diff.iecode.textconv "node /path/to/out/src/cli.js decode"
echo "*.TcPOU diff=iecode" >> .gitattributes
echo "*.TcVIS diff=iecode" >> .gitattributes
```

## Develop

```
npm install && npm test          # unit tests (view round trip, project model, templates, workspace, language, libraries, visualizations)
IECODE_TCVIS_SAMPLES=<folder> npm test   # also parse every .TcVIS below <folder> (real projects, nothing is written)
./scripts/e2e.sh                 # end-to-end in real VS Code (throwaway profile)
npm run package                  # iecode-<version>.vsix
```

Or open this folder in VS Code and press F5.

## Known limits

- Section order in the text doesn't reorder XML elements. A renamed section header counts as delete + add, so the member gets a new GUID.
- Renaming an object in the tree renames the file, its declaration and the `.plcproj` entry, but not references to it in other objects (use **Rename Symbol** for variables and members).
- Name resolution covers locals, members, EXTENDS, qualified names, arrays, pointers, GVLs and enums of the workspace and of referenced libraries with sources (`.library`). A `.compiled-library` (e.g. most Beckhoff libraries) has no sources: its symbols are not known. Of a library, the version TwinCAT would use is read (`*`: the newest available).
- Compiler messages are mapped to the ST view by object name; for errors in declarations the line may be off.
- The ADS interface from source code has no sizes and ignores conditional pragmas. It doesn't know types from libraries: library GVLs (e.g. each library's `Global_Version`) and members inherited from library function blocks are missing. The build output (`.tmc`) is exact.
- Visualization editor: elements can't be added or deleted yet, and the drawing is an approximation (no images, styles
  as their stored colors, frames from libraries as placeholders). Texts containing `"` can't be edited there.
- **Save as Independent Project File** edits the `.xti` files directly: close the project in TwinCAT XAE first, or XAE overwrites the change when it saves. Only EtherCAT boxes stored in an `.xti` (not inline in the `.tsproj`) can be moved.
- The CLI-driven features have not been tested against a real TwinCAT installation yet.

## License and trademarks

MIT License, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

TwinCAT®, Beckhoff® and EtherCAT® are registered trademarks of Beckhoff Automation GmbH. This extension is not
affiliated with, endorsed by, or supported by Beckhoff Automation GmbH.
