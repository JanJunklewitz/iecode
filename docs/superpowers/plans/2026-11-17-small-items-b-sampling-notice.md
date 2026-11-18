# Plan B: Notice when sampling had a hole Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [small items master plan](2026-11-17-small-items-master-plan.md). Supersedes task E3 of [Plan E](2026-11-09-ads-wishlist-e-runtime-and-plc.md) together with its amendments (round 1 item 7, round 2 items 12 and 13); where the texts differ, this plan wins.

**Goal:** When the PLC connection was lost, the symbols were reloaded after a download or restart, or sampling stopped, the next `ads_watch`, `ads_read`, `ads_scope` and `ads_wait` result says so in one line, and the ADS Watch view and the ADS Scope show the same line, so a table with a hole is no longer read as a quiet machine.

**Architecture:** The CLI host gets one additive event `reloaded` (protocol entry 2 is still open, so no protocol bump). The extension records host events in a pure `SamplingLog` (`extension/src/core/samplingLog.ts`) with monotonic ids; each tool object keeps a cursor and prefixes the notice of the events it has not shown yet. The views show the newest notice for two minutes.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit).

**Spec:** wishlist section 2, row "Resume watch sampling after a PLC download or restart and show a one-line notice" ([ads-mcp-wishlist.md](../../ads-mcp-wishlist.md)); Plan E task E3 for the background and the hypotheses H1 to H4.

## Global Constraints

- Public repository: generic symbol names only (`MAIN.nCount`). Commits: English subject plus a 1-3 sentence why-body, noreply address, `git commit -s`.
- Decisions in pure `extension/src/core/` modules; `src/ads/` and `src/views/` only wire.
- Results without an event stay byte-identical (pinned by a test per tool text function).
- CLI events are additive; the host loop stays single-threaded (`WatchHost.cs`, "No threads, no clock").
- Tests: `cd extension && npm test`. C#: only through the PowerShell tool, `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~<Name>"`; never chained with `dotnet build`, nothing heavy in parallel. If the running `iecode mcp` locks `IECode.Cli/bin`, build and test the test projects only (they do not reference `IECode.Cli`).

## Decisions (taken by the planner, 2026-11-17)

1. **Notice only, no keep-alive.** Plan E's keep-alive (`iecode.ads.aiKeepAliveSeconds`) is not built: it keeps the whole sampling and its CPU load running and needs the H1 reproduction first. The notice already tells the agent that sampling stopped and how to start it. The reproduction of H1 to H3 moves to the manual check of Task 3 and is recorded; a keep-alive becomes a new TODO item only if H1 reproduces.
2. **Explicit `reloaded` event from the CLI** (amendment round 2 item 12): the `items` event only comes when the items differ, so a download with an unchanged list is invisible to the extension today. `WatchHost.ResolveAgain` gets a reason and emits `{"event":"reloaded","reason":"<text>"}` before it publishes, when the resolve was started by the poll (symbol version changed, dead handles), not by a `watch` request and not by a reconnect (the `state` events already cover that).
3. **No `restarted` kind.** A restart by a settings change is a `stopped` event with the existing reason `The ADS host restarted (settings changed).` followed by `started`; the pair renders as "stopped from .. to ..". One renderer path less.
4. **Cursor is an event id** (amendment round 2 item 13), wall-clock time is for display only. A new tool object starts at the current id (no old notices for a new MCP connection). The log keeps the newest 50 events; when the cursor points before the oldest kept event the notice starts with `(earlier notices dropped)`.
5. **Where the notice goes:** first line of `ads_watch`, `ads_read`, `ads_scope`; last line of `ads_wait` (its verdict stays first). ADS Watch view: `TreeView.message` shows the newest notice for 120 s when the view has no disconnect message. ADS Scope: the existing `note` field shows it under the same rule.
6. **At most three notice lines** per result, newest kept, plus `(N earlier notices not shown)`.

## Prior measurements (another ADS project, simulation targets, October 2026)

Measured with a handle-based poll loop of up to 3000 symbols; they tell which notice each scenario should produce.

| Scenario | Measured behaviour | Expected notice here |
|---|---|---|
| Route cut for about 20 s while polling | Reads fail with `0x7` (target machine not found); the PLC keeps its handles, values come back by themselves without a re-resolve; no SDK connection event fired | `lost ... and restored ...`, no `reloaded` |
| PLC download with a changed symbol list | Reads fail with `0x710`, then `0x745` timeouts for about 30 s, then `0x1D` (secure route coming back); the symbol version (index group `0xF008`) went up by one | `lost ... restored`, then `reloaded` (symbol version changed) |
| PLC restart without download | Stale handles answer `0x711`; exactly one re-resolve; values equal afterwards; recovery 6-16 s after a system restart (20 restarts in 10 h) | `reloaded` (symbol handles no longer valid), usually after `lost/restored` |
| Online change | Not measured (the attempt failed in the XAE). A change that adds a symbol may keep the old handles valid and need no re-resolve | Unknown: record in the manual check |

Two cautions taken over from those runs: a bare TCP connect to the router port 48898 made every concurrent ADS connection on that PC fail with `TlsSendError`, so no part of this plan probes router ports (the `TODO.md` note "the route needs a TCP probe of 8016 / 48898" was a manual observation, not a mechanism to build); and while the target is down, a re-resolve that fails every cycle floods the log unless it is throttled (the host's `ReportOnce` already keeps one line per message).

## Review Focus

1. The first `connected:false` before any `connected:true` (target not reachable at start) is not a "lost" event. (Task 2, `an initial disconnect is not a loss`)
2. A loss that is still open in one call and restored before the next: the first result says "lost at", the second "restored at" without repeating the loss. (Task 2, `a pair split across two calls is shown in two parts`)
3. A download with an unchanged watch list: a `reloaded` event arrives. (Task 1, `Symbol_version_change_with_unchanged_items_emits_reloaded`)
4. A `watch` request that changes the list does not count as a reload. (Task 1, `Watch_op_does_not_emit_reloaded`)
5. A tool call without events: byte-identical result. (Task 2, `withNotice without a notice returns the text unchanged`)

## File Structure

- CLI: `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`WatchReloadedEvent`), `cli/src/IECode.Core/Ads/WatchHost.cs` (`ResolveAgain(string? reason)`), `cli/README.md` ("Live values"); test `cli/tests/IECode.Core.Tests/WatchHostTests.cs`.
- Create `extension/src/core/samplingLog.ts`; test `extension/test/samplingLog.test.ts`.
- Modify `extension/src/core/adswatch.ts` (`HostMessage` gains `reloaded`), `extension/src/core/adsToolText.ts` (`withNotice`, `withTrailingNotice`), `extension/src/ads/host.ts`, `extension/src/ads/adsTools.ts`, `extension/src/views/adsWatch.ts`, `extension/src/views/adsScope.ts`, `extension/CHANGELOG.md`; test `extension/test/adsToolText.test.ts`.

---

### Task 1: `reloaded` event in the CLI host

**Files:**
- Modify: `cli/src/IECode.Core/Ads/WatchProtocol.cs:76-80`, `cli/src/IECode.Core/Ads/WatchHost.cs:95,130,142,188,238`, `cli/README.md:102-117`
- Test: `cli/tests/IECode.Core.Tests/WatchHostTests.cs`

**Interfaces:**
- Produces: `internal sealed record WatchReloadedEvent(string Event, string Reason);` wire `{"event":"reloaded","reason":"symbol version changed"}` or `"reason":"symbol handles no longer valid"`.
- `private void ResolveAgain(string? reason = null)`: call sites at lines 130 and 142 pass `backend.SymbolVersionChanged()`-derived reason (`"symbol version changed"` when the version check triggered, else `"symbol handles no longer valid"`); line 95 (pending retry) passes the reason stored from the failed attempt (`_pendingReason`); line 238 (reconnect) passes null. The event is emitted once per resolve, after `FlushPending()` and before `Publish()`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void Symbol_version_change_with_unchanged_items_emits_reloaded()   // same items after resolve: one {"event":"reloaded","reason":"symbol version changed"}, no items event
[Fact] public void Dead_handle_resolve_emits_reloaded_with_the_handle_reason()   // ReadWatched returns 0x710 for an item, not guarded
[Fact] public void Watch_op_does_not_emit_reloaded()
[Fact] public void Reconnect_resolve_does_not_emit_reloaded()                     // state false then true: only state events
[Fact] public void A_failed_resolve_emits_reloaded_once_when_the_retry_succeeds() // Resolve throws once, next Tick succeeds
```

- [ ] **Step 2: Run to verify they fail (PowerShell tool)**

Run: `dotnet build cli/tests/IECode.Core.Tests` then, as a separate command, `dotnet test cli/tests/IECode.Core.Tests --no-build --filter "FullyQualifiedName~reloaded|FullyQualifiedName~Reconnect_resolve"`
Expected: the new tests fail (no `reloaded` line emitted).

- [ ] **Step 3: Implement** as in Interfaces; `_pendingReason` is set before `backend.Resolve` and cleared after the event is sent.

- [ ] **Step 4: Run to verify they pass**, then the whole `IECode.Core.Tests` project (separate commands). Expected: all pass.

- [ ] **Step 5: README and commit**

Add under the `samples` line of "Live values": ``→ {"event":"reloaded","reason":"symbol version changed"}   the host resolved the symbols again by itself (download, online change, PLC restart); also when the items did not change``.

```bash
git add cli/src/IECode.Core/Ads/WatchProtocol.cs cli/src/IECode.Core/Ads/WatchHost.cs cli/README.md cli/tests/IECode.Core.Tests/WatchHostTests.cs
git commit -s -m "Tell the extension when the watch host reloaded the symbols" -m "The items event only comes when the items differ, so a download with an unchanged list was invisible. An additive event keeps older extensions working; protocol 2 is not released yet, so no version bump."
```

---

### Task 2: Pure sampling log and notice text

**Files:**
- Create: `extension/src/core/samplingLog.ts`
- Modify: `extension/src/core/adswatch.ts:10-15` (`HostMessage` gains `| { event: 'reloaded'; reason: string }`), `extension/src/core/adsToolText.ts`
- Test: `extension/test/samplingLog.test.ts`, `extension/test/adsToolText.test.ts`

**Interfaces:**
- Consumes: `ToolNames` (`adsToolText.ts:16`, uses `watch` and `wait`).
- Produces:
  ```ts
  export type SamplingEvent =
    | { kind: 'lost'; t: number; error: string }
    | { kind: 'restored'; t: number }
    | { kind: 'reloaded'; t: number; reason: string }
    | { kind: 'stopped'; t: number; reason: string }
    | { kind: 'started'; t: number };
  export interface Logged { id: number; e: SamplingEvent }
  export class SamplingLog {
    constructor(cap?: number);                      // default 50
    /** Feeds a host state change; records lost/restored only after a first connected:true. */
    state(connected: boolean, error: string | undefined, t: number): void;
    record(e: SamplingEvent): void;                 // reloaded, stopped, started
    /** Id of the newest event, 0 when none; a new reader starts here. */
    head(): number;
    /** Events with id > cursor, oldest first, and whether older ones were dropped by the cap. */
    since(cursor: number): { events: SamplingEvent[]; dropped: boolean };
    /** Newest event not older than maxAgeMs, for the views. */
    recent(nowMs: number, maxAgeMs: number): SamplingEvent[];
    clear(): void;                                  // target change; ids keep counting
  }
  export function noticeText(events: SamplingEvent[], dropped: boolean, clock: (ms: number) => string, names: ToolNames): string | undefined;
  // adsToolText.ts
  export function withNotice(text: string, notice: string | undefined): string;          // `${notice}\n${text}` or text
  export function withTrailingNotice(text: string, notice: string | undefined): string;  // `${text}\n${notice}` or text
  ```

- [ ] **Step 1: Write the failing tests** (`clock = ms => \`T${ms}\``, `names = MCP_NAMES`)

```ts
test('a lost and restored connection is one line with both times', () => {
  assert.equal(noticeText([{ kind: 'lost', t: 3, error: 'ADS error 0x745' }, { kind: 'restored', t: 9 }], false, clock, names),
    'Notice: the connection to the PLC was lost at T3 and restored at T9; values in between are missing.');
});
test('a connection that is still lost names the error', () => {
  assert.equal(noticeText([{ kind: 'lost', t: 3, error: 'ADS error 0x745' }], false, clock, names),
    'Notice: the connection to the PLC was lost at T3 (ADS error 0x745); sampling resumes when it is back.');
});
test('a pair split across two calls is shown in two parts', () => {
  assert.equal(noticeText([{ kind: 'restored', t: 9 }], false, clock, names), 'Notice: the connection to the PLC was restored at T9.');
});
test('a reload names its reason', () => {
  assert.equal(noticeText([{ kind: 'reloaded', t: 9, reason: 'symbol version changed' }], false, clock, names),
    'Notice: the symbols were reloaded at T9 (symbol version changed: download, online change or PLC restart); values may have been reset.');
});
test('a stop followed by a start is one line about the gap', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'The ADS host stopped (idle).' }, { kind: 'started', t: 900 }], false, clock, names),
    'Notice: sampling was stopped from T10 to T900 (The ADS host stopped (idle).); values in between are missing.');
});
test('a stop without a restart says how to start again', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'The ADS host stopped (idle).' }], false, clock, names),
    'Notice: sampling stopped at T10 (The ADS host stopped (idle).); ads_watch or ads_wait starts it again.');
});
test('Copilot names in the texts', () => { /* COPILOT_NAMES -> 'adsWatch or adsWait starts it again' */ });
test('no events give no notice', () => { assert.equal(noticeText([], false, clock, names), undefined); });
test('more than three notices keep the newest three', () => { /* first line '(2 earlier notices not shown)' */ });
test('dropped events are said first', () => { /* first line '(earlier notices dropped)' */ });
test('an initial disconnect is not a loss', () => {
  const log = new SamplingLog(); log.state(false, 'no route', 1); assert.equal(log.head(), 0);
  log.state(true, undefined, 2); log.state(false, 'ADS error 0x745', 3);
  assert.deepEqual(log.since(0).events, [{ kind: 'lost', t: 3, error: 'ADS error 0x745' }]);
});
test('since() returns only newer events and the cap drops the oldest', () => { /* cap 2, three records, since(0).dropped === true */ });
test('clear() drops the events but ids keep counting', () => { /* head() after clear unchanged, since(head) empty, next record id = head+1 */ });
test('recent() returns events not older than maxAgeMs', () => {});
// adsToolText.test.ts
test('withNotice without a notice returns the text unchanged', () => {
  assert.equal(withNotice('a\nb', undefined), 'a\nb'); assert.equal(withTrailingNotice('a', undefined), 'a');
  assert.equal(withNotice('a', 'N'), 'N\na'); assert.equal(withTrailingNotice('a', 'N'), 'a\nN');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd extension && npm test`
Expected: compile error `Cannot find module '../src/core/samplingLog'`.

- [ ] **Step 3: Implement.** Coalescing walks oldest to newest: `lost` pairs with the next `restored`, `stopped` with the next `started`; a lone `restored` or `started` renders as "restored at" / "sampling started again at Tn"; every rendered line is one notice; keep the newest three.

- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/samplingLog.ts extension/src/core/adswatch.ts extension/src/core/adsToolText.ts extension/test/samplingLog.test.ts extension/test/adsToolText.test.ts
git commit -s -m "Add a log of connection and sampling events" -m "The tools need to tell the agent about holes in the data. A cursor by event id instead of by time keeps two events in the same millisecond apart and lets each client see each event once."
```

---

### Task 3: Record in the host, show in the tools and views

**Files:**
- Modify: `extension/src/ads/host.ts` (`readonly log = new SamplingLog()`; `setState` feeds `log.state`; `handle` case `reloaded` records; `stop()` and `exited()` record `stopped` with their reason; the hello in `start()` records `started`; the target-change branch at line 120 calls `log.clear()`), `extension/src/ads/adsTools.ts` (cursor `let seen = host.log.head()` per `adsTools()` call; `watch`, `read`, `scope` wrap with `withNotice`, `wait` with `withTrailingNotice`; then `seen = host.log.head()`), `extension/src/views/adsWatch.ts:94-97` (`showState`: disconnect message first, else `noticeText(host.log.recent(now, 120_000), ...)`; re-run on `onState`, on a new log event and once 120 s after it), `extension/src/views/adsScope.ts:48` (same rule for `note` when it would be `''`), `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 2 exports; `clock` already used by `adsTools.ts`.
- `AdsHost` adds `readonly onLog: vscode.Event<void>` fired after each recorded event (views refresh on it).

- [ ] **Step 1: Wire as listed.** No unit tests (`vscode` module); the decisions are tested in Task 2.

- [ ] **Step 2: Run the tests.** Run: `cd extension && npm test`. Expected: compiles, all pass.

- [ ] **Step 3: Manual check (about 1 h, simulation target; record in this file under "Findings")**

1. H1 idle stop: add symbols with `ads_watch` through MCP, close the ADS Watch view and the scope, wait 60 s, call `ads_scope`: first line `Notice: sampling stopped at ...; ads_watch or ads_wait starts it again.`
2. H2 restart with the view open: restart TwinCAT; the view shows the loss message, then the notice; the next `ads_watch` starts with `lost at ... and restored at ...`.
3. Download with an unchanged list (if the target allows a download): `ads_read` starts with `the symbols were reloaded`. If the target allows an online change, try one and record whether the symbol version changes and whether a `reloaded` notice comes (not measured anywhere yet).
4. H3: kill the `iecode ads serve` child with the view open; record whether anything restarts it (expected: no; record as a new TODO item if so).
5. A call without events: no notice line.

- [ ] **Step 4: CHANGELOG and commit**

CHANGELOG under `## Unreleased` / `### Claude Code and ADS`: ``- `ads_watch`, `ads_read`, `ads_scope` and `ads_wait` start (wait: end) with a notice when the connection to the PLC was lost and restored, when the symbols were reloaded after a download, online change or PLC restart, or when sampling had stopped. The ADS Watch view and the ADS Scope show the same line for two minutes. The reload notice needs the iecode CLI of this release.``

```bash
git add extension/src/ads/host.ts extension/src/ads/adsTools.ts extension/src/views/adsWatch.ts extension/src/views/adsScope.ts extension/CHANGELOG.md
git commit -s -m "Show sampling notices in the ADS tools and views" -m "An agent read a stalled table as a quiet machine. The host already reconnects after a PLC restart, so the missing piece was telling the reader, not another reconnect mechanism."
```

## Findings

(filled by Task 3 step 3: scenario, what happened, the notice text seen)

## Done when

`npm test` and the `IECode.Core.Tests` green, manual check recorded, wishlist row "Resume watch sampling ..." set to Done with the test names, Plan E task E3 marked "superseded by small items Plan B".
