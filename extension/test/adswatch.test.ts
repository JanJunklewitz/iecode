import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_SPANS, niceTicks, spanOptions, PendingRequests, PROTOCOL, ScopeBuffer, WatchItem, downsample, thinKeepingChanges, fillEvenly, hostStartFailure, minMaxBuckets, numericValue, parseHostLine, scopeText, changeEntries, CUT_MARK, formatNumber, formatValueText, settingsError, symbolAt, MAX_WATCHED, watchLimitError, aiWriteDecision, watchEdit, watchRename, clampInterval, clampBufferSeconds, parseWatchList, workspaceOverrides, oneLine, writeStillApproved, sampleAge, gapNote, HostError, HostGone, RequestTimeout, writeStage } from '../src/core/adswatch';

const item = (symbol: string, numeric = true): WatchItem => ({ symbol, type: 'INT', numeric, error: null });
const rows = (n: number, step = 1000, t0 = 0) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * step, v: [String(i)] }));

test('sampleAge formats old samples', () => {
  assert.equal(sampleAge(1000, 2500), undefined);
  assert.equal(sampleAge(1000, 13_400), '12 s old');
  assert.equal(sampleAge(undefined, 5), undefined);
});

test('gap note when the newest sample is old', () => {
  const tail = 'sampling only runs while the ADS Watch view or the ADS Scope is open.';
  assert.equal(gapNote(0, 61_000, () => '10:00:00'), `No samples since 10:00:00: ${tail}`);
  assert.equal(gapNote(60_000, 61_000, () => '10:00:00'), undefined);
  assert.equal(gapNote(undefined, 1, () => '10:00:00'), `No samples yet: ${tail}`);
});

test('parseHostLine reads each message kind', () => {
  assert.equal(PROTOCOL, 1);
  assert.deepEqual(parseHostLine('{"event":"hello","protocol":1}'), { event: 'hello', protocol: 1 });
  assert.deepEqual(parseHostLine('{"event":"state","connected":false,"error":"x"}'), { event: 'state', connected: false, error: 'x' });
  assert.deepEqual(parseHostLine('{"event":"samples","gen":2,"rows":[{"t":5,"v":["1"]}]}'), { event: 'samples', gen: 2, rows: [{ t: 5, v: ['1'] }] });
  assert.deepEqual(parseHostLine('{"event":"items","gen":2,"items":[]}'), { event: 'items', gen: 2, items: [] });
  assert.deepEqual(parseHostLine('{"id":3,"ok":true,"data":{}}'), { id: 3, ok: true, data: {} });
  assert.equal(parseHostLine('Building…'), undefined);
  assert.equal(parseHostLine('42'), undefined);
  assert.equal(parseHostLine(''), undefined);
  // JSON objects that are neither an event nor a reply
  assert.equal(parseHostLine('{"foo":1}'), undefined);
  assert.equal(parseHostLine('{"id":1}'), undefined);
  assert.equal(parseHostLine('{"event":5}'), undefined);
  assert.equal(parseHostLine('{"ok":true}'), undefined);
  assert.deepEqual(parseHostLine('{"id":null,"ok":false,"error":"bad json"}'), { id: null, ok: false, error: 'bad json' });
});

test('hostStartFailure', () => {
  assert.equal(hostStartFailure(false, 2, 500), 'too old');
  assert.equal(hostStartFailure(false, null, 10001), 'too old');
  assert.equal(hostStartFailure(true, null, 60000), undefined);
  assert.equal(hostStartFailure(false, null, 500), undefined);
  assert.notEqual(hostStartFailure(true, 2, 500), 'too old');
});

test('numericValue', () => {
  assert.equal(numericValue('TRUE'), 1);
  assert.equal(numericValue('FALSE'), 0);
  assert.equal(numericValue('Running', 1), 1);
  assert.equal(numericValue('NaN'), undefined);
  assert.equal(numericValue('Infinity'), undefined);
  assert.equal(numericValue('1.5'), 1.5);
  assert.equal(numericValue('00:00:01.5000000'), 1500);
  assert.equal(numericValue('-00:00:01'), -1000);
  assert.equal(numericValue('1.02:00:00'), 93600000);
  assert.equal(numericValue('abc'), undefined);
  assert.equal(numericValue(null), undefined);
});

test('latest keeps the raw text', () => {
  const b = new ScopeBuffer(60);
  b.setItems(1, [item('A', false), item('B'), item('C', false)]);
  b.push(1, [{ t: 1, v: ['18446744073709551615', 'TRUE', '00:00:01.5000000'] }]);
  assert.equal(b.latest('A')?.value, '18446744073709551615');
  assert.equal(b.latest('B')?.value, 'TRUE');
  assert.equal(b.latest('C')?.value, '00:00:01.5000000');
  assert.deepEqual(b.series('B', 0), [{ t: 1, y: 1 }]);
  assert.deepEqual(b.series('A', 0), []);
});

test('ScopeBuffer drops old and stale rows, keeps history across setItems', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [item('MAIN.a')]);
  b.push(1, rows(30));
  assert.equal(b.series('MAIN.a', 0).length, 11);
  b.push(0, [{ t: 99000, v: ['7'] }]);
  assert.equal(b.series('MAIN.a', 0).at(-1)?.t, 29000);
  b.setItems(2, [item('MAIN.a'), item('MAIN.b')]);
  assert.equal(b.series('MAIN.a', 0).length, 11);
  b.push(1, [{ t: 31000, v: ['1', '1'] }]);
  assert.equal(b.series('MAIN.b', 0).length, 0);
  b.push(2, [{ t: 31000, v: ['5', '6'] }]);
  assert.deepEqual(b.series('MAIN.b', 0), [{ t: 31000, y: 6 }]);
  assert.equal(b.latest('MAIN.a')?.value, '5');
});

test('setItems drops removed symbols', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [item('X')]);
  b.push(1, rows(2));
  b.setItems(2, [item('Y')]);
  assert.equal(b.latest('X'), undefined);
  assert.deepEqual(b.series('X', 0), []);
});

test('maxValues caps rows and span reports the held time', () => {
  const b = new ScopeBuffer(1000, 1000);
  b.setItems(1, Array.from({ length: 10 }, (_, i) => item('S' + i)));
  b.push(1, Array.from({ length: 300 }, (_, i) => ({ t: i * 1000, v: Array.from({ length: 10 }, () => String(i)) })));
  assert.equal(b.series('S0', 0).length, 100);
  assert.equal(b.span(), 99);
});

test('setSeconds shortens now and longer keeps the rest', () => {
  const b = new ScopeBuffer(120);
  b.setItems(1, [item('A')]);
  b.push(1, rows(61));
  assert.equal(b.series('A', 0).length, 61);
  b.setSeconds(10);
  assert.equal(b.series('A', 0).length, 11);
  b.setSeconds(120);
  assert.equal(b.series('A', 0).length, 11);
  assert.equal(b.span(), 10);
});

test('enum rows plot the number and keep the text', () => {
  const b = new ScopeBuffer(60);
  b.setItems(1, [item('E', false)]);
  b.push(1, [{ t: 1, v: ['Running'], e: [1] }]);
  assert.deepEqual(b.series('E', 0), [{ t: 1, y: 1 }]);
  assert.equal(b.latest('E')?.value, 'Running');
});

test('summary', () => {
  const b = new ScopeBuffer(100);
  b.setItems(1, [item('A')]);
  b.push(1, rows(11));
  assert.deepEqual(b.summary('A', 3, 10000), { min: 7, max: 10, last: '10', count: 4 });
  assert.equal(b.summary('nope', 3, 10000), undefined);
});

test('downsample keeps first and last', () => {
  const r = Array.from({ length: 1000 }, (_, i) => i);
  const d = downsample(r, 200);
  assert.equal(d.length, 200);
  assert.equal(d[0], 0);
  assert.equal(d.at(-1), 999);
  assert.deepEqual(downsample([1, 2, 3], 200), [1, 2, 3]);
});

test('minMaxBuckets keeps a spike', () => {
  const pts = Array.from({ length: 30000 }, (_, i) => ({ t: i, y: i === 12345 ? 1000 : 1 }));
  const m = minMaxBuckets(pts, 600);
  assert.ok(m.length <= 1200);
  assert.ok(m.some(p => p.y === 1000));
  for (let i = 1; i < m.length; i++) assert.ok(m[i].t >= m[i - 1].t);
});

test('scopeText summarises and limits rows', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.fTemp'), item('GVL.nCount')]);
  b.push(1, Array.from({ length: 10000 }, (_, i) => ({ t: i * 10, v: [String(i), '5'] })));
  const text = scopeText(b, ['MAIN.fTemp', 'GVL.nCount'], 100000, 99990);
  assert.match(text, /MAIN\.fTemp.*min=0.*max=9999.*last=9999/);
  assert.match(text, /GVL\.nCount.*min=5.*max=5/);
  const dataRows = text.split('\n').filter(l => /^-?\d+(\.\d+)?\t/.test(l));
  assert.ok(dataRows.length <= 200 && dataRows.length > 100);
});

test('thinKeepingChanges keeps both sides of every transition', () => {
  const r = Array.from({ length: 1000 }, (_, i) => (i < 300 ? 0 : i < 301 ? 1 : i < 900 ? 2 : 3));
  const out = thinKeepingChanges(r, 200, (a, b) => a !== b);
  assert.equal(out.changes, 3);
  assert.equal(out.droppedChanges, 0);
  assert.deepEqual([...new Set(out.rows)], [0, 1, 2, 3]);
  assert.equal(out.rows.length, 7);
  assert.deepEqual(thinKeepingChanges([1, 2, 3], 200, (a, b) => a !== b).rows, [1, 2, 3]);
});

test('thinKeepingChanges shows the newest rows when changes exceed the limit', () => {
  const r = Array.from({ length: 1000 }, (_, i) => i);
  const out = thinKeepingChanges(r, 200, (a, b) => a !== b);
  assert.equal(out.rows.length, 200);
  assert.equal(out.rows.at(-1), 999);
  assert.equal(out.changes, 999);
  assert.ok(out.droppedChanges > 700);
});

test('scopeText never drops a value change of a step counter and says it thinned', () => {
  const steps = [0, 7, 109, 150, 210, 300, 410, 500];
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.nStep')]);
  b.push(1, Array.from({ length: 1990 }, (_, i) => ({ t: i * 10, v: [String(steps[Math.min(steps.length - 1, Math.floor(i / 240))])] })));
  const text = scopeText(b, ['MAIN.nStep'], 100000, 19890);
  const values = text.split('\n').filter(l => /^-?\d+(\.\d+)?\t/.test(l)).map(l => l.split('\t')[1]);
  assert.deepEqual([...new Set(values)], steps.map(String));
  assert.match(text, /\d+ of 1990 samples shown, 7 value changes kept/);
});

test('fillEvenly tops a kept set up to the limit with evenly spaced rows', () => {
  const all = Array.from({ length: 1000 }, (_, i) => i);
  const out = fillEvenly(all, [0, 500, 999], 100);
  assert.equal(out.length, 100);
  assert.deepEqual(out.slice(), out.slice().sort((a, b) => a - b));
  assert.ok(out.includes(500));
  assert.deepEqual(fillEvenly(all, [0, 999], 2), [0, 999]);
});

test('scopeText thins a fast-changing column evenly and still keeps every step', () => {
  const steps = [0, 7, 109, 150];
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.fTemp'), item('MAIN.nStep')]);
  b.push(1, Array.from({ length: 2000 }, (_, i) => ({ t: i * 10, v: [String(i), String(steps[Math.floor(i / 500)])] })));
  const text = scopeText(b, ['MAIN.fTemp', 'MAIN.nStep'], 100000, 19990);
  const data = text.split('\n').filter(l => /^-?\d+(\.\d+)?\t/.test(l)).map(l => l.split('\t'));
  assert.equal(data.length, 200);
  assert.deepEqual([...new Set(data.map(d => d[2]))], steps.map(String));
  assert.equal(data[0][1], '0');
  assert.equal(data.at(-1)![1], '1999');
  assert.ok(data.filter(d => Number(d[1]) > 500 && Number(d[1]) < 1500).length > 50);
  assert.match(text, /200 of 2000 samples shown, 3 value changes kept; evenly thinned \(fast-changing\): MAIN\.fTemp/);
});

test('scopeText with only fast-changing columns spans the whole window', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.fTemp')]);
  b.push(1, Array.from({ length: 10000 }, (_, i) => ({ t: i * 10, v: [String(i)] })));
  const text = scopeText(b, ['MAIN.fTemp'], 100000, 99990);
  const data = text.split('\n').filter(l => /^-?\d+(\.\d+)?\t/.test(l)).map(l => l.split('\t'));
  assert.equal(data.length, 200);
  assert.equal(data[0][1], '0');
  assert.equal(data.at(-1)![1], '9999');
  assert.match(text, /200 of 10000 samples shown; evenly thinned \(fast-changing\): MAIN\.fTemp/);
});

test('scopeText has no thinning header when every row is shown', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('A')]);
  b.push(1, rows(11));
  assert.doesNotMatch(scopeText(b, ['A'], 100000, 10000), /samples shown/);
});

test('PendingRequests', async () => {
  const p = new PendingRequests();
  const a = p.add(1, 1000);
  p.settle({ id: 99, ok: true });
  p.settle({ id: null, ok: true });
  p.settle({ id: 1, ok: true, data: 'x' });
  assert.equal(await a, 'x');
  const f = p.add(2, 1000);
  p.settle({ id: 2, ok: false, error: 'bad' });
  await assert.rejects(f, /bad/);
  const c = p.add(3, 1000);
  const d = p.add(4, 1000);
  p.rejectAll('host exited');
  await assert.rejects(c, /host exited/);
  await assert.rejects(d, /host exited/);
  await assert.rejects(p.add(5, 20), /unknown/);
});

test('PendingRequests rejects an open request whose id is added again', async () => {
  const p = new PendingRequests();
  const old = p.add(1, 1000);
  const fresh = p.add(1, 1000);
  await assert.rejects(old, /replaced/);
  p.settle({ id: 1, ok: true, data: 'new' });
  assert.equal(await fresh, 'new');
});

test('settingsError accepts local and AMS NetIds, rejects the rest', () => {
  assert.equal(settingsError({ target: 'local', port: 851 }), undefined);
  assert.equal(settingsError({ target: 'Local', port: 851 }), undefined);
  assert.equal(settingsError({ target: '192.168.1.10.1.1', port: 852 }), undefined);
  assert.match(settingsError({ target: '1.2.3', port: 851 }) ?? '', /iecode\.ads\.target/);
  assert.match(settingsError({ target: '192.168.1.300.1.1', port: 851 }) ?? '', /iecode\.ads\.target/);
  assert.match(settingsError({ target: 'plc01', port: 851 }) ?? '', /iecode\.ads\.target/);
  assert.match(settingsError({ target: 'local', port: 0 }) ?? '', /iecode\.ads\.port/);
  assert.match(settingsError({ target: 'local', port: 65536 }) ?? '', /iecode\.ads\.port/);
  assert.match(settingsError({ target: 'local', port: 851.5 }) ?? '', /iecode\.ads\.port/);
});

test('symbolAt qualifies variables declared in PROGRAM and GVL objects', () => {
  const main = 'PROGRAM MAIN\nVAR\n  bStart : BOOL;\n  fbMotor, fbPump : FB_Motor;\n  bIn AT %I* : BOOL;\nEND_VAR\n\nnCount := 1;\n';
  assert.deepEqual(symbolAt(main, 'bStart', '/p/MAIN.TcPOU'), { name: 'MAIN.bStart', qualified: true });
  assert.deepEqual(symbolAt(main, 'fbMotor.bEnable', '/p/MAIN.TcPOU'), { name: 'MAIN.fbMotor.bEnable', qualified: true });
  assert.deepEqual(symbolAt(main, 'bIn', '/p/MAIN.TcPOU'), { name: 'MAIN.bIn', qualified: true });
  assert.deepEqual(symbolAt(main, 'MAIN.bStart', '/p/MAIN.TcPOU'), { name: 'MAIN.bStart', qualified: true });
  // assigned, not declared here (e.g. an unqualified GVL variable)
  assert.deepEqual(symbolAt(main, 'nCount', '/p/MAIN.TcPOU'), { name: 'nCount', qualified: false });
  assert.deepEqual(symbolAt(main, 'GVL.nCount', '/p/MAIN.TcPOU'), { name: 'GVL.nCount', qualified: false });
  const gvl = 'VAR_GLOBAL\n  nCount : INT;\nEND_VAR\n';
  assert.deepEqual(symbolAt(gvl, 'nCount', 'C:\\p\\GVL.TcGVL'), { name: 'GVL.nCount', qualified: true });
  const fb = 'FUNCTION_BLOCK FB_Motor\nVAR\n  bEnable : BOOL;\nEND_VAR\n';
  assert.deepEqual(symbolAt(fb, 'bEnable', '/p/FB_Motor.TcPOU'), { name: 'bEnable', qualified: false });
  assert.deepEqual(symbolAt(main, '', '/p/MAIN.TcPOU'), { name: '', qualified: false });
  // a selection is matched literally, never as a regular expression
  assert.deepEqual(symbolAt(main, 'a(b', '/p/MAIN.TcPOU'), { name: 'a(b', qualified: false });
  // unescaped, [1] would be a character class matching the declaration of arr1
  const arr = 'PROGRAM MAIN\nVAR\n  arr1 : INT;\nEND_VAR\n';
  assert.deepEqual(symbolAt(arr, 'arr[1]', '/p/MAIN.TcPOU'), { name: 'arr[1]', qualified: false });
});

test('watchLimitError allows at most 200 symbols', () => {
  assert.equal(MAX_WATCHED, 200);
  assert.equal(watchLimitError(0), undefined);
  assert.equal(watchLimitError(200), undefined);
  assert.match(watchLimitError(201) ?? '', /At most 200 .*201/);
});

test('spanOptions offers a span only once the one before it is covered', () => {
  assert.deepEqual(spanOptions(0), [10]);
  assert.deepEqual(spanOptions(10), [10]);
  assert.deepEqual(spanOptions(15), [10, 30]);
  assert.deepEqual(spanOptions(100), [10, 30, 60, 300]);
  assert.deepEqual(SCOPE_SPANS, [10, 30, 60, 300]);
});

test('niceTicks uses 1/2/5 steps inside the range', () => {
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceTicks(0.1, 0.9, 4), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual(niceTicks(-3, 3, 3), [-2, 0, 2]);
  assert.deepEqual(niceTicks(5, 5, 4), [5]);
});

test('aiWriteDecision refuses anything but confirm and auto', () => {
  assert.equal(aiWriteDecision('off'), 'refuse');
  assert.equal(aiWriteDecision('confirm'), 'confirm');
  assert.equal(aiWriteDecision('auto'), 'allow');
  assert.equal(aiWriteDecision('bogus'), 'refuse');
  assert.equal(aiWriteDecision(''), 'refuse');
});

test('aiWriteDecision asks instead of auto-approving while the workspace redirects the target', () => {
  assert.equal(aiWriteDecision('auto', true), 'confirm');
  assert.equal(aiWriteDecision('auto', false), 'allow');
  assert.equal(aiWriteDecision('confirm', true), 'confirm');
  assert.equal(aiWriteDecision('off', true), 'refuse');
});

test('writeStillApproved refuses when the decision got stricter after the prepare step', () => {
  assert.equal(writeStillApproved('allow', 'allow'), true);
  assert.equal(writeStillApproved('confirm', 'confirm'), true);
  assert.equal(writeStillApproved('confirm', 'allow'), true);
  assert.equal(writeStillApproved('allow', 'confirm'), false);
  assert.equal(writeStillApproved(undefined, 'confirm'), false);
  assert.equal(writeStillApproved(undefined, 'allow'), true);
  assert.equal(writeStillApproved('confirm', 'refuse'), false);
  assert.equal(writeStillApproved('refuse', 'refuse'), false);
  assert.equal(writeStillApproved('refuse', 'confirm'), false);
  assert.equal(writeStillApproved('refuse', 'allow'), true);
});

test('workspaceOverrides flags workspace values that differ from the user or default value', () => {
  assert.equal(workspaceOverrides(undefined), false);
  assert.equal(workspaceOverrides({ defaultValue: 'local' }), false);
  assert.equal(workspaceOverrides({ defaultValue: 'local', globalValue: '5.1.2.3.1.1' }), false);
  assert.equal(workspaceOverrides({ defaultValue: 'local', workspaceValue: '5.1.2.3.1.1' }), true);
  assert.equal(workspaceOverrides({ defaultValue: 'local', workspaceFolderValue: '5.1.2.3.1.1' }), true);
  assert.equal(workspaceOverrides({ defaultValue: 'local', workspaceValue: 'local' }), false);
  assert.equal(workspaceOverrides({ defaultValue: 851, globalValue: 852, workspaceValue: 852 }), false);
  assert.equal(workspaceOverrides({ defaultValue: 851, globalValue: 852, workspaceFolderValue: 851 }), true);
});

test('oneLine keeps AI text on one log line', () => {
  assert.equal(oneLine('a\r\nb\nc'), 'a\\r\\nb\\nc');
  assert.equal(oneLine('MAIN.x'), 'MAIN.x');
});

test('watchEdit by the user adds without duplicates and removes case-insensitively', () => {
  const a = { symbol: 'a', ai: false };
  assert.deepEqual(watchEdit([a], ['a', 'b'], ['A']), [{ symbol: 'b', ai: false }]);
  assert.deepEqual(watchEdit([a], [' B ', 'b', '', 'C']), [a, { symbol: 'B', ai: false }, { symbol: 'C', ai: false }]);
  assert.deepEqual(watchEdit([{ symbol: 'x', ai: true }], [], ['X']), []);
  assert.deepEqual(watchEdit([a]), [a]);
  // the user re-adding what the AI added makes it the user's, so the AI cannot remove it any more
  assert.deepEqual(watchEdit([{ symbol: 'MAIN.x', ai: true }, a], ['main.X']), [{ symbol: 'MAIN.x', ai: false }, a]);
});

test('watchEdit by the AI marks its entries and removes only those (O10)', () => {
  const user = { symbol: 'MAIN.a', ai: false };
  const mine = watchEdit([user], ['MAIN.b', 'main.A'], [], true);
  assert.deepEqual(mine, [user, { symbol: 'MAIN.b', ai: true }]);
  assert.deepEqual(watchEdit(mine, [], ['main.a'], true), mine);
  assert.deepEqual(watchEdit(mine, [], ['main.B'], true), [user]);
});

test('parseWatchList reads old string lists and entry lists', () => {
  assert.deepEqual(parseWatchList(['MAIN.a', 'GVL.b']), [{ symbol: 'MAIN.a', ai: false }, { symbol: 'GVL.b', ai: false }]);
  assert.deepEqual(parseWatchList([{ symbol: 'MAIN.a', ai: true }, { symbol: 'GVL.b' }, 'x']), [{ symbol: 'MAIN.a', ai: true }, { symbol: 'GVL.b', ai: false }, { symbol: 'x', ai: false }]);
  assert.deepEqual(parseWatchList(undefined), []);
  assert.deepEqual(parseWatchList({}), []);
  assert.deepEqual(parseWatchList([42, null, { ai: true }]), []);
});

test('watchRename keeps the position, hands the entry to the user and merges with an existing name', () => {
  const l = [{ symbol: 'MAIN.a', ai: true }, { symbol: 'MAIN.b', ai: false }, { symbol: 'MAIN.c', ai: false }];
  assert.deepEqual(watchRename(l, 'main.a', 'GVL.x'), [{ symbol: 'GVL.x', ai: false }, l[1], l[2]]);
  assert.deepEqual(watchRename(l, 'MAIN.a', 'main.C'), [l[1], l[2]]);
  assert.equal(watchRename(l, 'MAIN.a', '  '), l);
  assert.equal(watchRename(l, 'nope', 'GVL.x'), l);
});

test('the scope sampling fields are clamped to the bounds of the settings', () => {
  assert.deepEqual([5, 9999, 100.4, NaN].map(clampInterval), [10, 5000, 100, 100]);
  assert.deepEqual([1, 99999, 300, NaN].map(clampBufferSeconds), [10, 3600, 300, 300]);
});

test('ScopeBuffer.clear drops samples but keeps items', () => {
  const b = new ScopeBuffer(300);
  b.setItems(1, [item('a')]);
  b.push(1, rows(3));
  b.clear();
  assert.equal(b.latest('a'), undefined);
  assert.equal(b.series('a', 0).length, 0);
  b.push(1, rows(2, 1000, 100_000));
  assert.equal(b.latest('a')?.value, '1');
  assert.equal(b.series('a', 0).length, 2);
});

test('PendingRequests tells a timeout from a host exit', async () => {
  const p = new PendingRequests();
  await assert.rejects(p.add(1, 10), RequestTimeout);
  const open = p.add(2, 1000);
  p.rejectAll('The ADS host exited (code 1).');
  await assert.rejects(open, HostGone);
});

test('rejectAll after a settings restart is a host exit', async () => {
  const p = new PendingRequests();
  const open = p.add(1, 1000);
  p.rejectAll('The ADS host restarted (settings changed).');
  await assert.rejects(open, (e: Error) => e instanceof HostGone && /restarted/.test(e.message));
});

test('a watch reply installs its items before the next line of the same chunk', () => {
  const pending = new PendingRequests();
  const buffer = new ScopeBuffer(60);
  void pending.add(7, 1000, d => { const r = d as { gen: number; items: WatchItem[] }; buffer.setItems(r.gen, r.items); });
  // reply and first samples arrive in one stdout chunk and are dispatched in one synchronous loop
  pending.settle({ id: 7, ok: true, data: { gen: 3, items: [{ symbol: 'P', type: 'BOOL', numeric: false, error: null }] } });
  buffer.push(3, [{ t: 1000, v: ['TRUE'] }]);
  assert.equal(buffer.latest('P')?.value, 'TRUE');
});

test('host error keeps the written field', async () => {
  assert.deepEqual(parseHostLine('{"id":1,"ok":false,"error":"x","written":"no"}'), { id: 1, ok: false, error: 'x', written: 'no' });
  const p = new PendingRequests();
  const open = p.add(1, 1000);
  p.settle({ id: 1, ok: false, error: 'x', written: 'no' });
  await assert.rejects(open, (e: Error) => e instanceof HostError && e.written === 'no' && e.message === 'x');
});

test('write outcome after a failed read-back', () => {
  assert.deepEqual(writeStage({ data: { symbol: 'a', value: null, readBackError: 'x' } }), { kind: 'written', value: null, readBackError: 'x' });
  assert.deepEqual(writeStage({ data: { symbol: 'a', value: '5' } }), { kind: 'written', value: '5' });
});

test('write outcome of an old CLI error is unknown', () => {
  assert.deepEqual(writeStage({ error: new HostError('Write a: timeout') }), { kind: 'unknown', reason: 'Write a: timeout' });
});

test('write outcome not sent only with proof', () => {
  assert.deepEqual(writeStage({ error: new HostError('Symbol not found', 'no') }), { kind: 'notSent', reason: 'Symbol not found' });
  assert.equal(writeStage({ error: new HostError('x', 'maybe') }).kind, 'unknown');
  assert.equal(writeStage({ error: new RequestTimeout('t') }).kind, 'unknown');
  assert.equal(writeStage({ error: new HostGone('g') }).kind, 'unknown');
  assert.equal(writeStage({ error: new Error('plain') }).kind, 'unknown');
  assert.equal(writeStage({ error: 'not an error' }).kind, 'unknown');
});

const real = (symbol: string): WatchItem => ({ symbol, type: 'REAL', numeric: true, error: null });

test('scopeText honours maxRows and says it thinned', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.fTemp')]);
  b.push(1, Array.from({ length: 1000 }, (_, i) => ({ t: i * 10, v: [String(i)] })));
  const text = scopeText(b, ['MAIN.fTemp'], 100000, 9990, { maxRows: 20 });
  const data = text.split('\n').filter(l => /^-?\d+(\.\d+)?\t/.test(l));
  assert.equal(data.length, 20);
  assert.match(text, /20 of 1000 samples shown; evenly thinned \(fast-changing\): MAIN\.fTemp/);
});

test('scopeText rounds numbers to decimals but never pads integers', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [real('MAIN.f')]);
  b.push(1, [{ t: 0, v: ['1.23456'] }, { t: 1000, v: ['2.5'] }, { t: 2000, v: ['3'] }]);
  const text = scopeText(b, ['MAIN.f'], 100000, 2000, { decimals: 2 });
  assert.match(text, /^MAIN\.f: min=1\.23 max=3 last=3 count=3$/m);
  assert.deepEqual(text.split('\n').filter(l => /^-?\d/.test(l)), ['-2.000\t1.23', '-1.000\t2.50', '0.000\t3']);
  assert.equal(formatValueText('2.56789', 1), '2.6');
  assert.equal(formatValueText('Running', 1), 'Running');
  assert.equal(formatValueText(null, 1), null);
  assert.equal(formatNumber(2.5), '2.5');
});

test('scopeText decimals handles tiny and negative-zero values', () => {
  assert.equal(formatNumber(1e-7, 3), '0.000');
  assert.equal(formatNumber(-0.001, 2), '0.00');
  assert.equal(formatValueText('1e-7', 2), '0.00');
});

const textItem = (symbol: string): WatchItem => ({ symbol, type: 'STRING(80)', numeric: false, error: null });
const at = (values: (string | null)[], step = 1000) => values.map((v, i) => ({ t: i * step, v: [v] }));

test('change log keeps the first sample and every change, nothing else', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(['0', '0', '1', '1', '2']));
  const log = b.changes('S', 0);
  assert.deepEqual(log.entries, [{ t: 0, text: '0', first: true }, { t: 2000, text: '1' }, { t: 4000, text: '2' }]);
  assert.equal(log.start, undefined);
  assert.equal(log.startUnknown, false);
  assert.equal(log.olderDropped, false);
  assert.equal(changeEntries(log).length, 2);
});

test('a null sample is no change and does not reset the comparison', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(['1', null, '1', '2']));
  assert.deepEqual(b.changes('S', 0).entries, [{ t: 0, text: '1', first: true }, { t: 3000, text: '2' }]);
});

test('the log keeps one predecessor so the window start value is known', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => (i < 5 ? '0' : i < 25 ? '7' : '1'))));
  const log = b.changes('S', 20000);
  assert.deepEqual(log.start, { t: 5000, text: '7' });
  assert.deepEqual(log.entries, [{ t: 25000, text: '1' }]);
  assert.equal(log.startUnknown, false);
  assert.equal(log.coveredFromMs, 20000);
});

test('a change exactly at the window start is an entry, its predecessor the start', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(['0', '0', '1', '1']));
  const log = b.changes('S', 2000);
  assert.deepEqual(log.start, { t: 0, text: '0', first: true });
  assert.deepEqual(log.entries, [{ t: 2000, text: '1' }]);
});

test('the entry cap drops the oldest entries and says so', () => {
  const b = new ScopeBuffer(1000, 2_000_000, 10);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 50 }, (_, i) => String(i))));
  const log = b.changes('S', 0);
  assert.equal(log.entries.length, 10);
  assert.equal(log.entries.at(-1)!.text, '49');
  assert.equal(log.olderDropped, true);
  assert.equal(log.startUnknown, true);
  assert.equal(log.coveredFromMs, 40000);
  assert.equal(changeEntries(log).length, 10);
});

test('the entry cap is split over the watched symbols', () => {
  const b = new ScopeBuffer(1000, 2_000_000, 20);
  b.setItems(1, [item('A'), item('B')]);
  b.push(1, Array.from({ length: 50 }, (_, i) => ({ t: i * 1000, v: [String(i), 'x'] })));
  assert.equal(b.changes('A', 0).entries.length, 10);
  assert.equal(b.changes('B', 0).entries.length, 1);
});

test('long texts are stored cut but compared in full', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [textItem('S')]);
  const a = 'x'.repeat(256);
  b.push(1, at([a + 'a', a + 'a', a + 'b', 'short']));
  const e = b.changes('S', 0).entries;
  assert.equal(e.length, 3);
  assert.equal(e[0].text, a + CUT_MARK);
  assert.equal(e[1].text, a + CUT_MARK);
  assert.equal(e[2].text, 'short');
});

test('setItems drops the log of a removed symbol and clear drops all logs', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('A'), item('B')]);
  b.push(1, [{ t: 0, v: ['1', '2'] }, { t: 1000, v: ['3', '4'] }]);
  b.setItems(2, [item('A')]);
  assert.equal(b.changes('B', 0).entries.length, 0);
  assert.equal(b.changes('A', 0).entries.length, 2);
  b.clear();
  assert.equal(b.changes('A', 0).entries.length, 0);
  b.push(2, [{ t: 5000, v: ['3'] }]);
  assert.deepEqual(b.changes('A', 0).entries, [{ t: 5000, text: '3', first: true }]);
});

test('a request longer than the buffer is clamped and says what the log covers', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => String(i % 2))));
  const log = b.changes('S', -1_000_000);
  assert.equal(log.coveredFromMs, 20000);
  assert.deepEqual(log.start, { t: 19000, text: '1' });
});

test('shrinking the window trims the log and growing it again does not bring history back', () => {
  const b = new ScopeBuffer(100);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => String(i))));
  b.setSeconds(10);
  assert.equal(b.changes('S', 0).entries.length, 11);
  b.setSeconds(100);
  const log = b.changes('S', 0);
  assert.equal(log.entries.length, 12);   // the 11 in the window plus the kept predecessor
  assert.equal(log.coveredFromMs, 20000);
});

test('isText follows numeric, not the type name; typeOf follows the item', () => {
  const b = new ScopeBuffer(100);
  b.setItems(1, [textItem('S'), item('N'), { symbol: 'A', type: 'T_Alias', numeric: false, error: null }]);
  assert.equal(b.isText('S'), true);
  assert.equal(b.isText('A'), true);
  assert.equal(b.isText('N'), false);
  assert.equal(b.isText('nope'), false);
  assert.equal(b.typeOf('N'), 'INT');
  assert.equal(b.typeOf('nope'), undefined);
});
