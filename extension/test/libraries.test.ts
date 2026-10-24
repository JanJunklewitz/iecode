import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discover } from '../src/core/workspace';
import { overview, scanRepository, scanFolder, addReference, removeReference, hasReference } from '../src/core/libraries';

const fixtures = join(__dirname, '..', '..', 'test', 'fixtures', 'ws');

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-repo-'));
  for (const [v, l, vers] of [['example machines ltd', 'tc3_motorlib', ['1.2.0', '1.10.0']], ['beckhoff automation gmbh', 'tc2_standard', ['3.3.3.0', '3.4.5.0']]] as const)
    for (const ver of vers) mkdirSync(join(dir, v, l, ver), { recursive: true });
  mkdirSync(join(dir, 'example machines ltd', 'tc3_motorlib', 'temp'), { recursive: true });
  writeFileSync(join(dir, 'Tc3_Extra_2.0.1.library'), '');
  writeFileSync(join(dir, 'notes.txt'), '');
  return dir;
}

test('scans repository and folder sources', async () => {
  const dir = repo();
  try {
    assert.equal((await scanRepository(dir)).length, 4);
    assert.deepEqual((await scanFolder(dir)).map(a => `${a.name} ${a.version}`), ['Tc3_Extra 2.0.1']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overview: usage, newest version, outdated and workspace libraries', async () => {
  const dir = repo();
  try {
    const rows = overview(await discover([fixtures]), await scanRepository(dir));
    const motor = rows.find(r => r.name === 'Tc3_MotorLib')!;
    assert.deepEqual(motor.versions, ['1.10.0', '1.3.0', '1.2.0']);       // repository + workspace project 1.3.0
    assert.deepEqual(motor.workspace, { unit: 'Tc3_MotorLib/MotorLib', version: '1.3.0' });
    assert.deepEqual(motor.outdated.map(o => o.unit), ['MachineX/PLC1']);
    const std = rows.find(r => r.name === 'Tc2_Standard')!;
    assert.equal(std.usedBy[0].pinned, false);
    assert.equal(std.outdated.length, 0);                                    // * is never outdated
    const logging = rows.find(r => r.name === 'Tc3_Logging')!;
    assert.equal(logging.inconsistent, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('adds and removes references without touching the rest', () => {
  const text = readFileSync(join(fixtures, 'apps/MachineX/MachineX/PLC1/PLC1.plcproj'), 'utf8');
  const added = addReference(text, { name: 'Tc3_Logging', version: '1.0.0', vendor: 'Example Machines Ltd' });
  assert.ok(hasReference(added, 'Tc3_Logging'));
  assert.ok(!/[^\r]\n/.test(added), 'CRLF kept');
  assert.equal(removeReference(added, 'Tc3_Logging'), text);
  assert.throws(() => addReference(text, { name: 'Tc2_Standard', version: '*', vendor: 'Beckhoff Automation GmbH' }), /already/);
});
