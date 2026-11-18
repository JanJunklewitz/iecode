import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tempRepo } from './helpers/gitRepo';
import { blame, runGit } from '../src/core/git';
import { LineBlame, SectionBlame, blameSections, makeRefine, parseBlamePorcelain, stripTags } from '../src/core/blame';
import { spansOf, SectionSpan } from '../src/core/objectSpans';

const H = (n: number) => String(n).repeat(40);

test('parseBlamePorcelain reads author, time, summary and the not committed yet marker', () => {
  const out = [
    `${H(1)} 1 1 2`, 'author Ada', 'author-mail <a@x>', 'author-time 100', 'author-tz +0000', 'committer Ada', 'committer-time 100',
    'summary First', 'filename f.xml', '\tone',
    `${H(1)} 2 2`, '\ttwo',                                   // later line of the same commit: abbreviated header
    `${H(2)} 7 3 1`, 'author Bob', 'author-time 200', 'summary Second', 'previous x f.xml', 'filename old.xml', '\tthree',
    `${'0'.repeat(40)} 4 4 1`, 'author Not Committed Yet', 'author-time 300', 'summary Version of f.xml', 'filename f.xml', '\tfour',
  ].join('\n') + '\n';
  const r = parseBlamePorcelain(out);
  assert.equal(r.length, 4);
  assert.deepEqual([r[0].author, r[0].time, r[0].summary, r[0].origLine, r[0].origPath], ['Ada', 100, 'First', 1, 'f.xml']);
  assert.deepEqual([r[1].author, r[1].summary, r[1].origLine], ['Ada', 'First', 2]);   // abbreviated header reuses the commit info
  assert.deepEqual([r[2].author, r[2].origLine, r[2].origPath], ['Bob', 7, 'old.xml']);
  assert.equal(r[3].uncommitted, true);
  assert.equal(r[0].uncommitted, false);
});

const lb = (commit: number, time: number, over: Partial<LineBlame> = {}): LineBlame =>
  ({ commit: H(commit), author: `a${commit}`, time, summary: `s${commit}`, uncommitted: false, origLine: 1, origPath: 'f', ...over });

/** One section with a 3 line implementation at XML lines 10 to 12, no declaration. */
const span = (): SectionSpan => ({
  key: 'METHOD:M', kind: 'METHOD', name: 'M', viewFirst: 0, viewLast: 4, header: 0,
  impl: { viewFirst: 2, viewLast: 4, xmlLines: [10, 11, 12], boundaryFirst: true, boundaryLast: true },
});
const xmlBlame = (...rows: LineBlame[]) => { const a: LineBlame[] = []; rows.forEach((r, i) => { a[9 + i] = r; }); return a; };

test('blameSections takes the newest commit over the section lines', async () => {
  // three different commits: no run that a tag change could have produced, but the boundary lines are checked anyway
  const refine = async (c: LineBlame) => c;
  const r = await blameSections([span()], xmlBlame(lb(1, 10), lb(2, 30), lb(3, 20)), refine);
  assert.equal(r[0].last.commit, H(2));
  assert.deepEqual(r[0].authors, ['a2', 'a3', 'a1']);
  assert.equal(r[0].lines[0], undefined);          // header line
  assert.equal(r[0].lines[3]?.commit, H(2));
});

test('a boundary line newer than the interior is refined', async () => {
  const calls: string[] = [];
  const refine = async (c: LineBlame) => { calls.push(c.commit); return c.commit === H(2) ? lb(1, 10) : c; };
  const r = await blameSections([span()], xmlBlame(lb(1, 10), lb(1, 10), lb(2, 20)), refine);
  assert.equal(calls.filter(c => c === H(2)).length, 1);   // the stolen last line is refined once
  assert.equal(r[0].lines[4]?.commit, H(1));
  assert.equal(r[0].last.commit, H(1));
});

// ---------------------------------------------------------------- real repositories

const pou = (body: string[], eol = '\n') => [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<TcPlcObject Version="1.1.0.1">',
  '  <POU Name="FB_A" Id="{00000000-0000-0000-0000-000000000001}">',
  '    <Declaration><![CDATA[FUNCTION_BLOCK FB_A]]></Declaration>',
  '    <Method Name="M" Id="{00000000-0000-0000-0000-000000000002}">',
  '      <Declaration><![CDATA[METHOD M]]></Declaration>',
  '      <Implementation>',
  `        <ST><![CDATA[${body.join(eol)}]]></ST>`,
  '      </Implementation>',
  '    </Method>',
  '  </POU>',
  '</TcPlcObject>',
  '',
].join(eol);

const FILE = 'FB_A.TcPOU';

/** Blame of the body lines of METHOD M, as `[text, commit index]` with the commits numbered in creation order. */
async function bodyBlame(r: ReturnType<typeof tempRepo>, commits: string[]): Promise<{ text: string; commit: number }[]> {
  const path = join(r.dir, FILE);
  const xml = readFileSync(path, 'utf8');
  const spans = spansOf(xml);
  const raw = await blame(r.dir, path);
  const res = await blameSections(spans, raw, makeRefine(r.dir));
  const sb = res.find(s => s.key === 'METHOD:M') as SectionBlame;
  const m = spans.find(s => s.key === 'METHOD:M')!;
  const viewLines = xml.replace(/\r\n/g, '\n').split('\n');
  void viewLines;
  return m.impl!.xmlLines.map((xl, i) => {
    const l = sb.lines[m.impl!.viewFirst - m.viewFirst + i]!;
    const text = xml.replace(/\r\n/g, '\n').split('\n')[xl - 1].replace(/^.*<!\[CDATA\[/, '').replace(/\]\]><\/ST>$/, '');
    return { text, commit: commits.indexOf(l.commit) };
  });
}

const head = (r: ReturnType<typeof tempRepo>) => r.git('rev-parse', 'HEAD').trim();

test('an appended last line does not steal the old last line (mandatory acceptance test)', async () => {
  const r = tempRepo();
  try {
    const commits: string[] = [];
    r.write(FILE, pou(['a;', 'b;'])); r.commitAll('c1'); commits.push(head(r));
    r.write(FILE, pou(['a;', 'b;', 'c;'])); r.commitAll('c2'); commits.push(head(r));
    r.write(FILE, pou(['a;', 'b;', 'c;', 'd;', 'e;'])); r.commitAll('c3'); commits.push(head(r));
    const got = await bodyBlame(r, commits);
    assert.deepEqual(got.map(g => [g.text, g.commit]), [['a;', 0], ['b;', 0], ['c;', 1], ['d;', 2], ['e;', 2]]);
  } finally { r.cleanup(); }
});

test('a prepended first line does not steal the old first line', async () => {
  const r = tempRepo();
  try {
    const commits: string[] = [];
    r.write(FILE, pou(['a;', 'b;'])); r.commitAll('c1'); commits.push(head(r));
    r.write(FILE, pou(['p;', 'a;', 'b;'])); r.commitAll('c2'); commits.push(head(r));
    r.write(FILE, pou(['q;', 'r;', 'p;', 'a;', 'b;'])); r.commitAll('c3'); commits.push(head(r));
    const got = await bodyBlame(r, commits);
    assert.deepEqual(got.map(g => [g.text, g.commit]), [['q;', 2], ['r;', 2], ['p;', 1], ['a;', 0], ['b;', 0]]);
  } finally { r.cleanup(); }
});

test('an uncommitted line above the section does not shift the refined line', async () => {
  const r = tempRepo();
  try {
    const commits: string[] = [];
    r.write(FILE, pou(['a;', 'b;'])); r.commitAll('c1'); commits.push(head(r));
    r.write(FILE, pou(['a;', 'b;', 'c;'])); r.commitAll('c2'); commits.push(head(r));
    r.write(FILE, pou(['a;', 'b;', 'c;', 'd;'])); r.commitAll('c3'); commits.push(head(r));
    // working copy: an extra property-like line inserted above the method (uncommitted)
    const withExtra = pou(['a;', 'b;', 'c;', 'd;']).replace('  </POU>', '    <!-- note -->\n  </POU>')
      .replace('    <Method Name="M"', '    <!-- above -->\n    <Method Name="M"');
    r.write(FILE, withExtra);
    const got = await bodyBlame(r, commits);
    assert.deepEqual(got.map(g => [g.text, g.commit]), [['a;', 0], ['b;', 0], ['c;', 1], ['d;', 2]]);
  } finally { r.cleanup(); }
});

test('stripTags drops the CDATA tags but keeps a ]]> that is code', () => {
  assert.equal(stripTags('        <ST><![CDATA[a;'), 'a;');
  assert.equal(stripTags('b;]]></ST>'), 'b;');
  assert.equal(stripTags('c;]]></Declaration>   '), 'c;');
  assert.equal(stripTags("'a]]]]><![CDATA[>b';]]></ST>"), "'a]]>b';");
  assert.equal(stripTags('plain;'), 'plain;');
});

test('a commit that only changes line endings does not take over the lines', async () => {
  const r = tempRepo();
  try {
    const commits: string[] = [];
    r.write(FILE, pou(['a;', 'b;', 'c;'])); r.commitAll('c1'); commits.push(head(r));
    r.write(FILE, pou(['a;', 'b;', 'c;'], '\r\n')); r.commitAll('c2'); commits.push(head(r));
    const got = await bodyBlame(r, commits);
    assert.deepEqual(got.map(g => g.commit), [0, 0, 0]);
  } finally { r.cleanup(); }
});

test('blame of an untracked file and of a file outside a repository gives an empty list, not an exception', async () => {
  const r = tempRepo();
  try {
    r.write('x.txt', 'tracked\n'); r.commitAll('c1');
    r.write('untracked.TcPOU', pou(['a;']));
    assert.deepEqual(await blame(r.dir, join(r.dir, 'untracked.TcPOU')), []);
  } finally { r.cleanup(); }
  const outside = tempRepo();   // reuse a folder, but ask for a path in a directory that is no repository
  outside.cleanup();
  assert.deepEqual(await blame(outside.dir, join(outside.dir, 'nope.TcPOU')), []);
});

test('runGit writes the input option to the child stdin', async () => {
  const r = tempRepo();
  try {
    const sha = await runGit(r.dir, ['hash-object', '--stdin'], { input: 'hello\n' });
    assert.equal(sha.trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
  } finally { r.cleanup(); }
});
