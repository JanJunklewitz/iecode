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

// The CLI may print other text (build output, warnings) on stdout; those lines are not messages.
export function parseHostLine(line: string): HostMessage | undefined {
  const s = line.trim();
  if (!s.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(s);
    return o && typeof o === 'object' ? o as HostMessage : undefined;
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

// A write cannot be retried blindly, so a timeout says the outcome is unknown.
export class PendingRequests {
  private open = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  add(id: number, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.open.delete(id);
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
