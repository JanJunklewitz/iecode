import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbolsInput, parseWatchInput, wantsFullList, parseReadInput, parseScopeInput, parseWriteInput, parseWaitInput, parseConfigInput, parsePresetInput, parseCaptureInput } from '../src/core/toolInput';

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

test('parseWatchInput reads force and clearAi with their rules', () => {
  assert.deepEqual(parseWatchInput({ remove: ['a'], force: true }), { ok: true, value: { add: [], remove: ['a'], force: true } });
  assert.deepEqual(parseWatchInput({ force: true }), { ok: false, error: 'force needs remove' });
  assert.deepEqual(parseWatchInput({ force: 'yes', remove: ['a'] }), { ok: false, error: 'force must be a boolean' });
  assert.deepEqual(parseWatchInput({ clearAi: true }), { ok: true, value: { add: [], remove: [], clearAi: true } });
  assert.deepEqual(parseWatchInput({ clearAi: 1 }), { ok: false, error: 'clearAi must be a boolean' });
  assert.deepEqual(parseWatchInput({ clearAi: true, add: ['a'] }), { ok: false, error: 'clearAi cannot be combined with add or remove' });
  assert.equal(wantsFullList({ add: [], remove: [], clearAi: true }), false);
});

test('parseWatchInput reads the group fields and rejects contradictory ones', () => {
  assert.deepEqual(parseWatchInput({ add: ['a'], group: ' T1 ' }), { ok: true, value: { add: ['a'], remove: [], group: 'T1' } });
  assert.deepEqual(parseWatchInput({ group: 'T1', enable: false }), { ok: true, value: { add: [], remove: [], group: 'T1', enable: false } });
  assert.deepEqual(parseWatchInput({ group: 'T1', removeGroup: true }), { ok: true, value: { add: [], remove: [], group: 'T1', removeGroup: true } });
  const bad = (raw: unknown, error: string) => assert.deepEqual(parseWatchInput(raw), { ok: false, error });
  bad({ enable: true }, 'enable needs group');
  bad({ removeGroup: true }, 'removeGroup needs group');
  bad({ group: 'T1', enable: true, removeGroup: true }, 'enable and removeGroup cannot be combined');
  bad({ group: 'T1', removeGroup: true, add: ['a'] }, 'removeGroup cannot be combined with add or remove');
  bad({ group: 'T1', remove: ['a'] }, 'group cannot be combined with remove; use removeGroup to remove a whole group');
  bad({ group: 'T1' }, 'group needs add, enable or removeGroup');
  bad({ group: ' ', add: ['a'] }, 'group must not be blank');
  bad({ group: 'T1', add: ['a'], clearAi: true }, 'clearAi cannot be combined with add, remove or group');
});

test('wantsFullList is false for a group operation', () => {
  assert.equal(wantsFullList({ add: [], remove: [], group: 'T1', enable: false }), false);
});

test('a group cannot be combined with list', () => {
  assert.deepEqual(parseWatchInput({ group: 'T1', add: ['a'], list: true }), { ok: false, error: 'list cannot be combined with group' });
});

test('parseWriteInput keeps the single form exactly and accepts a batch', () => {
  assert.deepEqual(parseWriteInput({ symbol: 'MAIN.x', value: '1' }), { ok: true, value: { symbol: 'MAIN.x', value: '1' } });
  assert.deepEqual(parseWriteInput({ writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '' }] }),
    { ok: true, value: { writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '' }] } });
});

test('parseWriteInput refuses a bad batch before any dialog, with the item named', () => {
  const err = (raw: unknown) => { const p = parseWriteInput(raw); assert.equal(p.ok, false); return p.ok ? '' : p.error; };
  assert.equal(err({ symbol: 'a', value: '1', writes: [{ symbol: 'b', value: '2' }] }), 'use either symbol and value or writes, not both');
  assert.equal(err({ writes: 'x' }), 'writes must be an array of { symbol, value } objects');
  assert.equal(err({ writes: ['x'] }), 'writes must be an array of { symbol, value } objects');
  assert.equal(err({ writes: [] }), 'writes must not be empty');
  assert.equal(err({ writes: Array.from({ length: 21 }, (_, i) => ({ symbol: `S${i}`, value: '1' })) }), 'writes has more than 20 entries');
  assert.equal(err({ writes: [{ symbol: 'a', value: '1' }, { symbol: 'b' }] }), 'writes[1].value must be a string');
  assert.equal(err({ writes: [{ value: '1' }] }), 'writes[0].symbol must be a string');
  assert.equal(err({ writes: [{ symbol: ' ', value: '1' }] }), 'writes[0].symbol must not be blank');
  assert.equal(err({ writes: [{ symbol: 'a', value: 'v'.repeat(4097) }] }), 'writes[0].value is longer than 4096 characters');
  assert.equal(err({ writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'B', value: '1' }, { symbol: ' main.A ', value: '2' }] }), 'writes[2] repeats writes[0]: MAIN.a');
  assert.equal(parseWriteInput({ writes: Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, value: '1' })) }).ok, true);
});

test('parseSymbolsInput takes prefix, type and offset', () => {
  assert.deepEqual(parseSymbolsInput({ prefix: 'MAIN.', type: 'BOOL', offset: 100 }), { ok: true, value: { filter: '', prefix: 'MAIN.', type: 'BOOL', offset: 100 } });
  assert.deepEqual(parseSymbolsInput({ offset: -1 }), { ok: false, error: 'offset must be a whole number of 0 or more' });
  assert.deepEqual(parseSymbolsInput({ offset: 1.5 }), { ok: false, error: 'offset must be a whole number of 0 or more' });
  assert.deepEqual(parseSymbolsInput({ prefix: 5 }), { ok: false, error: 'prefix must be a string' });
});

test('parseSymbolsInput takes enumType and hidden and leaves absent keys out', () => {
  assert.deepEqual(parseSymbolsInput({ filter: 'x', enumType: 'E_Mode', hidden: true }), { ok: true, value: { filter: 'x', enumType: 'E_Mode', hidden: true } });
  assert.deepEqual(parseSymbolsInput({ filter: 'MAIN.' }), { ok: true, value: { filter: 'MAIN.' } });
  assert.deepEqual(parseSymbolsInput({ enumType: '' }), { ok: true, value: { filter: '' } });
  assert.deepEqual(parseSymbolsInput({ hidden: 'yes' }), { ok: false, error: 'hidden must be true or false' });
  assert.deepEqual(parseSymbolsInput({ enumType: 5 }), { ok: false, error: 'enumType must be a string' });
});

test('parseConfigInput rounds but does not clamp, and rejects non-numbers', () => {
  assert.deepEqual(parseConfigInput({}), { ok: true, value: {} });
  assert.deepEqual(parseConfigInput({ pollMs: 20 }), { ok: true, value: { pollMs: 20 } });
  assert.deepEqual(parseConfigInput({ pollMs: 20.6, bufferSeconds: 5000 }), { ok: true, value: { pollMs: 21, bufferSeconds: 5000 } });
  assert.deepEqual(parseConfigInput({ pollMs: '20' }), { ok: false, error: 'pollMs must be a finite number' });
  assert.deepEqual(parseConfigInput({ bufferSeconds: NaN }), { ok: false, error: 'bufferSeconds must be a finite number' });
});

test('parsePresetInput lists without arguments and needs a path with a preset', () => {
  assert.deepEqual(parsePresetInput({}), { ok: true, value: {} });
  assert.deepEqual(parsePresetInput({ path: ' MAIN.fbSeq ', preset: 'seq' }), { ok: true, value: { path: 'MAIN.fbSeq', preset: 'seq' } });
  assert.deepEqual(parsePresetInput({ preset: 'seq' }), { ok: false, error: 'path is required with preset' });
  assert.deepEqual(parsePresetInput({ path: ' ', preset: 'seq' }), { ok: false, error: 'path must not be blank' });
  assert.deepEqual(parsePresetInput({ path: 'x'.repeat(513) }), { ok: false, error: 'path is longer than 512 characters' });
});

test('parseCaptureInput applies the defaults and clamps the windows', () => {
  const base = { symbol: 'MAIN.nStep', condition: '= 40' };
  const p = parseCaptureInput(base);
  assert.ok(p.ok);
  if (p.ok) {
    assert.deepEqual({ ...p.value, condition: undefined }, { symbol: 'MAIN.nStep', condition: undefined, preSeconds: 5, postSeconds: 5, timeoutSeconds: 30, symbols: [] });
  }
  const q = parseCaptureInput({ ...base, preSeconds: 700, postSeconds: 90 });
  assert.ok(q.ok && q.value.preSeconds === 600 && q.value.postSeconds === 60);
  const n = parseCaptureInput({ ...base, preSeconds: -1 });
  assert.ok(n.ok && n.value.preSeconds === 0);
  assert.deepEqual(parseCaptureInput({ ...base, postSeconds: '5' }), { ok: false, error: 'postSeconds must be a finite number' });
  assert.equal(parseCaptureInput({ symbol: 'x', condition: 'bogus' }).ok, false);
  const s = parseCaptureInput({ ...base, symbols: ['A', 'B'] });
  assert.ok(s.ok && s.value.symbols.join() === 'A,B');
});
