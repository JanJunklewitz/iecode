// Log format definitions and single-line parsing for the log viewer. No vscode imports.

export type Level = 'error' | 'warning' | 'info' | 'debug' | 'other';
/** Order used for the Uint8 level column. */
export const LEVELS: Level[] = ['error', 'warning', 'info', 'debug', 'other'];

export interface LogFormatDef {
  id: string;
  name: string;
  entry: string;
  timeFormat?: string;
  levels?: Record<string, Level>;
  ignore?: string;
}

export interface LogFormat {
  def: LogFormatDef;
  entry: RegExp;
  ignore?: RegExp;
  time?: { re: RegExp; order: string[] };
  /** def.levels with lower-cased keys, built once by compileFormat for the scan hot path. */
  levelMap?: Map<string, Level>;
}

export interface ParsedLine {
  seq?: number;
  time: number;
  timeText: string;
  level: Level;
  levelText: string;
  source: string;
  message: string;
}

export class LogFormatError extends Error {}

/** Every regex sees at most this many characters of a line. */
const MAX_MATCH = 8192;

const STANDARD_LEVELS: Record<string, Level> = {
  error: 'error', fatal: 'error', critical: 'error',
  warning: 'warning', warn: 'warning',
  info: 'info',
  debug: 'debug',
};

export const BUILT_IN_FORMATS: LogFormatDef[] = [
  {
    id: 'twincat-logger',
    name: 'TwinCAT logger',
    entry: '^(?<seq>\\d{10}) - (?<time>\\S+) - (?<level>[A-Za-z]+) - (?<source>.*?) - (?<message>.*)$',
    timeFormat: 'yyyy-MM-dd-HH:mm:ss.SSS',
    levels: STANDARD_LEVELS,
    ignore: '^Sequence\\s+- Timestamp - Category - Source - Message\\s*$',
  },
  {
    id: 'tab-separated',
    name: 'Tab separated',
    entry: '^(?<time>\\d{2}\\.\\d{2}\\.\\d{4} \\d{2}:\\d{2}:\\d{2})\\t(?<level>[^\\t]+)\\t(?<message>.*)$',
    timeFormat: 'dd.MM.yyyy HH:mm:ss',
    levels: STANDARD_LEVELS,
  },
  {
    id: 'plain',
    name: 'Plain text',
    entry: '^(?<message>.*\\S.*)$',
  },
];

const PLAIN_LEVEL = /\b(error|warn|warning|info|debug)\b/i;

const TIME_TOKENS = /yyyy|MM|dd|HH|mm|ss|SSS/g;
const TOKEN_WIDTH: Record<string, number> = { yyyy: 4, MM: 2, dd: 2, HH: 2, mm: 2, ss: 2, SSS: 3 };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
}

function compileTime(timeFormat: string): { re: RegExp; order: string[] } {
  const order: string[] = [];
  let src = '';
  let pos = 0;
  for (const m of timeFormat.matchAll(TIME_TOKENS)) {
    src += escapeRegex(timeFormat.slice(pos, m.index));
    src += `(\\d{${TOKEN_WIDTH[m[0]]}})`;
    order.push(m[0]);
    pos = m.index! + m[0].length;
  }
  src += escapeRegex(timeFormat.slice(pos));
  return { re: new RegExp(`^${src}$`), order };
}

export function compileFormat(def: LogFormatDef): LogFormat {
  const make = (src: string, what: string): RegExp => {
    try {
      return new RegExp(src);
    } catch (e) {
      throw new LogFormatError(`Invalid ${what} regex in log format '${def.id}': ${(e as Error).message}`);
    }
  };
  const entry = make(def.entry, 'entry');
  if (!/\(\?<message>/.test(def.entry)) {
    throw new LogFormatError(`The entry regex of log format '${def.id}' needs a (?<message>...) group`);
  }
  const f: LogFormat = { def, entry };
  if (def.ignore) f.ignore = make(def.ignore, 'ignore');
  if (def.levels) f.levelMap = new Map(Object.entries(def.levels).map(([k, v]) => [k.toLowerCase(), v]));
  if (def.timeFormat) {
    try {
      f.time = compileTime(def.timeFormat);
    } catch (e) {
      throw new LogFormatError(`Invalid time format in log format '${def.id}': ${(e as Error).message}`);
    }
  }
  return f;
}

function utc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number {
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (Number.isNaN(t)) return NaN;
  const c = new Date(t);
  // Round trip: an overflowing component (Feb 30, hour 24) would be normalized silently otherwise.
  if (c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d ||
      c.getUTCHours() !== h || c.getUTCMinutes() !== mi || c.getUTCSeconds() !== s || c.getUTCMilliseconds() !== ms) {
    return NaN;
  }
  return t;
}

/** Wall-clock time (no time zone) as Date.UTC milliseconds; NaN when the text does not match. */
export function parseTime(f: LogFormat, text: string): number {
  if (!f.time) return NaN;
  const m = f.time.re.exec(text);
  if (!m) return NaN;
  const v: Record<string, number> = { yyyy: 1970, MM: 1, dd: 1, HH: 0, mm: 0, ss: 0, SSS: 0 };
  f.time.order.forEach((tok, i) => { v[tok] = Number(m[i + 1]); });
  return utc(v.yyyy, v.MM, v.dd, v.HH, v.mm, v.ss, v.SSS);
}

/** 'yyyy-MM-dd HH:mm[:ss]' as wall-clock Date.UTC; NaN when invalid. Never uses the local time zone. */
export function parseFilterTime(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return NaN;
  return utc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0, 0);
}

/** Text of a time filter input: {} when empty (open end), {ms} when valid, {error} for the webview otherwise. */
export function parseFilterTimeInput(text: string): { ms?: number; error?: string } {
  if (text.trim() === '') return {};
  const ms = parseFilterTime(text);
  return Number.isNaN(ms) ? { error: 'Invalid time, expected yyyy-MM-dd HH:mm:ss' } : { ms };
}

export type LineKind = { kind: 'entry'; entry: ParsedLine } | { kind: 'continuation' } | { kind: 'ignored' };

function mapLevel(f: LogFormat, levelText: string, message: string): Level {
  if (f.def.id === 'plain') {
    const m = PLAIN_LEVEL.exec(message);
    if (!m) return 'other';
    const w = m[1].toLowerCase();
    return w === 'warn' || w === 'warning' ? 'warning' : (w as Level);
  }
  if (!levelText) return 'other';
  return f.levelMap?.get(levelText.toLowerCase()) ?? 'other';
}

export function parseLine(f: LogFormat, line: string): LineKind {
  const head = line.length > MAX_MATCH ? line.slice(0, MAX_MATCH) : line;
  if (f.ignore && f.ignore.test(head)) return { kind: 'ignored' };
  const m = f.entry.exec(head);
  if (!m) return { kind: 'continuation' };
  const g = m.groups ?? {};
  const timeText = g.time ?? '';
  const levelText = g.level ?? '';
  const message = g.message ?? '';
  const e: ParsedLine = {
    time: timeText ? parseTime(f, timeText) : NaN,
    timeText,
    level: mapLevel(f, levelText, message),
    levelText,
    source: g.source ?? '',
    message,
  };
  if (g.seq !== undefined) e.seq = Number(g.seq);
  return { kind: 'entry', entry: e };
}

const SAMPLE_LINES = 200;
const MIN_RATIO = 0.3;

/** Picks the format that matches most sampled lines (at least 30 %); falls back to 'plain'. Never throws. */
export function detectFormat(lines: string[], formats: LogFormat[]): LogFormat {
  const fallback = formats.find(f => f.def.id === 'plain') ?? compileFormat(BUILT_IN_FORMATS[2]);
  let best: LogFormat | undefined;
  let bestRatio = 0;
  for (const f of formats) {
    if (f.def.id === 'plain') continue;
    let sampled = 0;
    let hits = 0;
    for (const line of lines) {
      if (sampled >= SAMPLE_LINES) break;
      if (line.trim() === '') continue;
      let r: LineKind;
      try {
        r = parseLine(f, line);
      } catch {
        continue;
      }
      if (r.kind === 'ignored') continue;
      sampled++;
      if (r.kind === 'entry') hits++;
    }
    if (sampled === 0) continue;
    const ratio = hits / sampled;
    if (ratio >= MIN_RATIO && ratio > bestRatio) {
      best = f;
      bestRatio = ratio;
    }
  }
  return best ?? fallback;
}
