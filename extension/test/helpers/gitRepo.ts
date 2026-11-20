import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * Throwaway repository with real git. Local config `core.autocrlf=false` so Windows and Linux see the same
 * bytes; a test can change it with `git('config', 'core.autocrlf', 'true')`.
 */
export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-test-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a],
    { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  /** Runs git and returns normally even on a non-zero exit (a conflicting merge exits 1). */
  const tryGit = (...a: string[]) => { try { git(...a); } catch { /* expected conflict */ } };
  const file = join(dir, 'f.txt');
  const commit = (content: string, msg: string) => { writeFileSync(file, content); git('add', 'f.txt'); git('commit', '-q', '-m', msg); };
  /** Writes a file (relative to the repository) byte-exact; creates missing directories. */
  const write = (relPath: string, content: string | Buffer) => {
    const p = join(dir, relPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const commitAll = (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); };
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  // a git child killed by a timeout can hold the folder for a moment on Windows, so a failed delete is retried
  const cleanup = () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return { dir, file, git, tryGit, commit, write, commitAll, cleanup };
}
