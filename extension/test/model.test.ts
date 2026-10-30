import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { decode, encode, ConflictError } from '../src/model';
import { parseXml } from '../src/xml';

const dir = join(__dirname, '..', '..', 'samples');
const load = (f: string) => readFileSync(join(dir, f), 'utf8');
const pou = load('FB_Motor.TcPOU');

test('unchanged view round-trips byte-identical for every sample', () => {
  for (const f of readdirSync(dir)) {
    const xml = load(f);
    assert.equal(encode(xml, decode(xml)), xml, f);
  }
});

test('view shows ST only, splits "]]>" CDATA transparently', () => {
  const v = decode(pou);
  assert.ok(!v.includes('<![CDATA['));
  assert.ok(v.includes("sInfo : STRING := 'a]]>b';"));
  assert.ok(v.includes('//==== GET Speed ===='));
  assert.ok(v.includes('(CFC, read-only'));
});

test('editing one method only touches that CDATA and its LineIds', () => {
  const v = decode(pou).replace('Start := TRUE;', 'Start := bRunning;');
  const out = encode(pou, v);
  assert.ok(out.includes('Start := bRunning;'));
  assert.ok(!out.includes('<LineIds Name="FB_Motor.Start">'));
  assert.ok(out.includes('<LineIds Name="FB_Motor">'));
  assert.ok(out.includes('{a1b2c3d4-0000-0000-0000-000000000001}'), 'GUID kept');
  assert.ok(out.includes('FolderPath="Internal\\"'), 'folder kept');
  assert.ok(out.includes('<XmlArchive>...</XmlArchive>'), 'CFC kept');
  assert.ok(!out.includes('\r\n'.repeat(2) + '  </POU>'));
  assert.ok(!/[^\r]\n/.test(out), 'CRLF preserved');
  assert.equal(decode(out), v);
});

test('adding method, action and setter creates elements with new GUIDs', () => {
  const v = decode(pou) +
    '//==== METHOD Stop ====\nMETHOD Stop\n//---- IMPLEMENTATION ----\nbEnable := FALSE;\n' +
    '//==== SET Speed ====\nVAR\nEND_VAR\n//---- IMPLEMENTATION ----\n_fSpeed := Speed;\n' +
    '//==== ACTION Init ====\n//---- IMPLEMENTATION ----\n_fSpeed := 0;\n';
  const out = encode(pou, v);
  parseXml(out);
  assert.match(out, /<Method Name="Stop" Id="\{[0-9a-f-]{36}\}">/);
  assert.match(out, /<Set Name="Set" Id=/);
  assert.match(out, /<Action Name="Init"/);
  assert.ok(out.indexOf('<Method Name="Stop"') < out.indexOf('<LineIds'), 'inserted before LineIds');
  assert.ok(out.indexOf('<Set Name="Set"') < out.indexOf('</Property>'));
  assert.equal(encode(out, decode(out)), out, 'stable after insert');
});

test('removing a property removes accessors and their LineIds', () => {
  const v = decode(pou).replace(/\/\/==== PROPERTY Speed ====[\s\S]*?(?=\/\/==== ACTION)/, '');
  const out = encode(pou, v);
  parseXml(out);
  assert.ok(!out.includes('<Property'));
  assert.ok(!out.includes('FB_Motor.Speed.Get'));
  assert.ok(out.includes('<Action Name="Reset"'));
});

test('invalid views are rejected with a line number', () => {
  assert.throws(() => encode(pou, decode(pou) + '//==== GET Missing ====\nVAR\nEND_VAR\n'), /PROPERTY Missing/);
  assert.throws(() => encode(load('ST_Axis.TcDUT'), decode(load('ST_Axis.TcDUT')) + '//---- IMPLEMENTATION ----\nx;\n'), /no implementation/);
});

test('merge conflict in the XML structure is reported as ConflictError, not a parse error', () => {
  const xml = pou.replace(/( *<Method Name="Start"[^\r\n]*\r?\n)/,
    '<<<<<<< HEAD\r\n$1=======\r\n    <Method Name="Start" Id="{a1b2c3d4-0000-0000-0000-000000000099}" FolderPath="Other\\">\r\n>>>>>>> feature\r\n');
  assert.notEqual(xml, pou);
  assert.throws(() => decode(xml), (e: Error) => e instanceof ConflictError && /merge conflict/.test(e.message));
  assert.throws(() => encode(xml, decode(pou)), ConflictError);
});

test('merge conflict between XML elements (no parse error) is still a ConflictError', () => {
  const xml = pou.replace(/( *<Method Name="Start"[^\r\n]*\r?\n)/, '<<<<<<< HEAD\r\n=======\r\n>>>>>>> feature\r\n$1');
  assert.notEqual(xml, pou);
  assert.throws(() => decode(xml), ConflictError);
});

test('merge conflict inside <LineIds> keeps the ST view and is dropped on save', () => {
  const xml = pou.replace(/( *<LineId [^\r\n]*\r?\n)/, '<<<<<<< HEAD\r\n$1=======\r\n      <LineId Id="99" Count="1" />\r\n>>>>>>> feature\r\n');
  assert.notEqual(xml, pou);
  assert.equal(decode(xml), decode(pou));
  const out = encode(xml, decode(xml));
  assert.doesNotMatch(out, /^(<{7}|={7}|>{7})/m);
  assert.equal(decode(out), decode(pou));
});

test('merge conflict inside ST code stays editable in the view', () => {
  const xml = pou.replace(/( *_fSpeed := fSetSpeed;\r?\n)/, '<<<<<<< HEAD\r\n$1=======\r\n    _fSpeed := 2.0 * fSetSpeed;\r\n>>>>>>> feature\r\n');
  assert.notEqual(xml, pou);
  const v = decode(xml);
  assert.match(v, /^<{7} HEAD$/m);
  const resolved = encode(xml, v.replace(/<{7} HEAD\n([\s\S]*?)={7}\n[\s\S]*?>{7} feature\n/, '$1'));
  assert.equal(decode(resolved), decode(pou));
});
