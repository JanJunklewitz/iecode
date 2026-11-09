# Plan A: Scope Output That Is Correct and Compact

> **For agentic workers:** rough sub-plan of the [master plan](2026-11-09-ads-wishlist-master-plan.md). Before building a task, expand it into TDD steps with superpowers:writing-plans; use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** `ads_scope` never hides a value change, says when it shows less than it has, and offers a change-only view for numbers and strings.

**Architecture:** Pure changes in `ScopeBuffer` and `scopeText` (`extension/src/core/adswatch.ts`), texts in `adsToolText.ts`, input in `toolInput.ts`, schema in `package.json`. No CLI change, no protocol bump. Phase 2 of the [roadmap](2026-11-06-ads-mcp-wishlist.md) (change log, `changesOnly`, D7, D24) is reused unchanged.

**Tech Stack:** TypeScript, `node --test`.

**Spec:** [wishlist section 1](../../ads-mcp-wishlist.md), roadmap Phase 2.

## Global Constraints

See the master plan. In addition:

- `ads_scope` without the new options keeps its current table format; only the header line that reports thinning is new, and only when rows were left out.
- The numeric series for the plot (`views/adsScope.ts`) stays untouched.

## Review Focus

1. A column that toggles once between two long constant runs: both transitions survive thinning.
2. Two symbols whose changes fall into the same row: the row stays, neither column loses its change.
3. More changes than `maxRows`: the table shows the newest rows and says how many earlier changes it left out; it never pretends to be complete.
4. A STRING that changes while the numeric series has no point for it: appears in `changesOnly`, not in the plot.
5. The watch stopped mid-window (host stop, download): the header says the last sample time instead of a table that ends silently.

## File Structure

- `extension/src/core/adswatch.ts`: `thinKeepingChanges`, change log in `ScopeBuffer`, `scopeText` options.
- `extension/src/core/adsToolText.ts`: header lines, change-only table text, edge list text, stall warning.
- `extension/src/core/toolInput.ts`: `parseScopeInput` gains `changesOnly`, `maxRows`, `decimals`, `edges`.
- `extension/src/ads/adsTools.ts`, `extension/package.json`: pass the options through, describe them.
- Tests: `extension/test/adswatch.test.ts`, `adsToolText.test.ts`, `toolInput.test.ts`.

## Tasks

### A1: Lossless thinning and an honest header (priority 1, correctness)

**Interfaces:**
- Produces: `thinKeepingChanges<T>(rows: T[], max: number, differs: (a: T, b: T) => boolean): { rows: T[]; changes: number; droppedChanges: number }` in `adswatch.ts`; `scopeText` header line `N of M samples shown, K value changes kept`, added only when rows were left out.

Steps (to expand): failing test with a 1990-row step counter and 14 changes → all 14 transitions are in the output, header names `200 of 1990`; keep the last row of every run of equal values and the first row of the next run (two rows per transition); if the kept rows exceed `max`, keep the newest `max` and report `droppedChanges`; replace the `downsample` call in `scopeText` (`downsample` itself stays for its other callers); update the existing `scopeText` tests only where the new header appears.

### A2: `maxRows`, `decimals` and change times in the summary

**Interfaces:**
- Consumes: A1.
- Produces: `ScopeInput.maxRows?: number` (1-200, default 200), `ScopeInput.decimals?: number` (0-9, numbers in table and summary); `ScopeBuffer.summary()` returns also `firstChange?: number` and `lastChange?: number` (ms); summary line `... changed first at -9.4 s, last at -0.3 s`.

Steps: parser tests with out-of-range values (clamp, never throw); summary test with a constant series (no change times) and a toggling one; `decimals` applies to both table cells and min/max/last.

### A3: Change log, `changesOnly` and strings

**Interfaces:**
- Produces: `ScopeBuffer.changes(symbol: string, fromMs: number): { t: number; text: string }[]`; `ScopeInput.changesOnly?: boolean`.

Implement roadmap Phase 2 as written: entry cap 100 000 with `older changes dropped`, texts cut to 256 characters with a `…[cut]` mark and change detection on the full text, one predecessor entry per symbol so the window start value is known (`unknown (history dropped)` where the cap removed it), `setItems` and `clear` drop logs, table never thinned and capped at the newest 200 rows with `N earlier changes not shown`. Summary line for non-numeric symbols: `S: changes=K last="…"` instead of "no numeric samples".

### A4: Sample age and stall warning in the scope result

**Interfaces:**
- Consumes: `sampleAge(newestMs, nowMs)` and `gapNote` in `adswatch.ts` (today used by `ads_read`).
- Produces: scope result starts with `No samples since <time>: <reason>` when the newest row is older than the stall threshold; per-symbol `last` carries the age when older than 2 s.

Steps: tests with a buffer whose newest row is 30 s old; with a fresh one (no extra text); with an empty one (existing "No samples yet" text stays).

### A5: Edge list for BOOL symbols

**Interfaces:**
- Consumes: A3 change log. Produces: `ScopeInput.edges?: boolean`; `edgesText(buf, symbols, seconds, now): string` with rows `t[s]\tsymbol\trising|falling`.

Steps: tests with a BOOL pulse, a BOOL that is constant (no rows, says so), a non-BOOL symbol (named as ignored, not an error); edges beyond 200 follow the same "earlier edges not shown" rule as A3.

### A6: Release

Manifest descriptions recommend `changesOnly` for step counters, enums, BOOLs and strings; CHANGELOG entry; live check of `ads_scope` and the still-open `ads_wait` check against a simulation target; wishlist rows set to Done with test names.

## Order

A1 → A2 → A3 → A4 → A5 → A6. A1 and A2 can ship alone as a first PR if A3 slips.
