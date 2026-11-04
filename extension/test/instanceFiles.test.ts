import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsOps, writeInstance, removeInstance, sweepStaleInstances, setConnectedMarker, connectedMarker, aclAllowsOthers } from '../src/core/instanceFiles';
import { InstanceFile } from '../src/core/mcpWire';

class FakeFs implements FsOps {
  files = new Map<string, { text: string; mtime: number }>();
  dirs = new Set<string>();
  clock = 0;
  ops: string[] = [];
  mkdir(p: string) { this.dirs.add(p); this.ops.push(`mkdir ${p}`); }
  write(p: string, text: string) { this.files.set(p, { text, mtime: this.clock }); this.ops.push(`write ${p}`); }
  rename(a: string, b: string) { const f = this.files.get(a)!; this.files.delete(a); this.files.set(b, { ...f, mtime: this.clock }); this.ops.push(`rename ${a} ${b}`); }
  list(dir: string) { return [...this.files.keys()].filter(k => k.startsWith(dir + '\\')).map(k => k.slice(dir.length + 1)); }
  read(p: string) { const f = this.files.get(p); if (!f) throw new Error('ENOENT'); return f.text; }
  remove(p: string) { this.files.delete(p); this.ops.push(`remove ${p}`); }
  exists(p: string) { return this.files.has(p); }
  mtimeMs(p: string) { return this.files.get(p)!.mtime; }
}

const DIR = 'C:\\L\\iecode\\mcp\\v1\\instances';
const file = (id: string, pipe = `iecode-mcp-${id}`): InstanceFile => ({
  format: 1, id, pid: 1, startedAt: '2026-11-04T00:00:00Z', extensionVersion: '0.2.6', bridgeProtocol: { min: 1, max: 1 },
  pipe, roots: ['c:\\work'], workspaceName: 'work', rootsRevision: 1, secret: 'AAAA',
});
const TEN_MIN = 600_000;

test('writeInstance writes a temp file and renames it', () => {
  const fs = new FakeFs();
  writeInstance(DIR, file('a1'), fs);
  assert.deepEqual(fs.ops, [`mkdir ${DIR}`, `write ${DIR}\\a1.tmp`, `rename ${DIR}\\a1.tmp ${DIR}\\a1.json`]);
  assert.equal(JSON.parse(fs.read(`${DIR}\\a1.json`)).id, 'a1');
  assert.equal(fs.exists(`${DIR}\\a1.tmp`), false);
});

test('writeInstance again refreshes the mtime', () => {
  const fs = new FakeFs();
  writeInstance(DIR, file('a1'), fs);
  fs.clock = 5000;
  writeInstance(DIR, file('a1'), fs);
  assert.equal(fs.mtimeMs(`${DIR}\\a1.json`), 5000);
});

test('removeInstance deletes only that instance', () => {
  const fs = new FakeFs();
  writeInstance(DIR, file('a1'), fs);
  writeInstance(DIR, file('b2'), fs);
  removeInstance(DIR, 'a1', fs);
  removeInstance(DIR, 'zz', fs);
  assert.deepEqual(fs.list(DIR), ['b2.json']);
});

test('sweepStaleInstances keeps a fresh file even when its pipe is unreachable', async () => {
  const fs = new FakeFs();
  writeInstance(DIR, file('a1'), fs);
  await sweepStaleInstances(DIR, fs, 1000, TEN_MIN, async () => false);
  assert.ok(fs.exists(`${DIR}\\a1.json`));
});

test('sweepStaleInstances keeps an old file whose pipe answers', async () => {
  const fs = new FakeFs();
  writeInstance(DIR, file('a1'), fs);
  const probed: string[] = [];
  await sweepStaleInstances(DIR, fs, TEN_MIN + 1, TEN_MIN, async p => { probed.push(p); return true; });
  assert.ok(fs.exists(`${DIR}\\a1.json`));
  assert.deepEqual(probed, ['\\\\.\\pipe\\iecode-mcp-a1']);
});

test('sweepStaleInstances deletes an old file with a dead pipe', async () => {
  const fs = new FakeFs();
  writeInstance(DIR, file('a1'), fs);
  writeInstance(DIR, file('b2'), fs);
  await sweepStaleInstances(DIR, fs, TEN_MIN + 1, TEN_MIN, async p => p.endsWith('b2'));
  assert.deepEqual(fs.list(DIR), ['b2.json']);
});

test('sweepStaleInstances skips an unreadable file', async () => {
  const fs = new FakeFs();
  fs.write(`${DIR}\\bad.json`, '{not json');
  fs.write(`${DIR}\\nopipe.json`, '{}');
  await sweepStaleInstances(DIR, fs, TEN_MIN + 1, TEN_MIN, async () => false);
  assert.ok(fs.exists(`${DIR}\\bad.json`));
  assert.ok(fs.exists(`${DIR}\\nopipe.json`));
});

test('sweepStaleInstances removes an old temp file', async () => {
  const fs = new FakeFs();
  fs.write(`${DIR}\\a1.tmp`, 'half');
  await sweepStaleInstances(DIR, fs, TEN_MIN + 1, TEN_MIN, async () => true);
  assert.equal(fs.exists(`${DIR}\\a1.tmp`), false);
});

test('connected marker is set and cleared', () => {
  const fs = new FakeFs();
  const v1 = 'C:\\L\\iecode\\mcp\\v1';
  assert.equal(connectedMarker(v1, fs), false);
  setConnectedMarker(v1, true, fs);
  assert.equal(connectedMarker(v1, fs), true);
  setConnectedMarker(v1, false, fs);
  assert.equal(connectedMarker(v1, fs), false);
  setConnectedMarker(v1, false, fs); // clearing twice is fine
});

// Real icacls output of a default %LOCALAPPDATA% folder (German Windows)
const DEFAULT_DE = `C:\\Users\\me\\AppData\\Local NT-AUTORITÄT\\SYSTEM:(I)(OI)(CI)(F)
                                VORDEFINIERT\\Administratoren:(I)(OI)(CI)(F)
                                PC\\me:(I)(OI)(CI)(F)

1 Dateien erfolgreich verarbeitet, bei 0 Dateien ist ein Verarbeitungsfehler aufgetreten.`;
const DEFAULT_EN = `C:\\Users\\me\\AppData\\Local NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)
                              BUILTIN\\Administrators:(I)(OI)(CI)(F)
                              PC\\me:(I)(OI)(CI)(F)

Successfully processed 1 files; Failed processing 0 files`;

test('aclAllowsOthers accepts owner, SYSTEM and Administrators only', () => {
  assert.equal(aclAllowsOthers(DEFAULT_DE), false);
  assert.equal(aclAllowsOthers(DEFAULT_EN), false);
  assert.equal(aclAllowsOthers(''), false);
});

test('aclAllowsOthers flags Everyone and Users and Authenticated Users', () => {
  const add = (base: string, line: string) => base.replace('\n\n', `\n                              ${line}\n\n`);
  assert.equal(aclAllowsOthers(add(DEFAULT_EN, 'Everyone:(R)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_EN, 'BUILTIN\\Users:(R)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_EN, 'NT AUTHORITY\\Authenticated Users:(M)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_DE, 'VORDEFINIERT\\Benutzer:(R)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_DE, 'Jeder:(R)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_DE, 'NT-AUTORITÄT\\Authentifizierte Benutzer:(M)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_EN, '*S-1-1-0:(R)')), true);
  assert.equal(aclAllowsOthers(add(DEFAULT_EN, 'Everyone:(DENY)(W)')), false);
});

test('aclAllowsOthers sees Users on the first line', () => {
  assert.equal(aclAllowsOthers('C:\\x BUILTIN\\Users:(OI)(CI)(R)\n   PC\\me:(F)'), true);
});
