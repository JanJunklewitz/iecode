# Plan G: IO Link Consistency Checks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find dead links (link to a PLC variable that no longer exists), size mismatches between linked variables, unlinked IO variables, and IO channels linked more than once; show them as warnings in the IO links view and as diagnostics.

**Architecture:** `core/ioLinkSymbols.ts` (Task 0, shared with Plan F) parses the PLC side of a link and resolves it against the `.tmc`. `core/ioLinkChecks.ts` compares the links of the system project (`IoSnapshot` from `core/iotree.ts`) with the symbols of the built PLC (`TmcFile` from `core/tmc.ts`) and returns `Finding`s (Plan H Task 1). `commands/ioLinkChecks.ts` publishes them and adds the warning rows to the IO links view. One PLC project (one `.tmc`) is checked against the links whose PLC name is that project's name.

**Tech Stack:** TypeScript (`node --test`), `core/iotree.ts`, `core/iolinks.ts`, `core/tmc.ts`, `Finding` of `core/findings.ts`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decisions 7, 10 and 11, open question 1); TODO item "IO link consistency checks". Needs Plan H Task 1 (`Finding`, `applyLevels`, `summaryText`, all in `core/findings.ts`) merged first.

## Global Constraints

- See the master plan. The symbol list comes from the build output (`.tmc`); without a build, or with a build older than the sources (the existing stale check used by `ads_symbols`), the checks report one info finding "PLC project not built (or build is older than the sources): link checks skipped" and nothing else.
- Findings are anchored on the `<Link>` element of the `.tsproj` / `.xti` that stores it (line of the element), so a click opens the right place.

## Review Focus

1. The PLC side of a link is `TIPC^<plc>^<plc> Instance^<task> Inputs|Outputs^<path>` (`HwLink.left`; the `OwnerA Name` is `TIPC^PLC1^PLC1 Instance`, `VarA` is `PlcTask Inputs^MAIN.bStart`, `linksOfFile` joins them; see `iotree.test.ts`). `parsePlcLinkSide` splits it into `{ plc, area, path }`; `area` is matched against the `.tmc` data area of the same name, `plc` against the name of the PLC project the `.tmc` belongs to; a variable with the same symbol path in another area, task or PLC project is not a match.
2. **Array elements and sub-paths (measured, see "Real-project check")**: a link whose PLC side is an array element (`...stIO.iaState[3]`) or a sub-item written with `^` (`...stData^D[0]`) is not a symbol of its own in the `.tmc`; it resolves through the longest prefix that is a symbol (strip `[n]`, treat `^` as `.`). Without this rule about 10 % of the links of the real project are reported dead.
3. A `TIPC^` side that `parsePlcLinkSide` does not accept (it has no `<plc> Instance^<task> Inputs|Outputs` shape: the safety links) is skipped by every rule here. **Not** every `TIPC^` side: all PLC links start with `TIPC^` (first draft error).
4. A project with no links at all: no finding, no error.
5. Several PLC variables on one **input** channel are normal (18 such channels in the real project): info at most. Two variables on one **output** channel are a conflict: warning (2 in the real project).
6. Links inside the `<UnrestoredVarLinks>` block of the `.xti` (old links XAE kept, carrying `RestoreInfo`) are not active links; the checks read `<Mappings>` only, as `linksOfFile` does.
7. A symbol that is `AT %I*` in the source but missing from the `.tmc` because the project is not rebuilt: the stale rule above applies, not a flood of dead-link errors.

## File Structure

- Create `extension/src/core/ioLinkSymbols.ts` (ships in Lane 2's PR as its first commit, see the master plan), `extension/src/core/ioLinkChecks.ts`, `extension/src/commands/ioLinkChecks.ts`.
- Modify `extension/src/core/workspace.ts` (`systemProjectOf`, Task 0), `extension/src/core/iotree.ts` (`HwLink` gets an optional `at?: number`, the offset of the `<Link>` element, set in `linksOfDoc`; additive, existing literals stay valid), `extension/src/views/ioLinkTree.ts` or `ioLinks.ts` (warning rows; read which one builds the rows before editing), `extension/src/extension.ts`, `extension/package.json` (rule defaults in `iecode.lint.rules`), `CHANGELOG.md`.
- Tests: `extension/test/ioLinkSymbols.test.ts`, `extension/test/ioLinkChecks.test.ts`.

### Task 0: Link symbol helper (shared with Plan F)

**Files:** Create `extension/src/core/ioLinkSymbols.ts`, `extension/test/ioLinkSymbols.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export function parsePlcLinkSide(side: string): { plc: string; area: string; path: string } | undefined   // /^TIPC\^([^^]+)\^\1 Instance\^([^^]+ (?:Inputs|Outputs))\^(.+)$/, the shape `shortName` in iotree.ts already parses
  export function normalizeLinkPath(path: string): string                                                   // lower-case, `[n]` removed, `^` as `.`
  export function resolveLinkSymbol(path: string, symbols: Map<string, TmcVar>): { symbol?: TmcVar; viaParent: boolean }   // longest prefix of the normalized path present in `symbols` (keys normalized the same way)
  ```
  ```ts
  export function systemProjectOf(model: Pick<WorkspaceModel, 'solutions'>, unit: Unit): { project: TwinCatProject; plcName: string } | undefined   // the TwinCatProject of unit.solution.projects whose plcs contains unit.plc (what iecode.ioLinks in extension.ts does inline); plcName is the PLC item name used in `TIPC^<plc>^` paths
  ```
  `shortName` keeps its own regex (it renders, it does not resolve); the new function is the one parser for checks and impact. `systemProjects()` of `workspace.ts` stays as is (zero-PLC projects only) and is **not** the lookup for these features.

- [ ] **Step 1: Write the failing tests:** `a PLC side is split into plc, area and path`; `a safety TIPC side, an IO side and a name with another instance name give undefined`; `normalizeLinkPath removes array indices and turns ^ into dots`; `resolveLinkSymbol finds an exact symbol, an array element through its array and a ^ sub-path through its parent`; `a longer unknown tail still resolves through the longest known prefix and says viaParent` (a parent match proves nothing about the child: no dead-link finding, no type finding, but it counts as linked for `io-unlinked`); `systemProjectOf finds the project that contains the PLC and one with PLC and IO in one tsproj` (the common case) `and returns the PLC item name of a renamed PLC`.
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Commit** `Parse the PLC side of an IO link in one place` (body: IO link checks and the impact view both have to turn a link path into a symbol path; two regexes would drift, and a `TIPC^` prefix test alone matches every PLC link).

### Task 1: Check rules

**Files:** Create `extension/src/core/ioLinkChecks.ts`, `extension/test/ioLinkChecks.test.ts`.

**Interfaces:**
- Consumes: `HwLink` (`left`, `right`, `size`, `attrs`, `file`), `toIoLink` / `IoLink`, `TmcFile` (`modules[].areas[]: TmcArea { name, areaType, symbols: TmcVar { name, type, bitSize } }`), `Finding`, `resolveLinkSymbol` (below, in `core/ioLinkSymbols.ts`).
- Produces:
  ```ts
  export interface LinkSource { link: HwLink; line: number }                   // line of the <Link> element in link.file (from HwLink.at and the file text; `link.file` is relative to the project folder, the finding's `file` is made absolute by the caller)
  export function checkIoLinks(links: LinkSource[], tmc: TmcFile | undefined, built: { stale: boolean }, plc: string): Finding[]   // only links whose parsed PLC name is `plc`
  export const IO_RULES: RuleInfo[]
  ```
  Rules (id, default level): `io-dead-link` error (PLC side not found in the area's symbols, also not through a parent, Review Focus 2); `io-type-changed` warning (the link's type attribute differs from the symbol's type in the `.tmc`; only for an **exact** symbol match, never for a link resolved through a parent: an array element or sub-path carries the element type, the `.tmc` symbol has the array or struct type, which would give about 78 false warnings on the real project; the attribute is `TypeA` when `link.sideA === link.left` (the PLC side is stored as A) and `TypeB` otherwise, because `linksOfDoc` swaps the sides; a missing type attribute is unknown, not a mismatch; nothing in the repository reads `TypeA` yet, so Step 1 confirms with a real `.tsproj` that XAE writes it); `io-unlinked` warning (symbol of an input or output area that no link resolves to, directly or through a parent / element); `io-channel-twice` (grouped by IO channel **and bit range** (`OffsA` / `OffsB` and `Size`; several BOOLs linked to different bits of one output word are valid, the 2 measured output cases may be exactly that): warning when two PLC variables overlap on one output range, info when they overlap on an input range, nothing for disjoint ranges; when offsets or sizes are missing the range is unknown and the rule says info only; the grouping runs over the links of **all** PLC projects of the system project, while the symbol rules run per PLC); `io-not-built` info (see Global Constraints). **No size rule:** the `Size` attribute is not simply the symbol's `BitSize / 8` (see "Real-project check": 8 of 683 matching links disagree), so a size rule would produce false alarms.
  The link-to-symbol resolution is Task 0 (`parsePlcLinkSide`, `resolveLinkSymbol`); `checkIoLinks` indexes each `.tmc` area's symbols once into `Map<normalizedPath, TmcVar>` and calls it per link.

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
- Consumes: `checkIoLinks` (Task 1), `readProject` / `snapshotOf` and the `.tsproj` lookup the IO links view already does (`views/ioLinks.ts`), `parseTmc` / `decodeTmc` and the build output lookup used for `ads_symbols` (`newerSources` in `core/symbolOrigin.ts` is the stale check (timestamp based with a 2 s tolerance: it detects "older than the sources", it does not prove the build matches the sources); `core/adsinterface.ts` reads the `.tmc`), `applyLevels` (Plan H Task 1).
- Produces: `registerIoLinkChecks(ctx, state): void`; command `iecode.lintIoLinks`; a "Checks" group with one row per finding at the top of the IO links view (empty group is not shown).

- [ ] **Step 1: Write the failing test** for the pure grouping `ioFindingRows(findings: Finding[]): { label: string; description: string; file: string; line: number }[]` in `core/ioLinkChecks.ts` (one row per finding, sorted errors first, label the IO side short name via `shortName` from `core/iotree.ts`).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire:** a `DiagnosticCollection` `iecode-lint-iolinks` on the `.tsproj` / `.xti` files; run on opening the IO links view, on save of a `.tsproj` / `.xti`, after the `.tmc` changes (file watcher on the build output) **and after a save of an ST object or `.plcproj` of that PLC** (a fresh `.tmc` becomes stale; the old dead-link findings must turn into `io-not-built`: every run replaces all diagnostics of the collection). `IoSnapshot.warnings` (a referenced `.xti` that could not be read) make the link set incomplete: `io-unlinked` is then not reported and one info says why; rows into the view; `iecode.lintIoLinks` forces a run and shows the summary message of `summaryText` (Plan H Task 1).
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check on a project where one PLC variable was renamed after linking: the dead link shows in the view and in the Problems panel. Also open the real project of the check above: expect about 2 dead links, 2 output-channel warnings and no flood; more than 10 findings means a resolution rule is missing.
- [ ] **Step 5: Commit** `Show IO link problems in the view and the Problems panel` (body: the checks are only useful where the links are looked at).
