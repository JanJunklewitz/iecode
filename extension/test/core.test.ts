import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadSolution, loadPlcProject, listMembers, findFiles } from '../src/core/projects';
import { newObjectXml, addSections, methodSection, propertySection, actionSection, interfaceStubs, declaration } from '../src/core/templates';
import { addCompile, addFolder, removeCompile, removeFolder, renamePath, renameObjectXml, hasCompile } from '../src/core/plcproj';
import { decode, encode } from '../src/model';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'ws');
const plc1 = join(fixtures, 'apps/MachineX/MachineX/PLC1');

function tempCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-ext-'));
  cpSync(fixtures, dir, { recursive: true });
  return dir;
}

test('loads solution, PLC project, objects with types and references', async () => {
  const sln = await loadSolution(join(fixtures, 'apps/MachineX/MachineX.sln'));
  assert.equal(sln.projects.length, 1);
  assert.equal(sln.projects[0].tcVersion, '3.1.4024.66');
  const plc = sln.projects[0].plcs[0];
  assert.equal(plc.name, 'PLC1');
  assert.equal(plc.isLibrary, false);
  assert.deepEqual(plc.folders, ['Interfaces', 'POUs', 'POUs/Motion']);
  const byName = Object.fromEntries(plc.objects.map(o => [o.name, o]));
  assert.equal(byName.MAIN.type, 'PROGRAM');
  assert.equal(byName.FB_Motor.type, 'FUNCTION_BLOCK');
  assert.equal(byName.I_Motor.type, 'INTERFACE');
  assert.equal(byName.FB_Motor.rel, 'POUs/Motion/FB_Motor.TcPOU');
  const refs = Object.fromEntries(plc.references.map(r => [r.effective.name, r]));
  assert.equal(refs.Tc3_MotorLib.effective.version, '1.2.0');
  assert.equal(refs.Tc2_Standard.effective.version, '*');
});

test('library metadata of a library project', async () => {
  const lib = await loadPlcProject(join(fixtures, 'libs/Tc3_MotorLib/MotorLib/MotorLib/MotorLib.plcproj'));
  assert.equal(lib.isLibrary, true);
  assert.deepEqual([lib.title, lib.company, lib.version], ['Tc3_MotorLib', 'Example Machines Ltd', '1.3.0']);
});

test('lists members of a POU and an interface', () => {
  const fb = listMembers(readFileSync(join(plc1, 'POUs/Motion/FB_Motor.TcPOU'), 'utf8'));
  assert.deepEqual(fb.map(m => `${m.kind} ${m.name}`), ['METHOD Start', 'PROPERTY Speed', 'ACTION Reset', 'METHOD Diagram']);
  assert.equal(fb.find(m => m.name === 'Speed')!.get, true);
  assert.equal(fb.find(m => m.name === 'Speed')!.set, false);
  assert.match(fb[0].signature, /^METHOD PUBLIC Start : BOOL/);
  const itf = listMembers(readFileSync(join(plc1, 'Interfaces/I_Motor.TcIO'), 'utf8'));
  assert.deepEqual(itf.map(m => m.name), ['Start']);
});

test('findFiles skips TwinCAT output and tool folders', async () => {
  const found = await findFiles(fixtures, ['.plcproj']);
  assert.equal(found.length, 3);
});

test('new objects are valid, CRLF + BOM, and round-trip through the ST view', () => {
  for (const kind of ['FUNCTION_BLOCK', 'PROGRAM', 'FUNCTION', 'INTERFACE', 'STRUCT', 'ENUM', 'UNION', 'ALIAS', 'GVL'] as const) {
    const xml = newObjectXml(kind, 'X_Test', { implements: kind === 'FUNCTION_BLOCK' ? ['I_Motor'] : undefined });
    assert.equal(xml.charCodeAt(0), 0xfeff, kind);
    assert.ok(!/[^\r]\n/.test(xml), `${kind} CRLF`);
    const src = xml.slice(1);
    assert.equal(encode(src, decode(src)), src, `${kind} round trip`);
  }
  assert.match(declaration('FUNCTION_BLOCK', 'FB_A', { extends: 'FB_Base', implements: ['I_A', 'I_B'], abstract: true }),
    /^FUNCTION_BLOCK ABSTRACT FB_A EXTENDS FB_Base IMPLEMENTS I_A, I_B\n/);
  assert.throws(() => newObjectXml('PROGRAM', '1abc'), /identifier/);
});

test('adds method, property and action to a POU', () => {
  const xml = readFileSync(join(plc1, 'POUs/MAIN.TcPOU'), 'utf8');
  const out = addSections(xml,
    methodSection({ name: 'Init', returnType: 'BOOL', access: 'PRIVATE' }) +
    propertySection({ name: 'Ready', type: 'BOOL', access: 'PUBLIC', get: true, set: true }) +
    actionSection('Cyclic'));
  assert.equal(out.charCodeAt(0), 0xfeff);
  const members = listMembers(out);
  assert.deepEqual(members.map(m => `${m.kind} ${m.name}`), ['METHOD Init', 'PROPERTY Ready', 'ACTION Cyclic']);
  assert.ok(members[1].get && members[1].set);
  assert.match(out, /<Method Name="Init" Id="\{[0-9a-f-]{36}\}">/);
  assert.match(decode(out.slice(1)), /METHOD PRIVATE Init : BOOL/);
  assert.throws(() => addSections(out, actionSection('Cyclic')), /already exists/);
});

test('implements an interface with stubs, skipping existing members', () => {
  const itf = readFileSync(join(plc1, 'Interfaces/I_Motor.TcIO'), 'utf8');
  const fb = newObjectXml('FUNCTION_BLOCK', 'FB_New', { implements: ['I_Motor'] });
  const stubs = interfaceStubs([itf]);
  assert.match(stubs, /\/\/==== METHOD Start ====\nMETHOD PUBLIC Start : BOOL/);
  const out = addSections(fb, stubs);
  assert.deepEqual(listMembers(out).map(m => m.name), ['Start']);
  assert.equal(interfaceStubs([itf], decode(out.slice(1))), '');
});

test('plcproj edits keep CRLF and touch only their entries', () => {
  const text = readFileSync(join(plc1, 'PLC1.plcproj'), 'utf8');
  const added = addCompile(text, 'POUs/Motion/FB_Axis.TcPOU');
  assert.ok(hasCompile(added, 'POUs/Motion/FB_Axis.TcPOU'));
  assert.ok(!/[^\r]\n/.test(added));
  assert.equal(addCompile(added, 'POUs/Motion/FB_Axis.TcPOU'), added, 'idempotent');
  assert.equal(removeCompile(added, 'POUs/Motion/FB_Axis.TcPOU'), text, 'remove is the inverse of add');

  const folders = addFolder(text, 'DUTs/Axis');
  assert.match(folders, /<Folder Include="DUTs" \/>\r\n\s*<Folder Include="DUTs\\Axis" \/>/);
  assert.equal(addFolder(folders, 'DUTs/Axis'), folders);

  const moved = renamePath(text, 'POUs/Motion', 'POUs/Drives');
  assert.match(moved, /<Compile Include="POUs\\Drives\\FB_Motor.TcPOU">/);
  assert.match(moved, /<Folder Include="POUs\\Drives" \/>/);
  assert.match(moved, /<Compile Include="POUs\\MAIN.TcPOU">/);

  const gone = removeFolder(text, 'POUs');
  assert.ok(!/POUs/.test(gone));
  assert.match(gone, /Interfaces\\I_Motor/);
});

test('renames an object inside its file', () => {
  const xml = readFileSync(join(plc1, 'POUs/Motion/FB_Motor.TcPOU'), 'utf8');
  const out = renameObjectXml(xml, 'FB_Motor', 'FB_Drive');
  assert.match(out, /<POU Name="FB_Drive"/);
  assert.match(out, /FUNCTION_BLOCK FB_Drive/);
  assert.match(out, /<LineIds Name="FB_Drive.Speed.Get">/);
  assert.ok(!/FB_Motor/.test(out));
});

test('temp copies are isolated', () => {
  const dir = tempCopy();
  try { assert.ok(readFileSync(join(dir, 'apps/MachineX/MachineX.sln'), 'utf8').length > 0); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
