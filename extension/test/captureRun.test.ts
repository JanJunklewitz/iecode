import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_GRACE_MS, CaptureDeps, CaptureOutcome, CaptureRequest, runCapture } from '../src/core/captureRun';
import { ChangeLog } from '../src/core/scopeChanges';
import { SampleBatch, USER_REMOVED } from '../src/core/waitRun';
import { parseCondition } from '../src/core/waitCondition';

const T0 = 1_000_000;
const tick = () => new Promise<void>(r => setImmediate(r));
const ITEMS = [
  { symbol: 'MAIN.nStep', type: 'INT', numeric: true, error: null },
  { symbol: 'MAIN.sText', type: 'STRING(80)', numeric: false, error: null },
];
const batch = (rows: [number, string, string][]): SampleBatch => ({ gen: 1, items: ITEMS, rows: rows.map(([t, a, b]) => ({ t, v: [a, b] })) });
const emptyLog = (): ChangeLog => ({ entries: [], olderDropped: false, startUnknown: false, coveredFromMs: 0 });

interface Rig {
  deps: CaptureDeps;
  held: string[]; released: string[];
  timers: { ms: number; fn: () => void }[];
  samples(b: SampleBatch): void; ended(r: string): void; removed(s: string[]): void;
  seed: { log: (symbol: string) => ChangeLog };
}

function rig(over: Partial<CaptureDeps> = {}, capacity = 100): Rig {
  const sampleL: ((b: SampleBatch) => void)[] = [], endedL: ((r: string) => void)[] = [], removedL: ((s: string[]) => void)[] = [];
  const r: Rig = { held: [], released: [], timers: [], seed: { log: () => emptyLog() } } as unknown as Rig;
  const sub = <T>(list: T[], l: T) => { list.push(l); return { dispose() { list.splice(list.indexOf(l), 1); } }; };
  r.deps = {
    hold: async s => { r.held.push(s); return { release: async () => { r.released.push(s); } }; },
    ready: async () => undefined,
    onSamples: l => sub(sampleL, l), onEnded: l => sub(endedL, l), onUserRemoved: l => sub(removedL, l),
    monotonicMs: () => 0, wallMs: () => T0,
    setTimer: (ms, fn) => { const t = { ms, fn }; r.timers.push(t); return { dispose() { r.timers = r.timers.filter(x => x !== t); } }; },
    history: s => r.seed.log(s),
    capacitySeconds: () => capacity,
    format: (_s, text) => text,
    ...over,
  };
  r.samples = b => [...sampleL].forEach(l => l(b));
  r.ended = x => [...endedL].forEach(l => l(x));
  r.removed = s => [...removedL].forEach(l => l(s));
  return r;
}

const cond = (text: string) => { const p = parseCondition(text); if (!p.ok) throw new Error(p.error); return p.value; };
const req = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({ symbol: 'MAIN.nStep', condition: cond('= 40'), preSeconds: 2, postSeconds: 1, timeoutSeconds: 30, ...over });
const ac = () => new AbortController();
const window = (o: CaptureOutcome) => { assert.ok(o.kind === 'captured' || o.kind === 'timeout' || o.kind === 'ended', o.kind); return (o as { window: { table: string; fromMs: number; toMs: number; originMs: number; historyFromMs?: number } }).window; };

test('captures pre and post around the trigger and renders after the post rows arrived', async () => {
  const r = rig();
  let result: CaptureOutcome | undefined;
  const p = runCapture(r.deps, ['MAIN.sText'], req(), ac().signal).then(o => { result = o; });
  await tick();
  r.samples(batch([[T0 + 1000, '10', 'idle'], [T0 + 3000, '40', 'run']]));
  await tick();
  assert.equal(result, undefined, 'the post rows are not there yet');
  r.samples(batch([[T0 + 4000, '40', 'run']]));
  await p;
  assert.equal(result!.kind, 'captured');
  const w = window(result!);
  assert.deepEqual([w.fromMs, w.toMs, w.originMs], [T0 + 1000, T0 + 4000, T0 + 3000]);
  assert.equal(w.table, ['t[s]\tMAIN.nStep\tMAIN.sText', '-2.000\t10\tidle', '0.000\t40\trun'].join('\n'));
  assert.equal(w.historyFromMs, undefined);
});

test('a post window that is already in the batch finishes at once', async () => {
  const r = rig();
  const p = runCapture(r.deps, [], req(), ac().signal);
  await tick();
  r.samples(batch([[T0 + 3000, '40', 'x'], [T0 + 4000, '40', 'x']]));
  assert.equal((await p).kind, 'captured');
});

test('holds are released after the call, once each, and the table is built from the own log', async () => {
  const r = rig();
  const p = runCapture(r.deps, ['MAIN.sText', 'MAIN.nStep'], req(), ac().signal);
  await tick();
  r.samples(batch([[T0 + 3000, '40', 'x'], [T0 + 4000, '40', 'x']]));
  const out = await p;
  // the wait takes its own hold of the trigger on top of the call's holds; every hold is given back
  assert.deepEqual(r.held.sort(), ['MAIN.nStep', 'MAIN.nStep', 'MAIN.sText']);
  assert.deepEqual(r.released.sort(), r.held);
  assert.match(window(out).table, /MAIN\.sText/);
});

test('the user removing a captured symbol during the post window ends partial with that reason, the table is still built', async () => {
  const r = rig();
  const p = runCapture(r.deps, ['MAIN.sText'], req({ postSeconds: 5 }), ac().signal);
  await tick();
  r.samples(batch([[T0 + 1000, '10', 'idle'], [T0 + 3000, '40', 'run'], [T0 + 3500, '40', 'run']]));
  await tick();
  r.removed(['main.stext']);
  const out = await p;
  assert.equal(out.kind, 'captured');
  if (out.kind === 'captured') {
    assert.equal(out.partial, USER_REMOVED);
    assert.equal(out.window.toMs, T0 + 3500);
    assert.match(out.window.table, /0\.000\t40\trun/);
  }
});

test('host end during the post window ends partial with the reason', async () => {
  const r = rig();
  const p = runCapture(r.deps, [], req({ postSeconds: 5 }), ac().signal);
  await tick();
  r.samples(batch([[T0 + 3000, '40', 'x']]));
  await tick();
  r.ended('The ADS host stopped.');
  const out = await p;
  assert.equal(out.kind === 'captured' && out.partial, 'The ADS host stopped.');
});

test('connection loss during the post window ends partial after post + grace', async () => {
  const r = rig();
  const p = runCapture(r.deps, [], req({ postSeconds: 5 }), ac().signal);
  await tick();
  r.samples(batch([[T0 + 3000, '40', 'x']]));
  await tick();
  const timer = r.timers.find(t => t.ms === 5000 + CAPTURE_GRACE_MS);
  assert.ok(timer, 'a timer of post + grace is armed');
  timer!.fn();
  const out = await p;
  assert.equal(out.kind, 'captured');
  assert.match(out.kind === 'captured' ? out.partial ?? '' : '', /^no new samples within 3 s after the post window; the connection to the PLC may have been lost$/);
  assert.equal(r.released.length, r.held.length);
});

test('timeout returns the last pre seconds up to the newest sample', async () => {
  const r = rig();
  const p = runCapture(r.deps, [], req({ timeoutSeconds: 5 }), ac().signal);
  await tick();
  r.samples(batch([[T0 + 1000, '1', 'x'], [T0 + 2000, '3', 'x']]));
  r.timers.find(t => t.ms === 5000)!.fn();
  const out = await p;
  assert.equal(out.kind, 'timeout');
  if (out.kind === 'timeout') {
    assert.equal(out.last, '3');
    assert.equal(out.seconds, 5);
    assert.deepEqual([out.window.fromMs, out.window.toMs, out.window.originMs], [T0, T0 + 2000, T0 + 2000]);
  }
});

test('ended before the trigger returns the window it has', async () => {
  const r = rig();
  const p = runCapture(r.deps, [], req(), ac().signal);
  await tick();
  r.samples(batch([[T0 + 500, '1', 'x']]));
  r.ended('The ADS target changed.');
  const out = await p;
  assert.equal(out.kind, 'ended');
  assert.match(window(out).table, /MAIN\.nStep/);
});

test('a buffer shorter than pre + post is refused before holding anything', async () => {
  const r = rig({}, 2);
  const out = await runCapture(r.deps, ['MAIN.sText'], req(), ac().signal);
  assert.equal(out.kind, 'refused');
  assert.equal(out.kind === 'refused' && out.reason, 'the capture window needs 3 s of history but the buffer holds 2 s; raise it with {config} { bufferSeconds: 3 } (a large change asks the user to confirm)');
  assert.equal(r.held.length, 0);
});

test('history shorter than the pre window is reported', async () => {
  const r = rig();
  const p = runCapture(r.deps, [], req(), ac().signal);
  await tick();
  r.samples(batch([[T0 + 2500, '10', 'x'], [T0 + 3000, '40', 'x'], [T0 + 4000, '40', 'x']]));
  const w = window(await p);
  assert.equal(w.historyFromMs, T0 + 2500);
});

test('the pre window starts with what the buffer already holds', async () => {
  const r = rig();
  r.seed.log = s => (s === 'MAIN.nStep'
    ? { ...emptyLog(), start: { t: T0 - 5000, text: '7', first: true }, entries: [], coveredFromMs: T0 - 5000 }
    : emptyLog());
  const p = runCapture(r.deps, [], req(), ac().signal);
  await tick();
  r.samples(batch([[T0 + 3000, '40', 'x'], [T0 + 4000, '40', 'x']]));
  const w = window(await p);
  assert.ok(w.table.split('\n').some(l => /^-?\d+\.\d{3}\t7$/.test(l) || l.endsWith('\t7')), w.table);
});

test('cancel during the post window releases every hold and returns cancelled', async () => {
  const r = rig();
  const c = ac();
  const p = runCapture(r.deps, ['MAIN.sText'], req({ postSeconds: 5 }), c.signal);
  await tick();
  r.samples(batch([[T0 + 3000, '40', 'x']]));
  await tick();
  c.abort();
  assert.equal((await p).kind, 'cancelled');
  assert.equal(r.released.length, r.held.length);
});

test('a refused trigger (condition not allowed for the type) releases the holds', async () => {
  const r = rig();
  const p = runCapture(r.deps, ['MAIN.sText'], req({ condition: cond('contains "x"') }), ac().signal);
  await tick();
  r.samples(batch([[T0 + 100, '5', 'x']]));
  const out = await p;
  assert.equal(out.kind, 'refused');
  assert.equal(r.released.length, r.held.length);
});

test('a hold that fails ends refused and releases the earlier ones', async () => {
  const r = rig();
  let n = 0;
  r.deps.hold = async s => { if (++n === 2) throw new Error('hold failed'); r.held.push(s); return { release: async () => { r.released.push(s); } }; };
  const out = await runCapture(r.deps, ['MAIN.sText'], req(), ac().signal);
  assert.deepEqual(out, { kind: 'refused', reason: 'hold failed' });
  assert.deepEqual(r.released, ['MAIN.nStep']);
});
