import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairRenames, similarity } from '../src/core/renameMatch';

const ten = (last: string) => Array.from({ length: 9 }, (_, i) => `line${i};`).concat(last).join('\n');

test('similarity of equal texts is 1 and of disjoint texts 0', () => {
  assert.equal(similarity('a;\nb;', 'a;\nb;'), 1);
  assert.equal(similarity('a;\nb;', 'c;\nd;'), 0);
});
test('blank lines and indentation are ignored', () => assert.equal(similarity('a;\n\n  b;', '  a;\nb;\n\n'), 1));
test('repeated lines count as often as they occur', () => assert.equal(similarity('a;\na;\na;', 'a;'), 1 / 3));
test('similarity is 0 when a side has no non-blank line', () => assert.equal(similarity('', 'a;'), 0));
test('pairRenames pairs a renamed item whose body changed by one line out of ten', () => {
  const r = pairRenames(['old'], ['new'], t => (t === 'old' ? ten('x;') : ten('y;')));
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].from, r[0].to], ['old', 'new']);
});
test('pairRenames gives no pair when two added items fit equally well', () => {
  assert.equal(pairRenames(['o'], ['n1', 'n2'], t => (t === 'o' ? ten('x;') : ten('y;'))).length, 0);
});
test('pairRenames gives no pair below the threshold', () => {
  assert.equal(pairRenames(['o'], ['n'], t => (t === 'o' ? 'a;\nb;\nc;\nd;' : 'a;\nx;\ny;\nz;')).length, 0);
});
test('pairRenames never uses an item twice', () => {
  const body = (t: string) => (t === 'n' ? ten('y;') : ten(t === 'o1' ? 'x;' : 'z;'));
  const r = pairRenames(['o1', 'o2'], ['n'], body, { threshold: 0.5 });
  assert.ok(r.length <= 1);
});
test('two one-line items with equal text are not paired', () => {
  assert.equal(pairRenames(['a'], ['b'], () => 'x := 1;').length, 0);
  assert.equal(pairRenames(['a'], ['b'], () => 'x := 1;', { minLines: 1 }).length, 1);
});
test('two removed and one added empty method give no pair', () => {
  assert.equal(pairRenames(['a', 'b'], ['c'], () => '').length, 0);
});
