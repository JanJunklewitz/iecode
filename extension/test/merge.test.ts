import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeLabels, mergeText, stage } from '../src/core/git';

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
