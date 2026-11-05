// Reading entry text back from disk, text search in a worker thread and raw export. No vscode imports.
import { promises as fsp } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { LogFormat, LogFormatDef, LogFormatError, ParsedLine, parseLine } from './logformat';

/** Copied from the store before any await, so a later store change cannot move it. */
export interface EntryRef { file: number; offset: number; length: number; firstLength: number }
export interface EntryText { first: ParsedLine; text: string; truncated: boolean }
export interface TextQuery { query: string; regex: boolean; caseSensitive: boolean }
export interface SearchResult { flags: Uint8Array; from: number; bytesRead: number }

/** The scan parses up to 8192 characters from 3 bytes per character; the previews read as much (EntryStore.firstLength). */
const MAX_PREVIEW_BYTES = 8192 * 3;
const DEFAULT_DETAIL_BYTES = 1024 * 1024;
const EXPORT_CHUNK = 1024 * 1024;
/** Largest gap between two entries that one export read still spans. */
const EXPORT_SPAN_GAP = 64 * 1024;
const NEWLINE = 0x0a;

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Keeps one read handle per file open; close() waits until every acquire() has been released. While a reader still
 * holds the files, another acquire() succeeds even after close() (a reader that took a snapshot before a reload may
 * acquire again inside, as exportTo does through exportRaw); once all are released, acquire() throws.
 */
export class LogFiles {
  private handles: Array<Promise<fsp.FileHandle> | undefined>;
  private active = 0;
  private closing?: Promise<void>;
  private idle?: () => void;

  constructor(private paths: string[]) {
    this.handles = paths.map(() => undefined);
  }

  /** Marks the files as in use; call the returned function once when the read is done. */
  acquire(): () => void {
    if (this.closing && this.active === 0) throw new Error('The log files are closed');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) this.idle?.();
    };
  }

  /** Opens the file lazily. Only valid between acquire() and its release. */
  handle(file: number): Promise<fsp.FileHandle> {
    let h = this.handles[file];
    if (!h) {
      h = fsp.open(this.paths[file], 'r');
      h.catch(() => { this.handles[file] = undefined; });
      this.handles[file] = h;
    }
    return h;
  }

  /** Safe to call more than once; every call resolves after the readers are released and the handles closed. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.active > 0) await new Promise<void>(resolve => { this.idle = resolve; });
      const open = this.handles;
      this.handles = this.paths.map(() => undefined);
      for (const p of open) {
        if (!p) continue;
        try {
          await (await p).close();
        } catch {
          // Never opened or already closed.
        }
      }
    })();
    return this.closing;
  }
}

/** Decodes bytes as UTF-8 (a cut multi-byte character becomes U+FFFD, never throws) and drops a BOM at file offset 0. */
function decode(buf: Buffer, n: number, offset: number): string {
  let s = 0;
  if (offset === 0 && n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) s = 3;
  return buf.toString('utf8', s, n);
}

function parseFirst(format: LogFormat, line: string): ParsedLine {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  const r = parseLine(format, text);
  if (r.kind === 'entry') return r.entry;
  return { time: NaN, timeText: '', level: 'other', levelText: '', source: '', message: text };
}

/** Parsed first line of every ref (at most 24 KB read each), in the order of refs. */
export async function readPreviews(files: LogFiles, formats: LogFormat[], refs: EntryRef[]): Promise<ParsedLine[]> {
  const release = files.acquire();
  try {
    const order = refs.map((_, i) => i).sort((a, b) => refs[a].file - refs[b].file || refs[a].offset - refs[b].offset);
    const out = new Array<ParsedLine>(refs.length);
    for (const i of order) {
      const r = refs[i];
      const want = Math.min(r.firstLength, MAX_PREVIEW_BYTES);
      const buf = Buffer.allocUnsafe(want);
      const fh = await files.handle(r.file);
      const { bytesRead } = await fh.read(buf, 0, want, r.offset);
      out[i] = parseFirst(formats[r.file], decode(buf, bytesRead, r.offset));
    }
    return out;
  } finally {
    release();
  }
}

/** Full text of an entry (CRLF normalized to LF), cut at maxBytes. */
export async function readDetail(files: LogFiles, formats: LogFormat[], ref: EntryRef, maxBytes = DEFAULT_DETAIL_BYTES): Promise<EntryText> {
  const release = files.acquire();
  try {
    const want = Math.min(ref.length, maxBytes);
    const buf = Buffer.allocUnsafe(want);
    const fh = await files.handle(ref.file);
    const { bytesRead } = await fh.read(buf, 0, want, ref.offset);
    const text = decode(buf, bytesRead, ref.offset).replace(/\r\n/g, '\n');
    // The entry regex only sees the first 24 KB of the first line (as in the scan), decoded on its own (BOM/CR
    // handled as in readPreviews).
    const head = Math.min(ref.firstLength, MAX_PREVIEW_BYTES, bytesRead);
    return { first: parseFirst(formats[ref.file], decode(buf, head, ref.offset)), text, truncated: ref.length > maxBytes };
  } finally {
    release();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileQuery(q: TextQuery): RegExp {
  try {
    return new RegExp(q.regex ? q.query : escapeRegex(q.query), q.caseSensitive ? '' : 'i');
  } catch (e) {
    // The engine's message already reads "Invalid regular expression: /(/i: Unterminated group".
    throw new LogFormatError((e as Error).message);
  }
}

/**
 * Searches the source, message and continuation lines of the entries from `from` on (time and level text are not
 * searched; each piece is tested separately, up to 8 KB). `refs` are the columns indexed by entry and trimmed to the
 * entry count (EntryStore columns are longer: they have spare capacity), since their length is the number of entries
 * searched; the part from `from` on is copied here and the copies are transferred to a worker, so the caller's arrays
 * stay usable.
 * The worker is terminated when the signal aborts; a catastrophic regex can therefore never block the host. A worker
 * that finished its search is kept for the next one (the live tail searches every few seconds), see takeWorker.
 */
export async function searchText(
  paths: string[],
  refs: { file: Uint16Array; offset: Float64Array; length: Float64Array },
  formats: LogFormatDef[],
  q: TextQuery,
  from: number,
  signal?: AbortSignal,
): Promise<SearchResult> {
  compileQuery(q);
  if (signal?.aborted) throw abortError();
  // Nothing to search: no worker, no read.
  if (from >= refs.file.length) return { flags: new Uint8Array(0), from, bytesRead: 0 };
  const file = refs.file.slice(from);
  const offset = refs.offset.slice(from);
  const length = refs.length.slice(from);
  const worker = takeWorker();
  return new Promise<SearchResult>((resolve, reject) => {
    let settled = false;
    /** reuse: the worker answered and is idle again; otherwise it is stopped (abort, crash). */
    const finish = (fn: () => void, reuse: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (reuse) releaseWorker(worker);
      else void worker.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => reject(abortError()), false);
    const onMessage = (m: { flags?: Uint8Array; bytesRead?: number; error?: string }): void => {
      if (m.error !== undefined) finish(() => reject(new Error(m.error)), true);
      else finish(() => resolve({ flags: m.flags!, from, bytesRead: m.bytesRead! }), true);
    };
    const onError = (e: Error): void => finish(() => reject(e), false);
    const onExit = (): void => finish(() => reject(new Error('The search worker exited unexpectedly')), false);
    signal?.addEventListener('abort', onAbort);
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage({ paths, file, offset, length, formats, q },
      [file.buffer as ArrayBuffer, offset.buffer as ArrayBuffer, length.buffer as ArrayBuffer]);
  });
}

/** Most finished search workers kept for reuse, and how long an unused one is kept. */
const MAX_IDLE_WORKERS = 2;
const WORKER_IDLE_MS = 30_000;
const idleWorkers: { worker: Worker; timer: NodeJS.Timeout }[] = [];

function dropIdle(worker: Worker): void {
  const k = idleWorkers.findIndex(w => w.worker === worker);
  if (k < 0) return;
  clearTimeout(idleWorkers[k].timer);
  idleWorkers.splice(k, 1);
}

/**
 * An idle worker, else a new one. Starting a worker (thread, module load) costs tens of milliseconds, too much for
 * the small search of each live-tail commit. A worker runs one search at a time.
 */
function takeWorker(): Worker {
  const idle = idleWorkers.pop();
  if (idle) {
    clearTimeout(idle.timer);
    idle.worker.ref();
    return idle.worker;
  }
  const worker = new Worker(path.join(__dirname, 'logsearchWorker.js'));
  // An idle worker that dies must not be handed out again.
  worker.on('exit', () => dropIdle(worker));
  return worker;
}

/** Keeps the worker for the next search; unref'd while idle, so it never keeps the process alive. */
function releaseWorker(worker: Worker): void {
  if (idleWorkers.length >= MAX_IDLE_WORKERS) {
    void worker.terminate();
    return;
  }
  worker.unref();
  const timer = setTimeout(() => {
    dropIdle(worker);
    void worker.terminate();
  }, WORKER_IDLE_MS);
  timer.unref();
  idleWorkers.push({ worker, timer });
}

/**
 * Writes the original bytes of each entry followed by one "\n" (never re-encoded, no BOM). Small entries of one file
 * that lie close together are read with one read and batched into output chunks of up to 1 MB; an entry of 1 MB or
 * more is read and written in chunks of its own.
 */
export async function exportRaw(
  files: LogFiles,
  refs: EntryRef[] | Iterable<EntryRef>,
  out: (chunk: Buffer) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const release = files.acquire();
  try {
    const list = Array.isArray(refs) ? refs : [...refs];
    // A chunk handed to out() is never reused, so the caller may keep it.
    let pending = Buffer.allocUnsafe(EXPORT_CHUNK);
    let used = 0;
    const flush = async (): Promise<void> => {
      if (used === 0) return;
      const chunk = pending.subarray(0, used);
      pending = Buffer.allocUnsafe(EXPORT_CHUNK);
      used = 0;
      await out(chunk);
    };
    let i = 0;
    while (i < list.length) {
      if (signal?.aborted) throw abortError();
      const r = list[i];
      if (r.length >= EXPORT_CHUNK) {
        await flush();
        await exportLarge(files, r, out, signal);
        i++;
        continue;
      }
      // Extend the span over following small entries of the same file that are close by (offsets rising).
      let j = i;
      const start = r.offset;
      let end = r.offset + r.length;
      while (j + 1 < list.length) {
        const n = list[j + 1];
        const nEnd = Math.max(end, n.offset + n.length);
        if (n.file !== r.file || n.length >= EXPORT_CHUNK || n.offset < start || n.offset > end + EXPORT_SPAN_GAP ||
          nEnd - start > EXPORT_CHUNK) break;
        end = nEnd;
        j++;
      }
      const span = Buffer.allocUnsafe(end - start);
      const fh = await files.handle(r.file);
      const { bytesRead } = await fh.read(span, 0, span.length, start);
      for (let k = i; k <= j; k++) {
        const e = list[k];
        const rel = e.offset - start;
        // A shorter read means the file shrank since the scan; emit what exists.
        const avail = Math.max(0, Math.min(e.length, bytesRead - rel));
        if (used + avail + 1 > EXPORT_CHUNK) await flush();
        span.copy(pending, used, rel, rel + avail);
        pending[used + avail] = NEWLINE;
        used += avail + 1;
      }
      i = j + 1;
    }
    if (signal?.aborted) throw abortError();
    await flush();
  } finally {
    release();
  }
}

async function exportLarge(files: LogFiles, r: EntryRef, out: (chunk: Buffer) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const fh = await files.handle(r.file);
  let done = 0;
  do {
    if (signal?.aborted) throw abortError();
    const n = Math.min(EXPORT_CHUNK, r.length - done);
    const last = done + n >= r.length;
    const buf = Buffer.allocUnsafe(n + (last ? 1 : 0));
    const { bytesRead } = n > 0 ? await fh.read(buf, 0, n, r.offset + done) : { bytesRead: 0 };
    if (last) {
      buf[bytesRead] = NEWLINE;
      await out(buf.subarray(0, bytesRead + 1));
      break;
    }
    if (bytesRead === 0) {
      await out(Buffer.from([NEWLINE]));
      break;
    }
    await out(buf.subarray(0, bytesRead));
    done += bytesRead;
  } while (done < r.length);
}
