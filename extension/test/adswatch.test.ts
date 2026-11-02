import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests, PROTOCOL, ScopeBuffer, WatchItem, downsample, hostStartFailure, minMaxBuckets, numericValue, parseHostLine, scopeText, settingsError, symbolAt } from '../src/core/adswatch';

const item = (symbol: string, numeric = true): WatchItem => ({ symbol, type: 'INT', numeric, error: null });
const rows = (n: number, step = 1000, t0 = 0) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * step, v: [String(i)] }));

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
});
