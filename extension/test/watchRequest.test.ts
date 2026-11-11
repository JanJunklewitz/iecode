import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchList } from '../src/core/watchList';
import { WatchEntry } from '../src/core/adswatch';
import { runWatchRequest } from '../src/core/watchRequest';

function fakeList(initial: WatchEntry[] = []) {
  let list = initial;
  let off: string[] = [];
  let active: string[] = [];
  const w = new WatchList({
    entries: () => list,
    set: async (e, a) => { await Promise.resolve(); list = e; active = a; },
    groupsOff: () => off,
    setGroupsOff: async k => { off = k; },
  });
  return { w, list: () => list, active: () => active };
}
const yes = async () => true;
const signal = () => new AbortController().signal;

test('force asks once for all user entries and removes them on yes', async () => {
  const f = fakeList([{ symbol: 'U1', ai: false }, { symbol: 'U2', ai: false }, { symbol: 'A', ai: true }]);
  const asked: string[][] = [];
  const r = await runWatchRequest(f.w, { add: [], remove: ['U1', 'U2', 'A'], force: true }, async s => { asked.push(s); return true; }, signal());
  assert.deepEqual(asked, [['U1', 'U2']]);
  assert.deepEqual(r.removed, ['U1', 'U2', 'A']);
  assert.deepEqual(r.declined, []);
  assert.deepEqual(f.list(), []);
});

test('a declined confirmation keeps the user entries and says so; AI entries still go', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }]);
  const r = await runWatchRequest(f.w, { add: [], remove: ['U', 'A'], force: true }, async () => false, signal());
  assert.deepEqual({ removed: r.removed, declined: r.declined, kept: r.kept }, { removed: ['A'], declined: ['U'], kept: [] });
  assert.deepEqual(f.list(), [{ symbol: 'U', ai: false }]);
});

test('without force nothing is asked and the user entry is kept', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }]);
  let asked = 0;
  const r = await runWatchRequest(f.w, { add: [], remove: ['U'] }, async () => { asked++; return true; }, signal());
  assert.equal(asked, 0);
  assert.deepEqual(r.kept, ['U']);
});

test('a confirmation that throws counts as no, and none is asked when no user entry is named', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }]);
  const r = await runWatchRequest(f.w, { add: [], remove: ['U'], force: true }, async () => { throw new Error('x'); }, signal());
  assert.deepEqual(r.declined, ['U']);
  let asked = 0;
  await runWatchRequest(f.w, { add: [], remove: ['A'], force: true }, async () => { asked++; return true; }, signal());
  assert.equal(asked, 0);
});

test('the confirmation does not block other list edits while it is open', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }]);
  let answer!: (v: boolean) => void;
  const p = runWatchRequest(f.w, { add: [], remove: ['U'], force: true }, () => new Promise<boolean>(r => { answer = r; }), signal());
  await f.w.aiEdit(['B'], []);
  assert.deepEqual(f.list().map(e => e.symbol), ['U', 'B']);
  answer(true);
  assert.deepEqual((await p).removed, ['U']);
});

test('add into a group, switch it off, switch it on, remove it', async () => {
  const f = fakeList();
  const sig = new AbortController().signal;
  const a = await runWatchRequest(f.w, { add: ['A', 'B'], remove: [], group: 'T1' }, yes, sig);
  assert.deepEqual([a.added, a.grouped], [['A', 'B'], ['A', 'B']]);
  const off = await runWatchRequest(f.w, { add: [], remove: [], group: 'T1', enable: false }, yes, sig);
  assert.deepEqual(off.groupOp, { name: 'T1', action: 'off', members: 2 });
  assert.deepEqual(f.active(), []);
  const on = await runWatchRequest(f.w, { add: [], remove: [], group: 'T1', enable: true }, yes, sig);
  assert.deepEqual(on.groupOp, { name: 'T1', action: 'on', members: 2 });
  const gone = await runWatchRequest(f.w, { add: [], remove: [], group: 'T1', removeGroup: true }, yes, sig);
  assert.deepEqual([gone.groupOp?.action, gone.removed], ['removed', ['A', 'B']]);
  const none = await runWatchRequest(f.w, { add: [], remove: [], group: 'T9', enable: true }, yes, sig);
  assert.deepEqual(none.groupOp, { name: 'T9', action: 'none', members: 0 });
});

test('add with enable: false prepares a switched-off group', async () => {
  const f = fakeList();
  await runWatchRequest(f.w, { add: ['A'], remove: [], group: 'T1', enable: false }, yes, new AbortController().signal);
  assert.deepEqual(f.active(), []);
  assert.equal(f.list().length, 1);
});
