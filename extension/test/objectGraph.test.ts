import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolIndex } from '../src/lang/index';
import { ObjectGraph, assemble, callersOf, fileEdges, findUnused, reach, reachedFrom, whyReachable } from '../src/core/objectGraph';

const FB_A = `FUNCTION_BLOCK FB_A EXTENDS FB_Base IMPLEMENTS I_X
VAR
    fbB : FB_B;
    aItems : ARRAY[1..3] OF ST_Item;
    _n : INT;
END_VAR
//---- IMPLEMENTATION ----
_n := _n + 1;
fbB.Run(nSpeed := 3);
//==== METHOD Go ====
METHOD Go : BOOL
VAR
    nLocal : INT;
END_VAR
//---- IMPLEMENTATION ----
nLocal := 1;
Go := fbB.Run(nSpeed := nLocal); // fbB.Hidden();
sText := 'fbB.Hidden';
Unknown.Thing();
//==== PROPERTY Level ====
PROPERTY Level : INT
//==== GET Level ====
VAR
END_VAR
//---- IMPLEMENTATION ----
Level := GVL_Main.nCount + fbB.Count;
//==== ACTION Reset ====
//---- IMPLEMENTATION ----
Go();
_n := 0;
`;
const FB_B = `FUNCTION_BLOCK FB_B
VAR
    Count : INT;
END_VAR
//---- IMPLEMENTATION ----
//==== METHOD Run ====
METHOD Run : BOOL
VAR_INPUT
    nSpeed : INT;
END_VAR
//---- IMPLEMENTATION ----
Run := TRUE;
`;
const BASE = `FUNCTION_BLOCK FB_Base
//---- IMPLEMENTATION ----
`;
const ITF = `INTERFACE I_X
//---- IMPLEMENTATION ----
`;
const ITEM = `TYPE ST_Item :
STRUCT
    nId : INT;
END_STRUCT
END_TYPE
//---- IMPLEMENTATION ----
`;
const GVL = `VAR_GLOBAL
    nCount : INT;
END_VAR
//---- IMPLEMENTATION ----
`;
const PRG = `PROGRAM PRG_Plain
VAR
    n : INT;
END_VAR
//---- IMPLEMENTATION ----
n := n + 1;
`;

function index() {
  const ix = new SymbolIndex();
  ix.update('/p/FB_A.TcPOU', FB_A);
  ix.update('/p/FB_B.TcPOU', FB_B);
  ix.update('/p/FB_Base.TcPOU', BASE);
  ix.update('/p/I_X.TcIO', ITF);
  ix.update('/p/ST_Item.TcDUT', ITEM);
  ix.update('/p/GVL_Main.TcGVL', GVL);
  ix.update('/p/PRG_Plain.TcPOU', PRG);
  return ix;
}
const edges = (file: string, nonSt?: Map<string, string>) => { const ix = index(); return fileEdges(ix, ix.get(file)!, nonSt); };
const has = (e: ReturnType<typeof edges>, from: string, to: string, reason?: string) =>
  e.refs.some(r => r.from === from && r.to === to && (!reason || r.reason === reason));

test('a call of a method of another function block is an edge from the calling member to the called member', () => {
  const e = edges('/p/FB_A.TcPOU');
  assert.ok(has(e, 'FB_A.GO', 'FB_B.RUN', 'call'));
  assert.ok(has(e, 'FB_A', 'FB_B.RUN', 'call'));          // the main body calls it too
  assert.ok(has(e, 'FB_A.RESET', 'FB_A.GO', 'call'));     // an action calling a method of its own object
});

test('a type name in a declaration is an edge to the object, also through ARRAY OF', () => {
  const e = edges('/p/FB_A.TcPOU');
  assert.ok(has(e, 'FB_A', 'FB_B', 'type'));
  assert.ok(has(e, 'FB_A', 'ST_ITEM', 'type'));
});

test('EXTENDS and IMPLEMENTS give edges to the base and the interface, and no second type edge', () => {
  const e = edges('/p/FB_A.TcPOU');
  assert.ok(has(e, 'FB_A', 'FB_BASE', 'extends'));
  assert.ok(has(e, 'FB_A', 'I_X', 'implements'));
  assert.equal(e.refs.filter(r => r.to === 'FB_BASE').length, 1);
});

test('a reference to a GVL variable is an edge to the GVL; a call inside a property GET is an edge from the property', () => {
  const e = edges('/p/FB_A.TcPOU');
  assert.ok(has(e, 'FB_A.LEVEL', 'GVL_MAIN'));
  assert.ok(has(e, 'FB_A.LEVEL', 'FB_B'));                // fbB.Count: a variable of FB_B
});

test('a reference to an own variable or a local gives no edge', () => {
  const e = edges('/p/PRG_Plain.TcPOU');
  assert.deepEqual(e.refs, []);
  assert.deepEqual(e.unresolved, []);
  const a = edges('/p/FB_A.TcPOU');
  assert.ok(!a.refs.some(r => r.to === 'FB_A' || r.from === r.to));
});

test('identifiers in comments and strings give no edge', () => {
  const e = edges('/p/FB_A.TcPOU');
  assert.ok(!e.unresolved.some(u => u.name === 'Hidden'));
  assert.ok(!e.refs.some(r => r.to === 'FB_B.HIDDEN'));
});

test('an unknown identifier is listed as unresolved with its line; call parameter names are not', () => {
  const e = edges('/p/FB_A.TcPOU');
  const names = e.unresolved.map(u => u.name);
  assert.ok(names.includes('Unknown') && names.includes('sText'));
  assert.equal(e.unresolved.find(u => u.name === 'Unknown')!.from, 'FB_A.GO');
  assert.equal(typeof e.unresolved.find(u => u.name === 'Unknown')!.line, 'number');
  assert.ok(!names.includes('nSpeed'));
});

test('a program with no references gives only its own node', () => {
  const e = edges('/p/PRG_Plain.TcPOU');
  assert.deepEqual(e.nodes.map(n => n.id), ['PRG_PLAIN']);
});

test('nodes: the object and one node per method, property and action, with the object as owner', () => {
  const e = edges('/p/FB_A.TcPOU');
  assert.deepEqual(e.nodes.map(n => n.id).sort(), ['FB_A', 'FB_A.GO', 'FB_A.LEVEL', 'FB_A.RESET']);
  assert.equal(e.nodes.find(n => n.id === 'FB_A.GO')!.owner, 'FB_A');
});

test('__NEW(FB_X) gives an edge to FB_X', () => {
  const ix = index();
  ix.update('/p/PRG_New.TcPOU', 'PROGRAM PRG_New\nVAR\n    p : POINTER TO FB_B;\nEND_VAR\n//---- IMPLEMENTATION ----\np := __NEW(FB_B);\n');
  const e = fileEdges(ix, ix.get('/p/PRG_New.TcPOU')!);
  assert.ok(e.refs.some(r => r.to === 'FB_B' && r.from === 'PRG_NEW'));
  assert.ok(!e.unresolved.some(u => u.name === '__NEW'));
});

test('a non-ST body gives words attributed to its own section', () => {
  const e = edges('/p/FB_A.TcPOU', new Map([['ACTION:Reset', '<CFC><Xml>FB_B Run</Xml></CFC>']]));
  const w = e.words.filter(x => x.from === 'FB_A.RESET').map(x => x.word);
  assert.ok(w.includes('FB_B') && w.includes('Run'));
  assert.ok(!e.words.some(x => x.from === 'FB_A'));
});

test('a library object is a library node with the library as id prefix', () => {
  const ix = index();
  ix.update('/lib/FB_B.TcPOU', FB_B.replace('FB_B', 'FB_L'), 'Lib');
  const e = fileEdges(ix, ix.get('/lib/FB_B.TcPOU')!);
  assert.equal(e.nodes[0].id, 'LIB::FB_L');
  assert.equal(e.nodes[0].library, true);
});

test('performance: a 5000-line GVL, 20000 identifier tokens and 3000 library objects stay under 2 s per file', () => {
  const ix = index();
  const gvl = ['VAR_GLOBAL', ...Array.from({ length: 5000 }, (_, i) => `    g${i} : INT;`), 'END_VAR', '//---- IMPLEMENTATION ----', ''].join('\n');
  ix.update('/p/GVL_Big.TcGVL', gvl);
  for (let i = 0; i < 3000; i++) ix.update(`/lib/L${i}.TcPOU`, `FUNCTION_BLOCK FB_L${i}\n//---- IMPLEMENTATION ----\n`, 'Lib');
  const body = Array.from({ length: 10000 }, (_, i) => `n := g${i % 5000} + g${(i + 1) % 5000};`).join('\n');
  ix.update('/p/PRG_Big.TcPOU', `PROGRAM PRG_Big\nVAR\n    n : INT;\nEND_VAR\n//---- IMPLEMENTATION ----\n${body}\n`);
  const t0 = Date.now();
  const e = fileEdges(ix, ix.get('/p/PRG_Big.TcPOU')!);
  const ms = Date.now() - t0;
  console.log(`fileEdges over ~40000 tokens with 3000 library objects: ${ms} ms`);
  assert.ok(e.refs.some(r => r.to === 'GVL_BIG'));
  assert.ok(ms < 2000, `${ms} ms`);
});

// ---------------------------------------------------------------- graph and reachability

const prg = (name: string, vars: string, body: string) => `PROGRAM ${name}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n${body}\n`;
const fb = (head: string, methods: Record<string, string> = {}, vars = '') =>
  `${head}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n` + Object.entries(methods).map(([n, b]) => `//==== METHOD ${n} ====\nMETHOD ${n} : BOOL\n//---- IMPLEMENTATION ----\n${b}\n`).join('');
const itf = (name: string, extendsName: string | undefined, methods: string[]) =>
  `INTERFACE ${name}${extendsName ? ' EXTENDS ' + extendsName : ''}\n//---- IMPLEMENTATION ----\n` + methods.map(n => `//==== METHOD ${n} ====\nMETHOD ${n} : BOOL\n//---- IMPLEMENTATION ----\n`).join('');

function graphOf(views: Record<string, string>, libs: Record<string, string> = {}) {
  const ix = new SymbolIndex();
  for (const [n, v] of Object.entries(views)) ix.update(`/p/${n}.TcPOU`, v);
  for (const [n, v] of Object.entries(libs)) ix.update(`/lib/${n}.TcPOU`, v, 'Lib');
  const g = assemble(ix.objects().map(o => fileEdges(ix, o)), ix);
  return { g, ix };
}
const unused = (g: ObjectGraph, roots: string[]) => findUnused(g, reach(g, roots)).map(f => `${f.id}:${f.confidence}`).sort();
const isReach = (g: ObjectGraph, roots: string[], id: string) => reach(g, roots).reachable.has(id);

test('an object nobody references is unreferenced; one called only by an unused object is only-from-unused', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    fb : FB_Used;', 'fb.Run();'),
    FB_Used: fb('FUNCTION_BLOCK FB_Used', { Run: ';' }),
    FB_Lonely: fb('FUNCTION_BLOCK FB_Lonely', {}, '    c : FB_Callee;'),
    FB_Callee: fb('FUNCTION_BLOCK FB_Callee'),
  });
  assert.deepEqual(unused(g, ['MAIN']), ['FB_CALLEE:only-from-unused', 'FB_LONELY:unreferenced']);
});

test('a method of a used function block that nobody calls is listed, and not its object', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    fb : FB_Used;', 'fb.Run();'),
    FB_Used: fb('FUNCTION_BLOCK FB_Used', { Run: ';', Stop: ';' }),
  });
  assert.deepEqual(unused(g, ['MAIN']), ['FB_USED.STOP:unreferenced']);
});

test('Review 1: a call through an interface reaches the implementations of reachable implementers only', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    i : I_X;\n    a : FB_A;', 'i.M();'),
    I_X: itf('I_X', undefined, ['M']),
    FB_A: fb('FUNCTION_BLOCK FB_A IMPLEMENTS I_X', { M: ';' }),
    FB_B: fb('FUNCTION_BLOCK FB_B IMPLEMENTS I_X', { M: ';' }),
  });
  assert.ok(isReach(g, ['MAIN'], 'FB_A.M'));
  assert.ok(!isReach(g, ['MAIN'], 'FB_B.M'));
});

test('a call through I_X reaches FB_A.M when FB_A implements I_Y that extends I_X; IMPLEMENTS inherited from a base counts', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    i : I_X;\n    a : FB_A;\n    d : FB_D;', 'i.M();'),
    I_X: itf('I_X', undefined, ['M']),
    I_Y: itf('I_Y', 'I_X', []),
    FB_A: fb('FUNCTION_BLOCK FB_A IMPLEMENTS I_Y', { M: ';' }),
    FB_Base: fb('FUNCTION_BLOCK FB_Base IMPLEMENTS I_X', { M: ';' }),
    FB_D: fb('FUNCTION_BLOCK FB_D EXTENDS FB_Base'),
  });
  assert.ok(isReach(g, ['MAIN'], 'FB_A.M'));
  assert.ok(isReach(g, ['MAIN'], 'FB_BASE.M'));
});

test('Review 2: an override is reachable when the base method and the derived block are', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    d : FB_Derived;', 'd.Run();'),
    FB_Base: fb('FUNCTION_BLOCK FB_Base', { Run: ';', Other: ';' }),
    FB_Derived: fb('FUNCTION_BLOCK FB_Derived EXTENDS FB_Base', { Run: ';', Other: 'SUPER^.Other();' }),
  });
  const r = reach(g, ['MAIN']).reachable;
  assert.ok(r.has('FB_DERIVED.RUN') && r.has('FB_BASE.RUN'));
  assert.ok(r.has('FB_BASE.OTHER'));
});

test('Review 3: FB_init, FB_exit and FB_reinit of a reachable block are reachable without a call', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    fb : FB_A;', ''),
    FB_A: fb('FUNCTION_BLOCK FB_A', { FB_init: ';', FB_exit: ';', FB_reinit: ';', Plain: ';' }),
  });
  const r = reach(g, ['MAIN']).reachable;
  assert.ok(r.has('FB_A.FB_INIT') && r.has('FB_A.FB_EXIT') && r.has('FB_A.FB_REINIT'));
  assert.ok(!r.has('FB_A.PLAIN'));
});

test('Review 4: an identifier that cannot be resolved reaches every member of that name', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    p : POINTER TO INT;', 'pUnknown^.Start();'),
    FB_A: fb('FUNCTION_BLOCK FB_A', { Start: ';' }),
    FB_B: fb('FUNCTION_BLOCK FB_B', { Start: ';' }),
  });
  const rec = reach(g, ['MAIN']).reachable;
  assert.equal(rec.get('FB_A.START')?.reason, 'by-name');
  assert.ok(rec.has('FB_B.START'));
});

test('Review 5: recursion, mutual recursion and an object that extends itself terminate', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    a : FB_A;', 'a.Rec();'),
    FB_A: fb('FUNCTION_BLOCK FB_A EXTENDS FB_A', { Rec: 'Rec(); Other();', Other: 'Rec();' }),
  });
  assert.ok(isReach(g, ['MAIN'], 'FB_A.OTHER'));
});

test('Review 8: a function called only from a non-ST body is reachable (reason non-st)', () => {
  const ix = new SymbolIndex();
  ix.update('/p/MAIN.TcPOU', prg('MAIN', '', ''));
  ix.update('/p/FC_Calc.TcPOU', 'FUNCTION FC_Calc : INT\n//---- IMPLEMENTATION ----\n');
  const files = ix.objects().map(o => fileEdges(ix, o, o.root?.name === 'MAIN' ? new Map([['MAIN', '<CFC>FC_Calc</CFC>']]) : undefined));
  const g = assemble(files, ix);
  assert.equal(reach(g, ['MAIN']).reachable.get('FC_CALC')?.reason, 'non-st');
});

test('Review 9: contract members are never listed as unused; an interface nobody uses is the finding, not its methods', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    a : FB_A;', ''),
    I_X: itf('I_X', undefined, ['M']),
    FB_A: fb('FUNCTION_BLOCK FB_A IMPLEMENTS I_X EXTENDS FB_Base', { M: ';', Run: ';', Own: ';' }),
    FB_Base: fb('FUNCTION_BLOCK FB_Base', { Run: ';' }),
  });
  assert.deepEqual(unused(g, ['MAIN']), ['FB_A.OWN:unreferenced']);
});

test('an implementation of an interface that is not in the index is never listed', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    a : FB_A;', ''),
    FB_A: fb('FUNCTION_BLOCK FB_A IMPLEMENTS I_Library', { Cb: ';' }),
  });
  assert.deepEqual(unused(g, ['MAIN']), []);
});

test('a contract member of a reachable owner is reachable and what it calls is not unused', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    a : FB_A;', ''),
    I_X: itf('I_X', undefined, ['Cb']),
    FB_A: fb('FUNCTION_BLOCK FB_A IMPLEMENTS I_X', { Cb: 'Helper();', Helper: ';' }),
  });
  const r = reach(g, ['MAIN']).reachable;
  assert.equal(r.get('FB_A.CB')?.reason, 'contract');
  assert.ok(r.has('FB_A.HELPER'));
});

test('a library node is never listed as unused', () => {
  const { g } = graphOf({ MAIN: prg('MAIN', '', '') }, { FB_L: fb('FUNCTION_BLOCK FB_L', { M: ';' }) });
  assert.deepEqual(unused(g, ['MAIN']), []);
});

test('whyReachable returns the path from the root to a method; callersOf and reachedFrom answer the other way', () => {
  const { g } = graphOf({
    MAIN: prg('MAIN', '    a : FB_A;', 'a.Go();'),
    OTHER: prg('OTHER', '', ''),
    FB_A: fb('FUNCTION_BLOCK FB_A', { Go: 'Inner();', Inner: ';' }),
  });
  assert.deepEqual(whyReachable(reach(g, ['MAIN']), 'FB_A.INNER').map(p => p.id), ['MAIN', 'FB_A.GO', 'FB_A.INNER']);
  assert.deepEqual(callersOf(g, 'FB_A.INNER'), ['FB_A.GO']);
  assert.deepEqual(reachedFrom(g, 'FB_A.INNER', ['MAIN', 'OTHER']), ['MAIN']);
});
