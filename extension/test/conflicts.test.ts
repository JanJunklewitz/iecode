import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findConflicts, resolveLines } from '../src/lang/conflicts';

const text = ['a;', '<<<<<<< HEAD', 'b := 1;', '=======', 'b := 2;', 'c;', '>>>>>>> feature', 'd;'].join('\n');

test('finds a conflict block', () => {
  assert.deepEqual(findConflicts(text), [{ start: 1, sep: 3, end: 6 }]);
});

test('resolves current, incoming and both', () => {
  const lines = text.split('\n');
  const [b] = findConflicts(text);
  assert.deepEqual(resolveLines(lines, b, 'current'), ['b := 1;']);
  assert.deepEqual(resolveLines(lines, b, 'incoming'), ['b := 2;', 'c;']);
  assert.deepEqual(resolveLines(lines, b, 'both'), ['b := 1;', 'b := 2;', 'c;']);
});

test('diff3 style: the base section is dropped', () => {
  const t = ['<<<<<<< HEAD', 'x;', '||||||| base', 'y;', '=======', 'z;', '>>>>>>> f'].join('\r\n');
  const [b] = findConflicts(t);
  assert.deepEqual(b, { start: 0, base: 2, sep: 4, end: 6 });
  assert.deepEqual(resolveLines(t.split(/\r?\n/), b, 'current'), ['x;']);
});

test('incomplete blocks and ST comparisons are ignored', () => {
  assert.deepEqual(findConflicts('<<<<<<< HEAD\nx;\n'), []);
  assert.deepEqual(findConflicts('IF a <<<<<<< b THEN\n=======\n'), []);
});
