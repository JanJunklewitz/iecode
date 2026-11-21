import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_WORDS, TYPE_SHORT, TreeFilter, FilterTyping, filterIdSuffix, sameFilter, filterMessage, objectMatches, parseTreeFilter, visibleIn } from '../src/core/treeFilter';
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
test('ids get a generation suffix', () => assert.equal(filterIdSuffix(3), '#f3'));
const typing = () => {
  const pending = new Map<number, () => void>(); let next = 0;
  const applied: (string | undefined)[] = []; const errors: (string | undefined)[] = [];
  const t = new FilterTyping({ set: fn => { pending.set(++next, fn); return next; }, clear: h => { pending.delete(h as number); } },
    f => applied.push(f?.text), e => errors.push(e));
  return { t, applied, errors, fire: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach(f => f()); } };
};
test('typing applies only the last text after the pause', () => {
  const x = typing(); x.t.change('mo'); x.t.change('motor');
  assert.deepEqual(x.applied, []); x.fire(); assert.deepEqual(x.applied, ['motor']);
});
test('accept applies at once and a late timer does nothing', () => {
  const x = typing(); x.t.change('motor');
  assert.equal(x.t.accept(), true); x.fire(); assert.deepEqual(x.applied, ['motor']);
});
test('accept on an invalid text keeps the box open and shows the error', () => {
  const x = typing(); x.t.change('@xyz');
  assert.equal(x.t.accept(), false); assert.deepEqual(x.applied, []); assert.match(x.errors[0]!, /Unknown kind/);
});
test('abandon drops the pending change', () => {
  const x = typing(); x.t.change('motor'); x.t.abandon(); x.fire(); assert.deepEqual(x.applied, []);
});
test('an empty text applies no filter', () => {
  const x = typing(); x.t.change('  '); assert.equal(x.t.accept(), true); assert.deepEqual(x.applied, [undefined]);
});
test('sameFilter ignores surrounding whitespace and treats none as equal to none', () => {
  const p = (s: string) => parseTreeFilter(s) as TreeFilter | undefined;
  assert.equal(sameFilter(p('motor'), p('motor ')), true);
  assert.equal(sameFilter(undefined, p(' ')), true);
  assert.equal(sameFilter(p('motor'), p('motor @fb')), false);
  assert.equal(sameFilter(undefined, p('motor')), false);
});

test('sameFilter compares words and kinds, not the typed text', () => {
  const p = (t: string) => parseTreeFilter(t) as TreeFilter | undefined;
  assert.equal(sameFilter(p('motor'), p('Motor')), true);
  assert.equal(sameFilter(p('motor axis'), p('axis   motor')), true);
  assert.equal(sameFilter(p('@fb @prg'), p('@prg @fb @fb')), true);
  assert.equal(sameFilter(p('motor @fb'), p('motor')), false);
  assert.equal(sameFilter(p('motor'), p('axis')), false);
});
