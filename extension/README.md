# IECode – Structured Text for TwinCAT

Edit TwinCAT 3 `.TcPOU`, `.TcDUT`, `.TcGVL` and `.TcIO` files as plain Structured Text in VS Code, browse and extend
PLC projects, work with several libraries and applications in one workspace, and build / deploy through the
[`iecode` CLI](../cli/README.md).

**No export/import, no `.st` files on disk.** The TwinCAT XML file stays the only source of truth;
VS Code shows a live text view of it and saving writes your text back into the XML file.

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
| **Build / Check / Clean**, compiler messages in Problems on the ST view lines | – | ✔ |
| **Activate** on local or remote targets, **Save as library** (.library / .compiled-library, install), **Encrypt / protect** with a user DB | – | ✔ |
| **Build workspace** in dependency order, **build affected** projects after saves | – | ✔ |
| **Compare as ST** (no XML): with HEAD, a commit, two commits or another file; **Show ST in git diff** (textconv) | ✔ | ✔ |
| **IO Links**: variable ↔ channel mappings of a TwinCAT project, compared between working copy, HEAD and any commit (added / removed / moved / changed), CSV export | ✔ | ✔ |
| **ADS Interface**: the symbols ADS clients can access, without a running PLC: from the build output (`<PLC>.tmc`, exact, refreshes after each build) or straight from the source code (working copy or any commit); compare any two, CSV export, JSON snapshot for `iecode ads diff` | ✔ | ✔ |
| Encrypted objects are shown with a lock and can't be opened as text | ✔ | ✔ |

## Settings

| Setting | Default | |
|---|---|---|
| `iecode.openAsST` | `true` | Open TwinCAT object files as Structured Text instead of XML |
| `iecode.cliPath` | `""` | Path to `iecode`; empty: from PATH. Install with **IECode: Install CLI** |
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


The ST view is also available on the command line (`node out/src/cli.js`, installed as `iecode-st`):

```
iecode-st decode <file>                                  # ST view
iecode-st diff <a.TcPOU> <b.TcPOU>                       # unified diff of the ST views
iecode-st diff --rev HEAD~3 [--to <ref>] <file>          # ST diff against git history
iecode-st links <x.tsproj> [--csv]                       # IO links
iecode-st links-diff --rev <ref> [--to <ref>] <x.tsproj> # IO link changes
iecode-st ads <x.plcproj|x.tmc> [--rev <ref>] [--members]  # ADS interface from source / build output
iecode-st ads-diff --rev <ref> [--to <ref>] <x.plcproj>     # ADS interface changes in the source
```

As a git textconv for readable diffs (or use **IECode: Show ST in git diff**):

```
git config diff.iecode.textconv "node /path/to/out/src/cli.js decode"
echo "*.TcPOU diff=iecode" >> .gitattributes
```

## Develop

```
npm install && npm test          # unit tests (view round trip, project model, templates, workspace, language, libraries)
./scripts/e2e.sh                 # end-to-end in real VS Code (throwaway profile)
npm run package                  # iecode-<version>.vsix
```

Or open this folder in VS Code and press F5.

## Known limits

- Section order in the text doesn't reorder XML elements. A renamed section header counts as delete + add, so the member gets a new GUID.
- Renaming an object in the tree renames the file, its declaration and the `.plcproj` entry, but not references to it in other objects (use **Rename Symbol** for variables and members).
- Name resolution covers locals, members, EXTENDS, qualified names, arrays, pointers, GVLs and enums of the workspace; symbols from installed libraries (e.g. Tc2_Standard) are not known yet.
- Compiler messages are mapped to the ST view by object name; for errors in declarations the line may be off.
- The ADS interface from source code has no sizes, ignores conditional pragmas and doesn't expand types from libraries; the build output (`.tmc`) is exact.
- The CLI-driven features have not been tested against a real TwinCAT installation yet.

## Market check (Oct 2026)

| Project | What it does | Why it isn't enough |
|---|---|---|
| [Zeugwerk/Plaincat](https://github.com/Zeugwerk/Plaincat) | Converts the XML to `.st` files and back (CLI + Windows-only VS Code ext.) | Archived Sept 2026 and called a proof of concept by its own maintainers. Regenerates GUIDs, drops non-ST objects |
| [Apollo3zehn/vscode-twincat-st](https://codeberg.org/Apollo3zehn/vscode-twincat-st) | Highlighting, diagnostics and navigation for ST | Explicitly no editing of TcPOU XML; you have to convert to `.st` first |
| [Serhioromano/vscode-st](https://github.com/Serhioromano/vscode-st) | Highlighting and formatting, recognises `.TcPOU` | You still see and edit raw XML |
| truST, ControlForge | ST language servers, runtime, linting | Generic IEC 61131-3 / CODESYS, no TcPOU round trip |
| [Zeugwerk PlcSense](https://socket.dev/npm/package/@zeugwerk/plcsense) | Commercial MCP server (symbols, validation) | Read-only, for AI agents, not an editor |
| [TwinCAT.ProductivityTools](https://github.com/philippleidig/TwinCAT.ProductivityTools) | "Open in VS Code" from XAE | Opens the raw XML |
| **Beckhoff [TwinCAT PLC++](https://control.com/news/beckhoff-redesigns-programmable-logic-with-new-plc-platform/)** | Next-gen PLC: code stored as plain text, standalone CLI compiler | This is Beckhoff's own long-term answer. Projects on TC3 4024/4026 XML still need a bridge like this one |

Nothing on the market currently edits TcPOU XML **in place** as plain text without a conversion step.

## License and trademarks

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

TwinCAT®, Beckhoff® and EtherCAT® are registered trademarks of Beckhoff Automation GmbH. This extension is not
affiliated with, endorsed by, or supported by Beckhoff Automation GmbH.
