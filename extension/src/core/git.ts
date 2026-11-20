// Minimal git access (git CLI) for comparing files and IO links with earlier versions.

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { promises as fs, realpathSync } from 'fs';
import { LineBlame, parseBlamePorcelain } from './blameParse';

export interface Commit { hash: string; short: string; date: string; author: string; subject: string }

export interface GitOptions {
  /** Written to the child's stdin (execFile has no input option of its own). */
  input?: string | Buffer;
  /** Kill the child after this many ms; the error then has timedOut = true. */
  timeout?: number;
}

function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: opts.timeout }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const e = new Error(stderr.trim() || err.message) as Error & { timedOut?: boolean };
      // `killed` is also set when the output exceeds maxBuffer, which is no timeout
      if (opts.timeout !== undefined && (err as { killed?: boolean }).killed && (err as { code?: unknown }).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') e.timedOut = true;
      reject(e);
    });
    if (opts.input !== undefined) {
      p.stdin!.on('error', () => { /* the child exited before reading everything; the exit code reports it */ });
      p.stdin!.end(opts.input);
    }
  });
}

/** Runs git in a folder and returns stdout; exported for callers and tests that need a call the helpers below do not cover. */
export const runGit = git;

/** Top folder of the git repository containing a path, or undefined if it isn't in one. */
export async function repoRoot(p: string): Promise<string | undefined> {
  const dir = (await fs.stat(p).catch(() => undefined))?.isDirectory() ? p : path.dirname(p);
  try { return path.resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim()); } catch { return undefined; }
}

/** Resolves symlinks (e.g. /var → /private/var on macOS), also for paths that don't exist (any more). */
function real(p: string): string {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  const dir = path.dirname(p);
  return dir === p ? p : path.join(real(dir), path.basename(p));
}

/** A ref as given; refuses one starting with '-', which git would read as an option (e.g. show --output=<file>). */
function checkRef(ref: string): string {
  if (ref.startsWith('-')) throw new Error(`Invalid git ref '${ref}'`);
  return ref;
}

const rel = (root: string, p: string) => path.relative(real(root), real(p)).split(path.sep).join('/');

/** File content at a commit (undefined if the file didn't exist there). */
export async function show(root: string, ref: string, file: string): Promise<string | undefined> {
  try { return await git(root, ['show', `${checkRef(ref)}:${rel(root, file)}`]); } catch { return undefined; }
}

/** Contents of many files at a commit with one git call; files missing at that commit are left out. */
export async function showMany(root: string, ref: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!files.length) return out;
  const data = await new Promise<Buffer>((resolve, reject) => {
    const p = execFile('git', ['cat-file', '--batch'], { cwd: root, maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.toString().trim() || err.message)) : resolve(stdout)));
    p.stdin!.end(files.map(f => `${ref}:${rel(root, f)}\n`).join(''));
  });
  let pos = 0;
  for (const f of files) {
    const nl = data.indexOf(10, pos);
    if (nl < 0) break;
    const header = data.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = / blob (\d+)$/.exec(header);
    if (!m) continue;                           // "<object> missing" (or not a file)
    const size = Number(m[1]);
    out.set(f, data.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

/** Commits that touched any of the paths (newest first). */
export async function log(root: string, paths: string[], max = 50): Promise<Commit[]> {
  const sep = '\u001f';
  const out = await git(root, ['log', `-n${max}`, `--format=%H${sep}%h${sep}%ad${sep}%an${sep}%s`, '--date=short', '--', ...paths.map(p => rel(root, p))]);
  return out.split('\n').filter(Boolean).map(l => {
    const [hash, short, date, author, subject] = l.split(sep);
    return { hash, short, date, author, subject };
  });
}

/** Files below a folder at a commit, filtered by extension. Paths are returned below `dir` as given by the caller. */
export async function filesAt(root: string, ref: string, dir: string, exts: string[]): Promise<string[]> {
  const base = rel(root, dir);
  // -z: no C-quoting of non-ASCII paths (core.quotePath)
  const out = await git(root, ['ls-tree', '-r', '-z', '--name-only', checkRef(ref), '--', base || '.']);
  const want = exts.map(e => e.toLowerCase());
  return out.split('\0')
    .filter(f => want.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(dir, ...path.posix.relative(base, f).split('/')));
}

/** Sets a git config value in the repository. */
export const config = (root: string, key: string, value: string) => git(root, ['config', key, value]).then(() => undefined);

/** Effective git config value in the repository (local, global or system), or undefined if unset. */
export const getConfig = (root: string, key: string) =>
  git(root, ['config', '--get', key]).then(v => v.trim() || undefined, () => undefined);

/** Content of an index stage of an unmerged file (1 base, 2 ours, 3 theirs), or undefined if that stage doesn't exist. */
export async function stage(root: string, n: 1 | 2 | 3, file: string): Promise<string | undefined> {
  try { return await git(root, ['show', `:${n}:${rel(root, file)}`]); } catch { return undefined; }
}

/** Three-way text merge via `git merge-file`; `conflicts` is the number of conflict hunks (git caps it at 127). */
export async function mergeText(ours: string, base: string, theirs: string,
  labels: { ours: string; base: string; theirs: string }): Promise<{ text: string; conflicts: number }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iecode-merge-'));
  try {
    const [o, b, t] = ['ours', 'base', 'theirs'].map(n => path.join(dir, n));
    await Promise.all([fs.writeFile(o, ours), fs.writeFile(b, base), fs.writeFile(t, theirs)]);
    // merge.conflictStyle=merge keeps the markers free of ||||||| even if the user's config says diff3
    const args = ['-c', 'merge.conflictStyle=merge', 'merge-file', '-p', '-L', labels.ours, '-L', labels.base, '-L', labels.theirs, o, b, t];
    return await new Promise((resolve, reject) =>
      execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) return resolve({ text: stdout, conflicts: 0 });
        const code = (err as { code?: unknown }).code;
        // 1..127 is the conflict count; 255 is git's "negative on error", anything else is a failure
        if (typeof code === 'number' && code >= 1 && code <= 127) return resolve({ text: stdout, conflicts: code });
        reject(new Error(stderr.trim() || err.message));
      }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Names the two sides of an ongoing merge, cherry-pick, rebase or revert for conflict markers. */
export async function mergeLabels(root: string): Promise<{ ours: string; theirs: string }> {
  const short = (ref: string) => git(root, ['rev-parse', '--short', ref]).then(s => s.trim());
  const ours = await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).then(s => s.trim(), () => short('HEAD'));
  for (const head of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'REVERT_HEAD']) {
    const hash = await git(root, ['rev-parse', '-q', '--verify', head]).then(s => s.trim(), () => '');
    if (!hash) continue;
    const name = await git(root, ['name-rev', '--name-only', hash]).then(s => s.trim(), () => '');
    return { ours, theirs: name && name !== 'undefined' ? name : await short(hash) };
  }
  return { ours, theirs: 'incoming' };
}

/** True if `ref` names a commit (also false for a git failure, e.g. no repository). */
export async function isCommit(root: string, ref: string): Promise<boolean> {
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${checkRef(ref)}^{commit}`]); return true; } catch { return false; }
}

// ---------------------------------------------------------------- blame

/** `git blame --porcelain -w` of a file, parsed; empty for an untracked file or a path outside a repository. A timeout throws (error.timedOut). */
export async function blame(root: string, file: string): Promise<LineBlame[]> {
  try {
    return parseBlamePorcelain(await git(root, ['-c', 'core.quotePath=false', 'blame', '--porcelain', '-w', '--', rel(root, file)], { timeout: 15_000 }));
  } catch (e) {
    if ((e as { timedOut?: boolean }).timedOut) throw e;
    return [];
  }
}

export interface LineHistoryEntry { commit: string; author: string; time: number; summary: string; removed?: string; added?: string }

/**
 * History of one line (`git log -L`), newest first, at most 3 entries. The commit and line number are those of the
 * blame porcelain, so uncommitted lines above or a renamed file cannot shift the line.
 */
export async function lineHistory(root: string, commit: string, origPath: string, origLine: number): Promise<LineHistoryEntry[]> {
  const sep = '\u001f';
  let out: string;
  try {
    out = await git(root, ['-c', 'core.quotePath=false', 'log', `-L${origLine},${origLine}:${origPath}`, checkRef(commit), '-w', '-p', '-n', '3', '--no-color',
      `--format=@@@%H${sep}%an${sep}%at${sep}%s`], { timeout: 15_000 });
  } catch { return []; }
  const entries: LineHistoryEntry[] = [];
  let cur: (LineHistoryEntry & { rem: string[]; add: string[] }) | undefined;
  let inHunk = false;
  const flush = () => {
    if (!cur) return;
    const { rem, add, ...e } = cur;
    entries.push({ ...e, removed: rem.length ? rem.join('\n') : undefined, added: add.length ? add.join('\n') : undefined });
  };
  for (const line of out.split('\n')) {
    const h = /^@@@([0-9a-f]{40})\u001f([^\u001f]*)\u001f(\d+)\u001f(.*)$/.exec(line);
    if (h) {
      flush();
      cur = { commit: h[1], author: h[2], time: Number(h[3]), summary: h[4], rem: [], add: [] };
      inHunk = false;
    } else if (cur && line.startsWith('@@')) inHunk = true;
    else if (cur && inHunk && line.startsWith('+')) cur.add.push(line.slice(1).replace(/\r$/, ''));
    else if (cur && inHunk && line.startsWith('-')) cur.rem.push(line.slice(1).replace(/\r$/, ''));
  }
  flush();
  return entries;
}
