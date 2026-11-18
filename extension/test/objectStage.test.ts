import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSections, discardSection, hasMixedEol, sectionRanges, stageSection } from '../src/core/objectStage';
import { decode, sectionsOfXml } from '../src/model';
import { ViewError } from '../src/model';

interface M { name: string; id: number; body?: string; cfc?: string }
interface P { type: string; get?: string; set?: string }
const guid = (n: number) => `{00000000-0000-0000-0000-${String(n).padStart(12, '0')}}`;

/** A .TcPOU: main declaration and implementation, methods, optional property Speed, LineIds for everything. */
function pou(o: { decl?: string; impl?: string; methods?: M[]; prop?: P; eol?: string; bom?: boolean; lineIds?: string }) {
  const L = ['<?xml version="1.0" encoding="utf-8"?>', '<TcPlcObject Version="1.1.0.1">', `  <POU Name="FB_A" Id="${guid(1)}">`,
    `    <Declaration><![CDATA[${o.decl ?? 'FUNCTION_BLOCK FB_A'}]]></Declaration>`, '    <Implementation>', `      <ST><![CDATA[${o.impl ?? 'main;'}]]></ST>`, '    </Implementation>'];
  const ids = [`  <LineIds Name="FB_A">`, '    <LineId Id="1" Count="0" />', '  </LineIds>'];
  for (const m of o.methods ?? []) {
    L.push(`    <Method Name="${m.name}" Id="${guid(m.id)}">`, `      <Declaration><![CDATA[METHOD ${m.name}]]></Declaration>`, '      <Implementation>',
      m.cfc ? `        <CFC><XmlArchive>${m.cfc}</XmlArchive></CFC>` : `        <ST><![CDATA[${m.body ?? ''}]]></ST>`, '      </Implementation>', '    </Method>');
    ids.push(`  <LineIds Name="FB_A.${m.name}">`, '    <LineId Id="2" Count="0" />', '  </LineIds>');
  }
  if (o.prop) {
    L.push(`    <Property Name="Speed" Id="${guid(90)}">`, `      <Declaration><![CDATA[PROPERTY Speed : ${o.prop.type}]]></Declaration>`);
    ids.push('  <LineIds Name="FB_A.Speed">', '    <LineId Id="3" Count="0" />', '  </LineIds>');
    for (const [tag, body] of [['Get', o.prop.get], ['Set', o.prop.set]] as const) {
      if (body === undefined) continue;
      L.push(`      <${tag} Name="${tag}" Id="${guid(tag === 'Get' ? 91 : 92)}">`, '        <Implementation>', `          <ST><![CDATA[${body}]]></ST>`, '        </Implementation>', `      </${tag}>`);
      ids.push(`  <LineIds Name="FB_A.Speed.${tag}">`, '    <LineId Id="4" Count="0" />', '  </LineIds>');
    }
    L.push('    </Property>');
  }
  L.push(...ids.map(l => '  ' + l.trimStart() === l.trimStart() ? l : l), '  </POU>', '</TcPlcObject>', '');
  const eol = o.eol ?? '\n';
  return (o.bom ? '﻿' : '') + L.join(eol);
}

const keys = (xml: string) => sectionsOfXml(xml.replace(/^﻿/, '')).map(s => s.key);
const idOf = (xml: string, key: string) => sectionsOfXml(xml.replace(/^﻿/, '')).find(s => s.key === key)!.node.attrs.Id;
const view = (xml: string) => decode(xml.replace(/^﻿/, ''));

const A = (b: string) => ({ name: 'A', id: 2, body: b }), B = (b: string) => ({ name: 'B', id: 3, body: b });

test('changedSections lists exactly the sections whose text differs, with their state, and ignores LineIds', () => {
  const base = pou({ decl: 'D1', methods: [A('a1'), B('b1')], prop: { type: 'INT', get: 'g1' } });
  const work = pou({ decl: 'D1', methods: [A('a2'), { name: 'Stop', id: 7, body: 's' }], prop: { type: 'INT', get: 'g1' } })
    .replace('<LineId Id="2" Count="0" />', '<LineId Id="99" Count="0" />');
  const got = changedSections(base, work).map(c => `${c.key}:${c.state}`).sort();
  assert.deepEqual(got, ['METHOD:A:changed', 'METHOD:B:removed', 'METHOD:Stop:added']);
  assert.deepEqual(changedSections(base, base), []);
});

test('stageSection takes one changed method and leaves the others as in base', () => {
  const base = pou({ methods: [A('a1'), B('b1')] });
  const work = pou({ methods: [A('a2'), B('b2')] });
  const out = stageSection(base, work, 'METHOD:A');
  assert.equal(view(out), view(base).replace('a1', 'a2'));
  assert.ok(out.includes('b1') && !out.includes('b2'));
});

/** The XML minus the section's unit ranges and LineIds, for the byte comparison. */
function without(xml: string, key: string) {
  const r = sectionRanges(xml.replace(/^﻿/, '')).get(key);
  const body = xml.replace(/^﻿/, '');
  const cuts = [...(r?.units ?? []), ...(r?.lineIds ?? [])].sort((a, b) => b.start - a.start);
  let out = body;
  for (const c of cuts) out = out.slice(0, c.start) + out.slice(c.end);
  return out;
}

test('bytes outside the section are identical (LF, CRLF, BOM)', () => {
  for (const o of [{}, { eol: '\r\n' }, { eol: '\r\n', bom: true }]) {
    const base = pou({ ...o, methods: [A('a1'), B('b1')] });
    const work = pou({ ...o, methods: [A('a2'), B('b2')] });
    const out = stageSection(base, work, 'METHOD:A');
    assert.equal(without(out, 'METHOD:A'), without(base, 'METHOD:A'));
    assert.equal(out.charCodeAt(0) === 0xfeff, !!o.bom);
  }
});

test('an added method keeps its Id, is placed after its predecessor and appears once', () => {
  const base = pou({ methods: [A('a1'), B('b1')] });
  const work = pou({ methods: [A('a1'), { name: 'Stop', id: 7, body: 's' }, B('b1')] });
  const out = stageSection(base, work, 'METHOD:Stop');
  assert.equal(idOf(out, 'METHOD:Stop'), guid(7));
  assert.deepEqual(keys(out), ['MAIN', 'METHOD:A', 'METHOD:Stop', 'METHOD:B']);
  assert.equal(out.split('Stop"').length - 1, 2, 'element and its LineIds entry');
  assert.deepEqual(changedSections(out, work), []);
});

test('stageSection removes a deleted member and its LineIds', () => {
  const base = pou({ methods: [A('a1'), B('b1')] });
  const work = pou({ methods: [A('a1')] });
  const out = stageSection(base, work, 'METHOD:B');
  assert.equal(out, work);
});

test('stageSection on the main declaration keeps the method change unstaged', () => {
  const base = pou({ decl: 'D1', methods: [A('a1')] });
  const work = pou({ decl: 'D2', impl: 'main2;', methods: [A('a2')] });
  const out = stageSection(base, work, 'MAIN');
  assert.ok(out.includes('D2') && out.includes('main2;'));
  assert.ok(out.includes('a1') && !out.includes('a2'));
});

test('a new property is staged with its GET and SET', () => {
  const base = pou({ methods: [A('a1')] });
  const work = pou({ methods: [A('a1')], prop: { type: 'INT', get: 'g;', set: 's;' } });
  assert.deepEqual(changedSections(base, work).map(c => c.key), ['PROPERTY:Speed']);
  const out = stageSection(base, work, 'PROPERTY:Speed');
  assert.equal(out, work);
});

test('changing the property type and the GET body: the two stage independently', () => {
  const base = pou({ prop: { type: 'INT', get: 'g1' } });
  const work = pou({ prop: { type: 'REAL', get: 'g2' } });
  assert.deepEqual(changedSections(base, work).map(c => c.key).sort(), ['GET:Speed', 'PROPERTY:Speed']);
  const type = stageSection(base, work, 'PROPERTY:Speed');
  assert.ok(type.includes('REAL') && type.includes('g1') && !type.includes('g2'));
  const get = stageSection(base, work, 'GET:Speed');
  assert.ok(get.includes('INT') && get.includes('g2'));
});

test('a GET added to an existing property lands inside the property element', () => {
  const base = pou({ prop: { type: 'INT', set: 's;' } });
  const work = pou({ prop: { type: 'INT', get: 'g;', set: 's;' } });
  const out = stageSection(base, work, 'GET:Speed');
  const props = out.slice(out.indexOf('<Property'), out.indexOf('</Property>'));
  assert.ok(props.includes('Name="Get"'));
  assert.deepEqual(keys(out).filter(k => k.includes('Speed')).sort(), ['GET:Speed', 'PROPERTY:Speed', 'SET:Speed']);
});

test('a removed property takes the LineIds of both accessors', () => {
  const base = pou({ prop: { type: 'INT', get: 'g;', set: 's;' } });
  const work = pou({});
  const out = stageSection(base, work, 'PROPERTY:Speed');
  assert.equal(out, work);
  assert.ok(!out.includes('Speed'));
});

test('MAIN carries its own LineIds entry along', () => {
  const base = pou({});
  const work = pou({ impl: 'main2;' }).replace('<LineId Id="1" Count="0" />', '<LineId Id="55" Count="0" />');
  const out = stageSection(base, work, 'MAIN');
  assert.ok(out.includes('Id="55"'));
});

test('a target with mixed line endings is refused', () => {
  const base = pou({ methods: [A('a1')], eol: '\r\n' }).replace('<TcPlcObject Version="1.1.0.1">\r\n', '<TcPlcObject Version="1.1.0.1">\n');
  assert.equal(hasMixedEol(base), true);
  assert.throws(() => stageSection(base, pou({ methods: [A('a2')] }), 'METHOD:A'), ViewError);
});

test('a changed non-ST body is a change of its section and is staged byte for byte', () => {
  const base = pou({ methods: [{ name: 'C', id: 2, cfc: 'one' }] });
  const work = pou({ methods: [{ name: 'C', id: 2, cfc: 'two' }] });
  assert.deepEqual(changedSections(base, work), [{ key: 'METHOD:C', state: 'changed' }]);
  assert.equal(stageSection(base, work, 'METHOD:C'), work);
});

test('discardSection restores one section in the work copy and keeps the other edits', () => {
  const base = pou({ methods: [A('a1'), B('b1')] });
  const work = pou({ methods: [A('a2'), B('b2')] });
  const out = discardSection(base, work, 'METHOD:A');
  assert.ok(out.includes('a1') && out.includes('b2') && !out.includes('a2'));
});

test('line endings follow the target', () => {
  const base = pou({ methods: [A('a1\nx')] });
  const work = pou({ methods: [A('a2\r\nx')], eol: '\r\n' });
  const out = stageSection(base, work, 'METHOD:A');
  assert.ok(!out.includes('\r'));
  assert.ok(out.includes('a2\nx'));
});

test('a key in neither side throws', () => {
  const x = pou({});
  assert.throws(() => stageSection(x, x, 'METHOD:Nope'), ViewError);
});
