import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTree, diffSummary, diffTrees, readProject, shortName, treeToYaml, yamlScalar, DiffEntry } from '../src/core/iotree';
import { linksAt, projectAt } from '../src/core/iohistory';

const TSPROJ = (links: string) => `<?xml version="1.0"?>
<TcSmProject>
  <Project><Io><Device File="Device 1 (EtherCAT).xti"/></Io></Project>
  <Mappings>
    <OwnerA Name="TIPC^PLC1^PLC1 Instance">
      <OwnerB Name="TIID^Device 1 (EtherCAT)^B1^Term 2 (EL1008)">
${links}
      </OwnerB>
    </OwnerA>
  </Mappings>
</TcSmProject>`;
const LINKS = `        <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.bStart2" VarB="Channel 1^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.yes" VarB="Channel 10^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.bNamed" VarB="Channel 2^MAIN.bNamed" Size="1" OffsB="3"/>`;
// The device holds inline boxes; one box is stored in its own file, in a folder per inline box.
const DEVICE = `<TcSmItem><Device><Name>Device 1 (EtherCAT)</Name>
  <Box><Name>B1</Name><Box><Name>Term 2 (EL1008)</Name></Box><Box File="Term 9.xti"/></Box>
</Device></TcSmItem>`;
// Owner names in an .xti are relative to the item of the file ("" = the box itself).
const TERM9 = `<TcSmItem><Box><Name>Term 9</Name></Box><Mappings><OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="">
  <Link VarA="PlcTask Outputs^MAIN.bLamp" VarB="Channel 1^Output"/></OwnerB></OwnerA></Mappings></TcSmItem>`;
const UNREFERENCED = `<TcSmItem><Mappings><OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="TIID^Old">
  <Link VarA="PlcTask Inputs^MAIN.bOld" VarB="Channel 1^Input"/></OwnerB></OwnerA></Mappings></TcSmItem>`;

function project(links = LINKS): string {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-iotree-'));
  writeFileSync(join(dir, 'Sys.tsproj'), TSPROJ(links));
  mkdirSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT)', 'B1'), { recursive: true });
  writeFileSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT).xti'), '﻿' + DEVICE);
  writeFileSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT)', 'B1', 'Term 9.xti'), TERM9);
  writeFileSync(join(dir, '_Config', 'IO', 'Old.xti'), UNREFERENCED);
  return dir;
}
const read = (f: string) => fs.readFile(f, 'utf8').catch(() => undefined);

test('links of the referenced .xti chain, owners resolved, unreferenced files ignored', async () => {
  const dir = project();
  try {
    const links = await linksAt(join(dir, 'Sys.tsproj'), undefined);
    assert.equal(links.length, 5);
    const lamp = links.find(l => l.variable.endsWith('MAIN.bLamp'))!;
    assert.equal(lamp.io, 'TIID^Device 1 (EtherCAT)^B1^Term 9^Channel 1^Output');
    assert.equal(lamp.file, '_Config/IO/Device 1 (EtherCAT)/B1/Term 9.xti');
    assert.ok(!links.some(l => l.variable.endsWith('MAIN.bOld')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('YAML tree: boxes nested, channels in natural order, channel named after the variable shortened', async () => {
  const dir = project();
  try {
    const s = await readProject(join(dir, 'Sys.tsproj'), read);
    assert.deepEqual(s.warnings, []);
    assert.equal(treeToYaml(buildTree(s.links, s.boxes)), [
      'Device 1 (EtherCAT):',
      '  B1:',
      '    Term 2 (EL1008):',
      '      Channel 1^Input:',
      '        - PLC1^MAIN.bStart',
      '        - PLC1^MAIN.bStart2',
      '      Channel 2: PLC1^MAIN.bNamed [Size=1 OffsIO=3]',
      '      Channel 10^Input: PLC1^MAIN.yes',
      '    Term 9:',
      '      Channel 1^Output: PLC1^MAIN.bLamp',
      ''].join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing referenced file is a warning', async () => {
  const dir = project();
  try {
    rmSync(join(dir, '_Config', 'IO', 'Device 1 (EtherCAT)', 'B1', 'Term 9.xti'));
    const s = await readProject(join(dir, 'Sys.tsproj'), read);
    assert.equal(s.links.length, 4);
    assert.match(s.warnings[0], /Referenced file not found: _Config.IO.Device 1 \(EtherCAT\).B1.Term 9\.xti/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('short names and YAML scalars', () => {
  assert.equal(shortName('TIPC^Plc^Plc Instance^PlcTask Inputs^MAIN.x'), 'Plc^MAIN.x');
  assert.equal(shortName('TINC^NC-Task 1 SAF^Axes^MA1^Drive'), 'NC^NC-Task 1 SAF^Axes^MA1^Drive');
  assert.equal(shortName('TIID^Device 1^Term 1'), 'Device 1^Term 1');
  assert.equal(yamlScalar('Channel 1'), 'Channel 1');
  assert.equal(yamlScalar('yes'), "'yes'");
  assert.equal(yamlScalar('12'), "'12'");
  assert.equal(yamlScalar('-KF2.0 (EK1100)'), '-KF2.0 (EK1100)');
  assert.equal(yamlScalar("a: it's"), "'a: it''s'");
  assert.equal(yamlScalar('[x]'), "'[x]'");
});

const leaf = (es: DiffEntry[], ...path: string[]): DiffEntry => {
  const [k, ...rest] = path;
  const e = es.find(x => x.key === k)!;
  return rest.length ? leaf(e.kids!, ...rest) : e;
};

test('tree comparison with git HEAD: added, removed and moved values', async () => {
  const dir = project();
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(dir, 'Sys.tsproj'), TSPROJ(`        <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.bStart2" VarB="Channel 3^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.bNamed" VarB="Channel 2^MAIN.bNamed" Size="1" OffsB="3"/>`));
    const [a, b] = await Promise.all([projectAt(join(dir, 'Sys.tsproj'), 'HEAD'), projectAt(join(dir, 'Sys.tsproj'), undefined)]);
    assert.equal(a.links.length, 5);
    assert.equal(b.links.length, 4);
    const d = diffTrees(buildTree(a.links, a.boxes), buildTree(b.links, b.boxes));
    assert.deepEqual(diffSummary(d), { channels: 3, added: 0, removed: 1, moved: 1 });
    const term = ['Device 1 (EtherCAT)', 'B1', 'Term 2 (EL1008)'];
    assert.equal(leaf(d, 'Device 1 (EtherCAT)').state, 'changed');
    assert.equal(leaf(d, ...term, 'Channel 2').state, 'same');
    assert.deepEqual(leaf(d, ...term, 'Channel 1^Input').values, [
      { text: 'PLC1^MAIN.bStart', state: 'same' },
      { text: 'PLC1^MAIN.bStart2', state: 'removed', moved: 'Device 1 (EtherCAT) › B1 › Term 2 (EL1008) › Channel 3^Input' },
    ]);
    assert.equal(leaf(d, ...term, 'Channel 3^Input').state, 'added');
    assert.equal(leaf(d, ...term, 'Channel 10^Input').state, 'removed');
    assert.equal(leaf(d, 'Device 1 (EtherCAT)', 'B1', 'Term 9').state, 'same');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history reads referenced files with non-ASCII names (git quotes them without -z)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-iotree-'));
  try {
    writeFileSync(join(dir, 'Sys.tsproj'), '<TcSmProject><Project><Io><Device File="Gerät 1.xti"/></Io></Project></TcSmProject>');
    mkdirSync(join(dir, '_Config', 'IO'), { recursive: true });
    writeFileSync(join(dir, '_Config', 'IO', 'Gerät 1.xti'), `<TcSmItem><Device><Name>Gerät 1</Name></Device><Mappings><OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="">
  <Link VarA="PlcTask Inputs^MAIN.bTür" VarB="Channel 1^Input"/></OwnerB></OwnerA></Mappings></TcSmItem>`);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.quotePath=true', ...a], { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const head = await projectAt(join(dir, 'Sys.tsproj'), 'HEAD');
    assert.deepEqual(head.warnings, []);
    assert.deepEqual((await linksAt(join(dir, 'Sys.tsproj'), 'HEAD')).map(l => l.io), ['TIID^Gerät 1^Channel 1^Input']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git refs starting with "-" are refused, not passed to git as options', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iecode-gitref-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const { show, filesAt } = await import('../src/core/git');
    const out = join(dir, 'pwned.txt');
    assert.equal(await show(dir, `--output=${out}`, join(dir, 'a.txt')), undefined);
    await assert.rejects(filesAt(dir, `--output=${out}`, dir, ['.txt']), /Invalid git ref/);
    await assert.rejects(fs.access(out));
    assert.equal(await show(dir, 'HEAD', join(dir, 'a.txt')), 'a');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
