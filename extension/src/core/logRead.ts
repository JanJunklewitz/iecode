// Reads new lines of a TwinCAT log folder since a byte-offset marker. Pure: all file access goes through LogFs.
// Lines are split on the byte 0x0A and decoded one by one, so offsets are byte offsets and a character is never split.

import * as path from 'path';

export interface LogFile { name: string; size: number }
export interface LogFs {
  /** The `*.log` files of the directory, in any order. */
  list(): Promise<LogFile[]>;
  /** Up to `length` bytes from `from`; fewer at the end of the file. */
  read(name: string, from: number, length: number): Promise<Buffer>;
}
export interface LogMarker { file: string; offset: number }

export const MAX_LOG_LINES = 500;
export const DEFAULT_LOG_LINES = 100;
/** Bytes read per call at most. */
export const SCAN_LIMIT_BYTES = 16 * 1024 * 1024;
/** Tail mode reads at most this much from the end of the newest file. */
export const TAIL_BYTES = 256 * 1024;
/** A longer line is cut to this length. */
export const MAX_LINE_BYTES = 1024 * 1024;
export const READ_CHUNK_BYTES = 1024 * 1024;
/** Characters of kept lines per call at most (the tool text is capped at 50,000 and must keep room for the marker). */
export const LOG_TEXT_BUDGET = 40_000;

export interface LogQuery { since?: LogMarker; filter: string[]; exclude: string[]; maxLines: number }
export interface LogRead { lines: string[]; next: LogMarker; more: boolean; scannedLines: number; notes: string[]; file: string }

export const encodeMarker = (m: LogMarker): string => `${m.file}@${m.offset}`;

export function decodeMarker(s: string): LogMarker | undefined {
  const at = s.lastIndexOf('@');
  if (at < 1) return undefined;
  const file = s.slice(0, at), digits = s.slice(at + 1);
  if (file.length > 255 || /[\u0000-\u001f\u007f/\\:]/.test(file) || file.includes('..')) return undefined;
  if (!/^\d{1,15}$/.test(digits)) return undefined;
  return { file, offset: Number(digits) };
}

/** Any filter item (empty filter keeps all) and no exclude item; case-insensitive substring. */
export function lineMatches(line: string, filter: string[], exclude: string[]): boolean {
  return matchesLower(line, filter.map(x => x.toLowerCase()), exclude.map(x => x.toLowerCase()));
}
const matchesLower = (line: string, filter: string[], exclude: string[]): boolean => {
  const l = line.toLowerCase();
  if (exclude.some(x => l.includes(x))) return false;
  return filter.length === 0 || filter.some(x => l.includes(x));
};

/** The setting `iecode.ads.logDirectory` as a value: a full path, or the reason it cannot be used. */
export function checkLogDirectory(v: unknown, platform: NodeJS.Platform = process.platform): { dir: string } | { problem: string } {
  if (typeof v !== 'string' || !v.trim()) return { problem: 'no log directory set. Set iecode.ads.logDirectory in the user settings to the folder of the TwinCAT log files.' };
  const d = v.trim();
  const full = (platform === 'win32' ? path.win32 : path.posix).isAbsolute(d) && !(platform === 'win32' && /^[\\/](?![\\/])/.test(d));   // not drive-relative or rooted without a drive
  return full ? { dir: d } : { problem: 'iecode.ads.logDirectory must be a full path, for example C:\\Logs\\TwinCAT.' };
}

const decodeLine = (b: Buffer): string => b.toString('utf8');
const byName = (a: LogFile, b: LogFile): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export async function markNow(fs: LogFs): Promise<LogMarker | undefined> {
  const files = (await fs.list()).sort(byName);
  const f = files[files.length - 1];
  return f ? markAt(fs, f) : undefined;
}

/** The end of the last complete line of a file (looking back at most one line limit). */
async function markAt(fs: LogFs, f: LogFile): Promise<LogMarker> {
  if (f.size === 0) return { file: f.name, offset: 0 };
  const look = Math.min(f.size, MAX_LINE_BYTES);
  const buf = await fs.read(f.name, f.size - look, look);
  const i = buf.lastIndexOf(0x0a);
  if (i >= 0) return { file: f.name, offset: f.size - look + i + 1 };
  return { file: f.name, offset: f.size <= MAX_LINE_BYTES ? 0 : f.size };
}

/** True if a complete line exists after (files[k], off) below the snapshot sizes. */
async function moreAfter(fs: LogFs, files: LogFile[], k: number, off: number, chunk: number): Promise<boolean> {
  for (let i = k; i < files.length; i++) {
    const f = files[i];
    let pos = i === k ? off : 0;
    if (pos >= f.size) continue;
    if (i < files.length - 1) return true;          // an older file: an unfinished last line counts as complete
    const end = Math.min(f.size, pos + MAX_LINE_BYTES);   // look ahead at most one line limit
    while (pos < end) {
      const b = await fs.read(f.name, pos, Math.min(chunk, end - pos));
      if (b.length === 0) break;
      if (b.indexOf(0x0a) >= 0) return true;
      pos += b.length;
    }
    if (pos < f.size) return true;                   // more than a line limit without a line end: the next call consumes it as a cut line
  }
  return false;
}

export async function readLog(fs: LogFs, q: LogQuery, chunkBytes: number = READ_CHUNK_BYTES): Promise<LogRead | undefined> {
  const files = (await fs.list()).sort(byName);
  if (files.length === 0) return undefined;
  const last = files.length - 1;
  const lines: string[] = [];
  const notes: string[] = [];
  let scannedLines = 0, scannedBytes = 0, oversizeNoted = false;
  let cur: LogMarker;
  let k: number, offset: number, skipFirst = false;
  const tail = q.since === undefined;
  const cap = tail ? Number.POSITIVE_INFINITY : q.maxLines;

  let lastK = last;
  const fl = q.filter.map(x => x.toLowerCase()), el = q.exclude.map(x => x.toLowerCase());
  let chars = 0, contNote = -1;
  if (tail) {
    k = last;
    if (files[last].size === 0 && last > 0) {
      k = last - 1;
      notes.push(`The newest log file is empty: showing the end of ${files[k].name}`);
    }
    lastK = k;
    const size = files[k].size;
    offset = Math.max(0, size - TAIL_BYTES);
    if (offset > 0) {
      const prev = await fs.read(files[k].name, offset - 1, 1);
      skipFirst = prev.length === 1 && prev[0] !== 0x0a;
    }
  } else {
    const idx = files.findIndex(f => f.name === q.since!.file);
    if (idx < 0) {
      k = 0; offset = 0;
      notes.push(`Marker file ${q.since!.file} is gone: started at the oldest file ${files[0].name}`);
    } else {
      k = idx; offset = q.since!.offset;
      if (offset > files[idx].size) {
        offset = 0;
        notes.push(`Offset of ${files[idx].name} is past the end of the file: started at the beginning`);
      }
    }
  }
  cur = { file: files[k].name, offset };
  const startK = k;

  const finish = (partial: Buffer, len: number, endAbs: number, name: string): boolean => {
    let b = partial;
    if (len > MAX_LINE_BYTES) {
      if (!oversizeNoted) { notes.push('A line longer than 1 MB was cut'); oversizeNoted = true; }
    } else if (b.length > 0 && b[b.length - 1] === 0x0d) b = b.subarray(0, b.length - 1);
    const text = decodeLine(b);
    scannedLines++;
    cur = { file: name, offset: endAbs };
    if (matchesLower(text, fl, el)) { lines.push(text); chars += text.length + 1; }
    return lines.length >= cap || (!tail && chars >= LOG_TEXT_BUDGET);
  };

  let stopped: 'max' | 'limit' | undefined;
  outer: for (; k <= lastK; k++) {
    const f = files[k];
    if (k > startK) {
      const text = `PLC restart or new log file: continued in ${f.name}`;
      if (contNote < 0) { contNote = notes.length; notes.push(text); } else notes[contNote] = text;
      offset = 0;
    }
    const isNewest = k === last;
    let pos = offset, lineStart = offset, partial: Buffer = Buffer.alloc(0), partialLen = 0, skipping = tail && skipFirst;
    const append = (piece: Buffer): void => {
      partialLen += piece.length;
      if (skipping) return;
      const room = MAX_LINE_BYTES - partial.length;
      if (room > 0) partial = Buffer.concat([partial, piece.subarray(0, room)]);
    };
    while (pos < f.size) {
      const chunk = await fs.read(f.name, pos, Math.min(chunkBytes, f.size - pos));
      if (chunk.length === 0) break;
      scannedBytes += chunk.length;
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl < 0) { append(chunk.subarray(from)); break; }
        append(chunk.subarray(from, nl));
        const endAbs = pos + nl + 1;
        if (skipping) skipping = false;
        else if (finish(partial, partialLen, endAbs, f.name)) { stopped = 'max'; break outer; }
        partial = Buffer.alloc(0); partialLen = 0; lineStart = endAbs;
        from = nl + 1;
      }
      pos += chunk.length;
      if (scannedBytes >= SCAN_LIMIT_BYTES && partialLen <= MAX_LINE_BYTES && (pos < f.size || k < last)) {   // never stop inside an oversized line: the marker would not move
        cur = { file: f.name, offset: lineStart };
        notes.push('Scan limit of 16 MB reached');
        stopped = 'limit';
        break outer;
      }
    }
    if (partialLen > 0 && !skipping && (!isNewest || partialLen > MAX_LINE_BYTES)) {
      if (finish(partial, partialLen, f.size, f.name)) { stopped = 'max'; break outer; }
    } else if (!isNewest) {
      cur = { file: f.name, offset: f.size };
    } else {
      cur = skipping ? await markAt(fs, f) : { file: f.name, offset: lineStart };
    }
  }

  let kept = lines;
  if (tail) {
    if (kept.length > q.maxLines) kept = kept.slice(kept.length - q.maxLines);
    let total = 0, from = kept.length;
    while (from > 0 && (total + kept[from - 1].length + 1 <= LOG_TEXT_BUDGET || from === kept.length)) { from--; total += kept[from].length + 1; }
    kept = kept.slice(from);
  }
  let more = false;
  if (stopped) {
    const ci = files.findIndex(f => f.name === cur.file);
    more = await moreAfter(fs, files, ci, cur.offset, chunkBytes);
  }
  return { lines: kept, next: cur, more, scannedLines, notes, file: cur.file };
}

export function logText(r: LogRead | undefined, q: LogQuery, dir: string): string {
  if (!r) return `No .log file in ${dir}.`;
  const filtered = q.filter.length > 0 || q.exclude.length > 0;
  const out = [filtered ? `Log ${r.file}: ${r.lines.length} of ${r.scannedLines} scanned lines match.` : `Log ${r.file}: ${r.lines.length} lines.`];
  for (const n of r.notes) out.push(`Note: ${n}`);
  out.push(...r.lines);
  const m = encodeMarker(r.next);
  out.push(r.more ? `More lines follow: call again with since "${m}".` : `Next: since "${m}"`);
  return out.join('\n');
}
