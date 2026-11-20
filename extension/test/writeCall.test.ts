import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareWrite, WriteCallDeps } from '../src/core/writeCall';
import { WriteInput } from '../src/core/toolInput';
import { WriteOp } from '../src/core/writeGate';
import { RestorePlan } from '../src/core/writeJournal';

const deps = (over: Partial<WriteCallDeps> = {}): WriteCallDeps => ({ targetKey: () => 'A:851', ...over });
const op = async (input: WriteInput, d: WriteCallDeps = deps()): Promise<WriteOp> => {
  const c = await prepareWrite(input, 'MCP', d);
  assert.ok('op' in c, JSON.stringify(c));
  return (c as { op: WriteOp }).op;
};
const text = async (input: WriteInput, d: WriteCallDeps = deps()) => {
  const c = await prepareWrite(input, 'MCP', d);
  assert.ok('text' in c, 'expected a text');
  return (c as { text: { text: string; isError?: boolean } }).text;
};

test('a single write is the plain op, a pulse and a batch carry items', async () => {
  assert.deepEqual(await op({ symbol: 'MAIN.x', value: '5' }), { symbol: 'MAIN.x', value: '5', targetKey: 'A:851', via: 'MCP' });
  const p = await op({ symbol: 'MAIN.b', value: 'TRUE', pulseMs: 100 });
  assert.deepEqual(p.items, [{ symbol: 'MAIN.b', value: 'TRUE', pulseMs: 100 }]);
  const b = await op({ writes: [{ symbol: 'A', value: '1' }, { symbol: 'B', value: '2' }] });
  assert.equal(b.items?.length, 2);
  assert.equal(b.symbol, 'A');
});

test('journal returns its text and no op', async () => {
  assert.deepEqual(await text({ journal: true }, deps({ journal: () => ({ text: 'the journal' }) })), { text: 'the journal' });
});

test('a batch on a host without the feature is refused before any op', async () => {
  const t = await text({ writes: [{ symbol: 'A', value: '1' }, { symbol: 'B', value: '2' }] }, deps({ requires: async () => 'this needs a newer iecode CLI: batch write' }));
  assert.deepEqual(t, { text: 'Not written: this needs a newer iecode CLI: batch write.', isError: true });
  // a single write needs no feature
  await op({ symbol: 'A', value: '1' }, deps({ requires: async () => 'never asked' }));
});

test('a write to persistent data is refused without confirmPersistent and carries the list with it', async () => {
  const persistentOf = async (s: string[]) => s.filter(x => x.startsWith('GVL.P'));
  const t = await text({ symbol: 'GVL.P.n', value: '1' }, deps({ persistentOf }));
  assert.equal(t.isError, true);
  assert.match(t.text, /^Not written: GVL\.P\.n is PERSISTENT data/);
  const o = await op({ symbol: 'GVL.P.n', value: '1', confirmPersistent: true }, deps({ persistentOf }));
  assert.deepEqual(o.persistent, ['GVL.P.n']);
  const plain = await op({ symbol: 'MAIN.x', value: '1' }, deps({ persistentOf }));
  assert.equal(plain.persistent, undefined);
});

const plan = (over: Partial<RestorePlan> = {}): RestorePlan => ({ writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '5' }], skipped: [], remaining: 0, ...over });

test('restore with nothing to do returns the text and no op', async () => {
  const t = await text({ restore: true }, deps({ restorePlan: async () => plan({ writes: [] }) }));
  assert.equal(t.text, 'Nothing to restore: no AI write of this session is left that has a known old value on A:851.');
  const withSkips = await text({ restore: true }, deps({ restorePlan: async () => plan({ writes: [], skipped: [{ symbol: 'MAIN.c', reason: 'old value was not read (x)' }] }) }));
  assert.match(withSkips.text, /\nSkipped \(not restored\): MAIN\.c \(old value was not read \(x\)\)$/);
});

test('restore builds one op with the restore flag and the plan items', async () => {
  const o = await op({ restore: true }, deps({ restorePlan: async () => plan({ skipped: [{ symbol: 'MAIN.c', reason: 'r' }], remaining: 2 }) }));
  assert.deepEqual(o.items, [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '5' }]);
  assert.deepEqual(o.restore, { skipped: [{ symbol: 'MAIN.c', reason: 'r' }], remaining: 2 });
});

test('restore of several values on an old CLI says it needs a newer iecode CLI', async () => {
  const t = await text({ restore: true }, deps({ restorePlan: async () => plan(), requires: async () => 'this needs a newer iecode CLI: batch write' }));
  assert.match(t.text, /^Not written: this needs a newer iecode CLI/);
});

test('restore of persistent symbols needs confirmPersistent', async () => {
  const d = deps({ restorePlan: async () => plan(), persistentOf: async s => s.filter(x => x === 'MAIN.b') });
  assert.match((await text({ restore: true }, d)).text, /^Not written: MAIN\.b is PERSISTENT/);
  assert.deepEqual((await op({ restore: true, confirmPersistent: true }, d)).persistent, ['MAIN.b']);
});
