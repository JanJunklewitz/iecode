# Plan E: Runtime Control, PLC State, Capture and Alarms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [master plan](2026-11-09-ads-wishlist-master-plan.md). E2 to E4 need Plan C's task C0; E5 needs Plan A's task A3 and the finished `ads_wait`, but no CLI change.

**Goal:** An agent can tune sampling without touching a panel, is told when the PLC connection or sampling was interrupted, reads the PLC state, captures the window around an event, gets a one-call overview of a state machine, and (if the spikes say go) reads active alarms and PLC-cycle timestamps.

**Architecture:** E1, E5 and E8 are extension only, with every decision in a pure `extension/src/core/` module and `src/ads/` only wiring. E2 to E4 add watch-host features behind the protocol version table of C0 (`host.supports(feature)`), so an older CLI only loses those features. E2, E3, E6 and E7 start with a spike or a reproduction that ends in a recorded go/no-go; the TDD steps after the spike are conditional on its outcome.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads` 7.0.389.

**Spec:** [wishlist sections 2, 4 and 7](../../ads-mcp-wishlist.md); roadmap [Phases 3, 8 and 9](2026-11-06-ads-mcp-wishlist.md) with decisions D4, D11, D17-D20 and D23; finished pattern [ads_wait](2026-11-06-ads-wait.md).

## Global Constraints

- Public repository: no internal project, module, machine or symbol names, no real data in code, tests, docs, spike notes or commits; examples use generic names (`MAIN.nStep`, `GVL.bRun`, `MAIN.fbSeq`). Commits: GitHub noreply address as author and `Signed-off-by`, `git commit -s`, English subject plus a 1-3 sentence why-body (the problem, the decision, the rejected alternative).
- Every tool is declared once in `extension/package.json` (`languageModelTools`, name `iecode_ads_<x>`, `toolReferenceName` `ads<X>`) and served by both `buildMcpTools` (`mcpTools.ts`) and `lmTools.ts`; the manifest parity test (`mcpTools.test.ts`, "the manifest declares the six tools in client-neutral words") lists the tool names in manifest order and must stay green. New tools are appended after the tools of Plans A-D already merged; update that one `deepEqual` list in the task that adds the tool. Descriptions must not name a Copilot tool (extend the regex in that test with the new names).
- New parameters are optional; results of existing calls stay byte-identical except where a task says otherwise (E3 adds a notice line only when an event happened).
- Decisions live in pure `core/` modules (the node tests cannot load `vscode`). Code in `src/ads/` only wires and is checked by compiling plus the manual check of the release task.
- The host loop stays single-threaded ("No threads, no clock", `WatchHost.cs`); anything that arrives on an ADS thread goes through a thread-safe queue that `Tick` drains (only E7).
- Timestamps promise task-cycle boundaries for one task only (user decision); no promise about the order inside one cycle or across tasks (`TODO.md` item).
- A change to memory use (buffer length) asks for a confirmation above a threshold (E1).
- CLI protocol: the first CLI task of the release train bumps `WatchHost.Protocol` and adds the immutable `PROTOCOL_TABLE` entry (C0); later tasks of the same unreleased train add their feature to that entry. Features used here: `state` (E4) and `watchRate` (E2) in the T2 entry, `alarms` (E6) and `notify` (E7) in the T3 entry. Replies change additively only. A missing feature gives the text from `featureMissingText` (E4 defines it unless C0 already exports an equivalent: then use that one).
- Tests: `cd extension && npm test` (runs `tsc -p .` then `node --test out/test/*.test.js`); one file: `cd extension && npm run compile` then `node --test out/test/<name>.test.js`. C# tests only through the PowerShell tool: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~<Name>"`; never chain `dotnet build` and `dotnet test` in one command and start nothing heavy next to it (memory crash 2026-08-27).
- Spike notes go into this file under the task's "Findings" heading, with no internal names. Spike code is throwaway and stays out of the repo (no dependency is added before a go).

## Review Focus

Lines that no single task's own tests would cover; the owning task carries the test.

1. Buffer raised to 10 minutes with 200 symbols: a confirmation is shown and names the memory estimate; lowering never asks. (E1, `planConfig confirms ...`)
2. The user changes the setting after an `ads_config` override: the setting wins again, no stale override. (E1, `sampling override ends when the setting changes`)
3. PLC connection lost during a capture: the capture ends with the reason and returns the table it has, never hangs past `postSeconds` plus the grace time. (E5, `connection loss during the post window ends partial`)
4. A trigger symbol removed from the watch list by the user after the trigger: the table is still rendered because the capture holds its symbols until it is built. (E5, `holds are released only after the table was built`)
5. A per-symbol slow rate (500 ms) next to a 10 ms symbol: rows of the fast symbol are not delayed, the slow cell is marked as repeated and never counts as a new observation in `ads_wait` or the scope series. (E2)
6. A preset path that does not exist: the missing members are named, the others are still read; a preset with a bad name or suffix is reported, not silently dropped. (E8)
7. Notify mode with a reconnect: queued events of the old connection are dropped, not mixed into the new one. (E7)
8. A host started by an older CLI: `ads_state` and per-symbol rates answer with the "needs a newer iecode CLI" text; every older tool keeps working. (E2, E4)

## File Structure

- Create `extension/src/core/adsConfig.ts`: buffer estimate, config plan, config run (E1).
- Create `extension/src/core/presets.ts`: preset parsing, expansion, result text (E8).
- Create `extension/src/core/samplingLog.ts`: connection and sampling events, notice text, keep-alive delay (E3).
- Create `extension/src/core/plcState.ts`: state reply parsing, restart tracker (E4).
- Create `extension/src/core/captureRun.ts`: capture built on `runWait` (E5).
- Modify `extension/src/core/adswatch.ts` (`SCOPE_MAX_VALUES`, `Row.r`, `WatchEntry.everyMs`), `adsToolText.ts` (`ToolNames.config`, texts), `toolInput.ts` (parsers), `mcpTools.ts` (`AdsToolFns`), `watchList.ts` (rates, E2).
- Modify `extension/src/ads/host.ts` (session sampling, sampling log, state op, rate request), `adsTools.ts`, `lmTools.ts`, `extension/package.json` (tools, setting `iecode.ads.presets`), `extension/CHANGELOG.md`, `cli/README.md` ("Live values").
- CLI: `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`, `AdsLink.cs`; `cli/src/IECode.Cli/Commands/TargetCommands.cs` (`UnavailableBackend` must implement every new `IWatchBackend` member).
- Tests: `extension/test/adsConfig.test.ts`, `presets.test.ts`, `samplingLog.test.ts`, `plcState.test.ts`, `captureRun.test.ts` (new); `adswatch.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`, `mcpTools.test.ts`, `watchList.test.ts`; `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs` and `FakeLink.cs`.

## Order

E1 -> E8 (extension only, first release train). Then E3 -> E4 -> E5 (E5 needs A3 merged), then E2 after its spike (C0 needed for E2-E4). E6 and E7 last, each only after its go. E9 closes the plan. E3 and E4 both read host state events but touch different files except `host.ts` and `adsTools.ts`: build them one after the other.

---

### Task E1: `ads_config`: poll interval and buffer length through MCP (extension only)

**Files:**
- Create: `extension/src/core/adsConfig.ts`
- Modify: `extension/src/core/adswatch.ts` (export `SCOPE_MAX_VALUES = 2_000_000`, used as the default of `ScopeBuffer`'s `maxValues` at line 73)
- Modify: `extension/src/core/toolInput.ts` (`parseConfigInput`), `extension/src/core/adsToolText.ts` (`ToolNames.config`, `configText`), `extension/src/core/mcpTools.ts` (`AdsToolFns.config`, registration)
- Modify: `extension/src/ads/host.ts` (session override in `sampling()`, `applySampling`), `extension/src/ads/adsTools.ts` (`config`), `extension/src/ads/lmTools.ts`, `extension/package.json` (`iecode_ads_config`), `extension/CHANGELOG.md`
- Test: `extension/test/adsConfig.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Consumes: `clampInterval`, `clampBufferSeconds` (`adswatch.ts:339,341`), `ScopeBuffer.setSeconds`, `AdsHost.setInterval`, `AdsHost.sampling()` (`host.ts:120`, today read from the settings only), `ToolText`.
- Produces:
  ```ts
  // adswatch.ts
  export const SCOPE_MAX_VALUES = 2_000_000;
  // adsConfig.ts
  export interface Sampling { intervalMs: number; bufferSeconds: number }
  export interface BufferEstimate { symbols: number; values: number; bytes: number; effectiveSeconds: number; capped: boolean }
  export const CONFIG_CONFIRM_VALUES = 1_000_000;   // ask above this many stored values, and only when the change raises memory use
  export const BYTES_PER_VALUE = 64;                // replaced by the measurement of step 1
  export function bufferEstimate(s: Sampling, symbols: number, maxValues?: number): BufferEstimate;
  export type ConfigPlan =
    | { kind: 'show' }
    | { kind: 'unchanged' }
    | { kind: 'apply'; next: Sampling; notes: string[] }
    | { kind: 'confirm'; next: Sampling; notes: string[] };
  export function planConfig(current: Sampling, req: { pollMs?: number; bufferSeconds?: number }, symbols: number): ConfigPlan;
  export interface ConfigDeps {
    current(): Sampling; symbols(): number;
    confirm(text: string): Promise<boolean>;                       // modal dialog, wired in adsTools.ts
    apply(next: Sampling): Promise<void>;
    setTimer(ms: number, fn: () => void): { dispose(): void };
  }
  export type ConfigOutcome =
    | { kind: 'shown'; sampling: Sampling; estimate: BufferEstimate }
    | { kind: 'unchanged'; sampling: Sampling }
    | { kind: 'applied'; before: Sampling; after: Sampling; estimate: BufferEstimate; notes: string[] }
    | { kind: 'declined'; wanted: Sampling; estimate: BufferEstimate }
    | { kind: 'cancelled' };
  export const CONFIG_CONFIRM_MS = 60_000;
  export function runConfig(deps: ConfigDeps, req: { pollMs?: number; bufferSeconds?: number }, signal: AbortSignal): Promise<ConfigOutcome>;
  // toolInput.ts
  export function parseConfigInput(raw: unknown): Parsed<{ pollMs?: number; bufferSeconds?: number }>;
  // adsToolText.ts: ToolNames gains `config` (COPILOT 'adsConfig', MCP 'ads_config')
  export function configText(o: { outcome: ConfigOutcome; target: string }): ToolText;
  ```
- AdsHost (no unit test, `vscode`): `applySampling(next: Sampling): Promise<void>` stores the override, calls `buffer.setSeconds` and `setInterval`; `sampling()` returns override ?? settings; the `onDidChangeConfiguration` listener (`host.ts:98`) drops the override of the matching key when `iecode.ads.sampleIntervalMs` or `iecode.ads.bufferSeconds` changes (the setting then wins again, which is Review Focus 2).

Estimate rule: per symbol the buffer keeps `min(ceil(bufferSeconds*1000/intervalMs), floor(maxValues / max(1, symbols)))` values (`ScopeBuffer.trim` at `adswatch.ts:138-139`); so `values = symbols * thatMin`, `effectiveSeconds = min(bufferSeconds, perSymbol * intervalMs / 1000)`, `capped = effectiveSeconds < bufferSeconds`; with 0 symbols the per-symbol cap of one symbol applies and `values` is 0.

- [ ] **Step 1: Measure the bytes per stored value (spike, 15 min, no repo change)**

In a scratch script under the scratchpad directory (not in the repo): compile the repo (`npm run compile`), fill `new ScopeBuffer(3600)` with `setItems(1, 20 items)` and 50 000 rows (1 000 000 values) of `push(1, rows)` with `node --expose-gc`, and print `(process.memoryUsage().heapUsed after gc - before) / 1e6`. Record the number under "E1 findings" below and set `BYTES_PER_VALUE` to it rounded up to the next multiple of 8 (64 is the `[estimated]` start value). Go/no-go: none; the number only feeds the memory text.

- [ ] **Step 2: Write the failing tests**

```ts
// adsConfig.test.ts
test('estimate: 20 symbols, 100 ms, 300 s hold the full window', () => {
  assert.deepEqual(bufferEstimate({ intervalMs: 100, bufferSeconds: 300 }, 20),
    { symbols: 20, values: 60000, bytes: 60000 * BYTES_PER_VALUE, effectiveSeconds: 300, capped: false });
});
test('estimate: 200 symbols at 10 ms hold only 100 s of 600 s (cap of 2 000 000 values)', () => {
  const e = bufferEstimate({ intervalMs: 10, bufferSeconds: 600 }, 200);
  assert.equal(e.values, 2_000_000); assert.equal(e.effectiveSeconds, 100); assert.equal(e.capped, true);
});
test('estimate: no symbols stores nothing and does not divide by zero', () => {
  assert.equal(bufferEstimate({ intervalMs: 100, bufferSeconds: 300 }, 0).values, 0);
});
test('planConfig shows the current values without arguments', () => {
  assert.deepEqual(planConfig({ intervalMs: 100, bufferSeconds: 300 }, {}, 20), { kind: 'show' });
});
test('planConfig clamps and says so', () => {
  const p = planConfig({ intervalMs: 100, bufferSeconds: 300 }, { pollMs: 5, bufferSeconds: 5000 }, 1);
  assert.equal(p.kind, 'apply');
  if (p.kind === 'apply') {
    assert.deepEqual(p.next, { intervalMs: 10, bufferSeconds: 3600 });
    assert.deepEqual(p.notes, ['pollMs 5 was raised to 10 (allowed 10-5000).', 'bufferSeconds 5000 was lowered to 3600 (allowed 10-3600).',
      'Windows timers tick about every 15.6 ms, so below about 16 ms the real rate is lower.']);
  }
});
test('planConfig confirms a rise above 1 000 000 stored values (10 minutes, 200 symbols)', () => {
  assert.equal(planConfig({ intervalMs: 100, bufferSeconds: 300 }, { bufferSeconds: 600 }, 200).kind, 'confirm');   // 1 200 000 values
});
test('planConfig applies a small rise and a reduction without asking', () => {
  assert.equal(planConfig({ intervalMs: 100, bufferSeconds: 300 }, { bufferSeconds: 600 }, 20).kind, 'apply');
  assert.equal(planConfig({ intervalMs: 10, bufferSeconds: 3600 }, { bufferSeconds: 300 }, 200).kind, 'apply');
});
test('planConfig reports no change when the values already match', () => {
  assert.deepEqual(planConfig({ intervalMs: 100, bufferSeconds: 300 }, { pollMs: 100 }, 5), { kind: 'unchanged' });
});
test('runConfig applies after the user confirms and passes the question with the memory estimate', ...)   // confirm text: `Raise the ADS sample buffer to 600 s with a poll every 100 ms? It would hold up to 1200000 values (about 73.2 MB at 64 bytes each) for 200 watched symbols.` (MB from BYTES_PER_VALUE)
test('runConfig declines when the user says no and applies nothing', ...)    // outcome declined, apply not called
test('runConfig declines when the dialog is not answered within 60 s', ...)   // timer fired -> declined
test('runConfig is cancelled by the signal while the dialog is open', ...)    // outcome cancelled, apply not called
test('runConfig applies without a dialog for plan apply', ...)
```
`toolInput.test.ts`: `parseConfigInput({})` -> `{}`; `{ pollMs: 20 }`; `{ pollMs: '20' }` -> error `pollMs must be a finite number`; `{ bufferSeconds: NaN }` -> `bufferSeconds must be a finite number`; values are rounded, not clamped (clamping and its note belong to `planConfig`).

`adsToolText.test.ts` (`configText`, `target: 'local'`, `BYTES_PER_VALUE` 64, adjust the MB figures to the measured constant):
- shown: `ADS sampling on local: poll every 100 ms, buffer 300 s.\nBuffer: 20 watched symbols, up to 60000 values (about 3.7 MB), holds the full 300 s.\nChange it with pollMs (10-5000) and bufferSeconds (10-3600); the change lasts until the user edits the setting or the window reloads.`
- shown, capped (200 symbols, 10 ms, 600 s): second line `Buffer: 200 watched symbols, up to 2000000 values (about 122.1 MB), holds only 100 s of the 600 s: the buffer stores at most 2000000 values in total.`
- applied (100->20 ms, 300->600 s, 20 symbols): `Poll interval 100 -> 20 ms, buffer 300 -> 600 s (this session only; the settings are unchanged).\nBuffer: 20 watched symbols, up to 600000 values (about 36.6 MB), holds the full 600 s.` followed by the notes, one per line; only the changed part is named (`Poll interval 100 -> 20 ms (this session only; ...)`).
- unchanged: `Nothing to change: poll every 100 ms, buffer 300 s already.`
- declined: `Not changed: the change was not confirmed (it would hold up to 2000000 values, about 122.1 MB).`
- cancelled: `Config change cancelled.`; none of these sets `isError`.

`mcpTools.test.ts`: `ads_config passes validated arguments and the call's signal`; `ads_config with a bad argument never reaches the tool` (text starts with `Invalid arguments:`); the manifest test requires `iecode_ads_config` with no `required` list.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors `Cannot find module '../src/core/adsConfig'` and missing exports.

- [ ] **Step 4: Implement the pure parts**

`adsConfig.ts`, `parseConfigInput`, `configText`, `AdsToolFns.config`, the `ads_config` registration with the call's `signal` in `buildMcpTools`, and `SCOPE_MAX_VALUES`. `runConfig` races `deps.confirm` against the signal and `deps.setTimer(CONFIG_CONFIRM_MS, ...)`; the first to settle wins and the others are disposed; an `apply` rejection propagates as the tool error text.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass, including the new tests; existing text tests unchanged.

- [ ] **Step 6: Wire host, tool, manifest, Copilot (no unit tests, `vscode` module)**

`AdsHost.applySampling` and the override as described; `adsTools.config(input, signal)` builds `ConfigDeps` (`confirm`: `vscode.window.showWarningMessage(text, { modal: true }, 'Apply')` returning `pick === 'Apply'`, like `adsWrite.ts:25`; `symbols: () => host.items().length`) and returns `configText`. Manifest entry: `displayName` `ADS Config`; `userDescription` `Show or change the ADS poll interval and buffer length for this session.`; `modelDescription`: `Shows or sets how often watched ADS values are read (pollMs, 10-5000) and how many seconds of values are kept (bufferSeconds, 10-3600). Without arguments it returns the current values and the memory the buffer needs. A change lasts until the user edits the setting or the window reloads. The buffer stores at most 2 million values in total, so many symbols at a fast poll keep fewer seconds than asked; the result says so. A change that makes the buffer much larger asks the user to confirm.`; `inputSchema`: `pollMs` (number, `Poll interval in ms, 10-5000.`), `bufferSeconds` (number, `Seconds of values kept, 10-3600.`). Copilot: `configTool` with the cancellation token turned into an `AbortController` like `waitTool` (`lmTools.ts:52-66`), registered as `iecode_ads_config`. CHANGELOG line under `### Claude Code and ADS` in `## Unreleased`: ``- New tool `ads_config` (Copilot: `adsConfig`) shows or sets the poll interval and the buffer length for the session, with the memory the buffer needs; a change that makes the buffer much larger asks you to confirm. The buffer stores at most 2 million values in total, so many symbols at a fast poll keep fewer seconds than the setting says, and the tool says so.``

Run: `cd extension && npm test` -> compiles, all pass.

- [ ] **Step 7: Commit**

```bash
git add extension/src/core/adsConfig.ts extension/src/core/adswatch.ts extension/src/core/toolInput.ts extension/src/core/adsToolText.ts extension/src/core/mcpTools.ts extension/src/ads/host.ts extension/src/ads/adsTools.ts extension/src/ads/lmTools.ts extension/package.json extension/CHANGELOG.md extension/test/adsConfig.test.ts extension/test/toolInput.test.ts extension/test/adsToolText.test.ts extension/test/mcpTools.test.ts
git commit -s -m "Add ads_config to tune the poll interval and the buffer length" -m "An agent that needs a 90 s init in the scope or a faster poll for a pulse had to ask the user to open a panel. The change is a session override, not a write to the user's settings, and a rise above 1 000 000 stored values asks first because the buffer caps at 2 000 000 values and silently keeps fewer seconds than asked."
```

**E1 findings** (filled by step 1): bytes per stored value `[measured: <n>]`.

---

### Task E8: Presets for state-machine overviews (extension only)

**Files:**
- Create: `extension/src/core/presets.ts`
- Modify: `extension/src/core/toolInput.ts` (`parsePresetInput`), `extension/src/core/adsToolText.ts` (`ToolNames.preset`), `extension/src/core/mcpTools.ts`, `extension/src/ads/adsTools.ts` (`preset`), `extension/src/ads/lmTools.ts`, `extension/package.json` (tool `iecode_ads_preset`, setting `iecode.ads.presets`), `extension/CHANGELOG.md`
- Test: `extension/test/presets.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Consumes: `AdsHost.read(symbols)` (`host.ts:200`, returns `AdsReadResult[]` with `error` per symbol), `readOnceRow`-style value text, `ToolText`.
- Produces:
  ```ts
  export type Presets = Record<string, string[]>;
  export const MAX_PRESETS = 20, MAX_PRESET_MEMBERS = 30;
  export function parsePresets(raw: unknown): { presets: Presets; problems: string[] };
  export function presetSymbols(path: string, members: string[]): string[];         // `${path}.${member}`
  export function presetListText(p: { presets: Presets; problems: string[] }, names: ToolNames): string;
  export function presetText(o: { path: string; preset: string; target: string; results: { symbol: string; type: string; value: string | null; error: string | null }[] }): string;
  // toolInput.ts
  export function parsePresetInput(raw: unknown): Parsed<{ path?: string; preset?: string }>;
  ```
  Setting `iecode.ads.presets`: object, name -> array of member suffixes. A name matches `^[A-Za-z0-9_][A-Za-z0-9_ -]{0,39}$`; a suffix matches `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$` (a member path below the instance, so `stStep.sText` and `aTimes[2]` work). No library naming is built in; the setting default is `{}`.

Rules: a bad name or suffix is not dropped silently: it goes to `problems` as `preset "<name>": <reason>` and the valid rest stays. More than 20 presets or 30 members: `problems` entry and the excess is ignored. `parsePresetInput`: `{}` lists presets; `preset` without `path` -> error `path is required with preset`; `path` blank -> `path must not be blank`; both length-limited to 512 (`MAX_SYMBOL_LENGTH`).

- [ ] **Step 1: Write the failing tests**

```ts
// presets.test.ts
test('parsePresets keeps valid presets and reports bad ones', () => {
  const r = parsePresets({ seq: ['nStep', 'sStepText', 'stErr.sText'], 'bad name!': ['x'], mode: ['bad member', 'eMode'] });
  assert.deepEqual(r.presets, { seq: ['nStep', 'sStepText', 'stErr.sText'], mode: ['eMode'] });
  assert.deepEqual(r.problems, ['preset "bad name!": the name may use letters, digits, space, _ and - (1-40 characters)', 'preset "mode": member "bad member" is not a member path']);
});
test('parsePresets of a non-object or an empty value is no presets and no problem', () => {
  assert.deepEqual(parsePresets(undefined), { presets: {}, problems: [] });
  assert.deepEqual(parsePresets([]).problems, ['iecode.ads.presets must be an object of name -> list of member names']);
});
test('parsePresets caps presets and members', ...)   // 21st preset and 31st member are ignored with a problem line each
test('presetSymbols joins path and members', () => assert.deepEqual(presetSymbols('MAIN.fbSeq', ['nStep', 'stErr.sText']), ['MAIN.fbSeq.nStep', 'MAIN.fbSeq.stErr.sText']));
test('presetText prints one block and names the missing members', () => {
  assert.equal(presetText({ path: 'MAIN.fbSeq', preset: 'seq', target: 'local', results: [
    { symbol: 'MAIN.fbSeq.nStep', type: 'INT', value: '40', error: null },
    { symbol: 'MAIN.fbSeq.sStepText', type: 'STRING(80)', value: 'Wait for release', error: null },
    { symbol: 'MAIN.fbSeq.nGone', type: '', value: null, error: 'Symbol not found' }] }),
    'Preset "seq" of MAIN.fbSeq on local:\nnStep : INT = 40\nsStepText : STRING(80) = "Wait for release"\nnGone : error Symbol not found\n1 of 3 members could not be read: nGone');
});
test('presetListText lists names with members, problems and the empty case', ...)
```
Strings are shown quoted in the block (`type` starting with `STRING`/`WSTRING`), everything else as is. Empty list text: `No presets defined. Add them in the setting iecode.ads.presets, e.g. { "sequencer": ["nStep", "sStepText", "bBusy"] }.` When `problems` exist they follow as lines `Problem: <text>`. The tool without `preset` returns `presetListText`; with an unknown preset name: `Error: no preset "x"; defined: seq, mode` (isError).

`toolInput.test.ts`: the four `parsePresetInput` cases above. `mcpTools.test.ts`: `ads_preset passes validated arguments`, manifest list gains `ads_preset`, schema has no `required`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm run compile` then `node --test out/test/presets.test.js`
Expected: compile error `Cannot find module '../src/core/presets'`.

- [ ] **Step 3: Implement `presets.ts`, `parsePresetInput`, `presetText`, `presetListText`**

Block format as pinned above: header `Preset "<name>" of <path> on <target>:`, one line per member in the setting's order (member suffix, not the full path), a last line `<k> of <n> members could not be read: <names>` only if `k > 0`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Wire the tool, the setting and Copilot**

`adsTools.preset(input)`: reads `vscode.workspace.getConfiguration('iecode.ads').get('presets')`, runs `parsePresets`, and for a named preset calls `host.read(presetSymbols(...))` once (one request, the host reads each name and reports errors per item) inside `leased`. Manifest setting: `iecode.ads.presets`, `type: object`, `default: {}`, `additionalProperties: { type: array, items: { type: string } }`, `markdownDescription`: `Named member lists for the AI tool **ADS Preset**: name -> member names read below a path in one call, e.g. {"sequencer": ["nStep", "sStepText", "sError", "bBusy"]}. Nothing is built in; the members follow your own naming.` Tool entry: `displayName` `ADS Preset`; `userDescription` `Read a named group of members of a function block in one call.`; `modelDescription`: `Reads the members listed in a user-defined preset (setting iecode.ads.presets) below a path in one call and prints one block, e.g. the step, step text, error text and busy flag of a state machine. Without arguments it lists the defined presets. Members that do not exist are named, the others are still read. Values are read once, not watched.`; `inputSchema`: `path` (string, maxLength 512, `ADS path of the instance, e.g. MAIN.fbSeq.`), `preset` (string, maxLength 40, `Preset name.`). Copilot `iecode_ads_preset`. CHANGELOG: ``- New tool `ads_preset` (Copilot: `adsPreset`) reads a named group of members below a path in one call (for example step, step text, error text and busy flag of a state machine). You define the groups in the setting `iecode.ads.presets`; no naming convention is built in.``

Run: `cd extension && npm test` -> all pass.

- [ ] **Step 6: Commit**

```bash
git add extension/src/core/presets.ts extension/src/core/toolInput.ts extension/src/core/adsToolText.ts extension/src/core/mcpTools.ts extension/src/ads/adsTools.ts extension/src/ads/lmTools.ts extension/package.json extension/CHANGELOG.md extension/test/presets.test.ts extension/test/toolInput.test.ts extension/test/mcpTools.test.ts
git commit -s -m "Add ads_preset for user-defined member groups" -m "Reading a state machine took six to eight symbols per sequencer. A built-in view would assume one library's member names, so the groups come from a setting and nothing in the code knows a naming convention."
```

---

### Task E3: Connection and sampling notices, and resume after a PLC restart

This task starts with a reproduction. The wishlist reports a watch that was stale for 974 s. The code suggests a different first suspect than a PLC restart: the host stops 30 s after the last lease (`host.ts:294`, `IDLE_MS`), `ads_scope` takes no lease (`adsTools.ts:126`), so sampling stops 30 s after the last `ads_watch` or `ads_read` call unless a view is open, and `gapNote` already says "sampling only runs while the ADS Watch view or the ADS Scope is open". A PLC restart, by contrast, is handled by the host itself (state event, retry every 2 s, `WatchHost.TryConnect`; the `TODO.md` manual check "Restart of TwinCAT while watching" is done). So the reproduction must separate the causes before anything is built.

**Files:**
- Create: `extension/src/core/samplingLog.ts`
- Modify: `extension/src/ads/host.ts` (record events in `handle`, `exited`, `stop`, `start`; keep-alive on the idle timer if the go path says so), `extension/src/ads/adsTools.ts` (notice at the top of watch and scope, trailing in wait), `extension/src/core/adsToolText.ts`, `extension/CHANGELOG.md`
- Test: `extension/test/samplingLog.test.ts`, `adsToolText.test.ts`

**Interfaces:**
- Consumes: `HostMessage` events `state` and `items` (`adswatch.ts:9-14`), `AdsHost.onEnded` reasons (`host.ts:63`), `ToolNames`.
- Produces:
  ```ts
  export type SamplingEvent =
    | { kind: 'lost'; t: number; error: string }       // state event connected:false after a connected state
    | { kind: 'restored'; t: number }                  // state event connected:true after a lost
    | { kind: 'reloaded'; t: number }                  // host-initiated `items` event (download, online change, restart)
    | { kind: 'stopped'; t: number; reason: string }   // onEnded
    | { kind: 'started'; t: number };                  // hello of a new host
  export class SamplingLog {
    constructor(cap?: number);                          // default 50 newest events
    record(e: SamplingEvent): void;
    since(ms: number): SamplingEvent[];                 // events with t > ms, oldest first
    clear(): void;                                      // target change
  }
  export function noticeText(events: SamplingEvent[], clock: (ms: number) => string, names: ToolNames): string | undefined;
  export function idleDelayMs(o: { baseMs: number; keepAliveMs: number; aiEntries: number; lastAiCallMs: number | undefined; nowMs: number }): number;   // go path H1 only
  ```
- `AdsToolFns`/`adsTools()` keep one `lastNoticeMs` per tool object (each MCP connection and Copilot have their own, `mcpServer.ts:162`, `lmTools.ts:31`); a notice shows each event once per connection.

- [ ] **Step 1: Reproduce and record (checklist, about 2 h, against a simulation target)**

Use a PLC in run mode on a simulation target with three watched symbols, one of them a counter that increments every cycle. Record each result in "E3 findings" (table: scenario, what happened, time until the first new row, what `ads_scope` printed).

1. H1, idle stop: add the symbols with `ads_watch` through MCP, close the ADS Watch view and the scope, wait 60 s without a tool call, then call `ads_scope`. Expect (if H1): IECode output shows `ADS host exited` about 30 s after the last call; `ads_scope` prints `No samples since <time>: sampling only runs while ...`; a following `ads_watch` call (any) starts sampling again.
2. H2, PLC restart with a lease held (watch view open): restart TwinCAT (`iecode target run` or the XAE restart button). Record the `state` events in the IECode output (`connected:false` with the ADS error, then `connected:true`), the seconds until rows continue, and whether the counter restarted from 0 (it must, that is the restart signature).
3. H3, host process killed with a lease held (`taskkill` of the `iecode ads serve` child): does anything restart it? (Reading `host.ts`: `exited()` sets state but starts nothing; only `use()`, `ensure()` and settings changes start a host.)
4. H4, download with an unchanged list: unit-test only (a download is not possible on every simulation target, see `TODO.md`); skip the live run and write "covered by `WatchHostTests` only".

Decision table, written into the findings:

| Finding | The task becomes |
|---|---|
| H1 reproduces (most likely) | Build the notice **and** the keep-alive (steps 6-9, with `idleDelayMs`): sampling continues for `iecode.ads.aiKeepAliveSeconds` (default 300) after the last AI tool call while AI-added entries exist. Open decision 1 below. |
| Only H2 (rows resume, the user just saw nothing) | Build the notice only (steps 2-5, 8-9), skip `idleDelayMs`. |
| H3 reproduces | Additionally restart the host on an unexpected exit while a lease is held (one retry per 5 s, in `exited()`), with a test of the retry decision in `samplingLog.ts` (`shouldRestart`), then the notice. |
| None reproduces | Build the notice only and record in the wishlist row that the 974 s case could not be reproduced. |

- [ ] **Step 2: Write the failing tests (`samplingLog.test.ts`)**

```ts
const clock = (ms: number) => `T${ms}`;
const names = MCP_NAMES;
test('a lost and restored connection is one line with both times', () => {
  assert.equal(noticeText([{ kind: 'lost', t: 3, error: 'ADS error 0x745' }, { kind: 'restored', t: 9 }], clock, names),
    'Notice: connection to the PLC was lost at T3 and restored at T9; values in between are missing.');
});
test('a connection that is still lost names the error', () => {
  assert.equal(noticeText([{ kind: 'lost', t: 3, error: 'ADS error 0x745' }], clock, names),
    'Notice: connection to the PLC lost at T3 (ADS error 0x745); sampling resumes when it is back.');
});
test('symbols reloaded without a user edit are named', () => {
  assert.equal(noticeText([{ kind: 'reloaded', t: 9 }], clock, names),
    'Notice: symbols were reloaded at T9 (download, online change or PLC restart).');
});
test('a stop followed by a start is one line about the gap', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'The ADS host stopped (idle).' }, { kind: 'started', t: 900 }], clock, names),
    'Notice: sampling was stopped from T10 to T900 (The ADS host stopped (idle).); values in between are missing.');
});
test('a stop without a restart says how to start again', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'The ADS host stopped (idle).' }], clock, names),
    'Notice: sampling stopped at T10 (The ADS host stopped (idle).); ads_watch or ads_wait starts it again.');
});
test('no events give no notice; more than three notices keep the newest three', ...)   // oldest dropped, first line `(2 earlier notices not shown)`
test('since() returns only newer events and the log keeps its cap', ...)
test('clear() drops the log (target change)', ...)
```
Go path H1 (`idleDelayMs`): `base 30000, keepAlive 300000, aiEntries 2, lastAiCall 1000, now 5000` -> `296000`; `aiEntries 0` -> `30000`; `lastAiCall undefined` -> `30000`; `keepAlive 0` -> `30000` (never shorter than `baseMs`, never negative).
`adsToolText.test.ts`: `withNotice(text, notice)` puts `notice\n` before the text, and `undefined` returns the text byte-identical.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd extension && npm run compile` then `node --test out/test/samplingLog.test.js`
Expected: compile error `Cannot find module '../src/core/samplingLog'`.

- [ ] **Step 4: Implement `samplingLog.ts`**

Coalescing: walk the events oldest to newest; `lost` pairs with the next `restored`, `stopped` with the next `started`; the unpaired forms produce the "still lost" / "stop without restart" lines; `reloaded` is its own line. The `names` argument is used only for the tool names in the texts (`ads_watch`, `ads_wait`: use `names.watch` and `names.wait`, so the Copilot texts say `adsWatch`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 6: Record events in the host (no unit tests, `vscode` module)**

`AdsHost` owns `readonly log = new SamplingLog()`: in `handle()` `state` event record `lost` (connected false after a connected state) and `restored` (connected true after a lost); in `case 'items'` (host-initiated, not a watch reply) record `reloaded`; in `stop()` and `exited()` record `stopped` with the reason; in `start()` when the hello arrives record `started`; the target-change branch of the configuration listener calls `log.clear()`. Use `Date.now()` as `t`.

- [ ] **Step 7: Show the notice in the tools (no unit tests)**

`adsTools()` keeps `let seen = 0`; `watch` and `scope` results are prefixed with `noticeText(host.log.since(seen), clock, names)` and then `seen = Date.now()`; `wait` appends the notice of the events since the call start as a last line (`Note:` text is the same line). `read` is not changed (its rows already carry the sample age).

- [ ] **Step 8: Keep-alive (only if H1 reproduced)**

Setting `iecode.ads.aiKeepAliveSeconds` (integer, default 300, 0 to 3600, `0` = off), `markdownDescription`: `After the last AI tool call, keep sampling for this many seconds while AI-added entries are on the watch list, so the scope has history when the agent comes back. 0 stops sampling 30 s after the last use as before.` `AdsHost.release()` (`host.ts:290`) arms the idle timer with `idleDelayMs({ baseMs: IDLE_MS, keepAliveMs, aiEntries: entries().filter(e => e.ai).length, lastAiCallMs, nowMs: Date.now() })`; `adsTools` calls `host.touchAi()` at the start of `watch`, `read`, `wait`, `scope`, `capture`. No change when the setting is 0.

Run: `cd extension && npm test` -> compiles, all pass.

- [ ] **Step 9: CHANGELOG and commit**

CHANGELOG (adapt to the findings): ``- `ads_watch`, `ads_scope` and `ads_wait` start with a notice when the connection to the PLC was lost and restored, when the symbols were reloaded (download, online change, PLC restart), or when sampling had stopped, so a table with a hole is no longer read as a quiet machine.`` Plus, if step 8 ran: ``- Sampling continues for 5 minutes after the last AI tool call while the AI's watch entries exist (`iecode.ads.aiKeepAliveSeconds`); before, it stopped 30 s after the last call and `ads_scope` showed a stale table.``

```bash
git add extension/src/core/samplingLog.ts extension/src/ads/host.ts extension/src/ads/adsTools.ts extension/src/core/adsToolText.ts extension/package.json extension/CHANGELOG.md extension/test/samplingLog.test.ts extension/test/adsToolText.test.ts
git commit -s -m "Tell the agent when sampling had a hole" -m "A scope table that ends silently was read as a quiet machine. The host already reconnects by itself after a PLC restart, so the missing piece is a notice built from the host's state, items and stop events, not another reconnect mechanism."
```

**E3 findings** (filled by step 1): table of H1 to H4 with `[measured]` values.

---

### Task E4: `ads_state`: PLC run state and restart detection (needs C0, CLI + extension)

**Files:**
- Create: `extension/src/core/plcState.ts`
- Modify: `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`PlcState`, `IWatchBackend.ReadPlcState`, `WatchStateData`), `cli/src/IECode.Core/Ads/WatchHost.cs` (op `state`), `cli/src/IECode.Automation/AdsWatchBackend.cs` (`ReadPlcState`), `cli/src/IECode.Automation/AdsLink.cs` (`IAdsLink.ReadStateInfo`), `cli/src/IECode.Cli/Commands/TargetCommands.cs` (`UnavailableBackend`), `cli/README.md`
- Modify: `extension/src/core/hostProtocol.ts` (`PROTOCOL_TABLE` feature `state`), `extension/src/ads/host.ts` (`plcState()`), `adsTools.ts`, `lmTools.ts`, `mcpTools.ts`, `toolInput.ts`, `adsToolText.ts` (`ToolNames.state`, `stateText`, `featureMissingText`), `package.json`, `CHANGELOG.md`
- Test: `extension/test/plcState.test.ts`, `adsToolText.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`; `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `FakeLink.cs`

**Interfaces:**
- Consumes (C0): `PROTOCOL_TABLE`, `host.supports(feature: string): boolean`; feature name `state`. Existing: `IAdsLink.ReadState()` returns only the `AdsErrorCode` (`AdsLink.cs:19`), `BeckhoffLink.ReadState` uses `_client.TryReadState(out _)` (`AdsLink.cs:63`).
- Produces C#:
  ```csharp
  // WatchProtocol.cs
  public sealed record PlcState(string AdsState, ushort DeviceState, long? CycleCount, long? CycleTimeUs, long? OnlineChangeCount, string? TaskNote);
  // IWatchBackend
  PlcState ReadPlcState(int task);     // throws AdsFault; cycle fields null with TaskNote when the system info symbols are missing
  // AdsLink.cs, IAdsLink
  (AdsErrorCode Code, AdsState State, ushort DeviceState) ReadStateInfo();
  // WatchHost.cs: op "state" with optional integer "task" (1..16, default 1)
  internal sealed record WatchStateData(string AdsState, ushort DeviceState, long? CycleCount, long? CycleTimeUs, long? OnlineChangeCount, string? TaskNote);
  ```
  Wire (`camelCase`, nulls omitted): `{"id":5,"op":"state","task":1}` -> `{"id":5,"ok":true,"data":{"adsState":"Run","deviceState":0,"cycleCount":1234567,"cycleTimeUs":10000,"onlineChangeCount":3}}`. The cycle fields come from the PLC system-info symbols `TwinCAT_SystemInfoVarList._TaskInfo[<task>].CycleCount` and `.CycleTime` (unit 100 ns, so `cycleTimeUs = CycleTime / 10`) and `TwinCAT_SystemInfoVarList._AppInfo.OnlineChangeCnt`, read by name with `ReadOnce`. **Step 1 verifies these names against a simulation target before anything is coded**; if a name differs the constants change, the design does not.
- Produces TS:
  ```ts
  export interface PlcStateReply { adsState: string; deviceState: number; cycleCount?: number; cycleTimeUs?: number; onlineChangeCount?: number; taskNote?: string }
  export function parsePlcState(data: unknown): PlcStateReply | string;   // string = why the reply is unusable
  export interface RestartFinding { kind: 'restart' | 'onlineChange'; was: number; now: number; atMs: number }
  export class StateTracker {
    observe(targetKey: string, s: PlcStateReply, nowMs: number): RestartFinding | undefined;  // per target: cycleCount went down -> restart; onlineChangeCount changed -> onlineChange
  }
  // adsToolText.ts
  export function stateText(o: { target: string; state: PlcStateReply; task: number; finding?: RestartFinding; clock: (ms: number) => string; lastCallMs?: number }): string;
  export const featureMissingText = (tool: string, feature: string): string =>
    `${tool} needs a newer iecode CLI (feature "${feature}"); run "IECode: Install CLI" to update it.`;
  // toolInput.ts
  export function parseStateInput(raw: unknown): Parsed<{ task: number }>;   // task optional, integer 1-16, default 1; 0, 17, 1.5, '2' -> `task must be an integer from 1 to 16`
  ```
- Host: `AdsHost.plcState(task: number): Promise<PlcStateReply>` (`leased`, `ensure(true)`, `request({ op: 'state', task })`, `parsePlcState`); throws when `!supports('state')`.

- [ ] **Step 1: Verify the system-info names and the ADS state read (about 1 h, against a simulation target)**

With `iecode ads serve` over stdin: `read` of `TwinCAT_SystemInfoVarList._TaskInfo[1].CycleCount`, `.CycleTime` and `TwinCAT_SystemInfoVarList._AppInfo.OnlineChangeCnt` (one `{"op":"read","symbols":[...]}` line). Record in "E4 findings": do the names resolve (index in a path included), the unit of `CycleTime`, whether `CycleCount` restarts at 0 after a TwinCAT restart, and the value of `AdsState` for Run, Stop and Config (`TryReadState`). Outcomes: names resolve -> implement as specified; they do not -> `cycleCount` and the other numbers stay null, `taskNote` says `task counters not readable: <ads message>`, and the restart finding falls back to `adsState` transitions (Run -> Stop/Config -> Run between two calls cannot be seen; the text then says `restart detection needs the task counters`).

- [ ] **Step 2: Write the failing C# tests**

```csharp
// WatchHostTests.cs (Rig.Backend gains StateFn)
[Fact] public void State_op_returns_the_backend_state_and_passes_the_task()  // reply data: adsState "Run", deviceState 0, cycleCount 1234567; FakeBackend.LastTask == 2 for {"op":"state","task":2}
[Fact] public void State_op_defaults_to_task_1()
[Fact] public void State_op_rejects_a_task_outside_1_to_16()                  // ok:false, error "task must be an integer from 1 to 16."
[Fact] public void State_op_fault_with_lost_connection_marks_the_host_lost()  // AdsFault(connectionLost) -> state event connected:false, reply ok:false
[Fact] public void Hello_reports_protocol()                                   // asserts WatchHost.Protocol (edited only by the first CLI task of the train)
// AdsWatchBackendTests.cs (FakeLink.StateInfo, FakeLink read of the system info names)
[Fact] public void ReadPlcState_reads_state_and_task_counters()   // CycleTime 100000 (100 ns) -> CycleTimeUs 10000
[Fact] public void ReadPlcState_without_the_system_info_symbols_returns_state_and_a_note()  // TaskNote "task counters not readable: Symbol 'TwinCAT_SystemInfoVarList...' not found"
[Fact] public void ReadPlcState_maps_a_failing_state_read_to_an_AdsFault()
```

- [ ] **Step 3: Run the C# tests to verify they fail (PowerShell tool)**

Run: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~State_op"`
Expected: compile error (missing `ReadPlcState`, `PlcState`).

- [ ] **Step 4: Implement the CLI side**

`DoState(JsonElement root)` in `WatchHost.Handle` (`"state" => DoState(root)`), reading `task` with the same style as `DoInterval`; `AdsWatchBackend.ReadPlcState` calls `link.ReadStateInfo()` (an error code other than `NoError` -> `AdsFault` through `Map`) and `ReadOnce` for the three names, catching `IECodeException` and `AdsFault` (not connection-lost) into `TaskNote`. `FakeLink` gets `StateInfo` and the fake symbols. `UnavailableBackend.ReadPlcState` throws the stored fault. Add the `state` row to the protocol list in `cli/README.md` ("Live values"): `← {"id":5,"op":"state","task":1}   PLC run state, task cycle time and counter (task 1..16, default 1)`.

- [ ] **Step 5: Run the C# tests to verify they pass (PowerShell tool)**

Run: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~State"` then `dotnet test cli/tests/IECode.Automation.Tests --filter "FullyQualifiedName~ReadPlcState"`
Expected: pass (two separate commands, nothing in parallel).

- [ ] **Step 6: Commit the CLI side**

```bash
git add cli/src cli/tests cli/README.md
git commit -s -m "Add a state op to the ADS watch host" -m "An agent cannot tell a restarted PLC from a quiet one by watching values. The op reports the ADS run state and the task counters; a missing system-info symbol is a note in the reply, not a failure, so the run state still comes back."
```

- [ ] **Step 7: Write the failing TypeScript tests**

```ts
// plcState.test.ts
test('parsePlcState accepts the reply and rejects a shape it does not know', () => {
  assert.deepEqual(parsePlcState({ adsState: 'Run', deviceState: 0, cycleCount: 1234567, cycleTimeUs: 10000, onlineChangeCount: 3 }),
    { adsState: 'Run', deviceState: 0, cycleCount: 1234567, cycleTimeUs: 10000, onlineChangeCount: 3 });
  assert.equal(parsePlcState({ adsState: 5 }), 'unexpected reply to the state request');
});
test('a cycle count that went down is a restart', () => {
  const t = new StateTracker();
  assert.equal(t.observe('local:851', { adsState: 'Run', deviceState: 0, cycleCount: 1_000_000, onlineChangeCount: 3 }, 1000), undefined);
  assert.deepEqual(t.observe('local:851', { adsState: 'Run', deviceState: 0, cycleCount: 12, onlineChangeCount: 3 }, 9000), { kind: 'restart', was: 1_000_000, now: 12, atMs: 1000 });
});
test('a changed online change count without a restart is an online change', ...)   // { kind: 'onlineChange', was: 3, now: 4, atMs }
test('the tracker is per target and the first call finds nothing', ...)
test('a missing counter never reports a restart', ...)
// adsToolText.test.ts (stateText, clock = ms => `T${ms}`)
```
`stateText` exact texts:
- Running: `PLC state on local: Run (device state 0).\nTask 1: cycle time 10.000 ms, cycle count 1234567.`
- Not running (`adsState` not `Run`): first line `PLC state on local: Stop (device state 0).\nThe PLC is not running: values are not updated.` followed by the task line when the counters exist.
- Restart: an extra last line `Restart detected: the cycle count went from 1000000 to 12 since the last call at T1000.`; online change: `Online change or download detected: the change count went from 3 to 4 since the last call at T1000.`
- Counters missing: `Task 1: <taskNote>` (default `task counters not available`).
- `parseStateInput` and `mcpTools.test.ts` cases (`ads_state passes validated arguments`, manifest list gains `ads_state`, `featureMissingText` text pinned: `ads_state needs a newer iecode CLI (feature "state"); run "IECode: Install CLI" to update it.`).

- [ ] **Step 8: Run the TypeScript tests to verify they fail, implement, run again**

Run: `cd extension && npm test` -> compile errors; implement `plcState.ts`, `stateText`, `featureMissingText`, `parseStateInput`, `AdsToolFns.state`, the MCP registration; run again -> all pass.

- [ ] **Step 9: Wire host, tool, manifest, Copilot, CHANGELOG (no unit tests)**

`hostProtocol.ts`: the `PROTOCOL_TABLE` entry of the train gets `ops: [..., 'state']`, `features: [..., 'state']`; `adsTools.state(input)` returns `featureMissingText('ads_state', 'state')` as an error result when `!host.supports('state')`. Manifest: `displayName` `ADS State`; `userDescription` `Read the run state of the PLC and detect a restart.`; `modelDescription`: `Returns the PLC run state (Run, Stop, Config), the task cycle time and the cycle counter of a task (default 1). Compare with the previous call: a cycle counter that went down means the PLC restarted and everything is reset; a changed online change count means a download or online change. Needs a recent iecode CLI.`; `inputSchema`: `task` (integer, minimum 1, maximum 16, `PLC task number, default 1.`). CHANGELOG: ``- New tool `ads_state` (Copilot: `adsState`) reports the PLC run state, the task cycle time and cycle counter, and says when the PLC restarted or an online change happened since the last call. Needs the matching iecode CLI.``

- [ ] **Step 10: Commit the extension side**

```bash
git add extension/src/core/plcState.ts extension/src/core/toolInput.ts extension/src/core/adsToolText.ts extension/src/core/mcpTools.ts extension/src/ads/host.ts extension/src/ads/adsTools.ts extension/src/ads/lmTools.ts extension/package.json extension/CHANGELOG.md extension/test/plcState.test.ts extension/test/adsToolText.test.ts extension/test/toolInput.test.ts extension/test/mcpTools.test.ts
git commit -s -m "Add ads_state for the PLC run state and restart detection" -m "After a restart every variable is reset and nothing in the watch output says so. The tool compares the task cycle counter between calls; the feature is gated by the protocol table so an older CLI loses only this tool."
```

**E4 findings** (filled by step 1): names resolved yes/no, `CycleTime` unit, `AdsState` values seen.

---

### Task E5: `ads_capture`: the window around a condition (needs A3 and `ads_wait`, no CLI change)

**Files:**
- Create: `extension/src/core/captureRun.ts`
- Modify: `extension/src/core/toolInput.ts` (`parseCaptureInput`), `extension/src/core/adsToolText.ts` (`ToolNames.capture`, `captureResultText`), `extension/src/core/mcpTools.ts`, `extension/src/ads/adsTools.ts` (`capture`), `extension/src/ads/lmTools.ts`, `extension/package.json`, `extension/CHANGELOG.md`
- Test: `extension/test/captureRun.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Consumes: `runWait`, `WaitDeps`, `WaitOutcome`, `SampleBatch`, `USER_REMOVED` (`waitRun.ts`), `parseCondition`, `conditionText`, `WAIT_DEFAULT_SECONDS`, `WAIT_MAX_SECONDS`, Plan A task A3: `ScopeBuffer.changes(symbol: string, fromMs: number): { t: number; text: string }[]` and the change-only table renderer. E5 needs the renderer in this shape; if A3 shipped a seconds-based one, step 3 adds this thin wrapper in `adswatch.ts` around `ScopeBuffer.changes` and A3's row builder instead of a second table implementation:
  ```ts
  export function changesTableText(buf: ScopeBuffer, symbols: string[], fromMs: number, toMs: number, originMs: number): string;
  // tab-separated, header `t[s]\t<symbols>`, one row per timestamp with a change, `((t - originMs) / 1000).toFixed(3)`, never thinned, same cap and `earlier changes not shown` note as A3
  ```
- Produces:
  ```ts
  export interface CaptureDeps extends WaitDeps {
    newestMs(): number | undefined;                         // newest buffered sample time of the captured symbols
    oldestMs(): number | undefined;                         // oldest buffered sample time (history start)
    capacitySeconds(): number;                              // seconds the buffer really holds (E1 estimate.effectiveSeconds)
    snapshot(fromMs: number, toMs: number, originMs: number): string;   // changesTableText over the captured symbols
  }
  export interface CaptureRequest { symbol: string; condition: WaitCondition; preSeconds: number; postSeconds: number; timeoutSeconds: number }
  export interface CaptureWindow { fromMs: number; toMs: number; originMs: number; table: string; historyFromMs?: number }
  export type CaptureOutcome =
    | { kind: 'captured'; met: Extract<WaitOutcome, { kind: 'met' }>; window: CaptureWindow; partial?: string }
    | { kind: 'timeout'; last: string | undefined; seconds: number; window: CaptureWindow }
    | { kind: 'ended'; reason: string; window: CaptureWindow }
    | { kind: 'refused'; reason: string }
    | { kind: 'cancelled' };
  export const CAPTURE_GRACE_MS = 3000;                      // wait for the last post rows beyond postSeconds
  export const CAPTURE_DEFAULT_PRE = 5, CAPTURE_DEFAULT_POST = 5, CAPTURE_MAX_PRE = 600, CAPTURE_MAX_POST = 60;
  export function runCapture(deps: CaptureDeps, holdSymbols: string[], req: CaptureRequest, signal: AbortSignal): Promise<CaptureOutcome>;
  // toolInput.ts
  export function parseCaptureInput(raw: unknown): Parsed<CaptureRequest & { symbols: string[] }>;
  // adsToolText.ts
  export function captureResultText(o: { symbol: string; condition: WaitCondition; outcome: CaptureOutcome; target: string; intervalMs: number; clock: (ms: number) => string; names: ToolNames; bufferSeconds: number }): ToolText;
  ```
  Behaviour of `runCapture`: (1) refuse before anything starts when `capacitySeconds() < pre + post` with `the capture window needs <pre+post> s of history but the buffer holds <cap> s; raise it with ads_config { bufferSeconds: <pre+post> } (a large change asks the user to confirm)` (the core returns `refused` with the token `{config}` in place of the tool name; `captureResultText` replaces it with `names.config`, so Copilot texts say `adsConfig`). (2) Hold every symbol of `holdSymbols` (the trigger and the captured ones) and keep the holds until the table is built, because `ScopeBuffer.setItems` drops the series of a symbol that leaves the list (`adswatch.ts:88-95`) and `runWait` releases its own hold the moment it meets. (3) Run `runWait` with `timeoutSeconds`. (4) On `met` at row time `t`: window `[t - pre*1000, t + post*1000]`, origin `t`; finish when `newestMs() >= t + post*1000` (checked at once and on every batch), or on `onEnded` (partial with the reason), `onUserRemoved` of a held symbol (partial `USER_REMOVED`), the timer at `post*1000 + CAPTURE_GRACE_MS` after the met (partial `no samples after <time>; the connection to the PLC may have been lost`), or the signal (`cancelled`). (5) `timeout` and `ended` carry the last `pre` seconds up to `newestMs() ?? wallMs()`, origin = that end. (6) `snapshot` is called before the holds are released. `historyFromMs` is set when `oldestMs() > fromMs`. Total call time stays below 190 s (120 + 60 + grace), inside the MCP tool timeout.

- [ ] **Step 1: Write the failing tests (`captureRun.test.ts`)**

Build a fake `CaptureDeps` in the test file (emitters for samples/ended/removed, a manual clock, a timer list, hold counters, `newest`/`oldest` set by the test, `snapshot` returning `TABLE(<from>,<to>,<origin>)`). Tests:

```ts
test('captures pre and post around the trigger and renders after the post rows arrived', ...)
  // trigger row t = T0+3000 ('= TRUE'), pre 2, post 1: no result until a batch with a row t >= T0+4000 arrived, then
  // { kind: 'captured', met.t: T0+3000, window: { fromMs: T0+1000, toMs: T0+4000, originMs: T0+3000, table: `TABLE(${T0+1000},${T0+4000},${T0+3000})` } }
test('a post window that is already buffered finishes at once', ...)   // newestMs() >= t + post when the trigger fires
test('holds are released only after the table was built', ...)         // order of events recorded: snapshot, then released === holdSymbols.length (Review Focus 4)
test('the user removing a captured symbol during the post window ends partial with that reason', ...)  // partial: 'removed from the watch list by the user', table still built
test('host end during the post window ends partial with the reason', ...)
test('connection loss during the post window ends partial after post + grace', ...)  // fire the timer; partial text `no samples after <t>; the connection to the PLC may have been lost` (Review Focus 3)
test('timeout returns the last pre seconds up to the newest sample', ...)  // { kind: 'timeout', last: '3', seconds: 5, window: { fromMs: end - pre*1000, toMs: end, originMs: end } }
test('ended before the trigger returns the window it has', ...)         // kind ended, window present
test('a buffer shorter than pre + post is refused before holding anything', ...)  // refused, held === 0
test('history shorter than the pre window is reported', ...)            // oldestMs() > fromMs -> window.historyFromMs
test('cancel during the post window releases every hold and returns cancelled', ...)
test('a refused trigger (condition not allowed for the type) releases the holds', ...)
```
`toolInput.test.ts`: `parseCaptureInput({ symbol: 'MAIN.nStep', condition: '= 40' })` -> `{ symbol, condition, preSeconds: 5, postSeconds: 5, timeoutSeconds: 30, symbols: [] }`; `preSeconds: 700` -> 600; `postSeconds: 90` -> 60; `preSeconds: -1` -> 0; `postSeconds: '5'` -> `postSeconds must be a finite number`; bad condition -> the allowed-forms text; `symbols` rules as `parseReadInput`.

`captureResultText` exact texts (clock `T<ms>`, origin printed relative, intervalMs 100, target `local`):
- captured: `Captured at T3000 (after 3.42 s): MAIN.nStep = 40\nWindow -2 s .. +1 s around the trigger on local; the table shows value changes only, time 0 = the trigger.\n<table>\nSampled every 100 ms; changes between samples are not seen.` with ` (true at the first observation)` appended to the first line when `firstObservation`.
- partial: the first two lines as above, then `Capture ended early: <reason>; the table covers -2 s .. +0.3 s.` (`+0.3` = the newest sample after the trigger, from `window.toMs`), then the table.
- history short: extra line before the table `History starts at T2500, later than the requested -2 s; the symbols were watched for a shorter time.`
- timeout: `Not met within 30 s: MAIN.nStep = 40; last value 3. Showing the last 5 s (changes only, time 0 = now):\n<table>\nSampled every ...`; without a last value `; no valid value observed`.
- ended: `Wait ended: <reason>. Showing the last 5 s that were sampled:\n<table>`.
- refused: `Error: <reason>` (isError); cancelled: `Capture cancelled.`
- `isError` only for refused.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm run compile` then `node --test out/test/captureRun.test.js`
Expected: compile error `Cannot find module '../src/core/captureRun'`.

- [ ] **Step 3: Implement `captureRun.ts`, `parseCaptureInput`, `captureResultText` and (if A3 lacks it) `changesTableText`**

`runCapture` composes `deps.hold` per symbol (all awaited before `runWait`; a rejected hold releases the earlier ones and returns `refused` with the message), then `runWait(deps, req, signal)` and the post phase as specified. Keep the post phase as one idempotent `finish`, the same pattern as `runWait`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Wire the tool, manifest, Copilot, CHANGELOG (no unit tests)**

`adsTools.capture(input, signal)`: symbols = `input.symbols` (as watched names) or `host.watched()`, plus the trigger symbol; `snapshot` calls `changesTableText(host.buffer, captured, from, to, origin)`; `capacitySeconds` from `bufferEstimate(host.sampling(), host.items().length).effectiveSeconds` (E1); lease the host for the whole call (`leased`), like `wait`. Not-watched names in `symbols` are listed in a first line `Not watched, so no history (add them with <names.watch>): ...` as `scopeToolText` does. Manifest: `displayName` `ADS Capture`; `userDescription` `Capture the values around a PLC condition.`; `modelDescription`: `Waits like the wait tool until a condition is met, then returns the value changes of the watched symbols from preSeconds before to postSeconds after the trigger as one table (time 0 = the trigger). Use it for a pulse or for reading a text at the moment a sequence errors. The symbols must already be watched for the before-part to have content; the buffer must hold at least preSeconds + postSeconds (see the config tool). Not met within the timeout returns the last window and says so. Resolution is the sample interval.`; `inputSchema`: `symbol`, `condition` (required, as `ads_wait`), `preSeconds` (number, `Seconds before the trigger, 0-600, default 5.`), `postSeconds` (number, `Seconds after the trigger, 0-60, default 5.`), `timeoutSeconds` (number, `Seconds to wait for the trigger, 1-120, default 30.`), `symbols` (string array, maxItems 200, `Watched names to include; default all watched.`). Copilot tool with `AbortController` like `waitTool`. CHANGELOG: ``- New tool `ads_capture` (Copilot: `adsCapture`) waits for a condition like `ads_wait` and returns the value changes of the watched symbols from a few seconds before to a few seconds after it, with the trigger as time 0. It needs a buffer at least as long as the window; `ads_config` can raise it.``

Run: `cd extension && npm test` -> compiles, all pass.

- [ ] **Step 6: Commit**

```bash
git add extension/src/core/captureRun.ts extension/src/core/adswatch.ts extension/src/core/toolInput.ts extension/src/core/adsToolText.ts extension/src/core/mcpTools.ts extension/src/ads/adsTools.ts extension/src/ads/lmTools.ts extension/package.json extension/CHANGELOG.md extension/test/captureRun.test.ts extension/test/toolInput.test.ts extension/test/adsToolText.test.ts extension/test/mcpTools.test.ts
git commit -s -m "Add ads_capture for the window around a condition" -m "A pulse or an error text that is gone one cycle later needed a wait, then a scope call that no longer showed it. The capture holds its symbols until the table is built, because the wait releases its hold the moment it meets and the buffer drops the series of a symbol that left the list."
```

---

### Task E2: Per-symbol sample rate (needs C0; spike first)

**Files:**
- Modify (spike, throwaway): none in the repo.
- Modify (after go): `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`WatchRow.R`, `IWatchBackend.SetRateGroups`, `ReadWatchedGroup`), `WatchHost.cs` (`watch` op reads `everyMs`, due logic in `Poll`), `cli/src/IECode.Automation/AdsWatchBackend.cs` (one sum read per rate group), `AdsLink.cs` (unchanged API, several `PrepareRead` calls), `TargetCommands.cs` (`UnavailableBackend`), `cli/README.md`
- Modify (after go): `extension/src/core/adswatch.ts` (`Row.r`, `WatchEntry.everyMs`, `parseWatchList`, `ScopeBuffer.push` skips repeated cells), `watchList.ts` (`aiEdit` third argument), `waitRun.ts` (skip repeated cells), `toolInput.ts` (`parseWatchInput` `rates`), `adsToolText.ts`, `ads/host.ts` (`watch` request carries `everyMs`), `adsTools.ts`, `package.json` (`ads_watch` schema), `CHANGELOG.md`
- Test (after go): `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `extension/test/adswatch.test.ts`, `waitRun.test.ts`, `watchList.test.ts`, `toolInput.test.ts`

**Interfaces (after go):**
- Consumes (C0): `PROTOCOL_TABLE`, `host.supports('watchRate')`.
- Produces C#:
  ```csharp
  // IWatchBackend (additive; ReadWatched() keeps reading every item when no groups were set)
  void SetRateGroups(IReadOnlyList<int> groupOfItem);                       // index-aligned with the last Resolve; 0 = every tick
  IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> ReadWatchedGroup(int group);   // full-length, cells of other groups are (null, null, null)
  // WatchRow gains: IReadOnlyList<int>? R  (JsonIgnore WhenWritingNull): indexes of cells that repeat the previous value
  ```
  Wire: `{"id":1,"op":"watch","symbols":["MAIN.nFast","MAIN.sText"],"everyMs":[0,500]}` (`everyMs` optional, index-aligned, `0` or absent = every tick; at most 4 distinct non-zero values, else `ok:false` with `at most 4 different sample rates are allowed.`); rows: `{"t":1730539200000,"v":["42","Wait"],"r":[1]}`.
- Produces TS: `Row.r?: number[]`; `WatchEntry { symbol: string; ai: boolean; everyMs?: number }`; `WatchList.aiEdit(add: string[], remove: string[], rates?: Record<string, number>)`; `parseWatchInput` returns `rates: Record<string, number>` (symbol -> everyMs, integer 20-60000, `0` clears; a value below the poll interval means the poll interval, said in the result text); `ads_watch` schema gains `rates` (object, `additionalProperties: { type: number }`, `Per-symbol read period in ms, e.g. {"MAIN.sStepText": 500}; 0 clears. Slow symbols repeat their last value between reads.`).

- [ ] **Step 1: Spike: does a slow group pay off? (about 2 h, against a simulation target, no repo change)**

Measure with `iecode ads serve` over stdin and a throwaway script in the scratchpad that sends `interval` 10 and a `watch` list, then records the `t` of consecutive rows for 30 s (median and 95th percentile of the spacing in ms) and the host's CPU (Task Manager or `Get-Process`). Conditions: N in {5, 20, 50, 100, 200}; list A = N INT/BOOL symbols; list B = the same N where 80 % are STRING(80) symbols; list C = only the 20 % non-string symbols of B. Record all numbers in "E2 findings" with `[measured]`.

Go/no-go: **go** if list B's median spacing at N = 50 is at least 1.4 times list C's (the slow symbols make up at least 30 % of the poll cost, so reading them at 500 ms lets the fast ones run noticeably faster), or if 200 symbols cannot hold 100 ms in list B but can in C. **No-go** otherwise: the task ends here, no code; the wishlist row becomes `Out of scope: measured, a slow group saves less than 30 % of the poll time (see plan E2 findings)`; the rest of this task is deleted.

- [ ] **Step 2: (go) Write the failing C# tests**

```csharp
[Fact] public void Watch_with_everyMs_reads_the_slow_group_only_when_due()   // FakeBackend counts ReadWatchedGroup(0) and (1): 10 ticks of 100 ms with everyMs 500 -> group 1 read on ticks 1, 6 (first tick immediately)
[Fact] public void A_row_between_slow_reads_repeats_the_slow_value_and_marks_it()    // r == [1], v[1] == the previous value
[Fact] public void The_fast_cells_are_not_delayed_by_the_slow_group()        // every row has a fresh fast value
[Fact] public void More_than_four_distinct_rates_are_refused_with_the_limit_text()
[Fact] public void A_new_watch_resets_the_due_times()
[Fact] public void A_slow_item_error_is_reported_once_and_repeats_as_null_without_r()   // errors are never "repeated" values
[Fact] public void Watch_without_everyMs_is_byte_identical_to_before()       // no "r" field, ReadWatched() path
// AdsWatchBackendTests
[Fact] public void SetRateGroups_prepares_one_sum_read_per_group()           // FakeLink counts PrepareRead calls: 2 for groups {0, 1}
[Fact] public void ReadWatchedGroup_returns_full_length_rows_with_empty_cells_for_other_groups()
```
Run: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~Watch_with_everyMs"` (PowerShell tool). Expected: compile error (missing members).

- [ ] **Step 3: (go) Implement the CLI side, run the C# tests, commit**

`WatchHost`: parse `everyMs` in `DoWatch` (new optional parameter next to `Symbols(root)`), keep `_groupOfItem`, `_lastValues`, `_nextDue[group]`; in `Poll(now)` read group 0 always and every other group when `now >= _nextDue[group]` (then `_nextDue[group] = now + everyMs`), merge into one row with `R` listing the indexes of cells not read in this row (their value is the last value; before the first read the cell is `null` without `R`). `AdsWatchBackend.SetRateGroups` builds one `PrepareRead` per group over the indexes of `_sumIndex`; the existing `ReadWatched()` stays for lists without groups. Protocol table: feature `watchRate` in the T2 entry. `cli/README.md`: add the `everyMs` request field and the `r` row field to "Live values".

Run: both `dotnet test` commands (Core tests, then Automation tests, one after the other). Expected: pass.

```bash
git add cli/src cli/tests cli/README.md
git commit -s -m "Read slow ADS symbols at their own rate" -m "One sum read for every symbol every tick made a 10 ms pulse pay for the 500 ms texts. Items now sit in rate groups with one sum read each; a cell between two reads repeats its value and is marked, so a client never mistakes it for a new observation."
```

- [ ] **Step 4: (go) Write the failing TypeScript tests**

```ts
// adswatch.test.ts
test('ScopeBuffer.push skips repeated cells: no new point, latest keeps its time', ...)   // row { t: 2000, v: ['1', 'a'], r: [1] } after { t: 1000, v: ['0','a'] } -> series of item 1 has 1 point, latest('S').t === 1000
test('parseWatchList keeps everyMs and drops values that are not integers 20-60000', ...)
// waitRun.test.ts
test('a repeated cell is not an observation: it neither meets nor sets the changes baseline', ...)   // row.r includes the column
// watchList.test.ts
test('aiEdit with rates sets everyMs on the entry and 0 clears it', ...)
test('a user edit that renames or re-adds an entry keeps its rate only when the symbol is unchanged', ...)
// toolInput.test.ts
test('parseWatchInput accepts rates and rejects a value outside 0 or 20-60000', ...)   // `rates["MAIN.sText"] must be 0 or an integer from 20 to 60000`
```
`adsToolText.test.ts`: `watchResultText` appends `Read period: MAIN.sText every 500 ms (repeats its last value in between).` per rated symbol (one line each), and `Read period below the poll interval (100 ms) reads at the poll interval: MAIN.nFast.` for a value below the poll; old calls byte-identical. `featureMissingText('ads_watch rates', 'watchRate')` is returned when `!supports('watchRate')`: `ads_watch rates needs a newer iecode CLI (feature "watchRate"); run "IECode: Install CLI" to update it.`

- [ ] **Step 5: (go) Run to see them fail, implement, run again**

Run: `cd extension && npm test` (fail), implement as in the interfaces, `cd extension && npm test` (pass). `host.ts` builds `everyMs` from `entries()` when any entry has a rate and only when `supports('watchRate')`; otherwise the watch request is the old one and the tool result says the rate was ignored with `featureMissingText`.

- [ ] **Step 6: (go) Manifest, CHANGELOG, commit**

`ads_watch` `modelDescription` gains a sentence: `rates sets a slower read period for single symbols (for example a text at 500 ms) so the fast ones keep their rate.` CHANGELOG: ``- `ads_watch` accepts `rates` to read single symbols (texts, slow values) at their own period, so a 10 ms pulse is not slowed down by the rest of the list. Needs the matching iecode CLI.``

```bash
git add extension/src extension/package.json extension/CHANGELOG.md extension/test
git commit -s -m "Offer per-symbol read periods in ads_watch" -m "The host can now read slow symbols less often; the tool passes the period through the protocol table gate and the buffer and the wait ignore repeated cells, so the numbers in the series stay real observations."
```

**E2 findings** (filled by step 1): table N x list A/B/C with median and p95 spacing and CPU, and the go/no-go line.

---

### Task E6: Alarms: spike, then `ads_alarms` (conditional)

**Files:** after a go: Create `extension/src/core/alarms.ts`, `extension/test/alarms.test.ts`; Modify `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`, `cli/src/IECode.Automation/IECode.Automation.csproj` (the one package reference), `TargetCommands.cs`, `cli/README.md`, `extension/src/ads/host.ts`, `adsTools.ts`, `lmTools.ts`, `mcpTools.ts`, `toolInput.ts`, `adsToolText.ts`, `package.json`, `CHANGELOG.md`, `NOTICE` (third-party notice if the licence asks for it). After a no-go: only `docs/ads-mcp-wishlist.md` (row text).

- [ ] **Step 1: Spike checklist (about half a day; throwaway console project outside the repo; user decision: no dependency before a go)**

Record each answer under "E6 findings" with `[measured]` or `[read from the package]`:

1. **Package and licence.** Which package reads active alarms (candidate named in the roadmap: `Beckhoff.TwinCAT.TcEventLoggerAdsProxy`; confirm the exact id and version on the package feed). Read its `.nuspec` licence field and licence file; answer: may a public open-source repository reference it and ship its DLLs in the CLI release archive (`packaging/`)? Does it need a TwinCAT installation or a runtime licence on the engineering PC? Is a third-party notice needed (`NOTICE`)?
2. **Function.** Against a remote target through the ADS route (the TwinCAT EventLogger service, ADS port 132): connect, read the active alarms, read their texts for a language id, read the raised time, source, event id, severity and confirmation state. Record the member names that work, and what happens when the logger is not running or the target is unreachable (exception type, time to fail).
3. **Behaviour.** Text language when the target has several; whether cleared alarms of the last N seconds can be read (needed for `sinceSeconds`) or only active ones; the connection cost (time for connect and first read).
4. **Footprint.** CLI output size change and whether a single-file publish still works (`packaging/`); whether the package works on a machine without TwinCAT (the CLI already needs the ADS router, check what else it pulls in).

Go criteria (all must hold): licence permits redistribution in an open-source tool, or the package can be referenced without shipping it (documented download step); active alarms readable from a remote target; no TwinCAT installation required beyond what `ads serve` already needs; size increase under 5 MB `[estimated threshold, adjust with the user]`. Otherwise **no-go**. Outcomes: **go** -> steps 2-8; **no-go** -> change the wishlist row `Active alarms or the last N logger messages` to `Out of scope: <reason from the findings>` and the task ends; **partial** (active alarms only) -> go with `sinceSeconds` removed from the interface below.

- [ ] **Step 2: (go) Write the failing C# tests**

```csharp
// WatchHostTests (FakeBackend.AlarmsFn)
[Fact] public void Alarms_op_returns_the_active_alarms()            // data[0]: raised (epoch ms), source, eventId, severity "Error", text, confirmed false
[Fact] public void Alarms_op_passes_the_language_id()               // {"op":"alarms","language":1031} -> FakeBackend.LastLanguage == 1031
[Fact] public void Alarms_op_with_an_unreachable_logger_is_a_reply_error_not_a_lost_connection()   // ok:false, error text; no state event
// AdsWatchBackendTests (a fake IAlarmLink next to FakeLink)
[Fact] public void ReadAlarms_maps_the_logger_alarms_to_records()
[Fact] public void ReadAlarms_maps_a_logger_exception_to_an_AdsFault_with_the_message()
```
Records: `public sealed record WatchAlarm(long Raised, string Source, uint EventId, string Severity, string Text, bool Confirmed, long? Cleared);` `IWatchBackend.ReadAlarms(int? language)`; the Beckhoff types stay behind a new internal `IAlarmLink` in `AdsLink.cs` so the SDK is faked in tests like `IAdsLink`.

- [ ] **Step 3: (go) Run to see them fail, implement, run to see them pass, commit**

Run (PowerShell tool, one command at a time): `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~Alarms_op"` (fails), implement, rerun (passes); `dotnet test cli/tests/IECode.Automation.Tests --filter "FullyQualifiedName~ReadAlarms"`. Protocol: feature `alarms` in the T3 entry.

```bash
git add cli/src cli/tests cli/README.md NOTICE
git commit -s -m "Add an alarms op to the ADS watch host" -m "Active alarms were only visible in the engineering tool. The logger package is referenced only after the licence, remote-access and footprint spike came out as go; the SDK sits behind a link interface so the mapping is tested with a fake."
```

- [ ] **Step 4: (go) Write the failing TypeScript tests**

```ts
test('parseAlarmsInput: sinceSeconds optional, integer 1-86400, max 1-200 default 50', ...)   // `sinceSeconds must be a finite number`
test('alarmsText lists active alarms newest first with time, severity, source, event id, text and state', () => {
  assert.equal(alarmsText({ target: 'local', alarms: [{ raised: 3000, source: 'Machine.Axis1', eventId: 4711, severity: 'Error', text: 'Axis 1: following error', confirmed: false }], clock: ms => `T${ms}`, max: 50 }),
    'Active alarms on local (1):\nT3000  Error  Machine.Axis1  event 4711  "Axis 1: following error"  unconfirmed');
});
test('no alarms is a normal result', () => assert.equal(alarmsText({ target: 'local', alarms: [], clock, max: 50 }), 'No active alarms on local.'));
test('more than max alarms are cut with a count', ...)   // `(12 more not listed)`
test('a host without the feature answers with the missing-feature text', ...)   // `ads_alarms needs a newer iecode CLI (feature "alarms"); run "IECode: Install CLI" to update it.`
```
Run `cd extension && npm test` (fail), implement `alarms.ts`, `parseAlarmsInput`, `alarmsText`, `AdsHost.alarms()`, `adsTools.alarms`, MCP and Copilot wiring, manifest (`displayName` `ADS Alarms`; `modelDescription`: `Returns the active alarms of the TwinCAT EventLogger on the configured target: time raised, severity, source, event id, text and confirmation state. With sinceSeconds it also lists alarms raised or cleared in that span. Needs a recent iecode CLI.`; `inputSchema` `sinceSeconds`, `max`), CHANGELOG (``- New tool `ads_alarms` (Copilot: `adsAlarms`) lists the active alarms of the TwinCAT EventLogger of the target. Needs the matching iecode CLI.``), rerun (pass).

```bash
git add extension/src extension/package.json extension/CHANGELOG.md extension/test
git commit -s -m "Add ads_alarms for the active TwinCAT alarms" -m "Error texts of a sequence were gone once the machine handled the error. The tool reads them through the new host op and says so plainly when the CLI is too old."
```

**E6 findings** (filled by step 1): the four answers and the go/no-go line.

---

### Task E7: PLC-cycle timestamps: spike, then notify mode (conditional)

**Files:** after a go: Modify `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`WatchNotifyEvent`, `IWatchBackend.StartNotify/StopNotify/DrainNotifications`), `WatchHost.cs` (`mode` in `watch`, queue drain in `Tick`), `cli/src/IECode.Automation/AdsWatchBackend.cs`, `AdsLink.cs`, `TargetCommands.cs`, `cli/README.md`; `extension/src/core/adswatch.ts` (`ScopeBuffer.pushEvents`), `waitRun.ts` (events), `host.ts`, `toolInput.ts`, `adsToolText.ts`, `package.json`, `CHANGELOG.md`. After a no-go: the wishlist row only.

- [ ] **Step 1: Spike checklist (about half a day; throwaway console project outside the repo; one task only, per the user decision)**

Record under "E7 findings" with `[measured]`:

1. **Timestamps.** `AddDeviceNotification` (`AdsTransMode.OnChange`, cycle time 0) for a BOOL and an INT toggled by one task: the stamp type (FILETIME of the task cycle), its resolution, and whether two symbols changed in the same cycle carry identical stamps (measure 1000 pairs; report the share with identical stamps). Whether a stamp is the task cycle start or the change time.
2. **Cost.** 50, 100 and 200 notifications: CPU of the host, notification latency versus the poll (`t_receive - t_plc`), lost or merged events with `maxDelay` 0 and 100 ms (compare the received count with a PLC-side counter).
3. **Thread hand-off.** Callbacks arrive on ADS threads; prove a `ConcurrentQueue` filled by the callbacks and drained by `WatchHost.Tick` loses nothing and keeps per-symbol order at 200 events/s; measure the added latency (`Tick` runs every poll interval, so up to one interval).
4. **Reconnect and download.** After a connection loss and after a download/online change: do callbacks of the old connection still arrive, are handles invalid, what exception shows up; confirm that all queued events of the old connection can be recognised (connection generation counter) and dropped.
5. **Clock.** The offset between the PLC stamp and the host clock (`DateTimeOffset.UtcNow`) over 10 minutes: stable, drifting? Decide: either convert PLC time to host time with a re-measured offset (one clock per buffer) or keep PLC time and mark the buffer's clock; record the choice.
6. **Series.** What feeds the numeric plot series in notify mode: change events only (step plot) versus one polled row per interval (default to test: keep polling for the series and use notifications only for the change log and `ads_wait`).

Go criteria: stamps have task-cycle resolution and symbols of one task show identical stamps in at least 99 % of same-cycle changes; no lost events at 200 symbols with `maxDelay` 0 or a documented `maxDelay`; the queue hand-off is lossless; old-connection events are recognisable. Otherwise **no-go**. Outcomes: **go** -> steps 2-7; **no-go** -> wishlist row `PLC-cycle timestamps via ADS notifications` becomes `Out of scope: <measured reason>`; **partial** (stamps unreliable for the order, usable for latency) -> no-go for the order promise, wishlist note only.

- [ ] **Step 2: (go) Write the failing C# tests**

```csharp
[Fact] public void Notifications_from_another_thread_are_emitted_by_Tick_in_order()      // FakeBackend raises 100 events from a Task, Tick emits events { gen, t, i, v } in per-symbol order
[Fact] public void Reconnect_drops_queued_events_of_the_old_connection()                 // Review Focus 7: events enqueued before MarkLost never appear after the new connection
[Fact] public void A_new_watch_clears_the_queue_and_starts_a_new_gen()
[Fact] public void Poll_mode_output_is_unchanged_when_mode_is_not_notify()
[Fact] public void Notify_without_a_task_stamp_falls_back_to_the_host_clock_and_says_so()   // only if the spike found stamps can be missing
// AdsWatchBackendTests
[Fact] public void StartNotify_registers_one_notification_per_symbol_and_StopNotify_removes_them()
[Fact] public void DrainNotifications_returns_events_tagged_with_the_connection_generation()
```
Wire: `{"id":1,"op":"watch","symbols":[...],"mode":"notify"}`; events `{"event":"changes","gen":2,"changes":[{"t":<ms>,"i":0,"v":"TRUE"}, ...]}` (`t` in the clock the spike chose; additionally `{"event":"clock","offsetMs":<n>}` once if the PLC clock is converted). Protocol feature `notify` in the T3 entry.

- [ ] **Step 3: (go) Run to see them fail, implement, run to see them pass, commit**

Run (PowerShell tool, one command at a time): `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~Notif"`; implement; rerun; then `dotnet test cli/tests/IECode.Automation.Tests --filter "FullyQualifiedName~Notify"`. The host loop stays single-threaded: callbacks only enqueue, `Tick` drains and emits.

```bash
git add cli/src cli/tests cli/README.md
git commit -s -m "Add an opt-in notify mode to the ADS watch host" -m "Polling cannot prove the order of two events a few cycles apart. Notifications arrive on ADS threads, so they only fill a queue that Tick drains; events of an old connection carry its generation and are dropped after a reconnect."
```

- [ ] **Step 4: (go) Write the failing TypeScript tests**

```ts
// adswatch.test.ts
test('pushEvents appends change-log entries with the PLC time and keeps the numeric series untouched', ...)
test('pushEvents of another gen is ignored', ...)
test('events of one cycle share a timestamp and the table gets a cycle column', ...)   // two symbols, same t -> same `cycle` number, header `t[s]\tcycle\t<symbols>`
// waitRun.test.ts
test('a change event meets a condition like a row and reports the PLC time', ...)
// toolInput.test.ts
test('parseWatchInput accepts mode "poll" or "notify" and rejects others', ...)   // `mode must be "poll" or "notify"`
// adsToolText.test.ts
test('a notify table says what equal times mean', ...)   // line `Equal times mean the same task cycle; the order of changes inside one cycle is unknown.`
```
The promise text is fixed by the user decision: `Times are PLC task-cycle times of one task; changes of symbols of different tasks are not ordered.`

- [ ] **Step 5: (go) Run to see them fail, implement, run to see them pass**

Run: `cd extension && npm test` (fail), implement `ScopeBuffer.pushEvents`, the per-gen column mapping for `changes` events in `host.ts`, `mode` in `parseWatchInput` and `ads_watch` (schema `mode`: enum `poll`, `notify`, default `poll`; `modelDescription` sentence: `mode notify records changes with PLC task-cycle times for symbols of one task; the default poll is better for plots.`), the `cycle` column, rerun (pass).

- [ ] **Step 6: (go) CHANGELOG and commit**

CHANGELOG: ``- `ads_watch` accepts `mode: "notify"` to record value changes with PLC task-cycle times (symbols of one task); `ads_scope` then shows a `cycle` column. The order of changes inside one cycle and across tasks is not promised. Needs the matching iecode CLI.``

```bash
git add extension/src extension/package.json extension/CHANGELOG.md extension/test
git commit -s -m "Use PLC cycle times in notify mode for the wait and the change table" -m "The extension takes change events with a PLC task time instead of polled rows for the change log and ads_wait; one clock per buffer, as decided in the spike."
```

**E7 findings** (filled by step 1): the six answers and the go/no-go line.

---

### Task E9: Release

**Files:** `extension/CHANGELOG.md`, `docs/ads-mcp-wishlist.md`, `cli/README.md`, `TODO.md`, `docs/superpowers/plans/2026-11-09-ads-wishlist-e-runtime-and-plc.md` (findings)

- [ ] **Step 1: Check the documents**

CHANGELOG has one line per user-visible change of E1, E3, E4, E5, E8 and, per outcome, E2, E6, E7, in the style of the `ads_wait` entry (state the tool and Copilot name, what it does, and the limit). `cli/README.md` "Live values" lists the new ops and fields (`state`, `everyMs`, `r`, and per outcome `alarms`, `mode`, `changes`). `TODO.md` keeps the cross-task event order item. The wishlist rows (`Poll interval and buffer length ...`, `Resume watch sampling ...`, `ads_state ...`, `Trigger and capture ...`, `A one-call overview ... / Component mode ...`, `Per-symbol sample rate`, `Active alarms ...`, `PLC-cycle timestamps ...`) change to Done with the test names, or to Out of scope with the findings reason.

- [ ] **Step 2: Full test runs**

Run: `cd extension && npm test`
Expected: all pass (previous count plus the new tests, 0 failed).

Run (PowerShell tool, one at a time): `dotnet test cli/tests/IECode.Core.Tests` then `dotnet test cli/tests/IECode.Automation.Tests`
Expected: all pass.

- [ ] **Step 3: Manual check against a simulation target (Extension Development Host, PLC in run mode, MCP connected)**

Record each line in the PR:

1. `ads_config {}` shows the values and the estimate; `ads_config { pollMs: 20, bufferSeconds: 600 }` with 200 watched symbols asks for a confirmation naming the estimate (cancel it: `Not changed ...`); with 5 symbols it applies without a dialog; changing `iecode.ads.sampleIntervalMs` in the settings afterwards wins again.
2. `ads_preset {}` lists the presets; `ads_preset { path, preset }` on a real function block prints one block; one wrong member name is named at the end, the others are printed.
3. `ads_watch add` three symbols, close all views, wait 60 s, call `ads_scope`: it carries the notice from E3 (and, if built, shows history thanks to the keep-alive).
4. `ads_state` before and after a TwinCAT restart: the second call prints `Restart detected: the cycle count went from <n> to <m> since the last call at <time>.`
5. `ads_capture { symbol: <BOOL pulse>, condition: "= TRUE", preSeconds: 3, postSeconds: 3 }` returns a table with the trigger at 0.000. Then **restart the PLC during the post window** of a second capture: the capture ends partial with the connection-loss text within `postSeconds` plus 3 s and still returns the table it has; the next `ads_watch` call starts with the connection notice.
6. Per outcome: a symbol at `rates` 500 ms next to a 10 ms symbol (E2), `ads_alarms` (E6), a notify-mode change table with the `cycle` column (E7).
7. An older CLI (the previous release) with the new extension: `ads_state` and `rates` answer with the "needs a newer iecode CLI" text, every other tool works.
8. Record the live check of `ads_wait` that is still open (done together with Plan A).

- [ ] **Step 4: Commit**

```bash
git add extension/CHANGELOG.md docs/ads-mcp-wishlist.md cli/README.md TODO.md docs/superpowers/plans/2026-11-09-ads-wishlist-e-runtime-and-plc.md
git commit -s -m "Document the runtime tools and close the wishlist rows of Plan E" -m "Every tool of Plan E is checked by hand against a simulation target, including a PLC restart during a capture; the wishlist rows carry the test names or the measured reason for a no-go."
```

---

## Open decisions

1. **Keep sampling alive after the last AI tool call (E3, only if H1 reproduces).** Recommendation: yes, `iecode.ads.aiKeepAliveSeconds` default 300 while AI-added entries exist (matches the default buffer of 300 s; costs one ADS connection for a few more minutes). The alternative is notice only, which tells the agent but does not give it the history.
2. **`ads_config` scope and confirmation threshold (E1).** Recommendation: session override only (the user's settings stay untouched) and a confirmation above 1 000 000 stored values when the change raises memory use. The alternative of writing the user's settings makes a one-line agent call change a permanent setting.
3. **Input shape for per-symbol rates (E2, only after a go).** Recommendation: a separate `rates` map on `ads_watch` (`{ "MAIN.sText": 500 }`), because `add` stays a string array and old callers keep working. The alternative of objects inside `add` changes the existing schema.

## Self-review

- **Spec coverage:** E1 (wishlist 4 poll/buffer, roadmap D17 memory), E2 (4 per-symbol rate), E3 (2 resume + notice), E4 (7 `ads_state`), E5 (2 capture), E6 (7 alarms, Phase 9, decision 3), E7 (2 notifications, Phase 8, decision 4), E8 (7 overview and component mode via presets), E9 (release, manual check with a restart during a capture). Review Focus lines 1-8 each name their test.
- **Type consistency:** `Sampling`/`BufferEstimate` (E1) are used by E5 (`capacitySeconds` from `bufferEstimate(...).effectiveSeconds`); `ToolNames` gains `config`, `preset`, `state`, `capture` (and `alarms`) once each, all in `adsToolText.ts`; `Row.r` (E2) is the same name in C# (`R`, camelCase `r`) and TypeScript; `featureMissingText(tool, feature)` is defined in E4 and reused by E2, E6; `WatchEntry.everyMs` and `Record<string, number>` rates match across `parseWatchInput`, `WatchList.aiEdit` and the host request (`everyMs` array). `CaptureDeps extends WaitDeps` reuses the exact `WaitDeps` members of `waitRun.ts`. Protocol features: `state`, `watchRate`, `alarms`, `notify`.
- **Placeholders:** the only open values are the ones a spike produces on purpose (`BYTES_PER_VALUE`, thresholds in the findings, the A3 renderer shape), each with the rule that sets it.
- **Proportion:** signatures, test names and pinned strings; bodies are left to the implementer. E2, E6 and E7 TDD steps are marked conditional on their go.


## Review amendments (2026-11-10)

From the engineering review of this plan. These override the task text above where they differ.

1. **One missing-feature text (E2, E4, E6).** Do not define `featureMissingText(tool, feature)` here; C0 owns `featureMissingText`, `FEATURE_LABELS` and `HostCaps.missing`. Add labels `state`, `watchRate`, `alarms`, `notify`; E tests pin the C0 wording.
2. **Check after the host started (E2, E4).** `adsTools.state` and the `rates` path call `await host.ready()` first and only then check the capabilities; otherwise an idle-stopped host or a fresh window answers "needs a newer CLI" with a current CLI. Put this decision in a pure function in `core/` (`plcState.ts`) and test: idle host, old CLI, current CLI.
3. **E5 consumes the real change log.** `ScopeBuffer.changes` returns A3's `ChangeLog` (`entries`, `start`, `olderDropped`, `startUnknown`); `changesTableText` is built on it and keeps `unknown (history dropped)` and `older changes dropped`.
4. **`StateTracker` key (E4).** Keyed by target and task (`taskIndex`); a call for another task never compares counters. Restart rules: `cycleCount` went down or `onlineChangeCount` reset to 0 (both are named, priority tested); a 32-bit wrap is not a restart (a drop of more than 2^31 is a wrap); the text says a restart between two calls is invisible when the new count already passed the old one.
5. **Protocol entry.** `state` and `watchRate` go into the open entry of the unreleased CLI; if that entry is already released, open the next one (Plan C amendment 1). No edits to a released entry.
6. **E2 promise.** Replace "rows of the fast symbol are not delayed" by "a slow group never makes a row older than the poll interval; the base group is read first and the row is emitted after the due groups". The go criterion adds an absolute limit (median spacing of the fast symbol within 1.5x of the poll interval and p95 within 3x), not only the 1.4x ratio. Add tests: `rates` for an unlisted symbol (refused with a clear text), group assignment after a re-resolve (download).
7. **E3 conditional code.** `idleDelayMs` and `shouldRestart` move into the conditional steps (H1 and H3); they are not created on other outcomes. `lost` is recorded only after a first `connected: true`; a `restart()` caused by a settings change records `restarted`, not `stopped`; a new connection starts `seen` at the current event count; `ads_read` shows the same notice; `touchAi` re-arms the idle timer of `scope` (no lease). The record logic goes into `samplingLog.ts` as a pure function with tests (initial `connected:false`, restart by settings, expired keep-alive, `aiEntries` going to 0).
8. **E1.** The "which setting change drops which override" decision moves into `adsConfig.ts` with a test; a late Apply click after the 60 s timeout must not call `apply` (test); an `apply` rejection gives an error text (test); the confirmation threshold is judged against the memory estimate including text symbols and the change log of A3 (`BYTES_PER_VALUE` measured for text too, or an `[estimated]` upper bound).
9. **E5.** `capacitySeconds` counts the trigger symbol (judged after the holds are planned, not before); duplicates in `holdSymbols` are merged; a hold of an already watched symbol sends no request; `postSeconds: 0` is tested; the total of 190 s is checked against the MCP client timeout of `mcpServer.ts` and capped to it.
10. **E7.** The notification queue gets a cap (10,000 events, oldest dropped, counted and said in the text).


## Review amendments, round 2 (2026-11-10)

From the second, independent review. These override round 1 and the task text.

1. **Capture keeps its own history (E5).** A user removal calls `deps.set` first and `ScopeBuffer.setItems` then drops the history, so holds do not protect against it. `runCapture` records the change entries of its symbols into its own recorder from the start of the call (or copies them before the destructive apply). Integration test with a real `WatchList` and a real `ScopeBuffer`: the user removes a symbol, the capture ends partial, the earlier values stay in the table.
2. **Deadline and abort from the first moment (E5).** One monotonic deadline and abort/target-change monitoring start when `ads_capture` is called and cover all holds; the time the trigger is armed is defined (after the holds); a trigger during the preparation is handled, not ignored. The 190 s claim is replaced by the sum of the real limits. The MCP client timeout is not known to the extension (`mcpTools.ts:86` only holds a Claude-measured lower bound); do not assert it.
3. **Gaps during a capture (E5).** Connection and sampling gaps are tracked over the whole capture and reported even after a reconnect (`captured with gaps` or partial). The result keeps requested and observed window bounds separately. Test: a short outage that recovers before the post window ends.
4. **E2 promise (replaces round 1 item 6).** No absolute latency promise. The task separates sample time, row spacing and delivery latency. The throwaway prototype measures several due groups together and slow or failing reads; if fast results must be delivered independently of slow groups, a shared row after all reads is not enough and the go is withheld.
5. **E7 observation contract.** Before any code define: the initial value (an unchanged value gives no notification, so `ads_wait ... = TRUE` needs a first observation), the raw enum value in the wire format, a single change-log source per mode (poll or notify, never both), time ordering, and explicit loss markers handed to running waits and captures. Tests: a condition already true, a late notification against a poll row, an enum comparison, a queue overflow during a capture.
6. **Host API (E4, E2, E6).** Replace every `host.supports(...)` by `host.requires(feature)` or, after `ready()`, `host.hostCaps()`; a start error and a missing feature stay distinguishable (both tested).
7. **State tracker (E4; replaces round 1 item 4, wrap rule).** A wrap and a reset can both look like a drop; report them as ambiguous findings, use time and cycle information to plausibilise, and drop "everything is reset" from the manifest text (PERSISTENT data survive a restart). Tests: high count then real reset, normal wrap, long observation gap. `OnlineChangeCnt` behavior is a spike result, not an assumed signature.
8. **Capture capacity (E5).** Keep the configured span, the numeric capacity, the change-log losses and the real coverage per symbol apart; the 100,000-entry change log (about 500 entries per symbol for 200 symbols) is a second limit that `ads_config` cannot raise. A global `oldestMs()` is not the history start of every symbol.
9. **`ads_config` (E1).** Config changes are serialised; immediately before applying, the configuration revision and the memory assumptions are checked; if they changed the plan is made again and confirmed again. Tests: two config calls in parallel, a setting change, a larger watch list during the dialog.
10. **Apply order (E1).** The host operation (`setInterval`) runs first; the destructive trim runs after it succeeded; remaining partial effects are reported. After a failure `sampling()`, the local buffer and the host state agree or are marked as different. Test the consistency, not only the message.
11. **Estimate contract (E1).** Define a conservative total bound or a per-component estimate (numeric values, text values, change log); the confirmation threshold is expressed in bytes derived from a stated reference. Capacity numbers are never presented as guaranteed history.
12. **`reloaded` event (E3).** `items` is sent only when the published items differ (`WatchHost.cs:204-213`), so a download with an unchanged list gives no event. Either add an explicit reload event with a reason to the CLI protocol or word the notice as `item metadata changed`. Test the download-with-unchanged-list case.
13. **Event cursor (E3).** The cursor is a monotonic event id; wall-clock time is for display only. Define the cap loss, split lost/restored pairs across tool calls, and the `restarted` event with renderer and tests.
14. **One watch-request builder (E2, E7).** Rates and mode are built by one function used by `host.ts`, `setWatched`, `afterHello`, user edits and the holds of wait and capture; an idle restart and a later watch call without `mode` keep the mode. Tests for each path.
15. **E6 contract.** After the spike fix the whole contract through tool, host, backend and SDK: time filter, active versus history, language, order, limit. Test a cleared alarm inside and outside the time window; `sinceSeconds` is removed on a partial go.
16. **Blocking operations (E4, E6, keep-alive).** New operations get a time and work budget and a stated behavior when exceeded; a slow alarm query may belong in its own process. The extension timeout does not stop a running synchronous backend call. The keep-alive keeps the whole sampling alive (the TODO notes about 16 % host CPU at 21 symbols and 10 ms), so it is documented as continuing ADS, CPU and memory load, not "one connection".
17. **Compilable steps (E1, E4, E5).** The signature, the real `adsTools()` implementation, the descriptor fixtures (`mcpTools.test.ts` lines 42, 45, 78, 222), the manifest and the registrations land in one compiling step; before that only the isolated pure tests are expected green.
18. **Release (E9).** An outcome matrix over the eight go/no-go combinations of E2, E6, E7 decides manifest, labels, docs, tests and the table entry; `everyMs`/`r` and the `rates` test are conditional on the E2 go. E9 owns the release pin (Plan C round 2 item 9). The E4 commit lists `hostProtocol.ts` and `hostProtocol.test.ts`.
19. **Serializer (E4).** The serializer uses `JsonIgnoreCondition.Never`, so `WatchStateData` gets `JsonIgnore(WhenWritingNull)` on the optional counters, and the missing-counter case is tested from the serialized reply to `parsePlcState`.


## Open questions to ask at task start

Put each question to the user with its recommendation when the named task starts; write the answer and the date under it.

1. **E1, memory confirmation threshold.** The threshold is still a value count (`CONFIG_CONFIRM_VALUES`) although the estimate now has components (numeric values, text values, change log). Question: which byte reference should trigger the confirmation? Recommendation: 128 MB as the conservative total, measured with real text symbols in step 1.
   **Answer (2026-11-12):** 128 MB as the conservative total (user decision). The bytes per stored value were measured in E1 step 1: 71 numeric and 54 text, both with the test rows counted, so BYTES_PER_VALUE is 72.
2. **E2, sample age per symbol.** With per-symbol rates a fresh fast symbol hides an old slow one in `newestSample`, and no task prints a reliable age for watch results (the wishlist asks for it). Question: add a per-symbol age line to `ads_watch` and `ads_scope` summaries, with a stale rule that depends on the rate? Recommendation: yes, in E2 after the go; list-wide sampling activity and the age of one symbol are shown separately.
3. **E3, keep-alive default and cost.** Keeping sampling alive for 300 s keeps the whole sampling running (the TODO notes about 16 % host CPU at 21 symbols and 10 ms). Question: is 300 s the right default, and should it depend on the number of symbols? Recommendation: measure CPU at 21 and 200 symbols in the E3 reproduction; default 120 s above 50 symbols, 300 s below.
4. **E4 and E7, spike facts.** Names of the system info symbols, the task index, whether the cycle counter is a 32-bit value and how it behaves after a restart, `OnlineChangeCnt` after a restart, and the time base and precision of notifications are not known. Question: confirm the result of each spike before the text and manifest claims are pinned. Recommendation: no manifest sentence about a restart signature before the spike is recorded.
5. **E6, EventLogger.** Package and licence, redistribution, history access, remote access. Question: go, no-go or partial go after the spike (master decision 3)? Recommendation: no dependency before a written go.
