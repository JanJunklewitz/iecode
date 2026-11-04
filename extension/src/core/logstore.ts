// Columnar storage for the entries of a log file. No vscode imports.

export class LogLimitError extends Error {}

export const DEFAULT_MAX_ENTRIES = 5_000_000;
export const DEFAULT_MAX_SOURCES = 1_000_000;

/** One entry as handed to EntryStore.append; level is an index into LEVELS, source the plain text. */
export interface EntryInput {
  time: number;
  sortTime: number;
  level: number;
  source: string;
  seq: number;
  file: number;
  offset: number;
  length: number;
  firstLength: number;
  terminated: number;
  lines: number;
  hash: number;
}

export const FNV_OFFSET = 0x811c9dc5;

/** Feeds the UTF-16 code units of text into a running FNV-1a hash. */
export function fnv1a(h: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return h >>> 0;
}

const INITIAL_CAPACITY = 1024;

function grow<T extends Float64Array | Uint32Array | Uint16Array | Uint8Array>(a: T, capacity: number): T {
  const b = new (a.constructor as new (n: number) => T)(capacity);
  b.set(a);
  return b;
}

export class EntryStore {
  count = 0;
  maxEntries: number;
  maxSources: number;
  time = new Float64Array(INITIAL_CAPACITY);
  sortTime = new Float64Array(INITIAL_CAPACITY);
  level = new Uint8Array(INITIAL_CAPACITY);
  source = new Uint32Array(INITIAL_CAPACITY);
  seq = new Float64Array(INITIAL_CAPACITY);
  file = new Uint16Array(INITIAL_CAPACITY);
  offset = new Float64Array(INITIAL_CAPACITY);
  length = new Float64Array(INITIAL_CAPACITY);
  firstLength = new Uint32Array(INITIAL_CAPACITY);
  terminated = new Uint8Array(INITIAL_CAPACITY);
  lines = new Uint16Array(INITIAL_CAPACITY);
  hash = new Uint32Array(INITIAL_CAPACITY);
  sources: string[] = [];
  private sourceIndex = new Map<string, number>();

  constructor(opts: { maxEntries?: number; maxSources?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;
  }

  private ensureCapacity(): void {
    if (this.count < this.time.length) return;
    const n = this.time.length * 2;
    this.time = grow(this.time, n);
    this.sortTime = grow(this.sortTime, n);
    this.level = grow(this.level, n);
    this.source = grow(this.source, n);
    this.seq = grow(this.seq, n);
    this.file = grow(this.file, n);
    this.offset = grow(this.offset, n);
    this.length = grow(this.length, n);
    this.firstLength = grow(this.firstLength, n);
    this.terminated = grow(this.terminated, n);
    this.lines = grow(this.lines, n);
    this.hash = grow(this.hash, n);
  }

  private intern(source: string): number {
    let i = this.sourceIndex.get(source);
    if (i === undefined) {
      if (this.sources.length >= this.maxSources) {
        throw new LogLimitError(`Too many entries for the viewer: more than ${this.maxSources} distinct sources; open the file as text`);
      }
      i = this.sources.length;
      this.sources.push(source);
      this.sourceIndex.set(source, i);
    }
    return i;
  }

  /** Returns the entry index. Throws LogLimitError (leaving the store unchanged) past maxEntries / maxSources. */
  append(e: EntryInput): number {
    if (this.count >= this.maxEntries) {
      throw new LogLimitError(`Too many entries for the viewer: more than ${this.maxEntries} entries; open the file as text`);
    }
    const source = this.intern(e.source);
    this.ensureCapacity();
    const i = this.count++;
    this.time[i] = e.time;
    this.sortTime[i] = e.sortTime;
    this.level[i] = e.level;
    this.source[i] = source;
    this.seq[i] = e.seq;
    this.file[i] = e.file;
    this.offset[i] = e.offset;
    this.length[i] = e.length;
    this.firstLength[i] = e.firstLength;
    this.terminated[i] = e.terminated;
    this.lines[i] = e.lines;
    this.hash[i] = e.hash;
    return i;
  }

  /** Appends all entries of another store (source indices are re-interned). */
  appendFrom(other: EntryStore): void {
    for (let i = 0; i < other.count; i++) {
      this.append({
        time: other.time[i], sortTime: other.sortTime[i], level: other.level[i],
        source: other.sources[other.source[i]], seq: other.seq[i], file: other.file[i],
        offset: other.offset[i], length: other.length[i], firstLength: other.firstLength[i],
        terminated: other.terminated[i], lines: other.lines[i], hash: other.hash[i],
      });
    }
  }

  /** Drops the entries from index count on. Interned sources are kept. */
  truncate(count: number): void {
    if (count < this.count) this.count = Math.max(0, count);
  }
}
