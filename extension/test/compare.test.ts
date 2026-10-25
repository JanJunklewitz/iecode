import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, diffLinks, linksToCsv, shortPath } from '../src/core/iolinks';
import { diffLines, unifiedDiff } from '../src/core/textdiff';

const tsproj = (links: string) => `<?xml version="1.0"?>
<TcSmProject TcSmVersion="1.0" TcVersion="3.1.4024.66">
  <Project>
    <Io><Device Name="Device 1 (EtherCAT)" File="Device 1 (EtherCAT).xti"/></Io>
  </Project>
  <Mappings>
    <OwnerA Name="TIPC^PLC1^PLC1 Instance">
      <OwnerB Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 2 (EL1008)">
${links}
      </OwnerB>
    </OwnerA>
    <OwnerA Name="TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 3 (EL2008)">
      <OwnerB Name="TIPC^PLC1^PLC1 Instance">
        <Link VarA="Channel 1^Output" VarB="PlcTask Outputs^MAIN.bLamp"/>
      </OwnerB>
    </OwnerA>
  </Mappings>
</TcSmProject>`;

const OLD = tsproj(`        <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.bStop" VarB="Channel 2^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.nInputs" VarB="Channel 3^Input" Size="1" OffsA="8"/>`);
const NEW = tsproj(`        <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 4^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.bReset" VarB="Channel 2^Input"/>
        <Link VarA="PlcTask Inputs^MAIN.nInputs" VarB="Channel 3^Input" Size="1" OffsA="9"/>`);

test('extracts links and always puts the IO side into io', () => {
  const links = extractLinks(OLD, 'Machine.tsproj');
  assert.equal(links.length, 4);
  const lamp = links.find(l => l.variable.endsWith('MAIN.bLamp'))!;
  assert.equal(lamp.variable, 'TIPC^PLC1^PLC1 Instance^PlcTask Outputs^MAIN.bLamp');
  assert.equal(lamp.io, 'TIID^Device 1 (EtherCAT)^Term 1 (EK1100)^Term 3 (EL2008)^Channel 1^Output');
  assert.deepEqual(links.find(l => l.variable.endsWith('nInputs'))!.attrs, { Size: '1', OffsA: '8' });
  assert.match(linksToCsv(links), /^Variable;IO;Attributes;File\n/);
  assert.equal(shortPath(lamp.io), '…^Term 3 (EL2008)^Channel 1^Output');
});

test('diff: moved, added, removed, changed attributes, unchanged ignored', () => {
  const c = diffLinks(extractLinks(OLD, 'a'), extractLinks(NEW, 'b'));
  const s = c.map(x => `${x.kind} ${x.variable.split('^').pop()} ${x.before ? shortPath(x.before, 2) : ''} -> ${x.after ? shortPath(x.after, 2) : ''}`);
  assert.deepEqual(s, [
    'added MAIN.bReset  -> …^Channel 2^Input',
    'moved MAIN.bStart …^Channel 1^Input -> …^Channel 4^Input',
    'removed MAIN.bStop …^Channel 2^Input -> ',
    'changed MAIN.nInputs …^Channel 3^Input -> …^Channel 3^Input',
  ]);
  assert.equal(c[3].details, 'OffsA=8 Size=1 → OffsA=9 Size=1');
  assert.deepEqual(diffLinks(extractLinks(OLD, 'a'), extractLinks(OLD, 'b')), []);
});

test('line diff and unified diff', () => {
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.deepEqual(ops.map(o => o.op + o.text), [' a', '-b', '+x', ' c', ' d', '+e']);
  assert.equal(unifiedDiff('same\n', 'same\n', 'a', 'b'), '');
  const u = unifiedDiff('1\n2\n3\n4\n5\n6\n7\n8\n9\n', '1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n', 'old', 'new', 1);
  assert.equal(u, '--- old\n+++ new\n@@ -4,3 +4,3 @@\n 4\n-5\n+FIVE\n 6\n');
  assert.deepEqual(diffLines([], ['a']).map(o => o.op), ['+']);
  assert.deepEqual(diffLines(['a'], []).map(o => o.op), ['-']);
});

test('line diff reproduces both inputs for random cases', () => {
  let seed = 42;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 300; i++) {
    const a = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]);
    const b = Array.from({ length: rnd(12) }, () => 'abcd'[rnd(4)]);
    const ops = diffLines(a, b);
    assert.deepEqual(ops.filter(o => o.op !== '+').map(o => o.text), a);
    assert.deepEqual(ops.filter(o => o.op !== '-').map(o => o.text), b);
  }
});

test('working-copy links include .xti files deep below _Config', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { linksAt } = await import('../src/core/iohistory');
  const dir = mkdtempSync(join(tmpdir(), 'iecode-io-'));
  try {
    writeFileSync(join(dir, 'Sys.tsproj'), OLD);
    // TwinCAT nests one folder per box: _Config/IO/<device>/<box>/<box>/…/<term>.xti
    const deep = join(dir, '_Config', 'IO', 'Device 1 (EtherCAT)', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'Term 9.xti'), `<TcSmItem><Mappings><OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="TIID^Device 1 (EtherCAT)^Term 9">
      <Link VarA="PlcTask Inputs^MAIN.bDeep" VarB="Channel 1^Input"/></OwnerB></OwnerA></Mappings></TcSmItem>`);
    const links = await linksAt(join(dir, 'Sys.tsproj'), undefined);
    assert.equal(links.length, 5);
    assert.ok(links.some(l => l.variable.endsWith('MAIN.bDeep') && l.file.startsWith('_Config/IO/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
