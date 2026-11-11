import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBackChanged, sentence } from '../src/core/writeText';

test('sentence strips exactly one trailing dot', () => {
  assert.equal(sentence('ends with a dot.'), 'ends with a dot');
  assert.equal(sentence('no dot'), 'no dot');
  assert.equal(sentence('two..'), 'two.');
});

test('without a type only the words TRUE and FALSE prove a BOOL', () => {
  assert.equal(readBackChanged('TRUE', 'FALSE'), true);
  assert.equal(readBackChanged(' false ', 'TRUE'), true);
  assert.equal(readBackChanged('TRUE', 'true'), false);
  assert.equal(readBackChanged('1', '0'), false);       // could be an INT
  assert.equal(readBackChanged('1', 'FALSE'), false);
  assert.equal(readBackChanged('1', '5'), false);
  assert.equal(readBackChanged('3.5', '3.0'), false);
  assert.equal(readBackChanged('abc', 'abd'), false);
});

test('a resolved BOOL type also accepts 1 and 0; any other type never changes the wording', () => {
  assert.equal(readBackChanged('1', 'FALSE', 'BOOL'), true);
  assert.equal(readBackChanged('TRUE', '0', 'bool'), true);
  assert.equal(readBackChanged('1', '1', 'BOOL'), false);
  assert.equal(readBackChanged('1', '0', 'INT'), false);
  assert.equal(readBackChanged('abc', 'abd', 'STRING'), false);
  assert.equal(readBackChanged('TRUE', 'FALSE', 'STRING'), false);
});
