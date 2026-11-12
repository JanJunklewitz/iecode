// The change log of the scope buffer: per watched symbol the first observed text and every later change, so text values
// and change times survive although the numeric series cannot hold them. Pure, no vscode.

export const MAX_CHANGE_ENTRIES = 100_000;
export const MAX_CHANGE_TEXT = 256;
export const CUT_MARK = '…[cut]';

/** `first` marks the first observation of a symbol (its first sample), which is no change. */
/** `after` is set when read errors lie between the previous valid sample (at that time) and this entry: the change happened somewhere in between. */
export interface ChangeEntry { t: number; text: string; first?: true; after?: number }

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
    const gapFrom = l.failedSince !== undefined ? l.lastValidT : undefined;
    l.lastValidT = t;
    l.failedSince = undefined;
    const { cut, key } = cutAndKey(text);
    if (key === l.lastKey) return;
    const first = l.lastKey === undefined;
    l.entries.push(first ? { t, text: cut, first: true } : gapFrom !== undefined ? { t, text: cut, after: gapFrom } : { t, text: cut });
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
    return { start, entries, olderDropped, startUnknown, lastValidT: l.lastValidT, failedSince: l.failedSince, coveredFromMs: Math.max(windowStart, covered === -Infinity ? windowStart : covered) };
  }
}

export interface ChangesTable { notes: string[]; header: string; rows: string[] }

/**
 * The `changesOnly` table: one row per time at which a symbol has an entry in the window, unchanged cells empty,
 * plus a start row with the values in force at the window start. The start row counts against `maxRows` and is
 * left out when rows are left out; the newest rows always stay.
 */
export function changesTable(names: string[], logs: ChangeLog[], o: {
  now: number; requestedStart: number; maxRows: number; unknownText: string; cell: (index: number, text: string) => string;
}): ChangesTable {
  const notes: string[] = [];
  const known = logs.filter(l => l.entries.length > 0 || l.start !== undefined || l.startUnknown);
  const covered = known.length > 0 ? Math.min(...known.map(l => l.coveredFromMs)) : o.requestedStart;
  if (o.requestedStart < covered) notes.push(`history covers only the last ${Math.round((o.now - covered) / 1000)} s`);
  const dropped = names.filter((_, i) => logs[i].olderDropped);
  if (dropped.length > 0) notes.push(`older changes dropped: ${dropped.join(', ')}`);

  const rows = new Map<number, string[]>();
  const row = (t: number): string[] => { let r = rows.get(t); if (!r) rows.set(t, r = names.map(() => '')); return r; };
  const t0 = Math.max(o.requestedStart, covered);
  const startCells = logs.map((l, i) => (l.start ? o.cell(i, l.start.text) : l.startUnknown ? o.unknownText : ''));
  const labels = new Map<number, string>();
  logs.forEach((l, i) => {
    for (const e of l.entries) {
      row(e.t)[i] = o.cell(i, e.text);
      if (e.after !== undefined && !labels.has(e.t)) labels.set(e.t, `unknown between ${((e.after - o.now) / 1000).toFixed(3)} and ${((e.t - o.now) / 1000).toFixed(3)}`);
    }
  });
  const events = [...rows.keys()].sort((a, b) => a - b);
  const startRow = startCells.some(c => c !== '') && !rows.has(t0);
  if (startRow) startCells.forEach((c, i) => { row(t0)[i] = c; });
  else if (rows.has(t0)) startCells.forEach((c, i) => { const r = rows.get(t0)!; if (r[i] === '' && c !== '') r[i] = c; });

  let times = [...rows.keys()].sort((a, b) => a - b);
  if (times.length > o.maxRows) {
    times = events.slice(Math.max(0, events.length - o.maxRows));
    const hidden = events.length - times.length;
    if (hidden > 0) notes.push(`${hidden} earlier rows not shown, narrow seconds or symbols`);
  }
  return { notes, header: ['t[s]', ...names].join('\t'), rows: times.map(t => [labels.get(t) ?? ((t - o.now) / 1000).toFixed(3), ...rows.get(t)!].join('\t')) };
}

/** "-9.4" (one decimal, never "-0.0"); seconds relative to `now`. */
export function relSeconds(t: number, now: number): string {
  const r = ((t - now) / 1000).toFixed(1);
  return r === '-0.0' ? '0.0' : r;
}

const rel3 = (t: number, now: number): string => ((t - now) / 1000).toFixed(3);

/** Type names the host reports for a plain (non-alias) type; anything else that is not BOOL may be an alias of BOOL. */
const BUILTIN_TYPE = /^(U?(S|D|L)?INT|BYTE|WORD|DWORD|LWORD|L?REAL|L?TIME|DATE|DT|TOD|W?STRING|ARRAY|POINTER|REFERENCE)\b/i;

/** `bool` only for the exact type name BOOL; an unknown name may be an alias and is not proven. */
export function edgeKind(type: string | undefined): 'bool' | 'other' | 'alias' {
  if (type === undefined) return 'alias';
  if (type.toUpperCase() === 'BOOL') return 'bool';
  return BUILTIN_TYPE.test(type) ? 'other' : 'alias';
}

export interface EdgeInput { name: string; type: string | undefined; log: ChangeLog }
export interface EdgesTable { summaries: string[]; notes: string[]; header?: string; rows: string[] }

/** The `edges` view: one summary line per symbol and, when edges exist, a table of them (newest `maxRows`). */
export function edgesTable(inputs: EdgeInput[], o: { now: number; seconds: number; requestedStart: number; maxRows: number }): EdgesTable {
  const summaries: string[] = [];
  const edges: { t: number; index: number; label: string; kind: string }[] = [];
  inputs.forEach((s, index) => {
    const kind = edgeKind(s.type);
    if (kind === 'other') { summaries.push(`${s.name}: not a BOOL, ignored`); return; }
    if (kind === 'alias') { summaries.push(`${s.name}: type ${s.type ?? 'unknown'} is an alias, not proven BOOL; use ads_read`); return; }
    const log = s.log;
    const newest = log.entries.at(-1) ?? log.start;
    if (!newest) { summaries.push(`${s.name}: no samples in the last ${o.seconds} s`); return; }
    const failed = log.failedSince === undefined ? '' : ` reading failed since ${relSeconds(log.failedSince, o.now)} s`;
    const mine = changeEntries(log).filter(e => e.text === 'TRUE' || e.text === 'FALSE');
    if (mine.length === 0) { summaries.push(`${s.name}: no edges in the last ${o.seconds} s, stays ${newest.text}${failed}`); return; }
    const rising = mine.filter(e => e.text === 'TRUE').length;
    const dropped = log.olderDropped;
    summaries.push(`${s.name}: edges${dropped ? '>=' : '='}${mine.length} (${rising} rising, ${mine.length - rising} falling${dropped ? `; ${mine.length} retained edges, older edges dropped` : ''}), now ${newest.text}${failed}`);
    for (const e of mine) {
      const when = e.after !== undefined ? `unknown between ${rel3(e.after, o.now)} and ${rel3(e.t, o.now)}` : rel3(e.t, o.now);
      edges.push({ t: e.t, index, label: when, kind: e.text === 'TRUE' ? 'rising' : 'falling' });
    }
  });
  const known = inputs.filter(s => edgeKind(s.type) === 'bool' && (s.log.entries.length > 0 || s.log.start !== undefined)).map(s => s.log.coveredFromMs);
  const covered = known.length > 0 ? Math.min(...known) : o.requestedStart;
  const coverage = o.requestedStart < covered ? `history covers only the last ${Math.round((o.now - covered) / 1000)} s` : undefined;
  if (edges.length === 0) return { summaries: coverage ? [...summaries, coverage] : summaries, notes: [], rows: [] };
  edges.sort((a, b) => a.t - b.t || a.index - b.index);
  const notes: string[] = coverage ? [coverage] : [];
  const shown = edges.slice(Math.max(0, edges.length - o.maxRows));
  if (shown.length < edges.length) notes.push(`${edges.length - shown.length} earlier edges not shown, narrow seconds or symbols`);
  return { summaries, notes, header: 't[s]\tsymbol\tedge', rows: shown.map(e => `${e.label}\t${inputs[e.index].name}\t${e.kind}`) };
}
