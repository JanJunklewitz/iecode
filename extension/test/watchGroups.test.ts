import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchEntry } from '../src/core/adswatch';
import { activeSymbols, addToGroup, dropGroup, groupNameError, groupSummaries, isActive } from '../src/core/watchGroups';

const e = (symbol: string, ai: boolean, groups?: string[]): WatchEntry => (groups ? { symbol, ai, groups } : { symbol, ai });

test('an entry is sampled when it has no group or one of its groups is on', () => {
  assert.equal(isActive(e('a', true), ['t1']), true);
  assert.equal(isActive(e('a', true, ['T1']), ['t1']), false);
  assert.equal(isActive(e('a', true, ['T1', 'T2']), ['t1']), true);
});

test('activeSymbols keeps held symbols of a switched-off group', () => {
  const list = [e('a', true, ['T1']), e('b', false)];
  assert.deepEqual(activeSymbols(list, ['t1'], []), ['b']);
  assert.deepEqual(activeSymbols(list, ['t1'], ['A']), ['a', 'b']);
});

test('groupSummaries counts members in order of first appearance', () => {
  assert.deepEqual(groupSummaries([e('a', true, ['T1']), e('b', true, ['t1', 'T2'])], ['t2']),
    [{ name: 'T1', count: 2, on: true }, { name: 'T2', count: 1, on: false }]);
});

test("addToGroup labels AI entries and refuses the user's", () => {
  const r = addToGroup([e('a', true), e('u', false)], ['a', 'U', 'A', 'nope'], ' T1 ');
  assert.deepEqual(r, { entries: [e('a', true, ['T1']), e('u', false)], grouped: ['a'], refused: ['U'] });
  assert.deepEqual(addToGroup(r.entries, ['a'], 't1').entries, r.entries);
});

test('dropGroup keeps entries of other groups and removes the rest', () => {
  const r = dropGroup([e('a', true, ['T1']), e('b', true, ['T1', 'T2']), e('c', true)], 'T1');
  assert.deepEqual(r, { entries: [e('b', true, ['T2']), e('c', true)], removed: ['a'] });
});

test('group names are validated', () => {
  assert.equal(groupNameError('  '), 'group must not be blank');
  assert.equal(groupNameError('x'.repeat(65)), 'group is longer than 64 characters');
  assert.equal(groupNameError('T1'), undefined);
});
