# Plan A: Scope Output That Is Correct and Compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Sub-plan A of the [master plan](2026-11-09-ads-wishlist-master-plan.md).

**Goal:** `ads_scope` never hides a value change, says when it shows less than it has, shows text values, and offers a change-only view and an edge list. The tool takes `maxRows`, `decimals`, `changesOnly` and `edges`.

**Architecture:** All decisions live in the pure module `extension/src/core/adswatch.ts` (`ScopeBuffer` with a change log, `scopeText`, `edgesText`); `adsToolText.ts` only composes the result text, `toolInput.ts` validates the new inputs, `src/ads/adsTools.ts`, `src/ads/lmTools.ts` and `core/mcpTools.ts` pass them through, `package.json` declares them once for Copilot and MCP. No CLI change, no protocol bump. This is Phase 2 of the [roadmap](2026-11-06-ads-mcp-wishlist.md) (change log, `changesOnly`, D7, D24) plus the "Compact scope output" and "Edge" rows of the wishlist.

**Tech Stack:** TypeScript, `node --test` (`cd extension && npm test`, which runs `tsc -p .` first). No new dependencies.

**Spec:** [wishlist sections 1, 2 (edges), 3 (sample age)](../../ads-mcp-wishlist.md), roadmap "Phase 2: Scope with `changesOnly` and strings".

## Global Constraints

See the master plan. In addition:

- Public repository: generic example symbols only (`MAIN.nStep`, `GVL.bBusy`, `MAIN.sMsg`); no internal names. Commits: English subject plus a 1-3 sentence why-body, `git commit -s`, GitHub noreply author (never the company mail).
- New inputs are optional. `parseScopeInput` returns a field only when the caller sent it, so `parseScopeInput({ symbols: ['a'], seconds: 30 })` stays `{ ok: true, value: { symbols: ['a'], seconds: 30 } }`.
- The table format of `ads_scope` without options stays as it is. Intended output changes, all listed in the tasks: the thinning header (A1, done) and the change suffix of the summary line (A4). Existing tests are changed only where one of these appears.
- The numeric series for the plot (`views/adsScope.ts`) stays untouched; the change log is a second, separate store.
- `now` inside `scopeText` is the time of the newest sample (not the wall clock); every relative time (`t[s]`, `first at -9.4 s`) is relative to it.
- No value of a symbol with a null text (read error) is logged as a change (see Open decisions).
- Tests: `cd extension && npm test`. No `dotnet` work in this plan.

## Review Focus

1. A column that toggles once between two long constant runs: both transitions survive thinning. (A1, done)
2. Two symbols whose changes fall into the same row: the row stays, neither column loses its change. (A1 done; A5 for `changesOnly`)
3. More changes than `maxRows`: the table shows the newest rows and says how many earlier ones it left out; it never pretends to be complete. (A1 done; A5)
4. A STRING that changes while the numeric series has no point for it: appears in the summary and in `changesOnly`, not in the plot. (A3, A4, A5)
5. The watch stopped mid-window (host stop, download, error): the result starts with the last sample time and the host's last message instead of a table that ends silently. (A6)
6. The change-log cap removes the value in force at the window start: the cell says `unknown (history dropped)`, the header says `older changes dropped`. (A3, A5)
7. Two long texts that share their first 256 characters are two changes. (A3)

## File Structure

- `extension/src/core/adswatch.ts`: `ScopeOptions`, `formatNumber`, `formatValueText`, change log in `ScopeBuffer` (`changes`, `typeOf`, `isText`), `changeEntries`, `scopeText` options, `changesOnly` table, `hostNote`, `edgesText`.
- `extension/src/core/adsToolText.ts`: `scopeSummaryText` gets `options`, `edges`, `state`; head lines for the three modes.
- `extension/src/core/toolInput.ts`: `ScopeArgs`, `parseScopeInput` gains `maxRows`, `decimals`, `changesOnly`, `edges`.
- `extension/src/ads/adsTools.ts`, `extension/src/ads/lmTools.ts`, `extension/src/core/mcpTools.ts`, `extension/package.json`: pass the options through, describe them.
- Tests: `extension/test/adswatch.test.ts`, `adsToolText.test.ts`, `toolInput.test.ts`.

## Task overview

| Task | What | Status |
|---|---|---|
| A1 | Lossless thinning and an honest header | **Done** (commits 04a0232, 9c1c6fc) |
| A2 | `maxRows` and `decimals` | open |
| A3 | Change log in `ScopeBuffer` | open |
| A4 | Summary lines: change times, text symbols | open |
| A5 | `changesOnly` table and input | open |
| A6 | Stall reason from the host state | open |
| A7 | Edge list for BOOL symbols | open |
| A8 | Release: manifest text, CHANGELOG, wishlist, live check | open |

The rough plan had A3 (log, `changesOnly`, strings, summary) as one task and A4 for the sample age; they are split here (A3, A4, A5) and the old A4 shrank to A6 because `scopeSummaryText` already prints `No samples since <time>: ...` through `gapNote` (see A6). Master plan references to "A3" (Plan E5 depends on the change log) still point at the log task.

---

### Task A1: Lossless thinning and an honest header (DONE)

Implemented in commits `04a0232` ("Keep every value change when ads_scope thins a long window") and `9c1c6fc` ("Thin fast-changing scope columns evenly instead of cutting to the tail"). Nothing to build; later tasks rely on this code in `extension/src/core/adswatch.ts`:

- `thinKeepingChanges<T>(rows: T[], max: number, differs: (a: T, b: T) => boolean): { rows: T[]; changes: number; droppedChanges: number }`: returns all rows when `rows.length <= max`; otherwise keeps first row, last row and both rows around every transition; if those exceed `max`, the newest `max` rows and `droppedChanges` (transitions not shown).
- `fillEvenly<T>(all: T[], kept: T[], max: number): T[]`: tops `kept` up to `max` with evenly spaced rows of `all`, in the order of `all`.
- `scopeText(buf, symbols, seconds, now, maxRows = 200, maxColumns = MAX_SCOPE_COLUMNS)` (positional today; A2 turns the last two into an options object). A column that changes in more than `maxRows / 4` places is "fast-changing" and thinned evenly; only the other columns are held to the keep-every-change rule. When rows are left out it prints one header line before the `t[s]` row: `200 of 1990 samples shown, 14 value changes kept`; with dropped transitions `...; 40 earlier changes not shown, narrow seconds or symbols`; with fast columns `...; evenly thinned (fast-changing): MAIN.fTemp`; with only fast columns `200 of 10000 samples shown; evenly thinned (fast-changing): MAIN.fTemp`. No line when every row is shown.
- `downsample` stays for its other callers.
- Tests: `thinKeepingChanges keeps both sides of every transition`, `thinKeepingChanges shows the newest rows when changes exceed the limit`, `scopeText never drops a value change of a step counter and says it thinned`, `fillEvenly tops a kept set up to the limit with evenly spaced rows`, `scopeText thins a fast-changing column evenly and still keeps every step`, `scopeText with only fast-changing columns spans the whole window`, `scopeText has no thinning header when every row is shown` in `extension/test/adswatch.test.ts`.
- CHANGELOG line already written (`extension/CHANGELOG.md`, Unreleased, second bullet).

---

### Task A2: `maxRows` and `decimals`

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`scopeText` options object, `formatNumber`, `formatValueText`), `extension/src/core/adsToolText.ts` (`scopeSummaryText`), `extension/src/core/toolInput.ts` (`ScopeArgs`, `parseScopeInput`), `extension/src/core/mcpTools.ts` (`AdsToolFns.scope`), `extension/src/ads/adsTools.ts` (`ScopeInput`, `scopeSummary`, `scope`), `extension/src/ads/lmTools.ts` (scope tool validates its input like `ads_wait`), `extension/package.json` (schema of `iecode_ads_scope`)
- Test: `extension/test/adswatch.test.ts`, `extension/test/toolInput.test.ts`, `extension/test/adsToolText.test.ts`

**Interfaces:**
- Consumes: A1 (`scopeText`, `thinKeepingChanges`, `fillEvenly`).
- Produces:
  ```ts
  // adswatch.ts
  export interface ScopeOptions { maxRows?: number; maxColumns?: number; decimals?: number }   // A5 adds changesOnly
  export function scopeText(buf: ScopeBuffer, symbols: string[], seconds: number, now: number, opts?: ScopeOptions): string;
  /** Integers unchanged; other numbers rounded with toFixed(decimals); decimals undefined = String(n). */
  export function formatNumber(n: number, decimals?: number): string;
  /** A numeric text with a fraction or exponent is rounded to `decimals`; everything else (also null) is returned as is. */
  export function formatValueText(text: string | null, decimals?: number): string | null;
  // toolInput.ts
  export const SCOPE_MAX_ROWS = 200;
  export interface ScopeArgs { symbols: string[]; seconds?: number; maxRows?: number; decimals?: number }   // A5, A7 add fields
  export function parseScopeInput(raw: unknown): Parsed<ScopeArgs>;
  // adsToolText.ts
  scopeSummaryText(o: { buffer: ScopeBuffer; symbols: string[]; seconds: number; target: string; intervalMs: number; now: number; clock: (ms: number) => string; options?: ScopeOptions }): string
  // adsTools.ts
  export type ScopeInput = Partial<ScopeArgs>;
  export function scopeSummary(host: AdsHost, symbols: string[], seconds: number, options?: ScopeOptions): string;
  ```
  The old positional `maxRows` / `maxColumns` of `scopeText` have no caller outside `adswatch.ts` tests (which pass four arguments), so the signature change breaks nothing.

Rules: `maxRows` is clamped to 1-200 (rounded), `decimals` to 0-9 (rounded); a non-number or non-finite value is an error (`maxRows must be a finite number`, `decimals must be a finite number`), an out-of-range number never throws. `decimals` rounds the numbers of the table cells, `min`, `max` and the `last` text of the summary; integers are never padded.

- [ ] **Step 1: Write the failing tests**

`extension/test/toolInput.test.ts`:

```ts
test('toolInput scope maxRows and decimals are clamped, never thrown', () => {
  const v = (o: unknown) => { const p = parseScopeInput(o); return p.ok ? p.value : p.error; };
  assert.deepEqual(v({ maxRows: 20.6, decimals: 2 }), { symbols: [], maxRows: 21, decimals: 2 });
  assert.equal((v({ maxRows: 0 }) as { maxRows: number }).maxRows, 1);
  assert.equal((v({ maxRows: 5000 }) as { maxRows: number }).maxRows, 200);
  assert.equal((v({ decimals: -3 }) as { decimals: number }).decimals, 0);
  assert.equal((v({ decimals: 12 }) as { decimals: number }).decimals, 9);
  assert.equal(v({ maxRows: 'x' }), 'maxRows must be a finite number');
  assert.equal(v({ decimals: NaN }), 'decimals must be a finite number');
  assert.deepEqual(v({ symbols: ['a'], seconds: 30 }), { symbols: ['a'], seconds: 30 });   // unchanged: absent fields stay absent
});
```

`extension/test/adswatch.test.ts` (add `formatNumber`, `formatValueText` to the import):

```ts
const real = (symbol: string): WatchItem => ({ symbol, type: 'REAL', numeric: true, error: null });

test('scopeText honours maxRows and says it thinned', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.fTemp')]);
  b.push(1, Array.from({ length: 1000 }, (_, i) => ({ t: i * 10, v: [String(i)] })));
  const text = scopeText(b, ['MAIN.fTemp'], 100000, 9990, { maxRows: 20 });
  const data = text.split('\n').filter(l => /^-?\d+(\.\d+)?\t/.test(l));
  assert.equal(data.length, 20);
  assert.match(text, /20 of 1000 samples shown; evenly thinned \(fast-changing\): MAIN\.fTemp/);
});

test('scopeText rounds numbers to decimals but never pads integers', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [real('MAIN.f')]);
  b.push(1, [{ t: 0, v: ['1.23456'] }, { t: 1000, v: ['2.5'] }, { t: 2000, v: ['3'] }]);
  const text = scopeText(b, ['MAIN.f'], 100000, 2000, { decimals: 2 });
  assert.match(text, /^MAIN\.f: min=1\.23 max=3 last=3 count=3$/m);
  assert.deepEqual(text.split('\n').filter(l => /^-?\d/.test(l)), ['-2.000\t1.23', '-1.000\t2.50', '0.000\t3']);
  assert.equal(formatValueText('2.56789', 1), '2.6');
  assert.equal(formatValueText('Running', 1), 'Running');
  assert.equal(formatValueText(null, 1), null);
  assert.equal(formatNumber(2.5), '2.5');
});
```

`extension/test/adsToolText.test.ts`:

```ts
test('scope summary passes maxRows to the table', () => {
  assert.equal(scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, options: { maxRows: 2 } }),
    'ADS values of the last 60 s up to the newest sample (target local):\na: min=0 max=2 last=2 count=3\n\n2 of 3 samples shown; evenly thinned (fast-changing): a\nt[s]\ta\n-2.000\t0\n0.000\t2');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (`scopeText` takes no options object, `formatValueText` and `options` unknown); after the signature compiles, the assertions fail.

- [ ] **Step 3: Implement**

`adswatch.ts`: replace the `maxRows`/`maxColumns` parameters of `scopeText` by `opts: ScopeOptions = {}` (`const maxRows = opts.maxRows ?? 200`, `maxColumns = opts.maxColumns ?? MAX_SCOPE_COLUMNS`); apply `formatNumber(sum.min, d)`, `formatNumber(sum.max, d)`, `formatValueText(sum.last, d)` in the summary line and `formatNumber(y, d)` for table cells (the maps hold the numbers). `formatValueText` rounds only when the text matches the existing `NUMBER` regex and `decimals !== undefined` and the number is not an integer text. `adsToolText.ts`: pass `o.options` to `scopeText`. `toolInput.ts`: add `ScopeArgs`, `SCOPE_MAX_ROWS`, parse the two fields with a shared `clampedNumber(o, field, min, max)` helper (finite check, `Math.round`, clamp). `adsTools.ts`: `ScopeInput = Partial<ScopeArgs>`, `scopeSummary(host, symbols, seconds, options = {})`, `scope` passes `{ maxRows: input.maxRows, decimals: input.decimals }`. `mcpTools.ts`: `AdsToolFns.scope(input: ScopeArgs)`. `lmTools.ts`: the scope tool parses its input first (today it passes the raw input on, so a model could send `maxRows: "x"`):

```ts
invoke(opts) {
  const p = parseScopeInput(opts.input);
  return text(p.ok ? tools.scope(p.value).text : `Invalid arguments: ${p.error}`);
},
```

`package.json`, `iecode_ads_scope.inputSchema.properties`: add
`"maxRows": { "type": "number", "description": "Most table rows, 1-200, default 200." }` and `"decimals": { "type": "number", "description": "Round fractional numbers to this many decimals, 0-9 (integers stay as they are)." }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass (the existing `scopeText` and `scope summary` tests are unchanged and green).

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/package.json
git commit -s -m "Add maxRows and decimals to ads_scope" -m "An agent that wants a quick look asked for 200 rows and 8-digit floats; two optional inputs let it ask for 20 rows and rounded numbers. The Copilot scope tool now validates its input like ads_wait instead of passing raw values on."
```

---

### Task A3: Change log in `ScopeBuffer`

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`ScopeBuffer`)
- Test: `extension/test/adswatch.test.ts`

**Interfaces:**
- Consumes: existing `ScopeBuffer.push`, `trim`, `setItems`, `clear`, `latest`.
- Produces:
  ```ts
  export const MAX_CHANGE_ENTRIES = 100_000;   // roadmap D7: total, split per item like trim() does
  export const MAX_CHANGE_TEXT = 256;
  export const CUT_MARK = '…[cut]';
  export interface ChangeEntry { t: number; text: string }            // text cut to MAX_CHANGE_TEXT + CUT_MARK
  export interface ChangeLog {
    /** The value in force at the window start: the last entry before it. Undefined: none known, see startUnknown. */
    start?: ChangeEntry;
    /** Entries with t >= window start, oldest first. The first entry ever seen of a symbol is its first sample, not a change. */
    entries: ChangeEntry[];
    /** True when the entry cap removed entries that lay inside the window. */
    olderDropped: boolean;
    /** True when `start` is undefined because the cap removed it (not because the symbol had no sample yet). */
    startUnknown: boolean;
  }
  // ScopeBuffer
  constructor(seconds: number, maxValues?: number, maxChanges?: number);   // maxChanges default MAX_CHANGE_ENTRIES
  changes(symbol: string, fromMs: number): ChangeLog;
  typeOf(symbol: string): string | undefined;      // type of the current item
  isText(symbol: string): boolean;                  // type STRING(n) or WSTRING(n), case-insensitive
  /** The entries that are real changes: all but the first-ever entry, which is just the first sample. */
  export function changeEntries(log: ChangeLog): ChangeEntry[];
  ```
  Semantics:
  - Every row of the current `gen` appends `{ t, text }` per item when the full text differs from the previous *non-null* text of that item. A null text is skipped (the previous text stays the comparison base). The stored text is cut at 256 characters and gets `…[cut]`; the comparison uses the full text, so two long texts with the same start are two entries.
  - `trim()` keeps one predecessor (the last entry older than the cutoff `newest - ms`) per item and removes older entries; then it enforces the cap `max(2, floor(maxChanges / max(1, items.length)))` per item by removing the oldest entries and remembering the time of the newest removed one.
  - `changes(symbol, fromMs)` uses `max(fromMs, newest - ms)` as window start. `olderDropped` is true when the newest removed time is `>=` the window start; `startUnknown` when `start` is undefined and the cap ever removed an entry of the symbol.
  - `setItems` drops the logs of symbols no longer watched; `clear()` drops all logs and their comparison state.
  - `changeEntries(log)`: `log.entries` without its first element when `log.start === undefined && !log.startUnknown`, else `log.entries`.

- [ ] **Step 1: Write the failing tests** (`extension/test/adswatch.test.ts`; add `changeEntries`, `MAX_CHANGE_ENTRIES`, `CUT_MARK` to the import)

```ts
const text = (symbol: string): WatchItem => ({ symbol, type: 'STRING(80)', numeric: false, error: null });
const at = (values: (string | null)[], step = 1000) => values.map((v, i) => ({ t: i * step, v: [v] }));

test('change log keeps the first sample and every change, nothing else', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(['0', '0', '1', '1', '2']));
  const log = b.changes('S', 0);
  assert.deepEqual(log.entries, [{ t: 0, text: '0' }, { t: 2000, text: '1' }, { t: 4000, text: '2' }]);
  assert.equal(log.start, undefined);
  assert.equal(log.startUnknown, false);
  assert.equal(log.olderDropped, false);
  assert.equal(changeEntries(log).length, 2);
});

test('a null sample is no change and does not reset the comparison', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(['1', null, '1', '2']));
  assert.deepEqual(b.changes('S', 0).entries, [{ t: 0, text: '1' }, { t: 3000, text: '2' }]);
});

test('the log keeps one predecessor so the window start value is known', () => {
  const b = new ScopeBuffer(10);                    // 10 s window
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => (i < 5 ? '0' : i < 25 ? '7' : '1'))));   // t 0..30000, changes at 5000 and 25000
  const log = b.changes('S', 20000);
  assert.deepEqual(log.start, { t: 5000, text: '7' });
  assert.deepEqual(log.entries, [{ t: 25000, text: '1' }]);
  assert.equal(log.startUnknown, false);
});

test('the entry cap drops the oldest entries and says so', () => {
  const b = new ScopeBuffer(1000, 2_000_000, 10);   // at most 10 entries for the one item
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 50 }, (_, i) => String(i))));
  const log = b.changes('S', 0);
  assert.equal(log.entries.length, 10);
  assert.equal(log.entries.at(-1)!.text, '49');
  assert.equal(log.olderDropped, true);
  assert.equal(log.startUnknown, true);
  assert.equal(MAX_CHANGE_ENTRIES, 100_000);
});

test('long texts are stored cut but compared in full', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [text('S')]);
  const a = 'x'.repeat(256);
  b.push(1, at([a + 'a', a + 'b', 'short']));
  const e = b.changes('S', 0).entries;
  assert.equal(e.length, 3);
  assert.equal(e[0].text, a + CUT_MARK);
  assert.equal(e[1].text, a + CUT_MARK);
  assert.equal(e[2].text, 'short');
});

test('setItems drops the log of a removed symbol and clear drops all logs', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('A'), item('B')]);
  b.push(1, [{ t: 0, v: ['1', '2'] }, { t: 1000, v: ['3', '4'] }]);
  b.setItems(2, [item('A')]);
  assert.equal(b.changes('B', 0).entries.length, 0);
  assert.equal(b.changes('A', 0).entries.length, 2);
  b.clear();
  assert.equal(b.changes('A', 0).entries.length, 0);
  b.push(2, [{ t: 5000, v: ['3'] }]);              // same text as before the clear: logged again
  assert.deepEqual(b.changes('A', 0).entries, [{ t: 5000, text: '3' }]);
});

test('isText and typeOf follow the item type', () => {
  const b = new ScopeBuffer(100);
  b.setItems(1, [text('S'), item('N'), { symbol: 'W', type: 'WSTRING(40)', numeric: false, error: null }]);
  assert.equal(b.isText('S'), true);
  assert.equal(b.isText('W'), true);
  assert.equal(b.isText('N'), false);
  assert.equal(b.typeOf('N'), 'INT');
  assert.equal(b.typeOf('nope'), undefined);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (`changes`, `changeEntries`, constructor arity, `isText` unknown).

- [ ] **Step 3: Implement**

Add the private stores `changes_: Map<string, ChangeEntry[]>`, `lastText_: Map<string, string>` (full text of the last non-null sample), `droppedT_: Map<string, number>` (time of the newest entry the cap removed). In `push`, inside the per-item loop, after `latest_.set`: `if (text !== null) this.log(it.symbol, r.t, text)`. `symbol` keys are the item spellings of the current gen (as for `series_`). Extend `trim()` (called by `push`, `setSeconds`, `setItems`) with the predecessor and cap rules above; `clear()` and `setItems` clean the three maps. `typeOf` reads `this.items`; `isText` tests `/^W?STRING\b/i` on it. `changes()` returns a fresh `ChangeLog` (copies of the arrays are not needed; callers do not mutate). A comment at `changes()` states that a window longer than the buffer is clamped to the buffer, like the numeric series.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass; the 7 new tests included; existing `ScopeBuffer` tests unchanged (the log is additive).

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/adswatch.ts extension/test/adswatch.test.ts
git commit -s -m "Keep a change log per watched symbol in the scope buffer" -m "The numeric series cannot hold text and says nothing about when a value changed; a separate log with its own entry cap (100 000, split per symbol) and one predecessor entry per symbol gives the scope strings, change times and a known start value without growing the plot data."
```

---

### Task A4: Summary lines: change times and text symbols

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`scopeText` summary lines)
- Test: `extension/test/adswatch.test.ts`, `extension/test/adsToolText.test.ts`

**Interfaces:**
- Consumes: A3 (`ScopeBuffer.changes`, `changeEntries`, `isText`), A2 (`formatValueText`, `ScopeOptions`).
- Produces (all internal to `adswatch.ts`; the observable result is the summary line):
  ```ts
  /** "-9.4" (one decimal, never "-0.0"); seconds relative to `now`. */
  function relSeconds(t: number, now: number): string;
  /** One-line text for a summary or table cell: \r \n \t escaped, cut at 80 characters with "…"; quoted when `quote`. */
  function shownText(text: string, quote: boolean): string;
  ```
  Summary line formats (exact):
  - numeric, K changes in the window, K >= 1: `MAIN.nStep: min=0 max=6 last=6 count=11 changes=2 (first at -7.0 s, last at -1.0 s)`; constant (K = 0): the line stays `MAIN.nStep: min=5 max=5 last=5 count=11` (no suffix, byte-identical to today).
  - symbol without numeric series but with a log: text symbol `MAIN.sMsg: changes=2 last="Error 5" (first at -2.0 s, last at 0.0 s)`; K = 0 gives `MAIN.sMsg: changes=0 last="Run"`; a non-STRING non-numeric symbol shows `last=<text>` unquoted.
  - no series and no log: today's `S: no numeric samples in the last N s, last=...` unchanged.
  `first` / `last` are the times of the first and last real change (`changeEntries`) relative to `now`; `last` of the text is the newest log entry, shown with `shownText`.

- [ ] **Step 1: Write the failing tests**

`extension/test/adswatch.test.ts`:

```ts
test('scopeText summary names the number of changes and when they happened', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.nStep'), item('GVL.nConst')]);
  b.push(1, Array.from({ length: 11 }, (_, i) => ({ t: i * 1000, v: [i < 3 ? '0' : i < 9 ? '5' : '6', '5'] })));
  const text = scopeText(b, ['MAIN.nStep', 'GVL.nConst'], 100000, 10000);
  assert.match(text, /^MAIN\.nStep: min=0 max=6 last=6 count=11 changes=2 \(first at -7\.0 s, last at -1\.0 s\)$/m);
  assert.match(text, /^GVL\.nConst: min=5 max=5 last=5 count=11$/m);
});

test('scopeText summarises a STRING symbol by its changes', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [text('MAIN.sMsg')]);
  b.push(1, at(['', 'Run', 'Run', 'Error 5']));
  assert.match(scopeText(b, ['MAIN.sMsg'], 100000, 3000), /^MAIN\.sMsg: changes=2 last="Error 5" \(first at -2\.0 s, last at 0\.0 s\)$/m);
  const quiet = new ScopeBuffer(100000);
  quiet.setItems(1, [text('MAIN.sMsg')]);
  quiet.push(1, at(['Run', 'Run']));
  assert.match(scopeText(quiet, ['MAIN.sMsg'], 100000, 1000), /^MAIN\.sMsg: changes=0 last="Run"$/m);
});

test('scopeText cuts and escapes a long or multi-line text in the summary', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [text('MAIN.sMsg')]);
  b.push(1, at(['a\nb\tc', 'y'.repeat(100)]));
  const lines = scopeText(b, ['MAIN.sMsg'], 100000, 1000).split('\n');
  assert.equal(lines[0], `MAIN.sMsg: changes=1 last="${'y'.repeat(80)}…" (first at 0.0 s, last at 0.0 s)`);
  assert.equal(shownText('a\nb\tc', true), '"a\\nb\\tc"');   // export shownText for this check
});
```

`shownText` is exported for the test (`export function shownText`).

`extension/test/adsToolText.test.ts`: change the expected summary line of `scope summary of fresh samples has no gap note` to `a: min=0 max=2 last=2 count=3 changes=2 (first at -1.0 s, last at 0.0 s)` and the same line in `scope summary passes maxRows to the table` (A2). The `scope uses the gap note` and `scope table keeps 20 symbols` tests stay as they are.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL (suffix and text summary missing; `shownText` not exported).

- [ ] **Step 3: Implement**

In the summary loop of `scopeText`: read `const log = buf.changes(s, now - seconds * 1000); const ch = changeEntries(log)`. Numeric branch appends `ch.length > 0 ? ` changes=${ch.length} (first at ${relSeconds(ch[0].t, now)} s, last at ${relSeconds(ch.at(-1)!.t, now)} s)` : ''`. Else-branch: if `log.entries.length > 0 || log.start` use the text format with the newest of `log.entries`/`log.start` as `last`; otherwise the old no-numeric-samples text. `relSeconds` returns `'0.0'` when the rounded value is zero. `shownText` escapes with `oneLine` plus `\t` -> `\\t`, cuts to 80 characters with `…`, wraps in quotes when `quote`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/adswatch.ts extension/test/adswatch.test.ts extension/test/adsToolText.test.ts
git commit -s -m "Show change counts and change times in the scope summary" -m "A step counter or a message text has no useful min and max; how often and when it changed lets the agent read durations without the table. This changes the summary line of a symbol that changed; constant symbols print as before."
```

---

### Task A5: `changesOnly` table and input

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`ScopeOptions.changesOnly`, `scopeText` branch, `changesRows`), `extension/src/core/adsToolText.ts` (head line), `extension/src/core/toolInput.ts`, `extension/src/ads/adsTools.ts`, `extension/package.json`
- Test: `extension/test/adswatch.test.ts`, `extension/test/adsToolText.test.ts`, `extension/test/toolInput.test.ts`

**Interfaces:**
- Consumes: A2 (`ScopeOptions`, `formatValueText`), A3 (`ChangeLog`), A4 (`shownText`, `relSeconds`).
- Produces:
  ```ts
  export interface ScopeOptions { maxRows?: number; maxColumns?: number; decimals?: number; changesOnly?: boolean }
  export const UNKNOWN_START = 'unknown (history dropped)';
  // ScopeArgs (toolInput.ts) gains: changesOnly?: boolean
  ```
  Output of `scopeText(..., { changesOnly: true })`: the summary lines of A4, a blank line, then
  1. when any shown symbol has `olderDropped`: `older changes dropped: A, B` (names of those symbols);
  2. when rows are left out: `N earlier rows not shown, narrow seconds or symbols`;
  3. the header `t[s]` + one column per shown symbol (the first 20, as in the numeric table; the existing `(table columns: first 20 of N symbols; ...)` line follows);
  4. a start row at the window start time (`(from - now) / 1000` with three decimals) when at least one shown symbol has a `start` entry or `startUnknown`: the cell is the start text, `unknown (history dropped)` for `startUnknown`, empty otherwise; omitted when rows were left out;
  5. one row per time at which at least one shown symbol has an entry in the window (the first sample of a symbol counts as a row), unchanged cells empty, newest `maxRows` rows (default 200). Cells: `shownText(text, buf.isText(symbol))` for text symbols, else `formatValueText(text, decimals)`.
  Never thinned: no `samples shown` header. The head line of the tool result in this mode is `ADS value changes of the last 60 s up to the newest sample (target local):`.

  Wording note: the roadmap says `N earlier changes not shown`; a hidden row can also be a first sample, so the text says `rows`.

- [ ] **Step 1: Write the failing tests**

`extension/test/toolInput.test.ts`:

```ts
test('toolInput scope changesOnly', () => {
  assert.deepEqual(parseScopeInput({ changesOnly: true }), { ok: true, value: { symbols: [], changesOnly: true } });
  assert.deepEqual(parseScopeInput({ changesOnly: false }), { ok: true, value: { symbols: [], changesOnly: false } });
  assert.deepEqual(parseScopeInput({ changesOnly: 'yes' }), { ok: false, error: 'changesOnly must be true or false' });
});
```

`extension/test/adswatch.test.ts`:

```ts
const tableOf = (text: string) => text.slice(text.indexOf('t[s]'));

test('changesOnly lists one row per change time with empty cells for unchanged symbols', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('A'), { symbol: 'B', type: 'BOOL', numeric: true, error: null }]);
  const a = ['0', '0', '1', '1', '1', '2'], bb = ['FALSE', 'FALSE', 'FALSE', 'TRUE', 'TRUE', 'TRUE'];
  b.push(1, a.map((v, i) => ({ t: i * 1000, v: [v, bb[i]] })));
  const text = scopeText(b, ['A', 'B'], 100000, 5000, { changesOnly: true });
  assert.equal(tableOf(text), ['t[s]\tA\tB', '-5.000\t0\tFALSE', '-3.000\t1\t', '-2.000\t\tTRUE', '0.000\t2\t'].join('\n'));
  assert.doesNotMatch(text, /samples shown/);
});

test('changesOnly shows the value at the window start and quotes text', () => {
  const b = new ScopeBuffer(10);
  b.setItems(1, [text('S')]);
  b.push(1, at(Array.from({ length: 31 }, (_, i) => (i < 25 ? 'idle' : 'Error 5'))));
  const out = scopeText(b, ['S'], 10, 30000, { changesOnly: true });
  assert.equal(tableOf(out), ['t[s]\tS', '-10.000\t"idle"', '-5.000\t"Error 5"'].join('\n'));
  assert.match(out, /^S: changes=1 last="Error 5" \(first at -5\.0 s, last at -5\.0 s\)$/m);
});

test('changesOnly marks a start value the entry cap removed', () => {
  const b = new ScopeBuffer(1000, 2_000_000, 2);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 10 }, (_, i) => String(i))));
  const out = scopeText(b, ['S'], 100, 9000, { changesOnly: true });
  assert.match(out, /^older changes dropped: S$/m);
  assert.equal(tableOf(out), ['t[s]\tS', '-100.000\tunknown (history dropped)', '-1.000\t8', '0.000\t9'].join('\n'));
});

test('changesOnly shows the newest rows and says how many it left out', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('S')]);
  b.push(1, at(Array.from({ length: 300 }, (_, i) => String(i)), 10));
  const out = scopeText(b, ['S'], 100000, 2990, { changesOnly: true });
  const data = out.split('\n').filter(l => /^-?\d+\.\d+\t/.test(l));
  assert.equal(data.length, 200);
  assert.equal(data.at(-1), '0.000\t299');
  assert.match(out, /^100 earlier rows not shown, narrow seconds or symbols$/m);
  assert.match(scopeText(b, ['S'], 100000, 2990, { changesOnly: true, maxRows: 20 }), /^280 earlier rows not shown/m);
});

test('changesOnly keeps every change of a long window without a thinning header', () => {
  const steps = Array.from({ length: 15 }, (_, i) => i * 7);
  const b = new ScopeBuffer(100000);
  b.setItems(1, [item('MAIN.nStep')]);
  b.push(1, Array.from({ length: 1990 }, (_, i) => ({ t: i * 10, v: [String(steps[Math.min(14, Math.floor(i / 130))])] })));
  const out = scopeText(b, ['MAIN.nStep'], 100000, 19890, { changesOnly: true });
  const data = out.split('\n').filter(l => /^-?\d+\.\d+\t/.test(l)).map(l => l.split('\t')[1]);
  assert.deepEqual(data, steps.map(String));
  assert.doesNotMatch(out, /samples shown/);
});

test('changesOnly rounds numeric cells to decimals', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [real('MAIN.f')]);
  b.push(1, [{ t: 0, v: ['1.23456'] }, { t: 1000, v: ['2'] }]);
  assert.equal(tableOf(scopeText(b, ['MAIN.f'], 100000, 1000, { changesOnly: true, decimals: 2 })), ['t[s]\tMAIN.f', '-1.000\t1.23', '0.000\t2'].join('\n'));
});
```

`extension/test/adsToolText.test.ts`:

```ts
test('scope summary in changesOnly mode names the view in its head line', () => {
  const text = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, options: { changesOnly: true } });
  assert.ok(text.startsWith('ADS value changes of the last 60 s up to the newest sample (target local):\n'), text);
  assert.ok(text.endsWith('t[s]\ta\n-2.000\t0\n-1.000\t1\n0.000\t2'), text);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL (`changesOnly` is ignored, the numeric table is printed; the parser rejects nothing).

- [ ] **Step 3: Implement**

`scopeText`: after the summary lines, `if (opts.changesOnly) { lines.push('', ...changesRows(buf, shown, seconds, now, opts)); if (symbols.length > shown.length) lines.push(<the existing columns note>); return lines.join('\n'); }`. `changesRows` collects `buf.changes(s, from)` per shown symbol, builds `Map<number, string>` per symbol from `log.entries`, sorts the union of times, cuts to the newest `maxRows` and builds the lines described above. `scopeSummaryText`: head `value changes` when `o.options?.changesOnly`. `parseScopeInput`: `changesOnly` must be `boolean`, else `changesOnly must be true or false`; null counts as missing. `adsTools.scope`: pass `changesOnly: input.changesOnly` in `options`. `package.json`: add `"changesOnly": { "type": "boolean", "description": "One row per value change instead of one per sample; also lists STRING values. Never thinned." }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/package.json
git commit -s -m "Add changesOnly to ads_scope, also for STRING values" -m "A step counter, an enum or a text changes a few times in a window of thousands of samples; one row per change with the start value shows all of them in few lines. Rejected: reusing the thinned table, which drops short changes by design."
```

---

### Task A6: Stall reason from the host state

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`gapNote`, `hostNote`), `extension/src/core/adsToolText.ts` (`scopeSummaryText`), `extension/src/ads/adsTools.ts` (`scopeSummary`)
- Test: `extension/test/adswatch.test.ts`, `extension/test/adsToolText.test.ts`

**Current state:** `scopeSummaryText` already starts with `No samples since <time>: sampling only runs while the ADS Watch view or the ADS Scope is open.` when the newest sample is older than 2 s (`gapNote`, tested by `scope uses the gap note`), and `No samples yet for ...` without samples. Per-symbol sample ages carry no extra information, because every row stamps all symbols (`latest` is the time of the newest row for each symbol). What is missing: after a host error, restart or download the cause is not named, although `host.state()` has it.

**Interfaces:**
- Consumes: `AdsHost.state(): AdsState` (`{ connected: boolean; error?: string }`, `host.ts:137`).
- Produces:
  ```ts
  export function gapNote(newestMs: number | undefined, nowMs: number, clock: (ms: number) => string, extra?: string): string | undefined;
  /** "Last host message: <error>" with an error, "The ADS host is not connected." when disconnected without one, else undefined. */
  export function hostNote(state: { connected: boolean; error?: string } | undefined): string | undefined;
  // scopeSummaryText gains: state?: { connected: boolean; error?: string }
  // adsTools.ts: scopeSummary passes state: host.state()
  ```
  `gapNote` returns `No samples since 10:00:00: sampling only runs while the ADS Watch view or the ADS Scope is open. Last host message: Port 851 not found.` when `extra` is given and the gap exists; the `extra` is not added to `No samples yet`.

- [ ] **Step 1: Write the failing tests**

`extension/test/adswatch.test.ts`:

```ts
test('gap note adds the host message when sampling is stale', () => {
  const tail = 'sampling only runs while the ADS Watch view or the ADS Scope is open.';
  assert.equal(gapNote(0, 61_000, () => '10:00:00', 'Last host message: x.'), `No samples since 10:00:00: ${tail} Last host message: x.`);
  assert.equal(gapNote(60_000, 61_000, () => '10:00:00', 'Last host message: x.'), undefined);
  assert.equal(hostNote({ connected: false, error: 'Port 851 not found.' }), 'Last host message: Port 851 not found.');
  assert.equal(hostNote({ connected: false }), 'The ADS host is not connected.');
  assert.equal(hostNote({ connected: true }), undefined);
  assert.equal(hostNote(undefined), undefined);
  assert.equal(hostNote({ connected: false, error: 'a\nb' }), 'Last host message: a\\nb');
});
```

`extension/test/adsToolText.test.ts`:

```ts
test('scope with a stale newest sample names the host state', () => {
  const text = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 70_000, clock, state: { connected: false, error: 'Port 851 not found.' } });
  assert.ok(text.startsWith(`${gapNote(2000, 70_000, clock, 'Last host message: Port 851 not found.')}\n`), text);
});

test('scope with fresh samples ignores the host state', () => {
  const fresh = scopeSummaryText({ buffer: filled(['a']), symbols: ['a'], seconds: 60, target: 'local', intervalMs: 100, now: 2500, clock, state: { connected: false } });
  assert.ok(fresh.startsWith('ADS values of the last 60 s'), fresh);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (`hostNote` missing, `extra` and `state` unknown).

- [ ] **Step 3: Implement**

`gapNote` appends `` ` ${extra}` `` to the stale text only. `hostNote` escapes the error with `oneLine`. `scopeSummaryText` calls `gapNote(end, o.now, o.clock, hostNote(o.state))`. `scopeSummary` in `adsTools.ts` adds `state: host.state()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test
git commit -s -m "Name the host state when the scope has stopped getting samples" -m "A scope that ends silently after a download looked complete; the stale note now adds the host's last message. Per-symbol sample ages were rejected: all symbols of a row share one timestamp, so they would repeat the list-wide note."
```

---

### Task A7: Edge list for BOOL symbols

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`edgesText`), `extension/src/core/adsToolText.ts` (`scopeSummaryText`), `extension/src/core/toolInput.ts`, `extension/src/ads/adsTools.ts`, `extension/package.json`
- Test: `extension/test/adswatch.test.ts`, `extension/test/adsToolText.test.ts`, `extension/test/toolInput.test.ts`

**Interfaces:**
- Consumes: A3 (`ChangeLog`, `changeEntries`, `typeOf`), A4 (`relSeconds`), A2 (`ScopeOptions.maxRows`).
- Produces:
  ```ts
  export function edgesText(buf: ScopeBuffer, symbols: string[], seconds: number, now: number, maxRows?: number): string;
  // ScopeArgs gains: edges?: boolean
  // scopeSummaryText gains: edges?: boolean   (uses edgesText instead of scopeText)
  ```
  Output (exact): one line per symbol, then a blank line and the table only when edges exist:
  - BOOL with edges: `MAIN.bBusy: edges=3 (2 rising, 1 falling), now TRUE`
  - BOOL without: `GVL.bDone: no edges in the last 100 s, stays FALSE`
  - BOOL without any sample in the log: `GVL.bX: no samples in the last 100 s`
  - other type: `MAIN.nStep: not a BOOL, ignored`
  - table: `t[s]\tsymbol\tedge`, rows `-4.000\tMAIN.bBusy\trising`, sorted by time then by symbol order; more than `maxRows` (default 200): the newest and, before the table header, `N earlier edges not shown, narrow seconds or symbols`.
  An edge is a real change (`changeEntries`) of a BOOL whose new text is `TRUE` (rising) or `FALSE` (falling); the first sample is not an edge. Head line of the tool result: `ADS edges of the last 60 s up to the newest sample (target local):`; last line of the result: `Sampled every 100 ms; edges shorter than one sample are not seen.`
  `parseScopeInput({ edges: true, changesOnly: true })` fails with `edges and changesOnly cannot be combined: edges lists BOOL edges, changesOnly lists every change`.

- [ ] **Step 1: Write the failing tests**

`extension/test/toolInput.test.ts`:

```ts
test('toolInput scope edges', () => {
  assert.deepEqual(parseScopeInput({ edges: true }), { ok: true, value: { symbols: [], edges: true } });
  assert.deepEqual(parseScopeInput({ edges: 1 }), { ok: false, error: 'edges must be true or false' });
  const both = parseScopeInput({ edges: true, changesOnly: true });
  assert.equal(both.ok, false);
  if (!both.ok) assert.match(both.error, /edges and changesOnly cannot be combined/);
  assert.equal(parseScopeInput({ edges: false, changesOnly: true }).ok, true);
});
```

`extension/test/adswatch.test.ts` (add `edgesText` to the import):

```ts
const bool = (symbol: string): WatchItem => ({ symbol, type: 'BOOL', numeric: true, error: null });

test('edgesText lists rising and falling edges of a BOOL', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('MAIN.bBusy')]);
  b.push(1, at(['FALSE', 'TRUE', 'TRUE', 'FALSE', 'FALSE', 'TRUE']));
  assert.equal(edgesText(b, ['MAIN.bBusy'], 100, 5000), [
    'MAIN.bBusy: edges=3 (2 rising, 1 falling), now TRUE', '',
    't[s]\tsymbol\tedge', '-4.000\tMAIN.bBusy\trising', '-2.000\tMAIN.bBusy\tfalling', '0.000\tMAIN.bBusy\trising'].join('\n'));
});

test('edgesText says so for a constant BOOL, a non-BOOL and a symbol without samples', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('GVL.bDone'), item('MAIN.nStep'), bool('GVL.bX')]);
  b.push(1, [{ t: 0, v: ['FALSE', '1', null] }, { t: 1000, v: ['FALSE', '2', null] }]);
  assert.equal(edgesText(b, ['GVL.bDone', 'MAIN.nStep', 'GVL.bX'], 100, 1000), [
    'GVL.bDone: no edges in the last 100 s, stays FALSE',
    'MAIN.nStep: not a BOOL, ignored',
    'GVL.bX: no samples in the last 100 s'].join('\n'));
});

test('edgesText shows the newest edges beyond the row limit', () => {
  const b = new ScopeBuffer(100000);
  b.setItems(1, [bool('GVL.bFlag')]);
  b.push(1, at(Array.from({ length: 251 }, (_, i) => (i % 2 === 0 ? 'FALSE' : 'TRUE')), 10));
  const out = edgesText(b, ['GVL.bFlag'], 100, 2500);
  assert.match(out, /^GVL\.bFlag: edges=250 \(125 rising, 125 falling\), now FALSE$/m);
  assert.match(out, /^50 earlier edges not shown, narrow seconds or symbols$/m);
  assert.equal(out.split('\n').filter(l => /\t(rising|falling)$/.test(l)).length, 200);
});
```

`extension/test/adsToolText.test.ts`:

```ts
test('scope summary in edges mode has its own head and closing line', () => {
  const b = new ScopeBuffer(300);
  b.setItems(1, [{ symbol: 'GVL.bBusy', type: 'BOOL', numeric: true, error: null }]);
  b.push(1, [{ t: 0, v: ['FALSE'] }, { t: 1000, v: ['TRUE'] }]);
  assert.equal(scopeSummaryText({ buffer: b, symbols: ['GVL.bBusy'], seconds: 60, target: 'local', intervalMs: 100, now: 1500, clock, edges: true }), [
    'ADS edges of the last 60 s up to the newest sample (target local):',
    'GVL.bBusy: edges=1 (1 rising, 0 falling), now TRUE', '',
    't[s]\tsymbol\tedge', '0.000\tGVL.bBusy\trising',
    'Sampled every 100 ms; edges shorter than one sample are not seen.'].join('\n'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (`edgesText` missing, `edges` unknown).

- [ ] **Step 3: Implement**

`edgesText` per symbol: `buf.typeOf(s)?.toUpperCase() === 'BOOL'` else the ignored line; `const ch = changeEntries(buf.changes(s, now - seconds * 1000))`; no log entries and no `start` (also when every sample was null) -> no-samples line; `now TRUE/FALSE` from `buf.latest(s)?.value`. `scopeSummaryText`: head `edges`, body from `edgesText(o.buffer, o.symbols, o.seconds, end, o.options?.maxRows)`, closing line appended. `parseScopeInput`: boolean check, conflict check after both fields parsed. `adsTools.scope` passes `edges: input.edges`; `package.json` gets `"edges": { "type": "boolean", "description": "List rising and falling edges of BOOL symbols with their times instead of the table; other types are named as ignored. Do not combine with changesOnly." }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/package.json
git commit -s -m "Add an edge list for BOOL symbols to ads_scope" -m "Command bits and busy flags are read as pulses; a list of rising and falling edges with times is shorter than the changesOnly table and names the sample resolution so a missed pulse is not read as proof. Rejected: silently preferring one of edges and changesOnly when both are set."
```

---

### Task A8: Release

**Files:**
- Modify: `extension/package.json` (`modelDescription` of `iecode_ads_scope`), `extension/CHANGELOG.md`, `extension/README.md` (the ADS tools paragraph that names `ads_scope`, if it lists the options), `docs/ads-mcp-wishlist.md`
- Test: `extension/test/mcpTools.test.ts` stays green (tool order and count unchanged)

**Interfaces:**
- Consumes: A2-A7. Produces: nothing new.

- [ ] **Step 1: Manifest description.** Replace the `modelDescription` of `iecode_ads_scope` by:

  `Returns per watched ADS symbol over the last seconds (default 60): min, max, last value and sample count, how often it changed and when, plus a tab-separated table (time in seconds relative to the newest sample). Prefer changesOnly: true for step counters, enums, BOOLs and STRING values (one row per value change with the start value, never thinned; the plain table lists STRING values only in the summary). Use edges: true for BOOL pulses (rising and falling edges with times). maxRows limits the rows, decimals rounds fractions. A plain table over a long window is thinned and says how many samples it shows; it keeps every value change except in fast-changing columns, which are thinned evenly. Only watched symbols have a history: add them with the watch tool first and wait for samples.`

- [ ] **Step 2: CHANGELOG** (`extension/CHANGELOG.md`, Unreleased, "Claude Code and ADS", after the existing `ads_scope` bullet):

  `- ``ads_scope`` has new options. ``changesOnly`` lists one row per value change with the value at the start of the window, never thinned, and also shows STRING values; ``edges`` lists rising and falling edges of BOOL symbols with their times; ``maxRows`` and ``decimals`` shorten the table. The summary line says how often a symbol changed and when, and a scope that has stopped getting samples names the last host message.`

  (use single backticks as in the existing entries).

- [ ] **Step 3: README** — check the sentence in `extension/README.md` that names `ads_scope`; add `changesOnly` / `edges` only if it lists options, otherwise leave it.

- [ ] **Step 4: Full test run.** `cd extension && npm test`. Expected: all pass, same skipped count as before (1).

- [ ] **Step 5: Live check against a simulation target** (not the unit tests; record the result in the PR). With a TwinCAT runtime in simulation and a PLC with a step counter `MAIN.nStep` that advances through at least 10 steps, a BOOL `GVL.bBusy` that pulses, a STRING `MAIN.sMsg` that changes and a REAL `MAIN.fTemp` that ramps: `ads_watch add` the four, wait 30 s, then:
  1. `ads_scope {seconds: 25}`: header `N of M samples shown ...` names `fast-changing: MAIN.fTemp`; every `MAIN.nStep` value is in the table; the summaries show `changes=` and times; `MAIN.sMsg` is summarised by its changes.
  2. `ads_scope {changesOnly: true, seconds: 25}`: one row per change, text quoted, a start row.
  3. `ads_scope {edges: true, symbols: ["GVL.bBusy", "MAIN.nStep"]}`: edge rows for the BOOL, `MAIN.nStep: not a BOOL, ignored`.
  4. `ads_scope {maxRows: 10, decimals: 1}`: 10 rows, one decimal.
  5. Stop the runtime or close the ADS views for more than 2 s and call again: the result starts with `No samples since ...` and, after a host error, the last host message.
  6. The still-open `ads_wait` live check (Plan master, "Definition of done"): `ads_wait {symbol: "MAIN.nStep", condition: "changes", timeoutSeconds: 20}` returns `Condition met at ...`; a timeout case returns `Not met within N s ...`.
  Use the installed extension build (VSIX), not the development host, and a CLI of the same release; the MCP server of the test machine must list the new schema (`ads_scope` shows `changesOnly`).

- [ ] **Step 6: Wishlist.** In `docs/ads-mcp-wishlist.md` set to Done (with the test names from A2-A7 in the Tests column or notes): "ads_scope never drops a value change", "Say it when rows are dropped" (A1 tests listed above), "Change-only mode", "STRING and WSTRING history", "`maxRows` and `decimals`", "Per symbol in the summary: min, max, last, time of the first and last change", "`edges: true`", and in section 3 the stall line of "Show the sample age in watch and scope summaries; warn when sampling of the whole list stopped" (the `ads_watch` list shows no values, so its half stays Done by `ads_read`). Add `npm test` counts and the live-check date.

- [ ] **Step 7: Commit**

```bash
git add extension/package.json extension/CHANGELOG.md extension/README.md docs/ads-mcp-wishlist.md
git commit -s -m "Document the ads_scope options and close the scope wishlist items" -m "The model only uses changesOnly and edges if the tool description recommends them for the signals they fit. Wishlist rows are set to Done with their test names and the live check."
```

---

## Order

A1 (done) -> A2 -> A3 -> A4 -> A5 -> A6 -> A7 -> A8. A2 and A3 are independent and could be built in either order; A4 needs A2 and A3, A5 needs A4, A7 needs A3 and A4, A6 is independent (could go right after A2). If A3-A7 slip, A1 and A2 can ship as the plan's PR on their own (the manifest text of A8 then mentions only what exists).

## Open decisions

1. **`edges` together with `changesOnly`.** Recommendation (built in A7): reject with a clear error. Alternative: let `edges` win silently, which hides what the caller asked for.
2. **Summary line suffix.** A4 appends `changes=K (first at ..., last at ...)` to the summary of every symbol that changed, so the default `ads_scope` text is no longer byte-identical for such symbols (constant symbols are). Recommendation: accept; it is the wishlist item "time of the first and last change". Alternative: show the suffix only with `changesOnly`.
3. **Null samples (read errors) in the change log.** Recommendation (built in A3): skipped, the last good text stays the comparison base, so an error burst is not a flood of changes. Alternative: log `(read error)` as a value, so a symbol going bad shows in `changesOnly`.
4. **Copilot scope input validation (A2).** The Copilot tool now rejects invalid input with `Invalid arguments: ...` like `adsWait`; before, it passed raw values on. Recommendation: accept.


## Review amendments (2026-11-10)

From the engineering review of this plan. These override the task text above where they differ; apply them while building the named task.

1. **Alias-safe type classes (A3, A4, A7).** The CLI sends the type name of the symbol, which can be an alias (`T_MaxString`, a BOOL alias). `isText` and the BOOL check must not be plain regexes on `STRING(n)` / `BOOL`. Reuse the type-to-class table of `extension/src/core/waitCondition.ts` (it already decides unknown names by the value). Add tests with an alias STRING and an alias BOOL for A3 (quoted summary, escaped cell), A5 (an empty string is not an unchanged cell) and A7 (alias BOOL gets edges).
2. **Host message on the no-samples path (A6).** `scopeSummaryText` returns `No samples yet ...` before `gapNote` runs. Append the last host message there too, and test "no samples ever plus a host error". Replace the tautological A6 assertion (expected value built by `gapNote` itself) by a literal string.
3. **Dropped history in summaries and edges (A4, A7).** When `ChangeLog.olderDropped` is true, the summary line says `changes>=K (older changes dropped)` instead of `changes=K`, and `edgesText` ends with `older edges dropped` and ignores the classification of the first retained entry when `startUnknown`. Test: a noisy REAL under the cap, summary and edges.
4. **Size limit of `changesOnly` (A5).** The row limit is not a character limit. When the text would exceed `MAX_TOOL_TEXT`, drop the oldest rows (not the newest) and say how many; test with long quoted texts.
5. **Order.** A7 also depends on A5 (the `changesOnly` parser field for the conflict check). Order stays A1 -> A8 but A7 consumes A5.
6. **Intended output changes.** A4 also changes the summary line of constant non-numeric symbols (`changes=0 last="Run"`); A2 adds input validation to the Copilot scope tool. Both are listed in the master's intended changes.
7. **Module size.** Put the change log, `changesRows` and `edgesText` in a new `extension/src/core/scopeChanges.ts` instead of growing `adswatch.ts` (476 lines, a merge hotspot for B, C and E). `ScopeBuffer` keeps the log and exports its types.
8. **Test gaps to add:** `maxRows` 1 and 2; `decimals` on `1e-7` and `-0.00`; `changes()` with `fromMs` after the cutoff; the cap split over several items; `setSeconds` shrinking the log; a constant symbol and two symbols changing at the same sample in `changesOnly`; more than 20 symbols. Drop the `MAX_CHANGE_ENTRIES === 100_000` constant pin.


## Review amendments, round 2 (2026-11-10)

From the second, independent review. These override round 1 and the task text.

1. **Text and alias types (replaces round 1 item 1).** `waitCondition.classify` decides an alias by its value, so it must not decide text-ness here (an alias STRING holding `TRUE` is classified `bool`, an empty one `other`). Rule: an item with `numeric === false` is shown as text (quoted, escaped, never rounded by `decimals`), whatever its type name. `edges` accepts only an item whose type name is exactly `BOOL`; an alias gets `type <name> is an alias, not proven BOOL; use ads_read` in the result. Tests: alias STRING with `""`, `"TRUE"`, `"FALSE"`, `"1.234"`; alias BOOL.
2. **Window coverage (A3, A5).** `ChangeLog` carries `coveredFromMs` (the oldest time the buffer can speak for: the older of the buffer start and the first retained sample after trimming). The start row is printed only when the requested start is not before `coveredFromMs`; otherwise the header says `history covers only the last N s` and the start row is placed at `coveredFromMs`. A first observation is marked in the log (`first: true`), not derived from a missing predecessor. Tests: request longer than the buffer; shrink then grow the buffer; a change exactly at the window start.
3. **Read errors (A3, A4, A7).** A null sample does not count as a change, but the summary shows the last valid value with its time and `reading failed since <time>` when the newest samples are null. `edges` and `changesOnly` use the same rule; an error interval between two values makes the edge time `unknown between <t1> and <t2>`. Tests: valid -> null, null -> same value, null -> other value in all three modes.
4. **One budget for the whole answer (A5, A7).** The text limit applies to the assembled answer (head, summaries, table, footer). Order of cuts: oldest table rows first, then summaries beyond the first 50 symbols (with a count), the footer and the target/host lines are always kept. Applies to the plain table, `changesOnly` and `edges`. Tests on the final text of all three modes with 200 long names.
5. **Edges after a cap (A7, replaces the second half of round 1 item 3).** The first retained entry is a known change, not a first observation; keep it. When `olderDropped`, print `edges>=K` and `K retained edges`. Test with a toggling BOOL and a small cap (a REAL does not reach this path).
6. **`maxRows` (A2, A5).** The start row counts against `maxRows`; `maxRows: 1` returns the newest event only. Tests with a predecessor and one change in the window.
7. **Stall reason (A6).** `host.state()` does not keep the reason. `AdsHost` stores the last end reason with its time (`lastEnded()`), set in `stop()`/`exited()` and kept across a reconnect; `scopeSummary` passes it to `gapNote`. Tests: idle stop, settings restart, error then reconnect.
8. **Task placement (A3-A5).** A3 tests only storage and classification; quoted summaries move to A4, table cells to A5. The owner of the log is `scopeChanges.ts` (`ChangeLogStore`); `ScopeBuffer` owns one instance and delegates `push`, `setItems`, `setSeconds`, `clear`.
9. **Escaping (A4, A5).** `shownText` escapes `\` as `\\`, `"` as `\"`, newline as `\n`, tab as `\t`; the cut marker is `...` after at most 80 characters. Tested through the printed summary and cells; `shownText` is not exported for the test.
10. **Wiring (A2, A5, A7).** `ScopeOptions` contains `changesOnly`, `edges`, `maxRows`, `decimals`; one test in `mcpTools.test.ts` spies on `scope` with every new parameter and checks that an invalid combination never reaches it. The change-only branch does not build the numeric maps.
11. **Live check (A8).** Close all views and leases, wait for the real host stop (30 s), then check the stale line. Compare skipped tests by reason, not by a fixed count.
