import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { WatchList } from '../src/core/watchList';
import { WatchEntry, watchEdit } from '../src/core/adswatch';

function fake(initial: WatchEntry[] = [], offInitial: string[] = []) {
  let list = initial;
  let off = offInitial;
  let active: string[] = [];
  const sets: WatchEntry[][] = [];
  const w = new WatchList({
    entries: () => list,
    set: async (e, a, o) => { await Promise.resolve(); list = e; active = a; off = o; sets.push(e); },
    groupsOff: () => off,
  });
  return { w, list: () => list, sets, active: () => active, off: () => off };
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
  const w = new WatchList({ entries: () => list, set: async e => { if (fail) throw new Error('disk full'); list = e; }, groupsOff: () => [] });
  await assert.rejects(w.aiEdit(['A'], []), /disk full/);
  fail = false;
  await w.aiEdit(['B'], []);
  assert.deepEqual(list, [{ symbol: 'B', ai: true }]);
});

// Like the host: the list is saved first, then the host start can fail, so `set` throws after the save.
function savedThenFails(initial: WatchEntry[] = []) {
  let list = initial;
  let failures = 0;
  const w = new WatchList({ entries: () => list, set: async e => { list = e; if (failures > 0) { failures--; throw new Error('host down'); } }, groupsOff: () => [] });
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

test('add with a group labels the entries; switching the group off stops sampling but keeps the entries', async () => {
  const f = fake();
  const r = await f.w.aiEdit(['A', 'B'], [], { group: 'T1' });
  assert.deepEqual([r.added, r.grouped, r.ungrouped, r.switchedOn], [['A', 'B'], ['A', 'B'], [], false]);
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: true, groups: ['T1'] }, { symbol: 'B', ai: true, groups: ['T1'] }]);
  assert.deepEqual(await f.w.setGroup('t1', false), { found: true, members: 2 });
  assert.deepEqual(f.active(), []);
  assert.equal(f.list().length, 2);
  await f.w.setGroup('T1', true);
  assert.deepEqual(f.active(), ['A', 'B']);
});

test('adding to a switched-off group switches it on', async () => {
  const f = fake([{ symbol: 'A', ai: true, groups: ['T1'] }], ['t1']);
  const r = await f.w.aiEdit(['B'], [], { group: 'T1' });
  assert.equal(r.switchedOn, true);
  assert.deepEqual(f.off(), []);
  assert.deepEqual(f.active(), ['A', 'B']);
});

test('a symbol in two groups is sampled until both are off', async () => {
  const f = fake();
  await f.w.aiEdit(['A'], [], { group: 'T1' });
  await f.w.aiEdit(['A'], [], { group: 'T2' });
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: true, groups: ['T1', 'T2'] }]);
  await f.w.setGroup('T1', false);
  assert.deepEqual(f.active(), ['A']);
  await f.w.setGroup('T2', false);
  assert.deepEqual(f.active(), []);
});

test('a group switched off while a wait holds a symbol keeps it sampled until the wait ends', async () => {
  const f = fake();
  await f.w.aiEdit(['P'], [], { group: 'T1' });
  const h = await f.w.hold('P');
  await f.w.setGroup('T1', false);
  assert.deepEqual(f.active(), ['P']);
  await h.release();
  assert.deepEqual(f.active(), []);
  assert.equal(f.list().length, 1);
});

test('a hold on a parked entry starts sampling it and parks it again on release', async () => {
  const f = fake([{ symbol: 'P', ai: true, groups: ['T1'] }], ['t1']);
  const h = await f.w.hold('P');
  assert.deepEqual(f.active(), ['P']);
  await h.release();
  assert.deepEqual(f.active(), []);
  assert.deepEqual(f.list(), [{ symbol: 'P', ai: true, groups: ['T1'] }]);
});

test('removeGroup removes the entries no other group needs and reports held ones', async () => {
  const f = fake();
  await f.w.aiEdit(['A', 'B'], [], { group: 'T1' });
  await f.w.aiEdit(['B'], [], { group: 'T2' });
  await f.w.setGroup('T1', false);
  const h = await f.w.hold('A');
  const r = await f.w.removeGroup('T1');
  assert.deepEqual(r, { found: true, removed: [], held: ['A'] });
  assert.deepEqual(f.list().map(e => e.symbol), ['A', 'B']);
  await h.release();
  assert.deepEqual(f.list().map(e => e.symbol), ['B']);
  assert.deepEqual(await f.w.removeGroup('T2'), { found: true, removed: ['B'], held: [] });
  assert.deepEqual(f.off(), []);
});

test('a user entry cannot join a group', async () => {
  const f = fake([{ symbol: 'U', ai: false }]);
  const r = await f.w.aiEdit(['U'], [], { group: 'T1' });
  assert.deepEqual([r.already, r.ungrouped, r.grouped], [['U'], ['U'], []]);
  assert.deepEqual(f.list(), [{ symbol: 'U', ai: false }]);
});

test('an unknown group changes nothing', async () => {
  const f = fake([{ symbol: 'A', ai: true }]);
  assert.deepEqual(await f.w.setGroup('nope', false), { found: false, members: 0 });
  assert.deepEqual(await f.w.removeGroup('nope'), { found: false, removed: [], held: [] });
  assert.equal(f.sets.length, 0);
  assert.equal(f.w.groupState('nope'), 'none');
});

test('switching a group on over the limit is refused and the group stays off', async () => {
  const user = Array.from({ length: 150 }, (_, i) => ({ symbol: `S${i}`, ai: false }));
  const parked = Array.from({ length: 60 }, (_, i) => ({ symbol: `P${i}`, ai: true, groups: ['T1'] }));
  const f = fake([...user, ...parked], ['t1']);
  await assert.rejects(f.w.setGroup('T1', true), /200/);
  assert.deepEqual(f.off(), ['t1']);
});

test('the user taking an AI entry over drops its group', async () => {
  const f = fake([{ symbol: 'A', ai: true, groups: ['T1'] }]);
  await f.w.userEdit(c => watchEdit(c, ['a']));
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: false }]);
});

test('a stale switched-off key is dropped on the next save and a new group never reports it was off', async () => {
  const f = fake([], ['t1']);
  const r = await f.w.aiEdit(['A'], [], { group: 'T1' });
  assert.equal(r.switchedOn, false);
  assert.deepEqual(f.off(), []);
  assert.deepEqual(f.active(), ['A']);
});

test('add with a group and enable: false parks the entries without ever sampling them', async () => {
  const f = fake();
  const r = await f.w.aiEdit(['A', 'B'], [], { group: 'T1', enable: false });
  assert.deepEqual([r.grouped, r.groupMembers], [['A', 'B'], 2]);
  assert.deepEqual(f.sets.length, 1);
  assert.deepEqual(f.active(), []);
  assert.deepEqual(f.off(), ['t1']);
});

test('the limit of 200 applies to the final active list of an add with enable: false', async () => {
  const user = Array.from({ length: 200 }, (_, i) => ({ symbol: `S${i}`, ai: false }));
  const f = fake(user);
  await f.w.aiEdit(['P'], [], { group: 'T1', enable: false });
  assert.equal(f.list().length, 201);
  assert.equal(f.active().length, 200);
  await assert.rejects(f.w.aiEdit(['Q'], [], { group: 'T2' }), /200/);
});

test('the stored list is capped at 1000 entries', async () => {
  const big = Array.from({ length: 1000 }, (_, i) => ({ symbol: `P${i}`, ai: true, groups: ['G'] }));
  const f = fake(big, ['g']);
  await assert.rejects(f.w.aiEdit(['X'], [], { group: 'G' }), /At most 1000 variables/);
  assert.equal(f.list().length, 1000);
});

test('a variable is in at most 8 groups and the list holds at most 50 groups', async () => {
  const f = fake([{ symbol: 'A', ai: true, groups: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'] }]);
  await assert.rejects(f.w.aiEdit(['A'], [], { group: 'g9' }), /at most 8 groups/);
  const many = Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}`, ai: true, groups: [`g${i}`] }));
  const g = fake(many);
  await assert.rejects(g.w.aiEdit(['Z'], [], { group: 'new' }), /at most 50 groups/);
  assert.equal(g.sets.length, 0);
});

test('an aborted call changes nothing', async () => {
  const f = fake([{ symbol: 'A', ai: true }]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(f.w.aiEdit(['B'], ['A'], { signal: abort.signal }), /cancelled/);
  assert.equal(f.sets.length, 0);
});

test('setGroup counts only the symbols that really start or stop being sampled', async () => {
  const f = fake([{ symbol: 'A', ai: true, groups: ['T1', 'T2'] }, { symbol: 'B', ai: true, groups: ['T1'] }]);
  assert.deepEqual(await f.w.setGroup('T1', false), { found: true, members: 1 });
  assert.deepEqual(f.active(), ['A']);
});
