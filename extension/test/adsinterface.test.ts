import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { diffInterfaces, diffSymbols, fromBuild, fromSource, fromSourceAt, fromTmc, symbolsToCsv, toSnapshot } from '../src/core/adsinterface';
import { loadPlcProject } from '../src/core/projects';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'ws');

const TMC = (main = '', motor = '') => `<?xml version="1.0"?>
<TcModuleClass>
  <DataTypes>
    <DataType><Name>FB_Base</Name><BitSize>64</BitSize>
      <SubItem><Name>nState</Name><Type>INT</Type><BitSize>16</BitSize></SubItem>
    </DataType>
    <DataType><Name GUID="{1}">FB_Motor</Name><BitSize>192</BitSize><ExtendsType>FB_Base</ExtendsType>
      <SubItem><Name>bEnable</Name><Type>BOOL</Type><Comment><![CDATA[ Enable the drive ]]></Comment><BitSize>8</BitSize></SubItem>
      <SubItem><Name>stStatus</Name><Type>ST_Status</Type><BitSize>64</BitSize></SubItem>
      <SubItem><Name>pNext</Name><Type PointerTo="1">FB_Motor</Type><BitSize>64</BitSize></SubItem>
      ${motor}
    </DataType>
    <DataType><Name>ST_Status</Name><BitSize>64</BitSize>
      <SubItem><Name>fSpeed</Name><Type>REAL</Type><BitSize>32</BitSize></SubItem>
    </DataType>
    <DataType><Name Namespace="Tc2_Standard">TON</Name><BitSize>256</BitSize>
      <SubItem><Name>Q</Name><Type>BOOL</Type><BitSize>8</BitSize></SubItem>
    </DataType>
  </DataTypes>
  <Modules><Module><Name>PLC1</Name><DataAreas>
    <DataArea><Name>PlcTask Inputs</Name>
      <Symbol><Name>MAIN.bStart</Name><Comment>Start &amp; go</Comment><BitSize>1</BitSize><BaseType>BIT</BaseType></Symbol>
    </DataArea>
    <DataArea><Name>PlcTask Internal</Name>
      <Symbol><Name>MAIN.fbMotor</Name><BitSize>192</BitSize><BaseType>FB_Motor</BaseType></Symbol>
      <Symbol><Name>MAIN.tDelay</Name><BitSize>256</BitSize><BaseType Namespace="Tc2_Standard">TON</BaseType></Symbol>
      <Symbol><Name>GVL.aValues</Name><BitSize>160</BitSize><BaseType>INT</BaseType><ArrayInfo><LBound>0</LBound><Elements>10</Elements></ArrayInfo></Symbol>
      <Symbol><Name>TwinCAT_SystemInfoVarList._AppInfo</Name><BitSize>64</BitSize><BaseType>PlcAppSystemInfo</BaseType></Symbol>
      ${main}
    </DataArea>
  </DataAreas></Module></Modules>
</TcModuleClass>`;

test('ADS interface: top-level symbols from the build output (.tmc)', () => {
  const s = fromTmc(TMC());
  assert.deepEqual(s.map(x => x.name), ['GVL.aValues', 'MAIN.bStart', 'MAIN.fbMotor', 'MAIN.tDelay', 'TwinCAT_SystemInfoVarList._AppInfo']);
  assert.deepEqual(s[1], { name: 'MAIN.bStart', type: 'BIT', bitSize: 1, comment: 'Start & go', area: 'PlcTask Inputs' });
  assert.equal(s[0].type, 'ARRAY [0..9] OF INT');
});

test('ADS interface: members expanded with EXTENDS and library types, not pointers', () => {
  const s = fromTmc(TMC(), true);
  assert.deepEqual(s.filter(x => x.name.startsWith('MAIN.')).map(x => x.name), [
    'MAIN.bStart', 'MAIN.fbMotor', 'MAIN.fbMotor.bEnable', 'MAIN.fbMotor.nState', 'MAIN.fbMotor.pNext',
    'MAIN.fbMotor.stStatus', 'MAIN.fbMotor.stStatus.fSpeed', 'MAIN.tDelay', 'MAIN.tDelay.Q',
  ]);
  assert.equal(s.find(x => x.name === 'MAIN.fbMotor.pNext')!.type, 'POINTER TO FB_Motor');
  assert.equal(s.find(x => x.name === 'MAIN.fbMotor.bEnable')!.comment, 'Enable the drive');
});

test('ADS interface: diff of two builds, case-insensitive names', () => {
  const before = fromTmc(TMC('<Symbol><Name>MAIN.nCount</Name><BitSize>16</BitSize><BaseType>INT</BaseType></Symbol><Symbol><Name>MAIN.bOld</Name><BitSize>8</BitSize><BaseType>BOOL</BaseType></Symbol>'), true);
  const after = fromTmc(TMC('<Symbol><Name>main.nCount</Name><BitSize>32</BitSize><BaseType>DINT</BaseType></Symbol>', '<SubItem><Name>bReset</Name><Type>BOOL</Type><BitSize>8</BitSize></SubItem>'), true);
  const changes = diffSymbols(before, after);
  assert.deepEqual(changes.map(c => `${c.kind} ${c.name}`), ['removed MAIN.bOld', 'added MAIN.fbMotor.bReset', 'changed main.nCount']);
  assert.equal(changes[2].details, 'INT → DINT, 2 B → 4 B');
  assert.deepEqual(diffSymbols(before, before), []);
});

const GVL = `{attribute 'qualified_only'}
VAR_GLOBAL
    nCount : INT; // parts produced
    {attribute 'hide'}
    nSecret : INT;
    aValues : ARRAY[0..9] OF INT;
END_VAR
VAR_GLOBAL CONSTANT
    MAX_AXES : INT := 4;
END_VAR
`;
const MAIN = `PROGRAM MAIN
VAR_INPUT
    bStart AT %I* : BOOL;
END_VAR
VAR
    // the conveyor drive
    fbMotor : FB_Motor;
    tDelay : TON;
    pMotor : POINTER TO FB_Motor;
END_VAR
VAR_TEMP
    i : INT;
END_VAR
//---- IMPLEMENTATION ----
fbMotor();
`;
const FB_BASE = `FUNCTION_BLOCK FB_Base
VAR
    nState : INT;
END_VAR
VAR_STAT
    nInstances : INT;
END_VAR
//---- IMPLEMENTATION ----
`;
const FB_MOTOR = `FUNCTION_BLOCK FB_Motor EXTENDS FB_Base
VAR_INPUT
    bEnable : BOOL; (* Enable the drive *)
END_VAR
VAR
    stStatus : ST_Status;
    pNext : POINTER TO FB_Motor;
END_VAR
//---- IMPLEMENTATION ----
//==== METHOD Start ====
METHOD Start : BOOL
VAR_INPUT
    fSpeed : REAL;
END_VAR
//---- IMPLEMENTATION ----
`;
const ST_STATUS = `TYPE ST_Status :
STRUCT
    fSpeed : REAL;
END_STRUCT
END_TYPE
`;
const sources = [
  { file: 'GVL.TcGVL', view: GVL }, { file: 'MAIN.TcPOU', view: MAIN }, { file: 'FB_Base.TcPOU', view: FB_BASE },
  { file: 'FB_Motor.TcPOU', view: FB_MOTOR }, { file: 'ST_Status.TcDUT', view: ST_STATUS },
];

test('ADS interface from source: GVL and program variables, no constants, temporaries or hidden ones', () => {
  const r = fromSource(sources);
  assert.deepEqual(r.symbols.map(s => `${s.name}:${s.type}`), [
    'GVL.aValues:ARRAY[0..9] OF INT', 'GVL.nCount:INT', 'MAIN.bStart:BOOL', 'MAIN.fbMotor:FB_Motor', 'MAIN.pMotor:POINTER TO FB_Motor', 'MAIN.tDelay:TON',
  ]);
  assert.deepEqual(r.roots!.sort(), ['GVL', 'MAIN']);
  const byName = Object.fromEntries(r.symbols.map(s => [s.name, s]));
  assert.equal(byName['GVL.nCount'].comment, 'parts produced');
  assert.equal(byName['MAIN.fbMotor'].comment, 'the conveyor drive');
  assert.equal(byName['MAIN.bStart'].area, 'Inputs');
  assert.equal(byName['GVL.nCount'].area, 'VAR_GLOBAL');
});

test('ADS interface from source: members of the project types, statics and methods left out', () => {
  const names = fromSource(sources, true).symbols.map(s => s.name).filter(n => n.startsWith('MAIN.fbMotor'));
  assert.deepEqual(names, ['MAIN.fbMotor', 'MAIN.fbMotor.bEnable', 'MAIN.fbMotor.nState', 'MAIN.fbMotor.pNext', 'MAIN.fbMotor.stStatus', 'MAIN.fbMotor.stStatus.fSpeed']);
  assert.equal(fromSource(sources, true).symbols.find(s => s.name === 'MAIN.fbMotor.bEnable')!.comment, 'Enable the drive');
});

test('ADS interface: build output compared with source only covers what the source knows', () => {
  const build = { origin: 'build' as const, symbols: fromTmc(TMC(), true) };
  const source = fromSource(sources, true);
  // the system symbols and the library FB's members (MAIN.tDelay.Q) are not reported; pMotor is new in the source
  // ARRAY [0..9] OF INT (build) and ARRAY[0..9] OF INT (source) are the same type
  const changes = diffInterfaces(build, source);
  assert.deepEqual(changes.map(c => `${c.kind} ${c.name}`), ['added GVL.nCount', 'changed MAIN.bStart', 'added MAIN.pMotor']);
  assert.equal(changes[1].details, 'BIT → BOOL');
  assert.deepEqual(diffInterfaces(source, build).map(c => c.kind), ['removed', 'changed', 'removed']);
});

test('ADS interface: fixture project from source, build output, stale check, CSV and snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-ads-'));
  try {
    cpSync(fixtures, dir, { recursive: true });
    const plc = await loadPlcProject(join(dir, 'apps/MachineX/MachineX/PLC1/PLC1.plcproj'));
    const src = await fromSourceAt(plc, undefined, true);
    assert.ok(src.symbols.some(s => s.name === 'MAIN.fbMotor'));
    await assert.rejects(fromBuild(plc), /Build it first/);

    const tmc = join(plc.dir, 'PLC1.tmc');
    writeFileSync(tmc, TMC());
    const past = new Date(Date.now() - 60_000), now = new Date();
    for (const f of [plc.file, ...plc.objects.map(o => o.file)]) utimesSync(f, past, past);
    utimesSync(tmc, now, now);
    const built = await fromBuild(plc);
    assert.equal(built.stale, false);
    assert.equal(built.symbols.length, 5);
    utimesSync(plc.objects[0].file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    assert.equal((await fromBuild(plc)).stale, true);

    assert.match(symbolsToCsv(built.symbols), /^Name;Type;BitSize;Area;Comment\nGVL\.aValues;ARRAY \[0\.\.9\] OF INT;160;PlcTask Internal;\n/);
    const snap = JSON.parse(toSnapshot('PLC1', built.symbols, false));
    assert.equal(snap.format, 'iecode-ads-interface/1');
    assert.equal(snap.symbols[1].bitSize, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
