import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeLabels, mergeText, stage } from '../src/core/git';
import { AutoResolveError, autoResolve, editedSinceConflict, sameSnapshot, snapshotOf } from '../src/core/autoResolve';
import { decode } from '../src/model';

const BASE = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
const labels = { ours: 'ours-label', base: 'base-label', theirs: 'theirs-label' };

/** Temp repo with real git; autocrlf off so Windows and Linux see the same bytes. */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-merge-test-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a],
    { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  /** Runs git and returns normally even on a non-zero exit (a conflicting merge exits 1). */
  const tryGit = (...a: string[]) => { try { git(...a); } catch { /* expected conflict */ } };
  const file = join(dir, 'f.txt');
  const commit = (content: string, msg: string) => { writeFileSync(file, content); git('add', 'f.txt'); git('commit', '-q', '-m', msg); };
  git('init', '-q', '-b', 'main');
  return { dir, file, git, tryGit, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** main and topic both change line 2 differently, starting from BASE. Leaves main checked out. */
function divergedRepo() {
  const r = tempRepo();
  r.commit(BASE, 'base');
  r.git('checkout', '-q', '-b', 'topic');
  r.commit(BASE.replace('l2', 'topic2'), 'topic');
  r.git('checkout', '-q', 'main');
  r.commit(BASE.replace('l2', 'main2'), 'main');
  return r;
}

test('stage returns base/ours/theirs of a conflicted file and undefined for a missing stage', async () => {
  const r = divergedRepo();
  try {
    r.tryGit('merge', 'topic');
    assert.equal(await stage(r.dir, 1, r.file), BASE);
    assert.equal(await stage(r.dir, 2, r.file), BASE.replace('l2', 'main2'));
    assert.equal(await stage(r.dir, 3, r.file), BASE.replace('l2', 'topic2'));
    assert.equal(await stage(r.dir, 1, join(r.dir, 'nope.txt')), undefined);
  } finally { r.cleanup(); }
});

test('mergeText merges disjoint changes cleanly', async () => {
  const res = await mergeText(BASE.replace('l2', 'ours2'), BASE, BASE.replace('l7', 'theirs7'), labels);
  assert.equal(res.conflicts, 0);
  assert.equal(res.text, BASE.replace('l2', 'ours2').replace('l7', 'theirs7'));
});

test('mergeText reports a conflict with the given labels', async () => {
  // a user-global diff3 setting is the real risk; mergeText runs outside any repo, so set it via the environment
  const saved = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'merge.conflictStyle';
  process.env.GIT_CONFIG_VALUE_0 = 'diff3';
  try {
    const res = await mergeText(BASE.replace('l2', 'ours2'), BASE, BASE.replace('l2', 'theirs2'), labels);
    assert.equal(res.conflicts, 1);
    assert.match(res.text, /^<{7} ours-label$/m);
    assert.match(res.text, /^>{7} theirs-label$/m);
    assert.doesNotMatch(res.text, /^\|{7}/m);
  } finally {
    for (const [k, v] of Object.entries({ GIT_CONFIG_COUNT: saved.c, GIT_CONFIG_KEY_0: saved.k, GIT_CONFIG_VALUE_0: saved.v })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('mergeText throws on binary input (git exits 255)', async () => {
  await assert.rejects(mergeText('a\0b\n', 'a\n', 'a\n', labels));
});

test('mergeText throws when git merge-file fails', async () => {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const missing = join(tmpdir(), 'iecode-does-not-exist', 'x');
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = missing;   // os.tmpdir() reads these on every call
  try {
    await assert.rejects(mergeText('a\n', 'a\n', 'a\n', labels));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('mergeLabels names the incoming side during a merge', async () => {
  const r = divergedRepo();
  try {
    assert.deepEqual(await mergeLabels(r.dir), { ours: 'main', theirs: 'incoming' });
    r.tryGit('merge', 'topic');
    const labelsNow = await mergeLabels(r.dir);
    assert.equal(labelsNow.ours, 'main');
    assert.equal(r.git('rev-parse', labelsNow.theirs).trim(), r.git('rev-parse', 'MERGE_HEAD').trim());
  } finally { r.cleanup(); }
});

test('stage and mergeLabels during a cherry-pick and a rebase', async () => {
  const r = divergedRepo();
  try {
    r.tryGit('cherry-pick', 'topic');
    assert.equal(await stage(r.dir, 2, r.file), BASE.replace('l2', 'main2'));
    assert.equal(await stage(r.dir, 3, r.file), BASE.replace('l2', 'topic2'));
    const cp = await mergeLabels(r.dir);
    assert.equal(cp.ours, 'main');
    assert.equal(r.git('rev-parse', cp.theirs).trim(), r.git('rev-parse', 'CHERRY_PICK_HEAD').trim());
    r.git('cherry-pick', '--abort');

    r.git('checkout', '-q', 'topic');
    r.tryGit('rebase', 'main');
    // stage 2 is the upstream, stage 3 the commit being replayed
    assert.equal(await stage(r.dir, 2, r.file), BASE.replace('l2', 'main2'));
    assert.equal(await stage(r.dir, 3, r.file), BASE.replace('l2', 'topic2'));
    const rb = await mergeLabels(r.dir);
    assert.match(rb.ours, /^[0-9a-f]{4,}$/);   // detached HEAD: short hash
    assert.equal(r.git('rev-parse', rb.theirs).trim(), r.git('rev-parse', 'REBASE_HEAD').trim());
  } finally { r.cleanup(); }
});

// ---------------------------------------------------------------- auto-resolve of object files

const SAMPLE = readFileSync(join(__dirname, '..', '..', 'samples', 'FB_Motor.TcPOU'), 'utf8');
const START_LINEIDS = '<LineIds Name="FB_Motor.Start">\r\n      <LineId Id="2" Count="2" />';
const START_FOLDER = 'FolderPath="Internal\\"';
const DIAGRAM = '<XmlArchive>...</XmlArchive>';

/** The conflict of scripts/conflict-repo.sh: body, <LineIds> and FolderPath of method Start changed on both sides. */
const startConflict = (xml: string, side: 'a' | 'b') => {
  const [body, id, folder] = side === 'a' ? ['TRUE AND FALSE', '20', 'FolderA'] : ['NOT FALSE', '30', 'FolderB'];
  return xml.replace('Start := TRUE;', `Start := ${body};`)
    .replace(START_LINEIDS, START_LINEIDS.replace('Id="2"', `Id="${id}"`))
    .replace(START_FOLDER, `FolderPath="${folder}\\"`);
};

/** Adds a method before the first <LineIds> (where TwinCAT puts it). */
const addMethod = (xml: string, name: string, decl: string, body: string, id: string) => xml.replace('    <LineIds Name="FB_Motor">',
  `    <Method Name="${name}" Id="{a1b2c3d4-0000-0000-0000-${id.padStart(12, '0')}}">\r\n` +
  `      <Declaration><![CDATA[${decl}]]></Declaration>\r\n` +
  `      <Implementation>\r\n        <ST><![CDATA[${body}]]></ST>\r\n      </Implementation>\r\n    </Method>\r\n` +
  '    <LineIds Name="FB_Motor">');

interface ObjectRepoOptions { base?: string; attributes?: string; config?: [string, string][] }

/** Commits `base` as FB_Motor.TcPOU, edits it on branches a and b (undefined deletes it), then merges b into a. */
function objectRepo(edit: (xml: string, side: 'a' | 'b') => string | undefined, opts: ObjectRepoOptions = {}) {
  const { base = SAMPLE, attributes = '*.TcPOU -text\n', config = [] } = opts;
  const r = tempRepo();
  const file = join(r.dir, 'FB_Motor.TcPOU');
  for (const [k, v] of config) r.git('config', k, v);
  writeFileSync(join(r.dir, '.gitattributes'), attributes);
  writeFileSync(file, base);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'base');
  for (const side of ['a', 'b'] as const) {
    r.git('checkout', '-q', '-b', side, 'main');
    const xml = edit(base, side);
    if (xml === undefined) r.git('rm', '-q', 'FB_Motor.TcPOU');
    else { writeFileSync(file, xml); r.git('add', '-A'); }
    r.git('commit', '-q', '-m', side);
  }
  r.git('checkout', '-q', 'a');
  r.tryGit('merge', 'b');
  return { ...r, file };
}

const withoutCdata = (xml: string) => xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
const markerLine = /^(<{7}|={7}|>{7})/m;
const refusal = (message: string | RegExp) => (e: Error) =>
  e instanceof AutoResolveError && (typeof message === 'string' ? e.message === message : message.test(e.message));

test('autoResolve leaves only code conflicts', async () => {
  const r = objectRepo(startConflict);
  try {
    const written = readFileSync(r.file, 'utf8');
    assert.match(withoutCdata(written), markerLine);   // git's result: markers in the XML
    const res = await autoResolve(r.file);
    assert.equal(res.codeConflicts, 1);
    const view = decode(res.xml);
    assert.equal(view.match(/^<{7}/gm)?.length, 1);
    assert.match(view, /^<{7} a\nStart := TRUE AND FALSE;\n={7}\nStart := NOT FALSE;\n>{7} b$/m);
    assert.doesNotMatch(withoutCdata(res.xml), markerLine);
    assert.equal(readFileSync(r.file, 'utf8'), written);   // does not write
  } finally { r.cleanup(); }
});

test('autoResolve keeps ours\' XML attributes', async () => {
  const r = objectRepo(startConflict);
  try {
    const { xml } = await autoResolve(r.file);
    assert.match(xml, /<Method Name="Start" Id="[^"]+" FolderPath="FolderA\\">/);
    assert.doesNotMatch(xml, /FolderB/);
  } finally { r.cleanup(); }
});

test('autoResolve takes a method added only by theirs', async () => {
  const r = objectRepo((xml, side) => {
    const x = startConflict(xml, side);
    return side === 'b' ? addMethod(x, 'Added', 'METHOD Added : BOOL', 'Added := TRUE;', '10') : x;
  });
  try {
    const { xml, codeConflicts } = await autoResolve(r.file);
    assert.equal(codeConflicts, 1);
    assert.match(decode(xml), /^\/\/==== METHOD Added ====\nMETHOD Added : BOOL\n\/\/---- IMPLEMENTATION ----\nAdded := TRUE;$/m);
  } finally { r.cleanup(); }
});

test('autoResolve keeps BOM and CRLF', async () => {
  // eol=crlf: the index (and so every stage) holds LF, only the working file has CRLF
  const r = objectRepo(startConflict, { base: '﻿' + SAMPLE, attributes: '*.TcPOU text eol=crlf\n' });
  try {
    assert.doesNotMatch((await stage(r.dir, 2, r.file))!, /\r\n/);
    const { xml } = await autoResolve(r.file);
    assert.ok(xml.startsWith('﻿<?xml'));
    assert.doesNotMatch(xml, /(^|[^\r])\n/);
    assert.match(xml, /\r\n/);
  } finally { r.cleanup(); }
});

test('autoResolve refuses a delete/modify conflict', async () => {
  const r = objectRepo((xml, side) => side === 'a' ? undefined : startConflict(xml, side));
  try {
    await assert.rejects(autoResolve(r.file), refusal('FB_Motor.TcPOU: deleted on one side; resolve in Source Control'));
  } finally { r.cleanup(); }
});

test('autoResolve refuses a structural conflict', async () => {
  // git merge-file keeps the common header line outside the hunk; the hunk then holds an IMPLEMENTATION marker
  const r = objectRepo((xml, side) => side === 'a'
    ? addMethod(xml, 'Added', 'METHOD Added : BOOL', 'Added := TRUE;', '10')
    : addMethod(xml, 'Added', 'METHOD Added : INT', 'Added := 1;', '11'));
  try {
    await assert.rejects(autoResolve(r.file), refusal('FB_Motor.TcPOU: conflict in the object structure; use the XML merge editor'));
  } finally { r.cleanup(); }
});

test('autoResolve refuses a conflict between two different added methods', async () => {
  // the hunk holds a section header on each side
  const r = objectRepo((xml, side) => side === 'a'
    ? addMethod(xml, 'AddedA', 'METHOD AddedA : BOOL', 'AddedA := TRUE;', '10')
    : addMethod(xml, 'AddedB', 'METHOD AddedB : INT', 'AddedB := 1;', '11'));
  try {
    await assert.rejects(autoResolve(r.file), refusal(/conflict in the object structure/));
  } finally { r.cleanup(); }
});

test('autoResolve refuses a changed graphical implementation', async () => {
  const r = objectRepo((xml, side) => xml.replace(DIAGRAM, `<XmlArchive>${side}</XmlArchive>`));
  try {
    await assert.rejects(autoResolve(r.file),
      refusal('FB_Motor.TcPOU: graphical implementation changed on both sides; use the XML merge editor'));
  } finally { r.cleanup(); }
});

test('autoResolve refuses a graphical implementation changed only by theirs', async () => {
  const r = objectRepo((xml, side) => side === 'b'
    ? startConflict(xml, side).replace(DIAGRAM, '<XmlArchive>b</XmlArchive>')
    : startConflict(xml, side));
  try {
    await assert.rejects(autoResolve(r.file), refusal(/graphical implementation/));
  } finally { r.cleanup(); }
});

test('autoResolve keeps a graphical implementation changed only by ours', async () => {
  const r = objectRepo((xml, side) => side === 'a'
    ? startConflict(xml, side).replace(DIAGRAM, '<XmlArchive>a</XmlArchive>')
    : startConflict(xml, side));
  try {
    const { xml } = await autoResolve(r.file);
    assert.match(xml, /<XmlArchive>a<\/XmlArchive>/);
  } finally { r.cleanup(); }
});

test('autoResolve refuses a file outside a git repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-merge-test-'));
  try {
    const file = join(dir, 'FB_Motor.TcPOU');
    writeFileSync(file, SAMPLE);
    await assert.rejects(autoResolve(file), refusal(/not in a git repository/));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('editedSinceConflict detects manual edits', async () => {
  const r = objectRepo(startConflict);
  try {
    const { snapshot } = await autoResolve(r.file);
    const labels = await mergeLabels(r.dir);
    const written = readFileSync(r.file, 'utf8');
    assert.equal(await editedSinceConflict(r.file, snapshot, labels, written), false);
    assert.equal(await editedSinceConflict(r.file, snapshot, labels, '﻿' + written.replace(/\r\n/g, '\n')), false);
    assert.equal(await editedSinceConflict(r.file, snapshot, labels), false);   // reads the file itself
    const edited = written.replace('bEnable := TRUE;', 'bEnable := FALSE;');
    assert.notEqual(edited, written);
    assert.equal(await editedSinceConflict(r.file, snapshot, labels, edited), true);
  } finally { r.cleanup(); }
});

test('editedSinceConflict accepts the file git wrote in diff3 style', async () => {
  const r = objectRepo(startConflict, { config: [['merge.conflictStyle', 'diff3']] });
  try {
    assert.match(readFileSync(r.file, 'utf8'), /^\|{7}/m);
    const { snapshot } = await autoResolve(r.file);
    assert.equal(await editedSinceConflict(r.file, snapshot, await mergeLabels(r.dir)), false);
  } finally { r.cleanup(); }
});

test('snapshotOf and sameSnapshot notice a changed working file', async () => {
  const r = objectRepo(startConflict);
  try {
    const { snapshot } = await autoResolve(r.file);
    assert.equal(sameSnapshot(snapshot, await snapshotOf(r.file)), true);
    writeFileSync(r.file, readFileSync(r.file, 'utf8') + ' ');
    assert.equal(sameSnapshot(snapshot, await snapshotOf(r.file)), false);
  } finally { r.cleanup(); }
});
