import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeLogFs } from '../src/ads/logFs';

function tempDir(): { dir: string; outside: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'iecode-log-'));
  const dir = join(root, 'logs');
  mkdirSync(dir);
  const outside = join(root, 'secret.log');
  writeFileSync(outside, 'secret\n');
  return { dir, outside, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('nodeLogFs lists regular .log files only', async t => {
  const { dir, done } = tempDir();
  t.after(done);
  writeFileSync(join(dir, 'Log_1.log'), '0123456789');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  mkdirSync(join(dir, 'x.log'));
  assert.deepEqual(await nodeLogFs(dir).list(), [{ name: 'Log_1.log', size: 10 }]);
});

test('nodeLogFs neither lists nor reads a symbolic link', async t => {
  const { dir, outside, done } = tempDir();
  t.after(done);
  writeFileSync(join(dir, 'Log_1.log'), 'a');
  try { symlinkSync(outside, join(dir, 'Log_9.log')); } catch { t.skip('symlink creation is refused on this machine (needs a privilege on Windows)'); return; }
  const fs = nodeLogFs(dir);
  assert.deepEqual((await fs.list()).map(f => f.name), ['Log_1.log']);
  await assert.rejects(fs.read('Log_9.log', 0, 10), /not a log file/);
});

test('nodeLogFs reads a byte range and fewer bytes at the end', async t => {
  const { dir, done } = tempDir();
  t.after(done);
  writeFileSync(join(dir, 'Log_1.log'), '0123456789');
  const fs = nodeLogFs(dir);
  assert.equal((await fs.read('Log_1.log', 8, 100)).toString(), '89');
  assert.equal((await fs.read('Log_1.log', 20, 5)).length, 0);
  assert.equal((await fs.read('Log_1.log', 2, 3)).toString(), '234');
});

test('nodeLogFs refuses a name that is not a listed file', async t => {
  const { dir, outside, done } = tempDir();
  t.after(done);
  writeFileSync(join(dir, 'Log_1.log'), 'a');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const fs = nodeLogFs(dir);
  await assert.rejects(fs.read('../secret.log', 0, 1), /not a log file/);
  await assert.rejects(fs.read(outside, 0, 1), /not a log file/);
  await assert.rejects(fs.read('notes.txt', 0, 1), /not a log file/);
});
