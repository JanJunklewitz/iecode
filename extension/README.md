# IECode – Structured Text for TwinCAT (VS Code extension, proof of concept)

Edit TwinCAT 3 `.TcPOU`, `.TcDUT`, `.TcGVL` and `.TcIO` files as plain Structured Text in VS Code.
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

Features: auto-redirect when you open a `.TcPOU` (setting `iecode.openAsST`), **Open as XML** / **Open as Structured Text**
commands, outline/breadcrumbs per method/property/action, folding per section, ST syntax highlighting, snippets
(`//method`, `//property`, `//action`), ST highlighting *inside* CDATA when you open the raw XML, and
**IECode: Build PLC project** (`Ctrl+Shift+B`), which runs your own CLI from `iecode.buildCommand`
(`${solution}`, `${file}` placeholders).

The core is also a small Node CLI, `iecode-st decode <file>` / `iecode-st encode <file> <view.st>`. It also works as a git textconv for readable diffs:

```
git config diff.iecode-st.textconv "node /path/to/out/src/cli.js decode"
echo "*.TcPOU diff=iecode-st" >> .gitattributes
```

## Try it

```
npm install && npm test          # unit tests (round-trip, edits, add/remove, validation)
./scripts/e2e.sh                 # end-to-end in real VS Code (throwaway profile)
code --install-extension iecode-0.0.1.vsix
```

Or open this folder in VS Code and press F5. That opens `samples/` in an Extension Development Host.

## Known limits (PoC)

- Section order in the text doesn't reorder XML elements. A renamed section header counts as delete + add, so the object gets a new GUID.
- Only objects inside existing files. Creating new POU files and adding them to `.plcproj` isn't done yet; the build CLI / Automation Interface could handle that.
- Not tested yet against real TwinCAT 4024/4026 projects with folders, SFC transitions, `.TcTTO` tasks or `.TcVis`.
- There's no ST language server. Install an ST LSP and point it at the `twincat-st` language, or add one later.
- Compiler errors from the build CLI aren't mapped to view lines yet (needs object name + line → view offset).

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
