import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_STATE_OP_TEXT, PlcStateReply, StateTracker, parsePlcState, runState, stateText } from '../src/core/plcState';
import { COPILOT_NAMES, MCP_NAMES } from '../src/core/adsToolText';

const clock = (ms: number) => `T${ms}`;
const names = MCP_NAMES;
const run = (cycleCount: number, over: Partial<PlcStateReply> = {}): PlcStateReply =>
  ({ adsState: 'Run', deviceState: 0, cycleCount, cycleTimeUs: 1000, onlineChangeCount: 3, ...over });
const text = (o: Partial<Parameters<typeof stateText>[0]> & { state: PlcStateReply }) =>
  stateText({ target: 'local', task: 1, first: false, findings: [], clock, names, ...o });

test('parsePlcState accepts the reply and rejects a shape it does not know', () => {
  assert.deepEqual(parsePlcState({ adsState: 'Run', deviceState: 0, cycleCount: 5, cycleTimeUs: 10000, onlineChangeCount: 3, systemState: 'Run' }),
    { adsState: 'Run', deviceState: 0, cycleCount: 5, cycleTimeUs: 10000, onlineChangeCount: 3, systemState: 'Run' });
  // the reply of the host when the counters are not readable: the null counters are left out
  assert.deepEqual(parsePlcState(JSON.parse('{"adsState":"Run","deviceState":0,"taskNote":"task counters not readable: x"}')),
    { adsState: 'Run', deviceState: 0, taskNote: 'task counters not readable: x' });
  // config mode: only the system state and the PLC error
  assert.deepEqual(parsePlcState(JSON.parse('{"plcError":"Cannot reach x:851 (0x6)","plcAdsCode":6,"systemState":"Config"}')),
    { plcError: 'Cannot reach x:851 (0x6)', plcAdsCode: 6, systemState: 'Config' });
  for (const bad of [null, 'x', 3, [], {}, { adsState: 5 }, { adsState: 'Run', cycleCount: 'many' }, { plcError: 'only' }]) {
    assert.equal(parsePlcState(bad), 'unexpected reply to the state request', JSON.stringify(bad));
  }
});

test('the first call is marked first and finds nothing', () => {
  const t = new StateTracker();
  assert.deepEqual(t.observe('k#1', run(10), 1000, 50), { first: true, findings: [] });
});

test('a cycle count that went down is a restart', () => {
  const t = new StateTracker();
  assert.deepEqual(t.observe('k#1', run(1_000_000), 1000, 50), { first: true, findings: [] });
  assert.deepEqual(t.observe('k#1', run(12), 9000, 8050), { first: false, findings: [{ kind: 'restart', was: 1_000_000, now: 12, sinceMs: 1000 }] });
});

test('elapsed time comes from the monotonic clock', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1000), 10_000_000, 0);
  // the wall clock went back one hour, 60 s passed: 60000 cycles expected, 61000 counted
  assert.deepEqual(t.observe('k#1', run(61_000), 6_400_000, 60_000), { first: false, findings: [] });
});

test('a drop near 2^32 is restart or wrap', () => {
  const t = new StateTracker();
  t.observe('k#1', run(4_294_960_000), 1000, 0);
  assert.deepEqual(t.observe('k#1', run(5000), 11_000, 10_000).findings, [{ kind: 'restartOrWrap', was: 4_294_960_000, now: 5000, sinceMs: 1000 }]);
});

test('a count that rose far too little is slow', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1000), 1000, 0);
  assert.deepEqual(t.observe('k#1', run(2000), 61_000, 60_000).findings, [{ kind: 'slow', was: 1000, now: 2000, sinceMs: 1000 }]);
});

test('a short wait gives no slow finding', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1000), 1000, 0);
  // 50 ms: fewer than 100 cycles are expected, too little evidence
  assert.deepEqual(t.observe('k#1', run(1001), 1050, 50).findings, []);
});

test('a changed cycle time is reported instead of slow', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1000), 1000, 0);
  assert.deepEqual(t.observe('k#1', run(1010, { cycleTimeUs: 10_000 }), 61_000, 60_000).findings,
    [{ kind: 'cycleTimeChanged', was: 1000, now: 10_000, sinceMs: 1000 }]);
});

test('a changed online change count is an online change', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1000), 1000, 0);
  assert.deepEqual(t.observe('k#1', run(2000, { onlineChangeCount: 4 }), 2000, 1000).findings, [{ kind: 'onlineChange', was: 3, now: 4, sinceMs: 1000 }]);
});

test('a restart hides the online change that comes with it', () => {
  const t = new StateTracker();
  t.observe('k#1', run(5_000_000), 1000, 0);
  assert.deepEqual(t.observe('k#1', run(5, { onlineChangeCount: 0 }), 2000, 1000).findings.map(f => f.kind), ['restart']);
});

test('the counter families are compared on their own', () => {
  const t = new StateTracker();
  const noOnline = (c: number): PlcStateReply => ({ adsState: 'Run', cycleCount: c, cycleTimeUs: 1000 });
  t.observe('a#1', noOnline(1_000_000), 1000, 0);
  assert.deepEqual(t.observe('a#1', noOnline(3), 2000, 1000).findings.map(f => f.kind), ['restart']);
  const onlyOnline = (n: number): PlcStateReply => ({ adsState: 'Run', onlineChangeCount: n });
  t.observe('b#1', onlyOnline(1), 1000, 0);
  assert.deepEqual(t.observe('b#1', onlyOnline(2), 2000, 1000).findings.map(f => f.kind), ['onlineChange']);
});

test('the tracker is per target and task', () => {
  const t = new StateTracker();
  t.observe('local#1', run(1_000_000), 1000, 0);
  assert.deepEqual(t.observe('local#2', run(12), 2000, 1000), { first: true, findings: [] });
  assert.deepEqual(t.observe('other#1', run(12), 2000, 1000), { first: true, findings: [] });
  assert.equal(t.observe('local#1', run(1_001_000), 2000, 1000).findings.length, 0);
});

test('a missing counter or a cycle time of 0 finds nothing', () => {
  const t = new StateTracker();
  t.observe('k#1', { adsState: 'Run' }, 1000, 0);
  assert.deepEqual(t.observe('k#1', { adsState: 'Run' }, 2000, 1000).findings, []);
  t.observe('z#1', run(100, { cycleTimeUs: 0, onlineChangeCount: undefined }), 1000, 0);
  assert.deepEqual(t.observe('z#1', run(1, { cycleTimeUs: 0, onlineChangeCount: undefined }), 2000, 1000).findings, []);
});

test('a reply without counters keeps the earlier baseline', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1_000_000), 1000, 0);
  t.observe('k#1', { systemState: 'Config', plcError: 'x', plcAdsCode: 6 }, 2000, 1000);
  assert.deepEqual(t.observe('k#1', run(7), 3000, 2000).findings.map(f => f.kind), ['restart']);
});

test('a family that failed in one call keeps its earlier baseline, with the time it was read', () => {
  const t = new StateTracker();
  t.observe('k#1', run(1_000_000), 1000, 0);
  // the cycle count item failed this time, the online change count came back
  assert.deepEqual(t.observe('k#1', { adsState: 'Run', onlineChangeCount: 3 }, 2000, 1000).findings, []);
  // the restart is still seen, compared with the call at T1000
  assert.deepEqual(t.observe('k#1', run(7), 3000, 2000).findings, [{ kind: 'restart', was: 1_000_000, now: 7, sinceMs: 1000 }]);
});

test('stateText for a running PLC', () => {
  assert.equal(text({ state: { adsState: 'Run', deviceState: 0, cycleCount: 1234567, cycleTimeUs: 10000, onlineChangeCount: 3 } }),
    'PLC state on local: Run (device state 0).\nTask 1: cycle time 10.000 ms, cycle count 1234567, online changes 3.');
});

test('the first call says there is no baseline', () => {
  const s = text({ state: run(5), first: true });
  assert.match(s, /\nNo earlier ads_state call for task 1 on this target to compare with; call it again later to see a restart or an online change\.$/);
  assert.match(text({ state: run(5), first: true, names: COPILOT_NAMES }), /No earlier adsState call/);
});

test('stateText for a stopped PLC', () => {
  assert.equal(text({ state: run(5, { adsState: 'Stop', onlineChangeCount: undefined }) }),
    'PLC state on local: Stop (device state 0).\nThe PLC is not running: values are not updated.\nTask 1: cycle time 1.000 ms, cycle count 5.');
});

test('stateText without counters', () => {
  assert.equal(text({ state: { adsState: 'Run', deviceState: 0, taskNote: 'task counters not readable: nope' } }),
    'PLC state on local: Run (device state 0).\nTask 1: task counters not readable: nope');
  assert.match(text({ state: { adsState: 'Run', deviceState: 0 } }), /\nTask 1: task counters not available$/);
  assert.match(text({ state: { adsState: 'Run', cycleCount: 9, taskNote: 'not readable: X (symbol not found)' } }),
    /\nTask 1: cycle count 9; not readable: X \(symbol not found\)\.$/);
});

test('stateText names a TwinCAT system that is not in Run', () => {
  assert.equal(text({ state: run(5, { systemState: 'Config', onlineChangeCount: undefined }) }).split('\n')[1], 'TwinCAT system: Config (config mode: no PLC program runs).');
  assert.doesNotMatch(text({ state: run(5, { systemState: 'Run' }) }), /TwinCAT system/);
});

test('stateText in config mode', () => {
  assert.equal(text({ state: { systemState: 'Config', plcError: 'Cannot reach x:851 over ADS: Err (0x6)', plcAdsCode: 6 }, first: true }),
    'TwinCAT system on local: Config (config mode: no PLC program runs).\nPLC: not reachable (Cannot reach x:851 over ADS: Err (0x6)).');
});

test('stateText with the PLC port missing and the system in Run', () => {
  assert.equal(text({ state: { systemState: 'Run', plcError: 'Cannot reach (0x6)', plcAdsCode: 6 } }),
    'PLC on local: not reachable (Cannot reach (0x6)); the TwinCAT system runs, so the PLC port is missing: no PLC program on this port, or it is still starting.');
});

test('stateText with another PLC error and the system in Run', () => {
  assert.equal(text({ state: { systemState: 'Run', plcError: 'timeout (0x745)', plcAdsCode: 0x745 } }), 'PLC on local: not reachable (timeout (0x745)).');
});

test('stateText findings', () => {
  const f = (finding: Parameters<typeof stateText>[0]['findings'][number]) => text({ state: run(5), findings: [finding] }).split('\n').slice(2).join('\n');
  assert.equal(f({ kind: 'restart', was: 1_000_000, now: 12, sinceMs: 1000 }),
    'The cycle count went down from 1000000 to 12 since the call at T1000: the PLC restarted (or a download reset the task).');
  assert.equal(f({ kind: 'restartOrWrap', was: 4_294_960_000, now: 5000, sinceMs: 1000 }),
    'The cycle count went from 4294960000 to 5000 since the call at T1000: a restart or a counter wrap.');
  assert.equal(f({ kind: 'slow', was: 1000, now: 2000, sinceMs: 1000 }),
    'The cycle count rose less than the elapsed time allows since the call at T1000: the PLC was stopped or restarted in between.');
  assert.equal(f({ kind: 'cycleTimeChanged', was: 1000, now: 10_000, sinceMs: 1000 }),
    'The task cycle time changed from 1.000 ms to 10.000 ms since the call at T1000 (download); the counter is not compared.');
  assert.equal(f({ kind: 'onlineChange', was: 3, now: 4, sinceMs: 1000 }),
    'The online change count went from 3 to 4 since the call at T1000: an online change or download happened.');
});

test('runState on a host without the feature gives the missing-feature text and reads nothing', async () => {
  let read = 0;
  const r = await runState({
    requires: async () => 'this needs a newer iecode CLI: PLC state (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…"',
    plcState: async () => { read++; return run(1); },
    tracker: new StateTracker(), targetKey: 'local:851', target: 'local', clock, names, wallMs: () => 1000, monoMs: () => 0,
  }, 1);
  assert.equal(r.isError, true);
  assert.match(r.text, /needs a newer iecode CLI: PLC state/);
  assert.equal(read, 0);
});

test('runState compares with the previous call of the same target and task', async () => {
  const tracker = new StateTracker();
  let n = 1_000_000;
  let mono = 0;
  const deps = () => ({
    requires: async () => undefined,
    plcState: async () => run(n),
    tracker, targetKey: 'local:851', target: 'local', clock, names, wallMs: () => 1000 + mono, monoMs: () => mono,
  });
  const a = await runState(deps(), 1);
  assert.match(a.text, /No earlier ads_state call/);
  n = 5; mono = 1000;
  const b = await runState(deps(), 1);
  assert.match(b.text, /The cycle count went down from 1000000 to 5/);
  assert.equal(b.isError, undefined);
});

test('a count far from 2^32 or a new count too large for a wrap is a restart, not a wrap', () => {
  const t = new StateTracker();
  // 1 ms cycle: 100 ms is 100 cycles; a wrap from 2^32-10 would land near 90, not at 1 000 000
  t.observe('k#1', run(4_294_967_286), 1000, 0);
  assert.deepEqual(t.observe('k#1', run(1_000_000), 1100, 100).findings.map(f => f.kind), ['restart']);
  t.observe('w#1', run(4_294_967_286), 1000, 0);
  assert.deepEqual(t.observe('w#1', run(90), 1100, 100).findings.map(f => f.kind), ['restartOrWrap']);
});

test('an older protocol-2 CLI without the state op gets the update text', async () => {
  const r = await runState({
    requires: async () => undefined, plcState: async () => { throw new Error("Unknown op 'state'."); },
    tracker: new StateTracker(), targetKey: 'k', target: 'local', clock, names, wallMs: () => 0, monoMs: () => 0,
  }, 1);
  assert.equal(r.isError, true);
  assert.equal(r.text, `Cannot read the PLC state: ${UNKNOWN_STATE_OP_TEXT}`);
});

test('runState turns a failed request into an error text', async () => {
  const r = await runState({
    requires: async () => undefined, plcState: async () => { throw new Error('Cannot reach target'); },
    tracker: new StateTracker(), targetKey: 'k', target: 'local', clock, names, wallMs: () => 0, monoMs: () => 0,
  }, 1);
  assert.deepEqual(r, { text: 'Error: Cannot reach target', isError: true });
});
