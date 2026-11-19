import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HwLink, linksOfFile } from '../src/core/iotree';
import { LinkSource, checkIoLinks, withLines } from '../src/core/ioLinkChecks';
import type { TmcFile, TmcVar } from '../src/core/tmc';

const IN = 'PlcTask Inputs', OUT = 'PlcTask Outputs';
const plcSide = (area: string, path: string, plc = 'PLC1') => `TIPC^${plc}^${plc} Instance^${area}^${path}`;
const CH = (n: number, dir = 'Input') => `TIID^Device 1^Box 1^Channel ${n}^${dir}`;

function link(area: string, path: string, io: string, extra: Record<string, string> = {}, plc = 'PLC1', size?: string, offsIo?: string): LinkSource {
  const l: HwLink = { left: plcSide(area, path, plc), right: io, size, offsRight: offsIo, attrs: { ...extra }, sideA: plcSide(area, path, plc), file: 'Sys.tsproj' };
  return { link: l, line: 10 };
}
const sym = (name: string, type = 'BOOL'): TmcVar => ({ name, type, bitSize: 8 });
const tmcOf = (inputs: TmcVar[], outputs: TmcVar[] = []): TmcFile => ({
  types: [],
  modules: [{ name: 'PLC1', contexts: [], interfaces: [], licenses: [], parameters: [], properties: [], areas: [
    { name: IN, areaType: 'InputDst', symbols: inputs }, { name: OUT, areaType: 'OutputSrc', symbols: outputs },
  ] }],
});
const FRESH = { stale: false };
const run = (links: LinkSource[], tmc: TmcFile | undefined = tmcOf([sym('MAIN.bStart')]), built = FRESH) => checkIoLinks(links, tmc, built, 'PLC1');
/** Rule ids without io-unlinked, which the fixtures' extra symbols would add everywhere. */
const rules = (links: LinkSource[], tmc?: TmcFile) => run(links, tmc).map(f => f.rule).filter(r => r !== 'io-unlinked');

test('no links gives no findings', () => {
  assert.deepEqual(run([]), []);
  assert.deepEqual(run([], undefined, { stale: true }), []);
});

test('a stale or missing build gives only io-not-built', () => {
  const l = [link(IN, 'MAIN.gone', CH(1))];
  assert.deepEqual(run(l, tmcOf([]), { stale: true }).map(f => [f.rule, f.level]), [['io-not-built', 'info']]);
  assert.deepEqual(checkIoLinks(l, undefined, FRESH, 'PLC1').map(f => f.rule), ['io-not-built']);
});

test('io-dead-link: a PLC side missing from the build is an error on the link line', () => {
  const [f] = run([link(IN, 'MAIN.gone', CH(1))]);
  assert.equal(f.rule, 'io-dead-link');
  assert.equal(f.level, 'error');
  assert.equal(f.line, 10);
  assert.equal(f.file, 'Sys.tsproj');
  assert.equal(f.space, 'xml');
  assert.deepEqual(rules([link(IN, 'MAIN.bStart', CH(1))]), []);
});

test('a same-named variable in another area is not a match', () => {
  assert.deepEqual(rules([link(OUT, 'MAIN.bStart', CH(1, 'Output'))]), ['io-dead-link']);
});

test('an array element and a ^ sub-path resolve through their parent', () => {
  const tmc = tmcOf([sym('MAIN.stIO', 'ST_IO'), sym('GVL.stData', 'ST_D')]);
  const l = [link(IN, 'MAIN.stIO.iaState[3]', CH(1)), link(IN, 'GVL.stData^D[0]', CH(2)), link(IN, 'MAIN.stIO.a.b[2].c', CH(3))];
  assert.deepEqual(rules(l, tmc), []);
});

test('a TIPC link that is not a PLC area symbol (safety) is skipped', () => {
  const safety: LinkSource = { line: 3, link: { left: 'TIPC^Safety^Safety Instance^StandardInputs^X', right: CH(1), attrs: {}, sideA: '', file: 'Sys.tsproj' } };
  assert.deepEqual(rules([safety]), []);
});

test('only links of the checked PLC are reported', () => {
  assert.deepEqual(rules([link(IN, 'MAIN.gone', CH(1), {}, 'PLC2')]), []);
});

test('io-type-changed: only for an exact match, and TypeA or TypeB by which side holds the PLC variable', () => {
  const tmc = tmcOf([sym('MAIN.bStart', 'BOOL'), sym('MAIN.stIO', 'ST_IO')]);
  assert.deepEqual(rules([link(IN, 'MAIN.bStart', CH(1), { TypeA: 'INT' })], tmc), ['io-type-changed']);
  assert.deepEqual(rules([link(IN, 'MAIN.bStart', CH(1), { TypeA: 'bool' })], tmc), []);
  assert.deepEqual(rules([link(IN, 'MAIN.bStart', CH(1))], tmc), []);                              // unknown, not a mismatch
  assert.deepEqual(rules([link(IN, 'MAIN.stIO.a[1]', CH(1), { TypeA: 'INT' })], tmc), []);        // through a parent
  const swapped = link(IN, 'MAIN.bStart', CH(1), { TypeA: 'INT', TypeB: 'BOOL' });
  swapped.link.sideA = CH(1);                                                                      // the IO side is stored as A
  assert.deepEqual(rules([swapped], tmc), []);
  swapped.link.attrs.TypeB = 'INT';
  assert.deepEqual(rules([swapped], tmc), ['io-type-changed']);
});

test('io-unlinked: a symbol of an input or output area that no link resolves to', () => {
  const tmc = tmcOf([sym('MAIN.bStart'), sym('MAIN.stIO', 'ST_IO'), sym('MAIN.bFree')], [sym('MAIN.bLamp')]);
  const found = run([link(IN, 'MAIN.bStart', CH(1)), link(IN, 'MAIN.stIO.a[1]', CH(2))], tmc);
  assert.deepEqual(found.map(f => [f.rule, f.level]), [['io-unlinked', 'hint'], ['io-unlinked', 'hint']]);
  assert.ok(found.some(f => /MAIN\.bFree/.test(f.message)) && found.some(f => /MAIN\.bLamp/.test(f.message)));
});

test('io-unlinked is skipped and explained while the link set is incomplete', () => {
  const tmc = tmcOf([sym('MAIN.bStart'), sym('MAIN.bFree')]);
  const f = checkIoLinks([link(IN, 'MAIN.bStart', CH(1))], tmc, FRESH, 'PLC1', { incomplete: 'an .xti could not be read', anchor: { file: 'Sys.tsproj', line: 0 } });
  assert.deepEqual(f.map(x => [x.rule, x.level]), [['io-links-incomplete', 'info']]);
});

test('two variables on an input channel give info, on an output channel a warning, on disjoint bits nothing', () => {
  const tmc = tmcOf([sym('MAIN.a'), sym('MAIN.b')], [sym('MAIN.c'), sym('MAIN.d')]);
  const inputs = [link(IN, 'MAIN.a', CH(1), {}, 'PLC1', '1', '0'), link(IN, 'MAIN.b', CH(1), {}, 'PLC1', '1', '0')];
  const outputs = [link(OUT, 'MAIN.c', CH(2, 'Output'), {}, 'PLC1', '1', '0'), link(OUT, 'MAIN.d', CH(2, 'Output'), {}, 'PLC1', '1', '0')];
  const disjoint = [link(OUT, 'MAIN.c', CH(3, 'Output'), {}, 'PLC1', '1', '0'), link(OUT, 'MAIN.d', CH(3, 'Output'), {}, 'PLC1', '1', '8')];
  const unknown = [link(OUT, 'MAIN.c', CH(4, 'Output')), link(OUT, 'MAIN.d', CH(4, 'Output'))];
  const twice = (l: LinkSource[]) => run(l, tmc).filter(f => f.rule === 'io-channel-twice').map(f => f.level);
  assert.deepEqual(twice(inputs), ['info', 'info']);
  assert.deepEqual(twice(outputs), ['warning', 'warning']);
  assert.deepEqual(twice(disjoint), []);
  assert.deepEqual(twice(unknown), ['info', 'info']);
});

test('the channel rule groups over all PLC projects but reports only the links of the checked one', () => {
  const tmc = tmcOf([], [sym('MAIN.c')]);
  const l = [link(OUT, 'MAIN.c', CH(1, 'Output'), {}, 'PLC1', '1', '0'), link(OUT, 'MAIN.x', CH(1, 'Output'), {}, 'PLC2', '1', '0')];
  const f = run(l, tmc).filter(x => x.rule === 'io-channel-twice');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'warning');
});

test('links in UnrestoredVarLinks are ignored; withLines finds the line of each <Link>', () => {
  const src = `<TcSmProject>
  <Mappings>
    <OwnerA Name="TIPC^PLC1^PLC1 Instance">
      <OwnerB Name="TIID^Device 1^Box 1">
        <Link VarA="PlcTask Inputs^MAIN.bStart" VarB="Channel 1^Input"/>
      </OwnerB>
    </OwnerA>
  </Mappings>
  <UnrestoredVarLinks>
    <OwnerA Name="TIPC^PLC1^PLC1 Instance"><OwnerB Name="TIID^Device 1^Box 1">
      <Link VarA="PlcTask Inputs^MAIN.old" VarB="Channel 9^Input"/></OwnerB></OwnerA>
  </UnrestoredVarLinks>
</TcSmProject>`;
  const links = linksOfFile(src, 'Sys.tsproj');
  assert.equal(links.length, 1);
  const sources = withLines(links, () => src);
  assert.equal(sources[0].line, 4);
  assert.deepEqual(rules(sources), []);
});
