// Pure logic for live ADS values: messages of the `iecode ads serve` host, a bounded sample buffer
// and the text form handed to LM tools. No vscode imports; the host process and views live elsewhere.

export const PROTOCOL = 1;

export interface WatchItem { symbol: string; type: string; numeric: boolean; error: string | null }
export interface Row { t: number; v: (string | null)[]; e?: (number | null)[] }

export type HostMessage =
  | { event: 'hello'; protocol: number }
  | { event: 'samples'; gen: number; rows: Row[] }
  | { event: 'state'; connected: boolean; error?: string }
  | { event: 'items'; gen: number; items: WatchItem[] }
  | { id: number | null; ok: boolean; data?: unknown; error?: string; adsCode?: number; written?: string };

// The CLI may print other text (build output, warnings) on stdout; those lines are not messages, and neither is JSON
// that is neither an event nor a reply.
export function parseHostLine(line: string): HostMessage | undefined {
  const s = line.trim();
  if (!s.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(s);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    const event = typeof o.event === 'string';
    const reply = (o.id === null || typeof o.id === 'number') && typeof o.ok === 'boolean';
    return event || reply ? o as HostMessage : undefined;
  } catch {
    return undefined;
  }
}

// ENOENT (not installed) is seen by the caller at spawn time. Exit code 2 = unknown command of an older CLI.
export function hostStartFailure(helloSeen: boolean, exitCode: number | null, elapsedMs: number): string | undefined {
  if (!helloSeen && (exitCode === 2 || (exitCode === null && elapsedMs > 10000))) return 'too old';
  return undefined;
}

import { ChangeLog, ChangeLogStore, MAX_CHANGE_ENTRIES, changeEntries, changesTable, edgesTable, relSeconds } from './scopeChanges';
export { ChangeEntry, ChangeLog, MAX_CHANGE_ENTRIES, MAX_CHANGE_TEXT, CUT_MARK, changeEntries } from './scopeChanges';

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TIMESPAN = /^(-)?(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;

// NaN / Infinity would break axis scaling, so they are not plotted.
export function numericValue(text: string | null, enumValue?: number | null): number | undefined {
  if (enumValue !== undefined && enumValue !== null) return Number.isFinite(enumValue) ? enumValue : undefined;
  if (text === null) return undefined;
  const s = text.trim();
  if (s === 'TRUE') return 1;
  if (s === 'FALSE') return 0;
  if (NUMBER.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const m = TIMESPAN.exec(s);
  if (m) {
    const ms = (((Number(m[2] ?? 0) * 24 + Number(m[3])) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000
      + (m[6] ? Number('0.' + m[6]) * 1000 : 0);
    return m[1] ? -ms : ms;
  }
  return undefined;
}

interface Point { t: number; y: number }

// Per item a series of numbers plus the last raw text; the text stays exact (ULINT, TIME) while the
// series is only for plotting. Rows x items is capped so a long window cannot exhaust memory.
export class ScopeBuffer {
  private ms: number;
  private gen = -1;
  private items: WatchItem[] = [];
  private series_ = new Map<string, Point[]>();
  private latest_ = new Map<string, { t: number; value: string | null }>();
  private newest = -Infinity;
  private readonly log: ChangeLogStore;

  constructor(seconds: number, private readonly maxValues = 2_000_000, maxChanges = MAX_CHANGE_ENTRIES) {
    this.ms = seconds * 1000;
    this.log = new ChangeLogStore(maxChanges);
  }

  setSeconds(seconds: number): void {
    this.ms = seconds * 1000;
    this.trim();
  }

  span(): number {
    let s = 0;
    for (const p of this.series_.values()) if (p.length > 1) s = Math.max(s, p[p.length - 1].t - p[0].t);
    return s / 1000;
  }

  setItems(gen: number, items: WatchItem[]): void {
    this.gen = gen;
    this.items = items;
    const keep = new Set(items.map(i => i.symbol));
    for (const k of [...this.series_.keys()]) if (!keep.has(k)) this.series_.delete(k);
    for (const k of [...this.latest_.keys()]) if (!keep.has(k)) this.latest_.delete(k);
    this.log.keepOnly(keep);
    this.trim();
  }

  push(gen: number, rows: Row[]): void {
    if (gen !== this.gen) return;
    for (const r of rows) {
      this.newest = Math.max(this.newest, r.t);
      this.items.forEach((it, i) => {
        const text = r.v[i] ?? null;
        this.latest_.set(it.symbol, { t: r.t, value: text });
        this.log.add(it.symbol, r.t, text);
        const e = r.e?.[i];
        const y = it.numeric || (e !== undefined && e !== null) ? numericValue(text, e) : undefined;
        if (y === undefined) return;
        let s = this.series_.get(it.symbol);
        if (!s) this.series_.set(it.symbol, s = []);
        s.push({ t: r.t, y });
      });
    }
    this.trim();
  }

  /** Drops all samples (the target changed); the items and the gen stay, so the host's next rows are stored again. */
  clear(): void {
    this.series_.clear();
    this.latest_.clear();
    this.log.clear();
    this.newest = -Infinity;
  }

  latest(symbol: string): { t: number; value: string | null } | undefined {
    return this.latest_.get(symbol);
  }

  /** The type name of the current item. */
  typeOf(symbol: string): string | undefined {
    return this.items.find(i => i.symbol === symbol)?.type;
  }

  /** An item the host does not report as numeric is shown as text, whatever its type name (aliases included). */
  isText(symbol: string): boolean {
    const it = this.items.find(i => i.symbol === symbol);
    return it !== undefined && !it.numeric;
  }

  /** Changes of the symbol since fromMs; a window longer than the buffer is clamped to the buffer, like the numeric series. */
  changes(symbol: string, fromMs: number): ChangeLog {
    return this.log.changes(symbol, fromMs, this.newest, this.ms);
  }

  series(symbol: string, fromMs: number): Point[] {
    return (this.series_.get(symbol) ?? []).filter(p => p.t >= fromMs);
  }

  summary(symbol: string, seconds: number, now: number): { min: number; max: number; last: string | null; count: number } | undefined {
    const pts = this.series(symbol, now - seconds * 1000);
    if (pts.length === 0) return undefined;
    let min = Infinity, max = -Infinity;
    for (const p of pts) { if (p.y < min) min = p.y; if (p.y > max) max = p.y; }
    return { min, max, last: this.latest_.get(symbol)?.value ?? null, count: pts.length };
  }

  private trim(): void {
    const cap = Math.max(1, Math.floor(this.maxValues / Math.max(1, this.items.length)));
    const cutoff = this.newest - this.ms;
    for (const s of this.series_.values()) {
      let n = 0;
      while (n < s.length && s[n].t < cutoff) n++;
      n = Math.max(n, s.length - cap);
      if (n > 0) s.splice(0, n);
    }
    this.log.trim(this.newest, this.ms, this.items.length);
  }
}

// Min and max per bucket (in time order) so a one-sample spike survives thinning.
export function minMaxBuckets(points: Point[], buckets: number): Point[] {
  if (points.length <= buckets * 2) return points;
  const out: Point[] = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size), to = Math.min(points.length, Math.floor((b + 1) * size));
    if (from >= to) continue;
    let lo = points[from], hi = points[from];
    for (let i = from + 1; i < to; i++) {
      if (points[i].y < lo.y) lo = points[i];
      if (points[i].y > hi.y) hi = points[i];
    }
    if (lo === hi) out.push(lo);
    else if (lo.t <= hi.t) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}

export function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  if (max < 2) return rows.slice(0, Math.max(0, max));
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * (rows.length - 1) / (max - 1))]);
  return out;
}

/**
 * Thins rows to at most `max` without losing a value change: both rows around every transition stay (the last of a
 * run and the first of the next). Only when the transitions alone exceed `max` are the newest `max` rows returned;
 * `droppedChanges` counts the transitions that are then missing, so the caller can say so.
 */
export function thinKeepingChanges<T>(rows: T[], max: number, differs: (a: T, b: T) => boolean): { rows: T[]; changes: number; droppedChanges: number } {
  const edge = rows.map((r, i) => i > 0 && differs(rows[i - 1], r));
  const changes = edge.filter(Boolean).length;
  if (rows.length <= max) return { rows, changes, droppedChanges: 0 };
  const keep = rows.filter((_, i) => i === 0 || i === rows.length - 1 || edge[i] || edge[i + 1]);
  if (keep.length <= max) return { rows: keep, changes, droppedChanges: 0 };
  const from = rows.length - Math.max(0, max);
  return { rows: rows.slice(from), changes, droppedChanges: edge.slice(0, from + 1).filter(Boolean).length };
}

/** Adds evenly spaced rows of `all` to `kept` until `max` rows are shown; the result keeps the order of `all`. */
export function fillEvenly<T>(all: T[], kept: T[], max: number): T[] {
  const have = new Set(kept);
  const rest = all.filter(r => !have.has(r));
  const room = Math.min(rest.length, Math.max(0, max - kept.length));
  for (let i = 0; i < room; i++) have.add(rest[room === 1 ? 0 : Math.round(i * (rest.length - 1) / (room - 1))]);
  return all.filter(r => have.has(r));
}

/** No reply within the time limit; for a write that was sent, the outcome is unknown. */
export class RequestTimeout extends Error {}

/** The host exited or was stopped while a request was open. */
export class HostGone extends Error {}

/** The host answered ok:false. `written: "no"` is its proof that a write was not sent (cli/README.md, "Live values"). */
export class HostError extends Error {
  constructor(message: string, readonly written?: string) { super(message); }
}

export type WriteStage =
  | { kind: 'written'; value: string | null; readBackError?: string }
  | { kind: 'notSent'; reason: string }
  | { kind: 'unknown'; reason: string };

/**
 * How far a write got, from the host's reply data or from the rejection of the request. "Not sent" needs the host's proof
 * (`written: "no"`); everything else that failed is unknown, so an older CLI without the field never yields "not sent".
 */
export function writeStage(outcome: { data: unknown } | { error: unknown }): WriteStage {
  if ('data' in outcome) {
    const d = (outcome.data ?? {}) as { value?: unknown; readBackError?: unknown };
    const stage: WriteStage = { kind: 'written', value: typeof d.value === 'string' ? d.value : null };
    if (typeof d.readBackError === 'string') stage.readBackError = d.readBackError;
    return stage;
  }
  const e = outcome.error;
  const reason = e instanceof Error ? e.message : String(e);
  return e instanceof HostError && e.written === 'no' ? { kind: 'notSent', reason } : { kind: 'unknown', reason };
}

// A write cannot be retried blindly, so a timeout says the outcome is unknown. An id added again while still open
// rejects the older request, which could otherwise never settle.
export class PendingRequests {
  private open = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onData?: (data: unknown) => void }>();

  /** onData runs synchronously inside settle for an ok reply, before the promise resolves (a throw rejects it). */
  add(id: number, timeoutMs: number, onData?: (data: unknown) => void): Promise<unknown> {
    const old = this.open.get(id);
    if (old) {
      this.open.delete(id);
      clearTimeout(old.timer);
      old.reject(new Error(`Request ${id} was replaced by a newer one with the same id.`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.open.get(id)?.timer === timer) this.open.delete(id);
        reject(new RequestTimeout(`No reply from the ADS host within ${timeoutMs} ms; the outcome is unknown.`));
      }, timeoutMs);
      this.open.set(id, { resolve, reject, timer, onData });
    });
  }

  settle(msg: { id: number | null; ok: boolean; data?: unknown; error?: string; written?: string }): void {
    if (msg.id === null) return;
    const p = this.open.get(msg.id);
    if (!p) return;
    this.open.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) {
      try {
        p.onData?.(msg.data);
        p.resolve(msg.data);
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
    } else p.reject(new HostError(msg.error ?? 'request failed', msg.written));
  }

  rejectAll(reason: string): void {
    for (const p of this.open.values()) { clearTimeout(p.timer); p.reject(new HostGone(reason)); }
    this.open.clear();
  }
}

const STALE_MS = 2000;

/** "<n> s old" for a sample older than 2 s, else undefined (also without a sample time). */
export function sampleAge(newestMs: number | undefined, nowMs: number): string | undefined {
  if (newestMs === undefined || nowMs - newestMs < STALE_MS) return undefined;
  return `${Math.round((nowMs - newestMs) / 1000)} s old`;
}

/** Tells why values may be missing: samples only arrive while the watch view or the scope keeps the host alive. */
export function gapNote(newestMs: number | undefined, nowMs: number, clock: (ms: number) => string, extra?: string): string | undefined {
  const tail = 'sampling only runs while the ADS Watch view or the ADS Scope is open.';
  if (newestMs === undefined) return `No samples yet: ${tail}`;
  return nowMs - newestMs < STALE_MS ? undefined : `No samples since ${clock(newestMs)}: ${tail}${extra ? ` ${extra}` : ''}`;
}

/** Why the host process last ended and when; kept across a reconnect (the state only holds the current error). */
export interface HostEnd { reason: string; at: number }

/**
 * What the host says about a stall: its last message, why it last ended (only when that end is not older than the
 * newest sample, so it can explain the gap), or that it is not connected. Undefined when there is nothing to add.
 */
export function hostNote(state: { connected: boolean; error?: string } | undefined, ended: HostEnd | undefined, clock: (ms: number) => string, newestMs?: number): string | undefined {
  const parts: string[] = [];
  if (state?.error) parts.push(`Last host message: ${oneLine(state.error)}`);
  if (ended && (newestMs === undefined || ended.at >= newestMs)) parts.push(`The ADS host ended at ${clock(ended.at)}: ${oneLine(ended.reason)}`);
  if (parts.length === 0 && state && !state.connected) parts.push('The ADS host is not connected.');
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Most symbols that get a column in the scope table (the summaries cover all of them). */
export const MAX_SCOPE_COLUMNS = 20;

/** One-line text for a summary: cut at 80 characters with "...", backslash, quote, CR, LF and TAB escaped, quoted when `quote`. */
const ESCAPES: Record<string, string> = { "\\": "\\\\", '"': '\\"', "\r": "\\r", "\n": "\\n", "\t": "\\t" };
function shownText(text: string, quote: boolean): string {
  const cut = text.length > 80 ? `${text.slice(0, 80)}...` : text;
  const e = cut.replace(/[\\"\r\n\t]/g, c => (c === '"' && !quote ? c : ESCAPES[c]));
  return quote ? `"${e}"` : e;
}

function summaryLine(buf: ScopeBuffer, s: string, seconds: number, now: number, d: number | undefined): string {
  const sum = buf.summary(s, seconds, now);
  const log = buf.changes(s, now - seconds * 1000);
  const ch = changeEntries(log);
  const newest = log.entries.at(-1) ?? log.start;
  const when = (e: { t: number; after?: number }) => (e.after === undefined ? `${relSeconds(e.t, now)} s` : `unknown (between ${relSeconds(e.after, now)} and ${relSeconds(e.t, now)} s)`);
  const times = ch.length === 0 ? '' : log.olderDropped
    ? ` (older changes dropped; first retained at ${when(ch[0])}, last at ${when(ch[ch.length - 1])})`
    : ` (first at ${when(ch[0])}, last at ${when(ch[ch.length - 1])})`;
  const count = `changes${log.olderDropped ? '>=' : '='}${ch.length}`;
  const failed = log.failedSince === undefined ? '' : ` reading failed since ${relSeconds(log.failedSince, now)} s (last valid at ${relSeconds(log.lastValidT ?? log.failedSince, now)} s)`;
  if (sum) {
    const last = log.failedSince !== undefined && newest ? newest.text : sum.last;
    return `${s}: min=${formatNumber(sum.min, d)} max=${formatNumber(sum.max, d)} last=${formatValueText(last, d)} count=${sum.count}${ch.length > 0 ? ` ${count}${times}` : ''}${failed}`;
  }
  if (newest) return `${s}: ${count} last=${shownText(newest.text, buf.isText(s))}${times}${failed}`;
  return `${s}: no numeric samples in the last ${seconds} s, last=${buf.latest(s)?.value ?? 'n/a'}`;
}

/** The cell of a symbol whose start value the entry cap removed. */
export const UNKNOWN_START = 'unknown (history dropped)';

/** `maxChars` is the budget of the whole text (see assemble); unset means no limit. */
export interface ScopeOptions { maxRows?: number; maxColumns?: number; decimals?: number; changesOnly?: boolean; edges?: boolean; maxChars?: number }

/** Integers unchanged; other numbers rounded with toFixed(decimals); decimals undefined = String(n). */
export function formatNumber(n: number, decimals?: number): string {
  if (decimals === undefined || Number.isInteger(n)) return String(n);
  const r = n.toFixed(decimals);
  return /^-0(.0*)?$/.test(r) ? r.slice(1) : r;
}

/** A numeric text with a fraction or exponent is rounded to `decimals`; everything else (also null) is returned as is. */
export function formatValueText(text: string | null, decimals?: number): string | null {
  if (text === null || decimals === undefined || !NUMBER.test(text) || /^[+-]?\d+$/.test(text)) return text;
  return formatNumber(Number(text), decimals);
}

/** The pieces of a scope answer; `assemble` joins them and keeps the whole text inside a character budget. */
interface ScopeParts { summaries: string[]; notes: string[]; header?: string; rows: string[]; footer: string[] }

/** Most summaries kept when the budget forces them to be cut (the footer and the newest rows are cut last or never). */
const MAX_BUDGET_SUMMARIES = 50;

function joinParts(p: ScopeParts, summaries: string[], notes: string[], rows: string[]): string {
  const lines = [...summaries];
  if (p.header !== undefined) lines.push('', ...notes, p.header, ...rows, ...p.footer);
  return lines.join('\n');
}

/**
 * Joins the parts. Over the budget, the oldest table rows go first (with a note), then summaries beyond the first
 * MAX_BUDGET_SUMMARIES (with a count); the header, the notes and the footer stay.
 */
function assemble(p: ScopeParts, maxChars: number): string {
  const whole = joinParts(p, p.summaries, p.notes, p.rows);
  if (whole.length <= maxChars) return whole;
  let summaries = p.summaries;
  const cutSummaries = () => [...summaries.slice(0, MAX_BUDGET_SUMMARIES), `(${summaries.length - MAX_BUDGET_SUMMARIES} more summaries not shown: output size limit)`];
  if (p.header === undefined) {
    if (summaries.length > MAX_BUDGET_SUMMARIES) summaries = cutSummaries();
    return summaries.join('\n');
  }
  const fit = (): { text: string; kept: number } => {
    const note = (n: number) => `${n} earlier rows not shown (output size limit), narrow seconds or symbols`;
    const base = joinParts(p, summaries, [...p.notes, note(p.rows.length)], []).length;
    let room = maxChars - base, kept = 0;
    for (let i = p.rows.length - 1; i >= 0 && room >= p.rows[i].length + 1; i--) { room -= p.rows[i].length + 1; kept++; }
    const rows = p.rows.slice(p.rows.length - kept);
    return { kept, text: joinParts(p, summaries, kept < p.rows.length ? [...p.notes, note(p.rows.length - kept)] : p.notes, rows) };
  };
  let r = fit();
  if (r.text.length > maxChars && summaries.length > MAX_BUDGET_SUMMARIES) {
    summaries = cutSummaries();
    r = fit();
  }
  return r.text;
}

/** Rising and falling edges of BOOL symbols with their times; other symbols are named as ignored. */
export function edgesText(buf: ScopeBuffer, symbols: string[], seconds: number, now: number, opts: ScopeOptions = {}): string {
  const from = now - seconds * 1000;
  const t = edgesTable(symbols.map(name => ({ name, type: buf.typeOf(name), log: buf.changes(name, from) })), { now, seconds, requestedStart: from, maxRows: opts.maxRows ?? 200 });
  return assemble({ summaries: t.summaries, notes: t.notes, header: t.header, rows: t.rows, footer: [] }, opts.maxChars ?? Infinity);
}

// Summary per symbol plus a tab-separated table (seconds relative to now) of at most maxRows rows and maxColumns symbols.
export function scopeText(buf: ScopeBuffer, symbols: string[], seconds: number, now: number, opts: ScopeOptions = {}): string {
  if (opts.edges) return edgesText(buf, symbols, seconds, now, opts);
  const maxRows = opts.maxRows ?? 200;
  const maxColumns = opts.maxColumns ?? MAX_SCOPE_COLUMNS;
  const d = opts.decimals;
  const budget = opts.maxChars ?? Infinity;
  const parts: ScopeParts = { summaries: symbols.map(s => summaryLine(buf, s, seconds, now, d)), notes: [], rows: [], footer: [] };
  const shown = symbols.slice(0, maxColumns);
  const columnsNote = symbols.length > shown.length ? [`(table columns: first ${shown.length} of ${symbols.length} symbols; the summaries above cover all of them)`] : [];
  if (opts.changesOnly) {
    const from = now - seconds * 1000;
    const table = changesTable(shown, shown.map(s => buf.changes(s, from)), {
      now, requestedStart: from, maxRows, unknownText: UNKNOWN_START,
      cell: (i, text) => (buf.isText(shown[i]) ? shownText(text, true) : formatValueText(text, d) ?? ''),
    });
    if (table.rows.length === 0 && table.notes.length === 0) return assemble(parts, budget);
    return assemble({ ...parts, notes: table.notes, header: table.header, rows: table.rows, footer: columnsNote }, budget);
  }
  const shownMaps = shown.map(s => new Map(buf.series(s, now - seconds * 1000).map(p => [p.t, p.y] as const)));
  const times = [...new Set(shownMaps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  if (times.length === 0) return assemble(parts, budget);
  // A column that changes in more than a quarter of maxRows places is a continuous signal: its changes are not
  // events, so it is thinned evenly; the other columns keep every change.
  const changeCount = (m: Map<number, number>) => times.reduce((n, t, i) => n + (i > 0 && m.get(t) !== m.get(times[i - 1]) ? 1 : 0), 0);
  const fast = shownMaps.map(m => changeCount(m) > Math.max(maxRows / 4, 10));
  const slowMaps = shownMaps.filter((_, i) => !fast[i]);
  const thin = thinKeepingChanges(times, maxRows, (a, b) => slowMaps.some(m => m.get(a) !== m.get(b)));
  const rowsShown = thin.droppedChanges === 0 && fast.some(Boolean) ? fillEvenly(times, thin.rows, maxRows) : thin.rows;
  if (rowsShown.length < times.length) {
    const lost = thin.droppedChanges > 0 ? `; ${thin.droppedChanges} earlier changes not shown, narrow seconds or symbols` : ' kept';
    const events = slowMaps.length > 0 ? `, ${thin.changes} value changes${lost}` : '';
    const thinned = fast.some(Boolean) ? `; evenly thinned (fast-changing): ${shown.filter((_, i) => fast[i]).join(', ')}` : '';
    parts.notes.push(`${rowsShown.length} of ${times.length} samples shown${events}${thinned}`);
  }
  parts.header = ['t[s]', ...shown].join('\t');
  parts.rows = rowsShown.map(t => [((t - now) / 1000).toFixed(3), ...shownMaps.map(m => { const y = m.get(t); return y === undefined ? '' : formatNumber(y, d); })].join('\t'));
  parts.footer = columnsNote;
  return assemble(parts, budget);
}

const NETID = /^\d{1,3}(\.\d{1,3}){5}$/;

/** The host (WatchHost.MaxSymbols) rejects longer lists. */
export const MAX_WATCHED = 200;

/** Sample interval in ms, as the host accepts it (the setting has the same bounds). */
export const clampInterval = (ms: number): number => Math.min(5000, Math.max(10, Math.round(Number(ms) || 100)));
/** Scope buffer length in seconds (the setting has the same bounds). */
export const clampBufferSeconds = (s: number): number => Math.min(3600, Math.max(10, Math.round(Number(s) || 300)));

/** Why a watch list of `count` symbols can't be watched, or undefined. Checked before the list is saved. */
export function watchLimitError(count: number): string | undefined {
  return count > MAX_WATCHED ? `At most ${MAX_WATCHED} variables can be watched (this list has ${count}). Remove some first.` : undefined;
}

/** A saved watch entry; `ai` marks entries the AI added, the only ones it may remove (O10). */
export interface WatchEntry { symbol: string; ai: boolean }

/** The saved list (workspaceState): entries, or a plain string array saved before the `ai` flag existed. */
export function parseWatchList(raw: unknown): WatchEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchEntry[] = [];
  for (const x of raw) {
    if (typeof x === 'string') out.push({ symbol: x, ai: false });
    else if (x && typeof x === 'object' && typeof x.symbol === 'string') out.push({ symbol: x.symbol, ai: x.ai === true });
  }
  return out;
}

/**
 * Adds and removes symbols (ADS names are case-insensitive), keeping the order. With `byAi` new entries are marked
 * `ai` and `remove` drops only `ai` entries, so the AI cannot take away what the user watches (O10). The user adding
 * a symbol the AI added makes the entry the user's.
 */
export function watchEdit(current: WatchEntry[], add: string[] = [], remove: string[] = [], byAi = false): WatchEntry[] {
  const out = [...current];
  const seen = new Set(out.map(e => e.symbol.toLowerCase()));
  for (const s of add.map(x => x.trim())) {
    if (!s) continue;
    if (seen.has(s.toLowerCase())) {
      if (!byAi) out.forEach((e, i) => { if (e.ai && e.symbol.toLowerCase() === s.toLowerCase()) out[i] = { ...e, ai: false }; });
      continue;
    }
    seen.add(s.toLowerCase());
    out.push({ symbol: s, ai: byAi });
  }
  const drop = new Set(remove.map(x => x.trim().toLowerCase()));
  return out.filter(e => !drop.has(e.symbol.toLowerCase()) || (byAi && !e.ai));
}

/**
 * Renames one watched symbol in place (user edit): the entry keeps its position and becomes the user's. If the new
 * name is already watched, the old entry just goes away. An empty new name changes nothing.
 */
export function watchRename(current: WatchEntry[], from: string, to: string): WatchEntry[] {
  const next = to.trim();
  if (!next) return current;
  const at = current.findIndex(e => e.symbol.toLowerCase() === from.trim().toLowerCase());
  if (at < 0) return current;
  const exists = current.some((e, i) => i !== at && e.symbol.toLowerCase() === next.toLowerCase());
  return exists ? current.filter((_, i) => i !== at) : current.map((e, i) => (i === at ? { symbol: next, ai: false } : e));
}

/**
 * What an AI write does per `iecode.ads.aiWrites`; an unknown value refuses, like the default `off`.
 * `auto` asks anyway while the workspace settings redirect target or port: a cloned repo must not choose
 * where auto-approved writes go.
 */
export function aiWriteDecision(setting: string, workspaceTarget = false): 'refuse' | 'confirm' | 'allow' {
  return setting === 'confirm' ? 'confirm' : setting === 'auto' ? (workspaceTarget ? 'confirm' : 'allow') : 'refuse';
}

export type WriteDecision = ReturnType<typeof aiWriteDecision>;

/**
 * True if a write may go ahead with the decision `now` at invoke time, given the one its prepare step used
 * (`undefined`: none known). `confirm` now needs the confirmation of the prepare step; if the settings got stricter in
 * between, the laxer prepare step must not count and the AI is asked to retry instead.
 */
export function writeStillApproved(prepared: WriteDecision | undefined, now: WriteDecision): boolean {
  return now === 'allow' || (now === 'confirm' && prepared === 'confirm');
}

/** Shape of `WorkspaceConfiguration.inspect()` that matters here. */
export interface SettingLayers<T> { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }

/** True if a workspace or folder value of the setting differs from the user value (or the default without one). */
export function workspaceOverrides<T>(i: SettingLayers<T> | undefined): boolean {
  if (!i) return false;
  const user = i.globalValue ?? i.defaultValue;
  return [i.workspaceValue, i.workspaceFolderValue].some(v => v !== undefined && v !== user);
}

/** AI-supplied text for a log line or prompt: line breaks become literal \r / \n so they cannot fake extra lines. */
export function oneLine(s: string): string {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/** Why the target / port settings can't be used, or undefined. Checked before spawning the host. */
export function settingsError(s: { target: string; port: number }): string | undefined {
  if (s.target.toLowerCase() !== 'local' && !(NETID.test(s.target) && s.target.split('.').every(n => Number(n) <= 255)))
    return `iecode.ads.target "${s.target}" is neither "local" nor an AMS NetId (six numbers, e.g. 192.168.1.10.1.1).`;
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)
    return `iecode.ads.port ${s.port} is not a port number (1 … 65535).`;
  return undefined;
}

/**
 * ADS name of the word at the cursor in an ST view: qualified with the object name when the word's first part is
 * declared in a PROGRAM or GVL (ADS names are MAIN.x / GVL.x); else unqualified, for the user to complete.
 */
export function symbolAt(text: string, word: string, file: string): { name: string; qualified: boolean } {
  const base = file.split(/[\\/]/).pop() ?? '';
  const gvl = /\.TcGVL$/i.test(base) ? base.replace(/\.TcGVL$/i, '') : undefined;
  const object = gvl ?? /^\s*PROGRAM\s+([A-Za-z_]\w*)/im.exec(text)?.[1];
  if (!object || !word) return { name: word, qualified: false };
  if (word.toLowerCase().startsWith(object.toLowerCase() + '.')) return { name: word, qualified: true };
  // the selection is free text (`a(b`, `arr[1]`): matched literally
  const first = word.split('.')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a declaration "x : INT", "x, y : INT" or "x AT %I* : BOOL", not an assignment "x := 1"
  const declared = new RegExp(`^\\s*${first}\\s*(,|:(?!=)|AT\\b)`, 'im').test(text);
  return declared ? { name: `${object}.${word}`, qualified: true } : { name: word, qualified: false };
}

export const SCOPE_SPANS = [10, 30, 60, 300];

// Offers a span only while the buffer holds data for the span before it, so the select never promises history
// that does not exist; the smallest span is always there.
export function spanOptions(heldSeconds: number): number[] {
  return SCOPE_SPANS.filter((_, i) => i === 0 || SCOPE_SPANS[i - 1] < heldSeconds);
}

// Axis tick values on 1/2/5 x 10^n steps covering [min, max]; about `count` ticks.
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min) || count < 1) return [min];
  const raw = (max - min) / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  for (let i = first; i * step <= max + step * 1e-9; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}
