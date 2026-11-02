# TODO

## Open

- [ ] **ADS variable access: watchlist, mini scope and AI interface**: an ADS interface to read and write PLC variables, usable by the user and by AI agents.
  - Watchlist: tracked variables, added by hand (e.g. from the editor or a symbol picker) or by an AI agent. Read the actual value and write a new value.
  - Separate window (panel) for the tracked variables, with a mini scope like in the System project: the actual values are recorded and plotted over a configurable time span.
  - AI interface (e.g. MCP server or CLI) with the same capabilities: define which variables are tracked (add/remove), read the scope data, read the actual value, write variables.
  - Open: sample rate and buffer size, how writes are guarded (confirmation for AI writes, read-only mode), access to a target when no PLC is connected.
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
