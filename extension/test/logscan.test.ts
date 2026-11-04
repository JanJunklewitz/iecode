import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUILT_IN_FORMATS, LEVELS, compileFormat } from '../src/core/logformat';
import { EntryStore, LogLimitError } from '../src/core/logstore';
import { RawLine, readLines, scanFile, sniff } from '../src/core/logscan';
import { writeSyntheticLog } from './logGen';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures', 'logs');
const logger = compileFormat(BUILT_IN_FORMATS[0]);
const plain = compileFormat(BUILT_IN_FORMATS[2]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iecode-logscan-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let tmpCount = 0;
function tmpFile(content: string | Buffer): string {
  const p = path.join(tmp, `f${tmpCount++}.log`);
  fs.writeFileSync(p, content);
  return p;
}

function entryLine(seq: number, time: string, level: string, source: string, message: string): string {
  return `${String(seq).padStart(10, '0')} - ${time} - ${level} - ${source} - ${message}`;
}
const T1 = '2026-01-15-10:00:01.123';
const T2 = '2026-01-15-10:00:02.456';
const BOOT = '0000-00-00-00:00:00.000';

/** Independent line splitter for the expectations: [start, content length] of every line of a buffer. */
function lineExtents(buf: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) {
      if (start < buf.length) out.push([start, buf.length - start]);
      return out;
    }
    out.push([start, nl > start && buf[nl - 1] === 0x0d ? nl - 1 - start : nl - start]);
    start = nl + 1;
  }
}

async function collect(p: string, o = {}): Promise<RawLine[]> {
  const lines: RawLine[] = [];
  for await (const b of readLines(p, o)) lines.push(...b);
  return lines;
}

function sameStore(a: EntryStore, b: EntryStore): void {
  assert.equal(a.count, b.count);
  for (let i = 0; i < a.count; i++) {
    assert.equal(a.sources[a.source[i]], b.sources[b.source[i]], `source ${i}`);
    for (const col of ['time', 'sortTime', 'level', 'seq', 'file', 'offset', 'length', 'firstLength', 'terminated', 'lines', 'hash'] as const) {
      assert.deepEqual(a[col][i], b[col][i], `${col} ${i}`);
    }
  }
}

for (const name of ['logger-lf.log', 'logger-crlf.log']) {
  test(`${name}: three entries at exact byte offsets`, async () => {
    const p = path.join(fixtures, name);
    const buf = fs.readFileSync(p);
    const ext = lineExtents(buf).slice(1); // the first line is the ignored header
    assert.equal(ext.length, 3);
    const store = new EntryStore();
    const r = await scanFile(p, 0, logger, store);
    assert.equal(store.count, 3);
    for (let i = 0; i < 3; i++) {
      assert.equal(store.offset[i], ext[i][0]);
      assert.equal(store.length[i], ext[i][1]);
      assert.equal(store.firstLength[i], ext[i][1]);
      assert.equal(store.terminated[i], 1);
      assert.equal(store.lines[i], 1);
      assert.equal(store.seq[i], i + 1);
    }
    assert.equal(store.sources[store.source[1]], 'fbMain.fbPump.fbValve');
    assert.equal(r.size, buf.length);
    assert.equal(r.lastEntryStart, ext[2][0]);
  });
}

test('LF and CRLF files give the same entries apart from offsets', async () => {
  const a = new EntryStore();
  const b = new EntryStore();
  await scanFile(path.join(fixtures, 'logger-lf.log'), 0, logger, a);
  await scanFile(path.join(fixtures, 'logger-crlf.log'), 0, logger, b);
  for (let i = 0; i < 3; i++) {
    assert.equal(a.length[i], b.length[i]);
    assert.equal(a.hash[i], b.hash[i]);
    assert.equal(a.time[i], b.time[i]);
  }
});

test('mixed LF and CRLF line breaks', async () => {
  const content = [entryLine(1, T1, 'INFO', 'a', 'one'), '\r\n', entryLine(2, T2, 'INFO', 'a', 'two'), '\n', entryLine(3, T2, 'INFO', 'a', 'three'), '\r\n'].join('');
  const p = tmpFile(content);
  const ext = lineExtents(Buffer.from(content));
  const store = new EntryStore();
  await scanFile(p, 0, logger, store);
  assert.equal(store.count, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(store.offset[i], ext[i][0]);
    assert.equal(store.length[i], ext[i][1]);
  }
});

test('file without a final newline: last entry complete, no phantom entry', async () => {
  const p = path.join(fixtures, 'logger-nonewline.log');
  const buf = fs.readFileSync(p);
  const ext = lineExtents(buf).slice(1);
  const store = new EntryStore();
  await scanFile(p, 0, logger, store);
  assert.equal(store.count, 3);
  assert.equal(store.offset[2], ext[2][0]);
  assert.equal(store.offset[2] + store.length[2], buf.length);
  assert.equal(store.terminated[2], 0);
  assert.equal(store.terminated[1], 1);
});

test('a file that ends with a line break gets no phantom entry', async () => {
  const store = new EntryStore();
  await scanFile(tmpFile(entryLine(1, T1, 'INFO', 'a', 'x') + '\n'), 0, logger, store);
  assert.equal(store.count, 1);
});

test('empty file: no entries, no error', async () => {
  const store = new EntryStore();
  const r = await scanFile(path.join(fixtures, 'empty.log'), 0, logger, store);
  assert.equal(store.count, 0);
  assert.equal(r.size, 0);
});

test('multiline.log: continuation lines extend the entry, leading lines are skipped', async () => {
  const p = path.join(fixtures, 'multiline.log');
  const buf = fs.readFileSync(p);
  const ext = lineExtents(buf); // 2 stray, entry, 2 details, entry, entry
  const store = new EntryStore();
  await scanFile(p, 0, logger, store);
  assert.equal(store.count, 3);
  assert.equal(store.offset[0], ext[2][0]);
  assert.equal(store.lines[0], 3);
  assert.equal(store.length[0], ext[4][0] + ext[4][1] - ext[2][0]);
  assert.equal(store.firstLength[0], ext[2][1]);
  assert.equal(store.lines[1], 1);
  assert.equal(store.offset[1], ext[5][0]);
});

test('boot entries sort like the next dated entry, or the previous one at the end', async () => {
  const p = tmpFile([
    entryLine(1, BOOT, 'INFO', 'boot', 'a'), entryLine(2, BOOT, 'INFO', 'boot', 'b'),
    entryLine(3, T1, 'INFO', 'x', 'c'),
    entryLine(4, BOOT, 'INFO', 'boot', 'd'),
    entryLine(5, T2, 'INFO', 'x', 'e'),
    entryLine(6, BOOT, 'INFO', 'boot', 'f'),
  ].join('\n') + '\n');
  const store = new EntryStore();
  await scanFile(p, 0, logger, store);
  const t1 = Date.UTC(2026, 0, 15, 10, 0, 1, 123);
  const t2 = Date.UTC(2026, 0, 15, 10, 0, 2, 456);
  assert.equal(store.count, 6);
  assert.deepEqual(Array.from(store.sortTime.subarray(0, 6)), [t1, t1, t1, t2, t2, t2]);
  assert.ok(Number.isNaN(store.time[0]) && Number.isNaN(store.time[3]) && Number.isNaN(store.time[5]));
  assert.equal(store.time[2], t1);
});

test('a file without any dated entry sorts its boot entries first', async () => {
  const store = new EntryStore();
  await scanFile(tmpFile([entryLine(1, BOOT, 'INFO', 'boot', 'a'), entryLine(2, BOOT, 'INFO', 'boot', 'b')].join('\n') + '\n'), 0, logger, store);
  assert.equal(store.count, 2);
  assert.equal(store.sortTime[0], -Infinity);
  assert.equal(store.sortTime[1], -Infinity);
});

test('multi-byte characters straddling 4-byte chunk boundaries', async () => {
  for (const name of ['logger-lf.log', 'logger-crlf.log', 'multiline.log']) {
    const p = path.join(fixtures, name);
    const whole = new EntryStore();
    const small = new EntryStore();
    await scanFile(p, 0, logger, whole);
    await scanFile(p, 0, logger, small, { chunkSize: 4 });
    sameStore(whole, small);
  }
  const content = `${entryLine(1, T1, 'INFO', 'fbÄ.fb€', 'ä€ä€')}\n${entryLine(2, T2, 'INFO', 'fb€', '€')}\n`;
  const store = new EntryStore();
  await scanFile(tmpFile(content), 0, logger, store, { chunkSize: 4 });
  assert.equal(store.count, 2);
  assert.deepEqual(store.sources, ['fbÄ.fb€', 'fb€']);
  assert.equal(store.offset[1], Buffer.byteLength(content.split('\n')[0]) + 1);
});

test('abort mid-scan rejects with AbortError and leaves the store usable', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const ctrl = new AbortController();
  const store = new EntryStore();
  let calls = 0;
  await assert.rejects(
    scanFile(p, 0, logger, store, { chunkSize: 64, signal: ctrl.signal, onProgress: () => { if (++calls === 3) ctrl.abort(); } }),
    { name: 'AbortError' });
  assert.ok(store.count < 3);
  store.truncate(0);
  await scanFile(p, 0, logger, store);
  assert.equal(store.count, 3);
});

test('startOffset resume equals one full scan', async () => {
  for (const name of ['logger-lf.log', 'multiline.log', 'logger-nonewline.log']) {
    const p = path.join(fixtures, name);
    const full = new EntryStore();
    const full2 = await scanFile(p, 0, logger, full);
    const part = new EntryStore();
    await scanFile(p, 0, logger, part);
    part.truncate(part.count - 1);
    await scanFile(p, 0, logger, part, { startOffset: full2.lastEntryStart, chunkSize: 16 });
    sameStore(full, part);
  }
});

test('resume keeps the sort time of trailing boot entries', async () => {
  const p = tmpFile([entryLine(1, T1, 'INFO', 'x', 'a'), entryLine(2, BOOT, 'INFO', 'boot', 'b')].join('\n') + '\n');
  const full = new EntryStore();
  const r = await scanFile(p, 0, logger, full);
  const part = new EntryStore();
  await scanFile(p, 0, logger, part);
  part.truncate(1);
  await scanFile(p, 0, logger, part, { startOffset: r.lastEntryStart });
  sameStore(full, part);
  assert.equal(part.sortTime[1], part.time[0]);
});

test('resume on a grown file does not re-patch stored boot entries', async () => {
  const first = [entryLine(1, T1, 'INFO', 'x', 'a'), entryLine(2, BOOT, 'INFO', 'boot', 'b'), entryLine(3, BOOT, 'INFO', 'boot', 'c')].join('\n') + '\n';
  const p = tmpFile(first);
  const store = new EntryStore();
  const r = await scanFile(p, 0, logger, store);
  const t1 = Date.UTC(2026, 0, 15, 10, 0, 1, 123);
  const t2 = Date.UTC(2026, 0, 15, 10, 0, 2, 456);
  assert.deepEqual(Array.from(store.sortTime.subarray(0, 3)), [t1, t1, t1]);
  fs.appendFileSync(p, entryLine(4, T2, 'INFO', 'x', 'd') + '\n');
  store.truncate(store.count - 1);
  await scanFile(p, 0, logger, store, { startOffset: r.lastEntryStart });
  assert.equal(store.count, 4);
  // Entry 1 was committed before the resume point and keeps t1 (a full scan would give it t2); the rescanned entry 2 gets t2.
  assert.deepEqual(Array.from(store.sortTime.subarray(0, 4)), [t1, t1, t2, t2]);
});

test('live scan leaves an unterminated last line unread', async () => {
  const p = tmpFile(`${entryLine(1, T1, 'INFO', 'x', 'a')}\n${entryLine(2, T2, 'INFO', 'x', 'half writt')}`);
  const store = new EntryStore();
  await scanFile(p, 0, logger, store, { live: true });
  assert.equal(store.count, 1);
  const p2 = tmpFile(`${entryLine(1, T1, 'INFO', 'x', 'a')}\nhalf a continuation`);
  const s2 = new EntryStore();
  await scanFile(p2, 0, logger, s2, { live: true });
  assert.equal(s2.lines[0], 1);
  const s3 = new EntryStore();
  await scanFile(p2, 0, logger, s3);
  assert.equal(s3.lines[0], 2);
});

test('a BOM at offset 0 is skipped for parsing but counted in the offsets', async () => {
  const line = entryLine(1, T1, 'INFO', 'x', 'a');
  const store = new EntryStore();
  await scanFile(tmpFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line + '\n' + line + '\n')])), 0, logger, store);
  assert.equal(store.count, 2);
  assert.equal(store.offset[0], 0);
  assert.equal(store.offset[1], 3 + line.length + 1);
});

test('sniff: UTF-16 BOM is reported, a scan is not attempted', async () => {
  const s = await sniff(path.join(fixtures, 'utf16.log'));
  assert.equal(s.encoding, 'utf16');
  assert.deepEqual(Array.from(s.head.subarray(0, 2)), [0xff, 0xfe]);
});

test('sniff: lines, encoding and UTF-8 validity', async () => {
  const s = await sniff(path.join(fixtures, 'logger-crlf.log'));
  assert.equal(s.encoding, 'utf8');
  assert.equal(s.validUtf8, true);
  assert.equal(s.lines.length, 4);
  assert.ok(s.lines[1].startsWith('0000000001 - '));
  assert.equal(s.head.length, 64);
  assert.deepEqual((await sniff(path.join(fixtures, 'empty.log'))).lines, []);
  assert.equal((await sniff(tmpFile(Buffer.from([0x61, 0xe4, 0x0a])))).validUtf8, false);
  assert.equal((await sniff(tmpFile(Buffer.from([0xe4])))).validUtf8, false);
  assert.equal((await sniff(tmpFile(Buffer.from([0x61, 0x62, 0xe4])))).validUtf8, false);
});

test('sniff: a 64 KB boundary inside a valid multi-byte character is not invalid', async () => {
  const s = await sniff(tmpFile(Buffer.concat([Buffer.alloc(65535, 0x61), Buffer.from('€€\n')])));
  assert.equal(s.validUtf8, true);
  assert.equal(s.lines.length, 0); // the single cut line is dropped
});

test('readLines: a 3 MB line is retained up to 1 MB, physical offsets stay exact', async () => {
  const MB = 1024 * 1024;
  const p = tmpFile(Buffer.concat([Buffer.alloc(3 * MB, 0x61), Buffer.from('\nshort\r\n')]));
  const lines = await collect(p, { chunkSize: 64 * 1024 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].truncated, true);
  assert.equal(lines[0].end - lines[0].start, MB);
  assert.equal(lines[0].physEnd - lines[0].offset, 3 * MB);
  assert.equal(lines[0].terminator, 1);
  assert.equal(lines[1].offset, 3 * MB + 1);
  assert.equal(lines[1].buf.toString('utf8', lines[1].start, lines[1].end), 'short');
  assert.equal(lines[1].terminator, 2);
  assert.equal(lines[1].truncated, false);
});

test('readLines: CRLF split across a chunk boundary is one terminator', async () => {
  const p = tmpFile('abc\r\ndef\nlast');
  const lines = await collect(p, { chunkSize: 4 });
  assert.deepEqual(lines.map(l => [l.buf.toString('utf8', l.start, l.end), l.offset, l.physEnd, l.terminator, l.truncated]),
    [['abc', 0, 3, 2, false], ['def', 5, 8, 1, false], ['last', 9, 13, 0, false]]);
});

test('a 3 MB file without a line break is one entry of exact length', async () => {
  const MB = 1024 * 1024;
  const head = entryLine(1, T1, 'INFO', 'x', '');
  const content = Buffer.concat([Buffer.from(head), Buffer.alloc(3 * MB, 0x62)]);
  const store = new EntryStore();
  await scanFile(tmpFile(content), 0, logger, store, { chunkSize: 256 * 1024 });
  assert.equal(store.count, 1);
  assert.equal(store.length[0], content.length);
  assert.equal(store.firstLength[0], 8192);
  assert.equal(store.terminated[0], 0);
});

test('a file that is not valid UTF-8 still scans', async () => {
  const content = Buffer.concat([Buffer.from(entryLine(1, T1, 'INFO', 'x', 'bad ')), Buffer.from([0xe4]), Buffer.from('\n')]);
  const store = new EntryStore();
  await scanFile(tmpFile(content), 0, logger, store);
  assert.equal(store.count, 1);
  assert.equal(store.length[0], content.length - 1);
});

test('maxEntries and maxSources reject with LogLimitError and leave the store consistent', async () => {
  const eleven = Array.from({ length: 11 }, (_, i) => entryLine(i + 1, T1, 'INFO', 'x', `m${i}`)).join('\n') + '\n';
  const store = new EntryStore();
  await assert.rejects(scanFile(tmpFile(eleven), 0, logger, store, { maxEntries: 10 }), LogLimitError);
  assert.equal(store.count, 10);

  const limited = new EntryStore({ maxEntries: 10 });
  await assert.rejects(scanFile(tmpFile(eleven), 0, logger, limited), LogLimitError);
  assert.equal(limited.count, 10);

  const sources = new EntryStore();
  const three = ['a', 'b', 'c'].map((s, i) => entryLine(i + 1, T1, 'INFO', s, 'm')).join('\n') + '\n';
  await assert.rejects(scanFile(tmpFile(three), 0, logger, sources, { maxSources: 2 }), LogLimitError);
  assert.equal(sources.count, 2);
  assert.deepEqual(sources.sources, ['a', 'b']);
});

test('hash differs when only the level or only a continuation line differs', async () => {
  const store = new EntryStore();
  const lines = [
    entryLine(1, T1, 'INFO', 'x', 'm'),
    entryLine(1, T1, 'ERROR', 'x', 'm'),
    entryLine(1, T1, 'INFO', 'x', 'm') + '\n  detail A',
    entryLine(1, T1, 'INFO', 'x', 'm') + '\n  detail B',
    entryLine(1, T1, 'INFO', 'x', 'm'),
  ];
  await scanFile(tmpFile(lines.join('\n') + '\n'), 0, logger, store);
  assert.equal(store.count, 5);
  const h = Array.from(store.hash.subarray(0, 5));
  assert.equal(new Set(h.slice(0, 4)).size, 4);
  assert.equal(h[0], h[4]);
});

test('plain format: every non-blank line is an entry, blank lines continue the previous one', async () => {
  const store = new EntryStore();
  await scanFile(tmpFile('one\n\ntwo\n'), 0, plain, store);
  assert.equal(store.count, 2);
  assert.equal(store.lines[0], 2);
});

test('synthetic generator output scans, grows the store and has multi-line entries', async () => {
  const p = path.join(tmp, 'synthetic.log');
  writeSyntheticLog(p, 300 * 1024, { bootLines: 3 });
  const size = fs.statSync(p).size;
  assert.ok(size >= 300 * 1024);
  const store = new EntryStore();
  const r = await scanFile(p, 0, logger, store);
  assert.ok(store.count > 1024);
  assert.equal(r.size, size);
  assert.ok(Number.isNaN(store.time[0]) && !Number.isNaN(store.time[3]));
  assert.ok(store.sources.length > 100);
  assert.ok(Array.from(store.lines.subarray(0, store.count)).some(n => n === 3));
});

test('appendFrom copies entries and re-interns sources', async () => {
  const a = new EntryStore();
  const b = new EntryStore();
  await scanFile(tmpFile(entryLine(1, T1, 'INFO', 'first', 'm') + '\n'), 0, logger, a);
  await scanFile(tmpFile(entryLine(1, T1, 'INFO', 'second', 'm') + '\n'), 1, logger, b);
  a.appendFrom(b);
  assert.equal(a.count, 2);
  assert.equal(a.sources[a.source[1]], 'second');
  assert.equal(a.file[1], 1);
});

test('appendFrom at an index replaces the entries from there on', async () => {
  const a = new EntryStore();
  const b = new EntryStore();
  await scanFile(tmpFile([entryLine(1, T1, 'INFO', 'one', 'm'), entryLine(2, T1, 'INFO', 'two', 'm')].join('\n') + '\n'), 0, logger, a);
  await scanFile(tmpFile([entryLine(2, T1, 'ERROR', 'two', 'm'), entryLine(3, T1, 'INFO', 'three', 'm')].join('\n') + '\n'), 0, logger, b);
  a.appendFrom(b, 1);
  assert.equal(a.count, 3);
  assert.deepEqual([0, 1, 2].map(i => a.sources[a.source[i]]), ['one', 'two', 'three']);
  assert.equal(a.level[1], LEVELS.indexOf('error'));
});

test('appendFrom past a limit throws LogLimitError and leaves the store unchanged', async () => {
  const lines = (n: number, src: (k: number) => string) =>
    Array.from({ length: n }, (_, k) => entryLine(k + 1, T1, 'INFO', src(k), 'm')).join('\n') + '\n';
  const a = new EntryStore({ maxEntries: 3, maxSources: 2 });
  await scanFile(tmpFile(lines(2, () => 'one')), 0, logger, a);
  const many = new EntryStore();
  await scanFile(tmpFile(lines(2, () => 'one')), 0, logger, many);
  assert.throws(() => a.appendFrom(many), LogLimitError);
  assert.equal(a.count, 2);
  // Fits the entry limit at index 1, but brings two new sources.
  const sources = new EntryStore();
  await scanFile(tmpFile(lines(2, k => `s${k}`)), 0, logger, sources);
  assert.throws(() => a.appendFrom(sources, 1), LogLimitError);
  assert.equal(a.count, 2);
  assert.deepEqual(a.sources, ['one']);
  assert.equal(a.sources[a.source[1]], 'one');
});
