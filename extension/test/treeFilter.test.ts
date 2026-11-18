import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_WORDS, TYPE_SHORT, TreeFilter, filterMessage, objectMatches, parseTreeFilter, visibleIn } from '../src/core/treeFilter';
import { ObjectType, PlcObject } from '../src/core/projects';

const obj = (rel: string, type: ObjectType = 'FUNCTION_BLOCK'): PlcObject =>
  ({ rel, file: `/p/${rel}`, name: rel.split('/').pop()!.replace(/\.\w+$/, ''), type });
test('an empty filter is no filter', () => {
  assert.equal(parseTreeFilter(''), undefined); assert.equal(parseTreeFilter('   '), undefined);
});
test('words and kinds are parsed', () => {
  assert.deepEqual(parseTreeFilter(' Motor  @fb @FUN axis'), { text: 'Motor  @fb @FUN axis', words: ['motor', 'axis'], kinds: ['FUNCTION_BLOCK', 'FUNCTION'] });
});
test('an unknown kind is an error that lists the kinds', () => {
  assert.deepEqual(parseTreeFilter('@xyz'), { error: 'Unknown kind "@xyz". Kinds: @fb @prg @fun @itf @enum @struct @union @alias @gvl @task @texts @images' });
});
test('name words match case-insensitively and all must match', () => {
  const f = parseTreeFilter('motor ctrl') as TreeFilter;
  assert.equal(objectMatches(f, { name: 'FB_MotorCtrl', type: 'FUNCTION_BLOCK' }), true);
  assert.equal(objectMatches(f, { name: 'FB_Motor', type: 'FUNCTION_BLOCK' }), false);
});
test('kind words alone list every object of the kinds', () => {
  const f = parseTreeFilter('@gvl') as TreeFilter;
  assert.equal(objectMatches(f, { name: 'GVL_Io', type: 'GVL' }), true);
  assert.equal(objectMatches(f, { name: 'MAIN', type: 'PROGRAM' }), false);
});
test('folders on the path to a hit are visible, others are not', () => {
  const objs = [obj('POUs/Motion/Axis/FB_Axis.TcPOU'), obj('POUs/Io/FB_Io.TcPOU'), obj('MAIN.TcPOU', 'PROGRAM')];
  const v = visibleIn(parseTreeFilter('axis') as TreeFilter, objs);
  assert.deepEqual([...v.folders].sort(), ['POUs', 'POUs/Motion', 'POUs/Motion/Axis']);
  assert.deepEqual([...v.objects].map(o => o.name), ['FB_Axis']);
});
test('kind words are derived from the short names', () => {
  for (const [w, t] of Object.entries(KIND_WORDS)) assert.equal(TYPE_SHORT[t]!.toLowerCase(), w);
  for (const s of Object.values(TYPE_SHORT)) if (!s!.includes(' ')) assert.ok(s!.toLowerCase() in KIND_WORDS, s);
  assert.equal('visu settings' in KIND_WORDS, false);
});
test('filterMessage counts objects and projects', () => {
  const f = parseTreeFilter('@fb motor') as TreeFilter;
  assert.equal(filterMessage(f, 12, 3), 'Filter "@fb motor": 12 objects in 3 projects.');
  assert.equal(filterMessage(f, 1, 1), 'Filter "@fb motor": 1 object in 1 project.');
  assert.equal(filterMessage(f, 0, 0), 'Filter "@fb motor": nothing found.');
});
test('edge cases of the parser', () => {
  assert.ok('error' in (parseTreeFilter('@') as { error: string }));
  assert.deepEqual((parseTreeFilter('@fb @FB') as TreeFilter).kinds, ['FUNCTION_BLOCK']);
  assert.ok('error' in (parseTreeFilter('@constructor') as { error: string }));
  assert.equal(objectMatches(parseTreeFilter('@fb') as TreeFilter, { name: 'X', type: 'OTHER' }), false);
});
