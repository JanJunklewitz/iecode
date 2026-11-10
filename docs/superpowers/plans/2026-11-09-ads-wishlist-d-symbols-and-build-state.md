# Plan D: Symbols, Structures, Enums and Build State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent finds symbols without a build output, reads structures and arrays whole, knows the valid enum values, sees which source a symbol list comes from, and sees at once when the sources are newer than the build output or the running PLC runs another build.

**Architecture:** Decisions live in pure `extension/src/core/` modules (`symbolOrigin.ts`, `symbolQuery.ts`, `symbolSource.ts`, `onlineSymbols.ts`, `watchExpand.ts`, additions to `adsinterface.ts`, `tmc.ts`, `adsToolText.ts`, `toolInput.ts`); `src/ads/` only wires them. Online symbols are a separate short-lived `iecode ads symbols --online` process (never a watch-host op, so samples and writes do not wait behind a symbol upload, roadmap D22). Struct reads are an additive `depth` request field and an optional `members` list in the `read` reply, gated by the protocol table (roadmap D23). All C# decisions are pure Core classes tested without the Beckhoff assemblies; the Beckhoff glue stays thin.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads`.

**Spec:** [../../ads-mcp-wishlist.md](../../ads-mcp-wishlist.md) (sections 3 and 6), [2026-11-06-ads-mcp-wishlist.md](2026-11-06-ads-mcp-wishlist.md) (Phases 5 and 7, decisions D1, D14, D15, D22, D23), [2026-11-09-ads-wishlist-master-plan.md](2026-11-09-ads-wishlist-master-plan.md). Style template: [2026-11-06-ads-wait.md](2026-11-06-ads-wait.md).

## Global Constraints

- Public repository: no internal project, module, machine or symbol names in code, tests, docs or commits; the examples in this plan (`MAIN`, `FB_Drive`, `E_Mode`, `ST_Axis`) are generic. Commits: GitHub noreply author (`git config user.email` of the repo is already `143817835+PatrHofmann@users.noreply.github.com`), `git commit -s -m "<subject>" -m "<1-3 sentence why>"`, English only.
- Tests: `cd extension && npm test` (runs `tsc -p .` first); a single file: `cd extension && npx tsc -p . && node --test out/test/<name>.test.js`. C# only through the PowerShell tool: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~<Class>"` (or `IECode.Automation.Tests`). Never chain `dotnet build` and `dotnet test`, and start nothing else heavy next to them (memory crash on this machine).
- Tools are declared once in `extension/package.json` (`languageModelTools`) and served by both `buildMcpTools` and `lmTools.ts`; the manifest parity test stays green. New input fields are optional; a parse result contains an optional key only when the caller sent it, so `parseSymbolsInput({ filter: 'MAIN.' })` stays `{ filter: 'MAIN.' }`.
- Intended output changes (the only ones): `ads_symbols` now names its source and the build time before the rows (D1, D5b) and words its paging note differently (D3); `ads_read` of a struct or array returns members instead of "not a single value" (D7b). A single-value `ads_read` row, `ads_watch` and `ads_scope` stay byte-identical, and the `read` reply of the host is unchanged for a request without `depth`.
- The result of `ads_symbols` names its source with exactly these lines (D1, D5b): `Symbols from the build output of <unit> (built <YYYY-MM-DD HH:mm:ss>).`, `Symbols from the running PLC (<target>).`, `Symbols from the source code of <unit> (may differ from the PLC).`
- Online symbol lists are bounded (roadmap D15): a filter is required, at most 500 matches plus the total count, 60 s timeout. Struct reads are bounded: depth default 3, max 5; at most 200 members; at most 20 elements per array.
- Hidden variables (`{attribute 'hide'}`) have no ADS symbol: nothing can read them over ADS, so there is no "opt-in read". They are listed as hidden and named in not-found hints (D2, D4).
- Dependency on Plan C task C0 (protocol version table). Consumed interface, exported from the pure module `extension/src/core/hostProtocol.ts` that C0 creates (node tests can load it): `PROTOCOL_TABLE: Record<number, { ops: string[]; features: string[] }>` and `AdsHost.supports(feature: string): boolean` (valid after `await host.ready()`, reset on every host start). Feature names this plan adds to the entry of the unreleased protocol number: `onlineSymbols` (D5, `ads symbols --online` exists), `structRead` (D7, `read` accepts `depth` and replies with `members`). If C2 has not bumped `WatchHost.Protocol` yet when D5 or D7 is built, the first of them bumps it to the next number and creates the table entry, following C0's pattern; later tasks add their feature to that open entry. Missing-feature wording follows C0: `needs a newer iecode CLI: <feature>`.

## Review Focus

1. No `.tmc` and an offline target: `auto` falls back to the source code, says `Symbols from the source code of <unit> (may differ from the PLC).` and names why online was not used. Test in D5b (`planSources`, `onlineFailureText`).
2. A struct with 5000 leaf members: capped at 200, the result says `4800 members left out`. Test in D7 (`StructExpand`) and D7b (`readStructRows`).
3. Sources newer than the `.tmc` by one second of clock skew: no false stale warning (2 s tolerance). Test in D1.
4. An enum whose members share a value: both names listed with a note, and a write by the second name resolves. Tests in D2 (list text) and D2b (write).
5. A hidden member: listed as hidden only on request, a read of it says there is no ADS symbol and names the matching property. Tests in D2 and D4.

## File Structure

- `extension/src/core/symbolOrigin.ts` (new): build time, stale tolerance, the three source header lines.
- `extension/src/core/symbolQuery.ts` (new): filter, prefix, type, paging, query text.
- `extension/src/core/symbolSource.ts` (new): which source answers (`auto`, `online`, `build`, `source`).
- `extension/src/core/onlineSymbols.ts` (new): argv and result parsing of `iecode ads symbols --online`.
- `extension/src/core/watchExpand.ts` (new): names for `ads_watch { expand: true }`.
- `extension/src/core/tmc.ts`, `adsinterface.ts`: enum members, hidden flag, property lookup, build time and newer sources.
- `extension/src/core/adsToolText.ts`, `toolInput.ts`, `extension/src/ads/adsTools.ts`, `host.ts`, `mcpTools.ts`, `extension/package.json`: wiring and texts.
- `extension/src/ads/onlineSymbols.ts` (new): runs the CLI process.
- `cli/src/IECode.Core/Ads/`: `OnlineSymbols.cs` (new), `StructExpand.cs` (new), `PlcValueText.cs`, `WatchProtocol.cs`, `WatchHost.cs`.
- `cli/src/IECode.Automation/`: `AdsLink.cs`, `AdsWatchBackend.cs`, `AdsValues.cs`, `OnlineSymbolList.cs` (new).
- `cli/src/IECode.Cli/Commands/TargetCommands.cs`, `cli/README.md`.
- Tests: `extension/test/symbolOrigin.test.ts`, `symbolQuery.test.ts`, `symbolSource.test.ts`, `onlineSymbols.test.ts`, `watchExpand.test.ts` (new), `symbolFixtures.ts` (new, shared fixtures), additions to `adsinterface.test.ts`, `tmc.test.ts`, `adsToolText.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`; `cli/tests/IECode.Core.Tests/OnlineSymbolsTests.cs`, `StructExpandTests.cs` (new), `PlcValueTextTests.cs`, `WatchHostTests.cs`; `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `FakeLink.cs`, `OnlineSymbolListTests.cs` (new).

## Order

D1 -> D2 -> D3 -> D4 (extension only, release train T1). D2b, D5, D7 are CLI tasks without a dependency on each other; build them on one branch one after the other (they share `WatchProtocol.cs`, `AdsLink.cs`) after C0. D5b needs D5 and C0; D6 needs D5 (its online compare) and a simulation target; D6b needs D6; D7b needs D7 and C0; D8 last.

---

### Task D1: Build time and stale-source warning (extension only)

**Files:**
- Create: `extension/src/core/symbolOrigin.ts`, `extension/test/symbolOrigin.test.ts`
- Modify: `extension/src/core/adsinterface.ts` (`AdsInterface`, `fromBuild`, lines 34-43 and 318-324), `extension/src/core/adsToolText.ts` (`symbolsText`), `extension/src/ads/adsTools.ts` (`symbols`), `extension/test/adsinterface.test.ts`, `extension/test/adsToolText.test.ts`, `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: `fromBuild(plc: PlcProject, members?: boolean): Promise<AdsInterface>` (today sets `stale` with no tolerance).
- Produces:
  ```ts
  // symbolOrigin.ts
  export const STALE_TOLERANCE_MS = 2000;
  export const MAX_NEWER_LISTED = 3;
  export function newerSources(builtMs: number, sources: { file: string; mtimeMs: number }[], toleranceMs?: number): string[]; // base names, newest first, only files newer than builtMs + tolerance
  export function localStamp(d: Date): string;                       // 'YYYY-MM-DD HH:mm:ss', local time
  export function buildHeader(o: { unit: string; builtAt: Date; newer: string[] }): string[];
  // adsinterface.ts
  export interface AdsInterface { /* existing */ builtAt?: Date; newerSources?: string[] }   // set by fromBuild; stale === newerSources.length > 0
  // adsToolText.ts
  export function symbolsText(o: { headers: string[]; matches: string[]; total: number; max: number; typed: string; missing: string[]; unreadable: string[]; units: number }): string;
  ```

- [ ] **Step 1: Write the failing tests** in `symbolOrigin.test.ts`:
  - `a source file counts as newer only beyond the tolerance`: `newerSources(10_000, [{ file: 'a/A.TcPOU', mtimeMs: 12_000 }])` is `[]`; with `mtimeMs: 12_001` it is `['A.TcPOU']`.
  - `newer sources come newest first as base names`: `newerSources(0, [{ file: 'x/Old.TcPOU', mtimeMs: 5000 }, { file: 'y\\New.TcGVL', mtimeMs: 9000 }])` is `['New.TcGVL', 'Old.TcPOU']`.
  - `localStamp pads every field`: `localStamp(new Date(2026, 10, 9, 8, 2, 3))` is `'2026-11-09 08:02:03'`.
  - `header without a warning`: `buildHeader({ unit: 'PLC1', builtAt: new Date(2026, 10, 9, 10, 12, 3), newer: [] })` deep-equals `['Symbols from the build output of PLC1 (built 2026-11-09 10:12:03).']`.
  - `header warns with at most three names`: `newer: ['A.TcPOU','B.TcPOU','C.TcPOU','D.TcPOU']` adds `'Warning: 4 source files are newer than the build output (A.TcPOU, B.TcPOU, C.TcPOU and 1 more); the symbols may be outdated. Build the project again.'`; with one name: `'Warning: 1 source file is newer than the build output (A.TcPOU); the symbols may be outdated. Build the project again.'`.
  
  In `adsinterface.test.ts` extend `ADS interface: fixture project ...`: after the `stale === true` assertion add `assert.deepEqual(built2.newerSources, [basename(plc.objects[0].file)])` and `assert.ok(Math.abs(built.builtAt!.getTime() - now.getTime()) < 1500)`; new test `a source file one second newer than the build is not stale (clock skew)`: set the objects to `now + 1000 ms`, tmc at `now`, assert `stale === false` and `newerSources` is `[]`. In `adsToolText.test.ts` change the `symbols listing` base to `headers: []` and add: `symbolsText({ ...base, headers: ['H1', 'H2'] })` is `'H1\nH2\nMAIN.a : INT'`; with no match and a header, the header stays first (`'H1\nNo symbols match "zz".'`).
- [ ] **Step 2: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/symbolOrigin.test.js`. Expected: compile error `Cannot find module '../src/core/symbolOrigin'`.
- [ ] **Step 3: Implement** `symbolOrigin.ts` as specified (base name via `path.basename` after normalizing `\` to `/`); in `fromBuild` use `fs.stat(file)` for `builtMs`, compute `newerSources(builtMs, [plc.file, ...plc.objects.map(o => o.file)] stat'ed, STALE_TOLERANCE_MS)` (a file that cannot be stat'ed is skipped, as today), return `builtAt: new Date(builtMs)`, `newerSources`, `stale: newer.length > 0`. `symbolsText` puts `headers` first. In `adsTools.symbols` push `...buildHeader({ unit: u.plc.name, builtAt: b.builtAt!, newer: b.newerSources ?? [] })` per successfully read unit and pass `headers`.
- [ ] **Step 4: Run** `cd extension && npm test`. Expected: all pass (the existing stale test with 60 s offsets stays green).
- [ ] **Step 5: CHANGELOG and commit.** Add under `## Unreleased` / `### Claude Code and ADS`: "- `ads_symbols` says where its list comes from and when the build output was made, and warns when source files are newer than the build output (more than 2 s). A retest that ran code built before the fix is easy to spot now." Then:
  ```bash
  git add extension/src extension/test extension/CHANGELOG.md
  git commit -s -m "Show the build time and a stale warning in ads_symbols" -m "A retest once ran code built before the fix and was only found out by comparing file times by hand. The warning tolerates 2 s of clock skew so a build that finishes while the sources are still being saved does not cry wolf."
  ```

---

### Task D2: Enum members and hidden variables (extension only)

**Files:**
- Create: `extension/src/core/enumLookup.ts`, `extension/test/symbolFixtures.ts`
- Modify: `extension/src/core/tmc.ts`, `extension/src/core/adsinterface.ts` (`AdsSymbol`, `visible`, `fromSource`, `fromSourceAt`), `extension/src/core/toolInput.ts` (`parseSymbolsInput`), `extension/src/core/adsToolText.ts`, `extension/src/ads/adsTools.ts` (`SymbolsInput`, `symbols`), `extension/package.json` (`iecode_ads_symbols`), `extension/CHANGELOG.md`
- Test: `extension/test/tmc.test.ts`, `adsinterface.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`

**Interfaces:**
- Consumes: `parseTmc(xml): TmcFile` with `types[].kind === 'enum'` and `enumValues` (`tmc.ts:44,126`); `SymbolIndex`, `PlcSymbol` kinds `ENUM` / `ENUM_VALUE` (`lang/parser.ts:10-11,269-281`); D1's `headers`.
- Produces:
  ```ts
  // tmc.ts
  export interface EnumMember { name: string; value: string; comment?: string }
  export interface EnumInfo { name: string; base?: string; members: EnumMember[] }
  export function findEnum(file: TmcFile, typeName: string): EnumInfo | undefined;   // by name or Namespace.name, case-insensitive; kind must be 'enum'
  export function sharedValues(e: EnumInfo): { value: string; names: string[] }[];   // only values with 2+ names, in declaration order
  // adsinterface.ts
  export interface AdsSymbol { /* existing */ hidden?: boolean }
  export function fromSource(objects: { file: string; view: string }[], members?: boolean, hidden?: boolean): AdsInterface; // hidden: also returns declarations marked {attribute 'hide'} with hidden: true (never expanded)
  export function fromSourceAt(plc: PlcProject, ref: string | undefined, members?: boolean, hidden?: boolean): Promise<AdsInterface>;
  export function sourceObjects(plc: PlcProject, ref?: string): Promise<{ file: string; view: string }[]>; // extracted from fromSourceAt, also used by D4
  export function enumFromSource(objects: { file: string; view: string }[], typeName: string): EnumInfo | undefined;
  // enumLookup.ts
  export function pickEnum(tmcXml: string | undefined, sources: { file: string; view: string }[], typeName: string): { info: EnumInfo; origin: 'build' | 'source' } | undefined; // build output first, source when there is no tmc or it has no such enum
  // toolInput.ts
  parseSymbolsInput(raw): Parsed<{ filter: string; enumType?: string; hidden?: boolean }>
  // adsToolText.ts
  export function enumText(o: { info: EnumInfo; from: string }): string;
  export const noEnumText: (name: string) => string;
  export function hiddenText(rows: string[], total: number): string;
  ```
  `SymbolsInput` in `adsTools.ts` becomes `{ filter?: string; enumType?: string; hidden?: boolean }`.

- [ ] **Step 1: Write fixtures** in `extension/test/symbolFixtures.ts` (exports `SRC` and `ENUM_TMC`, reused by D3 and D4). `SRC` is a `{ file, view }[]` of: `E_Mode.TcDUT` = `TYPE E_Mode :\n(\n    Off := 0,\n    Run := 1, // normal operation\n    Start := 1\n) INT;\nEND_TYPE\n`; `E_Step.TcDUT` = `TYPE E_Step :\n(\n    Idle,\n    Fill := 5,\n    Drain,\n    Done := 16#10\n);\nEND_TYPE\n`; `ST_Axis.TcDUT` (STRUCT `nPos : DINT; bOn : BOOL; sName : STRING(20);`); `FB_Drive.TcPOU` = `FUNCTION_BLOCK FB_Drive\nVAR_INPUT\n    bEnable : BOOL;\nEND_VAR\nVAR\n    {attribute 'hide'}\n    bBusy : BOOL;\n    {attribute 'hide'}\n    bPlain : BOOL;\n    nState : INT;\nEND_VAR\n//---- IMPLEMENTATION ----\n//==== PROPERTY Busy ====\n{attribute 'monitoring' := 'call'}\nPROPERTY PUBLIC Busy : BOOL\n//==== PROPERTY Plain ====\nPROPERTY PUBLIC Plain : BOOL\n`; `MAIN.TcPOU` with `fbDrive : FB_Drive; aDrives : ARRAY[1..3] OF FB_Drive; eMode : E_Mode; stAxis : ST_Axis;` (view format as `MAIN` in `adsinterface.test.ts:96-113`). `ENUM_TMC` is a minimal module class with `<DataType><Name>E_Mode</Name><BitSize>16</BitSize><BaseType>INT</BaseType><EnumInfo><Text>Off</Text><Enum>0</Enum></EnumInfo><EnumInfo><Text>Run</Text><Enum>1</Enum><Comment>Normal operation</Comment></EnumInfo><EnumInfo><Text>Start</Text><Enum>1</Enum></EnumInfo></DataType>` and one symbol `MAIN.eMode`.
- [ ] **Step 2: Write the failing tests.**
  - `tmc.test.ts` `findEnum lists members by name or qualified name`: with the existing `Machine.tmc` fixture, `findEnum(tmc, 'E_Mode')!.members.map(m => \`${m.name}=${m.value}\`)` is `['Off=0', 'Run=1']`, `.members[1].comment` is `'Normal operation'`, `.base` is `'INT'`; `findEnum(tmc, 'e_mode')?.name` is `'E_Mode'`; `findEnum(tmc, 'FB_Motor')` and `findEnum(tmc, 'T_Missing')` are `undefined`. `sharedValues({ name: 'E', members: [Off=0, Run=1, Start=1] })` is `[{ value: '1', names: ['Run', 'Start'] }]`.
  - `adsinterface.test.ts` `source: hidden variables are listed only on request and flagged`: `fromSource(SRC, true).symbols` has no `MAIN.fbDrive.bBusy`; with `hidden = true` the names of the symbols with `hidden` are exactly `['MAIN.fbDrive.bBusy', 'MAIN.fbDrive.bPlain']` (the array `MAIN.aDrives` is not expanded), and `MAIN.fbDrive.nState` has no `hidden` flag. `enumFromSource reads explicit and implicit values`: `enumFromSource(SRC, 'E_Mode')!.members.map(m => m.name + '=' + m.value)` is `['Off=0', 'Run=1', 'Start=1']` with `members[1].comment === 'normal operation'`; `E_Step` gives `['Idle=0', 'Fill=5', 'Drain=6', 'Done=16']`; `enumFromSource(SRC, 'ST_Axis')` is `undefined`.
  - `enumLookup` (in `adsinterface.test.ts`): `pickEnum(ENUM_TMC, SRC, 'E_Mode')!.origin` is `'build'`; `pickEnum(undefined, SRC, 'E_Step')!.origin` is `'source'`; `pickEnum(ENUM_TMC, SRC, 'E_Step')!.origin` is `'source'` (not in the build output); `pickEnum(undefined, SRC, 'E_Nope')` is `undefined`.
  - `toolInput.test.ts`: `parseSymbolsInput({ filter: 'x', enumType: 'E_Mode', hidden: true })` is `{ ok: true, value: { filter: 'x', enumType: 'E_Mode', hidden: true } }`; `{ hidden: 'yes' }` fails with `hidden must be true or false`; `{ enumType: 5 }` fails with `enumType must be a string`; `{ enumType: '' }` leaves the key out.
  - `adsToolText.test.ts`: `enumText` for `E_Mode` (base `INT`, members `Off=0`, `Run=1` with comment `Normal operation`, `Start=1`, from `the build output of PLC1`) is exactly `Enum E_Mode (INT), from the build output of PLC1:\n  Off = 0\n  Run = 1  // Normal operation\n  Start = 1\nNote: Run and Start share the value 1; a read shows Run, so compare by number.`; three names sharing give `Note: A, B and C share the value 1; a read shows A, so compare by number.`; without `base` the first line is `Enum E_Mode, from ...:`. `noEnumText('E_X')` is `No enum type "E_X" found in the build output or the source code of the workspace PLC projects.`. `hiddenText(['MAIN.fbDrive.bBusy : BOOL'], 1)` is `Hidden (marked {attribute 'hide'}, so no ADS symbol and not readable; a property with {attribute 'monitoring' := 'call'} may expose the value):\nMAIN.fbDrive.bBusy : BOOL`; with total 3 and one row it ends with `\n(2 more hidden variables not listed)`.
- [ ] **Step 3: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/tmc.test.js out/test/adsinterface.test.js`. Expected: compile errors for the missing exports.
- [ ] **Step 4: Implement.** `findEnum`: match `type.name` or `${type.namespace}.${type.name}` case-insensitively, `kind === 'enum'`, `base` from `type.base`. `visible()` becomes a wrapper of a new `declaration(v, obj): 'visible' | 'hidden' | 'skip'` that returns `hidden` only for a declaration that would otherwise be visible and carries `{attribute 'hide'}` (the two places `visible` tests today, `adsinterface.ts:237-253`); `fromSource` pushes `hidden: true` rows (not expanded) only when its `hidden` argument is true. `enumFromSource`: `SymbolIndex.find(typeName)` with `root.kind === 'ENUM'`; value of a member is the number after `name :=` in its `detail` line (decimal or `16#`-style via `parseInt(digits, base)`), else previous value + 1 (first is 0); comment is the text after `//` on that line. `pickEnum`: `findEnum(parseTmc(xml), name)` first, then `enumFromSource`. In `adsTools.symbols`: if `input.enumType` is set, look through the units (`enumAt`: read the `.tmc` via `findTmc` when it exists, plus `sourceObjects(plc)`) and answer only `enumText({ info, from: 'the build output of <unit>' | 'the source code of <unit>' })` or `noEnumText`; if `input.hidden`, run `fromSourceAt(plc, undefined, true, true)` per unit, take rows with `hidden`, apply the filter, cap at 100 and append `hiddenText(...)` after the normal result. Update `package.json`: `iecode_ads_symbols` loses `"required": ["filter"]`, gains `enumType` (string, maxLength 512, "Name of an enum type, e.g. E_Mode: returns its members with values, so valid values for the write and wait tools are known.") and `hidden` (boolean, "Also list variables marked {attribute 'hide'}: they have no ADS symbol and cannot be read."); append one sentence to `modelDescription` naming both.
- [ ] **Step 5: Run** `cd extension && npm test`. Expected: all pass, manifest parity green.
- [ ] **Step 6: CHANGELOG and commit.** "- `ads_symbols` lists the members of an enum type (`enumType`), so valid values for `ads_write` and `ads_wait` are known, and with `hidden: true` the variables marked `{attribute 'hide'}` that have no ADS symbol. Before, the agent had to open the source for both." Commit `Add enum members and hidden variables to ads_symbols` with the why: "An agent wrote enum values by guessing; the source was the only place the valid names were. An opt-in read of hidden variables is impossible (they have no ADS symbol), so they are listed as hidden instead."

---

### Task D2b: Enum alias names resolve on write (CLI, no protocol change)

**Files:**
- Modify: `cli/src/IECode.Core/Ads/PlcValueText.cs` (`Parse`, `ParseEnum`, lines 38-44 and 77-88), `cli/src/IECode.Automation/AdsValues.cs` (`Members`, `ParseForWrite`, lines 61-66 and 83-89)
- Test: `cli/tests/IECode.Core.Tests/PlcValueTextTests.cs`

**Interfaces:**
- Consumes: `IEnumType.EnumValues` (a name list that can repeat a value); today `Members(IEnumType)` keeps only the first name per value (`TryAdd`), so a write by the second name fails with `'Start' is not a valid INT.`.
- Produces:
  ```csharp
  // PlcValueText
  public static object Parse(string iecType, string text, IReadOnlyDictionary<long, string>? enumMembers = null,
      IReadOnlyList<(string Name, long Value)>? enumAll = null);   // enumAll lists every name, including aliases; used by ParseEnum when given
  // AdsValues
  public static IReadOnlyList<(string Name, long Value)>? AllMembers(IDataType? type);   // null for a non-enum
  ```
  Reads still show the first name (`Format` is untouched).

- [ ] **Step 1: Write the failing tests** in `PlcValueTextTests.cs` with `byValue = { [0] = "Off", [1] = "Run" }` and `all = [("Off", 0), ("Run", 1), ("Start", 1)]`:
  - `Enum_alias_names_parse_to_their_value`: `Parse("INT", "Start", byValue, all)` equals `1L`; `"start"` (case-insensitive, one distinct value) equals `1L`; `"1"` equals `1L`; `"Run"` equals `1L`.
  - `Enum_names_that_differ_only_by_case_with_different_values_stay_ambiguous`: `all = [("Run", 1), ("RUN", 2)]`, `Parse(..., "run", ...)` throws `IECodeException` with a message containing `matches several enum members: Run, RUN`.
  - `Without_the_full_list_an_alias_is_still_unknown`: `Parse("INT", "Start", byValue)` throws `IECodeException` with message `'Start' is not a valid INT.` (old behaviour, callers that do not pass the list).
- [ ] **Step 2: Run (PowerShell tool)**: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~PlcValueTextTests"`. Expected: compile error (no 4-argument `Parse`).
- [ ] **Step 3: Implement.** `ParseEnum(text, members, all)`: candidates are `all` when given, else `members` pairs; exact (ordinal) match first; then case-insensitive matches grouped by value: one distinct value is a match, more than one throws the existing "several" message listing the names; no match falls to `long.Parse`. `AdsValues.AllMembers` returns `en.EnumValues.Select(m => (m.Name, Convert.ToInt64(m.Value)))` for an `IEnumType` found through `Underlying`; `ParseForWrite` passes it as `enumAll`.
- [ ] **Step 4: Run** the same filter, then `dotnet test cli/tests/IECode.Core.Tests` and `dotnet test cli/tests/IECode.Automation.Tests` (separately, one after the other). Expected: all pass. The Beckhoff-side `AllMembers` is covered by the manual check in D8 (no SDK type to fake).
- [ ] **Step 5: Commit** `Accept every name of an enum value on write` with the why: "Two enum members with one value are legal in IEC 61131-3; the symbol loader kept only the first name per value, so a write by the second name failed. The list of members that ads_symbols now prints would otherwise offer names that cannot be written." No CHANGELOG line in the extension (CLI behaviour); note it in the PR text.

---

### Task D3: Filter by type and prefix, paging, members of an instance (extension only)

**Files:**
- Create: `extension/src/core/symbolQuery.ts`, `extension/test/symbolQuery.test.ts`
- Modify: `extension/src/core/adsinterface.ts` (export `norm` as `normalizeType`), `extension/src/core/toolInput.ts`, `extension/src/core/adsToolText.ts` (`symbolsText`), `extension/src/ads/adsTools.ts` (`symbols`), `extension/package.json`, `extension/test/toolInput.test.ts`, `extension/test/adsToolText.test.ts`, `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: `AdsSymbol` (name, type); `normalizeType` (the existing `norm` at `adsinterface.ts:375`: strips namespaces and blanks, upper-cases, `STRING` = `STRING(80)`).
- Produces:
  ```ts
  // symbolQuery.ts
  export interface SymbolQuery { filter: string; prefix: string; type: string; offset: number }
  export const PAGE_SIZE = 100;
  export function matchesQuery(s: { name: string; type: string }, q: SymbolQuery): boolean;
  export function queryText(q: SymbolQuery): string;   // filter alone: the filter itself; else 'prefix X', 'type Y', joined with ' and '
  export function pageNote(o: { total: number; offset: number; pageSize: number }): string | undefined;
  // toolInput.ts
  parseSymbolsInput(raw): Parsed<{ filter: string; enumType?: string; hidden?: boolean; prefix?: string; type?: string; offset?: number }>
  // adsToolText.ts: symbolsText gains offset
  symbolsText(o: { headers: string[]; matches: string[]; total: number; max: number; offset: number; typed: string; missing: string[]; unreadable: string[]; units: number }): string
  ```
  `matchesQuery`: `filter` is a case-insensitive contains; `prefix` is a case-insensitive starts-with, and when it ends with `.` only direct members match (the rest after the prefix has no `.`), so `MAIN.fbMotor.` lists the instance's members, not the whole subtree; `type` matches the whole type text or the element type of an `ARRAY [..] OF T` after `normalizeType` (so `Tc2_Standard.TON` finds `TON`, `string` finds `STRING(80)`, `INT` finds `ARRAY [0..9] OF INT` but not `DINT`).

- [ ] **Step 1: Write the failing tests** in `symbolQuery.test.ts` (helper `q = (p) => ({ filter: '', prefix: '', type: '', offset: 0, ...p })`):
  - `filter is a case-insensitive contains`: `matchesQuery({ name: 'MAIN.fbMotor.bEnable', type: 'BOOL' }, q({ filter: 'enable' }))` is true.
  - `a prefix ending in a dot lists direct members only`: with `prefix: 'main.fbmotor.'` `MAIN.fbMotor.bEnable` is true, `MAIN.fbMotor.stStatus.fSpeed` false, `MAIN.fbMotor` false; with `prefix: 'MAIN.fbMotor'` all three are true.
  - `type matches whole types and array element types`: the four examples above, plus `INT` vs `DINT` false.
  - `queryText`: filter `zz` gives `zz`; prefix `MAIN.` and type `BOOL` give `prefix MAIN. and type BOOL`; all empty gives ``.
  - `pageNote`: `{ total: 50, offset: 0, pageSize: 100 }` is `undefined`; `{ 357, 0, 100 }` is `(257 more not listed; narrow the filter or continue with offset 100)`; `{ 357, 100, 100 }` is `(rows 101-200 of 357; 157 more, continue with offset 200)`; `{ 357, 300, 100 }` is `(rows 301-357 of 357; end of list)`; `{ 357, 400, 100 }` is `No rows at offset 400: 357 symbols match.`.
  
  In `toolInput.test.ts`: `parseSymbolsInput({ prefix: 'MAIN.', type: 'BOOL', offset: 100 })` is `{ ok: true, value: { filter: '', prefix: 'MAIN.', type: 'BOOL', offset: 100 } }`; `{ offset: -1 }` and `{ offset: 1.5 }` fail with `offset must be a whole number of 0 or more`. In `adsToolText.test.ts` update the paging assertion: `symbolsText({ ...base, total: 103, offset: 0 })` ends with `(3 more not listed; narrow the filter or continue with offset 100)`; `{ matches: [], total: 357, offset: 400 }` returns `No rows at offset 400: 357 symbols match.` and not "No symbols match".
- [ ] **Step 2: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/symbolQuery.test.js`. Expected: `Cannot find module '../src/core/symbolQuery'`.
- [ ] **Step 3: Implement** the module and the text. `adsTools.symbols` collects every matching row first (`all`), then `total = all.length`, `matches = all.slice(offset, offset + PAGE_SIZE)`, `typed = queryText(q)`. Manifest: `prefix` (string, maxLength 512, "Start of the ADS name; a trailing dot, e.g. MAIN.fbMotor., lists only the direct members of that instance with their types."), `type` (string, maxLength 512, "Only symbols of this type, e.g. BOOL or FB_Drive; arrays match their element type."), `offset` (integer, minimum 0, "Skip this many matches; pages are 100 rows."); `modelDescription` says "at most 100 per call, continue with offset".
- [ ] **Step 4: Run** `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: CHANGELOG and commit.** "- `ads_symbols` filters by type and by name prefix, pages through long results with `offset`, and a prefix ending in a dot (`MAIN.fbMotor.`) lists the members of that instance with their types." Commit `Filter ads_symbols by type and prefix and page long results` with the why: "A filter that only matches substrings returned whole subtrees and cut at 100 with no way to see the rest. The trailing-dot prefix keeps an instance listing to one level so a large function block does not flood the answer."

---

### Task D4: Matching property in the "symbol not found" text (extension only)

**Files:**
- Modify: `extension/src/core/adsinterface.ts`, `extension/src/core/adsToolText.ts` (`propertyHintText`, `readOnceRow`, `watchResultText`), `extension/src/ads/adsTools.ts` (`read`, `watch`), `extension/test/adsinterface.test.ts`, `extension/test/adsToolText.test.ts`, `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: `SymbolIndex.find`, `membersOf`, `baseTypeName` (`lang/index.ts:15,75`); `sourceObjects(plc)` (D2); `SRC` fixture (D2: `FB_Drive` has the hidden `bBusy` and `bPlain`, the monitoring-call property `Busy` and the plain property `Plain`; `MAIN.aDrives` is an array of `FB_Drive`).
- Produces:
  ```ts
  // adsinterface.ts
  export function matchingProperties(objects: { file: string; view: string }[], symbol: string): string[];  // full names, at most 3
  export function matchingPropertiesAt(plc: PlcProject, symbol: string): Promise<string[]>;
  // adsToolText.ts
  export function propertyHintText(props: string[]): string;
  export interface ReadRow { /* existing */ hint?: string }           // readOnceRow appends the hint after the error
  watchResultText(o: { /* existing */ hints?: string[] }): string     // each hint becomes its own line
  ```
  Algorithm of `matchingProperties`: split the symbol at `.`; the first segment is a GVL or PROGRAM; each middle segment (with `[...]` stripped) is looked up in `membersOf(currentType)` and its declared type, through `baseTypeName` (which already strips `ARRAY [..] OF`), becomes the current type; the last segment is compared with the `PROPERTY` members of the final type that carry `{attribute 'monitoring' := 'call'}`; both sides are reduced to a core name: drop a leading `P_`/`p_` and a leading run of 1-3 lower-case letters followed by an upper-case letter (`bBusy` and `Busy` both give `busy`), compared case-insensitively. Anything unresolvable gives `[]`.

- [ ] **Step 1: Write the failing tests.**
  - `adsinterface.test.ts` `matchingProperties finds the monitoring-call property of a hidden variable`: `matchingProperties(SRC, 'MAIN.fbDrive.bBusy')` is `['MAIN.fbDrive.Busy']`; `'MAIN.aDrives[2].bBusy'` is `['MAIN.aDrives[2].Busy']`; `'MAIN.fbDrive.nState'` is `[]` (no property of that name); `'MAIN.fbDrive.bPlain'` is `[]` (the property `Plain` has no monitoring attribute); `'NOPE.x.bBusy'` and `'MAIN.bBusy'` are `[]`.
  - `adsToolText.test.ts`: `propertyHintText(['MAIN.fbDrive.Busy'])` is `Matching property in the source code: MAIN.fbDrive.Busy (monitoring call); try that name.`; with two names `Matching properties in the source code: A, B (monitoring call); try one of those names.`; `readOnceRow({ symbol: 'MAIN.fbDrive.bBusy', type: '', value: null, error: "Symbol 'MAIN.fbDrive.bBusy' not found on local.", hint: propertyHintText([...]) })` is `MAIN.fbDrive.bBusy : error Symbol 'MAIN.fbDrive.bBusy' not found on local. Matching property in the source code: MAIN.fbDrive.Busy (monitoring call); try that name.`; without `hint` the row is unchanged; `watchResultText({ ..., hints: ['Hint for MAIN.x.bBusy: Matching property in the source code: MAIN.x.Busy (monitoring call); try that name.'] })` ends with that line.
- [ ] **Step 2: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/adsinterface.test.js`. Expected: `matchingProperties is not exported`.
- [ ] **Step 3: Implement.** Pull the monitoring-call test out of `visible()` (`/\{\s*attribute\s+'monitoring'\s*:=\s*'call'/i` on the lines of the property declaration) into a helper next to it. In `adsTools`: after `host.read(others)`, for every row whose `error` matches `/not found/i` ask `matchingPropertiesAt` of each unit until one returns names and set `hint`; in `watch`, do the same for the `add` entries whose item error matches `/not found/i` and pass `hints` as `Hint for <symbol>: <propertyHintText>`. A throwing source read is swallowed (the hint is a courtesy; the original error text stays).
- [ ] **Step 4: Run** `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: CHANGELOG and commit.** "- When `ads_read` or `ads_watch` cannot find a symbol, the result names a matching property of the function block from the source (`MAIN.fbDrive.bBusy` hidden, property `Busy` with `{attribute 'monitoring' := 'call'}`), so the agent does not guess other paths." Commit `Name the matching property when a symbol is not found` with the why: "The hidden-variable hint says that a property may exist but not which one. The source already knows the function block, so the answer is one lookup. The hint appends to the CLI error instead of replacing it, because the CLI text also says why the symbol is missing."

---

### Task D5: `iecode ads symbols --online` (CLI)

**Files:**
- Create: `cli/src/IECode.Core/Ads/OnlineSymbols.cs`, `cli/src/IECode.Automation/OnlineSymbolList.cs`, `cli/tests/IECode.Core.Tests/OnlineSymbolsTests.cs`, `cli/tests/IECode.Automation.Tests/OnlineSymbolListTests.cs`
- Modify: `cli/src/IECode.Automation/AdsLink.cs` (`ISymbolSet.Enumerate`, `BeckhoffLink.Set`), `cli/tests/IECode.Automation.Tests/FakeLink.cs` (`FakeSet.Enumerate`), `cli/src/IECode.Cli/Commands/TargetCommands.cs` (`Symbols()`, lines 240-275), `cli/src/IECode.Core/Ads/WatchHost.cs` (`Protocol`, only if still unbumped), `cli/README.md` (command table line 43, "Live values" feature list)

**Interfaces:**
- Consumes: `IAdsLink.UploadSymbols()`, `ISymbolSet.Count`, `SymbolTable.MeansUnreachable(requested, count)`, `AdsCodes`; `TargetOption()` and `PortOption()` of `TargetCommands`; C0's protocol table entry (feature `onlineSymbols`).
- Produces:
  ```csharp
  // Core
  public sealed record OnlineSymbol(string Name, string Type, string? Comment);
  public static class OnlineSymbols {
      public const int MaxMatches = 500;
      public static (IReadOnlyList<OnlineSymbol> Matches, int Total) Select(IEnumerable<OnlineSymbol> all, string filter, int max = MaxMatches); // case-insensitive contains on Name, sorted by Name (ordinal, ignore case), total counted before the cap
      public static string RequireFilter(string? filter);   // returns the trimmed filter; blank throws IECodeException(ExitCodes.Usage, "--online needs --filter: the symbol table of a running PLC is too large to list.")
  }
  // Automation
  internal interface ISymbolSet { /* existing */ IEnumerable<OnlineSymbol> Enumerate(); }   // every instance path down to depth 8; arrays, pointers and references are listed but not entered
  public static class OnlineSymbolList {
      public static (IReadOnlyList<OnlineSymbol> Matches, int Total) List(Core.AmsNetId target, int port, string filter);
      internal static (IReadOnlyList<OnlineSymbol> Matches, int Total) List(Func<IAdsLink> newLink, string where, string filter);
  }
  ```
  CLI surface: `iecode ads symbols --online --target <netid> [--port 851] --filter <text> --json`. JSON `data`: `{ "target": "<netid>", "port": 851, "total": 612, "symbols": [ { "name": "...", "type": "...", "comment": null } ] }` (at most 500 symbols). Human output: first line `Running PLC <netid>:<port>  (<shown> of <total> symbol(s))`, then the existing row format. `--online` ignores the path argument and needs Windows (`IECodeException(ExitCodes.Usage, "--online needs Windows (the ADS client).")` elsewhere).

- [ ] **Step 1: Write the failing tests.**
  - `OnlineSymbolsTests` (Core): `Select_filters_case_insensitively_and_sorts_by_name` (input `MAIN.b`, `main.a`, `GVL.x`, filter `main.` gives names `["main.a", "MAIN.b"]`, `Total == 2`); `Select_caps_at_the_maximum_but_counts_everything` (600 names `MAIN.n000`..`MAIN.n599`, default max: 500 matches, `Total == 600`, first `MAIN.n000`); `RequireFilter_refuses_a_blank_filter` (`"  "` and `null` throw `IECodeException` with `ExitCode == ExitCodes.Usage` and the message above); `RequireFilter_trims` (`" MAIN. "` returns `"MAIN."`).
  - `OnlineSymbolListTests` (Automation, `FakeLink`/`FakeSet`): `List_returns_the_matches_of_the_uploaded_table` (table of 3 symbols, one match); `List_reports_an_empty_table_as_unreachable` (`new FakeSet()` throws `IECodeException` with `ExitCode == ExitCodes.TargetFailed`, message starting `Cannot reach test:851 over ADS`); `List_reports_a_target_that_does_not_answer` (`link.State = AdsErrorCode.TargetPortNotFound` gives the same exit code).
- [ ] **Step 2: Run (PowerShell tool)**: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~OnlineSymbolsTests"`. Expected: compile error, `OnlineSymbols` does not exist.
- [ ] **Step 3: Implement.** `Select` collects every match, sorts, takes `max`. `OnlineSymbolList.List`: `link.Connect()`, `ReadState()` code other than `NoError` is `TargetFailed`; `UploadSymbols()`; `SymbolTable.MeansUnreachable(1, set.Count)` is `TargetFailed`; then `Select(set.Enumerate(), filter)`. `BeckhoffLink.Set.Enumerate` walks `symbols` and each `ISymbol.SubSymbols` lazily to depth 8, yielding `new OnlineSymbol(s.InstancePath, s.DataType?.Name ?? "?", s.Comment)` and descending only for struct-like data types (use the `DataTypeCategory` members of the pinned SDK for struct, class and union; not Array, Pointer, Reference). In `Symbols()` add `--online`, `--target`, `--port`; the action branches into a `[SupportedOSPlatform("windows")]` helper before `LoadInterfaces`. Add `onlineSymbols` to the open protocol entry (see Global Constraints) and document the flag in `cli/README.md` (one line in the command table, one in "Live values" under the compatibility list).
- [ ] **Step 4: Run** `dotnet test cli/tests/IECode.Core.Tests`, then, as a separate command, `dotnet test cli/tests/IECode.Automation.Tests`. Expected: all pass.
- [ ] **Step 5: Commit** `Add ads symbols --online for targets without a build output` with the why: "A module without a .tmc gave 'No PLC projects' and the agent had no symbol list at all. A separate short-lived process keeps the full symbol upload away from the watch host, which would stall samples, waits and confirmed writes behind it (roadmap D22)."

---

### Task D5b: Online source and the fallback chain in `ads_symbols` (extension; needs C0 and D5)

**Files:**
- Create: `extension/src/core/symbolSource.ts`, `extension/src/core/onlineSymbols.ts`, `extension/src/ads/onlineSymbols.ts`, `extension/test/symbolSource.test.ts`, `extension/test/onlineSymbols.test.ts`
- Modify: `extension/src/core/symbolOrigin.ts` (two more headers), `extension/src/core/toolInput.ts`, `extension/src/ads/host.ts` (`endpoint()`), `extension/src/ads/adsTools.ts` (`symbols`), `extension/src/core/mcpTools.ts` (`AdsToolFns.symbols` input type), `extension/package.json`, `extension/test/toolInput.test.ts`, `extension/test/symbolOrigin.test.ts`, `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: C0's `AdsHost.supports('onlineSymbols')` (after `await host.ready()`); D5's CLI JSON; `fromBuild`, `fromSourceAt` (D1-D2); `matchesQuery`, `queryText`, `pageNote` (D3); `customCliPath()`, `useInstallDir()` from `extension/src/cli/iecode.ts`.
- Produces:
  ```ts
  // symbolSource.ts
  export type SourceChoice = 'auto' | 'online' | 'build' | 'source';
  export interface UnitState { name: string; hasBuild: boolean; isLibrary: boolean }
  export interface SourcePlan { online: boolean; perUnit: { unit: string; source: 'build' | 'source' | 'skip' }[]; error?: string; notes: string[] }
  export function planSources(o: { choice: SourceChoice; units: UnitState[]; onlineSupported: boolean; hasFilter: boolean }): SourcePlan;
  // onlineSymbols.ts (core)
  export interface OnlineResult { target: string; total: number; symbols: { name: string; type: string; comment?: string | null }[] }
  export function onlineArgs(target: string, port: number, filter: string): string[]; // ['ads','symbols','--online','--target',t,'--port',String(p),'--filter',f,'--json']
  export function parseOnlineOutput(stdout: string): Parsed<OnlineResult>;          // last non-empty line is the CLI result document
  export const onlineFailureText: (reason: string) => string;
  // symbolOrigin.ts
  export const onlineHeader: (target: string) => string;      // 'Symbols from the running PLC (<target>).'
  export const sourceHeader: (unit: string) => string;        // 'Symbols from the source code of <unit> (may differ from the PLC).'
  // ads/onlineSymbols.ts (wiring)
  export function listOnline(target: string, port: number, filter: string, signal?: AbortSignal): Promise<Parsed<OnlineResult>>; // execFile, 60 s timeout, kills the child on abort
  // host.ts
  endpoint(): { target: string; port: number }
  // toolInput.ts
  parseSymbolsInput(raw): Parsed<{ ...; source?: SourceChoice }>   // error: 'source must be one of auto, online, build, source'
  ```
  Rules of `planSources`: `build`: units with a build use it, units without one are `skip` (non-library ones are reported as "not built" as today); `source`: every unit `source`; `online`: `online: true` and no per-unit entries, `error` `source "online" needs a filter or prefix: a running PLC has too many symbols to list.` without a filter and `source "online" needs a newer iecode CLI: onlineSymbols.` when unsupported; `auto`: units with a build use it; units without one (non-library) use online when `onlineSupported && hasFilter`, else `source`, with a note `The online symbol list needs a filter or prefix; showing the source code instead.` or `The online symbol list needs a newer iecode CLI: onlineSymbols; showing the source code instead.`; library units without a build are `skip` silently.

- [ ] **Step 1: Write the failing tests.**
  - `symbolSource.test.ts` (units `A` built, `B` not built, `L` library not built): `auto` with support and filter gives `online: true` (it covers `B`, so `B` has no per-unit entry) and `perUnit` `[{ unit: 'A', source: 'build' }, { unit: 'L', source: 'skip' }]`; `auto` without filter gives `online: false`, `B` is `source`, `notes` is `['The online symbol list needs a filter or prefix; showing the source code instead.']`; `auto` unsupported gives the `needs a newer iecode CLI: onlineSymbols` note; `auto` with every unit built gives `online: false` and no notes; `build` marks `B` as `skip`; `source` marks all `source`; `online` without filter has the `error` above.
  - `onlineSymbols.test.ts`: `onlineArgs('local', 851, 'MAIN.')` deep-equals `['ads', 'symbols', '--online', '--target', 'local', '--port', '851', '--filter', 'MAIN.', '--json']`; `parseOnlineOutput` of two lines of progress text followed by `{"ok":true,"data":{"target":"local","port":851,"total":2,"symbols":[{"name":"MAIN.a","type":"INT","comment":null}]}}` is `{ ok: true, value: { target: 'local', total: 2, symbols: [...] } }`; `{"ok":false,"error":"Cannot reach 5.1.2.3.1.1 over ADS: timeout"}` is `{ ok: false, error: 'Cannot reach 5.1.2.3.1.1 over ADS: timeout' }`; empty or non-JSON stdout is `{ ok: false, error: 'The iecode CLI returned no result for the online symbol list.' }`; `onlineFailureText('timeout')` is `Online symbol list failed: timeout. Showing the source code instead.`.
  - `symbolOrigin.test.ts`: `onlineHeader('local')` is `Symbols from the running PLC (local).`; `sourceHeader('PLC1')` is `Symbols from the source code of PLC1 (may differ from the PLC).`.
  - `toolInput.test.ts`: `parseSymbolsInput({ source: 'online' })` keeps `source: 'online'`; `{ source: 'x' }` fails with the message above.
- [ ] **Step 2: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/symbolSource.test.js`. Expected: `Cannot find module '../src/core/symbolSource'`.
- [ ] **Step 3: Implement.** In `adsTools.symbols`: `await host.ready()` only when the choice can use online (`auto` with a not-built non-library unit, or `online`) so a plain build-output call never starts the host; build `UnitState` from `NoBuildOutputError` probing (`findTmc(u.plc.file)`), call `planSources`, return `{ text: 'Error: ' + plan.error, isError: true }` when set; read the planned units with `fromBuild` / `fromSourceAt(plc, undefined, true)`; if `plan.online`, call `listOnline(endpoint.target, endpoint.port, longestOf(filter, prefix))` and on failure append `onlineFailureText(reason)` and read the not-built units from the source. Online rows are filtered with `matchesQuery` (type and prefix are applied client side on the at most 500 rows; paging with `offset` works inside those rows) and `total` grows by `cli.total - cli.symbols.length` so the paging note still appears. Header lines: `buildHeader` per build unit, `sourceHeader` per source unit, `onlineHeader(host.target())` once, then the `notes`. `package.json`: `source` (string enum `auto`, `online`, `build`, `source`, default `auto`; "Where the list comes from: auto uses the build output and falls back to the running PLC (filter or prefix needed) and then to the source code."). `endpoint()` returns the same target and port `start()` uses (`settings()`).
- [ ] **Step 4: Run** `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: CHANGELOG and commit.** "- `ads_symbols` lists the symbols of a project without a build output from the running PLC (needs a filter or prefix, at most 500 matches) or from the source code, and says which. New input `source` picks the source explicitly. The online list needs the iecode CLI of this release; with an older CLI the result says so and shows the source code." Commit `Fall back to the online symbol list and the source in ads_symbols` with the why: "A project that was never built had no symbols at all. The chain build output, running PLC, source code keeps the cheap offline answer first and names the source every time, because source code can differ from what runs."

---

### Task D6: Spike: which build runs on the target (go / no-go)

**Time-box:** about 2 h, needs a simulation target with a PLC project that can be built and downloaded, and D5 for step 7. Throwaway work, nothing is committed except the findings.

**Where findings are recorded:** under the heading `## D6 findings` at the end of this file, one dated entry per run, plus a one-line status in the wishlist row "Report the PLC project build that is loaded on the target next to the workspace `.tmc` time" (`docs/ads-mcp-wishlist.md`). The decision (outcome A, B or C below) is written first, then the data.

**Checklist** (read each value with `iecode ads read <path>`, or the `ads_read` tool on leaf paths; the struct itself cannot be read before D7):
1. Read `TwinCAT_SystemInfoVarList._AppInfo.AppTimestamp`, `.OnlineChangeCnt`, `.ProjectName`, `.AppName`, `.ObjId` (the symbol exists in a built project, its type `PlcAppSystemInfo` appears in every `.tmc`). Record type, value, whether the timestamp is UTC or local.
2. Build the project without downloading: do the values change? (expected: no.)
3. Download (login) a full build: which of `AppTimestamp`, `OnlineChangeCnt`, the symbol version byte (`0xF008`, read with the CLI's `SymbolVersion` or `ads` debug) change?
4. Change only a statement in a POU (no declaration), build, online change: which values change? This is the case that matters (a retest on code built before a logic fix; the symbol interface is identical, so a pure interface compare cannot see it).
5. Restart the PLC without a download: do the values stay?
6. Compare `AppTimestamp` with the mtime of the `.tmc` and, if present, of the project's `.compileinfo`: constant offset, rounding, time zone? Also: does a build without source changes rewrite the `.tmc` (mtime moves)?
7. With D5: `iecode ads symbols --online --filter MAIN. --target <sim>` against `.tmc` symbols through `diffSymbols`: identical after a body-only change? (proves what an interface compare can and cannot see).
8. Two PLC projects on one target: does `ProjectName` / `AppName` select the right one? Remote target: clock offset between engineering PC and runtime.
9. Is `TwinCAT_SystemInfoVarList` readable over ADS port 851 on a target with `{attribute 'hide'}`-free default settings (access rights, "symbol not found")?

**Outcomes and what D6b becomes:**
- **A, a timestamp or counter identifies the loaded build and moves on a body-only change** (most likely `AppTimestamp`): D6b compares it with the workspace `.tmc` time using a tolerance measured in step 6. Extension only, no new CLI code (leaf reads go through `host.read`), so no C0 dependency.
- **B, only the interface can be compared** (no value moves on an online change, or it cannot be matched to the `.tmc`): D6b compares the online interface of D5 with the `.tmc` through `diffSymbols` and says `Target interface matches the build output` or `differs: N added, M removed, K changed`; it states honestly that a body-only change is not detected. Needs D5 and D5b.
- **C, neither works reliably** (values missing, wrong over remote clocks, or access denied): D6b is dropped; the wishlist row becomes `Out of scope` with the reason, and D8 does not mention it. The rest of the plan is unaffected.

- [ ] **Step 1: Run the checklist** and write the findings table (value, how it moved on steps 2-5, offset in step 6).
- [ ] **Step 2: Write `## D6 findings`** with the outcome letter and the tolerance in ms (outcome A).
- [ ] **Step 3: Commit** the findings: `Record the D6 findings on identifying the loaded build` with the why: "D6b depends on which target value identifies the loaded build; the plan keeps the data so the decision can be re-read."

---

### Task D6b: Loaded build against workspace build (shape depends on D6; outcome A shown)

**Files:**
- Modify: `extension/src/core/symbolOrigin.ts`, `extension/src/ads/adsTools.ts` (`symbols`), `extension/CHANGELOG.md`, `docs/ads-mcp-wishlist.md`
- Test: `extension/test/symbolOrigin.test.ts`

**Interfaces (outcome A):**
- Consumes: `AdsInterface.builtAt` (D1); `host.read(['TwinCAT_SystemInfoVarList._AppInfo.AppTimestamp'])` (path and type as D6 confirmed); `localStamp`.
- Produces:
  ```ts
  export interface LoadedBuild { stampMs: number }     // parsed from the value text of the leaf the spike found
  export function parseLoadedBuild(valueText: string | null): LoadedBuild | undefined;   // 'YYYY-MM-DDTHH:mm:ss' (PlcValueText DT format) as UTC; null or unparsable gives undefined
  export function compareBuilds(loaded: LoadedBuild | undefined, workspaceBuiltAt: Date, toleranceMs: number): string | undefined;
  ```
  `compareBuilds` returns `undefined` when `loaded` is undefined (target unreachable or no value: say nothing, the symbol list does not depend on it), else one of: `Target runs the same build as the workspace build output.` (difference within `toleranceMs`), `Target runs another build than the workspace output: loaded <stamp>, workspace build output <stamp> (not downloaded yet?).` (loaded older), `Target runs another build than the workspace output: loaded <stamp>, workspace build output <stamp> (the build output is older than the loaded build).` (loaded newer). Stamps use `localStamp`. The tolerance is the constant measured in D6 step 6 (`LOADED_BUILD_TOLERANCE_MS`).

- [ ] **Step 1: Write the failing tests** in `symbolOrigin.test.ts`: `parseLoadedBuild('2026-11-09T09:00:00')` has `stampMs === Date.UTC(2026, 10, 9, 9, 0, 0)`; `parseLoadedBuild(null)` and `parseLoadedBuild('garbage')` are `undefined`; `compareBuilds` with a loaded stamp equal to the built time plus 1 s and tolerance 2000 is `Target runs the same build as the workspace build output.`; with the loaded stamp one hour older it is `Target runs another build than the workspace output: loaded 2026-11-09 09:00:00, workspace build output 2026-11-09 10:12:03 (not downloaded yet?).` (build the dates with the same time zone arithmetic the test machine uses: construct the `Date` from `loaded.stampMs`); one hour newer gives the `(the build output is older than the loaded build)` text; `compareBuilds(undefined, ...)` is `undefined`.
- [ ] **Step 2: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/symbolOrigin.test.js`. Expected: `parseLoadedBuild is not exported`.
- [ ] **Step 3: Implement** the two functions. In `adsTools.symbols`, when a unit used the build output and the host is already running or the call chose `source: 'build'`, read the leaf once (`host.read` of the one path, errors ignored) and add the `compareBuilds` line after the build header. Never start the host only for this line when the user has no target configured: skip when `host.ready()` throws.
- [ ] **Step 4: Run** `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: Commit and CHANGELOG.** "- `ads_symbols` says whether the target runs the same build as the workspace build output, so a stale download shows up in one call." Commit `Compare the loaded build with the workspace build output` with the why: "A retest once ran code that was built before the fix and was only found out by comparing file times by hand; the spike found a target value that moves on every download, so the check is one extra read."
  - **If outcome B:** the tests become `compareInterfaces(online: AdsSymbol[], build: AdsSymbol[]): string` over `diffSymbols`, texts `Target interface matches the build output (a change inside a code body is not detected).` and `Target interface differs from the build output: 2 added, 1 removed, 3 changed.`; the Plan D5b online list is the data source, filter `''` is not allowed, so the compare uses the first 500 symbols of a prefix the user passed (`prefix`) and is skipped otherwise.
  - **If outcome C:** do not build this task; set the wishlist row to `Out of scope` with the spike's reason.

---

### Task D7: Struct and array read (CLI; needs C0)

**Files:**
- Create: `cli/src/IECode.Core/Ads/StructExpand.cs`, `cli/tests/IECode.Core.Tests/StructExpandTests.cs`
- Modify: `cli/src/IECode.Core/Ads/WatchProtocol.cs` (records, `IWatchBackend.ReadMembers`), `cli/src/IECode.Core/Ads/WatchHost.cs` (`DoRead`, lines 49-50 and 302-320), `cli/src/IECode.Automation/AdsLink.cs` (`ILinkSymbol`), `cli/src/IECode.Automation/AdsWatchBackend.cs` (`ReadMembers`), `cli/tests/IECode.Automation.Tests/FakeLink.cs` (`FakeSymbol`, `Sums` counter), `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/README.md` (the `read` request line 106 and the reply description)

**Interfaces:**
- Consumes: `ISymbolRead` sum read (`PrepareRead(IReadOnlyList<ILinkSymbol>)`), `AdsValues.IsSingleValue`, `PlcValueText.Format`, `AdsCodes.HiddenHint`; C0's protocol entry (feature `structRead`).
- Produces:
  ```csharp
  // Core
  public enum NodeKind { Leaf, Struct, Array, Opaque }          // Opaque: pointer, reference, interface, unknown
  public sealed record StructWalk<T>(IReadOnlyList<T> Leaves, int OmittedMembers, int OmittedElements, IReadOnlyList<string> NotExpanded);
  public static class StructExpand {
      public const int DefaultDepth = 3, MaxDepth = 5, MaxMembers = 200, MaxElements = 20, MaxNotExpanded = 20;
      public static StructWalk<T> Walk<T>(T root, int depth, int maxMembers, int maxElements,
          Func<T, NodeKind> kind, Func<T, IReadOnlyList<T>> children, Func<T, string> path);
  }
  public sealed record MemberValue(string Name, string Type, string? Value, string? Error);   // Name: the full instance path
  public sealed record StructRead(string Type, IReadOnlyList<MemberValue> Members, int OmittedMembers, int OmittedElements, IReadOnlyList<string> NotExpanded);
  // IWatchBackend (default interface method, so existing fakes and UnavailableBackend need no change)
  StructRead? ReadMembers(string symbol, int depth) => null;   // null: not available or a single value, the host falls back to ReadOnce
  // Automation
  internal interface ILinkSymbol { /* existing */ string Path { get; } NodeKind Kind { get; } IReadOnlyList<ILinkSymbol> Children { get; } }
  ```
  `Walk` rules: the root's children are level 1; a `Struct` or `Array` child at level L is entered when `L < depth`, else its path goes to `NotExpanded` as `<path> (depth limit)`; an `Opaque` node goes to `NotExpanded` as `<path> (pointer or reference)`; an array enters its first `maxElements` children and adds the rest to `OmittedElements`; once `maxMembers` leaves are collected further leaves only count in `OmittedMembers`; a `Leaf` root is its own single leaf; `NotExpanded` keeps at most `MaxNotExpanded` entries.
  Wire format (additive, only for a request with `depth`): request `{"op":"read","symbols":[...],"depth":3}`; per symbol reply item `{symbol, type, value, error}` plus, for a struct or array, `"members":[{"name","type","value","error"}]` and `"notes":{"omittedMembers":0,"omittedElements":0,"notExpanded":[]}` with `value` and `error` null on the item itself. `depth` is clamped to 1..5; a non-integer `depth` fails the request with `read needs an integer 'depth'.`. A single-value symbol answers as today.

- [ ] **Step 1: Write the failing tests.**
  - `StructExpandTests` (tree helper `record N(string Path, NodeKind Kind, params N[] Kids)`): `Leaves_come_depth_first_in_declaration_order`; `Depth_limit_marks_deeper_structs_as_not_expanded` (depth 1, root with leaf `a` and struct `s` holding `b`: leaves `[a]`, `NotExpanded == ["s (depth limit)"]`); `Arrays_show_the_first_elements_and_count_the_rest` (25 leaf elements, max 20: 20 leaves, `OmittedElements == 5`); `The_member_cap_counts_what_it_leaves_out` (5000 leaf children, max 200: 200 leaves, `OmittedMembers == 4800`); `Pointers_and_references_are_not_expanded` (`NotExpanded == ["pNext (pointer or reference)"]`); `A_single_value_root_is_its_own_leaf`.
  - `AdsWatchBackendTests` (new `FakeSymbol` parameters `Kind`, `Children`; `FakeLink.Sums` counts `Reader.Read` calls): `ReadMembers_reads_all_leaves_of_a_struct_in_one_sum_read` (struct `MAIN.stAxis`, type `ST_Axis`, children `MAIN.stAxis.nPos : DINT` and `MAIN.stAxis.bOn : BOOL`, `link.Sum = () => Ok(120, true)`: `StructRead.Type == "ST_Axis"`, members `[("MAIN.stAxis.nPos","DINT","120",null), ("MAIN.stAxis.bOn","BOOL","TRUE",null)]`, `link.Sums == 1`); `ReadMembers_returns_null_for_a_single_value`; `ReadMembers_of_an_unknown_symbol_is_not_found_with_the_hide_hint` (`IECodeException` with `ExitCode == ExitCodes.NotFound` and message containing `{attribute 'hide'}`); `One_member_with_a_read_error_does_not_fail_the_others` (items `[NoError, DeviceSymbolNotFound]`: second member `Error == "DeviceSymbolNotFound (0x710)"`, value null); `A_failed_sum_read_is_an_ads_fault`.
  - `WatchHostTests`: `Read_with_depth_asks_the_backend_for_members` (fake `MembersFn` returns one member `MAIN.st.a`; the reply item has `members[0].name == "MAIN.st.a"` and `notes.omittedMembers == 0`); `Read_without_depth_has_no_members_property` (`TryGetProperty("members")` is false and the item has exactly the four old fields); `Read_with_depth_of_a_single_value_falls_back_to_the_scalar_read` (`MembersFn` returns null: `value == "1"`); `Depth_is_clamped_to_the_allowed_range` (9 reaches the backend as 5, 0 as 1); `A_non_integer_depth_fails_the_request` (`"depth":"x"` replies `ok:false` with `read needs an integer 'depth'.`).
- [ ] **Step 2: Run (PowerShell tool)**: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~StructExpandTests"`. Expected: compile error, `StructExpand` does not exist.
- [ ] **Step 3: Implement.** `AdsWatchBackend.ReadMembers`: `Find`-like lookup without the single-value check (same not-found text with `AdsCodes.HiddenHint`); `if (sym.IsSingleValue) return null`; `StructExpand.Walk(sym, depth, MaxMembers, MaxElements, s => s.Kind, s => s.Children, s => s.Path)`; one `link.PrepareRead(walk.Leaves).Read()`; a whole-request failure maps like `ReadWatched` (`Text($"Read from {_where}", code)`); each item becomes a `MemberValue` with `PlcValueText.Format(leaf.BaseType, AdsValues.Normalize(leaf.BaseType, value), leaf.Members)` or `Error = $"{(AdsErrorCode)code} (0x{code:X})"`. The Beckhoff `Symbol` class fills `Kind` from `AdsValues.Underlying(DataType).Category` (primitive, enum, string, subrange: Leaf; struct, class, union: Struct; array: Array; everything else: Opaque; use the category names of the pinned SDK), `Path` from `InstancePath`, `Children` from `SubSymbols` wrapped the same way (array elements are the sub symbols of an array symbol; check this in the D8 manual run). `WatchHost.DoRead(symbols, depth)` reads `depth` once per request, calls `backend.ReadMembers(s, depth)` per symbol when it is set and falls back to `ReadOnce` when that returns null; `WatchReadItem` gains `Members` and `Notes` with `JsonIgnore(WhenWritingNull)`. Add `structRead` to the open protocol entry; document `depth`, `members` and `notes` in `cli/README.md`.
- [ ] **Step 4: Run** `dotnet test cli/tests/IECode.Core.Tests`, then separately `dotnet test cli/tests/IECode.Automation.Tests`. Expected: all pass, including every old `WatchHostTests` read test unchanged.
- [ ] **Step 5: Commit** `Read structures and arrays whole in the watch host` with the why: "The read of a struct failed with 'not a single value' and the agent had to list members first and read them one by one. The members come from one sum read of the leaf symbols, and the reply only gains optional fields, so a protocol-1 extension keeps working."

---

### Task D7b: `ads_read` of structures and `ads_watch { expand: true }` (extension; needs C0 and D7)

**Files:**
- Create: `extension/src/core/watchExpand.ts`, `extension/test/watchExpand.test.ts`
- Modify: `extension/src/core/toolInput.ts` (`parseReadInput`, `parseWatchInput`), `extension/src/core/adsToolText.ts`, `extension/src/ads/host.ts` (`AdsReadResult`, `read`), `extension/src/ads/adsTools.ts` (`read`, `watch`), `extension/src/core/mcpTools.ts` (`AdsToolFns`), `extension/package.json` (`iecode_ads_read`, `iecode_ads_watch`), `extension/test/toolInput.test.ts`, `extension/test/adsToolText.test.ts`, `extension/test/mcpTools.test.ts`, `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: C0's `AdsHost.supports('structRead')`; D7's reply (`members`, `notes`); `readOnceRow`, `watchListText`.
- Produces:
  ```ts
  // host.ts
  export interface ReadMember { name: string; type: string; value: string | null; error: string | null }
  export interface ReadNotes { omittedMembers: number; omittedElements: number; notExpanded: string[] }
  export interface AdsReadResult { /* existing */ members?: ReadMember[]; notes?: ReadNotes }
  read(symbols: string[], depth?: number): Promise<AdsReadResult[]>   // sends depth only when given
  // toolInput.ts
  parseReadInput(raw): Parsed<{ symbols: string[]; depth?: number }>             // 'depth must be a whole number from 1 to 5'
  parseWatchInput(raw): Parsed<{ add: string[]; remove: string[]; expand?: boolean }>   // 'expand must be true or false'
  // adsToolText.ts
  export function readStructRows(r: { symbol: string; type: string; members: ReadMember[]; notes?: ReadNotes }): string;   // multi-line text of one row
  export const structNeedsNewerCli: (symbol: string) => string;
  export function notSingleValueHint(error: string | null | undefined): string | null | undefined;   // used by watchListText
  // watchExpand.ts
  export function expandAdds(add: string[], rows: { symbol: string; error: string | null; members?: ReadMember[]; notes?: ReadNotes }[]): { names: string[]; lines: string[] };
  ```
  Texts: `readStructRows` first line `MAIN.stAxis : ST_Axis (3 members)` (`(1 member)` singular), then one indented line per member `  MAIN.stAxis.nPos : DINT = 120` or, for a member with an error, `  MAIN.stAxis.bOn : error <error>`, then notes `  (4800 members left out: at most 200 are read; read a part of the structure for the rest)`, `  (35 array elements left out: at most 20 per array are read)`, `  (not expanded: MAIN.stAxis.pNext (pointer or reference), MAIN.stAxis.stDeep (depth limit))`. `structNeedsNewerCli('MAIN.stAxis')` is `MAIN.stAxis : error is not a single value; struct expansion needs a newer iecode CLI: structRead`. `notSingleValueHint('ST_Axis is not a single value; add its members instead')` is `ST_Axis is not a single value; add its members instead, or add it with expand: true`; any other text passes through unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `adsToolText.test.ts`: the `readStructRows`, `structNeedsNewerCli` and `notSingleValueHint` strings above, one member of three with an error, the singular header, and all three notes together (4800 omitted members, 35 omitted elements, two not-expanded entries); `watchListText([{ symbol: 'MAIN.st', type: 'ST_Axis', numeric: false, error: 'ST_Axis is not a single value; add its members instead' }], [])` contains the `expand: true` text; an unrelated error is unchanged; `readOnceRow` assertions of the existing `read rows` test stay untouched.
  - `toolInput.test.ts`: `parseReadInput({ symbols: ['a'], depth: 2 })` is `{ ok: true, value: { symbols: ['a'], depth: 2 } }`; `{ depth: 0 }`, `{ depth: 6 }`, `{ depth: 2.5 }` fail with `depth must be a whole number from 1 to 5`; without `depth` the value has no `depth` key; `parseWatchInput({ add: ['a'], expand: true })` keeps `expand: true`; `{ expand: 'yes' }` fails with `expand must be true or false`.
  - `watchExpand.test.ts`: `expandAdds(['MAIN.stAxis', 'MAIN.nCount'], [{ symbol: 'MAIN.stAxis', error: null, members: [{ name: 'MAIN.stAxis.nPos', type: 'DINT', value: '1', error: null }, { name: 'MAIN.stAxis.bOn', type: 'BOOL', value: null, error: 'x' }] }, { symbol: 'MAIN.nCount', error: null }])` gives `names: ['MAIN.stAxis.nPos', 'MAIN.nCount']` and `lines: ['Expanded MAIN.stAxis into 1 watched member.', 'Not added (read error): MAIN.stAxis.bOn']`; a row with `notes.omittedMembers: 4800` adds `MAIN.stAxis: 4800 more members not added (the limit is 200).`; a row with `error` set keeps the name itself (the watch call then reports the item error); duplicate names (case-insensitive) appear once.
  - `mcpTools.test.ts`: the fake `read` receives `{ symbols: ['MAIN.st'], depth: 2 }` through `ads_read`, and `ads_watch` receives `expand: true`; an invalid `depth` returns `Invalid arguments: depth must be a whole number from 1 to 5`.
- [ ] **Step 2: Run to see them fail**: `cd extension && npx tsc -p . && node --test out/test/watchExpand.test.js`. Expected: `Cannot find module '../src/core/watchExpand'`.
- [ ] **Step 3: Implement.** `host.read(symbols, depth?)` sends `{ op: 'read', symbols, depth }` only when `depth` is set and maps `members` and `notes` through. `adsTools.read`: `depth = input.depth ?? 3`; after `await host.ready()` send it only when `host.supports('structRead')`; a once-read row with `members` becomes `readStructRows(...)`, a row whose error matches `/is not a single value/` on a host without the feature becomes `structNeedsNewerCli(symbol)`. `adsTools.watch`: when `input.expand` is true and the host does not support `structRead`, return `Error: expand needs a newer iecode CLI: structRead` (`isError`, nothing changed); otherwise `host.read(add, 3)`, `expandAdds`, pass the names to `host.list.aiEdit` and add `lines` to the result. `watchListText` applies `notSingleValueHint` to each item error. `package.json`: `iecode_ads_read` gains `depth` (integer 1-5, "How many levels of nested structures to read, default 3; a structure or array is returned as a list of its members, at most 200 members and 20 array elements."), `iecode_ads_watch` gains `expand` (boolean, "Add the members of a structure instead of failing; at most 200 members."), and both `modelDescription` texts say so.
- [ ] **Step 4: Run** `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: CHANGELOG and commit.** "- `ads_read` returns a structure, function block instance or array as a list of its members (`depth` 1-5, default 3; at most 200 members and 20 array elements, the result says what was left out), and `ads_watch { expand: true }` watches the members of a structure. Both need the iecode CLI of this release; an older CLI keeps working for single values and says what to update." Commit `Read structures whole and watch their members` with the why: "Reading a structure needed one call per member after a listing call. The limits keep one call from flooding the context, and the result names every cut so a capped list is never taken for the whole."

---

### Task D8: Release

**Files:**
- Modify: `extension/CHANGELOG.md` (order and wording of the Unreleased entries above), `docs/ads-mcp-wishlist.md` (rows of sections 3 and 6), `cli/README.md` (checked), this file (`D6 findings`)

- [ ] **Step 1: Wishlist rows.** Set to Done, with the test names: "`ads_symbols` shows the build time of the `.tmc` and warns when sources are newer" (D1: `symbolOrigin.test.ts`), "Member list of an enum type" (D2, D2b), "`ads_symbols` filter by type or path prefix, paging beyond 100 hits, members of an FB instance with types" (D3), "Read a property with monitoring `call` by its `P_` name; say clearly when no symbol exists" (D4), "Symbols without a `.tmc` from the online symbol table, naming the source" (D5, D5b), "Report the PLC project build that is loaded on the target" (D6b or Out of scope per D6), "Read structs and arrays as a whole" (D7, D7b), "Read hidden members behind an opt-in flag, or list them as hidden" (D2; write "listed as hidden; an opt-in read is impossible because a hidden variable has no ADS symbol").
- [ ] **Step 2: Full automated run.** `cd extension && npm test` (expected: all pass); PowerShell, one after the other: `dotnet test cli/tests/IECode.Core.Tests`, then `dotnet test cli/tests/IECode.Automation.Tests` (expected: all pass).
- [ ] **Step 3: Manual check against a simulation target** (record the result in the PR): a TwinCAT simulation runtime with a library project that has its own `MAIN`, a function block with a `{attribute 'hide'}` variable and a `{attribute 'monitoring' := 'call'}` property, a struct with a pointer member and an array member of 30 elements, and an enum with two names for one value.
  1. `ads_symbols { filter: "MAIN." }` prints `Symbols from the build output of <unit> (built ...).` first; touch a `.TcPOU` and call again: the `Warning: 1 source file is newer ...` line appears; touch it within 2 s of a build: no warning.
  2. `ads_symbols { prefix: "MAIN.fbDrive." }` lists direct members only; `{ type: "BOOL" }` lists BOOLs; with 150 matches `offset: 100` prints `(rows 101-150 of 150; end of list)`.
  3. `ads_symbols { enumType: "E_Mode" }` lists members and the shared-value note; `ads_write` of the second alias name succeeds (needs the CLI of this release, D2b); `ads_symbols { hidden: true, filter: "fbDrive" }` lists `MAIN.fbDrive.bBusy` as hidden.
  4. `ads_read { symbols: ["MAIN.fbDrive.bBusy"] }`: error plus `Matching property in the source code: MAIN.fbDrive.Busy (monitoring call); try that name.`; reading `MAIN.fbDrive.Busy` returns a value.
  5. Move the `.tmc` away and call `ads_symbols { filter: "MAIN." }`: header `Symbols from the running PLC (<target>).`; with the target stopped: `Online symbol list failed: ...` and `Symbols from the source code of <unit> (may differ from the PLC).`; with `source: "online"` and no filter: the error text.
  6. `ads_read { symbols: ["MAIN.stAxis"] }` lists the leaves; `depth: 1` reports the nested struct under `not expanded ... (depth limit)`; the pointer member shows `(pointer or reference)`; the 30-element array shows 20 elements and `(10 array elements left out ...)`. Confirm here that array elements are the sub symbols of the array symbol (D7 assumption).
  7. `ads_watch { add: ["MAIN.stAxis"] }`: the item error mentions `expand: true`; with `expand: true` the members are watched and `Expanded MAIN.stAxis into N watched members.` appears.
  8. Old CLI check: start the extension with the previous CLI release: scalar `ads_read`, `ads_watch`, `ads_write`, `ads_wait` work; struct read, `expand`, online list answer `needs a newer iecode CLI: <feature>` and the source fallback still lists symbols.
  9. D6b: the compare line shows `same build` after a download and `another build` after a build without download (outcome A) or is absent (outcome C).
- [ ] **Step 4: Commit** `Mark the symbol and build-state wishlist items done` with the why: "The wishlist is the status page of the ADS tools; the rows must say what was built, with the test names, and what was ruled out (opt-in read of hidden variables) and why."

---

## Open decisions

1. **Online list in `auto` only for units without a build output.** Recommendation: yes. Online costs a symbol upload and needs a reachable target; the build output is instant and free, and the new header names the source and build time so the agent can ask for `source: "online"` when it doubts the build. The alternative (online first when reachable) makes every call depend on the target.
2. **`prefix` ending in `.` lists direct members only.** Recommendation: yes. A deep function block instance otherwise floods the answer; the agent descends by a longer prefix. The alternative is a `depth` parameter (more surface for little gain).
3. **If the D6 spike ends in outcome B (interface compare only).** Recommendation: build it and word it as "interface matches" instead of "same build", because a retest on code built before a body-only fix is the case the wishlist item came from, and an interface compare cannot see it. If you prefer, treat B as no-go (outcome C) rather than ship a check that sounds stronger than it is.
4. **Hidden variables are listed, not readable.** The rough plan had an opt-in `includeHidden` read; a variable with `{attribute 'hide'}` has no ADS symbol, so no flag can make it readable. The plan lists them with `hidden: true` and points to the monitoring-call property (D4). Confirm that this replaces the opt-in.
5. **`ads_wait` on an alias name of an enum value.** A read shows the first name, so `ads_wait(sym, "= Start")` for a second alias never matches by name. The D2 note tells the agent to compare by number; fixing it in `waitCondition.ts` needs the enum member list in the wait run. Recommendation: leave it, the note covers it.

## Self-review

- **Spec coverage:** wishlist section 6 rows are D1 (build time), D6/D6b (loaded build), D5/D5b (online), D3 (filter, paging, instance members), D2 (enum members); section 3 rows are D7/D7b (structs and arrays), D2/D4 (hidden, property); roadmap Phase 5a, 5b and Phase 7 are D5/D5b, D7/D7b, D4. Rough-plan Review Focus items 1-5 each have a named test above. Sample age (wishlist section 3, first row) belongs to Plan A.
- **Type consistency:** `SymbolQuery` (D3) is used unchanged by D5b; `AdsInterface.builtAt/newerSources` (D1) feed `buildHeader` (D1) and `compareBuilds` (D6b); `ReadMember`/`ReadNotes` (D7b) mirror the C# `MemberValue` and `notes` record (camelCase JSON: `name`, `type`, `value`, `error`; `omittedMembers`, `omittedElements`, `notExpanded`); feature names `onlineSymbols` and `structRead` appear identically in D5, D5b, D7, D7b and the constraints; `symbolsText` gains `headers` in D1 and `offset` in D3 (each task updates the existing test base); `SymbolsInput` gains fields in D2, D3, D5b and the parse results keep optional keys absent.
- **Placeholders:** none left; the two places that depend on outside facts are named: where C0 puts the protocol table (Global Constraints) and the Beckhoff `DataTypeCategory` names and array sub-symbol behaviour (D5, D7, checked in D8 step 3.6). D6 is a spike by design, with outcomes spelled out.
- **Proportion:** each task carries signatures, test names with exact expected strings and a commit; bodies are described, not written.


## Review amendments (2026-11-10)

From the engineering review of this plan. These override the task text above where they differ.

1. **Use C0's real interface (D5b, D7b).** The host has `hostCaps()`, `requires(feature)` and `knownMissing(feature)`; `supports` lives on `HostCaps`. The wording of a missing feature comes from `featureMissingText` / `FEATURE_LABELS` of C0 (add labels for `onlineSymbols` and `structRead`); D does not hand-write these texts. Call `await host.ready()` first, then check the capabilities.
2. **Protocol entry.** D5 and D7 add their features to the open protocol entry as the master rule says (an entry is frozen by the CLI release, see Plan C amendment 1); the branch "if C2 has not bumped yet" is only valid for a stand-alone D release.
3. **`type` filter and BIT (D3).** The build output stores top-level BOOL as `BIT`. `normalizeType` maps `BIT` to `BOOL` for matching, and `STRING` matches `STRING(n)`. Tests: `type: BOOL` finds a `BIT` symbol; `string` finds `STRING(20)`.
4. **Online filtering (D5b).** `type` is passed to the CLI as `--type` and applied before the 500 cap; until then the note says `type filter applied to the first 500 rows only`. Test with more than 500 matches.
5. **Orchestration in core (D1-D5b).** Extract the decision logic of `adsTools.symbols` into a pure `runSymbols(deps)` in `extension/src/core/symbolSource.ts` with injected `fromBuild`, `fromSourceAt`, `listOnline`, `ready`; test: `ready()` throws (fall back to the source with a note), online failure text, header order, `total` arithmetic, offset across units.
6. **Enum aliases on an old CLI (D2).** `enumText` marks alias names the CLI cannot write yet when the host protocol is below the one that carries D2b (`(alias, write needs a newer CLI)`); no alias note when the host is unknown. D2 stays in T1; D2b in T2.
7. **Enum parsing from source (D2).** A member whose value is not a plain integer literal (expression, `INT#5`, `2#101`, `16#FF_FF`, negative) gets its value from the build output if available, otherwise no value, and `EnumMember.value` is `string | undefined`. Tests: several members on one line, an expression value, a negative value.
8. **D7.** `ReadMembers` returns the scalar for a non-structured symbol so `DoRead` does one `Find` per symbol, not two. `NotExpanded` overflow is counted (`OmittedNotExpanded`) and said in the note. `Walk` tests: array root over `maxElements`, `depth` with `maxMembers`. `expand` checks the 200 limit against the existing list before expanding and says so.
9. **D5, D6b.** `--online` with a one-character filter is rejected (`RequireFilter` needs at least 2 characters); measure the symbol-table size and upload time in D6. D6b prints `No loaded-build comparison (host not running)` instead of nothing; the time zone of `AppTimestamp` is settled in D6.
10. **Intended output change.** D1's 2 s tolerance also changes the stale warning of `views/adsInterface.ts` (lines 68, 76, 172); this is in the master list. D4 tests use the real CLI error text (`AdsCodes.HiddenHint`); suggest properties with `monitoring := 'variable'` too, or document why not.
11. **Line references fixed in this plan:** `TargetCommands.cs` lines 240-275, `cli/README.md` line 43, `PlcValueText.cs` lines 38-44 and 77-88, `AdsValues.cs` lines 61-66 and 83-89, `WatchHost.cs` lines 49-50 and 302-320, `adsinterface.ts:237-253`.


## Review amendments, round 2 (2026-11-10)

From the second, independent review. These override round 1 and the task text.

1. **Online paging (D5, D5b; replaces round 1 item 4).** The CLI applies the whole query (`--filter`, `--prefix`, `--type`) and the paging (`--offset`, `--max`) and returns an exact `total`; the extension does not filter or page the rows afterwards. Signatures of `onlineArgs`, `listOnline`, `OnlineSymbolList.List`, `OnlineSymbols.Select` change accordingly. Tests: offset 400, 500, 600; a prefix match only behind position 500.
2. **Compare only complete sets (D6b).** The loaded-build comparison runs only when both sides were obtained with the same rules and neither was capped; otherwise the result is `Comparison incomplete (capped at 500)`, never "matches". Test: one difference behind the 500th symbol. Online arrays are not expanded and the walk stops at depth 8; the build side uses the same rules.
3. **Online is its own source (D5b).** In `auto` the online table is a separate section with the header of its endpoint; it never stands in for a unit of the workspace and never removes a per-unit entry. No de-duplication across sources; every row keeps its origin. Tests: two projects with the same symbol names, a project on another port.
4. **D7 result contract (D7, D7b; replaces round 1 item 8 in part).** `ReadMembers` returns `MemberRead { Kind: Scalar | Struct | Opaque; Scalar; Struct }`; without `depth` the old wire reply stays. `AdsValues.Underlying` becomes `internal`. `OmittedNotExpanded` goes through the C# records, JSON, the TS `ReadNotes`, the formatter and tests.
5. **Selection cost (D5).** Count matches while streaming and keep only the page; for a prefix filter prune the subtree. Say honestly that the symbol table upload happens before filtering. Measure upload, walk and selection separately in D6.
6. **Struct work budget (D7).** A request-wide limit of 1000 leaves and a traversal budget; children are read lazily; at the budget the rest count is `unknown`. Tests with several large roots and delayed ADS calls.
7. **Sum read wording (D7).** The promise is "one call of the sum-read adapter"; `SumFallbackMode.All` may fall back to single reads, which the text and tests do not hide. Struct values are not an atomic snapshot.
8. **Alias write capability (D2, D2b).** Define the feature `enumAliasWrite` in the open protocol entry (C0 table) and pass the capability state (`supported`, `unsupported`, `unknown`) to `enumText`; unknown shows the note, so unknown never reads as supported.
9. **Enum values (D2).** Model `known | unknown` per member with its origin. An unknown value propagates to implicit successors until the next known initial value (`(A := C + 2, B, C := 10, D)`: A and B unknown, C = 10, D = 11). Members are split by tokens, not by line; values stay strings (no JS number rounding); unknown values form no alias group; a build value is labelled as such when it replaces a source expression.
10. **Type matching (D3).** Query matching (`BIT` = `BOOL`, `STRING` matches `STRING(n)`) is separate from the equivalence used by `diffSymbols`; the existing diff test `BIT -> BOOL` stays unchanged, an explicit string length stays relevant in a diff.
11. **D7b builds on Plan B.** `expand` is an additive field of B's `WatchRequest` and runs inside `runWatchRequest`; no direct `aiEdit` path. Tests combine `expand` with remove, groups and `list`.
12. **Host lifecycle (D5b).** `ads_symbols` takes a lease for the capability check; `ready()` alone does not keep a host alive. Test: host off before, online list ends, host does not stay active. The online browse does not start watch uploads (`afterHello` list resend is accepted only when a list exists; say so).
13. **Cancellation (D5b).** The signal runs through MCP, Copilot, `symbols`, `runSymbols` and `listOnline`; after an abort there is no source fallback and no further host action.
14. **Fallback only for `auto` (D5b).** An explicit `source` returns an error on failure. The source loader reports skipped or unreadable files. Test valid but useless JSON (`{"ok":true,"data":null}`).
15. **Wording of the compare (D6, D6b).** Go only if the runtime identity can be tied to a build artefact; otherwise the line says `timestamps agree within <tolerance>`, not `same build`. Every comparison that cannot run says why (host off, symbol missing, access denied, unreadable value). Time zone and tests come from the D6 result.
16. **Struct edge cases (D7).** Zero leaves (pointer-only root, depth cut) sends no ADS read and returns type and limit notes only. Tests: opaque root, array alias, array not starting at 0, multi-dimensional array, a result count mismatch, a marshalling exception during a download, the scalar return with one lookup.
17. **Expand and the watch limit (D7b).** Capacity is checked inside the serialised list edit on the de-duplicated final list; all read limits (`OmittedMembers`, `OmittedNotExpanded`, array and depth notes) also appear in the watch result. Tests: list full while removing and expanding, concurrent add.
18. **Property hints (D4).** Visibility and hint suitability are separate; `visible()` keeps accepting any `monitoring` attribute. Tests: `'call'`, `'variable'`, a `P_` path (live check).
19. **Small fixes.** D1 test: bind the second build explicitly (no `built2`) and import `basename`. D6 spike: no `SymbolVersion` debug command exists; name an available read path or a throwaway SDK helper.
