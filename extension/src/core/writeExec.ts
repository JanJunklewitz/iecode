// One write call of the gate: a single write, a batch in one request, and a pulse (write, wait, write back). Pure: the host,
// the clock and the type check come in through ExecDeps, so the rules (which host op is used, how a rejection reads, that a
// pulse is always reset) are unit-tested without VS Code.

import { WriteNotSent, WriteOp, WriteResult, itemsOf, sendOutcome } from './writeGate';
import { JournalEntry } from './writeJournal';
import { PulseOutcome, WriteItem, WriteItemResult, oppositeBool } from './writeText';

export interface ExecDeps {
  /** The scalar write (host op "write"). */
  writeOne(item: WriteItem, beforeSend: () => string | undefined): Promise<{ value: string | null; readBackError?: string }>;
  /** The batch write (host op "writeMany"): one request, one result per item. */
  writeMany(items: WriteItem[], beforeSend: () => string | undefined): Promise<{ items: WriteItemResult[] }>;
  /** Waits; the extension keeps the time of a pulse. */
  sleep(ms: number): Promise<void>;
  /** A monotonic clock in ms. */
  now(): number;
  /** The type of symbols before a pulse; never throws, a failed read is the `error` of its row. */
  readBefore(symbols: string[]): Promise<ReadRow[]>;
  /** The journal of AI writes; without it nothing is recorded and only a pulse reads before the write. */
  journal?: { record(e: Omit<JournalEntry, 'seq' | 'time'>): void; markRestored(symbols: readonly string[], targetKey: string): void };
}

export type ReadRow = { symbol: string; type: string | null; value: string | null; error?: string | null };

const key = (s: string): string => s.trim().toLowerCase();

/** The values and types just before the write; a read that fails gives a row with an error for every symbol, never a throw. */
async function readOld(items: readonly WriteItem[], deps: ExecDeps): Promise<Map<string, ReadRow>> {
  const symbols = items.map(i => i.symbol);
  let rows: ReadRow[];
  try {
    rows = await deps.readBefore(symbols);
  } catch (e) {
    rows = symbols.map(symbol => ({ symbol, type: null, value: null, error: (e as Error).message }));
  }
  return new Map(rows.map(r => [key(r.symbol), r]));
}

/** What an AI write left behind: written and unknown items (a refused op and a not-written item changed nothing). */
function record(op: WriteOp, items: readonly WriteItem[], result: WriteResult, old: Map<string, ReadRow>, deps: ExecDeps): void {
  const journal = deps.journal;
  if (!journal) return;
  const outcomes: ('written' | 'unknown' | undefined)[] =
    result.kind === 'written' ? ['written' as const]
    : result.kind === 'unknown' ? items.map(() => 'unknown' as const)
    : result.kind === 'done' ? result.items.map(r => (r.status === 'notWritten' ? undefined : r.status))
    : [];
  const written: string[] = [];
  items.forEach((item, k) => {
    const outcome = outcomes[k];
    if (!outcome) return;
    const row = old.get(key(item.symbol));
    const failed = !row || row.error || row.value === null;
    journal.record({
      targetKey: op.targetKey, symbol: item.symbol,
      oldValue: failed ? null : (row.value as string),
      ...(failed ? { oldValueError: row?.error ?? 'no answer' } : {}),
      newValue: item.value, outcome, via: op.via, kind: op.restore ? 'restore' : 'write',
      ...(item.pulseMs !== undefined ? { pulse: true } : {}),
      ...(op.persistent?.some(p => key(p) === key(item.symbol)) ? { persistent: true } : {}),
    });
    if (outcome === 'written') written.push(item.symbol);
  });
  if (op.restore && written.length) journal.markRestored(written, op.targetKey);
}

/** The request of the op without a pulse: exactly what a single write or a batch did before pulses existed. */
async function send(op: WriteOp, beforeSend: () => string | undefined, deps: ExecDeps): Promise<WriteResult> {
  const items = itemsOf(op);
  try {
    if (items.length > 1) return { kind: 'done', items: (await deps.writeMany(items, beforeSend)).items };
    const back = await deps.writeOne(items[0], beforeSend);
    if (!op.items) return { kind: 'written', readBack: back.value, readBackError: back.readBackError };
    const item: WriteItemResult = { symbol: items[0].symbol, status: 'written', readBack: back.value };
    if (back.readBackError !== undefined) item.readBackError = back.readBackError;
    return { kind: 'done', items: [item] };
  } catch (e) {
    return sendOutcome(e);
  }
}

/**
 * A single op returns exactly what it did before the batch existed. An op with one item still goes through the scalar
 * write (so an older host serves it) and is wrapped as a result list of one; only two or more items need the batch op.
 * A rejection maps through `sendOutcome`: a proven "not sent" refuses, everything else is an unknown outcome.
 * A pulse item is checked to be a BOOL first (nothing is sent otherwise), and its reset is always attempted afterwards.
 */
export async function executeWrite(op: WriteOp, beforeSend: () => string | undefined, deps: ExecDeps): Promise<WriteResult> {
  const items = itemsOf(op);
  const pulse = items.find(i => i.pulseMs !== undefined);
  const old = pulse || deps.journal ? await readOld(items, deps) : new Map<string, ReadRow>();
  const result = await perform(op, items, pulse, old, beforeSend, deps);
  record(op, items, result, old, deps);
  return result;
}

async function perform(op: WriteOp, items: readonly WriteItem[], pulse: WriteItem | undefined, old: Map<string, ReadRow>, beforeSend: () => string | undefined, deps: ExecDeps): Promise<WriteResult> {
  if (!pulse) return send(op, beforeSend, deps);

  const refused = pulseTypeProblem(pulse, old.get(key(pulse.symbol)));
  if (refused) return { kind: 'refused', reason: refused };
  const first = await send(op, beforeSend, deps);
  if (first.kind === 'refused') return first;

  const wasSent = first.kind === 'unknown' ? true : first.kind === 'done' ? first.items.find(i => i.symbol === pulse.symbol)?.status !== 'notWritten' : true;
  if (!wasSent) return first;
  const outcome = await reset(pulse, deps);
  if (first.kind === 'done') {
    const item = first.items.find(i => i.symbol === pulse.symbol);
    if (item && item.status !== 'notWritten') item.pulse = outcome;
    return first;
  }
  if (first.kind === 'unknown') {
    const tail = outcome.state === 'done' ? `the reset of ${pulse.symbol} to ${outcome.reset} was sent` : `the reset of ${pulse.symbol} to ${outcome.reset} did not go through (${outcome.reason}), so ${pulse.symbol} may still be set`;
    return { kind: 'unknown', reason: `${first.reason}; ${tail}` };
  }
  // a written single item (cannot happen for a pulse, which always carries items)
  return first;
}

/** A pulse only makes sense on a BOOL; a type that cannot be read is refused too, so nothing is sent blind. */
function pulseTypeProblem(pulse: WriteItem, row: ReadRow | undefined): string | undefined {
  if (!row || row.error || row.type === null) return `cannot check the type of ${pulse.symbol}: ${row?.error ?? 'no answer'}`;
  if (row.type.trim().toUpperCase() !== 'BOOL') return `pulseMs works on BOOL variables only; ${pulse.symbol} is ${row.type}`;
  return undefined;
}

/**
 * Waits and writes the opposite value. No approval, deadline or cancellation applies: the bit must return to idle, so the
 * reset gets a `beforeSend` that never refuses (only the host's own target guard still applies).
 */
async function reset(pulse: WriteItem, deps: ExecDeps): Promise<PulseOutcome> {
  const ms = pulse.pulseMs as number;
  const back = oppositeBool(pulse.value) ?? 'FALSE';
  const sentAt = deps.now();
  await deps.sleep(ms);
  const heldMs = Math.round(deps.now() - sentAt);
  try {
    await deps.writeOne({ symbol: pulse.symbol, value: back }, () => undefined);
    return { ms, heldMs, reset: back, state: 'done' };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ms, heldMs, reset: back, state: e instanceof WriteNotSent ? 'notSent' : 'unknown', reason };
  }
}
