import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decode } from '../src/model';
import { mapToView, memberOf } from '../src/core/diagnostics';
import { setLibraryVersion, compareVersions } from '../src/core/references';

const plc1 = join(__dirname, '..', '..', 'test', 'fixtures', 'ws', 'apps/MachineX/MachineX/PLC1');
const view = decode(readFileSync(join(plc1, 'POUs/Motion/FB_Motor.TcPOU'), 'utf8').replace(/^﻿/, ''));
const lines = view.split('\n');

test('finds the member a message refers to', () => {
  assert.deepEqual(memberOf("Unknown type 'fSped' (FB_Motor.Start)", 'FB_Motor'), { member: 'Start', accessor: undefined });
  assert.deepEqual(memberOf('FB_Motor.Speed.Get: missing return', 'FB_Motor'), { member: 'Speed', accessor: 'GET' });
  assert.deepEqual(memberOf('somewhere else', 'FB_Motor'), {});
});

test('maps a method error to its implementation line in the view', () => {
  const p = mapToView(view, 'FB_Motor', { severity: 'error', message: "Unknown type (FB_Motor.Start)", line: 2, column: 5 });
  assert.equal(lines[p.line], 'bEnable := TRUE;');
  assert.equal(p.column, 4);
  assert.equal(p.section, 'METHOD Start');
});

test('maps a main body error and a property accessor error', () => {
  const main = mapToView(view, 'FB_Motor', { severity: 'error', message: 'x', line: 1 });
  assert.equal(lines[main.line], 'IF bEnable THEN');
  const get = mapToView(view, 'FB_Motor', { severity: 'warning', message: 'FB_Motor.Speed.Get', line: 1 });
  assert.equal(lines[get.line], 'Speed := _fSpeed;');
});

test('without a line the diagnostic goes to the section header; lines are clamped to the section', () => {
  const p = mapToView(view, 'FB_Motor', { severity: 'error', message: 'FB_Motor.Reset' });
  assert.equal(lines[p.line], '//==== ACTION Reset ====');
  const far = mapToView(view, 'FB_Motor', { severity: 'error', message: 'FB_Motor.Start', line: 99 });
  assert.ok(lines[far.line + 1].startsWith('//===='));
});

test('sets library versions in plcproj text', () => {
  const text = readFileSync(join(plc1, 'PLC1.plcproj'), 'utf8');
  const r = setLibraryVersion(text, 'tc3_motorlib', '1.3.0');
  assert.deepEqual(r.changes, [{ library: 'Tc3_MotorLib', vendor: 'Example Machines Ltd', from: '1.2.0', to: '1.3.0' }]);
  assert.equal(r.text, text.replace('Tc3_MotorLib, 1.2.0', 'Tc3_MotorLib, 1.3.0'));
  assert.equal(setLibraryVersion(text, 'Tc3_MotorLib', '1.2.0').changes.length, 0);
  assert.throws(() => setLibraryVersion(text, 'x', 'latest'));
});

test('compares versions numerically', () => {
  assert.ok(compareVersions('3.3.10.0', '3.3.9.0') > 0);
  assert.ok(compareVersions('1.2', '1.2.0') === 0);
  assert.ok(compareVersions('*', '9.9') > 0);
});
