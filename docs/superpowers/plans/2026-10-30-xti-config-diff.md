# XTI Config Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare two versions of a TwinCAT `.xti` file (first target: the PLC instance `_Config/PLC/Plc.xti` / `Plc Instance.xti`) by meaning instead of by XML line, grouped by category, with persisted filter checkboxes that hide noise.

**Architecture:** A pure core flattens one `.xti` into an ordered list of `ConfigEntry` (identity key → value, with category and noise kind) and diffs two lists by key, so moved blocks, offsets and GUID churn do not produce line noise. On top: a CLI command `config-diff` (same shape as `links-diff`), a YAML document per version for VS Code's diff editor, and a webview panel "Config Changes" with version pickers and one checkbox per category / noise kind; the hidden set is the setting `iecode.configDiff.hidden`.

**Tech Stack:** TypeScript, VS Code extension API (webview, TextDocumentContentProvider, settings), existing `src/xml.ts` parser and `src/core/git.ts`, `node --test`.

**Spec:**
- [docs/research/xti-diff/README.md](../../research/xti-diff/README.md), sections *Results* and *Conclusions for the implementation* (categories, noise sources, defaults).
- `TODO.md`, item *Semantic diff for system config files* (concept: reuse compare entry points, YAML-like model, persisted checkboxes, hidden-count, IO links only as a hint).

## Global Constraints

- All code, comments, UI strings, commit messages in English.
- Match surrounding style: 2-space indent, single quotes, terse one-line comments explaining *why*; follow `src/core/iolinks.ts` / `src/views/ioLinks.ts` patterns.
- No new runtime dependencies. XML via `parseXml` from `src/xml.ts`, git via `show` / `log` / `repoRoot` from `src/core/git.ts`.
- `npm test` (= `tsc -p . && node --test out/test/*.test.js`, run in `extension/`) stays green after every task. Run tests through the PowerShell tool, not Git Bash.
- Existing IO links diff and ST compare behaviour must not change.
- Category ids and order (display order, top to bottom): `tasks`, `settings`, `licenses`, `unrestored`, `parameters`, `symbols`, `types`, `other`, `layout`, `metadata`. Plus `links`, which is never listed, only counted.
- Noise ids: `guid`, `build`, `timestamps`, `whitespace`.
- Default of `iecode.configDiff.hidden`: `["layout", "metadata", "guid", "build", "timestamps", "whitespace"]`.
- Test fixtures are synthetic (generic names like `MAIN.bStart`, `PlcTask`). Never copy content from company projects into this public repo.
- Commits: subject + 1-3 sentence body on *why*; no attribution trailers.

## Review Focus

1. **Huge diffs**: real files have 75k-320k lines; with *layout* shown, one commit yields >100k changes. The webview must not receive them all: at most 500 changes per category are sent, plus the total. Test in Task 2 (`limitChanges`).
2. **Duplicate identities**: the same `LicenseId` can appear several times; the same symbol name can appear in two data areas. Keys must stay unique (`#2`, `#3` suffix in document order) and diff stably. Test in Task 1.
3. **File missing in one version** (xti added, deleted or renamed between the refs): treat it as an empty entry list, so everything shows as added / removed, and add a note to the header. Never throw. Test in Task 3.
4. **Split instance files**: the small `Plc.xti` only has `<Project><Instance File="Plc Instance.xti"/>`, and `Plc Instance.xti` has no `Project` element. Flattening must find `Instance` / `TmcDesc` / `DataTypes` anywhere below the root. Test in Task 1.
5. **Non-PLC `.xti`** (EtherCAT device, NC axis): no crash. Unknown elements go to `other` via the generic fallback, and `Mappings` to `links`. Test in Task 1.

## Not in this plan

- Jumping from a change to its line in the raw XML diff (TODO concept): needs line offsets in `ConfigEntry`; add it after the first review on real diffs.
- Rename detection (a symbol renamed shows as removed + added).
- Tuned categories for other `.xti` types and the `.tsproj` (open question in the research doc). They work through the `other` fallback.

---

### Task 1: Flatten an `.xti` into categorised entries

**Files:**
- Create: `extension/src/core/configmodel.ts`
- Test: `extension/test/configdiff.test.ts` (new; holds an inline synthetic fixture `PLC_XTI` with: root `TcSmItem @TcVersion`; `DataTypes` with one struct `ST_Motor` (`Name @GUID @Namespace`, `BitSize`, two `SubItem`s with `Type @GUID`, `BitOffs`), one enum with `EnumInfo` and `Properties/Property` `to_string_function` = `__TO_STRING__17`; `Project @AmsPort="851"`; `Instance @TmcHash @LastKnownRefactorCnt` with `TmcDesc` containing `Licenses` (the same `LicenseId` twice), `Contexts/Context` (`Name` `PlcTask`, `Priority` 20, `CycleTime` 100000), `ParameterValues` (`Application Timestamp`, `Application Port` 851), `Properties` (`ChangeDate`), `DataAreas/DataArea` "PlcTask Inputs" with symbol `MAIN.bStart` (`BaseType` BOOL, `BitOffs`, `Comment`); `UnrestoredVarLinks @ImportTime` with one `Link @VarA @VarB @RestoreInfo="ANotFound"`; `Mappings` with one link. Also `SPLIT_POINTER` (6-line `Plc.xti` of the split variant) and `SPLIT_INSTANCE` (a `TcSmItem` with `DataTypes` + `Instance`, no `Project`).)

**Interfaces – Produces:**
```ts
export type Category = 'tasks' | 'settings' | 'licenses' | 'unrestored' | 'parameters' | 'symbols' | 'types' | 'other' | 'layout' | 'metadata' | 'links';
export type Noise = 'guid' | 'build' | 'timestamps' | 'whitespace';
export const CATEGORIES: Category[];          // display order from Global Constraints, without 'links'
export const NOISE: Noise[];
export interface ConfigEntry { key: string; value: string; category: Category; noise?: Noise }
export function flattenConfig(xml: string): ConfigEntry[];
export function cycleTimeText(ticks: string): string;   // 100 ns ticks -> "10 ms"
```

Key scheme (identity, never an offset or index unless there is no name):

| Source | Key | Category / noise |
|---|---|---|
| root `@TcVersion` | `TcVersion` | `settings` |
| `Project/@*` | `project/@<attr>` | `settings` |
| `Instance/@TmcHash`, `@LastKnownRefactorCnt` | `instance/@<attr>` | `metadata` |
| other `Instance/@*`, `Instance/Name`, `CLSID` | `instance/@<attr>`, `instance/Name`, `instance/CLSID` | `settings` |
| `Contexts/Context` | `tasks/<Name>/<Priority\|CycleTime\|Id\|ManualConfig/OTCID\|DependOn>`; CycleTime value via `cycleTimeText` | `tasks` |
| `TaskPouOids/TaskPouOid` | `tasks/pou-oids/<@OTCID>/@Prio` | `tasks` |
| `Licenses/License` | `licenses/<LicenseId>`, value `present` | `licenses` |
| `Parameters/Parameter` | `parameters/<Name>/<BaseType\|PTCID>` | `parameters` |
| `ParameterValues/Value` | `parameter-values/<Name>`, value = text of `Value`/`String`/`Data` child | `parameters`; `build` noise for `Application Timestamp`, `Refactory Counter` |
| `TmcDesc/Properties/Property` | `properties/<Name>` | `settings`; `build` noise for `ChangeDate`, `GeneratedCodeSize`, `GlobalDataSize` |
| `DataAreas/DataArea` | `symbols/<area Name>/@AreaType`, `/ContextId`, `/ByteSize` (`layout`) | `symbols` |
| `DataArea/Symbol` | `symbols/<area>/<symbol Name>/<BaseType\|Comment\|Default\|ArrayInfo\|@TcContextMask\|Properties/<Name>>`; `BitOffs`, `BitSize` | `symbols`; `BitOffs`/`BitSize` → `layout` |
| `DataTypes/DataType` | `types/<@Namespace.>Name/...`: `BaseType`, `Comment`, `SubItem/<Name>/<Type\|Comment\|Default>`, `Method/<Name>/Parameter/<Name>/Type`, `Method/<Name>/ReturnType`, `EnumInfo/<Text>` = `Enum`, `ArrayInfo`, `Properties/<Name>`; `BitSize`, `BitOffs`, `GetCodeOffs`, `SetCodeOffs`, `ReturnBitSize` | `types`; size/offset keys → `layout`; `to_string_function` / `to_wstring_function` → `build` noise |
| any `@GUID`, `@GuidA`, `@IdA` | `<owner key>/@GUID` | owner's category, `guid` noise |
| `UnrestoredVarLinks/OwnerA/OwnerB/Link` | `unrestored/<OwnerA Name>/<OwnerB Name>/<VarA>`, value `<VarB> (<RestoreInfo>)` | `unrestored` |
| `UnrestoredVarLinks/@ImportTime` | `unrestored/@ImportTime#<n>` | `unrestored`, `timestamps` noise |
| `Mappings/.../Link` | `links/<OwnerA>/<OwnerB>/<VarA>` = `<VarB>` | `links` |
| anything else | `other/<element path>[<Name> or #index]/...` | `other` |

Values are trimmed text with inner whitespace collapsed to one space (CDATA comments included). Compound children (`Default`, `ArrayInfo`) become one compact value, e.g. `LBound=0 Elements=8`. A key that occurs again gets the suffix `#2`, `#3` … in document order.

- [ ] **Step 1: Write failing tests** in `test/configdiff.test.ts`:
  - `flattenConfig finds tasks, licenses, parameters, symbols and types`: keys `tasks/PlcTask/CycleTime` (value `10 ms`), `licenses/{…}` and `licenses/{…}#2`, `parameter-values/Application Port` (value `851`), `symbols/PlcTask Inputs/MAIN.bStart/BaseType` (value `BOOL`), `types/ST_Motor/SubItem/nSpeed/Type` exist with the expected categories.
  - `flattenConfig marks noise`: `parameter-values/Application Timestamp` → `build`; `properties/ChangeDate` → `build`; the `to_string_function` property → `build`; `types/ST_Motor/@GUID` → `guid`; `unrestored/@ImportTime#1` → `timestamps`; `instance/@TmcHash` → category `metadata`; `symbols/PlcTask Inputs/MAIN.bStart/BitOffs` → category `layout`.
  - `flattenConfig handles the split variant`: `SPLIT_POINTER` yields `project/@AmsPort` and `TcVersion` only; `SPLIT_INSTANCE` yields `tasks/...` and `types/...` keys.
  - `flattenConfig puts unknown elements into other and links into links`: a minimal EtherCAT-like xti (`<TcSmItem><Device><Name>Device 1</Name><Box><Name>Term 1</Name><EtherCAT SlaveType="1"/></Box></Device><Mappings>…</Mappings></TcSmItem>`) does not throw, gives at least one `other/` key and one `links/` key.
  - `cycleTimeText converts 100 ns ticks`: `'100000'` → `'10 ms'`, `'120000'` → `'12 ms'`, `'5000'` → `'0.5 ms'`, `'abc'` → `'abc'`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail (module missing).
- [ ] **Step 3: Implement** `src/core/configmodel.ts`. Walk the `parseXml` tree once and dispatch on element name plus ancestors (`hasAncestor`, `text` from `src/core/iotree.ts`). The generic fallback recurses into unknown elements and names each one by its `<Name>` child text, or by `#<index>` among siblings with the same name.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `Config diff: flatten xti files into categorised entries`.

### Task 2: Diff, filter, limit and YAML

**Files:**
- Create: `extension/src/core/configdiff.ts`
- Test: `extension/test/configdiff.test.ts`

**Interfaces:**
- Consumes: `ConfigEntry`, `Category`, `Noise`, `CATEGORIES`, `flattenConfig` (Task 1).
- Produces:
```ts
export type Filter = Category | Noise;
export const DEFAULT_HIDDEN: Filter[];        // value from Global Constraints
export interface ConfigChange { kind: 'added' | 'removed' | 'changed'; key: string; category: Category; noise?: Noise; before?: string; after?: string }
export function diffConfig(before: ConfigEntry[], after: ConfigEntry[]): ConfigChange[];
export function isHidden(c: { category: Category; noise?: Noise }, hidden: ReadonlySet<Filter>): boolean;   // 'links' always hidden
export interface CategoryGroup { category: Category; shown: ConfigChange[]; total: number; hidden: number }
export function groupChanges(changes: ConfigChange[], hidden: ReadonlySet<Filter>, limit?: number): { groups: CategoryGroup[]; links: number; hiddenBy: Partial<Record<Filter, number>> };
export function configToYaml(entries: ConfigEntry[], hidden: ReadonlySet<Filter>, header?: string): string;
```
Rules:
- `diffConfig` matches by `key`. Changes are sorted by `CATEGORIES` order, then key. A change whose values differ only in whitespace gets noise `whitespace`, unless the entry already has a noise kind.
- `groupChanges` returns the groups in `CATEGORIES` order and leaves out empty ones. `limit` defaults to 500. `links` = number of link changes. `hiddenBy` counts per filter id, so the panel can show "(123 hidden)".
- `configToYaml` nests the keys by `/`, with categories as top-level keys in `CATEGORIES` order. Hidden entries are left out, so the diff editor shows only what is visible. Scalars are quoted with `yamlScalar` from `src/core/iotree.ts`.

- [ ] **Step 1: Write failing tests:**
  - `diffConfig reports added, removed and changed by key`: build `after` by changing `CycleTime` to 120000, removing one license, and adding symbol `MAIN.bStop`. The result contains `changed tasks/PlcTask/CycleTime 10 ms -> 12 ms`, `removed licenses/...#2` and `added symbols/PlcTask Inputs/MAIN.bStop/BaseType`.
  - `diffConfig ignores reordering`: the same entries in reversed order give `[]`.
  - `diffConfig marks whitespace-only changes`: feed two `ConfigEntry` lists directly (bypassing `flattenConfig`, which already collapses whitespace) with the same `Comment` key and values `'a b'` vs `'a b '`. The result is one change with noise `whitespace`.
  - `groupChanges hides by category and noise and counts`: with `DEFAULT_HIDDEN`, a `BitOffs` change and a GUID change are not shown. `hiddenBy.layout === 1` and `hiddenBy.guid === 1`. A `links` change only increments `links`.
  - `groupChanges limits each category`: 1200 symbol changes with `limit` 500 → `shown.length === 500`, `total === 1200`.
  - `configToYaml leaves out hidden entries`: YAML of `PLC_XTI` with `DEFAULT_HIDDEN` contains `tasks:` and `CycleTime: 10 ms` and does not contain `BitOffs` or `__TO_STRING__`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests fail.
- [ ] **Step 3: Implement** `src/core/configdiff.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `Config diff: compare entries by identity, filter and render YAML`.

### Task 3: Versions from git and the `config-diff` CLI command

**Files:**
- Create: `extension/src/core/confighistory.ts`
- Modify: `extension/src/cli.ts` (usage comment at the top, new `config-diff` branch next to `links-diff`)
- Test: `extension/test/configdiff.test.ts`

**Interfaces:**
- Consumes: `flattenConfig` (Task 1); `diffConfig`, `groupChanges`, `DEFAULT_HIDDEN`, `Filter` (Task 2); `show`, `repoRoot` from `src/core/git.ts`.
- Produces:
```ts
export interface ConfigVersion { entries: ConfigEntry[]; missing: boolean }
export async function configAt(file: string, ref: string | undefined): Promise<ConfigVersion>;   // ref undefined = working copy
export function changesToText(changes: ConfigChange[], hidden: ReadonlySet<Filter>): string;
```
`configAt` strips a UTF-8 BOM. When the file does not exist at that ref (or on disk), it returns `{ entries: [], missing: true }` and does not throw. `changesToText` prints a first line `<n> visible change(s), <m> hidden`, then one heading per non-empty visible category (`## tasks (2)`), then lines `changed  <key>  <before> -> <after>`, then a last line `<k> IO link change(s): see links-diff` if there are any.
CLI: `iecode-st config-diff --rev <ref> [--to <ref>] <file.xti> [--all] [--hide <id,id>]`. `--all` = nothing hidden (links still only counted). `--hide` replaces `DEFAULT_HIDDEN`. Exit code 1 if visible changes exist, 0 if none, like `links-diff`.

- [ ] **Step 1: Write failing tests:**
  - `configAt returns missing for a file that is not in the commit`: temp repo via `fs.mkdtemp` + `git init` and commit `a.xti`. `configAt(<repo>/b.xti, 'HEAD')` → `{ entries: [], missing: true }`. `configAt(<repo>/a.xti, 'HEAD').entries.length > 0`.
  - `changesToText groups by category and mentions hidden and links`: for a diff with one task change, one layout change (hidden by `DEFAULT_HIDDEN`) and one link change, the first line is `1 visible change(s), 1 hidden`, the output contains `## tasks (1)`, has no `## layout` heading, and ends with `1 IO link change(s): see links-diff`.
- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement** `confighistory.ts` and the CLI branch.
- [ ] **Step 4: Run** `npm test`. Expected: pass. Then `node out/src/cli.js config-diff --rev HEAD <some sample .xti>` prints without throwing. Use a synthetic file written to the scratchpad if the repo has no `.xti` sample.
- [ ] **Step 5: Commit** `CLI: config-diff for xti files`.

### Task 4: "Config Changes" panel, YAML diff and commands

**Files:**
- Create: `extension/src/views/configDiff.ts` (`registerConfigDiff(ctx)`, `html(nonce, csp)`)
- Modify: `extension/src/extension.ts` (call `registerConfigDiff(ctx)` next to `registerIoYaml(ctx)`)
- Modify: `extension/package.json` (commands, menus, setting)
- Test: `extension/test/configdiff.test.ts` (pure parts only)

**Interfaces:**
- Consumes: `configAt` (Task 3); `groupChanges`, `configToYaml`, `DEFAULT_HIDDEN`, `Filter` (Task 2); `CATEGORIES`, `NOISE` (Task 1); `log`, `repoRoot` from `src/core/git.ts`.
- Produces:
  - Commands `iecode.configDiff` (title "Compare Config with HEAD", icon `$(settings)`) and `iecode.configDiffCommit` (title "Compare Config with Commit…"). Both accept `Uri | SourceControlResourceState | undefined`, falling back to the active editor. They only accept `.xti`, with the message `IECode: select an .xti file to compare its configuration.`
  - Menus: `explorer/context`, `editor/title/context`, `scm/resourceState/context`, all with `when` `resourceExtname =~ /\\.xti$/i` and group `3_compare`, next to the IO links entries.
  - Setting `iecode.configDiff.hidden`: `type: array`, `items.enum` = all `Filter` ids, `default` = `DEFAULT_HIDDEN`, `markdownDescription` "Categories and noise kinds hidden in **Config Changes** (the checkboxes in the panel write this setting)."
  - YAML scheme `iecode-config`: `iecode-config:/<file> config (<label>).yaml?file=…&ref=…&label=…`. The provider renders `configToYaml(entries, hidden)` and re-renders when the setting changes (fire `onDidChange` from `onDidChangeConfiguration`).

Panel behaviour (one panel, reused like `showIoLinks`):
- Top bar: file name, version selects *Compare* / *with* (working copy, HEAD, the last 100 commits of the file via `log(root, [file], 100)`), then one checkbox per entry of `CATEGORIES` and `NOISE`. Checked = shown, so the label reads "show". Then the buttons **Open as YAML** and **Expand / Collapse**.
- A checkbox change posts `{ type: 'filter', hidden: Filter[] }`. The extension writes `iecode.configDiff.hidden` with `ConfigurationTarget.Global`, recomputes, and posts the result. The panel opens with the current setting.
- Body: one `<details>` per non-empty group, in `CATEGORIES` order. Summary `tasks · 2 changes (5 hidden)`. Rows show `kind`, `key` (without the category prefix), `before → after`. Groups over the limit end with `… and N more (open as YAML to see all)`.
- Summary line: `<n> visible change(s) · <m> hidden · <k> IO link change(s)`. The IO link part has a link that runs `iecode.ioLinksDiff` for the same file.
- A version where the file is missing shows the warning `<file> does not exist in <label>`.
- The webview CSP and escaping follow `src/views/ioLinks.ts` `html()`.

- [ ] **Step 1: Write failing test** `configDiff html has a checkbox per filter`: `html('n', 'csp')` contains `data-filter="<id>"` for every id in `CATEGORIES` and `NOISE`, and `nonce-n`.
- [ ] **Step 2: Run** `npm test`. Expected: fail.
- [ ] **Step 3: Implement** `src/views/configDiff.ts`, the `package.json` contributions and the `extension.ts` wiring.
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Manual check** in the Extension Development Host on a git repo with a committed synthetic PLC `.xti`. Change `CycleTime` and a symbol comment in the working copy, then right-click the file → *Compare Config with HEAD*:
  - The panel shows *tasks* and *symbols* groups, layout/metadata are hidden with counts.
  - Ticking *layout* shows the `BitOffs` rows. After a VS Code reload the checkbox is still ticked.
  - **Open as YAML** opens a diff with only visible entries.
- [ ] **Step 6: Commit** `Config Changes panel: categorised xti diff with persisted filters`.

### Task 5: Docs and release notes

**Files:**
- Modify: `extension/README.md` (feature table row after *IO Links*; CLI block line `iecode-st config-diff --rev <ref> [--to <ref>] <file.xti> [--all] [--hide <ids>]  # config changes of an xti`)
- Modify: `extension/CHANGELOG.md` (new section for the next version above the current top one, `### System project` bullet: categorised config diff for `.xti`, persisted filters, CLI `config-diff`)
- Modify: `extension/package.json` (`version` = the next patch version after the current one)
- Modify: `TODO.md` (tick the item, link this plan)

- [ ] **Step 1:** Write the README, CHANGELOG, version and TODO changes.
- [ ] **Step 2: Run** `npm test`. Expected: pass.
- [ ] **Step 3: Commit** `Docs: config diff for xti files`.
