import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchItem } from '../src/core/adswatch';
import { UnresolvedNotes } from '../src/core/unresolved';

const it = (symbol: string, error: string | null = null): WatchItem => ({ symbol, type: error ? '' : 'INT', numeric: false, error });
const CLI_TEXT = "Symbol 'MAIN.x' not found on 127.0.0.1.1.1:851";

test('an unresolved entry is reported once, and again after it resolved and broke', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('a', 'Symbol not found'), it('b')]), [{ symbol: 'a', error: 'Symbol not found' }]);
  assert.deepEqual(n.take([it('a', 'Symbol not found')]), []);
  assert.deepEqual(n.take([it('a')]), []);
  assert.deepEqual(n.take([it('a', 'Symbol not found')]), [{ symbol: 'a', error: 'Symbol not found' }]);
});

test('an entry removed from the list is forgotten; reset forgets everything', () => {
  const n = new UnresolvedNotes();
  n.take([it('a', 'Symbol not found')]);
  n.take([]);
  assert.equal(n.take([it('a', 'Symbol not found')]).length, 1);
  n.reset();
  assert.equal(n.take([it('a', 'Symbol not found')]).length, 1);
});

test('symbols of this call are marked reported without being returned', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('X', 'Symbol not found')], ['x']), []);
  assert.deepEqual(n.take([it('X', 'Symbol not found')]), []);
});

test('only a not-found error counts, a transient one is neither reported nor remembered', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('a', 'No connection to the target'), it('b', 'Request timed out')]), []);
  assert.deepEqual(n.take([it('a', CLI_TEXT)]), [{ symbol: 'a', error: CLI_TEXT }]);
  assert.deepEqual(n.take([it('a', 'No connection to the target')]), []);
  assert.deepEqual(n.take([it('a', CLI_TEXT)]), [{ symbol: 'a', error: CLI_TEXT }]);
});
