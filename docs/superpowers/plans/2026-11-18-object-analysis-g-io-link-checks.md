# Plan G: IO Link Consistency Checks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find dead links (link to a PLC variable that no longer exists), size mismatches between linked variables, unlinked IO variables, and IO channels linked more than once; show them as warnings in the IO links view and as diagnostics.

**Architecture:** `core/ioLinkChecks.ts` compares the links of the system project (`IoSnapshot` from `core/iotree.ts`) with the symbols of the built PLC (`TmcFile` from `core/tmc.ts`) and returns `Finding`s (Plan H Task 1). `commands/ioLinkChecks.ts` publishes them and adds the warning rows to the IO links view.

**Tech Stack:** TypeScript (`node --test`), `core/iotree.ts`, `core/iolinks.ts`, `core/tmc.ts`, `Finding` of `core/findings.ts`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 7, open question 1); TODO item "IO link consistency checks". Needs Plan H Task 1 (the `Finding` type) only.

## Global Constraints

- See the master plan. The symbol list comes from the build output (`.tmc`); without a build, or with a build older than the sources (the existing stale check used by `ads_symbols`), the checks report one info finding "PLC project not built (or build is older than the sources): link checks skipped" and nothing else.
- Findings are anchored on the `<Link>` element of the `.tsproj` / `.xti` that stores it (line of the element), so a click opens the right place.

## Review Focus

1. The area part of a link variable (`PlcTask Inputs^MAIN.bStart`) is matched against the `.tmc` data area of the same name; a variable with the same symbol path in another area or task is not a match.
2. A link whose PLC side is a member of a struct or array element (`MAIN.stIn.bStart`, `MAIN.aIn[3]`) resolves through the parent symbol's type, not only by full-name lookup.
3. A project with no links at all: no finding, no error.
4. Two links on one IO channel, one on an output and one on an input, are judged by their direction (see open question 1 of the master plan: the default severities are a proposal and are verified on a real project before release).
5. A symbol that is `AT %I*` in the source but missing from the `.tmc` because the project is not rebuilt: the stale rule above applies, not a flood of dead-link errors.

## File Structure

- Create `extension/src/core/ioLinkChecks.ts`, `extension/src/commands/ioLinkChecks.ts`.
- Modify `extension/src/views/ioLinkTree.ts` or `ioLinks.ts` (warning rows; read which one builds the rows before editing), `extension/src/extension.ts`, `extension/package.json` (rules registered in `iecode.check.rules` defaults), `CHANGELOG.md`.
- Tests: `extension/test/ioLinkChecks.test.ts`.

### Task 1: Check rules

**Files:** Create `extension/src/core/ioLinkChecks.ts`, `extension/test/ioLinkChecks.test.ts`.

**Interfaces:**
- Consumes: `HwLink` (`left`, `right`, `size`, `attrs`, `file`), `toIoLink` / `IoLink`, `TmcFile` (`modules[].areas[]: TmcArea { name, areaType, symbols: TmcVar { name, type, bitSize } }`), `Finding`, `ioVariablePath` (Plan F Task 1; if Plan F is not built, put the same pure function in this file and let Plan F import it).
- Produces:
  ```ts
  export interface LinkSource { link: HwLink; line: number }                   // line of the <Link> element in link.file
  export function checkIoLinks(links: LinkSource[], tmc: TmcFile | undefined, built: { stale: boolean }): Finding[]
  export const IO_RULES: RuleInfo[]
  ```
  Rules (id, default level): `io-dead-link` error (PLC side not found in the area's symbols, including struct / array parents, Review Focus 2); `io-size-mismatch` warning (only when the link carries `Size` and the symbol has a `bitSize`, compare bytes; step 1 below decides the unit); `io-unlinked` warning (symbol of an input or output area without any link; see step 1); `io-channel-twice` warning for two PLC variables on one IO channel (info when all links to that channel are inputs); `io-not-built` info (see Global Constraints).

- [ ] **Step 1: Look at real data before coding** (30 min, record the findings in the PR): in a built PLC project, open one `.tmc` and one `.tsproj` and write down (a) which symbols a data area `... Inputs` / `... Outputs` lists (all `AT %I*` and explicit `AT %IX0.0`, or only wildcard ones), (b) what the `Size` attribute of a `<Link>` means next to the symbol's `BitSize`. Adjust the two rules `io-unlinked` and `io-size-mismatch` to what you see and put a minimal synthetic fixture with the same shape in the test file. If the data cannot be had, ship without these two rules and say so in the CHANGELOG.
- [ ] **Step 2: Write the failing tests:** one per rule (positive and negative), `no links gives no findings`, `a stale build gives only io-not-built`, `a struct member link resolves through its parent`, `a same-named variable in another area is not a match`.
- [ ] **Step 3: Run** `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement** `checkIoLinks`; index the tmc symbols once per call by `area name + '^' + symbol name` (case-insensitive).
- [ ] **Step 5: Run tests.** Expected: PASS.
- [ ] **Step 6: Commit** `Check IO links against the built PLC symbols` (body: a renamed or removed variable left a dead link that only showed up when the machine did not react; the build output is what XAE itself resolves links against).

### Task 2: Wire into the Problems panel and the IO links view

**Files:** Create `extension/src/commands/ioLinkChecks.ts`; modify the IO links view file, `extension/src/extension.ts`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `checkIoLinks` (Task 1), `readProject` / `snapshotOf` and the `.tsproj` lookup the IO links view already does (`views/ioLinks.ts`), `parseTmc` / `decodeTmc` and the build output lookup used for `ads_symbols` (`core/symbolSource.ts` or `symbolOrigin.ts` on the branch that has them; on `main` find the nearest equivalent, `core/adsinterface.ts` reads the `.tmc`), `applyLevels` (Plan H Task 1).
- Produces: `registerIoLinkChecks(ctx, state): void`; command `iecode.checkIoLinks`; a "Checks" group with one row per finding at the top of the IO links view (empty group is not shown).

- [ ] **Step 1: Write the failing test** for the pure grouping `ioFindingRows(findings: Finding[]): { label: string; description: string; file: string; line: number }[]` in `core/ioLinkChecks.ts` (one row per finding, sorted errors first, label the IO side short name via `shortName` from `core/iotree.ts`).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire:** a `DiagnosticCollection` `iecode-iolinks` on the `.tsproj` / `.xti` files; run on opening the IO links view, on save of a `.tsproj` / `.xti` and after the `.tmc` changes (file watcher on the build output); rows into the view; `iecode.checkIoLinks` forces a run and shows the summary message of `summaryText` (Plan H Task 4).
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check on a project where one PLC variable was renamed after linking: the dead link shows in the view and in the Problems panel.
- [ ] **Step 5: Commit** `Show IO link problems in the view and the Problems panel` (body: the checks are only useful where the links are looked at).
