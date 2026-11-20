# Log File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only viewer for log files (first format: the TwinCAT logger text files, up to 100 MB each) with filters, colored severity, merged timelines and live tail, usable from the "Open With" menu and a command.

**Architecture:** A VS Code independent core in `extension/src/core/` scans a file once into columnar typed arrays (time, level, source id, byte offset, hash; no message strings), so a 100 MB logger file costs less than 300 MB of memory (logger profile, asserted in Task 11; other inputs are bounded by the entry limit below). Messages are re-read from disk for the visible rows only. Filters, grouping and gap detection run on the typed arrays in the extension host; the text search runs in a `worker_threads` Worker that is terminated on abort, because one pathological regex match never yields and would freeze every extension in the host (review O2); a webview shows a virtual-scrolled table and asks the host for row windows. A log format is a data definition (regex with named groups, time format, level map), so new formats need no code.

**Tech Stack:** TypeScript (extension, `node --test`), plain JS/CSS webview in `extension/media/` (same pattern as `plcArchiveEditor`), no new dependencies.

**Spec:** No separate design document. The requirements are the "Log file viewer" item in [TODO.md](../../../TODO.md) plus the decisions in this plan (marked **Decision**), made after reading real logger files (not committed).

## Global Constraints

- The repository is public: never commit real log content, machine, project or variable names from real logs. All fixtures are synthetic and generic (`fbMain.fbPump.fbValve`).
- Everything in files is English (code, comments, UI strings, docs, commit messages incl. body). Every commit has a 1-3 sentence body on why. No `Co-Authored-By`. Author, committer and Signed-off-by use the GitHub noreply address.
- Cosmetic changes (whitespace, reordering) go in their own commit.
- No new runtime dependencies. Core files in `src/core/` must not import `vscode`.
- Files up to 100 MB must open without freezing the extension host: scan in chunks of at most 1 MB and yield to the event loop between chunks.
- Encoding: UTF-8 with optional BOM. UTF-16 files give a clear error message, not garbage. **Decision (review C12, replaces O3):** no legacy-encoding fallback. Node's `latin1` is not Windows-1252, and the 41 sample logger files checked on 2026-11-04 are pure ASCII. When the 64 KB sniff is not valid UTF-8 (checked with `new TextDecoder('utf-8', { fatal: true })`, ignoring an incomplete sequence cut by the 64 KB boundary), the file is still decoded as UTF-8 (invalid bytes become U+FFFD) and the status line warns "This file is not valid UTF-8". Export copies bytes, so it is not affected.
- Size limits (review O6, C3, C7): every regex (format entry regex, ignore regex, text query) sees at most the first 8 KB of a line; `readLines` keeps at most 1 MB of one line (the rest is skipped, physical offsets stay exact). Rows read only the entry's first line (at most 8 KB, `LogRow.message` cut at 2000 characters); `detail` reads at most 1 MB of an entry and says when it was cut. A session holds at most 5,000,000 entries and 1,000,000 distinct sources; past that, `load` stops with `LogLimitError` ("Too many entries for the viewer: …; open the file as text") instead of exhausting the extension host (a 100 MB `plain` file of 2-byte lines would otherwise need 50 M entries, about 2.5 GB).
- Responsiveness (review C13): no synchronous step in the extension host may block the event loop for more than 200 ms on a 100 MB logger file (load, order, filter, grouping, refresh); Task 11 measures it with `perf_hooks.monitorEventLoopDelay`.
- **Known limit (review C5):** format regexes run in the extension host during the scan. The built-in formats are linear; a catastrophic regex in a user's own `iecode.logViewer.formats` entry can still block the host. The setting's description says so. Moving the scan into the Worker is the fallback if this bites.
- **Decision (review O20):** format definitions live in the `iecode.logViewer.formats` setting, not in repo files (the TODO left this open). A workspace `.vscode/settings.json` can still share them per repo.
- Times in logs have no time zone. **Decision:** keep them as wall-clock values stored with `Date.UTC(...)` and format them from UTC components, so DST never shifts them. Wall-clock times are not monotonic: the hour after a DST fall-back repeats and a clock correction can jump back. **Decision (review R4):** a single-file session therefore keeps the file order; only merged sessions sort by time.
- Log text is untrusted input (it comes from machines and customers). The webview renders it with `textContent` only, never `innerHTML` or string-built HTML.
- The viewer reads files with Node `fs`, so it accepts only `file:` URIs. Other schemes (`git:`, `iecode-rev:`, virtual file systems) get a clear message with an "Open as text" button.
- Line-ending fixtures must survive `core.autocrlf=true` checkouts: `extension/test/fixtures/logs/** -text` goes into `.gitattributes` in the same commit as the fixtures (Task 2).

## State Model (review C2, C6)

The session publishes immutable **snapshots**: `{ revision, fileGeneration, count, order, filterResult, view }`. Readers (`rows`, `detail`, `jump`, `bookmark`, export) take the current snapshot synchronously, copy the `file`/`offset`/`length` values they need before their first `await`, and never see a later change. Writers build the next snapshot off to the side and publish it in one synchronous step:

- The `EntryStore` is append-only for published indices. A live refresh scans the tail into a separate small `EntryStore`; the commit step (synchronous) replaces the last entry and appends the tail, then rebuilds order, filter result and view, and bumps `revision`.
- A full reload (file shrank, rotated, rewritten) builds a new store and a new `LogFiles` and bumps `fileGeneration`. The old `LogFiles` closes when the last reader that took the old snapshot has finished (reference count).
- Only a change of the text query aborts the running text search. Level, time, source, file and option changes reuse the current text flags and publish synchronously. Refresh requests are coalesced: at most one runs, at most one more is pending.
- Every host-to-webview message carries `revision`; every webview request carries the `revision` it was made for. The host answers a request for an older revision with `{type:'stale', revision}` and the webview re-requests. Bookmarks are keyed by `(fileGeneration, entry index)` and cleared on a new `fileGeneration`.

```
 webview request(rev) ──> host: snapshot = current ── rev == snapshot.revision? ── no ──> {stale}
                                     │ yes
                                     └─ copy offsets ─ await read ─ reply(rev)
 refresh / setFilters ──> build next off to the side ── (await search/scan) ── commit: publish snapshot, revision++ ──> {state}
```

## Review Focus

1. File ends without a newline, has CRLF and LF mixed, or is empty: no phantom entry, offsets stay correct. Pinned in Task 2.
2. Message contains ` - `, or the source field is empty: fields split correctly. Pinned in Task 1.
3. Boot entries carry a time without a date (`BOOT-------00:00:00.000`): they sort in front of the first dated entry of their file and are not removed by a time filter. Pinned in Tasks 1 and 3.
4. Invalid regex in the text filter, or a new query while the old scan still runs: error message in the UI, old scan is aborted, no crash. Pinned in Task 4.
5. File that matches no format, is binary or UTF-16: falls back to the plain format or shows the encoding error, never hangs. Pinned in Tasks 1 and 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `extension/src/core/logformat.ts` | Format definitions, built-ins, compile, line parsing, time parsing, detection |
| `extension/src/core/logstore.ts` | `EntryStore`: growable columnar storage of scanned entries |
| `extension/src/core/logscan.ts` | Stream a file into an `EntryStore` (chunked, abortable, resumable) |
| `extension/src/core/logfilter.ts` | Timeline order, filters, per-filter hidden counts |
| `extension/src/core/logrows.ts` | Read entry text back from disk, text/regex search (host side), raw byte export |
| `extension/src/core/logsearchWorker.ts` | Worker body of the text search (no `vscode` import) |
| `extension/src/core/logview.ts` | Filtered view: grouping of repeats, deltas, gaps, jump to next error |
| `extension/src/core/logsession.ts` | One viewer's state: files, format, store, filters, bookmarks, live tail |
| `extension/src/views/logViewer.ts` | Custom readonly editor, merged panel, message protocol, commands |
| `extension/media/logViewer.js`, `logViewer.css` | Webview: table, virtual scroll, filter bar, detail pane |
| `extension/media/logScroll.js` | Pure webview logic (scroll mapping, request/revision bookkeeping), loadable by the webview and by `node --test` |
| `extension/test/log*.test.ts` | Tests per core file; fixtures in `extension/test/fixtures/logs/` |

---

### Task 1: Format definitions and line parsing

**Files:**
- Create: `extension/src/core/logformat.ts`, `extension/test/logformat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Level = 'error' | 'warning' | 'info' | 'debug' | 'other';
  export const LEVELS: Level[];                       // order used for the Uint8 level column
  export interface LogFormatDef { id: string; name: string; entry: string; timeFormat?: string; levels?: Record<string, Level>; ignore?: string }
  export interface LogFormat { def: LogFormatDef; entry: RegExp; ignore?: RegExp; time?: { re: RegExp; order: string[] } }
  export interface ParsedLine { seq?: number; time: number; timeText: string; level: Level; levelText: string; source: string; message: string }
  export class LogFormatError extends Error {}
  export const BUILT_IN_FORMATS: LogFormatDef[];      // 'twincat-logger', 'tab-separated', 'plain'
  export function compileFormat(def: LogFormatDef): LogFormat;
  export type LineKind = { kind: 'entry'; entry: ParsedLine } | { kind: 'continuation' } | { kind: 'ignored' };
  export function parseLine(f: LogFormat, line: string): LineKind;   // ignored (header) and continuation are distinct (review C16)
  export function parseTime(f: LogFormat, text: string): number;                   // NaN when it does not match
  export function detectFormat(lines: string[], formats: LogFormat[]): LogFormat;  // never throws; falls back to 'plain'
  export function parseFilterTime(text: string): number;                         // 'yyyy-MM-dd HH:mm[:ss]' as wall-clock Date.UTC; NaN when invalid (review O9)
  ```

- [ ] **Step 1: Write the failing tests** in `logformat.test.ts`:
  - `twincat-logger` parses `0000000042 - 2026-10-19-00:00:21.669 - INFO - fbMain.fbPump.fbValve - Execute` to seq 42, source `fbMain.fbPump.fbValve`, message `Execute`, level `info`, time `Date.UTC(2026,9,19,0,0,21,669)`.
  - Empty source: `0000000001 - 2026-10-19-00:00:21.669 - WARNING -  - Fault active` gives source `''`, message `Fault active`.
  - Message with separators: `... - ERROR - fbMain - Start failed - retry - ()` gives message `Start failed - retry - ()`.
  - Boot line: `0000000003 - BOOT-------00:00:00.000 - DEBUG -  - Interlock active` gives `Number.isNaN(time)`, `timeText` `BOOT-------00:00:00.000`, level `debug`.
  - Header line `Sequence   - Timestamp - Category - Source - Message` gives `{kind:'ignored'}` (via `ignore`), a line `  at stack frame` gives `{kind:'continuation'}`.
  - Dates are validated by round trip (review C16): `2026-02-30-00:00:00.000` and `2026-10-19-24:00:00.000` give NaN, not a normalized date; the same for `parseFilterTime`.
  - `tab-separated` parses `03.04.2024 16:17:13\tInfo\tProgram needed 32 s` (time format `dd.MM.yyyy HH:mm:ss`, level `Info` mapped case-insensitively).
  - Unknown level text maps to `other`.
  - `parseFilterTime('2026-10-19 00:00:21')` equals `Date.UTC(2026,9,19,0,0,21)` whatever the machine's time zone (the webview sends the filter text, the host parses it; never `new Date(text)`), and `'2026-13-01 00:00'` gives NaN.
  - `compileFormat` throws `LogFormatError` for an invalid regex and for an `entry` without a `message` group.
  - `detectFormat` picks `twincat-logger` for 20 logger lines with a header, picks `tab-separated` for tab lines, and returns `plain` for `['\u0000\u0001garbage', 'x']`.
  - `detectFormat` still picks `twincat-logger` when 60 % of the sampled lines are continuation lines of multi-line entries (review R3), and when a rotated file starts with 8 continuation lines before its first entry (review O12).
- [ ] **Step 2: Run** `cd extension && npm test` and confirm the new tests fail (module missing).
- [ ] **Step 3: Implement** `logformat.ts`. Entry regex for the logger: `^(?<seq>\d{10}) - (?<time>\S+) - (?<level>[A-Za-z]+) - (?<source>.*?) - (?<message>.*)$`, `ignore` = the header line. `timeFormat` tokens `yyyy MM dd HH mm ss SSS` compile to a regex plus an order list, other characters are literal; the logger format uses `yyyy-MM-dd-HH:mm:ss.SSS`. After `Date.UTC(...)` the components are read back with `getUTC*` and must equal the parsed ones, else NaN. The entry and ignore regexes are applied to at most the first 8 KB of a line. Named groups: `seq`, `time`, `level`, `source`, `message` (only `message` required). `plain`: every non-empty line is an entry, level found by a case-insensitive word match on error/warn/info/debug, else `other`. Detection: first 200 non-empty, non-ignored lines; `plain` is never ranked, it is the fallback. A format qualifies when at least 30 % of the sampled lines match (continuation lines of multi-line entries do not match, so a fixed 70 % bar would reject logs with stack traces). Highest ratio wins, ties by list order, else `plain`.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log format definitions and line parsing`.

---

### Task 2: Entry store and file scan

**Files:**
- Create: `extension/src/core/logstore.ts`, `extension/src/core/logscan.ts`, `extension/test/logscan.test.ts`, `extension/test/logGen.ts`, `extension/test/fixtures/logs/` (small synthetic files: `logger-lf.log`, `logger-crlf.log`, `logger-nonewline.log`, `multiline.log`, `empty.log`, `utf16.log`)
- Modify: `.gitattributes` (`extension/test/fixtures/logs/** -text`; without it `core.autocrlf=true` turns the LF fixture into CRLF on Windows and the offset tests fail on the Windows release job). The mixed LF/CRLF case is written from a string into a temp file inside the test, not committed.
- Modify: `.github/workflows/ci.yml`: add a job `extension-windows` (`windows-latest`, same checkout/setup-node/`npm ci`/`npm test` steps as `extension`, without packaging), because PR CI runs the extension tests on Ubuntu only and Windows only at release time (review C18). Own commit; if upstream declines the job, run `npm test` on Windows locally before the merge.

**Interfaces:**
- Consumes: `LogFormat`, `parseLine`, `LEVELS` from Task 1.
- Produces:
  ```ts
  export class EntryStore {
    count: number;
    time: Float64Array;      // raw time, NaN when none
    sortTime: Float64Array;  // time used for ordering (see scan)
    level: Uint8Array;       // index into LEVELS
    source: Uint32Array;     // index into sources
    seq: Float64Array;       // the logger writes 10 digits, more than Uint32 holds (review R2); NaN when none
    file: Uint16Array;       // index into the session's file list
    offset: Float64Array;    // byte offset of the entry's first line
    length: Float64Array;    // physical byte length of the whole entry (all its lines, without the final line break)
    firstLength: Uint32Array; // physical byte length of the first line (rows read only this, capped at 8 KB)
    terminated: Uint8Array;  // 1 when the entry ended with a line break in the file
    lines: Uint16Array;      // line count, capped at 65535
    hash: Uint32Array;       // FNV-1a of level + source + message + continuation lines (first 8 KB each) (review C11)
    sources: string[];       // interned source strings
    append(e: { ... }): number;           // returns the entry index; throws LogLimitError past maxEntries / maxSources
    appendFrom(other: EntryStore): void;  // used by the live commit step (State Model)
    truncate(count: number): void;
  }
  export class LogLimitError extends Error {}
  export interface ScanOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void; startOffset?: number; chunkSize?: number /* default 1 MB; tests use 4 */; live?: boolean /* keep an unterminated last line unread */; maxEntries?: number /* default 5e6 */; maxSources?: number /* default 1e6 */ }
  export interface ScanResult { size: number; lastEntryStart: number }   // lastEntryStart = offset of the final entry, for resuming
  export interface RawLine { buf: Buffer; start: number; end: number; offset: number; physEnd: number; terminator: 0 | 1 | 2; truncated: boolean }
  // start/end = retained bytes in buf (at most 1 MB, \r\n excluded); offset..physEnd = the line's physical extent in the file;
  // terminator = 0 (end of file), 1 (\n) or 2 (\r\n); truncated = bytes past the 1 MB cap were skipped (review C8)
  export async function* readLines(path: string, o?: ScanOptions): AsyncGenerator<RawLine[]>;   // one batch per chunk; the only line splitter (review R5)
  export async function scanFile(path: string, fileId: number, format: LogFormat, store: EntryStore, o?: ScanOptions): Promise<ScanResult>;
  export async function sniff(path: string): Promise<{ lines: string[]; encoding: 'utf8' | 'utf16'; validUtf8: boolean; head: Buffer /* first 64 bytes */ }>;   // first 64 KB
  ```

- [ ] **Step 1: Write the failing tests** in `logscan.test.ts`:
  - LF file with 3 entries: `count` 3, offsets are the byte positions of the line starts, `length` excludes the line break.
  - CRLF file gives the same entries; `length` excludes `\r\n`; mixed LF/CRLF works.
  - File without final newline: last entry complete, no phantom empty entry. Empty file: `count` 0, no error.
  - `multiline.log`: continuation lines extend the previous entry (`lines` 3, `length` spans them); leading lines before the first entry are skipped.
  - Boot entries get `sortTime` equal to the time of the next dated entry in the same file (previous one if none follow); `time` stays NaN.
  - Multi-byte characters (`ä`, `€`) at positions that straddle a 4-byte chunk boundary: use a test hook `chunkSize` in the options (`ScanOptions.chunkSize`, default 1 MB) set to 4; offsets and sources stay correct.
  - `signal` aborted mid-scan rejects with `AbortError` and leaves the store usable (`truncate` to the previous count works).
  - `startOffset` resume: scanning from `lastEntryStart` after truncating that entry yields the same store as one full scan.
  - `sniff` reports `utf16` for `utf16.log` (BOM FF FE); `scanFile` is not called for it (the session rejects, Task 5).
  - `sniff` reports `validUtf8: false` for a temp file with byte `0xE4` alone, and `true` for a file whose 64 KB boundary cuts a valid `€` in half (review C12).
  - `readLines` on a 3 MB line followed by a short line: the first `RawLine` has `truncated`, retained bytes of 1 MB, `physEnd - offset` of 3 MB; the second line's `offset` is exact. CRLF split across a 4-byte chunk boundary gives `terminator` 2 (review C8).
  - `maxEntries: 10` on a file with 11 entries rejects with `LogLimitError` and leaves the store at 10 entries; `maxSources` likewise (review C3).
  - `hash` differs for two entries that differ only in level, or only in a continuation line (review C11).
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement.** `EntryStore` doubles its arrays when full. `readLines` owns the chunked reading and line splitting below; `scanFile`, Task 4's search worker and Task 9's tail consume it, none splits lines on its own. Export does not use it: export copies byte ranges (Task 4). `scanFile` reads with `fs.createReadStream` (`highWaterMark = chunkSize`), splits on byte `0x0A` itself, keeps the incomplete tail line between chunks, decodes each complete line with `buf.toString('utf8', s, e)` (strip a trailing `\r` and a BOM at offset 0), calls `parseLine`, and awaits `setImmediate` after each chunk. Offsets are computed from bytes, never from string lengths. Filling `sortTime`: collect indices of NaN entries and patch them when the next dated entry arrives or at the end of the file; a file with no dated entry at all gives them `-Infinity`, so they sort first in a merged view (review O15, add a test). While live (Task 9, `ScanOptions.live`), an unterminated final line is not consumed, so a half-written line never shows as a continuation (review O14).
  Also create `extension/test/logGen.ts`: `writeSyntheticLog(path, bytes, opts?)` writes a generic logger file (levels, 2000 sources, some multi-line entries, optional boot lines). The perf test (Task 11) and the manual 100 MB check (Task 6, via `node -e "require('./out/test/logGen').writeSyntheticLog(...)"`) both use it (review O4).
  Line limits (Global Constraints) are pinned here: a 3 MB file without `\n` gives one entry with exact `length`, and `parseLine` sees only 8 KB of it.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add columnar log entry store and chunked file scan`.

---

### Task 3: Timeline order, filters and hidden counts

**Files:**
- Create: `extension/src/core/logfilter.ts`, `extension/test/logfilter.test.ts`

**Interfaces:**
- Consumes: `EntryStore`, `Level`, `LEVELS`.
- Produces:
  ```ts
  export interface Filters {
    levels: Level[];                 // visible levels; all five by default
    from?: number; to?: number;      // wall-clock ms; entries without a time always pass
    source?: string;                 // case-insensitive substring of the source
    text?: Uint8Array;               // match flag per entry from Task 4, undefined = no text filter
  }
  export interface FilterResult { indices: Uint32Array; hiddenBy: { level: number; time: number; source: number; text: number } }
  export function timelineOrder(store: EntryStore, fileCount: number): Uint32Array;   // one file: entry order as scanned (no sort); several: k-way merge of the per-file runs by sortTime, ties by file index
  export function applyFilters(store: EntryStore, order: Uint32Array, f: Filters): FilterResult;
  ```
  `hiddenBy.x` = entries that pass every other filter but fail filter `x`, i.e. what switching `x` off would reveal.

- [ ] **Step 1: Write the failing tests** with a hand-built store of 8 entries (mixed levels, two sources, one boot entry with NaN time, two files):
  - `timelineOrder` interleaves two files by time and keeps equal times in file order, then offset.
  - Boot entry sorts in front of the first dated entry of its file.
  - One file whose times run `02:30, 02:59, 02:05, 02:40` (DST fall-back) keeps file order with `fileCount` 1 (review R4), and keeps its own order inside a merge too (the merge never reorders entries of one file).
  - `levels: ['error']` returns only errors; `hiddenBy.level` is the number of non-errors that pass the other filters.
  - Time range excludes dated entries outside it, keeps the boot entry.
  - `source: 'PUMP'` matches `fbMain.fbPump` case-insensitively.
  - An entry failing two filters counts in neither `hiddenBy` value; one failing only one counts in that one. The sum check: `indices.length + sum(single-fail counts) <= store.count`.
  - Empty `levels` returns no entries.
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement** with one pass over `order` computing a 4-bit fail mask per entry (level, time, source, text); precompute a `Uint8Array` per source id for the source test. `timelineOrder` for several files merges the per-file runs (each already in file order) with a small binary heap over the file heads: O(n log k), no comparator sort over a million entries, no per-entry objects, so it stays inside the 200 ms budget (review C13).
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log timeline order and filters with hidden counts`.

---

### Task 4: Row reading and text search

**Files:**
- Create: `extension/src/core/logrows.ts`, `extension/src/core/logsearchWorker.ts`, `extension/test/logrows.test.ts`

**Interfaces:**
- Consumes: `EntryStore`, `LogFormat`, `parseLine`.
- Produces:
  ```ts
  export interface EntryRef { file: number; offset: number; length: number; firstLength: number }   // copied from the store before any await (State Model)
  export interface EntryText { first: ParsedLine; text: string; truncated: boolean }
  export interface TextQuery { query: string; regex: boolean; caseSensitive: boolean }
  export class LogFiles { constructor(paths: string[]); acquire(): () => void; close(): Promise<void> }   // keeps handles open; close waits until every acquire() is released
  export async function readPreviews(files: LogFiles, formats: LogFormat[] /* per file id */, refs: EntryRef[]): Promise<ParsedLine[]>;   // first line only, at most 8 KB read (review C7)
  export async function readDetail(files: LogFiles, formats: LogFormat[], ref: EntryRef, maxBytes?: number /* 1 MB */): Promise<EntryText>;
  export interface SearchResult { flags: Uint8Array; from: number; bytesRead: number }   // flags[i] belongs to entry from + i
  export async function searchText(paths: string[], refs: { file: Uint16Array; offset: Float64Array; length: Float64Array } /* copies, see below */, formats: LogFormatDef[], q: TextQuery, from: number, signal?: AbortSignal): Promise<SearchResult>;
  // runs in a worker_threads Worker (out/src/core/logsearchWorker.js), terminated on abort (review O2); reads files from offset[from] on (review C9)
  export function compileQuery(q: TextQuery): RegExp;                    // throws LogFormatError('Invalid regular expression: …')
  export async function exportRaw(files: LogFiles, refs: EntryRef[] | Iterable<EntryRef>, out: (chunk: Buffer) => Promise<void>, signal?: AbortSignal): Promise<void>;
  // contract (review C14): for each entry its original bytes (offset, length) followed by one "\n"; no BOM; UTF-8 or not, bytes are copied, never re-encoded
  ```

- [ ] **Step 1: Write the failing tests** against the fixtures of Task 2:
  - `readPreviews` returns the parsed first line; refs from two files work; for an entry with 50,000 continuation lines (temp file, about 5 MB) it returns only the first line (the read size follows from `firstLength`, so no I/O spy is needed). `readDetail` returns the full text of a multi-line entry, and for that 5 MB entry with `maxBytes` 1 MB returns `truncated: true` (review C7).
  - `LogFiles.close()` waits until an `acquire()`d reader releases it (State Model).
  - `searchText` plain, case-insensitive: flags exactly the entries whose source, message or continuation lines contain the query; time and level text never match (searching `INFO` does not flag every info entry; the level filter does that) (review R9); case-sensitive flag respected; regex mode matches `Start failed \(\)`.
  - Multi-line entries match on any of their lines.
  - `compileQuery({ query: '(', regex: true, ... })` throws `LogFormatError` with message starting `Invalid regular expression`.
  - An aborted signal rejects with `AbortError`; a second call after it still works.
  - Catastrophic regex `(a+)+$` on a synthetic file with a 5000-character line of `a` followed by `!`: aborting after 200 ms rejects within 500 ms, and a `setImmediate` callback scheduled during the search runs on time (the host's event loop is never blocked) (review O2).
  - `searchText` with `from` = k returns flags only for entries ≥ k, equal to the full search's flags there, and `bytesRead` is at most `size - offset[k]` (review C9).
  - After a search, also an aborted one, the caller's arrays are still usable (`byteLength` unchanged) (review C1).
  - `exportRaw` emits the original bytes of the given entries in the given order, each followed by `\n`; a CRLF file keeps the `\r\n` inside multi-line entries; the last entry of a file without final newline still gets its `\n`, so two merged files never glue lines together (review C14). An aborted signal stops between chunks with `AbortError`.
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement.** `readPreviews` sorts the refs by `(file, offset)`, reads `min(firstLength, 8 KB)` bytes each with `FileHandle.read`, and returns results in the requested order; `readDetail` reads `min(length, maxBytes)`. Both hold an `acquire()` of `LogFiles` while reading. `searchText` starts `logsearchWorker.ts` (Create it too; `core/` rule: no `vscode` import). **Buffer ownership (review C1):** the session passes `slice()` copies of the `file`/`offset`/`length` columns from `from` to the end (14 bytes per entry, about 14 MB for a full search, nothing for a tail search) and transfers those copies; the store's own buffers are never transferred. The worker opens the files itself, seeks to `offset[from]` of each file, streams through `readLines` (Task 2), tests source, message and continuation lines of each entry (first 8 KB per line) and posts back the worker-owned `flags` (transferred) and `bytesRead`. On abort the host calls `worker.terminate()`. A plain query is escaped into a `RegExp`; `compileQuery` runs in the host first, so a syntax error never starts a worker. The scan stays in the host (Known limit, Global Constraints). `exportRaw` copies byte ranges with `FileHandle.read` in chunks of at most 1 MB, never through decoded strings.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log row reading, text search and raw export`.

---

### Task 5: Viewer session, grouping, gaps and jump

**Files:**
- Create: `extension/src/core/logview.ts`, `extension/src/core/logsession.ts`, `extension/test/logview.test.ts`, `extension/test/logsession.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces:
  ```ts
  export interface LogRow { pos: number; index: number; file: string; seq?: number; time: string; timeMs: number; level: Level; source: string;
    message: string; extraLines: number; repeat: number; deltaMs?: number; gap: boolean; bookmarked: boolean }
  export interface ViewOptions { groupRepeats: boolean; gapMs: number }
  export interface SessionFilters { levels: Level[]; from?: number; to?: number; source?: string; text?: TextQuery }
  export class LogView {                                   // pure: built from store + FilterResult
    constructor(store: EntryStore, indices: Uint32Array, o: ViewOptions);
    readonly rowCount: number;                            // rows after grouping; the webview's scroll height (review C6)
    rowEntries(pos: number, count: number): { index: number; repeat: number }[];   // index = first member of the group
    members(pos: number): Uint32Array;                    // all entries of a row's group, in view order (review C11)
    previousTime(pos: number): number | undefined;        // time of the row before, for deltas
    find(from: number, dir: 1 | -1, pred: (index: number) => boolean): number;   // row position or -1
  }
  export class StaleError extends Error {}                // request made for an older revision (State Model)
  export interface SessionState { revision: number; fileGeneration: number; files: string[]; formats: string[] /* per file (review O7) */;
    filters: SessionFilters; options: ViewOptions; total: number; matched: number /* entries */; rowCount: number /* rows after grouping */;
    hiddenBy: FilterResult['hiddenBy']; levelCounts: Record<Level, number>; viewFirstTimeMs?: number /* baseline of "relative" mode (review C6) */;
    firstTimeMs?: number; lastTimeMs?: number; scanning: number /*0..1*/; live: boolean; warning?: string /* e.g. not valid UTF-8 */; error?: string }
  export class LogSession {
    static open(paths: string[], formats: LogFormatDef[], o: ViewOptions): LogSession;   // user formats are tried before built-ins
    load(onProgress?: (f: number) => void): Promise<void>;       // sniff, detect, scan, order; rejects with a clear message for UTF-16 and with LogLimitError
    setFilters(f: Partial<SessionFilters>): Promise<void>;       // only a text-query change aborts the running search
    setOptions(o: Partial<ViewOptions>): void;                   // synchronous publish, never aborts a search
    rows(revision: number, pos: number, count: number): Promise<LogRow[]>;   // rejects with StaleError for an older revision
    detail(revision: number, pos: number): Promise<{ text: string; truncated: boolean }>;
    toggleBookmark(revision: number, pos: number): void;         // bookmarks the group's first member
    jump(revision: number, from: number, dir: 1 | -1, what: 'error' | 'bookmark'): number;
    setLive(on: boolean): void;                                  // ingestion on/off (review C17); "follow the end" is webview-only state
    state(): SessionState;
    exportTo(dest: string, signal?: AbortSignal): Promise<void>; // Task 10
    dispose(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests.** `logview.test.ts` with a store of identical consecutive entries:
  - `groupRepeats: true` collapses consecutive entries with equal source and hash into one row with `repeat` equal to the run length; entries separated by another entry do not merge; `rowCount` shrinks accordingly; `members(pos)` returns every entry of the group. An INFO and an ERROR entry with the same source and message stay two rows (the hash includes the level, review C11).
  - `find` returns the next/previous position matching a predicate, `-1` at the ends.
  - `previousTime` supports the delta of the first row of a window.
  `logsession.test.ts` with fixtures:
  - `load` detects the logger format and fills `state()` (`total`, `levelCounts`, first/last time).
  - `rows(0, 2)` returns `deltaMs` as the difference to the previous visible row (`undefined` for the first), and `gap: true` when the delta exceeds `gapMs`.
  - `setFilters({ levels: ['error'] })` changes `matched`; `hiddenBy.level` is reported; a second `setFilters` while a text search runs aborts the first without an unhandled rejection.
  - Invalid text regex sets `state().error` to `Invalid regular expression…` and keeps the previous result.
  - Bookmarks: `toggleBookmark` twice clears it; `jump(..., 'bookmark')` finds the next one; `rows` reports `bookmarked`.
  - Two files in one session merge by time; `rows[].file` is the base name.
  - `load` of `utf16.log` rejects with a message containing `UTF-16`.
  - Consistency without blocking (State Model; review R12, O1, C2): `rows()` answers from the current snapshot also while a text search runs; a second text query aborts the running search at once and no unhandled rejection remains; `setOptions` and a level change during a running search do not abort it, and the search result is applied with the new options; `rows()` with an older revision rejects with `StaleError`; `dispose()` during a search and during a `rows()` read resolves without errors and closes the files after the read. The `refresh()` interleavings live in Task 9.
  - `state().rowCount` equals `matched` without grouping and is smaller with grouping; `viewFirstTimeMs` is the time of the first row of the filtered view (review C6).
  - A `plain` temp file of 30 entries opened with `maxEntries` 20 (test option) rejects `load` with `LogLimitError` (review C3).
  - A file with invalid UTF-8 opens and `state().warning` says so (review C12).
  - Mixed formats (review O7): merging a logger file and a tab-separated file detects the format per file; `rows` parses each entry with its file's format.
  - `state()` carries the current filters and options, so a rebuilt webview can redraw its filter bar (review O8).
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement** the State Model section above. The session owns one `LogFiles`, one `EntryStore`, the current snapshot, the current `SessionFilters`, the text flags of the current query, and the bookmark set. A text-query change: abort the running search synchronously, start a new one (copied columns, Task 4), and on success publish a snapshot only if no newer query arrived meanwhile. All other changes rebuild filter result and view synchronously from the current flags and publish. `rows`/`detail`/`jump`/`toggleBookmark` check the revision, copy the `EntryRef`s of the window synchronously, then read with `readPreviews`/`readDetail` under `LogFiles.acquire()`. Detection runs per file; each entry is parsed with its file's format. `rows` shortens the message to its first line (`extraLines` = line count - 1). Bookmarks are a `Set` of entry indices for the current `fileGeneration`.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log viewer session with grouping, gaps and navigation`.

---

### Task 6: Custom editor and virtual-scrolled table

**Files:**
- Create: `extension/src/views/logViewer.ts`, `extension/media/logViewer.js`, `extension/media/logViewer.css`, `extension/media/logScroll.js`, `extension/test/logScroll.test.ts`
- Modify: `extension/package.json` (customEditors, commands, menus, configuration), `extension/src/extension.ts` (register next to `registerPlcArchiveEditor`)

**Interfaces:**
- Consumes: `LogSession`, `SessionState`, `LogRow` (Task 5).
- Produces: view type `iecode.logViewer` (`CustomReadonlyEditorProvider`, selector `*.log`, priority `option`, so the plain text editor stays the default). **Decision:** a readonly provider with our own document, not a text document, because VS Code does not hand 100 MB files to a text editor. Command `iecode.logViewer.open` (explorer and editor title context for `*.log`; opens the active file). Settings: `iecode.logViewer.formats` (array of format definitions as in Task 1; the description warns that a regex with catastrophic backtracking blocks VS Code while a file is scanned, Global Constraints "Known limit"), `iecode.logViewer.gapSeconds` (default `5`), `iecode.logViewer.groupRepeats` (default `false`).
  Webview protocol (every request carries the `rev` it was made for, State Model), webview to host: `{type:'ready'}`, `{type:'rows', rev, pos, count, id}`, `{type:'filters', ...}`, `{type:'options', ...}`, `{type:'detail', rev, pos}`, `{type:'jump', rev, from, dir, what}`, `{type:'bookmark', rev, pos}`, `{type:'live', on}`, `{type:'export'}`, `{type:'openRaw'}`. Host to webview: `{type:'state', state}` (carries `state.revision`), `{type:'rows', rev, id, pos, rows}`, `{type:'detail', rev, pos, text, truncated}`, `{type:'jumped', rev, pos}`, `{type:'stale', rev}`, `{type:'error', message}`. The scroll height uses `state.rowCount`, never `matched`. One panel per document: `supportsMultipleEditorsPerDocument` stays off (the default), so the document owns the session and the panel owns only its subscriptions.
  `media/logScroll.js` (plain JS, ends with `if (typeof module === 'object') module.exports = { ... }` so `node --test` can `require` it; the webview loads it with its own nonce `<script>` before `logViewer.js`): `rowToScrollTop(row, rowCount, viewportPx)`, `scrollTopToRow(scrollTop, rowCount, viewportPx)` (real height up to 10 M px, proportional above), `windowFor(firstRow, visibleRows, rowCount)` (about 200 rows with margin, clamped), and a small request tracker `createRequests()` with `next(rev)`, `accept(reply)` (drops replies with an older `id` or a `rev` other than the current one) and `onState(rev)`.

- [ ] **Step 1: Write `test/logScroll.test.ts` first** (review C15): `scrollTopToRow(rowToScrollTop(r))` round-trips for `rowCount` 100 and 5,000,000 (proportional mode) at the first, a middle and the last row; the last row is reachable; `windowFor` never asks beyond `rowCount` or below 0; the tracker drops an older `id`, drops a reply for `rev` 3 after `onState(4)`, and accepts the current one. Run `npm test`, confirm failure, implement `logScroll.js`, run again.
- [ ] **Step 1b: Manual check list** (rendering and workbench integration cannot run under `node --test`): write the list into the task's commit body and run it in step 4: open a small log, open a 100 MB file generated with `writeSyntheticLog` (Task 2), scroll with the thumb and the wheel, resize the window, switch theme.
- [ ] **Step 2: Implement `logViewer.ts`.** Content security policy as in `plcArchiveEditor.ts`. `openCustomDocument` rejects a non-`file:` URI with a clear message and the "Open as text" button (Global Constraints). The provider creates a `LogSession` per document, sends `state` after `load` with progress while scanning, answers `rows` requests, and disposes the session with the document. Register with `webviewOptions: { retainContextWhenHidden: true }` as `plcArchiveEditor.ts:102` does; after a window reload the webview redraws its filter bar from `state.filters`/`state.options` (review O8). A "Open as text" button sends `openRaw` (`vscode.openWith` default).
- [ ] **Step 3: Implement the webview.** All log text goes into the DOM with `textContent` (Global Constraints; manual check: a synthetic entry `<img src=x onerror=alert(1)>` shows as text). Fixed row height of 20 px, columns: line marker (bookmark), time, level (colored with `--vscode-errorForeground`, `--vscode-editorWarning-foreground`, `--vscode-editorInfo-foreground`, and `--vscode-descriptionForeground` for debug and other, review O18), source, message. Virtual scroll renders only visible rows plus a margin and requests windows of about 200 rows; the mapping (real height up to 10 million px, proportional above) and the stale-reply handling come from `logScroll.js`; on `{type:'stale'}` the webview re-requests with the current revision. Status line: `matched / total`, scan progress while scanning, `state.warning` and `state.error`.
- [ ] **Step 4: Compile and run the checks.** `cd extension && npm test` (type check), then F5 in VS Code and go through the list.
- [ ] **Step 5: Commit** `Add log viewer editor with virtual-scrolled table`.

---

### Task 7: Filter bar, detail pane and navigation

**Files:**
- Modify: `extension/media/logViewer.js`, `extension/media/logViewer.css`, `extension/src/views/logViewer.ts`

**Interfaces:**
- Consumes: protocol of Task 6.
- Produces: UI only.

- [ ] **Step 1: Implement the filter bar.** One toggle per level showing its count; time range as two text inputs (`yyyy-MM-dd HH:mm:ss`, empty = open; the webview sends the text, the host parses it with `parseFilterTime`, an invalid value shows red under the input) with a preset "first / last N minutes"; source text input; text input with `.*` (regex) and `Aa` (case) toggles. Next to each filter the number from `hiddenBy` ("hidden: 1,203") shown only when above zero. Inputs debounce by 250 ms. `state.error` appears red under the text input.
- [ ] **Step 2: Implement the detail pane.** Clicking a row opens a bottom pane with all fields and the full multi-line text (request `detail`; when `truncated`, a note "Showing the first 1 MB, open as text for the rest"); rows with `extraLines` show `+N lines`; a group row lists its member count.
- [ ] **Step 3: Implement navigation.** Buttons and keys: next / previous error (`F8` / `Shift+F8`), toggle bookmark (`Ctrl+F2` on the selected row), next / previous bookmark (`F2` / `Shift+F2`). The keys are contributed as commands with keybindings in `package.json` (`when`: `activeCustomEditorId == 'iecode.logViewer' || activeWebviewPanelId == 'iecode.logViewer.merged'`), which post to the webview; no raw `keydown` handlers, because webview key presses also reach the workbench and `F8` would run "Go to Next Problem" too (review O11). On macOS `Ctrl+F2` becomes `Cmd+F2` (`mac` keybinding field). Manual check (review C17): the keys work in the custom editor and in the merged panel, also while the focus is in a filter input, and `F8` does not move the Problems selection. `jump` scrolls the row to the middle of the view; error navigation and bookmarks work on rows (a group is one row, its level is uniform because the hash includes the level).
- [ ] **Step 4: Implement time display modes.** Toggle between absolute, relative to `state.viewFirstTimeMs`, the first entry of the filtered view (not the top row of the viewport, so values stay put while scrolling, review O19, C6), and delta to the previous row (`deltaMs`, formatted `+30 ms`, `+2.4 s`, `+3 min`); gaps (`gap: true`) get a top border and the delta in the warning color. A negative delta (clock jumped back, DST fall-back) shows as `-59 min` in the warning color, and in merged views it is normal between files. Option "group repeats" shows `×N` after the message.
- [ ] **Step 5: Run the manual checks** (small file: each filter alone and combined; hidden counts change as expected; keys work; gap marker appears; large file stays responsive while typing in the text filter). Commit `Add filters, detail pane and navigation to the log viewer`.

---

### Task 8: Merge several files on one timeline

**Files:**
- Modify: `extension/src/views/logViewer.ts`, `extension/package.json`, `extension/src/core/logfilter.ts`, `extension/test/logfilter.test.ts`, `extension/src/core/logsession.ts`, `extension/test/logsession.test.ts`, `extension/media/logViewer.js`

**Interfaces:**
- Consumes: `LogSession.open(paths, …)` already supports several files (Task 5).
- Size guard (review O6, C3): before opening, the command sums the file sizes; above 500 MB it asks for confirmation with the total. The hard bound is the session's entry and source limit (Global Constraints), which also applies to merges.
- Produces: command `iecode.logViewer.openMerged`; the `file` column in the webview is shown only when `state.files.length > 1`.

- [ ] **Step 1: Implement the command** for the explorer (multi-select of `*.log` files; also a folder: all `*.log` files directly inside) and for the command palette (multi-select quick pick of `*.log` files from the workspace). It opens a `WebviewPanel` with view type `iecode.logViewer.merged` (a merged view has no single document), titled `Logs (N files)`, with the same webview and protocol.
- [ ] **Step 2: Add the file column** with a color stripe per file so interleaved sources are distinguishable, and a per-file toggle in the filter bar (hide a file; implemented by a source-style filter on the file index, extend `Filters` with `files?: number[]` and `hiddenBy` with `file`, and a test in `logfilter.test.ts` first).
- [ ] **Step 3: Verify manually** with three synthetic files whose times interleave; total entries equal the sum; order is by time. Commit `Merge several log files on one timeline`.

---

### Task 9: Live tail

**Files:**
- Modify: `extension/src/core/logsession.ts`, `extension/test/logsession.test.ts`, `extension/src/views/logViewer.ts`, `extension/media/logViewer.js`

**Interfaces:**
- Consumes: `ScanResult.lastEntryStart`, `EntryStore.appendFrom`/`truncate`, `ScanOptions.startOffset`/`live`, `searchText(..., from)`.
- Produces: `LogSession.refresh(): Promise<boolean>` (true when something changed). **Decision:** live tail only for single-file sessions; merged sessions stay static.
- File identity (review O5, C10): at load the session keeps `fstat` of its open handle (`dev`, `ino`, `birthtimeMs`) plus size and the first 64 bytes. `refresh` compares `stat(path)` with that: a different `dev`/`ino` (or, where `ino` is 0, a different `birthtimeMs`) means replaced; a smaller size or a changed first 64 bytes means rewritten in place. Both trigger a full reload with a new `fileGeneration`.

- [ ] **Step 1: Write the failing tests:**
  - Appending two entries to a fixture copy and calling `refresh()` adds exactly two entries and keeps earlier row positions; appending a continuation line to the last entry updates that entry's `lines` without a duplicate; calling `refresh()` without changes returns `false`; a half-written last line (no `\n` yet) does not appear until it is complete.
  - Full reload: a file that became shorter; a file deleted and recreated with the same first 64 bytes and the same size (detected by `ino`/`birthtimeMs`; skip with a note where the file system reports neither); a file rewritten in place with a different start. Each bumps `fileGeneration`, clears bookmarks and text flags, and reopens `LogFiles`; a `rows()` read started before the reload finishes on the old handles.
  - Interleavings (State Model, moved here from Task 5): `rows()` while `refresh()` scans answers from the previous snapshot; `setOptions` during `refresh()` does not drop the refresh (both effects are visible afterwards); ten watcher events in a row run at most two refreshes (coalescing); `dispose()` during `refresh()` resolves without errors.
  - With a text filter set, `refresh()` after an append flags the new matching entry, keeps the earlier flags, and the search's `bytesRead` is at most the appended bytes plus the last entry (review P1, C9).
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement `refresh`** per the State Model: compare identity; on a plain append scan from the last entry's offset into a separate tail `EntryStore` (`live: true`), run the text search on the tail only (`from` = index of the last entry), then commit synchronously (replace the last entry, `appendFrom`, extend the flags, rebuild order/filter/view, publish). The perf test of Task 11 adds a case: append 10 lines with a text filter set, `refresh()` within 200 ms.
- [ ] **Step 4: Wire the UI.** The editor watches the file (`vscode.workspace.createFileSystemWatcher` on its URI, plus a 2 s poll fallback while live is on), calls `refresh` (coalesced), and sends a new `state`. Two separate states (review C17): **Live** (session-owned, `setLive`): watch and ingest new entries or not; on by default only when the file changed within the last minute. **Follow** (webview-owned): keep the view at the end. Follow switches off when the user scrolls up and on again when they scroll to the bottom or press `End`; the **Pause** button is "Follow off" while ingestion continues.
- [ ] **Step 5: Run** `npm test`, expect PASS; manual check with a script appending lines every 500 ms. Commit `Follow growing log files in the log viewer`.

---

### Task 10: Export of the filtered view

**Files:**
- Modify: `extension/src/core/logsession.ts`, `extension/test/logsession.test.ts`, `extension/src/views/logViewer.ts`, `extension/media/logViewer.js`

**Interfaces:**
- Consumes: `exportRaw` (Task 4).
- Produces: `LogSession.exportTo(dest, signal)`. Contract (review C4, C14): all matched entries in view order, also every member of a grouped row (not only the representative), each as original bytes plus `\n` (Task 4); `dest` must not be any input file (compared after `fs.realpath`, case-insensitively on Windows), else `LogFormatError('Cannot export into a file that is open in the viewer')`; output goes to `<dest>.<random>.tmp` in the same folder and is renamed to `dest` only after success; on abort or write error the temp file is deleted and `dest` is untouched.

- [ ] **Step 1: Write the failing tests** in `logsession.test.ts`: export with `levels: ['error']` writes exactly the error entries' bytes; with grouping on, a group of 3 exports 3 entries; `dest` equal to the input path (also with different case on Windows) rejects and the input is unchanged; aborting mid-export leaves neither `dest` nor a temp file; an existing `dest` with other content is replaced only after success (abort leaves the old content).
- [ ] **Step 2: Implement `exportTo`**, then the Export button: save dialog (default name `<file>.filtered.log`, overwrite confirmation is the dialog's), progress notification with cancel wired to the `AbortSignal`.
- [ ] **Step 3: Run** `npm test`, expect PASS; verify manually that exporting with only errors visible yields a file that opens in the viewer with `total` equal to the exported `matched`. Commit `Export the filtered log view`.

---

### Task 11: Performance check, documentation, TODO

**Files:**
- Create: `extension/test/logPerf.test.ts`
- Modify: `extension/CHANGELOG.md`, `extension/README.md` (if it lists features), `TODO.md`

- [ ] **Step 1: Write the perf test** (runs only when `IECODE_PERF=1`, so the default `npm test` stays fast): generate a 100 MB synthetic logger file in the OS temp folder with `writeSyntheticLog` (Task 2; about one million lines, five levels, 2000 distinct sources, a few multi-line entries), then assert: `load` finishes within 30 s; peak `process.memoryUsage().rss` growth (sampled every 50 ms during load and search, so the Worker's memory counts too) stays below 300 MB for this logger profile; `setFilters({ levels: ['error'] })` finishes within 2 s; a plain text search finishes within 15 s; `monitorEventLoopDelay` (resolution 10 ms) reports a max below 200 ms during load, filter, a 3-file merge order and the refresh case (review C13); the live-tail case from Task 9. Two extra cases (review C3): a 100 MB `plain` file of 2-byte lines stops with `LogLimitError` within 10 s and below 400 MB peak; a 100 MB logger file with 500,000 distinct sources loads below the source limit and its peak is recorded. Print the measured numbers.
- [ ] **Step 1b: Packaging check** (review C18): `npx @vscode/vsce@4.0.0 ls --no-dependencies` (the `package` script's tool) must list `out/src/core/logsearchWorker.js` and `media/logScroll.js`; add that check as a step to the `extension` CI job after `npm run package` (`... ls --no-dependencies | grep -q logsearchWorker.js`), own commit.
- [ ] **Step 2: Run** the perf file alone, so the other test files do not run in parallel and distort the times (review O17): `npm run compile`, then (PowerShell) `$env:IECODE_PERF=1; node --test out/test/logPerf.test.js`, and record the numbers in the task's commit body. If a limit fails, fix the scan or filter code before continuing (typical causes: per-line string allocation, per-entry object creation).
- [ ] **Step 3: Document.** CHANGELOG entry (log viewer, formats setting, size limit tested, live tail, merge); README feature line; in `TODO.md` link this plan under the "Log file viewer" item, tick what is done and list what is left: "ask AI about this entry", source tree filter, custom-format editor UI, notes on formats other than the two built-ins, the viewer in Restricted Mode (the extension declares `untrustedWorkspaces.supported: false`, so logs opened from an untrusted folder such as Downloads get no viewer; review O10), restoring the merged panel after a reload (no serializer).
- [ ] **Step 4: Commit** `Test log viewer on a 100 MB file and document it`.

---

## Self-Review

- **Coverage of the TODO item:** filters (severity, time range, text and regex, source, hidden counts) Tasks 3, 5, 7; presentation (columns, colors, collapsed multi-line, relative timestamps and gaps) Tasks 6, 7; live tail, error jump, bookmarks, merge, group repeats, export Tasks 7 to 10; format-agnostic definitions Task 1 (settings in Task 6); first format logger Task 1; large files Tasks 2, 4, 6, 11. Left out on purpose: "ask AI about this entry" (needs the AI interface decision), a UI to edit format definitions.
- **Types:** `LogRow`, `SessionState` (with `revision`, `rowCount`), `Filters` (extended by `files` in Task 8, with its test), `ScanOptions.chunkSize`/`live`/`maxEntries`, `EntryRef`, `LineKind`, `StaleError`, `LogLimitError` are named the same in every task.
- **Proportion:** each task names signatures, test cases and the spec values; algorithm bodies are left to the implementer except the scan and virtual-scroll constraints that decide behavior.

---

## Engineering Review (2026-11-04, /plan-eng-review)

Target: this plan, at commit 784a72b. All decisions below were made by the reviewer on the owner's explicit delegation ("du triffst alle entscheidungen", chat of 2026-11-04); each one picked the recommended option. The accepted changes are already written into the tasks above, marked `review R<n>`, `review P<n>` or `review O<n>`.

### Scope Challenge

- Complexity: 12 new source files (7 core incl. `logsearchWorker.ts`, 1 view, 2 media, test helper `logGen.ts`), 8 test files, 6 modified files; about 9 new classes/modules. The gate tripped.
- Feature cuts considered: merge (Task 8), live tail (Task 9), export (Task 10). Kept: live tail and merge are owner decisions from the planning session, and Tasks 1-7 already form a usable stop point inside the branch.
- Structure: original arrangement kept. Merging `logstore` into `logscan` or `logview` into `logsession` would save two files but join pure, separately tested units with I/O code.
- Result: **scope accepted as-is**.
- Reality rows: premise table 7 claims, 1 unverified ("VS Code does not hand 100 MB files to a text editor": from documentation knowledge, not probed; the decision does not depend on it). Already-done: no log viewer code on `origin/main` or the branch (`git log origin/main --grep "log viewer"` empty). Surface check: `npm test` = `tsc -p . && node --test out/test/*.test.js` (`extension/package.json:1523`), `vscode.openWith` used at `plcArchiveEditor.ts:74`. Binding decisions: UTC wall clock, readonly editor, live tail single-file; none overruled (R4 refines the DST claim, keeps UTC). Numbers: memory per entry about 49 bytes [estimated], 100 MB about 1 M lines [estimated], all perf limits [re-measure in Task 11]. Deferred asks: "ask AI" and the format editor UI, with reasons in Self-Review. PR count: one PR, but the branch is stacked on `ph/ads-mcp-server`, so it can only merge after that one.

### Decision ledger

| ID | Finding (severity, confidence, source) | Decision | Where |
|---|---|---|---|
| R1 | CRITICAL 9/10: no `.gitattributes` rule for `*.log`, `core.autocrlf=true` here, so the LF fixture checks out as CRLF and Task 2's offset tests break on the Windows release job (`.gitattributes`, `release.yml:14`) | `-text` rule for the fixture folder; mixed-ending file built in the test | Global Constraints, Task 2 |
| R2 | 8/10: `seq: Uint32Array` but the logger writes `\d{10}` (up to 9 999 999 999) | `Float64Array` | Task 2 |
| R3 | 7/10: 70 % detection bar fails for logs with many stack-trace lines | 30 % bar, `plain` never ranked; test | Task 1 |
| R4 | 8/10: DST fall-back repeats an hour; sorting one file by wall clock interleaves it | single file keeps file order; negative deltas shown | Global Constraints, Tasks 3, 7 |
| R5 | 7/10: "extract a helper if needed" leaves two line splitters (red flag "two ways") | one `readLines` for scan, search, tail (export copies byte ranges since C8) | Tasks 2, 4 |
| R6 | 7/10: `chunkSize` used in tests but missing from `ScanOptions` | added (factual correction) | Task 2 |
| R7 | 7/10: log text is untrusted, rendering not specified | `textContent` only, manual check | Global Constraints, Task 6 |
| R8 | 6/10: Open With on `git:`/`iecode-rev:` URIs would fail inside `fs` | `file:` only, clear message | Global Constraints, Task 6 |
| R9 | 7/10: search scope contradicts itself ("source or message" vs "entry text") | source + message + continuation lines | Task 4 |
| R12 | 7/10: `rows()` racing `setFilters`/`refresh` | revised by O1, then replaced by the State Model (C2) | Tasks 5, 9 |
| P1 | 7/10: live tail discarded text flags, so each append re-read 100 MB with a text filter | flags extended incrementally; perf case | Task 9, Task 11 |
| O1 | High: one queue would block scrolling behind a 15 s search, and a queued abort fires too late | abort on arrival, slow work outside, reads never wait; made concrete by the State Model (C2) | Task 5, State Model |
| O2 | High: a pathological regex never yields and freezes every extension in the host | text search in a `worker_threads` Worker, `terminate()` on abort; 8 KB regex input cap; scan stays in host (fallback noted) | Architecture, Task 4 |
| O3 | High (not observed: 41 sample files are pure ASCII): non-UTF-8 logs | `latin1` fallback, **replaced by C12**: no fallback, UTF-8 with a warning | Global Constraints |
| O4 | Medium: Task 5 test used Task 9's `refresh`; Task 6 used a Task 11 "script"; Task 8 file list incomplete | test moved, `logGen.ts` in Task 2, file list completed | Tasks 2, 5, 6, 8, 9 |
| O5 | Medium: rotation that grows past the old size before the next poll | identity check (refined by C10: `dev`/`ino`/`birthtimeMs` plus prefix), reopen, clear bookmarks and flags | Task 9 |
| O6 | Medium: no limit for huge lines or huge merges | 1 MB line / 8 KB regex / 2000-char message caps; 500 MB merge confirm | Global Constraints, Tasks 2, 8 |
| O7 | Medium: merge assumed one format | detection per file | Tasks 4, 5 |
| O8 | Medium: webview state after reload | `retainContextWhenHidden`, filters/options in `state` | Tasks 5, 6 |
| O9 | Medium: time filter could be parsed in local time | `parseFilterTime` in the host, tested | Tasks 1, 7 |
| O10 | Medium: Restricted Mode disables the viewer | deferred: TODO entry in Task 11 (changing workspace trust touches the whole extension) | Task 11 |
| O11 | Medium: raw `F8` keydown also triggers workbench commands | contributed keybindings with `when` clauses | Task 7 |
| O12 | Medium: rotated file starting mid stack trace | dropped the "first 5 lines" rule; test | Task 1 |
| O13 | Medium: ship after Task 7, move 8-10 to a follow-up | rejected: live tail and merge are owner decisions; Task 7 is the internal stop point | - |
| O14-O20 | Low: half-written line, boot-only file, memory figure, perf noise, debug color, "relative" meaning, settings decision | all accepted | Tasks 1, 2, 6, 7, 9, 11, Global Constraints |

Approval readiness: PASS (R1-R9, R12, P1, O1-O20; authority: owner delegation of 2026-11-04).

### Copilot second opinion (2026-11-04, GitHub Copilot CLI, model gpt-6.1-sol)

Verdict given: "execute only after a targeted redesign of state ownership, worker boundaries and bounded I/O". Each point was checked against the plan and the code; the owner approved folding in the accepted ones ("ja arbeite es ein", chat of 2026-11-04). Markers `review C<n>` above.

| ID | Finding | Check | Decision | Where |
|---|---|---|---|---|
| C1 | Transferring store columns to the Worker detaches them | valid: the plan said "transferred typed arrays" | send `slice()` copies, never the store's buffers; test arrays stay usable | Task 4 |
| C2 | Generation checks do not make a mutating refresh safe; options abort refreshes; handles closed under readers | valid | State Model: immutable snapshots, tail built aside, synchronous commit, coalescing, ref-counted `LogFiles` | State Model, Tasks 5, 9 |
| C3 | Memory bound only holds for logger files; `plain` with short lines needs about 2.5 GB | valid | 5 M entry / 1 M source limit with `LogLimitError`; RSS peak measured; extra perf cases | Global Constraints, Tasks 2, 5, 11 |
| C4 | Export can overwrite an input file; cancel not wired | valid | reject inputs (realpath), temp file plus rename, abort cleans up | Task 10 |
| C5 | Format regexes in the host stay unbounded | partly: built-ins are linear, user regexes are deliberate input in a trusted workspace | documented known limit, warning in the setting; scan-in-Worker stays the fallback | Global Constraints, Task 6 |
| C6 | Protocol lacks `rowCount` and revisions; relative-time baseline vague | valid | `revision` on every message, `rowCount`, `viewFirstTimeMs`, `stale` reply | State Model, Tasks 5, 6, 7 |
| C7 | Line cap does not bound an entry; previews read whole entries | valid | `firstLength` column, previews read ≤ 8 KB, detail ≤ 1 MB with `truncated` | Tasks 2, 4 |
| C8 | `RawLine` cannot describe truncated physical lines; export through capped lines loses bytes | valid | `physEnd`, `terminator`, `truncated`; export copies byte ranges | Tasks 2, 4 |
| C9 | Incremental flags still re-read the whole file | valid | worker seeks to `offset[from]`, reports `bytesRead`, tested | Tasks 4, 9 |
| C10 | First 64 bytes are no file identity | valid | `fstat` `dev`/`ino`, `birthtimeMs` fallback, prefix only for in-place rewrites | Task 9 |
| C11 | Grouping ignores level and continuation lines; group members undefined | valid | hash over level + source + message + continuation lines; `members(pos)`; export writes all members | Tasks 2, 5, 10 |
| C12 | `latin1` is not Windows-1252; encoding not propagated | valid, and the earlier failure-mode table was wrong | O3 fallback dropped: UTF-8 with U+FFFD and a warning; boundary-safe sniff | Global Constraints, Tasks 2, 5 |
| C13 | "Finishes in 2 s" is not responsiveness | partly: a budget is cheap, a redesign is not needed yet | 200 ms event-loop budget measured; k-way merge instead of a comparator sort | Global Constraints, Tasks 3, 11 |
| C14 | Raw export has no byte contract | valid | original bytes plus `\n` per entry, no BOM, all group members | Tasks 4, 10 |
| C15 | "No unit test possible for the webview" is wrong | partly: true for rendering, not for the logic; multiple panels per document do not occur (`supportsMultipleEditorsPerDocument` off) | pure `media/logScroll.js` with `test/logScroll.test.ts` | Task 6 |
| C16 | `parseLine` mixes ignored and continuation; `Date.UTC` normalizes invalid dates | valid | `LineKind`; round-trip date validation | Task 1 |
| C17 | Live/Pause/Follow undefined; keybindings unverified | valid | Live (session) and Follow (webview) separated; manual keybinding checks incl. macOS | Tasks 7, 9 |
| C18 | Readiness claims too strong; PR CI has no Windows extension tests; worker not checked in the VSIX | valid (`ci.yml`: `extension` job on `ubuntu-26.04` only) | `extension-windows` CI job; `vsce ls` packaging check; claims below corrected | Tasks 2, 11 |

### Architecture

Two shapes. A (chosen): `LogSession` in the extension host owns store, order and view; only the text search runs in a Worker. B: the whole session in a Worker, the host only forwards webview messages. B isolates every regex (also user format regexes during the scan) but doubles the message protocol (webview to host to worker) and makes `rows` an extra hop. A hides the same policy behind the same `LogSession` surface and keeps tests in-process; B stays the fallback when Task 11 shows host stalls. Red flags checked: "two ways to do one task" (R5, fixed); "split ownership" of text flags between session and tail (P1, one owner: the session); no importable internals beyond the `core/` boundary rule.

```
 webview (logViewer.js)            extension host                                worker
 ----------------------            --------------                                ------
 scroll ── rows(rev,pos,id) ──────> LogSession.rows ── rev current? ─ copy EntryRefs ─ readPreviews (acquire LogFiles)
 filter ── filters ───────────────> setFilters ─┬─ text query changed: abort old search ──> terminate()
                                                 │                      searchText(copies) ──> seek + readLines + RegExp
                                                 │                      <── flags, bytesRead ─┘
                                                 └─ other filters: applyFilters on current flags
                                    commit: publish snapshot, revision++ ── state ──> redraw
 file change ── watcher/poll ─────> refresh (coalesced): identity ─┬─ changed: full reload, fileGeneration++
                                                                    └─ append: tail store aside ─ tail search ─ commit
```

### Code quality, tests, performance

Code quality findings: R2, R3, R5, R6, R7, R9 (above). Test gaps found: R1, the DST order test, the detection tests, the concurrency tests; all added to the tasks. Performance: P1; memory about 49 bytes per entry plus doubling headroom [estimated], checked in Task 11.

```
CODE PATHS                                         USER FLOWS
logformat  parseLine/detect/parseFilterTime        open *.log via Open With   [manual, Task 6]
  [★★★ planned] fields, boot, header, plain,       huge file scroll/resize    [manual, Task 6]
                 detection w/ continuation, O12     filter typing large file   [manual, Task 7 + perf]
logscan    readLines/scanFile/sniff                 keys F8/F2 no workbench    [manual, Task 7]
  [★★★ planned] LF/CRLF/no-NL/empty/BOM/UTF-16,     merge 3 files              [manual, Task 8]
                 chunk 4 bytes, abort, resume,      live append every 500 ms   [manual, Task 9]
                 no-NL 3 MB, boot-only file         rotation during live       [unit, Task 9]
logfilter  [★★★ planned] levels/time/source/        export errors only         [manual, Task 10]
                 hidden counts, DST file order      <img> entry renders text   [manual, Task 6]
logrows    [★★★ planned] read, search scope, abort, pathological regex
logsession [★★★ planned] load, deltas/gaps, filters, bookmarks, per-file formats,
                 non-blocking rows, utf16, refresh/rotation (Task 9)
logScroll.js [★★★ planned] scroll mapping, window clamp, stale replies (C15)
logsession exportTo [★★★ planned] input-path reject, abort cleanup, groups (C4)
logViewer.ts / logViewer.js  [GAP, manual only: rendering, workbench keys, watcher wiring]
COVERAGE: core and webview logic have planned tests; rendering and editor glue manual only;
          Windows coverage on PRs only once the extension-windows job exists (C18)
```

Test plan artifact: `~/.gstack/projects/JanJunklewitz-iecode/` (eng-review test plan of 2026-11-04).

### Failure modes

| Path | Realistic failure | Handling | Silent? |
|---|---|---|---|
| scan | 100 MB file on a slow network share | chunked, progress in status line, abortable on close | no |
| detect | unknown format | `plain` fallback, format name in the status line | no |
| search | pathological regex | Worker terminated on the next keystroke | no |
| live tail | file rotated | identity check, full reload | no |
| rows | file deleted while open | read error goes to `{type:'error'}` | no |
| encoding | non-UTF-8 bytes | shown as U+FFFD, warning in the status line (C12) | no |
| load | huge entry count (`plain`, short lines) | `LogLimitError` with "open as text" (C3) | no |
| export | destination is an input file, or cancel | rejected; temp file plus rename (C4) | no |
| scan | catastrophic user format regex | none: documented known limit (C5) | yes, VS Code hangs: accepted risk, not a planned gap |

Critical gaps: 0 planned. One accepted risk (C5) stays open on purpose. These are design-level claims; the acceptance gates are the tests in Tasks 1-11, the perf limits of Task 11 and the Windows run (C18).

### NOT in scope

- "Ask AI about this entry": waits for the AI interface decision (TODO item).
- Format editor UI: settings JSON is enough for the first formats.
- Viewer in Restricted Mode (O10): needs a workspace-trust change for the whole extension; TODO entry.
- Restoring the merged panel after a window reload: needs a `WebviewPanelSerializer`; TODO entry.
- Scan in a Worker: only if Task 11 shows host stalls.

### What already exists

- `views/plcArchiveEditor.ts`: CSP, nonce, `retainContextWhenHidden`, `vscode.openWith` "open as text": reused as the pattern.
- `core/lifecycleQueue.ts`: generation-counter pattern reused; the class itself is server-specific, not reused.
- `media/plcArchiveEditor.js`: renders with `textContent` already; same rule for the log webview.
- Test fixtures read from `test/fixtures` via `join(__dirname, '..', '..', 'test', 'fixtures', …)` (`test/core.test.ts:11`): same for `fixtures/logs`.

### Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Tasks 1-2 | core (format, scan) | - |
| Tasks 3-4 | core (filter, rows, worker) | 1-2 |
| Task 5 | core (session) | 3-4 |
| Tasks 6-7 | views, media, package.json | 5 |
| Tasks 8-10 | views, media, core session | 6-7 |
| Task 11 | tests, docs | 9 |

Tasks 3 and 4 can run in parallel worktrees (disjoint files, both only consume Tasks 1-2). Everything else is sequential, because the views and the session are shared modules.

### Implementation Tasks

_No new tasks: every accepted finding is folded into Tasks 1-11 above._

### Completion summary

- Step 0: Scope Challenge: scope accepted as-is
- Reality rows: 7/7 emitted, 1 unverified premise
- Architecture Review: 3 issues found (R4, R8, R12)
- Code Quality Review: 6 issues found (R2, R3, R5, R6, R7, R9)
- Test Review: diagram produced, 4 gaps identified (R1, DST test, detection tests, concurrency tests)
- Performance Review: 1 issue found (P1)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 2 items, folded into Task 11's TODO.md step (Restricted Mode, merged panel restore)
- Failure modes: 0 planned critical gaps; 1 accepted risk (C5, user format regex in the host)
- Unresolved decisions: 0
- Outside voice: native Claude subagent (Codex CLI not installed), completed with 20 findings: 18 accepted, 1 deferred, 1 rejected
- Copilot second opinion (gpt-6.1-sol): 18 findings: 14 accepted, 3 accepted in part (C5 as documented limit, C13, C15), 0 rejected; O3 replaced by C12
- Parallelization: 2 lanes for Tasks 3-4, everything else sequential
- Lake Score: N/A (decisions delegated, no completeness-scored questions asked)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | - | - |
| Outside Review | native Claude subagent (Codex not installed), default-on | Independent 2nd opinion | 1 | unavailable (outside provider), native completed | 20 findings: 18 accepted, 1 deferred, 1 rejected |
| Outside Review | GitHub Copilot CLI (gpt-6.1-sol), on request | Cross-model 2nd opinion | 1 | completed | 18 findings: 14 accepted, 3 in part, 0 rejected |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open (all mapped into tasks) | 14 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | - | - |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | - | - |

- **OUTSIDE COVERAGE:** codex: not installed; native fallback (Claude Plan subagent, in-host) completed with 20 findings. Copilot CLI (external, model gpt-6.1-sol) completed with 18 findings.
- **CROSS-MODEL:** overlap between Claude subagent and Copilot: regex isolation (O2/C5), rotation identity (O5/C10), line limits (O6/C7/C8), encoding (O3/C12), responsiveness (O1/C2/C13). Copilot alone found the buffer detachment (C1), the export-over-input risk (C4), the entry-count memory hole (C3) and the grouping/level issue (C11).
- **VERDICT:** Eng review done; all findings of both outside reviews resolved into the plan (State Model added). Status stays issues_open because findings existed. Ready to implement; acceptance gates are the task tests, the Task 11 perf limits and a Windows test run.

NO UNRESOLVED DECISIONS
