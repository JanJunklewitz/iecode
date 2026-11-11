import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbolsInput, parseWatchInput, parseReadInput, parseScopeInput, parseWriteInput, parseWaitInput } from '../src/core/toolInput';

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
