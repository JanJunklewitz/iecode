# Plan E: Runtime Control, PLC State, Capture and Alarms

> **For agentic workers:** rough sub-plan of the [master plan](2026-11-09-ads-wishlist-master-plan.md). Expand each task into TDD steps with superpowers:writing-plans before building it. E2 to E4 need C0; E5 needs plan A3 and the finished `ads_wait`, but no CLI change.

**Goal:** An agent can tune sampling without touching a panel, notices a PLC restart, reads the PLC state, captures the window around an event, gets a one-call overview of a state machine, and (if the spikes say go) reads active alarms and PLC-cycle timestamps.

**Architecture:** E1 and E8 are extension only. E2 to E5 add watch-host features behind the protocol table of C0. E6 and E7 are spikes with a go/no-go note before any design.

**Tech Stack:** TypeScript, C# .NET, `Beckhoff.TwinCAT.Ads`.

**Spec:** [wishlist sections 2, 4 and 7](../../ads-mcp-wishlist.md), roadmap Phases 8 and 9.

## Global Constraints

See the master plan. In addition:

- The host loop stays single-threaded ("no threads, no clock", `WatchHost.cs`); anything that arrives on an ADS thread goes through a thread-safe queue that `Tick` drains.
- Timestamps promise task-cycle boundaries for one task only (user decision); no promise about the order inside one cycle or across tasks.
- A change to memory use (buffer length) asks for a confirmation above a threshold.

## Review Focus

1. Buffer raised to 10 minutes with 200 symbols: confirmation shown, memory estimate named.
2. PLC download during a capture: the capture ends with the reason and returns what it has.
3. A per-symbol slow rate (500 ms) next to a 10 ms symbol: rows of the fast symbol are not delayed, the slow cell repeats its last value and is marked as repeated.
4. A preset path that does not exist: the missing members are named, the others are still read.
5. Notification mode with a reconnect: queued events of the old connection are dropped, not mixed into the new one.

## File Structure

- `extension/src/core/adswatch.ts`, `adsToolText.ts`, `toolInput.ts`, `extension/src/ads/adsTools.ts`, `host.ts`, `package.json`: config tool, notices, capture, presets.
- `extension/src/core/presets.ts` (new): preset parsing and expansion.
- `extension/src/core/captureRun.ts` (new): capture built on the wait run.
- `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`: `state` op, per-item rate.
- Tests: `presets.test.ts`, `captureRun.test.ts`, `adswatch.test.ts`, `AdsWatchBackendTests`.

## Tasks

### E1: Poll interval and buffer length through MCP (extension only)

**Interfaces:** new tool `ads_config { pollMs?: number, bufferSeconds?: number }`; no arguments returns the current values and the memory estimate; setting values uses the host `interval` op and `ScopeBuffer.setSeconds`; confirmation dialog when the estimate exceeds a threshold. It changes the effective values for the session, not the user's settings.

### E2: Per-symbol sample rate (needs C0)

**Interfaces:** watch item option `everyMs?: number`; host reads slow items only when due and repeats their last value in between; rows mark repeated cells; the extension sends it through `ads_watch add` (`{ symbol, everyMs }`). Spike first (about 2 h): does the sum read cost drop enough to justify the complexity? If not, the task ends with a note.

### E3: Resume after a PLC restart and a visible notice

First reproduce the observed stale watch (974 s without samples) against a simulation target and record the cause. Then: the host's `onEnded` reasons and reconnects produce one notice line `PLC restarted / symbols reloaded at <time>` at the start of the next watch, scope and wait result, and sampling resumes without user action.

### E4: PLC state tool (needs C0)

**Interfaces:** host op `state` → `{ adsState, deviceState, taskCycleTimeUs?, taskCycleCount? }`; tool `ads_state {}`; the result flags a restart when the cycle count went down since the last call.

### E5: Capture around a condition (needs plan A3 and `ads_wait`, no CLI change)

**Interfaces:** `ads_capture { symbol, condition, preSeconds, postSeconds, timeoutSeconds? }` built on `runWait`: when the condition is met, waits `postSeconds`, then returns the change-only table (A3) for `[t − pre, t + post]` of the watched symbols; on timeout returns the last window and says so. Needs the buffer to be at least `preSeconds` long (E1 can raise it).

### E6: Alarms spike, then tool

Spike (half a day): read active alarms through the TcEventLogger proxy against a remote target; licence and redistribution terms; text language. Go/no-go note in this file. On go: tool `ads_alarms { sinceSeconds? }` and host op `alarms`. On no-go: the wishlist row says why.

### E7: PLC-cycle timestamps spike, then notify mode

Spike (half a day, one task only): ADS notifications with cycle time 0, timestamp resolution, identical stamps for two symbols of one task, cost of 50-200 notifications, hand-off to the `Tick` loop, behavior on download. Decide how notify events feed the numeric series and the change log (one clock per buffer). Go/no-go note in this file. On go: opt-in `mode: "notify"`, change events `{ gen, t, i, v }`, the table gets a `cycle` column.

### E8: Presets for state-machine overviews (extension only)

**Interfaces:** setting `iecode.ads.presets` (map name → list of member suffixes, e.g. a project's step, step text, error text, busy members); tool `ads_preset { path, preset }` reads `path.<suffix>` for each suffix in one go and prints one block; also usable for a component mode. No library naming is built in.

### E9: Release

CHANGELOG entries; wishlist rows to Done; manual check of each tool against a simulation target, including a PLC restart during a capture.

## Order

E1 → E8 first (extension only). Then E3 → E4 → E5, E2 after its spike. E6 and E7 last, each only after its go.
