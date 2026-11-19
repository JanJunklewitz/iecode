import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolIndex } from '../src/lang/index';
import { ObjectGraph, assemble, fileEdges } from '../src/core/objectGraph';
import { escapeLabel, mermaidIds, mermaidNodeCount, objectGraphMermaid } from '../src/core/graphExport';
import { toMermaid as toProjectMermaid } from '../src/core/workspace';

const prg = (name: string, vars: string, body: string) => `PROGRAM ${name}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n${body}\n`;
const fb = (head: string, methods: Record<string, string> = {}, vars = '') =>
  `${head}\nVAR\n${vars}\nEND_VAR\n//---- IMPLEMENTATION ----\n` + Object.entries(methods).map(([n, b]) => `//==== METHOD ${n} ====\nMETHOD ${n} : BOOL\n//---- IMPLEMENTATION ----\n${b}\n`).join('');

function graphOf(views: Record<string, string>): ObjectGraph {
  const ix = new SymbolIndex();
  for (const [n, v] of Object.entries(views)) ix.update(`/p/${n}.TcPOU`, v);
  return assemble(ix.objects().map(o => fileEdges(ix, o)), ix);
}

const views = {
  MAIN: prg('MAIN', '    m : FB_Motor;', 'm.Run();'),
  FB_Motor: fb('FUNCTION_BLOCK FB_Motor', { Run: ';' }),
  FB_Lonely: fb('FUNCTION_BLOCK FB_Lonely', {}, '    x : FB_Motor;'),
  FB_Far: fb('FUNCTION_BLOCK FB_Far'),
};

test('mermaidIds gives distinct ids for names that differ only in punctuation, and a name that looks like a generated id (n1) does not collide', () => {
  const ids = mermaidIds(['a.b', 'a_b', 'a b', 'n1', 'ä', 'a.b']);
  assert.equal(new Set(ids.values()).size, 5);
  assert.ok([...ids.values()].every(v => /^n\d+$/.test(v)));
  assert.deepEqual([...mermaidIds(['b', 'a']).entries()], [['a', 'n1'], ['b', 'n2']]);
  assert.deepEqual([...mermaidIds(['b', 'a'])], [...mermaidIds(['a', 'b'])]);
});

test('labels with quotes, brackets and umlauts are escaped', () => {
  assert.equal(escapeLabel('say "hi" [x] Größe'), 'say #quot;hi#quot; [x] Größe');
  assert.equal(escapeLabel('a#b'), 'a#35;b');
});

test('the project graph export goes through the same allocator', () => {
  const unit = (id: string, lib: boolean) => ({ id, plc: { isLibrary: lib, title: 'Lib "X"', version: '1.0' } });
  const out = toProjectMermaid({
    units: [unit('App/PLC 1', false), unit('Lib.Core', true)],
    edges: [{ from: 'App/PLC 1', to: 'Lib.Core', link: 'workspace', ref: { effective: { version: '1.0' } } }],
  } as never);
  assert.match(out, /^flowchart TD\n  n1\["App\/PLC 1"\]\n  n2\[\("Lib #quot;X#quot; 1\.0"\)\]\n  n2 -->\|workspace\| n1$/);
});

test('members are folded into their object by default', () => {
  const out = objectGraphMermaid(graphOf(views), {});
  assert.ok(out.startsWith('flowchart LR'));
  assert.ok(!/FB_Motor\.Run|Run"/.test(out));
  assert.match(out, /\["MAIN"\]/);
  assert.equal((out.match(/-->/g) ?? []).length, new Set(out.match(/n\d+ --> n\d+/g)).size);
  const withMembers = objectGraphMermaid(graphOf(views), { members: true });
  assert.match(withMembers, /\["FB_Motor\.Run"\]/);
});

test('unused nodes get the unused class', () => {
  const g = graphOf(views);
  const out = objectGraphMermaid(g, { unused: [{ id: 'FB_LONELY', confidence: 'unreferenced' }] });
  assert.match(out, /classDef unused stroke-dasharray: 4 3/);
  const id = out.match(/(n\d+)\["FB_Lonely"\]/)![1];
  assert.match(out, new RegExp(`class ${id} unused`));
});

test('only restricts to the nodes and their neighbours', () => {
  const out = objectGraphMermaid(graphOf(views), { only: ['FB_MOTOR'] });
  assert.match(out, /\["FB_Motor"\]/);
  assert.match(out, /\["MAIN"\]/);
  assert.match(out, /\["FB_Lonely"\]/);
  assert.ok(!/FB_Far/.test(out));
});

test('mermaidNodeCount counts the node lines', () => {
  assert.equal(mermaidNodeCount(objectGraphMermaid(graphOf(views), {})), 4);
});
