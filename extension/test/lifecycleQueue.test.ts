import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleQueue, Timers } from '../src/core/lifecycleQueue';

class FakeTimers implements Timers {
  active = new Map<number, () => void>();
  private next = 1;
  setInterval(fn: () => void) { const id = this.next++; this.active.set(id, fn); return id; }
  clearInterval(h: unknown) { this.active.delete(h as number); }
}

const tick = () => new Promise<void>(r => setImmediate(r));

test('a start that is still listening when stop runs publishes nothing', async () => {
  const q = new LifecycleQueue(new FakeTimers());
  const published: string[] = [];
  const closed: string[] = [];
  let finishListen!: () => void;
  const listening = new Promise<void>(r => { finishListen = r; });
  const gen = q.current(); // taken when start() is called, before it is queued
  const start = q.enqueue(async () => {
    await listening; // sweep, listen
    if (gen.stale()) { closed.push('pipe'); return; }
    published.push('instance file');
  });
  q.invalidate(); // stop() while the start is still listening
  const stop = q.enqueue(async () => { closed.push('stop ran'); });
  finishListen();
  await Promise.all([start, stop]);
  assert.deepEqual(published, []);
  assert.deepEqual(closed, ['pipe', 'stop ran']); // the late start closed what it opened, then stop ran
});

test('steps run one after the other and a failing step does not block the next', async () => {
  const q = new LifecycleQueue(new FakeTimers());
  const order: string[] = [];
  const a = q.enqueue(async () => { await tick(); order.push('a'); throw new Error('boom'); });
  const b = q.enqueue(async () => { order.push('b'); return 7; });
  await assert.rejects(a, /boom/);
  assert.equal(await b, 7);
  assert.deepEqual(order, ['a', 'b']);
});

test('a heartbeat of an old generation writes nothing', async () => {
  const timers = new FakeTimers();
  const q = new LifecycleQueue(timers);
  let beats = 0;
  q.every(60_000, () => { beats++; });
  const [oldTick] = [...timers.active.values()];
  oldTick();
  await tick();
  assert.equal(beats, 1);
  q.invalidate();
  oldTick(); // a timer callback that was already queued in the event loop
  await tick();
  assert.equal(beats, 1);
});

test('a tick that was queued before stop does nothing when its turn comes', async () => {
  const timers = new FakeTimers();
  const q = new LifecycleQueue(timers);
  let beats = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const busy = q.enqueue(() => gate);
  q.every(10, () => { beats++; });
  [...timers.active.values()][0](); // queued behind the busy step
  q.invalidate();
  release();
  await busy;
  await tick();
  assert.equal(beats, 0);
});

test('stop clears the timers', () => {
  const timers = new FakeTimers();
  const q = new LifecycleQueue(timers);
  q.every(1000, () => undefined);
  q.every(5000, () => undefined);
  assert.equal(timers.active.size, 2);
  q.invalidate();
  assert.equal(timers.active.size, 0);
});

test('a timer started after stop belongs to the new generation', async () => {
  const timers = new FakeTimers();
  const q = new LifecycleQueue(timers);
  q.invalidate();
  let beats = 0;
  q.every(10, () => { beats++; });
  [...timers.active.values()][0]();
  await tick();
  assert.equal(beats, 1);
});
