import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'zlib';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readLibraryArchive } from '../src/core/libraryArchive';
import { findLibrarySource, scanFolder, scanRepository } from '../src/core/libraries';
import { listMembers } from '../src/core/projects';
import { decode } from '../src/model';
import { SymbolIndex } from '../src/lang/index';

// ---------------------------------------------------------------- a .library as CODESYS writes it

const varint = (n: number) => {
  const out: number[] = [];
  do { let c = n & 0x7f; n >>>= 7; if (n) c |= 0x80; out.push(c); } while (n);
  return Buffer.from(out);
};
const HEAD = (body: Buffer) => {
  const h = Buffer.alloc(20);
  h.writeUInt32LE(0x28092002, 0);
  h.writeUInt32LE(body.length, 16);
  return Buffer.concat([h, body]);
};

function zip(files: [string, Buffer][]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const comp = deflateRawSync(data), n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    local.push(lh, n, comp);
    central.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

interface Obj { guid: string; parent?: string; name: string; folder?: string; impl?: string; decl?: string; short?: boolean }

/** Builds a library: strings are de-duplicated per line like CODESYS does; object 0 is a GUID (string index 0). */
function library(objs: Obj[], extraStrings: string[] = []): Buffer {
  const strings: string[] = ['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '00000000-0000-0000-0000-000000000000'];
  const idx = (s: string) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  extraStrings.forEach(idx);
  let lineId = 0x0550;
  const run = (text: string) => Buffer.concat(text.split('\n').map(l => {
    const r = Buffer.alloc(10);
    r[0] = 0x0b;
    r.writeUInt32LE(lineId++, 1);
    return Buffer.concat([r, varint(idx(l))]);
  }));
  const files: [string, Buffer][] = [];
  for (const o of objs) {
    const meta = o.short
      ? Buffer.concat([Buffer.from([0x0f, 0x0a]), varint(idx(o.guid)), varint(idx(o.parent ?? strings[1])), varint(idx(o.name)), Buffer.from([0, 0, 0]), varint(idx('792f2eb6-721e-4e64-ba20-bc98351056db')), Buffer.from([2, 0x80, 0x0c, 0x6b])])
      : Buffer.concat([Buffer.from([0x0f, 0x0a]), varint(idx(o.guid)), varint(idx(o.parent ?? strings[1])), varint(idx(o.name)),
        Buffer.from([0x01, 0x80, 0x0c, 0x0f, 0x62, 0x09, 0x01, 0x80, 0x0c, 0x80, 0x0c, 0x5f]), varint(idx(o.folder ?? strings[1])),
        varint(idx('6f9dac99-8de1-4efc-8465-68ac443b7d08')), Buffer.from([0x02, 0x80, 0x0c, 0x6b])]);
    const parts: Buffer[] = [Buffer.from([0x0f, 0x13, 0x12, 0x0c, 0x01, 0x0f])];
    if (o.impl !== undefined) parts.push(run(o.impl));
    // the separator ends in 0c 0b 0f: together with the next record it looks like a record of string 0 (a GUID)
    if (o.decl !== undefined) parts.push(Buffer.from([0x0d, 0x0c, 0x0b, 0x0f]), run(o.decl));
    parts.push(Buffer.from([0x14, 0xcc, 0x01]));
    files.push([`${o.guid}.meta`, HEAD(meta)], [`${o.guid}.object`, HEAD(Buffer.concat(parts))]);
  }
  const table = Buffer.concat([varint(strings.length), ...strings.map((s, i) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(i), varint(b.length), b]); })]);
  return zip([...files, ['__shared_data_storage_string_table__.auxiliary', table]]);
}

const G = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const LIB = library([
  { guid: G(1), name: 'POUs' },
  { guid: G(2), name: 'Motion', folder: G(1) },
  { guid: G(3), name: 'FB_Drive', folder: G(2), impl: 'nCount := nCount + 1;\nM_Reset();', decl: '(*\n:Description: A drive.\n*)\nFUNCTION_BLOCK FB_Drive EXTENDS FB_Base\nVAR\n\tnCount : INT;\nEND_VAR' },
  { guid: G(4), parent: G(3), name: 'M_Reset', impl: 'nCount := 0;', decl: 'METHOD M_Reset : BOOL\nVAR_INPUT\nEND_VAR' },
  { guid: G(5), parent: G(3), name: 'P_Count', decl: 'PROPERTY P_Count : INT' },
  { guid: G(6), parent: G(5), name: 'Get', impl: 'P_Count := nCount;', decl: 'VAR\nEND_VAR', short: true },
  { guid: G(7), parent: G(3), name: 'A_Clear', impl: 'nCount := 0;' },
  { guid: G(8), name: 'E_Mode', folder: G(1), decl: 'TYPE E_Mode :\n(\n\teOff,\n\teOn\n);\nEND_TYPE' },
  { guid: G(9), name: 'GVL_Drive', decl: '{attribute \'qualified_only\'}\nVAR_GLOBAL\n\tgnDrives : INT;\nEND_VAR' },
  { guid: G(10), name: 'I_Drive', decl: 'INTERFACE I_Drive' },
  { guid: G(11), parent: G(10), name: 'M_Start', decl: 'METHOD M_Start : BOOL' },
  { guid: G(12), name: 'VI_Drive' },                                 // a visualization: no text, skipped
], ['Tc2_Standard, * (Beckhoff Automation GmbH)', 'Tc3_Base, 1.2.0.0 (Example GmbH)', 'not, a (library) reference text']);

test('reads POUs, DUTs, GVLs and interfaces with their members from a .library', () => {
  const a = readLibraryArchive(LIB);
  assert.deepEqual(a.objects.map(o => `${o.folder}|${o.name}${o.ext}|${o.type}`), [
    '|GVL_Drive.TcGVL|GVL', '|I_Drive.TcIO|INTERFACE', 'POUs|E_Mode.TcDUT|ENUM', 'POUs/Motion|FB_Drive.TcPOU|FUNCTION_BLOCK',
  ]);
  const fb = a.objects.find(o => o.name === 'FB_Drive')!;
  assert.equal(decode(fb.xml), [
    '(*', ':Description: A drive.', '*)', 'FUNCTION_BLOCK FB_Drive EXTENDS FB_Base', 'VAR', '\tnCount : INT;', 'END_VAR',
    '//---- IMPLEMENTATION ----', 'nCount := nCount + 1;', 'M_Reset();',
    '//==== ACTION A_Clear ====', '//---- IMPLEMENTATION ----', 'nCount := 0;',
    '//==== METHOD M_Reset ====', 'METHOD M_Reset : BOOL', 'VAR_INPUT', 'END_VAR', '//---- IMPLEMENTATION ----', 'nCount := 0;',
    '//==== PROPERTY P_Count ====', 'PROPERTY P_Count : INT',
    '//==== GET P_Count ====', 'VAR', 'END_VAR', '//---- IMPLEMENTATION ----', 'P_Count := nCount;',
  ].join('\n') + '\n');
  assert.deepEqual(listMembers(fb.xml).map(m => `${m.kind} ${m.name}${m.get ? ' get' : ''}`), ['ACTION A_Clear', 'METHOD M_Reset', 'PROPERTY P_Count get']);
  const itf = a.objects.find(o => o.name === 'I_Drive')!;
  assert.equal(decode(itf.xml), 'INTERFACE I_Drive\n//==== METHOD M_Start ====\nMETHOD M_Start : BOOL\n');
  assert.deepEqual(a.dependencies.map(d => `${d.name} ${d.version}`), ['Tc2_Standard *', 'Tc3_Base 1.2.0.0']);
});

test('rejects files that are not libraries', () => {
  assert.throws(() => readLibraryArchive(Buffer.from('not a zip at all, just text')), /Not a ZIP/);
  assert.throws(() => readLibraryArchive(zip([['a.txt', Buffer.from('x')]])), /not a TwinCAT/);
});

test('finds the .library of a reference in the repository and in library folders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-libsrc-'));
  try {
    const repo = join(dir, 'repo'), folder = join(dir, 'folder');
    for (const v of ['1.0.0', '1.1.0']) {
      mkdirSync(join(repo, 'example gmbh', 'tc3_drive', v), { recursive: true });
      writeFileSync(join(repo, 'example gmbh', 'tc3_drive', v, 'Tc3_Drive.library'), LIB);
    }
    mkdirSync(join(repo, 'beckhoff automation gmbh', 'tc2_standard', '3.4.5.0'), { recursive: true });
    writeFileSync(join(repo, 'beckhoff automation gmbh', 'tc2_standard', '3.4.5.0', 'Tc2_Standard.compiled-library'), '');
    mkdirSync(folder);
    writeFileSync(join(folder, 'Tc3_Tools_2.0.0.library'), LIB);
    const available = [...await scanRepository(repo), ...await scanFolder(folder)];

    const newest = await findLibrarySource({ name: 'Tc3_Drive', version: '*', vendor: 'Example GmbH' }, available);
    assert.equal(newest.version, '1.1.0');
    assert.equal(newest.file, join(repo, 'example gmbh', 'tc3_drive', '1.1.0', 'Tc3_Drive.library'));
    assert.equal((await findLibrarySource({ name: 'Tc3_Drive', version: '1.0.0', vendor: 'Example GmbH' }, available)).version, '1.0.0');
    assert.deepEqual(await findLibrarySource({ name: 'Tc3_Drive', version: '9.9.9', vendor: 'Example GmbH' }, available), {});
    assert.deepEqual(await findLibrarySource({ name: 'Tc2_Standard', version: '*', vendor: 'Beckhoff Automation GmbH' }, available), { compiled: true });
    assert.equal((await findLibrarySource({ name: 'Tc3_Tools', version: '2.0.0', vendor: 'Someone' }, available)).file, join(folder, 'Tc3_Tools_2.0.0.library'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('symbol index: library objects, namespace-qualified names and workspace precedence', () => {
  const idx = new SymbolIndex();
  for (const o of readLibraryArchive(LIB).objects) idx.update(`/lib/Tc3_Drive.library/${o.name}${o.ext}`, decode(o.xml), 'Tc3_Drive');
  idx.setNamespaces(new Map([['Drv', 'Tc3_Drive'], ['Tc3_Drive', 'Tc3_Drive']]));
  const app = 'PROGRAM MAIN\nVAR\n\tfbA : FB_Drive;\n\tfbB : Drv.FB_Drive;\nEND_VAR\n//---- IMPLEMENTATION ----\nfbA.M_Reset();\nfbB.P_Count;\nDrv.GVL_Drive.gnDrives := 1;\n';
  idx.update('/ws/MAIN.TcPOU', app);
  const at = (line: number, word: string) => idx.resolve('/ws/MAIN.TcPOU', line, app.split('\n')[line].lastIndexOf(word));

  assert.equal(at(2, 'FB_Drive')?.file, '/lib/Tc3_Drive.library/FB_Drive.TcPOU');
  assert.equal(at(3, 'FB_Drive')?.file, '/lib/Tc3_Drive.library/FB_Drive.TcPOU');       // Drv.FB_Drive
  assert.equal(at(6, 'M_Reset')?.symbol.kind, 'METHOD');
  assert.equal(at(7, 'P_Count')?.symbol.kind, 'PROPERTY');
  assert.equal(at(8, 'gnDrives')?.symbol.name, 'gnDrives');
  assert.equal(at(8, 'Drv'), undefined);
  assert.deepEqual(idx.completions('/ws/MAIN.TcPOU', 8, 4).map(c => c.label).sort(), ['E_Mode', 'FB_Drive', 'GVL_Drive', 'I_Drive']);

  // references from the workspace into the library
  const decl = at(2, 'FB_Drive')!;
  assert.deepEqual(idx.references(decl).map(r => `${r.file}:${r.range.line}`).sort(),
    ['/lib/Tc3_Drive.library/FB_Drive.TcPOU:3', '/ws/MAIN.TcPOU:2', '/ws/MAIN.TcPOU:3']);

  // a workspace object of the same name wins, and the library one comes back when it is removed
  idx.update('/ws/FB_Drive.TcPOU', 'FUNCTION_BLOCK FB_Drive\n');
  assert.equal(at(2, 'FB_Drive')?.file, '/ws/FB_Drive.TcPOU');
  idx.update('/lib/Tc3_Drive.library/FB_Drive.TcPOU', decode(readLibraryArchive(LIB).objects.find(o => o.name === 'FB_Drive')!.xml), 'Tc3_Drive');
  assert.equal(at(2, 'FB_Drive')?.file, '/ws/FB_Drive.TcPOU');
  idx.remove('/ws/FB_Drive.TcPOU');
  assert.equal(at(2, 'FB_Drive')?.file, '/lib/Tc3_Drive.library/FB_Drive.TcPOU');
});
