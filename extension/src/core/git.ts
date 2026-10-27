// Minimal git access (git CLI) for comparing files and IO links with earlier versions.

import { execFile } from 'child_process';
import * as path from 'path';
import { promises as fs, realpathSync } from 'fs';

export interface Commit { hash: string; short: string; date: string; author: string; subject: string }

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)));
}

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
