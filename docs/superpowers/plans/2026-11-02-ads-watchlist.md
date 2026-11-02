# ADS Watchlist, Mini Scope and AI Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read and write PLC variables live from VS Code: a watchlist view, a mini scope that plots the watched values over a configurable time span, and VS Code language model tools that give AI agents in the chat the same capabilities.

**Architecture:** A long-running CLI process `iecode ads serve` holds one ADS connection, polls the watched symbols in one sum read per cycle and streams the values as JSON lines on stdout; it takes requests (watch list, one-off read, write) as JSON lines on stdin. Its logic (`WatchHost`) is pure and tested against a fake backend; the Beckhoff glue (`AdsWatchBackend`) is a thin adapter. The extension spawns one host per target, keeps the sample ring buffer, and puts three front ends on it: the watchlist tree view, the scope webview and the LM tools.

**Tech Stack:** C# / .NET 10, `Beckhoff.TwinCAT.Ads` 7.0.389 (already referenced by `IECode.Automation`), System.CommandLine, System.Text.Json, xunit.v3; TypeScript, VS Code extension API (`TreeDataProvider`, webview, `vscode.lm.registerTool`), `node --test`.

**Spec:** `TODO.md`, item *ADS variable access: watchlist, mini scope and AI interface*, plus these decisions:

- AI interface = VS Code language model tools (`contributes.languageModelTools`), not an MCP server. These tools reach Copilot Chat only; Claude Code cannot call `vscode.lm` tools, so with `iecode.aiChat` on Claude Code the AI path is "Add to AI Chat" (clipboard). A later MCP server cannot sit on the host alone: the watch list and the sample history live in the extension, so it would be an endpoint served by the extension (O4). README and TODO say so.
- One shared host process for UI and AI; the extension owns the watch list and the sample buffer.
- Values are polled (sum read per cycle), not ADS notifications. Notifications are a later option if the scope needs sub-10 ms resolution.
- AI writes are off by default. The switch `iecode.ads.aiWrites` has three positions: `off` (refused), `confirm` (every AI write is confirmed by the user), `auto` (auto-approve: written without asking).
- Target = the setting `iecode.ads.target` (`local` or an AMS NetId), port `iecode.ads.port`. Changing either restarts the host.

## Global Constraints

- All code, comments, UI strings, commit messages in English. Commit subject + 1-3 sentence body on *why*, no attribution trailers, signed off (`git commit -s`; CI rejects commits without `Signed-off-by`).
- Match surrounding style: C# like `cli/src/IECode.Automation/Target.cs` (file-scoped namespaces, `IECodeException` + `ExitCodes`); TypeScript 2-space indent, single quotes, terse *why* comments, pure logic in `extension/src/core/` with `node --test` tests in `extension/test/`.
- This repo is public: test fixtures and examples use generic names (`MAIN.bStart`, `GVL.nCount`, `MAIN.fTemp`). No company names, paths or project content.
- No new runtime dependencies in the extension. In the CLI only what is already referenced.
- Tests: `npm test` in `extension/` and `dotnet test --solution cli/IECode.slnx` stay green after every task. Run `dotnet test` through the PowerShell tool, alone (never chained with `dotnet build`, nothing heavy in parallel).
- Existing behaviour of `iecode ads read|write|symbols|diff` and the ADS Interface view does not change, except that `ads read|write` gain the value types of Task 1.
- Values cross every boundary as **canonical text** (format in Task 1), invariant culture, never locale-dependent.
- Protocol version `1`. Settings and their defaults:
  - `iecode.ads.target` = `"local"`
  - `iecode.ads.port` = `851`
  - `iecode.ads.sampleIntervalMs` = `100` (min `10`, max `5000`; the description says Windows timers tick about every 15.6 ms, so below ~16 ms the real rate is lower, and every row carries its actual read time, O9)
  - `iecode.ads.bufferSeconds` = `300` (min `10`, max `3600`)
  - `iecode.ads.aiWrites` = `"off"` (enum `off` | `confirm` | `auto`; `"scope": "application"`, user settings only: `window` scope can be set in a workspace `.vscode/settings.json`, so a cloned repo could turn on auto-approve. Same reason as `iecode.cliPath` using `machine`)
- Max watched symbols: `200`. LM tool results: at most `200` sample rows.

## Review Focus

1. **PLC download / online change while watching**: handles go stale (ADS `0x710` / `0x711`, or the symbol version changes). The host must re-resolve the watch list by itself and keep streaming, without the user re-adding anything. Test in Task 2 (`WatchHost_ResolvesAgain_AfterDeadHandleCodes`).
2. **Target unreachable or connection lost mid-watch**: no crash, no exit. The host reports `state connected:false` once, retries every 2 s, reports `connected:true` when back. The view shows "disconnected". Test in Task 2 (`WatchHost_ReportsLostConnection_AndRetries`).
3. **One bad symbol in the list** (unknown name, struct / FB / array, typo): only that item gets an error, every other item keeps updating. Test in Task 2 (`WatchHost_BadSymbol_DoesNotStopOthers`).
4. **German locale input**: `1,5` for a REAL is rejected with a clear message (never written as 15), output always uses `.`. Test in Task 1 (`Parse_Real_RejectsDecimalComma`).
5. **Old CLI without `ads serve`**: the extension must say "update the CLI", not hang. The host sends `hello` first (before it even parses `-t` / `--port`, R3); no `hello` within 10 s or an early exit means "too old / not installed". An exit after `hello` is never "too old": a bad target arrives as a `state` error. Test of the decision in Task 4 (`hostStartFailure`).

## Not in this plan

- MCP server, ADS notifications, allowlist for AI writes, writing structs / arrays as a whole, a live online symbol browser (the picker uses the `.tmc` build output plus free text).

---

### Task 1: Canonical value text in Core

Moves `Target.Convert` into Core, adds formatting and the date / time types, so the host and `ads read|write` share one codec.

**Files:**
- Create: `cli/src/IECode.Core/Ads/PlcValueText.cs`
- Create: `cli/src/IECode.Automation/AdsValues.cs` (O5: alias → base type name via `IAliasType.BaseType`, PlcOpen `TIME/LTIME/TOD/DATE/DT` → `TimeSpan` / `DateTime`; used by `Target` now and by `AdsWatchBackend` in Task 3)
- Modify: `cli/src/IECode.Automation/Target.cs` (`Read` returns `(string Type, object? Value, string Text)`: `Value` typed as today, `Text` from `PlcValueText.Format` after `AdsValues` (C2: replacing `Value` with text would break O6); `Write` parses with `PlcValueText.Parse`; delete `Convert`), `cli/src/IECode.Cli/Commands/TargetCommands.cs` (O6: `ads read --json` keeps `value` typed as today and adds `text` with the canonical text)
- Test: `cli/tests/IECode.Core.Tests/PlcValueTextTests.cs`

**Interfaces – Produces:**
```csharp
namespace IECode.Core.Ads;
public static class PlcValueText
{
    /// .NET value as read over ADS -> canonical text. enumMembers: value -> name for enum types, else null.
    public static string Format(string iecType, object? value, IReadOnlyDictionary<long, string>? enumMembers = null);
    /// canonical / user text -> .NET value of the IEC type. Throws IECodeException(ExitCodes.Usage, …) on bad input.
    public static object Parse(string iecType, string text, IReadOnlyDictionary<long, string>? enumMembers = null);
    /// true for BOOL, integer types, REAL, LREAL, enums (enumMembers != null), TIME, LTIME — the values the scope can plot.
    public static bool IsNumeric(string iecType, bool isEnum);
}
```

Canonical format: BOOL `TRUE`/`FALSE` (parse also `1`/`0`, any case); integers decimal; REAL/LREAL round-trip `"R"` with `.`; STRING/WSTRING as is (`STRING(80)` matches by prefix); enum = member name, number if not a member (parse accepts name or number); TIME/LTIME/TOD `TimeSpan` `"c"` (`00:00:01.5000000`); DATE/DT `yyyy-MM-ddTHH:mm:ss` (DT) / `yyyy-MM-dd` (DATE). Aliases are resolved by the caller (Task 3), `Format` only sees base type names.

- [ ] **Step 1: Write the failing tests**

```csharp
[Theory]
[InlineData("BOOL", true, "TRUE")]
[InlineData("INT", (short)-42, "-42")]
[InlineData("REAL", 3.14f, "3.14")]
[InlineData("LREAL", 0.1, "0.1")]
[InlineData("STRING(80)", "Hello, world", "Hello, world")]
public void Format_Elementary(string type, object value, string expected) => Assert.Equal(expected, PlcValueText.Format(type, value));

[Fact] public void Format_Time() => Assert.Equal("00:00:01.5000000", PlcValueText.Format("TIME", TimeSpan.FromMilliseconds(1500)));
[Fact] public void Format_Enum_UnknownValue_IsNumber() => Assert.Equal("7", PlcValueText.Format("E_State", 7, new Dictionary<long, string> { [0] = "Idle" }));
[Fact] public void Parse_Enum_ByName() => Assert.Equal(1L, System.Convert.ToInt64(PlcValueText.Parse("E_State", "Running", new Dictionary<long, string> { [0] = "Idle", [1] = "Running" })));
[Fact] public void Parse_Real_RejectsDecimalComma() => Assert.Equal(ExitCodes.Usage, Assert.Throws<IECodeException>(() => PlcValueText.Parse("REAL", "1,5")).ExitCode);
[Fact] public void Parse_Int_Overflow_IsUsageError() => Assert.Throws<IECodeException>(() => PlcValueText.Parse("SINT", "200"));
[Fact] public void RoundTrip_Lreal() { var t = PlcValueText.Format("LREAL", 1.0 / 3); Assert.Equal(1.0 / 3, (double)PlcValueText.Parse("LREAL", t)); }
[Fact] public void Parse_Struct_NotSupported() => Assert.Throws<IECodeException>(() => PlcValueText.Parse("ST_Motor", "1"));
```

- [ ] **Step 2: Run, expect FAIL** — `dotnet test --solution cli/IECode.slnx --filter PlcValueText` → compile error, `PlcValueText` missing.
- [ ] **Step 3: Implement `PlcValueText`**; then switch `Target.Read` / `Target.Write` to it (Write gets enum members from the symbol's `IEnumType` if any).
- [ ] **Step 4: Run, expect PASS** — same command, plus the full `dotnet test --solution cli/IECode.slnx`. Manual (O5): `iecode ads read` of a TIME and of an alias variable prints canonical text; `--json` still has the typed `value` (number for INT / REAL, `true` for BOOL, as before) plus `text` (O6, C2).
- [ ] **Step 5: Commit** — `git commit -s -m "CLI: one canonical value text for ADS reads and writes" -m "<why: host and ads read/write must agree on values; adds TIME/DATE/enum which ads write rejected>"`

### Task 2: Watch host logic and protocol (pure, Core)

**Files:**
- Create: `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `cli/src/IECode.Core/Ads/WatchHost.cs`, `cli/src/IECode.Core/Ads/AdsCodes.cs` (C5: the ADS error code table of R2 as a pure function, so it is unit-tested; Automation has no test project)
- Test: `cli/tests/IECode.Core.Tests/WatchHostTests.cs` (contains `FakeBackend : IWatchBackend` with scripted values / faults), `cli/tests/IECode.Core.Tests/AdsCodesTests.cs`

**Protocol (JSON lines, UTF-8, one object per line):**
- stdin requests: `{"id":1,"op":"watch","symbols":["MAIN.bStart","GVL.nCount"]}` (replaces the list), `{"id":2,"op":"read","symbols":["MAIN.x"]}` (one-off, not watched), `{"id":3,"op":"write","symbol":"MAIN.x","value":"5"}`, `{"id":4,"op":"interval","ms":100}`. EOF on stdin = stop.
- stdout replies: `{"id":1,"ok":true,"data":…}` / `{"id":1,"ok":false,"error":"…","adsCode":1808}`. `watch` data: `{"gen":3,"items":[{"symbol":"MAIN.bStart","type":"BOOL","numeric":true,"error":null}]}`. `read` data: `[{"symbol","type","value","error"}]`. `write` data: `{"symbol","value"}` (value as read back).
- stdout events: `{"event":"hello","protocol":1}` (first line, always), `{"event":"samples","gen":3,"rows":[{"t":1762070400123,"v":["TRUE","42",null,"Running"],"e":[null,null,null,1]}]}` (`t` Unix ms, `v` index-aligned with the items of `gen`, `null` = item error; `e` only when the `gen` has an enum item: index-aligned enum numbers, `null` for non-enum items, C1), `{"event":"state","connected":false,"error":"…"}`, `{"event":"items","gen":4,"items":[…]}` (R5: sent when a re-resolve after a download / version change yields different items, e.g. a changed type or a deleted symbol; it starts a new `gen`. Same items → no event, `gen` kept).

**Interfaces – Produces:**
```csharp
namespace IECode.Core.Ads;
public sealed record WatchItem(string Symbol, string Type, bool Numeric, string? Error);
public sealed class AdsFault(string message, uint? adsCode, bool connectionLost) : Exception(message) { public uint? AdsCode { get; } = adsCode; public bool ConnectionLost { get; } = connectionLost; }
public interface IWatchBackend : IDisposable
{
    void Connect();                                                   // throws AdsFault(connectionLost: true)
    IReadOnlyList<WatchItem> Resolve(IReadOnlyList<string> symbols);  // per-item errors in WatchItem.Error, never throws for one bad name
    IReadOnlyList<(string? Value, long? EnumValue, uint? AdsCode)> ReadWatched();  // O3: per item, index-aligned with the last Resolve; EnumValue only for enum items (C1); throws AdsFault only for connection loss
    // host: any item with 0x710/0x711 → re-resolve; other codes → that item null + item error, the rest keep their values
    bool SymbolVersionChanged();                                      // cheap 1-byte read, called every tick before rows are published (R4)
    (string Type, string Value) ReadOnce(string symbol);
    string Write(string symbol, string text);                         // returns the value read back
}
public sealed class WatchHost(IWatchBackend backend, Action<string> emit)
{
    public const int Protocol = 1, MaxSymbols = 200;
    public void Start();                          // emits hello, connects (failure -> state connected:false)
    public void Handle(string requestLine);       // one stdin line
    public void Tick(DateTimeOffset now);         // called by the loop every interval; polls, flushes samples every 100 ms, retries connect 2 s after the failed attempt ended (a dead target can block ~5 s per attempt, so ~7 s apart; stdin requests wait meanwhile, O9)
    public int IntervalMs { get; }                // default 100, clamped to 10..5000
}
public static class AdsCodes
{
    public static bool IsConnectionLost(uint adsCode);   // C5: the R2 table (0x6, 0x7, 0x745, 0x746..0x74A); AdsWatchBackend calls it
    public static bool IsDeadHandle(uint adsCode);       // 0x710, 0x711
}
```
`WatchHost` has no threads and no clock of its own: the loop (Task 3) calls `Tick`, tests call it with explicit times.

- [ ] **Step 1: Write the failing tests** (names and assertions):
  - `Start_EmitsHelloFirst` — first emitted line parses to `event == "hello"`, `protocol == 1`.
  - `Watch_ReturnsItems_WithNewGen` — `watch` with 2 symbols → reply `ok`, `gen` 1, 2 items.
  - `Watch_MoreThan200_IsRejected` — 201 symbols → `ok:false`, error mentions `200`.
  - `Tick_EmitsSamples_EveryHundredMs` — interval 10 ms, ticks at 0, 10, …, 90 ms → no event; tick at 100 ms → exactly one `samples` event with 11 rows (0..100 inclusive; the flush runs after the read), `gen` 1 (O12). Each row `t` is the time passed to `Tick` for that read; the loop passes the clock after the sum read returns (O9).
  - `WatchHost_BadSymbol_DoesNotStopOthers` — fake resolves `MAIN.nope` with `Error`, `MAIN.a` fine → rows have `[null, "1"]`, item error in the watch reply.
  - `WatchHost_ResolvesAgain_AfterDeadHandleCodes` — `ReadWatched` throws `AdsFault(adsCode: 0x711)` once → backend `Resolve` called a second time with the same list, next rows carry values again, `gen` unchanged (same symbols).
  - `WatchHost_ResolvesAgain_WhenSymbolVersionChanged`.
  - `WatchHost_ReportsLostConnection_AndRetries` — `ReadWatched` throws `ConnectionLost` → one `state connected:false`; no `Connect` before +2 s; `Connect` succeeds at +2 s → `state connected:true`, then `Resolve` again.
  - `Write_ReturnsReadBack` and `Write_BadValue_IsErrorReply` (fake `Write` throws `IECodeException`) → `ok:false` with the message, host keeps running.
  - `BadJson_IsErrorReply_NotCrash` — `Handle("{oops")` → `{"id":null,"ok":false,…}`.
  - `WatchHost_ResolvesAgain_TypeChanged_NewGen` (R5) — after `0x711` the fake resolves `MAIN.a` as `REAL` instead of `INT` → one `items` event with `gen` 2 and the new type; following rows carry `gen` 2.
  - `WatchHost_MixedRow_OneDeadHandle_ResolvesAgain_OtherCodeIsItemError` (O3) — row `[ok, 0x711, 0x705]` → re-resolve; a row `[ok, 0x705]` → `["1", null]` and an item error, no re-resolve.
  - `WatchHost_OtherAdsCode_KeepsPolling` (R2) — `ReadWatched` throws `AdsFault(adsCode: 0x705, connectionLost: false)` → no `state` event, no `Connect`, the next tick polls again; the error is reported once on stderr, not per tick.
  - `WatchHost_ChecksSymbolVersion_BeforePublishingRows` (R4) — fake `SymbolVersionChanged` returns true on a tick → the rows read in that tick are dropped, `Resolve` runs again, no row from the old resolution reaches `samples`.
  - `Samples_CarryEnumNumbers_OnlyWithEnumItems` (C1) — items `[INT, E_State]` → rows have `e: [null, 1]`; items without an enum → rows have no `e`.
  - `AdsCodes_ConnectionLost_AndDeadHandle` (C5, in `AdsCodesTests`) — `0x6`, `0x7`, `0x745`, `0x746`, `0x74A` → connection lost; `0x710`, `0x711` → dead handle; `0x705`, `0x701` → neither.
- [ ] **Step 2: Run, expect FAIL** — `dotnet test --solution cli/IECode.slnx --filter WatchHost`.
- [ ] **Step 3: Implement** `WatchProtocol` (request record + `JsonSerializer` with camelCase, `null` kept in `v`) and `WatchHost`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `CLI: watch host protocol and logic for live ADS values` (body: why pure + fake backend: the ADS part needs a runtime, the recovery logic must be testable in CI).

### Task 3: `iecode ads serve` with the Beckhoff backend

**Files:**
- Create: `cli/src/IECode.Automation/AdsWatchBackend.cs`
- Modify: `cli/src/IECode.Cli/Commands/TargetCommands.cs` (new subcommand `serve` in `Ads()`), `cli/README.md` (command table row + a short "Live values" section with the protocol summary)

**Interfaces:**
- Consumes: `IWatchBackend`, `WatchHost`, `AdsFault`, `AdsCodes`, `PlcValueText` (Tasks 1-2).
- Produces: CLI `iecode ads serve [-t <netid>] [--port 851]` — Windows only, runs until stdin closes, exit code 0. Logs only to stderr; stdout carries protocol lines only.

`AdsWatchBackend(Core.AmsNetId target, int port)`: one `AdsClient`; symbols from `SymbolLoaderFactory.Create(client, SymbolLoaderSettings.Default)`; `Resolve` looks up each path, resolves aliases to the base type (`IAliasType.BaseType`), rejects non-atomic types (struct, FB, array, pointer, reference, interface) with `Error = "<type> is not a single value; add its members instead"`; reads with one `TwinCAT.Ads.SumCommand.SumSymbolRead` over the resolved symbols **in handle mode** (R4: check the access-mode parameter of `SumSymbolRead` in 7.0.389 first; an index group / offset read gets no `0x710`/`0x711` after a download and would return other variables' bytes from the old addresses). Convert PlcOpen values (`TwinCAT.PlcOpen.TIME/LTIME/TOD/DATE/DT`) to `TimeSpan` / `DateTime` before `PlcValueText.Format`. `SymbolVersionChanged` reads the 1-byte symbol version (index group `0xF008`, offset 0) and compares with the last value. `Resolve` after a fault or a symbol version change throws the old symbol loader away and builds a new one, otherwise it returns the old types (O2). `serve` reads stdin as a UTF-8 stream (`Program.cs` only sets `OutputEncoding`) (O8). Error mapping (R2): an unreachable or stopped target also arrives as `AdsErrorException`, so classify by code. `connectionLost: true` for target port / machine not found (`0x6`, `0x7`), client sync timeout (`0x745`), the router / port codes `0x746`..`0x74A`, and any non-`AdsErrorException` `AdsException` / socket fault; every other code → `AdsFault(adsCode, connectionLost: false)` (dead handles re-resolve, the rest stay item errors and polling continues). The code table is `AdsCodes` in Core (Task 2, C5); extend it there after the manual check. `Connect()` must prove the target is there: `AdsClient.Connect` only opens the local router port, so follow it with `ReadState()` and map its failure the same way. `serve` does not run through `Runner.Action`'s target parsing before `hello` (R3): it writes `hello` first, then parses `-t` / `--port`; an invalid NetId becomes `{"event":"state","connected":false,"error":"Invalid AMS NetId …"}` and the host waits for stdin EOF without connecting. Log only through `ctx.Log.Step/Warn/Error` (stderr); `Info`/`Success` write to stdout (`Reporter.cs:29,31`). The loop in `serve`: a reader thread queues stdin lines; the main thread calls `host.Handle` for queued lines and `host.Tick(now)` every `IntervalMs` (`PeriodicTimer`). EOF is queued behind the lines read before it: the loop handles every queued request (and flushes its reply) before it stops, so `request | iecode ads serve` never drops the request (C3). `ReadWatched` fills `EnumValue` from the raw integer of enum symbols (C1).

- [ ] **Step 1: Implement backend and `serve`.**
- [ ] **Step 2: Build and run the whole test suite** — `dotnet test --solution cli/IECode.slnx` → PASS.
- [ ] **Step 3: Manual check against a local runtime** (TwinCAT in run mode with any PLC program; use symbols that exist there):
  ```powershell
  '{"id":1,"op":"read","symbols":["MAIN.bStart"]}' | iecode ads serve -t local
  ```
  Expected: `hello`, the `read` reply (not dropped although stdin closes at once, C3), exit 0. Then start `iecode ads serve -t local` interactively (stdin stays open), paste `{"id":1,"op":"watch","symbols":["MAIN.bStart","MAIN.nope"]}` → a `watch` reply with one item error for `MAIN.nope`, then `samples` events until Ctrl+Z / Enter, exit 0. Check once that the `0xF008` symbol-version read with length 1 succeeds and changes on a download (Copilot doubted the 1-byte length; adjust if the runtime says otherwise). Then download the PLC once while a session runs interactively → values continue after a short gap (Review Focus 1). Then stop TwinCAT (config mode) → `state connected:false`, and back to run → `connected:true` (Review Focus 2). Change a watched INT to REAL and download → an `items` event with the new type (O2 / R5). Write `'ÄÖÜ'` to a STRING and read it back unchanged (O8). Then `'' | iecode ads serve -t 1.2.3` → `hello`, then `state connected:false` with the NetId error, exit 0 (R3); and with a NetId that has no route → `state connected:false` within the ADS timeout, not an item error (R2).
- [ ] **Step 4: Commit** — `CLI: ads serve streams live PLC values over stdin/stdout`.

### Task 4: Extension core: host messages, sample buffer, tool text

**Files:**
- Create: `extension/src/core/adswatch.ts`
- Test: `extension/test/adswatch.test.ts`

**Interfaces – Produces:**
```ts
export const PROTOCOL = 1;
export interface WatchItem { symbol: string; type: string; numeric: boolean; error: string | null }
export type HostMessage =
  | { event: 'hello'; protocol: number }
  | { event: 'samples'; gen: number; rows: { t: number; v: (string | null)[]; e?: (number | null)[] }[] }   // O1: e = enum values, index-aligned, only when an item is an enum
  | { event: 'state'; connected: boolean; error?: string }
  | { event: 'items'; gen: number; items: WatchItem[] }                           // R5: AdsHost calls buffer.setItems
  | { id: number | null; ok: boolean; data?: unknown; error?: string; adsCode?: number };
export function parseHostLine(line: string): HostMessage | undefined;              // undefined for non-JSON lines
export function hostStartFailure(helloSeen: boolean, exitCode: number | null, elapsedMs: number): string | undefined;
//   'not installed' (ENOENT is handled by the caller), 'too old' (exit 2 or no hello after 10000 ms), undefined while fine
export function numericValue(text: string | null, enumValue?: number): number | undefined;  // TRUE/FALSE -> 1/0, numbers, TimeSpan "c" -> ms, enum -> its number (O1); NaN / Infinity -> undefined (O12)
export class ScopeBuffer {
  constructor(seconds: number, maxValues = 2_000_000);   // R8: rows x items capped; numeric items stored as numbers
  setSeconds(seconds: number): void;                     // C4: iecode.ads.bufferSeconds changed; shorter drops old rows now, longer keeps all
  span(): number;                                        // seconds actually held (less than `seconds` when the cap bites)
  setItems(gen: number, items: WatchItem[]): void;     // keeps the history of symbols that stay watched
  push(gen: number, rows: { t: number; v: (string | null)[]; e?: (number | null)[] }[]): void;   // drops rows of other gens and rows older than seconds; enum items plot `e` (C1)
  latest(symbol: string): { t: number; value: string | null } | undefined;   // O1: the raw text as received, kept per item apart from the numeric series
  series(symbol: string, fromMs: number): { t: number; y: number }[];
  summary(symbol: string, seconds: number, now: number): { min: number; max: number; last: string | null; count: number } | undefined;
}
export function minMaxBuckets(points: { t: number; y: number }[], buckets: number): { t: number; y: number }[];  // R9: min and max per bucket, keeps spikes
export function downsample<T>(rows: T[], max: number): T[];                       // keeps first and last, evenly spaced
export class PendingRequests {                                               // R7: reply id -> Promise, rejected on timeout or host exit
  add(id: number, timeoutMs: number): Promise<unknown>;
  settle(msg: { id: number | null; ok: boolean; data?: unknown; error?: string }): void;
  rejectAll(reason: string): void;
}
export function scopeText(buf: ScopeBuffer, symbols: string[], seconds: number, now: number, maxRows = 200): string;  // text for LM tools / AI chat
```

- [ ] **Step 1: Write the failing tests**: `parseHostLine` for each message kind and for `"Building…"` (→ `undefined`); `hostStartFailure(false, 2, 500) === 'too old'`, `(false, null, 10001) === 'too old'`, `(true, null, 60000) === undefined`, `(true, 2, 500) !== 'too old'` (R3); `numericValue('TRUE') === 1`, `('Running', 1) === 1`, `('NaN') === undefined`, `('Infinity') === undefined`; `latest()` after pushing `'18446744073709551615'` (ULINT), `'TRUE'` and `'00:00:01.5000000'` returns exactly those strings (O1); `('1.5') === 1.5`, `('00:00:01.5000000') === 1500`, `('abc') === undefined`; `ScopeBuffer` drops rows older than `seconds` and rows with a stale `gen`, keeps history of `MAIN.a` across `setItems` that only adds `MAIN.b`; `downsample` of 1000 rows to 200 keeps first and last and returns 200; `scopeText` for 10 000 rows contains min / max / last per symbol and at most 200 data rows; `ScopeBuffer` with `maxValues` 1000 and 10 items keeps 100 rows and `span()` reports their time span (R8); `setSeconds(10)` on a buffer holding 60 s drops everything older than 10 s, and `setSeconds(120)` afterwards keeps what is left (C4); a pushed enum row `v: ['Running'], e: [1]` gives `series` value `1` and `latest` `'Running'` (C1); `minMaxBuckets` of 30 000 points with one spike into 600 buckets keeps the spike and returns at most 1200 points (R9); `PendingRequests` (R7): a reply resolves its id, an unknown id is ignored, `rejectAll('host exited')` rejects every open request, a request with `timeoutMs` 20 rejects after 20 ms with a message that says the outcome is unknown.
- [ ] **Step 2: Run, expect FAIL** — `npm test` in `extension/`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `Extension: sample buffer and host messages for live ADS values`.

### Task 5: Host process and watchlist view

**Files:**
- Create: `extension/src/ads/host.ts`, `extension/src/views/adsWatch.ts`
- Modify: `extension/src/extension.ts` (register), `extension/package.json` (view `iecode.adsWatch` "ADS Watch" in the `iecode` container; commands; settings from Global Constraints except `aiWrites`; menus), `extension/README.md` (feature row)

**Interfaces:**
- Consumes: `runCli`'s helpers `useInstallDir`, `customCliPath`, `cliAvailable`, `output` from `src/cli/iecode.ts`; everything from Task 4.
- Produces (used by Tasks 6-7):
```ts
// src/ads/host.ts
export class AdsHost implements vscode.Disposable {
  static get(ctx: vscode.ExtensionContext): AdsHost;               // singleton; (re)starts on settings change
  readonly onSamples: vscode.Event<void>;                           // after buffer.push
  readonly onState: vscode.Event<{ connected: boolean; error?: string }>;
  readonly buffer: ScopeBuffer;
  items(): WatchItem[];
  watched(): string[];                                              // persisted in workspaceState 'iecode.adsWatch'
  setWatched(symbols: string[]): Promise<WatchItem[]>;
  read(symbols: string[]): Promise<{ symbol: string; type: string; value: string | null; error: string | null }[]>;
  write(symbol: string, value: string): Promise<string>;            // value read back
  setInterval(ms: number): Promise<void>;                           // sent on start and when iecode.ads.sampleIntervalMs changes
}
```
The host process starts on use (O11): when the ADS Watch view becomes visible with a non-empty list, when the scope is open, or when an LM tool or `read` / `write` needs it (also with an empty list, O7); it stops 30 s after the last of these ends, and when the window closes. Opening a workspace with a saved list does not connect by itself. Before spawning, the extension checks `iecode.ads.target` (`local` or six numbers) and `port` (1..65535) and shows a settings error instead of starting (O12). It is restarted on a change of `iecode.ads.target` / `port` (and re-sent the list); a change of `iecode.ads.bufferSeconds` calls `buffer.setSeconds` without a restart (C4). Spawn: `iecode ads serve -t <target> --port <port>` with `windowsHide`; stderr lines go to the `IECode` output channel. Every request goes through `PendingRequests` with a 10 s timeout (R7); on host exit or restart all open requests are rejected. A timed-out `write` says `Write of <symbol> timed out; the value may or may not have been written` and reads the symbol again on the next sample.

Commands (all with `category: "IECode"`): `iecode.adsWatchAdd` (QuickPick over the `.tmc` symbols of the workspace PLC projects via `fromBuild(plc, true)`, multi-select, plus "Enter a name…"), `iecode.adsWatchAddFromEditor` (editor context menu in ST views: word at cursor qualified with the object name for PROGRAM / GVL objects, else an input box prefilled with the word), `iecode.adsWatchRemove`, `iecode.adsWatchClear`, `iecode.adsWatchWrite` (input box prefilled with the current value; modal confirm `Write MAIN.x := 5 on <target>?` for every target, `local` included: on a machine PC the local runtime drives the real machine, C0), `iecode.adsWatchCopy` (value to clipboard). Tree items: label = symbol, description = value (or `⚠ error`), tooltip = type; the view message shows `Disconnected: <error>` when `connected` is false. Refresh the tree at most 4 × per second, not per sample event.

- [ ] **Step 1: Implement host and view, wire up `package.json`.**
- [ ] **Step 2: `npm test` → PASS** (compiles everything, existing tests green).
- [ ] **Step 3: Manual check (F5 Extension Host, local runtime):** add a symbol via picker and from the editor; value updates; write with confirm; set `iecode.ads.target` to an unreachable NetId → "Disconnected" message, no error popups in a loop; rename the CLI path to something missing → one error with "Install CLI" action (Review Focus 5).
- [ ] **Step 4: Commit** — `Extension: ADS watchlist view with live values and writes`.

### Task 6: Mini scope

**Files:**
- Create: `extension/src/views/adsScope.ts`
- Modify: `extension/src/extension.ts`, `extension/package.json` (command `iecode.adsScope` "Open ADS Scope", in the `iecode.adsWatch` view title), `extension/README.md`

**Interfaces:**
- Consumes: `AdsHost.get(ctx).buffer.series`, `onSamples`, `items()`.

One webview panel (pattern of `src/views/adsInterface.ts`: nonce, CSP, `retainContextWhenHidden`). A `<canvas>` line plot of all numeric watched items with a legend checkbox per series (hidden state in webview state), a time span select (10 s, 30 s, 1 min, 5 min; capped by `bufferSeconds`), Pause / Resume (stops redrawing, buffer keeps filling), auto-scaled Y axis per visible series set, cursor readout of time and values. The extension posts the visible window's series at most 10 × per second, each reduced with `minMaxBuckets` to the canvas width the webview reports (R9); the span select is capped by `buffer.span()` (R8); BOOL is drawn as a step line.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: `npm test` → PASS.**
- [ ] **Step 3: Manual check:** a sine / counter variable plots smoothly at 100 ms for 5 min; switching the span keeps the history; hiding a series rescales; with 20 symbols at 10 ms the window stays responsive.
- [ ] **Step 4: Commit** — `Extension: mini scope for watched ADS values`.

### Task 7: Language model tools and AI chat

**Files:**
- Create: `extension/src/ads/lmTools.ts`
- Modify: `extension/package.json` (`engines.vscode` `^1.95.0`; the README names the VS Code version whose Copilot agent mode calls extension tools (O12), devDependency `@types/vscode` `1.95.0`, `contributes.languageModelTools`, setting `iecode.ads.aiWrites`, context menu `iecode.adsWatchAiChat` "Add to AI Chat" on the view title), `extension/src/extension.ts`, `extension/src/core/adswatch.ts` (+ tests in `extension/test/adswatch.test.ts`), `extension/README.md`

**Interfaces:**
- Consumes: `AdsHost` (Task 5), `scopeText`, `downsample` (Task 4), `sendToAiChat` from `src/commands/aiChat.ts`.
- Produces: tools (`name` / `toolReferenceName`, all `canBeReferencedInPrompt: true`, input schemas as below):
  - `iecode_ads_symbols` / `adsSymbols` `{ filter: string }` → matching names + types from the `.tmc` of the workspace PLC projects (max 100).
  - `iecode_ads_watch` / `adsWatch` `{ add?: string[]; remove?: string[] }` → the resulting watch list with types and errors.
  - `iecode_ads_read` / `adsRead` `{ symbols?: string[] }` → current values; watched ones from the buffer, others by a one-off `read`.
  - `iecode_ads_scope` / `adsScope` `{ symbols?: string[]; seconds?: number }` → `scopeText` (default all watched, 60 s).
  - `iecode_ads_write` / `adsWrite` `{ symbol: string; value: string }` → with `aiWrites` `off`: no write, result text says how to enable it; with `confirm`: `prepareInvocation` returns `confirmationMessages` (`Write <symbol> := <value> on <target>?`); with `auto`: IECode asks nothing (`prepareInvocation` returns no `confirmationMessages`), VS Code's own tool-approval rules still apply and may show their generic confirmation (R6). VS Code lets the user pick "Always Allow" for a tool, which would also silence `confirm`: if the 1.95 API has no way to keep a tool from being auto-approved, the README states that `confirm` relies on the user not choosing "Always Allow" for `adsWrite`, and the tool description and the `enumDescriptions` entry of `confirm` in the setting say so too (C6). The result is the value read back. Every AI write (also `auto`) is logged to the `IECode` output channel as `AI write <symbol> := <value> on <target>`.
  - Command `iecode.adsAiWrites` "Set AI Write Access…" (QuickPick `Off` / `Confirm each write` / `Auto-approve`, writes the setting globally) in the `iecode.adsWatch` view title; the view description shows `AI writes: auto` while auto-approve is on, so it is never on unnoticed.

Add to `adswatch.ts` and test: `aiWriteDecision(setting: string): 'refuse' | 'confirm' | 'allow'` (`confirm` → `confirm`, `auto` → `allow`, anything else → `refuse`), and `watchEdit(current: { symbol: string; ai: boolean }[], add: string[] = [], remove: string[] = [], byAi = false)` (no duplicates, case-insensitive match on remove, keeps order; with `byAi` new entries are marked `ai` and `remove` only drops `ai` entries, O10). The view shows AI-added entries with a sparkle icon.

"Add to AI Chat" on the watch view sends `scopeText` of all watched symbols over the last 60 s via `sendToAiChat`.

- [ ] **Step 1: Write the failing tests** for `aiWriteDecision` (`'off'` → `refuse`, `'confirm'` → `confirm`, `'auto'` → `allow`, `'bogus'` → `refuse`) and `watchEdit` (user: `[a]` + add `[a, b]` − remove `[A]` → `[b]`; AI: remove of a user entry is ignored, remove of its own entry works) (O10).
- [ ] **Step 2: Run, expect FAIL** — `npm test`.
- [ ] **Step 3: Implement** the two functions, then `lmTools.ts` with `vscode.lm.registerTool` per tool.
- [ ] **Step 4: `npm test` → PASS.**
- [ ] **Step 5: Manual check in Copilot Chat (agent mode):** "watch MAIN.nCounter and tell me how it changed in the last 30 s" uses `adsWatch` + `adsScope`; "set MAIN.bStart to TRUE" is refused with `aiWrites` `off`, asks for confirmation with `confirm`, writes without an IECode prompt with `auto` (and the view shows `AI writes: auto`); note whether VS Code itself still asks, and whether "Always Allow" bypasses `confirm`, and make the README match what you saw (R6).
- [ ] **Step 6: Commit** — `Extension: language model tools for live ADS values`.

### Task 8: Docs and TODO

**Files:**
- Modify: `extension/CHANGELOG.md` (new section *ADS watchlist*), `TODO.md` (tick the ADS item, link this plan, list what is left: MCP server, notifications, AI write allowlist), `README.md` if the feature table needs a row.

- [ ] **Step 1: Update the docs.**
- [ ] **Step 2: `npm test` and `dotnet test --solution cli/IECode.slnx` → PASS.**
- [ ] **Step 3: Commit** — `Docs: ADS watchlist, scope and AI tools`.

---

# Eng review (/plan-eng-review, 2026-11-02)

Target: `docs/superpowers/plans/2026-11-02-ads-watchlist.md` (this file). Report file: this file.

## Scope record

feature answers: none (no cuts proposed); structure: A (Original arrangement, D3); accepted scope: Tasks 1-8 as written; pending remedies: R1-R7.

## Decision ledger

### R1: `iecode.ads.aiWrites` setting scope
Finding: 1, CRITICAL, confidence 9, plan line 33 (`scope window / user, not workspace`), reviewer: Claude.
Plan baseline: `"scope": "window"`, original proposal.
Runtime evidence: VS Code `window` scope settings can be set in workspace `.vscode/settings.json`; only `application` (user settings) and `machine` (user/remote) exclude the workspace. Repo precedent: `extension/package.json:963` gives `iecode.cliPath` `"scope": "machine"`.
Comparison grid: | R1 | window (pending) | A: application | B: window |
Question D4: see chat brief D4. Options: A) application scope (recommended); B) keep window.
State: approved
Actual answer: A (D4, 2026-11-02)
Accepted scope: plan amended as option A describes (Global Constraints / Review Focus / Tasks 2-4)

### R2: classify ADS errors and probe the connection
Finding: 2, CRITICAL, confidence 8, plan line 162 (`Map AdsErrorException → AdsFault(connectionLost: false)`), reviewer: Claude.
Plan baseline: every `AdsErrorException` = not a connection loss; `Connect()` assumed to fail when the target is down.
Runtime evidence: `cli/src/IECode.Automation/Target.cs:110` shows the existing code also lumps all `AdsErrorException`s. Unreachable targets surface as `AdsErrorException` codes (target port/machine not found 0x6/0x7, client sync timeout 0x745), and `AdsClient.Connect` only opens the local router port. Unknown codes (e.g. 0x705) have no defined host reaction.
Comparison grid: | R2 | all AdsErrorException non-connection (pending) | A: code table (0x6, 0x7, 0x745, 0x746..0x74A router/port codes) → connectionLost; Connect probes ReadState; other codes → per-item error, keep polling; tests | B: as written |
Question D5: see chat brief D5. Options: A) code table + probe (recommended); B) as written.
State: approved
Actual answer: A (D5, 2026-11-02)
Accepted scope: plan amended as option A describes (Global Constraints / Review Focus / Tasks 2-4)

### R3: invalid target misreported as "CLI too old"
Finding: 3, CRITICAL, confidence 9, plan lines 42 / 190 (`exit 2 … means too old`), reviewer: Claude.
Plan baseline: exit 2 before `hello` = too old.
Runtime evidence: `cli/src/IECode.Core/AmsNetId.cs:36` throws `ExitCodes.Usage` (2) for a bad NetId; `Runner.cs` maps parse errors to 2 too. A typo in `iecode.ads.target` therefore shows "update the CLI".
Comparison grid: | R3 | exit 2 = too old (pending) | A: `serve` emits `hello` before parsing target/port; bad target → `state connected:false` with the NetId error, host keeps waiting for EOF; extension test `hostStartFailure(true, 2, …)` ≠ too old | B: as written |
Question D6: see chat brief D6. Options: A) hello first (recommended); B) as written.
State: approved
Actual answer: A (D6, 2026-11-02)
Accepted scope: plan amended as option A describes (Global Constraints / Review Focus / Tasks 2-4)

### R4: sum read access mode
Finding: 4, INFORMATIONAL, confidence 6, plan line 162 (`one TwinCAT.Ads.SumCommand.SumSymbolRead`), reviewer: Claude.
Plan baseline: access mode unspecified.
Runtime evidence: unknown; not verified against Beckhoff.TwinCAT.Ads 7.0.389 docs. If the default reads by index group/offset, a download does not raise 0x710/0x711 and stale addresses return other data for up to 1 s (the symbol-version poll).
Comparison grid: | R4 | unspecified (pending) | A: verify mode in Task 3, use handle access so 0x710/0x711 fire; check symbol version every tick before publishing a row | B: as written |
Question D7: see chat brief D7. Options: A) verify + handle access (recommended); B) as written.
State: approved
Actual answer: A (D7, 2026-11-02)
Accepted scope: plan amended as option A describes (Global Constraints / Review Focus / Tasks 2-4)

### R5: types can change on re-resolve, `gen` stays
Finding: 5, INFORMATIONAL, confidence 7, plan line 142 (`gen unchanged (same symbols)`), reviewer: Claude.
Plan baseline: re-resolve after dead handles / version change keeps `gen`, no new item list is sent.
Runtime evidence: a download can change `MAIN.x` from INT to REAL or delete it; the extension keeps the old `type` / `numeric` / `error` (unknown in code, proposal only).
Comparison grid: | R5 | gen kept, items not re-sent (pending) | A: re-resolve with different items → new `gen` + unsolicited `{"event":"items","gen":n,"items":[…]}`; same items → `gen` kept; test `WatchHost_ResolvesAgain_TypeChanged_NewGen` | B: as written |
State: approved
Actual answer: A (D8, 2026-11-02)
Accepted scope: plan amended as option A describes (Tasks 2, 4, 5, 7)

### R6: AI write modes vs. VS Code's own tool approval
Finding: 6, INFORMATIONAL, confidence 7, plan line 272 (`with auto: no confirmation, written at once`), reviewer: Claude.
Plan baseline: `auto` writes without any prompt; `confirm` asks every write.
Runtime evidence: VS Code tool docs (code.visualstudio.com/api/extension-guides/ai/tools): without `confirmationMessages` VS Code shows a generic confirmation, and the user can pick "Always Allow" for a tool, which also skips the `confirm` prompt.
Comparison grid: | R6 | auto = no prompt, confirm = every write (pending) | A: redefine: `off` refuse; `confirm` = our confirmation every call, tool marked so the chat cannot auto-approve it where the API allows, else documented; `auto` = no IECode confirmation, VS Code's approval rules decide; README + manual check say so | B: as written |
State: approved
Actual answer: A (D9, 2026-11-02)
Accepted scope: plan amended as option A describes (Tasks 2, 4, 5, 7)

### R7: no request timeout in AdsHost
Finding: 7, INFORMATIONAL, confidence 7, plan lines 228-231 (`read`/`write`/`setWatched` return Promises), reviewer: Claude.
Plan baseline: Promises resolve on the matching reply id; no timeout, no reject on host exit.
Runtime evidence: the host loop is single-threaded (plan line 162); an ADS call to a dead target blocks up to the ADS timeout (5 s default), and a host crash leaves pending ids. Unknown in code.
Comparison grid: | R7 | none (pending) | A: reject pending requests on host exit/restart and after 10 s; LM tools and the write command show the error | B: as written |
State: approved
Actual answer: A (D10, 2026-11-02)
Accepted scope: plan amended as option A describes (Tasks 2, 4, 5, 7)

### R8: sample buffer memory at the setting maxima
Finding: 8, INFORMATIONAL, confidence 8, plan lines 31-34 (interval min 10 ms, buffer max 3600 s, 200 symbols), reviewer: Claude.
Plan baseline: `ScopeBuffer` keeps every row as `(string | null)[]` for `bufferSeconds`.
Runtime evidence: arithmetic [estimated]: 3600 s / 0.01 s = 360 000 rows × 200 values = 72 M strings in the extension host, several GB. Defaults (100 ms, 300 s): 3 000 rows × 200 = 600 k, fine.
Comparison grid: | R8 | unbounded by product (pending) | A: cap stored values at 2 M (rows × items); above that the buffer keeps fewer seconds and the scope's span select shows the real span; numeric items stored as numbers, strings only for non-numeric; test in ScopeBuffer | B: as written |
State: approved
Actual answer: A (D11, 2026-11-02)
Accepted scope: plan amended as option A describes (Tasks 4, 6)

### R9: scope payload to the webview
Finding: 9, INFORMATIONAL, confidence 7, plan line 252 (`posts the visible window's series at most 10 × per second`), reviewer: Claude.
Plan baseline: full series of the visible window, 10 × per second.
Runtime evidence: [estimated] 5 min at 10 ms = 30 000 points per series × 20 series × 10 posts/s = 6 M points/s through postMessage.
Comparison grid: | R9 | full series (pending) | A: downsample each series to ~2 × canvas width (min/max per pixel bucket so spikes survive) before posting; webview reports its width; test for min/max bucketing in adswatch.test.ts | B: as written |
State: approved
Actual answer: A (D12, 2026-11-02)
Accepted scope: plan amended as option A describes (Tasks 4, 6)

### O1-O12: outside-voice findings (Claude Plan subagent, native fallback; Codex not installed)
Finding source: outside voice, 15 findings. Runtime evidence: O8 verified (`cli/src/IECode.Cli/Program.cs:13` sets only `Console.OutputEncoding`); O5 verified (`Target.cs:41` passes `sym.DataType?.Name`); others from plan text, unverified at runtime.
- O1 value text vs numeric storage / enums — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O2 new symbol loader on re-resolve — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O3 per-item sum read errors — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O5 PlcOpen/alias conversion shared in Task 1 — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O4 MCP / Claude Code reach — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O6 `ads read --json` value type — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O10 AI may remove user's watch items — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O11 autostart in every window — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O7 host on demand for read/write — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O8 UTF-8 stdin — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O9 real read timestamps + documented minimum — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)
- O12 small fixes (port parse, tick off-by-one, NaN filter, VS Code version note) — State: approved, A (D13-D23, 2026-11-02); O7 covered by O11 (D20)

### C0-C6: second opinion (GitHub Copilot CLI, model "auto", 2026-11-02)
Finding source: external model, 8 findings; 7 applied, 1 turned into a manual check. Each checked against the plan and the code before applying.
- C0 [CRITICAL] Task 5 — UI write skipped the confirmation on `local`; the local runtime of a machine PC drives the real machine. Applied: confirm on every target.
- C1 [MEDIUM] Tasks 2/4 — Task 4 expects enum numbers `e` in `samples`, Task 2 never sent them. Applied: `e` in the protocol, `EnumValue` in `ReadWatched`, tests on both sides.
- C2 [MEDIUM] Task 1 — `Target.Read` returning text would break O6's typed `value` (`Target.cs:37` returns `object?`). Applied: `Read` returns type, typed value and text.
- C3 [MEDIUM] Task 3 — EOF could drop requests queued before it, and the manual check piped stdin but expected samples. Applied: drain before stop, interactive manual check.
- C4 [MINOR] Tasks 4/5 — `bufferSeconds` change had no defined effect. Applied: `ScopeBuffer.setSeconds`, no host restart.
- C5 [MINOR] Tasks 2/3 — the R2 code table was manual-only. Applied: `AdsCodes` in Core with unit tests.
- C6 [MINOR] Task 7 — the setting text of `confirm` still promised a prompt on every write. Applied: `enumDescriptions` names the "Always Allow" limit.
- Not applied: symbol version `0xF008` would be 4 bytes, not 1 (Copilot marked it unsure; it is 1 byte as far as known). Task 3 manual check verifies the length.

Approval readiness: PASS (R1-R9: D4-D12; O1-O12: D13-D23; O7 via D20; C0-C6 applied; all 2026-11-02).

## Review body

**Scope Challenge:** scope accepted as-is (structure D3). Reality rows: premise-table pass (claims checked against `Target.cs`, `Runner.cs`, `Reporter.cs`, `AmsNetId.cs`, `package.json:963`; unverified=2: R4 access mode, R2 code list, both get a check in Task 3); already-done pass (`origin/main` has no `ads serve` / `languageModelTools`); surface-check finding (R3: `-t` parse exit 2); binding-decisions pass (LM tools over MCP kept, O4 only corrects the claim); numbers finding (R8/R9 estimates, marked [estimated]); deferred-asks pass (TODO.md item fully covered, MCP / notifications / allowlist listed as left); pr-count pass (one PR).

**Findings (all approved, folded into the plan above):**
- [CRITICAL] (9/10) plan:33 — `window` scope lets a workspace turn on AI auto-writes → R1
- [CRITICAL] (8/10) plan:162 / `Target.cs:110` — all `AdsErrorException`s treated as connected; `Connect` is local only → R2
- [CRITICAL] (9/10) `AmsNetId.cs:36` — bad target exits 2 before `hello`, shown as "CLI too old" → R3
- [INFORMATIONAL] (6/10) plan:162 — sum read access mode may not raise 0x710/0x711 after a download → R4
- [INFORMATIONAL] (7/10) plan:142 — changed types after re-resolve keep the old `gen` → R5
- [INFORMATIONAL] (7/10) plan:272 — `auto` / `confirm` promise behaviour VS Code's tool approval overrides → R6
- [INFORMATIONAL] (7/10) plan:228 — no request timeout; host crash hangs tool calls → R7
- [INFORMATIONAL] (8/10) plan:31-34 — buffer at setting maxima ~72 M values → R8
- [INFORMATIONAL] (7/10) plan:252 — full series posted to the webview 10 × / s → R9
- Outside voice (Claude Plan subagent; Codex not installed): 15 findings → O1-O12, all applied.

**Test coverage (planned):**
```
CODE PATHS                                          USER FLOWS
[+] PlcValueText (Core)                             [+] Watch a symbol
  ├── [★★★ PLANNED] format/parse, comma, overflow     ├── [MANUAL] picker / editor add, live value
  └── [★★  PLANNED] ads read alias/TIME (manual O5)   └── [MANUAL] write with confirm
[+] WatchHost (Core, fake backend)                  [+] Download while watching
  ├── [★★★ PLANNED] hello, gen, 200 cap, bad JSON     └── [MANUAL] values continue, items event (O2/R5)
  ├── [★★★ PLANNED] dead handle, version, type chg  [+] Target down / bad target
  ├── [★★★ PLANNED] mixed row (O3), other code (R2)   ├── [MANUAL] disconnected → reconnect
  └── [★★★ PLANNED] lost connection + retry            └── [★★ PLANNED] hostStartFailure (R3)
[+] AdsWatchBackend (Automation)                    [+] AI tools
  └── [MANUAL ONLY] code table, handles, UTF-8        ├── [★★ PLANNED] aiWriteDecision, watchEdit byAi
[+] adswatch.ts (extension core)                      └── [MANUAL] off / confirm / auto in Copilot
  ├── [★★★ PLANNED] parseHostLine, numericValue, NaN
  ├── [★★★ PLANNED] ScopeBuffer cap, latest raw text
  ├── [★★★ PLANNED] minMaxBuckets, downsample, scopeText
  └── [★★★ PLANNED] PendingRequests timeout / exit
[GAP] AdsWatchBackend has no automated test: needs a TwinCAT runtime; covered by the Task 3 manual check.
COVERAGE: unit-testable paths all planned; backend and VS Code UI manual only.
```
Test plan artifact: local gstack project folder (`~/.gstack/projects/…`), outside the repo.

**Failure modes:** target lost → `state` event + view message (R2, tested in fake); download → re-resolve with new loader (O2, manual); bad item → item error (O3, tested); host crash → pending requests rejected (R7, tested); memory blow-up → cap (R8, tested). Critical gaps (no test, no handling, silent): 0.

**NOT in scope:** MCP server (O4: would be served by the extension), ADS notifications, AI write allowlist, struct/array writes, online symbol browser (all as in the plan).

**What already exists:** `Target.Convert` (replaced by `PlcValueText`), `fromBuild` in `core/adsinterface.ts` (symbol picker), `sendToAiChat` in `commands/aiChat.ts`, `useInstallDir` / `customCliPath` / `output` in `cli/iecode.ts` (note: `cliPath()` is private; use `customCliPath() ?? 'iecode'`), webview pattern of `views/adsInterface.ts`.

**Parallelization:** Lane A: Task 1 → 2 → 3 (cli/). Lane B: Task 4 (extension/src/core, protocol from Task 2's text) → 5 → 6 → 7. Launch A + B together; Task 5's manual check waits for Task 3. Task 8 last. Conflict flag: README files touched by Tasks 3, 5, 6, 7, 8.

## Implementation Tasks
Synthesized from this review's findings; all already folded into Tasks 1-8 above.

- [ ] **T1 (P1, human: ~2h / CC: ~20 min)** — CLI — classify ADS codes, probe with ReadState, new loader on re-resolve, per-item read results (R2, O2, O3). Verify: WatchHost tests + Task 3 manual check.
- [ ] **T2 (P1, human: ~30 min / CC: ~5 min)** — CLI — `hello` before target parsing, UTF-8 stdin (R3, O8). Verify: `'' | iecode ads serve -t 1.2.3`.
- [ ] **T3 (P1, human: ~1h / CC: ~10 min)** — CLI — `AdsValues` helper in Task 1, typed `value` + `text` (O5, O6). Verify: `ads read` of TIME / alias.
- [ ] **T4 (P1, human: ~5 min / CC: ~1 min)** — extension — `aiWrites` `"scope": "application"` (R1).
- [ ] **T5 (P2, human: ~4h / CC: ~30 min)** — extension core — raw text + enum numbers, buffer cap, min/max buckets, PendingRequests, NaN filter (O1, R8, R9, R7, O12). Verify: `npm test`.
- [ ] **T6 (P2, human: ~2h / CC: ~15 min)** — extension — start on use, settings check, AI-only remove, approval semantics docs (O11, O7, O12, O10, R6, O4). Verify: Task 5/7 manual checks.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native fallback (Claude Plan subagent; Codex not installed) | Independent 2nd opinion | 1 | unavailable (in-host completed) | 15 findings, all applied |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (all mapped to tasks) | 5 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** Codex plan-review phase unavailable (CLI not installed); native Claude Plan subagent completed with 15 findings, all approved and applied. No external-model coverage.
- **VERDICT:** No review CLEAR yet; eng review findings all resolved into the plan, status issues_open by count rule. Scope Challenge 4 findings (R1-R4) reported separately.

NO UNRESOLVED DECISIONS
