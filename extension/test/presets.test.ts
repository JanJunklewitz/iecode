import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PRESETS, MAX_PRESET_MEMBERS, parsePresets, presetListText, presetSymbols, presetText, unknownPresetText } from '../src/core/presets';

test('parsePresets keeps valid presets and reports bad ones', () => {
  const r = parsePresets({ seq: ['nStep', 'sStepText', 'stErr.sText', 'aTimes[2]'], 'bad name!': ['x'], mode: ['bad member', 'eMode'] });
  assert.deepEqual(r.presets, { seq: ['nStep', 'sStepText', 'stErr.sText', 'aTimes[2]'], mode: ['eMode'] });
  assert.deepEqual(r.problems, ['preset "bad name!": the name may use letters, digits, space, _ and - (1-40 characters)', 'preset "mode": member "bad member" is not a member path']);
});

test('parsePresets of a non-object or an empty value is no presets and no problem', () => {
  assert.deepEqual(parsePresets(undefined), { presets: {}, problems: [] });
  assert.deepEqual(parsePresets({}), { presets: {}, problems: [] });
  assert.deepEqual(parsePresets([]).problems, ['iecode.ads.presets must be an object of name -> list of member names']);
  assert.deepEqual(parsePresets({ a: 'x' }).problems, ['preset "a": the value must be a list of member names']);
});

test('parsePresets caps presets and members with one problem line each', () => {
  const many = Object.fromEntries(Array.from({ length: MAX_PRESETS + 1 }, (_, i) => [`p${i}`, ['a']]));
  const r = parsePresets(many);
  assert.equal(Object.keys(r.presets).length, MAX_PRESETS);
  assert.deepEqual(r.problems, [`more than ${MAX_PRESETS} presets: the rest is ignored`]);
  const wide = parsePresets({ w: Array.from({ length: MAX_PRESET_MEMBERS + 2 }, (_, i) => `m${i}`) });
  assert.equal(wide.presets.w.length, MAX_PRESET_MEMBERS);
  assert.deepEqual(wide.problems, [`preset "w": more than ${MAX_PRESET_MEMBERS} members, the rest is ignored`]);
});

test('presetSymbols joins path and members', () => {
  assert.deepEqual(presetSymbols('MAIN.fbSeq', ['nStep', 'stErr.sText']), ['MAIN.fbSeq.nStep', 'MAIN.fbSeq.stErr.sText']);
});

test('presetText prints one block and names the missing members', () => {
  assert.equal(presetText({ path: 'MAIN.fbSeq', preset: 'seq', target: 'local', results: [
    { symbol: 'MAIN.fbSeq.nStep', type: 'INT', value: '40', error: null },
    { symbol: 'MAIN.fbSeq.sStepText', type: 'STRING(80)', value: 'Wait for release', error: null },
    { symbol: 'MAIN.fbSeq.nGone', type: '', value: null, error: 'Symbol not found' }] }),
  'Preset "seq" of MAIN.fbSeq on local:\nnStep : INT = 40\nsStepText : STRING(80) = "Wait for release"\nnGone : error Symbol not found\n1 of 3 members could not be read: nGone');
});

test('presetListText lists names with members, problems and the empty case', () => {
  assert.equal(presetListText({ presets: { seq: ['nStep', 'bBusy'], mode: ['eMode'] }, problems: [] }), 'seq: nStep, bBusy\nmode: eMode');
  assert.equal(presetListText({ presets: {}, problems: [] }), 'No presets defined. Add them in the setting iecode.ads.presets, e.g. { "sequencer": ["nStep", "sStepText", "bBusy"] }.');
  assert.equal(presetListText({ presets: { a: ['x'] }, problems: ['p1'] }), 'a: x\nProblem: p1');
});

test('unknownPresetText names the defined presets', () => {
  assert.equal(unknownPresetText('x', { seq: [], mode: [] }), 'Error: no preset "x"; defined: seq, mode');
  assert.equal(unknownPresetText('x', {}), 'Error: no preset "x"; none defined');
});
