import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hasCompile, renameObjectXml } from '../src/core/plcproj';
import { newObjectXml } from '../src/core/templates';
import {
  TC_OBJECT_EXTS, freshIds, isTcObjectFile, movePath, objectName, registerPaths, relInProject, templateKinds, unregisterPaths,
} from '../src/core/projectFiles';

const plc1 = join(__dirname, '..', '..', 'test', 'fixtures', 'ws', 'apps/MachineX/MachineX/PLC1');
const proj = () => readFileSync(join(plc1, 'PLC1.plcproj'), 'utf8');

test('recognizes every TwinCAT object file type, case-insensitively', () => {
  for (const ext of TC_OBJECT_EXTS) {
    assert.ok(isTcObjectFile(`X${ext}`), ext);
    assert.ok(isTcObjectFile(`X${ext.toUpperCase()}`), ext);
  }
  assert.ok(!isTcObjectFile('X.plcproj'));
  assert.ok(!isTcObjectFile('X.txt'));
});

test('paths relative to the PLC project, skipping output and hidden folders', () => {
  assert.equal(relInProject(plc1, join(plc1, 'POUs', 'FB_A.TcPOU')), 'POUs/FB_A.TcPOU');
  assert.equal(relInProject(plc1, join(plc1, 'FB_A.TcPOU')), 'FB_A.TcPOU');
  assert.equal(relInProject(plc1, plc1), undefined);
  assert.equal(relInProject(plc1, join(plc1, '..', 'Other', 'FB_A.TcPOU')), undefined);
  assert.equal(relInProject(plc1, join(plc1, '_CompileInfo', 'x.TcPOU')), undefined);
  assert.equal(relInProject(plc1, join(plc1, '.vs', 'x.TcPOU')), undefined);
});

test('registers new files of all types with their folders, idempotently, keeping CRLF', () => {
  const text = proj();
  const rels = TC_OBJECT_EXTS.map(e => `New/Sub/Obj${e.slice(3)}${e}`);
  const out = registerPaths(text, rels);
  for (const r of rels) assert.ok(hasCompile(out, r), r);
  assert.match(out, /<Folder Include="New" \/>/);
  assert.match(out, /<Folder Include="New\\Sub" \/>/);
  assert.match(out, /<Compile Include="New\\Sub\\ObjVIS.TcVIS">\r\n\s*<SubType>Code<\/SubType>\r\n\s*<\/Compile>/);
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(registerPaths(out, rels), out);
  // a file in the project root needs no folder; an existing one is left alone
  assert.equal(registerPaths(text, ['POUs/MAIN.TcPOU']), text);
  assert.ok(hasCompile(registerPaths(text, ['PlcTask.TcTTO']), 'PlcTask.TcTTO'));
  // an empty new folder
  assert.match(registerPaths(text, [], ['Empty']), /<Folder Include="Empty" \/>/);
});

test('unregisters deleted files and folders', () => {
  const text = proj();
  const added = registerPaths(text, ['GVLs/GVL_Io.TcGVL']);
  assert.equal(unregisterPaths(added, ['GVLs/GVL_Io.TcGVL', 'GVLs']), text);
  const noPous = unregisterPaths(text, ['POUs']);
  assert.ok(!/POUs/.test(noPous));
  assert.equal(unregisterPaths(text, ['Nothing/Here.TcPOU']), text);
});

test('moves renamed files and folders, adding new parent folders', () => {
  const text = proj();
  const file = movePath(text, 'POUs/MAIN.TcPOU', 'Programs/Main/MAIN.TcPOU');
  assert.ok(hasCompile(file, 'Programs/Main/MAIN.TcPOU'));
  assert.ok(!hasCompile(file, 'POUs/MAIN.TcPOU'));
  assert.match(file, /<Folder Include="Programs\\Main" \/>/);
  const dir = movePath(text, 'POUs/Motion', 'POUs/Drives');
  assert.ok(hasCompile(dir, 'POUs/Drives/FB_Motor.TcPOU'));
  assert.ok(!/POUs\\Motion/.test(dir));
});

test('templates only for ST object files', () => {
  assert.deepEqual(templateKinds('X.TcPOU'), ['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION']);
  assert.deepEqual(templateKinds('X.tcgvl'), ['GVL']);
  assert.deepEqual(templateKinds('X.TcVIS'), []);
});

test('a copied object gets the file name and new ids', () => {
  const xml = newObjectXml('FUNCTION_BLOCK', 'FB_A');
  assert.equal(objectName(xml), 'FB_A');
  const copy = freshIds(renameObjectXml(xml, 'FB_A', 'FB_B'));
  assert.equal(objectName(copy), 'FB_B');
  assert.match(copy, /FUNCTION_BLOCK FB_B/);
  const ids = (s: string) => [...s.matchAll(/Id="(\{[^}]+\})"/g)].map(m => m[1]);
  assert.equal(ids(copy).length, ids(xml).length);
  assert.ok(ids(copy).every(id => !ids(xml).includes(id)));
});
