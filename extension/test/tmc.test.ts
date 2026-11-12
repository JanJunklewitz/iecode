import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decodeTmc, findEnum, NotTmcError, parseTmc, sharedValues } from '../src/core/tmc';
import { fromTmc } from '../src/core/adsinterface';

const fixture = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'tmc', 'Machine.tmc'), 'utf8');
const tmc = parseTmc(fixture);
const type = (name: string) => tmc.types.find(t => t.name === name)!;
const index = (name: string) => tmc.types.findIndex(t => t.name === name);

test('module: identity, tasks, interfaces, licenses, parameters, properties', () => {
  assert.equal(tmc.vendor, 'IECode Samples');
  const [m] = tmc.modules;
  assert.deepEqual([m.name, m.group, m.classFactory, m.initSequence], ['PLC1', 'PLC', 'TcPlc30', 'PSO']);
  assert.deepEqual(m.contexts, [{ id: 0, name: 'PlcTask', priority: 20, cycleTimeNs: 10000000 }]);
  assert.deepEqual(m.interfaces, ['ITComObject']);
  assert.equal(m.licenses.length, 1);
  assert.deepEqual(m.parameters.map(p => [p.name, p.type, p.bitSize, p.ptcid, p.readOnly]), [['AdsPort', 'UINT', 16, '#x03002500', true]]);
  assert.deepEqual(m.properties, [{ name: 'ApplicationName', value: 'Port_851' }]);
});

test('data areas and symbols: type text, offsets, comments, defaults', () => {
  const [inputs, internal] = tmc.modules[0].areas;
  assert.deepEqual([inputs.name, inputs.no, inputs.areaType, inputs.contextId, inputs.byteSize], ['PlcTask Inputs', 0, 'InputDst', 0, 1]);
  assert.deepEqual([inputs.symbols[0].comment, inputs.symbols[0].bitOffs], ['Start & go', 3]);
  const [motor, values] = internal.symbols;
  assert.equal(motor.ref, index('FB_Motor'));
  assert.equal(motor.default, '{ .bEnable := true, .eMode := Run }');
  assert.equal(values.type, 'ARRAY [0..9] OF INT');
  assert.equal(values.ref, undefined, 'elementary types are not defined in the file');
});

test('references: by GUID, or by name for a namespace the definition does not have', () => {
  assert.equal(tmc.modules[0].areas[1].symbols[2].ref, index('T_Speed'));
  assert.equal(type('FB_Motor').extendsRef, index('FB_Base'));
  assert.equal(type('T_Motors').baseRef, index('FB_Motor'));
});

test('data types: kinds, members, enum values, methods', () => {
  assert.deepEqual(tmc.types.map(t => t.kind), ['struct', 'struct', 'enum', 'alias', 'array']);
  const m = type('FB_Motor');
  assert.equal(m.namespace, 'Machine');
  assert.deepEqual(m.members.map(x => x.name), ['bEnable', 'eMode', 'pNext', 'fSpeed']);
  assert.equal(m.members[0].default, '1');
  assert.deepEqual(m.members[0].properties, [{ name: 'TcInitSymbol', value: undefined }]);
  assert.equal(m.members[2].type, 'POINTER TO FB_Motor');
  assert.deepEqual(m.methods, ['Start(fRamp : LREAL) : BOOL']);
  assert.equal(type('FB_Base').members[0].comment, 'State & mode');
  assert.deepEqual(type('E_Mode').enumValues, [{ text: 'Off', value: '0', comment: undefined }, { text: 'Run', value: '1', comment: 'Normal operation' }]);
});

test('same symbols as the ADS interface', () => {
  const names = tmc.modules.flatMap(m => m.areas.flatMap(a => a.symbols.map(s => s.name))).sort();
  assert.deepEqual(names, fromTmc(fixture).map(s => s.name).sort());
});

test('files without modules or data types are valid', () => {
  assert.deepEqual(parseTmc('<TcModuleClass/>'), { vendor: undefined, modules: [], types: [] });
});

test('other XML and truncated files are rejected', () => {
  assert.throws(() => parseTmc('<?xml version="1.0"?><Project/>'), NotTmcError);
  assert.throws(() => parseTmc(''), NotTmcError);
  assert.throws(() => parseTmc(fixture.slice(0, fixture.length / 2)), /Unclosed|Unterminated/);
});

test('BOMs and UTF-16', () => {
  const xml = '<TcModuleClass><Vendor><Name>Müller</Name></Vendor></TcModuleClass>';
  assert.equal(parseTmc(decodeTmc(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(xml)]))).vendor, 'Müller');
  assert.equal(parseTmc(decodeTmc(new Uint8Array([0xff, 0xfe, ...Buffer.from(xml, 'utf16le')]))).vendor, 'Müller');
});

test('findEnum lists members by name or qualified name', () => {
  const e = findEnum(tmc, 'E_Mode')!;
  assert.deepEqual(e.members.map(m => `${m.name}=${m.value}`), ['Off=0', 'Run=1']);
  assert.equal(e.members[1].comment, 'Normal operation');
  assert.equal(e.base, 'INT');
  assert.equal(findEnum(tmc, 'e_mode')?.name, 'E_Mode');
  assert.equal(findEnum(tmc, 'FB_Motor'), undefined);
  assert.equal(findEnum(tmc, 'T_Missing'), undefined);
});

test('sharedValues finds aliases and ignores unknown values', () => {
  assert.deepEqual(sharedValues({ name: 'E', members: [{ name: 'Off', value: '0' }, { name: 'Run', value: '1' }, { name: 'Start', value: '1' }] }), [{ value: '1', names: ['Run', 'Start'] }]);
  assert.deepEqual(sharedValues({ name: 'E', members: [{ name: 'A' }, { name: 'B' }] }), []);
});
