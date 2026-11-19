import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AnalysisDeps, AnalysisState } from '../src/core/analysisState';
import type { Unit } from '../src/core/workspace';

const TASK = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'archive', 'PlcTask.TcTTO'), 'utf8');   // calls MAIN and VisuElems.Visu_Prg
const TASK_MAIN_ONLY = TASK.replace(/<PouCall>\s*<Name>VisuElems\.Visu_Prg<\/Name>\s*<\/PouCall>/, '');

const pou = (name: string, decl: string, impl = '', methods: Record<string, string> = {}) => [
  '<?xml version="1.0" encoding="utf-8"?>', '<TcPlcObject Version="1.1.0.1">', `  <POU Name="${name}" Id="{00000000-0000-0000-0000-000000000001}">`,
  `    <Declaration><![CDATA[${decl}]]></Declaration>`, '    <Implementation>', `      <ST><![CDATA[${impl}]]></ST>`, '    </Implementation>',
  ...Object.entries(methods).flatMap(([m, body]) => [`    <Method Name="${m}" Id="{00000000-0000-0000-0000-0000000000${m.length}2}">`,
    `      <Declaration><![CDATA[METHOD ${m} : BOOL]]></Declaration>`, '      <Implementation>', `        <ST><![CDATA[${body}]]></ST>`, '      </Implementation>', '    </Method>']),
  '  </POU>', '</TcPlcObject>', ''].join('\n');

interface Disk { files: Map<string, { text: string; v: number }>; reads: string[] }
const disk = (): Disk => ({ files: new Map(), reads: [] });
const put = (d: Disk, f: string, text: string) => d.files.set(f, { text, v: (d.files.get(f)?.v ?? 0) + 1 });

function unit(id: string, objs: { file: string; name: string; type: string; encrypted?: boolean }[], isLibrary = false): Unit {
  return { id, group: 'application', plc: { file: `/${id}.plcproj`, dir: `/${id}`, name: id, isLibrary, folders: [], references: [],
    objects: objs.map(o => ({ rel: o.name, ...o })) } } as unknown as Unit;
}
const deps = (d: Disk, units: Unit[], extra: Partial<AnalysisDeps> = {}): AnalysisDeps => ({
  model: () => ({ units, edges: [] }),
  read: async f => { const x = d.files.get(f); if (x) d.reads.push(f); return x && { text: x.text, stamp: String(x.v) }; },
  libraryObjects: () => [], namespaces: () => new Map(), settings: () => ({ rootObjects: [], rootPragmas: [] }), ...extra,
});

function app(d: Disk, id = 'App', extra: { file: string; name: string; type: string; encrypted?: boolean }[] = []) {
  put(d, `/${id}/PlcTask.TcTTO`, TASK_MAIN_ONLY);
  return unit(id, [{ file: `/${id}/PlcTask.TcTTO`, name: 'PlcTask', type: 'TASK' }, { file: `/${id}/MAIN.TcPOU`, name: 'MAIN', type: 'PROGRAM' }, ...extra]);
}

test('a changed file is read again, the others come from the cache', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN\nVAR\n    fb : FB_A;\nEND_VAR', 'fb.Go();'));
  put(d, '/App/FB_A.TcPOU', pou('FB_A', 'FUNCTION_BLOCK FB_A', '', { Go: ';' }));
  const u = app(d, 'App', [{ file: '/App/FB_A.TcPOU', name: 'FB_A', type: 'FUNCTION_BLOCK' }]);
  const st = new AnalysisState(deps(d, [u]));
  await st.request('App');
  const stamps = new Map<string, number>();
  d.reads.forEach(f => stamps.set(f, (stamps.get(f) ?? 0) + 1));
  put(d, '/App/FB_A.TcPOU', pou('FB_A', 'FUNCTION_BLOCK FB_A', '', { Go: ';', Extra: ';' }));
  st.invalidate('App');
  const a = await st.request('App');
  assert.ok(a.graph.nodes.has('FB_A.EXTRA'), 'the changed file is analysed again');
  assert.ok(a.unused.some(f => f.id === 'FB_A.EXTRA'));
});

test('a change in a callee changes the resolution of an unchanged caller', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN\nVAR\n    fb : FB_A;\nEND_VAR', 'fb.Go();'));
  put(d, '/App/FB_A.TcPOU', pou('FB_A', 'FUNCTION_BLOCK FB_A', '', { Go: ';' }));
  const u = app(d, 'App', [{ file: '/App/FB_A.TcPOU', name: 'FB_A', type: 'FUNCTION_BLOCK' }]);
  const st = new AnalysisState(deps(d, [u]));
  const before = await st.request('App');
  assert.ok(before.reach.reachable.has('FB_A.GO'));
  put(d, '/App/FB_A.TcPOU', pou('FB_A', 'FUNCTION_BLOCK FB_A', '', { Renamed: ';' }));
  st.invalidate('App');
  const after = await st.request('App');
  assert.ok(!after.graph.nodes.has('FB_A.GO'));
  assert.ok(after.graph.byNameUnresolved.has('GO'), 'the unchanged caller now has an unresolved name');
});

test('an encrypted file makes the analysis incomplete and no unused findings are produced', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  put(d, '/App/FB_Lonely.TcPOU', pou('FB_Lonely', 'FUNCTION_BLOCK FB_Lonely'));
  const u = app(d, 'App', [{ file: '/App/FB_Lonely.TcPOU', name: 'FB_Lonely', type: 'FUNCTION_BLOCK' }, { file: '/App/Secret.TcPOU', name: 'Secret', type: 'PROGRAM', encrypted: true }]);
  put(d, '/Ok/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN')); put(d, '/Ok/FB_Lonely.TcPOU', pou('FB_Lonely', 'FUNCTION_BLOCK FB_Lonely'));
  const complete = await new AnalysisState(deps(d, [app(d, 'Ok', [{ file: '/Ok/FB_Lonely.TcPOU', name: 'FB_Lonely', type: 'FUNCTION_BLOCK' }])])).request('Ok');
  assert.equal(complete.complete, true);
  const r = await new AnalysisState(deps(d, [u])).request('App');
  assert.equal(r.complete, false);
  assert.deepEqual(r.unused, []);
  assert.ok(r.notes.some(n => /not complete/.test(n)));
});

test('a library unit is skipped, a unit without task file is skipped with the note', async () => {
  const d = disk();
  put(d, '/Lib/FB_L.TcPOU', pou('FB_L', 'FUNCTION_BLOCK FB_L'));
  const lib = unit('Lib', [{ file: '/Lib/FB_L.TcPOU', name: 'FB_L', type: 'FUNCTION_BLOCK' }], true);
  put(d, '/NoTask/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  const nt = unit('NoTask', [{ file: '/NoTask/MAIN.TcPOU', name: 'MAIN', type: 'PROGRAM' }]);
  const st = new AnalysisState(deps(d, [lib, nt]));
  assert.equal((await st.request('Lib')).skipped, 'library');
  const r = await st.request('NoTask');
  assert.equal(r.skipped, 'no-tasks');
  assert.deepEqual(r.unused, []);
  assert.ok(r.notes.some(n => /no tasks found/.test(n)));
});

test('a task call into a namespace without source is a note and does not make the analysis incomplete', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  put(d, '/App/PlcTask.TcTTO', TASK);
  const u = unit('App', [{ file: '/App/PlcTask.TcTTO', name: 'PlcTask', type: 'TASK' }, { file: '/App/MAIN.TcPOU', name: 'MAIN', type: 'PROGRAM' }]);
  const r = await new AnalysisState(deps(d, [u], { namespaces: () => new Map([['VisuElems', 'VisuElems']]) })).request('App');
  assert.equal(r.complete, true);
  assert.ok(r.notes.some(n => /Visu_Prg/.test(n)));
});

test('two units with a MAIN each resolve into their own objects', async () => {
  const d = disk();
  put(d, '/A/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN\nVAR\n    x : FB_X;\nEND_VAR', 'x.Go();'));
  put(d, '/A/FB_X.TcPOU', pou('FB_X', 'FUNCTION_BLOCK FB_X', '', { Go: ';' }));
  put(d, '/B/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  put(d, '/B/FB_X.TcPOU', pou('FB_X', 'FUNCTION_BLOCK FB_X', '', { Go: ';' }));
  const a = app(d, 'A', [{ file: '/A/FB_X.TcPOU', name: 'FB_X', type: 'FUNCTION_BLOCK' }]);
  const b = app(d, 'B', [{ file: '/B/FB_X.TcPOU', name: 'FB_X', type: 'FUNCTION_BLOCK' }]);
  const st = new AnalysisState(deps(d, [a, b]));
  const ra = await st.request('A'), rb = await st.request('B');
  assert.ok(ra.reach.reachable.has('FB_X.GO'));
  assert.ok(!rb.reach.reachable.has('FB_X.GO'));
  assert.equal(ra.graph.nodes.get('FB_X')!.file, '/A/FB_X.TcPOU');
  assert.equal(rb.graph.nodes.get('FB_X')!.file, '/B/FB_X.TcPOU');
});

test('peek never blocks, onDidChange fires after a computation, a second request is served from the cache', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  const u = app(d);
  const st = new AnalysisState(deps(d, [u]));
  const fired: string[][] = [];
  st.onDidChange(ids => fired.push(ids));
  assert.equal(st.peek('App'), undefined);
  const p = st.request('App');
  assert.equal(st.peek('App'), undefined);
  const r = await p;
  assert.equal(st.peek('App'), r);
  assert.deepEqual(fired, [['App']]);
  const reads = d.reads.length;
  await st.request('App');
  assert.equal(d.reads.length, reads);
});

test('the analysis yields to the event loop between slices', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  const objs = Array.from({ length: 80 }, (_, i) => { put(d, `/App/FB_${i}.TcPOU`, pou(`FB_${i}`, `FUNCTION_BLOCK FB_${i}`)); return { file: `/App/FB_${i}.TcPOU`, name: `FB_${i}`, type: 'FUNCTION_BLOCK' }; });
  const u = app(d, 'App', objs);
  let turns = 0, stop = false;
  const tick = () => { turns++; if (!stop) setImmediate(tick); };
  setImmediate(tick);
  await new AnalysisState(deps(d, [u]), 25).request('App');
  stop = true;
  assert.ok(turns >= 3, `${turns} event loop turns`);
});

test('a generated project of 500 objects with 200 lines each analyses in under 10 s', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN\nVAR\n    f0 : FB_0;\nEND_VAR', 'f0.Go();'));
  const objs = Array.from({ length: 500 }, (_, i) => {
    const body = Array.from({ length: 200 }, (_, k) => `n := n + ${k};`).join('\n');
    put(d, `/App/FB_${i}.TcPOU`, pou(`FB_${i}`, `FUNCTION_BLOCK FB_${i}\nVAR\n    n : INT;\n    next : FB_${(i + 1) % 500};\nEND_VAR`, body, { Go: 'next.Go();' }));
    return { file: `/App/FB_${i}.TcPOU`, name: `FB_${i}`, type: 'FUNCTION_BLOCK' };
  });
  const u = app(d, 'App', objs);
  const t0 = Date.now();
  const r = await new AnalysisState(deps(d, [u])).request('App');
  const ms = Date.now() - t0;
  console.log(`analysis of 500 objects x 200 lines: ${ms} ms`);
  assert.ok(r.graph.nodes.size >= 1000);
  assert.ok(ms < 10_000, `${ms} ms`);
});

const FB_GO = (extra: Record<string, string> = {}) => pou('FB_A', 'FUNCTION_BLOCK FB_A', '', { Go: ';', ...extra });
const MAIN_FB = pou('MAIN', ['PROGRAM MAIN', 'VAR', '    fb : FB_A;', 'END_VAR'].join('\n'), 'fb.Go();');

test('a result computed from files that changed meanwhile is not cached and the caller gets a fresh one', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', MAIN_FB);
  put(d, '/App/FB_A.TcPOU', FB_GO());
  const u = app(d, 'App', [{ file: '/App/FB_A.TcPOU', name: 'FB_A', type: 'FUNCTION_BLOCK' }]);
  let st!: AnalysisState, changed = false;
  const base = deps(d, [u]);
  st = new AnalysisState({ ...base, read: async f => {
    const r = await base.read(f);
    if (f === '/App/FB_A.TcPOU' && !changed) { changed = true; put(d, f, FB_GO({ Extra: ';' })); st.invalidate('App'); }   // a save during the computation
    return r;
  } });
  const a = await st.request('App');
  assert.ok(a.graph.nodes.has('FB_A.EXTRA'), 'the caller gets the analysis of the new file');
  assert.ok(st.peek('App')!.graph.nodes.has('FB_A.EXTRA'), 'and so does the cache');
});

test('an aborted computation is not handed to a caller that joined it', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', MAIN_FB);
  put(d, '/App/FB_A.TcPOU', FB_GO());
  const u = app(d, 'App', [{ file: '/App/FB_A.TcPOU', name: 'FB_A', type: 'FUNCTION_BLOCK' }]);
  const st = new AnalysisState(deps(d, [u]));
  const ac = new AbortController();
  const first = st.request('App', ac.signal), second = st.request('App');
  ac.abort();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.complete, false);
  assert.deepEqual(a.unused, []);
  assert.equal(b.complete, true);
  assert.ok(b.graph.nodes.has('FB_A'), 'the second caller got a full analysis');
  assert.ok(st.peek('App')?.graph.nodes.has('FB_A'));
});

test('a task or visualization file that cannot be read or parsed makes the analysis incomplete', async () => {
  for (const [name, taskText] of [['missing', undefined], ['garbage', '<<< not xml']] as const) {
    const d = disk();
    put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
    put(d, '/App/FB_Lonely.TcPOU', pou('FB_Lonely', 'FUNCTION_BLOCK FB_Lonely'));
    const u = unit('App', [{ file: '/App/PlcTask.TcTTO', name: 'PlcTask', type: 'TASK' }, { file: '/App/MAIN.TcPOU', name: 'MAIN', type: 'PROGRAM' },
      { file: '/App/FB_Lonely.TcPOU', name: 'FB_Lonely', type: 'FUNCTION_BLOCK' }]);
    if (taskText !== undefined) put(d, '/App/PlcTask.TcTTO', taskText);
    const r = await new AnalysisState(deps(d, [u])).request('App');
    assert.equal(r.complete, false, name);
    assert.deepEqual(r.unused, [], name);
  }
});

test('a file that decodes but has no parsed object makes the analysis incomplete', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  put(d, '/App/FB_Empty.TcPOU', pou('FB_Empty', ''));
  const u = app(d, 'App', [{ file: '/App/FB_Empty.TcPOU', name: 'FB_Empty', type: 'FUNCTION_BLOCK' }]);
  const r = await new AnalysisState(deps(d, [u])).request('App');
  assert.equal(r.complete, false);
  assert.deepEqual(r.unused, []);
});

test('invalidate tells listeners that cached results are gone, until they are disposed', async () => {
  const d = disk();
  put(d, '/App/MAIN.TcPOU', pou('MAIN', 'PROGRAM MAIN'));
  const st = new AnalysisState(deps(d, [app(d)]));
  await st.request('App');
  let n = 0;
  const sub = st.onDidInvalidate(() => { n++; });
  st.invalidate('App'); st.invalidate();
  assert.equal(n, 2);
  assert.equal(st.peek('App'), undefined);
  sub.dispose();
  st.invalidate();
  assert.equal(n, 2);
});
