import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeader, localStamp, newerSources } from '../src/core/symbolOrigin';

test('a source file counts as newer only beyond the tolerance', () => {
  assert.deepEqual(newerSources(10_000, [{ file: 'a/A.TcPOU', mtimeMs: 12_000 }]), []);
  assert.deepEqual(newerSources(10_000, [{ file: 'a/A.TcPOU', mtimeMs: 12_001 }]), ['A.TcPOU']);
});

test('newer sources come newest first as base names', () => {
  assert.deepEqual(newerSources(0, [{ file: 'x/Old.TcPOU', mtimeMs: 5000 }, { file: 'y\\New.TcGVL', mtimeMs: 9000 }]), ['New.TcGVL', 'Old.TcPOU']);
});

test('localStamp pads every field', () => {
  assert.equal(localStamp(new Date(2026, 10, 9, 8, 2, 3)), '2026-11-09 08:02:03');
});

test('header without a warning', () => {
  assert.deepEqual(buildHeader({ unit: 'PLC1', builtAt: new Date(2026, 10, 9, 10, 12, 3), newer: [] }),
    ['Symbols from the build output of PLC1 (built 2026-11-09 10:12:03).']);
});

test('header warns with at most three names', () => {
  const builtAt = new Date(2026, 10, 9, 10, 12, 3);
  assert.equal(buildHeader({ unit: 'PLC1', builtAt, newer: ['A.TcPOU', 'B.TcPOU', 'C.TcPOU', 'D.TcPOU'] })[1],
    'Warning: 4 source files are newer than the build output (A.TcPOU, B.TcPOU, C.TcPOU and 1 more); the symbols may be outdated. Build the project again.');
  assert.equal(buildHeader({ unit: 'PLC1', builtAt, newer: ['A.TcPOU'] })[1],
    'Warning: 1 source file is newer than the build output (A.TcPOU); the symbols may be outdated. Build the project again.');
});
