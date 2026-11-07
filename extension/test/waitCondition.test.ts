import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCondition, classify, applicable, isValid, meets } from '../src/core/waitCondition';

const item = (type: string, numeric = true) => ({ symbol: 'S', type, numeric, error: null });
const ok = (s: string) => { const p = parseCondition(s); assert.ok(p.ok, s); return p.value; };

test('parses every operator and literal kind', () => {
  assert.deepEqual(ok('= 40'), { op: '=', literal: { kind: 'int', value: 40n } });
  assert.deepEqual(ok('>=-1.5'), { op: '>=', literal: { kind: 'real', value: -1.5 } });
  assert.deepEqual(ok('<> true'), { op: '<>', literal: { kind: 'bool', value: true } });
  assert.deepEqual(ok('= Running'), { op: '=', literal: { kind: 'name', value: 'Running' } });
  assert.deepEqual(ok('= "a \\"b\\""'), { op: '=', literal: { kind: 'string', value: 'a "b"' } });
  assert.deepEqual(ok(' changes '), { op: 'changes' });
  assert.deepEqual(ok('contains "Err"'), { op: 'contains', text: 'Err' });
});

test('bad conditions name the allowed forms', () => {
  for (const s of ['', '==1', '= ', 'contains Err', '= "open', 'between 1 2']) {
    const p = parseCondition(s);
    assert.equal(p.ok, false, s);
    if (!p.ok) assert.match(p.error, /= v, <> v, < v, <= v, > v, >= v, changes, contains "text"/);
  }
});

test('classifies by type name, then by value for aliases', () => {
  assert.equal(classify(item('LINT'), '1', null), 'integer');
  assert.equal(classify(item('LREAL'), '1.5', null), 'real');
  assert.equal(classify(item('BOOL', false), 'TRUE', null), 'bool');
  assert.equal(classify(item('STRING(80)', false), 'x', null), 'string');
  assert.equal(classify(item('E_State'), 'Running', 2), 'enum');
  assert.equal(classify(item('T_MyInt'), '12', null), 'integer');
  assert.equal(classify(item('TIME', false), '00:00:01', null), 'other');
});

test('rejects combinations the table does not allow', () => {
  assert.match(applicable(ok('< TRUE'), 'bool') ?? '', /BOOL/);
  assert.match(applicable(ok('> "a"'), 'string') ?? '', /string/i);
  assert.match(applicable(ok('= 1'), 'string') ?? '', /quoted/);
  assert.match(applicable(ok('contains "a"'), 'integer') ?? '', /contains/);
  assert.equal(applicable(ok('> 1'), 'enum'), undefined);
  assert.match(applicable(ok('> Running'), 'enum') ?? '', /enum/);
  assert.equal(applicable(ok('changes'), 'bool'), undefined);
});

test('compares per class', () => {
  assert.equal(meets(ok('= 9007199254740993'), 'integer', '9007199254740993', null, undefined), true);
  assert.equal(meets(ok('= 9007199254740993'), 'integer', '9007199254740992', null, undefined), false);
  assert.equal(meets(ok('= 1.5'), 'real', '1.50', null, undefined), true);
  assert.equal(meets(ok('> 2'), 'real', '2.0001', null, undefined), true);
  assert.equal(meets(ok('= running'), 'enum', 'Running', 2, undefined), true);
  assert.equal(meets(ok('= 2'), 'enum', 'Running', 2, undefined), true);
  assert.equal(meets(ok('= "001"'), 'string', '001', null, undefined), true);
  assert.equal(meets(ok('= "Abc"'), 'string', 'abc', null, undefined), false);
  assert.equal(meets(ok('contains "rr"'), 'string', 'Error 5', null, undefined), true);
  assert.equal(meets(ok('changes'), 'integer', '5', null, '4'), true);
  assert.equal(meets(ok('changes'), 'integer', '4', null, '4'), false);
});

test('null, NaN and Inf are never valid', () => {
  assert.equal(isValid('real', null), false);
  assert.equal(isValid('real', 'NaN'), false);
  assert.equal(isValid('real', '-Infinity'), false);
  assert.equal(isValid('string', ''), true);
});
