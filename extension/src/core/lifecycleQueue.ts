// Serializes the start, stop, poll, heartbeat and folder steps of a server and cancels what is still running with a generation
// counter: stop() invalidates, every step of a start re-checks `stale()` after each await and writes nothing when it changed.
// Pure: the timers are injected.

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: h => clearInterval(h as NodeJS.Timeout),
};

export interface Generation {
  /** True once `invalidate()` ran after this snapshot was taken. */
  stale(): boolean;
}

export class LifecycleQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private handles: unknown[] = [];

  constructor(private readonly timers: Timers = realTimers) {}

  current(): Generation {
    const g = this.generation;
    return { stale: () => g !== this.generation };
  }

  /** stop() and dispose(): running steps see `stale()`, every timer is cleared, a step queued later takes a fresh snapshot. */
  invalidate(): void {
    this.generation++;
    for (const h of this.handles) this.timers.clearInterval(h);
    this.handles = [];
  }

  /** One step after the other; a failing step does not block the next. */
  enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.tail.then(step, step);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** A timer of the current generation: its tick does nothing after `invalidate()` and is queued behind the running step. */
  every(ms: number, tick: () => void | Promise<void>): void {
    const g = this.current();
    this.handles.push(this.timers.setInterval(() => {
      if (g.stale()) return;
      void this.enqueue(async () => { if (!g.stale()) await tick(); }).catch(() => undefined);
    }, ms));
  }
}
