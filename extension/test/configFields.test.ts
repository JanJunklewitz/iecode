import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { configFields, groupOf, parseInput, toInputText } from '../src/core/configFields';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const fields = configFields(pkg.contributes.configuration.properties);
const f = (key: string) => fields.find(x => x.key === key)!;

test('groups: ads settings under ADS Watch, io-link, the rest General', () => {
  assert.equal(groupOf('iecode.ads.port'), 'ADS Watch');
  assert.equal(groupOf('iecode.ioLink.something'), 'IO-Link');
  assert.equal(groupOf('iecode.tcVersion'), 'General');
});

test('every iecode setting of package.json becomes a field, except the one with its own editor', () => {
  const keys = Object.keys(pkg.contributes.configuration.properties);
  assert.deepEqual(keys.filter(k => !fields.some(x => x.key === k)), ['iecode.configDiff.hidden']);
});

test('field metadata comes from the schema', () => {
  assert.equal(f('iecode.ads.port').type, 'integer');
  assert.equal(f('iecode.ads.port').min, 1);
  assert.equal(f('iecode.ads.port').max, 65535);
  assert.equal(f('iecode.ads.aiWrites').type, 'enum');
  assert.equal(f('iecode.ads.aiWrites').userOnly, true);
  assert.equal(f('iecode.ads.target').userOnly, false);
  assert.ok(!f('iecode.ads.target').description.includes('`'));
});

test('parseInput: integer range and text', () => {
  assert.deepEqual(parseInput(f('iecode.ads.port'), ' 851 '), { value: 851 });
  assert.ok('problem' in parseInput(f('iecode.ads.port'), '0'));
  assert.ok('problem' in parseInput(f('iecode.ads.port'), '70000'));
  assert.ok('problem' in parseInput(f('iecode.ads.port'), '8x'));
  assert.ok('problem' in parseInput(f('iecode.ads.port'), ''));
});

test('parseInput: boolean and enum', () => {
  assert.deepEqual(parseInput(f('iecode.restartAfterActivate'), false), { value: false });
  assert.ok('problem' in parseInput(f('iecode.restartAfterActivate'), 'true'));
  assert.deepEqual(parseInput(f('iecode.ads.aiWrites'), 'confirm'), { value: 'confirm' });
  assert.ok('problem' in parseInput(f('iecode.ads.aiWrites'), 'sure'));
});

test('parseInput: list is one entry per line without blanks', () => {
  assert.deepEqual(parseInput(f('iecode.ads.aiWritePaths'), 'MAIN.Sim\r\n\n  GVL.Test  \n'), { value: ['MAIN.Sim', 'GVL.Test'] });
  assert.deepEqual(parseInput(f('iecode.ads.aiWritePaths'), ''), { value: [] });
});

test('parseInput: presets object', () => {
  assert.deepEqual(parseInput(f('iecode.ads.presets'), '{"seq":["nStep","bBusy"]}'), { value: { seq: ['nStep', 'bBusy'] } });
  assert.ok('problem' in parseInput(f('iecode.ads.presets'), '{'));
  assert.ok('problem' in parseInput(f('iecode.ads.presets'), '[]'));
  assert.ok('problem' in parseInput(f('iecode.ads.presets'), '{"seq":"nStep"}'));
});

test('parseInput: log directory must be empty or a full path', () => {
  assert.deepEqual(parseInput(f('iecode.ads.logDirectory'), ''), { value: '' });
  assert.ok('problem' in parseInput(f('iecode.ads.logDirectory'), 'logs'));
  if (process.platform === 'win32') assert.deepEqual(parseInput(f('iecode.ads.logDirectory'), ' C:\\Logs '), { value: 'C:\\Logs' });
});

test('toInputText round trip', () => {
  assert.equal(toInputText(f('iecode.ads.aiWritePaths'), ['a', 'b']), 'a\nb');
  assert.equal(toInputText(f('iecode.ads.port'), 851), '851');
  assert.equal(toInputText(f('iecode.ads.presets'), {}), '{}');
});
