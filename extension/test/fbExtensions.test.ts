import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseObject } from '../src/lang/parser';
import { SymbolIndex } from '../src/lang/index';
import { memberStubs, missingMembers, describeMissing } from '../src/lang/inheritance';
import { layout, toMermaid, toPlantUml, toSvg, umlModel } from '../src/lang/uml';
import { addMemberFolder, deleteMemberFolder, listMemberFolders, listMembers, memberLevel, moveMemberToFolder, renameMemberFolder } from '../src/core/projects';
import { decode, encode } from '../src/model';

const ITF_BASE = `INTERFACE I_Base
//==== METHOD Init ====
METHOD Init : BOOL
`;
const ITF = `INTERFACE I_Motor EXTENDS I_Base
//==== METHOD Start ====
METHOD Start : BOOL
VAR_INPUT
    fSpeed : LREAL;
END_VAR
//==== PROPERTY Speed ====
PROPERTY Speed : LREAL
//==== GET Speed ====
//==== SET Speed ====
`;
const BASE = `FUNCTION_BLOCK ABSTRACT FB_Base IMPLEMENTS I_Motor
VAR
    fbAxis : FB_Axis;
END_VAR
//---- IMPLEMENTATION ----
//==== METHOD Init ====
METHOD PUBLIC Init : BOOL
//---- IMPLEMENTATION ----
Init := TRUE;
//==== METHOD Execute ====
METHOD PROTECTED ABSTRACT Execute : BOOL
VAR_INPUT
    nMode : INT;
END_VAR
//==== PROPERTY State ====
PROPERTY PUBLIC ABSTRACT State : INT
//==== GET State ====
VAR
END_VAR
`;
const AXIS = `FUNCTION_BLOCK FB_Axis
//---- IMPLEMENTATION ----
`;
const CHILD = `FUNCTION_BLOCK FB_Motor EXTENDS FB_Base
//---- IMPLEMENTATION ----
//==== METHOD Start ====
METHOD PUBLIC Start : BOOL
VAR_INPUT
    fSpeed : LREAL;
END_VAR
//---- IMPLEMENTATION ----
`;

function workspace(child = CHILD) {
  const ix = new SymbolIndex();
  ix.update('/p/I_Base.TcIO', ITF_BASE);
  ix.update('/p/I_Motor.TcIO', ITF);
  ix.update('/p/FB_Base.TcPOU', BASE);
  ix.update('/p/FB_Axis.TcPOU', AXIS);
  ix.update('/p/FB_Motor.TcPOU', child);
  return ix;
}

test('parser records ABSTRACT / FINAL and property accessors', () => {
  const { root } = parseObject(BASE, 'FB_Base');
  assert.deepEqual(root!.modifiers, ['ABSTRACT']);
  const exec = root!.children.find(c => c.name === 'Execute')!;
  assert.deepEqual(exec.modifiers, ['ABSTRACT']);
  assert.equal(exec.access, 'PROTECTED');
  const state = root!.children.find(c => c.name === 'State')!;
  assert.deepEqual(state.modifiers, ['ABSTRACT']);
  assert.deepEqual(state.accessors, ['GET']);
  assert.deepEqual(parseObject(ITF, 'I_Motor').root!.children.find(c => c.name === 'Speed')!.accessors, ['GET', 'SET']);
  assert.equal(parseObject('FUNCTION_BLOCK FINAL FB_X\n', 'FB_X').root!.name, 'FB_X');
});

test('missingMembers: abstract base members and interface members (incl. inherited interfaces)', () => {
  const ix = workspace();
  const { missing, unresolved } = missingMembers(ix, ix.get('/p/FB_Motor.TcPOU')!);
  assert.deepEqual(unresolved, []);
  // Start is implemented here, Init in the base class
  assert.deepEqual(missing.map(m => `${m.source.root!.name}.${m.name}:${m.reason}`).sort(),
    ['FB_Base.Execute:abstract', 'FB_Base.State:abstract', 'I_Motor.Speed:interface']);
  assert.match(describeMissing(ix.get('/p/FB_Motor.TcPOU')!, missing), /FB_Motor does not implement 3 members: .*FB_Base\.Execute \(abstract\)/);
});

test('missingMembers: nothing missing once everything is implemented; unresolved bases are reported', () => {
  const ix = workspace();
  const obj = ix.get('/p/FB_Motor.TcPOU')!;
  const full = CHILD + memberStubs(missingMembers(ix, obj).missing);
  ix.update('/p/FB_Motor.TcPOU', full);
  assert.deepEqual(missingMembers(ix, ix.get('/p/FB_Motor.TcPOU')!).missing, []);
  ix.update('/p/FB_X.TcPOU', 'FUNCTION_BLOCK FB_X EXTENDS FB_Unknown IMPLEMENTS I_Gone\n');
  assert.deepEqual(missingMembers(ix, ix.get('/p/FB_X.TcPOU')!).unresolved.sort(), ['FB_Unknown', 'I_Gone']);
});

test('memberStubs: drops ABSTRACT, keeps access and parameters, adds PUBLIC for interface members and accessors', () => {
  const ix = workspace();
  const stubs = memberStubs(missingMembers(ix, ix.get('/p/FB_Motor.TcPOU')!).missing);
  assert.match(stubs, /\/\/==== METHOD Execute ====\nMETHOD PROTECTED Execute : BOOL\nVAR_INPUT\n    nMode : INT;\nEND_VAR\n\/\/---- IMPLEMENTATION ----\n/);
  assert.match(stubs, /\/\/==== PROPERTY State ====\nPROPERTY PUBLIC State : INT\n\/\/==== GET State ====\nVAR\nEND_VAR\n\/\/---- IMPLEMENTATION ----\n/);
  assert.match(stubs, /PROPERTY PUBLIC Speed : LREAL\n\/\/==== GET Speed ====[\s\S]*\/\/==== SET Speed ====/);
  assert.doesNotMatch(stubs, /ABSTRACT/);
});

test('member folders: listed from FolderPath and <Folder>, added and moved in the XML', () => {
  const xml = readFileSync(join(__dirname, '../../samples/FB_Motor.TcPOU'), 'utf8');
  assert.deepEqual(listMemberFolders(xml), ['Internal']);
  assert.equal(listMembers(xml).find(m => m.name === 'Start')!.folder, 'Internal');

  let out = addMemberFolder(xml, 'Internal/Helpers', '{00000000-0000-0000-0000-00000000abcd}');
  assert.match(out, /<Folder Name="Helpers" Id="\{00000000-0000-0000-0000-00000000abcd\}" FolderPath="Internal\\" \/>/);
  assert.throws(() => addMemberFolder(out, 'internal', '{x}'), /already exists/);
  out = moveMemberToFolder(out, 'PROPERTY', 'Speed', 'Internal/Helpers');
  out = moveMemberToFolder(out, 'METHOD', 'Start', '');
  const members = listMembers(out);
  assert.equal(members.find(m => m.name === 'Speed')!.folder, 'Internal/Helpers');
  assert.equal(members.find(m => m.name === 'Start')!.folder, undefined);
  assert.deepEqual(listMemberFolders(out), ['Internal', 'Internal/Helpers']);
  // the ST view is unaffected and still round-trips
  assert.equal(decode(out), decode(xml));
  assert.equal(encode(out, decode(out)), out);

  const lvl = (rel: string) => memberLevel(members, listMemberFolders(out), rel, 'folders');
  assert.deepEqual(lvl(''), { folders: ['Internal'], members: members.filter(m => !m.folder).sort((a, b) => a.name.localeCompare(b.name)) });
  assert.deepEqual(lvl('Internal').folders, ['Internal/Helpers']);
  assert.deepEqual(lvl('Internal/Helpers').members.map(m => m.name), ['Speed']);
  assert.deepEqual(memberLevel(members, [], '', 'kind').folders, ['#METHOD', '#PROPERTY', '#ACTION']);
  assert.equal(memberLevel(members, [], '', 'none').members.length, members.length);
});

test('UML model, Mermaid, PlantUML and SVG', () => {
  const ix = workspace();
  const all = umlModel(ix);
  assert.deepEqual(all.classes.map(c => c.name), ['FB_Axis', 'FB_Base', 'FB_Motor', 'I_Base', 'I_Motor']);
  assert.deepEqual(all.relations.map(r => `${r.from} ${r.kind} ${r.to}${r.label ? ' ' + r.label : ''}`).sort(), [
    'FB_Base composition FB_Axis fbAxis', 'FB_Base implements I_Motor', 'FB_Motor extends FB_Base', 'I_Motor extends I_Base',
  ]);
  const mmd = toMermaid(all);
  assert.match(mmd, /^classDiagram\n/);
  assert.match(mmd, /class FB_Base \{\n {4}<<abstract>>\n[\s\S]*#Execute\(nMode : INT\)\* BOOL/);
  assert.match(mmd, /FB_Base <\|-- FB_Motor/);
  assert.match(mmd, /I_Motor <\|\.\. FB_Base/);
  assert.match(mmd, /FB_Base \*-- FB_Axis : fbAxis/);
  const puml = toPlantUml(all, 'full');
  assert.match(puml, /abstract class FB_Base \{\n {2}-fbAxis : FB_Axis\n {2}--\n/);
  assert.match(puml, /\{abstract\} #Execute\(nMode : INT\) : BOOL/);
  assert.match(puml, /interface I_Motor \{/);
  assert.match(puml, /@enduml\n$/);

  // bases sit above derived classes
  const { boxes } = layout(all);
  const y = (n: string) => boxes.find(b => b.cls.name === n)!.y;
  assert.ok(y('I_Base') < y('I_Motor') && y('I_Motor') < y('FB_Base') && y('FB_Base') < y('FB_Motor'));
  assert.match(toSvg(all), /^<svg [\s\S]*data-class="FB_Motor" data-file="\/p\/FB_Motor.TcPOU"[\s\S]*<\/svg>$/);

  // focus on one class: its bases, interfaces, derived classes and parts
  const focus = umlModel(ix, { focus: ['FB_Base'] });
  assert.deepEqual(focus.classes.map(c => c.name), ['FB_Axis', 'FB_Base', 'FB_Motor', 'I_Base', 'I_Motor']);
  // a file selection draws other bases as external boxes
  const part = umlModel(ix, { files: new Set(['/p/FB_Motor.TcPOU']) });
  assert.deepEqual(part.classes.map(c => `${c.name}${c.external ? ' (ext)' : ''}`), ['FB_Base (ext)', 'FB_Motor']);
});

test('member folders: rename and delete', () => {
  const sample = readFileSync(join(__dirname, '../../samples/FB_Motor.TcPOU'), 'utf8');
  // Internal (Start, Reset) / Internal/Helpers (Speed)
  let xml = addMemberFolder(sample, 'Internal/Helpers', '{00000000-0000-0000-0000-00000000abcd}');
  xml = moveMemberToFolder(xml, 'PROPERTY', 'Speed', 'Internal/Helpers');
  xml = moveMemberToFolder(xml, 'ACTION', 'Reset', 'Internal');
  const where = (x: string) => Object.fromEntries(listMembers(x).map(m => [m.name, m.folder ?? '']));

  // rename moves everything below the folder with it
  const renamed = renameMemberFolder(xml, 'Internal', 'Core');
  assert.deepEqual(listMemberFolders(renamed), ['Core', 'Core/Helpers']);
  assert.deepEqual(where(renamed), { Start: 'Core', Speed: 'Core/Helpers', Reset: 'Core', Diagram: '' });
  assert.match(renamed, /<Folder Name="Core" Id="\{11111111-2222-3333-4444-555555555555\}" \/>/);
  assert.match(renamed, /<Folder Name="Helpers" Id="\{00000000-0000-0000-0000-00000000abcd\}" FolderPath="Core\\" \/>/);
  assert.equal(decode(renamed), decode(sample));
  assert.deepEqual(where(renameMemberFolder(xml, 'Internal/Helpers', 'Util')), { Start: 'Internal', Speed: 'Internal/Util', Reset: 'Internal', Diagram: '' });
  assert.throws(() => renameMemberFolder(xml, 'Internal/Helpers', 'a/b'), /not a valid folder name/);
  assert.throws(() => renameMemberFolder(addMemberFolder(xml, 'Other', '{y}'), 'Other', 'internal'), /already exists/);
  assert.throws(() => renameMemberFolder(xml, 'Nope', 'X'), /not found/);

  // delete, keep members: contents move up one level
  const kept = deleteMemberFolder(xml, 'Internal', false);
  assert.deepEqual(listMemberFolders(kept), ['Helpers']);
  assert.deepEqual(where(kept), { Start: '', Speed: 'Helpers', Reset: '', Diagram: '' });
  assert.doesNotMatch(kept, /Name="Internal"/);
  assert.equal(decode(kept), decode(sample));
  const keptSub = deleteMemberFolder(xml, 'Internal/Helpers', false);
  assert.deepEqual(listMemberFolders(keptSub), ['Internal']);
  assert.deepEqual(where(keptSub), { Start: 'Internal', Speed: 'Internal', Reset: 'Internal', Diagram: '' });

  // delete with members: members, their accessors and LineIds go
  const gone = deleteMemberFolder(xml, 'Internal', true);
  assert.deepEqual(listMemberFolders(gone), []);
  assert.deepEqual(listMembers(gone).map(m => m.name), ['Diagram']);
  assert.doesNotMatch(gone, /<Folder |Name="Start"|Name="Speed"|Name="Reset"|FB_Motor\.Start/);
  assert.match(decode(gone), /^FUNCTION_BLOCK FB_Motor/);
  assert.equal(encode(gone, decode(gone)), gone);
});
