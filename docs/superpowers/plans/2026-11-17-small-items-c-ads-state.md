# Plan C: `ads_state` (PLC run state and restart detection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [small items master plan](2026-11-17-small-items-master-plan.md). Supersedes task E4 of [Plan E](2026-11-09-ads-wishlist-e-runtime-and-plc.md) and its amendments (round 1 items 2 and 4, round 2 items 6, 7, 16, 17 and 19); where the texts differ, this plan wins.

**Goal:** A new tool `ads_state` (Copilot: `adsState`) returns the PLC run state, the cycle time and cycle counter of a task and the online change count, and says when the PLC restarted or an online change happened since the previous call.

**Architecture:** The CLI watch host gets an op `state` (`IWatchBackend.ReadPlcState`), added to the still unreleased protocol entry 2 as op `state` and feature `plcState`. The extension parses the reply and compares it with the previous one in a pure `extension/src/core/plcState.ts`; the tool is declared once in `package.json` and served by MCP and Copilot like the other ADS tools.

**Tech Stack:** C# .NET (xUnit), `Beckhoff.TwinCAT.Ads`; TypeScript (`node --test`).

**Spec:** wishlist section 7, row "`ads_state`: run or stop state, task cycle time, cycle counter" ([ads-mcp-wishlist.md](../../ads-mcp-wishlist.md)); Plan E task E4 for the background.

## Global Constraints

- Public repository: generic names only. Commits: English subject plus a 1-3 sentence why-body, noreply address, `git commit -s`.
- Every tool is declared once in `extension/package.json` (`languageModelTools`, name `iecode_ads_state`, `toolReferenceName` `adsState`), listed in `LM_TOOL_NAMES` (`core/lmToolTable.ts`) and in `buildMcpTools`; the manifest lists in `test/mcpTools.test.ts:82` and `:235` gain `ads_state` at the end. Descriptions do not name Copilot tools.
- Protocol: entry 2 of `PROTOCOL_TABLE` is not released yet (master plan of 2026-11-09, C8 open), so `state` joins it; the pin `hostProtocol.test.ts:84` is updated in the same commit. If a CLI with protocol 2 was released before this plan runs, open entry 3 instead and bump `WatchHost.Protocol`.
- A missing feature answers with `featureMissingText` through `host.requires('plcState')` (starts the host first, so an idle host is not mistaken for an old CLI).
- Tests: `cd extension && npm test`; C# only through the PowerShell tool, build and test as separate commands, nothing heavy in parallel. If the running `iecode mcp` locks `IECode.Cli/bin`, build the test projects only.

## Decisions (taken by the planner, 2026-11-17)

1. **Names** (checked in Task 1 step 1 against a simulation before coding): `TwinCAT_SystemInfoVarList._TaskInfo[<task>].CycleCount` (UDINT), `.CycleTime` (UDINT, unit 100 ns, so `cycleTimeUs = CycleTime / 10`), `TwinCAT_SystemInfoVarList._AppInfo.OnlineChangeCnt` (UDINT). If a name does not resolve, its field is left out and `taskNote` says why; the run state still comes back.
2. **Task number** 1 to 16, default 1 (the PLC task index as in `_TaskInfo`).
3. **Restart rules** (`StateTracker`, keyed by target and task): with `elapsedMs` between the two calls and `expected = elapsedMs * 1000 / cycleTimeUs`:
   - count went down and the old count was within `1.5 * expected` of 2^32: `restartOrWrap` (a 32-bit wrap and a restart look the same);
   - count went down otherwise: `restart`;
   - count rose by less than half of `expected` (and `expected >= 100`): `slow` (the PLC was stopped, or restarted and already counted past the old value);
   - `onlineChangeCount` changed (and no restart finding): `onlineChange`.
   No finding on the first call per key or when a counter is missing. The texts never claim "everything is reset" (persistent data survive).
4. **Time budget:** the op reads the state and the three counters with one ADS state read and one sum read through the existing backend; each call has the ADS client timeout; the extension uses the normal request timeout.
5. **No change to `ads_watch`**: the restart finding is only in `ads_state` (Plan B already gives a reload notice).

## Review Focus

1. Task counters missing (old runtime, other name): reply without the counter fields, the tool prints the run state and the note. (Task 1, `ReadPlcState_without_the_system_info_symbols_returns_state_and_a_note`; Task 2, `stateText without counters`)
2. The serialized reply leaves out null counters and the TypeScript parser accepts it. (Task 1, `State_reply_omits_null_counters`; Task 2 parses that exact JSON)
3. A host from an older CLI: `ads_state` answers with the "needs a newer iecode CLI" text, the other tools work. (Task 2, `ads_state on a protocol-1 host gives the missing-feature text`)
4. Two tasks queried alternately never compare their counters. (Task 2, `the tracker is per target and task`)
5. PLC in Stop: the text says values are not updated. (Task 2, `stateText for a stopped PLC`)

## File Structure

- CLI: `cli/src/IECode.Core/Ads/WatchProtocol.cs` (`PlcState`, `IWatchBackend.ReadPlcState`, `WatchStateData`), `cli/src/IECode.Core/Ads/WatchHost.cs` (op `state`), `cli/src/IECode.Automation/AdsLink.cs` (`IAdsLink.ReadStateInfo`), `cli/src/IECode.Automation/AdsWatchBackend.cs` (`ReadPlcState`), `cli/src/IECode.Cli/Commands/TargetCommands.cs` (`UnavailableBackend`), `cli/README.md`; tests `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `FakeLink.cs`.
- Extension: create `extension/src/core/plcState.ts`; modify `core/hostProtocol.ts`, `core/adsToolText.ts` (`ToolNames.state`), `core/toolInput.ts` (`parseStateInput`), `core/mcpTools.ts` (`AdsToolFns.state`, registration), `core/lmToolTable.ts`, `ads/host.ts` (`plcState`), `ads/adsTools.ts`, `ads/lmTools.ts`, `package.json`, `CHANGELOG.md`; tests `test/plcState.test.ts` (new), `hostProtocol.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`.

---

### Task 1: `state` op in the CLI host

**Files:** as in File Structure, CLI part.

**Interfaces:**
- Produces C#:
  ```csharp
  // WatchProtocol.cs
  public sealed record PlcState(string AdsState, ushort DeviceState, long? CycleCount, long? CycleTimeUs, long? OnlineChangeCount, string? TaskNote);
  // IWatchBackend (default throws NotSupportedException so fakes keep compiling)
  PlcState ReadPlcState(int task);
  // AdsLink.cs, IAdsLink
  (AdsErrorCode Code, string AdsState, ushort DeviceState) ReadStateInfo();
  // WatchHost.cs: "state" => DoState(root); optional integer "task" 1..16, default 1
  internal sealed record WatchStateData(string AdsState, ushort DeviceState,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? CycleCount,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? CycleTimeUs,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? OnlineChangeCount,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TaskNote);
  ```
  Wire: `{"id":5,"op":"state","task":1}` -> `{"id":5,"ok":true,"data":{"adsState":"Run","deviceState":0,"cycleCount":1234567,"cycleTimeUs":10000,"onlineChangeCount":3}}`.

- [ ] **Step 1: Check the names against a simulation (about 30 min)**

With `iecode ads serve` (stdin): `{"id":1,"op":"read","symbols":["TwinCAT_SystemInfoVarList._TaskInfo[1].CycleCount","TwinCAT_SystemInfoVarList._TaskInfo[1].CycleTime","TwinCAT_SystemInfoVarList._AppInfo.OnlineChangeCnt"]}`. Record under "Findings": resolve yes/no, types, the unit of `CycleTime` (compare with the task's configured cycle), whether `CycleCount` restarts at 0 after a TwinCAT restart, `OnlineChangeCnt` after an online change and after a restart, the `AdsState` text in Run, Stop and Config. A differing name changes the constants only.

- [ ] **Step 2: Write the failing tests**

```csharp
// WatchHostTests.cs (FakeBackend gains StateFn and LastTask)
[Fact] public void State_op_returns_the_backend_state_and_passes_the_task()   // {"op":"state","task":2}: LastTask == 2, data adsState "Run", cycleCount 1234567
[Fact] public void State_op_defaults_to_task_1()
[Fact] public void State_op_rejects_a_task_outside_1_to_16()                   // 0, 17, 1.5, "2": ok:false, error "task must be an integer from 1 to 16."
[Fact] public void State_op_fault_with_lost_connection_marks_the_host_lost()   // AdsFault(connectionLost) -> state event connected:false, reply ok:false
[Fact] public void State_reply_omits_null_counters()                            // serialized data has no cycleCount key, has taskNote
// AdsWatchBackendTests.cs (FakeLink.StateInfo, fake system-info symbols)
[Fact] public void ReadPlcState_reads_state_and_task_counters()                 // CycleTime 100000 -> CycleTimeUs 10000
[Fact] public void ReadPlcState_without_the_system_info_symbols_returns_state_and_a_note()  // TaskNote starts "task counters not readable: "
[Fact] public void ReadPlcState_maps_a_failing_state_read_to_an_AdsFault()
```

- [ ] **Step 3: Run to verify they fail (PowerShell tool, separate commands)**

`dotnet build cli/tests/IECode.Core.Tests`, then `dotnet test cli/tests/IECode.Core.Tests --no-build --filter "FullyQualifiedName~State_"`. Expected: compile errors (`ReadPlcState`, `PlcState` missing).

- [ ] **Step 4: Implement.** `DoState` reads `task` like `DoInterval` reads `ms`; `AdsWatchBackend.ReadPlcState` calls `link.ReadStateInfo()` (code other than `NoError` -> `AdsFault` through the existing mapping) and reads the three names in one go; a missing symbol or a non-connection `AdsFault` becomes `TaskNote = "task counters not readable: <message>"`. `BeckhoffLink.ReadStateInfo` uses `_client.TryReadState(out var info)` and returns `info.AdsState.ToString()` and `info.DeviceState`. `UnavailableBackend.ReadPlcState` throws its stored fault.

- [ ] **Step 5: Run to verify they pass**, then both test projects in full (separate commands). Expected: all pass.

- [ ] **Step 6: README and commit**

`cli/README.md`, "Live values": ``← {"id":5,"op":"state","task":1}   PLC run state, cycle time and cycle counter of a task (1..16, default 1), online change count``.

```bash
git add cli/src cli/tests cli/README.md
git commit -s -m "Add a state op to the ADS watch host" -m "An agent cannot tell a restarted PLC from a quiet one by watching values. A missing system-info symbol is a note in the reply, not a failure, so the run state still comes back."
```

---

### Task 2: `ads_state` tool in the extension

**Files:** as in File Structure, extension part.

**Interfaces:**
- Consumes: Task 1 wire format; `host.requires(feature)` (`host.ts:512`), `featureMissingText` (`hostProtocol.ts`), `clock` in `adsTools.ts`.
- Produces:
  ```ts
  // plcState.ts
  export interface PlcStateReply { adsState: string; deviceState: number; cycleCount?: number; cycleTimeUs?: number; onlineChangeCount?: number; taskNote?: string }
  export function parsePlcState(data: unknown): PlcStateReply | string;   // string = 'unexpected reply to the state request'
  export type StateFinding =
    | { kind: 'restart' | 'restartOrWrap' | 'slow'; was: number; now: number; sinceMs: number }
    | { kind: 'onlineChange'; was: number; now: number; sinceMs: number };
  export class StateTracker { observe(key: string, s: PlcStateReply, nowMs: number): StateFinding | undefined }   // key = `${targetKey}#${task}`
  export function stateText(o: { target: string; task: number; state: PlcStateReply; finding?: StateFinding; clock: (ms: number) => string }): string;
  // toolInput.ts
  export function parseStateInput(raw: unknown): Parsed<{ task: number }>;
  // adsToolText.ts: ToolNames gains state ('ads_state' / 'adsState')
  // mcpTools.ts: AdsToolFns gains state(input: { task: number }): Promise<ToolText>
  // host.ts
  plcState(task: number): Promise<PlcStateReply>;   // leased, request({ op: 'state', task }), parsePlcState, throws on a string
  ```

- [ ] **Step 1: Write the failing tests** (`plcState.test.ts`, `clock = ms => \`T${ms}\``)

```ts
test('parsePlcState accepts the reply and rejects a shape it does not know', ...)   // also the exact JSON of Task 1 'State_reply_omits_null_counters'
test('a cycle count that went down is a restart', () => {
  const t = new StateTracker();
  t.observe('k#1', { adsState: 'Run', deviceState: 0, cycleCount: 1_000_000, cycleTimeUs: 1000, onlineChangeCount: 3 }, 1000);
  assert.deepEqual(t.observe('k#1', { adsState: 'Run', deviceState: 0, cycleCount: 12, cycleTimeUs: 1000, onlineChangeCount: 3 }, 9000),
    { kind: 'restart', was: 1_000_000, now: 12, sinceMs: 1000 });
});
test('a drop near 2^32 is restart or wrap', ...)          // was 4_294_960_000, cycle 1000 us, 10 s later now 5000 -> restartOrWrap
test('a count that rose far too little is slow', ...)     // was 1000, 60 s at 1000 us (expected 60000), now 2000 -> slow
test('a changed online change count is an online change', ...)
test('the tracker is per target and task', ...)
test('a missing counter or the first call finds nothing', ...)
test('stateText for a running PLC', () => {
  assert.equal(stateText({ target: 'local', task: 1, state: { adsState: 'Run', deviceState: 0, cycleCount: 1234567, cycleTimeUs: 10000, onlineChangeCount: 3 }, clock }),
    'PLC state on local: Run (device state 0).\nTask 1: cycle time 10.000 ms, cycle count 1234567, online changes 3.');
});
test('stateText for a stopped PLC', ...)    // second line 'The PLC is not running: values are not updated.', then the task line
test('stateText without counters', ...)     // 'Task 1: task counters not readable: <note>' (default 'task counters not available')
test('stateText findings', ...)             // pinned:
// restart:       'Restart detected: the cycle count went from 1000000 to 12 since the call at T1000.'
// restartOrWrap: 'The cycle count went from 4294960000 to 5000 since the call at T1000: a restart or a counter wrap.'
// slow:          'The cycle count rose less than the elapsed time allows since the call at T1000: the PLC was stopped or restarted in between.'
// onlineChange:  'Online change or download detected: the change count went from 3 to 4 since the call at T1000.'
// toolInput.test.ts
test('parseStateInput: task optional, integer 1-16, default 1', ...)   // 0, 17, 1.5, '2' -> 'task must be an integer from 1 to 16'
// mcpTools.test.ts: manifest lists gain 'ads_state'; 'ads_state passes validated arguments'
test('ads_state on a protocol-1 host gives the missing-feature text', ...)   // fake requires('plcState') returns the text; result isError
// hostProtocol.test.ts:84 pin: entry 2 ops gain 'state', features gain 'plcState'
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors.

- [ ] **Step 3: Implement in one compiling step** (round 2 item 17): `plcState.ts`, `parseStateInput`, `ToolNames.state`, `AdsToolFns.state` with its MCP registration, `LM_TOOL_NAMES` entry, the `lmTools.ts` handler, `adsTools.state` (`const missing = await host.requires('plcState'); if (missing) return error(missing);` then `plcState`, tracker per `adsTools()` call, `stateText` plus the target line), `hostProtocol.ts` entry 2 and `FEATURE_LABELS.plcState = 'PLC state'`, and the manifest:
  - `displayName` `ADS State`; `userDescription` `Read the run state of the PLC and detect a restart.`
  - `modelDescription`: `Returns the PLC run state (Run, Stop, Config), the cycle time and cycle counter of a PLC task (default 1) and the online change count. Call it again later: it says when the cycle counter went down (restart) or the online change count changed (download or online change) since the previous call. Needs a recent iecode CLI.`
  - `inputSchema`: `task` (integer, minimum 1, maximum 16, `PLC task number, default 1.`).

- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.

- [ ] **Step 5: Manual check (simulation, about 15 min):** `ads_state` in Run, after a stop, after a TwinCAT restart (restart finding), after an online change if possible; record under "Findings".

- [ ] **Step 6: CHANGELOG and commit**

CHANGELOG under `## Unreleased` / `### Claude Code and ADS`: ``- New tool `ads_state` (Copilot: `adsState`) reports the PLC run state, the cycle time and cycle counter of a task and the online change count, and says when the PLC restarted or an online change happened since the previous call. Needs the iecode CLI of this release.``

```bash
git add extension/src extension/test extension/package.json extension/CHANGELOG.md
git commit -s -m "Add ads_state for the PLC run state and restart detection" -m "After a restart every non-persistent variable is reset and nothing in the watch output says so. The tool compares the task cycle counter between calls and names an ambiguous drop as such instead of guessing."
```

## Findings

(filled by Task 1 step 1 and Task 2 step 5)

## Done when

`npm test`, `IECode.Core.Tests` and `IECode.Automation.Tests` green; findings recorded; wishlist row "`ads_state`" set to Done with the test names; Plan E task E4 marked "superseded by small items Plan C".
