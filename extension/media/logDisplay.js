// Pure display helpers of the log viewer webview (see logViewer.js): time formats, filter presets, hidden counts,
// debounce. No DOM access, so node --test can require it. Times carry no time zone: they are formatted from the
// UTC components, as the host does.
'use strict';

const pad2 = (n) => String(n).padStart(2, '0');
const isTime = (v) => typeof v === 'number' && Number.isFinite(v);

/** Signed delta to the previous row: `+30 ms`, `+2.4 s`, `+12 s`, `+3 min`, `-59 min`, `+1.5 h`, `+10 h`. */
function formatDelta(ms) {
  const sign = ms < 0 ? '-' : '+';
  const a = Math.abs(ms);
  if (Math.round(a) < 1000) return `${sign}${Math.round(a)} ms`;
  const s = a / 1000;
  if (s < 9.95) return `${sign}${s.toFixed(1)} s`;
  if (Math.round(s) < 60) return `${sign}${Math.round(s)} s`;
  const min = a / 60000;
  if (Math.round(min) < 60) return `${sign}${Math.round(min)} min`;
  const h = a / 3600000;
  if (h < 9.95) return `${sign}${h.toFixed(1)} h`;
  return `${sign}${Math.round(h)} h`;
}

/** Signed offset as hh:mm:ss.SSS; the hours are not wrapped at a day. */
function formatRelative(ms) {
  const sign = ms < 0 ? '-' : '+';
  const a = Math.round(Math.abs(ms));
  const h = Math.floor(a / 3600000);
  const m = Math.floor(a / 60000) % 60;
  const s = Math.floor(a / 1000) % 60;
  return `${sign}${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(a % 1000).padStart(3, '0')}`;
}

/** yyyy-MM-dd HH:mm:ss, the format the time filter inputs take. */
function formatFilterTime(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * Filter texts for the first / last `minutes` of the file; the other end stays open. The bound is rounded outward
 * to whole seconds, so the range covers at least the asked minutes. Null without dated entries or a positive count.
 */
function presetRange(kind, minutes, firstMs, lastMs) {
  if (!(minutes > 0)) return null;
  const span = minutes * 60000;
  if (kind === 'first') {
    if (!isTime(firstMs)) return null;
    return { from: '', to: formatFilterTime(Math.ceil((firstMs + span) / 1000) * 1000) };
  }
  if (!isTime(lastMs)) return null;
  return { from: formatFilterTime(Math.floor((lastMs - span) / 1000) * 1000), to: '' };
}

/**
 * Text of a row's time cell. mode: 'absolute' (the row's own text), 'relative' (to `baseMs`, the first dated entry of
 * the filtered view) or 'delta' (to the previous row). `warn` marks a gap or a negative delta in delta mode.
 */
function rowTime(row, mode, baseMs) {
  if (mode === 'relative') {
    if (!isTime(row.timeMs) || !isTime(baseMs)) return { text: '', warn: false };
    return { text: formatRelative(row.timeMs - baseMs), warn: false };
  }
  if (mode === 'delta') {
    if (!isTime(row.deltaMs)) return { text: '', warn: false };
    return { text: formatDelta(row.deltaMs), warn: !!row.gap || row.deltaMs < 0 };
  }
  return { text: row.time, warn: false };
}

/** "hidden: 1,203" next to a filter; empty when the filter hides nothing. */
function hiddenLabel(n) {
  return n > 0 ? `hidden: ${n.toLocaleString('en-US')}` : '';
}

/** Calls fn with the last arguments once `ms` passed without another call; flush() runs a pending call now. */
function createDebounce(fn, ms, timers) {
  const t = timers || { set: (f, d) => setTimeout(f, d), clear: (id) => clearTimeout(id) };
  let id;
  let args;
  let pending = false;
  const run = () => {
    if (!pending) return;
    pending = false;
    t.clear(id);
    id = undefined;
    const a = args;
    args = undefined;
    fn(...a);
  };
  return {
    get pending() { return pending; },
    call(...a) {
      args = a;
      pending = true;
      if (id !== undefined) t.clear(id);
      id = t.set(run, ms);
    },
    flush: run,
    cancel() {
      pending = false;
      args = undefined;
      if (id !== undefined) t.clear(id);
      id = undefined;
    },
  };
}

if (typeof module === 'object') {
  module.exports = { formatDelta, formatRelative, formatFilterTime, presetRange, rowTime, hiddenLabel, createDebounce };
}
