import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JournalEntry, WriteJournal, journalText, planRestore, restoreFooter } from '../src/core/writeJournal';

const T = 'A:851';
const base = { targetKey: T, via: 'MCP' as const, kind: 'write' as const, outcome: 'written' as const };
const rec = (j: WriteJournal, symbol: string, oldValue: string | null, newValue: string, extra: Partial<Omit<JournalEntry, 'seq' | 'time'>> = {}) =>
  j.record({ ...base, symbol, oldValue, newValue, ...extra });
const clock = (ms: number) => `t${ms}`;

test('records in order with sequence numbers and times from the clock', () => {
  let now = 100;
  const j = new WriteJournal(500, () => now++);
  rec(j, 'MAIN.a', '1', '2');
  rec(j, 'MAIN.b', '3', '4');
  assert.deepEqual(j.entries().map(e => [e.seq, e.time, e.symbol]), [[1, 100, 'MAIN.a'], [2, 101, 'MAIN.b']]);
});

test('the cap drops the oldest entries and counts them', () => {
  const j = new WriteJournal(2);
  for (let i = 0; i < 5; i++) rec(j, `MAIN.n${i}`, '0', '1');
  assert.deepEqual(j.entries().map(e => e.symbol), ['MAIN.n3', 'MAIN.n4']);
  assert.equal(j.dropped(), 3);
});

test('entries filters by target', () => {
  const j = new WriteJournal();
  rec(j, 'MAIN.a', '1', '2');
  rec(j, 'MAIN.b', '1', '2', { targetKey: 'B:851' });
  assert.deepEqual(j.entries('B:851').map(e => e.symbol), ['MAIN.b']);
});

test('markRestored flags every write entry of the symbols on that target only', () => {
  const j = new WriteJournal();
  rec(j, 'MAIN.a', '1', '2');
  rec(j, 'main.A', '2', '3');
  rec(j, 'MAIN.a', '1', '9', { targetKey: 'B:851' });
  rec(j, 'MAIN.b', '1', '2');
  j.markRestored(['MAIN.a'], T);
  assert.deepEqual(j.entries().map(e => !!e.restored), [true, true, false, false]);
});

test('journalText pins every line form', () => {
  const entries: JournalEntry[] = [
    { ...base, seq: 1, time: 1, symbol: 'MAIN.nMode', oldValue: '1', newValue: '2' },
    { ...base, seq: 2, time: 2, symbol: 'MAIN.bStart', oldValue: 'FALSE', newValue: 'TRUE', pulse: true },
    { ...base, seq: 3, time: 3, symbol: 'MAIN.nSet', oldValue: '3', newValue: '7', outcome: 'unknown' },
    { ...base, seq: 4, time: 4, symbol: 'MAIN.nMode', oldValue: '2', newValue: '1', kind: 'restore' },
    { ...base, seq: 5, time: 5, symbol: 'MAIN.sText', oldValue: null, oldValueError: 'link down', newValue: 'abc' },
    { ...base, seq: 6, time: 6, symbol: 'MAIN.nCfg', oldValue: '1', newValue: '2', persistent: true, restored: true },
  ];
  assert.equal(journalText(entries, { target: T, dropped: 12, clock }), [
    'Writes through the ADS tools in this session on A:851 (6):',
    't1  MAIN.nMode: 1 -> 2',
    't2  MAIN.bStart: FALSE -> TRUE (pulse)',
    't3  MAIN.nSet: outcome unknown, wanted 7 (was 3)',
    't4  MAIN.nMode: 2 -> 1 (restore)',
    't5  MAIN.sText: ? -> abc (old value not read: link down)',
    't6  MAIN.nCfg: 1 -> 2 [PERSISTENT] [restored]',
    '(12 older entries dropped)',
  ].join('\n'));
  assert.equal(journalText([], { target: T, dropped: 0, clock }), 'No writes through the ADS tools in this session on A:851.');
});

const entries = (build: (j: WriteJournal) => void): JournalEntry[] => { const j = new WriteJournal(); build(j); return j.entries(); };
const none = new Map<string, string>();

test('restore takes the oldest old value per symbol, the symbol written last first', () => {
  const e = entries(j => { rec(j, 'MAIN.a', '1', '2'); rec(j, 'MAIN.a', '2', '3'); rec(j, 'MAIN.b', '7', '8'); });
  assert.deepEqual(planRestore(e, T, none), { writes: [{ symbol: 'MAIN.b', value: '7' }, { symbol: 'MAIN.a', value: '1' }], skipped: [], remaining: 0 });
});

test('an unknown outcome is restored too', () => {
  const e = entries(j => rec(j, 'MAIN.a', '1', '2', { outcome: 'unknown' }));
  assert.deepEqual(planRestore(e, T, none).writes, [{ symbol: 'MAIN.a', value: '1' }]);
});

test('an unread old value is skipped with its reason', () => {
  const e = entries(j => rec(j, 'MAIN.c', null, '2', { oldValueError: 'link down' }));
  assert.deepEqual(planRestore(e, T, none), { writes: [], skipped: [{ symbol: 'MAIN.c', reason: 'old value was not read (link down)' }], remaining: 0 });
});

test('a symbol that cannot be read now is skipped, the others stay', () => {
  const e = entries(j => { rec(j, 'MAIN.a', '1', '2'); rec(j, 'MAIN.d', '5', '6'); });
  const plan = planRestore(e, T, new Map([['main.d', "Symbol 'MAIN.d' not found"]]));
  assert.deepEqual(plan.writes, [{ symbol: 'MAIN.a', value: '1' }]);
  assert.deepEqual(plan.skipped, [{ symbol: 'MAIN.d', reason: "cannot be read now: Symbol 'MAIN.d' not found" }]);
});

test('a write on another target is skipped with a reason', () => {
  const e = entries(j => rec(j, 'MAIN.x', '1', '2', { targetKey: 'B:851' }));
  assert.deepEqual(planRestore(e, T, none), { writes: [], skipped: [{ symbol: 'MAIN.x', reason: 'written on another target (B:851)' }], remaining: 0 });
});

test('restored entries and restore entries are not planned again', () => {
  const e = entries(j => { rec(j, 'MAIN.a', '1', '2', { restored: true }); rec(j, 'MAIN.b', '2', '1', { kind: 'restore' }); });
  assert.deepEqual(planRestore(e, T, none), { writes: [], skipped: [], remaining: 0 });
});

test('more than 20 writes plan 20 and report the rest', () => {
  const e = entries(j => { for (let i = 0; i < 25; i++) rec(j, `MAIN.n${i}`, '0', '1'); });
  const plan = planRestore(e, T, none);
  assert.equal(plan.writes.length, 20);
  assert.equal(plan.remaining, 5);
  assert.equal(plan.writes[0].symbol, 'MAIN.n24');
});

test('restoreFooter lists what was skipped and what is left', () => {
  assert.equal(restoreFooter({ skipped: [{ symbol: 'MAIN.c', reason: 'old value was not read (link down)' }, { symbol: 'MAIN.d', reason: 'cannot be read now: gone' }], remaining: 2 }),
    'Skipped (not restored): MAIN.c (old value was not read (link down)), MAIN.d (cannot be read now: gone)\n2 more writes are left in the journal; call restore again.');
  assert.equal(restoreFooter({ skipped: [], remaining: 0 }), '');
});
