import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';

type Mode = 'absolute' | 'relative' | 'delta';
interface RowLike { time: string; timeMs: number | null; deltaMs?: number; gap: boolean }
interface Timers { set(fn: () => void, ms: number): unknown; clear(id: unknown): void }
interface Debounce { call(...args: unknown[]): void; flush(): void; cancel(): void; readonly pending: boolean }
interface LogDisplay {
  formatDelta(ms: number): string;
  formatRelative(ms: number): string;
  formatFilterTime(ms: number): string;
  presetRange(kind: 'first' | 'last', minutes: number, firstMs?: number, lastMs?: number): { from: string; to: string } | null;
  rowTime(row: RowLike, mode: Mode, baseMs?: number): { text: string; warn: boolean };
  hiddenLabel(n: number): string;
  createDebounce(fn: (...args: unknown[]) => void, ms: number, timers?: Timers): Debounce;
}

// The webview script is plain JS in media/; out/test/*.js sits two levels below the extension folder.
const ld = require(path.join(__dirname, '..', '..', 'media', 'logDisplay.js')) as LogDisplay;

test('deltas are formatted in ms, s, min and h with their sign', () => {
  assert.equal(ld.formatDelta(0), '+0 ms');
  assert.equal(ld.formatDelta(30), '+30 ms');
  assert.equal(ld.formatDelta(999), '+999 ms');
  assert.equal(ld.formatDelta(1000), '+1.0 s');
  assert.equal(ld.formatDelta(2400), '+2.4 s');
  assert.equal(ld.formatDelta(12_345), '+12 s');
  assert.equal(ld.formatDelta(59_600), '+1 min', 'a value that rounds to 60 s moves to the next unit');
  assert.equal(ld.formatDelta(180_000), '+3 min');
  assert.equal(ld.formatDelta(-3_540_000), '-59 min');
  assert.equal(ld.formatDelta(5_400_000), '+1.5 h');
  assert.equal(ld.formatDelta(36_000_000), '+10 h');
  assert.equal(ld.formatDelta(-30), '-30 ms');
});

test('relative times are signed hh:mm:ss.SSS without a day limit', () => {
  assert.equal(ld.formatRelative(0), '+00:00:00.000');
  assert.equal(ld.formatRelative(62_345), '+00:01:02.345');
  assert.equal(ld.formatRelative(26 * 3_600_000), '+26:00:00.000');
  assert.equal(ld.formatRelative(-1), '-00:00:00.001');
});

test('filter times are yyyy-MM-dd HH:mm:ss from the UTC components', () => {
  assert.equal(ld.formatFilterTime(Date.UTC(2026, 9, 19, 7, 5, 9, 999)), '2026-10-19 07:05:09');
});

test('the first / last N minutes presets leave the other end open', () => {
  const first = Date.UTC(2026, 9, 19, 8, 0, 0, 500);
  const last = Date.UTC(2026, 9, 19, 12, 30, 10, 700);
  // The bounds are whole seconds and widen the range, so it covers at least N minutes.
  assert.deepEqual(ld.presetRange('first', 10, first, last), { from: '', to: '2026-10-19 08:10:01' });
  assert.deepEqual(ld.presetRange('last', 10, first, last), { from: '2026-10-19 12:20:10', to: '' });
  assert.equal(ld.presetRange('first', 10, undefined, undefined), null, 'no dated entries');
  assert.equal(ld.presetRange('last', 0, first, last), null);
  assert.equal(ld.presetRange('last', Number.NaN, first, last), null);
});

test('the time cell follows the display mode', () => {
  const row: RowLike = { time: '2026-10-19 08:00:01.250', timeMs: Date.UTC(2026, 9, 19, 8, 0, 1, 250), deltaMs: 30, gap: false };
  const base = Date.UTC(2026, 9, 19, 8, 0, 0, 0);
  assert.deepEqual(ld.rowTime(row, 'absolute', base), { text: row.time, warn: false });
  assert.deepEqual(ld.rowTime(row, 'relative', base), { text: '+00:00:01.250', warn: false });
  assert.deepEqual(ld.rowTime(row, 'delta', base), { text: '+30 ms', warn: false });
  assert.deepEqual(ld.rowTime({ ...row, deltaMs: 7000, gap: true }, 'delta', base), { text: '+7.0 s', warn: true }, 'gap');
  assert.deepEqual(ld.rowTime({ ...row, deltaMs: -3_540_000 }, 'delta', base), { text: '-59 min', warn: true }, 'clock went back');
  assert.deepEqual(ld.rowTime({ ...row, deltaMs: undefined }, 'delta', base), { text: '', warn: false }, 'first row');
  // NaN times arrive as null after the JSON round trip of postMessage.
  const undated: RowLike = { time: 'boot', timeMs: null, gap: false };
  assert.deepEqual(ld.rowTime(undated, 'absolute', base), { text: 'boot', warn: false });
  assert.deepEqual(ld.rowTime(undated, 'relative', base), { text: '', warn: false });
  assert.deepEqual(ld.rowTime(row, 'relative', undefined), { text: '', warn: false }, 'no dated entry in the view');
});

test('hidden counts show only above zero, with thousands separators', () => {
  assert.equal(ld.hiddenLabel(0), '');
  assert.equal(ld.hiddenLabel(1203), 'hidden: 1,203');
});

function fakeTimers() {
  let next = 1;
  const due = new Map<number, () => void>();
  return {
    due,
    set(fn: () => void) { const id = next++; due.set(id, fn); return id; },
    clear(id: unknown) { due.delete(id as number); },
    fire() { const fns = [...due.values()]; due.clear(); fns.forEach(f => f()); },
  };
}

test('debounce calls once with the last arguments, flush and cancel', () => {
  const t = fakeTimers();
  const calls: unknown[][] = [];
  const d = ld.createDebounce((...a) => calls.push(a), 250, t);
  d.call('a');
  d.call('b');
  assert.equal(d.pending, true);
  assert.equal(t.due.size, 1, 'one timer at a time');
  t.fire();
  assert.deepEqual(calls, [['b']]);
  assert.equal(d.pending, false);
  d.call('c');
  d.flush();
  assert.deepEqual(calls, [['b'], ['c']]);
  assert.equal(t.due.size, 0, 'flush clears the timer');
  d.flush();
  assert.equal(calls.length, 2, 'flush without a pending call does nothing');
  d.call('d');
  d.cancel();
  t.fire();
  assert.equal(calls.length, 2);
  assert.equal(d.pending, false);
});

test('the navigation keys are bound only in log viewer panels', () => {
  // out/test/*.js -> the extension's package.json is two levels up
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const when = "activeCustomEditorId == 'iecode.logViewer' || activeWebviewPanelId == 'iecode.logViewer.merged'";
  const keys = (manifest.contributes.keybindings as { command: string; key: string; mac?: string; when: string }[])
    .filter(k => k.command.startsWith('iecode.logViewer.'));
  const byCommand = Object.fromEntries(keys.map(k => [k.command, k]));
  assert.equal(byCommand['iecode.logViewer.nextError'].key, 'f8');
  assert.equal(byCommand['iecode.logViewer.previousError'].key, 'shift+f8');
  assert.equal(byCommand['iecode.logViewer.nextBookmark'].key, 'f2');
  assert.equal(byCommand['iecode.logViewer.previousBookmark'].key, 'shift+f2');
  assert.equal(byCommand['iecode.logViewer.toggleBookmark'].key, 'ctrl+f2');
  assert.equal(byCommand['iecode.logViewer.toggleBookmark'].mac, 'cmd+f2');
  assert.equal(keys.length, 5);
  for (const k of keys) assert.equal(k.when, when, k.command);
  const commands = new Set((manifest.contributes.commands as { command: string }[]).map(c => c.command));
  for (const k of keys) assert.ok(commands.has(k.command), `${k.command} is a contributed command`);
});
