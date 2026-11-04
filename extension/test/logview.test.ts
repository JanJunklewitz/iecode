import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUILT_IN_FORMATS, compileFormat } from '../src/core/logformat';
import { EntryStore } from '../src/core/logstore';
import { scanFile } from '../src/core/logscan';
import { LogView } from '../src/core/logview';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iecode-logview-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Entries given as [source, hash, time]; every other column is irrelevant for the view. */
function store(entries: Array<[string, number, number]>): EntryStore {
  const s = new EntryStore();
  entries.forEach(([source, hash, time], i) => s.append({
    time, sortTime: time, level: 2, source, seq: i + 1, file: 0, offset: i * 10, length: 9,
    firstLength: 9, terminated: 1, lines: 1, hash,
  }));
  return s;
}

function all(s: EntryStore): Uint32Array {
  return Uint32Array.from({ length: s.count }, (_, i) => i);
}

const T = Date.UTC(2026, 0, 15, 10, 0, 0, 0);
// a a a b a c c  -> groups [a a a] [b] [a] [c c]
const runs = (): EntryStore => store([
  ['fbMain.a', 1, T], ['fbMain.a', 1, T + 1], ['fbMain.a', 1, T + 2],
  ['fbMain.b', 2, T + 3], ['fbMain.a', 1, T + 4], ['fbMain.c', 3, T + 5], ['fbMain.c', 3, T + 6],
]);

test('without grouping every entry is one row', () => {
  const s = runs();
  const v = new LogView(s, all(s), { groupRepeats: false, gapMs: 0 });
  assert.equal(v.rowCount, 7);
  assert.deepEqual(v.rowEntries(0, 3), [{ index: 0, repeat: 1 }, { index: 1, repeat: 1 }, { index: 2, repeat: 1 }]);
  assert.deepEqual(Array.from(v.members(3)), [3]);
});

test('groupRepeats collapses consecutive entries with equal source and hash only', () => {
  const s = runs();
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  assert.equal(v.rowCount, 4);
  assert.deepEqual(v.rowEntries(0, 10), [
    { index: 0, repeat: 3 }, { index: 3, repeat: 1 }, { index: 4, repeat: 1 }, { index: 5, repeat: 2 },
  ]);
  assert.deepEqual(Array.from(v.members(0)), [0, 1, 2]);
  assert.deepEqual(Array.from(v.members(2)), [4]);
  assert.deepEqual(Array.from(v.members(3)), [5, 6]);
});

test('equal hash with a different source does not merge', () => {
  const s = store([['fbMain.a', 7, T], ['fbMain.b', 7, T], ['fbMain.b', 7, T]]);
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  assert.deepEqual(v.rowEntries(0, 5), [{ index: 0, repeat: 1 }, { index: 1, repeat: 2 }]);
});

test('grouping follows the filtered indices, so entries split by a hidden entry merge', () => {
  const s = runs();
  const v = new LogView(s, Uint32Array.from([0, 1, 2, 4, 5]), { groupRepeats: true, gapMs: 0 });
  assert.deepEqual(v.rowEntries(0, 5), [{ index: 0, repeat: 4 }, { index: 5, repeat: 1 }]);
  assert.deepEqual(Array.from(v.members(0)), [0, 1, 2, 4]);
});

test('an INFO and an ERROR entry with the same source and message stay two rows', async () => {
  const p = path.join(tmp, 'levels.log');
  fs.writeFileSync(p, [
    '0000000001 - 2026-01-15-10:00:01.000 - INFO - fbMain.fbPump - Same text',
    '0000000002 - 2026-01-15-10:00:02.000 - ERROR - fbMain.fbPump - Same text',
    '0000000003 - 2026-01-15-10:00:03.000 - ERROR - fbMain.fbPump - Same text',
  ].join('\n') + '\n');
  const s = new EntryStore();
  await scanFile(p, 0, compileFormat(BUILT_IN_FORMATS[0]), s);
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  assert.equal(v.rowCount, 2);
  assert.deepEqual(v.rowEntries(0, 2), [{ index: 0, repeat: 1 }, { index: 1, repeat: 2 }]);
});

test('rowEntries clamps the window to the rows', () => {
  const s = runs();
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  assert.deepEqual(v.rowEntries(3, 10), [{ index: 5, repeat: 2 }]);
  assert.deepEqual(v.rowEntries(4, 10), []);
  assert.deepEqual(v.rowEntries(-2, 3), [{ index: 0, repeat: 3 }]);
});

test('find returns the next or previous matching row and -1 at the ends', () => {
  const s = runs();
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  const isA = (i: number): boolean => s.sources[s.source[i]] === 'fbMain.a';
  assert.equal(v.find(-1, 1, isA), 0);
  assert.equal(v.find(0, 1, isA), 2);
  assert.equal(v.find(2, 1, isA), -1);
  assert.equal(v.find(v.rowCount, -1, isA), 2);
  assert.equal(v.find(2, -1, isA), 0);
  assert.equal(v.find(0, -1, isA), -1);
});

test('previousTime gives the time of the row before, for the delta of the first row of a window', () => {
  const s = runs();
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  assert.equal(v.previousTime(0), undefined);
  // The row before is the group [a a a]; the delta counts from its last member.
  assert.equal(v.previousTime(1), T + 2);
  assert.equal(v.previousTime(3), T + 4);
});

test('find passes the row position to the predicate', () => {
  const s = runs();
  const v = new LogView(s, all(s), { groupRepeats: true, gapMs: 0 });
  assert.equal(v.find(-1, 1, (_i, pos) => v.members(pos).includes(6)), 3);
});

test('previousTime is undefined when the row before has no time', () => {
  const s = store([['fbMain.a', 1, NaN], ['fbMain.b', 2, T]]);
  const v = new LogView(s, all(s), { groupRepeats: false, gapMs: 0 });
  assert.equal(v.previousTime(1), undefined);
});

test('an empty view has no rows', () => {
  const s = new EntryStore();
  const v = new LogView(s, new Uint32Array(0), { groupRepeats: true, gapMs: 0 });
  assert.equal(v.rowCount, 0);
  assert.deepEqual(v.rowEntries(0, 10), []);
  assert.equal(v.find(-1, 1, () => true), -1);
});
