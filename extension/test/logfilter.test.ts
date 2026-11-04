import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntryStore } from '../src/core/logstore';
import { LEVELS } from '../src/core/logformat';
import { applyFilters, timelineOrder, Filters } from '../src/core/logfilter';

const ALL = LEVELS.slice();
const t = (h: number, m: number) => Date.UTC(2026, 0, 1, h, m, 0);

interface E { file: number; time: number; sortTime?: number; level: string; source: string }

function build(entries: E[]): EntryStore {
  const s = new EntryStore();
  let offset = 0;
  entries.forEach((e, i) => {
    s.append({
      time: e.time, sortTime: e.sortTime ?? e.time, level: LEVELS.indexOf(e.level as never), source: e.source,
      seq: i, file: e.file, offset: offset += 10, length: 10, firstLength: 10, terminated: 1, lines: 1, hash: 0,
    });
  });
  return s;
}

// Entries 0-3 belong to file 0, entries 4-7 to file 1.
function eight(): EntryStore {
  return build([
    { file: 0, time: NaN, sortTime: t(10, 0), level: 'info', source: 'fbMain' },
    { file: 0, time: t(10, 0), level: 'error', source: 'fbMain.fbPump' },
    { file: 0, time: t(10, 5), level: 'warning', source: 'fbMain.fbValve' },
    { file: 0, time: t(10, 10), level: 'debug', source: 'fbMain.fbPump' },
    { file: 1, time: t(10, 0), level: 'info', source: 'fbMain' },
    { file: 1, time: t(10, 3), level: 'error', source: 'fbMain.fbValve' },
    { file: 1, time: t(10, 5), level: 'other', source: 'fbMain.fbPump' },
    { file: 1, time: t(10, 12), level: 'error', source: 'fbMain' },
  ]);
}

const noFilter = (): Filters => ({ levels: ALL });

test('two files interleave by time, equal times keep file order, boot entry leads its file', () => {
  const s = eight();
  // Boot entry 0 has sortTime 10:00 (same as entries 1 and 4): file 0 run first, store order inside the file.
  assert.deepEqual(Array.from(timelineOrder(s, 2)), [0, 1, 4, 5, 2, 6, 3, 7]);
});

test('boot entry without any dated entry in its file sorts first', () => {
  const s = build([
    { file: 0, time: t(9, 0), level: 'info', source: 'a' },
    { file: 1, time: NaN, sortTime: -Infinity, level: 'info', source: 'a' },
    { file: 1, time: t(8, 0), level: 'info', source: 'a' },
  ]);
  assert.deepEqual(Array.from(timelineOrder(s, 2)), [1, 2, 0]);
});

test('one file keeps scan order even when times run backwards (DST fall-back)', () => {
  const s = build([
    { file: 0, time: t(2, 30), level: 'info', source: 'a' },
    { file: 0, time: t(2, 59), level: 'info', source: 'a' },
    { file: 0, time: t(2, 5), level: 'info', source: 'a' },
    { file: 0, time: t(2, 40), level: 'info', source: 'a' },
  ]);
  assert.deepEqual(Array.from(timelineOrder(s, 1)), [0, 1, 2, 3]);
});

test('a merge never reorders the entries of one file', () => {
  const s = build([
    { file: 0, time: t(2, 30), level: 'info', source: 'a' },
    { file: 0, time: t(2, 59), level: 'info', source: 'a' },
    { file: 0, time: t(2, 5), level: 'info', source: 'a' },
    { file: 0, time: t(2, 40), level: 'info', source: 'a' },
    { file: 1, time: t(2, 20), level: 'info', source: 'a' },
    { file: 1, time: t(2, 45), level: 'info', source: 'a' },
  ]);
  const order = Array.from(timelineOrder(s, 2));
  assert.deepEqual(order.filter(i => i < 4), [0, 1, 2, 3]);
  assert.deepEqual(order, [4, 0, 5, 1, 2, 3]);
});

test('levels filter keeps matching levels and counts what switching it off would reveal', () => {
  const s = eight();
  const order = timelineOrder(s, 2);
  const r = applyFilters(s, order, { levels: ['error'] });
  assert.deepEqual(Array.from(r.indices), [1, 5, 7]);
  assert.equal(r.hiddenBy.level, 5);
  assert.deepEqual(r.hiddenBy, { level: 5, time: 0, source: 0, text: 0, file: 0 });
});

test('time range drops dated entries outside it and keeps the boot entry', () => {
  const s = eight();
  const r = applyFilters(s, timelineOrder(s, 2), { levels: ALL, from: t(10, 3), to: t(10, 10) });
  assert.deepEqual(Array.from(r.indices), [0, 5, 2, 6, 3]);
  assert.equal(r.hiddenBy.time, 3);
});

test('source filter is a case-insensitive substring match', () => {
  const s = eight();
  const r = applyFilters(s, timelineOrder(s, 2), { levels: ALL, source: 'PUMP' });
  assert.deepEqual(Array.from(r.indices), [1, 6, 3]);
  assert.equal(r.hiddenBy.source, 5);
});

test('text flags filter entries and are counted', () => {
  const s = eight();
  const text = new Uint8Array(8);
  text[2] = 1; text[7] = 1;
  const r = applyFilters(s, Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7]), { levels: ALL, text });
  assert.deepEqual(Array.from(r.indices), [2, 7]);
  assert.equal(r.hiddenBy.text, 6);
});

test('an entry failing two filters counts in neither hiddenBy value', () => {
  const s = eight();
  const order = timelineOrder(s, 2);
  // Errors only + source "pump": entry 1 passes both; 5 and 7 fail source only; 3 and 6 fail level only;
  // the remaining entries (0, 2, 4) fail both.
  const r = applyFilters(s, order, { levels: ['error'], source: 'pump' });
  assert.deepEqual(Array.from(r.indices), [1]);
  assert.equal(r.hiddenBy.level, 2);
  assert.equal(r.hiddenBy.source, 2);
  const sum = r.hiddenBy.level + r.hiddenBy.time + r.hiddenBy.source + r.hiddenBy.text + r.hiddenBy.file;
  assert.ok(r.indices.length + sum <= s.count);
});

test('files filter keeps the listed file indices and counts the hidden entries', () => {
  const s = eight();
  const r = applyFilters(s, timelineOrder(s, 2), { levels: ALL, files: [1] });
  assert.deepEqual(Array.from(r.indices), [4, 5, 6, 7]);
  assert.deepEqual(r.hiddenBy, { level: 0, time: 0, source: 0, text: 0, file: 4 });
});

test('an empty files list hides every entry, undefined shows every file', () => {
  const s = eight();
  const order = timelineOrder(s, 2);
  const none = applyFilters(s, order, { levels: ALL, files: [] });
  assert.equal(none.indices.length, 0);
  assert.equal(none.hiddenBy.file, 8);
  const all = applyFilters(s, order, { levels: ALL, files: undefined });
  assert.equal(all.indices.length, 8);
  assert.equal(all.hiddenBy.file, 0);
});

test('an entry failing the files filter and another one counts in neither hiddenBy value', () => {
  const s = eight();
  // Errors only + file 0 visible: entry 1 passes; 5 and 7 fail file only; 0, 2, 3 fail level only; 4 and 6 fail both.
  const r = applyFilters(s, timelineOrder(s, 2), { levels: ['error'], files: [0] });
  assert.deepEqual(Array.from(r.indices), [1]);
  assert.equal(r.hiddenBy.file, 2);
  assert.equal(r.hiddenBy.level, 3);
});

test('empty levels returns no entries', () => {
  const s = eight();
  const r = applyFilters(s, timelineOrder(s, 2), { levels: [] });
  assert.equal(r.indices.length, 0);
  assert.equal(r.hiddenBy.level, 8);
});

test('no filters keep everything in the given order', () => {
  const s = eight();
  const order = timelineOrder(s, 2);
  const r = applyFilters(s, order, noFilter());
  assert.deepEqual(Array.from(r.indices), Array.from(order));
});

test('one million entries merge and filter within the time budget', () => {
  const s = new EntryStore({ maxEntries: 2_000_000 });
  const n = 1_000_000;
  for (let i = 0; i < n; i++) {
    const f = i % 3;
    const time = Date.UTC(2026, 0, 1) + Math.floor(i / 3) * 1000;
    s.append({ time, sortTime: time, level: i % 5, source: 's' + (i % 50), seq: i, file: f, offset: i, length: 1, firstLength: 1, terminated: 1, lines: 1, hash: 0 });
  }
  const start = performance.now();
  const order = timelineOrder(s, 3);
  const r = applyFilters(s, order, { levels: ['error', 'warning'], source: 's1' });
  const ms = performance.now() - start;
  assert.equal(order.length, n);
  assert.ok(r.indices.length > 0);
  assert.ok(ms < 1000, `took ${ms} ms`);
});
