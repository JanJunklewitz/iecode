// The change log of the scope buffer: per watched symbol the first observed text and every later change, so text values
// and change times survive although the numeric series cannot hold them. Pure, no vscode.

export const MAX_CHANGE_ENTRIES = 100_000;
export const MAX_CHANGE_TEXT = 256;
export const CUT_MARK = '…[cut]';

/** `first` marks the first observation of a symbol (its first sample), which is no change. */
export interface ChangeEntry { t: number; text: string; first?: true }

export interface ChangeLog {
  /** The value in force at the window start: the last entry before it. Undefined: none known, see startUnknown. */
  start?: ChangeEntry;
  /** Entries with t >= window start, oldest first. */
  entries: ChangeEntry[];
  /** True when the entry cap removed entries that lay inside the window. */
  olderDropped: boolean;
  /** True when `start` is undefined because the cap removed it (not because the symbol had no sample yet). */
  startUnknown: boolean;
  /** The oldest time the log can speak for: the window start is clamped to it (buffer length, first sample, cap). */
  coveredFromMs: number;
  /** Time of the newest valid sample. */
  lastValidT?: number;
  /** Time of the first failed (null) sample after the newest valid one; undefined while reading works. */
  failedSince?: number;
}

/** The entries that are real changes: all but a first observation. */
export function changeEntries(log: ChangeLog): ChangeEntry[] {
  return log.entries.filter(e => !e.first);
}

/** 53-bit string hash (cyrb53); only used to tell apart long texts that share their first MAX_CHANGE_TEXT characters. */
function hash53(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** What is stored for a text and what it is compared by; the full long text is never kept. */
function cutAndKey(text: string): { cut: string; key: string } {
  if (text.length <= MAX_CHANGE_TEXT) return { cut: text, key: text };
  const cut = text.slice(0, MAX_CHANGE_TEXT) + CUT_MARK;
  return { cut, key: `${cut}\u0000${text.length}:${hash53(text)}` };
}

interface SymbolLog {
  /** Queue: live entries are entries[head..]; removing from the front moves head instead of splicing on every push. */
  entries: ChangeEntry[];
  head: number;
  lastKey?: string;
  firstT?: number;
  lastValidT?: number;
  failedSince?: number;
  /** Time of the newest entry the cap removed. */
  droppedT?: number;
  /** Everything before this time was trimmed by age; the predecessor entry still gives the value at that time. */
  floorT: number;
}

export class ChangeLogStore {
  private logs = new Map<string, SymbolLog>();

  constructor(private readonly maxChanges = MAX_CHANGE_ENTRIES) {}

  /** Records the text of one sample; a null text (read error) is no change and keeps the comparison base. */
  add(symbol: string, t: number, text: string | null): void {
    let l = this.logs.get(symbol);
    if (text === null) {
      if (l && l.failedSince === undefined) l.failedSince = t;
      return;
    }
    if (!l) this.logs.set(symbol, l = { entries: [], head: 0, floorT: -Infinity });
    l.lastValidT = t;
    l.failedSince = undefined;
    const { cut, key } = cutAndKey(text);
    if (key === l.lastKey) return;
    const first = l.lastKey === undefined;
    l.entries.push(first ? { t, text: cut, first: true } : { t, text: cut });
    if (first) l.firstT = t;
    l.lastKey = key;
  }

  /** Keeps symbols that are still watched. */
  keepOnly(symbols: Set<string>): void {
    for (const k of [...this.logs.keys()]) if (!symbols.has(k)) this.logs.delete(k);
  }

  clear(): void {
    this.logs.clear();
  }

  /** Age and cap rules; `itemCount` splits the total cap over the watched symbols. */
  trim(newest: number, ms: number, itemCount: number): void {
    const cutoff = newest - ms;
    const cap = Math.max(2, Math.floor(this.maxChanges / Math.max(1, itemCount)));
    for (const l of this.logs.values()) {
      // Keep the last entry older than the cutoff: it is the value in force at the window start.
      let aged = false;
      while (l.head + 1 < l.entries.length && l.entries[l.head + 1].t < cutoff) { l.head++; aged = true; }
      if (aged || (l.head < l.entries.length && l.entries[l.head].t < cutoff)) l.floorT = Math.max(l.floorT, cutoff);
      while (l.entries.length - l.head > cap) l.droppedT = l.entries[l.head++].t;
      if (l.head > 1024 && l.head * 2 > l.entries.length) { l.entries.splice(0, l.head); l.head = 0; }
    }
  }

  changes(symbol: string, fromMs: number, newest: number, ms: number): ChangeLog {
    const windowStart = Math.max(fromMs, newest - ms);
    const l = this.logs.get(symbol);
    if (!l) return { entries: [], olderDropped: false, startUnknown: false, coveredFromMs: windowStart };
    let i = l.entries.length;
    while (i > l.head && l.entries[i - 1].t >= windowStart) i--;
    const entries = l.entries.slice(i);
    const start = i > l.head ? l.entries[i - 1] : undefined;
    const startUnknown = start === undefined && l.droppedT !== undefined;
    const olderDropped = l.droppedT !== undefined && l.droppedT >= windowStart;
    let covered = Math.max(l.firstT ?? -Infinity, l.floorT);
    if (startUnknown) covered = Math.max(covered, entries[0]?.t ?? covered);
    return { start, entries, olderDropped, startUnknown, lastValidT: l.lastValidT, failedSince: l.failedSince, coveredFromMs: Math.max(windowStart, covered === -Infinity ? windowStart : covered) };
  }
}
