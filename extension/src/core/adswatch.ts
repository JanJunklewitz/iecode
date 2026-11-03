// Pure logic for live ADS values: messages of the `iecode ads serve` host, a bounded sample buffer
// and the text form handed to LM tools. No vscode imports; the host process and views live elsewhere.

export const PROTOCOL = 1;

export interface WatchItem { symbol: string; type: string; numeric: boolean; error: string | null }
interface Row { t: number; v: (string | null)[]; e?: (number | null)[] }

export type HostMessage =
  | { event: 'hello'; protocol: number }
  | { event: 'samples'; gen: number; rows: Row[] }
  | { event: 'state'; connected: boolean; error?: string }
  | { event: 'items'; gen: number; items: WatchItem[] }
  | { id: number | null; ok: boolean; data?: unknown; error?: string; adsCode?: number };

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

  constructor(seconds: number, private readonly maxValues = 2_000_000) {
    this.ms = seconds * 1000;
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
    this.trim();
  }

  push(gen: number, rows: Row[]): void {
    if (gen !== this.gen) return;
    for (const r of rows) {
      this.newest = Math.max(this.newest, r.t);
      this.items.forEach((it, i) => {
        const text = r.v[i] ?? null;
        this.latest_.set(it.symbol, { t: r.t, value: text });
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

  latest(symbol: string): { t: number; value: string | null } | undefined {
    return this.latest_.get(symbol);
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

// A write cannot be retried blindly, so a timeout says the outcome is unknown. An id added again while still open
// rejects the older request, which could otherwise never settle.
export class PendingRequests {
  private open = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  add(id: number, timeoutMs: number): Promise<unknown> {
    const old = this.open.get(id);
    if (old) {
      this.open.delete(id);
      clearTimeout(old.timer);
      old.reject(new Error(`Request ${id} was replaced by a newer one with the same id.`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.open.get(id)?.timer === timer) this.open.delete(id);
        reject(new Error(`No reply from the ADS host within ${timeoutMs} ms; the outcome is unknown.`));
      }, timeoutMs);
      this.open.set(id, { resolve, reject, timer });
    });
  }

  settle(msg: { id: number | null; ok: boolean; data?: unknown; error?: string }): void {
    if (msg.id === null) return;
    const p = this.open.get(msg.id);
    if (!p) return;
    this.open.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error ?? 'request failed'));
  }

  rejectAll(reason: string): void {
    for (const p of this.open.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.open.clear();
  }
}

// Summary per symbol plus a tab-separated table (seconds relative to now) of at most maxRows rows.
export function scopeText(buf: ScopeBuffer, symbols: string[], seconds: number, now: number, maxRows = 200): string {
  const lines: string[] = [];
  const maps = symbols.map(s => new Map(buf.series(s, now - seconds * 1000).map(p => [p.t, p.y] as const)));
  for (const s of symbols) {
    const sum = buf.summary(s, seconds, now);
    lines.push(sum
      ? `${s}: min=${sum.min} max=${sum.max} last=${sum.last} count=${sum.count}`
      : `${s}: no numeric samples in the last ${seconds} s, last=${buf.latest(s)?.value ?? 'n/a'}`);
  }
  const times = [...new Set(maps.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  if (times.length > 0) {
    lines.push('', ['t[s]', ...symbols].join('\t'));
    for (const t of downsample(times, maxRows)) {
      lines.push([((t - now) / 1000).toFixed(3), ...maps.map(m => m.get(t) ?? '')].join('\t'));
    }
  }
  return lines.join('\n');
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
