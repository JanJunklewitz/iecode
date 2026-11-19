import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SymbolIndex } from '../src/lang/index';
import { assemble, fileEdges, reach } from '../src/core/objectGraph';
import { DEFAULT_ROOT_PRAGMAS, globToRegExp, rootsOf } from '../src/core/analysisRoots';

const TASK = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'archive', 'PlcTask.TcTTO'), 'utf8');   // calls MAIN and VisuElems.Visu_Prg
const none = { taskFiles: [TASK], visuTexts: [], extra: [], rootPragmas: [] as string[] };

function setup(views: Record<string, string>, libs: Record<string, string> = {}) {
  const ix = new SymbolIndex();
  ix.setNamespaces(new Map([['VisuElems', 'VisuElems']]));
  for (const [n, v] of Object.entries(views)) ix.update(`/p/${n}.TcPOU`, v);
  for (const [n, v] of Object.entries(libs)) ix.update(`/lib/${n}.TcPOU`, v, 'VisuElems');
  const g = assemble(ix.objects().map(o => fileEdges(ix, o)), ix);
  return { g, ix };
}
const PRG = (name: string, body = '', vars = '') => `PROGRAM ${name}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n${body}\n`;
const ids = (r: ReturnType<typeof rootsOf>) => r.roots.map(x => `${x.id}:${x.why}${x.task ? ':' + x.task : ''}`).sort();

test('task calls become roots, a qualified call resolves through the namespace, an unknown one gives a note', () => {
  const { g, ix } = setup({ MAIN: PRG('MAIN') }, { Visu_Prg: PRG('Visu_Prg') });
  const r = rootsOf(g, ix, none);
  assert.deepEqual(ids(r).filter(x => x.includes(':task')), ['MAIN:task:PlcTask', 'VISUELEMS::VISU_PRG:task:PlcTask']);
  const missing = setup({ MAIN: PRG('MAIN') });
  const r2 = rootsOf(missing.g, missing.ix, none);
  assert.deepEqual(ids(r2).filter(x => x.includes(':task')), ['MAIN:task:PlcTask']);
  assert.ok(r2.notes.some(n => /Visu_Prg/.test(n)));
});

test('no task file means no tasks and the note says so', () => {
  const { g, ix } = setup({ MAIN: PRG('MAIN') });
  const r = rootsOf(g, ix, { ...none, taskFiles: [] });
  assert.equal(r.noTasks, true);
  assert.ok(r.notes.some(n => /no tasks found/.test(n)));
  assert.equal(r.roots.filter(x => x.why === 'task').length, 0);
});

test('a name used in a visualization text is a root, as a whole word only', () => {
  const { g, ix } = setup({ MAIN: PRG('MAIN'), FB_Shown: 'FUNCTION_BLOCK FB_Shown\n//---- IMPLEMENTATION ----\n', FB_Sho: 'FUNCTION_BLOCK FB_Sho\n//---- IMPLEMENTATION ----\n' });
  const r = rootsOf(g, ix, { ...none, visuTexts: ['<Bind>MAIN.fb : FB_Shown</Bind>'] });
  assert.ok(ids(r).includes('FB_SHOWN:visualization'));
  assert.ok(!ids(r).includes('FB_SHO:visualization'));
});

test('a configured glob matches objects case-insensitively', () => {
  assert.ok(globToRegExp('fb_*').test('FB_Motor'));
  assert.ok(!globToRegExp('FB_?').test('FB_Motor'));
  const { g, ix } = setup({ MAIN: PRG('MAIN'), FB_Plugin_A: 'FUNCTION_BLOCK FB_Plugin_A\n//---- IMPLEMENTATION ----\n', FB_Other: 'FUNCTION_BLOCK FB_Other\n//---- IMPLEMENTATION ----\n' });
  const r = rootsOf(g, ix, { ...none, extra: ['fb_plugin_*'] });
  assert.ok(ids(r).includes('FB_PLUGIN_A:configured'));
  assert.ok(!ids(r).includes('FB_OTHER:configured'));
});

test('a configured pragma makes an object or member a root; a call_after_init method too', () => {
  const { g, ix } = setup({
    MAIN: PRG('MAIN'),
    FB_Rpc: "{attribute 'TcRpcEnable'}\nFUNCTION_BLOCK FB_Rpc\n//---- IMPLEMENTATION ----\n",
    FB_Hook: "FUNCTION_BLOCK FB_Hook\n//---- IMPLEMENTATION ----\n//==== METHOD Init ====\n{attribute 'call_after_init'}\nMETHOD Init : BOOL\n//---- IMPLEMENTATION ----\n;\n//==== METHOD Plain ====\nMETHOD Plain : BOOL\n//---- IMPLEMENTATION ----\n;\n",
    FB_Opc: "FUNCTION_BLOCK FB_Opc\n//---- IMPLEMENTATION ----\n//==== PROPERTY Value ====\n{attribute 'OPC.UA.DA' := '1'}\nPROPERTY Value : INT\n",
  });
  const r = rootsOf(g, ix, { ...none, rootPragmas: DEFAULT_ROOT_PRAGMAS });
  const got = ids(r);
  assert.ok(got.includes('FB_RPC:pragma'));
  assert.ok(got.includes('FB_HOOK.INIT:pragma'));
  assert.ok(!got.includes('FB_HOOK.PLAIN:pragma'));
  assert.ok(got.includes('FB_OPC.VALUE:pragma'));
});

test('a GVL or program with an AT %I variable is a root', () => {
  const { g, ix } = setup({
    MAIN: PRG('MAIN'),
    IO_Inputs: 'VAR_GLOBAL\n    bStart AT %I* : BOOL;\nEND_VAR\n//---- IMPLEMENTATION ----\n',
  });
  assert.ok(ids(rootsOf(g, ix, none)).includes('IO_INPUTS:io'));
});

test('two tasks that call one program give two root records', () => {
  const { g, ix } = setup({ MAIN: PRG('MAIN') });
  const second = TASK.replace('Name="PlcTask"', 'Name="Task2"');
  const r = rootsOf(g, ix, { ...none, taskFiles: [TASK, second] });
  assert.deepEqual(ids(r).filter(x => x.startsWith('MAIN:task')).length, second === TASK ? 1 : 2);
});

test('an object reached only through a pragma root is not unused, and a library callback target stays reachable', () => {
  const { g, ix } = setup({
    MAIN: PRG('MAIN'),
    FB_Rpc: "{attribute 'TcRpcEnable'}\nFUNCTION_BLOCK FB_Rpc\n//---- IMPLEMENTATION ----\n//==== METHOD Go ====\nMETHOD Go : BOOL\n//---- IMPLEMENTATION ----\nHelper();\n//==== METHOD Helper ====\nMETHOD Helper : BOOL\n//---- IMPLEMENTATION ----\n;\n",
  });
  const r = rootsOf(g, ix, { ...none, rootPragmas: DEFAULT_ROOT_PRAGMAS });
  const reached = reach(g, r.roots.map(x => x.id)).reachable;
  assert.ok(reached.has('FB_RPC') && !reached.has('FB_RPC.GO'));
});

test('an exposure pragma on a variable of a GVL roots the GVL, a commented-out one does not', () => {
  const gvl = (pragmaLine: string) => ['VAR_GLOBAL', pragmaLine, '    nVal : INT;', 'END_VAR', '//---- IMPLEMENTATION ----', ''].join('\n');
  const { g, ix } = setup({ MAIN: PRG('MAIN'), GVL_Opc: gvl("{attribute 'OPC.UA.DA' := '1'}"), GVL_Off: gvl("// {attribute 'OPC.UA.DA' := '1'}") });
  const got = ids(rootsOf(g, ix, { ...none, rootPragmas: DEFAULT_ROOT_PRAGMAS }));
  assert.ok(got.includes('GVL_OPC:pragma'), got.join(','));
  assert.ok(!got.includes('GVL_OFF:pragma'), got.join(','));
});
