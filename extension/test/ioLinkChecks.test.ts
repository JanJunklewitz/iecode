import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HwLink, linksOfFile } from '../src/core/iotree';
import { LinkSource, checkIoLinks, ioFindingRows, unreadableProjectFinding, withLines } from '../src/core/ioLinkChecks';
import { Finding, offsetToPosition } from '../src/core/findings';
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

test('io-unlinked gives one finding per area and names the first variables', () => {
  const many = Array.from({ length: 8 }, (_, i) => sym(`MAIN.b${i}`));
  const found = run([], tmcOf(many)).filter(f => f.rule === 'io-unlinked');
  assert.equal(found.length, 0, 'without any link of the PLC nothing is reported');
  const withOne = run([link(IN, 'MAIN.b0', CH(1))], tmcOf(many)).filter(f => f.rule === 'io-unlinked');
  assert.equal(withOne.length, 1);
  assert.match(withOne[0].message, /7 variable\(s\)/);
  assert.match(withOne[0].message, /2 more/);
});

test('an unreadable build is named, not reported as not built', () => {
  const f = checkIoLinks([link(IN, 'MAIN.a', CH(1))], undefined, { stale: false, unreadable: 'bad xml' }, 'PLC1');
  assert.equal(f[0].rule, 'io-not-built');
  assert.match(f[0].message, /could not be read \(bad xml\)/);
  assert.match(f[0].message, /^PLC1:/);
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
  const twice = (l: LinkSource[]) => run(l, tmc).filter(f => f.rule.startsWith('io-channel-twice')).map(f => f.level);
  assert.deepEqual(twice(inputs), ['info', 'info']);
  assert.deepEqual(twice(outputs), ['warning', 'warning']);
  assert.deepEqual(twice(disjoint), []);
  assert.deepEqual(twice(unknown), ['info', 'info']);
});

test('the channel rule groups over all PLC projects but reports only the links of the checked one', () => {
  const tmc = tmcOf([], [sym('MAIN.c')]);
  const l = [link(OUT, 'MAIN.c', CH(1, 'Output'), {}, 'PLC1', '1', '0'), link(OUT, 'MAIN.x', CH(1, 'Output'), {}, 'PLC2', '1', '0')];
  const f = run(l, tmc).filter(x => x.rule.startsWith('io-channel-twice'));
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

test('ioFindingRows sorts errors first, then by file and line', () => {
  const f = (rule: string, level: Finding['level'], file: string, line: number): Finding =>
    ({ rule, level, message: `m-${rule}`, file, line, col: 0, endLine: line, endCol: 1 });
  const rows = ioFindingRows([f('a', 'hint', 'x', 1), f('b', 'error', 'z', 9), f('c', 'error', 'y', 2), f('d', 'warning', 'x', 0)]);
  assert.deepEqual(rows.map(r => r.label), ['m-c', 'm-b', 'm-d', 'm-a']);
  assert.deepEqual(rows[0], { label: 'm-c', description: 'error · c', file: 'y', line: 2, level: 'error' });
});

test('a confirmed output clash is not hidden by a third link with an unknown range', () => {
  const tmc = tmcOf([], [sym('MAIN.c'), sym('MAIN.d'), sym('MAIN.e')]);
  const l = [link(OUT, 'MAIN.c', CH(1, 'Output'), {}, 'PLC1', '1', '0'), link(OUT, 'MAIN.d', CH(1, 'Output'), {}, 'PLC1', '1', '0'), link(OUT, 'MAIN.e', CH(1, 'Output'))];
  const f = run(l, tmc).filter(x => x.rule.startsWith('io-channel-twice'));
  assert.ok(f.some(x => x.rule === 'io-channel-twice'));
});

test('the type of an array element link is not compared with the type of the array', () => {
  const tmc = tmcOf([sym('MAIN.a', 'ARRAY [0..3] OF BOOL')]);
  const found = run([link(IN, 'MAIN.a[3]', CH(1), { TypeA: 'BOOL', TypeB: 'BOOL' })], tmc);
  assert.ok(!found.some(f => f.rule === 'io-type-changed' || f.rule === 'io-dead-link'));
});

test('io-unlinked names the area as the build spells it', () => {
  const f = run([link(IN, 'MAIN.bStart', CH(1))], tmcOf([sym('MAIN.bStart'), sym('MAIN.bFree')])).find(x => x.rule === 'io-unlinked')!;
  assert.ok(f.message.includes('variable(s) of PlcTask Inputs have'), f.message);
});

test('a build with no data area gives io-not-built, not a dead link per link', () => {
  const empty: TmcFile = { types: [], modules: [] };
  const found = run([link(IN, 'MAIN.a', CH(1)), link(IN, 'MAIN.b', CH(2))], empty);
  assert.deepEqual(found.map(f => f.rule), ['io-not-built']);
  assert.match(found[0].message, /no data areas/);
});

test('withLines gives the same line as offsetToPosition for LF and CRLF text, and 0 for an unknown file or offset', () => {
  for (const eol of ['\n', '\r\n']) {
    const text = ['<a>', '  <Link A="1"/>', '  <Link A="2"/>', '', '  <Link A="3"/>', '</a>', ''].join(eol);
    const at = (n: number) => text.indexOf(`A="${n}"`) - 7;
    const mk = (n: number, file = 'f'): HwLink => ({ left: 'l', right: 'r', attrs: {}, sideA: 'l', file, at: at(n) });
    const got = withLines([mk(1), mk(2), mk(3), mk(3, 'other'), { ...mk(1), at: undefined }], f => (f === 'f' ? text : undefined));
    assert.deepEqual(got.map(g => g.line), [1, 2, 4, 0, 0], JSON.stringify(eol));
    for (const n of [1, 2, 3]) assert.equal(got[n - 1].line, offsetToPosition(text, at(n)).line);
  }
});

test('an unreadable project file gives one io-links-incomplete finding that names it', () => {
  const f = unreadableProjectFinding('Sys.tsproj');
  assert.deepEqual([f.rule, f.level, f.file], ['io-links-incomplete', 'info', 'Sys.tsproj']);
  assert.match(f.message, /Sys\.tsproj.*could not be read/);
});
