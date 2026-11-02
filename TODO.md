# TODO

## Open

- [x] **ADS variable access: watchlist, mini scope and AI interface**: an ADS interface to read and write PLC variables, usable by the user and by AI agents.
  - Plan: [docs/superpowers/plans/2026-11-02-ads-watchlist.md](docs/superpowers/plans/2026-11-02-ads-watchlist.md).
  - Done: ADS Watch view, ADS Scope, `iecode ads serve`, language model tools `iecode_ads_*`, setting `iecode.ads.aiWrites` (off / confirm / auto).
  - Left for later:
    - MCP server: must be served by the extension, not the host, because the watch list and the sample history live in the extension. Claude Code cannot call `vscode.lm` tools, so with `iecode.aiChat` on Claude Code the AI path stays "Add to AI Chat".
    - ADS notifications instead of polling (for a resolution below 10 ms).
    - AI write allowlist (which variables an AI may write).
    - Writing structs and arrays.
    - Live online symbol browser.
  - Manual checks still open:
    - [ ] Download / online change while watching.
    - [ ] Config <-> run mode transitions.
    - [ ] INT -> REAL download.
    - [ ] Write of non-ASCII strings (e.g. umlauts) via `serve`.
    - [ ] Enum values (`e`).
    - [ ] F5 checks of the view, the scope and the connection lease.
    - [ ] Copilot agent mode: `iecode.ads.aiWrites` off / confirm / auto, whether VS Code still asks on auto, whether "Always Allow" bypasses confirm.
- [ ] **Log file viewer**: a dedicated viewer for log files with filters and a cleaner, more readable presentation than the raw text.
  - Filters: severity (info / warning / error), time range, free text and regex, source / module, with the number of hidden lines per filter.
  - Presentation: parsed columns (time, severity, source, message), color per severity, collapsed multi-line entries (stack traces, long payloads), relative timestamps and gaps between entries.
  - Ideas: live tail with pause / auto-scroll, jump between errors, bookmarks, merge several log files on a common timeline, group repeated messages with a counter, export the filtered view, "ask AI about this entry" using the same interface as the ADS item above.
  - First format: the TwinCAT logger. Other formats (PLC application logs, iecode CLI output, custom logs) come later.
  - Format-agnostic by design: the viewer works on a generic entry model (time, severity, source, message, extra fields). A format is a configurable definition (e.g. a regex or field mapping, severity mapping, timestamp format, multi-line rule) that can be added in the settings without code changes. The TwinCAT logger is the first built-in definition.
  - Open: exact TwinCAT logger source and file format, how format definitions are stored and shared (settings vs. files in the repo), handling of very large files (streaming, virtual scrolling).
- [ ] **SYS folders not detected correctly**: some SYS folders are not recognized correctly by the extension (project view).
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
