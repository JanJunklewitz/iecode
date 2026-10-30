import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decode } from '../src/model';
import {
  addGlobalVersionEntry, globalVersionRel, newGlobalVersion, updateGlobalVersion, versionConstant, versionLine, versionParts,
} from '../src/core/globalVersion';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'ws');

test('constant name and four-part version as TwinCAT writes them', () => {
  assert.equal(versionConstant('Tc3_MotorLib'), 'stLibVersion_Tc3_MotorLib');
  assert.equal(versionConstant('Motor Lib (v2)'), 'stLibVersion_Motor_Lib__v2_');
  assert.deepEqual(versionParts('1.3'), [1, 3, 0, 0]);
  assert.throws(() => versionParts('1.x'));
  assert.equal(versionLine('Tc3_MotorLib', '1.3.0'),
    "stLibVersion_Tc3_MotorLib : ST_LibVersion := (iMajor := 1, iMinor := 3, iBuild := 0, iRevision := 0, nFlags := 0, sVersion := '1.3.0.0');");
});

test('new Global_Version is a GVL the ST view reads', () => {
  const xml = newGlobalVersion('Tc3_MotorLib', '1.3.0.2', '{00000000-0000-0000-0000-000000000001}');
  assert.ok(!xml.startsWith('﻿') && !/[^\r]\n/.test(xml), 'no BOM, CRLF');
  const st = decode(xml);
  assert.match(st, /^\{attribute 'TcGenerated'\}/);
  assert.match(st, /\tstLibVersion_Tc3_MotorLib : ST_LibVersion := \(iMajor := 1, iMinor := 3, iBuild := 0, iRevision := 2,/);
});

test('update replaces only the constant line, also a stale one', () => {
  const stale = newGlobalVersion('Old Name', '1.1.0', '{00000000-0000-0000-0000-000000000002}')
    .replace("sVersion := '1.1.0.0'", "sVersion := '1.0.4.0'");
  const out = updateGlobalVersion(stale, 'Tc3_MotorLib', '2.0.1');
  assert.equal(out, newGlobalVersion('Tc3_MotorLib', '2.0.1', '{00000000-0000-0000-0000-000000000002}'));
  assert.throws(() => updateGlobalVersion('<GVL><Declaration><![CDATA[VAR_GLOBAL END_VAR]]></Declaration></GVL>', 'X', '1.0'), /no stLibVersion_/);
});

test('.plcproj entry: found anywhere, added once with its folder', () => {
  const lib = readFileSync(join(fixtures, 'libs/Tc3_MotorLib/MotorLib/MotorLib/MotorLib.plcproj'), 'utf8');
  assert.equal(globalVersionRel(lib), undefined);
  const out = addGlobalVersionEntry(lib);
  assert.match(out, /<Compile Include="Version\\Global_Version\.TcGVL">\r\n\s*<SubType>Code<\/SubType>/);
  assert.match(out, /<Folder Include="Version" \/>/);
  assert.equal(globalVersionRel(out), 'Version/Global_Version.TcGVL');
  assert.equal(addGlobalVersionEntry(out), out, 'idempotent');
  assert.equal(globalVersionRel(out.replace('Version\\Global_Version', 'Info\\Global_Version')), 'Info/Global_Version.TcGVL');
});
