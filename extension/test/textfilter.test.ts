import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textFilter } from '../src/core/textfilter';

test('words: all must match, each in any field, ignoring case', () => {
  const { hit, error } = textFilter('  main   BOOL ', false);
  assert.equal(error, undefined);
  assert.ok(hit('MAIN.bStart', 'BOOL', undefined));
  assert.ok(!hit('MAIN.nCount', 'INT', 'a flag'));
  assert.ok(hit('GVL.x', 'BOOL', 'set by main'));
});

test('an empty filter matches everything, also in regex mode', () => {
  for (const q of ['', '   ']) assert.ok(textFilter(q, false).hit('x'));
  assert.ok(textFilter('', true).hit('x'));
});

test('regex: one case-insensitive expression per field, spaces are literal', () => {
  assert.ok(textFilter('^main\\.b', true).hit('MAIN.bStart'));
  assert.ok(!textFilter('^main\\.b', true).hit('GVL.MAIN.bStart'));
  assert.ok(!textFilter('a b', true).hit('a', 'b'));
  assert.ok(!textFilter('MAIN.*BOOL', true).hit('MAIN.x', 'BOOL'));
});

test('an invalid regex reports the error and hides nothing', () => {
  const { hit, error } = textFilter('(', true);
  assert.ok(error);
  assert.ok(hit('anything'));
});

test('runs from its source text, as in the webview', () => {
  const f = new Function(`return ${textFilter.toString()};`)() as typeof textFilter;
  assert.ok(f('main bool', false).hit('MAIN.x', 'BOOL'));
  assert.ok(f('^MAIN', true).hit('main.x'));
});
