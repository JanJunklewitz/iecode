import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, sectionsOfXml } from '../src/model';
import { spansOf, xmlLineOfViewLine } from '../src/core/objectSpans';

const LF = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<TcPlcObject Version="1.1.0.1">',
  '  <POU Name="FB_A" Id="{00000000-0000-0000-0000-000000000001}">',
  '    <Declaration><![CDATA[FUNCTION_BLOCK FB_A',
  'VAR',
  '  x : INT;',
  'END_VAR]]></Declaration>',
  '    <Implementation>',
  '      <ST><![CDATA[x := 1;',
  'x := 2;]]></ST>',
  '    </Implementation>',
  '    <Method Name="Start" Id="{00000000-0000-0000-0000-000000000002}">',
  '      <Declaration><![CDATA[METHOD Start : BOOL',
  'VAR_INPUT',
  'END_VAR]]></Declaration>',
  '      <Implementation>',
  '        <ST><![CDATA[a;',
  'b;',
  'c;]]></ST>',
  '      </Implementation>',
  '    </Method>',
  '    <Method Name="Split" Id="{00000000-0000-0000-0000-000000000003}">',
  '      <Declaration><![CDATA[METHOD Split]]></Declaration>',
  '      <Implementation>',
  '        <ST><![CDATA[s := ',
  "'a]]]]><![CDATA[>b';",
  'after;]]></ST>',
  '      </Implementation>',
  '    </Method>',
  '    <Method Name="Empty" Id="{00000000-0000-0000-0000-000000000004}">',
  '      <Declaration><![CDATA[]]></Declaration>',
  '      <Implementation>',
  '        <ST><![CDATA[]]></ST>',
  '      </Implementation>',
  '    </Method>',
  '    <Property Name="Speed" Id="{00000000-0000-0000-0000-000000000005}">',
  '      <Declaration><![CDATA[PROPERTY Speed : INT]]></Declaration>',
  '      <Get Name="Get" Id="{00000000-0000-0000-0000-000000000006}">',
  '        <Declaration><![CDATA[VAR',
  'END_VAR]]></Declaration>',
  '        <Implementation>',
  '          <ST><![CDATA[Speed := x;]]></ST>',
  '        </Implementation>',
  '      </Get>',
  '    </Property>',
  '    <Action Name="Cfc" Id="{00000000-0000-0000-0000-000000000007}">',
  '      <Implementation>',
  '        <CFC><XmlArchive>...</XmlArchive></CFC>',
  '      </Implementation>',
  '    </Action>',
  '  </POU>',
  '</TcPlcObject>',
  '',
].join('\n');
const CRLF = LF.replace(/\n/g, '\r\n');

const viewLines = (xml: string) => decode(xml).split('\n').slice(0, -1);   // the text ends with one newline

test('spans cover the whole view without gaps', () => {
  for (const xml of [LF, CRLF]) {
    const spans = spansOf(xml);
    assert.equal(spans.length, sectionsOfXml(xml).length);
    let next = 0;
    for (const s of spans) {
      assert.equal(s.viewFirst, next, s.key);
      assert.ok(s.viewLast >= s.viewFirst, s.key);
      next = s.viewLast + 1;
    }
    assert.equal(next, viewLines(xml).length);
  }
});

test('every body line maps to the xml line that holds the same text', () => {
  const xmlLines = LF.split('\n');
  const view = viewLines(LF);
  let checked = 0;
  for (let i = 0; i < view.length; i++) {
    const hit = xmlLineOfViewLine(spansOf(LF), i)!;
    assert.ok(hit, `line ${i}`);
    if (hit.xmlLine === undefined) continue;
    const xmlText = xmlLines[hit.xmlLine - 1].replace(/\]\]\]\]><!\[CDATA\[>/g, ']]>');
    assert.ok(xmlText.includes(view[i]), `view line ${i} "${view[i]}" vs xml line ${hit.xmlLine} "${xmlText}"`);
    checked++;
  }
  assert.ok(checked > 20);
});

test('first and last body line are flagged as boundary, interior lines are not', () => {
  const start = spansOf(LF).find(s => s.key === 'METHOD:Start')!;
  const impl = start.impl!;
  assert.equal(impl.viewLast - impl.viewFirst, 2);
  assert.equal(xmlLineOfViewLine(spansOf(LF), impl.viewFirst)!.boundary, true);
  assert.equal(xmlLineOfViewLine(spansOf(LF), impl.viewFirst + 1)!.boundary, false);
  assert.equal(xmlLineOfViewLine(spansOf(LF), impl.viewLast)!.boundary, true);
  assert.equal(impl.boundaryFirst, true);
  assert.equal(impl.boundaryLast, true);
});

test('crlf input gives the same xml line numbers as lf input', () => {
  assert.deepEqual(spansOf(CRLF), spansOf(LF));
});

test('the read-only implementation marker has no xml line', () => {
  const spans = spansOf(LF);
  const cfc = spans.find(s => s.key === 'ACTION:Cfc')!;
  assert.equal(cfc.impl, undefined);
  const view = viewLines(LF);
  const marker = view.findIndex(l => l.startsWith('//---- IMPLEMENTATION (CFC'));
  assert.ok(marker >= 0);
  const hit = xmlLineOfViewLine(spans, marker)!;
  assert.equal(hit.span.key, 'ACTION:Cfc');
  assert.equal(hit.xmlLine, undefined);
  // the plain marker of an ST implementation and a method header have none either
  const m = view.indexOf('//---- IMPLEMENTATION ----');
  assert.equal(xmlLineOfViewLine(spans, m)!.xmlLine, undefined);
  assert.equal(xmlLineOfViewLine(spans, cfc.header!)!.xmlLine, undefined);
});

test('a body with two CDATA segments maps each line to its own segment', () => {
  const spans = spansOf(LF);
  const split = spans.find(s => s.key === 'METHOD:Split')!;
  const xmlLines = LF.split('\n');
  const impl = split.impl!;
  assert.equal(impl.viewLast - impl.viewFirst, 2);
  const lines = impl.xmlLines;
  assert.ok(xmlLines[lines[0] - 1].includes('s := '));
  assert.ok(xmlLines[lines[1] - 1].includes(']]]]><![CDATA[>b'));
  assert.ok(xmlLines[lines[2] - 1].includes('after;'));
  assert.equal(lines[1], lines[0] + 1);
  assert.equal(lines[2], lines[1] + 1);
  assert.equal(viewLines(LF)[impl.viewFirst + 1], "'a]]>b';");
});

test('an empty declaration and an empty implementation are one view line each', () => {
  const empty = spansOf(LF).find(s => s.key === 'METHOD:Empty')!;
  assert.equal(empty.decl!.viewLast, empty.decl!.viewFirst);
  assert.equal(empty.impl!.viewLast, empty.impl!.viewFirst);
  const xmlLines = LF.split('\n');
  assert.ok(xmlLines[empty.decl!.xmlLines[0] - 1].includes('<Declaration>'));
  assert.ok(xmlLines[empty.impl!.xmlLines[0] - 1].includes('<ST>'));
  assert.equal(empty.decl!.boundaryFirst && empty.decl!.boundaryLast, true);
  // header, decl, marker, impl
  assert.equal(empty.viewLast - empty.viewFirst, 3);
});
