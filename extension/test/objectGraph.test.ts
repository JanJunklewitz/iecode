import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolIndex } from '../src/lang/index';
import { fileEdges } from '../src/core/objectGraph';

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
