import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbolsInput, parseWatchInput, wantsFullList, parseReadInput, parseScopeInput, parseWriteInput, parseWaitInput } from '../src/core/toolInput';

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

test('toolInput wait input', () => {
  assert.equal(parseWaitInput({ condition: '= 1' }).ok, false);
  assert.equal(parseWaitInput({ symbol: '  ', condition: '= 1' }).ok, false);
  assert.equal(parseWaitInput({ symbol: 'a' }).ok, false);
  const bad = parseWaitInput({ symbol: 'a', condition: 'nonsense' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /changes/);
  const t = (timeoutSeconds?: unknown) => parseWaitInput({ symbol: 'a', condition: 'changes', timeoutSeconds });
  const secs = (p: ReturnType<typeof t>) => p.ok ? p.value.timeoutSeconds : p.error;
  assert.equal(secs(t(0)), 1);
  assert.equal(secs(t(500)), 120);
  assert.equal(secs(t(7.4)), 7);
  assert.equal(secs(t()), 30);
  assert.equal(secs(t('10')), 'timeoutSeconds must be a finite number');
  assert.deepEqual(parseWaitInput({ symbol: 'a', condition: 'changes' }), { ok: true, value: { symbol: 'a', condition: { op: 'changes' }, timeoutSeconds: 30 } });
});

test('toolInput scope maxRows and decimals are clamped, never thrown', () => {
  const v = (o: unknown) => { const p = parseScopeInput(o); return p.ok ? p.value : p.error; };
  assert.deepEqual(v({ maxRows: 20.6, decimals: 2 }), { symbols: [], maxRows: 21, decimals: 2 });
  assert.equal((v({ maxRows: 0 }) as { maxRows: number }).maxRows, 1);
  assert.equal((v({ maxRows: 5000 }) as { maxRows: number }).maxRows, 200);
  assert.equal((v({ decimals: -3 }) as { decimals: number }).decimals, 0);
  assert.equal((v({ decimals: 12 }) as { decimals: number }).decimals, 9);
  assert.equal(v({ maxRows: 'x' }), 'maxRows must be a finite number');
  assert.equal(v({ decimals: NaN }), 'decimals must be a finite number');
  assert.deepEqual(v({ symbols: ['a'], seconds: 30 }), { symbols: ['a'], seconds: 30 });   // unchanged: absent fields stay absent
});

test('toolInput scope changesOnly', () => {
  assert.deepEqual(parseScopeInput({ changesOnly: true }), { ok: true, value: { symbols: [], changesOnly: true } });
  assert.deepEqual(parseScopeInput({ changesOnly: false }), { ok: true, value: { symbols: [], changesOnly: false } });
  assert.deepEqual(parseScopeInput({ changesOnly: null }), { ok: true, value: { symbols: [] } });
  assert.deepEqual(parseScopeInput({ changesOnly: 'yes' }), { ok: false, error: 'changesOnly must be true or false' });
});

test('toolInput scope edges', () => {
  assert.deepEqual(parseScopeInput({ edges: true }), { ok: true, value: { symbols: [], edges: true } });
  assert.deepEqual(parseScopeInput({ edges: 1 }), { ok: false, error: 'edges must be true or false' });
  const both = parseScopeInput({ edges: true, changesOnly: true });
  assert.equal(both.ok, false);
  if (!both.ok) assert.match(both.error, /edges and changesOnly cannot be combined/);
  assert.equal(parseScopeInput({ edges: false, changesOnly: true }).ok, true);
});

test('parseWatchInput reads list and leaves it out when absent', () => {
  assert.deepEqual(parseWatchInput({ list: true }), { ok: true, value: { add: [], remove: [], list: true } });
  assert.deepEqual(parseWatchInput({ add: ['a'] }), { ok: true, value: { add: ['a'], remove: [] } });
  assert.deepEqual(parseWatchInput({ list: null }), { ok: true, value: { add: [], remove: [] } });
  assert.deepEqual(parseWatchInput({ list: 'yes' }), { ok: false, error: 'list must be a boolean' });
});

test('wantsFullList is true for an empty call and for list: true', () => {
  assert.equal(wantsFullList({ add: [], remove: [] }), true);
  assert.equal(wantsFullList({ add: ['a'], remove: [] }), false);
  assert.equal(wantsFullList({ add: [], remove: ['b'] }), false);
  assert.equal(wantsFullList({ add: ['a'], remove: [], list: true }), true);
});
