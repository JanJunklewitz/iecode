import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchItem } from '../src/core/adswatch';
import { UnresolvedNotes } from '../src/core/unresolved';

const it = (symbol: string, error: string | null = null): WatchItem => ({ symbol, type: error ? '' : 'INT', numeric: false, error });

test('an unresolved entry is reported once, and again after it resolved and broke', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('a', 'Symbol not found'), it('b')]), [{ symbol: 'a', error: 'Symbol not found' }]);
  assert.deepEqual(n.take([it('a', 'Symbol not found')]), []);
  assert.deepEqual(n.take([it('a')]), []);
  assert.deepEqual(n.take([it('a', 'Symbol not found')]), [{ symbol: 'a', error: 'Symbol not found' }]);
});

test('an entry removed from the list is forgotten; reset forgets everything', () => {
  const n = new UnresolvedNotes();
  n.take([it('a', 'e')]);
  n.take([]);
  assert.equal(n.take([it('a', 'e')]).length, 1);
  n.reset();
  assert.equal(n.take([it('a', 'e')]).length, 1);
});

test('symbols of this call are marked reported without being returned', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('X', 'e')], ['x']), []);
  assert.deepEqual(n.take([it('X', 'e')]), []);
});
