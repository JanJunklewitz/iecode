import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchList } from '../src/core/watchList';
import { WatchEntry } from '../src/core/adswatch';
import { runWatchRequest } from '../src/core/watchRequest';

function fakeList(initial: WatchEntry[] = []) {
  let list = initial;
  const w = new WatchList({ entries: () => list, set: async e => { await Promise.resolve(); list = e; }, groupsOff: () => [], setGroupsOff: async () => undefined });
  return { w, list: () => list };
}
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
