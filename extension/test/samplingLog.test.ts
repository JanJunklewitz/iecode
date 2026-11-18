import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoticeReader, SamplingEvent, SamplingLog, gapWarning, gapsIn, noticeText } from '../src/core/samplingLog';
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
  const log = new SamplingLog(); log.state(true, undefined, 1);
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
  const log = new SamplingLog(); log.state(true, undefined, 1);
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
