# ADS MCP tools: wishlist and status

What an AI agent would like from the `iecode` ADS tools (`ads_symbols`, `ads_watch`, `ads_read`, `ads_write`, `ads_scope`, `ads_wait`), collected during simulation tests against a running PLC. Items are ordered by how much context or time they save. Status as of 2026-11-17, branch `feature/ads-local-netid`. Built since the first version: `ads_config`, `ads_preset`, `ads_capture`, `ads_log`, the symbol listing options, batch write, pulse, journal and restore, the PERSISTENT guard and struct read. Still open: the build loaded on the target (D6), `ads_state`, alarms, PLC-cycle timestamps, per-symbol sample rates, the resume notice after a download, reading a property by its `P_` name and the "Implemented" table above, which keeps its 2026-11-09 wording. Done rows say "live check open" when only unit tests ran.

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
| Trigger and capture: arm a condition, return the scope window around it (pre and post seconds) | Done (`ads_capture`, Plan E5) | Built on the change log of the scope buffer; tests in `captureRun.test.ts`. |
| Resume watch sampling after a PLC download or restart and show a one-line notice | Planned ([small items Plan B](superpowers/plans/2026-11-17-small-items-b-sampling-notice.md)) | Sampling was stale for 974 s once. `ads_wait` already reports the end reason; the watch view and scope do not. |
| PLC-cycle timestamps via ADS notifications | Planned (Phase 8, spike first) | Task-cycle resolution, not the order inside one cycle. |

## 3. Reads

| Item | Status | Notes |
|---|---|---|
| Show the sample age in watch and scope summaries; warn when sampling of the whole list stopped | Done (scope: Plan A6; watch list: `ads_read`) | `ads_read` shows the age of a stale entry; the scope result starts with `No samples since ...` and names the last host message and why the host last ended. Tests: `hostNote names the last host message, the last end and a missing connection`, `scope with a stale newest sample names the host state`, `scope without any sample names the host message`. |
| Read structs and arrays as a whole (members as a list, optional `depth`) | Done in code (Plan D7, D7b; live check open) | `ads_read` with `depth` 1-5 (default 3) lists the value leaves from one sum read, at most 200 members and 20 array elements per array, with notes for everything left out; `ads_watch { expand: true }` watches the members. Needs the CLI with ADS host protocol 2 (feature `structRead`); an older CLI says what to update. Tests: `StructExpandTests`, `ReadMembers_*` in `AdsWatchBackendTests.cs`, `Read_with_depth_*` in `WatchHostTests.cs`, `watchExpand.test.ts`. Open: not tried against a real target, in particular that the elements of an array are the sub symbols of the array symbol. |
| Read hidden members behind an opt-in flag, or list them as hidden in `ads_symbols` | Done as a listing (Plan D2) | `ads_symbols { hidden: true }` also lists variables marked `{attribute 'hide'}` (source only, they have no ADS symbol, so they cannot be read). |
| Read a property with monitoring `call` by its `P_` name; say clearly when no symbol exists | Planned (Phase 7) | |

## 4. Watch list management

| Item | Status | Notes |
|---|---|---|
| `ads_watch` returns only the diff and the count; a `list` option shows everything | Done | `toolInput.test.ts`, `adsToolText.test.ts`. The result names what the call changed and the count; `list: true` shows everything. Live check 2026-11-11 ok. |
| Done (Plan B) | `watchList.test.ts`, `watchGroups.test.ts`, `watchRequest.test.ts`. Groups are labels on the AI's entries; switching one off parks its symbols (not sampled, kept in the list). A running wait keeps its symbol sampled. Live check 2026-11-11 ok. |
| Done (Plan B) | `watchRequest.test.ts`, `watchList.test.ts`. `force` asks the user once in a dialog (cancel and the 120 s timeout both keep the entries); `clearAi` removes only the AI's entries. Live check 2026-11-11 ok. |
| Per-symbol sample rate (10 ms for pulses, 500 ms for texts) | New | Needs a host change. |
| Poll interval and buffer length settable through MCP, with a read-only call for the current values | Done (`ads_config`, Plan E1) | One call both reads and sets; changes that raise the memory use ask the user. |
| Done (Plan B) | `unresolved.test.ts`, `adswatch.test.ts`. The list and the switched-off groups survive a window reload; entries that stop resolving are reported once. `npm test`: 521 tests, 520 passed, 0 failed, 1 skipped. Live check 2026-11-11 ok. |

## 5. Writes and sequences

| Item | Status | Notes |
|---|---|---|
| `ads_write` with several symbols in one call, one confirmation | Done (Plan C2, C3a-c; needs the CLI with ADS host protocol 2) | `writes` (1-20 items): all values are parsed first, then one ADS sum write without a fallback to single writes, one read-back, one result per item (written, not written, outcome unknown). Tests: `WriteMany_*` in `AdsWatchBackendTests.cs` and `WatchHostTests.cs`; `writeManyStage maps a reply, a proof of not sent and everything else to unknown`, `a batch on a protocol-1 host is refused before the gate`, `confirmMessage: one item is byte-identical to the old dialog, several list every write`. Item codes follow the SDK contract check of 2026-11-12 (plan C, "C1 findings"): only 0x703 and 0x704 count as "not written", every other code is "unknown". |
| Same-cycle write of several symbols | Out of scope | One ADS request does not guarantee the same PLC cycle; that needs a PLC-side handshake (roadmap, open question 2). |
| Pulse mode (`pulseMs`) for command bits | Done (Plan C4) | BOOL only (type read first), timing kept by the extension, the reset is always attempted and a failed reset names the bit that may still be set. Tests in `writeExec.test.ts` (`a pulse writes the value, waits, then writes the opposite`, `a failing reset says the bit may still be set`, `an unknown first write still tries the reset`), `pulseMs is refused when out of range, fractional, on a non-BOOL value or twice`. |
| Read-back text that tells "the PLC reset the bit" from "write rejected" | Done (Plan C5) | `writeResultText tells a bit the PLC reset from a plain read-back`, `readBackChanged compares BOOL literals only`. |
| List what a session wrote (old and new value) and restore it in one call (`ads_snapshot` / `ads_restore`) | Done (Plan C6a, C6b) as `ads_write` with `journal: true` and `restore: true`, not as separate tools | The old value is read just before each AI write (best effort, a failed read never blocks the write); the journal is per window and in memory. A restore is one confirmed batch of at most 20 values, lists what it had to skip (value never read, symbol not readable now, other target) and never plans its own writes again. Tests: `writeJournal.test.ts`, `a restore op journals its writes as restore and marks the written symbols restored`, `ads_write restore goes through the gate as one op with the restore flag`. |

## 6. Symbols and build state

| Item | Status | Notes |
|---|---|---|
| `ads_symbols` shows the build time of the `.tmc` and warns when sources are newer | Done (Plan D1) | Header line with the build time and a stale warning (more than 2 s). |
| Report the PLC project build that is loaded on the target next to the workspace `.tmc` time | New | Makes a stale download visible in one call. |
| Symbols without a `.tmc` from the online symbol table, naming the source | Done in code (Plan D5, D5b; live check open) | `iecode ads symbols --online --filter` (a short-lived command, at most 500 matches) and the chain build output, running PLC, source code in `ads_symbols` with the input `source`; every answer names its source. Tests: `OnlineSymbolsTests`, `OnlineSymbolListTests`, `symbolSource.test.ts`. Open: not tried against a real target, in particular the time of the symbol upload on a large project. |
| `ads_symbols` filter by type or path prefix, paging beyond 100 hits, members of an FB instance with types | Done (Plan D3) | `type`, `prefix`, `offset` and `limit`; the members of one array element are listed when the prefix names the element. |
| Member list of an enum type | Done (Plan D2, D2b) | `ads_symbols { enumType }` lists the members and values; a write by any name of a value works, aliases included. |

## 7. PLC helpers

| Item | Status | Notes |
|---|---|---|
| `ads_state`: run or stop state, task cycle time, cycle counter | Planned ([small items Plan C](superpowers/plans/2026-11-17-small-items-c-ads-state.md), plus the TwinCAT system state) | Detects a restart (everything reset). |
| Active alarms or the last N logger messages | Planned (Phase 9, spike first) | |
| A one-call overview of a state-machine function block (step, description, elapsed time, error text, busy, release and interlock texts) | Done as user-defined presets (`ads_preset`, Plan E8) | A preset is a named list of member names you define, so no naming convention is built in. |
| Component mode (manual or automatic) of a path | New | Same convention problem as the line above. |

## 8. Safety and ergonomics

| Item | Status | Notes |
|---|---|---|
| Allow-list of path prefixes for AI writes (`iecode.ads.aiWritePaths`) | Done (Plan C7a) | The list limits symbol names, not machines: the same names exist on a real target. Tests in `writePolicy.test.ts`. |
| Done (Plan B) | `adsToolText.test.ts`, `writeGate.test.ts`. Watch, write and wait results end with `ADS target: <target>`. Live check 2026-11-11 ok. |
| Refuse PERSISTENT or configuration writes unless confirmed; list the persistent symbols changed in a session | Done (Plan C7b, variant A plus B) | The build output marks persistent symbols and the members of persistent ones (`TcPersistent`, checked 2026-11-17 against a built module with about 2400 persistent member symbols), so they are guarded without setup; `iecode.ads.persistentPaths` adds prefixes the build does not mark. A write below a guarded name is refused unless `confirmPersistent: true`, the dialog marks it and the journal tags it `[PERSISTENT]`. Tests: `fromTmc marks PERSISTENT symbols and the members of persistent types and symbols`, `persistentIn also counts symbols the build output marks, and their members`, `a write to persistent data is refused without confirmPersistent`. A variable not in the build output (an unbuilt project) is not guarded unless listed. |
| Aliases for long paths | Planned, deferred (Phase 6) | Small saving, hidden state in every input. Revisit after the output-volume items are in. |

## Suggested order for the open items

1. The two priority-1 correctness items of section 1 (silent thinning). They cause wrong conclusions, not just cost.
2. Phase 2 (`changesOnly` and strings), then Phase 1 (`ads_watch` diff).
3. Live check of `ads_wait` against a simulation, then release notes.
4. Phase 4 (batch write) and Phase 5 (structs, online symbols), which need the CLI.
