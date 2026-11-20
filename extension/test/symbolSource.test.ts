import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSources, UnitState } from '../src/core/symbolSource';
import { onlineArgs, onlineFailureText, parseOnlineOutput } from '../src/core/onlineSymbols';
import { onlineHeader, sourceHeader } from '../src/core/symbolOrigin';
import { parseSymbolsInput } from '../src/core/toolInput';

const units: UnitState[] = [
  { name: 'A', hasBuild: true, isLibrary: false },
  { name: 'B', hasBuild: false, isLibrary: false },
  { name: 'L', hasBuild: false, isLibrary: true },
];

test('auto with support and a filter asks the running PLC for the unit without a build', () => {
  const p = planSources({ choice: 'auto', units, onlineSupported: true, hasFilter: true });
  assert.equal(p.online, true);
  assert.deepEqual(p.perUnit, [{ unit: 'A', source: 'build' }, { unit: 'L', source: 'skip' }]);
  assert.deepEqual(p.notes, []);
});

test('auto without a filter falls back to the source and says why', () => {
  const p = planSources({ choice: 'auto', units, onlineSupported: true, hasFilter: false });
  assert.equal(p.online, false);
  assert.deepEqual(p.perUnit.find(u => u.unit === 'B'), { unit: 'B', source: 'source' });
  assert.deepEqual(p.notes, ['The online symbol list needs a filter or prefix; showing the source code instead.']);
});

test('auto with an old CLI says it needs a newer one', () => {
  const p = planSources({ choice: 'auto', units, onlineSupported: false, hasFilter: true });
  assert.equal(p.online, false);
  assert.deepEqual(p.notes, ['The online symbol list needs a newer iecode CLI: onlineSymbols; showing the source code instead.']);
});

test('auto with every unit built needs neither the PLC nor a note', () => {
  const p = planSources({ choice: 'auto', units: [units[0]], onlineSupported: true, hasFilter: false });
  assert.deepEqual(p, { online: false, perUnit: [{ unit: 'A', source: 'build' }], notes: [] });
});

test('build skips what has no build output, source takes everything from the source', () => {
  const b = planSources({ choice: 'build', units, onlineSupported: true, hasFilter: true });
  assert.deepEqual(b.perUnit.map(u => u.source), ['build', 'skip', 'skip']);
  const s = planSources({ choice: 'source', units, onlineSupported: true, hasFilter: true });
  assert.deepEqual(s.perUnit.map(u => u.source), ['source', 'source', 'source']);
});

test('online needs a filter and a CLI that can do it', () => {
  assert.equal(planSources({ choice: 'online', units, onlineSupported: true, hasFilter: false }).error, 'source "online" needs a filter or prefix: a running PLC has too many symbols to list.');
  assert.equal(planSources({ choice: 'online', units, onlineSupported: false, hasFilter: true }).error, 'source "online" needs a newer iecode CLI: onlineSymbols.');
  const ok = planSources({ choice: 'online', units, onlineSupported: true, hasFilter: true });
  assert.equal(ok.online, true);
  assert.equal(ok.error, undefined);
});

test('the CLI call and its result document', () => {
  assert.deepEqual(onlineArgs('local', 851, 'MAIN.'), ['ads', 'symbols', '--online', '--target', 'local', '--port', '851', '--filter', 'MAIN.', '--json']);
  const good = parseOnlineOutput('Running PLC local:851\nprogress\n{"ok":true,"data":{"target":"local","port":851,"total":2,"symbols":[{"name":"MAIN.a","type":"INT","comment":null}]}}\n');
  assert.deepEqual(good, { ok: true, value: { target: 'local', total: 2, symbols: [{ name: 'MAIN.a', type: 'INT', comment: null }] } });
  assert.deepEqual(parseOnlineOutput('{"ok":false,"error":"Cannot reach 5.1.2.3.1.1 over ADS: timeout"}'), { ok: false, error: 'Cannot reach 5.1.2.3.1.1 over ADS: timeout' });
  const none = { ok: false, error: 'The iecode CLI returned no result for the online symbol list.' };
  assert.deepEqual(parseOnlineOutput(''), none);
  assert.deepEqual(parseOnlineOutput('not json'), none);
  assert.equal(onlineFailureText('timeout'), 'Online symbol list failed: timeout. Showing the source code instead.');
});

test('the listing headers name the source', () => {
  assert.equal(onlineHeader('local'), 'Symbols from the running PLC (local).');
  assert.equal(sourceHeader('PLC1'), 'Symbols from the source code of PLC1 (may differ from the PLC).');
});

test('parseSymbolsInput keeps an explicit source and refuses an unknown one', () => {
  const p = parseSymbolsInput({ source: 'online' });
  assert.ok(p.ok && p.value.source === 'online');
  const auto = parseSymbolsInput({ source: 'auto' });
  assert.ok(auto.ok && !('source' in auto.value));
  const bad = parseSymbolsInput({ source: 'x' });
  assert.ok(!bad.ok && bad.error === 'source must be one of auto, online, build, source');
});
