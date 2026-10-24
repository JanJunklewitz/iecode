import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { decode, encode } from '../src/model';
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
