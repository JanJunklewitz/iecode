import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopeBuffer, WatchItem, gapNote } from '../src/core/adswatch';
import { COPILOT_NAMES, MCP_NAMES, MAX_TOOL_TEXT, TRUNCATED, capText, emptyReadText, emptyScopeText, readRow, readOnceRow, readText, scopeSummaryText, scopeToolText, symbolsText, watchFailureText, watchListText, watchResultText, waitResultText } from '../src/core/adsToolText';

const item = (symbol: string, type = 'INT', error: string | null = null): WatchItem => ({ symbol, type, numeric: true, error });
const filled = (symbols: string[], n = 3) => {
  const b = new ScopeBuffer(300);
  b.setItems(1, symbols.map(s => item(s)));
  b.push(1, Array.from({ length: n }, (_, i) => ({ t: i * 1000, v: symbols.map(() => String(i)) })));
  return b;
};
const clock = () => '10:00:00';

test('watch list text marks who added the entries', () => {
  assert.equal(watchListText([], []), 'The ADS watch list is empty.');
  assert.equal(
    watchListText([item('MAIN.a'), item('MAIN.b', '', 'Symbol not found')], [{ symbol: 'MAIN.a', ai: false }, { symbol: 'main.b', ai: true }]),
    'MAIN.a : INT [added by the user]\nMAIN.b : ? (error: Symbol not found) [added by AI]');
});

test('watch result text names the scope tool of the client', () => {
  const args = { list: 'L', kept: ['MAIN.a'], added: true, intervalMs: 100 };
  assert.equal(watchResultText({ ...args, names: COPILOT_NAMES }),
    'L\nNot removed (added by the user, only the user can remove them): MAIN.a\nNew values arrive every 100 ms; use adsScope for the history.');
  assert.equal(watchResultText({ ...args, kept: [], names: MCP_NAMES }), 'L\nNew values arrive every 100 ms; use ads_scope for the history.');
  assert.equal(watchResultText({ list: 'L', kept: [], added: false, intervalMs: 100, names: MCP_NAMES }), 'L');
});

test('a watch call that partly fails keeps the partial state and is an error', () => {
  assert.deepEqual(watchFailureText('Error: boom', 'L'), { text: 'Error: boom\nWatch list now:\nL', isError: true });
});

test('symbols listing', () => {
  const base = { matches: ['MAIN.a : INT'], total: 1, max: 100, typed: 'a', missing: [], unreadable: [], units: 1 };
  assert.equal(symbolsText(base), 'MAIN.a : INT');
  assert.equal(symbolsText({ ...base, matches: [], total: 0, typed: 'zz' }), 'No symbols match "zz".');
  assert.equal(symbolsText({ ...base, total: 103 }), 'MAIN.a : INT\n(3 more not listed; use a narrower filter)');
  assert.equal(symbolsText({ ...base, missing: ['P1', 'P2'], unreadable: ['P3 (bad)'] }),
    'MAIN.a : INT\nNot built, so not listed (no .tmc): P1, P2\nBuild output unreadable, so not listed: P3 (bad)');
  assert.equal(symbolsText({ ...base, matches: [], total: 0, units: 0 }), 'No symbols match "a".\nNo PLC projects in this workspace.');
});

test('read rows', () => {
  assert.equal(readRow({ symbol: 'MAIN.a', type: 'INT', value: '5', error: null }), 'MAIN.a : INT = 5');
  assert.equal(readRow({ symbol: 'MAIN.a', type: '', value: null, error: 'Symbol not found' }), 'MAIN.a : ? = (read error: Symbol not found)');
  assert.equal(readRow({ symbol: 'MAIN.a', type: 'INT', value: null, error: null }), 'MAIN.a : INT = (read error)');
  assert.equal(readOnceRow({ symbol: 'MAIN.x', type: 'BOOL', value: 'TRUE', error: null }), 'MAIN.x : BOOL = TRUE');
  assert.equal(readOnceRow({ symbol: 'MAIN.x', type: '', value: null, error: 'nope' }), 'MAIN.x : error nope');
  assert.equal(readText('local', ['r1', 'r2']), 'Values on local:\nr1\nr2');
  assert.equal(emptyReadText(), 'Nothing to read: no symbols given and the ADS watch list is empty.');
});

test('read appends the sample age', () => {
  assert.equal(readRow({ symbol: 'MAIN.a', type: 'INT', value: '5', error: null, age: '12 s old' }), 'MAIN.a : INT = 5 (12 s old)');
});

test('scope summary of fresh samples has no gap note', () => {
  assert.equal(scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock }),
    'ADS values of the last 60 s up to the newest sample (target local):\na: min=0 max=2 last=2 count=3 changes=2 (first at -1.0 s, last at 0.0 s)\n\nt[s]\ta\n-2.000\t0\n-1.000\t1\n0.000\t2');
});

test('scope uses the gap note', () => {
  const text = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 70_000, clock });
  const note = gapNote(2000, 70_000, clock)!;
  assert.ok(text.startsWith(`${note}\n`), text);
  assert.ok(text.includes('(target local):'));
  assert.ok(!text.includes('may have stopped'));
});

test('scope without samples', () => {
  assert.equal(scopeSummaryText({ buffer: new ScopeBuffer(300), symbols: ['a', 'b'], seconds: 60, target: 'local', intervalMs: 100, now: 1, clock }),
    'No samples yet for a, b. The values are sampled every 100 ms while the ADS host runs.');
});

test('scope tool text names the watch tool of the client', () => {
  assert.equal(emptyScopeText(COPILOT_NAMES), 'The ADS watch list is empty; add symbols with adsWatch first.');
  assert.equal(emptyScopeText(MCP_NAMES), 'The ADS watch list is empty; add symbols with ads_watch first.');
  assert.equal(scopeToolText('S', ['x', 'y'], COPILOT_NAMES), 'Not watched, so no history (add them with adsWatch): x, y\n\nS');
  assert.equal(scopeToolText('S', ['x'], MCP_NAMES), 'Not watched, so no history (add them with ads_watch): x\n\nS');
  assert.equal(scopeToolText('S', [], MCP_NAMES), 'S');
  assert.equal(scopeToolText(undefined, ['x'], MCP_NAMES), 'Not watched, so no history (add them with ads_watch): x');
});

test('scope table keeps 20 symbols', () => {
  const symbols = Array.from({ length: 25 }, (_, i) => `s${i}`);
  const text = scopeSummaryText({ buffer: filled(symbols), symbols, seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock });
  for (const s of symbols) assert.ok(text.includes(`${s}: min=0`), `summary of ${s}`);
  const header = text.split('\n').find(l => l.startsWith('t[s]'))!;
  assert.equal(header.split('\t').length, 21);
  assert.ok(text.includes('first 20 of 25 symbols'));
});

test('tool text is cut at the limit', () => {
  assert.equal(capText('short'), 'short');
  const long = 'x'.repeat(MAX_TOOL_TEXT + 100);
  const cut = capText(long);
  assert.ok(cut.endsWith(TRUNCATED));
  assert.ok(cut.startsWith('xxx'));
});

test('capText result never exceeds the limit', () => {
  for (const n of [MAX_TOOL_TEXT - 1, MAX_TOOL_TEXT, MAX_TOOL_TEXT + 1, MAX_TOOL_TEXT * 3]) assert.ok(capText('y'.repeat(n)).length <= MAX_TOOL_TEXT, String(n));
  assert.equal(capText('y'.repeat(MAX_TOOL_TEXT)).length, MAX_TOOL_TEXT);
  assert.equal(capText('z', 10), 'z');
  assert.ok(capText('z'.repeat(1000), TRUNCATED.length + 5).length <= TRUNCATED.length + 5);
});

test('waitResultText words every outcome', () => {
  const base = { symbol: 'MAIN.x', condition: { op: 'changes' } as const, intervalMs: 100, clock: (ms: number) => `T${ms}` };
  const sampled = 'Sampled every 100 ms; changes between samples are not seen.';
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'met', t: 5, value: '3', firstObservation: false, elapsedMs: 1234 } }),
    { text: `Condition met at T5 (after 1.23 s): MAIN.x = 3\n${sampled}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'met', t: 5, value: '3', firstObservation: true, elapsedMs: 0 } }),
    { text: `Condition met at T5 (after 0.00 s): MAIN.x = 3 (true at the first observation)\n${sampled}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'timeout', last: '2', seconds: 30 } }),
    { text: `Not met within 30 s: MAIN.x changes; last value 2\n${sampled}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'timeout', last: undefined, seconds: 30 } }),
    { text: `Not met within 30 s: MAIN.x changes; no valid value observed\n${sampled}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'timeout', last: 'eIdle', seconds: 30, seenEnum: ['eIdle', 'eRun'] } }),
    { text: `Not met within 30 s: MAIN.x changes; last value eIdle; enum names seen: eIdle, eRun (a name never seen may be misspelled)\n${sampled}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'ended', reason: 'host stopped' } }), { text: 'Wait ended: host stopped' });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'refused', reason: 'nope' } }), { text: 'Error: nope', isError: true });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'cancelled' } }), { text: 'Wait cancelled.' });
  assert.equal(COPILOT_NAMES.wait, 'adsWait');
  assert.equal(MCP_NAMES.wait, 'ads_wait');
});

test('scope summary passes maxRows to the table', () => {
  assert.equal(scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, options: { maxRows: 2 } }),
    'ADS values of the last 60 s up to the newest sample (target local):\na: min=0 max=2 last=2 count=3 changes=2 (first at -1.0 s, last at 0.0 s)\n\n2 of 3 samples shown; evenly thinned (fast-changing): a\nt[s]\ta\n-2.000\t0\n0.000\t2');
});
