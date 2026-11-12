import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYTES_PER_VALUE, CONFIG_CONFIRM_BYTES, CONFIG_CONFIRM_MS, ConfigDeps, ConfigRunner, Sampling, bufferEstimate, confirmQuestion, overridesAfterSettingChange, planConfig, runConfig } from '../src/core/adsConfig';

const S = (intervalMs: number, bufferSeconds: number): Sampling => ({ intervalMs, bufferSeconds });

test('estimate: 20 symbols, 100 ms, 300 s hold the full window', () => {
  assert.deepEqual(bufferEstimate(S(100, 300), 20), { symbols: 20, values: 60000, bytes: 60000 * BYTES_PER_VALUE, effectiveSeconds: 300, capped: false });
});

test('estimate: 200 symbols at 10 ms hold only 100 s of 600 s (cap of 2 000 000 values)', () => {
  const e = bufferEstimate(S(10, 600), 200);
  assert.equal(e.values, 2_000_000);
  assert.equal(e.effectiveSeconds, 100);
  assert.equal(e.capped, true);
});

test('estimate: no symbols stores nothing and does not divide by zero', () => {
  assert.equal(bufferEstimate(S(100, 300), 0).values, 0);
});

test('planConfig shows the current values without arguments', () => {
  assert.deepEqual(planConfig(S(100, 300), {}, 20), { kind: 'show' });
});

test('planConfig clamps and says so', () => {
  const p = planConfig(S(100, 300), { pollMs: 5, bufferSeconds: 5000 }, 1);
  assert.equal(p.kind, 'apply');
  if (p.kind === 'apply') {
    assert.deepEqual(p.next, S(10, 3600));
    assert.deepEqual(p.notes, ['pollMs 5 was raised to 10 (allowed 10-5000).', 'bufferSeconds 5000 was lowered to 3600 (allowed 10-3600).',
      'Windows timers tick about every 15.6 ms, so below about 16 ms the real rate is lower.']);
  }
});

test('planConfig confirms a rise above 128 MB (200 symbols at 10 ms fill the 2 000 000 value cap)', () => {
  assert.ok(2_000_000 * BYTES_PER_VALUE > CONFIG_CONFIRM_BYTES);
  assert.equal(planConfig(S(100, 300), { pollMs: 10, bufferSeconds: 600 }, 200).kind, 'confirm');
});

test('planConfig applies a small rise and a reduction without asking', () => {
  assert.equal(planConfig(S(100, 300), { bufferSeconds: 600 }, 20).kind, 'apply');
  assert.equal(planConfig(S(10, 3600), { bufferSeconds: 300 }, 200).kind, 'apply');
  // already above the limit: lowering, or a change that does not raise the estimate, never asks
  assert.equal(planConfig(S(10, 3600), { bufferSeconds: 1800 }, 200).kind, 'apply');
});

test('planConfig reports no change when the values already match', () => {
  assert.deepEqual(planConfig(S(100, 300), { pollMs: 100 }, 5), { kind: 'unchanged' });
});

// ---- runConfig ----

interface Rig { deps: ConfigDeps; asked: string[]; applied: Sampling[]; answer: { resolve(v: boolean): void }; timers: (() => void)[]; state: { current: Sampling; symbols: number } }

function rig(over: Partial<ConfigDeps> = {}): Rig {
  const state = { current: S(100, 300), symbols: 200 };
  const r = { asked: [] as string[], applied: [] as Sampling[], timers: [] as (() => void)[], state } as Rig;
  r.deps = {
    current: () => state.current,
    symbols: () => state.symbols,
    confirm: text => new Promise<boolean>(resolve => { r.asked.push(text); r.answer = { resolve }; }),
    apply: async next => { r.applied.push(next); state.current = next; },
    setTimer: (ms, fn) => { assert.equal(ms, CONFIG_CONFIRM_MS); r.timers.push(fn); return { dispose() { r.timers = r.timers.filter(t => t !== fn); } }; },
    ...over,
  };
  return r;
}
const ac = () => new AbortController();
const tick = () => new Promise<void>(r => setImmediate(r));
const BIG = { pollMs: 10, bufferSeconds: 600 };

test('runConfig applies after the user confirms and passes the question with the memory estimate', async () => {
  const r = rig();
  const p = runConfig(r.deps, BIG, ac().signal);
  await tick();
  assert.equal(r.asked.length, 1);
  assert.equal(r.asked[0], confirmQuestion(S(10, 600), 200));
  assert.match(r.asked[0], /^Raise the ADS sample buffer to 600 s with a poll every 10 ms\? It would hold up to 2000000 values \(about \d+\.\d MB at 72 bytes each\) for 200 watched symbols\.$/);
  r.answer.resolve(true);
  const out = await p;
  assert.equal(out.kind, 'applied');
  assert.deepEqual(r.applied, [S(10, 600)]);
});

test('runConfig declines when the user says no and applies nothing', async () => {
  const r = rig();
  const p = runConfig(r.deps, BIG, ac().signal);
  await tick();
  r.answer.resolve(false);
  assert.equal((await p).kind, 'declined');
  assert.equal(r.applied.length, 0);
});

test('runConfig declines when the dialog is not answered in time, and a late Apply click changes nothing', async () => {
  const r = rig();
  const p = runConfig(r.deps, BIG, ac().signal);
  await tick();
  r.timers[0]();
  assert.equal((await p).kind, 'declined');
  r.answer.resolve(true);
  await tick();
  assert.equal(r.applied.length, 0);
});

test('runConfig is cancelled by the signal while the dialog is open', async () => {
  const r = rig();
  const c = ac();
  const p = runConfig(r.deps, BIG, c.signal);
  await tick();
  c.abort();
  assert.equal((await p).kind, 'cancelled');
  r.answer.resolve(true);
  await tick();
  assert.equal(r.applied.length, 0);
});

test('runConfig applies without a dialog for a plan that needs none', async () => {
  const r = rig();
  const out = await runConfig(r.deps, { bufferSeconds: 600 }, ac().signal);
  assert.equal(r.asked.length, 0);
  assert.equal(out.kind, 'applied');
  assert.deepEqual(r.applied, [S(100, 600)]);
});

test('runConfig applies nothing when the watch list grew while the dialog was open', async () => {
  const r = rig();
  const p = runConfig(r.deps, BIG, ac().signal);
  await tick();
  r.state.symbols = 300;
  r.answer.resolve(true);
  assert.equal((await p).kind, 'changed');
  assert.equal(r.applied.length, 0);
});

test('an apply rejection propagates so the tool can report it', async () => {
  const r = rig({ apply: async () => { throw new Error('host refused'); } });
  await assert.rejects(runConfig(r.deps, { bufferSeconds: 600 }, ac().signal), /host refused/);
});

test('ConfigRunner runs two calls one after the other against the changed state', async () => {
  const r = rig();
  r.state.symbols = 5;
  const runner = new ConfigRunner(r.deps);
  const [a, b] = await Promise.all([runner.run({ bufferSeconds: 600 }, ac().signal), runner.run({ bufferSeconds: 600 }, ac().signal)]);
  assert.equal(a.kind, 'applied');
  assert.equal(b.kind, 'unchanged');
  assert.equal(r.applied.length, 1);
});

test('a setting change drops only the override of its key', () => {
  const o = { intervalMs: 20, bufferSeconds: 600 };
  assert.deepEqual(overridesAfterSettingChange(o, { sampleIntervalMs: true, bufferSeconds: false }), { bufferSeconds: 600 });
  assert.deepEqual(overridesAfterSettingChange(o, { sampleIntervalMs: false, bufferSeconds: true }), { intervalMs: 20 });
  assert.deepEqual(overridesAfterSettingChange(o, { sampleIntervalMs: false, bufferSeconds: false }), o);
});
