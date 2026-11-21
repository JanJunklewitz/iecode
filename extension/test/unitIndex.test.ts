import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnitIndex, UnitIndexInput } from '../src/core/unitIndex';
import type { Unit } from '../src/core/workspace';
import type { IndexedObject } from '../src/lang/index';

const xml = (kind: 'POU' | 'GVL', name: string, decl: string, impl = '') => [
  '<?xml version="1.0" encoding="utf-8"?>', '<TcPlcObject Version="1.1.0.1">', `  <${kind} Name="${name}" Id="{00000000-0000-0000-0000-000000000001}">`,
  `    <Declaration><![CDATA[${decl}]]></Declaration>`,
  ...(kind === 'POU' ? ['    <Implementation>', `      <ST><![CDATA[${impl}]]></ST>`, '    </Implementation>'] : []),
  `  </${kind}>`, '</TcPlcObject>', ''].join('\n');

function unit(id: string, files: { file: string; name: string; type: string; encrypted?: boolean }[], opts: { isLibrary?: boolean; title?: string; references?: unknown[] } = {}): Unit {
  return { id, group: opts.isLibrary ? 'library' : 'application',
    plc: { file: `/${id}.plcproj`, dir: `/${id}`, name: id, title: opts.title, isLibrary: !!opts.isLibrary, folders: [], references: opts.references ?? [],
      objects: files.map(f => ({ rel: f.name, file: f.file, name: f.name, type: f.type, encrypted: f.encrypted })) } } as unknown as Unit;
}

const input = (files: Record<string, string>, extra: Partial<UnitIndexInput> = {}): UnitIndexInput => ({
  readFile: async f => files[f], libraryObjects: () => [], namespaces: () => new Map(), ...extra,
});

const MAIN = (u: string) => ({ file: `/${u}/MAIN.TcPOU`, name: 'MAIN', type: 'PROGRAM' });

test('two units with a MAIN each get separate indexes', async () => {
  const a = unit('A', [MAIN('A')]), b = unit('B', [MAIN('B')]);
  const files = { '/A/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN', 'a;'), '/B/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN', 'b;') };
  const model = { units: [a, b], edges: [] };
  const ia = (await buildUnitIndex(a, model, input(files), [])).index;
  const ib = (await buildUnitIndex(b, model, input(files), [])).index;
  assert.equal(ia.find('MAIN')!.file, '/A/MAIN.TcPOU');
  assert.equal(ib.find('MAIN')!.file, '/B/MAIN.TcPOU');
  assert.equal(ia.objects().length, 1);
});

test('a workspace library project referenced with link workspace is indexed, a pinned one is not', async () => {
  const lib = unit('Lib', [{ file: '/Lib/FB_L.TcPOU', name: 'FB_L', type: 'FUNCTION_BLOCK' }], { isLibrary: true, title: 'Lib' });
  const app = unit('App', [MAIN('App')]);
  const files = { '/App/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN'), '/Lib/FB_L.TcPOU': xml('POU', 'FB_L', 'FUNCTION_BLOCK FB_L') };
  const edge = (link: 'workspace' | 'pinned') => ({ from: 'App', to: 'Lib', link, ref: {} as never });
  const linked = (await buildUnitIndex(app, { units: [app, lib], edges: [edge('workspace')] }, input(files), [])).index;
  assert.equal(linked.find('FB_L')?.library, 'Lib');           // marked as library: never reported
  const pinned = (await buildUnitIndex(app, { units: [app, lib], edges: [edge('pinned')] }, input(files), [])).index;
  assert.equal(pinned.find('FB_L'), undefined);
});

test('namespaces make a Lib.FB_X name resolve', async () => {
  const app = unit('App', [MAIN('App')]);
  const r = await buildUnitIndex(app, { units: [app], edges: [] }, input({ '/App/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN') }, {
    namespaces: () => new Map([['Tc2_Standard', 'Tc2_Standard']]),
    libraryObjects: () => [{ key: '/lib/TON.TcPOU', view: 'FUNCTION_BLOCK TON\n//---- IMPLEMENTATION ----\n', library: 'Tc2_Standard' }],
  }), []);
  assert.equal(r.index.find('Tc2_Standard.TON')?.library, 'Tc2_Standard');
});

test('a library object parsed once is shared by two unit indexes', async () => {
  const a = unit('A', [MAIN('A')]), b = unit('B', [MAIN('B')]);
  const parsed = new Map<string, IndexedObject>();
  const lib = [{ key: '/lib/TON.TcPOU', view: 'FUNCTION_BLOCK TON\n//---- IMPLEMENTATION ----\n', library: 'L' }];
  const files = { '/A/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN'), '/B/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN') };
  const model = { units: [a, b], edges: [] };
  const ia = (await buildUnitIndex(a, model, input(files, { libraryObjects: () => lib, parsed }), [])).index;
  const ib = (await buildUnitIndex(b, model, input(files, { libraryObjects: () => lib, parsed }), [])).index;
  assert.equal(ia.find('TON'), ib.find('TON'), 'the very same parsed object');
});

test('an unreadable, an encrypted and a broken file are reported in skipped', async () => {
  const u = unit('U', [MAIN('U'), { file: '/U/Gone.TcPOU', name: 'Gone', type: 'PROGRAM' },
    { file: '/U/Secret.TcPOU', name: 'Secret', type: 'PROGRAM', encrypted: true }, { file: '/U/Bad.TcPOU', name: 'Bad', type: 'PROGRAM' }]);
  const notes: string[] = [];
  const r = await buildUnitIndex(u, { units: [u], edges: [] }, input({ '/U/MAIN.TcPOU': xml('POU', 'MAIN', 'PROGRAM MAIN'), '/U/Bad.TcPOU': '<not-plc/>' }), notes);
  assert.deepEqual(r.skipped.map(s => `${s.file}:${s.reason}`).sort(), ['/U/Bad.TcPOU:not-st', '/U/Gone.TcPOU:unreadable', '/U/Secret.TcPOU:encrypted']);
  assert.equal(notes.length, 1);
  assert.equal(r.index.find('MAIN')?.file, '/U/MAIN.TcPOU');
});
