import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampAutoMinutes, autoState, effectiveSetting, autoNote, autoLabel, armedAtNow, nextRefreshMs, REDIRECT_NOTE } from '../src/core/writeArming';

const M = 60_000, NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const st = (armedAt: unknown, minutes = 60, nowMs = NOW, setting = 'auto') => autoState({ setting, armedAt, minutes, nowMs });
test('clampAutoMinutes keeps 1..1440 integers and falls back to 60', () => {
  assert.equal(clampAutoMinutes(30), 30); assert.equal(clampAutoMinutes(0), 60); assert.equal(clampAutoMinutes(1441), 60);
  assert.equal(clampAutoMinutes(2.5), 60); assert.equal(clampAutoMinutes('30'), 60); assert.equal(clampAutoMinutes(undefined), 60);
});
test('autoState: off and confirm are notAuto', () => {
  assert.deepEqual(st(iso(NOW), 60, NOW, 'confirm'), { kind: 'notAuto' });
});
test('autoState: armed inside the window with the time left', () => {
  assert.deepEqual(st(iso(NOW - 18 * M)), { kind: 'armed', untilMs: NOW + 42 * M, leftMs: 42 * M });
});
test('autoState expires exactly at the end of the window', () => {
  assert.equal(st(iso(NOW - 60 * M)).kind, 'expired');
  assert.equal(st(iso(NOW - 60 * M + 1)).kind, 'armed');
});
test('autoState treats a bad time stamp as not armed', () => {
  for (const armedAt of [undefined, '', 'tomorrow', 42, null, {}]) assert.equal(st(armedAt).kind, 'notArmed');
});
test('an arming time in the future is not armed', () => {
  assert.equal(st(iso(NOW + 1)).kind, 'notArmed');
  assert.equal(st(iso(NOW)).kind, 'armed');
});
test('a lowered minutes setting ends a window for good', () => {
  // armed 10 min ago for 60 min, lowered to 5: expired now and at every later time (the first draft re-armed itself here)
  const armedAt = iso(NOW - 10 * M);
  for (const later of [0, 20 * M, 40 * M, 49 * M]) assert.equal(st(armedAt, 5, NOW + later).kind, 'expired');
});
test('a raised minutes setting extends the current arming', () => {
  assert.equal(st(iso(NOW - 70 * M), 90).kind, 'armed');
});
test('effectiveSetting turns auto into confirm unless armed', () => {
  assert.equal(effectiveSetting('auto', { kind: 'armed', untilMs: 1, leftMs: 1 }), 'auto');
  assert.equal(effectiveSetting('auto', { kind: 'expired', untilMs: 1 }), 'confirm');
  assert.equal(effectiveSetting('auto', { kind: 'notArmed' }), 'confirm');
  assert.equal(effectiveSetting('off', { kind: 'notAuto' }), 'off');
  assert.equal(effectiveSetting('confirm', { kind: 'notAuto' }), 'confirm');
});
test('autoNote texts', () => {
  assert.equal(autoNote({ kind: 'expired', untilMs: NOW }, false),
    ' (auto-approve expired; re-arm it with "IECode: Set AI Write Access…")');
  assert.equal(autoNote({ kind: 'notArmed' }, false),
    ' (auto-approve is not armed; arm it with "IECode: Set AI Write Access…")');
  assert.equal(autoNote({ kind: 'armed', untilMs: NOW, leftMs: 1 }, false), '');
  assert.equal(autoNote({ kind: 'notAuto' }, false), '');
});
test('autoNote prefers the redirect note', () => {
  assert.equal(REDIRECT_NOTE, ' (the workspace settings set the ADS target or port, so auto-approve does not apply)');
  assert.equal(autoNote({ kind: 'expired', untilMs: NOW }, true), REDIRECT_NOTE);
  assert.equal(autoNote({ kind: 'armed', untilMs: NOW, leftMs: 1 }, true), REDIRECT_NOTE);
});
test('autoLabel for the watch view', () => {
  assert.equal(autoLabel({ kind: 'armed', untilMs: 0, leftMs: 42 * M + 1 }), 'AI writes: auto (43 min left)');
  assert.equal(autoLabel({ kind: 'armed', untilMs: 0, leftMs: 10_000 }), 'AI writes: auto (1 min left)');
  assert.equal(autoLabel({ kind: 'expired', untilMs: 0 }), 'AI writes: auto expired, confirming');
  assert.equal(autoLabel({ kind: 'notArmed' }), 'AI writes: auto not armed, confirming');
  assert.equal(autoLabel({ kind: 'notAuto' }), undefined);
});
test('armedAtNow is an ISO time stamp', () => {
  assert.equal(armedAtNow(NOW), iso(NOW));
});
test('nextRefreshMs', () => {
  // label "43 min left" changes to "42 min left" when leftMs drops to 42 min: 1 ms from now
  assert.equal(nextRefreshMs({ kind: 'armed', untilMs: 0, leftMs: 42 * M + 1 }), 1);
  assert.equal(nextRefreshMs({ kind: 'armed', untilMs: 0, leftMs: 42 * M }), M);
  // the last minute: refresh at the expiry itself
  assert.equal(nextRefreshMs({ kind: 'armed', untilMs: 0, leftMs: 10_000 }), 10_000);
  assert.equal(nextRefreshMs({ kind: 'expired', untilMs: 0 }), undefined);
  assert.equal(nextRefreshMs({ kind: 'notArmed' }), undefined);
});
test('a non-finite duration is never armed (fail closed)', () => {
  for (const minutes of [NaN, Infinity, -Infinity, 0, -5]) assert.equal(st(iso(NOW), minutes).kind, 'notArmed', String(minutes));
});
test('the AI write settings are application-scoped and the arming time is not synced', () => {
  // out/test/*.js -> the extension's package.json is two levels up
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const sections = Array.isArray(manifest.contributes.configuration) ? manifest.contributes.configuration : [manifest.contributes.configuration];
  const props: Record<string, { scope?: string; ignoreSync?: boolean }> = Object.assign({}, ...sections.map((x: { properties: object }) => x.properties));
  for (const k of ['iecode.ads.aiWrites', 'iecode.ads.aiWritePaths', 'iecode.ads.aiWritesAutoMinutes', 'iecode.ads.aiWritesArmedAt']) assert.equal(props[k]?.scope, 'application', k);
  assert.equal(props['iecode.ads.aiWritesArmedAt'].ignoreSync, true);
});

test('autoNote says nothing when auto-approve was never chosen, even if the workspace redirects the target', () => {
  assert.equal(autoNote({ kind: 'notAuto' }, true), '');
});
