// Stateful core of the log viewer: load, filters, text search, snapshots, rows, bookmarks. No vscode imports.
import * as path from 'path';
import { BUILT_IN_FORMATS, LEVELS, Level, LogFormat, LogFormatDef, compileFormat, detectFormat } from './logformat';
import { EntryStore } from './logstore';
import { scanFile, sniff } from './logscan';
import { FilterResult, applyFilters, timelineOrder } from './logfilter';
import { EntryRef, LogFiles, TextQuery, compileQuery, readDetail, readPreviews, searchText } from './logrows';
import { LogView, ViewOptions } from './logview';

export { ViewOptions } from './logview';

export interface LogRow {
  pos: number; index: number; file: string; seq?: number; time: string; timeMs: number; level: Level; source: string;
  message: string; extraLines: number; repeat: number; deltaMs?: number; gap: boolean; bookmarked: boolean;
}
export interface SessionFilters { levels: Level[]; from?: number; to?: number; source?: string; text?: TextQuery }

/** A request was made for an older revision; the caller re-requests with the current one. */
export class StaleError extends Error {
  constructor(readonly revision: number, readonly current: number) {
    super(`Request for revision ${revision}, current revision is ${current}`);
    this.name = 'StaleError';
  }
}

export interface SessionState {
  revision: number; fileGeneration: number; files: string[]; formats: string[];
  filters: SessionFilters; options: ViewOptions; total: number; matched: number; rowCount: number;
  hiddenBy: FilterResult['hiddenBy']; levelCounts: Record<Level, number>; viewFirstTimeMs?: number;
  firstTimeMs?: number; lastTimeMs?: number; scanning: number; live: boolean; warning?: string; error?: string;
}

/** Immutable once published; readers take it synchronously and never see a later change. */
interface Snapshot {
  revision: number;
  fileGeneration: number;
  store: EntryStore;
  files: LogFiles;
  formats: LogFormat[];
  count: number;
  order: Uint32Array;
  result: FilterResult;
  view: LogView;
  viewFirstTimeMs?: number;
}

const MAX_MESSAGE = 2000;
const ERROR_LEVEL = LEVELS.indexOf('error');

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** yyyy-MM-dd HH:mm:ss.SSS from the UTC components (times carry no time zone). */
function formatTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** An empty query means no text filter. */
function normalizeQuery(q: TextQuery | undefined): TextQuery | undefined {
  return q && q.query !== '' ? { query: q.query, regex: q.regex, caseSensitive: q.caseSensitive } : undefined;
}

function sameQuery(a: TextQuery | undefined, b: TextQuery | undefined): boolean {
  if (!a || !b) return a === b;
  return a.query === b.query && a.regex === b.regex && a.caseSensitive === b.caseSensitive;
}

/** Copy without undefined members, so the state compares and serializes cleanly. */
function cleanFilters(f: SessionFilters): SessionFilters {
  const out: SessionFilters = { levels: [...f.levels] };
  if (f.from !== undefined) out.from = f.from;
  if (f.to !== undefined) out.to = f.to;
  if (f.source !== undefined && f.source !== '') out.source = f.source;
  if (f.text !== undefined) out.text = { ...f.text };
  return out;
}

function emptyLevelCounts(): Record<Level, number> {
  return { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
}

export class LogSession {
  private store: EntryStore;
  private files: LogFiles;
  private formats: LogFormat[] = [];
  private order: Uint32Array = new Uint32Array(0);
  private snap: Snapshot;
  private revision = 0;
  private fileGeneration = 0;
  /** filters.text is the query the current textFlags belong to. */
  private filters: SessionFilters = { levels: [...LEVELS] };
  private textFlags?: Uint8Array;
  private search?: { ac: AbortController; query: TextQuery };
  private options: ViewOptions;
  /** Entry indices of the current fileGeneration. */
  private bookmarks = new Set<number>();
  private levelCounts = emptyLevelCounts();
  private firstTimeMs?: number;
  private lastTimeMs?: number;
  private scanning = 0;
  private live = false;
  private warning?: string;
  private error?: string;
  private loadAbort?: AbortController;
  private loaded = false;
  private disposed = false;

  private constructor(
    private readonly paths: string[],
    private readonly userFormats: LogFormatDef[],
    o: ViewOptions,
    private readonly limits: { maxEntries?: number; maxSources?: number },
  ) {
    this.options = { ...o };
    this.store = new EntryStore(limits);
    this.files = new LogFiles(paths);
    this.snap = this.build();
  }

  /** No I/O; call load() next. User formats are tried before the built-in ones. */
  static open(paths: string[], formats: LogFormatDef[], o: ViewOptions, limits: { maxEntries?: number; maxSources?: number } = {}): LogSession {
    return new LogSession([...paths], [...formats], o, limits);
  }

  /**
   * Sniffs, detects the format per file, scans, orders and runs a text query set before or during the load.
   * Rejects for UTF-16 files and with LogLimitError; resolves quietly when dispose() interrupts it.
   */
  async load(onProgress?: (f: number) => void): Promise<void> {
    const ac = new AbortController();
    this.loadAbort = ac;
    try {
      await this.loadFiles(ac.signal, onProgress);
    } catch (e) {
      if (this.disposed) return;
      throw e;
    }
  }

  private async loadFiles(signal: AbortSignal, onProgress?: (f: number) => void): Promise<void> {
    const userIds = new Set(this.userFormats.map(f => f.id));
    const candidates = [...this.userFormats, ...BUILT_IN_FORMATS.filter(f => !userIds.has(f.id))].map(compileFormat);

    const formats: LogFormat[] = [];
    const invalid: string[] = [];
    for (const p of this.paths) {
      const s = await sniff(p);
      if (s.encoding === 'utf16') {
        throw new Error(`${path.basename(p)} is UTF-16 encoded; the log viewer reads UTF-8 only. Save the file as UTF-8 or open it as text.`);
      }
      if (!s.validUtf8) invalid.push(path.basename(p));
      formats.push(detectFormat(s.lines, candidates));
    }

    const store = new EntryStore(this.limits);
    const n = this.paths.length;
    for (let i = 0; i < n; i++) {
      await scanFile(this.paths[i], i, formats[i], store, {
        signal,
        onProgress: f => {
          this.scanning = (i + f) / n;
          onProgress?.(this.scanning);
        },
      });
    }
    // Before the load, setFilters only records the query (filters.text); search until the recorded query is stable.
    let flags: Uint8Array | undefined;
    for (;;) {
      const q = this.filters.text;
      if (!q) {
        flags = undefined;
        break;
      }
      try {
        flags = (await this.searchStore(store, formats, q, signal)).flags;
      } catch (e) {
        if (this.disposed || (e as Error).name === 'AbortError') throw e;
        if (sameQuery(q, this.filters.text)) {
          this.filters = { ...this.filters, text: undefined };
          this.publish();
          this.error = (e as Error).message;
        }
        continue;
      }
      if (sameQuery(q, this.filters.text)) break;
    }
    if (this.disposed) return;

    this.textFlags = flags;
    this.store = store;
    this.formats = formats;
    this.order = timelineOrder(store, n);
    this.levelCounts = emptyLevelCounts();
    let first = Infinity;
    let last = -Infinity;
    for (let i = 0; i < store.count; i++) {
      this.levelCounts[LEVELS[store.level[i]]]++;
      const t = store.time[i];
      if (t < first) first = t;
      if (t > last) last = t;
    }
    this.firstTimeMs = first === Infinity ? undefined : first;
    this.lastTimeMs = last === -Infinity ? undefined : last;
    if (invalid.length === 1 && n === 1) this.warning = 'This file is not valid UTF-8';
    else if (invalid.length > 0) this.warning = `These files are not valid UTF-8: ${invalid.join(', ')}`;
    this.scanning = 1;
    onProgress?.(1);
    this.loaded = true;
    const error = this.error;
    this.publish();
    this.error = error;
  }

  private searchStore(store: EntryStore, formats: LogFormat[], q: TextQuery, signal: AbortSignal) {
    const count = store.count;
    return searchText(
      this.paths,
      { file: store.file.subarray(0, count), offset: store.offset.subarray(0, count), length: store.length.subarray(0, count) },
      formats.map(fm => fm.def),
      q, 0, signal,
    );
  }

  /** Only a change of the text query aborts the running search; everything else publishes synchronously. */
  async setFilters(f: Partial<SessionFilters>): Promise<void> {
    const { text, ...rest } = f;
    const textGiven = 'text' in f;
    const target = normalizeQuery(text);
    let invalid: string | undefined;
    if (textGiven && target) {
      try {
        compileQuery(target);
      } catch (e) {
        invalid = (e as Error).message;
      }
    }
    const hasRest = Object.keys(rest).length > 0;
    if (hasRest) this.filters = { ...this.filters, ...rest };

    if (invalid !== undefined) {
      // Keep the applied query and its flags, drop a pending search, apply the other parts; the error survives publish.
      this.search?.ac.abort();
      this.search = undefined;
      this.publish();
      this.error = invalid;
      return;
    }
    if (!this.loaded) {
      // load() runs the recorded query once the entries exist.
      if (textGiven) this.filters = { ...this.filters, text: target };
      this.publish();
      return;
    }
    const latest = this.search ? this.search.query : this.filters.text;
    if (!textGiven || sameQuery(target, latest)) {
      // A valid text equal to the latest query still publishes, so an earlier error is cleared.
      if (hasRest || textGiven) this.publish();
      return;
    }

    this.search?.ac.abort();
    this.search = undefined;
    if (!target || sameQuery(target, this.filters.text)) {
      if (!target) {
        this.textFlags = undefined;
        this.filters = { ...this.filters, text: undefined };
      }
      this.publish();
      return;
    }

    if (hasRest) this.publish();
    const job = { ac: new AbortController(), query: target };
    this.search = job;
    const generation = this.fileGeneration;
    try {
      const r = await this.searchStore(this.store, this.formats, target, job.ac.signal);
      if (this.search !== job || this.disposed || generation !== this.fileGeneration) return;
      this.search = undefined;
      this.textFlags = r.flags;
      this.filters = { ...this.filters, text: target };
      this.publish();
    } catch (e) {
      if (this.search !== job) return;
      this.search = undefined;
      if ((e as Error).name !== 'AbortError') this.error = (e as Error).message;
    }
  }

  /** Publishes synchronously and never aborts a running search. */
  setOptions(o: Partial<ViewOptions>): void {
    this.options = { ...this.options, ...o };
    this.publish();
  }

  async rows(revision: number, pos: number, count: number): Promise<LogRow[]> {
    const snap = this.current(revision);
    // Everything below up to the first await copies what the rows need from the snapshot.
    const { store, view } = snap;
    const start = Math.max(0, pos);
    const entries = view.rowEntries(start, count);
    const refs: EntryRef[] = entries.map(e => this.ref(store, e.index));
    const meta = entries.map((e, k) => {
      const i = e.index;
      return {
        index: i, repeat: e.repeat, file: store.file[i], seq: store.seq[i], time: store.time[i], level: LEVELS[store.level[i]],
        source: store.sources[store.source[i]], lines: store.lines[i], bookmarked: this.rowBookmarked(view, start + k),
        // Delta of this row is measured from the previous row's last member.
        prev: view.previousTime(start + k),
      };
    });
    const gapMs = this.options.gapMs;
    const parsed = await readPreviews(snap.files, snap.formats, refs);
    return meta.map((m, k) => {
      const t = m.time;
      const dated = !Number.isNaN(t);
      const deltaMs = dated && m.prev !== undefined ? t - m.prev : undefined;
      const message = parsed[k].message;
      const row: LogRow = {
        pos: start + k, index: m.index, file: path.basename(this.paths[m.file]),
        time: dated ? formatTime(t) : parsed[k].timeText, timeMs: t, level: m.level, source: m.source,
        message: message.length > MAX_MESSAGE ? message.slice(0, MAX_MESSAGE) : message,
        extraLines: m.lines - 1, repeat: m.repeat, gap: deltaMs !== undefined && gapMs > 0 && deltaMs > gapMs,
        bookmarked: m.bookmarked,
      };
      if (!Number.isNaN(m.seq)) row.seq = m.seq;
      if (deltaMs !== undefined) row.deltaMs = deltaMs;
      return row;
    });
  }

  async detail(revision: number, pos: number): Promise<{ text: string; truncated: boolean }> {
    const snap = this.current(revision);
    const e = snap.view.rowEntries(pos, 1)[0];
    if (!e) throw new RangeError(`No row at position ${pos}`);
    const d = await readDetail(snap.files, snap.formats, this.ref(snap.store, e.index));
    return { text: d.text, truncated: d.truncated };
  }

  /** Clears every bookmark of the row's group if it has one, otherwise bookmarks the group's first member. */
  toggleBookmark(revision: number, pos: number): void {
    const members = this.current(revision).view.members(pos);
    if (members.length === 0) return;
    let had = false;
    for (const i of members) if (this.bookmarks.delete(i)) had = true;
    if (!had) this.bookmarks.add(members[0]);
  }

  /** Next (dir 1) or previous (dir -1) row after `from` with an error or a bookmark (on any member); -1 when there is none. */
  jump(revision: number, from: number, dir: 1 | -1, what: 'error' | 'bookmark'): number {
    const { store, view } = this.current(revision);
    if (what === 'error') return view.find(from, dir, i => store.level[i] === ERROR_LEVEL);
    if (this.bookmarks.size === 0) return -1;
    return view.find(from, dir, (_i, p) => this.rowBookmarked(view, p));
  }

  private rowBookmarked(view: LogView, pos: number): boolean {
    if (this.bookmarks.size === 0) return false;
    for (const i of view.members(pos)) if (this.bookmarks.has(i)) return true;
    return false;
  }

  /** Ingestion on/off; the refresh itself comes with the live tail. */
  setLive(on: boolean): void {
    this.live = on;
  }

  state(): SessionState {
    const s = this.snap;
    const st: SessionState = {
      revision: s.revision, fileGeneration: s.fileGeneration, files: [...this.paths], formats: s.formats.map(f => f.def.id),
      filters: cleanFilters(this.filters), options: { ...this.options }, total: s.count, matched: s.result.indices.length,
      rowCount: s.view.rowCount, hiddenBy: { ...s.result.hiddenBy }, levelCounts: { ...this.levelCounts },
      scanning: this.scanning, live: this.live,
    };
    if (s.viewFirstTimeMs !== undefined) st.viewFirstTimeMs = s.viewFirstTimeMs;
    if (this.firstTimeMs !== undefined) st.firstTimeMs = this.firstTimeMs;
    if (this.lastTimeMs !== undefined) st.lastTimeMs = this.lastTimeMs;
    if (this.warning !== undefined) st.warning = this.warning;
    if (this.error !== undefined) st.error = this.error;
    return st;
  }

  /** Aborts a load or search; resolves once in-flight reads are done and the files are closed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.loadAbort?.abort();
    this.search?.ac.abort();
    this.search = undefined;
    await this.files.close();
  }

  private current(revision: number): Snapshot {
    if (revision !== this.snap.revision) throw new StaleError(revision, this.snap.revision);
    return this.snap;
  }

  private ref(store: EntryStore, i: number): EntryRef {
    return { file: store.file[i], offset: store.offset[i], length: store.length[i], firstLength: store.firstLength[i] };
  }

  /** Rebuilds filter result and view from the current state and publishes them in one synchronous step. */
  private publish(): void {
    this.revision++;
    this.error = undefined;
    this.snap = this.build();
  }

  private build(): Snapshot {
    const { store } = this;
    const { text: _query, ...rest } = this.filters;
    const result = applyFilters(store, this.order, { ...rest, text: this.textFlags });
    const view = new LogView(store, result.indices, this.options);
    let viewFirstTimeMs: number | undefined;
    for (let j = 0; j < result.indices.length; j++) {
      const t = store.time[result.indices[j]];
      if (!Number.isNaN(t)) {
        viewFirstTimeMs = t;
        break;
      }
    }
    return {
      revision: this.revision, fileGeneration: this.fileGeneration, store, files: this.files, formats: this.formats,
      count: store.count, order: this.order, result, view, viewFirstTimeMs,
    };
  }
}
