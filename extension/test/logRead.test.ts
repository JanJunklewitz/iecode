import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogFs, LogQuery, LogRead, checkLogDirectory, decodeMarker, encodeMarker, lineMatches, logText, markNow, readLog as readLogRaw } from '../src/core/logRead';

function memFs(files: Record<string, string | Buffer>): LogFs {
  const bufs = Object.entries(files).map(([name, v]) => [name, typeof v === 'string' ? Buffer.from(v, 'utf8') : v] as const).reverse();
  return {
    list: async () => bufs.map(([name, b]) => ({ name, size: b.length })),
    read: async (name, from, length) => {
      const e = bufs.find(x => x[0] === name);
      if (!e) throw new Error('no such file ' + name);
      return Buffer.from(e[1].subarray(from, from + length));
    },
  };
}
function must<T>(v: T | undefined): T { if (v === undefined) throw new Error('undefined result'); return v; }
const readLog = async (fs: LogFs, q: LogQuery, chunk?: number): Promise<LogRead> => must(await readLogRaw(fs, q, chunk));

test('encodeMarker and decodeMarker round trip and refuse a path', () => {
  assert.equal(encodeMarker({ file: 'Log_1.log', offset: 120 }), 'Log_1.log@120');
  assert.deepEqual(decodeMarker('Log_1.log@120'), { file: 'Log_1.log', offset: 120 });
  for (const bad of ['', 'Log_1.log', 'Log_1.log@-1', 'Log_1.log@1.5', '@5', '..\\x.log@1', 'a/b.log@1', 'C:x.log@1', 'a..b.log@1',
    'Log_1.log@9007199254740993', 'Log_1.log@1234567890123456', 'Log_1.log@0x10', 'Log_1.log@1\u0000', 'a\u0000b.log@1', 'x'.repeat(256) + '.log@1']) assert.equal(decodeMarker(bad), undefined, bad);
});
test('lineMatches: any filter, no exclude, case-insensitive', () => {
  assert.equal(lineMatches('A | ERROR | x', [], []), true);
  assert.equal(lineMatches('A | ERROR | x', ['error'], []), true);
  assert.equal(lineMatches('A | ERROR | x', ['warn', 'step'], []), false);
  assert.equal(lineMatches('A | DEBUG | x', [], ['debug']), false);
  assert.equal(lineMatches('A | ERROR | DEBUG', ['error'], ['debug']), false);
});
test('markNow is the end of the newest file at its last complete line', async () => {
  const fs = memFs({ 'Log_1.log': 'a\nb\n', 'Log_2.log': 'c\nd\nun' });
  assert.deepEqual(await markNow(fs), { file: 'Log_2.log', offset: 4 });
  assert.equal(await markNow(memFs({})), undefined);
});
test('readLog without a marker returns the tail of the newest file', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'one\ntwo\nthree\n' }), { filter: [], exclude: [], maxLines: 2 });
  assert.deepEqual(r.lines, ['two', 'three']);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 14 });
});
test('readLog returns the lines after a marker, filtered', async () => {
  const fs = memFs({ 'Log_1.log': 'a ok\nb ERROR\nc ok\nd ERROR\n' });
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 5 }, filter: ['error'], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['b ERROR', 'd ERROR']);   // offset 5 is the start of "b ERROR"
});
test('readLog stops at maxLines and gives the position after the last kept line', async () => {
  const fs = memFs({ 'Log_1.log': 'a\nb\nc\nd\n' });
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 2 });
  assert.deepEqual(r.lines, ['a', 'b']);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 4 });
  assert.equal(r.more, true);
});
test('readLog continues into a newer file and says so', async () => {
  const fs = memFs({ 'Log_1.log': 'a\nb\n', 'Log_2.log': 'c\n' });
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 2 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['b', 'c']);
  assert.deepEqual(r.notes, ['PLC restart or new log file: continued in Log_2.log']);
  assert.deepEqual(r.next, { file: 'Log_2.log', offset: 2 });
});
test('readLog starts at the oldest file when the marker file is gone', async () => {
  const r = await readLog(memFs({ 'Log_2.log': 'x\n' }), { since: { file: 'Log_1.log', offset: 9 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['x']);
  assert.deepEqual(r.notes, ['Marker file Log_1.log is gone: started at the oldest file Log_2.log']);
});
test('readLog restarts at 0 when the offset is past the end', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'x\n' }), { since: { file: 'Log_1.log', offset: 99 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['x']);
  assert.deepEqual(r.notes, ['Offset of Log_1.log is past the end of the file: started at the beginning']);
});
test('readLog leaves an unfinished last line for the next call', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\nhalf' }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['a']);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 2 });
});
test('readLog strips one trailing carriage return, also when a chunk splits CR and LF', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\r\nb\r\nc\rd\r\n' }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 }, 2);
  assert.deepEqual(r.lines, ['a', 'b', 'c\rd']);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 11 });
});
test('readLog keeps a multi-byte character that crosses a chunk', async () => {
  const r = await readLog(memFs({ 'Log_1.log': Buffer.from([0x61, 0xc3, 0xa9, 0x0a]) }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 }, 2);
  assert.deepEqual(r.lines, ['aé']);          // C3 A9 is split between the two chunks
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 4 });
});
test('readLog cuts an oversized line and moves on', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const q = { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 };
  const fs1 = memFs({ 'Log_1.log': big + '\nafter\n' });
  const a = await readLog(fs1, q);
  assert.equal(a.lines.length, 1);                 // the cut line already fills the text budget
  assert.equal(a.lines[0].length, 1024 * 1024);
  assert.ok(a.notes.includes('A line longer than 1 MB was cut'));
  assert.deepEqual(a.next, { file: 'Log_1.log', offset: 2 * 1024 * 1024 + 1 });
  assert.equal(a.more, true);
  const a2 = await readLog(fs1, { ...q, since: a.next });
  assert.deepEqual(a2.lines, ['after']);
  assert.deepEqual(a2.next, { file: 'Log_1.log', offset: 2 * 1024 * 1024 + 1 + 6 });
  const b = await readLog(memFs({ 'Log_1.log': big }), q);                 // unfinished and oversized
  assert.equal(b.lines.length, 1);
  assert.deepEqual(b.next, { file: 'Log_1.log', offset: 2 * 1024 * 1024 });
});
test('readLog says no more when maxLines ends exactly at the last complete line', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\nb\n' }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 2 });
  assert.equal(r.more, false);
  assert.equal((await readLog(memFs({ 'Log_1.log': 'a\nb\nhalf' }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 2 })).more, false);
});
test('readLog continues in two calls without losing or repeating a line', async () => {
  const fs = memFs({ 'Log_1.log': 'a ERR\nb ok\nc ERR\nd ERR\n' });
  const q1 = { since: { file: 'Log_1.log', offset: 0 }, filter: ['err'], exclude: [], maxLines: 2 };
  const r1 = await readLog(fs, q1, 3);
  assert.deepEqual(r1.lines, ['a ERR', 'c ERR']);
  assert.equal(r1.more, true);
  const r2 = await readLog(fs, { ...q1, since: r1.next }, 3);
  assert.deepEqual(r2.lines, ['d ERR']);
  assert.equal(r2.more, false);
});
test('readLog treats the unfinished last line of an older file as complete', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\nhalf', 'Log_2.log': 'c\n' }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['a', 'half', 'c']);
});
test('readLog orders files by name whatever list() returns', async () => {
  const r = await readLog(memFs({ 'Log_2.log': 'new\n', 'Log_1.log': 'old\n' }), { filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, ['new']);
  assert.equal(r.file, 'Log_2.log');
});
test('readLog is undefined for an empty directory', async () => {
  assert.equal(await readLogRaw(memFs({}), { filter: [], exclude: [], maxLines: 10 }), undefined);
});
test('readLog propagates a read error', async () => {
  const fs: LogFs = { list: async () => [{ name: 'Log_1.log', size: 2 }], read: async () => { throw new Error('gone'); } };
  await assert.rejects(readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 }), /gone/);
});
test('markNow marks the end when the unfinished line is longer than the line limit', async () => {
  assert.deepEqual(await markNow(memFs({ 'Log_1.log': 'a\n' + 'x'.repeat(2 * 1024 * 1024) })), { file: 'Log_1.log', offset: 2 + 2 * 1024 * 1024 });
});
test('readLog stops at the scan limit and offers a continue marker', async () => {
  const line = 'x'.repeat(1023) + '\n';                       // 1 KiB
  const fs = memFs({ 'Log_1.log': line.repeat(17 * 1024) });   // 17 MiB, nothing matches
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: ['nomatch'], exclude: [], maxLines: 10 });
  assert.deepEqual(r.lines, []);
  assert.equal(r.more, true);
  assert.equal(r.next.offset, 16 * 1024 * 1024);
  assert.ok(r.notes.includes('Scan limit of 16 MB reached'));
});
test('readLog survives invalid UTF-8', async () => {
  const fs: LogFs = { list: async () => [{ name: 'Log_1.log', size: 4 }], read: async () => Buffer.from([0x61, 0xff, 0xfe, 0x0a]) };
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 });
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].startsWith('a'));
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 4 });
});
test('readLog never leaves the directory', async () => {
  const asked: string[] = [];
  const fs: LogFs = { list: async () => [{ name: 'Log_1.log', size: 2 }], read: async (n) => { asked.push(n); return Buffer.from('a\n'); } };
  await readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(asked, ['Log_1.log']);
});
test('logText prints a header, the lines, the notes and the next marker', () => {
  const q = { filter: ['err'], exclude: [], maxLines: 100 };
  const r: LogRead = { lines: ['a ERR', 'b ERR'], next: { file: 'Log_1.log', offset: 40 }, more: false, scannedLines: 7, notes: ['PLC restart or new log file: continued in Log_1.log'], file: 'Log_1.log' };
  assert.equal(logText(r, q, 'C:\\Logs\\TwinCAT'),
    'Log Log_1.log: 2 of 7 scanned lines match.\nNote: PLC restart or new log file: continued in Log_1.log\na ERR\nb ERR\nNext: since "Log_1.log@40"');
  assert.equal(logText(undefined, q, 'C:\\Logs\\TwinCAT'), 'No .log file in C:\\Logs\\TwinCAT.');
});
test('logText says when more lines remain', () => {
  const r: LogRead = { lines: ['a'], next: { file: 'Log_1.log', offset: 2 }, more: true, scannedLines: 1, notes: [], file: 'Log_1.log' };
  assert.ok(logText(r, { filter: [], exclude: [], maxLines: 1 }, 'C:\\Logs\\TwinCAT').endsWith('More lines follow: call again with since "Log_1.log@2".'));
});

test('readLog consumes a line longer than the scan limit and moves the marker past it', async () => {
  const big = 'x'.repeat(17 * 1024 * 1024);
  const fs1 = memFs({ 'Log_1.log': big + '\nafter\n' });
  const q = { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 };
  const r = await readLog(fs1, q);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].length, 1024 * 1024);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 17 * 1024 * 1024 + 1 });      // moved past the long line
  const r2 = await readLog(fs1, { ...q, since: r.next });
  assert.deepEqual(r2.lines, ['after']);
  assert.deepEqual(r2.next, { file: 'Log_1.log', offset: 17 * 1024 * 1024 + 7 });
  assert.equal(r2.more, false);
});
test('readLog consumes an unfinished line longer than the scan limit', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'head\n' + 'x'.repeat(20 * 1024 * 1024) }), { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 10 });
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 5 + 20 * 1024 * 1024 });
  assert.equal(r.more, false);
});
test('readLog bounds the look-ahead for more lines', async () => {
  let bytes = 0;
  const inner = memFs({ 'Log_1.log': 'a\n' + 'x'.repeat(3 * 1024 * 1024) });
  const fs: LogFs = { list: inner.list, read: async (n, f, l) => { const b = await inner.read(n, f, l); bytes += b.length; return b; } };
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 1 });
  assert.deepEqual(r.lines, ['a']);
  assert.equal(r.more, true);                      // a line longer than the line limit follows
  assert.ok(bytes <= 2 * 1024 * 1024 + 16, `read ${bytes} bytes`);
});

const lineOf = (i: number, size: number): string => `${String(i).padStart(5, '0')} ${'x'.repeat(size - 7)}\n`;
const q0 = (maxLines = 5000): LogQuery => ({ filter: [], exclude: [], maxLines });

test('tail mode drops the partial first line of its window', async () => {
  const text = Array.from({ length: 4000 }, (_, i) => lineOf(i, 100)).join('');          // 400000 bytes, window starts mid-line
  const r = await readLog(memFs({ 'Log_1.log': text }), q0());
  assert.equal(r.scannedLines, 4000 - 1379);        // the dropped partial line is not counted
  assert.ok(r.lines[r.lines.length - 1].startsWith('03999 '));
  assert.ok(r.lines.length * 100 <= 40_000);   // the text budget keeps the last lines
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 400000 });
});
test('tail mode keeps the first line when its window starts exactly at a line start', async () => {
  const text = Array.from({ length: 4096 }, (_, i) => lineOf(i, 128)).join('');          // 524288 bytes, window starts at 262144
  const r = await readLog(memFs({ 'Log_1.log': text }), q0());
  assert.equal(r.scannedLines, 2048);               // the first line of the window is kept
  assert.ok(r.lines[r.lines.length - 1].startsWith('04095 '));
});
test('tail mode leaves an unfinished last line', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\nb\nhalf' }), q0());
  assert.deepEqual(r.lines, ['a', 'b']);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 4 });
});
test('tail mode marks at the last line end before a window without a line end', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\n' + 'x'.repeat(300 * 1024) }), q0(5));
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.next, { file: 'Log_1.log', offset: 2 });
});
test('tail mode of an empty newest file shows the end of the previous file and says so', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'a\nb\n', 'Log_2.log': '' }), q0());
  assert.deepEqual(r.lines, ['a', 'b']);
  assert.deepEqual(r.notes, ['The newest log file is empty: showing the end of Log_1.log']);
});
test('the scan limit counts bytes across files', async () => {
  const line = 'x'.repeat(1023) + '\n';
  const fs = memFs({ 'Log_1.log': line.repeat(8 * 1024), 'Log_2.log': line.repeat(12 * 1024) });
  const r = await readLog(fs, { since: { file: 'Log_1.log', offset: 0 }, filter: ['nomatch'], exclude: [], maxLines: 10 });
  assert.deepEqual(r.next, { file: 'Log_2.log', offset: 8 * 1024 * 1024 });
  assert.equal(r.more, true);
  assert.deepEqual(r.notes, ['PLC restart or new log file: continued in Log_2.log', 'Scan limit of 16 MB reached']);
});
test('a gone marker with several files gives one continue note', async () => {
  const r = await readLog(memFs({ 'Log_1.log': 'x\n', 'Log_2.log': 'x\n', 'Log_3.log': 'x\n', 'Log_4.log': 'x\n' }), { since: { file: 'Log_0.log', offset: 5 }, filter: [], exclude: [], maxLines: 10 });
  assert.deepEqual(r.notes, ['Marker file Log_0.log is gone: started at the oldest file Log_1.log', 'PLC restart or new log file: continued in Log_4.log']);
  assert.equal(r.lines.length, 4);
});
test('the kept text is capped and the marker continues after the last kept line', async () => {
  const text = Array.from({ length: 100 }, (_, i) => lineOf(i, 1024)).join('');
  const fs = memFs({ 'Log_1.log': text });
  const q = { since: { file: 'Log_1.log', offset: 0 }, filter: [], exclude: [], maxLines: 100 };
  const a = await readLog(fs, q);
  assert.ok(a.lines.length < 100 && a.lines.length >= 30, `${a.lines.length} lines`);
  assert.equal(a.more, true);
  assert.equal(a.next.offset, a.lines.length * 1024);
  const b = await readLog(fs, { ...q, since: a.next });
  assert.ok(b.lines[0].startsWith(String(a.lines.length).padStart(5, '0')));
});
test('checkLogDirectory accepts only a full path and gives the reason otherwise', () => {
  const unset = { problem: 'no log directory set. Set iecode.ads.logDirectory in the user settings to the folder of the TwinCAT log files.' };
  const rel = { problem: 'iecode.ads.logDirectory must be a full path, for example C:\\Logs\\TwinCAT.' };
  for (const v of [undefined, null, 5, '', '  ']) assert.deepEqual(checkLogDirectory(v, 'win32'), unset);
  assert.deepEqual(checkLogDirectory(' C:\\Logs\\TwinCAT ', 'win32'), { dir: 'C:\\Logs\\TwinCAT' });
  assert.deepEqual(checkLogDirectory('\\\\server\\share\\Logs', 'win32'), { dir: '\\\\server\\share\\Logs' });
  for (const v of ['Logs', '\\Logs', '/Logs', 'C:Logs', '.\\Logs']) assert.deepEqual(checkLogDirectory(v, 'win32'), rel, v);
  assert.deepEqual(checkLogDirectory('/var/log/tc', 'linux'), { dir: '/var/log/tc' });
  assert.deepEqual(checkLogDirectory('logs', 'linux'), rel);
});
