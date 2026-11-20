// What the AI wrote in this window, with the value each symbol had just before, so the user can see the changes and put
// them back. Pure: the clock comes in, nothing is stored on disk (a window reload empties the journal).

import { WriteItem } from './writeText';

export interface JournalEntry {
  seq: number;
  time: number;
  targetKey: string;
  symbol: string;
  /** The value read just before the write; null when that read failed (see `oldValueError`). */
  oldValue: string | null;
  oldValueError?: string;
  newValue: string;
  outcome: 'written' | 'unknown';
  via: 'MCP' | 'Copilot';
  kind: 'write' | 'restore';
  restored?: boolean;
  pulse?: boolean;
  persistent?: boolean;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export class WriteJournal {
  private list: JournalEntry[] = [];
  private cut = 0;
  private next = 1;

  constructor(private readonly maxEntries = 500, private readonly now: () => number = Date.now) {}

  record(e: Omit<JournalEntry, 'seq' | 'time'>): void {
    this.list.push({ ...e, seq: this.next++, time: this.now() });
    while (this.list.length > this.maxEntries) {
      this.list.shift();
      this.cut++;
    }
  }

  /** Oldest first, optionally only the entries written on one target. */
  entries(targetKey?: string): JournalEntry[] {
    return this.list.filter(e => targetKey === undefined || e.targetKey === targetKey).map(e => ({ ...e }));
  }

  /** How many older entries the cap cut. */
  dropped(): number {
    return this.cut;
  }

  /** Flags every write entry of the symbols on that target as undone, so a second restore does not plan them again. */
  markRestored(symbols: readonly string[], targetKey: string): void {
    for (const e of this.list) {
      if (e.kind === 'write' && e.targetKey === targetKey && symbols.some(s => same(s, e.symbol))) e.restored = true;
    }
  }
}

export function journalText(entries: readonly JournalEntry[], opts: { target: string; dropped: number; clock: (ms: number) => string }): string {
  if (!entries.length) return `No writes through the ADS tools in this session on ${opts.target}.`;
  const lines = entries.map(e => {
    const old = e.oldValue ?? '?';
    const flags = `${e.pulse ? ' (pulse)' : ''}${e.kind === 'restore' ? ' (restore)' : ''}${e.persistent ? ' [PERSISTENT]' : ''}${e.restored ? ' [restored]' : ''}`;
    const time = opts.clock(e.time);
    if (e.outcome === 'unknown') return `${time}  ${e.symbol}: outcome unknown, wanted ${e.newValue} (was ${old})${flags}`;
    if (e.oldValue === null) return `${time}  ${e.symbol}: ? -> ${e.newValue} (old value not read: ${e.oldValueError ?? 'unknown error'})${flags}`;
    return `${time}  ${e.symbol}: ${old} -> ${e.newValue}${flags}`;
  });
  return [
    `Writes through the ADS tools in this session on ${opts.target} (${entries.length}):`,
    ...lines,
    ...(opts.dropped > 0 ? [`(${opts.dropped} older entries dropped)`] : []),
  ].join('\n');
}

export interface RestorePlan {
  writes: WriteItem[];
  skipped: { symbol: string; reason: string }[];
  /** Writes that did not fit into this call (the cap) and stay in the journal. */
  remaining: number;
}

export const MAX_RESTORE = 20;

/**
 * What to write back: per symbol the old value of its oldest write that is not yet undone, symbols whose newest write is
 * most recent first. A value that was never read, a symbol that cannot be read now (a rebuild renamed it, the target
 * restarted without it) and a write on another target are skipped with a reason, never silently and never as a failure of
 * the others. `unreadable` maps a lower-case symbol to why it cannot be read now.
 */
export function planRestore(entries: readonly JournalEntry[], targetKey: string, unreadable: ReadonlyMap<string, string>, max = MAX_RESTORE): RestorePlan {
  const open = entries.filter(e => e.kind === 'write' && !e.restored);
  const skipped: { symbol: string; reason: string }[] = [];
  const bySymbol = new Map<string, JournalEntry[]>();
  for (const e of open) {
    const key = e.symbol.trim().toLowerCase();
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), e]);
  }
  const planned: { item: WriteItem; newest: number }[] = [];
  for (const [key, list] of bySymbol) {
    const here = list.filter(e => e.targetKey === targetKey);
    if (!here.length) {
      skipped.push({ symbol: list[0].symbol, reason: `written on another target (${list[0].targetKey})` });
      continue;
    }
    const oldest = here[0];
    if (oldest.oldValue === null) {
      skipped.push({ symbol: oldest.symbol, reason: `old value was not read (${oldest.oldValueError ?? 'unknown error'})` });
      continue;
    }
    const now = unreadable.get(key);
    if (now !== undefined) {
      skipped.push({ symbol: oldest.symbol, reason: `cannot be read now: ${now}` });
      continue;
    }
    planned.push({ item: { symbol: oldest.symbol, value: oldest.oldValue }, newest: here[here.length - 1].seq });
  }
  planned.sort((a, b) => b.newest - a.newest);
  return { writes: planned.slice(0, max).map(p => p.item), skipped, remaining: Math.max(0, planned.length - max) };
}

/** The footer of a restore result: what was left out and why, and that more is waiting. */
export function restoreFooter(info: { skipped: readonly { symbol: string; reason: string }[]; remaining: number }): string {
  const lines: string[] = [];
  if (info.skipped.length) lines.push(`Skipped (not restored): ${info.skipped.map(s => `${s.symbol} (${s.reason})`).join(', ')}`);
  if (info.remaining > 0) lines.push(`${info.remaining} more writes are left in the journal; call restore again.`);
  return lines.join('\n');
}

export const NOTHING_TO_RESTORE = (target: string): string => `Nothing to restore: no AI write of this session is left that has a known old value on ${target}.`;
