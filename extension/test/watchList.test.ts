import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { WatchList } from '../src/core/watchList';
import { WatchEntry } from '../src/core/adswatch';

function fake(initial: WatchEntry[] = []) {
  let list = initial;
  const sets: WatchEntry[][] = [];
  const w = new WatchList({ entries: () => list, set: async e => { await Promise.resolve(); list = e; sets.push(e); } });
  return { w, list: () => list, sets };
}

test('a hold adds an AI entry and its release removes it', async () => {
  const f = fake();
  const h = await f.w.hold('P');
  assert.deepEqual(f.list(), [{ symbol: 'P', ai: true }]);
  await h.release();
  assert.deepEqual(f.list(), []);
});

test('two holds share one entry until the last release', async () => {
  const f = fake();
  const [a, b] = await Promise.all([f.w.hold('P'), f.w.hold('p')]);
  await a.release();
  assert.equal(f.list().length, 1);
  await b.release();
  assert.equal(f.list().length, 0);
});

test('a symbol the user watches stays after the release', async () => {
  const f = fake([{ symbol: 'P', ai: false }]);
  await (await f.w.hold('P')).release();
  assert.deepEqual(f.list(), [{ symbol: 'P', ai: false }]);
});

test('an AI add during a hold makes the entry permanent', async () => {
  const f = fake();
  const h = await f.w.hold('P');
  await f.w.aiEdit(['P'], []);
  await h.release();
  assert.deepEqual(f.list(), [{ symbol: 'P', ai: true }]);
});

test('an AI remove during a hold keeps the entry until the release', async () => {
  const f = fake();
  const h = await f.w.hold('P');
  await f.w.aiEdit([], ['P']);
  assert.equal(f.list().length, 1);
  await h.release();
  assert.equal(f.list().length, 0);
});

test('a user removal ends the hold and is reported', async () => {
  const f = fake();
  const removed: string[][] = [];
  f.w.onUserRemoved(s => removed.push(s));
  const h = await f.w.hold('P');
  await f.w.userEdit(() => []);
  assert.deepEqual(removed, [['P']]);
  await h.release();
  assert.deepEqual(f.list(), []);
  assert.equal(f.sets.length, 2);
});

test('concurrent edits each see the result of the previous one', async () => {
  const f = fake();
  await Promise.all([f.w.aiEdit(['A'], []), f.w.aiEdit(['B'], []), f.w.userEdit(c => [...c, { symbol: 'C', ai: false }])]);
  assert.deepEqual(f.list().map(e => e.symbol), ['A', 'B', 'C']);
});

test('a hold on a full list is refused with the limit text', async () => {
  const f = fake(Array.from({ length: 200 }, (_, i) => ({ symbol: `S${i}`, ai: false })));
  await assert.rejects(f.w.hold('P'), /200/);
});

test('a user taking over a held entry keeps it after the release', async () => {
  const f = fake();
  const h = await f.w.hold('P');
  await f.w.userEdit(c => c.map(e => ({ ...e, ai: false })));
  await h.release();
  assert.deepEqual(f.list(), [{ symbol: 'P', ai: false }]);
});

test('a second release changes nothing', async () => {
  const f = fake();
  const [a, b] = await Promise.all([f.w.hold('P'), f.w.hold('P')]);
  await a.release();
  await a.release();
  assert.equal(f.list().length, 1);
  await b.release();
  assert.equal(f.list().length, 0);
});

test('a failed save rejects its call and the next one still runs', async () => {
  let list: WatchEntry[] = [];
  let fail = true;
  const w = new WatchList({ entries: () => list, set: async e => { if (fail) throw new Error('disk full'); list = e; } });
  await assert.rejects(w.aiEdit(['A'], []), /disk full/);
  fail = false;
  await w.aiEdit(['B'], []);
  assert.deepEqual(list, [{ symbol: 'B', ai: true }]);
});
