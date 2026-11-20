import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeWrite, ExecDeps } from '../src/core/writeExec';
import { WriteNotSent, WriteOp, WriteOutcomeUnknown } from '../src/core/writeGate';
import { WriteItem } from '../src/core/writeText';

const op = (extra: Partial<WriteOp> = {}): WriteOp => ({ symbol: 'MAIN.a', value: '1', targetKey: 'A:851', via: 'MCP', ...extra });
const batch = (): WriteOp => op({ items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }] });

function rig(over: Partial<ExecDeps> = {}) {
  const calls: string[] = [];
  let clock = 0;
  const deps: ExecDeps = {
    async sleep(ms) { calls.push(`sleep ${ms}`); clock += ms + 4; },
    now: () => clock,
    async readBefore(symbols) { calls.push(`readBefore ${symbols.join(',')}`); return symbols.map(symbol => ({ symbol, type: 'BOOL', value: 'FALSE' })); },
    async writeOne(item, beforeSend) { calls.push(`writeOne ${item.symbol}=${item.value}`); const why = beforeSend(); if (why) throw new WriteNotSent(why); return { value: item.value }; },
    async writeMany(items: WriteItem[], beforeSend) {
      calls.push('many'); const why = beforeSend(); if (why) throw new WriteNotSent(why);
      return { items: items.map(i => ({ symbol: i.symbol, status: 'written' as const, readBack: i.value })) };
    },
    ...over,
  };
  return { calls, deps };
}

test("a single op calls writeOne once and returns today's result", async () => {
  const r = rig();
  assert.deepEqual(await executeWrite(op(), () => undefined, r.deps), { kind: 'written', readBack: '1', readBackError: undefined });
  assert.deepEqual(r.calls, ['writeOne MAIN.a=1']);
});

test('a batch op calls writeMany once with the items in order and returns done', async () => {
  const r = rig();
  const res = await executeWrite(batch(), () => undefined, r.deps);
  assert.deepEqual(r.calls, ['many']);
  assert.deepEqual(res, { kind: 'done', items: [{ symbol: 'MAIN.a', status: 'written', readBack: '1' }, { symbol: 'MAIN.b', status: 'written', readBack: '2' }] });
});

test('one item in the list goes through writeOne and is wrapped as done', async () => {
  const r = rig({ async writeOne() { return { value: null, readBackError: 'link down' }; } });
  const res = await executeWrite(op({ items: [{ symbol: 'MAIN.a', value: '1' }] }), () => undefined, r.deps);
  assert.deepEqual(res, { kind: 'done', items: [{ symbol: 'MAIN.a', status: 'written', readBack: null, readBackError: 'link down' }] });
});

test('a not-sent rejection of a batch is refused, any other rejection is unknown', async () => {
  const notSent = rig({ async writeMany() { throw new WriteNotSent("writes[1] MAIN.b: 'zz' is not a valid INT."); } });
  assert.deepEqual(await executeWrite(batch(), () => undefined, notSent.deps), { kind: 'refused', reason: "writes[1] MAIN.b: 'zz' is not a valid INT." });
  const unknown = rig({ async writeMany() { throw new WriteOutcomeUnknown('Write of 2 values timed out; the values may or may not have been written'); } });
  assert.equal((await executeWrite(batch(), () => undefined, unknown.deps)).kind, 'unknown');
  const plain = rig({ async writeMany() { throw new Error('boom'); } });
  assert.deepEqual(await executeWrite(batch(), () => undefined, plain.deps), { kind: 'unknown', reason: 'boom' });
});

test('a beforeSend refusal reaches the host and ends the op refused', async () => {
  const r = rig();
  assert.deepEqual(await executeWrite(batch(), () => 'settings changed', r.deps), { kind: 'refused', reason: 'settings changed' });
});

const pulseOp = (extra: Partial<WriteItem> = {}): WriteOp =>
  op({ symbol: 'MAIN.b', value: 'TRUE', items: [{ symbol: 'MAIN.b', value: 'TRUE', pulseMs: 200, ...extra }] });

test('a pulse writes the value, waits, then writes the opposite', async () => {
  const r = rig();
  const res = await executeWrite(pulseOp(), () => undefined, r.deps);
  assert.deepEqual(r.calls, ['readBefore MAIN.b', 'writeOne MAIN.b=TRUE', 'sleep 200', 'writeOne MAIN.b=FALSE']);
  assert.deepEqual(res, { kind: 'done', items: [{ symbol: 'MAIN.b', status: 'written', readBack: 'TRUE', pulse: { ms: 200, heldMs: 204, reset: 'FALSE', state: 'done' } }] });
});

test('a pulse on a non-BOOL is refused before anything is sent', async () => {
  const r = rig({ async readBefore(symbols) { return symbols.map(symbol => ({ symbol, type: 'INT', value: '3' })); } });
  assert.deepEqual(await executeWrite(pulseOp(), () => undefined, r.deps), { kind: 'refused', reason: 'pulseMs works on BOOL variables only; MAIN.b is INT' });
  assert.deepEqual(r.calls, []);
});

test('an unreadable type refuses the pulse', async () => {
  const r = rig({ async readBefore(symbols) { return symbols.map(symbol => ({ symbol, type: null, value: null, error: 'link down' })); } });
  assert.deepEqual(await executeWrite(pulseOp(), () => undefined, r.deps), { kind: 'refused', reason: 'cannot check the type of MAIN.b: link down' });
});

test('a failing reset says the bit may still be set', async () => {
  let n = 0;
  const notSent = rig({ async writeOne(item) { if (++n === 2) throw new WriteNotSent('x'); return { value: item.value }; } });
  const a = await executeWrite(pulseOp(), () => undefined, notSent.deps);
  assert.ok(a.kind === 'done' && a.items[0].status === 'written' && a.items[0].pulse?.state === 'notSent');
  n = 0;
  const unknown = rig({ async writeOne(item) { if (++n === 2) throw new Error('no reply'); return { value: item.value }; } });
  const b = await executeWrite(pulseOp(), () => undefined, unknown.deps);
  assert.ok(b.kind === 'done' && b.items[0].status === 'written' && b.items[0].pulse?.state === 'unknown');
});

test('a pulse item that was not written gets no reset', async () => {
  const r = rig({ async writeMany(items) { return { items: items.map(i => ({ symbol: i.symbol, status: 'notWritten' as const, reason: 'rejected' })) }; } });
  const o = op({ items: [{ symbol: 'MAIN.b', value: 'TRUE', pulseMs: 100 }, { symbol: 'MAIN.c', value: '1' }] });
  await executeWrite(o, () => undefined, r.deps);
  assert.ok(!r.calls.some(c => c.startsWith('sleep')));
});

test('an unknown first write still tries the reset', async () => {
  const r = rig({ async writeOne() { throw new WriteOutcomeUnknown('timed out'); } });
  const res = await executeWrite(pulseOp(), () => undefined, r.deps);
  assert.equal(res.kind, 'unknown');
  assert.ok(r.calls.includes('sleep 200'));
  assert.match((res as { reason: string }).reason, /the reset of MAIN\.b to FALSE did not go through/);
});

test('the reset runs although the approval is gone: it gets no beforeSend', async () => {
  const seen: (string | undefined)[] = [];
  const r = rig({ async writeOne(item, before) { seen.push(before()); return { value: item.value }; } });
  await executeWrite(pulseOp(), () => 'the request was cancelled', r.deps);
  // the first write is refused by beforeSend (the host would throw); here writeOne only records what the callback returns
  assert.deepEqual(seen, ['the request was cancelled', undefined]);
});

test('a pulse in a batch uses one sum write for the call and a plain write for the reset', async () => {
  const r = rig();
  const o = op({ items: [{ symbol: 'MAIN.b', value: 'TRUE', pulseMs: 10 }, { symbol: 'MAIN.n', value: '5' }] });
  const res = await executeWrite(o, () => undefined, r.deps);
  assert.deepEqual(r.calls.filter(c => c === 'many' || c.startsWith('writeOne')), ['many', 'writeOne MAIN.b=FALSE']);
  assert.ok(res.kind === 'done' && res.items[0].status === 'written' && res.items[0].pulse?.state === 'done');
});

// ---- journal ----

import { WriteJournal } from '../src/core/writeJournal';

function journaled(over: Partial<ExecDeps> = {}, values: Record<string, string | null> = {}) {
  const r = rig({
    async readBefore(symbols) {
      r.calls.push(`readBefore ${symbols.join(',')}`);
      return symbols.map(symbol => (values[symbol] === null ? { symbol, type: null, value: null, error: 'link down' } : { symbol, type: 'INT', value: values[symbol] ?? '0' }));
    },
    ...over,
  });
  const journal = new WriteJournal();
  r.deps.journal = journal;
  return { ...r, journal };
}

test('a written item is journaled with the old value read before the write', async () => {
  const r = journaled({}, { 'MAIN.a': '7' });
  await executeWrite(op(), () => undefined, r.deps);
  assert.deepEqual(r.calls, ['readBefore MAIN.a', 'writeOne MAIN.a=1']);
  assert.deepEqual(r.journal.entries().map(e => [e.symbol, e.oldValue, e.newValue, e.outcome, e.kind]), [['MAIN.a', '7', '1', 'written', 'write']]);
});

test('a failed old-value read is journaled with the error and does not block the write', async () => {
  const r = journaled({}, { 'MAIN.a': null });
  const res = await executeWrite(op(), () => undefined, r.deps);
  assert.equal(res.kind, 'written');
  assert.deepEqual(r.journal.entries().map(e => [e.oldValue, e.oldValueError]), [[null, 'link down']]);
});

test('a read that throws is journaled as an unread old value, the write still runs', async () => {
  const r = journaled({ async readBefore() { throw new Error('boom'); } });
  const res = await executeWrite(op(), () => undefined, r.deps);
  assert.equal(res.kind, 'written');
  assert.equal(r.journal.entries()[0].oldValueError, 'boom');
});

test('a not-written item is not journaled, an unknown one is', async () => {
  const r = journaled({
    async writeMany() { return { items: [{ symbol: 'MAIN.a', status: 'notWritten' as const, reason: 'rejected' }, { symbol: 'MAIN.b', status: 'unknown' as const, reason: 'no reply' }, { symbol: 'MAIN.c', status: 'written' as const, readBack: '2' }] }; },
  });
  await executeWrite(op({ items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }, { symbol: 'MAIN.c', value: '2' }] }), () => undefined, r.deps);
  assert.deepEqual(r.journal.entries().map(e => [e.symbol, e.outcome]), [['MAIN.b', 'unknown'], ['MAIN.c', 'written']]);
});

test('a refused op is not journaled', async () => {
  const r = journaled();
  await executeWrite(batch(), () => 'settings changed', r.deps);
  assert.deepEqual(r.journal.entries(), []);
});

test('a batch that ends unknown journals every item as unknown', async () => {
  const r = journaled({ async writeMany() { throw new WriteOutcomeUnknown('timed out'); } });
  await executeWrite(batch(), () => undefined, r.deps);
  assert.deepEqual(r.journal.entries().map(e => e.outcome), ['unknown', 'unknown']);
});

test('a pulse item is journaled once, flagged pulse; the type check reuses the one read', async () => {
  const r = journaled({ async readBefore(symbols) { r.calls.push(`readBefore ${symbols.join(',')}`); return symbols.map(symbol => ({ symbol, type: 'BOOL', value: 'FALSE' })); } });
  await executeWrite(pulseOp(), () => undefined, r.deps);
  assert.equal(r.calls.filter(c => c.startsWith('readBefore')).length, 1);
  assert.deepEqual(r.journal.entries().map(e => [e.symbol, e.pulse, e.oldValue]), [['MAIN.b', true, 'FALSE']]);
});

test('persistent symbols are flagged in the journal', async () => {
  const r = journaled();
  await executeWrite(op({ persistent: ['MAIN.a'] }), () => undefined, r.deps);
  assert.equal(r.journal.entries()[0].persistent, true);
});

test('a restore op journals its writes as restore and marks the written symbols restored', async () => {
  const r = journaled();
  r.journal.record({ targetKey: 'A:851', via: 'MCP', kind: 'write', outcome: 'written', symbol: 'MAIN.a', oldValue: '1', newValue: '2' });
  r.journal.record({ targetKey: 'A:851', via: 'MCP', kind: 'write', outcome: 'written', symbol: 'MAIN.b', oldValue: '5', newValue: '6' });
  const restore = op({ items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '5' }], restore: { skipped: [], remaining: 0 } });
  const rr = journaled({ async writeMany(items) { return { items: [{ symbol: items[0].symbol, status: 'written' as const, readBack: '1' }, { symbol: items[1].symbol, status: 'notWritten' as const, reason: 'rejected' }] }; } });
  rr.deps.journal = r.journal;
  await executeWrite(restore, () => undefined, rr.deps);
  const all = r.journal.entries();
  assert.deepEqual(all.filter(e => e.kind === 'restore').map(e => e.symbol), ['MAIN.a']);
  assert.deepEqual(all.filter(e => e.kind === 'write').map(e => [e.symbol, !!e.restored]), [['MAIN.a', true], ['MAIN.b', false]]);
});

test('the reset of a pulse is not sent to another target than the approved one', async () => {
  let target = 'A:851';
  const r = rig({ targetKey: () => target, async sleep(ms) { r.calls.push(`sleep ${ms}`); target = 'B:851'; } });
  const res = await executeWrite(pulseOp(), () => undefined, r.deps);
  assert.deepEqual(r.calls.filter(c => c.startsWith('writeOne')), ['writeOne MAIN.b=TRUE']);
  assert.equal(res.kind, 'done');
  if (res.kind !== 'done') return;
  const item = res.items[0];
  assert.equal(item.status, 'written');
  const p = (item as { pulse?: { state: string; reason?: string } }).pulse!;
  assert.equal(p.state, 'notSent');
  assert.match(p.reason!, /target changed from A:851 to B:851.*may still be set on A:851/);
});
