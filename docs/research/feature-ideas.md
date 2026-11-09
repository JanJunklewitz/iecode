# Feature ideas and improvements (market research)

Survey of related TwinCAT / PLC tooling (as of 2026-11-09) and what IECode could take from it.
Facts come from README-level descriptions and marketplace pages; none of the projects was installed or tested.
Items marked *(unverified)* come from a user-supplied list or a search snippet only.

## 1. Landscape

| Project | What it does | Overlap with IECode |
|---|---|---|
| [TwinSight](https://marketplace.visualstudio.com/items?itemName=twinsight.twinsight) | VS Code language server for `.st` files: diagnostics W0001-W0015, "Implement interface" quick fix, library loading (managed libs, git, Beckhoff feed), per-code suppression in `twinsight.yaml` | Language features. Needs XML -> `.st` conversion first, no editing yet |
| [Explorer for TwinCAT](https://marketplace.visualstudio.com/items?itemName=thanhdang.explorer-for-twincat) | Closest competitor: edits ST inside the XML (only edited CDATA is rewritten), XAE-style project tree, split editor, per-object git views (stage / history / commits), "Build output (no code changes)" group for `TmcHash`-only changes, rename across projects, quick fixes, own MCP server, browser extension for PR review. See section 6 | Almost everything except IO / config views, ADS and CLI |
| [TwinCAT Structured Text (Apollo3zehn)](https://marketplace.visualstudio.com/items?itemName=Apollo3zehn.twincat-st) | Same idea: convert XML to `.st`, then highlighting and navigation | Language features |
| Plaincat / vscode-plaincat (Zeugwerk) *(unverified)* | Converts TwinCAT XML to flat `.st` and back | Same problem as the IECode ST view, but with two files instead of one source of truth |
| [TcTidier](https://github.com/CodePiercerTechnology/TcTidier) | Formatter for `.TcPOU/.TcDUT/.TcGVL/.TcIO/.st`; options in `.tctidier.json` (align declarations / assignments / named parameters, `normalizeOneLineIf`, `printWidth`); `tctidier-ignore` directives; workspace-wide run | Formatter. IECode has none |
| [agenticcontrolio/twincat-validator-mcp](https://github.com/agenticcontrolio/twincat-validator-mcp) | MCP: XML structure, GUID format / uniqueness, LineIds, naming (`FB_`, `ST_`, `E_` ...), 21 OOP checks (override signature, `FB_init` super call, interface contract, abstract instantiation ...), auto-fix, health score 0-100, idempotence check | Validation of what an AI / human writes into the XML |
| [eponce00/twincat-mcp](https://github.com/eponce00/twincat-mcp) | MCP with 3 meta tools over 72 operations: build with receipts, deploy / activate / restart, TcUnit run, `runtime.record`, job model (wait / cancel / result paging), request keys (idempotency), expiring grants, `workflow.sequence`, online-change workflow, route recovery | Build / deploy / ADS from AI |
| [idomp/twincat-mcp-public](https://github.com/idomp/twincat-mcp-public) | Fork aimed at Copilot: SAFE / ARMED mode (armed expires after 5 min), batch steps, multi-PLC build, library export, task / RT / IO-disable / variant config, ADS record to CSV without TE13xx, Scope control | CLI + ADS |
| [Auda29/twincat-mcp-mono](https://github.com/Auda29/twincat-mcp-mono) | ADS MCP, read-only default, 3 write gates (config, runtime switch, **per-symbol allowlist**), `plc_wait_until`, NC axis + IO read-only, event / runtime-error / log diagnostics, `tc_diagnose_*` | Closest to the IECode ADS MCP |
| [Edge-JB/TwinCAT-XAE-MCP](https://github.com/Edge-JB/TwinCAT-XAE-MCP), [ThorstenBrach/TcAgent](https://github.com/ThorstenBrach/TcAgent) | Drive the XAE tree (System Manager, IO / EtherCAT, linking) through the Automation Interface | Config authoring, not in IECode |
| [idomp/twincat-index-mcp](https://github.com/idomp/twincat-index-mcp) | Semantic code search (tree-sitter + embeddings) | Code search for AI |
| [TwinCAT.ProductivityTools](https://github.com/philippleidig/TwinCAT.ProductivityTools) | Visual Studio extension with productivity helpers | XAE-side only |
| TcUnit + [TcUnit-Runner](https://github.com/tcunit/TcUnit-Runner) | Unit tests, CI runner | Test workflow, no VS Code runner found |
| [TE1200](https://www.beckhoff.com/te1200) + [TcStaticAnalysisLoader](https://github.com/Beluk/TcStaticAnalysisLoader) | Beckhoff static analysis (licensed), CI wrapper | Only licensed; no open linter found |
| [ads-client](https://github.com/jisotalo/ads-client), [pyads](https://github.com/stlehmann/pyads) | ADS libraries (Node.js, Python), notifications, structs, arrays | Reference for ADS features |
| [TcOpen](https://github.com/TcOpenGroup/TcOpen), TcPreview *(unverified)* | .NET twins of PLC types, XML preview in web UIs | Different goal |
| TF1200 UI Client extensions | Custom views for the Beckhoff UI client | Not relevant |
| [truST](https://johannespettersson80.github.io/trust-platform/operate/debugging-and-runtime-panel/) | Open IEC 61131-3 runtime with VS Code debugger: breakpoints, inline values | Only product found with inline values in the editor |
| Beckhoff TcProjectCompare ([manual](https://download.beckhoff.com/download/document/automation/twincat3/TC3_Project_Compare_Tool_EN.pdf)) | Official stand-alone / VS-integrated compare and merge for whole TwinCAT projects (tree view, PLC editor, XML view); git diff / merge tool export. See section 6 | IO / config compare |

Not found: any VS Code tool with online values inside the ST editor for a vendor runtime, or a VS Code test runner for TcUnit. Both look like open gaps.

## 2. Ideas, ranked

Effort: S = about a day, M = a few days, L = a week or more. "Builds on" names existing IECode parts.

### A. Online values in the editor (inline watch)  - L, highest differentiation
Show the live value next to a variable in the ST editor (inline decorations, hover shows type and value, "Add to ADS Watch" from the cursor). Notable because no competitor does it for TwinCAT.
Builds on: ADS Watch, `iecode ads serve`, symbol resolution.
Needs: map editor text to a symbol path (instance path of the running FB is the hard part: a FB used in many instances).
Start small: only globals, `MAIN`, and a picked instance path.

### B. ADS write allowlist and ARMED mode

Effort S.
Auda29 uses a per-symbol allowlist; idomp uses a time-limited ARMED state; eponce00 uses expiring, scoped grants.
For IECode: extend `iecode.ads.aiWrites` (off / confirm / auto) with an allowlist (glob patterns) and an expiry for `auto`.
Builds on: write gate in the shared tool logic.

### C. Read-only diagnostics for AI

Effort S-M.
- `ads_wait` exists. Compare with `plc_wait_until` (max timeout cap, notification cap) for limits.
- Add read-only diagnostics: TwinCAT state, event / runtime error list, log tail. A "what is wrong right now" bundle (Auda29 `tc_diagnose_*`) saves an AI many calls.
- NC axes and IO as read-only views (axis state, error code) for motion debugging.
Open: the logger source is the same question as the log viewer item in `TODO.md`; do both once.

### D. ADS notifications instead of polling  - M, already on the TODO
Lowers CPU, allows < 10 ms, allows `ads_wait` to react immediately. ads-client and pyads show the API shape. Also enables "record to CSV" without TE13xx (idomp does this).

### E. Record / export of scope data

Effort S.
ADS Scope exists. Add: export to CSV, save / load a recording, and an AI-readable summary (min / max / edges / time between edges). Replaces the TE13xx Scope for simple timing checks.

### F. Formatter for ST

Effort S-M (1-2 days with the vendored engine, about a week if written from scratch).

TcTidier proves demand. A formatter that works on the ST view and writes back into the XML keeps the "one source of truth" property. Important: only touch the code lines (no XML churn), idempotent, config file in the repo.

**What a formatter is.** One key press ("Format Document") brings ST code into one fixed layout, like Prettier for JavaScript. Benefits: smaller git diffs, fewer review discussions, AI-written code looks like hand-written code. TcTidier's options (`.tctidier.json`): `indent`, `useTabs`, `alignDeclarations`, `alignAssignments`, `alignNamedParameters`, `blankLineBetweenCaseBranches`, `normalizeOneLineIf`, `printWidth`; ignore directives `tctidier-ignore`, `-start`, `-end`.

**Findings on TcTidier** (checked via the GitHub API on 2026-11-09, code only skimmed, not run):
- Licence MIT, so compatible with our MIT licence; needs the copyright notice and an entry in `NOTICE`.
- TypeScript, like our extension. The engine is in `src/native/` (about 37 KB, 10 files). `formatSt(code, config)` and `formatDocumentText(text)` take plain text and return text. `formatter.ts` does not import `vscode`; only `config.ts` uses `fs` / `path` to load the config file.
- Young and small: version 0.1.4, 4 stars, 30 commits, last push 2026-03-23. No npm package found, only the Marketplace extension.

**Options considered:**
1. **Vendor the engine** (chosen): copy `src/native/` into our extension, call `formatSt` on the ST text, the existing save path writes the result into the XML. Reuses `.tctidier.json`, so teams with TcTidier get the same result.
2. Tell users to install TcTidier next to IECode: no integration. It formats `.TcPOU` XML directly and does not know our ST view.
3. npm dependency: not possible, no package.
4. Write our own: about a week, and no gain over option 1.

**How we keep the vendored copy current (chosen: sync script).**
- `scripts/sync-tctidier.ps1 <commit-or-tag>` downloads `src/native/` and the `LICENSE` of that commit into `extension/src/vendor/tctidier/`.
- `VENDOR.md` next to it records the upstream commit currently in use.
- An update is: run the script with the new commit, read `git diff`, run the tests. Every upstream change is visible before it lands.
- We do not edit the vendored files. Our own wrapper (`format.ts`) calls `formatSt`; a needed fix goes in as a `.patch` file that the script applies after copying, so the next sync does not overwrite it.
- `formatSt` / `formatDocumentText` are not a promised API; a changed signature shows up as a compile error.
- Rejected: `git subtree` and git submodules. Both bring the whole upstream repo (benchmarks, docs, extension code) into our tree or checkout; submodules also complicate CI and VSIX packaging.

**Checks before adopting** (about 2 hours):
- Idempotent: formatting twice gives the same result.
- Nothing changes inside strings, comments and pragmas (`protection.ts` looks like it handles this).
- Runs on our `testdata/` without diff noise; add a test "format, format again, result equal".
- Ask the author whether a shared library would be acceptable, which would avoid a fork to maintain.

### G. XML structure checks and OOP rules

Effort M-L.
- Structural checks on XML written by AI or by hand: GUID format / uniqueness, LineIds, missing `<Method>` wrappers. Worth a `iecode check --xml` and a diagnostic on save, because the validator MCP exists only because this goes wrong.
- Naming-convention rules (configurable prefixes), diagnostics in the Problems panel.
- OOP rules from the validator list are cheap once the parser has inheritance: override signature, `FB_init` super call, abstract instantiation, interface not fully implemented.
- Quick fix "Implement interface" (TwinSight has it).

### H. Test workflow  - M
Run TcUnit from the CLI (`iecode test`): build, activate on a simulation target, wait, collect the result, exit code for CI. Show results in the VS Code Test Explorer. eponce00 and idomp both have `run_tcunit`, so the shape is known.
Risk: needs a runtime; keep it in the CLI first, with a clear "never on a production target" gate.

### I. CI additions  - S-M
- `iecode check` output as SARIF or GitHub annotations.
- Job summary for the diffs (ST diff, IO links diff, config diff) in a PR comment. The `setup-iecode` action is already there.
- Multi-PLC build order (idomp `multi_plc_build`) if the CLI does not already do it.

### J. AI-facing robustness (from the job-based MCPs)

Effort S each.
- Request keys: a repeated write with the same key returns the first receipt (no double writes after a retry).
- Output caps and paging on every tool result.
- `ads_sequence`: several steps in one call, validated before the first one runs.
- Bounded resources (max subscriptions, max wait) as settings.

### K. Smaller improvements to existing features
- Project view: finish the "SYS folders not detected" item; add search / filter in the tree.
- Dependency graph: export as Mermaid; mark unused objects (reachable from no task).
- Library manager: show outdated versions, diff two library versions as ST.
- Config diff: jump from a change to the raw XML line (already noted as left for later), rename detection.
- Merge editor: use the semantic diff to auto-resolve more GUID and `LineIds` conflicts.
- Git: `git blame` per method (blame on the ST view maps to XML lines).
- Online symbol browser (already on the TODO), with struct / array write.

## 3. Suggested order

1. **B** allowlist + expiry (S): closes a safety item, small.
2. **C** read-only diagnostics + **E** scope export (S-M): quick value for the AI workflow.
3. **G** XML structure checks (M): protects the core promise (valid XML after edits).
4. **D** notifications (M): prerequisite for fast waits and recording.
5. **A** inline values (L): the headline feature; prototype with globals only.
6. **F** formatter, **H** TcUnit: after the above.

## 4. Things not to copy

- Converting to separate `.st` files (TwinSight, Plaincat, Apollo3zehn): breaks the single-source-of-truth design.
- Wide XAE automation (System Manager tree authoring): large surface, hard to test without a licensed XAE; stay with build / activate / libraries.
- Embedding-based code search: heavy dependencies for a gain that the language service already covers.

## 5. Open questions

- Is online value display feasible for FB instances without ambiguity? (needs a prototype)
- Which TwinCAT logger source is stable enough for the diagnostics and the log viewer?
- Formatter: decided to vendor the TcTidier engine with a sync script (see F). Still open: whether it passes the checks listed there.

## 6. IO and config views: what others do

Short answer: nobody else offers a dedicated IO-links or config view with a semantic diff in VS Code. The two comparable tools sit at opposite ends.

| | IECode | [Explorer for TwinCAT](https://marketplace.visualstudio.com/items?itemName=thanhdang.explorer-for-twincat) | Beckhoff TcProjectCompare |
|---|---|---|---|
| IO / motion / task config in the tree | IO links view, PLC `.xti` config | No: "I/O, motion, and task configuration stay in XAE" | Yes: tree with System, Tasks, Motion (axes), PLC, I/O, Mappings |
| Diff of config files | Semantic: by identity, categories, noise filters, YAML, CLI | Raw XML diff only; groups `TmcHash` / `ProductVersion`-only changes as "Build output (no code changes)" and offers discard | Tree compare + XML compare; logical vs. formal changes; hide equal items |
| IO links diff | Yes, YAML | No | Via the I/O and Mappings branches (XML level) |
| Noise handling | Filters for GUID churn, `BitOffs`, timestamps; counts hidden changes | Only the metadata-only grouping | "Formal" changes (e.g. LineIds) marked with a bar and hideable; no per-category filters |
| Merge | XML conflict resolver, merge editor | None for config | Yes: accept single / block / all, with direction |
| Renames | Not detected yet | Rename updates `.plcproj` and task call | Shown as addition + deletion; manual "Compare To..." pairing |
| Runs without XAE, in CI | Yes (CLI, YAML) | VS Code only | Windows GUI; git diff / merge tool export |

What the others do better, worth copying:
1. **Formal vs. logical changes** (TcProjectCompare): a clear label per change, "does this change plant behaviour?". Our categories cover it indirectly; an explicit "behavioural / formal / noise" top-level split makes the view faster to read.
2. **Hide equal items** and a "changed only" tree filter.
3. **Manual pairing of renamed items** ("Compare To...") as a fallback until rename detection exists.
4. **Metadata-only files** (Explorer): in the SCM view, mark files whose only change is `TmcHash` / `ProductVersion` and offer discard. Cheap, and it removes the most common false alarm in `git status`.
5. **Merge direction and accept buttons** for config (TcProjectCompare): our merge editor could reuse the semantic model to merge by identity instead of by line.
6. **Rename side effects** (Explorer): a renamed program also updates the task's `<PouCall>`; do we?

What we do better: semantic categories with noise filters, YAML output for review and AI, CLI / CI use, IO links as a first-class diff.

Gaps nobody fills (candidates):
- IO-link and mapping **consistency checks** (link to a missing symbol, type mismatch, unlinked variable, double-linked input).
- **Impact view**: "which IO links and tasks are affected by renaming this variable".
- **PR-friendly summary** of config changes (Markdown) for a pull request comment.
- **ESI / EtherCAT**: no open tool found that reads the topology from the XML and diffs it semantically (device tree, slot / module changes, PDO mapping, DC settings). This is a real gap; the `.xti` research already shows which parts matter.

## 7. More ideas, ranked by interest for IECode

Interest = fit with the existing design x differentiation x effort. Items from sections 2 and 6 are not repeated.

1. **Metadata-only change detection in the SCM view** (S). From Explorer. `TmcHash`-only files hidden or grouped; the xti research already lists these as noise.
2. **IO-link consistency checks** (M). Builds on the IO links parser; CLI `iecode check` gets a rule set, the view gets warnings.
3. **Per-object git history and per-object staging** (M-L). Explorer has it (history following renames, stage one method). We have compare with HEAD / commit; "history of this object" would be the missing piece.
4. **Rename across projects with preview** (M). Explorer's F2 rename over all PLC projects with name-clash warning; also updates task calls.
5. **License status bar** (S). Time left on the TwinCAT license that expires first (Explorer). Matters on simulation PCs with 7-day trials; reads via ADS / the license files.
6. **Auto Declare / quick fixes** (M). Declare an unknown variable in the right VAR block with an inferred type (Explorer, Shift+F2); "Implement interface" (TwinSight).
7. **Browser / PR view** (L). Explorer's read-only browser extension shows TwinCAT objects in GitHub PRs. For us, a CI job that posts the ST + config + IO-links diff as a PR comment gets 80 % of it (S-M, see I).
8. **MCP: idempotent request keys and sequence calls** (S-M). See J.
9. **Library stubs** for compiled libraries without declarations (M). Explorer ships stubs for Tc2_Standard, Tc2_System, Tc2_MC2 and others because compiled libraries have no member info; we could read the `.compiled-library` / `.library` metadata where present.
10. **Multi-PLC integration build** (S). `multi_plc_build` and TMC auto-reload from idomp, if the CLI has no build order yet.
11. **Python / pyads bridge for tests** (S). Not a feature in the extension, but a documented recipe (ADS MCP or `iecode ads serve` plus pyads) for scripted sim tests.
12. **Scope export to `.svdx`-compatible CSV** (S). See E.

Skipped on purpose: browser extension as a product, embeddings search, XAE tree authoring (see section 4).
