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
/** Most entries a column reserves address space for; a higher limit grows by copying past it. */
const MAX_RESERVED = 1 << 24;

type Column = Float64Array | Uint32Array | Uint16Array | Uint8Array;
type ColumnType<T extends Column> = { new (buffer: ArrayBuffer): T; readonly BYTES_PER_ELEMENT: number };
type ResizableArrayBuffer = ArrayBuffer & { readonly maxByteLength: number; resize(byteLength: number): void };
// ES2024 resizable buffers (Node 20+); the ES2022 lib does not declare the options argument.
const ResizableBuffer = ArrayBuffer as unknown as new (byteLength: number, o: { maxByteLength: number }) => ResizableArrayBuffer;

/** A length-tracking column over a resizable buffer that can grow to `max` elements in place. */
function column<T extends Column>(type: ColumnType<T>, capacity: number, max: number): T {
  const size = type.BYTES_PER_ELEMENT;
  const reserved = Math.max(capacity, Math.min(max, MAX_RESERVED));
  return new type(new ResizableBuffer(capacity * size, { maxByteLength: reserved * size }));
}

/**
 * Grows in place, so a 5 M-entry store never holds an old and a new copy of its columns at once (copying left
 * hundreds of MB of dead buffers until the next full GC). Past the reserved size (a raised limit) it copies.
 */
function grow<T extends Column>(a: T, capacity: number, max: number): T {
  const buffer = a.buffer as ResizableArrayBuffer;
  const bytes = capacity * a.BYTES_PER_ELEMENT;
  if (bytes <= buffer.maxByteLength) {
    buffer.resize(bytes);
    return a;
  }
  const b = column(a.constructor as ColumnType<T>, capacity, max);
  b.set(a);
  return b;
}

export class EntryStore {
  count = 0;
  maxEntries: number;
  maxSources: number;
  time: Float64Array;
  sortTime: Float64Array;
  level: Uint8Array;
  source: Uint32Array;
  seq: Float64Array;
  file: Uint16Array;
  offset: Float64Array;
  length: Float64Array;
  firstLength: Uint32Array;
  terminated: Uint8Array;
  lines: Uint16Array;
  hash: Uint32Array;
  sources: string[] = [];
  private sourceIndex = new Map<string, number>();

  constructor(opts: { maxEntries?: number; maxSources?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;
    const max = this.maxEntries;
    this.time = column(Float64Array, INITIAL_CAPACITY, max);
    this.sortTime = column(Float64Array, INITIAL_CAPACITY, max);
    this.level = column(Uint8Array, INITIAL_CAPACITY, max);
    this.source = column(Uint32Array, INITIAL_CAPACITY, max);
    this.seq = column(Float64Array, INITIAL_CAPACITY, max);
    this.file = column(Uint16Array, INITIAL_CAPACITY, max);
    this.offset = column(Float64Array, INITIAL_CAPACITY, max);
    this.length = column(Float64Array, INITIAL_CAPACITY, max);
    this.firstLength = column(Uint32Array, INITIAL_CAPACITY, max);
    this.terminated = column(Uint8Array, INITIAL_CAPACITY, max);
    this.lines = column(Uint16Array, INITIAL_CAPACITY, max);
    this.hash = column(Uint32Array, INITIAL_CAPACITY, max);
  }

  private ensureCapacity(): void {
    if (this.count < this.time.length) return;
    // Never past the entry limit: the doubling step to 8.4 M entries would allocate ~200 MB that can never be used.
    const n = Math.max(this.count + 1, Math.min(this.time.length * 2, this.maxEntries));
    const max = this.maxEntries;
    this.time = grow(this.time, n, max);
    this.sortTime = grow(this.sortTime, n, max);
    this.level = grow(this.level, n, max);
    this.source = grow(this.source, n, max);
    this.seq = grow(this.seq, n, max);
    this.file = grow(this.file, n, max);
    this.offset = grow(this.offset, n, max);
    this.length = grow(this.length, n, max);
    this.firstLength = grow(this.firstLength, n, max);
    this.terminated = grow(this.terminated, n, max);
    this.lines = grow(this.lines, n, max);
    this.hash = grow(this.hash, n, max);
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

  /**
   * Replaces the entries from index `at` on (default: none) with all entries of another store; source indices are
   * re-interned. Atomic: checks both limits first and throws LogLimitError leaving the store unchanged.
   */
  appendFrom(other: EntryStore, at = this.count): void {
    const start = Math.max(0, Math.min(at, this.count));
    if (start + other.count > this.maxEntries) {
      throw new LogLimitError(`Too many entries for the viewer: more than ${this.maxEntries} entries; open the file as text`);
    }
    const fresh = new Set<string>();
    for (const s of other.sources) if (!this.sourceIndex.has(s)) fresh.add(s);
    if (this.sources.length + fresh.size > this.maxSources) {
      throw new LogLimitError(`Too many entries for the viewer: more than ${this.maxSources} distinct sources; open the file as text`);
    }
    this.truncate(start);
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
