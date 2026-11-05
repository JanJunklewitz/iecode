import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbolsInput, parseWatchInput, parseReadInput, parseScopeInput, parseWriteInput } from '../src/core/toolInput';

test('toolInput accepts valid input', () => {
  assert.deepEqual(parseSymbolsInput({ filter: 'MAIN.' }), { ok: true, value: { filter: 'MAIN.' } });
  assert.deepEqual(parseWatchInput({ add: ['a'], remove: ['b'] }), { ok: true, value: { add: ['a'], remove: ['b'] } });
  assert.deepEqual(parseReadInput({ symbols: ['a', 'b'] }), { ok: true, value: { symbols: ['a', 'b'] } });
  assert.deepEqual(parseScopeInput({ symbols: ['a'], seconds: 30 }), { ok: true, value: { symbols: ['a'], seconds: 30 } });
  assert.deepEqual(parseWriteInput({ symbol: 'MAIN.x', value: '1' }), { ok: true, value: { symbol: 'MAIN.x', value: '1' } });
});

test('toolInput rejects wrong types', () => {
  assert.deepEqual(parseWatchInput({ add: 'x' }), { ok: false, error: 'add must be an array of strings' });
  assert.deepEqual(parseReadInput({ symbols: [1] }), { ok: false, error: 'symbols must be an array of strings' });
  assert.deepEqual(parseReadInput(null), { ok: false, error: 'arguments must be an object' });
  assert.deepEqual(parseReadInput([]), { ok: false, error: 'arguments must be an object' });
  assert.equal(parseWriteInput({ symbol: 'a' }).ok, false);
  assert.equal(parseSymbolsInput({ filter: 5 }).ok, false);
});

test('toolInput enforces limits', () => {
  assert.equal(parseSymbolsInput({ filter: 'x'.repeat(513) }).ok, false);
  assert.equal(parseReadInput({ symbols: Array(201).fill('a') }).ok, false);
  assert.equal(parseScopeInput({ seconds: 'NaN' }).ok, false);
});

test('toolInput boundaries', () => {
  assert.equal(parseWriteInput({ symbol: 'x'.repeat(512), value: 'v'.repeat(4096) }).ok, true);
  assert.equal(parseWriteInput({ symbol: 'a', value: 'v'.repeat(4097) }).ok, false);
  assert.equal(parseReadInput({ symbols: Array(200).fill('a') }).ok, true);
  assert.equal(parseReadInput({ symbols: ['x'.repeat(513)] }).ok, false);
  for (const s of [NaN, Infinity, -Infinity]) assert.equal(parseScopeInput({ seconds: s }).ok, false);
});

test('toolInput optional fields', () => {
  assert.deepEqual(parseWatchInput(undefined), { ok: true, value: { add: [], remove: [] } });
  assert.deepEqual(parseWatchInput({ add: null }), { ok: true, value: { add: [], remove: [] } });
  assert.deepEqual(parseScopeInput({}), { ok: true, value: { symbols: [] } });
  assert.deepEqual(parseSymbolsInput(undefined), { ok: true, value: { filter: '' } });
});

test('toolInput write symbol and value', () => {
  assert.equal(parseWriteInput({ symbol: '  ', value: '1' }).ok, false);
  assert.deepEqual(parseWriteInput({ symbol: 'a', value: '' }), { ok: true, value: { symbol: 'a', value: '' } });
});
