# Plan D: Symbols, Structures, Enums and Build State

> **For agentic workers:** rough sub-plan of the [master plan](2026-11-09-ads-wishlist-master-plan.md). Expand each task into TDD steps with superpowers:writing-plans before building it. D1, D2 (online part), D5 and D6 need C0.

**Goal:** An agent finds symbols without a build output, reads structures and arrays whole, knows the valid enum values, and sees at once when the running PLC does not match the sources.

**Architecture:** Mostly extension side (`.tmc` and source parsing in `extension/src/core/tmc.ts` and `adsinterface.ts`). Online symbols and struct expansion need the CLI: a separate short-lived `iecode ads symbols --online` process (not a watch-host op, so samples and writes never wait behind a symbol upload) and an optional `members` list in the `read` reply.

**Tech Stack:** TypeScript, C# .NET, `Beckhoff.TwinCAT.Ads`.

**Spec:** [wishlist sections 3 and 6](../../ads-mcp-wishlist.md), roadmap Phases 5 and 7 (D15, D22, D23).

## Global Constraints

See the master plan. In addition:

- The result of `ads_symbols` names its source: `from the running PLC`, `from the build output`, `from the source code (may differ from the PLC)`.
- `ads_read` of a single-value symbol stays byte-identical; the struct reply is additive.
- Online symbol lists are bounded: a filter is required, at most 500 matches plus the total count, 60 s timeout.

## Review Focus

1. No `.tmc` and an offline target: the source fallback answers and says it may differ.
2. A struct with 5000 leaf members: capped at 200, the result says how many were left out.
3. Sources newer than the `.tmc` by one second of clock skew: no false stale warning (use a tolerance).
4. An enum whose members share a value: both names listed, the write by name still resolves.
5. A hidden member: listed as hidden, never silently readable without the opt-in.

## File Structure

- `extension/src/core/tmc.ts`, `adsinterface.ts`: enum members, hidden flag, member listing, build time, property lookup.
- `extension/src/core/adsToolText.ts`, `toolInput.ts`, `extension/src/ads/adsTools.ts`, `package.json`: `ads_symbols` options and texts.
- `cli/src/IECode.Cli/Commands/TargetCommands.cs`, `cli/src/IECode.Core/Ads/SymbolTable.cs`, `SymbolVersion.cs`: online symbols, symbol version.
- `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `AdsWatchBackend.cs`, `PlcValueText.cs`: struct read.
- Tests: `extension/test/adsinterface.test.ts` (or the existing tmc tests), `adsToolText.test.ts`, `AdsWatchBackendTests`.

## Tasks

### D1: Build time and stale-source warning (extension only)

**Interfaces:** `buildInfo(tmcPath: string, sourceFiles: string[]): { builtAt: Date; newerSources: string[] }`; `ads_symbols` prints `Build output from <time>` and `Warning: N source files are newer than the build output` (tolerance 2 s, first 3 names).

### D2: Enum members and hidden members (extension only)

**Interfaces:** `ads_symbols { type: "<enum type>" }` returns the member list `name = value`; symbol rows carry `hidden: true` where the `.tmc` or source says `{attribute 'hide'}`; `ads_read` of a hidden member needs the opt-in `includeHidden: true`. Builds on the hint already present from PR #27.

### D3: Filter, paging and instance members (extension only)

**Interfaces:** `ads_symbols` input `prefix?: string`, `type?: string`, `offset?: number` (page size 100); a prefix ending in `.` lists the members of that FB instance with their types from the `.tmc` data types.

### D4: Property lookup for "symbol not found" (roadmap Phase 7)

**Interfaces:** `matchingProperties(parentPath, lastSegment): string[]` in `adsinterface.ts`; the not-found text becomes `Not found. If it is hidden, try the property <parent>.<Prop> (monitoring call).` only when the parent type resolves; otherwise the generic hint stays.

### D5: Online symbols (needs C0)

**Interfaces:** `iecode ads symbols --online --target <netid> [--port] --filter <text>`; extension runs it as a separate process; fallback chain for `ads_symbols`: online table, build output, source code, each named in the result.

### D6: Loaded build versus workspace build (needs C0, spike first)

Spike (about 2 h): which values from the target identify the loaded PLC build (symbol version, online change count, boot project time); `SymbolVersion.cs` already reads the symbol version. If a value matches the `.tmc`, `ads_symbols` shows `Target runs the same build` or `Target runs another build than the workspace output`; if nothing reliable exists, the task ends with a note and the wishlist row says so.

### D7: Struct and array read (needs C0)

**Interfaces:** `read` reply gets an optional `members: { name, type, value }[]`; `ReadOnce` expands through `SubSymbols` with one sum read; `ads_read` input `depth?: number` (default 3, max 5), members capped at 200, arrays at 20 elements; an older host answers "struct expansion needs a newer iecode CLI". `ads_watch { expand: true }` adds the leaf members; without it the error mentions `expand`.

### D8: Release

CHANGELOG entries; wishlist rows to Done; manual check with a library project and a project with structs against a simulation target.

## Order

D1 → D2 → D3 → D4 in the first release train (extension only). D5 → D6 → D7 after C0.
