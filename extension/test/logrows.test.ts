import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUILT_IN_FORMATS, LogFormatError, compileFormat } from '../src/core/logformat';
import { EntryStore } from '../src/core/logstore';
import { scanFile } from '../src/core/logscan';
import { EntryRef, LogFiles, compileQuery, exportRaw, readDetail, readPreviews, searchText } from '../src/core/logrows';
import { writeSyntheticLog } from './logGen';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures', 'logs');
const logger = compileFormat(BUILT_IN_FORMATS[0]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iecode-logrows-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let tmpCount = 0;
function tmpFile(content: string | Buffer): string {
  const p = path.join(tmp, `f${tmpCount++}.log`);
  fs.writeFileSync(p, content);
  return p;
}

function entryLine(seq: number, level: string, source: string, message: string): string {
  return `${String(seq).padStart(10, '0')} - 2026-01-15-10:00:01.123 - ${level} - ${source} - ${message}`;
}

async function scan(paths: string[]): Promise<EntryStore> {
  const store = new EntryStore();
  for (let i = 0; i < paths.length; i++) await scanFile(paths[i], i, logger, store);
  return store;
}

function ref(s: EntryStore, i: number): EntryRef {
  return { file: s.file[i], offset: s.offset[i], length: s.length[i], firstLength: s.firstLength[i] };
}

function cols(s: EntryStore): { file: Uint16Array; offset: Float64Array; length: Float64Array } {
  return { file: s.file.subarray(0, s.count), offset: s.offset.subarray(0, s.count), length: s.length.subarray(0, s.count) };
}

const Q = (query: string, o: { regex?: boolean; caseSensitive?: boolean } = {}) => ({ query, regex: o.regex ?? false, caseSensitive: o.caseSensitive ?? false });
const defs = [BUILT_IN_FORMATS[0]];

function big(): string {
  const lines = [entryLine(1, 'INFO', 'fbMain.fbBig', 'Start dump')];
  for (let i = 0; i < 50000; i++) lines.push(`  continuation line ${i} with some padding text to reach size`);
  lines.push(entryLine(2, 'INFO', 'fbMain.fbBig', 'End dump'));
  return lines.join('\n') + '\n';
}

test('readPreviews parses the first line of refs from two files in the requested order', async () => {
  const a = path.join(fixtures, 'logger-lf.log');
  const b = path.join(fixtures, 'multiline.log');
  const s = await scan([a, b]);
  const files = new LogFiles([a, b]);
  try {
    const refs = [ref(s, s.count - 1), ref(s, 0), ref(s, 1)];
    const p = await readPreviews(files, [logger, logger], refs);
    assert.equal(p.length, 3);
    assert.equal(p[0].message, 'Valve stuck');
    assert.equal(p[0].level, 'error');
    assert.equal(p[1].message, 'Pump started');
    assert.equal(p[1].source, 'fbMain.fbPump');
    assert.equal(p[2].level, 'warning');
    assert.match(p[2].message, /^Valve ä slow/);
  } finally {
    await files.close();
  }
});

test('readPreviews strips a BOM and a CR and survives a cut multi-byte character', async () => {
  // 'ä' (2 bytes) starts at byte 8191 of the line, so the 8 KB cap cuts it in half.
  const long = 'x'.repeat(8191 - entryLine(2, 'INFO', 'fbMain.b', '').length) + 'ä€';
  const p = tmpFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(entryLine(1, 'INFO', 'fbMain.a', 'first') + '\r\n' + entryLine(2, 'INFO', 'fbMain.b', long) + '\r\n')]));
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const r = await readPreviews(files, [logger], [ref(s, 0), ref(s, 1)]);
    assert.equal(r[0].message, 'first');
    assert.equal(r[0].seq, 1);
    assert.equal(r[1].source, 'fbMain.b');
    assert.ok(r[1].message.length > 8000);
  } finally {
    await files.close();
  }
});

test('readPreviews and readDetail handle an entry with 50000 continuation lines', async () => {
  const p = tmpFile(big());
  const s = await scan([p]);
  assert.equal(s.count, 2);
  assert.ok(s.length[0] > 2_500_000);
  const files = new LogFiles([p]);
  try {
    const pv = await readPreviews(files, [logger], [ref(s, 0)]);
    assert.equal(pv[0].message, 'Start dump');
    const d = await readDetail(files, [logger], ref(s, 0), 1024 * 1024);
    assert.equal(d.truncated, true);
    assert.ok(d.text.length <= 1024 * 1024);
    assert.equal(d.first.message, 'Start dump');
    const full = await readDetail(files, [logger], ref(s, 1));
    assert.equal(full.truncated, false);
  } finally {
    await files.close();
  }
});

test('readDetail returns the full text of a multi-line entry', async () => {
  const p = path.join(fixtures, 'multiline.log');
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const d = await readDetail(files, [logger], ref(s, 0));
    assert.equal(d.truncated, false);
    assert.equal(d.text, '0000000001 - 2026-01-15-10:00:01.123 - INFO - fbMain.fbPump - Pump started\n  detail line one\n  detail line two');
    assert.equal(d.first.source, 'fbMain.fbPump');
  } finally {
    await files.close();
  }
});

test('LogFiles.close called twice resolves both calls after the release', async () => {
  const files = new LogFiles([path.join(fixtures, 'logger-lf.log')]);
  const release = files.acquire();
  const a = files.close();
  const b = files.close();
  release();
  await Promise.all([a, b]);
});

test('readDetail parses first from at most 8 KB of a long first line but returns the full text', async () => {
  const msg = 'y'.repeat(20000);
  const p = tmpFile(entryLine(1, 'ERROR', 'fbMain.long', msg) + '\n  tail line\n');
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const d = await readDetail(files, [logger], ref(s, 0));
    assert.ok(d.text.includes('y'.repeat(20000)));
    assert.ok(d.text.endsWith('  tail line'));
    assert.equal(d.first.source, 'fbMain.long');
    assert.ok(d.first.message.length <= 8192 && d.first.message.length > 8000);
    // 2-byte characters: the 8 KB byte cut leaves about 4000 characters, parseLine's own 8192-character cap would leave more.
    const wide = tmpFile(entryLine(1, 'ERROR', 'fbMain.long', 'ä'.repeat(10000)) + '\n  tail line\n');
    const ws = await scan([wide]);
    const wf = new LogFiles([wide]);
    try {
      const w = await readDetail(wf, [logger], ref(ws, 0));
      assert.ok(w.first.message.length < 4500, `message has ${w.first.message.length} chars`);
      assert.ok(w.text.includes('ä'.repeat(10000)));
    } finally {
      await wf.close();
    }
  } finally {
    await files.close();
  }
});

test('LogFiles.close waits for released readers', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const files = new LogFiles([p]);
  const release = files.acquire();
  let closed = false;
  const c = files.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(closed, false);
  release();
  await c;
  assert.equal(closed, true);
  assert.throws(() => files.acquire());
});

test('a reader may acquire files another reader holds after close was requested; close waits for both', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const s = await scan([p]);
  const files = new LogFiles([p]);
  const release = files.acquire();
  let closed = false;
  const c = files.close().then(() => { closed = true; });
  const chunks: Buffer[] = [];
  await exportRaw(files, [ref(s, 0)], async chunk => { chunks.push(chunk); });
  assert.equal(Buffer.concat(chunks).toString('utf8'), fs.readFileSync(p, 'utf8').split('\n')[1] + '\n');
  assert.equal(closed, false);
  release();
  await c;
  assert.equal(closed, true);
  assert.throws(() => files.acquire(), /closed/);
});

test('searchText plain search is case-insensitive and covers source, message and continuation lines only', async () => {
  const p = path.join(fixtures, 'multiline.log');
  const s = await scan([p]);
  const r = await searchText([p], cols(s), defs, Q('PUMP'), 0);
  // Entry 0: source fbPump; entry 1 and 2: fbPump.fbValve.
  assert.deepEqual(Array.from(r.flags), [1, 1, 1]);
  assert.equal(r.from, 0);
  const r2 = await searchText([p], cols(s), defs, Q('detail line TWO'), 0);
  assert.deepEqual(Array.from(r2.flags), [1, 0, 0]);
  const r3 = await searchText([p], cols(s), defs, Q('stuck'), 0);
  assert.deepEqual(Array.from(r3.flags), [0, 0, 1]);
});

test('searchText never matches time or level text', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const s = await scan([p]);
  assert.deepEqual(Array.from((await searchText([p], cols(s), defs, Q('INFO'), 0)).flags), [0, 0, 0]);
  assert.deepEqual(Array.from((await searchText([p], cols(s), defs, Q('2026-01-15'), 0)).flags), [0, 0, 0]);
});

test('searchText respects case sensitivity and regex mode', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const s = await scan([p]);
  assert.deepEqual(Array.from((await searchText([p], cols(s), defs, Q('pump started', { caseSensitive: true }), 0)).flags), [0, 0, 0]);
  assert.deepEqual(Array.from((await searchText([p], cols(s), defs, Q('Pump started', { caseSensitive: true }), 0)).flags), [1, 0, 0]);
  const q = p2(['Start failed ()']);
  const rx = await searchText([q], cols(await scan([q])), defs, Q('Start failed \\(\\)', { regex: true }), 0);
  assert.deepEqual(Array.from(rx.flags), [1, 0]);
  const plainParen = await searchText([q], cols(await scan([q])), defs, Q('Start failed ()'), 0);
  assert.deepEqual(Array.from(plainParen.flags), [1, 0]);
});

function p2(messages: string[]): string {
  return tmpFile([...messages, 'other'].map((m, i) => entryLine(i + 1, 'ERROR', 'fbMain.x', m)).join('\n') + '\n');
}

test('searchText works over two files with interleaved entries', async () => {
  const a = tmpFile([entryLine(1, 'INFO', 's.a', 'alpha'), entryLine(2, 'INFO', 's.a', 'needle')].join('\n') + '\n');
  const b = tmpFile([entryLine(1, 'INFO', 's.b', 'needle'), entryLine(2, 'INFO', 's.b', 'beta')].join('\n') + '\n');
  const s = await scan([a, b]);
  // Interleave: a0, b0, a1, b1.
  const order = [0, 2, 1, 3];
  const file = Uint16Array.from(order, i => s.file[i]);
  const offset = Float64Array.from(order, i => s.offset[i]);
  const length = Float64Array.from(order, i => s.length[i]);
  const r = await searchText([a, b], { file, offset, length }, [defs[0], defs[0]], Q('needle'), 0);
  assert.deepEqual(Array.from(r.flags), [0, 1, 1, 0]);
});

test('compileQuery throws LogFormatError for an invalid regex', () => {
  assert.throws(() => compileQuery({ query: '(', regex: true, caseSensitive: false }), (e: Error) => e instanceof LogFormatError && e.message.startsWith('Invalid regular expression'));
  // The engine's message already starts with the prefix; it appears once.
  assert.throws(() => compileQuery({ query: '(', regex: true, caseSensitive: false }), (e: Error) => !/Invalid regular expression.*Invalid regular expression/.test(e.message));
});

test('searchText from k flags only later entries, equals the full search there and reads less', async () => {
  const p = path.join(tmp, 'synthetic.log');
  writeSyntheticLog(p, 200_000);
  const s = await scan([p]);
  const full = await searchText([p], cols(s), defs, Q('fbUnit1'), 0);
  const k = Math.floor(s.count / 2);
  const part = await searchText([p], cols(s), defs, Q('fbUnit1'), k);
  assert.equal(part.from, k);
  assert.equal(part.flags.length, s.count - k);
  assert.deepEqual(Array.from(part.flags), Array.from(full.flags.subarray(k)));
  assert.ok(full.flags.some(f => f === 1));
  assert.ok(part.bytesRead <= fs.statSync(p).size - s.offset[k]);
  assert.ok(part.bytesRead < full.bytesRead);
});

test('searchText from the end returns no flags and reads nothing', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const s = await scan([p]);
  // A missing file proves that nothing is opened.
  const r = await searchText([path.join(tmp, 'missing.log')], cols(s), defs, Q('pump'), s.count);
  assert.equal(r.from, s.count);
  assert.equal(r.flags.length, 0);
  assert.equal(r.bytesRead, 0);
});

test('searchText leaves the caller arrays usable, also after an abort', async () => {
  const p = path.join(fixtures, 'multiline.log');
  const s = await scan([p]);
  const c = cols(s);
  const before = [c.file.buffer.byteLength, c.offset.buffer.byteLength, c.length.buffer.byteLength];
  await searchText([p], c, defs, Q('pump'), 0);
  const ac = new AbortController();
  const pr = searchText([p], c, defs, Q('pump'), 0, ac.signal);
  ac.abort();
  await assert.rejects(pr, (e: Error) => e.name === 'AbortError');
  assert.deepEqual([c.file.buffer.byteLength, c.offset.buffer.byteLength, c.length.buffer.byteLength], before);
  assert.equal(s.offset[1] > 0, true);
});

test('searchText rejects with AbortError and a later call still works', async () => {
  const p = path.join(fixtures, 'multiline.log');
  const s = await scan([p]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(searchText([p], cols(s), defs, Q('pump'), 0, ac.signal), (e: Error) => e.name === 'AbortError');
  const r = await searchText([p], cols(s), defs, Q('stuck'), 0);
  assert.deepEqual(Array.from(r.flags), [0, 0, 1]);
});

test('a catastrophic regex is aborted quickly and never blocks the event loop', async () => {
  const p = tmpFile(entryLine(1, 'INFO', 'fbMain.x', 'a'.repeat(5000) + '!') + '\n');
  const s = await scan([p]);
  const ac = new AbortController();
  const started = Date.now();
  const pr = searchText([p], cols(s), defs, Q('(a+)+$', { regex: true }), 0, ac.signal);
  const rejected = assert.rejects(pr, (e: Error) => e.name === 'AbortError');
  setTimeout(() => ac.abort(), 200);
  let lag = -1;
  const t0 = Date.now();
  setImmediate(() => { lag = Date.now() - t0; });
  await rejected;
  assert.ok(Date.now() - started < 700, `aborted after ${Date.now() - started} ms`);
  assert.ok(lag >= 0 && lag < 100, `event loop lag ${lag} ms`);
});

async function collect(files: LogFiles, refs: EntryRef[], signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await exportRaw(files, refs, async c => { chunks.push(c); }, signal);
  return Buffer.concat(chunks);
}

test('exportRaw emits the original bytes in the given order, each followed by a newline', async () => {
  const p = path.join(fixtures, 'logger-lf.log');
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const got = await collect(files, [ref(s, 2), ref(s, 0)]);
    const raw = fs.readFileSync(p);
    const slice = (i: number): Buffer => raw.subarray(s.offset[i], s.offset[i] + s.length[i]);
    assert.deepEqual(got, Buffer.concat([slice(2), Buffer.from('\n'), slice(0), Buffer.from('\n')]));
  } finally {
    await files.close();
  }
});

test('exportRaw keeps CRLF inside multi-line entries and terminates a last line without newline', async () => {
  const crlf = tmpFile(entryLine(1, 'INFO', 's.a', 'one') + '\r\n  more\r\n' + entryLine(2, 'INFO', 's.a', 'two') + '\r\n');
  const nonl = tmpFile(entryLine(1, 'INFO', 's.b', 'tail'));
  const s = await scan([crlf, nonl]);
  const files = new LogFiles([crlf, nonl]);
  try {
    const got = await collect(files, [ref(s, 0), ref(s, 2)]);
    assert.equal(got.toString('utf8'), entryLine(1, 'INFO', 's.a', 'one') + '\r\n  more\n' + entryLine(1, 'INFO', 's.b', 'tail') + '\n');
  } finally {
    await files.close();
  }
});

test('exportRaw splits a large entry into chunks of at most 1 MB and does not alter bytes', async () => {
  const p = tmpFile(big());
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const sizes: number[] = [];
    const parts: Buffer[] = [];
    await exportRaw(files, [ref(s, 0)], async c => { sizes.push(c.length); parts.push(c); });
    assert.ok(sizes.length >= 3);
    assert.ok(sizes.every(n => n <= 1024 * 1024 + 1));
    const raw = fs.readFileSync(p);
    assert.deepEqual(Buffer.concat(parts), Buffer.concat([raw.subarray(s.offset[0], s.offset[0] + s.length[0]), Buffer.from('\n')]));
  } finally {
    await files.close();
  }
});

test('exportRaw stops with AbortError between chunks', async () => {
  const p = tmpFile(big());
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const ac = new AbortController();
    let n = 0;
    await assert.rejects(
      exportRaw(files, [ref(s, 0)], async () => { if (++n === 1) ac.abort(); }, ac.signal),
      (e: Error) => e.name === 'AbortError');
    assert.equal(n, 1);
  } finally {
    await files.close();
  }
});

test('exportRaw coalesces many small entries into few output chunks without changing the bytes', async () => {
  const lines: string[] = [];
  for (let i = 0; i < 20000; i++) lines.push(entryLine(i, 'INFO', 'fbMain.fbPump', `message ${i}`));
  const p = tmpFile(lines.join('\r\n') + '\r\n');
  const s = await scan([p]);
  const files = new LogFiles([p]);
  try {
    const refs: EntryRef[] = [];
    for (let i = 0; i < s.count; i++) refs.push(ref(s, i));
    const chunks: Buffer[] = [];
    await exportRaw(files, refs, async c => { chunks.push(c); });
    assert.ok(chunks.length <= 5, `out was called ${chunks.length} times for ${refs.length} entries`);
    assert.ok(chunks.every(c => c.length <= 1024 * 1024));
    assert.equal(Buffer.concat(chunks).toString('utf8'), lines.map(l => l + '\n').join(''));
  } finally {
    await files.close();
  }
});

test('exportRaw keeps the given order over two files and out-of-order entries', async () => {
  const a = tmpFile([1, 2, 3, 4].map(i => entryLine(i, 'INFO', 's.a', `a${i}`)).join('\n') + '\n');
  const b = tmpFile([1, 2].map(i => entryLine(i, 'INFO', 's.b', `b${i}`)).join('\n') + '\n');
  const s = await scan([a, b]);
  const files = new LogFiles([a, b]);
  try {
    const got = await collect(files, [ref(s, 3), ref(s, 0), ref(s, 4), ref(s, 1), ref(s, 5)]);
    const want = [entryLine(4, 'INFO', 's.a', 'a4'), entryLine(1, 'INFO', 's.a', 'a1'), entryLine(1, 'INFO', 's.b', 'b1'),
      entryLine(2, 'INFO', 's.a', 'a2'), entryLine(2, 'INFO', 's.b', 'b2')];
    assert.equal(got.toString('utf8'), want.map(l => l + '\n').join(''));
  } finally {
    await files.close();
  }
});
