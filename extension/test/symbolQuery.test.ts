import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elementPrefixes, matchesQuery } from '../src/core/symbolQuery';

test('elementPrefixes: the array elements a prefix names', () => {
  assert.deepEqual(elementPrefixes('MAIN.afb[2].'), ['MAIN.afb[2]']);
  assert.deepEqual(elementPrefixes('MAIN.afb[2].sub'), ['MAIN.afb[2]']);
  assert.deepEqual(elementPrefixes('A[1, 2].B[3].'), ['A[1, 2]', 'A[1, 2].B[3]']);
  assert.deepEqual(elementPrefixes('MAIN.afb[2]'), []);
  assert.deepEqual(elementPrefixes('MAIN.fb.'), []);
  assert.deepEqual(elementPrefixes(''), []);
});

test('matchesQuery: a prefix with blanks between the indexes still matches the name', () => {
  const q = { filter: '', prefix: 'MAIN.a[1, 2].', type: '', offset: 0 };
  assert.equal(matchesQuery({ name: 'MAIN.a[1,2].nState', type: 'INT' }, q), true);
  assert.equal(matchesQuery({ name: 'MAIN.a[1,3].nState', type: 'INT' }, q), false);
});
