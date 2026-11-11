import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopeBuffer, WatchItem, edgesText, scopeText } from '../src/core/adswatch';

const item = (symbol: string): WatchItem => ({ symbol, type: 'INT', numeric: true, error: null });
const real = (symbol: string): WatchItem => ({ symbol, type: 'REAL', numeric: true, error: null });
const bool = (symbol: string): WatchItem => ({ symbol, type: 'BOOL', numeric: true, error: null });
const text = (symbol: string): WatchItem => ({ symbol, type: 'STRING(80)', numeric: false, error: null });
const at = (values: (string | null)[], step = 1000) => values.map((v, i) => ({ t: i * step, v: [v] }));
const tableOf = (t: string) => t.slice(t.indexOf('t[s]'));
const dataRows = (t: string) => t.split('\n').filter(l => /^-?\d+\.\d+\t/.test(l));

test('changesOnly lists one row per change time with empty cells for unchanged symbols', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('A'), bool('B')]);
  const a = ['0', '0', '1', '1', '1', '2'], bb = ['FALSE', 'FALSE', 'FALSE', 'TRUE', 'TRUE', 'TRUE'];
  b.push(1, a.map((v, i) => ({ t: i * 1000, v: [v, bb[i]] })));
  const out = scopeText(b, ['A', 'B'], 100000, 5000, { changesOnly: true });
  assert.equal(tableOf(out), ['t[s]\tA\tB', '-5.000\t0\tFALSE', '-3.000\t1\t', '-2.000\t\tTRUE', '0.000\t2\t'].join('\n'));
  assert.doesNotMatch(out, /samples shown/);
});

test('changesOnly shows the value at the window start and quotes text', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [text('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => (i < 25 ? 'idle' : 'Error 5'))));
  const out = scopeText(b, ['S'], 10, 30000, { changesOnly: true });
  assert.equal(tableOf(out), ['t[s]\tS', '-10.000\t"idle"', '-5.000\t"Error 5"'].join('\n'));
  assert.match(out, /^S: changes=1 last="Error 5" \(first at -5\.0 s, last at -5\.0 s\)$/m);
});

test('changesOnly marks a start value the entry cap removed', () => {
  const b = new ScopeBuffer(1000, 2_000_000, 2);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 10 }, (_, i) => String(i))));
  const out = scopeText(b, ['S'], 9, 9000, { changesOnly: true });
  assert.match(out, /^older changes dropped: S$/m);
  assert.equal(tableOf(out), ['t[s]\tS', '-9.000\tunknown (history dropped)', '-1.000\t8', '0.000\t9'].join('\n'));
});

test('changesOnly says when the history is shorter than the request', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(['1', '1', '2']));
  const out = scopeText(b, ['S'], 100, 2000, { changesOnly: true });
  assert.match(out, /^history covers only the last 2 s$/m);
  assert.equal(tableOf(out), ['t[s]\tS', '-2.000\t1', '0.000\t2'].join('\n'));
  assert.doesNotMatch(scopeText(b, ['S'], 2, 2000, { changesOnly: true }), /history covers/);
});

test('changesOnly shows the newest rows and says how many it left out', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 300 }, (_, i) => String(i)), 10));
  const out = scopeText(b, ['S'], 100000, 2990, { changesOnly: true });
  assert.equal(dataRows(out).length, 200);
  assert.equal(dataRows(out).at(-1), '0.000\t299');
  assert.match(out, /^100 earlier rows not shown, narrow seconds or symbols$/m);
  assert.match(scopeText(b, ['S'], 100000, 2990, { changesOnly: true, maxRows: 20 }), /^280 earlier rows not shown/m);
});

test('the start row counts against maxRows', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => (i < 25 ? '7' : '1'))));
  assert.deepEqual(dataRows(scopeText(b, ['S'], 10, 30000, { changesOnly: true, maxRows: 2 })), ['-10.000\t7', '-5.000\t1']);
  const one = scopeText(b, ['S'], 10, 30000, { changesOnly: true, maxRows: 1 });
  assert.deepEqual(dataRows(one), ['-5.000\t1']);
  assert.doesNotMatch(one, /earlier rows not shown/);
});

test('changesOnly keeps every change of a long window without a thinning header', () => {
  const steps = Array.from({ length: 15 }, (_, i) => i * 7);
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.nStep')]);
  b.push(1, Array.from({ length: 1990 }, (_, i) => ({ t: i * 10, v: [String(steps[Math.min(14, Math.floor(i / 130))])] })));
  const out = scopeText(b, ['MAIN.nStep'], 100000, 19890, { changesOnly: true });
  assert.deepEqual(dataRows(out).map(l => l.split('\t')[1]), steps.map(String));
  assert.doesNotMatch(out, /samples shown/);
});

test('changesOnly rounds numeric cells to decimals', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [real('MAIN.f')]);
  b.push(1, [{ t: 0, v: ['1.23456'] }, { t: 1000, v: ['2'] }]);
  assert.equal(tableOf(scopeText(b, ['MAIN.f'], 100000, 1000, { changesOnly: true, decimals: 2 })), ['t[s]\tMAIN.f', '-1.000\t1.23', '0.000\t2'].join('\n'));
});

test('changesOnly with a constant symbol and two symbols changing at the same sample', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('A'), item('B'), item('C')]);
  b.push(1, [0, 1, 2].map(i => ({ t: i * 1000, v: [String(i), String(i * 2), '5'] })));
  assert.equal(tableOf(scopeText(b, ['A', 'B', 'C'], 100000, 2000, { changesOnly: true })),
    ['t[s]\tA\tB\tC', '-2.000\t0\t0\t5', '-1.000\t1\t2\t', '0.000\t2\t4\t'].join('\n'));
});

test('changesOnly distinguishes an empty string from an unchanged cell', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [{ symbol: 'A', type: 'T_Alias', numeric: false, error: null }, item('N')]);
  b.push(1, [{ t: 0, v: ['x', '1'] }, { t: 1000, v: ['', '2'] }]);
  assert.deepEqual(dataRows(scopeText(b, ['A', 'N'], 100000, 1000, { changesOnly: true })), ['-1.000\t"x"\t1', '0.000\t""\t2']);
});

test('changesOnly lists the first 20 symbols as columns and says so', () => {
  const names = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const b = new ScopeBuffer(100000);
  b.setItems(1, names.map(item));
  b.push(1, [0, 1].map(i => ({ t: i * 1000, v: names.map(() => String(i)) })));
  const out = scopeText(b, names, 100000, 1000, { changesOnly: true });
  assert.equal(out.split('\n').find(l => l.startsWith('t[s]'))!.split('\t').length, 21);
  assert.match(out, /first 20 of 25 symbols/);
});

test('the whole answer stays inside the budget: oldest rows go first, the columns footer stays', () => {
  const names = Array.from({ length: 200 }, (_, i) => `GVL.aVeryLongSymbolNameForTheBudgetTest${String(i).padStart(3, '0')}`);
  const b = new ScopeBuffer(100000);
  b.setItems(1, names.map(item));
  b.push(1, Array.from({ length: 100 }, (_, i) => ({ t: i * 1000, v: names.map(() => String(i)) })));
  for (const opts of [{ changesOnly: true, maxChars: 28000 }, { maxChars: 28000 }]) {
    const out = scopeText(b, names, 100000, 99000, opts);
    assert.ok(out.length <= 28000, `length ${out.length}`);
    assert.match(out, /first 20 of 200 symbols/);
    assert.match(out, /earlier rows not shown/);
    assert.ok(dataRows(out).at(-1)!.startsWith('0.000\t99'), 'newest row kept');
  }
});

test('summaries beyond 50 symbols are cut last, with a count', () => {
  const names = Array.from({ length: 200 }, (_, i) => `GVL.aVeryLongSymbolNameForTheBudgetTest${String(i).padStart(3, '0')}`);
  const b = new ScopeBuffer(100000);
  b.setItems(1, names.map(item));
  b.push(1, Array.from({ length: 3 }, (_, i) => ({ t: i * 1000, v: names.map(() => String(i)) })));
  const out = scopeText(b, names, 100000, 2000, { maxChars: 9000 });
  assert.ok(out.length <= 9000, `length ${out.length}`);
  assert.match(out, /^\(150 more summaries not shown: output size limit\)$/m);
  assert.match(out, /first 20 of 200 symbols/);
  assert.ok(out.includes('GVL.aVeryLongSymbolNameForTheBudgetTest049: min='));
  assert.ok(!out.includes('GVL.aVeryLongSymbolNameForTheBudgetTest050: min='));
});

test('edgesText lists rising and falling edges of a BOOL', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('MAIN.bBusy')]);
  b.push(1, at(['FALSE', 'TRUE', 'TRUE', 'FALSE', 'FALSE', 'TRUE']));
  assert.equal(edgesText(b, ['MAIN.bBusy'], 100, 5000), [
    'MAIN.bBusy: edges=3 (2 rising, 1 falling), now TRUE', '',
    't[s]\tsymbol\tedge', '-4.000\tMAIN.bBusy\trising', '-2.000\tMAIN.bBusy\tfalling', '0.000\tMAIN.bBusy\trising'].join('\n'));
});

test('edgesText says so for a constant BOOL, a non-BOOL, an alias and a symbol without samples', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('GVL.bDone'), item('MAIN.nStep'), bool('GVL.bX'), { symbol: 'GVL.bAlias', type: 'T_Flag', numeric: true, error: null }]);
  b.push(1, [{ t: 0, v: ['FALSE', '1', null, 'TRUE'] }, { t: 1000, v: ['FALSE', '2', null, 'FALSE'] }]);
  assert.equal(edgesText(b, ['GVL.bDone', 'MAIN.nStep', 'GVL.bX', 'GVL.bAlias'], 100, 1000), [
    'GVL.bDone: no edges in the last 100 s, stays FALSE',
    'MAIN.nStep: not a BOOL, ignored',
    'GVL.bX: no samples in the last 100 s',
    'GVL.bAlias: type T_Flag is an alias, not proven BOOL; use ads_read'].join('\n'));
});

test('edgesText shows the newest edges beyond the row limit', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('GVL.bFlag')]);
  b.push(1, at(Array.from({ length: 251 }, (_, i) => (i % 2 === 0 ? 'FALSE' : 'TRUE')), 10));
  const out = edgesText(b, ['GVL.bFlag'], 100, 2500);
  assert.match(out, /^GVL\.bFlag: edges=250 \(125 rising, 125 falling\), now FALSE$/m);
  assert.match(out, /^50 earlier edges not shown, narrow seconds or symbols$/m);
  assert.equal(out.split('\n').filter(l => /\t(rising|falling)$/.test(l)).length, 200);
  assert.equal(edgesText(b, ['GVL.bFlag'], 100, 2500, { maxRows: 5 }).split('\n').filter(l => /\t(rising|falling)$/.test(l)).length, 5);
});

test('edgesText cannot date an edge across a read error', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('B')]);
  b.push(1, at(['FALSE', null, 'TRUE', 'FALSE']));
  assert.equal(edgesText(b, ['B'], 100, 3000), [
    'B: edges=2 (1 rising, 1 falling), now FALSE', '',
    't[s]\tsymbol\tedge', 'unknown between -3.000 and -1.000\tB\trising', '0.000\tB\tfalling'].join('\n'));
  const failing = new ScopeBuffer(100000);
  failing.setItems(1, [bool('B')]);
  failing.push(1, at(['FALSE', 'TRUE', null]));
  assert.match(edgesText(failing, ['B'], 100, 2000), /^B: edges=1 \(1 rising, 0 falling\), now TRUE reading failed since 0\.0 s$/m);
});

test('edgesText with a capped log counts retained edges only', () => {
  const b = new ScopeBuffer(1000, 2_000_000, 10);
  b.setItems(1, [bool('B')]);
  b.push(1, at(Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 'FALSE' : 'TRUE'))));
  const out = edgesText(b, ['B'], 100, 49000);
  assert.match(out, /^B: edges>=10 \(5 rising, 5 falling; 10 retained edges, older edges dropped\), now TRUE$/m);
  assert.equal(out.split('\n').filter(l => /\t(rising|falling)$/.test(l)).length, 10);
});

test('edgesText keeps the whole answer inside the budget', () => {
  const names = Array.from({ length: 30 }, (_, i) => `GVL.bFlag${i}`);
  const b = new ScopeBuffer(100000);
  b.setItems(1, names.map(bool));
  b.push(1, Array.from({ length: 50 }, (_, i) => ({ t: i * 1000, v: names.map(() => (i % 2 === 0 ? 'FALSE' : 'TRUE')) })));
  const out = edgesText(b, names, 100, 49000, { maxRows: 200, maxChars: 4000 });
  assert.ok(out.length <= 4000, `length ${out.length}`);
  assert.match(out, /earlier rows not shown \(output size limit\)/);
  assert.ok(out.includes('GVL.bFlag29: edges=49'));
});

test('scopeText with edges delegates to the edge list', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('B')]);
  b.push(1, at(['FALSE', 'TRUE']));
  assert.equal(scopeText(b, ['B'], 100, 1000, { edges: true }), edgesText(b, ['B'], 100, 1000));
});
