import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { runWait, SampleBatch, WaitDeps, WaitOutcome } from '../src/core/waitRun';
import { parseCondition, WaitCondition } from '../src/core/waitCondition';
import { Row, WatchItem, watchLimitError } from '../src/core/adswatch';

const T0 = 1_000_000;

function emitter<T>() {
  const ls = new Set<(v: T) => void>();
  return {
    on: (l: (v: T) => void) => { ls.add(l); return { dispose: () => { ls.delete(l); } }; },
    emit: (v: T) => { for (const l of [...ls]) l(v); },
    count: () => ls.size,
  };
}

interface FakeOpts { holdLate?: boolean; holdError?: string; readyError?: string }

function fake(opts: FakeOpts = {}) {
  const samples = emitter<SampleBatch>();
  const ended = emitter<string>();
  const removed = emitter<string[]>();
  let mono = 500;
  let wall = T0;
  const timers: { ms: number; fn: () => void; disposed: boolean }[] = [];
  let held = 0;
  let released = 0;
  let resolveHold: (() => void) | undefined;
  const deps: WaitDeps = {
    hold: () => {
      if (opts.holdError) return Promise.reject(new Error(opts.holdError));
      const h = { release: async () => { released++; } };
      if (opts.holdLate) return new Promise(r => { resolveHold = () => { held++; r(h); }; });
      held++;
      return Promise.resolve(h);
    },
    ready: () => opts.readyError ? Promise.reject(new Error(opts.readyError)) : Promise.resolve(),
    onSamples: samples.on,
    onEnded: ended.on,
    onUserRemoved: removed.on,
    monotonicMs: () => mono,
    wallMs: () => wall,
    setTimer: (ms, fn) => { const t = { ms, fn, disposed: false }; timers.push(t); return { dispose: () => { t.disposed = true; } }; },
  };
  return {
    deps, samples, ended, removed, timers,
    held: () => held, released: () => released,
    resolveHold: () => resolveHold?.(),
    advance: (ms: number) => { mono += ms; wall += ms; },
    fireTimers: () => { for (const t of timers) if (!t.disposed) t.fn(); },
  };
}

const cond = (text: string): WaitCondition => {
  const p = parseCondition(text);
  if (!p.ok) throw new Error(p.error);
  return p.value;
};
const item = (symbol: string, type = 'BOOL', error: string | null = null): WatchItem => ({ symbol, type, numeric: type !== 'BOOL' && type !== 'STRING', error });
const rows = (vals: (string | null)[], start = T0): Row[] => vals.map((v, i) => ({ t: start + i, v: [v] }));
const tick = () => new Promise<void>(r => setImmediate(r));

function start(f: ReturnType<typeof fake>, condition: string, symbol = 'P', timeoutSeconds = 5, signal = new AbortController().signal) {
  let outcome: WaitOutcome | undefined;
  const p = runWait(f.deps, { symbol, condition: cond(condition), timeoutSeconds }, signal).then(o => { outcome = o; return o; });
  return { p, outcome: () => outcome };
}

test('meets on a pulse in row 4 of a 10-row batch', async () => {
  const f = fake();
  const w = start(f, '= TRUE');
  await tick();
  f.advance(9);
  const vals = Array.from({ length: 10 }, (_, i) => i === 4 ? 'TRUE' : 'FALSE');
  f.samples.emit({ gen: 1, items: [item('P')], rows: rows(vals) });
  assert.deepEqual(await w.p, { kind: 'met', t: T0 + 4, value: 'TRUE', firstObservation: false, elapsedMs: 9 });
  assert.equal(f.released(), f.held());
  assert.equal(f.samples.count() + f.ended.count() + f.removed.count(), 0);
  assert.ok(f.timers.every(t => t.disposed));
});

test('true at the first observation is reported as such', async () => {
  const f = fake();
  const w = start(f, '= TRUE');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P')], rows: rows([null, 'TRUE', 'FALSE']) });
  assert.deepEqual(await w.p, { kind: 'met', t: T0 + 1, value: 'TRUE', firstObservation: true, elapsedMs: 0 });
});

test('rows stamped before the call start are ignored', async () => {
  const f = fake();
  const w = start(f, '= TRUE');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P')], rows: [{ t: T0 - 1, v: ['TRUE'] }, { t: T0 + 1, v: ['FALSE'] }] });
  await tick();
  assert.equal(w.outcome(), undefined);
  f.fireTimers();
  assert.deepEqual(await w.p, { kind: 'timeout', last: 'FALSE', seconds: 5 });
});

test('a column moved by a new gen is found by name', async () => {
  const f = fake();
  const w = start(f, '= 7', 'p');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P', 'INT')], rows: [{ t: T0, v: ['3'] }] });
  f.samples.emit({ gen: 2, items: [item('X', 'INT'), item('P', 'INT')], rows: [{ t: T0 + 1, v: ['7', '5'] }, { t: T0 + 2, v: ['3', '7'] }] });
  assert.deepEqual(await w.p, { kind: 'met', t: T0 + 2, value: '7', firstObservation: false, elapsedMs: 0 });
});

test('a batch without the symbol is skipped', async () => {
  const f = fake();
  const w = start(f, '= TRUE');
  await tick();
  f.samples.emit({ gen: 1, items: [item('X')], rows: rows(['TRUE']) });
  await tick();
  assert.equal(w.outcome(), undefined);
  f.fireTimers();
  assert.deepEqual(await w.p, { kind: 'timeout', last: undefined, seconds: 5 });
});

test('changes needs a second valid value; null is not a change', async () => {
  const f = fake();
  const w = start(f, 'changes');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P', 'INT')], rows: rows(['4', null, '4']) });
  await tick();
  assert.equal(w.outcome(), undefined);
  f.samples.emit({ gen: 1, items: [item('P', 'INT')], rows: rows(['5'], T0 + 3) });
  assert.deepEqual(await w.p, { kind: 'met', t: T0 + 3, value: '5', firstObservation: false, elapsedMs: 0 });
});

test('NaN and Inf never meet nor count as a change', async () => {
  const f = fake();
  const w = start(f, 'changes');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P', 'REAL')], rows: rows(['1.5', 'NaN', 'Infinity', '1.5']) });
  await tick();
  assert.equal(w.outcome(), undefined);
  f.fireTimers();
  assert.deepEqual(await w.p, { kind: 'timeout', last: '1.5', seconds: 5 });
});

test('timeout reports the last valid value', async () => {
  const f = fake();
  const w = start(f, '> 10');
  await tick();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, 5000);
  f.samples.emit({ gen: 1, items: [item('P', 'INT')], rows: rows(['2', '3', null]) });
  f.fireTimers();
  assert.deepEqual(await w.p, { kind: 'timeout', last: '3', seconds: 5 });
  assert.equal(f.released(), 1);
});

test('cancel ends at once and releases the hold', async () => {
  const f = fake();
  const ac = new AbortController();
  const w = start(f, '= TRUE', 'P', 5, ac.signal);
  await tick();
  assert.equal(f.held(), 1);
  ac.abort();
  assert.deepEqual(await w.p, { kind: 'cancelled' });
  assert.equal(f.released(), 1);
});

test('an already aborted signal never holds', async () => {
  const f = fake();
  const ac = new AbortController();
  ac.abort();
  const w = start(f, '= TRUE', 'P', 5, ac.signal);
  assert.deepEqual(await w.p, { kind: 'cancelled' });
  await tick();
  assert.equal(f.released(), f.held());
});

test('cancel during a slow hold releases it when the hold resolves', async () => {
  const f = fake({ holdLate: true });
  const ac = new AbortController();
  const w = start(f, '= TRUE', 'P', 5, ac.signal);
  await tick();
  ac.abort();
  assert.deepEqual(await w.p, { kind: 'cancelled' });
  assert.equal(f.held(), 0);
  f.resolveHold();
  await tick();
  assert.equal(f.held(), 1);
  assert.equal(f.released(), 1);
});

test('host end and user removal end the wait with the reason', async () => {
  const f = fake();
  const w = start(f, '= TRUE');
  await tick();
  f.ended.emit('the ADS host stopped');
  assert.deepEqual(await w.p, { kind: 'ended', reason: 'the ADS host stopped' });
  assert.equal(f.released(), 1);

  const g = fake();
  const v = start(g, '= TRUE', 'main.P');
  await tick();
  g.removed.emit(['X']);
  await tick();
  assert.equal(v.outcome(), undefined);
  g.removed.emit(['MAIN.p']);
  assert.deepEqual(await v.p, { kind: 'ended', reason: 'removed from the watch list by the user' });
});

test('an item error refuses at once', async () => {
  const f = fake();
  const w = start(f, '= TRUE');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P', 'BOOL', 'not found')], rows: [] });
  assert.deepEqual(await w.p, { kind: 'refused', reason: 'not found' });
  assert.equal(f.released(), 1);
});

test('a condition the type does not allow is refused', async () => {
  const f = fake();
  const w = start(f, '< TRUE');
  await tick();
  f.samples.emit({ gen: 1, items: [item('P')], rows: rows(['FALSE']) });
  assert.deepEqual(await w.p, { kind: 'refused', reason: 'BOOL allows only = TRUE / = FALSE and <>' });
});

test('a refused hold ends the wait with its message', async () => {
  const msg = watchLimitError(201) as string;
  const f = fake({ holdError: msg });
  const w = start(f, '= TRUE');
  assert.deepEqual(await w.p, { kind: 'refused', reason: msg });
  assert.equal(f.held(), 0);
  assert.equal(f.released(), 0);
});

test('a host that fails to start refuses the wait', async () => {
  const f = fake({ readyError: 'ADS host did not start' });
  const w = start(f, '= TRUE');
  assert.deepEqual(await w.p, { kind: 'refused', reason: 'ADS host did not start' });
  assert.equal(f.released(), 1);
});
