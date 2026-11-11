# ADS MCP tools: wishlist and status

What an AI agent would like from the `iecode` ADS tools (`ads_symbols`, `ads_watch`, `ads_read`, `ads_write`, `ads_scope`, `ads_wait`), collected during simulation tests against a running PLC. Items are ordered by how much context or time they save. Status as of 2026-11-09, branch `feature/ads-mcp-wishlist`.

- Roadmap with design and review: [plans/2026-11-06-ads-mcp-wishlist.md](superpowers/plans/2026-11-06-ads-mcp-wishlist.md) (phase numbers below refer to it).
- Master plan and sub-plans for the open items: [plans/2026-11-09-ads-wishlist-master-plan.md](superpowers/plans/2026-11-09-ads-wishlist-master-plan.md).
- Detailed plan of the first item: [plans/2026-11-06-ads-wait.md](superpowers/plans/2026-11-06-ads-wait.md).

Status values: **Done** (merged on the branch and unit-tested), **Planned** (in the roadmap, not built), **New** (asked for, not yet in the roadmap), **Out of scope** (decided against, with the reason).

## Implemented

| Item | Status | Tests | Notes |
|---|---|---|---|
| `ads_wait`: block until a symbol meets a condition (`=`, `<>`, `<`, `<=`, `>`, `>=`, `changes`, `contains`), timeout 1-120 s, cancel | Done (Phase 3) | Unit tests: condition grammar and type table, wait run (every row of a batch, deadline, cancel, end reasons), watch list holds, tool text, MCP and Copilot wiring. `npm test`: 394 passed, 0 failed, 1 skipped (2026-11-09) | Not yet checked by hand against a live PLC; the installed MCP server of the test machine did not offer the tool yet. |
| One serialized owner of the watch list, with temporary entries held for a wait | Done | `watchList.test.ts` | Two waits on one symbol, an AI `add` or `remove` during a wait and a user removal are covered. |
| A wait ends with a reason on host stop, restart, target change or type change | Done | `waitRun.test.ts`, `adswatch.test.ts` | The caller never sees a silent timeout. |
| Enum names seen are listed when a wait by enum name times out | Done | `waitRun.test.ts` | Makes a misspelled member easy to spot. |
| Hint that a `{attribute 'hide'}` variable has no ADS symbol | Done (open PR #27) | Unit tests | Part of the "symbol not found" wishlist item. |

## 1. Compact scope output (highest value)

| Item | Status | Notes |
|---|---|---|
| `ads_scope` never drops a value change when it thins a long window | Done (Plan A1) | Every transition survives thinning (first and last row of each run kept); a column that changes constantly is thinned evenly. Tests in `adswatch.test.ts`: `thinKeepingChanges keeps both sides of every transition`, `scopeText never drops a value change of a step counter and says it thinned`, `scopeText thins a fast-changing column evenly and still keeps every step`. |
| Say it when rows are dropped | Done (Plan A1) | Header line such as `200 of 1990 samples shown, 14 value changes kept`, with a note when transitions are not shown. Tests: `scopeText never drops a value change of a step counter and says it thinned`, `scopeText has no thinning header when every row is shown`. |
| Change-only mode (`changesOnly`): one row per value change with its time | Done (Plan A5; live check 2026-11-11 ok) | One row per change time with the value at the window start, never thinned, newest 200 rows plus a note; the whole answer keeps a character budget. Tests in `scopeChanges.test.ts`: `changesOnly lists one row per change time with empty cells for unchanged symbols`, `changesOnly shows the value at the window start and quotes text`, `changesOnly shows the newest rows and says how many it left out`, `the whole answer stays inside the budget: oldest rows go first, the columns footer stays`. |
| STRING and WSTRING history in the scope | Done (Plan A3-A5; live check 2026-11-11 ok) | The change log keeps text with its own entry cap; the summary quotes the last text and `changesOnly` lists every text. Tests: `change log keeps the first sample and every change, nothing else`, `long texts are stored cut but compared in full`, `scopeText summarises a STRING symbol by its changes`, `changesOnly distinguishes an empty string from an unchanged cell`. |
| `maxRows` and `decimals` options | Done (Plan A2) | Lets the caller ask for 20 rows and rounded numbers. Tests: `toolInput scope maxRows and decimals are clamped, never thrown`, `scopeText honours maxRows and says it thinned`, `scopeText rounds numbers to decimals but never pads integers`. |
| Per symbol in the summary: min, max, last, time of the first and last change | Done (Plan A4; live check 2026-11-11 ok) | `changes=K (first at -7.0 s, last at -1.0 s)` after the usual fields; constant numeric symbols print as before; read errors show `reading failed since ...`. Tests: `scopeText summary names the number of changes and when they happened`, `the summary shows the last valid value and since when reading fails`, `a capped change log says the count is a lower bound`. |

## 2. Edge and event search

| Item | Status | Notes |
|---|---|---|
| `ads_wait(symbol, condition, timeoutSeconds)` | Done (see above) | Replaces the sleep plus `ads_read` polling loop. |
| `edges: true` on `ads_scope`: rising and falling edges of BOOLs with timestamps | Done (Plan A7; live check 2026-11-11 ok) | Only the exact type BOOL; an alias is named, not guessed. An edge across a read error is dated as unknown between two times. Tests: `edgesText lists rising and falling edges of a BOOL`, `edgesText cannot date an edge across a read error`, `toolInput scope edges`. |
| Trigger and capture: arm a condition, return the scope window around it (pre and post seconds) | New | Needed for pulses and for reading a text at the moment a sequencer errors. Builds on the Phase 2 change log. |
| Resume watch sampling after a PLC download or restart and show a one-line notice | New | Sampling was stale for 974 s once. `ads_wait` already reports the end reason; the watch view and scope do not. |
| PLC-cycle timestamps via ADS notifications | Planned (Phase 8, spike first) | Task-cycle resolution, not the order inside one cycle. |

## 3. Reads

| Item | Status | Notes |
|---|---|---|
| Show the sample age in watch and scope summaries; warn when sampling of the whole list stopped | Done (scope: Plan A6; watch list: `ads_read`) | `ads_read` shows the age of a stale entry; the scope result starts with `No samples since ...` and names the last host message and why the host last ended. Tests: `hostNote names the last host message, the last end and a missing connection`, `scope with a stale newest sample names the host state`, `scope without any sample names the host message`. |
| Read structs and arrays as a whole (members as JSON or a list, optional `depth`) | Planned (Phase 5b) | Today: "not a single value". |
| Read hidden members behind an opt-in flag, or list them as hidden in `ads_symbols` | New | The hint (PR #27) says why a hidden member is missing; reading it needs a decision about a flag. |
| Read a property with monitoring `call` by its `P_` name; say clearly when no symbol exists | Planned (Phase 7) | |

## 4. Watch list management

| Item | Status | Notes |
|---|---|---|
| `ads_watch` returns only the diff and the count; a `list` option shows everything | Planned (Phase 1) | Today every call echoes the whole list (55 entries). |
| Named watch groups, switchable and removable in one call | New | Keeps the sample rate high for the few symbols that matter. |
| Let the AI remove entries the user added after a confirmation, or clear the AI-added ones in one call | New | |
| Per-symbol sample rate (10 ms for pulses, 500 ms for texts) | New | Needs a host change. |
| Poll interval and buffer length settable through MCP, with a read-only call for the current values | New | The scope panel has time span, poll and buffer, but the tools only take `seconds` and `symbols`; the poll rate is the user setting `iecode.ads.sampleIntervalMs`. A 90 s module init needs a bigger buffer. Optional confirmation when memory use rises. |
| Persist the AI watch list in the workspace; report entries that no longer resolve after a build | New | |

## 5. Writes and sequences

| Item | Status | Notes |
|---|---|---|
| `ads_write` with several symbols in one call, one confirmation | Planned (Phase 4) | One ADS sum write; first an SDK contract check. |
| Same-cycle write of several symbols | Out of scope | One ADS request does not guarantee the same PLC cycle; that needs a PLC-side handshake (roadmap, open question 2). |
| Pulse mode (`pulseMs`) for command bits | New | So a command start does not depend on the PLC resetting the bit. |
| Read-back text that tells "the PLC reset the bit" from "write rejected" | New | Both read "reads back as FALSE (the PLC may change it again)" today. |
| List what a session wrote (old and new value) and restore it in one call (`ads_snapshot` / `ads_restore`) | New | |

## 6. Symbols and build state

| Item | Status | Notes |
|---|---|---|
| `ads_symbols` shows the build time of the `.tmc` and warns when sources are newer | New | A retest once ran code built before the fix and was only found invalid by comparing file times by hand. |
| Report the PLC project build that is loaded on the target next to the workspace `.tmc` time | New | Makes a stale download visible in one call. |
| Symbols without a `.tmc` from the online symbol table, naming the source | Planned (Phase 5a) | Separate short-lived process, filter required, 500 matches at most. |
| `ads_symbols` filter by type or path prefix, paging beyond 100 hits, members of an FB instance with types | New | The online list of Phase 5a covers part of it. |
| Member list of an enum type | New | So valid write values are known. A timed-out `ads_wait` already lists the names it saw. |

## 7. PLC helpers

| Item | Status | Notes |
|---|---|---|
| `ads_state`: run or stop state, task cycle time, cycle counter | New | Detects a restart (everything reset). |
| Active alarms or the last N logger messages | Planned (Phase 9, spike first) | |
| A one-call overview of a state-machine function block (step, description, elapsed time, error text, busy, release and interlock texts) | New | Today 6 to 8 symbols per sequencer. Needs a convention for the member names, so it may be better as a user-defined preset than a built-in view. |
| Component mode (manual or automatic) of a path | New | Same convention problem as the line above. |

## 8. Safety and ergonomics

| Item | Status | Notes |
|---|---|---|
| Allow-list of path prefixes for AI writes (`iecode.ads.aiWrites`) | New | So `auto` can be used on a simulation without risk on a real target. Also listed in `TODO.md`. |
| Show the connected target in every tool result header, including writes and watch | New | Reads already print it. |
| Refuse PERSISTENT or configuration writes unless confirmed; list the persistent symbols changed in a session | New | |
| Aliases for long paths | Planned, deferred (Phase 6) | Small saving, hidden state in every input. Revisit after the output-volume items are in. |

## Suggested order for the open items

1. The two priority-1 correctness items of section 1 (silent thinning). They cause wrong conclusions, not just cost.
2. Phase 2 (`changesOnly` and strings), then Phase 1 (`ads_watch` diff).
3. Live check of `ads_wait` against a simulation, then release notes.
4. Phase 4 (batch write) and Phase 5 (structs, online symbols), which need the CLI.
