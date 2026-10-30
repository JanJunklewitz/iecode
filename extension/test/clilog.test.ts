import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLine, diagnosticLine, progressLine } from '../src/core/clilog';

test('progress markers become log levels', () => {
  assert.deepEqual(progressLine('● Opening solution'), { level: 'info', text: 'Opening solution' });
  assert.deepEqual(progressLine('✔ Build succeeded'), { level: 'info', text: 'Build succeeded' });
  assert.deepEqual(progressLine('⚠ Library Tc3_X not found'), { level: 'warning', text: 'Library Tc3_X not found' });
  assert.deepEqual(progressLine('  ✖ C0032  FB_Motor.TcPOU(3)  Type unknown'), { level: 'error', text: 'C0032  FB_Motor.TcPOU(3)  Type unknown' });
  assert.deepEqual(progressLine('  plain detail '), { level: 'info', text: 'plain detail' });
});

test('compiler messages read like the CLI prints them', () => {
  assert.equal(diagnosticLine({ severity: 'error', code: 'C0032', file: 'C:\\ws\\PLC1\\POUs\\FB_Motor.TcPOU', line: 12, column: 5, project: 'PLC1', message: "Type 'X' not found" }),
    "C0032 FB_Motor.TcPOU(12,5): Type 'X' not found [PLC1]");
  assert.equal(diagnosticLine({ severity: 'warning', file: 'a/MAIN.TcPOU', line: 3, message: 'Unused variable' }), 'MAIN.TcPOU(3): Unused variable');
  assert.equal(diagnosticLine({ severity: 'info', message: 'Size of generated code: 1 KB' }), 'Size of generated code: 1 KB');
});

test('counts name only the kinds that occur', () => {
  assert.equal(countLine([]), '');
  assert.equal(countLine([{ severity: 'error', message: 'a' }, { severity: 'error', message: 'b' }, { severity: 'warning', message: 'c' }]), '2 errors, 1 warning');
  assert.equal(countLine([{ severity: 'info', message: 'a' }]), '1 message');
});
