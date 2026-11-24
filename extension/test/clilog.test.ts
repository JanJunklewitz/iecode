import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFailureText, compilerErrors, countLine, diagnosticLine, progressLine, ranBuild, rootCausesFirst, tcVersionHint } from '../src/core/clilog';
import { CliDiagnostic } from '../src/core/diagnostics';

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

test('root causes come first, the rest keeps its order', () => {
  const ds: CliDiagnostic[] = [
    { severity: 'error', message: 'a' },
    { severity: 'error', message: 'PLC1.Library Manager: library not installed', rootCause: true },
    { severity: 'warning', message: 'b' },
  ];
  assert.deepEqual(rootCausesFirst(ds).map(d => d.message), ['PLC1.Library Manager: library not installed', 'a', 'b']);
});

test('build failure text names the root cause or static analysis', () => {
  const root: CliDiagnostic = { severity: 'error', message: "Library 'X' is not installed", rootCause: true };
  assert.equal(buildFailureText('PLC1', [root, { severity: 'error', message: 'e' }], undefined),
    "PLC1 build failed: Library 'X' is not installed (and 1 more error(s))");
  assert.equal(buildFailureText('PLC1', [{ severity: 'error', code: 'SA0027', message: 's' }], { builds: [{ staticAnalysisOnly: true }] }),
    'PLC1 build failed only on static analysis (1 finding(s)).');
  assert.equal(buildFailureText('PLC1', [{ severity: 'error', message: 'e' }, { severity: 'error', message: 'f' }], { builds: [{}] }),
    'PLC1 build failed with 2 error(s).');
});

test('a run that stopped before building keeps the old problems', () => {
  assert.equal(ranBuild({ data: { builds: [] } }), true);
  assert.equal(ranBuild({ data: { solution: 'x.sln', errors: 0, warnings: 0 } }), true);
  assert.equal(ranBuild({}), false);
});

test('version errors point to the TwinCAT version setting', () => {
  assert.match(tcVersionHint(15) ?? '', /iecode\.tcVersion/);
  assert.match(tcVersionHint(2) ?? '', /iecode\.tcVersion/);
  assert.equal(tcVersionHint(10), undefined);
});

test('a root cause that is a warning is named too (TwinCAT 4024)', () => {
  const root: CliDiagnostic = { severity: 'warning', message: 'PLC.Library Manager: Library tc3_motorlib has not been added to the Library Manager', rootCause: true };
  assert.equal(buildFailureText('PLC', [root, { severity: 'error', message: 'Unknown type' }], undefined),
    'PLC build failed: PLC.Library Manager: Library tc3_motorlib has not been added to the Library Manager (and 1 error(s))');
});

test('only the generic line left counts as no compiler error', () => {
  assert.equal(compilerErrors([{ severity: 'info', message: 'The operation could not be completed.' }]), 0);
  assert.equal(compilerErrors([{ severity: 'error', message: 'e' }, { severity: 'warning', message: 'w' }]), 1);
});
