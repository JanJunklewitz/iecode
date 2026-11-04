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

const MAX_PREVIEW_BYTES = 8192;
const DEFAULT_DETAIL_BYTES = 1024 * 1024;
const EXPORT_CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Keeps one read handle per file open; close() waits until every acquire() has been released. */
export class LogFiles {
  private handles: Array<Promise<fsp.FileHandle> | undefined>;
  private active = 0;
  private closing = false;
  private idle?: () => void;

  constructor(private paths: string[]) {
    this.handles = paths.map(() => undefined);
  }

  /** Marks the files as in use; call the returned function once when the read is done. */
  acquire(): () => void {
    if (this.closing) throw new Error('The log files are closed');
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

  async close(): Promise<void> {
    this.closing = true;
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

/** Parsed first line of every ref (at most 8 KB read each), in the order of refs. */
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
    const nl = text.indexOf('\n');
    return { first: parseFirst(formats[ref.file], nl < 0 ? text : text.slice(0, nl)), text, truncated: ref.length > maxBytes };
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
    throw new LogFormatError(`Invalid regular expression: ${(e as Error).message}`);
  }
}

/**
 * Searches the source, message and continuation lines of the entries from `from` on (time and level text are not
 * searched; each piece is tested separately, up to 8 KB). `refs` are the full columns indexed by entry; the part from
 * `from` on is copied here and the copies are transferred to a worker, so the caller's arrays stay usable.
 * The worker is terminated when the signal aborts; a catastrophic regex can therefore never block the host.
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
  const file = refs.file.slice(from);
  const offset = refs.offset.slice(from);
  const length = refs.length.slice(from);
  const worker = new Worker(path.join(__dirname, 'logsearchWorker.js'), {
    workerData: { paths, file, offset, length, formats, q },
    transferList: [file.buffer as ArrayBuffer, offset.buffer as ArrayBuffer, length.buffer as ArrayBuffer],
  });
  return new Promise<SearchResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal?.addEventListener('abort', onAbort);
    worker.on('message', (m: { flags?: Uint8Array; bytesRead?: number; error?: string }) => {
      if (m.error !== undefined) finish(() => reject(new Error(m.error)));
      else finish(() => resolve({ flags: m.flags!, from, bytesRead: m.bytesRead! }));
    });
    worker.on('error', e => finish(() => reject(e)));
    worker.on('exit', () => finish(() => reject(new Error('The search worker exited unexpectedly'))));
  });
}

/** Writes the original bytes of each entry followed by one "\n" (never re-encoded, no BOM) in chunks of at most 1 MB. */
export async function exportRaw(
  files: LogFiles,
  refs: EntryRef[] | Iterable<EntryRef>,
  out: (chunk: Buffer) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const release = files.acquire();
  try {
    for (const r of refs) {
      const fh = await files.handle(r.file);
      let done = 0;
      do {
        if (signal?.aborted) throw abortError();
        const n = Math.min(EXPORT_CHUNK, r.length - done);
        const last = done + n >= r.length;
        const buf = Buffer.allocUnsafe(n + (last ? 1 : 0));
        const { bytesRead } = n > 0 ? await fh.read(buf, 0, n, r.offset + done) : { bytesRead: 0 };
        if (last) {
          // A shorter read means the file shrank since the scan; emit what exists.
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
  } finally {
    release();
  }
}
