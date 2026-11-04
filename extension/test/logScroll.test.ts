import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

interface Win { pos: number; count: number }
interface Requests {
  readonly rev: number;
  next(rev: number): { id: number; rev: number };
  accept(reply: { id: number; rev: number }): boolean;
  onState(rev: number): boolean;
}
interface LogScroll {
  ROW_HEIGHT: number;
  MAX_HEIGHT: number;
  scrollHeight(rowCount: number): number;
  rowToScrollTop(row: number, rowCount: number, viewportPx: number): number;
  scrollTopToRow(scrollTop: number, rowCount: number, viewportPx: number): number;
  renderRange(scrollTop: number, rowCount: number, viewportPx: number, margin?: number): { first: number; start: number; end: number; top: number };
  windowFor(firstRow: number, visibleRows: number, rowCount: number): Win;
  needsWindow(have: Win | undefined, start: number, end: number, rowCount: number): boolean;
  createRequests(): Requests;
}

// The webview script is plain JS in media/; out/test/*.js sits two levels below the extension folder.
const ls = require(path.join(__dirname, '..', '..', 'media', 'logScroll.js')) as LogScroll;

const VIEWPORT = 410;

for (const rowCount of [100, 5_000_000]) {
  // The last row that can be the first visible one, with a partial row in a viewport of 20.5 rows.
  const lastTop = rowCount - Math.ceil(VIEWPORT / 20);
  test(`row and scroll position round-trip for ${rowCount} rows`, () => {
    for (const row of [0, Math.floor(rowCount / 2), lastTop]) {
      const top = ls.rowToScrollTop(row, rowCount, VIEWPORT);
      assert.ok(top >= 0 && top <= ls.scrollHeight(rowCount) - VIEWPORT, `scrollTop ${top} of row ${row} is in range`);
      assert.equal(ls.scrollTopToRow(top, rowCount, VIEWPORT), row);
    }
  });

  test(`the last of ${rowCount} rows is reachable`, () => {
    const maxTop = ls.scrollHeight(rowCount) - VIEWPORT;
    assert.equal(ls.rowToScrollTop(rowCount - 1, rowCount, VIEWPORT), maxTop);
    const r = ls.renderRange(maxTop, rowCount, VIEWPORT);
    assert.equal(r.end, rowCount);
    assert.ok(r.top + (r.end - 1 - r.start) * ls.ROW_HEIGHT + ls.ROW_HEIGHT <= ls.scrollHeight(rowCount), 'last row lies inside the scroll area');
    assert.ok(r.top + (r.end - 1 - r.start) * ls.ROW_HEIGHT >= maxTop, 'last row is inside the viewport');
  });
}

test('the scroll height is real up to 10 million px and capped above', () => {
  assert.equal(ls.scrollHeight(0), 0);
  assert.equal(ls.scrollHeight(100), 2000);
  assert.equal(ls.scrollHeight(500_000), 10_000_000);
  assert.equal(ls.scrollHeight(5_000_000), ls.MAX_HEIGHT);
});

test('rows lie at their real position below the cap and at the viewport top above', () => {
  const real = ls.renderRange(1010, 100, VIEWPORT, 3);
  assert.equal(real.first, 50);
  assert.equal(real.start, 47);
  assert.equal(real.top, 47 * 20);
  const prop = ls.renderRange(4_000_000, 5_000_000, VIEWPORT, 3);
  assert.equal(prop.start, prop.first);
  assert.equal(prop.top, 4_000_000);
});

test('windowFor stays inside 0..rowCount', () => {
  for (const rowCount of [0, 10, 100, 5_000_000]) {
    for (const first of [0, 5, Math.floor(rowCount / 2), rowCount - 1, rowCount]) {
      const w = ls.windowFor(first, 21, rowCount);
      assert.ok(w.pos >= 0, `pos ${w.pos} >= 0`);
      assert.ok(w.count >= 0 && w.pos + w.count <= rowCount, `window ${w.pos}+${w.count} within ${rowCount}`);
      if (rowCount > 0) assert.ok(w.pos <= Math.max(0, Math.min(first, rowCount - 1)) && Math.min(first + 21, rowCount) <= w.pos + w.count, 'covers the visible rows');
    }
  }
  assert.deepEqual(ls.windowFor(1000, 21, 5_000_000).count, 200);
});

test('a window is requested only when the visible rows near its edge', () => {
  assert.equal(ls.needsWindow(undefined, 0, 21, 100), true);
  assert.equal(ls.needsWindow({ pos: 0, count: 100 }, 79, 100, 100), false);
  assert.equal(ls.needsWindow({ pos: 100, count: 200 }, 200, 221, 1000), false);
  assert.equal(ls.needsWindow({ pos: 100, count: 200 }, 270, 291, 1000), true);
  assert.equal(ls.needsWindow({ pos: 100, count: 200 }, 105, 126, 1000), true);
  assert.equal(ls.needsWindow({ pos: 0, count: 0 }, 0, 0, 0), false);
});

test('the request tracker drops older ids and replies for another revision', () => {
  const r = ls.createRequests();
  r.onState(3);
  const a = r.next(3);
  const b = r.next(3);
  assert.equal(r.accept({ id: a.id, rev: 3 }), false, 'older id');
  assert.equal(r.accept({ id: b.id, rev: 3 }), true, 'current request');
  const c = r.next(3);
  assert.equal(r.onState(4), true);
  assert.equal(r.onState(4), false, 'same revision is no change');
  assert.equal(r.accept({ id: c.id, rev: 3 }), false, 'reply for revision 3 after state 4');
  const d = r.next(4);
  assert.equal(d.rev, 4);
  assert.equal(r.accept({ id: d.id, rev: 4 }), true);
});
