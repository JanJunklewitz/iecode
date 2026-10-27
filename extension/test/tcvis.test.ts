import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { applyEdits, crc32, flatten, parseVisu, propertyId, visuToText, VisuEditError } from '../src/core/tcvis';

const xml = readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', 'visu', 'VI_Demo.TcVIS'), 'utf8');
const RECT = 'aaaaaaaa-0000-0000-0000-000000000001';
const FIELD = 'aaaaaaaa-0000-0000-0000-000000000002';
const FRAME = 'aaaaaaaa-0000-0000-0000-000000000004';

test('member ids are the CRC-32 of the property path', () => {
  assert.equal(crc32('Columns'), 1668544811);
  assert.equal(propertyId('m_StaticPosition.iX'), 1649127785);
  assert.equal(propertyId('m_StaticColors.NormalColors.dwFillColor'), 2812299069);
});

test('parses size, interface and elements with nesting', () => {
  const v = parseVisu(xml);
  assert.equal(v.name, 'VI_Demo');
  assert.deepEqual([v.width, v.height], [640, 480]);
  assert.match(v.declaration, /fbMotor : FB_Motor;/);
  assert.deepEqual(v.elements.map(e => e.kind), ['Rectangle', 'Group', 'Frame']);
  assert.deepEqual(flatten(v.elements).map(e => e.identifier), ['GenElemInst_1', 'GenElemInst_3', 'GenElemInst_2', 'GenElemInst_4']);
});

test('reads position, texts, colors, variables, frames and input actions', () => {
  const all = flatten(parseVisu(xml).elements);
  const rect = all.find(e => e.guid === RECT)!;
  assert.deepEqual(rect.rect, { x: 10, y: 20, w: 200, h: 100, angle: 0 });
  assert.equal(rect.text, 'Motor & pump');
  assert.deepEqual(rect.fill, { rgb: '#ff0000' });
  assert.deepEqual(rect.frame, { rgb: '#000000', style: 'BasicElement-Frame-Color' });
  assert.equal(rect.lineWidth, 2);

  const field = all.find(e => e.guid === FIELD)!;
  assert.equal(field.textVar, 'fbMotor.rSpeed');
  assert.equal(field.align.h, 'LEFT');
  assert.equal(field.actions.length, 1);
  assert.equal(field.actions[0].event, 'OnMouseClick');
  assert.equal(field.actions[0].kind, 'Write variable');
  assert.equal(field.actions[0].fields.find(f => f.name === 'InputBoxVariable')?.value, 'fbMotor.rSetSpeed');

  const frame = all.find(e => e.guid === FRAME)!;
  assert.deepEqual(frame.refs, ['VI_Motor']);
  assert.deepEqual(frame.params.map(p => [p.label, p.value]), [['VI_Motor.fbMotor', 'MAIN.fbMotor1']]);
});

test('text summary is stable YAML-like text', () => {
  const t = visuToText(parseVisu(xml));
  assert.match(t, /^name: VI_Demo$/m);
  assert.match(t, /^ {2}- Rectangle: Rectangle\n {4}id: GenElemInst_1\n {4}at: \[10, 20\]\n {4}size: \[200, 100\]\n {4}text: "Motor & pump"$/m);
  assert.match(t, /^ {8}textVariable: fbMotor\.rSpeed$/m);
  assert.match(t, /^ {10}- OnMouseClick: "Write variable"\n {12}InputBoxVariable: fbMotor\.rSetSpeed$/m);
  assert.match(t, /^ {6}VI_Motor\.fbMotor: MAIN\.fbMotor1$/m);
  assert.ok(!t.includes(' \n'), 'no trailing blanks');
});

test('edits splice single values and keep everything else byte-identical', () => {
  const x = propertyId('m_StaticPosition.iX');
  const out = applyEdits(xml, [
    { element: RECT, member: x, value: '42' },
    { element: RECT, member: propertyId('m_StaticTexts.pstText'), value: 'A <b> & c' },
    { element: RECT, member: propertyId('m_StaticColors.NormalColors.dwFillColor'), value: '#00ff00' },
    { element: FIELD, action: 0, field: 'InputBoxVariable', value: 'fbMotor.rNewSpeed' },
    { element: FRAME, member: crc32('demo-param'), value: 'MAIN.fbMotor2' },
  ]);
  assert.ok(out.startsWith('﻿'), 'BOM kept');
  assert.ok(!/[^\r]\n/.test(out), 'CRLF kept');
  assert.ok(out.includes(`<v n="Id">${x}L</v>\r\n                      <v n="Value">42</v>`));
  assert.ok(out.includes('"A &lt;b&gt; &amp; c"'));
  assert.ok(out.includes('<v n="Value">4278255360U</v>'), 'alpha byte of the old color kept');
  const all = flatten(parseVisu(out).elements);
  assert.equal(all.find(e => e.guid === RECT)!.rect.x, 42);
  assert.equal(all.find(e => e.guid === RECT)!.text, 'A <b> & c');
  assert.equal(all.find(e => e.guid === FIELD)!.actions[0].fields[0].value, 'fbMotor.rNewSpeed');
  assert.equal(all.find(e => e.guid === FRAME)!.params[0].value, 'MAIN.fbMotor2');
  // the group's child kept its position, the other element its id
  assert.equal(all.find(e => e.guid === FIELD)!.rect.x, 5);
  const undo = applyEdits(out, [
    { element: RECT, member: x, value: '10' },
    { element: RECT, member: propertyId('m_StaticTexts.pstText'), value: 'Motor & pump' },
    { element: RECT, member: propertyId('m_StaticColors.NormalColors.dwFillColor'), value: '#ff0000' },
    { element: FIELD, action: 0, field: 'InputBoxVariable', value: 'fbMotor.rSetSpeed' },
    { element: FRAME, member: crc32('demo-param'), value: 'MAIN.fbMotor1' },
  ]);
  assert.equal(undo, xml);
});

test('refuses edits it cannot write faithfully', () => {
  assert.throws(() => applyEdits(xml, [{ element: RECT, member: propertyId('m_StaticColors.NormalColors.dwFrameColor'), value: '#ffffff' }]), VisuEditError);
  assert.throws(() => applyEdits(xml, [{ element: RECT, member: propertyId('m_StaticTexts.pstText'), value: 'say "hi"' }]), VisuEditError);
  assert.throws(() => applyEdits(xml, [{ element: RECT, member: propertyId('m_StaticPosition.iX'), value: '1.5' }]), VisuEditError);
  assert.throws(() => applyEdits(xml, [{ element: RECT, member: propertyId('m_pTextChanges..pVarText'), value: 'x' }]), VisuEditError);
  assert.throws(() => applyEdits(xml, [{ element: 'ffffffff-0000-0000-0000-000000000000', member: 1, value: 'x' }]), VisuEditError);
});

// Real projects: IECODE_TCVIS_SAMPLES=<folder> npm test parses every .TcVIS below that folder
// and checks that a no-op edit round-trips byte-identical.
const samples = process.env.IECODE_TCVIS_SAMPLES;
test('parses real visualizations', { skip: !samples && 'set IECODE_TCVIS_SAMPLES' }, () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.TcVIS$/i.test(f)) files.push(p);
    }
  };
  for (const d of samples!.split(/[;:]/).filter(Boolean)) walk(d);
  assert.ok(files.length, 'no .TcVIS found');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const v = parseVisu(text);
    visuToText(v, { all: true });
    const e = flatten(v.elements).find(x => x.members.some(m => m.path === 'm_StaticPosition.iY'));
    if (e) assert.equal(applyEdits(text, [{ element: e.guid, member: propertyId('m_StaticPosition.iY'), value: String(e.rect.y) }]), text, f);
  }
});
