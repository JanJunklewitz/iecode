// One ads_capture call: waits for a condition like ads_wait and returns the value changes of the captured symbols from
// `pre` seconds before to `post` seconds after the trigger. The call keeps its own change log: it copies what the scope
// buffer holds at the start and records every sample after it, so a symbol the user removes (which drops its history
// from the buffer) does not take the captured values with it. No vscode imports.

import { ChangeLog, ChangeLogStore, MAX_CHANGE_ENTRIES, changesTable } from './scopeChanges';
import { SampleBatch, USER_REMOVED, WaitDeps, WaitOutcome, runWait } from './waitRun';
import type { WaitCondition } from './waitCondition';

export interface CaptureDeps extends WaitDeps {
  /** What the scope buffer holds of a symbol since fromMs; the seed of the call's own log. */
  history(symbol: string, fromMs: number): ChangeLog;
  /** Seconds the buffer really holds (the E1 estimate), so a window longer than that is refused up front. */
  capacitySeconds(): number;
  /** A value as the table shows it (text quoted and cut, numbers formatted). */
  format(symbol: string, text: string): string;
}

export interface CaptureRequest { symbol: string; condition: WaitCondition; preSeconds: number; postSeconds: number; timeoutSeconds: number }

export interface CaptureWindow { fromMs: number; toMs: number; originMs: number; table: string; historyFromMs?: number }

export type CaptureOutcome =
  | { kind: 'captured'; met: Extract<WaitOutcome, { kind: 'met' }>; window: CaptureWindow; partial?: string }
  | { kind: 'timeout'; last: string | undefined; seconds: number; window: CaptureWindow }
  | { kind: 'ended'; reason: string; window: CaptureWindow }
  | { kind: 'refused'; reason: string }
  | { kind: 'cancelled' };

/** Time beyond postSeconds to wait for the last rows before the capture ends partial. */
export const CAPTURE_GRACE_MS = 3000;
export const CAPTURE_DEFAULT_PRE = 5, CAPTURE_DEFAULT_POST = 5, CAPTURE_MAX_PRE = 600, CAPTURE_MAX_POST = 60;
export const CAPTURE_MAX_ROWS = 200;
const UNKNOWN_START = 'unknown (history dropped)';

/** Placeholder for the tool name of the config tool; captureResultText puts the client's name in. */
export const CONFIG_TOKEN = '{config}';

const key = (s: string): string => s.trim().toLowerCase();

/** The table of the captured symbols between from and to, times relative to origin; entries after `to` are cut. */
export function captureTable(store: ChangeLogStore, names: string[], fromMs: number, toMs: number, originMs: number, format: (symbol: string, text: string) => string): { table: string; historyFromMs?: number } {
  const logs = names.map(n => {
    const l = store.changes(n, fromMs, toMs, Number.MAX_SAFE_INTEGER);
    return { ...l, entries: l.entries.filter(e => e.t <= toMs) };
  });
  const t = changesTable(names, logs, { now: originMs, requestedStart: fromMs, maxRows: CAPTURE_MAX_ROWS, unknownText: UNKNOWN_START, cell: (i, text) => format(names[i], text) });
  const known = logs.filter(l => l.entries.length > 0 || l.start !== undefined || l.startUnknown);
  const covered = known.length ? Math.min(...known.map(l => l.coveredFromMs)) : undefined;
  const lines = [...t.notes.map(n => `(${n})`), t.header, ...t.rows];
  return { table: lines.join('\n'), ...(covered !== undefined && covered > fromMs ? { historyFromMs: covered } : {}) };
}

export function runCapture(deps: CaptureDeps, holdSymbols: string[], req: CaptureRequest, signal: AbortSignal): Promise<CaptureOutcome> {
  const need = req.preSeconds + req.postSeconds;
  if (deps.capacitySeconds() < need) {
    return Promise.resolve({
      kind: 'refused',
      reason: `the capture window needs ${need} s of history but the buffer holds ${Math.floor(deps.capacitySeconds())} s; raise it with ${CONFIG_TOKEN} { bufferSeconds: ${need} } (a large change asks the user to confirm)`,
    });
  }
  if (signal.aborted) return Promise.resolve({ kind: 'cancelled' });

  // the trigger and every captured symbol, once each
  const names: string[] = [];
  for (const s of [req.symbol, ...holdSymbols]) if (!names.some(n => key(n) === key(s))) names.push(s.trim());
  const wanted = new Set(names.map(key));

  const store = new ChangeLogStore(MAX_CHANGE_ENTRIES);
  const releases: (() => Promise<void>)[] = [];
  const subs: { dispose(): void }[] = [];
  let newest = -Infinity;
  const nameOf = new Map(names.map(n => [key(n), n]));

  const releaseAll = async (): Promise<void> => {
    for (const s of subs.splice(0)) s.dispose();
    await Promise.all(releases.splice(0).map(r => r().catch(() => undefined)));
  };

  const record = (b: SampleBatch): void => {
    const cols = b.items.map((i, c) => ({ c, name: nameOf.get(key(i.symbol)) })).filter(x => x.name !== undefined) as { c: number; name: string }[];
    for (const r of b.rows) {
      newest = Math.max(newest, r.t);
      for (const { c, name } of cols) store.add(name, r.t, r.v[c] ?? null);
    }
    store.trim(newest, Number.MAX_SAFE_INTEGER, names.length);
  };

  const windowAt = (originMs: number, toMs: number): CaptureWindow => {
    const fromMs = originMs - req.preSeconds * 1000;
    return { fromMs, toMs, originMs, ...captureTable(store, names, fromMs, toMs, originMs, deps.format) };
  };

  return (async (): Promise<CaptureOutcome> => {
    try {
      // the log starts with what the buffer already holds, then records every sample of the call
      subs.push(deps.onSamples(record));
      const wallStart = deps.wallMs();
      for (const n of names) {
        const h = await deps.hold(n);
        releases.push(() => h.release());
        if (signal.aborted) return { kind: 'cancelled' };
      }
      for (const n of names) {
        const l = deps.history(n, wallStart - req.preSeconds * 1000);
        if (l.start) store.add(n, l.start.t, l.start.text);
        for (const e of l.entries) if (!l.start || e.t > l.start.t) store.add(n, e.t, e.text);
      }
      newest = Math.max(newest, ...names.map(n => deps.history(n, wallStart).lastValidT ?? -Infinity));

      const waited = await runWait(deps, { symbol: req.symbol, condition: req.condition, timeoutSeconds: req.timeoutSeconds }, signal);
      switch (waited.kind) {
        case 'refused': return { kind: 'refused', reason: waited.reason };
        case 'cancelled': return { kind: 'cancelled' };
        case 'timeout': {
          const end = newest > -Infinity ? newest : deps.wallMs();
          return { kind: 'timeout', last: waited.last, seconds: waited.seconds, window: windowAt(end, end) };
        }
        case 'ended': {
          const end = newest > -Infinity ? newest : deps.wallMs();
          return { kind: 'ended', reason: waited.reason, window: windowAt(end, end) };
        }
        case 'met': return await postPhase(waited);
      }
    } catch (e) {
      return { kind: 'refused', reason: e instanceof Error ? e.message : String(e) };
    } finally {
      // the table is built (or the call is over) before any hold goes
      await releaseAll();
    }
  })();

  /** After the trigger: wait for the rows up to t + post; end early (partial) when the data cannot arrive any more. */
  function postPhase(met: Extract<WaitOutcome, { kind: 'met' }>): Promise<CaptureOutcome> {
    const target = met.t + req.postSeconds * 1000;
    return new Promise<CaptureOutcome>(resolve => {
      let done = false;
      const inner: { dispose(): void }[] = [];
      const finish = (partial?: string): void => {
        if (done) return;
        done = true;
        for (const s of inner) s.dispose();
        signal.removeEventListener('abort', onAbort);
        const toMs = partial === undefined ? target : Math.max(met.t, Math.min(target, newest));
        resolve({ kind: 'captured', met, window: windowAt(met.t, toMs), ...(partial !== undefined ? { partial } : {}) });
      };
      const onAbort = (): void => {
        if (done) return;
        done = true;
        for (const s of inner) s.dispose();
        resolve({ kind: 'cancelled' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (newest >= target) return finish();
      inner.push(deps.onSamples(() => { if (newest >= target) finish(); }));
      inner.push(deps.onEnded(reason => finish(reason)));
      inner.push(deps.onUserRemoved(symbols => { if (symbols.some(s => wanted.has(key(s)))) finish(USER_REMOVED); }));
      inner.push(deps.setTimer(req.postSeconds * 1000 + CAPTURE_GRACE_MS, () => finish(`no new samples within ${CAPTURE_GRACE_MS / 1000} s after the post window; the connection to the PLC may have been lost`)));
    });
  }
}
