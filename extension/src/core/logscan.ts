// Chunked reading and scanning of log files. No vscode imports.
import { promises as fsp } from 'fs';
import { LEVELS, LogFormat, parseLine } from './logformat';
import { EntryStore, FNV_OFFSET, fnv1a } from './logstore';

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  startOffset?: number;
  /** Bytes per read, default 1 MB; tests use a tiny value to hit chunk boundaries. */
  chunkSize?: number;
  /** Keep an unterminated last line unread (a writer may still be appending to it). */
  live?: boolean;
  /** Override the limits of the store for this scan. */
  maxEntries?: number;
  maxSources?: number;
}

/** size = file position the scan stopped at (bytes read); lastEntryStart = offset of the final entry, for resuming. */
export interface ScanResult { size: number; lastEntryStart: number }

/**
 * start/end = retained bytes in buf (at most 1 MB, line break excluded);
 * offset..physEnd = physical extent of the line in the file, line break excluded;
 * terminator = 0 (end of file), 1 (\n) or 2 (\r\n);
 * truncated = bytes past the 1 MB cap were skipped.
 */
export interface RawLine { buf: Buffer; start: number; end: number; offset: number; physEnd: number; terminator: 0 | 1 | 2; truncated: boolean }

const DEFAULT_CHUNK = 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_FIRST_LENGTH = 8192;
const MAX_HASH_CHARS = 8192;
/** Enough bytes to hold MAX_HASH_CHARS characters of any UTF-8 text (3 bytes per BMP char). */
const MAX_DECODE_BYTES = MAX_HASH_CHARS * 3;
const MAX_LINES = 65535;
const LF = 0x0a;
const CR = 0x0d;

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** The only line splitter: reads the file in chunks and yields the complete lines of each chunk. */
export async function* readLines(path: string, o: ScanOptions = {}): AsyncGenerator<RawLine[]> {
  const chunkSize = o.chunkSize ?? DEFAULT_CHUNK;
  const fh = await fsp.open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    let pos = o.startOffset ?? 0;
    // State of the line that is not complete yet.
    let lineStart = pos;
    let physLen = 0;
    let kept = 0;
    let parts: Buffer[] = [];
    let last = 0;

    const addPart = (chunk: Buffer, a: number, b: number): void => {
      if (b <= a) return;
      physLen += b - a;
      last = chunk[b - 1];
      const take = Math.min(MAX_LINE_BYTES - kept, b - a);
      if (take > 0) {
        parts.push(Buffer.from(chunk.subarray(a, a + take)));
        kept += take;
      }
    };
    const reset = (next: number): void => {
      lineStart = next;
      physLen = 0;
      kept = 0;
      parts = [];
      last = 0;
    };

    for (;;) {
      if (o.signal?.aborted) throw abortError();
      const chunk = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await fh.read(chunk, 0, chunkSize, pos);
      if (bytesRead === 0) break;
      const data = bytesRead < chunkSize ? chunk.subarray(0, bytesRead) : chunk;
      pos += bytesRead;
      const batch: RawLine[] = [];
      let from = 0;
      for (;;) {
        const nl = data.indexOf(LF, from);
        if (nl < 0) {
          addPart(data, from, data.length);
          break;
        }
        let buf: Buffer;
        let start: number;
        let end: number;
        let total: number;      // physical bytes of the line including a trailing 
        let cr: boolean;
        let content: number;    // physical bytes of the line without its line break
        if (parts.length === 0) {
          buf = data;
          start = from;
          total = nl - from;
          cr = total > 0 && data[nl - 1] === CR;
          content = cr ? total - 1 : total;
          end = start + Math.min(content, MAX_LINE_BYTES);
        } else {
          addPart(data, from, nl);
          total = physLen;
          cr = last === CR;
          content = cr ? total - 1 : total;
          buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
          start = 0;
          end = Math.min(kept, content);
        }
        batch.push({
          buf, start, end, offset: lineStart, physEnd: lineStart + content,
          terminator: cr ? 2 : 1, truncated: content > end - start,
        });
        reset(lineStart + total + 1);
        from = nl + 1;
      }
      o.onProgress?.(size > 0 ? Math.min(1, pos / size) : 1);
      if (batch.length > 0) yield batch;
    }
    if (physLen > 0 && !o.live) {
      const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      yield [{
        buf, start: 0, end: kept, offset: lineStart, physEnd: lineStart + physLen,
        terminator: 0, truncated: physLen > kept,
      }];
    }
  } finally {
    await fh.close();
  }
}

function decodeLine(l: RawLine): string {
  let s = l.start;
  if (l.offset === 0 && l.end - s >= 3 && l.buf[s] === 0xef && l.buf[s + 1] === 0xbb && l.buf[s + 2] === 0xbf) s += 3;
  return l.buf.toString('utf8', s, l.end);
}

interface Pending {
  time: number;
  level: number;
  source: string;
  seq: number;
  offset: number;
  length: number;
  firstLength: number;
  terminated: number;
  lines: number;
  hash: number;
}

export async function scanFile(path: string, fileId: number, format: LogFormat, store: EntryStore, o: ScanOptions = {}): Promise<ScanResult> {
  if (o.maxEntries !== undefined) store.maxEntries = o.maxEntries;
  if (o.maxSources !== undefined) store.maxSources = o.maxSources;
  const startOffset = o.startOffset ?? 0;
  const levelIndex = new Map(LEVELS.map((l, i) => [l, i]));

  // Boot entries (no time) get the time of the next dated entry, or of the previous one at the end.
  const undated: number[] = [];
  let lastTime = NaN;
  if (startOffset > 0) {
    for (let i = store.count - 1; i >= 0 && store.file[i] === fileId; i--) {
      if (!Number.isNaN(store.time[i])) { lastTime = store.time[i]; break; }
    }
  }
  const patchUndated = (t: number): void => {
    for (const i of undated) store.sortTime[i] = t;
    undated.length = 0;
  };

  let cur: Pending | undefined;
  let lastEntryStart = startOffset;
  const flush = (): void => {
    if (!cur) return;
    const p = cur;
    cur = undefined;
    const i = store.append({
      time: p.time, sortTime: p.time, level: p.level, source: p.source, seq: p.seq, file: fileId,
      offset: p.offset, length: p.length, firstLength: p.firstLength, terminated: p.terminated,
      lines: p.lines, hash: p.hash,
    });
    lastEntryStart = p.offset;
    if (Number.isNaN(p.time)) {
      undated.push(i);
    } else {
      patchUndated(p.time);
      lastTime = p.time;
    }
  };

  let size = startOffset;
  for await (const batch of readLines(path, o)) {
    for (const l of batch) {
      let head = l.buf.toString('utf8', l.start, Math.min(l.end, l.start + MAX_DECODE_BYTES));
      if (l.offset === 0 && l.end - l.start > 0 && head.charCodeAt(0) === 0xfeff) head = head.slice(1);
      const r = parseLine(format, head);
      if (r.kind === 'ignored') continue;
      if (r.kind === 'entry') {
        flush();
        const e = r.entry;
        let h = fnv1a(FNV_OFFSET, String(levelIndex.get(e.level)));
        h = fnv1a(h, '\0' + e.source + '\0' + e.message);
        cur = {
          time: e.time, level: levelIndex.get(e.level)!, source: e.source, seq: e.seq ?? NaN,
          offset: l.offset, length: l.physEnd - l.offset, firstLength: Math.min(l.physEnd - l.offset, MAX_FIRST_LENGTH),
          terminated: l.terminator === 0 ? 0 : 1, lines: 1, hash: h,
        };
      } else if (cur) {
        cur.length = l.physEnd - cur.offset;
        cur.terminated = l.terminator === 0 ? 0 : 1;
        if (cur.lines < MAX_LINES) cur.lines++;
        cur.hash = fnv1a(cur.hash, '\n' + head.slice(0, MAX_HASH_CHARS));
      }
    }
    size = batch[batch.length - 1].physEnd + batch[batch.length - 1].terminator;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  flush();
  if (undated.length > 0) patchUndated(Number.isNaN(lastTime) ? -Infinity : lastTime);
  return { size, lastEntryStart };
}

export async function sniff(path: string): Promise<{ lines: string[]; encoding: 'utf8' | 'utf16'; validUtf8: boolean; head: Buffer }> {
  const SNIFF_BYTES = 64 * 1024;
  const fh = await fsp.open(path, 'r');
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    const data = buf.subarray(0, bytesRead);
    const head = Buffer.from(data.subarray(0, 64));
    const utf16 = data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff));
    // stream: true keeps a multi-byte character cut by the 64 KB boundary from counting as invalid.
    let validUtf8 = true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: true });
    } catch {
      validUtf8 = false;
    }
    if (utf16) return { lines: [], encoding: 'utf16', validUtf8, head };
    const lines = new TextDecoder('utf-8').decode(data, { stream: true }).split(/\r?\n/);
    // A full sample ends mid-line; drop the cut line. A short sample is the whole file.
    if (bytesRead === SNIFF_BYTES) lines.pop();
    else if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return { lines, encoding: 'utf8', validUtf8, head };
  } finally {
    await fh.close();
  }
}
