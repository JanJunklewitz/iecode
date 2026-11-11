import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolQuery, matchesQuery, pageNote, queryText } from '../src/core/symbolQuery';

const q = (p: Partial<SymbolQuery>): SymbolQuery => ({ filter: '', prefix: '', type: '', offset: 0, ...p });

test('filter is a case-insensitive contains', () => {
  assert.equal(matchesQuery({ name: 'MAIN.fbMotor.bEnable', type: 'BOOL' }, q({ filter: 'enable' })), true);
  assert.equal(matchesQuery({ name: 'MAIN.fbMotor.bEnable', type: 'BOOL' }, q({ filter: 'zz' })), false);
});

test('a prefix ending in a dot lists direct members only', () => {
  const m = (name: string, prefix: string) => matchesQuery({ name, type: 'INT' }, q({ prefix }));
  assert.equal(m('MAIN.fbMotor.bEnable', 'main.fbmotor.'), true);
  assert.equal(m('MAIN.fbMotor.stStatus.fSpeed', 'main.fbmotor.'), false);
  assert.equal(m('MAIN.fbMotor', 'main.fbmotor.'), false);
  for (const n of ['MAIN.fbMotor.bEnable', 'MAIN.fbMotor.stStatus.fSpeed', 'MAIN.fbMotor']) assert.equal(m(n, 'MAIN.fbMotor'), true, n);
});

test('type matches whole types and array element types', () => {
  const t = (type: string, want: string) => matchesQuery({ name: 'MAIN.x', type }, q({ type: want }));
  assert.equal(t('Tc2_Standard.TON', 'TON'), true);
  assert.equal(t('TON', 'Tc2_Standard.TON'), true);
  assert.equal(t('STRING(80)', 'string'), true);
  assert.equal(t('STRING(20)', 'STRING(20)'), true);
  assert.equal(t('STRING(80)', 'STRING(20)'), false);
  assert.equal(t('ARRAY [0..9] OF INT', 'INT'), true);
  assert.equal(t('INT', 'DINT'), false);
  assert.equal(t('DINT', 'INT'), false);
  // the build output stores a top-level BOOL as BIT
  assert.equal(t('BIT', 'BOOL'), true);
  assert.equal(t('BOOL', 'bit'), true);
});

test('queryText', () => {
  assert.equal(queryText(q({ filter: 'zz' })), 'zz');
  assert.equal(queryText(q({ prefix: 'MAIN.', type: 'BOOL' })), 'prefix MAIN. and type BOOL');
  assert.equal(queryText(q({})), '');
  assert.equal(queryText(q({ filter: 'x', type: 'BOOL' })), 'filter x and type BOOL');
});

test('pageNote', () => {
  assert.equal(pageNote({ total: 50, offset: 0, pageSize: 100 }), undefined);
  assert.equal(pageNote({ total: 357, offset: 0, pageSize: 100 }), '(257 more not listed; narrow the filter or continue with offset 100)');
  assert.equal(pageNote({ total: 357, offset: 100, pageSize: 100 }), '(rows 101-200 of 357; 157 more, continue with offset 200)');
  assert.equal(pageNote({ total: 357, offset: 300, pageSize: 100 }), '(rows 301-357 of 357; end of list)');
  assert.equal(pageNote({ total: 357, offset: 400, pageSize: 100 }), 'No rows at offset 400: 357 symbols match.');
});
