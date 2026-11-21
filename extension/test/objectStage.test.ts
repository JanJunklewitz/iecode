import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasConflictMarkers, changedSections, decodeUtf8Strict, discardConfirmText, discardGuard, discardSection, hasMixedEol, sectionRanges, stageGuard, stageSection, writeFileSafe } from '../src/core/objectStage';
import { tempRepo } from './helpers/gitRepo';
import { NotUtf8Error, indexEntry, indexHasConflict, readIndex, runGit, writeIndexBlob } from '../src/core/git';
import { join } from 'path';
import { readFileSync, rmSync, writeFileSync } from 'fs';
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

// ---------------------------------------------------------------- git index

test('readIndex returns the staged text and undefined for an untracked file', async () => {
  const r = tempRepo();
  try {
    r.write('a.txt', 'one\n'); r.commitAll('c1'); r.write('u.txt', 'x');
    assert.equal(await readIndex(r.dir, join(r.dir, 'a.txt')), 'one\n');
    assert.equal(await readIndex(r.dir, join(r.dir, 'u.txt')), undefined);
  } finally { r.cleanup(); }
});

test('writeIndexBlob changes the index but not the working file or HEAD; BOM and CRLF survive', async () => {
  const r = tempRepo();
  try {
    r.write('a.txt', '﻿one\r\n'); r.commitAll('c1');
    r.write('a.txt', '﻿two\r\n');
    const f = join(r.dir, 'a.txt');
    const e = (await indexEntry(r.dir, f))!;
    await writeIndexBlob(r.dir, f, '﻿staged\r\n', e.sha);
    assert.equal(await readIndex(r.dir, f), '﻿staged\r\n');
    assert.match(r.git('diff', '--cached', '--stat'), /a\.txt/);
    assert.equal(r.git('show', 'HEAD:a.txt'), '﻿one\r\n');
    assert.equal(readFileSync(f, 'utf8'), '﻿two\r\n');
  } finally { r.cleanup(); }
});

test('with core.autocrlf=true an LF index stays LF', async () => {
  const r = tempRepo();
  try {
    r.git('config', 'core.autocrlf', 'true');
    r.write('a.txt', 'one\n'); r.commitAll('c1');
    const f = join(r.dir, 'a.txt');
    const e = (await indexEntry(r.dir, f))!;
    await writeIndexBlob(r.dir, f, 'two\n', e.sha);
    assert.equal(await readIndex(r.dir, f), 'two\n');
  } finally { r.cleanup(); }
});

test('writeIndexBlob refuses when the index entry changed in between', async () => {
  const r = tempRepo();
  try {
    r.write('a.txt', 'one\n'); r.commitAll('c1');
    const f = join(r.dir, 'a.txt');
    const e = (await indexEntry(r.dir, f))!;
    r.write('a.txt', 'other\n'); r.git('add', 'a.txt');
    await assert.rejects(writeIndexBlob(r.dir, f, 'two\n', e.sha), /index changed/);
  } finally { r.cleanup(); }
});

test('an intent-to-add file has an empty index blob', async () => {
  const r = tempRepo();
  try {
    r.write('seed.txt', 's'); r.commitAll('c1');
    r.write('n.txt', 'new\n'); r.git('add', '-N', 'n.txt');
    assert.equal(await readIndex(r.dir, join(r.dir, 'n.txt')), '');
  } finally { r.cleanup(); }
});

test('indexHasConflict is true during a conflicted merge', async () => {
  const r = tempRepo();
  try {
    r.commit('a\nb\nc\n', 'base');
    r.git('checkout', '-q', '-b', 't'); r.commit('a\nT\nc\n', 'topic');
    r.git('checkout', '-q', 'main'); r.commit('a\nM\nc\n', 'main');
    assert.equal(await indexHasConflict(r.dir, r.file), false);
    r.tryGit('merge', 't');
    assert.equal(await indexHasConflict(r.dir, r.file), true);
  } finally { r.cleanup(); }
});

test('a blob with a non-UTF-8 byte is refused', async () => {
  const r = tempRepo();
  try {
    r.write('a.txt', Buffer.from([0x2f, 0x2f, 0x20, 0xe4, 0x0a])); r.commitAll('c1');
    await assert.rejects(readIndex(r.dir, join(r.dir, 'a.txt')), NotUtf8Error);
  } finally { r.cleanup(); }
});

test('the sha check is repeated after an index.lock retry', async () => {
  const r = tempRepo();
  try {
    r.write('a.txt', 'one\n'); r.commitAll('c1');
    const f = join(r.dir, 'a.txt');
    const e = (await indexEntry(r.dir, f))!;
    const lock = join(r.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    // the first update-index fails on the lock; behind the writer's back, during its retry wait, the entry changes
    const p = writeIndexBlob(r.dir, f, 'two\n', e.sha, async () => {
      rmSync(lock);
      const sneaky = (await runGit(r.dir, ['hash-object', '-w', '--stdin'], { input: 'sneaky\n' })).trim();
      await runGit(r.dir, ['update-index', '--cacheinfo', `100644,${sneaky},a.txt`]);
    });
    await assert.rejects(p, /index changed/);
  } finally { r.cleanup(); }
});

test('stageGuard gives one message per refusal and offers the whole file for untracked and intent-to-add', () => {
  const ok = { tracked: true, intentToAdd: false, conflict: false, decodes: true, dirty: false, mixedEol: false, utf8: true };
  assert.deepEqual(stageGuard(ok), { ok: true });
  const bad = (o: Partial<typeof ok>) => stageGuard({ ...ok, ...o }) as { ok: false; message: string; wholeFile?: boolean };
  assert.match(bad({ dirty: true }).message, /save first/);
  assert.match(bad({ conflict: true }).message, /merge conflicts/);
  assert.equal(bad({ tracked: false }).wholeFile, true);
  assert.equal(bad({ intentToAdd: true }).wholeFile, true);
  assert.match(bad({ utf8: false }).message, /UTF-8/);
  assert.match(bad({ mixedEol: true }).message, /mixed line endings/);
  assert.match(bad({ decodes: false }).message, /cannot be read/);
  assert.equal(bad({ dirty: true }).wholeFile, undefined);
});

test('decodeUtf8Strict keeps a BOM and refuses bytes that do not round-trip', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a/>', 'utf8')]);
  assert.equal(decodeUtf8Strict(bom), '﻿<a/>');
  assert.equal(decodeUtf8Strict(Buffer.from([0x3c, 0xff, 0x3e])), undefined);
});

test('a unit that only the source has is an error, not a silent no-op', () => {
  const work = pou({ impl: 'main2;' });
  const lines = work.split('\n');
  const at = lines.findIndex(l => l.includes('main2;'));
  const base = [...lines.slice(0, at - 1), ...lines.slice(at + 2)].join('\n');   // drops the main <Implementation> block
  assert.notEqual(base, work);
  assert.deepEqual(changedSections(base, work).map(c => c.key), ['MAIN']);
  assert.throws(() => stageSection(base, work, 'MAIN'), ViewError);
});

test('a renamed object does not leak its new name into the copied LineIds', () => {
  const base = pou({ methods: [A('a1'), B('b1')] });
  const work = pou({ methods: [A('a2'), B('b1')] }).replace(/FB_A/g, 'FB_New');
  const out = stageSection(base, work, 'METHOD:A');
  assert.ok(!out.includes('FB_New'), out);
  assert.ok(out.includes('<LineIds Name="FB_A.A">'));
  assert.ok(out.includes('a2') && out.includes('b1'));
});

test('a GET added to a property that has a SET lands before the SET', () => {
  const base = pou({ prop: { type: 'INT', set: 's' } });
  const work = pou({ prop: { type: 'INT', get: 'g', set: 's' } });
  const out = stageSection(base, work, 'GET:Speed');
  assert.ok(out.indexOf('<Get ') >= 0 && out.indexOf('<Get ') < out.indexOf('<Set '), out);
  assert.deepEqual(changedSections(out, work), []);
});

test('a layout the splice does not expect is refused, not staged as broken XML', () => {
  const oneLine = (extra: string) => '<?xml version="1.0" encoding="utf-8"?>\n<TcPlcObject Version="1.1.0.1"><POU Name="FB_A" Id="' + guid(1) + '">'
    + '<Declaration><![CDATA[FUNCTION_BLOCK FB_A]]></Declaration>' + extra + '</POU></TcPlcObject>\n';
  const method = '<Method Name="M" Id="' + guid(5) + '"><Declaration><![CDATA[METHOD M]]></Declaration><Implementation><ST><![CDATA[x;]]></ST></Implementation></Method>';
  assert.throws(() => stageSection(oneLine(''), oneLine(method), 'METHOD:M'), ViewError);
});

test('the index entry of a file name with glob characters is that file, not a neighbour matching the pattern', async () => {
  const r = tempRepo();
  try {
    r.write('Pump1.TcPOU', 'one\n'); r.write('Pump[1].TcPOU', 'bracket\n'); r.commitAll('c1');
    const want = r.git('rev-parse', 'HEAD:Pump[1].TcPOU').trim();
    assert.equal((await indexEntry(r.dir, join(r.dir, 'Pump[1].TcPOU')))?.sha, want);
    assert.equal(await indexHasConflict(r.dir, join(r.dir, 'Pump[1].TcPOU')), false);
  } finally { r.cleanup(); }
});

// ---- discard (plan C, task 4) ----

const okInput = { tracked: true, intentToAdd: false, conflict: false, decodes: true, dirty: false, mixedEol: false, utf8: true };

test('writeFileSafe writes through a temporary file in the same folder and renames it over the target', async () => {
  const calls: string[] = [];
  await writeFileSafe('C:/p/FB_A.TcPOU', 'new', {
    write: async (p, c) => { calls.push(`write ${p} ${c}`); },
    rename: async (a, b) => { calls.push(`rename ${a} -> ${b}`); },
    remove: async p => { calls.push(`remove ${p}`); },
  });
  assert.equal(calls.length, 2);
  const tmp = /^write (\S+) new$/.exec(calls[0])![1];
  assert.ok(tmp.startsWith('C:/p/') && tmp !== 'C:/p/FB_A.TcPOU');
  assert.equal(calls[1], `rename ${tmp} -> C:/p/FB_A.TcPOU`);
});

test('writeFileSafe leaves the original untouched when the write fails', async () => {
  const calls: string[] = [];
  await assert.rejects(writeFileSafe('C:/p/FB_A.TcPOU', 'new', {
    write: async () => { throw new Error('disk full'); },
    rename: async (a, b) => { calls.push(`rename ${a} -> ${b}`); },
    remove: async p => { calls.push(`remove ${p}`); },
  }), /disk full/);
  assert.ok(!calls.some(c => c.startsWith('rename')), 'the original must not be replaced');
  assert.ok(calls.some(c => c.startsWith('remove')), 'the temporary file is cleaned up');
});

test('writeFileSafe removes the temporary file when the rename fails', async () => {
  const calls: string[] = [];
  await assert.rejects(writeFileSafe('C:/p/FB_A.TcPOU', 'new', {
    write: async () => undefined,
    rename: async () => { throw new Error('locked'); },
    remove: async p => { calls.push(`remove ${p}`); },
  }), /locked/);
  assert.equal(calls.length, 1);
});

test('discardGuard refuses when the file: or the iecode: document is dirty, also when it became dirty after the confirmation', () => {
  assert.deepEqual(discardGuard(okInput), { ok: true });
  // the command reads the dirty state again after the modal confirmation
  const after = discardGuard({ ...okInput, dirty: true });
  assert.equal(after.ok, false);
  if (!after.ok) assert.match(after.message, /unsaved changes/);
});

test('discardGuard has no whole-file way out: an untracked file has nothing to restore from', () => {
  for (const i of [{ ...okInput, tracked: false }, { ...okInput, intentToAdd: true }]) {
    const g = discardGuard(i);
    assert.equal(g.ok, false);
    if (!g.ok) { assert.ok(!('wholeFile' in g)); assert.match(g.message, /no committed or staged version/); }
  }
  for (const [k, re] of [['conflict', /merge conflicts/], ['mixedEol', /mixed line endings/], ['utf8', /UTF-8/], ['decodes', /cannot be read/]] as const) {
    const g = discardGuard({ ...okInput, [k]: k === 'conflict' || k === 'mixedEol' });
    assert.equal(g.ok, false, k);
    if (!g.ok) assert.match(g.message, re);
  }
});

test('discardConfirmText names the section and says it cannot be undone', () => {
  assert.equal(discardConfirmText('METHOD:Start', 'FB_A.TcPOU'), 'Discard your changes to method Start in FB_A.TcPOU? It goes back to the staged version (the index, not HEAD). This cannot be undone.');
  // a section that exists only in the working file is deleted, not restored: the text must say so
  assert.equal(discardConfirmText('METHOD:Foo', 'FB_A.TcPOU', 'added'), 'Delete method Foo from FB_A.TcPOU? It exists only in the working file. This cannot be undone.');
  assert.match(discardConfirmText('ACTION:Foo', 'FB_A.TcPOU', 'removed'), /^Restore action Foo in FB_A\.TcPOU\?.*index\.$/);
  // the main section is the declaration and the implementation: the question must name both
  assert.match(discardConfirmText('MAIN', 'FB_A.TcPOU'), /^Discard your changes to the main declaration and implementation in FB_A\.TcPOU\?/);
  assert.match(discardConfirmText('GET:Speed', 'X.TcPOU'), /property getter Speed/);
});

test('writeFileSafe retries a rename that a lock holds for a moment, but not other errors', async () => {
  let renames = 0;
  const slept: number[] = [];
  const io = (code: string, failures: number) => ({
    write: async () => undefined, remove: async () => undefined,
    rename: async () => { if (renames++ < failures) throw Object.assign(new Error(code), { code }); },
  });
  await writeFileSafe('C:/p/F.TcPOU', 'x', io('EBUSY', 2), { sleep: async ms => { slept.push(ms); } });
  assert.equal(renames, 3);
  assert.deepEqual(slept, [200, 200]);
  renames = 0;
  await assert.rejects(writeFileSafe('C:/p/F.TcPOU', 'x', io('EBUSY', 99), { sleep: async () => undefined }), /EBUSY/);
  assert.equal(renames, 3, 'gives up after two retries');
  renames = 0;
  await assert.rejects(writeFileSafe('C:/p/F.TcPOU', 'x', io('ENOSPC', 99), { sleep: async () => undefined }), /ENOSPC/);
  assert.equal(renames, 1, 'no retry for an error a wait does not fix');
});

test('writeFileSafe checks before every rename attempt and replaces nothing when the check fails', async () => {
  const calls: string[] = [];
  let checks = 0;
  await assert.rejects(writeFileSafe('C:/p/F.TcPOU', 'x', {
    write: async () => undefined,
    rename: async () => { calls.push('rename'); throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
    remove: async () => { calls.push('remove'); },
  }, { sleep: async () => undefined, beforeRename: async () => { if (++checks === 2) throw new Error('changed'); } }), /changed/);
  assert.deepEqual(calls, ['rename', 'remove'], 'the second attempt was stopped by the check, the temporary file removed');
});

test('writeFileSafe uses a different temporary name every time', async () => {
  const names = new Set<string>();
  for (let i = 0; i < 20; i++) await writeFileSafe('C:/p/F.TcPOU', 'x', { write: async p => { names.add(p); }, rename: async () => undefined, remove: async () => undefined });
  assert.equal(names.size, 20);
});

test('hasConflictMarkers finds leftover markers at a line start only', () => {
  assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nb'), true);
  assert.equal(hasConflictMarkers('a\n>>>>>>> branch\n'), true);
  assert.equal(hasConflictMarkers('x := a <<<<<<< 1;'), false);
  assert.equal(hasConflictMarkers('plain'), false);
});
