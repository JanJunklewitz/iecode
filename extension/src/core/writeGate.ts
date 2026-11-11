// The one path every AI write takes (MCP and Copilot): queue, approval, binding to the confirmed target,
// cancellation, deadlines and the outcome texts. Pure: the dialog, the settings and the host come in through GateDeps,
// the clock through Clock, so the rules are unit-tested without VS Code.

import { WriteDecision, writeStillApproved } from './adswatch';
import { WriteItem, WriteItemResult, readBackChanged, sentence } from './writeText';
import { COPILOT_NAMES, MCP_NAMES, ToolNames, targetLine, targetOfKey } from './adsToolText';

/** The write was not sent: refused before the request left, or the host proved it did not send it. `alreadyShown`: a failed host start. */
export class WriteNotSent extends Error {
  constructor(message: string, readonly alreadyShown = false) { super(message); }
}

/** The write request was sent and the outcome is not known (no reply, host gone, or an error that does not prove "not sent"). */
export class WriteOutcomeUnknown extends Error {}

export interface WriteOp {
  symbol: string;
  value: string;
  /** "<target>:<port>" the approval is bound to. */
  targetKey: string;
  via: 'MCP' | 'Copilot';
  /** Copilot: the decision its confirmation was shown with; the gate opens no dialog for it (R5). */
  prepared?: { decision: WriteDecision };
  /** A batch: all items in order; `symbol` and `value` mirror items[0]. */
  items?: WriteItem[];
}

export const itemsOf = (op: WriteOp): WriteItem[] => op.items ?? [{ symbol: op.symbol, value: op.value }];

/** The protocol feature an op needs beyond the scalar write: more than one item needs "writeMany". */
export const featureOf = (op: WriteOp): string | undefined => (itemsOf(op).length > 1 ? 'writeMany' : undefined);

export type WriteResult =
  /** Not sent. */
  | { kind: 'refused'; reason: string }
  /** Sent and taken; `readBack` is null with a `readBackError` when only the read-back failed. */
  | { kind: 'written'; readBack: string | null; readBackError?: string }
  /** Sent, but no reply or no proof either way. */
  | { kind: 'unknown'; reason: string }
  /** A batch that reached the host: one result per item, in order. */
  | { kind: 'done'; items: WriteItemResult[] };

export interface GateDeps {
  decision(): WriteDecision;
  targetKey(): string;
  /** The user's raw choice, also after the signal aborted: VS Code cannot close a modal. */
  confirm(op: WriteOp, signal: AbortSignal): Promise<boolean>;
  /** Calls `beforeSend` right before the request leaves; a returned reason means: do not send. */
  send(op: WriteOp, beforeSend: () => string | undefined): Promise<WriteResult>;
  /** The user approved after the request ended (cancelled, timed out, shut down): nothing was written. */
  lateApproval(op: WriteOp, reason: string): void;
}

export interface GatePolicy {
  /** Longest time one dialog may stay open, counted from when it opens (at most 120 s). */
  dialogMs: number;
  /** Longest time from run() to sending, queue wait included. */
  operationMs: number;
  maxQueued: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
};

const SHUTDOWN = 'IECode was shut down';
const CANCELLED = 'the request was cancelled';
const TOO_LONG = 'the request waited too long';
const OFF = 'AI writes are off. The user can allow them with the command "IECode: Set AI Write Access…" (setting iecode.ads.aiWrites in the user settings)';
/** A dialog needs at least this much of the operation deadline, else the user could not answer in time. */
export const MIN_DIALOG_MS = 5000;

const namesOf = (op: WriteOp): ToolNames => (op.via === 'MCP' ? MCP_NAMES : COPILOT_NAMES);
const refusal = (reason: string): WriteResult => ({ kind: 'refused', reason });

/** What a rejection of `send` means: a proven "not sent" refuses, everything else is an unknown outcome (R19). */
export function sendOutcome(e: unknown): WriteResult {
  const reason = e instanceof Error ? e.message : String(e);
  return e instanceof WriteNotSent ? refusal(reason) : { kind: 'unknown', reason };
}

export function writeResultText(r: WriteResult, op: WriteOp): string {
  return `${writeVerdict(r, op)}\n${targetLine(targetOfKey(op.targetKey))}`;
}

function writeVerdict(r: WriteResult, op: WriteOp): string {
  switch (r.kind) {
    case 'written':
      if (r.readBack !== null && readBackChanged(op.value, r.readBack)) {
        return `Written (accepted by ADS), but ${op.symbol} then reads back as ${r.readBack}, not ${op.value}: it changed after the write (the PLC may have changed it). Read it again before acting on it.`;
      }
      return r.readBack === null
        ? `Written, but ${op.symbol} could not be read back: ${sentence(r.readBackError ?? 'unknown error')}. Read it before acting on the value.`
        : `Written. ${op.symbol} reads back as ${r.readBack} (the PLC may change it again).`;
    case 'refused':
      return `Not written: ${sentence(r.reason)}.`;
    case 'unknown':
      return `Outcome unknown: ${sentence(r.reason)}. Do not write again on your own; read ${op.symbol} and ask the user.`;
    case 'done':
      // placeholder: C3b pins the batch texts
      return r.items.map(i => `${i.symbol}: ${i.status}`).join('\n');
  }
}

/** Refused and unknown are errors for the client; a written value is not, also when only its read-back failed. */
export const writeResultIsError = (r: WriteResult): boolean =>
  r.kind === 'done' ? r.items.some(i => i.status !== 'written') : r.kind !== 'written';

interface OpState {
  op: WriteOp;
  signal: AbortSignal;
  deadlineAt: number;
  /** The result was handed to the caller. */
  settled: boolean;
  /** `beforeSend` passed: from here nothing turns the result into "refused" any more. */
  committed: boolean;
  /** Why the op ended as refused; also read by `beforeSend` of an op that is still inside `send()`. */
  refusal?: string;
  /** The decision the op was approved under: the user confirmed (`confirm`) or settings allowed it (`allow`). */
  approved?: WriteDecision;
  resolve(r: WriteResult): void;
  timers: unknown[];
  onAbort(): void;
}

export class WriteGate {
  private readonly queue: OpState[] = [];
  private readonly open = new Set<OpState>();
  private running = false;
  private disposed = false;

  constructor(private readonly deps: GateDeps, private readonly policy: GatePolicy, private readonly clock: Clock = realClock) {}

  run(op: WriteOp, signal: AbortSignal): Promise<WriteResult> {
    if (this.disposed) return Promise.resolve(refusal(SHUTDOWN));
    if (signal.aborted) return Promise.resolve(refusal(CANCELLED));
    if (this.queue.length >= this.policy.maxQueued) return Promise.resolve(refusal('too many pending writes'));
    return new Promise<WriteResult>(resolve => {
      const s: OpState = {
        op, signal, deadlineAt: this.clock.now() + this.policy.operationMs, settled: false, committed: false,
        resolve, timers: [], onAbort: () => this.flip(s, CANCELLED),
      };
      s.timers.push(this.clock.setTimeout(() => this.flip(s, TOO_LONG), this.policy.operationMs));
      signal.addEventListener('abort', s.onAbort, { once: true });
      this.open.add(s);
      this.queue.push(s);
      void this.pump();
    });
  }

  /** Latched: every op not yet sent ends as refused, also one waiting inside `send()` for the host start. */
  dispose(): void {
    this.disposed = true;
    for (const s of [...this.open]) this.flip(s, SHUTDOWN);
  }

  // ---- internals ----

  private cleanup(s: OpState): void {
    for (const t of s.timers) this.clock.clearTimeout(t);
    s.timers = [];
    s.signal.removeEventListener('abort', s.onAbort);
    this.open.delete(s);
  }

  private finish(s: OpState, r: WriteResult): void {
    if (s.settled) return;
    s.settled = true;
    this.cleanup(s);
    s.resolve(r);
  }

  /** Ends a not yet sent op as refused at once (abort, deadline, dispose, a failed check). */
  private flip(s: OpState, reason: string): void {
    if (s.settled || s.committed) return;
    s.refusal ??= reason;
    const i = this.queue.indexOf(s);
    if (i >= 0) this.queue.splice(i, 1);
    this.finish(s, refusal(reason));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let s = this.queue.shift(); s; s = this.queue.shift()) {
        if (!s.settled) await this.process(s);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(s: OpState): Promise<void> {
    const { op } = s;
    const names = namesOf(op);
    const now = this.deps.decision();
    if (op.via === 'Copilot') {
      if (!op.prepared) return this.flip(s, `it needs the user's confirmation now; call ${names.write} again`);
      if (now === 'refuse') return this.flip(s, OFF);
      if (!writeStillApproved(op.prepared.decision, now)) {
        return this.flip(s, `the AI write access or the ADS target settings changed after this write was prepared, so it now needs the user's confirmation; call ${names.write} again to ask for it`);
      }
      s.approved = op.prepared.decision;
    } else if (now === 'refuse') {
      return this.flip(s, OFF);
    } else if (now === 'allow') {
      s.approved = 'allow';
    } else {
      if (s.deadlineAt - this.clock.now() < MIN_DIALOG_MS) return this.flip(s, TOO_LONG);
      const dialogTimer = this.clock.setTimeout(() => this.flip(s, 'the confirmation was not answered in time'), this.policy.dialogMs);
      s.timers.push(dialogTimer);
      let answer = false;
      try {
        answer = await this.deps.confirm(op, s.signal);
      } catch {
        answer = false;
      }
      this.clock.clearTimeout(dialogTimer);
      if (s.refusal !== undefined) {
        if (answer) this.deps.lateApproval(op, s.refusal);
        return;
      }
      if (!answer) return this.finish(s, refusal('the user declined the write'));
      s.approved = 'confirm';
    }
    let result: WriteResult;
    try {
      result = await this.deps.send(op, () => this.beforeSend(s));
    } catch (e) {
      result = sendOutcome(e);
    }
    this.finish(s, result);
  }

  /** The last check before the request is written; the first reason also ends the op as refused. */
  private beforeSend(s: OpState): string | undefined {
    const reason = this.refusalBeforeSend(s);
    if (reason === undefined) {
      s.committed = true;
      return undefined;
    }
    this.flip(s, reason);
    return s.refusal ?? reason;
  }

  private refusalBeforeSend(s: OpState): string | undefined {
    if (s.refusal !== undefined) return s.refusal;
    if (this.disposed) return SHUTDOWN;
    if (s.signal.aborted) return CANCELLED;
    if (this.clock.now() >= s.deadlineAt) return TOO_LONG;
    const now = this.deps.decision();
    if (now === 'refuse') return OFF;
    if (!writeStillApproved(s.approved, now)) return `it needs the user's confirmation now; call ${namesOf(s.op).write} again`;
    const target = this.deps.targetKey();
    if (target !== s.op.targetKey) return `the ADS target changed from ${s.op.targetKey} to ${target}`;
    return undefined;
  }
}

/**
 * What a Copilot prepare step stored for its invoke step. Copilot calls both with the same input only, so the record is
 * keyed by it; a second prepare for the same key while one is open makes the key ambiguous (two calls cannot be told
 * apart) and both invocations get nothing, which refuses them (R28).
 */
export class PreparedWrites {
  private readonly records = new Map<string, { decision: WriteDecision; targetKey: string; at: number; count: number; ambiguous: boolean }>();

  constructor(private readonly maxAgeMs: number, private readonly now: () => number = Date.now, private readonly maxRecords = 100) {}

  prepare(key: string, record: { decision: WriteDecision; targetKey: string }): void {
    const old = this.records.get(key);
    if (old && this.now() - old.at <= this.maxAgeMs) {
      // identical records bind the same decision and target, so either invoke may use it (a declined confirmation leaves one behind)
      old.count++;
      if (old.decision !== record.decision || old.targetKey !== record.targetKey) old.ambiguous = true;
      return;
    }
    // writes the user declined never reach invoke; keep the map from growing on them
    if (!old && this.records.size >= this.maxRecords) this.records.clear();
    this.records.set(key, { ...record, at: this.now(), count: 1, ambiguous: false });
  }

  take(key: string): { decision: WriteDecision; targetKey: string } | undefined {
    const r = this.records.get(key);
    if (!r) return undefined;
    if (this.now() - r.at > this.maxAgeMs) { this.records.delete(key); return undefined; }
    if (--r.count <= 0) this.records.delete(key);
    return r.ambiguous ? undefined : { decision: r.decision, targetKey: r.targetKey };
  }
}
