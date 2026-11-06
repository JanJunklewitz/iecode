# TODO

## Open

- [x] **MCP server for the ADS watch**: Claude Code reaches the five ADS tools through a user-scope stdio bridge (`iecode mcp`) to the window that serves its folder.
  - Spec: [docs/superpowers/specs/2026-11-03-ads-mcp-server-design.md](docs/superpowers/specs/2026-11-03-ads-mcp-server-design.md). Plan: [docs/superpowers/plans/2026-11-03-ads-mcp-bridge.md](docs/superpowers/plans/2026-11-03-ads-mcp-bridge.md) (with the earlier [plan](docs/superpowers/plans/2026-11-03-ads-mcp-server.md) for the shared tool logic and the write gate).
  - Done: bridge, extension server, Connect / Disconnect. Checked by hand against a real PLC target: read, scope, cancelled and confirmed write, no window, two windows on one folder, restart, Disconnect, packaged VSIX.
- [x] **ADS variable access: watchlist, mini scope and AI interface**: an ADS interface to read and write PLC variables, usable by the user and by AI agents.
  - Plan: [docs/superpowers/plans/2026-11-02-ads-watchlist.md](docs/superpowers/plans/2026-11-02-ads-watchlist.md).
  - Done: ADS Watch view, ADS Scope, `iecode ads serve`, language model tools `iecode_ads_*`, setting `iecode.ads.aiWrites` (off / confirm / auto).
  - Left for later:
    - ADS notifications instead of polling (for a resolution below 10 ms).
    - AI write allowlist (which variables an AI may write).
    - Writing structs and arrays.
    - Live online symbol browser.
  - Manual checks against a real runtime:
    - [x] Write of non-ASCII strings (e.g. umlauts) via `serve`: write reply, samples and a separate read return the text unchanged.
    - [x] Interactive EOF and piped one-shot requests (C3): every request read before EOF gets its reply, exit code 0.
    - [x] Reads, watch and samples at about 100 ms; item errors for unknown names, function blocks and arrays; DT text.
    - [x] `interval` clamping (5 -> 10, 9999 -> 5000).
    - [x] Error codes while the target restarts: 0x6, 0x1D (Secure ADS route) and 0x745 observed; 0x1D now counts as connection lost.
  - Manual checks still open:
    - [x] Restart of TwinCAT while watching (`target run`): disconnect (0x745, then 0x1D), `connected:true` again and the same items sample again. The route needs a TCP probe of 8016 / 48898 before it answers after a restart.
    - [x] Enum values: member name and `e` are shown (INT-based enum `TcEventSeverity`); a write by name is not re-checked.
    - [x] Poll timing: 21 symbols at `interval` 10 ms give a row about every 17 ms (round trip over the Secure ADS route), about 16 % CPU of the host.
    - [ ] Download / online change while watching, INT -> REAL. Not possible on TP: the throwaway project failed to start the real-time kernel there (`RTIME: incompatible software detected`, 0x1024), so the original application was put back. Covered by unit tests with a fake link only (`IECode.Automation.Tests`).
    - [ ] TIME / LTIME / TOD / WSTRING values (the original application has none at the top levels).
    - [x] F5 checks of the view, the scope and the connection lease: the watch value and the scope line run live, the host process ends about 30 s after the last variable is removed and the scope is closed.
    - [x] Copilot agent mode: `iecode.ads.aiWrites` off (write refused, the message names "IECode: Set AI Write Access…"), confirm (dialog) and auto (writes) behave as intended.
- [ ] **Log file viewer**: a dedicated viewer for log files with filters and a cleaner, more readable presentation than the raw text.
  - Filters: severity (info / warning / error), time range, free text and regex, source / module, with the number of hidden lines per filter.
  - Presentation: parsed columns (time, severity, source, message), color per severity, collapsed multi-line entries (stack traces, long payloads), relative timestamps and gaps between entries.
  - Ideas: live tail with pause / auto-scroll, jump between errors, bookmarks, merge several log files on a common timeline, group repeated messages with a counter, export the filtered view, "ask AI about this entry" using the same interface as the ADS item above.
  - First format: the TwinCAT logger. Other formats (PLC application logs, iecode CLI output, custom logs) come later.
  - Format-agnostic by design: the viewer works on a generic entry model (time, severity, source, message, extra fields). A format is a configurable definition (e.g. a regex or field mapping, severity mapping, timestamp format, multi-line rule) that can be added in the settings without code changes. The TwinCAT logger is the first built-in definition.
  - Open: exact TwinCAT logger source and file format, how format definitions are stored and shared (settings vs. files in the repo), handling of very large files (streaming, virtual scrolling).
- [ ] **Raw XML diff from the context menu**: show the raw file changes of `.TcPOU` and the other TwinCAT objects with a right-click, not only through the button of an open ST diff. Branch: `feature/raw-xml-compare`.
  - Steps:
    1. Source Control, right-click on **Changes** and **Staged Changes**: "Show Raw Changes (XML)" with the same sides as VS Code: staged = HEAD ↔ index, changes = index ↔ working copy, untracked = empty ↔ working copy. Needs reading the index (`git show :<path>`); `show()` in `extension/src/core/git.ts` takes a ref and must accept the index.
    2. Explorer, IECode view and editor tab: "Compare with HEAD (Raw XML)" in the **Compare** submenu (`iecode.compareRawWithHead` in `extension/src/commands/compare.ts`, menu entries in `package.json`).
    3. Bug: the **Show Raw Changes (XML)** button is missing in a diff opened from the Git Graph extension ("View Diff"), also after a window reload. Git Graph opens `git-graph:/file.TcPOU?<base64>`; IECode turns it into an `iecode-src` ST diff (tab title ends in "(ST)"), so the `when` clause of `iecode.showRawDiff` should match. Next: in that diff run "Developer: Inspect Context Keys" and read `resourceScheme`, `resourceExtname`, `isInDiffEditor`, `activeEditor`; compare with a Source Control diff, where the button is expected to show.
    4. The switch buttons of the diff show text instead of an icon: **Raw** (to XML) and **ST** (back). VS Code shows the title when a button has no icon, so the command palette entry needs a separate command with the long title.
    5. e2e test (raw diff opens with `iecode-raw` on both sides), CHANGELOG / README, build and tests.
  - Not possible: an entry in Git Graph's own context menu (a webview of another extension). Workaround until step 3 is fixed: `"iecode.openAsST": false` opens all diffs as XML.
  - Open: "Compare with Commit… (Raw XML)" as well?
- [ ] **SYS folders not detected correctly**: some SYS folders are not recognized correctly by the extension (project view).
- [x] **PLC projects in independent `.xti` files are not found**: `TwinCatProjectFile.Load` (`cli/src/IECode.Core/Projects/SolutionFile.cs`) only looks for an inline `<Project PrjFilePath="….plcproj">` in the `.tsproj`. XAE 4024 can keep a PLC project in its own file (`<Plc><Project File="X.xti"/></Plc>` in the `.tsproj`, `PrjFilePath` in `_Config/PLC/X.xti`); then `.sln`-based commands such as `iecode ads symbols` (probably also `info`) report "No PLC project found", while the project folder path works.
- [x] **Semantic diff for system config files (e.g. `_Config\PLC\Plc.xti`)**: show the *relevant* changes of a `.xti` / `.tsproj` instead of a raw XML diff. IO links are out of scope here (already covered by the IO links diff).
  - Plan: [docs/superpowers/plans/2026-10-30-xti-config-diff.md](docs/superpowers/plans/2026-10-30-xti-config-diff.md).
  - Done: PLC `.xti` config diff (panel, YAML, CLI). Left for later: jump from a change to its line in the raw XML diff, rename detection, tuned categories for other `.xti` types and the `.tsproj`.
  - Research: [docs/research/xti-diff](docs/research/xti-diff/README.md): survey of 390 commits of PLC `.xti` files with categories, noise sources and recommended defaults. Key results: only 8 % of the commits contain nothing but noise, but the noise (GUID churn, `BitOffs`, build timestamps) makes up most of the changed lines; tasks, licenses and settings change rarely but matter most.
  - Concept (not final):
    - Reuse the existing compare entry points (SCM "Compare with HEAD / commit"), but offer a "Config changes" view next to the IO links diff.
    - Parse both versions and compare by identity (symbol = area + name, type = namespace + name, task = id/name, ...), not line by line; render as a readable YAML-like model like the IO links diff.
    - Categories (first version shows everything, sort out after a review on real diffs): tasks, project/instance settings, licenses, unrestored links (warning), instance parameters, process image symbols, embedded data types, layout, metadata, other. Rare but important categories first. IO links only as a hint "N link changes, open the IO links diff".
    - Filter checkboxes at the top of the view, one per category, plus noise filters (GUID-only changes, build info and timestamps/counters, whitespace/reordering). The state is persisted (extension `globalState` or a setting, so it also applies to the CLI). Defaults: everything on except layout and metadata; all noise filters on. Show how many changes each filter hides.
    - Each change shows added / removed / changed with old -> new value, and a link to the line in the raw XML diff.
  - Open questions: see the research document (embedded data types when the PLC project is in the same repo, other `.xti` types and `.tsproj`, license names).
