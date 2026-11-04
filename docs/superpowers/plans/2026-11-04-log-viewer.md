# Log File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only viewer for log files (first format: the TwinCAT logger text files, up to 100 MB each) with filters, colored severity, merged timelines and live tail, usable from the "Open With" menu and a command.

**Architecture:** A VS Code independent core in `extension/src/core/` scans a file once into columnar typed arrays (time, level, source id, byte offset, hash; no message strings), so 100 MB costs well under 200 MB of memory. Messages are re-read from disk for the visible rows only. Filters, grouping and gap detection run on the typed arrays in the extension host; a webview shows a virtual-scrolled table and asks the host for row windows. A log format is a data definition (regex with named groups, time format, level map), so new formats need no code.

**Tech Stack:** TypeScript (extension, `node --test`), plain JS/CSS webview in `extension/media/` (same pattern as `plcArchiveEditor`), no new dependencies.

**Spec:** No separate design document. The requirements are the "Log file viewer" item in [TODO.md](../../../TODO.md) plus the decisions in this plan (marked **Decision**), made after reading real logger files (not committed).

## Global Constraints

- The repository is public: never commit real log content, machine, project or variable names from real logs. All fixtures are synthetic and generic (`fbMain.fbPump.fbValve`).
- Everything in files is English (code, comments, UI strings, docs, commit messages incl. body). Every commit has a 1-3 sentence body on why. No `Co-Authored-By`. Author, committer and Signed-off-by use the GitHub noreply address.
- Cosmetic changes (whitespace, reordering) go in their own commit.
- No new runtime dependencies. Core files in `src/core/` must not import `vscode`.
- Files up to 100 MB must open without freezing the extension host: scan in chunks of at most 1 MB and yield to the event loop between chunks.
- Encoding: UTF-8 with optional BOM. UTF-16 files give a clear error message, not garbage.
- Times in logs have no time zone. **Decision:** keep them as wall-clock values stored with `Date.UTC(...)` and format them from UTC components, so DST never shifts or reorders them.

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
| `extension/src/core/logrows.ts` | Read entry text back from disk, text/regex search pass, raw export |
| `extension/src/core/logview.ts` | Filtered view: grouping of repeats, deltas, gaps, jump to next error |
| `extension/src/core/logsession.ts` | One viewer's state: files, format, store, filters, bookmarks, live tail |
| `extension/src/views/logViewer.ts` | Custom readonly editor, merged panel, message protocol, commands |
| `extension/media/logViewer.js`, `logViewer.css` | Webview: table, virtual scroll, filter bar, detail pane |
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
  export function parseLine(f: LogFormat, line: string): ParsedLine | undefined;   // undefined = continuation or ignored line
  export function parseTime(f: LogFormat, text: string): number;                   // NaN when it does not match
  export function detectFormat(lines: string[], formats: LogFormat[]): LogFormat;  // never throws; falls back to 'plain'
  ```

- [ ] **Step 1: Write the failing tests** in `logformat.test.ts`:
  - `twincat-logger` parses `0000000042 - 2026-10-19-00:00:21.669 - INFO - fbMain.fbPump.fbValve - Execute` to seq 42, source `fbMain.fbPump.fbValve`, message `Execute`, level `info`, time `Date.UTC(2026,9,19,0,0,21,669)`.
  - Empty source: `0000000001 - 2026-10-19-00:00:21.669 - WARNING -  - Fault active` gives source `''`, message `Fault active`.
  - Message with separators: `... - ERROR - fbMain - Start failed - retry - ()` gives message `Start failed - retry - ()`.
  - Boot line: `0000000003 - BOOT-------00:00:00.000 - DEBUG -  - Interlock active` gives `Number.isNaN(time)`, `timeText` `BOOT-------00:00:00.000`, level `debug`.
  - Header line `Sequence   - Timestamp - Category - Source - Message` returns `undefined` (via `ignore`), and so does a line `  at stack frame` (continuation).
  - `tab-separated` parses `03.04.2024 16:17:13\tInfo\tProgram needed 32 s` (time format `dd.MM.yyyy HH:mm:ss`, level `Info` mapped case-insensitively).
  - Unknown level text maps to `other`.
  - `compileFormat` throws `LogFormatError` for an invalid regex and for an `entry` without a `message` group.
  - `detectFormat` picks `twincat-logger` for 20 logger lines with a header, picks `tab-separated` for tab lines, and returns `plain` for `['\u0000\u0001garbage', 'x']`.
- [ ] **Step 2: Run** `cd extension && npm test` and confirm the new tests fail (module missing).
- [ ] **Step 3: Implement** `logformat.ts`. Entry regex for the logger: `^(?<seq>\d{10}) - (?<time>\S+) - (?<level>[A-Za-z]+) - (?<source>.*?) - (?<message>.*)$`, `ignore` = the header line. `timeFormat` tokens `yyyy MM dd HH mm ss SSS` compile to a regex plus an order list, other characters are literal; the logger format uses `yyyy-MM-dd-HH:mm:ss.SSS`. Named groups: `seq`, `time`, `level`, `source`, `message` (only `message` required). `plain`: every non-empty line is an entry, level found by a case-insensitive word match on error/warn/info/debug, else `other`. Detection: first 200 non-empty, non-ignored lines, a format wins with at least 70 % matches (highest ratio first, ties by list order), else `plain`.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log format definitions and line parsing`.

---

### Task 2: Entry store and file scan

**Files:**
- Create: `extension/src/core/logstore.ts`, `extension/src/core/logscan.ts`, `extension/test/logscan.test.ts`, `extension/test/fixtures/logs/` (small synthetic files: `logger-lf.log`, `logger-crlf.log`, `logger-nonewline.log`, `multiline.log`, `empty.log`, `utf16.log`)

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
    seq: Uint32Array;
    file: Uint16Array;       // index into the session's file list
    offset: Float64Array;    // byte offset of the entry's first line
    length: Uint32Array;     // byte length of the whole entry (all its lines, without the final line break)
    lines: Uint16Array;      // line count, capped at 65535
    hash: Uint32Array;       // FNV-1a of source + message of the first line
    sources: string[];       // interned source strings
    append(e: { ... }): number;           // returns the entry index
    truncate(count: number): void;
  }
  export interface ScanOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void; startOffset?: number }
  export interface ScanResult { size: number; lastEntryStart: number }   // lastEntryStart = offset of the final entry, for resuming
  export async function scanFile(path: string, fileId: number, format: LogFormat, store: EntryStore, o?: ScanOptions): Promise<ScanResult>;
  export async function sniff(path: string): Promise<{ lines: string[]; encoding: 'utf8' | 'utf16' }>;   // first 64 KB
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
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement.** `EntryStore` doubles its arrays when full. `scanFile` reads with `fs.createReadStream` (`highWaterMark = chunkSize`), splits on byte `0x0A` itself, keeps the incomplete tail line between chunks, decodes each complete line with `buf.toString('utf8', s, e)` (strip a trailing `\r` and a BOM at offset 0), calls `parseLine`, and awaits `setImmediate` after each chunk. Offsets are computed from bytes, never from string lengths. Filling `sortTime`: collect indices of NaN entries and patch them when the next dated entry arrives or at the end of the file.
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
  export function timelineOrder(store: EntryStore): Uint32Array;     // by sortTime, then file, then offset
  export function applyFilters(store: EntryStore, order: Uint32Array, f: Filters): FilterResult;
  ```
  `hiddenBy.x` = entries that pass every other filter but fail filter `x`, i.e. what switching `x` off would reveal.

- [ ] **Step 1: Write the failing tests** with a hand-built store of 8 entries (mixed levels, two sources, one boot entry with NaN time, two files):
  - `timelineOrder` interleaves two files by time and keeps equal times in file order, then offset.
  - Boot entry sorts in front of the first dated entry of its file.
  - `levels: ['error']` returns only errors; `hiddenBy.level` is the number of non-errors that pass the other filters.
  - Time range excludes dated entries outside it, keeps the boot entry.
  - `source: 'PUMP'` matches `fbMain.fbPump` case-insensitively.
  - An entry failing two filters counts in neither `hiddenBy` value; one failing only one counts in that one. The sum check: `indices.length + sum(single-fail counts) <= store.count`.
  - Empty `levels` returns no entries.
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement** with one pass over `order` computing a 4-bit fail mask per entry (level, time, source, text); precompute a `Uint8Array` per source id for the source test. Sort `timelineOrder` with a typed-array index sort (decorate with `sortTime`).
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log timeline order and filters with hidden counts`.

---

### Task 4: Row reading and text search

**Files:**
- Create: `extension/src/core/logrows.ts`, `extension/test/logrows.test.ts`

**Interfaces:**
- Consumes: `EntryStore`, `LogFormat`, `parseLine`.
- Produces:
  ```ts
  export interface EntryText { first: ParsedLine; text: string }          // text = all lines of the entry
  export interface TextQuery { query: string; regex: boolean; caseSensitive: boolean }
  export class LogFiles { constructor(paths: string[]); close(): Promise<void> }   // keeps file handles open
  export async function readEntries(files: LogFiles, store: EntryStore, format: LogFormat, indices: number[]): Promise<EntryText[]>;
  export async function searchText(files: LogFiles, store: EntryStore, format: LogFormat, q: TextQuery, signal?: AbortSignal): Promise<Uint8Array>;
  export function compileQuery(q: TextQuery): RegExp;                    // throws LogFormatError('Invalid regular expression: …')
  export async function exportRaw(files: LogFiles, store: EntryStore, indices: Uint32Array, out: (chunk: string) => Promise<void>): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests** against the fixtures of Task 2:
  - `readEntries` returns the parsed first line and, for a multi-line entry, the full text; indices from two files work.
  - `searchText` plain, case-insensitive: flags exactly the entries whose source or message contains the query; case-sensitive flag respected; regex mode matches `Start failed \(\)`.
  - Multi-line entries match on any of their lines.
  - `compileQuery({ query: '(', regex: true, ... })` throws `LogFormatError` with message starting `Invalid regular expression`.
  - An aborted signal rejects with `AbortError`; a second call after it still works.
  - `exportRaw` emits the raw lines of the given entries in the given order.
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement.** `readEntries` sorts the requested indices by `(file, offset)`, reads each slice with `FileHandle.read`, and returns results in the requested order. `searchText` re-streams every file in 1 MB chunks (sharing the line splitting of Task 2, extract it into a helper in `logscan.ts` if needed) and tests the decoded entry text; it yields between chunks and checks the signal. A plain query is escaped into a `RegExp`.
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
  export class LogView {                                   // pure: built from store + FilterResult
    constructor(store: EntryStore, indices: Uint32Array, o: ViewOptions);
    readonly rowCount: number;
    rowEntries(pos: number, count: number): { index: number; repeat: number }[];
    previousTime(pos: number): number | undefined;        // time of the row before, for deltas
    find(from: number, dir: 1 | -1, pred: (index: number) => boolean): number;   // row position or -1
  }
  export interface SessionState { files: string[]; format: string; total: number; matched: number; hiddenBy: FilterResult['hiddenBy'];
    levelCounts: Record<Level, number>; firstTimeMs?: number; lastTimeMs?: number; scanning: number /*0..1*/; live: boolean; error?: string }
  export class LogSession {
    static open(paths: string[], formats: LogFormatDef[], o: ViewOptions): LogSession;   // user formats are tried before built-ins
    load(onProgress?: (f: number) => void): Promise<void>;       // sniff, detect, scan, order; rejects with a clear message for UTF-16
    setFilters(f: { levels?: Level[]; from?: number; to?: number; source?: string; text?: TextQuery }): Promise<void>;   // aborts a running text search
    setOptions(o: Partial<ViewOptions>): void;
    rows(pos: number, count: number): Promise<LogRow[]>;
    detail(index: number): Promise<string>;                      // full text of one entry
    toggleBookmark(index: number): void;
    jump(from: number, dir: 1 | -1, what: 'error' | 'bookmark'): number;
    state(): SessionState;
    exportFiltered(out: (chunk: string) => Promise<void>): Promise<void>;
    dispose(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing tests.** `logview.test.ts` with a store of identical consecutive entries:
  - `groupRepeats: true` collapses consecutive entries with equal source and hash into one row with `repeat` equal to the run length; entries separated by another entry do not merge; `rowCount` shrinks accordingly.
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
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement.** The session owns one `LogFiles`, one `EntryStore`, the `timelineOrder`, the current `Filters`, a text-match cache keyed by the query, and builds a new `LogView` after every filter or option change. `rows` reads text with `readEntries` for the window only and shortens the message to its first line (`extraLines` = line count - 1).
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `Add log viewer session with grouping, gaps and navigation`.

---

### Task 6: Custom editor and virtual-scrolled table

**Files:**
- Create: `extension/src/views/logViewer.ts`, `extension/media/logViewer.js`, `extension/media/logViewer.css`
- Modify: `extension/package.json` (customEditors, commands, menus, configuration), `extension/src/extension.ts` (register next to `registerPlcArchiveEditor`)

**Interfaces:**
- Consumes: `LogSession`, `SessionState`, `LogRow` (Task 5).
- Produces: view type `iecode.logViewer` (`CustomReadonlyEditorProvider`, selector `*.log`, priority `option`, so the plain text editor stays the default). **Decision:** a readonly provider with our own document, not a text document, because VS Code does not hand 100 MB files to a text editor. Command `iecode.logViewer.open` (explorer and editor title context for `*.log`; opens the active file). Settings: `iecode.logViewer.formats` (array of format definitions as in Task 1), `iecode.logViewer.gapSeconds` (default `5`), `iecode.logViewer.groupRepeats` (default `false`).
  Webview protocol, webview to host: `{type:'ready'}`, `{type:'rows', pos, count, id}`, `{type:'filters', ...}`, `{type:'options', ...}`, `{type:'detail', index}`, `{type:'jump', from, dir, what}`, `{type:'bookmark', index}`, `{type:'export'}`, `{type:'openRaw'}`. Host to webview: `{type:'state', state}`, `{type:'rows', id, pos, rows}`, `{type:'detail', index, text}`, `{type:'jumped', pos}`, `{type:'error', message}`.

- [ ] **Step 1: Manual check list first** (no unit test possible for the webview, as for the other editors): write the list into the task's commit body and run it in step 4: open a small log, open a 100 MB generated file (Task 11 script), scroll with the thumb and the wheel, resize the window, switch theme.
- [ ] **Step 2: Implement `logViewer.ts`.** Content security policy as in `plcArchiveEditor.ts`. The provider creates a `LogSession` per document, sends `state` after `load` with progress while scanning, answers `rows` requests, and disposes the session with the document. A "Open as text" button sends `openRaw` (`vscode.openWith` default).
- [ ] **Step 3: Implement the webview.** Fixed row height of 20 px, columns: line marker (bookmark), time, level (colored by the theme's error/warning/info/debug colors), source, message. Virtual scroll renders only visible rows plus a margin and requests windows of about 200 rows; **when the total height would exceed 10 million px**, map `scrollTop` proportionally to the row position instead of using real height (1 M+ rows). Stale `rows` replies (older `id`) are dropped. Status line: `matched / total`, scan progress while scanning.
- [ ] **Step 4: Compile and run the checks.** `cd extension && npm test` (type check), then F5 in VS Code and go through the list.
- [ ] **Step 5: Commit** `Add log viewer editor with virtual-scrolled table`.

---

### Task 7: Filter bar, detail pane and navigation

**Files:**
- Modify: `extension/media/logViewer.js`, `extension/media/logViewer.css`, `extension/src/views/logViewer.ts`

**Interfaces:**
- Consumes: protocol of Task 6.
- Produces: UI only.

- [ ] **Step 1: Implement the filter bar.** One toggle per level showing its count; time range as two text inputs (`yyyy-MM-dd HH:mm:ss`, empty = open) with a preset "first / last N minutes"; source text input; text input with `.*` (regex) and `Aa` (case) toggles. Next to each filter the number from `hiddenBy` ("hidden: 1,203") shown only when above zero. Inputs debounce by 250 ms. `state.error` appears red under the text input.
- [ ] **Step 2: Implement the detail pane.** Clicking a row opens a bottom pane with all fields and the full multi-line text (request `detail`); rows with `extraLines` show `+N lines`.
- [ ] **Step 3: Implement navigation.** Buttons and keys: next / previous error (`F8` / `Shift+F8`), toggle bookmark (`Ctrl+F2` on the selected row), next / previous bookmark (`F2` / `Shift+F2`). `jump` scrolls the row to the middle of the view.
- [ ] **Step 4: Implement time display modes.** Toggle between absolute, relative to the first visible entry, and delta to the previous row (`deltaMs`, formatted `+30 ms`, `+2.4 s`, `+3 min`); gaps (`gap: true`) get a top border and the delta in the warning color. Option "group repeats" shows `×N` after the message.
- [ ] **Step 5: Run the manual checks** (small file: each filter alone and combined; hidden counts change as expected; keys work; gap marker appears; large file stays responsive while typing in the text filter). Commit `Add filters, detail pane and navigation to the log viewer`.

---

### Task 8: Merge several files on one timeline

**Files:**
- Modify: `extension/src/views/logViewer.ts`, `extension/package.json`

**Interfaces:**
- Consumes: `LogSession.open(paths, …)` already supports several files (Task 5).
- Produces: command `iecode.logViewer.openMerged`; the `file` column in the webview is shown only when `state.files.length > 1`.

- [ ] **Step 1: Implement the command** for the explorer (multi-select of `*.log` files; also a folder: all `*.log` files directly inside) and for the command palette (multi-select quick pick of `*.log` files from the workspace). It opens a `WebviewPanel` (a merged view has no single document), titled `Logs (N files)`, with the same webview and protocol.
- [ ] **Step 2: Add the file column** with a color stripe per file so interleaved sources are distinguishable, and a per-file toggle in the filter bar (hide a file; implemented by a source-style filter on the file index, extend `Filters` with `files?: number[]` and a test in `logfilter.test.ts` first).
- [ ] **Step 3: Verify manually** with three synthetic files whose times interleave; total entries equal the sum; order is by time. Commit `Merge several log files on one timeline`.

---

### Task 9: Live tail

**Files:**
- Modify: `extension/src/core/logsession.ts`, `extension/test/logsession.test.ts`, `extension/src/views/logViewer.ts`, `extension/media/logViewer.js`

**Interfaces:**
- Consumes: `ScanResult.lastEntryStart`, `EntryStore.truncate`, `ScanOptions.startOffset`.
- Produces: `LogSession.refresh(): Promise<boolean>` (true when entries were added or the file shrank). **Decision:** live tail only for single-file sessions; merged sessions stay static.

- [ ] **Step 1: Write the failing tests:** appending two entries to a fixture copy and calling `refresh()` adds exactly two entries and keeps earlier row positions; appending a continuation line to the last entry updates that entry's `lines` without a duplicate; a file that became shorter triggers a full reload; calling `refresh()` without changes returns `false`.
- [ ] **Step 2: Run** `npm test`, confirm failure.
- [ ] **Step 3: Implement `refresh`** by stat-ing the file, truncating the last entry, rescanning from its offset, then rebuilding order, filters and view. The text-match cache is discarded (a search is re-run).
- [ ] **Step 4: Wire the UI.** The editor watches the file (`vscode.workspace.createFileSystemWatcher` on its URI, plus a 2 s poll fallback while live is on), calls `refresh`, and sends a new `state`. Buttons: `Live` (on by default only when the file changed within the last minute) and `Pause` (new entries keep arriving, the view does not move); with Live on and the view at the bottom, it follows the end.
- [ ] **Step 5: Run** `npm test`, expect PASS; manual check with a script appending lines every 500 ms. Commit `Follow growing log files in the log viewer`.

---

### Task 10: Export of the filtered view

**Files:**
- Modify: `extension/src/views/logViewer.ts`, `extension/media/logViewer.js`

**Interfaces:**
- Consumes: `LogSession.exportFiltered` (Task 5).

- [ ] **Step 1: Add an Export button** that opens a save dialog (default name `<file>.filtered.log`) and streams the raw lines of all matching entries in view order through `exportFiltered`, with a progress notification and cancel.
- [ ] **Step 2: Verify manually:** exporting with only errors visible yields a file that opens in the viewer with the same row count as `matched`. Commit `Export the filtered log view`.

---

### Task 11: Performance check, documentation, TODO

**Files:**
- Create: `extension/test/logPerf.test.ts`
- Modify: `extension/CHANGELOG.md`, `extension/README.md` (if it lists features), `TODO.md`

- [ ] **Step 1: Write the perf test** (runs only when `IECODE_PERF=1`, so the default `npm test` stays fast): generate a 100 MB synthetic logger file in the OS temp folder (about one million lines, five levels, 2000 distinct sources, a few multi-line entries), then assert: `load` finishes within 30 s, `process.memoryUsage().heapUsed + arrayBuffers` grows by less than 300 MB, `setFilters({ levels: ['error'] })` finishes within 2 s, and a plain text search finishes within 15 s. Print the measured numbers.
- [ ] **Step 2: Run** `IECODE_PERF=1 npm test` (PowerShell: `$env:IECODE_PERF=1; npm test`) and record the numbers in the task's commit body. If a limit fails, fix the scan or filter code before continuing (typical causes: per-line string allocation, per-entry object creation).
- [ ] **Step 3: Document.** CHANGELOG entry (log viewer, formats setting, size limit tested, live tail, merge); README feature line; in `TODO.md` link this plan under the "Log file viewer" item, tick what is done and list what is left: "ask AI about this entry", source tree filter, custom-format editor UI, notes on formats other than the two built-ins.
- [ ] **Step 4: Commit** `Test log viewer on a 100 MB file and document it`.

---

## Self-Review

- **Coverage of the TODO item:** filters (severity, time range, text and regex, source, hidden counts) Tasks 3, 5, 7; presentation (columns, colors, collapsed multi-line, relative timestamps and gaps) Tasks 6, 7; live tail, error jump, bookmarks, merge, group repeats, export Tasks 7 to 10; format-agnostic definitions Task 1 (settings in Task 6); first format logger Task 1; large files Tasks 2, 4, 6, 11. Left out on purpose: "ask AI about this entry" (needs the AI interface decision), a UI to edit format definitions.
- **Types:** `LogRow`, `SessionState`, `Filters` (extended by `files` in Task 8, with its test), `ScanOptions.chunkSize` (introduced in Task 2's test hook) are named the same in every task.
- **Proportion:** each task names signatures, test cases and the spec values; algorithm bodies are left to the implementer except the scan and virtual-scroll constraints that decide behavior.
