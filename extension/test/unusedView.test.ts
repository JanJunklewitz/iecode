import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolIndex } from '../src/lang/index';
import { assemble, fileEdges, findUnused, reach, ObjectGraph } from '../src/core/objectGraph';
import type { UnitAnalysis } from '../src/core/analysisState';
import { emptyReason, marksByFile, treeDescription, unusedMarks } from '../src/core/unusedView';

const prg = (name: string, vars: string, body: string) => `PROGRAM ${name}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n${body}\n`;
const fb = (head: string, methods: Record<string, string> = {}, vars = '') =>
  `${head}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n` + Object.entries(methods).map(([n, b]) => `//==== METHOD ${n} ====\nMETHOD ${n} : BOOL\n//---- IMPLEMENTATION ----\n${b}\n`).join('');

function analysis(views: Record<string, string>, over: Partial<UnitAnalysis> = {}): UnitAnalysis {
  const ix = new SymbolIndex();
  for (const [n, v] of Object.entries(views)) ix.update(`/p/${n}.TcPOU`, v);
  const graph: ObjectGraph = assemble(ix.objects().map(o => fileEdges(ix, o)), ix);
  const rc = reach(graph, ['MAIN']);
  return { unit: 'U', graph, reach: rc, roots: [], unused: findUnused(graph, rc), notes: [], complete: true, ...over };
}

test('members of an unused object are folded into the object mark', () => {
  const a = analysis({ MAIN: prg('MAIN', '', ''), FB_Dead: fb('FUNCTION_BLOCK FB_Dead', { A: ';', B: ';' }) });
  assert.deepEqual(unusedMarks(a).map(m => m.id), ['FB_DEAD']);
});

test('a used object with an unused method marks the method only', () => {
  const a = analysis({ MAIN: prg('MAIN', '    f : FB_Used;', 'f.Run();'), FB_Used: fb('FUNCTION_BLOCK FB_Used', { Run: ';', Spare: ';' }) });
  const marks = unusedMarks(a);
  assert.deepEqual(marks.map(m => m.id), ['FB_USED.SPARE']);
  assert.equal(marks[0].file, '/p/FB_Used.TcPOU');
  assert.equal(marks[0].name, 'Spare');
  assert.ok(marks[0].line > 0);
});

test('confidence text differs for unreferenced and only-from-unused', () => {
  const a = analysis({ MAIN: prg('MAIN', '', ''), FB_Dead: fb('FUNCTION_BLOCK FB_Dead', {}, '    c : FB_Callee;'), FB_Callee: fb('FUNCTION_BLOCK FB_Callee') });
  const byId = new Map(unusedMarks(a).map(m => [m.id, m]));
  assert.equal(byId.get('FB_DEAD')!.confidence, 'unreferenced');
  assert.equal(byId.get('FB_CALLEE')!.confidence, 'only-from-unused');
  assert.notEqual(byId.get('FB_DEAD')!.text, byId.get('FB_CALLEE')!.text);
});

test('emptyReason names a skipped library, a project without tasks and an incomplete analysis', () => {
  const a = analysis({ MAIN: prg('MAIN', '', '') });
  assert.equal(emptyReason(a), undefined);
  assert.match(emptyReason({ ...a, skipped: 'library' })!, /library project/);
  assert.match(emptyReason({ ...a, skipped: 'no-tasks' })!, /no tasks found/);
  assert.match(emptyReason({ ...a, complete: false })!, /not complete/);
});

test('marksByFile groups by file', () => {
  const a = analysis({ MAIN: prg('MAIN', '', ''), FB_X: fb('FUNCTION_BLOCK FB_X'), FB_Y: fb('FUNCTION_BLOCK FB_Y') });
  const m = marksByFile(unusedMarks(a));
  assert.deepEqual([...m.keys()].sort(), ['/p/FB_X.TcPOU', '/p/FB_Y.TcPOU']);
});

test('treeDescription appends unused to the description and leaves it alone without a mark', () => {
  const a = analysis({ MAIN: prg('MAIN', '', ''), FB_X: fb('FUNCTION_BLOCK FB_X') });
  const mark = unusedMarks(a)[0];
  assert.equal(treeDescription(undefined, 'FB'), 'FB');
  assert.equal(treeDescription(mark, 'FB'), 'FB · unused');
  assert.equal(treeDescription(mark, ''), 'unused');
});

test('a library node and a contract member never get a mark', () => {
  const ix = new SymbolIndex();
  ix.update('/p/MAIN.TcPOU', prg('MAIN', '    a : FB_A;', ''));
  ix.update('/p/I_X.TcIO', 'INTERFACE I_X\n//---- IMPLEMENTATION ----\n//==== METHOD M ====\nMETHOD M : BOOL\n//---- IMPLEMENTATION ----\n');
  ix.update('/p/FB_A.TcPOU', fb('FUNCTION_BLOCK FB_A IMPLEMENTS I_X', { M: ';' }));
  ix.update('/lib/FB_L.TcPOU', fb('FUNCTION_BLOCK FB_L', { X: ';' }), 'Lib');
  const graph = assemble(ix.objects().map(o => fileEdges(ix, o)), ix);
  const rc = reach(graph, ['MAIN']);
  const a: UnitAnalysis = { unit: 'U', graph, reach: rc, roots: [], unused: findUnused(graph, rc), notes: [], complete: true };
  assert.deepEqual(unusedMarks(a).map(m => m.id), []);   // the interface is implemented by a used block; its member, the implementation and the library are not marked
});
