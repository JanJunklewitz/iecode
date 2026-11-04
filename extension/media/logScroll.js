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
 * Tracks row requests: only the reply to the latest request for the current revision is used. A reply with an
 * older id or for another revision than the last state's is dropped.
 */
function createRequests() {
  let rev = -1;
  let last = 0;
  return {
    get rev() { return rev; },
    /** A new request for revision `r`; send its id and rev with the message. */
    next(r) { return { id: ++last, rev: r }; },
    accept(reply) { return reply.id === last && reply.rev === rev; },
    /** Records the revision of a state message; true when it changed. */
    onState(r) {
      const changed = r !== rev;
      rev = r;
      return changed;
    },
  };
}

if (typeof module === 'object') {
  module.exports = {
    ROW_HEIGHT, MAX_HEIGHT, scrollHeight, rowToScrollTop, scrollTopToRow, renderRange, windowFor, needsWindow, createRequests,
  };
}
