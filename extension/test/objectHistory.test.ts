import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers/gitRepo';
import { blobsAt, historyCommits } from '../src/core/git';
import { historyItemLabel, objectHistory, sectionTextOf } from '../src/core/objectHistory';
import { decode } from '../src/model';

interface M { name: string; id: number; body: string[]; cfc?: string }
const guid = (n: number) => `{00000000-0000-0000-0000-${String(n).padStart(12, '0')}}`;
const longBody = (tag: string) => Array.from({ length: 6 }, (_, i) => `step${i} := ${tag};`);

/** A .TcPOU with CRLF line endings; `prop` adds a property whose GET holds the given body. */
function pou(methods: M[], opts: { name?: string; getBody?: string[] } = {}) {
  const L = ['<?xml version="1.0" encoding="utf-8"?>', '<TcPlcObject Version="1.1.0.1">',
    `  <POU Name="${opts.name ?? 'FB_A'}" Id="${guid(1)}">`, '    <Declaration><![CDATA[FUNCTION_BLOCK FB_A]]></Declaration>'];
  for (const m of methods) {
    L.push(`    <Method Name="${m.name}" Id="${guid(m.id)}">`, `      <Declaration><![CDATA[METHOD ${m.name}]]></Declaration>`, '      <Implementation>');
    L.push(m.cfc ? `        <CFC><XmlArchive>${m.cfc}</XmlArchive></CFC>` : `        <ST><![CDATA[${m.body.join('\r\n')}]]></ST>`, '      </Implementation>', '    </Method>');
  }
  if (opts.getBody) {
    L.push(`    <Property Name="Speed" Id="${guid(90)}">`, '      <Declaration><![CDATA[PROPERTY Speed : INT]]></Declaration>', `      <Get Name="Get" Id="${guid(91)}">`,
      '        <Implementation>', `          <ST><![CDATA[${opts.getBody.join('\r\n')}]]></ST>`, '        </Implementation>', '      </Get>', '    </Property>');
  }
  L.push('  </POU>', '</TcPlcObject>', '');
  return L.join('\r\n');
}
const F = 'FB_A.TcPOU';
const summary = (e: { short: string; change: string; renamedFrom?: string }[], subjects: Map<string, string>) =>
  e.map(x => `${subjects.get(x.short)}:${x.change}${x.renamedFrom ? ':' + x.renamedFrom : ''}`);
const subjectsOf = (r: ReturnType<typeof tempRepo>) =>
  new Map(r.git('log', '--format=%h %s').trim().split('\n').map(l => [l.slice(0, 7), l.slice(8)] as [string, string]));
const short = (r: ReturnType<typeof tempRepo>) => r.git('log', '--format=%h %s').trim().split('\n').length;

test('a changed method gets one entry per commit that changed its text, other methods give none', async () => {
  const r = tempRepo();
  try {
    const a = (t: string) => ({ name: 'A', id: 2, body: longBody(t) }), b = (t: string) => ({ name: 'B', id: 3, body: longBody(t) });
    r.write(F, pou([a('1'), b('1')])); r.commitAll('c1');
    r.write(F, pou([a('1'), b('2')])); r.commitAll('c2 only B');
    r.write(F, pou([a('3'), b('2')])); r.commitAll('c3 A');
    const h = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:A');
    assert.deepEqual(summary(h.entries, subjectsOf(r)), ['c3 A:changed', 'c1:added']);
    assert.equal(h.cut, false);
    assert.ok(h.entries[0].before?.includes('step0 := 1;') && h.entries[0].after?.includes('step0 := 3;'));
  } finally { r.cleanup(); }
});

test('a rename keeps the history', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'Start', id: 2, body: longBody('1') }])); r.commitAll('c1');
    r.write(F, pou([{ name: 'Begin', id: 2, body: [...longBody('1').slice(0, 5), 'changed;'] }])); r.commitAll('c2 rename');
    r.write(F, pou([{ name: 'Begin', id: 2, body: [...longBody('1').slice(0, 4), 'again;', 'changed;'] }])); r.commitAll('c3 edit');
    const h = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:Begin');
    assert.deepEqual(summary(h.entries, subjectsOf(r)), ['c3 edit:changed', 'c2 rename:renamed:METHOD:Start', 'c1:added']);
  } finally { r.cleanup(); }
});

test('a rename that the Id does not show is paired by text, an unrelated delete plus add is not a rename', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'Old', id: 2, body: longBody('1') }])); r.commitAll('c1');
    r.write(F, pou([{ name: 'New', id: 5, body: longBody('1') }])); r.commitAll('c2 recreated');
    r.write(F, pou([{ name: 'Other', id: 6, body: Array.from({ length: 6 }, (_, i) => `x${i}();`) }])); r.commitAll('c3 unrelated');
    const same = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:New');
    assert.equal(same.entries.find(e => e.change === 'renamed')?.renamedFrom, 'METHOD:Old');
    const other = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:Other');
    assert.deepEqual(summary(other.entries, subjectsOf(r)), ['c3 unrelated:added']);
  } finally { r.cleanup(); }
});

test('a renamed file is followed', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('1') }])); r.commitAll('c1');
    r.git('mv', F, 'FB_B.TcPOU');
    r.write('FB_B.TcPOU', pou([{ name: 'A', id: 2, body: longBody('1') }], { name: 'FB_B' })); r.commitAll('c2 file rename');
    r.write('FB_B.TcPOU', pou([{ name: 'A', id: 2, body: longBody('2') }], { name: 'FB_B' })); r.commitAll('c3 edit');
    const h = await objectHistory(r.dir, `${r.dir}/FB_B.TcPOU`, 'METHOD:A');
    assert.deepEqual(summary(h.entries, subjectsOf(r)), ['c3 edit:changed', 'c1:added']);
    const hc = await historyCommits(r.dir, `${r.dir}/FB_B.TcPOU`, 10);
    assert.equal(hc[1].path, 'FB_B.TcPOU');
    assert.equal(hc[1].parentPath, F);
    assert.equal(hc[2].path, F);
  } finally { r.cleanup(); }
});

test('a commit with conflict markers is reported as unreadable and the walk goes on', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('1') }])); r.commitAll('c1');
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('1') }]).replace('<POU', '<<<<<<< ours\r\n<POU')); r.commitAll('c2 broken');
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('3') }])); r.commitAll('c3 fixed');
    const h = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:A');
    const s = summary(h.entries, subjectsOf(r));
    assert.ok(s.includes('c2 broken:unreadable'));
    assert.ok(s.includes('c1:added'));
  } finally { r.cleanup(); }
});

test('the list is cut at max and the oldest commit of the window is not reported as added', async () => {
  const r = tempRepo();
  try {
    for (let i = 1; i <= 4; i++) { r.write(F, pou([{ name: 'A', id: 2, body: longBody(String(i)) }])); r.commitAll(`c${i}`); }
    const h = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:A', 2);
    assert.equal(h.cut, true);
    assert.deepEqual(summary(h.entries, subjectsOf(r)), ['c4:changed', 'c3:changed']);
  } finally { r.cleanup(); }
});

test('a merge does not create entries for the other branch', async () => {
  const r = tempRepo();
  try {
    const m = (a: string, b: string) => pou([{ name: 'A', id: 2, body: longBody(a) }, { name: 'B', id: 3, body: longBody(b) }]);
    r.write(F, m('1', '1')); r.commitAll('base');
    r.git('checkout', '-q', '-b', 'topic'); r.write(F, m('1', '2')); r.commitAll('topic B');
    r.git('checkout', '-q', 'main'); r.write(F, m('3', '1')); r.commitAll('main A');
    r.tryGit('merge', '--no-edit', 'topic');
    r.write(F, m('3', '2')); r.git('add', '-A'); r.tryGit('commit', '-q', '--no-edit');
    const a = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:A');
    const b = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:B');
    assert.deepEqual(summary(a.entries, subjectsOf(r)), ['main A:changed', 'base:added']);
    assert.ok(!summary(b.entries, subjectsOf(r)).includes('main A:changed'));
  } finally { r.cleanup(); }
});

test('a method deleted and re-created under an old name is a new identity', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('1') }])); r.commitAll('c1');
    r.write(F, pou([])); r.commitAll('c2 deleted');
    r.write(F, pou([{ name: 'A', id: 7, body: Array.from({ length: 6 }, (_, i) => `z${i}();`) }])); r.commitAll('c3 recreated');
    const h = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:A');
    assert.deepEqual(summary(h.entries, subjectsOf(r)), ['c3 recreated:added']);
  } finally { r.cleanup(); }
});

test('a changed non-ST body is an entry and a property is one identity', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'C', id: 2, body: [], cfc: 'one' }], { getBody: ['Speed := 1;'] })); r.commitAll('c1');
    r.write(F, pou([{ name: 'C', id: 2, body: [], cfc: 'two' }], { getBody: ['Speed := 1;'] })); r.commitAll('c2 cfc');
    r.write(F, pou([{ name: 'C', id: 2, body: [], cfc: 'two' }], { getBody: ['Speed := 2;'] })); r.commitAll('c3 get');
    const c = await objectHistory(r.dir, `${r.dir}/${F}`, 'METHOD:C');
    assert.deepEqual(summary(c.entries, subjectsOf(r)), ['c2 cfc:changed', 'c1:added']);
    const p = await objectHistory(r.dir, `${r.dir}/${F}`, 'PROPERTY:Speed');
    assert.deepEqual(summary(p.entries, subjectsOf(r)), ['c3 get:changed', 'c1:added']);
  } finally { r.cleanup(); }
});

test('blobsAt reads several refs of one file with one call and leaves out missing blobs', async () => {
  const r = tempRepo();
  try {
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('1') }])); r.commitAll('c1');
    r.write(F, pou([{ name: 'A', id: 2, body: longBody('2') }])); r.commitAll('c2');
    const got = await blobsAt(r.dir, [{ ref: 'HEAD', file: F }, { ref: 'HEAD^', file: F }, { ref: 'HEAD^^', file: F }, { ref: 'HEAD', file: 'nope' }]);
    assert.equal(got.size, 2);
    assert.ok(got.get(`HEAD^:${F}`)!.includes('step0 := 1;'));
    assert.equal(short(r), 2);
  } finally { r.cleanup(); }
});

test('sectionTextOf joins the parts of a property and returns undefined for a missing key', () => {
  const xml = pou([], { getBody: ['Speed := 1;'] });
  const text = sectionTextOf(xml, decode(xml), 'PROPERTY:Speed')!;
  assert.ok(text.includes('PROPERTY Speed') && text.includes('Speed := 1;'));
  assert.equal(sectionTextOf(xml, decode(xml), 'METHOD:Nope'), undefined);
});

test('historyItemLabel shows the rename and marks an unreadable commit', () => {
  const e = { commit: 'a'.repeat(40), short: 'a1b2c3d', date: '2026-11-02', author: 'Ada Lovelace', subject: 'Fix cooling alarm', key: 'METHOD:Begin', change: 'renamed' as const, renamedFrom: 'METHOD:Start' };
  assert.deepEqual(historyItemLabel(e), { label: 'a1b2c3d  Fix cooling alarm', description: 'Ada Lovelace, 2026-11-02, renamed from Start' });
  assert.match(historyItemLabel({ ...e, change: 'unreadable' }).description, /not readable/);
});
