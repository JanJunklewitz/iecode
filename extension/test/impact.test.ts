import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolIndex } from '../src/lang/index';
import { ObjectGraph, assemble, fileEdges, reach } from '../src/core/objectGraph';
import { impactOf, impactRows, ioVariablePath } from '../src/core/impact';
import type { IoLink } from '../src/core/iolinks';

const prg = (name: string, vars: string, body: string) => `PROGRAM ${name}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n${body}\n`;
const fb = (head: string, methods: Record<string, string> = {}, vars = '') =>
  `${head}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n` + Object.entries(methods).map(([n, b]) => `//==== METHOD ${n} ====\nMETHOD ${n} : BOOL\n//---- IMPLEMENTATION ----\n${b}\n`).join('');
const itf = (name: string, methods: string[]) =>
  `INTERFACE ${name}\n//---- IMPLEMENTATION ----\n` + methods.map(n => `//==== METHOD ${n} ====\nMETHOD ${n} : BOOL\n//---- IMPLEMENTATION ----\n`).join('');

function graphOf(views: Record<string, string>): ObjectGraph {
  const ix = new SymbolIndex();
  for (const [n, v] of Object.entries(views)) ix.update(`/p/${n}.TcPOU`, v);
  return assemble(ix.objects().map(o => fileEdges(ix, o)), ix);
}

const link = (path: string, plc = 'PLC1', area = 'PlcTask Inputs'): IoLink =>
  ({ variable: `TIPC^${plc}^${plc} Instance^${area}^${path}`, io: 'TIID^Device 1^Box 1^Channel 1^Input', attrs: {}, file: 'a.tsproj' });

test('ioVariablePath cuts the area path and keeps the symbol path', () => {
  assert.equal(ioVariablePath(link('MAIN.bStart'), 'PLC1'), 'main.bstart');
  assert.equal(ioVariablePath(link('MAIN.bOut', 'PLC1', 'PlcTask Outputs'), 'PLC1'), 'main.bout');
  assert.equal(ioVariablePath(link('MAIN.iaState[3]'), 'PLC1'), 'main.iastate');
  assert.equal(ioVariablePath({ ...link('x'), variable: 'TIPC^Safety^Safety Instance^StandardInputs^X' }, 'PLC1'), undefined);
  assert.equal(ioVariablePath({ ...link('x'), variable: 'TIID^Device 1^Box 1^Channel 1' }, 'PLC1'), undefined);
});

test('the same variable path in another PLC project is not a match', () => {
  assert.equal(ioVariablePath(link('MAIN.bStart', 'PLC2'), 'PLC1'), undefined);
});

const views = {
  MAIN: prg('MAIN', '    fb : FB_Motor;\n    bStart : BOOL;', 'fb.Run();'),
  OTHER: prg('OTHER', '    bStart : BOOL;', ''),
  FB_Motor: fb('FUNCTION_BLOCK FB_Motor', { Run: ';' }),
  FB_Unused: fb('FUNCTION_BLOCK FB_Unused', {}, '    m : FB_Motor;'),
};

test('impact of an object lists tasks, direct callers and the count of transitive callers', () => {
  const g = graphOf({ ...views, PRG2: prg('PRG2', '    x : BOOL;', 'MAIN();') });
  const roots = ['MAIN'];
  const r = impactOf(g, reach(g, roots), roots, 'FB_MOTOR.RUN', [], 'PLC1');
  assert.deepEqual(r.tasks, ['MAIN']);
  assert.deepEqual(r.directCallers.map(c => c.id), ['MAIN']);
  assert.ok(r.directCallers[0].line >= 1);
  assert.equal(r.transitiveCallers, 1);       // PRG2 calls MAIN
});

test('impact of a variable finds its IO links and not a same-named variable of another program', () => {
  const g = graphOf(views);
  const links = [link('MAIN.bStart'), link('OTHER.bStart'), link('MAIN.bStart', 'PLC2')];
  const r = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'MAIN', links, 'PLC1', 'MAIN.bStart');
  assert.deepEqual(r.ioLinks.map(l => l.variable), [links[0].variable]);
});

test('a struct member link matches its struct variable', () => {
  const g = graphOf(views);
  const links = [link('MAIN.stData^D[0]'), link('MAIN.stData.x'), link('MAIN.stDataOther')];
  const r = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'MAIN', links, 'PLC1', 'MAIN.stData');
  assert.equal(r.ioLinks.length, 2);
});

test('impact of a method called through an interface lists the interface callers', () => {
  const g = graphOf({
    MAIN: prg('MAIN', '    i : I_Run;\n    m : FB_Impl;', 'i.Run();'),
    I_Run: itf('I_Run', ['Run']),
    FB_Impl: fb('FUNCTION_BLOCK FB_Impl IMPLEMENTS I_Run', { Run: ';' }),
  });
  const r = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'FB_IMPL.RUN', [], 'PLC1');
  assert.deepEqual(r.directCallers.map(c => c.id), ['MAIN']);
});

test('undefined links add a note, and a function block member variable is reported as not analysed', () => {
  const g = graphOf(views);
  const r = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'MAIN', undefined, 'PLC1', 'MAIN.bStart');
  assert.ok(r.notes.some(n => /IO links were not read/.test(n)));
  const fbVar = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'FB_MOTOR', [], 'PLC1', 'FB_Motor.bEnable');
  assert.ok(fbVar.notes.some(n => /instance paths not analysed/.test(n)));
});

test('impact of an unused object says no task reaches it and lists only unused callers', () => {
  const g = graphOf(views);
  const r = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'FB_UNUSED', [], 'PLC1');
  assert.deepEqual(r.tasks, []);
  assert.ok(r.notes.some(n => /no task reaches/.test(n)));
  const m = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'FB_MOTOR', [], 'PLC1');
  assert.deepEqual(m.tasks, ['MAIN']);
  assert.ok(m.directCallers.some(c => c.id === 'FB_UNUSED'));
});

test('no roots adds a note that no task was found', () => {
  const g = graphOf(views);
  const r = impactOf(g, reach(g, []), [], 'MAIN', [], 'PLC1');
  assert.ok(r.notes.some(n => /no tasks found/i.test(n)));
});

test('impactRows lists tasks, then callers, then IO links, then notes', () => {
  const g = graphOf(views);
  const links = [link('MAIN.bStart')];
  const r = impactOf(g, reach(g, ['MAIN']), ['MAIN'], 'FB_MOTOR.RUN', undefined, 'PLC1');
  const withIo = { ...r, ioLinks: links };
  const rows = impactRows(g, withIo);
  assert.deepEqual(rows.map(x => x.kind), ['task', 'caller', 'io', 'note']);
  assert.equal(rows[0].label, 'MAIN');
  assert.ok(rows[0].target?.file.endsWith('MAIN.TcPOU'));
  const caller = rows.find(x => x.kind === 'caller')!;
  assert.equal(caller.label, 'MAIN');
  assert.equal(caller.target?.line, withIo.directCallers[0].line);
  const io = rows.find(x => x.kind === 'io')!;
  assert.equal(io.label, 'Device 1^Box 1^Channel 1^Input');
  assert.equal(io.detail, 'PLC1^MAIN.bStart');
  assert.equal(rows[rows.length - 1].kind, 'note');
});
