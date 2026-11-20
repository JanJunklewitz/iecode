import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlcLinkSide, normalizeLinkPath, resolveLinkSymbol, systemProjectOf } from '../src/core/ioLinkSymbols';
import type { TmcVar } from '../src/core/tmc';
import type { Unit } from '../src/core/workspace';

const link = (path: string, plc = 'PLC1') => `TIPC^${plc}^${plc} Instance^PlcTask Inputs^${path}`;

test('a PLC side is split into plc, area and path', () => {
  assert.deepEqual(parsePlcLinkSide(link('MAIN.bStart')), { plc: 'PLC1', area: 'PlcTask Inputs', path: 'MAIN.bStart' });
  assert.deepEqual(parsePlcLinkSide('TIPC^PLC2^PLC2 Instance^Fast Outputs^GVL.stOut^D[0]'),
    { plc: 'PLC2', area: 'Fast Outputs', path: 'GVL.stOut^D[0]' });
});

test('a safety TIPC side, an IO side and a name with another instance name give undefined', () => {
  assert.equal(parsePlcLinkSide('TIPC^Safety^Safety Instance^StandardInputs^X'), undefined);
  assert.equal(parsePlcLinkSide('TIID^Device 1^Box 1^Channel 1'), undefined);
  assert.equal(parsePlcLinkSide('TIPC^PLC1^PLC2 Instance^PlcTask Inputs^MAIN.x'), undefined);
});

test('normalizeLinkPath removes array indices and turns ^ into dots', () => {
  assert.equal(normalizeLinkPath('MAIN.iaState[3]'), 'main.iastate');
  assert.equal(normalizeLinkPath('GVL.stData^D[0]'), 'gvl.stdata.d');
  assert.equal(normalizeLinkPath('MAIN.a[1][2].b'), 'main.a.b');
});

test('resolveLinkSymbol finds an exact symbol, an array element through its array and a ^ sub-path through its parent', () => {
  const v = (name: string) => ({ name, type: 'BOOL' }) as TmcVar;
  const symbols = new Map<string, TmcVar>([['main.bstart', v('MAIN.bStart')], ['main.iastate', v('MAIN.iaState')], ['gvl.stdata', v('GVL.stData')]]);
  assert.equal(resolveLinkSymbol('MAIN.bStart', symbols).symbol?.name, 'MAIN.bStart');
  assert.equal(resolveLinkSymbol('MAIN.bStart', symbols).viaParent, false);
  assert.equal(resolveLinkSymbol('MAIN.iaState[3]', symbols).symbol?.name, 'MAIN.iaState');
  assert.equal(resolveLinkSymbol('GVL.stData^D[0]', symbols).symbol?.name, 'GVL.stData');
});

test('a longer unknown tail still resolves through the longest known prefix and says viaParent', () => {
  const symbols = new Map<string, TmcVar>([['gvl.stdata', { name: 'GVL.stData', type: 'ST' } as TmcVar]]);
  const r = resolveLinkSymbol('GVL.stData.sub.deep[2]', symbols);
  assert.equal(r.symbol?.name, 'GVL.stData');
  assert.equal(r.viaParent, true);
  assert.deepEqual(resolveLinkSymbol('Other.x', symbols), { symbol: undefined, viaParent: false });
});

const plc = (file: string, name: string, itemName?: string) => ({ file, name, itemName }) as Unit['plc'];

test('systemProjectOf finds the project that contains the PLC and one with PLC and IO in one tsproj', () => {
  const a = plc('a/PLC1.plcproj', 'PLC1');
  const b = plc('b/Other.plcproj', 'Other');
  const model = { solutions: [{ file: 's.sln', name: 's', projects: [
    { file: 'a.tsproj', name: 'a', plcOnly: false, plcs: [a] },
    { file: 'b.tsproj', name: 'b', plcOnly: false, plcs: [b] },
  ] }] };
  const unit = { id: 's/PLC1', plc: a, solution: model.solutions[0] } as unknown as Unit;
  const r = systemProjectOf(model as never, unit);
  assert.equal(r?.project.file, 'a.tsproj');
  assert.equal(r?.plcName, 'PLC1');
});

test('systemProjectOf returns the PLC item name of a renamed PLC', () => {
  const a = plc('a/Machine.plcproj', 'Machine', 'PLC7');
  const model = { solutions: [{ file: 's.sln', name: 's', projects: [{ file: 'a.tsproj', name: 'a', plcOnly: false, plcs: [a] }] }] };
  const unit = { id: 's/Machine', plc: a, solution: model.solutions[0] } as unknown as Unit;
  assert.equal(systemProjectOf(model as never, unit)?.plcName, 'PLC7');
  assert.equal(systemProjectOf(model as never, { ...unit, solution: undefined }), undefined);
});
