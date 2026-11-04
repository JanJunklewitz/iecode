import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogLimitError } from '../src/core/logstore';
import { LogSession, StaleError } from '../src/core/logsession';

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
    assert.equal(st.revision, rev);
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
