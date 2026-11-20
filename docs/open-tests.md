# Open tests by priority

State of 2026-11-20 for the project tree filter (branch `feature/tree-filter`) and the ADS state work (branch `feature/ads-state-and-tree-filter`). Tick an item only after seeing it in the installed extension, and note what was seen when it fails.

Prerequisite: a VSIX built from the fixed branches. Legend: `[ ]` to do, `[x]` done, `[!]` failed.

## Priority 1: must pass before the branches are merged

### Project tree filter

- [ ] **P1-1** Create an object with the command wizard while a filter is active and confirmed with Enter: the filter and its message stay. (Failed twice before the fix.)
- [ ] **P1-2** Same with the filter box still open (text typed, no Enter) and the wizard started from the command palette: the filter stays, because closing the box keeps it now.
- [ ] **P1-3** Create an object whose name matches the active filter (filter `motor`, new `FB_MotorTest`): it shows up and the message count rises by one.
- [ ] **P1-4** Open a library project (Libraries group) and a folder, filter `motor`, then Clear: both are open again. Collapse one before filtering: it stays collapsed after Clear.
- [ ] **P1-5** Escape in the open box keeps the filter as typed (changed behaviour); Clear while the box is open still clears it.

### ADS

Needs a VSIX built from `feature/ads-state-and-tree-filter`, not from the tree filter branch. First check the installed `ads_write` description: it must say auto writes "only while it is armed", and the user settings must not hold a stray `iecode.ads.aiWritesArmedAt`.

- [ ] **P1-6** `iecode.ads.aiWrites = "auto"` left over from an old version and never re-chosen: a write asks for confirmation.
- [ ] **P1-7** Auto-approve armed with `iecode.ads.aiWritesAutoMinutes = 1`: after 60 s the next write asks again, also after changing the duration while armed.
- [ ] **P1-8** After a PLC runtime restart exactly one "symbols were reloaded" notice appears in the next tool result. Not fixed: a plain stop and start probably keeps the symbol version, so the CLI host reports no reload. Check with the watch host in JSON mode against a restart.
- [ ] **P1-9** `ads_symbols` with `source=online` and a prefix that names a struct member (`MAIN.fb.st.`) lists the members of the struct.

## Priority 2: should be checked, behaviour is specified but not yet seen

- [ ] **P2-1** Tree filter, focus loss: click into the editor with the box open and record whether the box closes and which filter applies. Note the filter from before opening.
- [ ] **P2-2** Tree filter, invalid input: `@xyz` shows the validation message with the kind list and keeps the previous filter; blank input means no filter.
- [ ] **P2-3** Tree filter after a window reload with an active filter: expected no filter (not saved); record what is seen.
- [ ] **P2-4** Tree filter, a file added from outside (file explorer instead of the wizard) while filtered: the tree applies the filter to the new model.
- [ ] **P2-5** ADS connection and sampling notice after a real link loss (disconnect in the ADS Watch view or cut the network), and the notice when it is restored.
- [ ] **P2-6** ADS Watch view shows the notice (2 minutes) and the minutes left of the auto-approve window.
- [ ] **P2-7** ADS stale symbol after a reload: the notice does not repeat every 5 s.

## Priority 3: nice to know, observation only

- [ ] **P3-1** Tree filter on a very large tree: time until the filtered tree shows.
- [ ] **P3-2** Tree filter, Enter speed: type `motor` and press Enter within 200 ms several times; always the full word.
- [ ] **P3-3** Tree filter while the member grouping setting changes.
- [ ] **P3-4** Tree filter with several PLC projects and a collapsed group: Clear restores the group state.
- [ ] **P3-5** `ads_state` tool (TODO item 4) is not built yet; nothing to test.

## Other branches in flight

Taken from the section "Branches in flight" of `TODO.md` on `docs/todo-branches-in-flight` (state of 2026-11-19). All are rebased on `origin/main` 0.2.20 and pass their unit tests; the items are the manual checks and known open points, nothing here has been seen by hand yet.

### Priority 1: needs a hand check before a pull request

- [ ] **`ph/fix-menu-regex`** (pull request #60 open, merge first): in the Extension Development Host right-click a `.plcproj`, a `.TcPOU` and an `.xti` in the Explorer; the IECode entries must appear.
- [ ] **`feature/ads-local-netid`** (chain B, ADS): against a real PLC check batch write, pulse and its reset, restore, the persistent-data guard and the online symbol list. The CLI tests cover the fake backend only.
- [ ] **`feature/ads-state-and-tree-filter`** (chain B, ADS): against a real PLC check the auto-approve window, the log of connection and sampling events and the reload notice (see P1-6 to P1-8 above).
- [ ] **`ph/log-viewer`**: open a log, live tail on a growing and on a rotated file, merge of several files, a 100 MB file, search while loading.
- [ ] **Chain A, `lane1a/*`**: blame, history and staging in a real repository with real `.TcPOU` files (renames, a BOM file, CRLF).

### Priority 2: check on a real project

- [ ] **`lane2/object-graph`, `lane2/unused-objects`, `lane2/impact-view`**: unused marks and the impact view on a project with tasks and libraries.
- [ ] **`lane3/io-link-checks`**: one real system project with a built `.tmc`; `io-type-changed` relies on `TypeA` and `TypeB` in active mappings, which is unverified.
- [ ] **`lane3/structure-checks`**: run the lint on a real project (safe to review now).

### Priority 3: known open points (decide or accept, no test needed)

- [ ] `lane1a/object-spans-blame`: a boundary line is repaired only next to the old first or last line of its commit; blame ignores whitespace, so a change inside a string literal can keep its old author.
- [ ] `lane1a/object-history`: only the first parent is followed (a rename on a merged branch is lost); whole-object history shows no deletions; opened diffs are empty after a restart.
- [ ] `lane1a/object-staging`: a deleted method has no Stage action; index updates are not one transaction with another Git client.
- [ ] `lane2/object-graph`: references in visualizations and non-ST bodies match words; library versions are chosen by name; a namespace qualifier does not restrict the lookup.
- [ ] `lane2/unused-objects`: hints are hidden while the XML counterpart is dirty only on the next save.
- [ ] `lane2/impact-view`: tasks counted by entry program; a variable shows its owner's result; a same-named GVL in two projects can be rejected; a link in a system-only project cannot be opened.
- [ ] `lane3/structure-checks`: a qualified type resolves by its last name; `xml-parse` is not strict; the `Lint Objects` summary can count a superseded run as empty.
- [ ] `lane3/io-link-checks`: a parent symbol counts as proof for a removed member (deliberate); the build is chosen by name, not by `TmcFilePath`; a PLC without any link is not checked.
- [ ] `feature/ads-local-netid`: the online symbol list is capped by the CLI before the prefix and type filters; `ads symbols --online` ignores `--save`, `--csv`, `--members`, `--plc`; duplicate names in one batch are compared as typed; restore does not compare with the value the AI wrote.
- [ ] `feature/ads-state-and-tree-filter`: a changed auto-approve duration moves the end of an expired window (intended, documented); an idle stop of the host is logged as a sampling stop; the scope gap warning covers the window up to the newest sample only.
- [ ] `feature/tree-filter`: a broad filter scans all objects per expanded folder; System projects and `References` are not searched.
- [ ] `ph/log-viewer`: user log format regexes run on the extension host; a rotation between the search worker and the scan can pair an old index with new text; a failed live refresh is retried only when the file size changes; a long first record (over 64 KiB) defeats format detection.

### Merge order and housekeeping

- [ ] Merge `ph/fix-menu-regex` first: every branch that adds a menu entry depends on a working condition.
- [ ] Chain A in order (graph, unused, impact as stacked pull requests); chain C after it, dropping the two shared commits.
- [ ] `combined/analysis-and-tree` (chain A, chain C and the tree filter, 964 extension tests): split into pull requests at the commits of the single branches.
- [ ] Chain B (ADS) only after the hand checks above.
- [ ] Plan-only branches: `feature/raw-xml-compare` (nothing built) stays out and is listed in `TODO.md` ("Plan-only branches"). `feature/object-analysis-and-history` (plans only) stays in on purpose, as the base of chains A and C, which implement its plans.

## Seen so far (before the fixes)

| Item | Result |
|---|---|
| `motor` plus immediate Enter | ok: filters by the full word |
| `motor @fb`, `@gvl` | ok: only hits visible, folders with hits open |
| Same words in other case or order | ok: same filter, no flicker |
| Funnel and Clear icon while filtered | ok: both visible, funnel left |
| Clear with the box open | ok: box closes, filter gone |
| Run the command again with the box open | ok: box stays, text stays |
| Collapsed group, filter, Clear | group restored; a library project that was open came back closed (fixed, see P1-4) |
| Create an object while filtered | the filter was gone afterwards, twice (fixed, see P1-1 and P1-2) |
