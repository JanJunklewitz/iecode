# ADS MCP Server for Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code gets the five ADS tools (symbols, watch, read, scope, write) of the Copilot tools through an MCP server that the extension serves on `127.0.0.1`.

**Architecture:** The tool logic moves out of `lmTools.ts` into shared functions used by both the Copilot tools and a new MCP server. Pure, VS Code-free modules in `extension/src/core/` hold the protocol layer, input validation, the write gate (queue, binding, cancellation, outcomes) and the Claude registration helpers, so they are unit-tested with `node --test`. Thin VS Code modules in `extension/src/ads/` wire them to `node:http`, `SecretStorage`, `workspaceState`, dialogs and the `claude` CLI.

**Tech Stack:** TypeScript 5.9, VS Code API 1.95, `node:http`, `node:crypto`, `node:child_process`, `node:test`. No runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-11-03-ads-mcp-server-design.md](../specs/2026-11-03-ads-mcp-server-design.md)

> **Status after the eng review of 2026-11-03 (D20, D21):** the transport changes from HTTP with per-folder local registration to a user-scope stdio bridge (`claude mcp add -s user iecode -- iecode mcp`) that finds the window serving its cwd through a discovery file. Tasks 2-5 are reviewed and ready to build. Tasks 1 and 6-8 (and the Connect parts of Task 9) describe the old HTTP design and are **not to be built** until the spec has been revised for the bridge and the new tasks have had their own eng review. See "Decision ledger" R18 for which review decisions carry over.
>
> **Status after the second opinion of 2026-11-03 (R19-R29):** a cross-model review found that a failed read-back after a successful write would be reported as "Not written" (R19). Task 2b (CLI) was added for it; Tasks 2-5 were tightened (R20-R29). Tasks 2, 2b, 3, 4 and 5 are ready to build in this order of lanes (see "Worktree parallelization strategy").

## Global Constraints

These hold for every task. Items marked **(HTTP, superseded)** describe the HTTP design and apply only to the not-yet-rewritten Tasks 1 and 6-8; Tasks 2-5 must not implement them.

- No runtime dependencies: plain `tsc -p .`, packaged with `vsce package --no-dependencies` (unless Task 1 decides otherwise and the user agrees).
- Public repository: no internal names, links, machine names or data in code, tests, docs or commits. Commits use the GitHub noreply author address, `git commit -s`, subject plus a 1-3 sentence why-body, English.
- MCP server name `iecode`, tool names `ads_symbols`, `ads_watch`, `ads_read`, `ads_scope`, `ads_write`.
- **(HTTP, superseded)** Server binds `127.0.0.1` only, path `/mcp`.
- **(HTTP, superseded)** Every request needs `Authorization: Bearer <token>` (else 401, no details); any `Origin` header → 403; `Host` other than `127.0.0.1:<port>` / `localhost:<port>` → 403; body over 1 MB → 413.
- **(HTTP, superseded)** Token: 32 random bytes per workspace in `SecretStorage`, new at every server start (R13), never logged, constant-time compare, deleted on Disconnect.
- `iecode.ads.aiWrites` is read from the user settings only (`aiWritesSetting()`); `auto` confirms while `workspaceTarget()` is true.
- Approval deadline for a write dialog: 2 min at most; every write also has an operation deadline counted from its arrival (R24). Both are injected into the gate, not hard-coded (R24). Sampling stays demand-driven (no lease held by a connected Claude).
- A write is reported as "Not written" only with proof that nothing reached the PLC; everything else is "written" or "outcome unknown" (R19).
- Copilot's "Always Allow" can skip Copilot's confirmation (README "Known limits"); the per-write confirmation guarantee holds for MCP writes and for Copilot only while the user has not chosen "Always Allow" (R27).
- Only a local Windows extension host (`vscode.env.remoteName === undefined`, `process.platform === 'win32'`).
- Tests: `cd extension && npm test` (PowerShell tool for anything `dotnet`; never run heavy builds in parallel). Baseline before this plan: 173 extension tests green.

## Review Focus

1. Target or port changed while a write dialog is open → the write is not sent and Claude is told why (Task 4 test `gate refuses when the target changed during approval`).
2. Claude interrupted while the dialog is open, user clicks "Write" afterwards → nothing written (Task 4 test `gate writes nothing after cancellation`, Task 6 test `response close before reply cancels the operation`).
3. Write timed out after sending → "outcome unknown", text says not to retry (Task 3 test `write reports unknown outcome on timeout`, Task 4 outcome text test).
4. Malformed JSON or wrong argument types from HTTP → error result, extension host keeps running (Task 5 tests, Task 6 `invalid JSON gives parse error`).
5. View closed, Claude asks for the scope a minute later → a gap note naming the view and scope (Task 2 test `gap note when the newest sample is old`).
6. Write succeeded on the PLC, read-back failed → "Written … could not be read back", never "Not written" (Task 2b test `Write_reports_a_failed_read_back`, Task 3 test `write outcome after a failed read-back`).
7. Gate disposed while the host is still starting → nothing is sent after the start (Task 4 test `gate sends nothing when disposed during the host start`).

---

### Task 1: Go/no-go spike (throwaway)

> Rewrite for the stdio bridge (D20/D21) before building: the spike must test a stdio server registered at user scope; R17's timeout check carries over.

Not merged. Answers the open spike questions of the spec; its findings decide Task 6's transport details and the SDK question.

**Files:**
- Create (scratchpad, not in the repo): `spike-mcp.js`, a ~80-line `node:http` server: bearer check, logs every request (method, all headers, body) to stdout, answers `initialize`, `tools/list` (one tool `ping_tool` that sleeps `seconds` then returns "pong"), `tools/call`, `notifications/*` with 202.
- Modify: this plan, section "Spike results" at the end (commit only that).

- [ ] **Step 1: Run the spike server** on a fixed port with a random token: `node spike-mcp.js 47123 <token>`.
- [ ] **Step 2: Register it in the terminal Claude Code:** `claude mcp add --transport http --scope local spike http://127.0.0.1:47123/mcp --header "Authorization: Bearer <token>"`; run `claude mcp list`. Expected: `spike` connected.
- [ ] **Step 3: Call the tool from the terminal Claude** (`claude -p "call ping_tool with seconds 1"`), then a long call (`seconds 120`) interrupted with Esc in an interactive session. Record: protocol version in `initialize` / `MCP-Protocol-Version` header, methods sent, `Accept` header, whether `notifications/cancelled` arrives, whether the HTTP connection closes, Claude's tool timeout.
- [ ] **Step 4: Ask the user to repeat Step 3 in the Claude Code VS Code extension** (same workspace folder, `/mcp` shows `spike`). Record whether the OAuth probe (anthropics/claude-code#46640) appears and whether the call works.
- [ ] **Step 4b (R17): Path and output checks.** Register from Node (`child_process.spawn` of the absolute `claude` path) with a lower-case drive cwd (`c:\…`), then start Claude from PowerShell in that folder and in a subfolder: is `spike` listed? Record `claude mcp get spike` output with the server up and down, and with a user-scope `spike` entry added as well (which one does it show?); save the outputs as the fixture for Task 8's `registeredPort` test. Record Claude's MCP tool timeout from Step 3; Task 4 uses `min(120 s, timeout - 10 s)` as `deadlineMs`.
- [ ] **Step 5: Remove the registration** (`claude mcp remove --scope local spike`), stop the server.
- [ ] **Step 6: Write "Spike results" into this plan:** Claude Code versions (terminal and extension), revision(s) seen, the transport checklist for Task 6 (HTTP methods, required response headers, version negotiation, notification handling, cancellation signal), and the decision hand-written vs. SDK. If either client fails to connect: stop and ask the user for the fallback (stdio bridge, SDK with bundler, terminal only) before Task 6.
- [ ] **Step 7: Commit** the plan update: `Docs: results of the MCP spike for the ADS server`.

---

### Task 2: Shared ADS tool functions

Moves the tool logic out of `lmTools.ts` so Copilot and MCP share it; adds the age and gap notes.

**Files:**
- Create: `extension/src/ads/adsTools.ts`, `extension/src/core/adsToolText.ts` (R10: pure text builders)
- Modify: `extension/src/ads/lmTools.ts` (Copilot tools become thin wrappers), `extension/src/core/adswatch.ts` (pure text helpers)
- Test: `extension/test/adswatch.test.ts`, `extension/test/adsToolText.test.ts` (R10)

**Interfaces:**
- Produces (core, pure): `export function sampleAge(newestMs: number | undefined, nowMs: number): string | undefined` — `undefined` under 2000 ms, else `"<n> s old"`; `export function gapNote(newestMs: number | undefined, nowMs: number, clock: (ms: number) => string): string | undefined` — `undefined` under 2000 ms; else `"No samples since <clock(newest)>: sampling only runs while the ADS Watch view or the ADS Scope is open."` (newest undefined: `"No samples yet: sampling only runs while the ADS Watch view or the ADS Scope is open."`).
- Produces (ads): `export interface ToolText { text: string; isError?: boolean }` and `export interface ToolNames { watch: string; scope: string; write: string }` and `export function adsTools(ctx: vscode.ExtensionContext, state: WorkspaceState, names: ToolNames): { symbols(i: SymbolsInput): Promise<ToolText>; watch(i: WatchInput): Promise<ToolText>; read(i: ReadInput): Promise<ToolText>; scope(i: ScopeInput): ToolText; host: AdsHost }` with `SymbolsInput`, `WatchInput`, `ReadInput`, `ScopeInput` exported from `adsTools.ts` (same shapes as in `lmTools.ts` today). Write is not in here (Task 4).

- [ ] **Step 1: Write failing tests** `sampleAge formats old samples` (`sampleAge(1000, 2500) === undefined`, `sampleAge(1000, 13_400) === '12 s old'`, `sampleAge(undefined, 5) === undefined`) and `gap note when the newest sample is old` (`gapNote(0, 61_000, () => '10:00:00')` equals the text above with `10:00:00`; `gapNote(60_000, 61_000, …) === undefined`; `gapNote(undefined, 1, …)` is the "No samples yet" text).
- [ ] **Step 1b (R10): Write golden tests** in `test/adsToolText.test.ts` for the watch list text, the symbols listing, the read rows and the scope summary, with expected strings taken from the current `lmTools.ts:39-59,72-95,128-141` (same inputs → same text), plus `scope uses the gap note`, `read appends the sample age`, `scope table keeps 20 symbols` and `tool text is cut at the limit` for the intended changes (R11: at most 20 symbols in the scope table with summaries for all, every result cut at 50 000 characters with "(output truncated: ask for fewer symbols or a shorter time span)" by `capText`; the 50 000 include the marker, test `capText result never exceeds the limit`). R25 adds golden cases for an empty scope, a scope without samples, a read of watched and unwatched symbols mixed, a read with `null` value and with an error, and a watch call that partly fails (its text keeps the partial state and is `isError`).
- [ ] **Step 2: Run** `cd extension && npm test`. Expected: the new tests fail (not exported).
- [ ] **Step 3: Implement** `sampleAge` and `gapNote` in `core/adswatch.ts`; move `list`, `newest`, `scopeSummary`, `watchedName` and the four invoke bodies from `lmTools.ts` into `adsTools.ts` returning `ToolText` (`failure(e)` → `{ text: errorText(e), isError: true }`). Scope: replace the existing "may have stopped" clause with `gapNote` (clock: `new Date(ms).toLocaleTimeString()`). Read: for a value taken from the buffer, append ` (<sampleAge>)` when defined; a value read back by a write (`host.value()` from the written cache) has no time and gets no age (O15). `lmTools.ts` wraps each with `text(r.text)`; its write tool is unchanged in this task.
- [ ] **Step 3b (R10, R15):** the text builders live in `core/adsToolText.ts` and take plain data (items, entries, latest values with time, sample interval, target, now) plus `names: { watch, scope, write }` (Copilot: `adsWatch` / `adsScope` / `adsWrite`, MCP: `ads_watch` / `ads_scope` / `ads_write`); the golden tests run with both name sets; `adsTools.ts` reads `AdsHost` and the settings and calls them. Each client creates its own `adsTools(…, names)` wrapper; state (watch list, buffer, host) stays shared because it lives in the `AdsHost` singleton (R25). Check the "Add to AI Chat" command and any other caller of the moved helpers (`grep -rn "scopeSummary\|watchedName" extension/src`) and point it to the new module.
- [ ] **Step 4: Run** `npm test`. Expected: all green (173 + the new tests).
- [ ] **Step 5: Commit** `Extension: ADS tool logic shared for Copilot and MCP` (why: MCP needs the same behaviour; one implementation keeps them from drifting).

---

### Task 2b: Write stages in `ads serve` (CLI, R19)

Today `AdsWatchBackend.Write` (`cli/src/IECode.Automation/AdsWatchBackend.cs:177-182`) writes and then reads back inside one call. A failed read-back makes `WatchHost.Handle` reply `ok:false`, although the PLC already took the value. The host must say how far a write got.

**Files:**
- Modify: `cli/src/IECode.Core/Ads/WatchProtocol.cs` (reply fields), `cli/src/IECode.Core/Ads/WatchHost.cs` (`DoWrite`, error reply of a write), `IWatchBackend.Write` (`WatchProtocol.cs:14-26`), `cli/src/IECode.Automation/AdsWatchBackend.cs` (`Write`), `cli/src/IECode.Automation/AdsLink.cs:105` only if parsing must be split from `WriteValue`, `cli/README.md` ("Live values" protocol)
- Test: `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/FakeLink.cs` (fail the read after a write)

**Interfaces (additive, no protocol bump):**
- Backend: `Write(symbol, text)` returns `(string? Value, string? ReadBackError)`; it throws `WriteNotSentException` (new, `IECode.Core.Ads`) for every failure known to happen before the ADS write request leaves: symbol not found, not a single value, the value text does not parse for the type. A failure of the ADS write call itself stays an `AdsFault` / exception (sent or not is unknown).
- Reply of `op:"write"`:
  - write and read-back done: `ok:true`, `data: { symbol, value }` (as today);
  - write done, read-back failed: `ok:true`, `data: { symbol, value: null, readBackError: "<message>" }`;
  - nothing sent: `ok:false`, `error`, `written: "no"`;
  - ADS write call failed: `ok:false`, `error`, `adsCode` (as today), no `written` field. The extension treats a missing `written` as "outcome unknown". This is conservative: an old CLI (no `written` field) never makes the extension say "Not written".
- Uncertain, decide in Step 3: whether an ADS error code returned by the device for the write (for example access denied, type mismatch) proves "not written". Only if `AdsCodes` documents the code as a device refusal (not a timeout, not connection lost) may the host add `written: "no"`; when in doubt, leave it out.

- [ ] **Step 1: Write failing tests:** `Write_reports_a_failed_read_back` (FakeLink: write succeeds, read throws → `Value == null`, `ReadBackError` set), `Write_of_an_unknown_symbol_is_not_sent` (→ `WriteNotSentException`, FakeLink saw no write), `Write_of_an_unparsable_value_is_not_sent`, and in `WatchHostTests`: `write reply says not written only before sending` (`written:"no"` for `WriteNotSentException`, no `written` for an `AdsFault`), `write reply carries the read-back error`.
- [ ] **Step 2: Run** (PowerShell tool, nothing else heavy in parallel) `dotnet build cli/IECode.slnx`, then separately `dotnet test cli/IECode.slnx --no-build`. Expected: the new tests fail.
- [ ] **Step 3: Implement.** In `AdsLink.Symbol.Write` parse with `AdsValues.ParseForWrite` before `WriteValue` and throw `WriteNotSentException` on a parse error; in `AdsWatchBackend.Write` map `Find` failures to `WriteNotSentException`, wrap the read-back in its own try and return its message as `ReadBackError`. `WatchHost.Handle` adds `written:"no"` for `WriteNotSentException`. Document the reply in `cli/README.md`.
- [ ] **Step 4: Run** build, then test, as in Step 2. Expected: green.
- [ ] **Step 5: Commit** `CLI: ads serve tells a failed read-back from a write that was not sent` (why: a failed read-back after a successful write was reported as an error, and AI clients would have been told "not written" for a value already on the PLC).

The CLI and the extension ship together (`.github/workflows/release.yml`), but users may update them separately; the conservative default above keeps a mixed pair safe.

---

### Task 3: Buffer reset on target change and write outcomes in the host

**Files:**
- Modify: `extension/src/core/adswatch.ts` (`ScopeBuffer.clear()`, `writeStage`), `extension/src/ads/host.ts:77-84`, `host.ts:160-174`, `host.ts:228-246` (`start`: `procKey`) and `host.ts:357-364` (`request`), `extension/src/views/adsWatch.ts:205` (the view's write: read-back error text)
- Depends on: Task 2b (reply fields; without it every host write error is "unknown", which is safe)
- Test: `extension/test/adswatch.test.ts`

**Interfaces:**
- Produces: `ScopeBuffer.clear(): void` (drops series, latest and newest; keeps items and gen).
- Produces in `core/adswatch.ts` (R7): `export class RequestTimeout extends Error {}` and `export class HostGone extends Error {}`; `PendingRequests` rejects a timeout with `RequestTimeout` and `rejectAll` with `HostGone`.
- Produces in `core/adswatch.ts` (R19, pure): `export type WriteStage = { kind: 'written'; value: string | null; readBackError?: string } | { kind: 'notSent'; reason: string } | { kind: 'unknown'; reason: string }` and `export function writeStage(outcome: { data: unknown } | { error: unknown }): WriteStage` (the resolved reply data, or the rejection of `request()`) — data → written (with `readBackError` from Task 2b); `HostError` with `written:"no"` → notSent; any other `HostError` → unknown; `RequestTimeout` / `HostGone` after the request was written → unknown. For that, `PendingRequests.settle` (`adswatch.ts:192-200`) rejects an `ok:false` reply with `export class HostError extends Error { written?: string }`, and `parseHostLine` keeps the `written` field; test `host error keeps the written field`.
- Produces in `host.ts`: `export class WriteNotSent extends Error {}` (guard refused, host not running, or the host says `written:"no"`), `export class WriteOutcomeUnknown extends Error {}` (sent, then no reply, or an ADS error without proof); `write(symbol: string, value: string, beforeSend?: () => string | undefined): Promise<{ value: string | null; readBackError?: string }>` — `beforeSend` runs after `ensure(true)`, synchronously right before `child.stdin.write`, with no `await` in between (R21); a returned string throws `WriteNotSent(reason)`. A plain `Error` is no longer a possible outcome of a write.
- Produces: `AdsHost.targetKey(): string` — `"<target>:<port>"` of the current settings, for binding approvals. `start()` stores the key it spawned the child with (`procKey`); the final check before sending also requires `procKey === op.targetKey`, so the request goes to a child that was started for the confirmed target (R21).

- [ ] **Step 1: Write failing test** `ScopeBuffer.clear drops samples but keeps items`: set items, push rows, `clear()`, then `latest('a') === undefined`, `series('a', 0).length === 0`, and a new `push` with the same gen is stored again. Also (R7) `PendingRequests tells a timeout from a host exit` (timeout → `RequestTimeout`, `rejectAll` → `HostGone`) and `rejectAll after a settings restart is a host exit`. R19: `write outcome after a failed read-back` (`writeStage({ data: { symbol: 'a', value: null, readBackError: 'x' } })` → written), `write outcome of an old CLI error is unknown` (`HostError` without `written`), `write outcome not sent only with proof` (`written:"no"` → notSent).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (`clear`, `RequestTimeout`, `HostGone` missing).
- [ ] **Step 3: Implement** `clear()`; in the `onDidChangeConfiguration` handler, when target or port changed (not for `iecode.cliPath`): call `this.buffer.clear()` and `this.written.clear()`, reset `items_` to unresolved entries of the saved list (`{ symbol, type: '', numeric: false, error: null }`) and fire `itemsChanged`, also while no host runs (R26). Add `targetKey()`, `procKey`, `writeStage`, the two error classes and `beforeSend`. `write` maps `writeStage`: written → returns `{ value, readBackError }` (sets `written` only for a non-null value); notSent → `WriteNotSent`; unknown → `WriteOutcomeUnknown` with the existing "may or may not have been written" text; the "not running" rejection of `request()` and a `beforeSend` refusal become `WriteNotSent`; `timedOut` uses `instanceof RequestTimeout` (R7). Write the request to the same `child` the guard checked (take `this.proc` once, check `procKey`, run `beforeSend`, write; no `await` in between). The UI write path (watch view) shows "written, read-back failed: …" for a written result with `readBackError`.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: ADS buffer cleared on a target change, write outcomes told apart` (why: samples of the old target were shown under the new one; MCP needs to know whether a failed write may have happened; a failed read-back is no longer reported as "not written").

Not unit-testable here: `host.ts` needs VS Code and a child process. The pure `writeStage` carries the classification; the wiring (`procKey`, no `await` before sending, item reset while idle) is checked by hand in Task 9 Step 2.

---

### Task 4: Write gate

Pure module: queue, approval binding, cancellation, deadline, outcome texts. Used by MCP now; the Copilot write tool also routes through its final check.

**Files:**
- Create: `extension/src/core/writeGate.ts`
- Create: `extension/src/ads/adsWrite.ts` (VS Code side: dialog, settings, host)
- Modify: `extension/src/ads/lmTools.ts` (Copilot `invoke` uses `adsWrite`'s bound check), `extension/src/extension.ts` (creates the one gate per window and hands it to the Copilot tools, later to MCP; R23)
- Test: `extension/test/writeGate.test.ts`
- Depends on: Task 3 (`WriteNotSent`, `WriteOutcomeUnknown`, written result with `readBackError`)

**Interfaces:**
- Produces (core):
  ```ts
  export interface WriteOp { symbol: string; value: string; targetKey: string; via: 'MCP' | 'Copilot';
    prepared?: { decision: WriteDecision } }   // Copilot: decision shown by prepareInvocation, the gate opens no dialog (R5)
  export type WriteResult =
    | { kind: 'refused'; reason: string }          // not sent
    | { kind: 'written'; readBack: string | null; readBackError?: string }   // R19: null with an error when the read-back failed
    | { kind: 'unknown'; reason: string };          // sent, no reply or no proof
  export interface GateDeps {
    decision(): 'refuse' | 'confirm' | 'allow';     // aiWriteDecision(aiWritesSetting(), workspaceTarget())
    targetKey(): string;                            // host.targetKey()
    confirm(op: WriteOp, signal: AbortSignal): Promise<boolean>; // the user's raw choice, also after the signal aborted (R22)
    send(op: WriteOp, beforeSend: () => string | undefined): Promise<WriteResult>;
    lateApproval(op: WriteOp, reason: string): void; // confirm resolved true after the abort, the deadline or dispose (R4)
  }
  export interface GatePolicy {
    dialogMs: number;     // longest time one dialog may take, counted from when it opens (≤ 120_000)
    operationMs: number;  // longest time from run() to sending, queue wait included (R24)
    maxQueued: number;    // 10
  }
  export class WriteGate {
    constructor(deps: GateDeps, policy: GatePolicy); // no defaults: the caller derives them from the measured client tool timeout (R17, R24)
    run(op: WriteOp, signal: AbortSignal): Promise<WriteResult>;
    dispose(): void;   // latched: every op not yet sent ends as refused "IECode was shut down", also one waiting in send() for the host start (R20); run() after dispose refuses at once
  }
  export function writeResultText(r: WriteResult, op: WriteOp): string;
  export function writeResultIsError(r: WriteResult): boolean; // refused and unknown → true; written → false, also with a read-back error (R25)
  ```
  `run` (R6: queue first, then dialog): the op enters a FIFO queue (one op at a time; more than `maxQueued` waiting, dialogs included → refused "too many pending writes"); at the head, `refuse` → refused (off text from lmTools); `confirm` → `confirm(op, signal)` raced against the deadline, which starts when this dialog opens, and `signal`; then the op is sent; a deadline or abort refuses the op at once, but the next dialog opens only after this `confirm` promise has settled, because VS Code cannot close a modal (R6 reopened, D16); `beforeSend` returns a reason if the gate was disposed ("IECode was shut down", R20), if `signal.aborted` ("the request was cancelled"), if the operation deadline has passed ("the request waited too long", R24), if `decision()` is now `refuse`, if it was `allow` at start but is `confirm` now ("needs confirmation now"), or if `targetKey() !== op.targetKey` ("the ADS target changed from A to B").
  Each op has its own latched state (`queued` → `confirming` → `sending` → `done`); dispose, abort and the operation deadline flip a not-yet-sent op to refused at once and are re-checked by `beforeSend`, so an op that is still inside `send()` waiting for the host start is never sent after them (R20). Once `send()` has passed `beforeSend`, nothing may turn the result into "refused" any more; it is whatever `send` returns (R20).
  Queue (R24): an op waiting in the queue that is aborted or passes its operation deadline leaves the queue at once (its slot is free again) and never gets a dialog. A stale dialog keeps only the dialog slot; ops behind it still expire on their own operation deadline. Before opening a dialog the gate checks that at least 5 s of the operation deadline remain, else refused "the request waited too long".
  Late approval (R22): `confirm` returns the raw choice; when it is `true` but the op was already refused (abort, dialog deadline, operation deadline, dispose), the gate calls `lateApproval` exactly once and sends nothing.
  Refused reasons name the write tool through the client's name set (R15: `adsWrite` / `ads_write`) and never start with "Not written:" (O13); the off reason is "AI writes are off. The user can allow them with the command "IECode: Set AI Write Access…" (setting iecode.ads.aiWrites in the user settings)". A Copilot op without a stored prepare decision is refused as today with "it needs the user's confirmation now; call the write tool again" (O16). The same refusal applies to an ambiguous prepare record (R28, see Step 3).
  `writeResultText`: written → `Written. <symbol> reads back as <readBack> (the PLC may change it again).`; written with a read-back error → `Written, but <symbol> could not be read back: <readBackError>. Read it before acting on the value.` (R19); refused → `Not written: <reason>.`; unknown → `Outcome unknown: <reason>. Do not write again on your own; read <symbol> and ask the user.`
- Produces (ads): `export function adsWriteGate(host: AdsHost, workspaceName: () => string, policy: GatePolicy): WriteGate` — called once in `extension.ts`; the same instance goes to the Copilot tools and to the MCP server, and is disposed after both (R23). `confirm` shows modal `showWarningMessage("Write <symbol> := <value> on <target> (<workspace>)?" [+ workspace-settings note], { modal: true }, 'Write')` and returns `pick === 'Write'` without looking at the signal (R22; VS Code cannot close a modal); `lateApproval` shows a non-modal warning "IECode: <symbol> was not written: <reason>." (R4); `send` maps `host.write(...)`: a result → written (with `readBackError`), `WriteNotSent` → refused, `WriteOutcomeUnknown` and every other error → unknown (R19: no plain error may become "not written"). Until the bridge spike measures the client tool timeout, `extension.ts` passes `{ dialogMs: 120_000, operationMs: 150_000, maxQueued: 10 }` for Copilot-only use (Copilot has no tool timeout that the extension knows); Task 7 recomputes it from the measurement (R17, R24).
  The "one dialog at a time" rule covers the gate's own dialogs (MCP). Copilot's confirmation is shown by VS Code in the chat, outside the gate; a prepared Copilot op still takes the gate's queue, so its write never overlaps an MCP write (R23). Logs every write like `lmTools` does, with `via MCP` or `via Copilot`.

- [ ] **Step 1: Write failing tests** with a fake `GateDeps`:
  - `gate refuses when writes are off` → `{ kind: 'refused' }`, `confirm` and `send` not called.
  - `gate sends without dialog on allow`.
  - `gate refuses when the target changed during approval`: `targetKey` returns `'A:851'` at start, `'B:851'` after `confirm` resolves → refused, reason contains `A:851` and `B:851`, `send`'s `beforeSend` returns that reason (fake `send` calls `beforeSend` first and returns refused if it returns a string).
  - `gate writes nothing after cancellation`: `confirm` resolves `true` after the signal was aborted → refused "the request was cancelled", fake host never wrote.
  - `gate refuses after the deadline` (deadline 10 ms, confirm never resolves).
  - `gate runs writes one after the other` (two ops, first `send` slow; second `send` starts only after the first resolved).
  - `gate rejects when too many writes wait` (`maxQueued: 1`).
  - `gate shows one dialog at a time`: two confirm ops; the second `confirm` is called only after the first op was sent or refused, and its deadline counts from then (R6).
  - `gate waits for a stale dialog before the next`: the first op's deadline passes (refused at once), its `confirm` is still open; the second `confirm` is called only after the first resolves (R6, D16).
  - `gate refuses pending writes on dispose` (confirm still open, `dispose()`, then confirm resolves `true` → refused, `send` not called).
  - `gate reports a late approval`: confirm resolves `true` after the abort → `lateApproval` called once with the reason, `send` not called (R4).
  - `writeResultText` for all three kinds, plus written with a read-back error (exact strings above); `writeResultIsError` for all of them (R25).
  - `gate sends nothing when disposed during the host start` (R20): `allow` op; fake `send` waits on a deferred "host started", then calls `beforeSend`; `dispose()` before the deferred resolves → `beforeSend` returns "IECode was shut down", fake host never wrote. Same for a confirmed op.
  - `gate refuses at once after dispose` (R20): `run` after `dispose()` → refused, no dialog.
  - `gate keeps the outcome of a sent write after dispose` (R20): `dispose()` after `beforeSend` passed → result is what `send` returns, not refused.
  - `gate drops a cancelled op from the queue` (R24): op 2 waits behind op 1's open dialog; abort op 2 → refused at once, `maxQueued` slot free again, op 2's `confirm` is never called.
  - `gate expires a queued op behind a stale dialog` (R24): op 1's `confirm` never settles; op 2 is refused "the request waited too long" when its `operationMs` passes, without a dialog.
  - `gate opens no dialog without time left` (R24): fewer than 5 s of `operationMs` left at the head → refused, `confirm` not called.
  - `gate reports a late approval after the deadline` and `… after dispose` (R22): raw `true` from `confirm` after the dialog deadline / after `dispose()` → `lateApproval` once, nothing sent.
  - `gate maps a plain send error to unknown` (R19): fake `send` rejects with `new Error('x')` → the adapter contract is tested on the pure mapping helper `sendOutcome(e)` exported from `core/writeGate.ts`: `WriteNotSent` → refused, anything else → unknown.
  - Use deferred promises and an injected clock (`now()` and timers in `GateDeps` or a `clock` option) for the deadline tests instead of real 10 ms timers (R24).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `core/writeGate.ts`, then `ads/adsWrite.ts`. Copilot's `invoke` (R5): keep its `prepareInvocation` confirmation, store `{ decision, targetKey }` there (R28: in a pure `PreparedWrites` class in `core/writeGate.ts`, keyed as today by `[symbol, value]`; a second `prepare` for the same key while a record is open marks the key ambiguous, and `take(key)` then returns `undefined` for both invocations, so both are refused with the "call the write tool again" text; records older than the operation deadline are dropped; at most 100 records as today), and call `gate.run({ symbol, value, targetKey, via: 'Copilot', prepared: { decision } }, signal)` with an `AbortSignal` from the cancellation token; return `writeResultText`. The gate opens no dialog for a prepared op but applies the same `beforeSend` rules (a prepared `allow` that is `confirm` now is refused, like `writeStillApproved` today), queue, log and outcome texts. Move `writeStillApproved` and its tests into the gate. Extra tests: `gate takes a prepared Copilot approval`, `gate refuses a prepared allow that now needs confirmation`, `prepared writes refuse an ambiguous key` (two prepares for the same symbol and value, the second for another target → both `take` calls return `undefined`), `prepared writes drop old records`, `gate shares one queue for Copilot and MCP` (a prepared Copilot op waits for a running MCP write, R23).
  The Copilot tool keeps returning `writeResultText`; with "Always Allow" chosen in the chat, Copilot skips `prepareInvocation`'s confirmation, which the gate cannot see. Task 9 states this in the README next to the existing limit (R27).
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: write gate binds AI writes to the confirmed target` (why: a write confirmed for one target could reach another after a settings change; cancelled requests must not write later).

---

### Task 5: Tool input validation

**Files:**
- Create: `extension/src/core/toolInput.ts`
- Test: `extension/test/toolInput.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
  export function parseSymbolsInput(raw: unknown): Parsed<{ filter: string }>;
  export function parseWatchInput(raw: unknown): Parsed<{ add: string[]; remove: string[] }>;
  export function parseReadInput(raw: unknown): Parsed<{ symbols: string[] }>;
  export function parseScopeInput(raw: unknown): Parsed<{ symbols: string[]; seconds?: number }>;
  export function parseWriteInput(raw: unknown): Parsed<{ symbol: string; value: string }>;
  ```
  Limits: symbol / filter ≤ 512 chars, value ≤ 4096 chars, arrays ≤ `MAX_WATCHED` (200) entries, `seconds` a finite number (clamped later by the tool to 1..3600). Missing optional arrays become `[]`. `raw` that is not a plain object → error `"arguments must be an object"`; `undefined` (no arguments sent) counts as `{}` (R29). An explicit `null` for an optional field counts as missing. Every array element is a string within the symbol limit. The write `symbol` must not be blank after trimming; the write `value` may be the empty string (an empty PLC STRING is a valid write). Errors name the field: `"add must be an array of strings"`.

- [ ] **Step 1: Write failing tests** `toolInput accepts valid input`, `toolInput rejects wrong types` (`{ add: 'x' }`, `{ symbols: [1] }`, `null`, `[]`, `{ symbol: 'a' }` without value), `toolInput enforces limits` (513-char symbol, 201-entry array, `seconds: 'NaN'`), and (R29) `toolInput boundaries` (512-char symbol and 4096-char value accepted, 4097-char value rejected, 200 entries accepted, a 513-char array element rejected, `seconds: NaN`, `Infinity` and `-Infinity` as numbers rejected), `toolInput optional fields` (`undefined` → defaults, `{ add: null }` → `[]`), `toolInput write symbol and value` (`'  '` symbol rejected, `''` value accepted).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the same limits to the tool schemas in `extension/package.json` (`languageModelTools[*].inputSchema`: `maxLength`, `maxItems`) so Copilot sees them too; Task 7 builds the MCP `inputSchema` from the same source. The extension validates at its own boundary, also when the bridge validates before (R29).
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: validate ADS tool arguments from outside VS Code` (why: MCP arguments are untrusted JSON; the Copilot path relied on TypeScript types).

---

### Task 6: MCP protocol layer

> Rewrite for the stdio bridge (D20/D21) before building: the JSON-RPC handling and R14 carry over; the HTTP checks (Origin, Host, token, 413, R8, O10) depend on the bridge ↔ extension transport still to be designed.

Pure request handler; the transport checklist from Task 1's "Spike results" is binding for the details below that it refines.

**Files:**
- Create: `extension/src/core/mcp.ts`
- Test: `extension/test/mcp.test.ts`

**Interfaces:**
- Consumes: `Parsed`/parsers (Task 5), `ToolText` shape (Task 2).
- Produces:
  ```ts
  export interface McpTool { name: string; description: string; inputSchema: object;
    call(args: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> }
  export interface HttpIn { method: string; path: string; headers: Record<string, string | undefined>; body: string; port: number } // path other than /mcp → 404 first (O10)
  export interface HttpOut { status: number; headers: Record<string, string>; body: string }
  export class McpHandler {
    constructor(opts: { token: string; tools: McpTool[]; serverVersion: string });
    handle(req: HttpIn, signal: AbortSignal): Promise<HttpOut>;
    cancel(requestId: string | number): void;    // from notifications/cancelled; aborts only if exactly one running call has that id (R14)
  }
  export const MAX_BODY = 1_048_576;
  export function tokenMatches(expected: string, given: string | undefined): boolean; // constant time
  ```
  Order of checks: `Origin` present → 403; bad `Host` → 403; bad token → 401 (`WWW-Authenticate: Bearer realm="iecode"`, the marker Connect probes for, R2); `MCP-Protocol-Version` present but not in the supported set of the spike checklist → 400 naming the supported versions, missing → accepted (R8); method not `POST` → 405 (unless the checklist says otherwise); body > `MAX_BODY` → 413; invalid JSON → JSON-RPC `-32700`; batch arrays → `-32600`. Methods: `initialize` (echo a supported `protocolVersion` per checklist, `capabilities: { tools: {} }`, `serverInfo: { name: 'iecode', version }`), `server/discover`, `ping`, `tools/list`, `tools/call` (unknown tool → `-32602`; tool result `{ content: [{ type: 'text', text }], isError }`), notifications (no `id`) → 202 empty body, `notifications/cancelled` → `cancel(params.requestId)`. Unknown method with `id` → `-32601`. A tool call gets an `AbortSignal` that fires on the outer `signal` or on `cancel(id)`.
- Tool descriptions and `inputSchema` are passed in by the caller (Task 7 reads them from `package.json`).

- [ ] **Step 1: Write failing tests** (one per row): `initialize answers with server info`, `tools/list lists the tools`, `tools/call returns text content`, `tools/call marks errors`, `unknown method gives -32601`, `notification gets 202 without body`, `missing token gives 401`, `wrong token gives 401`, `origin gives 403`, `wrong host gives 403`, `oversized body gives 413`, `invalid JSON gives parse error`, `batch gives invalid request`, `cancelled notification aborts the running call`, `outer signal aborts the running call` (name it `response close before reply cancels the operation`), `tokenMatches rejects different lengths`, `unsupported protocol version header gives 400` (R8), `wrong path gives 404` (O10: before the auth check, so OAuth discovery probes never see the bearer 401), `cancelled with an ambiguous id aborts nothing` (R14: two running calls with id 5, a cancel for 5 aborts neither and is logged).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto.timingSafeEqual` for the token.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: MCP protocol layer for the ADS tools` (why: hand-written to keep the extension free of runtime dependencies; decision from the spike).

---

### Task 7: MCP server in the extension

> Rewrite for the stdio bridge (D20/D21) before building: the tool wiring to `adsTools` and the gate carries over; listener, token and port handling depend on the new design.

**Files:**
- Create: `extension/src/core/mcpHttp.ts` (R9), `extension/test/mcpHttp.test.ts`
- Create: `extension/src/ads/mcpServer.ts`
- Modify: `extension/src/extension.ts:125` (start on activation if connected), `extension/src/views/adsWatch.ts:100` (status), `extension/package.json` (rewrite the five `modelDescription`s and the `aiWrites` description/picker text to neutral wording: no `#adsWatch`/`adsScope` names, approval details per client moved out of the tool text)
- Test: manual (VS Code module); pure parts are covered by Tasks 4–6.

**Interfaces:**
- Consumes: `adsTools` (Task 2), `adsWriteGate` (Task 4), parsers (Task 5), `McpHandler` (Task 6).
- Produces:
  ```ts
  export class AdsMcpServer implements vscode.Disposable {
    static get(ctx: vscode.ExtensionContext, state: WorkspaceState): AdsMcpServer;
    start(): Promise<number>;          // resolves the port; binds stored port, else port 0; stores the port it got
    stop(): Promise<void>;
    port(): number | undefined;        // undefined while not listening
    token(): Promise<string>;          // from SecretStorage key `iecode.mcp.token.<workspace id>`; start() replaces it with a new one (R13)
    deleteToken(): Promise<void>;
    readonly onState: vscode.Event<void>;
  }
  ```
  `workspaceState` keys: `iecode.mcp.connected` (boolean), `iecode.mcp.port` (number). On activation: start only if `connected` is true. Listens through `serveMcp` (R9: `core/mcpHttp.ts`, `127.0.0.1`, body up to `MAX_BODY + 1` bytes, `AbortController` on `res` close while `res.writableFinished` is false) and passes requests to `McpHandler.handle`. Tool names map to `adsTools` / gate: `ads_write` → parse → `gate.run({ symbol, value, targetKey: host.targetKey(), via: 'MCP' }, signal)` → `writeResultText`; the dialog renders `op.targetKey`, the target the op is bound to (O14). A listen error: one warning `IECode: the MCP server for Claude Code could not start: <reason>`, nothing else breaks. View description gains `MCP: on` while `port()` is defined.

- [ ] **Step 0 (R9): Write failing tests** in `test/mcpHttp.test.ts` on a real socket: `serveMcp binds 127.0.0.1`, `body over the limit gives 413 without reading it all`, `client disconnect aborts the running call` (handler waits on its signal, client destroys the socket, signal fires), `a taken port rejects start`; run `npm test` (FAIL), implement `core/mcpHttp.ts` (`serveMcp(handle, { port })`: `node:http` only, `127.0.0.1`, body read up to `MAX_BODY + 1`, `AbortController` on `res` close while `!res.writableFinished`), run `npm test` (green).
- [ ] **Step 1: Implement** `mcpServer.ts` on top of `serveMcp` (SecretStorage, workspaceState, status, tool wiring) and the wiring.
- [ ] **Step 2: Rewrite the `package.json` descriptions**; check that `lmTools.ts` still reads the Copilot-only approval hint from its own `prepareInvocation`, not from the shared description.
- [ ] **Step 3: Run** `npm test`. Expected: green (compiles, nothing regresses).
- [ ] **Step 4: Manual check with curl** (Bash tool) against an F5 session with a temporarily set `connected` flag: `initialize`, `tools/list`, `ads_read` of a watched variable; no token → 401; `-H "Origin: http://evil"` → 403.
- [ ] **Step 5: Commit** `Extension: MCP server serves the ADS tools on 127.0.0.1` (why: Claude Code cannot call vscode.lm tools).

---

### Task 8: Connect and Disconnect Claude Code

> Rewrite for the stdio bridge (D20/D21) before building: one user-scope registration; R1 and R12 (launcher lookup) carry over, R2, R3, R13 and R16 are moot in their current form.

**Files:**
- Create: `extension/src/core/claudeRegistration.ts`, `extension/src/ads/claudeConnect.ts`
- Modify: `extension/package.json` (commands `iecode.mcpConnect` "IECode: Connect Claude Code", `iecode.mcpDisconnect` "IECode: Disconnect Claude Code"; also in the ADS Watch view `…` menu), `extension/src/extension.ts`
- Test: `extension/test/claudeRegistration.test.ts`

**Interfaces:**
- Produces (core):
  ```ts
  export function addArgs(port: number, token: string): string[];
  // ['mcp','add','--transport','http','--scope','local','iecode',`http://127.0.0.1:${port}/mcp`,'--header',`Authorization: Bearer ${token}`]
  export function removeArgs(): string[];                 // ['mcp','remove','--scope','local','iecode']
  export function getArgs(): string[];                    // ['mcp','get','iecode']
  export function redact(text: string, token: string): string;   // token → '***'
  export function registeredPort(getOutput: string): number | undefined; // port parsed from `claude mcp get iecode`
  export function manualCommand(port: number, token: string): string; // the add command as one quoted line for the clipboard
  export function cmdLine(args: string[]): string;        // cmd.exe command line for claude.cmd; throws on cmd metacharacters (R1)
  export function findOnPath(pathEnv: string, exists: (p: string) => boolean): { exe?: string; cmd?: string }; // absolute PATH entries only (R12)
  export function ownerAction(registeredPort: number | undefined, ownPort: number, probe: 'iecode' | 'other' | 'none'): 'add' | 'replace' | 'ask'; // R2
  export function connectSteps(folders: string[], entries: Map<string, number | undefined>): { folder: string; undo: 'remove' | { restorePort: number } }[]; // R3
  ```
- Produces (ads): `registerClaudeConnect(ctx, state)` with the two commands.
  Connect: refuse with a message if `vscode.env.remoteName` is set or not Windows; start the server; for a folder whose `iecode` entry points to another port, probe that port without a token: a 401 with `WWW-Authenticate: Bearer realm="iecode"` means another IECode window serves the folder, so ask "Take over" / "Cancel" (`ownerAction`, R2; Cancel changes nothing); for each workspace folder (cwd = folder path): if `getArgs` shows an `iecode` entry, `removeArgs` then `addArgs`; on a nonzero exit restore the previous entry when it pointed to another port of this workspace, report the redacted output, and leave `connected` false. If a folder fails, undo this Connect's changes in reverse order (restore replaced entries, remove new ones; list from `connectSteps`, R3), stop the server if this Connect started it, and name the failing folder. Only after every folder succeeded set `iecode.mcp.connected = true` and tell the user: `Claude Code connected. A running Claude session needs /mcp to reconnect or a restart.` `claude` not found (ENOENT): offer `Copy Command` (note: "contains the access token; Windows clipboard history may keep it", O17) using `manualCommand`. Resolve `claude` with `findOnPath` (R12: absolute path from the PATH entries only, never the cwd or a relative entry; `claude.exe` first, then `claude.cmd`) and spawn that absolute path: `spawn(exePath, args, { cwd, shell: false, windowsHide: true })` for the native installer. If only `claude.cmd` is found (npm install; Node refuses `.cmd` without a shell), run `spawn('cmd.exe', ['/d', '/s', '/c', cmdLine([cmdPath, ...args])], { cwd, windowsVerbatimArguments: true, windowsHide: true })`; `cmdLine` (core) quotes each argument and throws on `"`, `&`, `|`, `<`, `>`, `^`, `%`, `!` or a line break (R1).
  Re-registration on start (R13): if `connected`, every start has a new token, so each folder is registered again with the new token (and the new port, if the stored one could not be bound) the same way, with the `connectSteps` rollback; silent unless it fails, then one warning.
  Folder changes (R16): on `onDidChangeWorkspaceFolders` while connected, register each added folder (owner check R2, `connectSteps`) and remove the entry of each removed folder if it points to the stored port; a failure shows one warning and leaves the other folders as they are; the lists come from pure `folderChanges(before, after)`.
  Disconnect: per folder, `removeArgs` only if `registeredPort(get output)` equals the stored `iecode.mcp.port` (not `port()`, which is undefined while not listening; O8); stop the server; `deleteToken()`; `connected = false`.

- [ ] **Step 1: Write failing tests** `addArgs builds the local-scope http registration`, `redact hides the token everywhere`, `registeredPort reads the URL port` (sample `claude mcp get` output from the spike results), `manualCommand quotes the header`, `cmdLine quotes arguments and refuses metacharacters` (R1), `ownerAction asks only when another IECode serves the folder` (R2), `connectSteps undoes in reverse order` (R3), `findOnPath ignores the current folder and relative entries` (R12), `folderChanges lists folders to add and remove` (R16).
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** core, then `claudeConnect.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Extension: connect Claude Code to the ADS MCP server` (why: one-time setup in the user's Claude configuration, never in a .mcp.json that could be committed).

---

### Task 9: Docs and end-to-end check

**Files:**
- Modify: `extension/README.md` (feature row "AI tools for live values": Claude Code via Connect; settings table; known limitation lines 156ff for MCP), `extension/CHANGELOG.md`, `TODO.md` (MCP item done, link to spec and plan)

- [ ] **Step 1: Update the docs.** The known limit for Copilot's "Always Allow" says that it also bypasses the gate's confirmation, while MCP writes are always confirmed by IECode's own dialog (R27).
- [ ] **Step 1b: Manual check of the host wiring (Tasks 2b-4, R19-R21, R26):** a write whose read-back fails is hard to stage on a real PLC; Task 2b's unit tests cover it, so record "not staged" unless a setup triggers it; change `iecode.ads.target` while a write waits for the host start → not written; change the target while the host is idle → the watch view shows the symbols as unresolved at once; dispose (reload the window) while a confirmed write waits for the host start → nothing written.
- [ ] **Step 2: Manual check, F5 session, terminal Claude and Claude Code in VS Code** (user runs the VS Code part): Connect; `/mcp` shows `iecode` connected; watch a variable → it appears in the ADS Watch view and scope; scope summary; write with off / confirm / auto; Cancel in the dialog; interrupt Claude while the dialog is open, then click Write → nothing written; change the target while the dialog is open → not written; close the view, wait 60 s, ask for the scope → gap note; restart VS Code → still connected without new setup (a Claude session running across the restart needs `/mcp` once, R13: new token per start); Disconnect → `/mcp` no longer lists it; with `claude` not on PATH, Connect offers Copy Command; a second window with another workspace on the same folder asks to take over, and Disconnect in the first window then leaves the second window's entry alone (spec Testing, F-T3); add and remove a workspace folder while connected → registered / unregistered (R16). Record the Claude Code versions in the commit body.
- [ ] **Step 3: Package** `npm run package`, install the VSIX, repeat Connect, read and one confirmed write.
- [ ] **Step 4: Run** `npm test`. Expected: green.
- [ ] **Step 5: Commit** `Docs: ADS tools for Claude Code over MCP`.

---

## Spike results

(Filled in by Task 1.)

## Eng review 2026-11-03

Target: this plan (`docs/superpowers/plans/2026-11-03-ads-mcp-server.md`), reviewed with `/plan-eng-review` against the spec and the code on `ph/ads-watchlist` at 51a123c.

### Scope record

feature answers: no feature cuts proposed; structure: A (Original arrangement, D1); accepted scope: Tasks 1-9 as written, 8 new source files, 4 new test files; pending remedies: none decided yet (findings from Sections 1-4 follow).

### Scope Challenge

No scope findings: the spec answers the three open questions of `TODO.md:5-7` (transport, discovery, write confirmation); nothing of this is on `origin/main` yet. Result: scope accepted as-is.

Premises (verified unless marked):

| Premise | Receipt | Verdict |
|---|---|---|
| `host.ts:77-84` is the settings handler, `host.ts:160-174` is `write` | read 51a123c | true |
| `extension.ts:125` registers the LM tools; `adsWatch.ts:100` sets the view description | read 51a123c | true |
| Baseline 173 extension tests | `npm test`: 174 tests, 173 pass, 1 skipped | true |
| `claude mcp add -t http -s local <name> <url> -H "<header>"` | `claude mcp add --help`, Claude Code 2.1.306 | true (`-H` is variadic, so it must stay after the URL) |
| `claude mcp get iecode` prints the URL | `claude mcp get --help` only (it also health-checks the server) | unverified |
| A host-exit rejection can be told from a timeout | `PendingRequests.rejectAll(reason)` with free-text reasons from `stop` / `exited` (`adswatch.ts:202`, `host.ts:344,354`) | false today; Task 3 must add the marker |
| `spawn('claude', …, { shell: false })` can start an npm install of Claude Code | npm ships only `claude.cmd`; Node rejects `.cmd` / `.bat` without a shell (EINVAL, fix of CVE-2024-27980) | false (finding A1) |
| Static bearer header avoids the OAuth probe of the VS Code extension (#46640) | spec only | unverified (spike) |
| An existing decision binds the plan | decision 2026-11-02: "a later MCP server is served by the extension" | true, plan follows it |

REALITY: premise-table finding 9 premises, 2 false, unverified=2 (plan:252 `claude mcp get` format, plan:46 OAuth probe)
REALITY: already-done pass no commits on origin/main since 2026-10-25 for extension/src/ads, core/adswatch.ts or --grep MCP (plan:7)
REALITY: surface-check finding `claude mcp add` flags verified on 2.1.306; `claude.cmd` cannot be spawned with shell:false (plan:256)
REALITY: binding-decisions pass 2026-11-02 decision "MCP server served by the extension" matches plan:5
REALITY: numbers pass 173 tests [measured: `npm test` at 51a123c, plan:23]; 1 MB body limit [estimated: plan:18]; 2 min deadline [estimated: plan:21]; 10 queued [estimated: plan:124]; 512/4096 chars [estimated: plan:161]
REALITY: deferred-asks pass no linked issue; TODO.md:5-7 open points all covered by the spec (plan:11)
REALITY: pr-count pass one PR, no ship policy, 9 task commits (plan:35-277)

### Section 1: Architecture

Design-twice. Shape 1 (the plan): an HTTP MCP server inside the extension host, a pure protocol layer, a separate `WriteGate` for MCP while the Copilot write keeps its own prepare/invoke check plus a `beforeSend` hook. Shape 2: one `WriteGate` owns every AI write; Copilot's `invoke` calls `gate.run` with the decision and target key it stored in `prepareInvocation` as "already confirmed", so queue, re-check rules, logging and the three outcome texts exist once. Shape 2 hides more behind the same `run(op, signal)` surface. Red flag hit by shape 1: "two ways to do one task" (finding A5). The stdio bridge of the spec stays the fallback only if the spike fails.

Findings:

- A1 [CRITICAL] (confidence: 8/10) plan:256 — "on Windows resolve `claude.cmd`/`claude.exe` the way `cli/iecode.ts` resolves its CLI if `shell: false` cannot start `claude` directly". `cli/iecode.ts:70,137` only spawn `iecode.exe`; Node refuses `.cmd` without a shell (EINVAL), and libuv's PATH search tries `.com` / `.exe` only. An npm install of Claude Code (only `claude.cmd`) therefore fails Connect with an error instead of a working path.
- A2 [INFORMATIONAL] (confidence: 7/10) plan:256 — "refuse if another window owns the folder (stored port answers `initialize` with this workspace's token…)". Port and token are per workspace, so this only finds the same workspace in a second window, which VS Code already prevents. A different workspace (another single-folder or multi-root window) with the same folder overwrites the `local` registration of that folder unnoticed, and Claude then talks to the other window.
- A3 [INFORMATIONAL] (confidence: 8/10) plan:256 — "Only after every folder succeeded set `iecode.mcp.connected = true`". Folders registered before the failing one stay registered; the spec (line 151) wants Connect to be transactional.
- A4 [INFORMATIONAL] (confidence: 7/10) plan:126 — "an aborted signal after the dialog resolves counts as declined (VS Code cannot close a modal)". The user clicks "Write" after Claude cancelled or the 2 min deadline passed and sees nothing; the spec (line 131) says IECode shows "Not written: the request was cancelled."
- A5 [INFORMATIONAL] (confidence: 7/10) plan:139 — Copilot keeps `prepared` / `writeStillApproved` (`lmTools.ts:165-193`) and only gains `beforeSend`, while MCP gets `WriteGate`. Two implementations of the re-check rules, two log formats, and Copilot keeps the single "may or may not have been written" error instead of the three outcomes; the spec (line 102) says "the final authorization check is shared".
- A6 [INFORMATIONAL] (confidence: 6/10) plan:124 — `confirm` runs before the FIFO queue, so two MCP writes open two modals at once. Medium confidence, verify this is actually an issue: if VS Code shows modals one after the other, the second deadline can pass before its dialog is seen.

Dispositions: A1 accepted (R1, D2), A2 accepted (R2, D3), A3 accepted (R3, D4), A4 accepted (R4, D5), A5 accepted (R5, D6), A6 accepted (R6, D7).

### Section 2: Code quality

- Q1 [CRITICAL] (confidence: 8/10) plan:87 — "if it is not today, give it a recognisable message prefix". It is not today: `rejectAll(reason)` (`adswatch.ts:202`) gets free text from `stop` / `exited` (`host.ts:197,214,344,362`), and a settings restart during a write rejects it as "The ADS host restarted (settings changed)." The gate maps a plain error to "refused", so Claude is told "not written" for a write the host may have executed. Task 3 has no test for it.
- Q2 [INFORMATIONAL] (confidence: 6/10) plan:195 — the check order has no row for an unsupported `MCP-Protocol-Version` header; the 2025-11-25 transport text requires 400 for it. Medium confidence, verify against the spike's transport checklist.

Shared code: the plan's own extraction (`adsTools.ts`, plan:53-70) has two verified callers after Task 2 (`lmTools.ts` tool bodies, `mcpServer.ts`), moves ~150 lines and adds ~40 (estimated), and removes the drift risk the spec names as an anti-goal; no further extraction proposed.

Dispositions: Q1 accepted (R7, D8), Q2 accepted (R8, D9).

### Section 3: Tests

Framework: `node:test` over compiled `out/test/*.test.js` (`extension/package.json:1468`), pure modules only; VS Code modules are checked by hand. Coverage of the plan after D2-D9:

```
CODE PATHS                                              USER FLOWS
[+] core/adswatch.ts                                    [+] Connect (Task 9, by hand) [→E2E]
  ├── sampleAge / gapNote      [★★★ planned] T2           ├── /mcp shows iecode         [manual]
  ├── ScopeBuffer.clear        [★★  planned] T3           ├── claude missing → Copy Cmd [GAP] T3-manual
  └── RequestTimeout/HostGone  [★★★ planned] T3 (R7)      ├── takeover dialog (R2)      [GAP] T3-manual
[+] ads/host.ts write mapping  [manual] via R7 classes    └── restart keeps connection  [manual]
[+] core/writeGate.ts          [★★★ planned] T4         [+] Write (Task 9) [→E2E]
  ├── off/allow/confirm, target change, cancel            ├── confirm / cancel / auto   [manual + unit]
  ├── deadline, order, maxQueued, dispose                 ├── interrupt Claude, click   [manual + unit R4]
  └── late approval (R4), one dialog (R6), Copilot (R5)   └── target change in dialog   [manual + unit]
[+] core/toolInput.ts          [★★★ planned] T5         [+] Read / scope
[+] core/mcp.ts                [★★★ planned] T6           ├── watch shows in view       [manual]
  └── version 400 (R8)                                    └── gap note after 60 s       [unit + manual]
[+] ads/mcpServer.ts HTTP glue [GAP] F-T1               [+] Copilot tools after Task 2/R5
  ├── body cap at MAX_BODY+1, 413                         └── same texts as before      [GAP] F-T2 (regression)
  ├── res 'close' before reply → abort
  └── 127.0.0.1 bind, listen error
[+] ads/adsTools.ts texts      [GAP] F-T2
[+] core/claudeRegistration.ts [★★★ planned] T8 (cmdLine, ownerAction, connectSteps)
[+] ads/claudeConnect.ts       [manual] Task 9

COVERAGE (planned): 26/31 paths with a ★★/★★★ test or a planned manual check; GAPS: 5 (F-T1 x3, F-T2 x1, manual rows x1)
```

- F-T1 [INFORMATIONAL] (confidence: 8/10) plan:228 — "calls `McpHandler.handle` with an `AbortController` that aborts on `res.on('close')` when `res.writableFinished` is false" is in `mcpServer.ts`, which is tested by hand only (plan:212). Review Focus 2 cites `response close before reply cancels the operation`, but that Task 6 test only fires the outer signal of `McpHandler`; a wrong event (`req` instead of `res` close) or a body read that buffers past the limit passes every planned test.
- F-T2 [CRITICAL, regression] (confidence: 7/10) plan:68 — Task 2 moves the Copilot tool bodies (`lmTools.ts:70-162`) into `adsTools.ts` and R5 reroutes the Copilot write; no test covers those texts today, and Task 9's manual check exercises Claude only.
- F-T3 [INFORMATIONAL] (confidence: 8/10) spec line 206 lists "`claude` missing" and "Disconnect after another window took over" as test cases; Task 9 Step 2 has neither. Carried forward as required proof of the approved spec, no question: add both to Task 9 Step 2.

Dispositions: F-T1 accepted (R9, D10), F-T2 accepted (R10, D11), F-T3 carried forward (spec Testing, added to Task 9 Step 2). Test plan artifact: `~/.gstack/projects/JanJunklewitz-iecode/…-eng-review-test-plan-20261103-115916.md` (outside the repo).

### Section 4: Performance

- P1 [INFORMATIONAL] (confidence: 7/10) `adswatch.ts:209` `scopeText(..., maxRows = 200)` with up to `MAX_WATCHED = 200` symbols (`adswatch.ts:231`) gives a table of up to 200 x 200 cells, about 240 KB of text [estimated: 200 rows x ~1.2 KB], far above what a Claude Code MCP tool result should carry; the spec (line 89) says "Output size is bounded too" and the plan has no bound. Scale: one call, not per request; Copilot gets the same text today.
- No other issues: the per-request work is one JSON parse of at most 1 MB and the existing tool bodies; no loops over unbounded data, the queue is bounded (`maxQueued` 10), the server keeps no per-session state.

Dispositions: P1 accepted (R11, D12).

### Outside voice (Claude subagent, native fallback: Codex CLI not installed)

The independent Plan subagent finished within the 5 min limit and reported 17 findings (O1-O17, numbered as in its report). Summary:

- O1 High: `claude` is resolved with the workspace folder as cwd; libuv and `cmd.exe` search the cwd before PATH, so a `claude.exe` / `claude.cmd` at the repo root runs on Connect and on the silent re-registration.
- O2 High: the token survives a port change; another Windows user who squats the stored port while VS Code is closed receives the bearer token from every Claude session and can use it on the new port.
- O3 High: `notifications/cancelled` is keyed by JSON-RPC id only; with several Claude sessions on one stateless server, session A's cancel aborts session B's request with the same id.
- O4 High: after a deadline or abort the stale modal stays open, so R6's "one dialog at a time" breaks: the next dialog opens behind it.
- O5 High: result texts name Copilot tools ("use adsScope", "add symbols with adsWatch first", "Call adsWrite again", `lmTools.ts:114,153,193`); R10's golden tests would freeze them for Claude.
- O6 Medium: local-scope lookup by path (drive-letter case from `Uri.fsPath`, subfolder of a git repo) is unverified; the spike registers and calls from the same cwd.
- O7 Medium: Task 8's `registeredPort` test needs `claude mcp get` output the spike never records; that output is scope-merged and health-checks the server.
- O8 Medium: Disconnect compares with `port()`, which is undefined while the server does not listen, so the entry stays.
- O9 Medium: workspace folders added or removed after Connect are not handled.
- O10 Medium: `HttpIn` has no path, so `/mcp` cannot be enforced and OAuth discovery probes get the bearer 401 instead of 404.
- O11 Medium: the measured client tool timeout never feeds the 2 min deadline.
- O12 Medium (strategic): most of the risk sits in per-folder, per-port registration; a user-scope stdio bridge in the `iecode` CLI with a discovery file would remove it.
- O13 Low: refused text doubles "Not written:" when the reason is the off text.
- O14 Low: the `ads_write` mapping omits `via: 'MCP'`; the dialog must show the target key the op is bound to.
- O15 Low: a value read back by a write has no time, so the sample age must not be appended to it.
- O16 Low: a Copilot `invoke` without a stored prepare decision is unspecified.
- O17 Low: the Copy Command note should say that the clipboard history may keep the token.

Carried forward without a question (they implement contracts already approved; evidence in brackets):
- O8 → Task 8: Disconnect compares `registeredPort` with the stored `iecode.mcp.port`, not `port()` [spec line 163: "only if it still points to this window's port"].
- O10 → Task 6: `HttpIn` gains `path`; any path other than `/mcp` → 404 before the auth check; test `wrong path gives 404` [plan:17 "path `/mcp`"].
- O13 → Task 4: the refused reason never carries the "Not written:" prefix; the off reason is "AI writes are off. The user can allow them …" [exact strings of `writeResultText`, plan:130].
- O14 → Task 7: `ads_write` passes `via: 'MCP'`; the dialog renders `op.targetKey` [R5 type; spec line 125 "as shown in the dialog"].
- O15 → Task 2: the age is appended only for values taken from the buffer, not for a written read-back [plan:68 "for a value taken from the buffer"].
- O16 → Task 4: a Copilot `invoke` without a stored prepare decision is refused as today ("needs the user's confirmation. Call the write tool again") [R10 regression contract].
- O17 → Task 8: the Copy Command note says "contains the access token; Windows clipboard history may keep it" [spec line 147 note].

## Decision ledger

### R1: How Connect starts an npm install of Claude Code
Finding: A1, CRITICAL, 8/10, plan:256, reviewer: Claude (plan-eng-review)
Plan baseline: `spawn('claude', args, { shell: false })`, else resolve `claude.cmd` / `claude.exe` like `cli/iecode.ts` (plan:256, original proposal)
Runtime evidence: the native installer puts `claude.exe` in `%USERPROFILE%\.local\bin`, npm puts `claude.cmd` in `%APPDATA%\npm` (both on this machine, `where claude`); Node rejects `.cmd` with `shell: false` (EINVAL)
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| R1 launcher when only `claude.cmd` exists | plan:256, fails with EINVAL | `claude.exe` from PATH first; else run `claude.cmd` through `cmd.exe /d /s /c` with a pure quoting helper in `core/claudeRegistration.ts` that refuses arguments with `" & \| < > ^ % !`; unit tests for the helper | `claude.exe` only; without it Connect offers "Copy Command" and names the reason (npm install found) | unchanged plan text |

Question D2:
D2 — How should Connect start Claude Code when only the npm version (claude.cmd) is installed?
Project/branch/task: ph/ads-watchlist, Task 8 of the ADS MCP plan.
ELI10: Connect runs `claude mcp add` for the user. Claude Code comes either as claude.exe (native installer) or as claude.cmd (npm). Node refuses to start a .cmd file without a shell, so the plan's fallback errors out for npm users.
Stakes if we pick wrong: npm users get an error on Connect instead of a registration or a clear manual path.
Recommendation: A because it makes Connect work for both installs and the quoting helper is small and unit-tested.
Completeness: A=10/10, B=7/10, C=3/10
Header: Claude start
Options:
A) cmd.exe fallback
claude.exe first; else claude.cmd through `cmd.exe /d /s /c` with a tested quoting helper that refuses cmd metacharacters (token is hex, port numeric). human ~2h / CC ~15 min; risk: quoting bug, caught by the helper tests.
B) claude.exe only
Only claude.exe is started; npm-only installs get "Copy Command" with the reason. human ~30 min / CC ~5 min; npm users paste the command once by hand.
C) Keep plan text
No change; the implementer finds the EINVAL during Task 8 and decides then. No effort now; npm users may hit an error.

State: approved
Actual answer: A) cmd.exe fallback (D2, 2026-11-03)
Accepted scope: Task 8 starts `claude.exe` from PATH first; if only `claude.cmd` exists it runs it through `cmd.exe /d /s /c` with `cmdLine(args)` from `core/claudeRegistration.ts`, which refuses arguments with cmd metacharacters; test `cmdLine quotes arguments and refuses metacharacters`.
History: none

### R2: Owner check when another workspace serves the same folder
Finding: A2, INFORMATIONAL, 7/10, plan:256, reviewer: Claude (plan-eng-review)
Plan baseline: Connect refuses if "the stored port answers `initialize` with this workspace's token while this window's server is not running" (plan:256, original proposal)
Runtime evidence: port and token are stored per workspace (`workspaceState`, SecretStorage key with the workspace id, plan:222,227); VS Code focuses the existing window when the same workspace is opened again; `--scope local` keys the registration by folder path
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| R2 a folder is already registered to another port | plan:256 checks only this workspace's stored port; a different workspace's entry is overwritten silently | before replacing an entry that points to another port, probe that port without a token; a 401 with `WWW-Authenticate: Bearer realm="iecode"` means another IECode window serves it, so Connect asks "Take over" / "Cancel"; pure helper `ownerAction(registeredPort, ownPort, probe)` with tests; Task 6 sets that realm | drop the owner check: the last Connect wins and the message names the port it replaced | unchanged plan text |

Question D3:
D3 — What should Connect do when the folder is already registered to another IECode window?
Project/branch/task: ph/ads-watchlist, Task 8 of the ADS MCP plan.
ELI10: Claude Code stores one `iecode` entry per folder. Two VS Code windows with different workspaces can contain the same folder. The planned check only catches the same workspace twice, which VS Code already prevents, so the real case overwrites the other window's entry without a word.
Stakes if we pick wrong: Claude reads and writes through a window the user is not looking at, with that window's target.
Recommendation: A because it detects the real case and lets the user decide, at the cost of one probe request and a small pure helper.
Completeness: A=10/10, B=7/10, C=4/10
Header: Owner check
Options:
A) Probe and ask
Probe the registered port; an IECode 401 means another window serves the folder, so ask Take over / Cancel. human ~2h / CC ~15 min; one extra request per Connect.
B) Last Connect wins
No owner check; Connect replaces the entry and names the replaced port. human ~15 min / CC ~3 min; the other window loses Claude silently apart from that message.
C) Keep plan text
Keep the check as written; it never fires in practice. No effort; the overwrite stays unnoticed.

State: approved
Actual answer: A) Probe and ask (D3, 2026-11-03)
Accepted scope: Task 6 answers 401 with `WWW-Authenticate: Bearer realm="iecode"`; Task 8 replaces the same-token check: before replacing a folder's `iecode` entry that points to another port, it probes that port without a token, and a 401 with that realm makes Connect ask "Take over" / "Cancel" (Cancel leaves everything unchanged); pure `ownerAction` in `core/claudeRegistration.ts` with test `ownerAction asks only when another IECode serves the folder`.
History: none

### R3: Rollback of a multi-root Connect that fails part-way
Finding: A3, INFORMATIONAL, 8/10, plan:257, reviewer: Claude (plan-eng-review)
Plan baseline: per folder remove + add, restore that folder's previous entry on failure; "Only after every folder succeeded set `iecode.mcp.connected = true`" (plan:257, original proposal)
Runtime evidence: none (proposed code); spec line 151 requires Connect to be transactional
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| R3 folders already registered when a later folder fails | stay registered to the new port while `connected` is false | Connect undoes its own changes in reverse order (restore each replaced entry, remove each new one), stops the server if this Connect started it, reports the failing folder; the pure step list comes from `connectSteps(folders, entries)` with a test for the rollback order | keep the registered folders, set `connected` true for them only if at least one succeeded, and name the failed folders | unchanged plan text |

Question D4:
D4 — What should happen to the folders already registered when Connect fails for a later folder?
Project/branch/task: ph/ads-watchlist, Task 8 of the ADS MCP plan.
ELI10: In a workspace with several folders Connect registers one folder after the other. If the third fails, the first two point to a server that is then marked as not connected, so Claude works there but IECode thinks it is off.
Stakes if we pick wrong: registrations nobody owns: Disconnect and the next start do not know about them.
Recommendation: A because the spec asks for a transactional Connect and the rollback list is a small pure function.
Completeness: A=10/10, B=7/10, C=4/10
Header: Rollback
Options:
A) Full rollback
Undo this Connect's changes in reverse order, stop a server it started, name the failing folder; pure `connectSteps` with a rollback test. human ~2h / CC ~15 min.
B) Keep partial
Keep the folders that worked, mark connected, name the failed ones. human ~30 min / CC ~5 min; a later Disconnect must handle a partly registered workspace.
C) Keep plan text
No change; orphaned registrations stay possible. No effort.

State: approved
Actual answer: A) Full rollback (D4, 2026-11-03)
Accepted scope: Task 8: when a folder fails, Connect undoes its own changes in reverse order (restore each replaced entry, remove each new one), stops the server if this Connect started it, leaves `connected` false and names the failing folder; the step and undo list comes from pure `connectSteps(folders, entries)` in `core/claudeRegistration.ts` with test `connectSteps undoes in reverse order`.
History: none

### R4: User notice when "Write" is clicked after the request ended
Finding: A4, INFORMATIONAL, 7/10, plan:126, reviewer: Claude (plan-eng-review)
Plan baseline: "an aborted signal after the dialog resolves counts as declined" (plan:126, original proposal); nothing shown to the user
Runtime evidence: none (proposed code); spec line 131: "A later click on "Write" then writes nothing; IECode logs it and shows "Not written: the request was cancelled.""
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R4 user clicks "Write" after cancel or deadline | nothing visible | `GateDeps.lateApproval(op, reason)` is called when `confirm` resolves `true` after the abort or the deadline; `adsWrite` shows a non-modal warning "IECode: <symbol> was not written: <reason>." and logs it; test `gate reports a late approval` | log line only |

Question D5:
D5 — Should IECode tell the user when they click "Write" after Claude cancelled or the 2 min deadline passed?
Project/branch/task: ph/ads-watchlist, Task 4 of the ADS MCP plan.
ELI10: VS Code cannot close a modal dialog from code. If Claude gives up while the dialog is open, a later click on "Write" correctly writes nothing, but the user sees no reaction and may think the value is in the PLC.
Stakes if we pick wrong: the user believes a PLC variable was set when it was not.
Recommendation: A because the spec already promises this message and it costs one callback and one test.
Completeness: A=10/10, B=6/10
Header: Late click
Options:
A) Show a warning
`lateApproval` callback, non-modal warning naming symbol and reason, plus log; test `gate reports a late approval`. human ~45 min / CC ~5 min.
B) Log only
Only the IECode output gets a line. human ~10 min / CC ~2 min; the user sees nothing unless they open the output.

State: approved
Actual answer: A) Show a warning (D5, 2026-11-03)
Accepted scope: Task 4: `GateDeps.lateApproval(op, reason)` is called when `confirm` resolves `true` after the abort or the deadline; `adsWrite` shows a non-modal warning "IECode: <symbol> was not written: <reason>." and logs it; test `gate reports a late approval`.
History: none

### R5: One write path for Copilot and MCP
Finding: A5, INFORMATIONAL, 7/10, plan:139, reviewer: Claude (plan-eng-review)
Plan baseline: Copilot keeps `prepareInvocation` + `prepared` map + `writeStillApproved` and only adds `beforeSend` for the target key; MCP uses `WriteGate` (plan:139, original proposal)
Runtime evidence: `lmTools.ts:165-203` holds the Copilot re-check and its own log lines; `host.ts:170` gives one "may or may not have been written" error for every timeout
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R5 Copilot write path | own re-check (`writeStillApproved`), `beforeSend` for the target only, single error text | `prepareInvocation` stores `{ decision, targetKey }`; `invoke` calls `gate.run({ symbol, value, targetKey, prepared: { decision } }, signal from the cancellation token)`; the gate skips its own dialog for a prepared op, applies the same `beforeSend` rules (cancelled, now refuse, allow→confirm, target changed), queue, log (`via Copilot`) and the three outcome texts; `writeStillApproved` moves into the gate with its existing tests; tests `gate takes a prepared Copilot approval` and `gate refuses a prepared allow that now needs confirmation` | plan as written |

Question D6:
D6 — Should Copilot writes run through the same write gate as MCP writes?
Project/branch/task: ph/ads-watchlist, Task 4 of the ADS MCP plan.
ELI10: The plan builds a new write gate for Claude (queue, re-checks, cancel, three outcomes) and patches only the target check into the Copilot write. The rules then live twice, and Copilot keeps the old single error for an unclear outcome.
Stakes if we pick wrong: the two clients drift, which the spec lists as an anti-goal; Copilot may retry a write whose outcome is unknown.
Recommendation: A because one gate gives both clients the same rules and outcome texts, and Copilot's own dialog simply replaces the gate's.
Completeness: A=10/10, B=6/10
Header: Write path
Options:
A) One gate for both
Copilot `invoke` calls `gate.run` with its prepared decision; same queue, re-checks, log and three outcomes; `writeStillApproved` moves into the gate. human ~3h / CC ~20 min; Copilot result texts change to the new outcome texts.
B) Plan as written
Copilot keeps its own check plus `beforeSend`. human ~1h / CC ~10 min; two rule sets to keep in step.

State: approved
Actual answer: A) One gate for both (D6, 2026-11-03)
Accepted scope: Task 4: `WriteOp` gains `via: 'MCP' | 'Copilot'` and `prepared?: { decision: WriteDecision }`; Copilot's `prepareInvocation` stores `{ decision, targetKey }`, its `invoke` calls `gate.run` with that op and an `AbortSignal` from the cancellation token, and returns `writeResultText`; the gate skips its own dialog for a prepared op and applies the same `beforeSend` rules, queue, log and outcome texts; `writeStillApproved` moves into the gate with its existing tests; tests `gate takes a prepared Copilot approval` and `gate refuses a prepared allow that now needs confirmation`.
History: none

### R6: One confirmation dialog at a time
Finding: A6, INFORMATIONAL, 6/10, plan:124, reviewer: Claude (plan-eng-review)
Plan baseline: "`confirm` → `confirm(op, signal)` raced against the deadline and `signal`; then the op waits its turn in a FIFO queue" (plan:124, original proposal)
Runtime evidence: unknown whether VS Code shows two modal `showWarningMessage` calls at once or one after the other; either way the deadline of the second starts before the user can see it
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R6 several MCP writes need confirmation | dialogs open in parallel, each deadline starts at once | each op enters the FIFO queue first; its dialog opens when it reaches the head; the 2 min deadline starts when its dialog opens; `maxQueued` counts ops waiting for a dialog too; test `gate shows one dialog at a time` | plan as written |

Question D7:
D7 — Should the write gate show one confirmation dialog at a time?
Project/branch/task: ph/ads-watchlist, Task 4 of the ADS MCP plan.
ELI10: If Claude asks for two writes quickly, the plan opens two dialogs at once. The user may confirm them in the wrong order, and the second dialog's 2 minute timer runs while it may still be hidden behind the first.
Stakes if we pick wrong: a write the user approved is dropped because its timer ran out unseen, or writes land in an order the user did not intend.
Recommendation: A because queue-then-confirm keeps order and timers honest with the same queue the plan already has.
Completeness: A=9/10, B=6/10
Header: Dialogs
Options:
A) Queue, then dialog
Ops queue first; one dialog at a time; deadline starts at its dialog; test `gate shows one dialog at a time`. human ~1h / CC ~10 min; a second write waits while the first dialog is open.
B) Plan as written
Parallel dialogs, deadline from the start of each request. No extra effort; order and hidden timers as described.

Reopened (O4, High, 7/10, plan:129, outside voice): VS Code cannot close a modal, so after a deadline or an abort the stale dialog stays open while the gate moves on; the next dialog opens behind it and its deadline runs unseen, which R6 was meant to stop.
Comparison grid (reopened):

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R6 next dialog after a deadline or abort | opens at once (R6 / D7) | the deadline or abort refuses the op at once, but the next dialog opens only after the previous `confirm` promise has settled (the user clicked or closed it); the next deadline starts when its dialog opens; `lateApproval` (R4) still fires; test `gate waits for a stale dialog before the next` | keep R6 as approved | investigate first (bounded: 20 min F5 check whether VS Code stacks or queues two modals), no change approved | defer this change only |

Question D16:
D16 — After a deadline or an abort, should the next write dialog wait until the stale one is closed?
Project/branch/task: ph/ads-watchlist, Task 4 of the ADS MCP plan.
ELI10: D7 made the gate show one dialog at a time. But when a dialog times out or Claude cancels, the dialog stays on screen. The gate then opens the next one behind it, so its 2 minute timer runs unseen and the user may click "Write" on the old one.
Stakes if we pick wrong: the one-dialog rule from D7 breaks in exactly the case it was for.
Recommendation: A because waiting for the real close keeps D7's promise and costs one extra await and a test.
Completeness: A=10/10, B=6/10, C=7/10, D=6/10
Header: Stale dialog
Options:
A) Apply this change
Refuse at once, but open the next dialog only after the stale one is closed; test `gate waits for a stale dialog before the next`. human ~45 min / CC ~5 min.
B) Keep this row's current value
R6 as approved in D7. No effort; dialogs can stack after a timeout.
C) Investigate before choosing
20 min F5 check of modal stacking; no change approved until then.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D16, 2026-11-03)
Accepted scope: Task 4: queue first, one dialog, deadline from dialog open, `maxQueued`, test `gate shows one dialog at a time` (D7); plus a deadline or abort refuses the op at once, but the next dialog opens only after the previous `confirm` promise has settled; the next deadline starts when its dialog opens; `lateApproval` (R4) still fires; test `gate waits for a stale dialog before the next`.
History: D7 (2026-11-03) answered A) Queue, then dialog, accepted scope "queue first, one dialog, deadline from dialog open, `maxQueued`, test `gate shows one dialog at a time`"; reopened for O4 (concrete new risk), answered in D16.

### R7: Telling "not sent" from "outcome unknown" in the host
Finding: Q1, CRITICAL, 8/10, plan:87, reviewer: Claude (plan-eng-review)
Plan baseline: "The `PendingRequests` rejection on host exit must be distinguishable; if it is not today, give it a recognisable message prefix and match it like `timedOut`" (plan:87, original proposal); Task 3 tests only `ScopeBuffer.clear`
Runtime evidence: not distinguishable today: `rejectAll(reason)` (`adswatch.ts:202`) rejects with free text from `stop` ("The ADS host stopped.", "The ADS host restarted (settings changed).", "… (idle).", `host.ts:197,214,362`) and `exited` (`host.ts:344`); `timedOut` matches a message prefix (`host.ts:222-225`); `request()` rejects "The ADS host is not running." before anything is sent (`host.ts:370`)
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R7 classification of a failed write | message prefix for timeouts only; every other rejection is a plain error that Task 4 maps to "refused" | `core/adswatch.ts` exports `RequestTimeout` and `HostGone` error classes; `PendingRequests` rejects with them (timeout, `rejectAll`); `host.write` maps either one after the request was written to `WriteOutcomeUnknown`, the "not running" rejection and `beforeSend` to `WriteNotSent`, an `ok:false` reply stays a plain error; `timedOut` uses `instanceof`; tests `PendingRequests tells a timeout from a host exit` and `rejectAll after a settings restart is a host exit` | plan text as written (conditional prefix, no test) |

Question D8:
D8 — How should the host tell a write that was never sent from one whose outcome is unknown?
Project/branch/task: ph/ads-watchlist, Task 3 of the ADS MCP plan.
ELI10: When the ADS host restarts (for example after a target change) or exits while a write is in flight, today's code rejects with a free-text message. The plan's gate would read that as "not written", so Claude may write again although the first write may already be in the PLC.
Stakes if we pick wrong: a double write to the PLC, the exact case the "outcome unknown" text exists to prevent.
Recommendation: A because error classes make the distinction explicit and two pure tests in adswatch.test.ts pin it.
Completeness: A=10/10, B=5/10
Header: Outcomes
Options:
A) Error classes
`RequestTimeout` / `HostGone` from `PendingRequests`; `host.write` maps them after sending to `WriteOutcomeUnknown`; two pure tests. human ~1.5h / CC ~10 min.
B) Plan as written
Message prefix if needed, no test. No extra effort; a restart during a write can still be reported as "not written".

State: approved
Actual answer: A) Error classes (D8, 2026-11-03)
Accepted scope: Task 3: `core/adswatch.ts` exports `RequestTimeout` and `HostGone`; `PendingRequests` rejects a timeout with `RequestTimeout` and `rejectAll` with `HostGone`; `host.write` maps either one, once the request was written, to `WriteOutcomeUnknown`, maps the "not running" rejection and a `beforeSend` refusal to `WriteNotSent`, keeps an `ok:false` reply a plain error; `timedOut` uses `instanceof`; tests `PendingRequests tells a timeout from a host exit` and `rejectAll after a settings restart is a host exit`.
History: none

### R8: Unsupported MCP-Protocol-Version header
Finding: Q2, INFORMATIONAL, 6/10, plan:195, reviewer: Claude (plan-eng-review)
Plan baseline: check order Origin → Host → token → method → size → JSON (plan:195); version handling "per checklist" for `initialize` only (original proposal)
Runtime evidence: none (proposed code); the 2025-11-25 Streamable HTTP text requires 400 for an invalid or unsupported `MCP-Protocol-Version`; which revision Claude Code 2.1.306 sends is a spike question
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R8 request with an unsupported `MCP-Protocol-Version` | not specified | after the token check, a present header that is not in the supported set from the spike checklist → 400 with a JSON-RPC error naming the supported versions; a missing header is accepted; test `unsupported protocol version header gives 400` | left to the spike checklist, no test row |

Question D9:
D9 — Should the MCP layer answer 400 to an unsupported MCP-Protocol-Version header, with a test?
Project/branch/task: ph/ads-watchlist, Task 6 of the ADS MCP plan.
ELI10: MCP clients send the protocol revision they speak in a header. The spec says a server must answer 400 when it does not support that revision, so the client can tell instead of getting odd answers later.
Stakes if we pick wrong: after a Claude Code update, calls fail in confusing ways instead of with a clear version error.
Recommendation: A because it is one branch and one test row, and the supported set comes from the spike anyway.
Completeness: A=9/10, B=6/10
Header: Version 400
Options:
A) 400 plus test
Present and unsupported → 400 naming the supported versions; missing header accepted; one test row. human ~30 min / CC ~5 min.
B) Spike decides
Leave it to the spike's transport checklist without a planned test. No effort now; may be forgotten.

State: approved
Actual answer: A) 400 plus test (D9, 2026-11-03)
Accepted scope: Task 6: after the token check, a present `MCP-Protocol-Version` header that is not in the supported set from the spike checklist → 400 with a JSON-RPC error naming the supported versions; a missing header is accepted; test `unsupported protocol version header gives 400`.
History: none

### R9: Tests for the HTTP glue of the MCP server
Finding: F-T1, INFORMATIONAL, 8/10, plan:228, reviewer: Claude (plan-eng-review)
Plan baseline: `mcpServer.ts` (VS Code module) holds `http.createServer`, the body cap and the `res` close abort; "Test: manual" (plan:212, original proposal)
Runtime evidence: none (proposed code); `node:http` needs no VS Code, so this glue can run under `node --test`
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R9 HTTP glue (bind, body cap, close → abort, listen error) | in `ads/mcpServer.ts`, manual check only | new `core/mcpHttp.ts`: `serveMcp(handle, { port }): Promise<{ port: number; close(): Promise<void> }>` with `node:http` only; `mcpServer.ts` keeps SecretStorage, workspaceState, status and tool wiring; tests on a real socket: `serveMcp binds 127.0.0.1`, `body over the limit gives 413 without reading it all`, `client disconnect aborts the running call`, `a taken port rejects start` | keep it in `mcpServer.ts`, manual curl check in Task 7 |

Question D10:
D10 — Should the HTTP part of the MCP server move into a pure module with real-socket tests?
Project/branch/task: ph/ads-watchlist, Tasks 6-7 of the ADS MCP plan.
ELI10: The plan tests the MCP protocol logic, but the part that reads the HTTP body, enforces the size limit and notices that Claude hung up lives in a VS Code module tested only by hand. That last part is what makes "Claude interrupted, then the user clicks Write" safe.
Stakes if we pick wrong: a wiring mistake (wrong close event, body read past the limit) ships unnoticed, and a cancelled write can still be confirmed.
Recommendation: A because `node:http` runs fine under `node --test` and four tests pin the cancellation the review focus depends on.
Completeness: A=10/10, B=6/10
Header: HTTP tests
Options:
A) core/mcpHttp.ts
Move the `node:http` glue into a pure module; four real-socket tests. human ~3h / CC ~20 min; one more core file.
B) Manual only
Keep the glue in `mcpServer.ts`, curl check by hand. No extra effort; the close → abort wiring has no automated test.

State: approved
Actual answer: A) core/mcpHttp.ts (D10, 2026-11-03)
Accepted scope: Task 7: new `core/mcpHttp.ts` with `serveMcp(handle, { port }): Promise<{ port: number; close(): Promise<void> }>` using `node:http` only (127.0.0.1, body cap at `MAX_BODY + 1`, `AbortController` on `res` close before the reply, listen error rejects); `mcpServer.ts` keeps SecretStorage, workspaceState, status and tool wiring; tests in `test/mcpHttp.test.ts` on a real socket: `serveMcp binds 127.0.0.1`, `body over the limit gives 413 without reading it all`, `client disconnect aborts the running call`, `a taken port rejects start`.
History: none

### R10: Regression contract for the Copilot tools
Finding: F-T2, CRITICAL (regression), 7/10, plan:68, reviewer: Claude (plan-eng-review)
Plan baseline: Task 2 moves the tool bodies of `lmTools.ts:70-162` into `adsTools.ts` (VS Code module, no tests); R5 reroutes the Copilot write through the gate; Task 9 checks Claude only (original proposal)
Runtime evidence: no test imports `lmTools.ts` (`extension/test/*.test.ts`); the text builders `list`, `scopeSummary`, the read rows and the symbols listing read `vscode.workspace` settings and `AdsHost` directly (`lmTools.ts:39-59,72-95,128-141`)
Behavior to preserve: the result texts of `adsSymbols`, `adsWatch`, `adsRead`, `adsScope` for Copilot, byte for byte, except the intended changes. Intended changes: the scope's "may have stopped" clause becomes `gapNote`; a buffered read value gains ` (<n> s old)`; Copilot write results become the three `writeResultText` outcomes (R5).
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R10 how the preserved Copilot texts are proven | not covered | pure text builders in new `core/adsToolText.ts` (input: plain items, entries, latest values, sample interval, target, now); `adsTools.ts` gathers the data and calls them; golden tests in `test/adsToolText.test.ts` for each tool, with expected strings captured from the current `lmTools.ts` before the move, plus one test per intended change | Task 2 commit is move-only; Task 9 Step 2 gains a Copilot row: each of the five tools once in Copilot Chat, texts compared with a run on 51a123c |

Question D11:
D11 — How do we prove the Copilot tools still answer the same after the move?
Project/branch/task: ph/ads-watchlist, Task 2 (and R5) of the ADS MCP plan.
ELI10: The plan moves the Copilot tool logic into a shared file and reroutes the Copilot write. Nothing tests those texts today, so a slip in the move changes what Copilot sees without anyone noticing. Contract: same texts as now, except the gap note, the sample age and the three write outcomes.
Stakes if we pick wrong: Copilot quietly gets different or broken answers, the drift the spec names as an anti-goal.
Recommendation: A because pure text builders give golden tests that also guard the MCP side, at the cost of one more core file.
Completeness: A=10/10, B=7/10
Header: Copilot test
Options:
A) Golden text tests
New pure `core/adsToolText.ts`, golden tests per tool from today's strings plus the intended changes. human ~4h / CC ~25 min; one more core file and test file.
B) Manual comparison
Move-only commit and a Copilot row in Task 9 comparing texts with 51a123c by hand. human ~1h / CC ~5 min; no automated guard for later changes.

State: approved
Actual answer: A) Golden text tests (D11, 2026-11-03)
Accepted scope: Task 2: new pure `core/adsToolText.ts` with the text builders of the four read-side tools (input: plain items, entries, latest values with time, sample interval, target, now); `adsTools.ts` gathers the data and calls them; `test/adsToolText.test.ts` holds golden tests per tool with expected strings taken from the current `lmTools.ts` before the move, plus one test per intended change (gap note, sample age); the write texts are covered by `writeResultText` (Task 4).
History: none

### R11: Size bound for tool results
Finding: P1, INFORMATIONAL, 7/10, adswatch.ts:209, reviewer: Claude (plan-eng-review)
Plan baseline: no bound on result text (original proposal); spec line 89 asks for one
Runtime evidence: `scopeText` caps rows at 200 but not columns; 200 watched symbols are allowed (`adswatch.ts:231`)
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| R11 result text size | unbounded (scope up to ~240 KB) | `scopeText` keeps at most 20 symbols in the table (summary lines for all) and every tool result is cut at 50 000 characters with "(output truncated: ask for fewer symbols or a shorter time span)"; both in core with tests `scope table keeps 20 symbols` and `tool text is cut at the limit` | no bound |

Question D12:
D12 — Should the ADS tools bound the size of their answers?
Project/branch/task: ph/ads-watchlist, Tasks 2 and 6 of the ADS MCP plan.
ELI10: Asking for the scope of all 200 watched variables builds a table of up to 200 x 200 values, roughly 240 KB of text. Claude Code warns about or cuts large tool results, and it costs a lot of context either way.
Stakes if we pick wrong: one scope call fills Claude's context or is cut off at a random point without a hint.
Recommendation: A because a table cap plus a clear truncation note keeps answers usable, for Copilot too.
Completeness: A=9/10, B=5/10
Header: Output cap
Options:
A) Cap the output
At most 20 symbols in the scope table (summaries for all), every result cut at 50 000 characters with a note; two core tests. human ~1h / CC ~10 min.
B) No bound
Keep today's size. No effort; big scopes may be cut by the client.

State: approved
Actual answer: A) Cap the output (D12, 2026-11-03)
Accepted scope: Task 2: `scopeText` keeps at most 20 symbols in the table (summary lines for all, and a line naming the left-out ones); `capText(text, 50_000)` in `core/adsToolText.ts` cuts every tool result with "(output truncated: ask for fewer symbols or a shorter time span)"; tests `scope table keeps 20 symbols` and `tool text is cut at the limit`. This is a third intended change of the Copilot texts in R10's contract.
History: none

### R12: Where the `claude` executable is looked up
Finding: O1, High, 8/10, plan:268-269, reviewer: outside voice (Claude subagent)
Plan baseline: R1 accepted scope: `spawn('claude', args, { cwd: folder })`, else `cmd.exe /d /s /c claude.cmd …` with `cwd: folder` (D2)
Runtime evidence: libuv's Windows `search_path` checks the cwd before PATH for a bare name; `cmd.exe` does the same; the workspace folder is a cloned repository
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R12 lookup of `claude` | bare name with the folder as cwd (repo root wins) | resolve an absolute path from the PATH entries only (`claude.exe`, then `claude.cmd`), skipping the cwd and relative PATH entries; spawn that absolute path (cwd stays the folder for the local scope); pure `findOnPath(pathEnv, exists)` with test `findOnPath ignores the current folder and relative entries` | keep the R1 text | investigate first (bounded: confirm the cwd-first lookup with a probe file, 15 min), no change approved | defer this change only |

Question D13:
D13 — Should Connect look up `claude` on PATH itself so a file in the repository can never run instead?
Project/branch/task: ph/ads-watchlist, Task 8 of the ADS MCP plan.
ELI10: Connect starts `claude` with the workspace folder as working directory. Windows looks in that folder first, so a `claude.exe` or `claude.cmd` committed to a repository would run instead of the real Claude Code, also silently when IECode re-registers on start.
Stakes if we pick wrong: opening a cloned repository and connecting runs code from that repository.
Recommendation: A because an absolute path from PATH closes the hole for a small pure function.
Completeness: A=10/10, B=3/10, C=5/10, D=3/10
Header: claude path
Options:
A) Apply this change
Absolute path from PATH entries only, cwd and relative entries skipped; `findOnPath` with a test. human ~1h / CC ~10 min.
B) Keep this row's current value
Bare `claude` with the folder as cwd, as approved in R1. No effort; a repo file can shadow Claude Code.
C) Investigate before choosing
15 min probe of the lookup order; no change approved until then.
D) Defer this proposed change only
Leave R1 as is now; this row stays unresolved.

State: approved
Actual answer: A) Apply this change (D13, 2026-11-03)
Accepted scope: Task 8: resolve an absolute path from the PATH entries only (`claude.exe`, then `claude.cmd`), skipping the cwd and relative PATH entries, and spawn that path (`claude.cmd` through `cmd.exe /d /s /c` per R1); cwd stays the folder for the local scope; pure `findOnPath(pathEnv, exists)` in `core/claudeRegistration.ts` with test `findOnPath ignores the current folder and relative entries`. Not found → Copy Command.
History: none

### R13: Token lifetime across restarts
Finding: O2, High, 7/10, plan:19, spec:157-161, reviewer: outside voice (Claude subagent)
Plan baseline: token created on first Connect, kept until Disconnect; port stored and reused across restarts (plan:19, plan:227, original proposal)
Runtime evidence: ports on 127.0.0.1 are shared by all Windows users; Claude Code sends the stored header to whatever listens on the registered port; spec line 35 lists "another Windows user on the machine" as an anti-goal
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R13 token lifetime | until Disconnect; a token sent to a port squatter stays valid on every later start | a new token at every server start; the start re-registers each folder with it (same `connectSteps` / rollback as Connect, silent unless it fails); the old token is rejected from then on; a Claude session that was running across the VS Code restart needs `/mcp` once | keep: token until Disconnect | investigate first (bounded: 30 min on Windows exclusive bind for 127.0.0.1 so another user cannot squat while IECode runs), no change approved | defer this change only |

Question D14:
D14 — Should the access token change at every start of the MCP server?
Project/branch/task: ph/ads-watchlist, Tasks 7-8 of the ADS MCP plan.
ELI10: The port is kept across restarts and the token lives until Disconnect. While VS Code is closed, another Windows user can listen on that port; every Claude session started then hands them the token, which still works when IECode comes back.
Stakes if we pick wrong: another user on the machine can read and write PLC variables, which the spec rules out.
Recommendation: A because a fresh token per start makes a leaked token worthless, at the cost of a silent re-registration and a `/mcp` reconnect after a VS Code restart.
Completeness: A=9/10, B=4/10, C=6/10, D=4/10
Header: Token
Options:
A) Apply this change
New token at every server start, folders re-registered silently; running Claude sessions need `/mcp` after a VS Code restart. human ~2h / CC ~15 min.
B) Keep this row's current value
Token until Disconnect. No effort; a squatted port leaks a lasting token.
C) Investigate before choosing
30 min on exclusive binding; no change approved until then.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D14, 2026-11-03)
Accepted scope: Tasks 7-8: every server start creates a new token (SecretStorage), and the start re-registers each folder with it through the same `connectSteps` / rollback as Connect (silent unless it fails, then one warning); the old token is rejected from then on; Task 9 records that a Claude session running across a VS Code restart needs `/mcp` once.
History: none

### R14: Cancellation by request id with several Claude sessions
Finding: O3, High, 7/10, plan:197, plan:202, reviewer: outside voice (Claude subagent)
Plan baseline: `notifications/cancelled` → `cancel(params.requestId)` aborts the running call with that id (plan:202, original proposal)
Runtime evidence: the server keeps no session (spec line 79); terminal and VS Code Claude sessions, and several folders, share one server; JSON-RPC ids are per client and start small, so they collide
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R14 handling of `notifications/cancelled` | aborts every running call with that id, across sessions | the closed response stays the primary cancel signal; `notifications/cancelled` aborts a call only when exactly one running call has that id, otherwise it is ignored and logged; test `cancelled with an ambiguous id aborts nothing`; the spike records which signal Claude Code sends | keep: abort by id | investigate first (bounded: spike Step 3 records whether Claude Code closes the connection, sends the notification, or both), no change approved | defer this change only |

Question D15:
D15 — How should a cancel notification behave when several Claude sessions use the server?
Project/branch/task: ph/ads-watchlist, Task 6 of the ADS MCP plan.
ELI10: Claude can say "cancel request 5". The server has no sessions, and two Claude windows both number their requests from 1, so session A's cancel can stop session B's request 5, for example B's open write dialog.
Stakes if we pick wrong: one Claude session aborts another's read or write without either knowing why (it fails safe for writes, but confuses).
Recommendation: A because the closed connection already identifies the right call, and an ambiguous id is safer ignored than guessed.
Completeness: A=9/10, B=5/10, C=7/10, D=5/10
Header: Cancel id
Options:
A) Apply this change
Connection close is the main signal; id cancel only when unambiguous, else ignored and logged; one test. human ~45 min / CC ~5 min.
B) Keep this row's current value
Abort every running call with that id. No effort; cross-session aborts possible.
C) Investigate before choosing
Let the spike show which signal Claude Code sends; no change approved until then.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D15, 2026-11-03)
Accepted scope: Task 6: the closed response (outer signal) stays the primary cancel; `notifications/cancelled` aborts a call only when exactly one running call has that id, otherwise it is ignored and logged; test `cancelled with an ambiguous id aborts nothing`; Task 1 Step 3 records which signal Claude Code sends on an interrupt.
History: none

### R15: Tool names inside result texts
Finding: O5, High, 9/10, plan:67, plan:218, reviewer: outside voice (Claude subagent), verified in code
Plan baseline: Task 7 rewrites only the `package.json` descriptions; R10 freezes the Copilot result texts byte for byte (D11)
Runtime evidence: `lmTools.ts:114` "use adsScope for the history", `lmTools.ts:153` "add symbols with adsWatch first", `lmTools.ts:158` "(add them with adsWatch)", `lmTools.ts:193` "Call adsWrite again"; Claude sees the tools as `ads_watch`, `ads_scope`, `ads_write`
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R15 tool names in result texts | Copilot names in every client | the text builders of `core/adsToolText.ts` and the gate's refused reasons take `names: { watch, scope, write }`; Copilot passes `adsWatch` / `adsScope` / `adsWrite` (its texts stay byte for byte, R10), MCP passes `ads_watch` / `ads_scope` / `ads_write`; golden tests run with both name sets | keep Copilot names for Claude too | investigate first (bounded: check whether Claude maps `adsScope` to `ads_scope` on its own in the spike), no change approved | defer this change only |

Question D17:
D17 — Should the result texts name the tools the way each client knows them?
Project/branch/task: ph/ads-watchlist, Tasks 2 and 4 of the ADS MCP plan.
ELI10: Some answers tell the AI what to call next, like "use adsScope for the history". Claude knows that tool as ads_scope, so it is told to call tools that do not exist. The planned golden tests would lock these texts in.
Stakes if we pick wrong: Claude follows a hint to a tool name it does not have, wastes a turn or gives up.
Recommendation: A because a name set per client fixes it and keeps Copilot's texts unchanged.
Completeness: A=10/10, B=4/10, C=6/10, D=4/10
Header: Tool names
Options:
A) Apply this change
Name set per client in the text builders and refused reasons; golden tests with both sets. human ~45 min / CC ~5 min.
B) Keep this row's current value
Copilot names for both clients. No effort; Claude gets wrong tool names.
C) Investigate before choosing
Check in the spike whether Claude maps the names itself; no change approved until then.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D17, 2026-11-03)
Accepted scope: Tasks 2 and 4: the text builders of `core/adsToolText.ts` and the gate's refused reasons take `names: { watch, scope, write }`; Copilot passes `adsWatch` / `adsScope` / `adsWrite` (its texts stay byte for byte, R10), MCP passes `ads_watch` / `ads_scope` / `ads_write`; the golden tests run with both name sets.
History: none

### R16: Workspace folders added or removed after Connect
Finding: O9, Medium, 7/10, plan:265-270, reviewer: outside voice (Claude subagent)
Plan baseline: Connect registers the folders present at that moment; no handling of later folder changes (original proposal)
Runtime evidence: none (proposed code); `vscode.workspace.onDidChangeWorkspaceFolders` exists in VS Code 1.95
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R16 folder added or removed while connected | added folder never registered; removed folder keeps an entry with this window's port and token | on `onDidChangeWorkspaceFolders` while connected: register each added folder (same owner check R2 and `connectSteps`), remove the entry of each removed folder if it points to the stored port; a failure shows one warning and leaves the other folders as they are; pure `folderChanges(before, after)` with test `folderChanges lists folders to add and remove`; Task 9 row: add and remove a folder while connected | keep: folders fixed at Connect | investigate first, no change approved | defer this change only |

Question D18:
D18 — Should IECode register and unregister workspace folders that are added or removed after Connect?
Project/branch/task: ph/ads-watchlist, Task 8 of the ADS MCP plan.
ELI10: Connect registers the folders that are open at that moment. A folder added later never gets the tools, and a removed folder keeps an entry pointing to this window.
Stakes if we pick wrong: Claude in a newly added folder has no ADS tools, and a removed folder still reaches this window.
Recommendation: A because it reuses the Connect steps and the owner check, so the rules stay the same as at Connect.
Completeness: A=9/10, B=5/10, C=6/10, D=5/10
Header: Folders
Options:
A) Apply this change
Register added and unregister removed folders while connected, reusing R2 and `connectSteps`; one test, one manual row. human ~1.5h / CC ~10 min.
B) Keep this row's current value
Folders fixed at Connect; the user runs Connect again after a change. No effort.
C) Investigate before choosing
No change approved until investigated.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D18, 2026-11-03)
Accepted scope: Task 8: on `onDidChangeWorkspaceFolders` while connected, register each added folder (owner check R2, `connectSteps`) and remove the entry of each removed folder if it points to the stored port; a failure shows one warning and leaves the other folders as they are; pure `folderChanges(before, after)` with test `folderChanges lists folders to add and remove`; Task 9 row: add and remove a folder while connected.
History: none

### R17: Spike checks for path lookup, `claude mcp get` and the client timeout
Finding: O6, O7, O11, Medium, 6-7/10, plan:44-47, plan:21, reviewer: outside voice (Claude subagent)
Plan baseline: Task 1 registers and calls from one terminal cwd, runs `claude mcp list`, records Claude's tool timeout without using it (plan:44-48, original proposal)
Runtime evidence: `Uri.fsPath` gives a lower-case drive letter; `claude mcp get` health-checks the server and merges scopes (`claude mcp get --help`); the 2 min deadline (plan:21) is not tied to the client timeout
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R17 spike depth | one cwd, `mcp list`, timeout recorded only | Task 1 adds: register from Node with a lower-case drive cwd, then start Claude from PowerShell in that folder and in a subfolder (O6); record `claude mcp get iecode` output with the server up and down and with a user-scope `iecode` entry present, used as the fixture of `registeredPort` (O7); set `deadlineMs` to the smaller of 120 s and the measured client tool timeout minus 10 s (O11) | keep the spike as written | investigate first, no change approved | defer this change only |

Question D19:
D19 — Should the spike also check path matching, the `claude mcp get` output and the client timeout?
Project/branch/task: ph/ads-watchlist, Task 1 of the ADS MCP plan.
ELI10: Three later tasks rely on facts nobody has checked: whether Claude finds a registration made with a lower-case drive letter or from a subfolder, what `claude mcp get` prints (the parser's test needs a real sample), and whether Claude gives up before IECode's 2 minute write dialog does.
Stakes if we pick wrong: Connect "works" but Claude never sees the server, the port parser is built against a guess, or every slow confirmation ends as a client error.
Recommendation: A because it adds about 20 minutes to a spike that runs anyway and removes three guesses.
Completeness: A=10/10, B=5/10, C=6/10, D=5/10
Header: Spike checks
Options:
A) Apply this change
Three extra spike checks; `deadlineMs` = min(120 s, client timeout - 10 s). human ~30 min / CC ~10 min.
B) Keep this row's current value
Spike as written. No effort; three assumptions stay unchecked.
C) Investigate before choosing
No change approved until investigated.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D19, 2026-11-03)
Accepted scope: Task 1 adds three checks: register from Node with a lower-case drive cwd, then start Claude from PowerShell in that folder and in a subfolder (O6); record `claude mcp get iecode` output with the server up and down and with a user-scope `iecode` entry present, used as the fixture of `registeredPort` (O7); Task 4 sets `deadlineMs` to the smaller of 120 s and the measured client tool timeout minus 10 s (O11).
History: none

### R18: HTTP with per-folder registration or a user-scope stdio bridge
Finding: O12, Medium (strategic), 6/10, spec:63, plan:246-276, reviewer: outside voice (Claude subagent)
Plan baseline: HTTP on 127.0.0.1 with a token, registered per folder in local scope (spec "Decided with the user", lines 63-64); the stdio bridge is the spike fallback only (spec line 193)
Runtime evidence: after D2-D18, Task 8 holds launcher lookup (R1, R12), owner probe (R2), rollback (R3), token rotation and re-registration per start (R13), folder events (R16); a stdio bridge would need a new `iecode mcp` command in the .NET CLI and a per-user discovery file
Comparison grid:

| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| R18 transport and registration | HTTP + per-folder local registration (user decision) | switch to a user-scope stdio bridge `claude mcp add -s user iecode -- iecode mcp` that finds the window serving its cwd through a discovery file; spec and Tasks 7-8 rewritten | keep HTTP + per-folder registration as amended | investigate first: at Task 1 Step 6, compare both designs in at most 1 h (CLI release coupling, discovery file security, what of Task 8 goes away) and bring the result back to the user before Task 7; no change approved | defer this change only |

Question D20:
D20 — Should the HTTP + per-folder registration design be compared with a stdio bridge before Task 7?
Project/branch/task: ph/ads-watchlist, Tasks 7-8 of the ADS MCP plan.
ELI10: Most of the new safety work in this review sits in Connect: finding claude, owner checks, rollback, new tokens per start, folder events. A small `iecode mcp` program that Claude starts itself, registered once per user, would make most of that unnecessary, but it needs a CLI release and a way to find the right VS Code window.
Stakes if we pick wrong: either we build and maintain a large Connect machinery we did not need, or we throw away a decided design for one that couples the extension to a CLI release.
Recommendation: C because you decided on HTTP with good reasons, and a one-hour comparison right after the spike is cheap before any Connect code exists.
Note: options differ in kind, not coverage — no completeness score.
Header: Transport
Options:
A) Apply this change
Switch to a user-scope stdio bridge now; spec and Tasks 7-8 rewritten. human ~1 day / CC ~1h for the rewrite; needs an `iecode` CLI release.
B) Keep this row's current value
HTTP + per-folder registration as amended. No extra effort.
C) Investigate before choosing
At most 1 h comparison at Task 1 Step 6, result to you before Task 7; no change approved now.
D) Defer this proposed change only
This row stays unresolved.

State: approved
Actual answer: A) Apply this change (D20, 2026-11-03; the user chose A over the recommended C)
Accepted scope: switch from HTTP + per-folder local registration to a user-scope stdio bridge (`claude mcp add -s user iecode -- iecode mcp`) that finds the window serving its cwd through a discovery file; the spec and Tasks 7-8 are rewritten. The design details of the bridge are not decided by this answer (see the impact note below).
History: none

Impact of D20 on earlier rows (not re-asked; to be rechecked when the bridge design exists):
- Become moot in their current form: R2 owner probe (no per-folder entries), R3 multi-folder rollback (one user-scope entry), R8 `MCP-Protocol-Version` header and O10 path 404 (no HTTP towards Claude), R9 `core/mcpHttp.ts` (unless the extension side keeps a local HTTP listener), R13 token per start and R16 folder events (replaced by whatever authenticates the bridge and keeps the discovery file current).
- Stay valid: R1 and R12 (Connect still runs `claude mcp add` once, now at user scope), R4-R7, R10, R11, R15 (write gate, outcomes, texts), R14 (one bridge per Claude session makes id cancel unambiguous, the rule stays harmless), R17's timeout check.
- Change shape: Task 1's spike (HTTP transport, OAuth probe) must test a stdio server instead; Task 6's protocol layer loses its HTTP checks but keeps JSON-RPC handling.

### Next step after D20 (D21)
Question D21 asked how to continue after the switch to the bridge. Answer: "Close, then revise spec" (D21, 2026-11-03): this review closes now; Tasks 2-5 are ready to build; Tasks 1 and 6-8 are marked "rewrite for the stdio bridge"; the spec gets a bridge revision (transport between bridge and extension, discovery file and its protection, authentication, release coupling with the .NET CLI), followed by a new eng review of the rewritten tasks.

Approval readiness: PASS. Checked R1 (D2), R2 (D3), R3 (D4), R4 (D5), R5 (D6), R6 (D7, reopened D16), R7 (D8), R8 (D9), R9 (D10), R10 (D11), R11 (D12), R12 (D13), R13 (D14), R14 (D15), R15 (D17), R16 (D18), R17 (D19), R18 (D20), next step (D21); carried forward without a question: F-T3, O8, O10, O13, O14, O15, O16, O17 (each cites the approved spec or plan line it implements). R2, R3, R8, R9, R13, R16 are approved but moot in their current form after D20; they are rechecked in the bridge review.

### Second opinion 2026-11-03 (GitHub Copilot CLI, gpt-6.1-sol)

Static review of this plan, the spec and the code at 51a123c; asked without Claude's own assessment. 14 findings (S1-S14) and a bridge proposal. Each finding was checked against the code; the user approved all that are judged sensible ("build in what you consider sensible", 2026-11-03).

| Finding | Severity | Verified | Disposition |
|---|---|---|---|
| S1 `ok:false` after a successful write (failed read-back) is reported as "not written" | critical | yes: `AdsWatchBackend.cs:177-182` writes, then reads; a read failure gives `ok:false` (`WatchHost.cs:57-69`) | R19 |
| S2 approval checks the settings, not the child process that gets the write | critical | partly: `start()` spawns with the settings of that moment (`host.ts:228-246`), `request()` takes `this.proc` (`host.ts:357-364`) | R21 (process key); A → B → A invalidation rejected: the write still goes to the confirmed target |
| S3 `dispose()` is not checked by `beforeSend` while the host starts | critical | yes: the plan's `beforeSend` list had no dispose check | R20 |
| S4 Copilot's prepare map keyed by `[symbol, value]` can mix two approvals | critical (Copilot: medium) | yes: `lmTools.ts:165-166` | R28 |
| S5 "Always Allow" contradicts the strict confirmation guarantee | critical | yes, known limit (`README.md:156`, `package.json:1266`) | R27 (document; an own IECode dialog for Copilot rejected: two dialogs per write) |
| S6 `lateApproval` cannot fire if the adapter turns a late click into `false` | medium | yes: plan text of `adsWriteGate.confirm` | R22 |
| S7 queue wait has no deadline; cancelled queued ops are not removed | medium | yes | R24 |
| S8 the factory allows two gates (two queues) | medium | yes | R23 |
| S9 tests do not reach the real host wiring | medium | yes | pure helpers (`writeStage`, `sendOutcome`) + Task 9 Step 1b; a child-process test seam for `host.ts` rejected for now (cost, VS Code dependency) |
| S10 target change keeps old item types / errors while idle | medium | yes: `host.ts:136-138` keeps `known` items | R26 |
| S11 `adsTools` has no name-set parameter | medium | yes | R25 |
| S12 Task 5 misses boundaries, `null`, real `NaN`; schemas lack limits | medium | yes | R29 |
| S13 `isError` mapping and cap incl. marker unspecified | low | yes | R25 |
| S14 Task 4 default deadline depends on the unrun spike; HTTP constraints look active | low | yes | R24 (injected policy), Global Constraints marked |

### Decision ledger, second opinion (R19-R29)

All rows: State approved; Actual answer: "build in what you consider sensible" (user, 2026-11-03); History: none.

- **R19 (S1): Write outcome by stage.** Task 2b: `ads serve` replies `written:"no"` only when nothing was sent, and `ok:true` with `value:null, readBackError` when only the read-back failed. Task 3: `HostError`, `writeStage`; any write error without `written:"no"` is "outcome unknown". Task 4: `send` never maps a plain error to refused; new text "Written, but … could not be read back". Rejected: mapping every host error to unknown without a CLI change (Claude would get "outcome unknown" for a misspelled symbol).
- **R20 (S3): Latched op state and dispose.** Task 4: `beforeSend` checks dispose; per-op state; `run` after dispose refuses; a sent op keeps its real outcome. Tests listed in Task 4.
- **R21 (S2): Write goes to the child started for the confirmed target.** Task 3: `procKey` per spawned child; take `this.proc` once, check `procKey` and `beforeSend`, write, no `await` in between.
- **R22 (S6): Raw dialog choice.** `confirm` returns the user's choice; the gate decides refusal and the one `lateApproval`.
- **R23 (S8): One gate per window.** Created in `extension.ts`, shared by Copilot and MCP; Copilot ops take the same queue; the one-dialog rule covers the gate's dialogs.
- **R24 (S7, S14): Operation deadline and injected policy.** `GatePolicy { dialogMs, operationMs, maxQueued }` without defaults; queued ops expire and leave the queue on abort; no dialog with less than 5 s left; deadline tests with an injected clock.
- **R25 (S11, S13): Name sets and error flags.** `adsTools(…, names)`; `writeResultIsError`; the 50 000-character cap includes the marker; extra golden cases.
- **R26 (S10): Item reset on a target change**, also while idle, with `itemsChanged`.
- **R27 (S5): Always Allow** stays a documented limit of the Copilot path; the README says MCP writes are always confirmed by IECode's dialog.
- **R28 (S4): Ambiguous Copilot prepare records are refused** (`PreparedWrites` in `core/writeGate.ts`).
- **R29 (S12): Input boundaries**, `undefined`/`null` handling, nonblank symbol, empty value allowed, limits in the `package.json` schemas.

### Inputs for the bridge revision (from the second opinion, not decided)

To be weighed in the spec revision (D21); none of this is approved yet.

- Transport: Copilot recommends a private loopback HTTP channel between bridge and extension, because Node cannot set an explicit DACL on a named pipe; Claude's own view was a named pipe. To settle in the spike: the DACL a Node-created pipe actually gets (`Get-Acl \\.\pipe\…` or `accesschk`), and whether another user can open it. Pipe wins if the default denies other users.
- Discovery: one file per extension-host instance under `%LOCALAPPDATA%\iecode\mcp\v1\instances\` (no shared registry, no read-modify-write between windows); fields: format version, random instance id, pid + process start time, extension version, bridge protocol range, endpoint, canonical workspace roots, root revision, per-instance secret; written atomically after the listener is up; a file is a candidate, liveness only by an authenticated handshake; PIDs alone are not proof.
- Selection: canonical paths (drive letter, separators, junctions), component-wise containment (`C:\work\plant` ≠ `C:\work\plant-old`), longest root wins, a tie is an error naming the windows (never "newest window"); the bridge stays pinned to the chosen instance.
- Authentication: other users and browsers are in the threat model, other processes of the same user are not. Protect the discovery directory with a DACL set by the .NET CLI. For HTTP, the bridge must not send its secret to a port that only the discovery file names (port squatting after a crash): Copilot proposes a mutual challenge-response; weigh it against the pipe.
- Cancellation: session id + request id; the bridge keeps reading stdin during a call; forward `notifications/cancelled`, stdin EOF and connection loss; the extension refuses every not-yet-sent write on them; never replay a `tools/call`; the spec states that only cancellation that arrives before sending can stop a write.
- Lifecycle: "register the bridge for this Windows user" and "serve this window" are separate; Disconnect of one window removes its discovery file, not the user-scope registration; register the absolute path of `iecode.exe`, not a bare `iecode` (R12 again).
- Release coupling: keep `iecode mcp` a thin relay in the .NET CLI (no ADS, no write rules, opaque MCP frames where possible, stdout only MCP frames); a bridge protocol version range with a clear upgrade error; a Node bridge shipped in the extension was judged worse (needs a standalone `node`, the extension path changes with every update).

### NOT in scope
- The bridge design itself (bridge ↔ extension transport, discovery file, authentication, CLI release): next spec round (D21).
- Other MCP clients than Claude Code: spec non-goal.
- Keeping the ADS host sampling while Claude is connected: decided with the user (demand-driven sampling).
- Exclusive binding against port squatting: moot once there is no fixed HTTP port towards Claude (D20).

### What already exists
- Copilot tool logic in `lmTools.ts:39-162`: moved, not rebuilt (Task 2, golden tests R10).
- `writeStillApproved` (`core/adswatch.ts`) and its tests: moved into the write gate (R5).
- `PendingRequests` (`adswatch.ts:173`): extended with error classes, not replaced (R7).
- `scopeText` (`adswatch.ts:209`): capped, not rewritten (R11).
- `cli/iecode.ts` spawn pattern: not reusable for `claude.cmd` (R1); `findOnPath` is new (R12).

### Diagrams

Write path after the review and the second opinion (Tasks 2b-4, valid for both transports):

```
 Copilot invoke ──(PreparedWrites.take, R28)──┐
                                              ▼
 MCP ads_write ──► toolInput ──► WriteGate.run(op, signal)      (one gate per window, R23)
                                   │ FIFO queue (maxQueued 10); abort / operation deadline → leaves queue, refused (R24)
                                   │ head reached, previous dialog closed (R6/D16), ≥ 5 s left (R24)
                                   ├─ decision refuse ───────────► refused
                                   ├─ confirm: modal (dialog deadline from open)
                                   │     ├─ declined / deadline / abort / dispose ─► refused (+ lateApproval on a raw "Write", R4, R22)
                                   │     └─ Write ─┐
                                   └─ allow ───────┤
                                                   ▼
                              host.write(symbol, value, beforeSend)   (ensure(true), then no await until stdin.write, R21)
                                   ├─ beforeSend: disposed / cancelled / op deadline / now refuse / allow→confirm /
                                   │              target changed / procKey ≠ op target ───────► WriteNotSent → refused
                                   ├─ host not running ─────────────────────────────► WriteNotSent → refused
                                   ├─ reply ok:false, written:"no" (Task 2b) ────────► WriteNotSent → refused
                                   ├─ reply ok:false, no proof (also old CLI) ───────► WriteOutcomeUnknown → unknown (R19)
                                   ├─ RequestTimeout / HostGone after sending ───────► WriteOutcomeUnknown → unknown
                                   ├─ reply ok:true, readBackError ──────────────────► written, read-back failed (R19)
                                   └─ reply ok:true ─────────────────────────────────► written (read back)
```

### Failure modes (Tasks 2-5)

| Path | Realistic failure | Covered by | User sees |
|---|---|---|---|
| host restart during a write | settings change restarts the host after the write was sent | R7 tests, `WriteOutcomeUnknown` | "Outcome unknown … read and ask the user" |
| target change during a dialog | user edits `iecode.ads.target` while the dialog is open | gate test `target changed during approval` | "Not written: the ADS target changed from A to B" |
| late click | user clicks Write after Claude gave up | R4 test, warning | warning naming the symbol |
| malformed arguments | `{ add: 'x' }` from outside VS Code | Task 5 tests | tool error naming the field |
| huge scope | 200 symbols, 3600 s | R11 tests | truncated text with a hint |
| Copilot text drift | slip during the move | R10 golden tests | test failure before shipping |
| failed read-back | PLC took the value, the read after it failed | Task 2b tests, `writeStage` tests (R19) | "Written, but … could not be read back" |
| shutdown during host start | window reloads while a write waits for `ensure(true)` | gate dispose tests (R20); host wiring by hand (Task 9 Step 1b) | nothing written |
| queue behind a stale dialog | user leaves a modal open | R24 queue tests | "Not written: the request waited too long" |
| two Copilot prepares, same arguments | target changes between them | R28 tests | "call the write tool again" |

Gap that stays: the `host.ts` wiring (`procKey`, no `await` before sending, item reset while idle) has no unit test, only the manual check of Task 9 Step 1b (S9; a child-process test seam was judged too costly for now). Tasks 1 and 6-8 are excluded until they are rewritten.

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Task 2 shared tool texts | `extension/src/ads`, `extension/src/core` (adswatch, adsToolText) | — |
| Task 2b write stages (CLI) | `cli/src/IECode.Core/Ads`, `cli/src/IECode.Automation`, `cli/tests` | — |
| Task 3 buffer reset, error classes, write stages | `extension/src/core` (adswatch), `extension/src/ads` (host), `extension/src/views` (adsWatch) | Task 2b (reply fields; safe without it) |
| Task 4 write gate | `extension/src/core` (writeGate), `extension/src/ads` (adsWrite, lmTools), `extension/src/extension.ts` | Task 3, Task 2 (`names`, lmTools) |
| Task 5 input validation | `extension/src/core` (toolInput), `extension/package.json` (schemas) | — |

Lane A: Task 2 → Task 3 → Task 4 (shared `core/adswatch.ts`, `ads/lmTools.ts`). Lane B: Task 5 (independent). Lane C: Task 2b (CLI only, `dotnet` through the PowerShell tool; not in parallel with another heavy build). Launch A + B + C; merge B and C any time, C before Task 3 is merged; Tasks 1 and 6-9 wait for the bridge spec. Conflict flag: `core/adswatch.ts` is touched by Tasks 2 and 3, so keep them in one lane.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1 day / CC: ~1h)** — spec — Revise the spec for the user-scope stdio bridge, then rewrite Tasks 1 and 6-8 and run a new eng review
  - Surfaced by: Outside voice O12 → D20, D21
  - Files: docs/superpowers/specs/2026-11-03-ads-mcp-server-design.md, this plan
  - Verify: `/plan-eng-review` on the rewritten tasks
- [ ] **T2 (P1, human: ~3h / CC: ~15min)** — host — Task 3 with `RequestTimeout` / `HostGone` and the write outcome mapping
  - Surfaced by: Code quality Q1 → R7 (D8)
  - Files: extension/src/core/adswatch.ts, extension/src/ads/host.ts, extension/test/adswatch.test.ts
  - Verify: `cd extension && npm test`
- [ ] **T3 (P1, human: ~1 day / CC: ~45min)** — write gate — Task 4 with queue-then-dialog, stale-dialog wait, late-approval warning, one path for Copilot and MCP, name sets, deadline from the spike
  - Surfaced by: A4, A5, A6, O4, O5, O13, O16, O11 → R4, R5, R6 (D7, D16), R15, R17
  - Files: extension/src/core/writeGate.ts, extension/src/ads/adsWrite.ts, extension/src/ads/lmTools.ts, extension/test/writeGate.test.ts
  - Verify: `cd extension && npm test`
- [ ] **T4 (P1, human: ~1 day / CC: ~40min)** — tool texts — Task 2 with pure `core/adsToolText.ts`, golden tests for both name sets, output cap, no age on read-back values
  - Surfaced by: F-T2, P1, O5, O15 → R10 (D11), R11 (D12), R15 (D17)
  - Files: extension/src/core/adsToolText.ts, extension/src/ads/adsTools.ts, extension/src/ads/lmTools.ts, extension/test/adsToolText.test.ts
  - Verify: `cd extension && npm test`
- [ ] **T5 (P2, human: ~2h / CC: ~10min)** — input — Task 5 argument validation with boundaries and schema limits
  - Surfaced by: Review Focus 4 (plan), S12 → R29
  - Files: extension/src/core/toolInput.ts, extension/test/toolInput.test.ts, extension/package.json
  - Verify: `cd extension && npm test`
- [ ] **T6 (P1, human: ~3h / CC: ~20min)** — CLI — Task 2b: `ads serve` tells "not sent", "sent, outcome unknown" and "written, read-back failed" apart
  - Surfaced by: second opinion S1 → R19
  - Files: cli/src/IECode.Core/Ads/WatchProtocol.cs, cli/src/IECode.Core/Ads/WatchHost.cs, cli/src/IECode.Automation/AdsWatchBackend.cs, cli/src/IECode.Automation/AdsLink.cs, cli/tests, cli/README.md
  - Verify: `dotnet build cli/IECode.slnx`, then separately `dotnet test cli/IECode.slnx --no-build` (PowerShell tool)

Second opinion additions to T2-T4: T2 (Task 3) gains `HostError`, `writeStage`, `procKey`, item reset (R19, R21, R26); T3 (Task 4) gains latched op state, raw dialog choice, operation deadline, one shared gate, `PreparedWrites` (R20, R22-R24, R28); T4 (Task 2) gains the `names` parameter, `isError` and extra golden cases (R25).

_No new tasks from Performance beyond T4._ Effort ratios assumed: features ~30x, tests ~50x, spec work ~3x.

### Unresolved decisions
None in this review. Not a decision but open work: Tasks 1 and 6-8 must be rewritten for the bridge (T1) before they can be built.

### Suppressed findings (confidence 3-4)
None.

### Completion summary
- Step 0: Scope Challenge — scope accepted as-is (D20 later changed the architecture of Tasks 1 and 6-8, not the feature scope)
- Reality rows: 7/7 applicable rows emitted, 2 unverified premises
- Architecture Review: 6 issues found
- Code Quality Review: 2 issues found
- Test Review: diagram produced, 3 gaps identified
- Performance Review: 1 issue found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed (the follow-up is T1, the immediate next step)
- Failure modes: 0 critical gaps flagged by this review; the later second opinion found one (S1, failed read-back reported as "not written"), fixed by R19; one known test gap stays (host wiring, manual only)
- Unresolved decisions: 0 in this review
- Outside voice: Claude subagent (native fallback, Codex CLI not installed), completed, 17 findings; 7 carried forward, 8 decided (D13-D20), 2 folded into D19
- Second opinion (GitHub Copilot CLI, gpt-6.1-sol): 14 findings; 11 built in (R19-R29), 3 partly rejected with reasons (S2 A → B → A, S5 own Copilot dialog, S9 test seam); bridge proposal kept as input for the spec revision
- Parallelization: 3 lanes (A: Tasks 2 → 3 → 4, B: Task 5, C: Task 2b)
- Lake Score: 12/18

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native Claude subagent (Codex CLI not installed), default-on | Independent 2nd opinion | 2 | issues_found (outside_status: unavailable) | 17 findings this run; 8 decided, 7 carried forward |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | ISSUES OPEN | 12 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase, unavailable (Codex CLI not installed); native Claude subagent completed within 5 min with 17 findings. No external-provider coverage.
- **CROSS-MODEL:** GitHub Copilot CLI (gpt-6.1-sol), 2026-11-03, after this review: 14 findings, agreed with Claude's own view on the gate complexity, the stale HTTP constraints, a thin relay in the .NET CLI with a version handshake and forwarded cancellation; disagreed on the bridge transport (loopback HTTP vs. named pipe, left to the bridge spike); new and verified: S1 (failed read-back), S3 (dispose during host start), S4 (Copilot prepare map).
- **VERDICT:** no review CLEAR; Tasks 2, 2b, 3, 4 and 5 are reviewed (R19-R29 not yet eng-reviewed themselves) and ready to build, Tasks 1 and 6-8 wait for the bridge spec revision; eng review required (again for the rewritten tasks).

NO UNRESOLVED DECISIONS
