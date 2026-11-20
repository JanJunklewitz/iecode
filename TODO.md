# TODO

## Priorities: small items worth doing next

Ranked by value for the effort (checked 2026-11-17 against the items below and [docs/ads-mcp-wishlist.md](docs/ads-mcp-wishlist.md)). Each is a day or less; none needs a design decision first.

1. **Live check of the ADS MCP features** (no code, about 1 hour on a simulation): the checklist under "ADS MCP: live check of the write and struct-read features". Everything from batch write to `ads_symbols --online` is unit-tested only, so a defect found here costs more than any new feature.
2. **ARMED expiry for `auto` AI writes** (small): the path allowlist exists (`iecode.ads.aiWritePaths`, Plan C7a); only the expiry of `auto` is missing. See "ADS write allowlist and ARMED expiry". Built 2026-11-18 (Plan A, `feature/ads-state-and-tree-filter`). The simulation test of 2026-11-20 ran an older build; the arming decision is pinned by a test, the check has to be repeated with this build (open, see [docs/open-tests.md](docs/open-tests.md)).
3. **Resume notice after a download or restart** (small): the watch view and the scope show a one-line notice when sampling resumed (wishlist section 2, "New"). `ads_wait` already reports the end reason; reuse it. Built 2026-11-18 (Plan B, same branch). Simulation check 2026-11-20: no notice appeared after a runtime restart, probably because a plain stop and start keeps the symbol version; open, see [docs/open-tests.md](docs/open-tests.md).
4. **`ads_state`** (small): run / stop state, task cycle time and cycle counter in one read, so an AI sees that the PLC restarted (wishlist section 7, "New").
5. **Dependency graph as Mermaid export** (small): text export of the graph `iecode.showGraph` already builds.
6. **ADS Scope export as CSV** (small): export a recording; the AI summary can follow later.
7. **Project view: search and filter in the tree** (small to medium): filter by name and kind. Built 2026-11-18 on `feature/tree-filter` (Plan D). Hand-checked 2026-11-20: name and kind filter, Enter timing, Clear, same filter in another case or order. Two defects found there are fixed (the filter vanished when another command's dialog closed the box; projects hidden by the filter came back closed) and need one more look, see [docs/open-tests.md](docs/open-tests.md).

Items 2, 3, 4 and 7 are planned in the [small items master plan](docs/superpowers/plans/2026-11-17-small-items-master-plan.md) (branch `feature/ads-state-and-tree-filter`): [A auto write expiry](docs/superpowers/plans/2026-11-17-small-items-a-auto-write-expiry.md), [B sampling notice](docs/superpowers/plans/2026-11-17-small-items-b-sampling-notice.md), [C `ads_state`](docs/superpowers/plans/2026-11-17-small-items-c-ads-state.md), [D tree filter](docs/superpowers/plans/2026-11-17-small-items-d-tree-filter.md).

Not now: same-cycle batch write, event order across tasks (both deferred by decision 2026-11-09), the log file viewer, the formatter (both need a design first).

## Branches in flight

State of 2026-11-19. All branches below are rebased on `origin/main` at release 0.2.20 and pass their tests. Every one was reviewed (code review at level high) and then checked by a second model (Copilot); the confirmed findings are fixed with a regression test and the notes in each `CHANGELOG.md` name what users see. Nothing is pushed and no pull request exists yet. `combined/analysis-and-tree` (see below) holds chain A, chain C and the tree filter in one line; the single branches stay for stacked pull requests.

**Chain A: object analysis** (base: `feature/object-analysis-and-history`, plans only, 3 commits)
- [ ] `lane1a/object-spans-blame`: blame per method in the ST view (CodeLens and hover, setting `iecode.blame.enabled`).
  - Open: a boundary line is only repaired when it sits next to the old first or last line of its commit, so an edit of the line after an appended one can hide the repair. Blame ignores whitespace (`-w`), so a change inside a string literal can keep its old author.
- [ ] `lane1a/object-history`: history of one object or member that follows renames, and a diff of one commit.
  - Open: the walk compares each commit with its first parent only (a rename on a merged branch is not followed, and merges rarely appear in `git log --follow`). A whole-object history does not show deletions. Opened diffs keep their text in memory only, so a restored tab after a restart is empty.
- [ ] `lane1a/object-staging`: stage a single method from the ST view.
  - Open: a deleted method has no Stage action (no anchor in the view). Index updates re-check the blob before `update-index` but are not one transaction with another Git client.
- [ ] `lane2/object-graph`: symbol index, reference edges, reachability, entry points and the cached analysis state.
  - Open: references in visualizations and non-ST bodies match words, not resolved variables (can only keep objects alive). Library versions are chosen by name, not by version. A namespace qualifier does not restrict the lookup to that library.
- [ ] `lane2/unused-objects`: unused marks in the tree and faded hints in the ST view.
  - Open: hints are hidden while the XML counterpart is dirty only on the next save.
- [ ] `lane2/impact-view`: impact of an object, member or variable, and Mermaid export.
  - Open: tasks are counted by entry program, not by task name. The result for a variable is the result of its owner object. The editor symbol is resolved against all projects, so a same-named GVL in two projects can be rejected. A link found in a separate system-only project cannot be opened from the list.
  - Shares two commits with chain C (`Parse the PLC side of an IO link in one place`, `Build a symbol index per PLC project`) with identical patches: rebasing chain C on the merged chain A drops them; keep the version of chain A where `unitIndex.ts` conflicts (it has the later fixes).

**Chain B: ADS tools** (base: `origin/main`)
- [ ] `feature/ads-local-netid`: batch write with a persistent-data guard, restore, structures read whole, online symbol list.
  - Open: the online symbol list is capped by the CLI before the prefix and type filters (a note says so, the real fix is a filter in the CLI). `ads symbols --online` ignores `--save`, `--csv`, `--members` and `--plc`. Duplicate names in one batch are compared as typed, not resolved. Restore does not compare the current value with the value the AI wrote.
- [ ] `feature/ads-state-and-tree-filter`: auto-approve window for AI writes, log of connection and sampling events, notices in tool results.
  - Open: changing the auto-approve duration changes the end of an already expired window (a re-arm is not required). An idle stop of the host is logged as a sampling stop. The scope gap warning covers the window up to the newest sample only (pinned by a test).
- [ ] `feature/tree-filter` (own worktree): name and kind filter for the project tree.
  - Open: a broad filter scans all objects per expanded folder; System projects and `References` nodes are not searched.

**Singles**
- [ ] `ph/fix-menu-regex`: the escaped dots in the explorer and editor menu conditions (also `.xti`), with a manifest test. Rebased on 0.2.20, 712 tests green; it also fixes seven more conditions that main added since. Merge first: every other branch that adds a menu entry depends on a working condition.
  - Pull request: [#60](https://github.com/JanJunklewitz/iecode/pull/60) (open).
  - [ ] Manual check before merging: in the Extension Development Host right-click a `.plcproj`, a `.TcPOU` and an `.xti` in the Explorer and confirm that the IECode entries appear.
- [ ] `ph/log-viewer`: log file viewer, rebased on `origin/main` (backup of the old state: `backup/log-viewer-pre-rebase`).
  - Open: regexes of user log formats run on the extension host (known limit, a workspace may supply them by decision). The text search worker and the scan read the file independently, so a rotation between them can pair an old index with new text. A failed live refresh is retried only when the file size changes. A scan has no fixed end offset while the file grows. A long first record (over 64 KiB) defeats format detection. Repeat grouping compares a hash. The copy of the menu fix was dropped from this branch (it comes with `ph/fix-menu-regex`).

**Chain C: object checks** (base: `feature/object-analysis-and-history`)
- [ ] `lane3/structure-checks`: lint rules for object files (XML structure and rules between function blocks).
  - Open: a qualified type resolves by its last name, not into the selected library. `xml-parse` is not a strict well-formedness check. The `Lint Objects` summary can count a superseded run as empty.
- [ ] `lane3/io-link-checks`: IO links against the symbols of the built PLC project.
  - Open: a parent symbol counts as proof for a removed member (a deliberate rule, pinned by a test). `io-type-changed` relies on `TypeA` and `TypeB` in active mappings, which is unverified on a real project. The build is chosen by name, not by `TmcFilePath`. A PLC without any link is not checked at all.

**Combined branch**: `combined/analysis-and-tree` = chain A + chain C + `feature/tree-filter` on `origin/main` 0.2.20, 74 commits in one line (964 extension tests, VSIX packages). The two shared commits of the chains are gone (identical patches); where `unitIndex.ts` conflicted the version of chain A was kept. Chain B (ADS) and `ph/log-viewer` are left out on purpose: they need checks against a real PLC or by hand first, and `ph/fix-menu-regex` is a small pull request of its own (prepared, not pushed). When the combined branch is split into pull requests again, cut it at the commits of the single branches.

**One branch for one pull request (2026-11-20)**: `combined/all-in-one` = all branches above (chain A, chain B, chain C, `ph/fix-menu-regex`, `ph/log-viewer`, `feature/tree-filter`) on `origin/main` 0.2.20, with today's fixes: the tree filter keeps its filter when another dialog closes the box and gives back the folders it hid, the online symbol list resolves the members below the filter path, and the blame test cleanup retries on Windows. It replaces `combined/analysis-and-tree`. Open hand checks are listed by priority in [docs/open-tests.md](docs/open-tests.md). Not in it on purpose: `feature/raw-xml-compare` (plan only) and the old `ph/*` and `backup/*` branches (earlier work, squashed into main by pull requests #1, #14, #16, #17, #30, #35, or backups).

**Cut points for stacked pull requests**: the single local branches of chain A, chain C, `feature/tree-filter` and `feature/ads-state-and-tree-filter` were deleted on 2026-11-20 after `combined/all-in-one` took them in. Their tips are the second parent of the matching `Merge <branch>` commit (`git log --merges --format='%h %s %p' origin/main..combined/all-in-one`), so the history is intact and any of them can be recreated with `git branch <name> <second parent>`. Kept as branches: those with a copy on `origin` (`feature/ads-local-netid`, `feature/object-analysis-and-history`, `ph/fix-menu-regex` with pull request #60, `ph/log-viewer`), `lane1a/object-spans-blame` (it also holds the test fix that is a cherry-pick in the combined branch), the `backup/*` branches and `combined/analysis-and-tree` (older copies of reviewed commits).

**Merge check (2026-11-19)**: all 13 branches were merged on top of `origin/main` 0.2.20 in a throwaway branch. The result compiles, passes 1107 extension tests and 329 CLI tests and packages as a VSIX. What it needed besides the changelog:
- `extension/src/extension.ts` and `extension/src/views/tree.ts`: `feature/tree-filter` (own tree view variable and filter message), the unused marks (`tree.setUnused`) and the auto-reveal of main (`registerAutoReveal`) touch the same lines. Keep all three; the tree view variable of the filter is the one auto-reveal gets.
- `extension/package.json`: adjacent additions (commands, menus, settings) of several branches; keep both sides.
- `extension/src/core/unitIndex.ts`, `extension/test/model.test.ts`: chain A and chain C (see above).
- Seven menu conditions of main were escaped twice again: `ph/fix-menu-regex` has the fix and a test that fails on any new one.

**Where a pull request makes sense (and what to check first)**
- `ph/fix-menu-regex`: pull request #60 is open. Smoke test in the Extension Development Host: right-click a `.plcproj`, a `.TcPOU` and an `.xti` in the Explorer.
- `feature/tree-filter`: rebased on 0.2.20 (the auto-reveal of main and the unused marks touch the same lines; the tree view variable of the filter is the one auto-reveal gets). Check by hand: filter box, kinds such as `@fb`, Clear while the box is open, running the command twice.
- Chain A in order (graph, unused, impact as separate pull requests, each on the one before): unit tests are green, but there is no run on a real project yet. Check blame, history and staging in a real repository with real `.TcPOU` files (renames, a BOM file, CRLF), and the unused marks and the impact on a project with tasks and libraries.
- Chain C: the lint is safe to review now. The IO link checks need one real system project with a built `.tmc` (`io-type-changed` relies on `TypeA`/`TypeB` in active mappings, unverified).
- Chain B (ADS): not before the manual checks against a real PLC target: batch write, pulse and its reset, restore, persistent guard, online symbol list, auto-approve window and the reload notice. The CLI tests are green but cover the fake backend only.
- `ph/log-viewer`: not before the manual checks (open a log, live tail on a growing and a rotated file, merge of several files, 100 MB file, search while loading).
- One pull request with everything is possible (it builds and tests), but about 130 commits and 20 000 lines cannot be reviewed; prefer the stacked pull requests above.

**Not in this list (checked 2026-11-19)**: the earlier `ph/*` branches, `feature/merge-conflicts-and-xti-diff` and the ADS wishlist branches are merged (squashed pull requests #1, #14, #16, #17, #30, #35). `feature/raw-xml-compare` is a plan only. Branches of other authors were not touched.

**Plan-only branches (kept out of the pull request, listed so they are not lost; checked 2026-11-20)**
- [ ] `feature/raw-xml-compare` (pushed to `origin`): raw XML diff from the context menu. Nothing is built, the branch holds one commit with the plan. Steps: (1) Source Control, right-click on **Changes** and **Staged Changes**: "Show Raw Changes (XML)" with the same sides as VS Code (staged = HEAD and index, changes = index and working copy, untracked = empty and working copy; needs reading the index with `git show :<path>`); (2) Explorer, IECode view and editor tab: "Compare with HEAD (Raw XML)" in the Compare submenu (`iecode.compareRawWithHead`); (3) bug: the **Show Raw Changes (XML)** button is missing in a diff opened from the Git Graph extension, also after a reload (Git Graph opens `git-graph:/file.TcPOU?<base64>`, IECode turns it into an `iecode-src` ST diff, so the `when` clause of the button does not match); (4) the switch buttons of the diff show text instead of an icon (**Raw**, **ST**), so the palette entry needs a separate command with the long title; (5) e2e test, CHANGELOG, README. Not possible: an entry in Git Graph's own context menu. Workaround until step 3: `"iecode.openAsST": false`. Open question: "Compare with Commit… (Raw XML)" as well?
- `feature/object-analysis-and-history` (pushed to `origin` on 2026-11-20; plans only, 3 commits): the plans A to H and the master plan of the object analysis. Decision 2026-11-20: they stay in the pull request on purpose, as the base of chains A and C, which implement them; the items above link to them. They are not "left out"; the branch is only listed here because it holds no code.
- Everything else checked on 2026-11-20 (the earlier `ph/*` branches, `feature/merge-conflicts-and-xti-diff`, the ADS wishlist and `fix/*` branches): every file they added exists in `origin/main`; only `.vscode/launch.json` and `.vscode/tasks.json` of `feature/merge-conflicts-and-xti-diff` do not (editor settings; I did not check why they are not in main). `ph/st-in-scm-diff` and `ph/setup-this-pc` have about 70 percent of their added lines in `main` (the rest was changed later), so nothing is lost there either, by a spot check.

**Plans in this pull request and what is not built yet (checked 2026-11-20 by reading code and test names; no test was run for this check, and the checkboxes in the plan files are not ticked, so they say nothing)**
- Fully built: the log viewer plan (11 of 11 tasks); the object analysis master plan and plans A (blame), D (object graph), E (unused), F (impact and Mermaid), G (IO link checks), H (structure checks); the small items plans A (auto-write expiry), B (sampling notice) and D (tree filter); the wishlist plans A, B, and C except its release task.
- [ ] **`ads_state`** (small items plan C, wishlist E4): built on `feat/ads-state` (CLI `state` op, protocol entry 2, tool in the extension and MCP, tests with fakes, loss text of the sampling notice points at it). Open: plan task 1 step 1 and task 2 step 5 need a PLC (the names `TwinCAT_SystemInfoVarList._TaskInfo[n].CycleCount` / `.CycleTime` and `_AppInfo.OnlineChangeCnt` and the unit of `CycleTime` are unverified defaults in `PlcStateNames.cs`); the CLI release that freezes protocol entry 2 waits for this.
- [ ] **Object analysis plan B, task 4**: renamed items in the config diff (`kind: 'renamed'`, `entityOf`, the three consumers, tests). The master plan ships it as a separate pull request. Also from plan B: the object history walk has no cancel button although the plan asks for one (small).
- [ ] **Object analysis plan C, task 4**: Discard Method (`iecode.discardSection`, lens, guard, confirm). Only the pure `discardSection` function exists. The master plan ships it as its own pull request.
- [ ] **ADS wishlist plan C, task C8**: no pin test for protocol entry 2 and no CLI release; deliberately after the live checks. Plan D tasks D6 and D6b (which build runs on the target, loaded build against the workspace build), D8 and plan E task E9 (releases) are not started.
- [ ] **ADS wishlist plan E**: E2 (sample rate per symbol), E6 (alarms) and E7 (PLC cycle timestamps) are not started; their spikes need a PLC. E3 (connection and sampling notices) is covered by small items plan B except the resume notice after a download.
- [ ] Small: a Copilot `prepared`-decision test for a lapsed auto-approve window is missing in `writeGate.test.ts` (the MCP case and the pure rules are tested).
- Deferred by their plans, not gaps: the plot break in the ADS Scope, keep-alive after the last AI call, a CLI `iecode lint`, unused variables, object moves in the history, the log viewer's AI question, source tree filter, custom format editor and Restricted Mode.
- Manual checks of all of these: see [docs/open-tests.md](docs/open-tests.md).

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
    - [x] Restart of TwinCAT while watching (`target run`): disconnect (0x745, then 0x1D), `connected:true` again and the same items sample again. The route needs a TCP probe of 8016 / 48898 before it answers after a restart. Do not build such a probe: in measurements of another ADS project (2026-09-30) a bare TCP connect to 48898 made every concurrent ADS connection on that PC fail with `TlsSendError`.
    - [x] Enum values: member name and `e` are shown (INT-based enum `TcEventSeverity`); a write by name is not re-checked.
    - [x] Poll timing: 21 symbols at `interval` 10 ms give a row about every 17 ms (round trip over the Secure ADS route), about 16 % CPU of the host.
    - [ ] Download / online change while watching, INT -> REAL. Not possible on TP: the throwaway project failed to start the real-time kernel there (`RTIME: incompatible software detected`, 0x1024), so the original application was put back. Covered by unit tests with a fake link only (`IECode.Automation.Tests`).
    - [ ] TIME / LTIME / TOD / WSTRING values (the original application has none at the top levels).
    - [x] F5 checks of the view, the scope and the connection lease: the watch value and the scope line run live, the host process ends about 30 s after the last variable is removed and the scope is closed.
    - [x] Copilot agent mode: `iecode.ads.aiWrites` off (write refused, the message names "IECode: Set AI Write Access…"), confirm (dialog) and auto (writes) behave as intended.
- [ ] **ADS MCP: live check of the write and struct-read features**: batch write (`writes`), `pulseMs`, `journal`, `restore`, `confirmPersistent` and the struct read (`ads_read` with `depth`, `ads_watch { expand: true }`) are covered by unit tests only; none was tried against a real target with the installed extension and the iecode CLI of ADS host protocol 2.
  - [ ] Batch write of 2 to 3 values on a simulation, including one value that fails to parse (nothing may be sent) and the read-back text.
  - [ ] Pulse of a BOOL command bit: the bit returns to its idle value; cancel the call during the hold and check the reset still runs.
  - [ ] Journal and restore after a PLC download that renamed a symbol: the restore lists the symbol as skipped and restores the rest.
  - [ ] Struct read: that the elements of an array are the sub symbols of the array symbol (`SubSymbols`), the 200 member and 20 element caps, a struct that holds a pointer.
  - [ ] `ads_symbols` from the running PLC (`source: "online"` with a filter) on a large project: how long the upload takes and that the 500 match cap and the total are right.
  - [ ] PERSISTENT guard against a built project: a write to a `TcPersistent` variable is refused without `confirmPersistent`.
- [ ] **ADS MCP: batch write in the same PLC cycle**: Plan C sends several values as one ADS request, which does not guarantee that the PLC sees them in the same cycle. A same-cycle write needs a PLC-side handshake (e.g. a library block that takes the values and applies them in one cycle). Deferred by user decision 2026-11-09; see [docs/superpowers/plans/2026-11-09-ads-wishlist-master-plan.md](docs/superpowers/plans/2026-11-09-ads-wishlist-master-plan.md).
- [ ] **ADS Scope: break the plot at sampling holes**: the scope draws one line across a lost connection or a stopped sampling, so a hole looks like a flat value. `ads_scope` already warns about such holes in its window (`gapsIn` / `gapWarning` in `extension/src/core/samplingLog.ts`, small items Plan B, Decision 10); the webview should break the line there too. Left out of Plan B because the webview drawing code has no tests.
- [ ] **ADS MCP: event order across several PLC tasks**: the PLC-cycle timestamp work (Plan E7) only promises an order for symbols of one task. Comparing task timestamps across tasks is deferred by user decision 2026-11-09.
- [ ] **ADS MCP: manual checks of the `ads_symbols` changes**: three changes are covered by unit tests but were not tried in the installed extension against a built PLC project.
  - [ ] Library workspace without build output: `ads_symbols` names the library as "not built" and says the PLC project may be in another workspace (instead of "No symbols match").
  - [ ] Array of function blocks: checked 2026-11-16 against a real symbol table: the prefix `...afbGasChannel[2].` lists the members of that element (122 hits) and the plain list does not repeat them. Still open: the spelling of several indexes (`[1,2]`) against names that TwinCAT writes in a real `.tmc` (no multi-dimensional array found yet; the filter matches names only, not types), and reading an element path with `ads_read` (the sim was not connected). Done 2026-11-16: "symbol not found" for an index outside the bounds now names the array and its bounds (`ads_read`, `ads_watch`); check it once in the installed extension.
  - [x] `limit`: checked 2026-11-16 with `limit: 10` on 529067 symbols: 10 rows, the next page starts at the right `offset` without overlap or gap, the last page says "end of list" without a further `offset`.
- [ ] **ADS MCP: tell the chat why it has no tools**: found 2026-11-16 on a new machine where the CLI was missing and every chat only reported "tool not found"; the reason was a VS Code notification the AI cannot see.
  - [x] Done (case: the `iecode` MCP entry works but no tools are published): without a saved tool list `iecode mcp` offers one help tool `ads_help`. Its description names the cause (no window for the folder, two windows, window silent, version mismatch, or "never published") and calling it returns the steps (Install CLI, Connect Claude Code, Reconnect in `/mcp`). See `HelpList` / `HelpAsync` in `cli/src/IECode.Core/Mcp/McpBridge.cs`. Not yet tried in a real chat.
  - [ ] Open (case: the iecode CLI is missing): `iecode mcp` is the CLI, so nothing can answer; the chat only sees a failed server in `/mcp`. The extension would have to act before connecting, e.g. offer "Install CLI" when the entry in Claude Code points to a file that does not exist, and check the entry at startup.
  - [ ] Ideas to extend it: let `ads_help` also report what it can check (CLI version against the extension, whether the Claude Code entry points to an existing file, the discovery folder state, the resolved local NetId and whether the target answers); say in the help text which folder the session runs in and which folders have an IECode window open; offer the same hints for the GitHub Copilot tools (VS Code notification only today); show the problem in the ADS Watch view and not only as a notification. For "the target does not answer", check the layers one by one and name the first that fails: host reachable (ping, or a TCP connect to an unrelated open port; never to the router ports 48898 / 8016), the AMS router (`ReadState` on ADS port 10000, answers on every TwinCAT PC), the PLC runtime port. An earlier ADS project worked out that attribution, including that a firewall dropping ping must not read as "network down".
- [ ] **Log file viewer**: a dedicated viewer for log files with filters and a cleaner, more readable presentation than the raw text.
  - Plan: [docs/superpowers/plans/2026-11-04-log-viewer.md](docs/superpowers/plans/2026-11-04-log-viewer.md) (files up to 100 MB; TwinCAT logger text format first).
  - [x] Viewer (read-only custom editor for `.log`) with parsed columns, color per level, detail pane for multi-line entries, time deltas and gap marks, virtual scrolling.
  - [x] Filters: level, time range, source, free text and regex, with the number of hidden entries per filter.
  - [x] Jump between errors, bookmarks, grouped repeats with a counter, export of the filtered view.
  - [x] Live tail (also across a replaced or rewritten file) and several files merged on one timeline.
  - [x] Formats: generic entry model, built-in TwinCAT logger, tab-separated and plain text, own formats as regex definitions in `iecode.logViewer.formats`.
  - [x] Large files: chunked scan and a search worker; checked on 100 MB files with `IECODE_PERF=1` (`extension/test/logPerf.test.ts`), limit 5,000,000 entries / 1,000,000 sources.
  - Left:
    - [ ] "Ask AI about this entry" using the same interface as the ADS item above.
    - [ ] Source tree filter (pick sources from a tree instead of typing a substring).
    - [ ] Editor UI for custom formats (today only the JSON setting).
    - [ ] Notes on formats other than the two built-ins (PLC application logs, iecode CLI output, other custom logs).
    - [ ] The viewer in Restricted Mode: the extension declares `untrustedWorkspaces.supported: false`, so logs opened from an untrusted folder such as Downloads get no viewer.
    - [ ] Restore the merged panel after a reload (no webview serializer yet).
  - [x] Manual UI checks (F5, 100 MB TwinCAT log with about 1,000,000 entries): loading, column heads, level and text / regex filters with the error message of an invalid pattern, detail pane, F8 and error / bookmark navigation, Live with appended lines, two files merged on one timeline with file toggles, and the export of the merged view. Still open: an export with an active filter (only the unfiltered export was checked).
- [x] **SYS folders not detected correctly**: some SYS folders are not recognized correctly by the extension (project view).
  - Not reproducible any more: all 12 `*.Sys` repos were opened one by one and show up under "System Projects" (fixed earlier by the system projects change). The dependency graph now also says that only system projects without a PLC exist instead of "No TwinCAT projects in this workspace." (`extension/src/views/graph.ts`).
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
- [ ] **ADS write allowlist and ARMED expiry**: restrict which variables an AI may write and let `auto` write access lapse.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#b-ads-write-allowlist-and-armed-mode). Prior art: [Auda29/twincat-mcp-mono](https://github.com/Auda29/twincat-mcp-mono) (per-symbol `writeAllowlist` as third gate), [idomp/twincat-mcp-public](https://github.com/idomp/twincat-mcp-public) (SAFE / ARMED mode, armed expires after 5 minutes), [eponce00/twincat-mcp](https://github.com/eponce00/twincat-mcp) (expiring, scoped grants).
  - Idea: extend `iecode.ads.aiWrites` (off / confirm / auto) with glob patterns for allowed symbols and an expiry for `auto`. Replaces the "AI write allowlist" line under the ADS item above.
  - Status 2026-11-17: the path allowlist is done (`iecode.ads.aiWritePaths`, wishlist Plan C7a). The expiry of `auto` is built (Plan A, 2026-11-18, unit-tested); left: the F5 check, then tick this item.
- [ ] **Read-only diagnostics tools for AI**: TwinCAT state, event / runtime error list, log tail, NC axis and IO state as read-only tools, plus a "what is wrong right now" bundle.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#c-read-only-diagnostics-for-ai). Prior art: [Auda29/twincat-mcp-mono](https://github.com/Auda29/twincat-mcp-mono) (`tc_state`, `tc_event_list`, `tc_runtime_error_list`, `tc_log_read`, `tc_diagnose_*`, `nc_read_axis`, `io_read_group`).
  - Open: the logger source is the same question as in the log file viewer item; decide it once for both.
- [ ] **XML structure checks and OOP rules**: validate `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` after edits by hand or by AI (GUID format and uniqueness, LineIds, method wrappers, naming prefixes) and check IEC 61131-3 OOP rules (override signature, `FB_init` super call, interface contract, abstract instantiation).
  - Plan: [H](docs/superpowers/plans/2026-11-18-object-analysis-h-structure-checks.md) (master plan: [docs/superpowers/plans/2026-11-18-object-analysis-master-plan.md](docs/superpowers/plans/2026-11-18-object-analysis-master-plan.md)).
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#g-xml-structure-checks-and-oop-rules). Prior art: [agenticcontrolio/twincat-validator-mcp](https://github.com/agenticcontrolio/twincat-validator-mcp) (structure checks, 21 OOP checks, auto-fix, health score).
  - Idea: `iecode check` rules plus Problems-panel diagnostics on save; auto-fix only for the safe structural cases.
- [ ] **Metadata-only changes in the SCM view**: mark files whose only change is XAE metadata (new `TmcHash`, new `ProductVersion`, build timestamps) so they do not look like real changes, and offer "discard" for them.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#6-io-and-config-views-what-others-do). Prior art: [Explorer for TwinCAT](https://marketplace.visualstudio.com/items?itemName=thanhdang.explorer-for-twincat) (group "Build output (no code changes)"). The noise sources are already listed in [docs/research/xti-diff](docs/research/xti-diff/README.md).
  - Idea: reuse the noise filters of the config diff to decide "nothing but noise"; show the group in the IECode SCM view next to "Compare with HEAD".
- [ ] **Config diff: logical vs. formal changes and hiding equal items**: split every change into "logical" (changes plant behaviour) and "formal" (only matters for project handling, e.g. LineIds, GUIDs, offsets), and add a "hide equal items" / "changed only" filter.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#6-io-and-config-views-what-others-do). Prior art: Beckhoff TcProjectCompare ([manual](https://download.beckhoff.com/download/document/automation/twincat3/TC3_Project_Compare_Tool_EN.pdf), section 5.3.1: formal changes marked with a bar, "Hide equal items + formal changes").
  - Idea: map the existing categories and noise filters to logical / formal as a top-level switch; apply to the config diff and the IO links diff.
- [ ] **IO link consistency checks**: find dead links (link to a symbol that no longer exists), type mismatches between linked variables, unlinked variables, and inputs linked twice.
  - Plan: [G](docs/superpowers/plans/2026-11-18-object-analysis-g-io-link-checks.md).
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#6-io-and-config-views-what-others-do). No other tool found that does this.
  - Idea: new rules in `iecode check` and warnings in the IO links view; the IO links parser and the PLC symbol list already exist.
- [ ] **Semantic EtherCAT topology diff**: compare the device tree of two versions (devices, slots / modules, PDO mapping, DC settings) by identity instead of as raw XML.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#6-io-and-config-views-what-others-do). Related: the `.xti` survey in [docs/research/xti-diff](docs/research/xti-diff/README.md) shows which parts of the config matter. TcProjectCompare only offers a generic XML comparison here.
  - Open: which `.xti` / `.tsproj` parts hold the topology, how large the files get, how to match renamed devices.
- [ ] **Per-object history and staging**: history of one object (POU, method, property, ...) following renames and moves, and staging / discarding a single method instead of the whole file.
  - Plans: [A spans and blame](docs/superpowers/plans/2026-11-18-object-analysis-a-object-spans-and-blame.md), [B history](docs/superpowers/plans/2026-11-18-object-analysis-b-object-history.md), [C staging](docs/superpowers/plans/2026-11-18-object-analysis-c-object-staging.md).
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#7-more-ideas-ranked-by-interest-for-iecode). Prior art: [Explorer for TwinCAT](https://marketplace.visualstudio.com/items?itemName=thanhdang.explorer-for-twincat) (views "TwinCAT Changes", "TwinCAT Commits", "TwinCAT History").
  - Idea: history first (read-only, lower risk); staging needs a partial write into the git index and is the harder part.
- [ ] **ADS Scope export and summary**: export recordings as CSV, save and reload them, and give AI a readable summary (min / max, edges, time between edges).
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#e-record--export-of-scope-data). Prior art: [idomp/twincat-mcp-public](https://github.com/idomp/twincat-mcp-public) (ADS record to CSV without a TE13xx license).
  - Idea: replaces the Beckhoff Scope for simple timing checks; the summary is a new return value of the scope tool.
- [ ] **ADS MCP: request keys**: a repeated write with the same key returns the first receipt instead of writing again, so a retry never writes twice.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#j-ai-facing-robustness-from-the-job-based-mcps). Prior art: [eponce00/twincat-mcp](https://github.com/eponce00/twincat-mcp) (a key reused with different arguments is rejected).
- [ ] **ADS MCP: bounded results**: output limits and paging for all tools, upper bounds for the number of subscriptions and the wait duration.
  - Research: same section as above. Prior art: [Auda29/twincat-mcp-mono](https://github.com/Auda29/twincat-mcp-mono) (`maxNotifications`, `maxWaitUntilMs`, `maxEvents`, `maxLogBytes`), [eponce00/twincat-mcp](https://github.com/eponce00/twincat-mcp) (paged job results).
  - Idea: make the limits settings; compare with the limits `ads_wait` already has.
- [ ] **ADS MCP: `ads_sequence`**: several steps in one call, all validated before the first one runs; no nested sequences.
  - Research: same section as above. Prior art: [eponce00/twincat-mcp](https://github.com/eponce00/twincat-mcp) (`workflow.sequence`, up to 32 steps).
  - Open: how the write gate (`iecode.ads.aiWrites`) applies per step, and what a mid-sequence failure leaves behind.
- [ ] **Merge by identity in the merge editor**: use the semantic model instead of lines to resolve GUID and LineIds conflicts automatically.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#k-smaller-improvements-to-existing-features). Prior art: Beckhoff TcProjectCompare ([manual](https://download.beckhoff.com/download/document/automation/twincat3/TC3_Project_Compare_Tool_EN.pdf): merge direction, accept single / block / all).
  - Idea: builds on the config diff, which already compares by identity.
- [x] **Project view: search and filter in the tree**: filter the tree by name and kind. Done (unreleased): names of objects only; member names (methods, properties) and library sources are not searched.
  - Research: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#k-smaller-improvements-to-existing-features). Prior art: [Explorer for TwinCAT](https://marketplace.visualstudio.com/items?itemName=thanhdang.explorer-for-twincat) (Go to Object, Find in Folder / Project).
- [ ] **Mark unused objects**: flag objects that no task can reach (not called from any program, not referenced).
  - Plans: [D object graph](docs/superpowers/plans/2026-11-18-object-analysis-d-object-graph.md), [E unused objects](docs/superpowers/plans/2026-11-18-object-analysis-e-unused-objects.md).
  - Research: same section as above. Builds on the dependency graph.
  - Open: how to treat objects only used through interfaces, FB_init or libraries.
- [ ] **Dependency graph as Mermaid export**: export the graph of `iecode.showGraph` as Mermaid text for docs and pull requests.
  - Plan: [F impact and Mermaid](docs/superpowers/plans/2026-11-18-object-analysis-f-impact-and-mermaid.md) (the project graph already has `toMermaid` in `core/workspace.ts`; no command calls it yet).
  - Research: same section as above.
- [ ] **Libraries: outdated versions and version diff**: show which libraries have newer versions available and compare two versions as ST.
  - Research: same section as above. Builds on `iecode.libraries` and the ST compare.
- [ ] **git blame per method**: blame for a method, property or action of the ST view instead of XML lines.
  - Plan: [A](docs/superpowers/plans/2026-11-18-object-analysis-a-object-spans-and-blame.md).
  - Research: same section as above. Prior art: [Explorer for TwinCAT](https://marketplace.visualstudio.com/items?itemName=thanhdang.explorer-for-twincat) (optional line blame, known to misattribute the first and last line of a section).
- [ ] **ST formatter on the TcTidier engine**: "Format Document" for the ST view; the result is written back into the XML like any edit. Config: `.tctidier.json` (indent, alignment of declarations / assignments / named parameters, blank lines between CASE branches, one-line IF, print width).
  - Research and decisions: [docs/research/feature-ideas.md](docs/research/feature-ideas.md#f-formatter-for-st). Engine: [CodePiercerTechnology/TcTidier](https://github.com/CodePiercerTechnology/TcTidier) (MIT, TypeScript, `src/native/` has no `vscode` dependency).
  - Decision: vendor `src/native/` into the extension and refresh it with `scripts/sync-tctidier.ps1 <commit>` (records the commit in `VENDOR.md`, copies the licence, applies local `.patch` files). No local edits of vendored files; `git subtree` and submodules rejected.
  - Before adopting (about 2 hours): idempotent, nothing changed inside strings / comments / pragmas, no diff noise on `testdata/`, add a "format twice" test; ask the author about a shared library.
  - Also: add the TcTidier copyright to `NOTICE`.
