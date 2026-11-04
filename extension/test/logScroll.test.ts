import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

interface Win { pos: number; count: number }
interface Requests {
  readonly rev: number;
  readonly pending: Win | undefined;
  next(rev: number, win?: Win): { id: number; rev: number };
  accept(reply: { id: number; rev: number }): boolean;
  onState(rev: number): boolean;
  clear(): void;
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
  nextWindow(r: { first: number; start: number; end: number }, rowCount: number, have: Win | undefined, pending: Win | undefined, force: boolean): Win | null;
  createRequests(): Requests;
  centerScrollTop(row: number, rowCount: number, viewportPx: number): number;
  navFrom(selected: number | null, firstVisible: number, dir: 1 | -1): number;
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

test('a freshly received window never needs another request', () => {
  // The webview asks nextWindow on every scroll and every reply; right after a reply it must ask for nothing.
  for (const n of [100, 100_000, 5_000_000]) {
    for (let vp = 100; vp <= 5000; vp += 100) {
      for (const row of [0, Math.floor(n / 2), n - 1]) {
        const r = ls.renderRange(ls.rowToScrollTop(row, n, vp), n, vp, 5);
        const w = ls.nextWindow(r, n, undefined, undefined, false);
        assert.ok(w, 'the first call asks for a window');
        assert.equal(ls.needsWindow(w, r.start, r.end, n), false, `rows ${n}, viewport ${vp}, row ${row}: window ${w.pos}+${w.count}`);
        assert.equal(ls.nextWindow(r, n, w, undefined, false), null, `no second request: rows ${n}, viewport ${vp}, row ${row}`);
      }
    }
  }
});

test('nextWindow skips a request that the pending one covers and asks again when forced', () => {
  const r = ls.renderRange(0, 1000, 400, 5);
  const w = ls.nextWindow(r, 1000, undefined, undefined, false)!;
  assert.equal(ls.nextWindow(r, 1000, undefined, w, false), null);
  assert.deepEqual(ls.nextWindow(r, 1000, w, undefined, true), w);
  assert.equal(ls.nextWindow(ls.renderRange(0, 0, 400, 5), 0, undefined, undefined, true), null, 'no rows, no request');
});

test('the tracker forgets the pending window on error, stale and state', () => {
  const r = ls.createRequests();
  r.onState(1);
  r.next(1, { pos: 0, count: 200 });
  assert.deepEqual(r.pending, { pos: 0, count: 200 });
  r.clear();
  assert.equal(r.pending, undefined, 'cleared after an error or a stale reply');
  const a = r.next(1, { pos: 0, count: 200 });
  assert.equal(r.accept({ id: a.id, rev: 1 }), true);
  assert.equal(r.pending, undefined, 'cleared by the accepted reply');
  r.next(1, { pos: 0, count: 200 });
  r.onState(1);
  assert.equal(r.pending, undefined, 'cleared by a state message');
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

test('a jump target lies in the middle of the view', () => {
  for (const n of [100, 100_000, 5_000_000]) {
    for (const row of [0, 10, Math.floor(n / 2), n - 1]) {
      const top = ls.centerScrollTop(row, n, VIEWPORT);
      const r = ls.renderRange(top, n, VIEWPORT);
      assert.ok(row >= r.first && row < r.first + Math.ceil(VIEWPORT / ls.ROW_HEIGHT), `rows ${n}: row ${row} is visible`);
      if (row >= 10 && row <= n - 11) assert.equal(row - r.first, 10, `rows ${n}: row ${row} is in the middle`);
    }
  }
});

test('navigation starts at the selected row, else around the first visible row', () => {
  assert.equal(ls.navFrom(42, 7, 1), 42);
  assert.equal(ls.navFrom(42, 7, -1), 42);
  // Without a selection the first visible row itself is a candidate going down; going up searches above it.
  assert.equal(ls.navFrom(null, 7, 1), 6);
  assert.equal(ls.navFrom(null, 7, -1), 7);
  assert.equal(ls.navFrom(null, 0, 1), -1);
});
