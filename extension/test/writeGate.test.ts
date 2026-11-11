import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WriteGate, GateDeps, GatePolicy, WriteOp, WriteResult, PreparedWrites, WriteNotSent, WriteOutcomeUnknown, sendOutcome, writeResultText, writeResultIsError, itemsOf, featureOf } from '../src/core/writeGate';
import { WriteDecision } from '../src/core/adswatch';

// ---- helpers ----

class FakeClock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => { const id = this.next++; this.timers.push({ at: this.t + ms, fn, id }); return id; };
  clearTimeout = (h: unknown) => { this.timers = this.timers.filter(x => x.id !== h); };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter(x => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise<void>(r => setImmediate(r));

const op = (symbol = 'MAIN.x', extra: Partial<WriteOp> = {}): WriteOp => ({ symbol, value: '1', targetKey: 'A:851', via: 'MCP', ...extra });

const POLICY: GatePolicy = { dialogMs: 100_000, operationMs: 150_000, maxQueued: 10 };

function rig(policy: Partial<GatePolicy> = {}) {
  const clock = new FakeClock();
  const state = { decision: 'confirm' as WriteDecision, target: 'A:851' };
  const confirms: { op: WriteOp; signal: AbortSignal; answer: Deferred<boolean> }[] = [];
  const sent: string[] = [];
  const late: [string, string][] = [];
  const r = {
    clock, state, confirms, sent, late,
    /** Replaced by tests that need a slow or failing send. */
    send: async (o: WriteOp, beforeSend: () => string | undefined): Promise<WriteResult> => {
      const why = beforeSend();
      if (why) return { kind: 'refused', reason: why };
      sent.push(o.symbol);
      return { kind: 'written', readBack: o.value };
    },
    gate: undefined as unknown as WriteGate,
  };
  const deps: GateDeps = {
    decision: () => state.decision,
    targetKey: () => state.target,
    confirm: (o, signal) => { const answer = deferred<boolean>(); confirms.push({ op: o, signal, answer }); return answer.promise; },
    send: (o, b) => r.send(o, b),
    lateApproval: (o, reason) => { late.push([o.symbol, reason]); },
  };
  r.gate = new WriteGate(deps, { ...POLICY, ...policy }, clock);
  return r;
}

const ac = () => new AbortController();
const refused = (r: WriteResult) => (r.kind === 'refused' ? r.reason : `<${r.kind}>`);

// ---- gate ----

test('gate refuses when writes are off', async () => {
  const r = rig();
  r.state.decision = 'refuse';
  const res = await r.gate.run(op(), ac().signal);
  assert.equal(res.kind, 'refused');
  assert.match(refused(res), /AI writes are off.*IECode: Set AI Write Access/);
  assert.equal(r.confirms.length, 0);
  assert.equal(r.sent.length, 0);
});

test('gate sends without dialog on allow', async () => {
  const r = rig();
  r.state.decision = 'allow';
  assert.deepEqual(await r.gate.run(op(), ac().signal), { kind: 'written', readBack: '1' });
  assert.equal(r.confirms.length, 0);
});

test('gate sends after the user confirmed', async () => {
  const r = rig();
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.confirms[0].answer.resolve(true);
  assert.equal((await p).kind, 'written');
});

test('gate refuses when the user declines', async () => {
  const r = rig();
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.confirms[0].answer.resolve(false);
  assert.equal(r.sent.length, 0);
  assert.equal((await p).kind, 'refused');
  assert.equal(r.late.length, 0);
});

test('gate refuses when the target changed during approval', async () => {
  const r = rig();
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.state.target = 'B:851';
  r.confirms[0].answer.resolve(true);
  const res = await p;
  assert.equal(res.kind, 'refused');
  assert.match(refused(res), /A:851/);
  assert.match(refused(res), /B:851/);
  assert.equal(r.sent.length, 0);
});

test('gate writes nothing after cancellation', async () => {
  const r = rig();
  const c = ac();
  const p = r.gate.run(op(), c.signal);
  await tick();
  c.abort();
  assert.equal(refused(await p), 'the request was cancelled');
  r.confirms[0].answer.resolve(true);
  await tick();
  assert.equal(r.sent.length, 0);
});

test('gate refuses after the deadline', async () => {
  const r = rig({ dialogMs: 10 });
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.clock.advance(11);
  const res = await p;
  assert.equal(res.kind, 'refused');
  assert.match(refused(res), /not answered|no answer/);
  assert.equal(r.sent.length, 0);
});

test('gate runs writes one after the other', async () => {
  const r = rig();
  r.state.decision = 'allow';
  const slow = deferred<void>();
  const order: string[] = [];
  r.send = async (o, b) => {
    b();
    order.push(`start ${o.symbol}`);
    if (o.symbol === 'MAIN.a') await slow.promise;
    order.push(`end ${o.symbol}`);
    return { kind: 'written', readBack: o.value };
  };
  const p1 = r.gate.run(op('MAIN.a'), ac().signal);
  const p2 = r.gate.run(op('MAIN.b'), ac().signal);
  await tick();
  assert.deepEqual(order, ['start MAIN.a']);
  slow.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start MAIN.a', 'end MAIN.a', 'start MAIN.b', 'end MAIN.b']);
});

test('gate rejects when too many writes wait', async () => {
  const r = rig({ maxQueued: 1 });
  r.state.decision = 'allow';
  const slow = deferred<void>();
  r.send = async (o, b) => { b(); await slow.promise; return { kind: 'written', readBack: o.value }; };
  const p1 = r.gate.run(op('MAIN.a'), ac().signal);
  const p2 = r.gate.run(op('MAIN.b'), ac().signal);
  const p3 = await r.gate.run(op('MAIN.c'), ac().signal);
  assert.equal(refused(p3), 'too many pending writes');
  slow.resolve();
  assert.equal((await p1).kind, 'written');
  assert.equal((await p2).kind, 'written');
});

test('gate shows one dialog at a time', async () => {
  const r = rig({ operationMs: 1_000_000 });
  const p1 = r.gate.run(op('MAIN.a'), ac().signal);
  const p2 = r.gate.run(op('MAIN.b'), ac().signal);
  await tick();
  assert.equal(r.confirms.length, 1);
  r.clock.advance(60_000);
  r.confirms[0].answer.resolve(true);
  await p1;
  await tick();
  assert.equal(r.confirms.length, 2);
  // the deadline of the second dialog counts from when it opened
  r.clock.advance(99_000);
  await tick();
  r.confirms[1].answer.resolve(true);
  assert.equal((await p2).kind, 'written');
});

test('gate waits for a stale dialog before the next', async () => {
  const r = rig({ dialogMs: 10 });
  const p1 = r.gate.run(op('MAIN.a'), ac().signal);
  const p2 = r.gate.run(op('MAIN.b'), ac().signal);
  await tick();
  r.clock.advance(11);
  assert.equal((await p1).kind, 'refused');
  await tick();
  assert.equal(r.confirms.length, 1, 'the second dialog waits for the stale one');
  r.confirms[0].answer.resolve(false);
  await tick();
  assert.equal(r.confirms.length, 2);
  r.confirms[1].answer.resolve(true);
  assert.equal((await p2).kind, 'written');
});

test('gate refuses pending writes on dispose', async () => {
  const r = rig();
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.gate.dispose();
  assert.equal(refused(await p), 'IECode was shut down');
  r.confirms[0].answer.resolve(true);
  await tick();
  assert.equal(r.sent.length, 0);
});

test('gate reports a late approval', async () => {
  const r = rig();
  const c = ac();
  const p = r.gate.run(op(), c.signal);
  await tick();
  c.abort();
  await p;
  r.confirms[0].answer.resolve(true);
  await tick();
  assert.deepEqual(r.late, [['MAIN.x', 'the request was cancelled']]);
  assert.equal(r.sent.length, 0);
});

test('gate reports a late approval after the deadline', async () => {
  const r = rig({ dialogMs: 10 });
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.clock.advance(11);
  await p;
  r.confirms[0].answer.resolve(true);
  await tick();
  assert.equal(r.late.length, 1);
  assert.equal(r.sent.length, 0);
});

test('gate reports a late approval after dispose', async () => {
  const r = rig();
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.gate.dispose();
  await p;
  r.confirms[0].answer.resolve(true);
  await tick();
  assert.deepEqual(r.late, [['MAIN.x', 'IECode was shut down']]);
});

test('gate sends nothing when disposed during the host start', async () => {
  for (const decision of ['allow', 'confirm'] as const) {
    const r = rig();
    r.state.decision = decision;
    const started = deferred<void>();
    const wrote: string[] = [];
    r.send = async (o, b) => {
      await started.promise;
      const why = b();
      if (why) return { kind: 'refused', reason: why };
      wrote.push(o.symbol);
      return { kind: 'written', readBack: o.value };
    };
    const p = r.gate.run(op(), ac().signal);
    await tick();
    if (decision === 'confirm') { r.confirms[0].answer.resolve(true); await tick(); }
    r.gate.dispose();
    started.resolve();
    assert.equal(refused(await p), 'IECode was shut down');
    await tick();
    assert.deepEqual(wrote, []);
  }
});

test('gate refuses at once after dispose', async () => {
  const r = rig();
  r.gate.dispose();
  assert.equal(refused(await r.gate.run(op(), ac().signal)), 'IECode was shut down');
  assert.equal(r.confirms.length, 0);
});

test('gate keeps the outcome of a sent write after dispose', async () => {
  const r = rig();
  r.state.decision = 'allow';
  const done = deferred<void>();
  r.send = async (o, b) => {
    assert.equal(b(), undefined);
    await done.promise;
    return { kind: 'unknown', reason: 'no reply' };
  };
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.gate.dispose();
  done.resolve();
  assert.deepEqual(await p, { kind: 'unknown', reason: 'no reply' });
});

test('gate drops a cancelled op from the queue', async () => {
  const r = rig({ maxQueued: 1 });
  const p1 = r.gate.run(op('MAIN.a'), ac().signal);
  const c2 = ac();
  const p2 = r.gate.run(op('MAIN.b'), c2.signal);
  await tick();
  c2.abort();
  assert.equal(refused(await p2), 'the request was cancelled');
  // the slot is free again
  const p3 = r.gate.run(op('MAIN.c'), ac().signal);
  await tick();
  assert.equal(r.confirms.length, 1, 'no dialog for the cancelled op');
  r.confirms[0].answer.resolve(true);
  await p1;
  await tick();
  assert.equal(r.confirms.length, 2);
  assert.equal(r.confirms[1].op.symbol, 'MAIN.c');
  r.confirms[1].answer.resolve(true);
  assert.equal((await p3).kind, 'written');
});

test('gate expires a queued op behind a stale dialog', async () => {
  const r = rig({ operationMs: 30_000, dialogMs: 100_000 });
  void r.gate.run(op('MAIN.a'), ac().signal);
  const p2 = r.gate.run(op('MAIN.b'), ac().signal);
  await tick();
  r.clock.advance(30_001);
  assert.equal(refused(await p2), 'the request waited too long');
  assert.equal(r.confirms.length, 1);
});

test('gate opens no dialog without time left', async () => {
  const r = rig({ operationMs: 4_000 });
  assert.equal(refused(await r.gate.run(op(), ac().signal)), 'the request waited too long');
  assert.equal(r.confirms.length, 0);
});

test('gate maps a plain send error to unknown', async () => {
  assert.deepEqual(sendOutcome(new WriteNotSent('nope')), { kind: 'refused', reason: 'nope' });
  assert.deepEqual(sendOutcome(new WriteOutcomeUnknown('maybe')), { kind: 'unknown', reason: 'maybe' });
  assert.deepEqual(sendOutcome(new Error('x')), { kind: 'unknown', reason: 'x' });
  assert.deepEqual(sendOutcome('str'), { kind: 'unknown', reason: 'str' });
  const r = rig();
  r.state.decision = 'allow';
  r.send = async () => { throw new Error('boom'); };
  assert.deepEqual(await r.gate.run(op(), ac().signal), { kind: 'unknown', reason: 'boom' });
});

test('gate refuses when the access got stricter after the user confirmed', async () => {
  const r = rig();
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.state.decision = 'refuse';
  r.confirms[0].answer.resolve(true);
  assert.match(refused(await p), /AI writes are off/);
  assert.equal(r.sent.length, 0);
});

test('gate refuses an allow that now needs confirmation', async () => {
  const r = rig();
  r.state.decision = 'allow';
  const gateOpen = deferred<void>();
  r.send = async (o, b) => { await gateOpen.promise; const why = b(); return why ? { kind: 'refused', reason: why } : { kind: 'written', readBack: '1' }; };
  const p = r.gate.run(op(), ac().signal);
  await tick();
  r.state.decision = 'confirm';
  gateOpen.resolve();
  assert.match(refused(await p), /needs the user's confirmation now/);
});

test('gate takes a prepared Copilot approval', async () => {
  const r = rig();
  const res = await r.gate.run(op('MAIN.x', { via: 'Copilot', prepared: { decision: 'confirm' } }), ac().signal);
  assert.equal(res.kind, 'written');
  assert.equal(r.confirms.length, 0, 'Copilot shows its own confirmation');
});

test('gate refuses a Copilot op without a prepare step', async () => {
  const r = rig();
  const res = await r.gate.run(op('MAIN.x', { via: 'Copilot' }), ac().signal);
  assert.match(refused(res), /needs the user's confirmation now; call adsWrite again/);
});

test('gate refuses a prepared allow that now needs confirmation', async () => {
  const r = rig();
  r.state.decision = 'confirm';
  const res = await r.gate.run(op('MAIN.x', { via: 'Copilot', prepared: { decision: 'allow' } }), ac().signal);
  assert.match(refused(res), /changed after this write was prepared.*call adsWrite again/);
  assert.equal(r.sent.length, 0);
});

test('gate refuses a prepared write after the target changed', async () => {
  const r = rig();
  r.state.target = 'B:851';
  const res = await r.gate.run(op('MAIN.x', { via: 'Copilot', prepared: { decision: 'confirm' } }), ac().signal);
  assert.match(refused(res), /A:851.*B:851/);
});

test('gate shares one queue for Copilot and MCP', async () => {
  const r = rig();
  r.state.decision = 'allow';
  const slow = deferred<void>();
  const order: string[] = [];
  r.send = async (o, b) => { b(); order.push(`start ${o.symbol}`); if (o.via === 'MCP') await slow.promise; order.push(`end ${o.symbol}`); return { kind: 'written', readBack: o.value }; };
  const p1 = r.gate.run(op('MAIN.mcp', { via: 'MCP' }), ac().signal);
  const p2 = r.gate.run(op('MAIN.cp', { via: 'Copilot', prepared: { decision: 'allow' } }), ac().signal);
  await tick();
  assert.deepEqual(order, ['start MAIN.mcp']);
  slow.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['start MAIN.mcp', 'end MAIN.mcp', 'start MAIN.cp', 'end MAIN.cp']);
});

// ---- texts ----

test('writeResultText for all kinds', () => {
  const o = op('MAIN.x');
  assert.equal(writeResultText({ kind: 'written', readBack: '5' }, o), 'Written. MAIN.x reads back as 5 (the PLC may change it again).\nADS target: A');
  assert.equal(writeResultText({ kind: 'written', readBack: null, readBackError: 'link down' }, o),
    'Written, but MAIN.x could not be read back: link down. Read it before acting on the value.\nADS target: A');
  assert.equal(writeResultText({ kind: 'refused', reason: 'the request was cancelled' }, o), 'Not written: the request was cancelled.\nADS target: A');
  assert.equal(writeResultText({ kind: 'refused', reason: 'ends with a dot.' }, o), 'Not written: ends with a dot.\nADS target: A');
  assert.equal(writeResultText({ kind: 'unknown', reason: 'no reply' }, o),
    'Outcome unknown: no reply. Do not write again on your own; read MAIN.x and ask the user.\nADS target: A');
});

test('writeResultText tells a bit that differs after an accepted write from a plain read-back', () => {
  const o = op('MAIN.bStart', { value: 'TRUE' });
  assert.equal(writeResultText({ kind: 'written', readBack: 'FALSE' }, o),
    'Written (accepted by ADS), but MAIN.bStart then reads back as FALSE, not TRUE: it changed after the write (the PLC may have changed it). Read it again before acting on it.\nADS target: A');
  assert.equal(writeResultText({ kind: 'written', readBack: 'TRUE' }, o), 'Written. MAIN.bStart reads back as TRUE (the PLC may change it again).\nADS target: A');
  // INT and STRING keep the old wording
  assert.equal(writeResultText({ kind: 'written', readBack: '0' }, op('MAIN.n', { value: '1' })), 'Written. MAIN.n reads back as 0 (the PLC may change it again).\nADS target: A');
  assert.equal(writeResultText({ kind: 'written', readBack: 'abd' }, op('MAIN.s', { value: 'abc' })), 'Written. MAIN.s reads back as abd (the PLC may change it again).\nADS target: A');
});

test('writeResultIsError marks refused and unknown, not a written value', () => {
  assert.equal(writeResultIsError({ kind: 'written', readBack: '1' }), false);
  assert.equal(writeResultIsError({ kind: 'written', readBack: null, readBackError: 'x' }), false);
  assert.equal(writeResultIsError({ kind: 'refused', reason: 'x' }), true);
  assert.equal(writeResultIsError({ kind: 'unknown', reason: 'x' }), true);
});

// ---- prepared writes ----

test('prepared writes hand each record out once', () => {
  const clock = new FakeClock();
  const p = new PreparedWrites(150_000, clock.now);
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  assert.deepEqual(p.take('k'), { decision: 'confirm', targetKey: 'A:851' });
  assert.equal(p.take('k'), undefined);
  assert.equal(p.take('other'), undefined);
});

test('prepared writes refuse an ambiguous key', () => {
  const clock = new FakeClock();
  const p = new PreparedWrites(150_000, clock.now);
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  p.prepare('k', { decision: 'confirm', targetKey: 'B:851' });
  assert.equal(p.take('k'), undefined);
  assert.equal(p.take('k'), undefined);
  // after both invocations the key is usable again
  p.prepare('k', { decision: 'allow', targetKey: 'A:851' });
  assert.deepEqual(p.take('k'), { decision: 'allow', targetKey: 'A:851' });
});

test('prepared writes drop old records', () => {
  const clock = new FakeClock();
  const p = new PreparedWrites(1000, clock.now);
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  clock.advance(1001);
  assert.equal(p.take('k'), undefined);
  // an expired record does not make a fresh prepare ambiguous
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  clock.advance(1001);
  p.prepare('k', { decision: 'allow', targetKey: 'B:851' });
  assert.deepEqual(p.take('k'), { decision: 'allow', targetKey: 'B:851' });
});

test('prepared writes keep at most 100 records', () => {
  const clock = new FakeClock();
  const p = new PreparedWrites(150_000, clock.now);
  for (let i = 0; i < 100; i++) p.prepare(`k${i}`, { decision: 'confirm', targetKey: 'A:851' });
  p.prepare('new', { decision: 'confirm', targetKey: 'A:851' });
  assert.equal(p.take('k0'), undefined);
  assert.ok(p.take('new'));
});

test('prepared writes survive a declined confirmation and a retry', () => {
  const clock = new FakeClock();
  const p = new PreparedWrites(150_000, clock.now);
  // the first confirmation was declined, so its invoke never ran and the record stayed
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  assert.deepEqual(p.take('k'), { decision: 'confirm', targetKey: 'A:851' });
  // one record is left over from the declined call; it must not poison the next retry either
  p.prepare('k', { decision: 'confirm', targetKey: 'A:851' });
  assert.deepEqual(p.take('k'), { decision: 'confirm', targetKey: 'A:851' });
});

test('itemsOf and featureOf', () => {
  assert.deepEqual(itemsOf(op('MAIN.x')), [{ symbol: 'MAIN.x', value: '1' }]);
  assert.equal(featureOf(op('MAIN.x')), undefined);
  const b = op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }] });
  assert.equal(itemsOf(b).length, 2);
  assert.equal(featureOf(b), 'writeMany');
  assert.equal(featureOf(op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }] })), undefined);
});

test('a batch op goes through the gate like a single write: one dialog, one send', async () => {
  const r = rig();
  const b = op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }] });
  const p = r.gate.run(b, ac().signal);
  await tick();
  r.confirms[0].answer.resolve(true);
  await p;
  assert.equal(r.confirms.length, 1);
  assert.equal(r.sent.length, 1);
});

test('writeResultIsError: a done batch is an error when any item was not written', () => {
  const w = { symbol: 'a', status: 'written' as const, readBack: '1' };
  assert.equal(writeResultIsError({ kind: 'done', items: [w, w] }), false);
  assert.equal(writeResultIsError({ kind: 'done', items: [w, { symbol: 'b', status: 'notWritten', reason: 'x' }] }), true);
});
