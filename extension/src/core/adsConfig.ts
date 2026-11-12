// Poll interval and buffer length through a tool: the estimate of what the buffer needs, the plan of a change (with
// a confirmation when it makes the buffer large) and the run of that plan. Pure: the dialog, the timer and the host
// come in through ConfigDeps.

import { SCOPE_MAX_VALUES, clampBufferSeconds, clampInterval } from './adswatch';

export interface Sampling { intervalMs: number; bufferSeconds: number }

export interface BufferEstimate { symbols: number; values: number; bytes: number; effectiveSeconds: number; capped: boolean }

/**
 * Upper bound of the heap one stored value takes. Measured 2026-11-12 with 20 symbols and 1 000 000 values: 71 bytes per
 * numeric value (change log included) and 54 per text value, both with the test's own row array counted, rounded up
 * to a multiple of 8.
 */
export const BYTES_PER_VALUE = 72;

/** A change that raises the estimate above this many bytes asks the user first (user decision 2026-11-12: 128 MB). */
export const CONFIG_CONFIRM_BYTES = 128 * 1024 * 1024;

/** What the buffer holds: per symbol `min(window, cap / symbols)` values; the cap is the buffer's total (ScopeBuffer.trim). */
export function bufferEstimate(s: Sampling, symbols: number, maxValues = SCOPE_MAX_VALUES): BufferEstimate {
  const perSymbol = Math.min(Math.ceil((s.bufferSeconds * 1000) / s.intervalMs), Math.floor(maxValues / Math.max(1, symbols)));
  const values = symbols * perSymbol;
  const effectiveSeconds = Math.min(s.bufferSeconds, (perSymbol * s.intervalMs) / 1000);
  return { symbols, values, bytes: values * BYTES_PER_VALUE, effectiveSeconds, capped: effectiveSeconds < s.bufferSeconds };
}

export interface ConfigRequest { pollMs?: number; bufferSeconds?: number }

export type ConfigPlan =
  | { kind: 'show' }
  | { kind: 'unchanged' }
  | { kind: 'apply'; next: Sampling; notes: string[] }
  | { kind: 'confirm'; next: Sampling; notes: string[] };

const WINDOWS_TIMER_NOTE = 'Windows timers tick about every 15.6 ms, so below about 16 ms the real rate is lower.';

export function planConfig(current: Sampling, req: ConfigRequest, symbols: number): ConfigPlan {
  if (req.pollMs === undefined && req.bufferSeconds === undefined) return { kind: 'show' };
  const notes: string[] = [];
  let intervalMs = current.intervalMs;
  let bufferSeconds = current.bufferSeconds;
  if (req.pollMs !== undefined) {
    intervalMs = clampInterval(req.pollMs);
    if (intervalMs > req.pollMs) notes.push(`pollMs ${req.pollMs} was raised to ${intervalMs} (allowed 10-5000).`);
    else if (intervalMs < req.pollMs) notes.push(`pollMs ${req.pollMs} was lowered to ${intervalMs} (allowed 10-5000).`);
  }
  if (req.bufferSeconds !== undefined) {
    bufferSeconds = clampBufferSeconds(req.bufferSeconds);
    if (bufferSeconds > req.bufferSeconds) notes.push(`bufferSeconds ${req.bufferSeconds} was raised to ${bufferSeconds} (allowed 10-3600).`);
    else if (bufferSeconds < req.bufferSeconds) notes.push(`bufferSeconds ${req.bufferSeconds} was lowered to ${bufferSeconds} (allowed 10-3600).`);
  }
  const next = { intervalMs, bufferSeconds };
  if (intervalMs === current.intervalMs && bufferSeconds === current.bufferSeconds) return { kind: 'unchanged' };
  if (intervalMs < 16) notes.push(WINDOWS_TIMER_NOTE);
  const after = bufferEstimate(next, symbols).bytes;
  const before = bufferEstimate(current, symbols).bytes;
  return after > CONFIG_CONFIRM_BYTES && after > before ? { kind: 'confirm', next, notes } : { kind: 'apply', next, notes };
}

export interface ConfigDeps {
  current(): Sampling;
  symbols(): number;
  /** The modal dialog; true when the user chose to apply. */
  confirm(text: string): Promise<boolean>;
  /** Changes the host first and the buffer after; throws when the host refuses (nothing is changed then). */
  apply(next: Sampling): Promise<void>;
  setTimer(ms: number, fn: () => void): { dispose(): void };
}

export type ConfigOutcome =
  | { kind: 'shown'; sampling: Sampling; estimate: BufferEstimate }
  | { kind: 'unchanged'; sampling: Sampling }
  | { kind: 'applied'; before: Sampling; after: Sampling; estimate: BufferEstimate; notes: string[] }
  | { kind: 'declined'; wanted: Sampling; estimate: BufferEstimate }
  | { kind: 'changed' }
  | { kind: 'cancelled' };

export const CONFIG_CONFIRM_MS = 60_000;

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

/** The question of the dialog; says what the buffer would hold. */
export function confirmQuestion(next: Sampling, symbols: number): string {
  const e = bufferEstimate(next, symbols);
  return `Raise the ADS sample buffer to ${next.bufferSeconds} s with a poll every ${next.intervalMs} ms? It would hold up to ${e.values} values (about ${mb(e.bytes)} MB at ${BYTES_PER_VALUE} bytes each) for ${symbols} watched symbols.`;
}

const same = (a: Sampling, b: Sampling) => a.intervalMs === b.intervalMs && a.bufferSeconds === b.bufferSeconds;

/**
 * Plans, asks when needed and applies. Calls are serialised by the caller (ConfigRunner). The dialog races the signal
 * and a timer; a click after either has won is ignored. If the sampling or the watch list changed while the dialog was
 * open, nothing is applied: the user confirmed another situation.
 */
export async function runConfig(deps: ConfigDeps, req: ConfigRequest, signal: AbortSignal): Promise<ConfigOutcome> {
  if (signal.aborted) return { kind: 'cancelled' };
  const before = deps.current();
  const symbols = deps.symbols();
  const plan = planConfig(before, req, symbols);
  if (plan.kind === 'show') return { kind: 'shown', sampling: before, estimate: bufferEstimate(before, symbols) };
  if (plan.kind === 'unchanged') return { kind: 'unchanged', sampling: before };
  if (plan.kind === 'confirm') {
    const answer = await ask(deps, confirmQuestion(plan.next, symbols), signal);
    if (answer === 'cancelled') return { kind: 'cancelled' };
    if (answer !== 'yes') return { kind: 'declined', wanted: plan.next, estimate: bufferEstimate(plan.next, symbols) };
    if (!same(deps.current(), before) || deps.symbols() !== symbols) return { kind: 'changed' };
  }
  await deps.apply(plan.next);
  return { kind: 'applied', before, after: plan.next, estimate: bufferEstimate(plan.next, symbols), notes: plan.notes };
}

type Answer = 'yes' | 'no' | 'timeout' | 'cancelled';

function ask(deps: ConfigDeps, text: string, signal: AbortSignal): Promise<Answer> {
  return new Promise<Answer>(resolve => {
    let done = false;
    const finish = (a: Answer) => {
      if (done) return;
      done = true;
      timer.dispose();
      signal.removeEventListener('abort', onAbort);
      resolve(a);
    };
    const onAbort = () => finish('cancelled');
    const timer = deps.setTimer(CONFIG_CONFIRM_MS, () => finish('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    deps.confirm(text).then(ok => finish(ok ? 'yes' : 'no'), () => finish('no'));
  });
}

/** One config change at a time: two calls in parallel would plan against the same state and both apply. */
export class ConfigRunner {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ConfigDeps) {}

  run(req: ConfigRequest, signal: AbortSignal): Promise<ConfigOutcome> {
    const next = this.tail.then(() => runConfig(this.deps, req, signal), () => runConfig(this.deps, req, signal));
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Which override a changed setting drops: only the one of that key, so the setting wins again for it. */
export function overridesAfterSettingChange(overrides: Partial<Sampling>, changed: { sampleIntervalMs: boolean; bufferSeconds: boolean }): Partial<Sampling> {
  const out = { ...overrides };
  if (changed.sampleIntervalMs) delete out.intervalMs;
  if (changed.bufferSeconds) delete out.bufferSeconds;
  return out;
}
