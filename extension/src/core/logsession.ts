// Stateful core of the log viewer: load, live tail, filters, text search, snapshots, rows, bookmarks. No vscode imports.
import { promises as fsp } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { BUILT_IN_FORMATS, LEVELS, Level, LogFormat, LogFormatDef, LogFormatError, compileFormat, detectFormatInfo } from './logformat';
import { EntryStore } from './logstore';
import { scanFile, sniff } from './logscan';
import { FilterResult, applyFilters, timelineOrder } from './logfilter';
import { EntryRef, LogFiles, TextQuery, compileQuery, exportRaw, readDetail, readPreviews, searchText } from './logrows';
import { LogView, ViewOptions } from './logview';

export { ViewOptions } from './logview';

export interface LogRow {
  pos: number; index: number; file: string; fileIndex: number; seq?: number; time: string; timeMs: number; level: Level; source: string;
  message: string; extraLines: number; repeat: number; deltaMs?: number; gap: boolean; bookmarked: boolean;
}
/** files: visible file indices (into SessionState.files); undefined = every file. */
export interface SessionFilters { levels: Level[]; from?: number; to?: number; source?: string; text?: TextQuery; files?: number[] }

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
  firstTimeMs?: number; lastTimeMs?: number; scanning: number; live: boolean; warning?: string;
  /** Error of the text query (invalid regex, failed search). */
  error?: string;
  /** Why the live tail could not ingest the file's changes (limit, UTF-16 after a rewrite, read error). */
  liveError?: string;
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
  if (f.files !== undefined) out.files = [...f.files];
  return out;
}

function emptyLevelCounts(): Record<Level, number> {
  return { error: 0, warning: 0, info: 0, debug: 0, other: 0 };
}

/** What the live tail compares to tell an append from a replaced or rewritten file. */
interface FileIdentity { dev: number; ino: number; birthtimeMs: number; size: number; head: Buffer }

const HEAD_BYTES = 64;

/** fstat of a freshly opened handle plus the first 64 bytes. */
async function fileIdentity(p: string): Promise<FileIdentity> {
  const fh = await fsp.open(p, 'r');
  try {
    const st = await fh.stat();
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
    return { dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs, size: st.size, head: head.subarray(0, bytesRead) };
  } finally {
    await fh.close();
  }
}

/** Another file under the same name: a different dev/ino, or (where ino is 0) a different birth time. */
function replacedFile(a: FileIdentity, b: FileIdentity): boolean {
  if (a.dev !== b.dev) return true;
  if (a.ino !== 0 || b.ino !== 0) return a.ino !== b.ino;
  return a.birthtimeMs !== b.birthtimeMs;
}

/** The same file rewritten in place: it shrank, or the bytes it started with changed. */
function rewrittenFile(old: FileIdentity, now: FileIdentity): boolean {
  return now.size < old.size || !now.head.subarray(0, old.head.length).equals(old.head);
}

/** Same extent of entry i of a and entry j of b (a re-scanned entry that did not grow). */
function sameExtent(a: EntryStore, i: number, b: EntryStore, j: number): boolean {
  return a.offset[i] === b.offset[j] && a.length[i] === b.length[j] && a.lines[i] === b.lines[j] &&
    a.terminated[i] === b.terminated[j];
}

function abortErrorOf(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Real path of the destination; the file itself may not exist yet, then its folder's real path plus the base name. */
async function resolvedTarget(dest: string): Promise<string> {
  try {
    return await fsp.realpath(dest);
  } catch {
    return path.join(await fsp.realpath(path.dirname(path.resolve(dest))), path.basename(dest));
  }
}

function sameFile(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  /** The text search of a running load or reload, over its new entries; aborted when the latest query changes. */
  private loadSearch?: { ac: AbortController; query: TextQuery };
  /** Per file: the format was chosen without an entry line confirming it (empty or header-only file). */
  private tentative: boolean[] = [];
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
  /** Single-file sessions: the file as of the last load or refresh. */
  private identity?: FileIdentity;
  /** A reload failed: the entries no longer match the file, so the next change reloads again. */
  private needsReload = false;
  /** Bumped by every live-tail commit; a full text search re-searches what changed during it. */
  private commits = 0;
  private refreshRun?: Promise<boolean>;
  private refreshNext?: Promise<boolean>;
  private refreshAbort?: AbortController;
  private lastTailSearchBytes = 0;
  /** Why the last refresh failed; cleared by the next commit or reload. Separate from error (the text query's). */
  private liveError?: string;

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

  /**
   * Builds store, formats and text flags off to the side and publishes them in one step. A reload (live tail: the file
   * was replaced or rewritten) also opens new LogFiles, bumps fileGeneration and clears the bookmarks; the old files
   * close once the readers of the old snapshot are done. Load progress is reported for the first load only.
   */
  private async loadFiles(signal: AbortSignal, onProgress?: (f: number) => void, reload = false): Promise<void> {
    const userIds = new Set(this.userFormats.map(f => f.id));
    const candidates = [...this.userFormats, ...BUILT_IN_FORMATS.filter(f => !userIds.has(f.id))].map(compileFormat);

    const formats: LogFormat[] = [];
    const tentative: boolean[] = [];
    const invalid: string[] = [];
    for (const p of this.paths) {
      const s = await sniff(p);
      if (s.encoding === 'utf16') {
        throw new Error(`${path.basename(p)} is UTF-16 encoded; the log viewer reads UTF-8 only. Save the file as UTF-8 or open it as text.`);
      }
      if (!s.validUtf8) invalid.push(path.basename(p));
      const d = detectFormatInfo(s.lines, candidates);
      formats.push(d.format);
      tentative.push(d.tentative);
    }

    // Taken before the scan, so growth during the scan shows up as an append in the next refresh.
    const identity = this.paths.length === 1 ? await fileIdentity(this.paths[0]) : undefined;
    const store = new EntryStore(this.limits);
    const n = this.paths.length;
    for (let i = 0; i < n; i++) {
      await scanFile(this.paths[i], i, formats[i], store, {
        signal,
        onProgress: reload ? undefined : f => {
          this.scanning = (i + f) / n;
          onProgress?.(this.scanning);
        },
      });
    }
    // Before the load, setFilters only records the query (filters.text); during a reload a search may be running on
    // the old entries. Search the new entries until the latest query is stable. Each search has its own controller,
    // which setFilters aborts when the latest query changes (a catastrophic regex must not hold up the load).
    let flags: Uint8Array | undefined;
    let applied: TextQuery | undefined;
    for (;;) {
      const q = this.latestQuery();
      applied = q;
      if (!q) {
        flags = undefined;
        break;
      }
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) ac.abort();
      this.loadSearch = { ac, query: q };
      try {
        flags = (await this.searchStore(store, formats, q, ac.signal)).flags;
      } catch (e) {
        if (this.disposed || signal.aborted) throw e;
        // Aborted by setFilters: search for the newer query.
        if ((e as Error).name === 'AbortError') continue;
        if (sameQuery(q, this.latestQuery())) {
          this.search?.ac.abort();
          this.search = undefined;
          this.filters = { ...this.filters, text: undefined };
          this.textFlags = undefined;
          this.publish();
          this.error = (e as Error).message;
        }
        continue;
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (this.loadSearch?.ac === ac) this.loadSearch = undefined;
      }
      if (sameQuery(q, this.latestQuery())) break;
    }
    if (this.disposed) return;

    if (reload) {
      const old = this.files;
      this.files = new LogFiles(this.paths);
      void old.close();
      this.fileGeneration++;
      this.bookmarks.clear();
      this.warning = undefined;
    }
    // A search still running belongs to the old entries; its query is applied here.
    this.search?.ac.abort();
    this.search = undefined;
    this.filters = { ...this.filters, text: applied };
    this.identity = identity;
    this.textFlags = flags;
    this.store = store;
    this.formats = formats;
    this.tentative = tentative;
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

  /** The query the next published text flags are for: a running search's, else the applied one. */
  private latestQuery(): TextQuery | undefined {
    return this.search ? this.search.query : this.filters.text;
  }

  /** A load or reload searching for another query than the latest one starts over with the latest. */
  private restartLoadSearch(): void {
    if (this.loadSearch && !sameQuery(this.loadSearch.query, this.latestQuery())) this.loadSearch.ac.abort();
  }

  /** Flags of the entries from `from` on; the columns are copied synchronously, before the first await. */
  private searchStore(store: EntryStore, formats: LogFormat[], q: TextQuery, signal: AbortSignal, from = 0) {
    const count = store.count;
    return searchText(
      this.paths,
      { file: store.file.subarray(0, count), offset: store.offset.subarray(0, count), length: store.length.subarray(0, count) },
      formats.map(fm => fm.def),
      q, from, signal,
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
      this.restartLoadSearch();
      this.publish();
      this.error = invalid;
      return;
    }
    if (!this.loaded) {
      // load() runs the recorded query once the entries exist.
      if (textGiven) this.filters = { ...this.filters, text: target };
      this.restartLoadSearch();
      this.publish();
      return;
    }
    if (!textGiven || sameQuery(target, this.latestQuery())) {
      // A valid text equal to the latest query still publishes, so the cleared error goes out.
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
      this.restartLoadSearch();
      this.publish();
      return;
    }

    if (hasRest) this.publish();
    const job = { ac: new AbortController(), query: target };
    this.search = job;
    this.restartLoadSearch();
    const generation = this.fileGeneration;
    try {
      // Live-tail commits during the search replace the last entry and append more; search those again until none came.
      let flags = new Uint8Array(0);
      let covered = 0;
      for (;;) {
        const commits = this.commits;
        const count = this.store.count;
        const from = Math.max(0, covered - 1);
        const r = await this.searchStore(this.store, this.formats, target, job.ac.signal, from);
        if (this.search !== job || this.disposed || generation !== this.fileGeneration) return;
        const next = new Uint8Array(count);
        next.set(flags.subarray(0, from));
        next.set(r.flags, from);
        flags = next;
        covered = count;
        if (this.commits === commits) break;
      }
      this.search = undefined;
      this.textFlags = flags;
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
        pos: start + k, index: m.index, file: path.basename(this.paths[m.file]), fileIndex: m.file,
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

  /** Ingestion on/off, reported in the state; the owner watches the file and calls refresh() while it is on. */
  setLive(on: boolean): void {
    this.live = on;
  }

  /** Bytes the text search of the last live-tail commit read (0 without a text filter). */
  get tailSearchBytes(): number {
    return this.lastTailSearchBytes;
  }

  /**
   * Live tail of a single-file session (merged sessions stay static and resolve false): ingests what was appended, or
   * reloads the file when it was replaced or rewritten, or when it grew while its format was still a guess (it was
   * empty or held only ignored lines, such as a header). Resolves true when the state changed (also for a new error)
   * and never rejects. Calls are coalesced: at most one refresh runs and at most one more is pending.
   */
  refresh(): Promise<boolean> {
    if (this.refreshNext) return this.refreshNext;
    const running = this.refreshRun;
    if (!running) return this.startRefresh();
    const next = running.then(() => {
      this.refreshNext = undefined;
      return this.startRefresh();
    });
    this.refreshNext = next;
    return next;
  }

  private startRefresh(): Promise<boolean> {
    const run = this.refreshOnce().finally(() => {
      if (this.refreshRun === run) this.refreshRun = undefined;
    });
    this.refreshRun = run;
    return run;
  }

  private async refreshOnce(): Promise<boolean> {
    if (this.disposed || !this.loaded || this.paths.length !== 1 || !this.identity) return false;
    const ac = new AbortController();
    this.refreshAbort = ac;
    let now: FileIdentity | undefined;
    let reload = this.needsReload;
    try {
      try {
        now = await fileIdentity(this.paths[0]);
      } catch {
        // Gone for a moment (a rotation renames the file away first); the next refresh looks again.
        return false;
      }
      if (this.disposed) return false;
      const old = this.identity;
      if (replacedFile(old, now) || rewrittenFile(old, now)) reload = true;
      else if (now.size === old.size) return false;
      // The format was a guess (empty or header-only file): detect it again from the grown file.
      else if (this.tentative[0]) reload = true;
      if (reload) {
        await this.loadFiles(ac.signal, undefined, true);
        this.needsReload = false;
        if (this.disposed) return false;
        this.liveError = undefined;
        return true;
      }
      const changed = await this.appendTail(now, ac.signal);
      // Committed or reloaded: an earlier refresh failure is over.
      if (changed) this.liveError = undefined;
      return changed;
    } catch (e) {
      if (this.disposed || (e as Error).name === 'AbortError') return false;
      // Not retried until the file changes again; a failed reload leaves entries that no longer match the file.
      if (now) this.identity = now;
      if (reload) this.needsReload = true;
      const message = (e as Error).message;
      const changed = this.liveError !== message;
      this.liveError = message;
      return changed;
    } finally {
      if (this.refreshAbort === ac) this.refreshAbort = undefined;
    }
  }

  /**
   * Scans from the last entry's offset into a separate store (an unterminated last line stays unread), searches only
   * that tail, then commits synchronously: replace the last entry, append the rest, extend the text flags, rebuild
   * order, filter result and view, publish.
   */
  private async appendTail(now: FileIdentity, signal: AbortSignal): Promise<boolean> {
    const store = this.store;
    const had = store.count > 0;
    const at = had ? store.count - 1 : 0;
    const start = had ? store.offset[at] : 0;
    const tail = new EntryStore(this.limits);
    await scanFile(this.paths[0], 0, this.formats[0], tail, { startOffset: start, live: true, signal });
    if (this.disposed) return false;
    if (had && tail.count > 0 && tail.offset[0] !== start) {
      // The last entry no longer starts where it did: the file changed beyond the head.
      await this.loadFiles(signal, undefined, true);
      return !this.disposed;
    }
    // Nothing complete was added: the last line is still being written.
    if (tail.count === 0 || (had && tail.count === 1 && sameExtent(store, at, tail, 0))) {
      this.identity = now;
      return false;
    }

    let flags: Uint8Array | undefined;
    this.lastTailSearchBytes = 0;
    for (;;) {
      // A full search for a new query may land meanwhile; then the tail is searched for that query too.
      const q = this.filters.text;
      if (!q) {
        flags = undefined;
        break;
      }
      const r = await this.searchStore(tail, this.formats, q, signal);
      this.lastTailSearchBytes += r.bytesRead;
      if (this.disposed) return false;
      if (sameQuery(q, this.filters.text)) {
        flags = r.flags;
        break;
      }
    }

    // Commit, synchronous from here on. appendFrom checks the limits before it changes anything.
    const oldLevel = store.level[at];
    store.appendFrom(tail, at);
    if (this.textFlags) {
      const f = new Uint8Array(store.count);
      f.set(this.textFlags.subarray(0, at));
      if (flags) f.set(flags, at);
      this.textFlags = f;
    }
    if (had) this.levelCounts[LEVELS[oldLevel]]--;
    for (let i = at; i < store.count; i++) {
      this.levelCounts[LEVELS[store.level[i]]]++;
      const t = store.time[i];
      if (Number.isNaN(t)) continue;
      if (this.firstTimeMs === undefined || t < this.firstTimeMs) this.firstTimeMs = t;
      if (this.lastTimeMs === undefined || t > this.lastTimeMs) this.lastTimeMs = t;
    }
    this.order = timelineOrder(store, this.paths.length);
    this.identity = now;
    this.commits++;
    // An error of the text query (invalid regex) still belongs to the query box.
    const error = this.error;
    this.publish();
    this.error = error;
    return true;
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
    if (this.liveError !== undefined) st.liveError = this.liveError;
    return st;
  }

  /**
   * Writes every matched entry (all members of grouped rows) in view order, as original bytes plus "\n" each, to a
   * temp file next to `dest` and renames it over `dest` after success; abort or failure deletes the temp file and
   * leaves `dest` alone. The snapshot is taken synchronously, so later filter changes or live commits do not affect a
   * running export. Resolves with the number of entries written.
   */
  async exportTo(dest: string, signal?: AbortSignal): Promise<number> {
    const snap = this.snap;
    // Copied and acquired before the first await.
    const release = snap.files.acquire();
    try {
      const indices = snap.result.indices;
      const refs: EntryRef[] = new Array(indices.length);
      for (let j = 0; j < indices.length; j++) refs[j] = this.ref(snap.store, indices[j]);

      const target = await resolvedTarget(dest);
      for (const p of this.paths) {
        if (sameFile(target, await fsp.realpath(p))) throw new LogFormatError('Cannot export into a file that is open in the viewer');
      }
      if (signal?.aborted) throw abortErrorOf();

      const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
      const fh = await fsp.open(tmp, 'wx');
      try {
        try {
          await exportRaw(snap.files, refs, async chunk => {
            let done = 0;
            while (done < chunk.length) done += (await fh.write(chunk, done, chunk.length - done)).bytesWritten;
          }, signal);
        } finally {
          await fh.close();
        }
        if (signal?.aborted) throw abortErrorOf();
        await fsp.rename(tmp, dest);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => undefined);
        throw e;
      }
      return refs.length;
    } finally {
      release();
    }
  }

  /** Aborts a load, refresh or search; resolves once in-flight reads are done and the files are closed. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.loadAbort?.abort();
    this.refreshAbort?.abort();
    this.search?.ac.abort();
    this.search = undefined;
    await this.refreshRun;
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
