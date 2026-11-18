import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoticeReader, SamplingEvent, SamplingLog, VIEW_NOTICE_MS, gapWarning, gapsIn, noticeText, scopeGapWarning, viewNotice } from '../src/core/samplingLog';
import { COPILOT_NAMES, MCP_NAMES } from '../src/core/adsToolText';

const clock = (ms: number) => `T${ms}`;
const names = MCP_NAMES;
const reloaded = (t: number): SamplingEvent => ({ kind: 'reloaded', t, reason: 'r' });

test('a lost and restored connection is one line with both times', () => {
  assert.equal(noticeText([{ kind: 'lost', t: 3, error: 'ADS error 0x745' }, { kind: 'restored', t: 9 }], false, clock, names),
    'Notice: the connection to the PLC was lost at T3 and restored at T9; values in between are missing.');
});
test('a connection that is still lost names the error', () => {
  assert.equal(noticeText([{ kind: 'lost', t: 3, error: 'ADS error 0x745' }], false, clock, names),
    'Notice: the connection to the PLC was lost at T3 (ADS error 0x745); sampling resumes when it is back.');
});
test('a pair split across two calls is shown in two parts', () => {
  assert.equal(noticeText([{ kind: 'restored', t: 9 }], false, clock, names), 'Notice: the connection to the PLC was restored at T9.');
});
test('a reload names its reason', () => {
  assert.equal(noticeText([{ kind: 'reloaded', t: 9, reason: 'symbol version changed' }], false, clock, names),
    'Notice: the symbols were reloaded at T9 (symbol version changed: download, online change or PLC restart); values may have been reset.');
});
test('a stop followed by a start is one line about the gap', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'The ADS host stopped (idle).' }, { kind: 'started', t: 900 }], false, clock, names),
    'Notice: sampling was stopped from T10 to T900 (The ADS host stopped (idle).); values in between are missing.');
});
test('a stop without a restart says how to start again', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'The ADS host stopped (idle).' }], false, clock, names),
    'Notice: sampling stopped at T10 (The ADS host stopped (idle).); ads_watch or ads_wait starts it again.');
});
test('a start without a stop in the same call is its own line', () => {
  assert.equal(noticeText([{ kind: 'started', t: 900 }], false, clock, names), 'Notice: sampling started again at T900.');
});
test('Copilot names in the texts', () => {
  assert.equal(noticeText([{ kind: 'stopped', t: 10, reason: 'idle' }], false, clock, COPILOT_NAMES),
    'Notice: sampling stopped at T10 (idle); adsWatch or adsWait starts it again.');
});
test('no events give no notice', () => { assert.equal(noticeText([], false, clock, names), undefined); });
test('more than three notices keep the newest three', () => {
  const lines = noticeText([1, 2, 3, 4, 5].map(reloaded), false, clock, names)!.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '(2 earlier notices not shown)');
  assert.match(lines[1], /reloaded at T3 /);
  assert.match(lines[3], /reloaded at T5 /);
});
test('one earlier notice not shown is singular', () => {
  assert.equal(noticeText([1, 2, 3, 4].map(reloaded), false, clock, names)!.split('\n')[0], '(1 earlier notice not shown)');
});
test('dropped events are said first', () => {
  const lines = noticeText([reloaded(5)], true, clock, names)!.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '(earlier notices dropped)');
  assert.match(lines[1], /reloaded at T5 /);
});
test('an initial disconnect is not a loss', () => {
  const log = new SamplingLog(); log.state(false, 'no route', 1); assert.equal(log.head(), 0);
  log.state(true, undefined, 2); log.state(false, 'ADS error 0x745', 3);
  assert.deepEqual(log.since(0).events, [{ kind: 'lost', t: 3, error: 'ADS error 0x745' }]);
});
test('a repeated disconnect is one loss and the return is one restore', () => {
  const log = new SamplingLog(); log.state(true, undefined, 1);
  log.state(false, 'a', 2); log.state(false, 'b', 3); log.state(true, undefined, 4); log.state(true, undefined, 5);
  assert.deepEqual(log.since(0).events.map(e => e.kind), ['lost', 'restored']);
});
test('a stop is not a loss and a new host\'s first connect is not a restore', () => {
  const log = new SamplingLog(); log.record({ kind: 'started', t: 0 }); log.state(true, undefined, 1);
  log.record({ kind: 'stopped', t: 2, reason: 'The ADS host stopped (idle).' });   // host.ts calls setState(false) here too, but that never reaches the log
  log.record({ kind: 'started', t: 3 }); log.state(true, undefined, 4);
  assert.deepEqual(log.since(0).events, [{ kind: 'stopped', t: 2, reason: 'The ADS host stopped (idle).' }, { kind: 'started', t: 3 }]);
});
test('the first start of the session is no notice', () => {
  const log = new SamplingLog(); log.record({ kind: 'started', t: 1 }); assert.equal(log.head(), 0);
});
test('since() returns only newer events and the cap drops the oldest', () => {
  const log = new SamplingLog(2);
  log.record(reloaded(1)); log.record(reloaded(2));
  assert.equal(log.since(0).dropped, false);
  assert.deepEqual(log.since(1).events, [reloaded(2)]);
  log.record(reloaded(3));
  assert.equal(log.head(), 3);
  const all = log.since(0);
  assert.deepEqual(all.events, [reloaded(2), reloaded(3)]);
  assert.equal(all.dropped, true);
  assert.equal(log.since(1).dropped, false);
});
test('clear() drops the events but ids keep counting', () => {
  const log = new SamplingLog();
  log.record(reloaded(1)); log.record(reloaded(2));
  const head = log.head();
  log.clear();
  assert.equal(log.head(), head);
  assert.deepEqual(log.since(head), { events: [], dropped: false });
  assert.equal(log.since(0).dropped, false);
  log.record(reloaded(3));
  assert.equal(log.head(), head + 1);
  assert.deepEqual(log.since(head).events, [reloaded(3)]);
});
test('clear() forgets a pending stop and the connection baseline', () => {
  const log = new SamplingLog(); log.record({ kind: 'started', t: 0 }); log.state(true, undefined, 1);
  log.record({ kind: 'stopped', t: 2, reason: 'x' }); log.clear();
  const head = log.head();
  log.record({ kind: 'started', t: 3 }); assert.equal(log.head(), head);
  log.state(false, 'e', 4); assert.equal(log.head(), head);
});
test('recent() returns events not older than maxAgeMs', () => {
  const log = new SamplingLog();
  log.record(reloaded(100)); log.record(reloaded(900));
  assert.deepEqual(log.recent(1000, 150), [reloaded(900)]);
  assert.deepEqual(log.recent(1000, 900), [reloaded(100), reloaded(900)]);
  assert.deepEqual(log.recent(1000, 50), []);
});
test('NoticeReader shows each event once, also to overlapping calls', () => {
  const log = new SamplingLog(); log.state(true, undefined, 1);
  const r = new NoticeReader(log, clock, names);
  assert.equal(r.take(), undefined);                       // nothing since the reader was made
  log.state(false, 'ADS error 0x745', 3);
  const a = r.take(), b = r.take();                         // two calls finishing back to back
  assert.match(a!, /lost at T3/); assert.equal(b, undefined);
});
test('a new NoticeReader starts at the head', () => {
  const log = new SamplingLog(); log.record(reloaded(1)); log.record(reloaded(2));
  const r = new NoticeReader(log, clock, names);
  assert.equal(r.take(), undefined);
  log.record(reloaded(3));
  assert.match(r.take()!, /reloaded at T3 /);
});
test('a NoticeReader that fell behind the cap says so', () => {
  const log = new SamplingLog(2);
  const r = new NoticeReader(log, clock, names);
  log.record(reloaded(1)); log.record(reloaded(2)); log.record(reloaded(3));
  assert.equal(r.take()!.split('\n')[0], '(earlier notices dropped)');
});
test('gapsIn finds the pairs inside the window and closes an open one at the end', () => {
  const ev: SamplingEvent[] = [{ kind: 'lost', t: 10, error: 'x' }, { kind: 'restored', t: 20 }, { kind: 'stopped', t: 50, reason: 'idle' }];
  assert.deepEqual(gapsIn(ev, 0, 100), [{ from: 10, to: 20, why: 'lost' }, { from: 50, to: 100, why: 'stopped' }]);
  assert.deepEqual(gapsIn(ev, 25, 40), []);
  assert.deepEqual(gapsIn(ev, 15, 100), [{ from: 15, to: 20, why: 'lost' }, { from: 50, to: 100, why: 'stopped' }]);
});
test('gapsIn pairs a stop with the next start', () => {
  const ev: SamplingEvent[] = [{ kind: 'stopped', t: 10, reason: 'idle' }, { kind: 'started', t: 30 }];
  assert.deepEqual(gapsIn(ev, 0, 100), [{ from: 10, to: 30, why: 'stopped' }]);
});
test('gapWarning names the holes', () => {
  assert.equal(gapWarning([{ from: 10, to: 20, why: 'lost' }], clock),
    'Warning: no samples from T10 to T20 (connection lost); the values do not show what happened in between.');
  assert.equal(gapWarning([], clock), undefined);
});
test('gapWarning names a stop and several holes', () => {
  assert.equal(gapWarning([{ from: 10, to: 20, why: 'lost' }, { from: 50, to: 100, why: 'stopped' }], clock),
    'Warning: no samples from T10 to T20 (connection lost), from T50 to T100 (sampling stopped); the values do not show what happened in between.');
});
test('gapsIn closes a lost gap at the stop and does not let it swallow a later loss', () => {
  const ev: SamplingEvent[] = [{ kind: 'lost', t: 10, error: 'x' }, { kind: 'stopped', t: 20, reason: 'idle' }, { kind: 'started', t: 30 },
    { kind: 'lost', t: 50, error: 'y' }, { kind: 'restored', t: 60 }];
  assert.deepEqual(gapsIn(ev, 0, 100), [{ from: 10, to: 20, why: 'lost' }, { from: 20, to: 30, why: 'stopped' }, { from: 50, to: 60, why: 'lost' }]);
  assert.deepEqual(gapsIn(ev.slice(0, 3), 0, 100), [{ from: 10, to: 20, why: 'lost' }, { from: 20, to: 30, why: 'stopped' }]);
});
test('gapsIn makes no zero-length gap at the window edge but keeps an open gap running to the end', () => {
  assert.deepEqual(gapsIn([{ kind: 'lost', t: 0, error: 'x' }, { kind: 'restored', t: 10 }], 10, 100), []);
  assert.deepEqual(gapsIn([{ kind: 'stopped', t: 100, reason: 'idle' }], 0, 100), []);
  assert.deepEqual(gapsIn([{ kind: 'lost', t: 0, error: 'x' }], 10, 100), [{ from: 10, to: 100, why: 'lost' }]);
});
test('a lost and restored pair and a stopped and started pair each count as one notice toward the cap', () => {
  const ev: SamplingEvent[] = [{ kind: 'lost', t: 1, error: 'x' }, { kind: 'restored', t: 2 }, { kind: 'stopped', t: 3, reason: 'r' }, { kind: 'started', t: 4 },
    reloaded(5), reloaded(6)];
  const lines = noticeText(ev, false, clock, names)!.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '(1 earlier notice not shown)');
  assert.match(lines[1], /stopped from T3 to T4/);
  const three = noticeText(ev.slice(0, 5), false, clock, names)!.split('\n');
  assert.equal(three.length, 3);
  assert.match(three[0], /lost at T1 and restored at T2/);
});
test('lost, reloaded, restored coalesces the pair and keeps the reload as its own line after it', () => {
  const lines = noticeText([{ kind: 'lost', t: 1, error: 'x' }, reloaded(2), { kind: 'restored', t: 3 }], false, clock, names)!.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /lost at T1 and restored at T3/);
  assert.match(lines[1], /reloaded at T2 /);
});

test('a view shows the disconnect message first, else the notices of the last two minutes', () => {
  const log = new SamplingLog(); log.state(true, undefined, 1); log.state(false, 'ADS error 0x745', 1000);
  assert.equal(viewNotice({ connected: false, error: 'ADS error 0x745' }, log, 2000, clock, names), 'Disconnected: ADS error 0x745');
  log.state(true, undefined, 3000);
  assert.equal(viewNotice({ connected: true }, log, 4000, clock, names), 'Notice: the connection to the PLC was lost at T1000 and restored at T3000; values in between are missing.');
  assert.equal(viewNotice({ connected: true }, log, 3000 + VIEW_NOTICE_MS + 1, clock, names), undefined);
  assert.equal(viewNotice({ connected: false }, new SamplingLog(), 0, clock, names), undefined);
});

test('the scope warns about holes in the window up to its newest sample', () => {
  const ev: SamplingEvent[] = [{ kind: 'lost', t: 10_000, error: 'x' }, { kind: 'restored', t: 20_000 }, { kind: 'stopped', t: 90_000, reason: 'idle' }];
  // newest sample at 30 s, 60 s shown: the lost hole is inside, the later stop is not
  assert.equal(scopeGapWarning(ev, 60, 30_000, 500_000, clock),
    'Warning: no samples from T10000 to T20000 (connection lost); the values do not show what happened in between.');
  assert.equal(scopeGapWarning(ev, 5, 30_000, 500_000, clock), undefined);
  // no sample yet: the window ends now
  assert.match(scopeGapWarning(ev, 60, undefined, 100_000, clock)!, /from T90000 to T100000 \(sampling stopped\)/);
});

test('a stop without a start is not recorded and the next start is no notice', () => {
  // a failed start (CLI missing, exit before hello) goes through exited() without a started
  const log = new SamplingLog();
  log.record({ kind: 'stopped', t: 1, reason: 'The ADS host exited (code 1).' });
  assert.equal(log.head(), 0);
  log.record({ kind: 'started', t: 2 });
  assert.equal(log.head(), 0);
});

test('a second stop without a start in between is not recorded', () => {
  const log = new SamplingLog();
  log.record({ kind: 'started', t: 1 });
  log.record({ kind: 'stopped', t: 2, reason: 'a' });
  log.record({ kind: 'stopped', t: 3, reason: 'b' });
  assert.deepEqual(log.since(0).events, [{ kind: 'stopped', t: 2, reason: 'a' }]);
});
