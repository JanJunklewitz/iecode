import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { checkStructure } from '../src/core/structureRules';
import { parseXml } from '../src/xml';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures');
const OBJECT_FILE = /\.(TcPOU|TcDUT|TcGVL|TcIO)$/i;
/** Files that are broken on purpose, with the reason. */
const ALLOWLIST: Record<string, string> = {};

function objectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? objectFiles(p) : OBJECT_FILE.test(n) ? [p] : [];
  });
}

test('every object fixture of the repository produces no finding at default severities', () => {
  const files = objectFiles(fixtures);
  assert.ok(files.length >= 6, `only ${files.length} fixtures found`);
  for (const f of files) {
    const name = f.slice(fixtures.length + 1).replace(/\\/g, '/');
    if (ALLOWLIST[name]) continue;
    assert.deepEqual(checkStructure(readFileSync(f, 'utf8'), f).map(x => `${x.rule}: ${x.message}`), [], name);
  }
});

const G = (n: number) => `{aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}}`;
const wrap = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\r\n<TcPlcObject Version="1.1.0.1">\r\n${body}\r\n</TcPlcObject>`;
const cd = (s: string) => `<![CDATA[${s}]]>`;
const pou = (extra = '', name = 'FB_X') => wrap(`  <POU Name="${name}" Id="${G(1)}">
    <Declaration>${cd(`FUNCTION_BLOCK ${name}\nVAR\nEND_VAR\n`)}</Declaration>
    <Implementation><ST>${cd(';')}</ST></Implementation>
${extra}
  </POU>`);
const method = (name: string, id: number, decl = `METHOD ${name} : BOOL`) => `    <Method Name="${name}" Id="${G(id)}">
      <Declaration>${cd(decl)}</Declaration>
      <Implementation><ST>${cd(';')}</ST></Implementation>
    </Method>`;
const run = (xml: string, file = '/p/FB_X.TcPOU', opts?: Parameters<typeof checkStructure>[2]) => checkStructure(xml, file, opts);
const rules = (xml: string, file?: string, opts?: Parameters<typeof checkStructure>[2]) => run(xml, file, opts).map(f => f.rule);

test('valid files of shapes the fixtures lack give no finding', () => {
  const struct = wrap(`  <DUT Name="ST_A" Id="${G(1)}">\n    <Declaration>${cd('TYPE ST_A :\nSTRUCT\n    x : INT;\nEND_STRUCT\nEND_TYPE\n')}</Declaration>\n  </DUT>`);
  const gvl = wrap(`  <GVL Name="GVL_A" Id="${G(1)}">\n    <Declaration>${cd('VAR_GLOBAL\nEND_VAR\n')}</Declaration>\n  </GVL>`);
  const action = pou(`    <Action Name="Reset" Id="${G(2)}">\n      <Implementation><ST>${cd(';')}</ST></Implementation>\n    </Action>\n    <Transition Name="T1" Id="${G(3)}">\n      <Implementation><ST>${cd('TRUE')}</ST></Implementation>\n    </Transition>\n    <LineIds Name="FB_X.Reset"><LineId Id="1" Count="0" /></LineIds>`);
  const cfc = pou(`    <Method Name="Diag" Id="${G(2)}">\n      <Declaration>${cd('METHOD Diag')}</Declaration>\n      <Implementation><CFC><XmlArchive>x</XmlArchive></CFC></Implementation>\n    </Method>`);
  const itf = wrap(`  <Itf Name="I_P" Id="${G(1)}">\n    <Declaration>${cd('INTERFACE I_P\n')}</Declaration>\n    <Property Name="Speed" Id="${G(2)}">\n      <Declaration>${cd('PROPERTY Speed : LREAL')}</Declaration>\n    </Property>\n  </Itf>`);
  const pragma = pou(method('Start', 2, '{attribute \'foo\'}\n// a comment\n(* block *)\nMETHOD PUBLIC Start : BOOL'));
  const abstract = pou(`    <Method Name="Go" Id="${G(2)}">\n      <Declaration>${cd('METHOD ABSTRACT Go')}</Declaration>\n    </Method>`);
  const noRoot = '<?xml version="1.0"?>\n<Project><Name>x</Name></Project>';
  assert.deepEqual(run(struct, '/p/ST_A.TcDUT'), []);
  assert.deepEqual(run(gvl, '/p/GVL_A.TcGVL'), []);
  assert.deepEqual(run(action), []);
  assert.deepEqual(run(cfc), []);
  assert.deepEqual(run(itf, '/p/I_P.TcIO'), []);
  assert.deepEqual(run(pragma), []);
  assert.deepEqual(run(abstract), []);
  assert.deepEqual(run(noRoot), []);
});

test('a method name differing only by case from its declaration is no finding', () => {
  assert.deepEqual(rules(pou(method('start', 2, 'METHOD Start : BOOL'))), []);
});

const lineOf = (xml: string, needle: string) => xml.slice(0, xml.indexOf(needle)).split('\n').length - 1;

test('guid-format is an error on the Id attribute', () => {
  const xml = pou().replace(G(1), '{not-a-guid}');
  const [f] = run(xml);
  assert.equal(f.rule, 'guid-format');
  assert.equal(f.level, 'error');
  assert.equal(f.line, lineOf(xml, '{not-a-guid}'));
});

test('guid-unique flags the later duplicate and offers a new Id', () => {
  const xml = pou(method('A', 2).replace(G(2), G(1)));
  const [f] = run(xml);
  assert.equal(f.rule, 'guid-unique');
  assert.equal(f.line, lineOf(xml, 'Method Name="A"'));
  assert.ok(f.fix && f.fix.edit.text !== G(1) && /^\{[0-9a-f-]{36}\}$/.test(f.fix.edit.text));
  assert.match(f.fix!.title, /identity/);
});

test('name-mismatch is an error on the Name attribute', () => {
  const xml = pou(method('Start', 2, 'METHOD Stop : BOOL'));
  const [f] = run(xml);
  assert.equal(f.rule, 'name-mismatch');
  assert.equal(f.line, lineOf(xml, 'Method Name="Start"'));
});

test('file-name-mismatch is a warning', () => {
  const [f] = run(pou(), '/p/FB_Other.TcPOU');
  assert.equal(f.rule, 'file-name-mismatch');
  assert.equal(f.level, 'warning');
  assert.deepEqual(rules(pou(), '/p/fb_x.TcPOU'), []);
});

test('member-structure: a method without declaration or implementation and a property without accessor', () => {
  const noDecl = pou(`    <Method Name="M" Id="${G(2)}"><Implementation><ST>${cd(';')}</ST></Implementation></Method>`);
  const noImpl = pou(`    <Method Name="M" Id="${G(2)}"><Declaration>${cd('METHOD M')}</Declaration></Method>`);
  const noAcc = pou(`    <Property Name="P" Id="${G(2)}"><Declaration>${cd('PROPERTY P : INT')}</Declaration></Property>`);
  for (const x of [noDecl, noImpl, noAcc]) assert.deepEqual(rules(x), ['member-structure']);
});

test('lineids-orphan removes only the node and its line; the file still parses', () => {
  const xml = pou(`    <LineIds Name="FB_X.Gone">\r\n      <LineId Id="1" Count="0" />\r\n    </LineIds>\r\n    <LineIds Name="FB_X"><LineId Id="1" Count="0" /></LineIds>`);
  const [f] = run(xml);
  assert.equal(f.rule, 'lineids-orphan');
  assert.equal(f.level, 'warning');
  const { start, end, text } = f.fix!.edit;
  const fixed = xml.slice(0, start) + text + xml.slice(end);
  assert.ok(!fixed.includes('FB_X.Gone'));
  assert.equal(fixed.length, xml.length - (end - start));
  assert.ok(xml.slice(start, end).includes('FB_X.Gone'));
  assert.doesNotThrow(() => parseXml(fixed));
  assert.deepEqual(run(fixed), []);
});

test('merge-conflict gives exactly one finding', () => {
  const xml = pou().replace('    <Declaration>', '<<<<<<< HEAD\n    <Declaration>');
  const f = run(xml);
  assert.deepEqual(f.map(x => x.rule), ['merge-conflict']);
});

test('a file that does not parse gives one xml-parse finding and nothing else', () => {
  const f = run('<TcPlcObject><POU Name="X"><Declaration>');
  assert.deepEqual(f.map(x => x.rule), ['xml-parse']);
  assert.deepEqual(rules('<a><?pi never closed'), ['xml-parse']);
});

test('naming-prefix is a hint and only when prefixes are set', () => {
  assert.deepEqual(rules(pou()), []);
  const f = run(pou(), '/p/FB_X.TcPOU', { namingPrefixes: { FUNCTION_BLOCK: 'FbX_' } });
  assert.deepEqual(f.map(x => [x.rule, x.level]), [['naming-prefix', 'hint']]);
  assert.deepEqual(rules(pou(), '/p/FB_X.TcPOU', { namingPrefixes: { FUNCTION_BLOCK: 'FB_' } }), []);
});

test('a BOM does not shift the reported lines', () => {
  const xml = '﻿' + pou().replace(G(1), '{bad}');
  assert.equal(run(xml)[0].line, 2);
});

test('a protected (encrypted) object file gives no finding', () => {
  assert.deepEqual(run('TcEncryptedFile\u0001<\u0007\u0000garbage<'), []);
});

test('a truncated closing tag throws instead of looping', () => {
  assert.throws(() => parseXml('<a></a '), /Unterminated closing tag/);
  assert.throws(() => parseXml('<TcPlcObject><POU></POU></TcPlcObject '), /Unterminated closing tag/);
});

test('guid-unique edits the Id value even when another attribute value contains Id=', () => {
  const xml = `<TcPlcObject><POU Name="P" Id="${G(1)}"><Method Name="M" Note="x Id=" Id="${G(1)}"><Declaration><![CDATA[METHOD M]]></Declaration><Implementation><ST><![CDATA[;]]></ST></Implementation></Method></POU></TcPlcObject>`;
  const f = checkStructure(xml, '/p/P.TcPOU').find(x => x.rule === 'guid-unique');
  assert.ok(f?.fix);
  const fixed = xml.slice(0, f.fix.edit.start) + f.fix.edit.text + xml.slice(f.fix.edit.end);
  assert.ok(fixed.includes('Note="x Id="'), 'the Note attribute stays intact');
  assert.equal(fixed.split(G(1)).length - 1, 1, 'only the later Id changed');
});

test('a property without a Declaration is a member-structure finding', () => {
  const xml = `<TcPlcObject><POU Name="P" Id="${G(1)}"><Declaration><![CDATA[FUNCTION_BLOCK P]]></Declaration><Property Name="X" Id="${G(2)}"><Get Name="Get" Id="${G(3)}"><Declaration><![CDATA[]]></Declaration></Get></Property></POU></TcPlcObject>`;
  assert.ok(checkStructure(xml, '/p/P.TcPOU').some(x => x.rule === 'member-structure' && /no Declaration/.test(x.message)));
});
