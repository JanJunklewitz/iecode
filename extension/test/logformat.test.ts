import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_FORMATS, LEVELS, LogFormat, LogFormatError, compileFormat, detectFormat, parseFilterTime, parseFilterTimeInput, parseLine, parseTime } from '../src/core/logformat';

function fmt(id: string): LogFormat {
  const def = BUILT_IN_FORMATS.find(d => d.id === id);
  assert.ok(def, id);
  return compileFormat(def);
}
const logger = fmt('twincat-logger');
const tabs = fmt('tab-separated');
const plain = fmt('plain');
const all = [logger, tabs, plain];

function entry(f: LogFormat, line: string) {
  const r = parseLine(f, line);
  assert.equal(r.kind, 'entry', line);
  return (r as { kind: 'entry'; entry: import('../src/core/logformat').ParsedLine }).entry;
}

test('built-in formats and level order', () => {
  assert.deepEqual(BUILT_IN_FORMATS.map(d => d.id), ['twincat-logger', 'tab-separated', 'plain']);
  assert.deepEqual(LEVELS, ['error', 'warning', 'info', 'debug', 'other']);
});

test('twincat-logger entry', () => {
  const e = entry(logger, '0000000042 - 2026-10-19-00:00:21.669 - INFO - fbMain.fbPump.fbValve - Execute');
  assert.equal(e.seq, 42);
  assert.equal(e.source, 'fbMain.fbPump.fbValve');
  assert.equal(e.message, 'Execute');
  assert.equal(e.level, 'info');
  assert.equal(e.time, Date.UTC(2026, 9, 19, 0, 0, 21, 669));
});

test('empty source', () => {
  const e = entry(logger, '0000000001 - 2026-10-19-00:00:21.669 - WARNING -  - Fault active');
  assert.equal(e.source, '');
  assert.equal(e.message, 'Fault active');
  assert.equal(e.level, 'warning');
});

test('message with separators', () => {
  const e = entry(logger, '0000000002 - 2026-10-19-00:00:21.669 - ERROR - fbMain - Start failed - retry - ()');
  assert.equal(e.source, 'fbMain');
  assert.equal(e.message, 'Start failed - retry - ()');
  assert.equal(e.level, 'error');
});

test('boot line has no usable time', () => {
  const e = entry(logger, '0000000003 - BOOT-------00:00:00.000 - DEBUG -  - Interlock active');
  assert.ok(Number.isNaN(e.time));
  assert.equal(e.timeText, 'BOOT-------00:00:00.000');
  assert.equal(e.level, 'debug');
});

test('header is ignored, indented text is a continuation', () => {
  assert.deepEqual(parseLine(logger, 'Sequence   - Timestamp - Category - Source - Message'), { kind: 'ignored' });
  assert.deepEqual(parseLine(logger, '  at stack frame'), { kind: 'continuation' });
});

test('dates are validated by round trip', () => {
  assert.ok(Number.isNaN(parseTime(logger, '2026-02-30-00:00:00.000')));
  assert.ok(Number.isNaN(parseTime(logger, '2026-10-19-24:00:00.000')));
  assert.equal(parseTime(logger, '2026-10-19-00:00:21.669'), Date.UTC(2026, 9, 19, 0, 0, 21, 669));
  assert.ok(Number.isNaN(parseFilterTime('2026-02-30 00:00')));
  assert.ok(Number.isNaN(parseFilterTime('2026-10-19 24:00')));
});

test('tab-separated entry', () => {
  const e = entry(tabs, '03.04.2024 16:17:13\tInfo\tProgram needed 32 s');
  assert.equal(e.time, Date.UTC(2024, 3, 3, 16, 17, 13));
  assert.equal(e.level, 'info');
  assert.equal(e.levelText, 'Info');
  assert.equal(e.message, 'Program needed 32 s');
  assert.equal(e.source, '');
});

test('unknown level text maps to other', () => {
  const e = entry(logger, '0000000004 - 2026-10-19-00:00:21.669 - NOTICE - fbMain - Hello');
  assert.equal(e.level, 'other');
  assert.equal(e.levelText, 'NOTICE');
});

test('parseFilterTime is time zone independent', () => {
  assert.equal(parseFilterTime('2026-10-19 00:00:21'), Date.UTC(2026, 9, 19, 0, 0, 21));
  assert.equal(parseFilterTime('2026-10-19 00:00'), Date.UTC(2026, 9, 19, 0, 0, 0));
  assert.ok(Number.isNaN(parseFilterTime('2026-13-01 00:00')));
  assert.ok(Number.isNaN(parseFilterTime('garbage')));
});

test('compileFormat rejects bad definitions', () => {
  assert.throws(() => compileFormat({ id: 'x', name: 'x', entry: '(' }), LogFormatError);
  assert.throws(() => compileFormat({ id: 'x', name: 'x', entry: '^(?<level>.*)$' }), LogFormatError);
  assert.throws(() => compileFormat({ id: 'x', name: 'x', entry: '^(?<message>.*)$', ignore: '(' }), LogFormatError);
});

test('plain format', () => {
  assert.deepEqual(parseLine(plain, ''), { kind: 'continuation' });
  assert.deepEqual(parseLine(plain, '   '), { kind: 'continuation' });
  const a = entry(plain, 'Something ERROR happened');
  assert.equal(a.level, 'error');
  assert.equal(a.message, 'Something ERROR happened');
  assert.ok(Number.isNaN(a.time));
  assert.equal(a.timeText, '');
  assert.equal(a.source, '');
  assert.equal(entry(plain, 'a warn b').level, 'warning');
  assert.equal(entry(plain, 'nothing special').level, 'other');
  assert.equal(entry(plain, 'x'.repeat(20000)).message.length, 8192);
});

function loggerLine(i: number): string {
  return `${String(i).padStart(10, '0')} - 2026-10-19-00:00:${String(i % 60).padStart(2, '0')}.000 - INFO - fbMain.fbPump - Step ${i}`;
}

test('detectFormat picks the logger, tabs, and falls back to plain', () => {
  const lines = ['Sequence   - Timestamp - Category - Source - Message'];
  for (let i = 0; i < 20; i++) lines.push(loggerLine(i));
  assert.equal(detectFormat(lines, all).def.id, 'twincat-logger');
  const t: string[] = [];
  for (let i = 0; i < 20; i++) t.push(`03.04.2024 16:17:${String(i).padStart(2, '0')}\tInfo\tMessage ${i}`);
  assert.equal(detectFormat(t, all).def.id, 'tab-separated');
  assert.equal(detectFormat(['\u0000\u0001garbage', 'x'], all).def.id, 'plain');
  assert.equal(detectFormat([], all).def.id, 'plain');
});

test('detectFormat tolerates many continuation lines', () => {
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) lines.push(loggerLine(i));
  for (let i = 0; i < 12; i++) lines.push('    at frame ' + i);
  assert.equal(detectFormat(lines, all).def.id, 'twincat-logger');
});

test('detectFormat tolerates a rotated file that starts with continuations', () => {
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) lines.push('    at frame ' + i);
  for (let i = 0; i < 20; i++) lines.push(loggerLine(i));
  assert.equal(detectFormat(lines, all).def.id, 'twincat-logger');
});

test('filter time input: empty is open, invalid text gets a message', () => {
  assert.deepEqual(parseFilterTimeInput(''), {});
  assert.deepEqual(parseFilterTimeInput('   '), {});
  assert.deepEqual(parseFilterTimeInput('2026-10-19 08:00'), { ms: Date.UTC(2026, 9, 19, 8, 0, 0) });
  assert.deepEqual(parseFilterTimeInput('2026-10-19 8:00'), { error: 'Invalid time, expected yyyy-MM-dd HH:mm:ss' });
  assert.deepEqual(parseFilterTimeInput('2026-02-30 00:00'), { error: 'Invalid time, expected yyyy-MM-dd HH:mm:ss' });
});
