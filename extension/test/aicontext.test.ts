import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decode } from '../src/model';
import { parseVisu } from '../src/core/tcvis';
import { aiPrompt, stAiContext, visuAiContext } from '../src/core/aicontext';

const root = join(__dirname, '..', '..', 'test', 'fixtures');
const st = decode(readFileSync(join(root, 'ws/apps/MachineX/MachineX/PLC1/POUs/Motion/FB_Motor.TcPOU'), 'utf8').replace(/^﻿/, ''));
const lines = st.split('\n');
const FILE = 'PLC1/POUs/Motion/FB_Motor.TcPOU';

test('ST selection is named by the section it starts in', () => {
  const at = (s: string) => lines.findIndex(l => l.startsWith(s));
  const c = stAiContext(st, at('fSetSpeed := fSpeed;'), at('Start := TRUE;'), FILE);
  assert.equal(c.what, 'METHOD FB_Motor.Start');
  assert.equal(c.code, 'fSetSpeed := fSpeed;\nbEnable := TRUE;\nStart := TRUE;');
  assert.equal(stAiContext(st, at('IF bEnable'), at('IF bEnable'), FILE).what, 'FB_Motor');
  assert.equal(stAiContext(st, at('Speed := _fSpeed;'), at('Speed := _fSpeed;'), FILE).what, 'GET FB_Motor.Speed');
});

test('empty selection takes the whole section', () => {
  const c = stAiContext(st, lines.indexOf('bEnable := TRUE;'), lines.indexOf('bEnable := TRUE;'), FILE, true);
  assert.ok(c.code.startsWith('//==== METHOD Start ====\nMETHOD PUBLIC Start : BOOL'));
  assert.ok(c.code.endsWith('Start := TRUE;'));
  const main = stAiContext(st, 0, 0, FILE, true);
  assert.ok(main.code.startsWith('FUNCTION_BLOCK FB_Motor') && main.code.endsWith('END_IF'));
});

test('prompt: comment, origin, code in a fence', () => {
  const c = { what: 'METHOD FB_Motor.Start', file: FILE, lang: 'st', code: 'Start := TRUE;\n' };
  assert.equal(aiPrompt(c, ' Why is this always TRUE? '),
    'Why is this always TRUE?\n\nMETHOD FB_Motor.Start in `PLC1/POUs/Motion/FB_Motor.TcPOU`:\n```st\nStart := TRUE;\n```\n');
  assert.ok(aiPrompt(c).startsWith('METHOD FB_Motor.Start in'));
  assert.ok(aiPrompt({ ...c, code: 'a ``` b' }).includes('````st\n'), 'fence longer than any inside');
});

test('visualization element context', () => {
  const v = parseVisu(readFileSync(join(root, 'visu', 'VI_Demo.TcVIS'), 'utf8'));
  const c = visuAiContext(v, 'Visus/VI_Demo.TcVIS', 'aaaaaaaa-0000-0000-0000-000000000001')!;
  assert.equal(c.what, 'Rectangle Rectangle (GenElemInst_1) of visualization VI_Demo');
  assert.match(c.code, /^- Rectangle: Rectangle\n {2}id: GenElemInst_1/);
  assert.equal(visuAiContext(v, 'x', 'nope'), undefined);
  assert.match(visuAiContext(v, 'x')!.code, /^# Visualization VI_Demo/);
});
