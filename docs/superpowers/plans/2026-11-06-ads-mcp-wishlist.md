# ADS MCP Wishlist Implementation Plan

> **For agentic workers:** this is a roadmap plan. Each phase gets its own detailed task plan (TDD steps, exact code) before it is built; use superpowers:writing-plans for that, then superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make the `iecode` ADS MCP tools fit how an AI agent debugs a running PLC: wait for a condition instead of sleeping, see only what changes (numbers and strings), prove the order of events within a PLC cycle, write several values at once, read structures, and see active alarms.

**Architecture today (relevant parts):**

- Tool logic: [extension/src/ads/adsTools.ts](../../../extension/src/ads/adsTools.ts) (symbols, watch, read, scope), write through the gate in `extension/src/core/writeGate.ts`. MCP wiring: [extension/src/core/mcpTools.ts](../../../extension/src/core/mcpTools.ts); tool descriptions and input schemas come from `contributes.languageModelTools` in `extension/package.json` (shared with the Copilot tools in `extension/src/ads/lmTools.ts`). Texts: [extension/src/core/adsToolText.ts](../../../extension/src/core/adsToolText.ts). Input parsing: `extension/src/core/toolInput.ts`.
- Sample history: `ScopeBuffer` in [extension/src/core/adswatch.ts](../../../extension/src/core/adswatch.ts) keeps a numeric series per item plus only the *latest* text, so strings have no history ("no numeric samples").
- ADS side: the CLI watch host (`iecode` child process, JSON lines). [cli/src/IECode.Core/Ads/WatchHost.cs](../../../cli/src/IECode.Core/Ads/WatchHost.cs) polls `IWatchBackend.ReadWatched()` (one sum read) every `intervalMs` (10-5000 ms) and stamps rows with the host clock; ops are `watch`, `read`, `write`, `interval`. Backend: [cli/src/IECode.Automation/AdsWatchBackend.cs](../../../cli/src/IECode.Automation/AdsWatchBackend.cs); non-single-value symbols are rejected ("not a single value; add its members instead").
- `ads_symbols` reads only the build output `<plc>.tmc` next to the `.plcproj` (`fromBuild` / `findTmc` in `extension/src/core/adsinterface.ts`).

**Tech Stack:** TypeScript (extension, `node --test`), C# .NET (CLI, xUnit), `Beckhoff.TwinCAT.Ads`. No new runtime dependencies in the extension.

## Global Constraints

- Public repository: no internal project names, symbol paths, machine names or data in code, tests, docs or commits. Commits: GitHub noreply author, `git commit -s`, English subject plus 1-3 sentence why-body.
- Every new or changed tool is declared once in `extension/package.json` (`languageModelTools`) and so exists for Copilot and MCP alike; tool texts live in `adsToolText.ts` and are pinned by tests.
- Writes keep the existing guarantees of the write gate: one user confirmation per AI write operation, "Not written" only with proof, "outcome unknown" after a timeout.
- Long-running tools (`ads_wait`) end before the MCP client's tool timeout (`CLAUDE_TOOL_TIMEOUT_MS`, 300 s) and honour the cancel signal.
- Protocol changes between extension and CLI bump the watch protocol version (`WatchHelloEvent.Protocol`, today `1` in `WatchHost.cs:11`), once per release that carries CLI changes. The CLI is installed separately from the extension (`iecode.cliPath`, PATH or install dir, `extension/src/cli/iecode.ts:51,125-132`), so the strict equality check (`host.ts:338`) would switch off *all* ADS tools after every CLI release for users whose versions differ. Instead the extension accepts any host protocol from 1 up to its own and switches off only the *features* the older host lacks, with a message naming the feature and "update the iecode CLI"; a newer host than the extension is still refused, so the compatibility is deliberately asymmetric: a CLI update can still break an older extension, and the message says to update the extension (review D5, reopened as D14). Rules (review D23): every protocol number has an immutable entry in one version table in `host.ts` (ops, request fields, reply shapes, write-proof semantics); changes to existing replies are additive (new optional fields) so no reply adapter is needed; the capabilities are reset on every host (re)start. Tests per CLI-touching phase: protocol-1 host with scalar read/write/watch/wait works, new features report "needs a newer CLI", current host works, newer host is refused.
- Every tool in `languageModelTools` must be served by both `buildMcpTools` and `lmTools.ts`; a manifest-parity test fails the build when one is missing (review D6). `MCP_TOOL_NAMES` in `mcpTools.ts:20` has no reader; delete it or derive it.
- This branch stacks on open PRs: #27 (hidden-symbol hint, HEAD `34135b9`) and, for Phase 5, #26 (library projects in `ads_symbols`). Rebase onto `main` after they merge.
- Tests: `cd extension && npm test`; `dotnet test` only through the PowerShell tool, never chained with `dotnet build`, nothing heavy in parallel.
- Keep the existing tool names; new parameters are optional so existing callers keep working.

## Phases at a glance

| # | Item (from the wishlist) | Value | Where | Size |
|---|---|---|---|---|
| 1 | `ads_watch` returns only the change | small | extension | 1 h |
| 2 | Scope `changesOnly` + strings in the table | high | extension | 4-6 h |
| 3 | `ads_wait` for a condition | highest | extension | 1-1.5 days (host ownership, gen race, lifecycle) |
| 4 | Write several values in one call | high | CLI + extension | 1-1.5 days (incl. SDK check) |
| 5 | `ads_symbols` fixes + structures readable | high | extension + CLI | 4-6 h |
| 6 | Aliases for long paths (**deferred**, review D2) | small | extension | 2 h |
| 7 | "Symbol not found" hint, matching property | small | extension | 2 h |
| 8 | PLC-cycle timestamps (notifications) | high | CLI + extension | 1-2 days |
| 9 | Active alarms from the TwinCAT EventLogger | medium | CLI + extension | spike + 1 day |

Order rationale: 3 is the biggest time saver, needs no CLI change and, since review D4 (rows on the sample event), no longer depends on the Phase 2 change log, so it goes first (review D13); then 1 and 2; 8 reuses the change log; 8 and 9 have open questions and start with a spike.

---

### Phase 1: `ads_watch` returns only the change

**Problem:** every `ads_watch` call returns the whole watch list (40+ lines) although the caller only added or removed a few.

**Design:**
- Default result: `Added: …`, `Removed: …`, `Not removed (added by the user): …`, per-item errors of the *added* symbols, and one line `Watch list: N symbols`.
- New optional input `list: boolean`; `ads_watch {}` (no add/remove) or `list: true` returns the full list as today.

**Files:** `extension/src/ads/adsTools.ts` (`watch`), `extension/src/core/adsToolText.ts` (`watchResultText`), `extension/src/core/toolInput.ts` (`parseWatchInput`), `extension/package.json` (schema + model description), `extension/test/adsToolText.test.ts`.

**Tests:** add two symbols → only those two lines plus the count; add an unknown symbol → its error is shown; empty call → full list; failure path still shows the full list (the caller needs to know what is left).

---

### Phase 2: Scope with `changesOnly` and strings

**Problem:** the scope table repeats unchanged rows (200 rows, 5 interesting), and string/text values (step descriptions, error texts) have no history at all.

**Design:**
- `ScopeBuffer` gets a per-item **change log** `{ t, text }[]`, appended only when the text differs from the previous sample (all types, also strings and enums). Trimmed by `seconds` like the numeric series, but with its **own entry cap** (review D7: 100 000 entries total, split per item like `trim()` does) and texts stored cut to 256 characters, because the numeric budget of 2 000 000 values would allow ~500 MB of strings. When the cap trims entries inside the window, the table says so (`older changes dropped`). The numeric series stays for the plot.
- `ads_scope` input `changesOnly?: boolean` (default `false` to keep current behaviour; the description recommends it). With it, the table is built from the change logs: one row per timestamp where at least one shown symbol changed; unchanged cells stay empty; strings are quoted and cut to 80 characters per cell.
- Summary line for non-numeric symbols: `S: changes=K last="…"` instead of "no numeric samples".
- First row of a `changesOnly` table shows the value at the window start (so a reader knows the state before the first change). Trimming keeps one predecessor entry per symbol (the last change before the window), so a string unchanged for ten minutes still has a start value; where the cap removed it, the cell says `unknown (history dropped)` (review D24).
- Changes are detected on the full value text before it is cut to 256 characters; a stored text that was cut is marked (`…[cut]`), so two different long strings with the same start are still two changes.
- The `changesOnly` table is never thinned with `downsample` (that would drop the short changes this table exists for); above 200 rows it shows the newest 200 and says `N earlier changes not shown, narrow seconds or symbols`.

**Files:** `extension/src/core/adswatch.ts` (`ScopeBuffer.push`, new `changes(symbol, from)`, `scopeText`), `extension/src/core/adsToolText.ts`, `extension/src/ads/adsTools.ts`, `toolInput.ts` (`parseScopeInput`), `package.json`, `extension/test/adswatch.test.ts`. The scope view (`extension/src/views/adsScope.ts`) is untouched.

**Tests:** constant BOOL plus toggling INT → rows only at the toggles; STRING changes appear with quotes; long strings cut; the change-log cap holds with a fast-changing string and the table says `older changes dropped`; `setItems` drops the change log of a removed symbol and `clear()` empties all logs (target change); a value unchanged since before the window still shows its start value; two long strings with the same first 256 characters are two changes; 300 changes show the newest 200 plus the note; `changesOnly: false` output unchanged (existing tests stay green).

---

### Phase 3: `ads_wait` for a condition

**Problem:** the agent guesses with sleeps whether a sequence step has been reached; each guess costs a round trip.

**Design:**
- New tool `ads_wait { symbol, condition, timeoutSeconds? }`. Condition grammar (parsed in a pure module `extension/src/core/waitCondition.ts`): `= v`, `<> v`, `< v`, `<= v`, `> v`, `>= v`, `changes`, `contains "text"`. `v` is a number, `TRUE`/`FALSE`, an enum name or a quoted string. Semantics by symbol type (review D16, one table in `waitCondition.ts`, everything else is a parse error naming the allowed forms):

  | Symbol type | allowed `v` | `=` / `<>` | `<` `<=` `>` `>=` |
  |---|---|---|---|
  | integer (incl. LINT/ULINT) | unquoted integer | exact, compared as `BigInt` from the value text | yes, `BigInt` |
  | REAL/LREAL | unquoted number | numeric equality of the parsed numbers (`1.5` = `1.50`), no epsilon; the tool text says so | yes |
  | BOOL | `TRUE`/`FALSE` (case-insensitive) | yes | not allowed |
  | enum | name (case-insensitive) or unquoted integer (compared with the row's enum number `e`) | yes | integer only |
  | STRING/WSTRING | quoted string only | exact, case-sensitive text | not allowed |
  | other (TIME, DATE …) | quoted string | exact displayed text | not allowed |

  `contains "text"` is for strings only (case-sensitive). A null value, a read error, `NaN` or `Inf` never satisfies a condition and never counts as a change; the result then says "no valid value". The symbol type comes from the watch item (`WatchItem.type`, `numeric`, the enum number `e`); a type the table cannot classify falls back to "other". A type change during the wait (download) ends it with that reason.
- Mechanism: the symbol is added to the watch list as an AI entry for the duration of the call if it is not watched yet. `watchEdit` keeps an entry the *user* re-added (`adswatch.ts:328`), but MCP calls run concurrently, so two waits on one symbol, or an AI `ads_watch add` during a wait, would lose the entry when the first wait ends. `adsTools()` is built once per MCP connection (`mcpServer.ts:162`) and once for Copilot (`lmTools.ts:29`), so the ownership lives in the singleton `AdsHost` (review D11, revised as D17): `host.holdForWait(symbol)` / `release` keep a reference count per symbol, and every list change (AI `ads_watch`, user edits, waits) goes through one serialized edit path in `AdsHost` that applies deltas to the current list instead of replacing it with a list computed before an `await`. The entry is removed when the last wait releases it, unless an `ads_watch add` made it permanent meanwhile. An AI `ads_watch remove` of a held entry only clears the permanent flag; the entry stays until the waits end. A user removal, clear or rename ends the affected waits with "removed from the watch list by the user". A full watch list (200 symbols, `WatchHost.cs:11`) ends the wait at once with the limit error. Each temporary add/remove is a `watch` op with a new gen, so the user's watch view shows the entry while the wait runs; the tool text says so. The tool subscribes to the host's sample events and checks **every row** of each batch; `changes` compares against the first sample after the call starts.
- `onSamples` exists (`host.ts:55`) but carries no data, and the host flushes rows every 100 ms (`WatchHost.cs:12`, `FlushMs`) while sampling down to 10 ms, so one event can hold 10 rows. Change it to fire `{ gen, rows }` (review D4) and resolve the symbol's column by name from the items of that `gen` (a user edit of the list during the wait renumbers the columns; rows of another gen are skipped).
- Generation race (review D18): today a watch reply is settled as a promise and `applyItems` runs only after the `await` (`host.ts:180`), while `lines()` dispatches every line of a stdout chunk synchronously, so samples of the new gen in the same chunk are dropped (`ScopeBuffer.push` checks the gen). `handle()` applies the items of a `watch` reply synchronously while dispatching it, before the next line, so the mapping for gen N exists before its first samples. Test through the real `lines()` + `handle()` with the reply and a one-row pulse in one chunk.
- Lifecycle (review D19): the wait awaits `host.ensure()` (not the fire-and-forget `use()`) and holds a lease for its whole duration (the host stops 30 s after the last lease, `host.ts:2`). `stop(reason)` today publishes only `{ connected: false }` and drops the reason (`host.ts`, `stop()`); add an `onEnded({ reason })` event fired for every stop, restart and target change, also while already disconnected. The wait ends with that reason, never with a silent timeout. One idempotent `finish()` resolves the call; cancel or timeout during the temporary add still releases the hold when the add completes later. The deadline runs from the call start on a monotonic clock (`performance.now()`) and includes host start and the watch add.
- Observation, not call start (review D20): the latest buffered value and a write read-back (`valueAt` returns it without a time, `host.ts:131`) do not prove anything about the call start. The wait evaluates only rows with `t` ≥ the call start (the host stamps rows with the same machine clock); the first such valid row is the baseline for `changes`. If that first row already meets the condition, the result says "true at the first observation (<time>)".
- Result: `Condition met at <time> (after 3.42 s): <symbol> = <value>`. Timeout: `Not met within N s; last value …` or `Not met within N s; no valid value observed` (not an error result, so the agent can decide). `alsoShow` is left out of the first release (review D20); the agent can call `ads_read` right after.
- `timeoutSeconds` default 30, clamped to 1…120 (review D12). `CLAUDE_TOOL_TIMEOUT_MS` is a measured lower bound for Claude Code only (`mcpTools.ts:84`), other MCP clients stop tool calls sooner; an agent that needs longer calls the tool again. The MCP cancel signal ends the wait at once.
- Resolution is the sample interval; the result names it (`sampled every 100 ms`). Phase 8 brings it to task-cycle resolution (not order inside a cycle).

**Files:** new `extension/src/core/waitCondition.ts` + test; `extension/src/ads/host.ts` (`onSamples` payload, synchronous `applyItems` for watch replies, `onEnded`, `holdForWait`, serialized list edits), `extension/src/core/adswatch.ts` (`watchEdit` deltas), `adsTools.ts` (`wait`), `mcpTools.ts` (register, pass `signal`), `lmTools.ts` (Copilot tool with `CancellationToken`), `toolInput.ts`, `package.json`, `adsToolText.ts`.

**Tests:** condition parser (all operators, quoting, bad input → clear error); wait with a fake host: met after the 3rd sample, already met, timeout, cancel, temporary watch entry removed afterwards and kept when the user added it during the wait; a pulse that is true only in row 4 of a 10-row batch is found; a list edit during the wait (new `gen`, columns shifted) still checks the right symbol; host stop during the wait ends it with the reason; two concurrent waits on one symbol keep the entry until the second ends; an `ads_watch add` during a wait keeps the entry afterwards; a full watch list gives the limit error; waits from two separate `adsTools()` instances (MCP + Copilot) share one hold; an AI `ads_watch remove` during a wait keeps the entry until the wait ends; a user removal ends the wait with its reason; reply + pulse in one stdout chunk through the real dispatcher; a stale buffered TRUE and a write read-back do not satisfy the wait; a row stamped before the call start is ignored; `null → value` is not a change; cancel during the temporary add releases the hold after the add completes; the condition table (every row above, LINT above 2^53, `1.5` = `1.50`, STRING `"001"` ≠ `1`, ordering on BOOL/STRING rejected).

---

### Phase 4: Write several values in one call

**Problem:** setting mode, setpoint and start takes three calls and three confirmations, with gaps between the writes.

**Design:**
- **Step 0, SDK contract check (review D21, prerequisite, ~2 h against a local simulation target):** with the pinned `Beckhoff.TwinCAT.Ads` 7.0.389, establish for the exact `SumSymbolWrite` overload used: result cardinality and order, which per-item codes come from the device and which the SDK synthesizes, what the aggregate result holds when the whole request fails, whether individual results survive an aggregate failure (the read adapter drops them when `r.Failed`, `AdsLink.cs:126`), and whether the SDK splits a large request. Record the findings in the phase plan; the result model below only claims what this check proves.
- `ads_write` accepts exactly one of `{ symbol, value }` (today) or `{ writes: [{ symbol, value }, …] }` (1-20 items, order kept). Both forms together, an empty list or two items naming the same symbol (case-insensitive) are refused before the dialog.
- **One** confirmation dialog listing all writes; the gate treats the batch as one operation.
- CLI: new watch-host op `writeMany` with a list; the backend resolves and converts *all* values first (any failure → `WriteNotSentException` for the whole batch, nothing sent); today conversion happens inside `Symbol.Write()` (`AdsLink.cs:105`), so Phase 4 splits it into a `Prepare(text) → bytes` step and a send step instead of looping over `Write()`; then sends one ADS **sum write** (`SumSymbolWrite`), then reads all back. One ADS request means the PLC sees the values between two cycles together only if the request fits one cycle; the tool text says "sent in one ADS request" and does not promise the same cycle.
- The sum write uses **no fallback** (`SumFallbackMode` none; `AdsLink.cs:79` uses `All` for reads, do not copy it). A failed whole request is reported as "Not written" only if Step 0 shows that this error comes back before any sub-write runs (e.g. "service not supported"); any other whole-request failure is "outcome unknown" for every item (review D10, narrowed by D21).
- Result model (review D9, revised by D21): `WriteResult` (`writeGate.ts:26-32`, one outcome per op today) gets a batch form: the whole batch is `refused` (nothing sent, reason per item), `unknown` (sent, no trustworthy reply), or `done` with one entry per item: `written` (+ read-back value or read-back error; a failed read-back never changes `written`), `notWritten` (only for per-item codes that Step 0 shows to be device rejections without effect), or `unknown` (any other code, a missing or misaligned result, or a result count that does not match). The conservative default is `unknown`, as in today's single write (`WatchProtocol.cs:13-19`). `writeResultText` lists every item; `writeResultIsError` is true when any item is not `written`.

**Files:** `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`IWatchBackend.WriteMany`, data records), `WatchHost.cs` (`writeMany` op, protocol version bump), `cli/src/IECode.Automation/AdsWatchBackend.cs`, `AdsLink.cs` (sum write); `extension/src/ads/host.ts`, `extension/src/core/writeGate.ts` (`WriteOp` with a list), `adsWrite.ts`, `mcpTools.ts`, `lmTools.ts` (Copilot's `prepareInvocation` confirmation must list every write, and `writeKey` must key the whole batch, `lmTools.ts:55-72`), `toolInput.ts` (`parseWriteInput`), `package.json`, `adsToolText.ts`. Tests on both sides (`AdsWatchBackendTests`, `writeGate` tests).

**Review focus:** one bad value in the batch → nothing written ("Not written", with the reason per item); timeout after send → "outcome unknown" for all; one item with a device-rejection code → only that item `notWritten`, the others written; an unclassified per-item code or a result count mismatch → that item (or all) `unknown`; a read-back failure keeps `written`; duplicate symbols, both input forms or an empty list are refused before the dialog; the dialog shows every symbol and value. Fake-link tests prove the classification code only; the Beckhoff behaviour itself is proven by Step 0.

---

### Phase 5: `ads_symbols` fixes and readable structures

**5a Project not found.**
- Root cause already fixed in open PR #26 (`683a1c1`, "List the ADS symbols of built library projects"): `adsTools.ts` filtered out every `isLibrary` project, so a module project with Title/Company/Version got "No PLC projects". No diagnosis step here (review D1); Phase 5 starts after #26 is merged.
- Remaining work, fallback chain for the symbol list when no `.tmc` exists: (1) the **online symbol table** of the connected target (review D15, revised as D22: **not** a watch-host op, because the host handles requests one after another and a full symbol upload, `AdsLink.cs:71-74`, would stall samples, waits and confirmed writes behind it. Instead the existing one-shot command `iecode ads symbols` (today build output only, `TargetCommands.cs:248`) gets `--online --target <netid> [--port]`, run by the extension as a separate short-lived process with a 60 s timeout; the filter is required, at most 500 matches are returned with the total count), (2) the source code (`fromSourceAt`, already used by the interface view). The result names its source (`from the running PLC`, `from the build output`, `from the source code (may differ from the PLC)`).

**5b Structures readable.**
- `ads_read` of a struct/FB instance returns all leaf members at once (`stX.a = 1`, `stX.b = 'text'`, …), depth-limited (default 3, max 5) and capped (200 members), arrays up to 20 elements. CLI: `ReadOnce` expands members via the symbol's `SubSymbols`, reading them in one sum read.
- `ads_watch` of a struct offers the same expansion on request (`expand: true`, adds the leaf members) instead of the error text; without it the error says that `expand: true` exists.

- Compatibility (review D23): the `read` reply keeps today's scalar fields for a single-value symbol and adds an optional `members` list for structs, so an older host's reply is a valid new reply without members; the extension shows "struct expansion needs a newer iecode CLI" when a struct read comes back from a host whose protocol lacks it.

**Files:** `adsTools.ts` (`symbols`, `read`), `cli/.../WatchProtocol.cs` (`ReadOnce` returns optional members besides `(Type, Value)`), `WatchHost.cs` (`read` reply with optional members, protocol bump), `cli/src/IECode.Cli/Commands/TargetCommands.cs` (`ads symbols --online`), `AdsWatchBackend.cs` (`ReadOnce` expansion, symbol browse), `PlcValueText.cs`, `extension/src/ads/host.ts` (`read` reply shape), `adsToolText.ts` (`readOnceRow`), tests on both sides.

---

### Phase 6: Aliases for long paths (deferred)

**Deferred by review D2.** Value is a few tokens per call; cost is hidden state in every tool input, and the write confirmation must then show the expanded path, not the alias. Revisit when agents demonstrably lose time to path length after Phases 1-3 have cut the output volume.

**Design (kept for later):**
- New tool `ads_alias { set?: { NAME: "path" }, remove?: string[] }`; aliases stored in `workspaceState`, shown in its result.
- Every symbol input of every tool expands a leading alias segment: `TS.bBusy` → `<path>.bBusy`. Expansion in one pure function (`extension/src/core/aliases.ts`) called from the input parsers; results show the alias form when the path came in as an alias (shorter output, too).
- Alias names: `[A-Za-z_][A-Za-z0-9_]*`, must not collide with a PLC namespace (`MAIN`, GVL names) — checked against the symbol list when available, else warned.

**Tests:** expansion, case-insensitivity, unknown alias passes through unchanged, collision warning, results use the short form.

---

### Phase 7: "Symbol not found" with a matching property

**State:** the `{attribute 'hide'}` hint is in on this branch (commit "Say that a hidden variable has no ADS symbol").

**Design:** when a symbol is not found, the extension looks in the source (`fromSourceAt`, already parsed for the interface view) for the declaring FB of the parent path and lists its properties with `{attribute 'monitoring' := 'call'}` whose names resemble the last segment (case-insensitive, prefix-stripped: `bBusy` ~ `Busy`). Text: `Not found. If it is hidden, try the property <parent>.<Prop> (monitoring call).` Only if the parent type can be resolved; otherwise the generic hint stays.

**Files:** `extension/src/core/adsinterface.ts` (property lookup), `adsToolText.ts`, `adsTools.ts` (read/watch/write error paths); tests with a small TcPOU fixture.

---

### Phase 8: PLC-cycle timestamps

**Problem:** with 10-300 ms polling the order of two events within a few cycles ("valve closed before the axis starts") cannot be proven.

**Spike first (half a day, throwaway):** ADS device notifications (`AddDeviceNotification`, `AdsTransMode.OnChange`, cycle time 0 = every task cycle) deliver a PLC timestamp (FILETIME of the task cycle) per change. Questions: timestamp resolution and whether two symbols of the same task get identical stamps in the same cycle; cost of 50-200 notifications; how the notification buffer (`maxDelay`) batches; behaviour on download / symbol version change. Also: `WatchHost` is single-threaded by design ("No threads, no clock", `WatchHost.cs:6`) while notification callbacks arrive on ADS threads, so the spike must show the hand-off (a thread-safe queue the `Tick` loop drains) and what happens to queued events on reconnect. And: `ScopeBuffer.push` takes full rows per gen stamped with the host clock, while notify mode sends sparse PLC-time events; the spike must decide what feeds the numeric series (plot) in notify mode and how `trim()` handles two clocks (one clock per buffer, converting PLC time with the reported offset, is the default to test).

**Design (if the spike is go):**
- Scope of the promise: notifications show changes at task-cycle boundaries. They do not prove the order of two assignments inside one cycle, and a value that changes and reverts within a cycle is not seen. Equal timestamps mean "same cycle of the same task" only if the spike confirms task identity and resolution; the output marks the order of equal-time changes as unknown. Order inside a cycle needs PLC-side instrumentation and is out of scope.
- New sampling mode in the watch host: `mode: "poll" | "notify"`. In notify mode the backend registers one notification per watched symbol and the host emits change events `{ gen, t: plcTime, i, v }` (with `gen`, so Phase 3's column mapping works unchanged) instead of polled rows; `ads_wait` consumes these events with the same per-gen mapping; `t` is the PLC timestamp, the host clock offset is reported once.
- The extension's change log (Phase 2) stores these events as they come; `ads_scope changesOnly` then shows PLC times with 0.1 ms resolution and a `cycle` column (same timestamp = same cycle); `ads_wait` reports the PLC time.
- Notify mode is opt-in (setting + `ads_watch { mode }`), poll stays default for the plot.

**Files:** `WatchProtocol.cs`, `WatchHost.cs`, `AdsWatchBackend.cs`, `AdsLink.cs`; `extension/src/ads/host.ts`, `adswatch.ts`; protocol version bump.

---

### Phase 9: Active alarms from the TwinCAT EventLogger

**Spike first:** how to read active alarms on the target without new runtime dependencies in the extension. Candidates: the `Beckhoff.TwinCAT.TcEventLoggerAdsProxy` NuGet in the CLI (ADS port 132, `GetActiveAlarms`, texts by language id), or the COM `TcEventLogger` on the engineering PC. Check: works against a remote target via the route, licence/redistribution terms of the package, text language.

**Design (if go):** new tool `ads_alarms { since?: seconds }` → active alarms (raised time, source, event class/id, severity, text, confirmation state) and, with `since`, alarms raised/cleared in that span. CLI op `alarms` in the watch host.

---

## Open questions for the user

1. ~~Phase 5a: which project does `ads_symbols` not find?~~ Answered by PR #26 (library projects were skipped).
2. Phase 4: is "one ADS request" enough, or must the values land in the same PLC cycle (then a PLC-side handshake is the only safe way, out of scope)?
3. Phase 8: are all relevant symbols in the same PLC task? Cross-task order needs the task timestamps compared, which the spike has to confirm.
4. Phase 9: is the NuGet dependency in the CLI acceptable?

---

# Eng review (2026-11-06, /plan-eng-review)

Target: this file. All decisions below were taken by the reviewer under the user's explicit delegation ("du entscheidest alles"); each picks the recommended option. The plan text above already contains the accepted amendments.

## Step 0: Scope Challenge

Result: **scope reduced per recommendation** (Phase 6 deferred, Phase 5a diagnosis dropped).

What already exists and is reused:

- `watchEdit(..., byAi)` (`adswatch.ts:322-336`) already keeps an entry the user re-added, which is exactly what `ads_wait`'s temporary watch entry needs.
- `onSamples` (`host.ts:55`) exists; Phase 3 changes its payload instead of adding a second event.
- MCP calls already run concurrently with a per-call `AbortSignal` and `notifications/cancelled` (`core/mcp.ts:51-83`); only `ads_write` uses the signal today.
- `SumSymbolRead` is already wrapped in `AdsLink.cs:78`; Phase 4's `SumSymbolWrite` sits next to it in the same `TwinCAT.Ads.SumCommand` namespace.
- The 5a root cause is fixed in open PR #26 (`683a1c1`).

Complexity: the roadmap touches ~25 files and adds 3-4 new modules (`waitCondition.ts`, `aliases.ts`, CLI ops `writeMany`/`symbols`/`alarms`), so the complexity gate tripped. Each phase is its own PR, which keeps every diff small; the smaller arrangement drops `aliases.ts` (D2/D3).

Findings:

1. [INFORMATIONAL] (confidence: 9/10) plan line "Step 1 is diagnosis on the reporting setup" (Phase 5a): already done. PR #26 `683a1c1` removes the library filter (`adsTools.ts:67`, `const units = state.current.units.filter(u => !u.plc.isLibrary);`). See D1.
2. [INFORMATIONAL] (confidence: 7/10) Phase 6: aliases add hidden state to every tool input for a few saved tokens, and the write confirmation would have to show the expanded path. See D2.

Reality rows:

| premise | claim | receipt | verdict |
|---|---|---|---|
| P1 | `ScopeBuffer` keeps numeric series plus only the latest text | `adswatch.ts:69-70` | true |
| P2 | watch host polls 10-5000 ms, ops watch/read/write/interval | `WatchHost.cs:12` | true |
| P3 | non-single-value symbols rejected | `AdsWatchBackend.cs:96` | true |
| P4 | "an `onSample` event, if not already there" | `host.ts:55` `onSamples` exists, no payload | corrected |
| P5 | extension "refuses an older host" | `host.ts:338` refuses any mismatch | corrected |
| P6 | `CLAUDE_TOOL_TIMEOUT_MS` 300 s | `mcpTools.ts:85` | true |
| P7 | `ads_symbols` reads only `.tmc` | `adsTools.ts:70` `fromBuild` | true |
| P8 | Phase 5a "project not found" = parsing or missing .tmc | PR #26 commit body: library filter | false (other cause) |

unverified=0

- REALITY: premise-table finding 8 premises, 2 corrected, 1 false (5a cause) `extension/src/ads/host.ts:55`
- REALITY: already-done finding PR #26 fixes 5a; `git log HEAD..origin/main` empty `extension/src/ads/adsTools.ts:67`
- REALITY: surface-check pass no new CLI flags or routes named; existing watch-host ops checked `cli/src/IECode.Core/Ads/WatchHost.cs:33`
- REALITY: binding-decisions pass no prior decisions on this branch (decision search empty) `docs/superpowers/plans/2026-11-06-ads-mcp-wishlist.md:16`
- REALITY: numbers finding phase sizes are `[estimated]`; FlushMs 100 and interval 10 ms `[measured: WatchHost.cs:12]` `cli/src/IECode.Core/Ads/WatchHost.cs:12`
- REALITY: deferred-asks pass no linked issue; all wishlist items mapped, Phase 6 deferred with reason `docs/superpowers/plans/2026-11-06-ads-mcp-wishlist.md:28`
- REALITY: pr-count finding one PR per phase (7 PRs + 2 spikes); CLI-touching phases (4, 5, 8, 9) need a joint release `extension/CHANGELOG.md:1`

## Section 1: Architecture

1. [CRITICAL] (confidence: 9/10) `host.ts:439` `this.samples.fire();` with `WatchHost.cs:12` `FlushMs = 100, ... MinIntervalMs = 10`: one samples event carries up to 10 rows, but `onSamples` has no payload and `ScopeBuffer` keeps only the latest text. An `ads_wait` that checks the value when the event fires misses every short pulse. D4 accepted: the event carries `{ gen, rows }`, the wait checks every row, columns by name per gen.
2. [CRITICAL] (confidence: 8/10) `host.ts:2` "started on use and stopped 30 s after the last use": a wait without its own lease lets the host stop mid-wait and then times out silently. Necessary implementation of the stated behavior (lease for the whole wait, end with the reason on host stop / target change); added to Phase 3, no separate decision.
3. [CRITICAL] (confidence: 7/10) `WatchHost.cs:6` "No threads, no clock: the loop calls Tick": Phase 8 notifications arrive on ADS threads. Added to the Phase 8 spike questions.
4. [INFORMATIONAL] (confidence: 8/10) `lmTools.ts:55-72`: Phase 4's file list missed the Copilot confirmation (`prepareInvocation`, `writeKey(opts.input)` keyed by one symbol/value). Factual correction, added.
5. [INFORMATIONAL] (confidence: 8/10) `WatchProtocol.cs` `(string Type, string Value) ReadOnce(string symbol);`: Phase 5b changes this contract and the `read` reply; the file list missed the protocol and `host.ts`. Factual correction, added.
6. [INFORMATIONAL] (confidence: 8/10) `host.ts:338` `if (msg.protocol !== PROTOCOL)`: four phases change the protocol and strict equality forces joint releases. D5 accepted: one bump per release.
7. [INFORMATIONAL] (confidence: 7/10) hand-synced tool lists: `package.json` `languageModelTools`, `buildMcpTools` (`mcpTools.ts:42-56`), `vscode.lm.registerTool` (`lmTools.ts:85-89`), and `MCP_TOOL_NAMES` (`mcpTools.ts:20`, no reader). Phases 3 and 9 add tools in all three places. D6 accepted: parity test.

Design-twice: the only new module is `waitCondition.ts`, a pure parser. Second shape considered for `ads_wait`: a host-side condition op in the CLI (closer to the cycle, no rows over the pipe). Rejected for now: it needs a protocol bump and C# condition parsing, while the extension shape reuses the buffer and becomes cycle-exact with Phase 8 anyway.

Red flags: #8 hand-synced list (finding 7, D6). No others found.

Dispositions: 1 accepted (D4); 2, 3, 4, 5 accepted as necessary implementation or factual corrections; 6 accepted (D5); 7 accepted (D6).

## Section 2: Code quality

1. [INFORMATIONAL] (confidence: 6/10) Phase 3 grammar "comparison is numeric where both sides are numeric". Medium confidence, verify: `= 1.5` on a REAL compares floats exactly, and enums arrive with both text and number (`WatchRow.E`, `WatchProtocol.cs`). Superseded by the type table in Phase 3 (D16): this note first said "REAL equality compares the displayed text", which contradicted the plan; text equality would wrongly separate `1.5` and `1.50`.
2. [INFORMATIONAL] (confidence: 6/10) Phase 1 changes the default output of `ads_watch` for existing callers. Input stays compatible (Global Constraints) and the output is text for an agent, so this is intended; the existing `watchResultText` tests are updated, not deleted.

Dispositions: both carried into the phase plans as notes, no remedy choice.

## Section 3: Tests

Framework: `node --test` (extension, `npm test`), xUnit (CLI). Existing: `adswatch.test.ts`, `adsToolText.test.ts`, `toolInput.test.ts`, `writeGate.test.ts`, `mcpTools.test.ts`, `AdsWatchBackendTests`.

```
CODE PATHS                                         USER FLOWS
[+] Phase 1 ads_watch diff output                   [+] Agent adds 2 symbols
  ├── [GAP] added only + count                        └── [GAP] sees 3 lines, not 40
  ├── [GAP] unknown symbol error shown
  └── [★★ TESTED] failure -> full list (adsToolText.test.ts)
[+] Phase 2 change log / changesOnly                [+] Agent reads step texts
  ├── [GAP] rows only at changes                      └── [GAP] quoted, cut at 80 chars
  ├── [GAP] change-log cap + "older changes dropped"
  ├── [GAP] setItems/clear drop logs
  └── [★★★ TESTED] changesOnly:false unchanged (adswatch.test.ts)
[+] Phase 3 ads_wait                                [+] Agent waits for step = 40
  ├── [GAP] parser: all ops, quoting, bad input       ├── [GAP] met -> time + value
  ├── [GAP] pulse in row 4 of a 10-row batch          ├── [GAP] timeout -> last value, not error
  ├── [GAP] gen change during the wait                └── [GAP] cancel ends at once
  ├── [GAP] host stop -> reason
  └── [GAP] temp entry removed / kept if user re-added
[+] Phase 4 writeMany                               [+] User confirms batch
  ├── [GAP] one bad value -> nothing sent (C#)        ├── [GAP] [->E2E] dialog lists all writes (MCP)
  ├── [GAP] timeout after send -> unknown for all     └── [GAP] Copilot confirmation lists all writes
  └── [GAP] per-item ADS error in the sum write
[+] Phase 5 symbols fallback / struct read
  ├── [GAP] no .tmc -> online list, source named
  └── [GAP] struct -> leaf members, depth/count caps
[+] Manifest parity (D6)
  └── [GAP] every iecode_ads_* served by MCP + lm

COVERAGE: 2/22 paths tested (9%) | all gaps are planned tests of new behavior
QUALITY: ★★★:1 ★★:1 | GAPS: 20 (1 E2E)
```

Regression contract (from the plan's Global Constraint "Keep the existing tool names; new parameters are optional"): `ads_scope` without `changesOnly`, `ads_write {symbol, value}` and `ads_read` of single-value symbols give byte-identical results (the `ads_read` part added by review D8/outside voice, because Phase 5b changes the `ReadOnce` contract); `adswatch.test.ts`, `adsToolText.test.ts`, `writeGate.test.ts`, `mcpTools.test.ts` stay green unchanged except the intended Phase 1 output and the "five tools" count. D8 accepted.

Value cards for the new critical tests:

- Value: protects=ads_wait sees a condition true in only one row of a batch; fails_when=the wait checks only the latest value per event; why_new=no wait exists; seam=none; no_claim=real PLC timing (fake host rows)
- Value: protects=a bad value in a batch sends nothing; fails_when=validation interleaves with sends; why_new=Write() covers one symbol only; seam=none; no_claim=real ADS sum-write error codes (fake link)
- Value: protects=every manifest tool is served on MCP and Copilot; fails_when=a new tool is declared but not wired; why_new=mcpTools.test.ts checks only the five names; seam=none; no_claim=runtime registration in VS Code

Tests made obsolete: none.

## Section 4: Performance

1. [INFORMATIONAL] (confidence: 8/10) `adswatch.ts:73` `private readonly maxValues = 2_000_000`: a string change log under the same count budget can hold 2M strings (~200-500 MB `[estimated]` at 100-250 bytes each). D7 accepted: separate 100 000-entry cap, texts cut to 256 characters.
2. [INFORMATIONAL] (confidence: 5/10) Phase 8: 50-200 notifications per target, cost unknown. Medium confidence, verify in the spike.

Dispositions: 1 accepted (D7); 2 left to the spike.

## NOT in scope

- Phase 6 aliases: deferred (D2), revisit after Phases 1-3.
- Same-PLC-cycle guarantee for batch writes: needs a PLC-side handshake (open question 2).
- Host-side wait condition in the CLI: rejected for now (Section 1, design-twice).

## Failure modes

| Path | Realistic failure | Covered by | User sees |
|---|---|---|---|
| ads_wait | short pulse between flushes | D4 + pulse test | condition found |
| ads_wait | host stops / target changes mid-wait | lease + reason test | clear reason |
| ads_wait | VS Code reloads mid-wait, temp AI entry stays in workspaceState | no test; AI entries are visible and removable in the watch view | visible extra entry (not silent) |
| change log | fast string fills memory | D7 cap test | "older changes dropped" |
| writeMany | timeout after send | gate outcome-unknown test | "outcome unknown" for all |
| symbols fallback | target offline, no .tmc | source fallback test | "from the source code (may differ)" |
| notify mode | callbacks on ADS threads race the Tick loop | spike | unknown until the spike |

Critical gaps: 0 (the notify-mode race is gated by the spike, not shipped).

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| P1 watch diff | extension/src/ads, extension/src/core | — |
| P2 change log | extension/src/core | — |
| P3 ads_wait | extension/src/ads, extension/src/core | — (D13) |
| P4 writeMany | cli/, extension/src/core, extension/src/ads | — |
| P5 symbols/struct | cli/, extension/src/ads | PR #26 merged |
| P7 property hint | extension/src/core | PR #27 merged |
| P8 spike | cli/ (throwaway) | — |

Lane A: P3 -> P1 -> P2 (shared `adsToolText.ts`, `toolInput.ts`). Lane B: P4 -> P5 (shared `WatchHost.cs`, one protocol bump per release). Lane C: P7. Lane D: P8 spike. Lane B's Step 0 (SDK check) can start at once.

Conflict flags: lanes A, B and C all touch `extension/src/ads/host.ts`, `adsTools.ts`, `adsToolText.ts`, `toolInput.ts` and `package.json`. Only the CLI part of B and the P8 spike are truly independent; merge the extension parts one at a time (A first, since P3 reshapes `host.ts`), rebasing the others after each merge.

## Implementation Tasks

Synthesized from this review's findings.

- [ ] **T0 (P1, human: ~2h / CC: ~30min)** — contracts — write the three contract sections first (wait condition table D16, write outcomes D21, protocol version table D23) as part of each phase plan, before code
  - Surfaced by: Copilot second opinion 12
  - Files: phase plans
  - Verify: phase plan review
- [ ] **T1 (P1, human: ~3h / CC: ~30min)** — host — `onSamples` fires `{ gen, rows }`; watch-reply items applied synchronously in `handle()` (D18); ads_wait checks every row by column name
  - Surfaced by: Architecture 1 (D4)
  - Files: extension/src/ads/host.ts, extension/src/ads/adsTools.ts
  - Verify: `cd extension && npm test` (pulse-in-batch and gen-change tests)
- [ ] **T2 (P1, human: ~5h / CC: ~1h)** — host — wait holds in `AdsHost` with serialized delta edits (D17), `onEnded` with reasons, awaitable start, idempotent finish (D19), observation from call start (D20)
  - Surfaced by: Architecture 2
  - Files: extension/src/ads/adsTools.ts
  - Verify: host-stop test
(T-list labels P1/P2/P3 are priorities, not phase numbers.)

- [ ] **T3 (P2, human: ~3h / CC: ~30min)** — tools — move the Copilot registrations into a `vscode`-free table (today direct `vscode.lm.registerTool` calls, `lmTools.ts:85-89`), then the manifest parity test; remove or derive `MCP_TOOL_NAMES`
  - Surfaced by: Architecture 7 (D6)
  - Files: extension/test/mcpTools.test.ts, extension/src/core/mcpTools.ts
  - Verify: `npm test`; deleting one registration makes it fail
- [ ] **T4 (P2, human: ~1h / CC: ~10min)** — ScopeBuffer — separate change-log cap, 256-char texts, "older changes dropped"
  - Surfaced by: Performance 1 (D7)
  - Files: extension/src/core/adswatch.ts, extension/test/adswatch.test.ts
  - Verify: cap test
- [ ] **T5 (P1, human: ~1 day / CC: ~2h)** — writeMany — SDK contract check first (D21), then batch `WriteResult` with per-item `unknown`, no sum-write fallback (D10), input rules, Copilot confirmation lists all writes
  - Surfaced by: Architecture 4
  - Files: extension/src/ads/lmTools.ts
  - Verify: Copilot path test or manual check in VS Code
- [ ] **T6 (P2, human: ~2h / CC: ~20min)** — Phase 8 spike — include the ADS-thread to Tick hand-off
  - Surfaced by: Architecture 3
  - Files: cli/src/IECode.Core/Ads/WatchHost.cs (spike branch)
  - Verify: spike notes answer the hand-off question
- [ ] **T7 (P2, human: ~3h / CC: ~30min)** — protocol — version table, accept older hosts, gate features, additive replies (D14, D23)
  - Surfaced by: Architecture 6, Outside voice 6 (D14)
  - Files: cli/src/IECode.Core/Ads/WatchHost.cs, extension/src/ads/host.ts
  - Verify: hello-mismatch test still green

## Decision ledger

All answers: auto-decided by the reviewer under the user's delegation "du entscheidest alles" (chat, 2026-11-06), recommended option each time.

### R1: Phase 5a scope
Finding: Scope 1, INFORMATIONAL, 9/10, `adsTools.ts:67`, reviewer Claude
Plan baseline: original proposal (diagnosis step, then fallback chain)
Runtime evidence: PR #26 `683a1c1` removes the library filter
Question D1: Drop the 5a diagnosis and depend on PR #26? Recommendation: A because the root cause is already found and fixed.
Header: Phase 5a
Options:
A) Drop diagnosis (recommended): keep only the fallback chain; Phase 5 waits for #26.
B) Keep diagnosis: re-investigate a solved bug.
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: 5a reduced to the fallback chain, dependency on PR #26.
History: none

### R2: Phase 6 aliases
Finding: Scope 2, INFORMATIONAL, 7/10, plan Phase 6, reviewer Claude
Plan baseline: original proposal (build Phase 6)
Runtime evidence: unknown (path-length cost not measured)
Question D2: Include, defer or cut aliases? Recommendation: B because the value is small and it adds hidden input state.
Header: Aliases
Options:
A) Include: 2 h, new module and state.
B) Defer (recommended): revisit after Phases 1-3.
C) Cut: drop the idea.
State: approved
Actual answer: B (delegated auto-decision)
Accepted scope: Phase 6 deferred; design kept in the plan.
History: none

### R3: Structure
Finding: complexity gate (~25 files, 3-4 new modules)
Plan baseline: original arrangement (9 phases incl. `aliases.ts`)
Runtime evidence: n/a
Question D3: Original or smaller arrangement? Recommendation: B, same features after D1/D2 with one module fewer. Pending remedies not decided here: R4-R8.
Header: Structure
Options:
A) Original arrangement
B) Smaller arrangement (recommended): no `aliases.ts`, one PR per phase
State: approved
Actual answer: B (delegated auto-decision)
Accepted scope: one PR per phase, `aliases.ts` not created.
History: none

### R4: ads_wait sample evaluation
Finding: Architecture 1, CRITICAL, 9/10, `host.ts:439`, reviewer Claude
Plan baseline: "checks each new sample" via an `onSample` event
Runtime evidence: `onSamples` has no payload; flush 100 ms, interval down to 10 ms
Question D4: How does ads_wait see every sample? Recommendation: A, the smallest change, reuses the existing event.
Header: Wait samples
Options:
A) Event carries rows (recommended): `{ gen, rows }`, check every row, columns by name.
B) Read the Phase 2 change log after each event: couples the wait to the change-log cap.
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: payload change, per-row check, gen handling, tests.
History: none

### R5: Protocol bumps
Finding: Architecture 6, INFORMATIONAL, 8/10, `host.ts:338`
Plan baseline: bump per protocol change
Runtime evidence: strict equality check
Question D5: Bump per phase or per release? Recommendation: A, fewer lockstep releases.
Header: Protocol
Options:
A) One bump per release (recommended)
B) Capability list in hello: more code for a pair that always ships together.
State: superseded by R14
Actual answer: see R14
Accepted scope: see R14
History: first answered A (one bump per release, strict equality kept). Reopened as D14 because the outside voice showed a false premise: CLI and extension are installed separately (`extension/src/cli/iecode.ts:51,125-132`), so they do not always ship together.

### R6: Manifest parity test
Finding: Architecture 7, INFORMATIONAL, 7/10, `mcpTools.ts:20`
Plan baseline: none
Runtime evidence: three hand-synced lists, `MCP_TOOL_NAMES` unused
Question D6: Add a parity test? Recommendation: A, new tools are coming in several phases.
Header: Parity test
Options:
A) Add test, drop the unused list (recommended): ~10 min CC.
B) Do nothing: rely on review.
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Global Constraint + T3.
History: none

### R7: Change-log memory cap
Finding: Performance 1, INFORMATIONAL, 8/10, `adswatch.ts:73`
Plan baseline: shared `maxValues` budget
Runtime evidence: 2 000 000 count budget, no byte bound
Question D7: Own cap for the change log? Recommendation: A, bounded memory for strings.
Header: Log cap
Options:
A) 100 000 entries, 256-char texts, "older changes dropped" (recommended)
B) Shared budget as planned
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Phase 2 design and tests updated.
History: none

### R8: Regression contract
Finding: Test review, regression rule
Plan baseline: Global Constraint "new parameters are optional"
Runtime evidence: existing tests listed in Section 3
Question D8: Confirm the regression contract? Recommendation: A.
Header: Regression
Options:
A) Old calls byte-identical, only Phase 1 output and the tool count change (recommended)
B) No explicit contract
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Section 3 regression contract.
History: none

### R9: Batch write result model
Finding: Outside voice 1, High, `writeGate.ts:26-32`, reviewer Claude subagent (native fallback), verified by reading the type
Plan baseline: "per-item ADS error" plus "the gate treats the batch as one operation", no result type
Runtime evidence: `WriteResult` has one outcome per op (refused / written / unknown)
Question D9: How does a batch report partial results? Recommendation: A, keeps "Not written only with proof" per item.
Header: Batch result
Options:
A) Batch form: refused / unknown / done with per-item written or failed (ADS error) (recommended)
B) All-or-nothing text: any item error makes the whole batch "outcome unknown"; simpler but hides which item failed.
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Phase 4 result model, text and tests.
History: none

### R10: Sum write fallback
Finding: Outside voice 2, High, `AdsLink.cs:79` (`SumFallbackMode.All` for reads)
Plan baseline: "one ADS sum write", fallback unspecified
Runtime evidence: read path falls back to single reads
Question D10: Allow fallback to single writes? Recommendation: A, keeps the one-request promise.
Header: Write fallback
Options:
A) No fallback, rejected sum command = "Not written" for the batch (recommended)
B) Fallback with a note in the result: writes can then fail halfway.
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Phase 4 design + test.
History: none

### R11: Concurrent temporary wait entries
Finding: Outside voice 3, High, `adswatch.ts:322-336`, `core/mcp.ts:51-83`
Plan baseline: `watchEdit(..., byAi = true)` removal
Runtime evidence: `byAi` protects only user re-adds; MCP calls are concurrent
Question D11: How are temporary entries owned? Recommendation: A, smallest fix that covers both races.
Header: Wait entries
Options:
A) In-memory reference count per symbol, `ads_watch add` makes it permanent (recommended)
B) Never remove temporary entries: leaves clutter in the user's list.
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Phase 3 mechanism, limit error path, tests.
History: none

### R12: ads_wait upper clamp
Finding: Outside voice 4, Medium, `mcpTools.ts:84`
Plan baseline: clamp 1-280 s
Runtime evidence: 300 s is a measured lower bound for Claude Code only
Question D12: Upper clamp? Recommendation: A, works for clients with shorter limits; the agent can repeat.
Header: Wait clamp
Options:
A) 1-120 s, default 30 (recommended)
B) 1-280 s as planned
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Phase 3 design.
History: none

### R13: Phase order
Finding: Outside voice 5, Medium, plan "Order rationale" vs D4
Plan baseline: 1, 2, then 3
Runtime evidence: D4 removed the dependency of 3 on 2
Question D13: Ship Phase 3 first? Recommendation: A, highest value, no dependency.
Header: Order
Options:
A) 3, then 1, then 2 (recommended)
B) Keep 1, 2, 3
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: order rationale and lanes updated.
History: none

### R14: Protocol compatibility (reopens R5)
Finding: Outside voice 6, Medium, `host.ts:338-339`, `extension/src/cli/iecode.ts:51,125-132`
Plan baseline: R5 answer A (strict equality, one bump per release)
Runtime evidence: CLI installed separately; strict equality switches off all ADS tools on a version skew
Question D14: How does the extension treat an older host? Recommendation: A, a CLI update never breaks the existing tools.
Header: Protocol
Options:
A) Accept protocol 1..own, switch off only missing ops, refuse a newer host (recommended)
B) Keep strict equality (R5 answer)
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Global Constraint rewritten; each CLI-touching phase gates its new op by protocol version and tests the "older host" message.
History: replaces R5.

### R15: Online symbol list bounds
Finding: Outside voice 8, Medium, `AdsLink.cs:73`, `host.ts:12`
Plan baseline: `symbols { filter }` unbounded
Runtime evidence: 10 s request timeout, full symbol upload
Question D15: Bounds for the online list? Recommendation: A.
Header: Symbol bounds
Options:
A) Filter required, 500 matches + total, 60 s op timeout (recommended)
B) Unbounded as planned
State: approved
Actual answer: A (delegated auto-decision)
Accepted scope: Phase 5a design.
History: none

Outside-voice findings taken as factual corrections without a choice: 7 (parity test needs a `vscode`-free registration table, T3 updated), 9 (notify mode vs `ScopeBuffer`, added to the Phase 8 spike), 10 (watch limit, folded into R11), 11 (visible watch entry, documented in Phase 3), 12 (T-list labels clarified), 13 (`ads_read` added to the D8 regression contract).

### Copilot second opinion (2026-11-06)

Reviewer: GitHub Copilot CLI, model `gpt-6.1-sol` (a different model family), read-only, verdict "would not approve unchanged". 12 findings (1 critical, 10 medium, 1 low). The reviewer verified each against the code before accepting; all were accepted. Answers: user instruction "baue alles ein was du für sinnvoll hältst" (chat, 2026-11-06), recommended option each time.

### R16: Wait condition semantics
Finding: Copilot 4, medium, plan Phase 3 vs Section 2 note (contradiction), `adswatch.ts:39-62`
Plan baseline: "numeric where both sides numeric, else exact text" plus the conflicting Section 2 note
Runtime evidence: rows carry value text and enum number `e`; `numericValue()` is plot-oriented
Question D16: One type table for the grammar? Recommendation: A, removes the contradiction and the unsafe cases.
Header: Wait grammar
Options:
A) Type table with BigInt integers, numeric REAL equality, enum by name or `e`, quoted strings exact, invalid combinations rejected (recommended)
B) Keep the loose rule
State: approved
Actual answer: A
Accepted scope: Phase 3 table and tests.
History: Section 2 note 1 superseded.

### R17: Host-wide wait ownership (revises R11)
Finding: Copilot 2, medium, `mcpServer.ts:162`, `lmTools.ts:29`, `host.ts:154-185`
Plan baseline: R11 answer A (reference count owned by `adsTools.ts`)
Runtime evidence: `adsTools()` is built per MCP connection and for Copilot; `setEntries` replaces whole lists after awaits
Question D17: Where does the wait hold live? Recommendation: A.
Header: Wait ownership
Options:
A) In `AdsHost`, all list edits serialized as deltas, AI remove keeps held entries, user removal ends waits (recommended)
B) Per `adsTools()` instance as in R11
State: approved
Actual answer: A
Accepted scope: Phase 3 mechanism, T2, tests.
History: refines R11 (reference count kept, owner moved).

### R18: Generation race
Finding: Copilot 3, medium, `host.ts:180` (`applyItems` after `await`), `lines()`
Plan baseline: D4 rows on the event
Runtime evidence: samples of a new gen in the same stdout chunk are dropped today
Question D18: Fix the reply/sample ordering? Recommendation: A, the smallest change at the cause.
Header: Gen race
Options:
A) Apply watch-reply items synchronously in `handle()`, test through the real dispatcher (recommended)
B) Buffer samples of unknown gens until their items arrive
State: approved
Actual answer: A
Accepted scope: Phase 3, T1.
History: none

### R19: Wait lifecycle
Finding: Copilot 6, medium, `host.ts` `use()`, `stop()`, `setState()`
Plan baseline: lease + "ends with the reason"
Runtime evidence: `use()` is fire-and-forget; `stop()` drops the reason; `setState()` suppresses repeats
Question D19: Lifecycle contract? Recommendation: A.
Header: Lifecycle
Options:
A) Awaited start, `onEnded({ reason })`, idempotent finish, monotonic deadline from call start, cleanup after late add (recommended)
B) Rely on `onState` as planned
State: approved
Actual answer: A
Accepted scope: Phase 3, T2.
History: none

### R20: Observation semantics and first-release scope
Finding: Copilot 5 and 12, medium/low, `host.ts:131`
Plan baseline: "already true at call start", `alsoShow`
Runtime evidence: buffered and written values carry no proof of the call time
Question D20: How is the start judged? Recommendation: A.
Header: Wait start
Options:
A) Only rows stamped at/after the call start, "true at the first observation", `alsoShow` deferred (recommended)
B) Keep "already true at call start"
State: approved
Actual answer: A
Accepted scope: Phase 3 design and tests.
History: none

### R21: Write proof per item (revises R9, narrows R10)
Finding: Copilot 1, critical, plan Phase 4 vs `WatchProtocol.cs:13-19`, `AdsLink.cs:126`
Plan baseline: R9 (non-zero per-item code = not written), R10 (rejected sum command = not written)
Runtime evidence: today a failure inside the write call is "unknown"; SDK sum-write semantics unverified in this repo
Question D21: How strong is "not written" per item? Recommendation: A, keeps the write gate's guarantee.
Header: Write proof
Options:
A) SDK contract check first; per item written / notWritten (proven codes only) / unknown, default unknown (recommended)
B) Keep R9: every non-zero code means not written
State: approved
Actual answer: A
Accepted scope: Phase 4 Step 0, result model, input rules, T5.
History: R9's "non-zero code = not written" withdrawn; R10's "no fallback" kept, its "rejected = not written" only after Step 0 proves it.

### R22: Online symbol list off the watch host (revises R15)
Finding: Copilot 8, medium, `AdsLink.cs:71-74`, `TargetCommands.cs:248`
Plan baseline: R15 (watch-host op with filter, cap, 60 s timeout)
Runtime evidence: the host handles requests serially; the upload happens before any filter
Question D22: Where does the online browse run? Recommendation: A, reuses an existing command and cannot stall waits or writes.
Header: Symbol browse
Options:
A) `iecode ads symbols --online` as a separate short-lived process (recommended)
B) Watch-host op as in R15
State: approved
Actual answer: A
Accepted scope: Phase 5a.
History: R15's filter and 500 cap kept.

### R23: Protocol feature matrix (refines R14)
Finding: Copilot 7, medium, Phase 5b `read` reply change
Plan baseline: R14 (accept older hosts, disable missing ops)
Runtime evidence: an older host still has `read` with the scalar shape
Question D23: How are changed replies handled? Recommendation: A, no adapters needed.
Header: Protocol rules
Options:
A) Immutable version table, additive reply changes only, gate features, reset on restart, per-phase compatibility tests (recommended)
B) Reply adapters per version
State: approved
Actual answer: A
Accepted scope: Global Constraint, Phase 5b compatibility, T7.
History: R14 rationale corrected (compatibility is asymmetric).

### R24: Change-log start value and long strings
Finding: Copilot 11, medium, `adswatch.ts` `trim()`
Plan baseline: "first row shows the value at the window start", texts cut to 256
Runtime evidence: trimming by time removes the last change before the window
Question D24: Keep a predecessor per symbol? Recommendation: A.
Header: Window start
Options:
A) One predecessor per symbol, change detection on full text, no downsampling of change rows (recommended)
B) As planned
State: approved
Actual answer: A
Accepted scope: Phase 2 design and tests.
History: none

Copilot findings taken as factual corrections without a choice: 9 (batch input rules, folded into R21), 10 (Phase 8 promise limited to cycle boundaries, `gen` in notify events), 12 (estimates raised, lane conflicts flagged, T0 contract task).

Approval readiness: PASS (R1-R4, R6-R8, R12-R14, R16-R24 approved; R5 superseded by R14; R9/R10/R11/R15 refined by R21/R17/R22; 2026-11-06)

## Outside voice

1. Codex CLI not installed; native fallback (Claude Plan subagent, completed within the 5-minute timer): 13 issues (3 High, 6 Medium, 4 Low), resolved as D9-D15. Same model family, no outside credit.
2. GitHub Copilot CLI, model `gpt-6.1-sol` (requested by the user): 12 issues (1 critical, 10 medium, 1 low), resolved as D16-D24. Cross-model coverage.

## Completion summary

- Step 0: Scope Challenge — scope reduced per recommendation (Phase 6 deferred, 5a diagnosis dropped)
- Reality rows: 7/7 applicable rows emitted (PLAN_REALITY complete), 0 unverified premises
- Architecture Review: 7 issues found
- Code Quality Review: 2 issues found
- Test Review: diagram produced, 20 gaps identified
- Performance Review: 2 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed (no TODOS.md in the repo; the deferred Phase 6 stays in this plan)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex unavailable (not installed); native Claude subagent completed, 13 findings; Copilot CLI `gpt-6.1-sol` completed, 12 findings
- Parallelization: 4 lanes; only the CLI part of lane B and the P8 spike run truly in parallel, extension parts merge one at a time
- Lake Score: 23/23 answers picked the most complete option
- Readiness: the decisions are accepted, not verified guarantees. Phase 3 can start after T0; Phase 4's write-proof semantics depend on its Step 0 SDK check.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native fallback + Copilot CLI (`gpt-6.1-sol`) | Independent 2nd opinion | 2 | completed (Copilot) | 13 + 12 findings, all resolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 31 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex unavailable (CLI not installed); native Claude Plan subagent completed with 13 findings (no outside credit); GitHub Copilot CLI `gpt-6.1-sol` completed with 12 findings (cross-model).
- **CROSS-MODEL:** both outside reviewers flagged the Phase 4 per-item result and the protocol compatibility; Copilot alone found the generation race, the per-instance ownership, the dropped stop reason and that the native subagent's D9 overclaimed write proof. Native Claude and Copilot (`gpt-6.1-sol`) are different model families.
- **VERDICT:** no review CLEAR; all findings are mapped to accepted plan changes and tasks T0-T7 (issues_open = mapped work). eng review required

NO UNRESOLVED DECISIONS
