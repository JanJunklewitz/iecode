import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScopeBuffer, WatchItem, gapNote } from '../src/core/adswatch';
import { parseCondition } from '../src/core/waitCondition';
import { COPILOT_NAMES, MCP_NAMES, MAX_TOOL_TEXT, TRUNCATED, capText, emptyReadText, emptyScopeText, readRow, readOnceRow, readText, scopeSummaryText, scopeToolText, symbolsText, enumText, noEnumText, hiddenText, propertyHintText, configText, captureResultText, addErrorLines, targetLine, targetOfKey, confirmRemoveText, unresolvedText, watchFailureText, watchListText, watchResultText, waitResultText } from '../src/core/adsToolText';

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

const none = { added: [], already: [], removed: [], kept: [], held: [], missing: [], declined: [] };
const wbase = { full: false, list: 'L', count: 3, intervalMs: 100, names: MCP_NAMES, addErrors: [] as string[], result: none, target: 'local', parked: 0, unresolved: [] as { symbol: string; error: string }[] };

test('watch result: a diff names only what changed, plus the count', () => {
  assert.equal(watchResultText({ ...wbase, result: { ...none, added: ['MAIN.a', 'MAIN.b'], removed: ['MAIN.c'] } }),
    'Added: MAIN.a, MAIN.b\nRemoved: MAIN.c\nWatch list: 3 symbols\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
  assert.equal(watchResultText({ ...wbase, count: 1, names: COPILOT_NAMES, result: { ...none, added: ['MAIN.a'] } }),
    'Added: MAIN.a\nWatch list: 1 symbol\nNew values arrive every 100 ms; use adsScope for the history.\nADS target: local');
  assert.equal(watchResultText({ ...wbase, result: { ...none, removed: ['MAIN.c'] } }), 'Removed: MAIN.c\nWatch list: 3 symbols\nADS target: local');
});

test('watch result: every refusal and error has its own line, in a fixed order', () => {
  assert.equal(watchResultText({ ...wbase, addErrors: ['MAIN.x : Symbol not found'],
    result: { added: ['MAIN.x'], already: ['a'], removed: [], kept: ['U'], held: ['h'], missing: ['m'], declined: [] } }),
    'Added: MAIN.x\nAlready in the list: a\nNot in the list: m\nNot removed (added by the user, only the user can remove them): U\nKept until a running wait ends: h\nError: MAIN.x : Symbol not found\nWatch list: 3 symbols\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
});

test('watch result: the full list replaces the count; an empty call is the list alone', () => {
  assert.equal(watchResultText({ ...wbase, full: true }), 'L\nADS target: local');
  assert.equal(watchResultText({ ...wbase, full: true, result: { ...none, added: ['a'] } }),
    'Added: a\nL\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
});

test('target line and the default port', () => {
  assert.equal(targetLine('local'), 'ADS target: local');
  assert.equal(targetOfKey('local:851'), 'local');
  assert.equal(targetOfKey('172.20.30.60.1.1:852'), '172.20.30.60.1.1:852');
});

test('confirmRemoveText lists the entries and cuts a long list', () => {
  assert.equal(confirmRemoveText(['MAIN.a']), 'An AI tool asks to remove 1 variable you added from the ADS Watch list:\nMAIN.a');
  assert.equal(confirmRemoveText(['a', 'b']), 'An AI tool asks to remove 2 variables you added from the ADS Watch list:\na\nb');
  const many = Array.from({ length: 13 }, (_, i) => `S${i}`);
  assert.equal(confirmRemoveText(many).split('\n').slice(-2).join('|'), 'S9|(and 3 more)');
});

test('watch result: a declined removal has its own line', () => {
  assert.equal(watchResultText({ ...wbase, result: { ...none, declined: ['U'], removed: ['A'] } }),
    'Removed: A\nNot removed (the user did not confirm): U\nWatch list: 3 symbols\nADS target: local');
});

test('watch result: group lines', () => {
  const r = { ...none, declined: [], added: ['a'], grouped: ['a'], ungrouped: ['U'], switchedOn: true };
  assert.equal(watchResultText({ ...wbase, group: 'T1', parked: 2, result: r }),
    'Added: a\nGroup T1: a\nGroup T1 switched on (it was off)\nNot grouped (added by the user): U\nWatch list: 3 symbols, 2 switched off\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
  const op = (action: 'on' | 'off' | 'removed' | 'none') => watchResultText({ ...wbase, parked: 0, result: { ...none, declined: [], grouped: [], ungrouped: [], switchedOn: false, groupOp: { name: 'T1', action, members: 3 } } });
  assert.equal(op('on'), 'Group T1 switched on (3 symbols)\nWatch list: 3 symbols\nADS target: local');
  assert.equal(op('off'), 'Group T1 switched off (3 symbols, not sampled now; their history is dropped)\nWatch list: 3 symbols\nADS target: local');
  assert.equal(op('removed'), 'Group T1 removed\nWatch list: 3 symbols\nADS target: local');
  assert.equal(op('none'), 'No group named T1\nWatch list: 3 symbols\nADS target: local');
});

test('the full list shows groups and the parked entries; without groups it is unchanged', () => {
  const entries = [{ symbol: 'MAIN.a', ai: true, groups: ['T1'] }, { symbol: 'MAIN.b', ai: true, groups: ['T2'] }];
  assert.equal(watchListText([item('MAIN.a')], entries, ['t2']),
    'MAIN.a : INT [added by AI] [group T1]\nSwitched off (not sampled): MAIN.b [group T2]\nGroups: T1 on (1), T2 off (1)');
  assert.equal(watchListText([], entries.slice(1), ['t2']),
    'The ADS watch list is empty.\nSwitched off (not sampled): MAIN.b [group T2]\nGroups: T2 off (1)');
});

test('unresolved text and its place in the watch result', () => {
  assert.equal(unresolvedText([]), undefined);
  assert.equal(unresolvedText([{ symbol: 'MAIN.a', error: 'Symbol not found' }]),
    'Not resolved on the target (kept in the list; rebuild the project or remove them):\nMAIN.a : Symbol not found');
  assert.equal(watchResultText({ ...wbase, unresolved: [{ symbol: 'MAIN.a', error: 'Symbol not found' }], addErrors: ['MAIN.x : e'], result: { ...none, added: ['MAIN.x'] } }),
    'Added: MAIN.x\nError: MAIN.x : e\nNot resolved on the target (kept in the list; rebuild the project or remove them):\nMAIN.a : Symbol not found\nWatch list: 3 symbols\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
});

test('addErrorLines names the stored spelling of added symbols with an error', () => {
  assert.deepEqual(addErrorLines([item('MAIN.a'), item('main.b', '', 'Symbol not found')], ['MAIN.B', 'MAIN.a']), ['main.b : Symbol not found']);
});

test('a watch call that partly fails keeps the partial state and is an error', () => {
  assert.deepEqual(watchFailureText('Error: boom', 'L'), { text: 'Error: boom\nWatch list now:\nL', isError: true });
});

test('symbols listing', () => {
  const base = { headers: [] as string[], offset: 0, matches: ['MAIN.a : INT'], total: 1, max: 100, typed: 'a', missing: [], unreadable: [], units: 1 };
  assert.equal(symbolsText(base), 'MAIN.a : INT');
  assert.equal(symbolsText({ ...base, matches: [], total: 0, typed: 'zz' }), 'No symbols match "zz".');
  assert.equal(symbolsText({ ...base, total: 103 }), 'MAIN.a : INT\n(3 more not listed; narrow the filter or continue with offset 100)');
  assert.equal(symbolsText({ ...base, missing: ['P1', 'P2'], unreadable: ['P3 (bad)'] }),
    'MAIN.a : INT\nNot built, so not listed (no .tmc): P1, P2\nBuild output unreadable, so not listed: P3 (bad)');
  assert.equal(symbolsText({ ...base, headers: ['H1', 'H2'] }), 'H1\nH2\nMAIN.a : INT');
  assert.equal(symbolsText({ ...base, headers: ['H1'], matches: [], total: 0, typed: 'zz' }), 'H1\nNo symbols match "zz".');
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
  assert.equal(scopeToolText('S', [], MCP_NAMES, ['MAIN.b [group T2]']),
    'Switched off, so no history (switch the group on with ads_watch: group and enable true): MAIN.b [group T2]\n\nS');
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
  const base = { symbol: 'MAIN.x', condition: { op: 'changes' } as const, intervalMs: 100, clock: (ms: number) => `T${ms}`, target: 'local' };
  const sampled = 'Sampled every 100 ms; changes between samples are not seen.';
  const tl = '\nADS target: local';
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'met', t: 5, value: '3', firstObservation: false, elapsedMs: 1234 } }),
    { text: `Condition met at T5 (after 1.23 s): MAIN.x = 3\n${sampled}${tl}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'met', t: 5, value: '3', firstObservation: true, elapsedMs: 0 } }),
    { text: `Condition met at T5 (after 0.00 s): MAIN.x = 3 (true at the first observation)\n${sampled}${tl}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'timeout', last: '2', seconds: 30 } }),
    { text: `Not met within 30 s: MAIN.x changes; last value 2\n${sampled}${tl}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'timeout', last: undefined, seconds: 30 } }),
    { text: `Not met within 30 s: MAIN.x changes; no valid value observed\n${sampled}${tl}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'timeout', last: 'eIdle', seconds: 30, seenEnum: ['eIdle', 'eRun'] } }),
    { text: `Not met within 30 s: MAIN.x changes; last value eIdle; enum names seen: eIdle, eRun (a name never seen may be misspelled)\n${sampled}${tl}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'ended', reason: 'host stopped' } }), { text: `Wait ended: host stopped${tl}` });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'refused', reason: 'nope' } }), { text: 'Error: nope', isError: true });
  assert.deepEqual(waitResultText({ ...base, outcome: { kind: 'cancelled' } }), { text: 'Wait cancelled.' });
  assert.equal(COPILOT_NAMES.wait, 'adsWait');
  assert.equal(MCP_NAMES.wait, 'ads_wait');
});

test('scope summary passes maxRows to the table', () => {
  assert.equal(scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, options: { maxRows: 2 } }),
    'ADS values of the last 60 s up to the newest sample (target local):\na: min=0 max=2 last=2 count=3 changes=2 (first at -1.0 s, last at 0.0 s)\n\n2 of 3 samples shown, 2 value changes; 1 earlier changes not shown, narrow seconds or symbols\nt[s]\ta\n-1.000\t1\n0.000\t2');
});

test('scope summary in changesOnly mode names the view in its head line', () => {
  const out = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, options: { changesOnly: true } });
  assert.ok(out.startsWith('ADS value changes of the last 60 s up to the newest sample (target local):\n'), out);
  assert.ok(out.endsWith('t[s]\ta\n-2.000\t0\n-1.000\t1\n0.000\t2'), out);
});

test('scope summary keeps the whole answer inside the tool text limit', () => {
  const symbols = Array.from({ length: 200 }, (_, i) => `GVL.aVeryLongSymbolNameForTheBudgetTest${String(i).padStart(3, '0')}`);
  const b = filled(symbols, 300);
  for (const options of [{}, { changesOnly: true }]) {
    const out = scopeSummaryText({ buffer: b, symbols, seconds: 3600, target: 'local', intervalMs: 100, now: 400_000, clock, options });
    assert.ok(out.length <= MAX_TOOL_TEXT - 1000, `length ${out.length}`);
    assert.ok(out.includes('first 20 of 200 symbols'));
  }
});

const STALE_TAIL = 'sampling only runs while the ADS Watch view or the ADS Scope is open.';

test('scope with a stale newest sample names the host state', () => {
  const out = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 70_000, clock, state: { connected: false, error: 'Port 851 not found.' } });
  assert.ok(out.startsWith(`No samples since 10:00:00: ${STALE_TAIL} Last host message: Port 851 not found.\nADS values of the last 60 s`), out);
});

test('scope with a stale newest sample names why the host ended', () => {
  const out = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 70_000, clock, state: { connected: false }, ended: { reason: 'The ADS host stopped (idle).', at: 3000 } });
  assert.ok(out.startsWith(`No samples since 10:00:00: ${STALE_TAIL} The ADS host ended at 10:00:00: The ADS host stopped (idle).\n`), out);
});

test('scope with fresh samples ignores the host state', () => {
  const fresh = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, state: { connected: false, error: 'x' } });
  assert.ok(fresh.startsWith('ADS values of the last 60 s'), fresh);
});

test('scope without any sample names the host message', () => {
  const b = new ScopeBuffer(300);
  b.setItems(1, [item('a')]);
  assert.equal(scopeSummaryText({ buffer: b, symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 1000, clock, state: { connected: false, error: 'boom' } }),
    'No samples yet for a. The values are sampled every 100 ms while the ADS host runs. Last host message: boom');
});

test('scope summary in edges mode has its own head and closing line', () => {
  const b = new ScopeBuffer(300);
  b.setItems(1, [{ symbol: 'GVL.bBusy', type: 'BOOL', numeric: true, error: null }]);
  b.push(1, [{ t: 0, v: ['FALSE'] }, { t: 1000, v: ['TRUE'] }]);
  assert.equal(scopeSummaryText({ buffer: b, symbols: ['GVL.bBusy'], seconds: 1, target: 'local', intervalMs: 100, now: 1500, clock, options: { edges: true } }), [
    'ADS edges of the last 1 s up to the newest sample (target local):',
    'GVL.bBusy: edges=1 (1 rising, 0 falling), now TRUE', '',
    't[s]\tsymbol\tedge', '0.000\tGVL.bBusy\trising',
    'Sampled every 100 ms; edges shorter than one sample are not seen.'].join('\n'));
});

test('enumText lists members, notes shared values and unknown values', () => {
  const info = { name: 'E_Mode', base: 'INT', members: [{ name: 'Off', value: '0' }, { name: 'Run', value: '1', comment: 'Normal operation' }, { name: 'Start', value: '1' }] };
  assert.equal(enumText({ info, from: 'the build output of PLC1' }),
    'Enum E_Mode (INT), from the build output of PLC1:\n  Off = 0\n  Run = 1  // Normal operation\n  Start = 1\nNote: Run and Start share the value 1; a read shows Run, so compare by number.');
  // an alias write is not known to work: the note says so unless the CLI is known to support it
  assert.match(enumText({ info, from: 'x', aliasWrite: 'unknown' }), /compare by number\. Writing a later name by its name may need a newer iecode CLI: write the number\.$/);
  assert.doesNotMatch(enumText({ info, from: 'x', aliasWrite: 'supported' }), /newer iecode CLI/);
  const three = { name: 'E', members: [{ name: 'A', value: '1' }, { name: 'B', value: '1' }, { name: 'C', value: '1' }] };
  assert.match(enumText({ info: three, from: 'x' }), /\nNote: A, B and C share the value 1; a read shows A, so compare by number\.$/);
  assert.match(enumText({ info: { name: 'E', members: [{ name: 'A' }] }, from: 'x' }), /^Enum E, from x:\n {2}A = \(unknown value\)\nNote: a value marked unknown/);
  assert.equal(noEnumText('E_X'), 'No enum type "E_X" found in the build output or the source code of the workspace PLC projects.');
});

test('hiddenText lists hidden variables and counts the rest', () => {
  const head = "Hidden (marked {attribute 'hide'}, so no ADS symbol and not readable; a property with {attribute 'monitoring' := 'call'} may expose the value):";
  assert.equal(hiddenText(['MAIN.fbDrive.bBusy : BOOL'], 1), `${head}\nMAIN.fbDrive.bBusy : BOOL`);
  assert.equal(hiddenText(['MAIN.fbDrive.bBusy : BOOL'], 3), `${head}\nMAIN.fbDrive.bBusy : BOOL\n(2 more hidden variables not listed)`);
});

test('symbols listing: a page past the end says so instead of "no symbols match"', () => {
  const base = { headers: [] as string[], matches: [] as string[], total: 357, max: 100, offset: 400, typed: 'a', missing: [], unreadable: [], units: 1 };
  assert.equal(symbolsText(base), 'No rows at offset 400: 357 symbols match.');
  assert.equal(symbolsText({ ...base, matches: ['MAIN.a : INT'], offset: 100 }), 'MAIN.a : INT\n(rows 101-200 of 357; 157 more, continue with offset 200)');
});

test('propertyHintText and its place in a read row and a watch result', () => {
  assert.equal(propertyHintText(['MAIN.fbDrive.Busy']), 'Matching property in the source code: MAIN.fbDrive.Busy (monitoring call); try that name.');
  assert.equal(propertyHintText(['A', 'B']), 'Matching properties in the source code: A, B (monitoring call); try one of those names.');
  const row = { symbol: 'MAIN.fbDrive.bBusy', type: '', value: null, error: "Symbol 'MAIN.fbDrive.bBusy' not found on local." };
  assert.equal(readOnceRow({ ...row, hint: propertyHintText(['MAIN.fbDrive.Busy']) }),
    "MAIN.fbDrive.bBusy : error Symbol 'MAIN.fbDrive.bBusy' not found on local. Matching property in the source code: MAIN.fbDrive.Busy (monitoring call); try that name.");
  assert.equal(readOnceRow(row), "MAIN.fbDrive.bBusy : error Symbol 'MAIN.fbDrive.bBusy' not found on local.");
});

test('watch result: a property hint is its own line after the error', () => {
  const none = { added: [], already: [], removed: [], missing: [], kept: [], declined: [], held: [] };
  const hint = 'Hint for MAIN.x.bBusy: Matching property in the source code: MAIN.x.Busy (monitoring call); try that name.';
  const text = watchResultText({
    target: 'local', parked: 0, unresolved: [], full: false, list: '', count: 1, intervalMs: 100, names: MCP_NAMES,
    result: { ...none, added: ['MAIN.x.bBusy'] }, addErrors: ['MAIN.x.bBusy : not found'], hints: [hint],
  });
  assert.match(text, /\nError: MAIN\.x\.bBusy : not found\nHint for MAIN\.x\.bBusy: Matching property in the source code: MAIN\.x\.Busy \(monitoring call\); try that name\.\n/);
});

test('configText: shown, applied, unchanged, declined and cancelled', () => {
  const e = (symbols: number, values: number, effectiveSeconds: number, capped: boolean) => ({ symbols, values, bytes: values * 72, effectiveSeconds, capped });
  assert.equal(configText({ target: 'local', outcome: { kind: 'shown', sampling: { intervalMs: 100, bufferSeconds: 300 }, estimate: e(20, 60000, 300, false) } }).text,
    'ADS sampling on local: poll every 100 ms, buffer 300 s.\nBuffer: 20 watched symbols, up to 60000 values (about 4.1 MB), holds the full 300 s.\nChange it with pollMs (10-5000) and bufferSeconds (10-3600); the change lasts until the user edits the setting or the window reloads.');
  assert.equal(configText({ target: 'local', outcome: { kind: 'shown', sampling: { intervalMs: 10, bufferSeconds: 600 }, estimate: e(200, 2_000_000, 100, true) } }).text.split('\n')[1],
    'Buffer: 200 watched symbols, up to 2000000 values (about 137.3 MB), holds only 100 s of the 600 s: the buffer stores at most 2000000 values in total.');
  assert.equal(configText({ target: 'local', outcome: { kind: 'applied', before: { intervalMs: 100, bufferSeconds: 300 }, after: { intervalMs: 20, bufferSeconds: 600 }, estimate: e(20, 600000, 600, false), notes: ['n1'] } }).text,
    'Poll interval 100 -> 20 ms, buffer 300 -> 600 s (this session only; the settings are unchanged).\nBuffer: 20 watched symbols, up to 600000 values (about 41.2 MB), holds the full 600 s.\nn1');
  assert.equal(configText({ target: 'local', outcome: { kind: 'applied', before: { intervalMs: 100, bufferSeconds: 300 }, after: { intervalMs: 100, bufferSeconds: 600 }, estimate: e(20, 120000, 600, false), notes: [] } }).text.split('\n')[0],
    'Buffer 300 -> 600 s (this session only; the settings are unchanged).');
  assert.equal(configText({ target: 'local', outcome: { kind: 'unchanged', sampling: { intervalMs: 100, bufferSeconds: 300 } } }).text, 'Nothing to change: poll every 100 ms, buffer 300 s already.');
  assert.equal(configText({ target: 'local', outcome: { kind: 'declined', wanted: { intervalMs: 10, bufferSeconds: 600 }, estimate: e(200, 2_000_000, 100, true) } }).text,
    'Not changed: the change was not confirmed (it would hold up to 2000000 values, about 137.3 MB).');
  assert.equal(configText({ target: 'local', outcome: { kind: 'cancelled' } }).text, 'Config change cancelled.');
  assert.equal(configText({ target: 'local', outcome: { kind: 'cancelled' } }).isError, undefined);
});

test('captureResultText: captured, partial, history short, timeout, ended, refused, cancelled', () => {
  const clock = (ms: number) => `T${ms}`;
  const base = { symbol: 'MAIN.nStep', condition: (() => { const p = parseCondition('= 40'); if (!p.ok) throw new Error(p.error); return p.value; })(), target: 'local', intervalMs: 100, clock, names: COPILOT_NAMES };
  const met = { kind: 'met' as const, t: 3000, value: '40', firstObservation: false, elapsedMs: 3420 };
  const window = { fromMs: 1000, toMs: 4000, originMs: 3000, table: 'TABLE' };
  assert.equal(captureResultText({ ...base, outcome: { kind: 'captured', met, window } }).text,
    'Captured at T3000 (after 3.42 s): MAIN.nStep = 40\nWindow -2 s .. +1 s around the trigger on local; the table shows value changes only, time 0 = the trigger.\nTABLE\nSampled every 100 ms; changes between samples are not seen.\nADS target: local');
  const partial = captureResultText({ ...base, outcome: { kind: 'captured', met: { ...met, firstObservation: true }, window: { ...window, toMs: 3300, historyFromMs: 2500 }, partial: 'The ADS host stopped.' } }).text.split('\n');
  assert.equal(partial[0], 'Captured at T3000 (after 3.42 s): MAIN.nStep = 40 (true at the first observation)');
  assert.equal(partial[2], 'Capture ended early: The ADS host stopped.; the table covers -2 s .. +0.3 s.');
  assert.equal(partial[3], 'History starts at T2500, later than the requested -2 s; the symbols were watched for a shorter time.');
  assert.equal(captureResultText({ ...base, outcome: { kind: 'timeout', last: '3', seconds: 30, window: { ...window, fromMs: -2000, toMs: 3000 } } }).text.split('\n')[0],
    'Not met within 30 s: MAIN.nStep = 40; last value 3. Showing the last 5 s (changes only, time 0 = now):');
  assert.equal(captureResultText({ ...base, outcome: { kind: 'ended', reason: 'The ADS target changed', window: { ...window, fromMs: -2000, toMs: 3000 } } }).text.split('\n')[0],
    'Wait ended: The ADS target changed. Showing the last 5 s that were sampled:');
  const refused = captureResultText({ ...base, outcome: { kind: 'refused', reason: 'raise it with {config} { bufferSeconds: 3 }' } });
  assert.equal(refused.text, 'Error: raise it with adsConfig { bufferSeconds: 3 }');
  assert.equal(refused.isError, true);
  assert.deepEqual(captureResultText({ ...base, outcome: { kind: 'cancelled' } }), { text: 'Capture cancelled.' });
});
