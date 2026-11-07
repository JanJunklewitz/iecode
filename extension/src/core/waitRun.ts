// One ads_wait call: holds the symbol on the watch list, checks every sampled row stamped at or after the call start
// against the condition, and ends on met, deadline, cancel, host end or user removal. No vscode imports.

import type { Row, WatchItem } from './adswatch';
import { WaitCondition, ValueClass, applicable, classify, isValid, meets } from './waitCondition';

export interface SampleBatch { gen: number; items: WatchItem[]; rows: Row[] }

export interface WaitDeps {
  hold(symbol: string): Promise<{ release(): Promise<void> }>;
  /** Resolves once the host runs (awaited, not fire-and-forget). */
  ready(): Promise<void>;
  onSamples(l: (b: SampleBatch) => void): { dispose(): void };
  /** Host stop, restart, target change. */
  onEnded(l: (reason: string) => void): { dispose(): void };
  onUserRemoved(l: (symbols: string[]) => void): { dispose(): void };
  /** performance.now() */
  monotonicMs(): number;
  /** Date.now(), the host's row clock */
  wallMs(): number;
  setTimer(ms: number, fn: () => void): { dispose(): void };
}

export type WaitOutcome =
  | { kind: 'met'; t: number; value: string; firstObservation: boolean; elapsedMs: number }
  | { kind: 'timeout'; last: string | undefined; seconds: number }
  | { kind: 'ended'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'cancelled' };

export const USER_REMOVED = 'removed from the watch list by the user';

const key = (s: string): string => s.trim().toLowerCase();
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

export function runWait(
  deps: WaitDeps,
  req: { symbol: string; condition: WaitCondition; timeoutSeconds: number },
  signal: AbortSignal,
): Promise<WaitOutcome> {
  // The deadline includes the host start: both clocks are read before anything else.
  const t0 = deps.wallMs();
  const startMono = deps.monotonicMs();
  const deadline = startMono + req.timeoutSeconds * 1000;
  const want = key(req.symbol);

  return new Promise<WaitOutcome>(resolve => {
    let done = false;
    let release: (() => Promise<void>) | undefined;
    let checked = false;             // applicable() ran on the first classified row
    let checkedType = '';            // item.type of that row; a later change (download) ends the wait
    let baseline: string | undefined; // first valid value: the `changes` baseline
    let last: string | undefined;     // last valid value, for the timeout

    const subs: { dispose(): void }[] = [];
    const onAbort = (): void => finish({ kind: 'cancelled' });

    function finish(outcome: WaitOutcome): void {
      if (done) return;
      done = true;
      for (const s of subs) s.dispose();
      signal.removeEventListener('abort', onAbort);
      if (release) void release().catch(() => undefined);
      resolve(outcome);
    }

    function onBatch(b: SampleBatch): void {
      if (done) return;
      try { checkBatch(b); } catch (e) { finish({ kind: 'refused', reason: message(e) }); }
    }

    function checkBatch(b: SampleBatch): void {
      const col = b.items.findIndex(i => key(i.symbol) === want);
      if (col < 0) return;
      const item = b.items[col];
      if (item.error) return finish({ kind: 'refused', reason: item.error });
      if (checked && item.type !== checkedType) {
        return finish({ kind: 'ended', reason: `the type of ${req.symbol.trim()} changed from ${checkedType} to ${item.type}` });
      }
      for (const row of b.rows) {
        if (row.t < t0) continue;
        const text = row.v[col] ?? null;
        if (text === null) continue;
        const enumValue = row.e?.[col];
        const cls: ValueClass = classify(item, text, enumValue);
        if (!checked) {
          checked = true;
          checkedType = item.type;
          const why = applicable(req.condition, cls);
          if (why) return finish({ kind: 'refused', reason: why });
        }
        // isValid before meets: a null/NaN/Inf value neither meets nor counts as a change
        if (!isValid(cls, text)) continue;
        const first = baseline === undefined;
        if (meets(req.condition, cls, text, enumValue, baseline)) {
          return finish({ kind: 'met', t: row.t, value: text, firstObservation: first, elapsedMs: deps.monotonicMs() - startMono });
        }
        if (first) baseline = text;
        last = text;
      }
    }

    if (signal.aborted) return finish({ kind: 'cancelled' });
    // a dependency that throws synchronously ends the wait like one that rejects, never leaving subscriptions behind
    const refuse = (e: unknown): void => finish({ kind: 'refused', reason: message(e) });
    try {
      signal.addEventListener('abort', onAbort);
      // Subscribed before the hold, so no batch between the add and the subscription is lost.
      subs.push(deps.onSamples(onBatch));
      subs.push(deps.onEnded(reason => finish({ kind: 'ended', reason })));
      subs.push(deps.onUserRemoved(symbols => { if (symbols.some(s => key(s) === want)) finish({ kind: 'ended', reason: USER_REMOVED }); }));
      subs.push(deps.setTimer(Math.max(0, deadline - deps.monotonicMs()), () => finish({ kind: 'timeout', last, seconds: req.timeoutSeconds })));

      deps.hold(req.symbol).then(
        h => {
          release = () => h.release();
          // finished while the hold was pending: release it now
          if (done) { void h.release().catch(() => undefined); return; }
          try {
            return deps.ready().then(undefined, refuse);
          } catch (e) {
            refuse(e);
          }
        },
        refuse,
      );
    } catch (e) {
      refuse(e);
    }
  });
}
