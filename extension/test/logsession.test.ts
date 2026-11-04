import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogFormatError } from '../src/core/logformat';
import { LogLimitError } from '../src/core/logstore';
import { LogSession, StaleError } from '../src/core/logsession';
import { writeSyntheticLog } from './logGen';

const fixtures = path.join(__dirname, '..', '..', 'test', 'fixtures', 'logs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iecode-logsession-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let tmpCount = 0;
function tmpFile(content: string | Buffer, name?: string): string {
  const p = path.join(tmp, name ?? `f${tmpCount++}.log`);
  fs.writeFileSync(p, content);
  return p;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** Logger line at 2026-01-15 10:00:00 plus ms milliseconds. */
function entry(seq: number, ms: number, level: string, source: string, message: string): string {
  const d = new Date(Date.UTC(2026, 0, 15, 10, 0, 0, 0) + ms);
  const time = `2026-01-15-${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`;
  return `${pad(seq, 10)} - ${time} - ${level} - ${source} - ${message}`;
}

const T0 = Date.UTC(2026, 0, 15, 10, 0, 0, 0);
const OPTS = { groupRepeats: false, gapMs: 1000 };

async function opened(paths: string[], o = OPTS): Promise<LogSession> {
  const s = LogSession.open(paths, [], o);
  await s.load();
  return s;
}

/** Five entries; the third has a continuation line, the last two repeat. */
function repeats(): string {
  return [
    entry(1, 0, 'INFO', 'fbMain.fbPump', 'Pump started'),
    entry(2, 100, 'WARNING', 'fbMain.fbPump.fbValve', 'Valve slow'),
    entry(3, 5100, 'ERROR', 'fbMain.fbPump.fbValve', 'Valve stuck'),
    '  detail line',
    entry(4, 5200, 'INFO', 'fbMain.fbPump', 'Cycle done'),
    entry(5, 5300, 'INFO', 'fbMain.fbPump', 'Cycle done'),
  ].join('\n') + '\n';
}

/** A line on which the regex (a+)+$ backtracks for a very long time. */
function catastrophic(): string {
  return [
    entry(1, 0, 'INFO', 'fbMain.fbPump', 'Pump started'),
    entry(2, 1000, 'INFO', 'fbMain.x', 'a'.repeat(5000) + '!'),
    entry(3, 2000, 'ERROR', 'fbMain.fbPump', 'Pump stuck'),
  ].join('\n') + '\n';
}

const SLOW = { query: '(a+)+$', regex: true, caseSensitive: false };

test('load detects the logger format and fills the state', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  try {
    const st = s.state();
    assert.equal(st.total, 3);
    assert.equal(st.matched, 3);
    assert.equal(st.rowCount, 3);
    assert.deepEqual(st.formats, ['twincat-logger']);
    assert.deepEqual(st.levelCounts, { error: 1, warning: 1, info: 1, debug: 0, other: 0 });
    assert.equal(st.firstTimeMs, Date.UTC(2026, 0, 15, 10, 0, 1, 123));
    assert.equal(st.lastTimeMs, Date.UTC(2026, 0, 15, 10, 0, 3, 789));
    assert.equal(st.scanning, 1);
    assert.equal(st.live, false);
    assert.equal(st.warning, undefined);
    assert.equal(st.error, undefined);
    assert.ok(st.revision > 0);
  } finally {
    await s.dispose();
  }
});

test('load reports progress', async () => {
  const s = LogSession.open([path.join(fixtures, 'logger-lf.log')], [], OPTS);
  const seen: number[] = [];
  await s.load(f => seen.push(f));
  assert.equal(seen[seen.length - 1], 1);
  await s.dispose();
});

test('rows parse the first line and report deltas and gaps', async () => {
  const s = await opened([tmpFile(repeats(), 'repeats.log')]);
  try {
    const rev = s.state().revision;
    const r = await s.rows(rev, 0, 3);
    assert.equal(r.length, 3);
    assert.deepEqual(r.map(x => x.pos), [0, 1, 2]);
    assert.deepEqual(r.map(x => x.index), [0, 1, 2]);
    assert.equal(r[0].file, 'repeats.log');
    assert.equal(r[0].seq, 1);
    assert.equal(r[0].time, '2026-01-15 10:00:00.000');
    assert.equal(r[0].timeMs, T0);
    assert.equal(r[0].level, 'info');
    assert.equal(r[0].source, 'fbMain.fbPump');
    assert.equal(r[0].message, 'Pump started');
    assert.deepEqual(r.map(x => x.deltaMs), [undefined, 100, 5000]);
    assert.deepEqual(r.map(x => x.gap), [false, false, true]);
    assert.equal(r[2].message, 'Valve stuck');
    assert.equal(r[2].extraLines, 1);
    assert.equal(r[0].extraLines, 0);
    assert.equal(r[0].repeat, 1);
    assert.equal(r[0].bookmarked, false);
    // The first row of a later window still gets its delta from the row before.
    const w = await s.rows(rev, 3, 2);
    assert.deepEqual(w.map(x => x.deltaMs), [100, 100]);
  } finally {
    await s.dispose();
  }
});

test('rows show the boot text for entries without a time and cut long messages at 2000 characters', async () => {
  const p = tmpFile([
    '0000000001 - 0000-00-00-00:00:00.000 - INFO - fbMain.fbBoot - Booting',
    entry(2, 0, 'INFO', 'fbMain.fbPump', 'x'.repeat(3000)),
  ].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const r = await s.rows(s.state().revision, 0, 2);
    assert.equal(r[0].time, '0000-00-00-00:00:00.000');
    assert.equal(r[0].deltaMs, undefined);
    assert.equal(r[1].deltaMs, undefined);
    assert.equal(r[1].gap, false);
    assert.equal(r[1].message.length, 2000);
  } finally {
    await s.dispose();
  }
});

test('detail returns the full text of a row', async () => {
  const s = await opened([path.join(fixtures, 'multiline.log')]);
  try {
    const d = await s.detail(s.state().revision, 0);
    assert.match(d.text, /Pump started\n {2}detail line one\n {2}detail line two/);
    assert.equal(d.truncated, false);
  } finally {
    await s.dispose();
  }
});

test('a level filter changes matched and reports hiddenBy.level', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  try {
    const before = s.state().revision;
    await s.setFilters({ levels: ['error'] });
    const st = s.state();
    assert.equal(st.matched, 1);
    assert.equal(st.hiddenBy.level, 2);
    assert.ok(st.revision > before);
    assert.deepEqual(st.filters.levels, ['error']);
    const r = await s.rows(st.revision, 0, 5);
    assert.equal(r.length, 1);
    assert.equal(r[0].message, 'Valve stuck');
  } finally {
    await s.dispose();
  }
});

test('a text filter applies, an empty query clears it', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  try {
    await s.setFilters({ text: { query: 'valve', regex: false, caseSensitive: false } });
    assert.equal(s.state().matched, 2);
    assert.equal(s.state().hiddenBy.text, 1);
    assert.equal(s.state().filters.text?.query, 'valve');
    await s.setFilters({ text: { query: '', regex: false, caseSensitive: false } });
    assert.equal(s.state().matched, 3);
    assert.equal(s.state().hiddenBy.text, 0);
  } finally {
    await s.dispose();
  }
});

test('a second text query aborts the running search without an unhandled rejection', async () => {
  const s = await opened([tmpFile(catastrophic())]);
  try {
    const t0 = Date.now();
    const first = s.setFilters({ text: SLOW });
    const second = s.setFilters({ text: { query: 'pump', regex: false, caseSensitive: false } });
    await first;
    assert.ok(Date.now() - t0 < 1000, `first search ended after ${Date.now() - t0} ms`);
    await second;
    assert.equal(s.state().matched, 2);
    assert.equal(s.state().filters.text?.query, 'pump');
    assert.equal(s.state().error, undefined);
  } finally {
    await s.dispose();
  }
});

test('an invalid regex sets the error and keeps the previous result, a valid change clears it', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  try {
    await s.setFilters({ text: { query: 'pump', regex: false, caseSensitive: false } });
    const rev = s.state().revision;
    await s.setFilters({ text: { query: '(', regex: true, caseSensitive: false } });
    const st = s.state();
    assert.match(st.error ?? '', /^Invalid regular expression/);
    assert.equal(st.matched, 3);
    assert.equal(st.filters.text?.query, 'pump');
    assert.ok(st.revision > rev);
    await s.setFilters({ levels: ['error', 'warning'] });
    assert.equal(s.state().error, undefined);
    assert.equal(s.state().matched, 2);
  } finally {
    await s.dispose();
  }
});

test('bookmarks toggle, show in rows and are found by jump', async () => {
  const s = await opened([tmpFile(repeats())]);
  try {
    const rev = s.state().revision;
    s.toggleBookmark(rev, 1);
    s.toggleBookmark(rev, 3);
    let r = await s.rows(rev, 0, 5);
    assert.deepEqual(r.map(x => x.bookmarked), [false, true, false, true, false]);
    assert.equal(s.jump(rev, 0, 1, 'bookmark'), 1);
    assert.equal(s.jump(rev, 1, 1, 'bookmark'), 3);
    assert.equal(s.jump(rev, 3, 1, 'bookmark'), -1);
    assert.equal(s.jump(rev, 3, -1, 'bookmark'), 1);
    s.toggleBookmark(rev, 3);
    r = await s.rows(rev, 0, 5);
    assert.deepEqual(r.map(x => x.bookmarked), [false, true, false, false, false]);
    assert.equal(s.jump(rev, 1, 1, 'bookmark'), -1);
  } finally {
    await s.dispose();
  }
});

test('jump finds the next and previous error row', async () => {
  const p = tmpFile([
    entry(1, 0, 'ERROR', 'fbMain.a', 'one'),
    entry(2, 1, 'INFO', 'fbMain.a', 'two'),
    entry(3, 2, 'ERROR', 'fbMain.a', 'three'),
    entry(4, 3, 'INFO', 'fbMain.a', 'four'),
  ].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const rev = s.state().revision;
    assert.equal(s.jump(rev, -1, 1, 'error'), 0);
    assert.equal(s.jump(rev, 0, 1, 'error'), 2);
    assert.equal(s.jump(rev, 2, 1, 'error'), -1);
    assert.equal(s.jump(rev, 3, -1, 'error'), 2);
  } finally {
    await s.dispose();
  }
});

test('a bookmark sits on the first member of a group', async () => {
  const s = await opened([tmpFile(repeats())], { groupRepeats: true, gapMs: 0 });
  try {
    const rev = s.state().revision;
    assert.equal(s.state().rowCount, 4);
    s.toggleBookmark(rev, 3);
    const r = await s.rows(rev, 3, 1);
    assert.equal(r[0].repeat, 2);
    assert.equal(r[0].index, 3);
    assert.equal(r[0].bookmarked, true);
    s.setOptions({ groupRepeats: false });
    const r2 = await s.rows(s.state().revision, 3, 2);
    assert.deepEqual(r2.map(x => x.bookmarked), [true, false]);
  } finally {
    await s.dispose();
  }
});

test('two files merge by time and rows name the file by its base name', async () => {
  const a = tmpFile([entry(1, 1000, 'INFO', 'fbMain.a', 'a1'), entry(2, 3000, 'INFO', 'fbMain.a', 'a2')].join('\n') + '\n', 'first.log');
  const b = tmpFile(entry(1, 2000, 'INFO', 'fbMain.b', 'b1') + '\n', 'second.log');
  const s = await opened([a, b]);
  try {
    const r = await s.rows(s.state().revision, 0, 3);
    assert.deepEqual(r.map(x => x.message), ['a1', 'b1', 'a2']);
    assert.deepEqual(r.map(x => x.file), ['first.log', 'second.log', 'first.log']);
    assert.deepEqual(s.state().files, [a, b]);
  } finally {
    await s.dispose();
  }
});

test('three files with interleaving times merge into one timeline with every entry', async () => {
  const lines = (f: number, n: number) =>
    Array.from({ length: n }, (_, k) => entry(k + 1, k * 300 + f * 100, 'INFO', `fbMain.f${f}`, `f${f}e${k}`)).join('\n') + '\n';
  const paths = [tmpFile(lines(0, 4)), tmpFile(lines(1, 3)), tmpFile(lines(2, 5))];
  const s = await opened(paths);
  try {
    const st = s.state();
    assert.equal(st.total, 12);
    const r = await s.rows(st.revision, 0, 20);
    assert.equal(r.length, 12);
    const times = r.map(x => x.timeMs);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.deepEqual(r.slice(0, 4).map(x => x.message), ['f0e0', 'f1e0', 'f2e0', 'f0e1']);
    assert.deepEqual(r.slice(0, 4).map(x => x.fileIndex), [0, 1, 2, 0]);
  } finally {
    await s.dispose();
  }
});

test('a file filter changes matched and reports hiddenBy.file; undefined shows every file again', async () => {
  const a = tmpFile([entry(1, 1000, 'INFO', 'fbMain.a', 'a1'), entry(2, 3000, 'ERROR', 'fbMain.a', 'a2')].join('\n') + '\n');
  const b = tmpFile(entry(1, 2000, 'INFO', 'fbMain.b', 'b1') + '\n');
  const s = await opened([a, b]);
  try {
    await s.setFilters({ files: [1] });
    let st = s.state();
    assert.equal(st.matched, 1);
    assert.equal(st.hiddenBy.file, 2);
    assert.deepEqual(st.filters.files, [1]);
    const r = await s.rows(st.revision, 0, 3);
    assert.deepEqual(r.map(x => x.message), ['b1']);
    assert.deepEqual(r.map(x => x.fileIndex), [1]);
    await s.setFilters({ files: undefined });
    st = s.state();
    assert.equal(st.matched, 3);
    assert.equal(st.hiddenBy.file, 0);
    assert.equal('files' in st.filters, false);
  } finally {
    await s.dispose();
  }
});

test('mixed formats are detected per file and each entry is parsed with its file format', async () => {
  const a = tmpFile([entry(1, 1000, 'INFO', 'fbMain.a', 'logger one'), entry(2, 3000, 'ERROR', 'fbMain.a', 'logger two')].join('\n') + '\n');
  const b = tmpFile('15.01.2026 10:00:02\tWARNING\tTab message\n');
  const s = await opened([a, b]);
  try {
    assert.deepEqual(s.state().formats, ['twincat-logger', 'tab-separated']);
    const r = await s.rows(s.state().revision, 0, 3);
    assert.deepEqual(r.map(x => x.message), ['logger one', 'Tab message', 'logger two']);
    assert.deepEqual(r.map(x => x.level), ['info', 'warning', 'error']);
    assert.equal(r[1].time, '2026-01-15 10:00:02.000');
    assert.equal(r[1].seq, undefined);
  } finally {
    await s.dispose();
  }
});

test('user formats are tried before the built-in ones', async () => {
  const p = tmpFile('[A] one\n[B] two\n');
  const s = LogSession.open([p], [{ id: 'bracket', name: 'Bracket', entry: '^\\[(?<source>\\w)\\] (?<message>.*)$' }], OPTS);
  try {
    await s.load();
    assert.deepEqual(s.state().formats, ['bracket']);
    const r = await s.rows(s.state().revision, 0, 2);
    assert.deepEqual(r.map(x => x.source), ['A', 'B']);
    assert.equal(r[0].time, '');
  } finally {
    await s.dispose();
  }
});

test('load of a UTF-16 file rejects with a clear message', async () => {
  const s = LogSession.open([path.join(fixtures, 'utf16.log')], [], OPTS);
  await assert.rejects(s.load(), /UTF-16/);
  await s.dispose();
});

test('a plain file with more entries than maxEntries rejects load with LogLimitError', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `plain line ${i + 1}`);
  const s = LogSession.open([tmpFile(lines.join('\n') + '\n')], [], OPTS, { maxEntries: 20 });
  await assert.rejects(s.load(), LogLimitError);
  await s.dispose();
});

test('a file with invalid UTF-8 opens with a warning', async () => {
  const p = tmpFile(Buffer.concat([Buffer.from(entry(1, 0, 'INFO', 'fbMain.a', 'bad ')), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
  const s = await opened([p]);
  try {
    assert.equal(s.state().total, 1);
    assert.match(s.state().warning ?? '', /not valid UTF-8/);
    const r = await s.rows(s.state().revision, 0, 1);
    assert.match(r[0].message, /^bad �/);
  } finally {
    await s.dispose();
  }
});

test('rowCount equals matched without grouping and is smaller with grouping; viewFirstTimeMs follows the view', async () => {
  const s = await opened([tmpFile(repeats())]);
  try {
    assert.equal(s.state().rowCount, 5);
    assert.equal(s.state().matched, 5);
    assert.equal(s.state().viewFirstTimeMs, T0);
    const rev = s.state().revision;
    s.setOptions({ groupRepeats: true });
    assert.equal(s.state().rowCount, 4);
    assert.equal(s.state().matched, 5);
    assert.ok(s.state().revision > rev);
    await s.setFilters({ levels: ['error'] });
    assert.equal(s.state().viewFirstTimeMs, T0 + 5100);
    await s.setFilters({ levels: [] });
    assert.equal(s.state().viewFirstTimeMs, undefined);
  } finally {
    await s.dispose();
  }
});

test('state carries the current filters and options', async () => {
  const s = await opened([tmpFile(repeats())]);
  try {
    await s.setFilters({ levels: ['error', 'info'], source: 'pump', from: T0, to: T0 + 6000 });
    s.setOptions({ gapMs: 250 });
    const st = s.state();
    assert.deepEqual(st.filters, { levels: ['error', 'info'], source: 'pump', from: T0, to: T0 + 6000 });
    assert.deepEqual(st.options, { groupRepeats: false, gapMs: 250 });
    s.setLive(true);
    assert.equal(s.state().live, true);
  } finally {
    await s.dispose();
  }
});

test('rows and detail for an older revision reject with StaleError', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  try {
    const rev = s.state().revision;
    await s.setFilters({ levels: ['error'] });
    await assert.rejects(s.rows(rev, 0, 1), StaleError);
    await assert.rejects(s.detail(rev, 0), StaleError);
    assert.throws(() => s.jump(rev, 0, 1, 'error'), StaleError);
    assert.throws(() => s.toggleBookmark(rev, 0), StaleError);
  } finally {
    await s.dispose();
  }
});

test('rows answer from the current snapshot while a text search runs', async () => {
  const s = await opened([tmpFile(catastrophic())]);
  try {
    const rev = s.state().revision;
    const search = s.setFilters({ text: SLOW });
    const r = await s.rows(rev, 0, 3);
    assert.deepEqual(r.map(x => x.seq), [1, 2, 3]);
    assert.equal(s.state().revision, rev);
    await s.setFilters({ text: { query: '', regex: false, caseSensitive: false } });
    await search;
  } finally {
    await s.dispose();
  }
});

test('setOptions and a level change during a search do not abort it; the result uses the new options', async () => {
  const s = await opened([tmpFile(repeats())]);
  try {
    const search = s.setFilters({ text: { query: 'fbPump', regex: false, caseSensitive: false } });
    s.setOptions({ groupRepeats: true });
    await s.setFilters({ levels: ['info'] });
    assert.equal(s.state().filters.text, undefined);
    assert.equal(s.state().matched, 3);
    await search;
    const st = s.state();
    assert.equal(st.filters.text?.query, 'fbPump');
    assert.deepEqual(st.filters.levels, ['info']);
    assert.equal(st.options.groupRepeats, true);
    assert.equal(st.matched, 3);
    assert.equal(st.rowCount, 2);
    const r = await s.rows(st.revision, 0, 5);
    assert.deepEqual(r.map(x => x.repeat), [1, 2]);
  } finally {
    await s.dispose();
  }
});

test('dispose during a search resolves without errors', async () => {
  const s = await opened([tmpFile(catastrophic())]);
  const search = s.setFilters({ text: SLOW });
  const t0 = Date.now();
  await s.dispose();
  await search;
  assert.ok(Date.now() - t0 < 1000);
});

test('dispose during a rows read closes the files after the read', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  const rev = s.state().revision;
  let rowsDone = false;
  const read = s.rows(rev, 0, 3).then(r => { rowsDone = true; return r; });
  await s.dispose();
  assert.equal(rowsDone, true);
  assert.equal((await read).length, 3);
  await assert.rejects(s.rows(rev, 0, 1));
});

test('a valid query equal to the applied one clears the error of an invalid one', async () => {
  const s = await opened([path.join(fixtures, 'logger-lf.log')]);
  try {
    await s.setFilters({ text: { query: 'pump', regex: true, caseSensitive: false } });
    await s.setFilters({ text: { query: 'pump(', regex: true, caseSensitive: false } });
    assert.match(s.state().error ?? '', /^Invalid regular expression/);
    const rev = s.state().revision;
    await s.setFilters({ text: { query: 'pump', regex: true, caseSensitive: false } });
    assert.equal(s.state().error, undefined);
    assert.ok(s.state().revision > rev);
  } finally {
    await s.dispose();
  }
});

test('an invalid query still applies the other filter parts and keeps the applied text', async () => {
  const s = await opened([tmpFile(repeats())]);
  try {
    await s.setFilters({ text: { query: 'valve', regex: false, caseSensitive: false } });
    assert.equal(s.state().matched, 2);
    await s.setFilters({ levels: ['error'], text: { query: '(', regex: true, caseSensitive: false } });
    const st = s.state();
    assert.match(st.error ?? '', /^Invalid regular expression/);
    assert.deepEqual(st.filters.levels, ['error']);
    assert.equal(st.filters.text?.query, 'valve');
    assert.equal(st.matched, 1);
    assert.equal(st.hiddenBy.level, 1);
    // The applied flags are still in use once all levels show again.
    await s.setFilters({ levels: ['error', 'warning', 'info', 'debug', 'other'] });
    assert.equal(s.state().matched, 2);
    assert.equal(s.state().hiddenBy.text, 3);
  } finally {
    await s.dispose();
  }
});

test('a running search interrupted by an invalid query never wipes the error later', async () => {
  const s = await opened([tmpFile(catastrophic())]);
  try {
    const search = s.setFilters({ text: SLOW });
    await s.setFilters({ text: { query: '(', regex: true, caseSensitive: false } });
    await search;
    await new Promise(r => setTimeout(r, 50));
    assert.match(s.state().error ?? '', /^Invalid regular expression/);
    assert.equal(s.state().filters.text, undefined);
    assert.equal(s.state().matched, 3);
  } finally {
    await s.dispose();
  }
});

test('with grouping the delta after a group counts from its last member', async () => {
  const lines: string[] = [];
  for (let k = 0; k < 10; k++) lines.push(entry(k + 1, k * 1000, 'INFO', 'fbMain.fbPump', 'Cycle done'));
  lines.push(entry(11, 10000, 'INFO', 'fbMain.fbPump', 'Cycle end'));
  const s = await opened([tmpFile(lines.join('\n') + '\n')], { groupRepeats: true, gapMs: 5000 });
  try {
    const rev = s.state().revision;
    const r = await s.rows(rev, 0, 2);
    assert.deepEqual(r.map(x => x.repeat), [10, 1]);
    assert.equal(r[1].deltaMs, 1000);
    assert.equal(r[1].gap, false);
    const w = await s.rows(rev, 1, 1);
    assert.equal(w[0].deltaMs, 1000);
  } finally {
    await s.dispose();
  }
});

test('a bookmark on a later group member shows on the row, is found by jump and cleared by toggling', async () => {
  const s = await opened([tmpFile(repeats())]);
  try {
    s.toggleBookmark(s.state().revision, 4);
    s.setOptions({ groupRepeats: true });
    const rev = s.state().revision;
    const r = await s.rows(rev, 3, 1);
    assert.equal(r[0].repeat, 2);
    assert.equal(r[0].bookmarked, true);
    assert.equal(s.jump(rev, -1, 1, 'bookmark'), 3);
    assert.equal(s.jump(rev, s.state().rowCount, -1, 'bookmark'), 3);
    s.toggleBookmark(rev, 3);
    assert.equal((await s.rows(rev, 3, 1))[0].bookmarked, false);
    assert.equal(s.jump(rev, -1, 1, 'bookmark'), -1);
    s.toggleBookmark(rev, 3);
    s.toggleBookmark(rev, 3);
    s.setOptions({ groupRepeats: false });
    const all = await s.rows(s.state().revision, 0, 5);
    assert.deepEqual(all.map(x => x.bookmarked), [false, false, false, false, false]);
  } finally {
    await s.dispose();
  }
});

test('dispose during load makes load resolve quietly', async () => {
  const p = path.join(tmp, 'big.log');
  writeSyntheticLog(p, 3 * 1024 * 1024);
  const s = LogSession.open([p], [], OPTS);
  const loading = s.load();
  await new Promise(r => setImmediate(r));
  await s.dispose();
  await loading;
});

// ---------- live tail (refresh) ----------

const PUMP = (seq: number) => entry(seq, seq * 100, 'INFO', 'fbMain.fbPump', `Pump cycle ${seq}`);
const VALVE = (seq: number) => entry(seq, seq * 100, 'ERROR', 'fbMain.fbPump.fbValve', `Valve stuck ${seq}`);

function grow(p: string, text: string): void {
  fs.appendFileSync(p, text);
}

test('refresh after appending two entries adds exactly them and keeps the earlier rows', async () => {
  const p = tmpFile([PUMP(1), PUMP(2), PUMP(3)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const before = await s.rows(s.state().revision, 0, 3);
    grow(p, [PUMP(4), VALVE(5)].join('\n') + '\n');
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.total, 5);
    assert.equal(st.rowCount, 5);
    assert.equal(st.fileGeneration, 0);
    assert.deepEqual(st.levelCounts, { error: 1, warning: 0, info: 4, debug: 0, other: 0 });
    assert.equal(st.lastTimeMs, T0 + 500);
    const r = await s.rows(st.revision, 0, 10);
    assert.deepEqual(r.slice(0, 3).map(x => [x.pos, x.index, x.message]), before.map(x => [x.pos, x.index, x.message]));
    assert.deepEqual(r.map(x => x.message), ['Pump cycle 1', 'Pump cycle 2', 'Pump cycle 3', 'Pump cycle 4', 'Valve stuck 5']);
  } finally {
    await s.dispose();
  }
});

test('refresh after a continuation line updates the last entry without a duplicate', async () => {
  const p = tmpFile([PUMP(1), VALVE(2)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    grow(p, '  detail of the stuck valve\n');
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.total, 2);
    assert.deepEqual(st.levelCounts, { error: 1, warning: 0, info: 1, debug: 0, other: 0 });
    const r = await s.rows(st.revision, 0, 5);
    assert.equal(r.length, 2);
    assert.equal(r[1].extraLines, 1);
    assert.match((await s.detail(st.revision, 1)).text, /Valve stuck 2\n {2}detail of the stuck valve/);
  } finally {
    await s.dispose();
  }
});

test('refresh without a change returns false and keeps the revision', async () => {
  const s = await opened([tmpFile([PUMP(1), PUMP(2)].join('\n') + '\n')]);
  try {
    const rev = s.state().revision;
    assert.equal(await s.refresh(), false);
    assert.equal(s.state().revision, rev);
    assert.equal(s.state().total, 2);
  } finally {
    await s.dispose();
  }
});

test('a half-written last line appears only once it is complete', async () => {
  const p = tmpFile(PUMP(1) + '\n');
  const s = await opened([p]);
  try {
    const line = PUMP(2);
    grow(p, line.slice(0, 20));
    assert.equal(await s.refresh(), false);
    assert.equal(s.state().total, 1);
    assert.equal((await s.rows(s.state().revision, 0, 5))[0].extraLines, 0);
    grow(p, line.slice(20) + '\n');
    assert.equal(await s.refresh(), true);
    const r = await s.rows(s.state().revision, 0, 5);
    assert.deepEqual(r.map(x => x.message), ['Pump cycle 1', 'Pump cycle 2']);
    assert.equal(r[0].extraLines, 0);
  } finally {
    await s.dispose();
  }
});

test('a shorter file reloads with a new fileGeneration, clears bookmarks and searches the new content', async () => {
  const p = tmpFile([PUMP(1), VALVE(2), VALVE(3)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    await s.setFilters({ text: { query: 'valve', regex: false, caseSensitive: false } });
    assert.equal(s.state().matched, 2);
    s.toggleBookmark(s.state().revision, 0);
    fs.writeFileSync(p, [VALVE(1), PUMP(2)].join('\n') + '\n');
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.fileGeneration, 1);
    assert.equal(st.total, 2);
    assert.equal(st.matched, 1);
    assert.equal(st.filters.text?.query, 'valve');
    const r = await s.rows(st.revision, 0, 5);
    assert.deepEqual(r.map(x => x.message), ['Valve stuck 1']);
    assert.equal(r[0].bookmarked, false);
    assert.equal(s.jump(st.revision, -1, 1, 'bookmark'), -1);
  } finally {
    await s.dispose();
  }
});

test('a file deleted and recreated with the same start and size reloads', async t => {
  const p = tmpFile([PUMP(1), entry(2, 200, 'INFO', 'fbMain.fbPump', 'one')].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const old = fs.statSync(p);
    fs.unlinkSync(p);
    fs.writeFileSync(p, [PUMP(1), entry(2, 200, 'INFO', 'fbMain.fbPump', 'six')].join('\n') + '\n');
    const now = fs.statSync(p);
    assert.equal(now.size, old.size);
    if (now.ino === old.ino && now.birthtimeMs === old.birthtimeMs) {
      t.skip('the file system reports neither a new inode nor a new birth time for the recreated file');
      return;
    }
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.fileGeneration, 1);
    assert.deepEqual((await s.rows(st.revision, 0, 5)).map(x => x.message), ['Pump cycle 1', 'six']);
  } finally {
    await s.dispose();
  }
});

test('a file rewritten in place with a different start reloads', async () => {
  const p = tmpFile([PUMP(1), PUMP(2)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const rev = s.state().revision;
    s.toggleBookmark(rev, 1);
    fs.writeFileSync(p, [entry(7, 100, 'INFO', 'fbMain.fbPump', 'Pump cycle 7'), PUMP(2), PUMP(3)].join('\n') + '\n');
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.fileGeneration, 1);
    const r = await s.rows(st.revision, 0, 5);
    assert.deepEqual(r.map(x => x.seq), [7, 2, 3]);
    assert.deepEqual(r.map(x => x.bookmarked), [false, false, false]);
  } finally {
    await s.dispose();
  }
});

test('a rows read started before a reload finishes and answers from its snapshot', async () => {
  const p = tmpFile([PUMP(1), PUMP(2), PUMP(3)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const rev = s.state().revision;
    await s.rows(rev, 0, 1);
    fs.writeFileSync(p, PUMP(1) + '\n');
    const read = s.rows(rev, 0, 3);
    const refresh = s.refresh();
    const r = await read;
    assert.deepEqual(r.map(x => x.pos), [0, 1, 2]);
    assert.equal(await refresh, true);
    assert.equal(s.state().fileGeneration, 1);
    assert.deepEqual((await s.rows(s.state().revision, 0, 5)).map(x => x.message), ['Pump cycle 1']);
  } finally {
    await s.dispose();
  }
});

test('rows during a refresh answer from the previous snapshot', async () => {
  const p = tmpFile([PUMP(1), PUMP(2)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    const rev = s.state().revision;
    grow(p, PUMP(3) + '\n');
    const refresh = s.refresh();
    const r = await s.rows(rev, 0, 5);
    assert.equal(r.length, 2);
    assert.equal(await refresh, true);
    assert.ok(s.state().revision > rev);
    await assert.rejects(s.rows(rev, 0, 1), StaleError);
  } finally {
    await s.dispose();
  }
});

test('setOptions during a refresh keeps both effects', async () => {
  const p = tmpFile([PUMP(1), PUMP(2)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    grow(p, [entry(3, 300, 'INFO', 'fbMain.x', 'same'), entry(4, 400, 'INFO', 'fbMain.x', 'same')].join('\n') + '\n');
    const refresh = s.refresh();
    s.setOptions({ groupRepeats: true });
    assert.equal(await refresh, true);
    const st = s.state();
    assert.equal(st.total, 4);
    assert.equal(st.options.groupRepeats, true);
    assert.equal(st.rowCount, 3);
  } finally {
    await s.dispose();
  }
});

test('ten refresh calls in a row run at most two refreshes', async () => {
  const p = tmpFile(PUMP(1) + '\n');
  const s = await opened([p]);
  try {
    grow(p, PUMP(2) + '\n');
    const calls = Array.from({ length: 10 }, () => s.refresh());
    assert.ok(new Set(calls).size <= 2, `${new Set(calls).size} refreshes`);
    const results = await Promise.all(calls);
    assert.equal(results[0], true);
    assert.equal(s.state().total, 2);
    // A refresh requested after these ran starts anew.
    grow(p, PUMP(3) + '\n');
    assert.equal(await s.refresh(), true);
    assert.equal(s.state().total, 3);
  } finally {
    await s.dispose();
  }
});

test('dispose during a refresh resolves without errors', async () => {
  const p = tmpFile(PUMP(1) + '\n');
  const s = await opened([p]);
  grow(p, PUMP(2) + '\n');
  const refresh = s.refresh();
  await s.dispose();
  assert.equal(typeof (await refresh), 'boolean');
});

test('with a text filter refresh flags the new matching entry, keeps the earlier flags and searches only the tail', async () => {
  const lines: string[] = [];
  for (let k = 1; k <= 200; k++) lines.push(k % 10 === 0 ? VALVE(k) : PUMP(k));
  const p = tmpFile(lines.join('\n') + '\n');
  const s = await opened([p]);
  try {
    await s.setFilters({ text: { query: 'valve', regex: false, caseSensitive: false } });
    assert.equal(s.state().matched, 20);
    const lastLength = Buffer.byteLength(lines[lines.length - 1] + '\n');
    const added = [PUMP(201), VALVE(202)].join('\n') + '\n';
    grow(p, added);
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.total, 202);
    assert.equal(st.matched, 21);
    assert.equal(st.hiddenBy.text, 181);
    const r = await s.rows(st.revision, 0, 30);
    assert.equal(r[0].message, 'Valve stuck 10');
    assert.equal(r[20].message, 'Valve stuck 202');
    assert.ok(s.tailSearchBytes > 0);
    assert.ok(s.tailSearchBytes <= Buffer.byteLength(added) + lastLength, `tail search read ${s.tailSearchBytes} bytes`);
  } finally {
    await s.dispose();
  }
});

test('a text query changed during a refresh also covers the appended entries', async () => {
  const p = tmpFile([PUMP(1), VALVE(2)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    await s.setFilters({ text: { query: 'valve', regex: false, caseSensitive: false } });
    grow(p, [PUMP(3), VALVE(4)].join('\n') + '\n');
    const refresh = s.refresh();
    const search = s.setFilters({ text: { query: 'pump cycle', regex: false, caseSensitive: false } });
    await Promise.all([refresh, search]);
    const st = s.state();
    assert.equal(st.total, 4);
    assert.equal(st.filters.text?.query, 'pump cycle');
    assert.deepEqual((await s.rows(st.revision, 0, 5)).map(x => x.seq), [1, 3]);
  } finally {
    await s.dispose();
  }
});

test('a limit error during refresh sets liveError, keeps the entries and the query error; a later reload clears it', async () => {
  const p = tmpFile([PUMP(1), PUMP(2)].join('\n') + '\n');
  const s = LogSession.open([p], [], OPTS, { maxEntries: 3 });
  await s.load();
  try {
    await s.setFilters({ text: { query: '(', regex: true, caseSensitive: false } });
    grow(p, [PUMP(3), PUMP(4)].join('\n') + '\n');
    assert.equal(await s.refresh(), true);
    let st = s.state();
    assert.match(st.liveError ?? '', /Too many entries/);
    assert.match(st.error ?? '', /^Invalid regular expression/);
    assert.equal(st.total, 2);
    assert.deepEqual((await s.rows(st.revision, 0, 5)).map(x => x.seq), [1, 2]);
    // The same failure again changes nothing.
    assert.equal(await s.refresh(), false);
    fs.writeFileSync(p, PUMP(1) + '\n');
    assert.equal(await s.refresh(), true);
    st = s.state();
    assert.equal(st.liveError, undefined);
    assert.equal(st.fileGeneration, 1);
    assert.equal(st.total, 1);
    assert.match(st.error ?? '', /^Invalid regular expression/);
  } finally {
    await s.dispose();
  }
});

test('an invalid query error survives a live append', async () => {
  const p = tmpFile([PUMP(1), PUMP(2)].join('\n') + '\n');
  const s = await opened([p]);
  try {
    await s.setFilters({ text: { query: '(', regex: true, caseSensitive: false } });
    grow(p, PUMP(3) + '\n');
    assert.equal(await s.refresh(), true);
    const st = s.state();
    assert.equal(st.total, 3);
    assert.match(st.error ?? '', /^Invalid regular expression/);
    assert.equal(st.liveError, undefined);
  } finally {
    await s.dispose();
  }
});

test('refresh of a merged session does nothing', async () => {
  const a = tmpFile(PUMP(1) + '\n');
  const b = tmpFile(PUMP(2) + '\n');
  const s = await opened([a, b]);
  try {
    grow(a, PUMP(3) + '\n');
    assert.equal(await s.refresh(), false);
    assert.equal(s.state().total, 2);
  } finally {
    await s.dispose();
  }
});

test('a text query set before load is applied by load', async () => {
  const s = LogSession.open([path.join(fixtures, 'logger-lf.log')], [], OPTS);
  try {
    await s.setFilters({ text: { query: 'valve', regex: false, caseSensitive: false } });
    await s.load();
    const st = s.state();
    assert.equal(st.total, 3);
    assert.equal(st.matched, 2);
    assert.equal(st.hiddenBy.text, 1);
    assert.equal(st.filters.text?.query, 'valve');
  } finally {
    await s.dispose();
  }
});

function tmpEntries(): string[] {
  return fs.readdirSync(tmp).filter(f => f.endsWith('.tmp'));
}

test('exportTo writes exactly the matched entries, each with its continuation lines', async () => {
  const p = tmpFile(repeats());
  const s = await opened([p]);
  try {
    await s.setFilters({ levels: ['error'] });
    const dest = path.join(tmp, 'errors.log');
    const n = await s.exportTo(dest);
    assert.equal(n, 1);
    assert.equal(fs.readFileSync(dest, 'utf8'), entry(3, 5100, 'ERROR', 'fbMain.fbPump.fbValve', 'Valve stuck') + '\n  detail line\n');
    assert.deepEqual(tmpEntries(), []);
    // The export opens as a log with total equal to the matched count.
    const re = await opened([dest]);
    try {
      assert.equal(re.state().total, s.state().matched);
    } finally {
      await re.dispose();
    }
  } finally {
    await s.dispose();
  }
});

test('exportTo writes every member of a grouped row', async () => {
  const lines = [0, 1, 2].map(i => entry(i + 1, i * 10, 'INFO', 'fbMain.fbPump', 'Cycle done'));
  const p = tmpFile(lines.join('\n') + '\n');
  const s = await opened([p], { groupRepeats: true, gapMs: 1000 });
  try {
    assert.equal(s.state().rowCount, 1);
    const dest = path.join(tmp, 'group.log');
    assert.equal(await s.exportTo(dest), 3);
    assert.equal(fs.readFileSync(dest, 'utf8'), lines.map(l => l + '\n').join(''));
  } finally {
    await s.dispose();
  }
});

test('exportTo refuses an input file as destination and leaves it unchanged', async () => {
  const content = repeats();
  const p = tmpFile(content);
  const s = await opened([p]);
  try {
    const rejects = (d: string) => assert.rejects(s.exportTo(d),
      (e: Error) => e instanceof LogFormatError && e.message === 'Cannot export into a file that is open in the viewer');
    await rejects(p);
    await rejects(path.join(path.dirname(p), '.', path.basename(p)));
    if (process.platform === 'win32') await rejects(path.join(path.dirname(p), path.basename(p).toUpperCase()));
    assert.equal(fs.readFileSync(p, 'utf8'), content);
    assert.deepEqual(tmpEntries(), []);
  } finally {
    await s.dispose();
  }
});

test('exportTo of a merged session refuses any of its inputs', async () => {
  const a = tmpFile(repeats());
  const b = tmpFile(repeats());
  const s = await opened([a, b]);
  try {
    await assert.rejects(s.exportTo(b), (e: Error) => e instanceof LogFormatError);
  } finally {
    await s.dispose();
  }
});

/** So many entries that the export needs several chunks, so an abort can land in the middle. */
function manyEntries(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(entry(i + 1, i, 'INFO', 'fbMain.fbPump', 'x'.repeat(200) + i));
  return lines.join('\n') + '\n';
}

test('an aborted export leaves neither destination nor temp file', async () => {
  const p = tmpFile(manyEntries(20000));
  const s = await opened([p]);
  try {
    const dest = path.join(tmp, 'aborted.log');
    const ac = new AbortController();
    const run = s.exportTo(dest, ac.signal);
    setImmediate(() => ac.abort());
    await assert.rejects(run, (e: Error) => e.name === 'AbortError');
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(tmpEntries(), []);
  } finally {
    await s.dispose();
  }
});

test('an aborted export keeps the old content of an existing destination', async () => {
  const p = tmpFile(repeats());
  const s = await opened([p]);
  try {
    const dest = tmpFile('old content\n', 'keep.log');
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(s.exportTo(dest, ac.signal), (e: Error) => e.name === 'AbortError');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'old content\n');
    assert.deepEqual(tmpEntries(), []);
  } finally {
    await s.dispose();
  }
});

test('an existing destination is replaced after a successful export', async () => {
  const p = tmpFile(repeats());
  const s = await opened([p]);
  try {
    const dest = tmpFile('old content\n', 'replace.log');
    assert.equal(await s.exportTo(dest), 5);
    assert.equal(fs.readFileSync(dest, 'utf8'), repeats());
    assert.deepEqual(tmpEntries(), []);
  } finally {
    await s.dispose();
  }
});

test('a failing export (missing folder) leaves nothing behind', async () => {
  const p = tmpFile(repeats());
  const s = await opened([p]);
  try {
    await assert.rejects(s.exportTo(path.join(tmp, 'no-such-folder', 'x.log')));
    assert.deepEqual(tmpEntries(), []);
  } finally {
    await s.dispose();
  }
});

test('an export is not affected by filters that change while it runs', async () => {
  const p = tmpFile(repeats());
  const s = await opened([p]);
  try {
    const dest = path.join(tmp, 'snapshot.log');
    const run = s.exportTo(dest);
    await s.setFilters({ levels: ['error'] });
    assert.equal(await run, 5);
    assert.equal(fs.readFileSync(dest, 'utf8'), repeats());
  } finally {
    await s.dispose();
  }
});
