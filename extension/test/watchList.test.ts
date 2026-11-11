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

// Like the host: the list is saved first, then the host start can fail, so `set` throws after the save.
function savedThenFails(initial: WatchEntry[] = []) {
  let list = initial;
  let failures = 0;
  const w = new WatchList({ entries: () => list, set: async e => { list = e; if (failures > 0) { failures--; throw new Error('host down'); } } });
  return { w, list: () => list, failNext: (n = 1) => { failures = n; } };
}

test('a release whose save fails still drops its hold, so a later wait removes its entry', async () => {
  const f = savedThenFails();
  const h = await f.w.hold('P');
  f.failNext();
  await assert.rejects(h.release(), /host down/);
  assert.deepEqual(f.list(), []);
  const h2 = await f.w.hold('P');
  await h2.release();
  assert.deepEqual(f.list(), []);
});

test('a hold whose save fails keeps no hold and takes its entry back', async () => {
  const f = savedThenFails([{ symbol: 'A', ai: false }]);
  f.failNext();
  await assert.rejects(f.w.hold('P'), /host down/);
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: false }]);
  // no hold record left: an AI add then remove of the symbol is not postponed
  await f.w.aiEdit(['P'], []);
  await f.w.aiEdit([], ['P']);
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: false }]);
});

test('a hold whose save and take-back both fail rejects with the first error', async () => {
  const f = savedThenFails();
  f.failNext(2);
  await assert.rejects(f.w.hold('P'), /host down/);
  await f.w.aiEdit([], ['P']);
  assert.deepEqual(f.list(), []);
});

test('a user edit whose save fails still ends the removed holds', async () => {
  const f = savedThenFails();
  const removed: string[][] = [];
  f.w.onUserRemoved(s => removed.push(s));
  const h = await f.w.hold('P');
  f.failNext();
  await assert.rejects(f.w.userEdit(() => []), /host down/);
  assert.deepEqual(removed, [['P']]);
  await h.release();
  assert.deepEqual(f.list(), []);
});

test('aiEdit reports what it added, what was there, what it removed and what it refused', async () => {
  const f = fake([{ symbol: 'U', ai: false }, { symbol: 'X', ai: true }]);
  const r = await f.w.aiEdit(['A', 'u', ' B ', 'a'], ['x', 'zz', 'U']);
  assert.deepEqual(r, { added: ['A', 'B'], already: ['u'], removed: ['x'], kept: ['U'], held: [], missing: ['zz'] });
  assert.deepEqual(f.list().map(e => e.symbol), ['U', 'A', 'B']);
});

test('aiEdit says a removal was postponed by a running wait', async () => {
  const f = fake();
  const h = await f.w.hold('P');
  const r = await f.w.aiEdit([], ['p']);
  assert.deepEqual(r, { added: [], already: [], removed: [], kept: [], held: ['p'], missing: [] });
  assert.equal(f.list().length, 1);
  await h.release();
  assert.equal(f.list().length, 0);
});

test("clearAi removes every AI entry that no wait holds and keeps the user's", async () => {
  const f = fake([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }, { symbol: 'B', ai: true }]);
  const h = await f.w.hold('B');
  const r = await f.w.aiEdit([], [], { clearAi: true });
  assert.deepEqual(r.removed, ['A']);
  assert.deepEqual(r.held, ['B']);
  assert.deepEqual(f.list().map(e => e.symbol), ['U', 'B']);
  await h.release();
  assert.deepEqual(f.list().map(e => e.symbol), ['U']);
});

test('removeUser removes exactly the confirmed user entries', async () => {
  const f = fake([{ symbol: 'U1', ai: false }, { symbol: 'U2', ai: false }]);
  const r = await f.w.aiEdit([], ['u1', 'U2'], { removeUser: ['u1'] });
  assert.deepEqual(r, { added: [], already: [], removed: ['u1'], kept: ['U2'], held: [], missing: [] });
  assert.deepEqual(f.list(), [{ symbol: 'U2', ai: false }]);
});

test('a user entry that a wait holds is not removed even when confirmed', async () => {
  const f = fake([{ symbol: 'U', ai: false }]);
  const h = await f.w.hold('U');
  const r = await f.w.aiEdit([], ['U'], { removeUser: ['U'] });
  assert.deepEqual(r.held, ['U']);
  await h.release();
  assert.deepEqual(f.list(), [{ symbol: 'U', ai: false }]);
});

test('userOwned names the requested entries the user added', () => {
  const f = fake([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }]);
  assert.deepEqual(f.w.userOwned(['u', 'a', 'zz']), ['u']);
});
