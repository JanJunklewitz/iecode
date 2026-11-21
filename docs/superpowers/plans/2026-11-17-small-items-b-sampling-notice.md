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
2. **Explicit `reloaded` event from the CLI** (amendment round 2 item 12): the `items` event only comes when the items differ, so a download with an unchanged list is invisible to the extension today. `WatchHost.ResolveAgain` gets a reason and emits `{"event":"reloaded","reason":"<text>"}` before it publishes, when the resolve was started by the poll (symbol version changed, dead handles), not by a `watch` request. **Amended by the eng review 2026-11-18 (R2):** a reconnect resolve emits `reloaded` too when the symbol table changed while the connection was down, because a download usually cuts the connection first (`0x745` timeouts) and `Drop()` clears the version baseline (`AdsWatchBackend.cs` `_watchVersion = null`), so without this the measured download case would show only "lost and restored". Two rules: the backend keeps the version of the last successful resolve across `Drop()` and reports `ResolveChangedVersion` after each `Resolve`; a reason pending from a resolve that failed with a connection loss survives the reconnect and is emitted by the reconnect resolve. A reconnect with an unchanged symbol version still emits nothing (the `state` events cover it).
3. **No `restarted` kind.** A restart by a settings change is a `stopped` event with the existing reason `The ADS host restarted (settings changed).` followed by `started`; the pair renders as "stopped from .. to ..". One renderer path less.
4. **Cursor is an event id** (amendment round 2 item 13), wall-clock time is for display only. A new tool object starts at the current id (no old notices for a new MCP connection). The log keeps the newest 50 events; when the cursor points before the oldest kept event the notice starts with `(earlier notices dropped)`.
5. **Where the notice goes:** first line of `ads_watch`, `ads_read`, `ads_scope`; last line of `ads_wait` (its verdict stays first). ADS Watch view: `TreeView.message` shows the newest notice for 120 s when the view has no disconnect message. ADS Scope: the existing `note` field shows it under the same rule.
6. **At most three notice lines** per result, newest kept, plus `(N earlier notices not shown)`.
7. **Only the host's own `state` events feed the loss tracking** (eng review 2026-11-18, R3). `AdsHost.setState` is also called by `stop()`, `exited()` and a failed start (`host.ts` `stop`: `this.setState({ connected: false })`); feeding those would turn every idle stop into a "lost" line next to the "stopped" line. So `SamplingLog.state` is called from `handle()` case `state` only. A `started` event resets the connection baseline, so the first `connected:true` of a new host process is not a "restored". A `started` is recorded only after a `stopped` (since the last `clear()`); the first start of the session is no notice.
8. **The loss text points at `ads_state`** once Plan C is in: a PLC restart while the connection was down keeps the symbol version, so only the cycle counter shows it. Plan C Task 2 appends `; ads_state compares the PLC cycle counter with its previous call to tell a restart` to the "lost ... and restored" line (MCP and Copilot names) and updates its pinned test. The wording does not promise a verdict: without an earlier `ads_state` call there is no counter to compare with (outside voice, R19), and `ads_state` says so.
9. **The notice cursor is a tested adapter** (R15, outside voice): `NoticeReader.take()` reads and advances in one synchronous step; `adsTools.ts` only calls it per result, also for error results (their `isError` flag is kept). The tool wiring then holds no decision of its own.
10. **A hole in the history is warned about whenever the history is shown** (R16, outside voice). The once-per-reader notice is consumed by the first result; a later `ads_scope` over a window that contains the hole would look like a quiet machine again, and a new MCP session never sees the notice. So `ads_scope` adds `gapWarning(gapsIn(log events, from, to))` for its window on every call, from the same log (cap 50 events; the buffer default is 300 s). Breaking the plotted line of the ADS Scope at the holes is not part of this plan (webview drawing code without tests); it is a `TODO.md` item.
11. **Target change order** (R17, outside voice): `host.ts` clears the log after the old process was stopped, not before (the target-change branch calls `restart()`, whose `stop()` would record a `stopped` into the just-cleared log and the new process's `started` would pair with it into a "gap" that spans two targets). With the clear after `restart()`, the new process's `started` has no `stopped` before it and is no notice.
12. **The paused ADS Scope still shows the notice** (R18, outside voice): `adsScope.ts` does not post while paused (`schedule` checks `view.paused`, line 60) and the webview ignores data while paused. The notice goes in a separate status message (`{ type: 'note', note }`) that the webview applies in every state; pause freezes the plot only.

## Prior measurements (another ADS project, simulation targets, October 2026)

Measured with a handle-based poll loop of up to 3000 symbols; they tell which notice each scenario should produce.

| Scenario | Measured behaviour | Expected notice here |
|---|---|---|
| Route cut for about 20 s while polling | Reads fail with `0x7` (target machine not found); the PLC keeps its handles, values come back by themselves without a re-resolve; no SDK connection event fired | `lost ... and restored ...`, no `reloaded` |
| PLC download with a changed symbol list | Reads fail with `0x710`, then `0x745` timeouts for about 30 s, then `0x1D` (secure route coming back); the symbol version (index group `0xF008`) went up by one | `lost ... restored`, then `reloaded` (symbol version changed), emitted by the reconnect resolve (Decision 2 as amended) |
| PLC restart without download | Stale handles answer `0x711`; exactly one re-resolve; values equal afterwards; recovery 6-16 s after a system restart (20 restarts in 10 h) | `reloaded` (symbol handles no longer valid) when the `0x711` came before the loss, usually after `lost/restored`; a restart entirely inside a loss gives only `lost/restored` (the version is unchanged), and the line points at `ads_state` (Decision 8) |
| Online change | Not measured (the attempt failed in the XAE). A change that adds a symbol may keep the old handles valid and need no re-resolve | Unknown: record in the manual check |

Two cautions taken over from those runs: a bare TCP connect to the router port 48898 made every concurrent ADS connection on that PC fail with `TlsSendError`, so no part of this plan probes router ports (the `TODO.md` note "the route needs a TCP probe of 8016 / 48898" was a manual observation, not a mechanism to build); and while the target is down, a re-resolve that fails every cycle floods the log unless it is throttled (the host's `ReportOnce` already keeps one line per message).

## Review Focus

1. The first `connected:false` before any `connected:true` (target not reachable at start) is not a "lost" event. (Task 2, `an initial disconnect is not a loss`)
2. A loss that is still open in one call and restored before the next: the first result says "lost at", the second "restored at" without repeating the loss. (Task 2, `a pair split across two calls is shown in two parts`)
3. A download with an unchanged watch list: a `reloaded` event arrives. (Task 1, `Symbol_version_change_with_unchanged_items_emits_reloaded`)
4. A `watch` request that changes the list does not count as a reload, unless its resolve is the first one after a download. (Task 1, `Watch_op_does_not_emit_reloaded`, `Watch_op_as_the_first_resolve_after_a_download_emits_reloaded`)
5. A tool call without events: byte-identical result. (Task 2, `withNotice without a notice returns the text unchanged`)
6. A download while the connection is down: the reconnect resolve emits `reloaded`. (Task 1, `Reconnect_after_a_symbol_version_change_emits_reloaded`)
7. An idle stop gives one "stopped" line, not also a "lost" line; the first connect of the restarted host is not a "restored". (Task 2, `a stop is not a loss and a new host's first connect is not a restore`)
8. Dead handles and a changed version in the same poll: the reason stays "symbol handles no longer valid" and `SymbolVersionChanged()` is not called once more (it sets `_stale`). (Task 1, `Dead_handles_with_a_changed_version_keep_the_handle_reason`)
9. Two overlapping tool calls never show the same notice twice. (Task 2, `NoticeReader shows each event once, also to overlapping calls`)
10. A later `ads_scope` over a window with a hole warns again, after the notice was consumed. (Task 2, `gapsIn ...`, `gapWarning names the holes`)

## File Structure

- CLI: `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`WatchReloadedEvent`, `IWatchBackend.ResolveChangedVersion`), `cli/src/IECode.Core/Ads/WatchHost.cs` (`ResolveAgain(string? reason)`), `cli/src/IECode.Automation/AdsWatchBackend.cs` (version kept across `Drop()`), `cli/README.md` ("Live values"); tests `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`.
- Create `extension/src/core/samplingLog.ts`; test `extension/test/samplingLog.test.ts`.
- Modify `extension/src/core/adswatch.ts` (`HostMessage` gains `reloaded`), `extension/src/core/adsToolText.ts` (`withNotice`, `withTrailingNotice`), `extension/src/ads/host.ts`, `extension/src/ads/adsTools.ts`, `extension/src/views/adsWatch.ts`, `extension/src/views/adsScope.ts`, `extension/CHANGELOG.md`; test `extension/test/adsToolText.test.ts`.

---

### Task 1: `reloaded` event in the CLI host

**Files:**
- Modify: `cli/src/IECode.Core/Ads/WatchProtocol.cs:76-80`, `cli/src/IECode.Core/Ads/WatchHost.cs:95,130,142,188,238`, `cli/README.md:102-117`
- Test: `cli/tests/IECode.Core.Tests/WatchHostTests.cs`

**Interfaces:**
- Produces: `internal sealed record WatchReloadedEvent(string Event, string Reason);` wire `{"event":"reloaded","reason":"symbol version changed"}` or `"reason":"symbol handles no longer valid"`.
- `private void ResolveAgain(string? reason = null)`: line 130 (sum read failed with a dead handle) passes `"symbol handles no longer valid"`. Line 139 keeps its evaluation order: split it into `if (dead.Count > 0 && !guarded) reason = handles; else if (backend.SymbolVersionChanged()) reason = version;` so `SymbolVersionChanged()` (which sets `_stale`) is called exactly when it is called today. Line 95 (pending retry) and line 238 (reconnect) pass `_pendingReason`, the reason of the last resolve that did not finish; a successful resolve clears it.
- After every successful `backend.Resolve` (in `ResolveAgain` and in `DoWatch`, which calls `backend.Resolve` itself at line 281), the event reason is `_pendingReason ?? (backend.ResolveChangedVersion ? "symbol version changed" : null)`; non-null emits one `reloaded` (in `ResolveAgain` after `FlushPending()` and before `Publish()`; in `DoWatch` before its reply) and clears `_pendingReason`. So a `watch` request that only changes the list emits nothing, but one that happens to be the first resolve after a download still reports the download (otherwise the next poll would see the new version as the baseline and the download would never be reported).
- `IWatchBackend`: `bool ResolveChangedVersion => false;` (default member, fakes keep compiling; `FakeBackend` gets a settable value). `AdsWatchBackend`: a field `_lastResolvedVersion` that `Drop()` does not clear; `Resolve` sets `ResolveChangedVersion = _lastResolvedVersion is { } old && version is { } v && old != v` and then stores `version`. An unreadable version (`null`) never reports a change.

- [ ] **Step 1: Write the failing tests**

```csharp
[Fact] public void Symbol_version_change_with_unchanged_items_emits_reloaded()   // same items after resolve: one {"event":"reloaded","reason":"symbol version changed"}, no items event
[Fact] public void Dead_handle_resolve_emits_reloaded_with_the_handle_reason()   // ReadWatched returns 0x710 for an item, not guarded
[Fact] public void Watch_op_does_not_emit_reloaded()                                // version unchanged, nothing pending
[Fact] public void Watch_op_as_the_first_resolve_after_a_download_emits_reloaded() // backend.ResolveChangedVersion = true on the watch resolve
[Fact] public void Reconnect_resolve_does_not_emit_reloaded()                     // state false then true: only state events
[Fact] public void A_failed_resolve_emits_reloaded_once_when_the_retry_succeeds() // Resolve throws once, next Tick succeeds
[Fact] public void Reconnect_after_a_symbol_version_change_emits_reloaded()      // state false, backend.ResolveChangedVersion = true on the reconnect resolve: one reloaded "symbol version changed"
[Fact] public void A_dead_handle_reason_survives_a_connection_loss()              // dead handle -> Resolve throws connectionLost -> reconnect resolve succeeds: one reloaded "symbol handles no longer valid"
[Fact] public void Dead_handles_with_a_changed_version_keep_the_handle_reason()    // FakeBackend counts SymbolVersionChanged calls: same count as before the change
// AdsWatchBackendTests.cs
[Fact] public void Resolve_reports_a_version_change_across_a_reconnect()         // Resolve at version 3, Connect (Drop), Resolve at 4: ResolveChangedVersion true; again at 4: false
[Fact] public void Resolve_with_an_unreadable_version_reports_no_change()
```

- [ ] **Step 2: Run to verify they fail (PowerShell tool)**

Run: `dotnet build cli/tests/IECode.Core.Tests` then, as a separate command, `dotnet test cli/tests/IECode.Core.Tests --no-build --filter "FullyQualifiedName~reloaded|FullyQualifiedName~Reconnect|FullyQualifiedName~reason"`; then the same two steps for `cli/tests/IECode.Automation.Tests` with `--filter "FullyQualifiedName~Resolve_"`
Expected: the new tests fail (no `reloaded` line emitted).

- [ ] **Step 3: Implement** as in Interfaces; `_pendingReason` is set before `backend.Resolve` and cleared after the event is sent.

- [ ] **Step 4: Run to verify they pass**, then the whole `IECode.Core.Tests` project (separate commands). Expected: all pass.

- [ ] **Step 5: README and commit**

Add under the `samples` line of "Live values": ``→ {"event":"reloaded","reason":"symbol version changed"}   the host resolved the symbols again by itself (download, online change, PLC restart); also when the items did not change``.

```bash
git add cli/src/IECode.Core/Ads/WatchProtocol.cs cli/src/IECode.Core/Ads/WatchHost.cs cli/src/IECode.Automation/AdsWatchBackend.cs cli/README.md cli/tests/IECode.Core.Tests/WatchHostTests.cs cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs
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
    /** Feeds a `state` event of the host process; records lost/restored only after a first connected:true of this process. */
    state(connected: boolean, error: string | undefined, t: number): void;
    /** reloaded and stopped are always kept; started only after a stopped (since the last clear) and it resets the connection baseline. */
    record(e: SamplingEvent): void;
    /** Id of the newest event, 0 when none; a new reader starts here. */
    head(): number;
    /** Events with id > cursor, oldest first, and whether older ones were dropped by the cap. */
    since(cursor: number): { events: SamplingEvent[]; dropped: boolean };
    /** Newest event not older than maxAgeMs, for the views. */
    recent(nowMs: number, maxAgeMs: number): SamplingEvent[];
    clear(): void;                                  // target change; ids keep counting
  }
  export function noticeText(events: SamplingEvent[], dropped: boolean, clock: (ms: number) => string, names: ToolNames): string | undefined;
  /**
   * One per tools object (MCP session or Copilot). take() reads the events since its cursor and moves the cursor in the
   * same synchronous step, so two overlapping calls never show the same notice twice and none is lost (R15).
   */
  export class NoticeReader {
    constructor(log: SamplingLog, clock: (ms: number) => string, names: ToolNames);   // cursor starts at log.head()
    take(): string | undefined;
  }
  /** Intervals without samples inside [fromMs, toMs]: lost..restored and stopped..started pairs, an open one ends at toMs. */
  export function gapsIn(events: SamplingEvent[], fromMs: number, toMs: number): { from: number; to: number; why: 'lost' | 'stopped' }[];
  /** One line for ads_scope when its window contains a gap, independent of any cursor (R16); undefined without gaps. */
  export function gapWarning(gaps: ReturnType<typeof gapsIn>, clock: (ms: number) => string): string | undefined;
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
test('a stop is not a loss and a new host\'s first connect is not a restore', () => {
  const log = new SamplingLog(); log.state(true, undefined, 1);
  log.record({ kind: 'stopped', t: 2, reason: 'The ADS host stopped (idle).' });   // host.ts calls setState(false) here too, but that never reaches the log
  log.record({ kind: 'started', t: 3 }); log.state(true, undefined, 4);
  assert.deepEqual(log.since(0).events, [{ kind: 'stopped', t: 2, reason: 'The ADS host stopped (idle).' }, { kind: 'started', t: 3 }]);
});
test('the first start of the session is no notice', () => {
  const log = new SamplingLog(); log.record({ kind: 'started', t: 1 }); assert.equal(log.head(), 0);
});
test('since() returns only newer events and the cap drops the oldest', () => { /* cap 2, three records, since(0).dropped === true */ });
test('clear() drops the events but ids keep counting', () => { /* head() after clear unchanged, since(head) empty, next record id = head+1 */ });
test('recent() returns events not older than maxAgeMs', () => {});
test('NoticeReader shows each event once, also to overlapping calls', () => {
  const log = new SamplingLog(); log.state(true, undefined, 1);
  const r = new NoticeReader(log, clock, names);
  assert.equal(r.take(), undefined);                       // nothing since the reader was made
  log.state(false, 'ADS error 0x745', 3);
  const a = r.take(), b = r.take();                         // two calls finishing back to back
  assert.match(a!, /lost at T3/); assert.equal(b, undefined);
});
test('a new NoticeReader starts at the head', () => { /* events before its creation are never shown */ });
test('gapsIn finds the pairs inside the window and closes an open one at the end', () => {
  const ev: SamplingEvent[] = [{ kind: 'lost', t: 10, error: 'x' }, { kind: 'restored', t: 20 }, { kind: 'stopped', t: 50, reason: 'idle' }];
  assert.deepEqual(gapsIn(ev, 0, 100), [{ from: 10, to: 20, why: 'lost' }, { from: 50, to: 100, why: 'stopped' }]);
  assert.deepEqual(gapsIn(ev, 25, 40), []);
  assert.deepEqual(gapsIn(ev, 15, 100), [{ from: 15, to: 20, why: 'lost' }, { from: 50, to: 100, why: 'stopped' }]);
});
test('gapWarning names the holes', () => {
  assert.equal(gapWarning([{ from: 10, to: 20, why: 'lost' }], clock),
    'Warning: no samples from T10 to T20 (connection lost); the values do not show what happened in between.');
  assert.equal(gapWarning([], clock), undefined);
});
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
- Modify: `extension/src/ads/host.ts` (`readonly log = new SamplingLog()`; `handle` case `state` feeds `log.state` (not `setState`, which `stop()`, `exited()` and a failed start also call; Decision 7); `handle` case `reloaded` records; `stop()` and `exited()` record `stopped` with their reason; the hello in `start()` records `started`; the target-change branch calls `log.clear()` after its `restart()` / `ensure()` call, not before (Decision 11)), `extension/src/ads/adsTools.ts` (one `new NoticeReader(host.log, clock, names)` per `adsTools()` call; `watch`, `read`, `scope` wrap their result with `withNotice(text, reader.take())`, `wait` with `withTrailingNotice`, error results too, keeping `isError` (Decision 9); `scope` also puts `gapWarning(gapsIn(...))` for its window first (Decision 10)), `extension/src/views/adsWatch.ts:94-97` (`showState`: disconnect message first, else `noticeText(host.log.recent(now, 120_000), ...)`; re-run on `onState`, on a new log event and once 120 s after it), `extension/src/views/adsScope.ts` (the notice under the same rule as a separate `{ type: 'note', note }` message that the webview applies also while paused (Decision 12); the webview script gets the matching handler), `extension/CHANGELOG.md`, `TODO.md` (new item: break the ADS Scope plot at sampling holes, Decision 10)

**Interfaces:**
- Consumes: Task 2 exports; `clock` already used by `adsTools.ts`.
- `AdsHost` adds `readonly onLog: vscode.Event<void>` fired after each recorded event (views refresh on it).

- [ ] **Step 1: Wire as listed.** The decisions, including the cursor (`NoticeReader`) and the gap warning, are tested in Task 2; the wiring left here has no branch of its own.

- [ ] **Step 2: Run the tests.** Run: `cd extension && npm test`. Expected: compiles, all pass.

- [ ] **Step 3: Manual check (about 1 h, simulation target; record in this file under "Findings")**. Run it in the same session as Plan C's checks and the `TODO.md` priority 1 live check (master plan, "Simulation session").

1. H1 idle stop: add symbols with `ads_watch` through MCP, close the ADS Watch view and the scope, wait 60 s, call `ads_scope`: first line `Notice: sampling stopped at ...; ads_watch or ads_wait starts it again.`
2. H2 restart with the view open: restart TwinCAT; the view shows the loss message, then the notice; the next `ads_watch` starts with `lost at ... and restored at ...`.
3. Download with an unchanged list (if the target allows a download): `ads_read` starts with `the symbols were reloaded`. If the target allows an online change, try one and record whether the symbol version changes and whether a `reloaded` notice comes (not measured anywhere yet).
4. H3: kill the `iecode ads serve` child with the view open; record whether anything restarts it (expected: no; record as a new TODO item if so).
5. A call without events: no notice line.
6. Cut the route (or stop the target's network) for about 20 s, run a download in that time if the target allows it, then restore: the next `ads_read` shows `lost ... and restored ...` and, after the download, `the symbols were reloaded ... (symbol version changed ...)` (Decision 2 as amended).
7. Let the view stop by idle and open it again: one "stopped ... to ..." line, no "lost" or "restored" line (Decision 7).
8. Pause the ADS Scope, cut the connection: the notice line appears in the paused scope (Decision 12). Switch `iecode.ads.target` while sampling: no "stopped ... to ..." line spanning both targets (Decision 11). After the notice was shown once, call `ads_scope` again with a window over the hole: the `Warning: no samples from ...` line is there (Decision 10).

- [ ] **Step 4: CHANGELOG and commit**

CHANGELOG under `## Unreleased` / `### Claude Code and ADS`: ``- `ads_watch`, `ads_read`, `ads_scope` and `ads_wait` start (wait: end) with a notice when the connection to the PLC was lost and restored, when the symbols were reloaded after a download, online change or PLC restart, or when sampling had stopped. `ads_scope` also warns on every call when its time window contains such a hole. The ADS Watch view and the ADS Scope show the notice for two minutes, also while the scope is paused. The reload notice needs the iecode CLI of this release.``

```bash
git add extension/src/ads/host.ts extension/src/ads/adsTools.ts extension/src/views/adsWatch.ts extension/src/views/adsScope.ts extension/CHANGELOG.md TODO.md
git commit -s -m "Show sampling notices in the ADS tools and views" -m "An agent read a stalled table as a quiet machine. The host already reconnects after a PLC restart, so the missing piece was telling the reader, not another reconnect mechanism."
```

## Findings

(filled by Task 3 step 3: scenario, what happened, the notice text seen)

## Done when

`npm test` and the `IECode.Core.Tests` green, manual check recorded, wishlist row "Resume watch sampling ..." set to Done with the test names, Plan E task E3 marked "superseded by small items Plan B".
