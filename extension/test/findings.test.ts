import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Finding, applyLevels, offsetToPosition, summaryText } from '../src/core/findings';

const f = (rule: string, level: Finding['level'] = 'error'): Finding =>
  ({ rule, level, message: rule, file: '/a', line: 0, col: 0, endLine: 0, endCol: 1 });

test('applyLevels rewrites the level and drops off rules', () => {
  const out = applyLevels([f('a'), f('b'), f('c', 'warning')], { a: 'hint', b: 'off' }, { c: 'info' });
  assert.deepEqual(out.map(x => [x.rule, x.level]), [['a', 'hint'], ['c', 'info']]);
});

test('a rule missing from both maps keeps its own level', () => {
  assert.equal(applyLevels([f('x', 'warning')], {}, {})[0].level, 'warning');
});

test('offsetToPosition handles CRLF and the last line', () => {
  const t = 'ab\r\ncd\r\nef';
  assert.deepEqual(offsetToPosition(t, 0), { line: 0, col: 0 });
  assert.deepEqual(offsetToPosition('\nx', 0), { line: 0, col: 0 }, 'a leading line break gives no negative column');
  assert.deepEqual(offsetToPosition(t, 4), { line: 1, col: 0 });
  assert.deepEqual(offsetToPosition(t, 5), { line: 1, col: 1 });
  assert.deepEqual(offsetToPosition(t, t.length), { line: 2, col: 2 });
  assert.deepEqual(offsetToPosition(t, 999), { line: 2, col: 2 });
});

test('summaryText names counts per level and the most frequent rule, and says No findings for none', () => {
  assert.equal(summaryText([]), 'No findings');
  const list = [...Array(5)].map(() => f('name-mismatch')).concat([f('x', 'warning')], [...Array(6)].map(() => f('guid', 'warning')));
  assert.equal(summaryText(list), '12 findings: 5 errors, 7 warnings; most frequent: guid (6)');
  assert.equal(summaryText([f('only')]), '1 finding: 1 error; most frequent: only (1)');
});
