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

1. The area part of a link variable (`PlcTask Inputs^MAIN.bStart`, as `linksOfFile` already builds it from `OwnerA Name="InputDst"`) is matched against the `.tmc` data area of the same name; a variable with the same symbol path in another area or task is not a match.
2. **Array elements and sub-paths (measured, see "Real-project check")**: a link whose PLC side is an array element (`...stIO.iaState[3]`) or a sub-item written with `^` (`...stData^D[0]`) is not a symbol of its own in the `.tmc`; it resolves through the longest prefix that is a symbol (strip `[n]`, treat `^` as `.`). Without this rule about 10 % of the links of the real project are reported dead.
3. Links with a `TIPC^` PLC side (safety project) are not PLC area symbols and are skipped by every rule here.
4. A project with no links at all: no finding, no error.
5. Several PLC variables on one **input** channel are normal (18 such channels in the real project): info at most. Two variables on one **output** channel are a conflict: warning (2 in the real project).
6. Links inside the `<UnrestoredVarLinks>` block of the `.xti` (old links XAE kept, carrying `RestoreInfo`) are not active links; the checks read `<Mappings>` only, as `linksOfFile` does.
7. A symbol that is `AT %I*` in the source but missing from the `.tmc` because the project is not rebuilt: the stale rule above applies, not a flood of dead-link errors.

## File Structure

- Create `extension/src/core/ioLinkChecks.ts`, `extension/src/commands/ioLinkChecks.ts`.
- Modify `extension/src/views/ioLinkTree.ts` or `ioLinks.ts` (warning rows; read which one builds the rows before editing), `extension/src/extension.ts`, `extension/package.json` (rules registered in `iecode.check.rules` defaults), `CHANGELOG.md`.
- Tests: `extension/test/ioLinkChecks.test.ts`.

### Task 1: Check rules

**Files:** Create `extension/src/core/ioLinkChecks.ts`, `extension/test/ioLinkChecks.test.ts`.

**Interfaces:**
- Consumes: `HwLink` (`left`, `right`, `size`, `attrs`, `file`), `toIoLink` / `IoLink`, `TmcFile` (`modules[].areas[]: TmcArea { name, areaType, symbols: TmcVar { name, type, bitSize } }`), `Finding`, `resolveLinkSymbol` (below, in `core/ioLinkSymbols.ts`).
- Produces:
  ```ts
  export interface LinkSource { link: HwLink; line: number }                   // line of the <Link> element in link.file
  export function checkIoLinks(links: LinkSource[], tmc: TmcFile | undefined, built: { stale: boolean }): Finding[]
  export const IO_RULES: RuleInfo[]
  ```
  Rules (id, default level): `io-dead-link` error (PLC side not found in the area's symbols, also not through a parent, Review Focus 2); `io-type-changed` warning (the link's `TypeA` attribute differs from the symbol's type in the `.tmc`; XAE writes `TypeA` into every link); `io-unlinked` warning (symbol of an input or output area that no link resolves to, directly or through a parent / element); `io-channel-twice` (warning when two PLC variables share one output channel, info when they share an input channel, Review Focus 5); `io-not-built` info (see Global Constraints). **No size rule:** the `Size` attribute is not simply the symbol's `BitSize / 8` (see "Real-project check": 8 of 683 matching links disagree), so a size rule would produce false alarms.
  Shared helper, in `core/ioLinkSymbols.ts` (Plan F Task 1 uses it too; whichever plan is built first creates it): `export function resolveLinkSymbol(variable: string, areas: Map<string, Map<string, TmcVar>>): { symbol?: TmcVar; viaParent: boolean; area: string }` where `variable` is `HwLink.left` (`Area^path`), the path is lower-cased, `[n]` groups are removed, `^` counts as `.`, and the longest prefix present in the area wins.

## Real-project check (2026-11-18, read-only, numbers only)

Run with the existing `parseTmc` and `linksOfFile` against a real XAE 4024 project (one PLC, 775 active links, a `.tmc` from the same week). Results the plan relies on:

| Measurement | Result |
|---|---|
| Links whose PLC side is found by exact name in its data area | 683 |
| Found only through a parent (array element, `^` sub-path) | 78 |
| Safety links (`TIPC^` side), not PLC area symbols | 12 |
| Not found at all | 2 (both elements of a nested array of structs) |
| `parseTmc` on the 7 MB `.tmc` | 139 ms |
| Input channels with 2 or more PLC variables / output channels with 2 or more | 18 / 2 |
| Links carrying `RestoreInfo` | 0 among the 775; 184 sit in `<UnrestoredVarLinks>`, an old block XAE keeps outside `<Mappings>` |
| Links whose `TypeA` differs from the `.tmc` type | 0 |
| Links with `Size` disagreeing with `BitSize / 8` | 8 (`Size="8"` against `BitSize` 8) |

Data area names in the `.tmc` are `<task> Inputs` (type `InputDst`), `<task> Outputs` (`OutputSrc`), `Internal`, `Retains`; a symbol name there is the plain path (`MAIN.x.y`) and a `BOOL` has `BitSize` 8. Not yet measured: whether `AT %IX0.0` (explicit address) symbols appear in the input area; step 1 settles it for `io-unlinked`.

- [ ] **Step 1: Settle `io-unlinked` on real data** (15 min, numbers only in the PR, no names): count the symbols of `... Inputs` / `... Outputs` that no link resolves to (with `resolveLinkSymbol`), then look at ten of them in the source: are they `AT %I*` variables that really lack a link, or explicit-address / unused ones? If more than a third are not real gaps, ship `io-unlinked` as `hint` and say so in the CHANGELOG.
- [ ] **Step 2: Write the failing tests:** one per rule (positive and negative), `no links gives no findings`, `a stale build gives only io-not-built`, `an array element and a ^ sub-path resolve through their parent` (the exact shapes from the table), `a same-named variable in another area is not a match`, `a TIPC link is skipped`, `two variables on an input channel give info, on an output channel a warning`, `links in UnrestoredVarLinks are ignored`.
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
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check on a project where one PLC variable was renamed after linking: the dead link shows in the view and in the Problems panel. Also open the real project of the check above: expect about 2 dead links, 2 output-channel warnings and no flood; more than 10 findings means a resolution rule is missing.
- [ ] **Step 5: Commit** `Show IO link problems in the view and the Problems panel` (body: the checks are only useful where the links are looked at).
