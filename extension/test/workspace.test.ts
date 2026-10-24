import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { discover, buildOrder, affected, unitOfFile, toMermaid } from '../src/core/workspace';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'ws');

test('discovers solutions and loose PLC projects and groups them', async () => {
  const m = await discover([fixtures]);
  assert.deepEqual(m.errors, []);
  const groups = Object.fromEntries(m.units.map(u => [u.id, u.group]));
  assert.deepEqual(groups, { 'MachineX/PLC1': 'application', 'Tc3_MotorLib/MotorLib': 'library', 'Logging': 'library' });
});

test('links references to library projects in the workspace', async () => {
  const m = await discover([fixtures]);
  const e = m.edges.map(e => `${e.from} -> ${e.to} (${e.link})`).sort();
  // PLC1 pins Tc3_MotorLib 1.2.0 while the project is at 1.3.0; MotorLib uses Logging 1.0.0 = project version
  assert.deepEqual(e, ['MachineX/PLC1 -> Tc3_MotorLib/MotorLib (pinned)', 'Tc3_MotorLib/MotorLib -> Logging (workspace)']);
});

test('build order puts libraries first; affected follows workspace links only', async () => {
  const m = await discover([fixtures]);
  assert.deepEqual(buildOrder(m), ['Logging', 'Tc3_MotorLib/MotorLib', 'MachineX/PLC1']);
  assert.deepEqual([...affected(m, ['Logging'])].sort(), ['Logging', 'Tc3_MotorLib/MotorLib']);
  assert.deepEqual([...affected(m, ['Tc3_MotorLib/MotorLib'])], ['Tc3_MotorLib/MotorLib']);
});

test('finds the unit of a file and renders mermaid', async () => {
  const m = await discover([fixtures]);
  assert.equal(unitOfFile(m, join(fixtures, 'apps/MachineX/MachineX/PLC1/POUs/MAIN.TcPOU'))?.id, 'MachineX/PLC1');
  assert.equal(unitOfFile(m, join(fixtures, 'README.md')), undefined);
  assert.match(toMermaid(m), /-\.->\|pinned 1\.2\.0\|/);
});

test('detects cycles', () => {
  const u = (id: string) => ({ id, group: 'library' as const, plc: {} as never });
  assert.throws(() => buildOrder({ units: [u('a'), u('b')], edges: [
    { from: 'a', to: 'b', link: 'workspace', ref: {} as never }, { from: 'b', to: 'a', link: 'workspace', ref: {} as never }] }), /cycle/);
});
