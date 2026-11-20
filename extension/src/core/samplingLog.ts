// Log of connection and sampling events (lost/restored, symbols reloaded, sampling stopped/started) and the notice text
// the ADS tools put in front of a result. Pure: no vscode imports, no clock of its own.

import type { ToolNames } from './adsToolText';

export type SamplingEvent =
  | { kind: 'lost'; t: number; error: string }
  | { kind: 'restored'; t: number }
  | { kind: 'reloaded'; t: number; reason: string }
  | { kind: 'stopped'; t: number; reason: string }
  | { kind: 'started'; t: number };

export interface Logged { id: number; e: SamplingEvent }

export class SamplingLog {
  private items: Logged[] = [];
  private lastId = 0;
  /** Highest id the cap evicted; a cursor below it missed events. clear() keeps it on purpose: a reader behind the cap gets "(earlier notices dropped)" also after a clear(). */
  private evicted = 0;
  /** A connected:true of the current host process was seen, so a later change is a real loss or restore. */
  private baseline = false;
  private connected = false;
  /** A stopped was recorded and no started followed since. */
  private stoppedPending = false;
  /** A started was recorded and no stopped followed since (since the last clear). */
  private running = false;

  constructor(private readonly cap = 50) {}

  /** Feeds a `state` event of the host process; records lost/restored only after a first connected:true of this process. */
  state(connected: boolean, error: string | undefined, t: number): void {
    if (!this.baseline) {
      if (connected) { this.baseline = true; this.connected = true; }
      return;
    }
    if (connected === this.connected) return;
    this.connected = connected;
    this.push(connected ? { kind: 'restored', t } : { kind: 'lost', t, error: error ?? 'connection lost' });
  }

  /**
   * reloaded is always kept; stopped only while a host runs (a failed start never said hello, so nothing was sampling)
   * and once per run; started only after a stopped (since the last clear) and it resets the connection baseline.
   */
  record(e: SamplingEvent): void {
    if (e.kind === 'started') {
      this.running = true;
      if (!this.stoppedPending) return;
      this.stoppedPending = false;
      this.baseline = false;
      this.connected = false;
    } else if (e.kind === 'stopped') {
      if (!this.running) return;
      this.running = false;
      this.stoppedPending = true;
    }
    this.push(e);
  }

  /** Id of the newest event, 0 when none; a new reader starts here. */
  head(): number { return this.lastId; }

  /** Events with id > cursor, oldest first, and whether older ones were dropped by the cap. */
  since(cursor: number): { events: SamplingEvent[]; dropped: boolean } {
    return { events: this.items.filter(i => i.id > cursor).map(i => i.e), dropped: this.evicted > cursor };
  }

  /** Events not older than maxAgeMs, oldest first, for the views. */
  recent(nowMs: number, maxAgeMs: number): SamplingEvent[] {
    return this.items.filter(i => nowMs - i.e.t <= maxAgeMs).map(i => i.e);
  }

  /** Target change; ids keep counting. */
  clear(): void {
    this.items = [];
    this.baseline = false;
    this.connected = false;
    this.stoppedPending = false;
    this.running = false;
  }

  private push(e: SamplingEvent): void {
    this.items.push({ id: ++this.lastId, e });
    while (this.items.length > this.cap) this.evicted = this.items.shift()!.id;
  }
}

const MAX_NOTICES = 3;

/** Coalesces lost..restored and stopped..started, oldest to newest; every returned line is one notice. */
export function noticeText(events: SamplingEvent[], dropped: boolean, clock: (ms: number) => string, names: ToolNames): string | undefined {
  const used = new Set<number>();
  const lines: string[] = [];
  const partner = (from: number, kind: 'restored' | 'started'): number => {
    for (let j = from + 1; j < events.length; j++) {
      if (used.has(j)) continue;
      if (events[j].kind === kind) return j;
      if (events[j].kind === 'lost' || events[j].kind === 'stopped') return -1;
    }
    return -1;
  };
  events.forEach((e, i) => {
    if (used.has(i)) return;
    switch (e.kind) {
      case 'lost': {
        const j = partner(i, 'restored');
        if (j >= 0) {
          used.add(j);
          lines.push(`Notice: the connection to the PLC was lost at ${clock(e.t)} and restored at ${clock(events[j].t)}; values in between are missing; ${names.state} compares the PLC cycle counter with its previous call to tell a restart.`);
        } else {
          // a stop that follows the loss ends the sampling, so it does not resume by itself
          const next = events.find((x, k) => k > i && !used.has(k) && (x.kind === 'restored' || x.kind === 'lost' || x.kind === 'stopped'));
          lines.push(next?.kind === 'stopped'
            ? `Notice: the connection to the PLC was lost at ${clock(e.t)} (${e.error}); sampling then stopped.`
            : `Notice: the connection to the PLC was lost at ${clock(e.t)} (${e.error}); sampling resumes when it is back.`);
        }
        break;
      }
      case 'restored':
        lines.push(`Notice: the connection to the PLC was restored at ${clock(e.t)}.`);
        break;
      case 'reloaded':
        lines.push(`Notice: the symbols were reloaded at ${clock(e.t)} (${e.reason}: download, online change or PLC restart); values may have been reset.`);
        break;
      case 'stopped': {
        const j = partner(i, 'started');
        if (j >= 0) {
          used.add(j);
          lines.push(`Notice: sampling was stopped from ${clock(e.t)} to ${clock(events[j].t)} (${e.reason}); values in between are missing.`);
        } else {
          lines.push(`Notice: sampling stopped at ${clock(e.t)} (${e.reason}); ${names.watch} or ${names.wait} starts it again.`);
        }
        break;
      }
      case 'started':
        lines.push(`Notice: sampling started again at ${clock(e.t)}.`);
        break;
    }
  });
  const out: string[] = [];
  if (dropped) out.push('(earlier notices dropped)');
  if (lines.length > MAX_NOTICES) {
    const hidden = lines.length - MAX_NOTICES;
    out.push(`(${hidden} earlier notice${hidden === 1 ? '' : 's'} not shown)`);
  }
  out.push(...lines.slice(-MAX_NOTICES));
  return out.length ? out.join('\n') : undefined;
}

/**
 * One per tools object (MCP session or Copilot). take() reads the events since its cursor and moves the cursor in the
 * same synchronous step, so two overlapping calls never show the same notice twice and none is lost (R15).
 */
export class NoticeReader {
  private cursor: number;
  constructor(private readonly log: SamplingLog, private readonly clock: (ms: number) => string, private readonly names: ToolNames) {
    this.cursor = log.head();
  }
  take(): string | undefined {
    const { events, dropped } = this.log.since(this.cursor);
    this.cursor = this.log.head();
    return noticeText(events, dropped, this.clock, this.names);
  }
}

/** Intervals without samples inside [fromMs, toMs]: lost..restored and stopped..started pairs, an open one ends at toMs. */
export function gapsIn(events: SamplingEvent[], fromMs: number, toMs: number): { from: number; to: number; why: 'lost' | 'stopped' }[] {
  const out: { from: number; to: number; why: 'lost' | 'stopped' }[] = [];
  const add = (start: number, end: number, why: 'lost' | 'stopped') => {
    if (end <= fromMs || start >= toMs) return;
    out.push({ from: Math.max(start, fromMs), to: Math.min(end, toMs), why });
  };
  let lost: number | undefined;
  let stopped: number | undefined;
  for (const e of events) {
    if (e.kind === 'lost' && lost === undefined) lost = e.t;
    else if (e.kind === 'restored' && lost !== undefined) { add(lost, e.t, 'lost'); lost = undefined; }
    else if (e.kind === 'stopped' && stopped === undefined) {
      if (lost !== undefined) { add(lost, e.t, 'lost'); lost = undefined; }
      stopped = e.t;
    }
    else if (e.kind === 'started' && stopped !== undefined) { add(stopped, e.t, 'stopped'); stopped = undefined; }
  }
  if (lost !== undefined) add(lost, toMs, 'lost');
  if (stopped !== undefined) add(stopped, toMs, 'stopped');
  return out.sort((a, b) => a.from - b.from);
}

/** One line for ads_scope when its window contains a gap, independent of any cursor (R16); undefined without gaps. */
export function gapWarning(gaps: ReturnType<typeof gapsIn>, clock: (ms: number) => string): string | undefined {
  if (!gaps.length) return undefined;
  const parts = gaps.map(g => `${clock(g.from)} to ${clock(g.to)} (${g.why === 'lost' ? 'connection lost' : 'sampling stopped'})`);
  return `Warning: no samples from ${parts.join(', from ')}; the values do not show what happened in between.`;
}

/** How long the ADS Watch view and the ADS Scope show a notice. */
export const VIEW_NOTICE_MS = 120_000;

/** The status line of a view: the disconnect message first, else the notices of the last two minutes (Decision 5). */
export function viewNotice(state: { connected: boolean; error?: string }, log: SamplingLog, nowMs: number, clock: (ms: number) => string, names: ToolNames): string | undefined {
  if (!state.connected && state.error) return `Disconnected: ${state.error}`;
  return noticeText(log.recent(nowMs, VIEW_NOTICE_MS), false, clock, names);
}

/** The gap warning of an ads_scope table: its window is `seconds` up to the newest sample, or up to now while there is none (R16). */
export function scopeGapWarning(events: SamplingEvent[], seconds: number, newestMs: number | undefined, nowMs: number, clock: (ms: number) => string): string | undefined {
  const to = newestMs ?? nowMs;
  return gapWarning(gapsIn(events, to - seconds * 1000, to), clock);
}
