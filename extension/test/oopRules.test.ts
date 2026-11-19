import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolIndex } from '../src/lang/index';
import { checkOop } from '../src/core/oopRules';

interface M { decl: string; body?: string }
const fb = (head: string, methods: Record<string, M | string> = {}, vars = '') =>
  `${head}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n` + Object.entries(methods).map(([n, m]) => {
    const d = typeof m === 'string' ? { decl: m } : m;
    return `//==== METHOD ${n} ====\n${d.decl}\n//---- IMPLEMENTATION ----\n${d.body ?? ';'}\n`;
  }).join('');
const itf = (head: string, methods: Record<string, string>) =>
  `${head}\n//---- IMPLEMENTATION ----\n` + Object.entries(methods).map(([n, d]) => `//==== METHOD ${n} ====\n${d}\n//---- IMPLEMENTATION ----\n`).join('');

function indexOf(views: Record<string, string>, lib: Record<string, string> = {}) {
  const ix = new SymbolIndex();
  for (const [n, v] of Object.entries(views)) ix.update(`/p/${n}.TcPOU`, v);
  for (const [n, v] of Object.entries(lib)) ix.update(`/lib/${n}.TcPOU`, v, 'Lib');
  return ix;
}
const check = (ix: SymbolIndex, name: string) => checkOop(ix, ix.get(`/p/${name}.TcPOU`)!);
const rules = (ix: SymbolIndex, name: string) => check(ix, name).map(f => f.rule);

const RUN_INT = 'METHOD Run : BOOL\nVAR_INPUT\n    a : INT;\nEND_VAR';

test('signature-mismatch: an override with another return type is an error naming both signatures', () => {
  const ix = indexOf({
    FB_Base: fb('FUNCTION_BLOCK FB_Base', { Run: RUN_INT }),
    FB_Derived: fb('FUNCTION_BLOCK FB_Derived EXTENDS FB_Base', { Run: 'METHOD Run : INT\nVAR_INPUT\n    a : INT;\nEND_VAR' }),
  });
  const [f] = check(ix, 'FB_Derived');
  assert.equal(f.rule, 'signature-mismatch');
  assert.equal(f.level, 'error');
  assert.equal(f.space, 'view');
  assert.match(f.message, /FB_Derived\.Run.*: INT/);
  assert.match(f.message, /FB_Base\.Run.*: BOOL/);
  assert.deepEqual(rules(ix, 'FB_Base'), []);
});

test('signature-mismatch: an interface method with another VAR_INPUT order is an error; parameter names differing only by case are not', () => {
  const two = 'METHOD Run : BOOL\nVAR_INPUT\n    a : INT;\n    b : INT;\nEND_VAR';
  const swapped = 'METHOD Run : BOOL\nVAR_INPUT\n    b : INT;\n    a : INT;\nEND_VAR';
  const cased = 'METHOD Run : BOOL\nVAR_INPUT\n    A : INT;\n    B : INT;\nEND_VAR';
  const mk = (impl: string) => indexOf({
    I_Run: itf('INTERFACE I_Run', { Run: two }),
    FB_Impl: fb('FUNCTION_BLOCK FB_Impl IMPLEMENTS I_Run', { Run: impl }),
  });
  assert.deepEqual(rules(mk(swapped), 'FB_Impl'), ['signature-mismatch']);
  assert.deepEqual(rules(mk(cased), 'FB_Impl'), []);
  assert.deepEqual(rules(mk(two), 'FB_Impl'), []);
});

test('an inherited signature change is reported on the derived block', () => {
  const ix = indexOf({
    I_Run: itf('INTERFACE I_Run', { Run: RUN_INT }),
    FB_Base: fb('FUNCTION_BLOCK FB_Base', { Run: 'METHOD Run : INT' }),
    FB_Derived: fb('FUNCTION_BLOCK FB_Derived EXTENDS FB_Base IMPLEMENTS I_Run'),
  });
  assert.deepEqual(rules(ix, 'FB_Derived'), ['signature-mismatch']);
});

test('final-violation: extending a FINAL block and overriding a FINAL method', () => {
  const ix = indexOf({
    FB_Fin: fb('FUNCTION_BLOCK FINAL FB_Fin'),
    FB_Child: fb('FUNCTION_BLOCK FB_Child EXTENDS FB_Fin'),
    FB_Base: fb('FUNCTION_BLOCK FB_Base', { Run: 'METHOD FINAL Run : BOOL' }),
    FB_Over: fb('FUNCTION_BLOCK FB_Over EXTENDS FB_Base', { Run: 'METHOD Run : BOOL' }),
    FB_Ok: fb('FUNCTION_BLOCK FB_Ok EXTENDS FB_Base'),
  });
  assert.deepEqual(rules(ix, 'FB_Child'), ['final-violation']);
  assert.deepEqual(rules(ix, 'FB_Over'), ['final-violation']);
  assert.deepEqual(rules(ix, 'FB_Ok'), []);
});

test('abstract-instantiation: a variable of an ABSTRACT block is an error, a pointer, reference or VAR_IN_OUT is not', () => {
  const abs = fb('FUNCTION_BLOCK ABSTRACT FB_Abs');
  const mk = (vars: string) => indexOf({ FB_Abs: abs, FB_User: fb('FUNCTION_BLOCK FB_User', {}, vars) });
  assert.deepEqual(rules(mk('    x : FB_Abs;'), 'FB_User'), ['abstract-instantiation']);
  assert.deepEqual(rules(mk('    x : ARRAY[0..1] OF FB_Abs;'), 'FB_User'), ['abstract-instantiation']);
  assert.deepEqual(rules(mk('    x : POINTER TO FB_Abs;'), 'FB_User'), []);
  assert.deepEqual(rules(mk('    x : REFERENCE TO FB_Abs;'), 'FB_User'), []);
  assert.deepEqual(rules(mk('    x : ARRAY[1..4] OF POINTER TO FB_Abs;'), 'FB_User'), []);
  assert.deepEqual(rules(mk('    x : ARRAY[1..4] OF REFERENCE TO FB_Abs;'), 'FB_User'), []);
  const inout = indexOf({ FB_Abs: abs, FB_User: `FUNCTION_BLOCK FB_User\nVAR_IN_OUT\n    x : FB_Abs;\nEND_VAR\n//---- IMPLEMENTATION ----\n` });
  assert.deepEqual(rules(inout, 'FB_User'), []);
});

test('an object that instantiates an abstract type is reported although it neither extends nor implements the changed object', () => {
  const ix = indexOf({ FB_Abs: fb('FUNCTION_BLOCK ABSTRACT FB_Abs'), PRG: `PROGRAM PRG\nVAR\n    x : FB_Abs;\nEND_VAR\n//---- IMPLEMENTATION ----\n` });
  assert.deepEqual(rules(ix, 'PRG'), ['abstract-instantiation']);
});

test('unresolved-base: a base or interface outside the index gives one info and never an error', () => {
  const ix = indexOf({ FB_X: fb('FUNCTION_BLOCK FB_X EXTENDS FB_Gone IMPLEMENTS I_Gone', { Run: RUN_INT }) });
  const f = check(ix, 'FB_X');
  assert.deepEqual(f.map(x => [x.rule, x.level]), [['unresolved-base', 'info']]);
});

test('two indexes with the same base-class name resolve into their own objects', () => {
  const base = (t: string) => fb('FUNCTION_BLOCK FB_Base', { Run: `METHOD Run : ${t}` });
  const derived = fb('FUNCTION_BLOCK FB_D EXTENDS FB_Base', { Run: 'METHOD Run : BOOL' });
  assert.deepEqual(rules(indexOf({ FB_Base: base('BOOL'), FB_D: derived }), 'FB_D'), []);
  assert.deepEqual(rules(indexOf({ FB_Base: base('INT'), FB_D: derived }), 'FB_D'), ['signature-mismatch']);
});

test('a library object is never checked, and a clean object gives no finding', () => {
  const ix = indexOf({ FB_Ok: fb('FUNCTION_BLOCK FB_Ok', { Run: RUN_INT }) }, { FB_Lib: fb('FUNCTION_BLOCK ABSTRACT FB_Lib') });
  assert.deepEqual(rules(ix, 'FB_Ok'), []);
  assert.deepEqual(checkOop(ix, ix.get('/lib/FB_Lib.TcPOU')!), []);
});

test('findings carry the hash of the view they were computed from', () => {
  const ix = indexOf({ FB_Abs: fb('FUNCTION_BLOCK ABSTRACT FB_Abs'), PRG: `PROGRAM PRG\nVAR\n    x : FB_Abs;\nEND_VAR\n//---- IMPLEMENTATION ----\n` });
  const [f] = check(ix, 'PRG');
  assert.match(f.version ?? '', /^[0-9a-f]{12}$/);
});

test('FB_init may add parameters in a derived block', () => {
  const ix = indexOf({
    FB_Base: fb('FUNCTION_BLOCK FB_Base', { FB_init: 'METHOD FB_init : BOOL\nVAR_INPUT\n    bInitRetains : BOOL;\n    bInCopyCode : BOOL;\nEND_VAR' }),
    FB_D: fb('FUNCTION_BLOCK FB_D EXTENDS FB_Base', { FB_init: 'METHOD FB_init : BOOL\nVAR_INPUT\n    bInitRetains : BOOL;\n    bInCopyCode : BOOL;\n    eUnit : INT;\nEND_VAR' }),
  });
  assert.deepEqual(rules(ix, 'FB_D'), []);
});
