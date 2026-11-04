// Pure scroll and request logic of the log viewer webview (see logViewer.js). No DOM access, so node --test can
// require it. Browsers cap an element's height (about 33 M px in Chromium), so the scroll area is real up to
// MAX_HEIGHT and proportional above: then one scroll pixel stands for a fraction of the rows and the visible
// rows are drawn at the viewport top.
'use strict';

const ROW_HEIGHT = 20;
const MAX_HEIGHT = 10000000;
const WINDOW_ROWS = 200;
/** Rows of the window that must remain beyond the visible ones before a new window is requested. */
const SLACK_ROWS = 25;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const proportional = (rowCount) => rowCount * ROW_HEIGHT > MAX_HEIGHT;

/** Height of the scroll area in px. */
function scrollHeight(rowCount) {
  return Math.min(Math.max(0, rowCount) * ROW_HEIGHT, MAX_HEIGHT);
}

/** Highest scrollTop of the scroll area. */
function maxScrollTop(rowCount, viewportPx) {
  return Math.max(0, scrollHeight(rowCount) - viewportPx);
}

/** In proportional mode: the row shown at the top at the highest scrollTop (all rows below it fit fully). */
function lastTopRow(rowCount, viewportPx) {
  return Math.max(0, rowCount - Math.floor(viewportPx / ROW_HEIGHT));
}

/** scrollTop that shows `row` at the top (clamped to the highest scrollTop). */
function rowToScrollTop(row, rowCount, viewportPx) {
  const max = maxScrollTop(rowCount, viewportPx);
  if (!proportional(rowCount)) return clamp(row * ROW_HEIGHT, 0, max);
  const last = lastTopRow(rowCount, viewportPx);
  if (last === 0) return 0;
  return Math.round(clamp(row, 0, last) * max / last);
}

/** First (topmost) row visible at `scrollTop`. */
function scrollTopToRow(scrollTop, rowCount, viewportPx) {
  if (rowCount <= 0) return 0;
  const max = maxScrollTop(rowCount, viewportPx);
  const top = clamp(scrollTop, 0, max);
  if (!proportional(rowCount)) return clamp(Math.floor(top / ROW_HEIGHT), 0, rowCount - 1);
  if (max === 0) return 0;
  return clamp(Math.round(top * lastTopRow(rowCount, viewportPx) / max), 0, rowCount - 1);
}

/**
 * Rows to draw at `scrollTop`: `first` is the topmost visible row, rows start..end-1 are drawn from `top` px
 * (inside the scroll area) on. The margin adds rows above and below in real mode, below only in proportional mode.
 */
function renderRange(scrollTop, rowCount, viewportPx, margin) {
  const m = margin || 0;
  const first = scrollTopToRow(scrollTop, rowCount, viewportPx);
  const visible = Math.ceil(viewportPx / ROW_HEIGHT) + 1;
  const end = clamp(first + visible + m, 0, Math.max(0, rowCount));
  if (!proportional(rowCount)) {
    const start = Math.max(0, first - m);
    return { first, start, end, top: start * ROW_HEIGHT };
  }
  return { first, start: first, end, top: clamp(scrollTop, 0, maxScrollTop(rowCount, viewportPx)) };
}

/** The window of about WINDOW_ROWS rows to request around the visible rows, clamped to 0..rowCount. */
function windowFor(firstRow, visibleRows, rowCount) {
  const n = Math.max(0, rowCount);
  const size = Math.max(WINDOW_ROWS, visibleRows + 2 * SLACK_ROWS);
  const pos = clamp(firstRow - Math.floor((size - visibleRows) / 2), 0, Math.max(0, n - size));
  return { pos, count: Math.min(size, n - pos) };
}

/** True when rows start..end-1 plus some slack (clamped to the rows that exist) are not inside `have`. */
function needsWindow(have, start, end, rowCount) {
  const lo = clamp(start - SLACK_ROWS, 0, Math.max(0, rowCount));
  const hi = clamp(end + SLACK_ROWS, 0, Math.max(0, rowCount));
  if (lo >= hi) return false;
  return !have || lo < have.pos || hi > have.pos + have.count;
}

/**
 * The window to request for the drawn rows `r` (from renderRange), or null: when there are no rows, or (unless
 * forced) when the rows held (`have`) or the request in flight (`pending`) already cover them. The window is built
 * around r.start..r.end, the same rows needsWindow checks, so a received window never asks for itself again.
 */
function nextWindow(r, rowCount, have, pending, force) {
  if (rowCount <= 0) return null;
  if (!force) {
    if (!needsWindow(have, r.start, r.end, rowCount)) return null;
    if (pending && !needsWindow(pending, r.start, r.end, rowCount)) return null;
  }
  const w = windowFor(r.start, r.end - r.start, rowCount);
  return w.count > 0 ? w : null;
}

/** scrollTop that shows `row` in the middle of the view (as far as the ends allow). */
function centerScrollTop(row, rowCount, viewportPx) {
  const half = Math.floor(Math.floor(viewportPx / ROW_HEIGHT) / 2);
  return rowToScrollTop(Math.max(0, row - half), rowCount, viewportPx);
}

/**
 * Row a jump starts from (jump looks at the rows after / before it): the selected row, else the first visible row
 * counts when going down and the search goes above it when going up.
 */
function navFrom(selected, firstVisible, dir) {
  if (selected !== null && selected !== undefined) return selected;
  return dir === 1 ? firstVisible - 1 : firstVisible;
}

/**
 * Tracks row requests: only the reply to the latest request for the current revision is used. A reply with an
 * older id or for another revision than the last state's is dropped. `pending` is the window of the request in
 * flight; an accepted reply, a state message and clear() (error or stale reply) forget it.
 */
function createRequests() {
  let rev = -1;
  let last = 0;
  let pending;
  return {
    get rev() { return rev; },
    get pending() { return pending; },
    /** A new request for revision `r` and window `win`; send its id and rev with the message. */
    next(r, win) {
      pending = win;
      return { id: ++last, rev: r };
    },
    accept(reply) {
      if (reply.id !== last || reply.rev !== rev) return false;
      pending = undefined;
      return true;
    },
    /** Records the revision of a state message; true when it changed. */
    onState(r) {
      const changed = r !== rev;
      rev = r;
      pending = undefined;
      return changed;
    },
    clear() { pending = undefined; },
  };
}

if (typeof module === 'object') {
  module.exports = {
    ROW_HEIGHT, MAX_HEIGHT, scrollHeight, rowToScrollTop, scrollTopToRow, renderRange, windowFor, needsWindow, nextWindow,
    createRequests, centerScrollTop, navFrom,
  };
}
