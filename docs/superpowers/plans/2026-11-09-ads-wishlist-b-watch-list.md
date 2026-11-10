# Plan B: Watch List Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AI manages its part of the ADS watch list with small results (`ads_watch` answers with what changed), a way to clean up (clear its own entries, remove the user's after a confirmation), named groups that can be switched off, a list that survives a restart and tells once which entries no longer resolve, and a target line in every result that changes or waits on the PLC.

**Architecture:** Every list change already goes through `WatchList` (`extension/src/core/watchList.ts`, the serialized owner with wait holds, merged with `ads_wait`). Groups, removal rules and the "unresolved once" memory are pure logic in `extension/src/core/` (`watchGroups.ts`, `watchRequest.ts`, `unresolved.ts`, plus the existing `watchList.ts`, `adswatch.ts`, `adsToolText.ts`, `toolInput.ts`). `src/ads/adsTools.ts`, `host.ts`, `lmTools.ts` only wire. The user's confirmation to remove their own entries is an injected callback (`ConfirmUserRemoval`), like the gate's `confirm`, so the rule is tested without `vscode`. No CLI change, no protocol bump.

**Tech Stack:** TypeScript, VS Code extension API, `node --test` (`cd extension && npm test`, which runs `tsc -p .` first). No new dependencies.

**Spec:** [docs/ads-mcp-wishlist.md](../../ads-mcp-wishlist.md) sections 4 (rows "`ads_watch` returns only the diff", "Named watch groups", "Let the AI remove entries the user added…", "Persist the AI watch list…") and 8 (row "Show the connected target in every tool result header"); roadmap [Phase 1](2026-11-06-ads-mcp-wishlist.md) and decisions D1-D24; master plan [2026-11-09-ads-wishlist-master-plan.md](2026-11-09-ads-wishlist-master-plan.md). Not part of this plan: per-symbol sample rate and "interval and buffer through MCP" (section 4, other rows; they need the host or belong to Plan E).

## What the code already does (checked against the repository, this changes the rough plan)

- **The list is already persisted.** `AdsHost.setEntries` saves `WatchEntry[]` (with the `ai` flag) in `workspaceState` under `iecode.adsWatch`, `entries()` reads it with `parseWatchList`, `afterHello` re-sends it after every host start. Task B4 therefore does not add storage; it adds the missing part, the one-time report of entries that no longer resolve, and B3 stores groups next to it.
- `WatchList` (merged with `ads_wait`) is stateless apart from the wait holds: it reads `deps.entries()` when a step runs. Groups are stored as a label on the entry (`WatchEntry.groups`) plus one extra stored list of switched-off group names, not as a `Map` inside `WatchList`.
- `adsTools.watch(input)` currently takes no signal; `lmTools.ts` passes the raw Copilot input to it without `parseWatchInput`. B1 fixes both (a strict boolean such as `force` must never be read from an unvalidated value).
- `watchResultText` returns `ToolText`-less plain text and is pinned by `adsToolText.test.ts` (`watch result text names the scope tool of the client`); B1 replaces its input shape and that test, as roadmap Phase 1 intends.
- Plan A edits `adsToolText.ts` (scope texts) and `toolInput.ts` (`parseScopeInput`) and merges first. This plan touches other functions of the same two files (`watchListText`, `watchResultText`, `waitResultText`, `parseWatchInput`); rebase onto A before starting and re-run `npm test`.

## Global Constraints

- Public repository: no internal project, module, machine or symbol names, symbol paths or data in code, tests, docs or commits; examples use generic names (`MAIN.nCounter`, `T1`). Commits: GitHub noreply author, `git commit -s`, English subject plus a 1-3 sentence why-body.
- Tools stay declared once in `extension/package.json`; texts live in `adsToolText.ts`; the manifest parity tests stay green. New input fields are optional and omitted from the parsed value when absent, so old calls parse to the same value as before (`parseWatchInput({ add: ['a'] })` stays `{ add: ['a'], remove: [] }`). Text results of other tools stay byte-identical except where a task says otherwise (B1: `ads_watch` diff; B5: a target line on watch, write and wait results).
- An entry the user added is never removed, grouped or switched off by the AI without the user's confirmation (removal) or at all (groups). A wait hold keeps its entry sampled and in the list until the wait ends.
- `WatchEntry` objects keep their exact shape when no group is set (`{ symbol, ai }`, no `groups` key, not `groups: undefined`), because tests compare with `deepEqual` and old saved lists must round-trip unchanged.
- Watch list limit stays 200 (`MAX_WATCHED`) and applies to the sampled (active) list.
- Tests: `cd extension && npm test`. No `dotnet` work in this plan.

## Review Focus

1. A group switched off while a wait holds one of its symbols: the entry stays sampled until the wait ends, then parks again. (B3b, `watchList.test.ts`)
2. A symbol in two groups: it is sampled until both groups are off; removing one group keeps it. (B3a, B3b)
3. A persisted entry whose symbol no longer exists after a build: reported once per session and per symbol, not on every call, and reported again after it resolved and broke again. (B4)
4. `ads_watch {}` on a list of 55 entries still shows the full list; only add and remove calls get the short result. (B1)
5. The user declines the confirmation (or does not answer) to remove their own entry: the entry stays and the result says so; one dialog per call, never one per symbol. (B2)
6. The AI cannot put a user entry into a group (it would then disappear when the group is switched off). (B3a, B3b)
7. A late answer to a dialog that already timed out never removes anything. (B2)

## File Structure

- Create: `extension/src/core/watchGroups.ts` (B3a): group names, `isActive`, `activeSymbols`, `groupSummaries`, `addToGroup`, `dropGroup`.
- Create: `extension/src/core/watchRequest.ts` (B2, extended in B3c): `runWatchRequest`, `ConfirmUserRemoval`, `confirmRemoveText`.
- Create: `extension/src/core/unresolved.ts` (B4): `UnresolvedNotes`.
- Modify: `extension/src/core/watchList.ts` (B1, B2, B3b): richer `aiEdit`, `clearAi`, groups, active list.
- Modify: `extension/src/core/adswatch.ts` (B3a): `WatchEntry.groups`, `parseWatchList`, `watchEdit`, `watchRename`.
- Modify: `extension/src/core/adsToolText.ts` (B1, B2, B3c, B4, B5): `watchResultText`, `watchListText`, `addErrorLines`, `unresolvedText`, `targetLine`, `targetOfKey`.
- Modify: `extension/src/core/toolInput.ts` (B1, B2, B3c): `WatchRequest`, `parseWatchInput`, `wantsFullList`.
- Modify: `extension/src/core/writeGate.ts` (B5): `writeResultText` adds the target line.
- Modify: `extension/src/core/mcpTools.ts` (B1): `AdsToolFns.watch(input: WatchRequest, signal)`.
- Modify: `extension/src/ads/adsTools.ts`, `host.ts`, `lmTools.ts`, `extension/src/views/adsWatch.ts` (wiring), `extension/package.json`, `extension/CHANGELOG.md`, `extension/README.md`, `docs/ads-mcp-wishlist.md`.
- Tests: `extension/test/watchList.test.ts`, `watchGroups.test.ts` (new), `watchRequest.test.ts` (new), `unresolved.test.ts` (new), `adsToolText.test.ts`, `toolInput.test.ts`, `adswatch.test.ts`, `writeGate.test.ts`, `mcpTools.test.ts`.

## Order

B1 -> B5 -> B2 -> B3a -> B3b -> B3c -> B4 -> B6. B1 and B5 are small and ship first; B2 introduces `runWatchRequest`, which B3c extends; B3b depends on B3a; B4 is independent of groups but comes after them so the "Not resolved" line lands in the final `watchResultText` shape. One pull request for the whole plan (merged after Plan A; see the delivery slices in the master plan), one commit per task.

---

### Task B1: Diff result and the `list` option (roadmap Phase 1)

**Files:**
- Modify: `extension/src/core/watchList.ts` (`aiEdit` result)
- Modify: `extension/src/core/toolInput.ts` (`WatchRequest`, `parseWatchInput`, `wantsFullList`)
- Modify: `extension/src/core/adsToolText.ts` (`watchResultText`, `addErrorLines`)
- Modify: `extension/src/core/mcpTools.ts` (`AdsToolFns.watch` type and call)
- Modify: `extension/src/ads/adsTools.ts` (`watch`), `extension/src/ads/lmTools.ts` (`watchTool`)
- Modify: `extension/package.json` (`iecode_ads_watch`), `extension/CHANGELOG.md`
- Test: `extension/test/watchList.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Consumes: `WatchEntry`, `WatchItem` from `extension/src/core/adswatch.ts`; `Parsed<T>` and the private helpers of `toolInput.ts`.
- Produces:
  ```ts
  // watchList.ts
  export interface AiEditResult {
    added: string[];    // requested adds that were new (requested spelling, trimmed, de-duplicated case-insensitively)
    already: string[];  // requested adds that were already in the list
    removed: string[];  // requested removes that left the list now
    kept: string[];     // requested removes the user owns (not removed)
    held: string[];     // requested removes postponed because a running wait holds the entry
    missing: string[];  // requested removes that are not in the list
  }
  aiEdit(add: string[], remove: string[]): Promise<AiEditResult>;   // was Promise<{ kept: string[] }>
  // toolInput.ts
  export interface WatchRequest { add: string[]; remove: string[]; list?: boolean }
  export function parseWatchInput(raw: unknown): Parsed<WatchRequest>;
  export const wantsFullList: (r: WatchRequest) => boolean;   // list === true, or nothing to change
  // adsToolText.ts
  export interface WatchResultInput {
    full: boolean;            // append the full list text
    list: string;             // watchListText(...)
    result: AiEditResult;
    addErrors: string[];      // addErrorLines(...)
    count: number;            // symbols sampled now
    intervalMs: number;
    names: ToolNames;
  }
  export function watchResultText(o: WatchResultInput): string;
  export function addErrorLines(items: WatchItem[], added: string[]): string[];  // `<stored symbol> : <error>` per added item with an error
  // adsTools.ts
  watch(input: WatchRequest, signal: AbortSignal): Promise<ToolText>   // signal unused until B2
  ```
  `AiEditResult` is imported by `adsToolText.ts` with `import type` (no cycle at runtime).

Result text of a diff (exact, in this order, a line only when its list is non-empty): `Added: a, b`; `Already in the list: c`; `Removed: d`; `Not in the list: e`; `Not removed (added by the user, only the user can remove them): f` (the existing wording); `Kept until a running wait ends: g`; one `Error: <symbol> : <error>` per `addErrors` entry; then, when `full`, the list text, otherwise `Watch list: N symbols` (`1 symbol` for one); finally, if `added` is non-empty, `New values arrive every <intervalMs> ms; use <names.scope> for the history.`. An empty call or `list: true` returns the list text only (plus the diff lines when `list: true` came with an add or remove). The failure path (`watchFailureText`) keeps the full list.

- [ ] **Step 1: Write the failing tests**

`watchList.test.ts` (uses the existing `fake()`):

```ts
test('aiEdit reports what it added, what was there, what it removed and what it refused', async () => {
  const f = fake([{ symbol: 'U', ai: false }, { symbol: 'X', ai: true }]);
  const r = await f.w.aiEdit(['A', 'u', ' B ', 'a'], ['x', 'zz', 'U']);
  assert.deepEqual(r, { added: ['A', 'B'], already: ['u'], removed: ['x'], kept: ['U'], held: [], missing: ['zz'] });
  assert.deepEqual(f.list().map(e => e.symbol), ['U', 'A', 'B']);
});

test('aiEdit says a removal was postponed by a running wait', async () => {
  const f = fake();
  const h = await f.w.hold('P');
  const r = await f.w.aiEdit([], ['p']);
  assert.deepEqual(r, { added: [], already: [], removed: [], kept: [], held: ['p'], missing: [] });
  assert.equal(f.list().length, 1);
  await h.release();
  assert.equal(f.list().length, 0);
});
```

`toolInput.test.ts`:

```ts
test('parseWatchInput reads list and leaves it out when absent', () => {
  assert.deepEqual(parseWatchInput({ list: true }), { ok: true, value: { add: [], remove: [], list: true } });
  assert.deepEqual(parseWatchInput({ add: ['a'] }), { ok: true, value: { add: ['a'], remove: [] } });
  assert.deepEqual(parseWatchInput({ list: null }), { ok: true, value: { add: [], remove: [] } });
  assert.deepEqual(parseWatchInput({ list: 'yes' }), { ok: false, error: 'list must be a boolean' });
});

test('wantsFullList is true for an empty call and for list: true', () => {
  assert.equal(wantsFullList({ add: [], remove: [] }), true);
  assert.equal(wantsFullList({ add: ['a'], remove: [] }), false);
  assert.equal(wantsFullList({ add: [], remove: ['b'] }), false);
  assert.equal(wantsFullList({ add: ['a'], remove: [], list: true }), true);
});
```

`adsToolText.test.ts` (replaces `watch result text names the scope tool of the client`):

```ts
const none = { added: [], already: [], removed: [], kept: [], held: [], missing: [] };
const wbase = { full: false, list: 'L', count: 3, intervalMs: 100, names: MCP_NAMES, addErrors: [] as string[], result: none };

test('watch result: a diff names only what changed, plus the count', () => {
  assert.equal(watchResultText({ ...wbase, result: { ...none, added: ['MAIN.a', 'MAIN.b'], removed: ['MAIN.c'] } }),
    'Added: MAIN.a, MAIN.b\nRemoved: MAIN.c\nWatch list: 3 symbols\nNew values arrive every 100 ms; use ads_scope for the history.');
  assert.equal(watchResultText({ ...wbase, count: 1, names: COPILOT_NAMES, result: { ...none, added: ['MAIN.a'] } }),
    'Added: MAIN.a\nWatch list: 1 symbol\nNew values arrive every 100 ms; use adsScope for the history.');
  assert.equal(watchResultText({ ...wbase, result: { ...none, removed: ['MAIN.c'] } }), 'Removed: MAIN.c\nWatch list: 3 symbols');
});

test('watch result: every refusal and error has its own line, in a fixed order', () => {
  assert.equal(watchResultText({ ...wbase, addErrors: ['MAIN.x : Symbol not found'],
    result: { added: ['MAIN.x'], already: ['a'], removed: [], kept: ['U'], held: ['h'], missing: ['m'] } }),
    'Added: MAIN.x\nAlready in the list: a\nNot in the list: m\nNot removed (added by the user, only the user can remove them): U\nKept until a running wait ends: h\nError: MAIN.x : Symbol not found\nWatch list: 3 symbols\nNew values arrive every 100 ms; use ads_scope for the history.');
});

test('watch result: the full list replaces the count; an empty call is the list alone', () => {
  assert.equal(watchResultText({ ...wbase, full: true }), 'L');
  assert.equal(watchResultText({ ...wbase, full: true, result: { ...none, added: ['a'] } }),
    'Added: a\nL\nNew values arrive every 100 ms; use ads_scope for the history.');
});

test('addErrorLines names the stored spelling of added symbols with an error', () => {
  assert.deepEqual(addErrorLines([item('MAIN.a'), item('main.b', '', 'Symbol not found')], ['MAIN.B', 'MAIN.a']), ['main.b : Symbol not found']);
});
```

`mcpTools.test.ts`: add `ads_watch passes the parsed fields and the call's signal` (fake `watch: async (i, signal) => ...` records both; call `{ add: ['A'], list: true }` reaches it as `{ add: ['A'], remove: [], list: true }` with an `AbortSignal`); extend the manifest test: `watch.inputSchema.properties.list.type === 'boolean'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (`wantsFullList`, `addErrorLines` not exported; `aiEdit` result shape; `watchResultText` input shape).

- [ ] **Step 3: Implement**

- `watchList.ts` `aiEdit`: compute the result lists from the entries before the edit: each requested name is trimmed, empty ones dropped, duplicates (case-insensitive) dropped. An add is `added` when no entry has that name, else `already`. A remove is `missing` when no entry has that name; otherwise `kept` when the entry is the user's (`!ai`), `held` when a wait holds it (`this.held(key)`), else `removed`. Keep the existing hold bookkeeping (the `rec.added` handling of postponed removals) unchanged; the written list stays the one the current code computes.
- `toolInput.ts`: add a private `bool(o, field)` helper (null or undefined = absent, other non-boolean = `${field} must be a boolean`); `parseWatchInput` returns `list` only when it is a boolean; `wantsFullList = r => r.list === true || (!r.add.length && !r.remove.length)`; export `WatchRequest`.
- `adsToolText.ts`: new `watchResultText` as specified above; `addErrorLines` matches `added` against `items` case-insensitively and prints `${item.symbol} : ${item.error}`; plural helper for `1 symbol`.
- `adsTools.ts` `watch(input, signal)`: `const result = await leased(host, () => host.list.aiEdit(add, remove))` inside the existing try/catch (failure path unchanged); then `ok(watchResultText({ full: wantsFullList(input), list: list(host), result, addErrors: addErrorLines(host.items(), result.added), count: host.watched().length, intervalMs: host.sampling().intervalMs, names }))`. `WatchInput` becomes `export type WatchInput = WatchRequest`.
- `mcpTools.ts`: `AdsToolFns.watch(input: WatchRequest, signal: AbortSignal)`, registered as `read('ads_watch', parseWatchInput, (v, signal) => d.tools.watch(v, signal))`.
- `lmTools.ts` `watchTool`: parse with `parseWatchInput` (invalid: `text(\`Invalid arguments: ${parsed.error}\`)`), pass an `AbortController` signal from the cancellation token, the same way `waitTool` does.
- `package.json` `iecode_ads_watch`: new property
  `"list": { "type": "boolean", "description": "Return the full list with types and errors. Default: only what this call changed, plus the count." }`;
  in `modelDescription` replace `Returns the resulting list with types and per-symbol errors.` by `Returns what the call added and removed plus the count; call it with no arguments, or with list: true, for the full list with types and per-symbol errors.`
- `CHANGELOG.md`, under `## Unreleased` / `### Claude Code and ADS`: `- \`ads_watch\` (Copilot: \`adsWatch\`) answers an add or remove with only what changed and the count (\`Watch list: 57 symbols\`) instead of the whole list; call it with no arguments or \`list: true\` for the full list.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass; the replaced `watchResultText` test is the only changed old test.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/package.json extension/CHANGELOG.md
git commit -s -m "Answer ads_watch with what changed, not the whole list" -m "Every add or remove echoed all 55 entries, which costs an agent context on each call. The full list stays one call away (no arguments or list: true), and the failure path still shows it."
```

---

### Task B5: Connected target in the result of watch, write and wait

**Files:**
- Modify: `extension/src/core/adsToolText.ts` (`targetLine`, `targetOfKey`, `watchResultText`, `waitResultText`)
- Modify: `extension/src/core/writeGate.ts` (`writeResultText`)
- Modify: `extension/src/ads/adsTools.ts` (pass `host.target()`)
- Modify: `extension/CHANGELOG.md`
- Test: `extension/test/adsToolText.test.ts`, `extension/test/writeGate.test.ts`, `extension/test/mcpTools.test.ts` (regexes stay valid, see below)

**Interfaces:**
- Consumes: B1 `WatchResultInput`.
- Produces:
  ```ts
  export const targetLine = (target: string): string => `ADS target: ${target}`;
  /** "<target>:<port>" (the gate's key) as the user knows it: the default port 851 is left out. */
  export const targetOfKey = (key: string): string => key.endsWith(':851') ? key.slice(0, -4) : key;
  // WatchResultInput gains `target: string`; waitResultText's argument gains `target: string`.
  // writeResultText(r, op) derives the target from op.targetKey.
  ```

The line is the **last** line of the result, so the verdict stays first: clients and tests rely on `Written.`, `Not written:`, `Outcome unknown:` and `Condition met` as the first words (see Open decisions). Placement: watch result: after the `New values arrive` line; write result: after the sentence; wait result: after the `Sampled every` line (or after the only line). Reads (`Values on <target>:`), scope (`(target <t>)`) and the failure texts of a host that did not start (no target contact) are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test('target line and the default port', () => {
  assert.equal(targetLine('local'), 'ADS target: local');
  assert.equal(targetOfKey('local:851'), 'local');
  assert.equal(targetOfKey('172.20.30.60.1.1:852'), '172.20.30.60.1.1:852');
});

test('watch result ends with the target', () => {
  assert.equal(watchResultText({ ...wbase, target: 'local', result: { ...none, removed: ['MAIN.c'] } }), 'Removed: MAIN.c\nWatch list: 3 symbols\nADS target: local');
});
```

`wbase` of B1 gains `target: 'local'`; every other expected `watchResultText` string of B1 gains `\nADS target: local` at its end. In `waitResultText words every outcome` add `target: 'local'` to `base` and append `\nADS target: local` to every expected text (`Wait cancelled.\nADS target: local`, `Error: nope\nADS target: local` with `isError: true` kept).

`writeGate.test.ts` `writeResultText for all kinds`: the helper `op('MAIN.x')` has `targetKey: 'A:851'`, so every expected string gets `\nADS target: A`, e.g. `'Written. MAIN.x reads back as 5 (the PLC may change it again).\nADS target: A'`. The regexes in `mcpTools.test.ts` (`/^Written\. MAIN\.x reads back as 1/`, `/^Not written/`, `/^Outcome unknown:/`) stay valid and are the proof that the verdict is still first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL (`targetLine` missing; old strings lack the line).

- [ ] **Step 3: Implement**

Add the two helpers to `adsToolText.ts`; append `targetLine(o.target)` as the last line in `watchResultText` and in every `waitResultText` branch (`{ text: \`...\n${targetLine(o.target)}\` }`, `isError` kept); in `writeResultText` append `\n${targetLine(targetOfKey(op.targetKey))}` to all three branches (the file already imports from `adsToolText`). In `adsTools.ts` pass `target: host.target()` to both text functions.

`CHANGELOG.md`: `- Results of \`ads_watch\`, \`ads_write\` and \`ads_wait\` end with the line \`ADS target: <target>\`, so a result always says which PLC it came from.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/CHANGELOG.md
git commit -s -m "Name the ADS target in watch, write and wait results" -m "Reads already said where the values came from, but a write result did not, and the target can be switched in the settings. The line goes last so the verdict words stay first."
```

---

### Task B2: Clear the AI entries; remove the user's entries after a confirmation

**Files:**
- Create: `extension/src/core/watchRequest.ts`, `extension/test/watchRequest.test.ts`
- Modify: `extension/src/core/watchList.ts` (`aiEdit` options, `userOwned`)
- Modify: `extension/src/core/toolInput.ts` (`clearAi`, `force`)
- Modify: `extension/src/core/adsToolText.ts` (`watchResultText` line, `confirmRemoveText`)
- Modify: `extension/src/ads/adsTools.ts` (confirmation dialog, `runWatchRequest`)
- Modify: `extension/package.json`, `extension/CHANGELOG.md`, `extension/README.md`
- Test: `extension/test/watchList.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`, `watchRequest.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Consumes: B1 (`AiEditResult`, `WatchRequest`, `watchResultText`).
- Produces:
  ```ts
  // watchList.ts
  export interface AiEditOptions {
    /** Symbols the user confirmed to remove although they added them. Only these user entries may go. */
    removeUser?: string[];
    /** Remove every AI entry that no wait holds. */
    clearAi?: boolean;
  }
  aiEdit(add: string[], remove: string[], opts?: AiEditOptions): Promise<AiEditResult>;
  /** The requested symbols (requested spelling) that are entries the user added; reads the list now, outside the step chain. */
  userOwned(symbols: string[]): string[];
  // watchRequest.ts
  export type ConfirmUserRemoval = (symbols: string[], signal: AbortSignal) => Promise<boolean>;
  export interface WatchRunResult extends AiEditResult { declined: string[] }
  export function runWatchRequest(list: WatchList, req: WatchRequest, confirm: ConfirmUserRemoval, signal: AbortSignal): Promise<WatchRunResult>;
  // toolInput.ts: WatchRequest gains `clearAi?: boolean; force?: boolean`
  // adsToolText.ts
  export function confirmRemoveText(symbols: string[]): string;
  // WatchResultInput.result becomes WatchRunResult; a new line `Not removed (the user did not confirm): a, b` follows `Not removed (added by the user, ...)`.
  ```

`runWatchRequest` rules: (1) `force` with symbols in `remove`: `owned = list.userOwned(remove)`; if `owned` is non-empty ask **once** with all of them; `true` puts them in `removeUser`, `false` puts them in `declined`. (2) The edit runs as one `aiEdit(add, remove, { removeUser, clearAi })`. (3) `kept` of the result excludes the declined ones (they have their own line). Without `force` nothing is asked: user entries land in `kept` as before. `confirm` that throws counts as "no". The confirmation is never asked while holding the list's step chain (a dialog can stay open for minutes and would block every other edit).

`clearAi: true`: removes every AI entry that is not held (held ones are reported in `held`), result `Removed: ...` as for a normal removal, `kept` empty.

`confirmRemoveText(symbols)`: `An AI tool asks to remove N variables you added from the ADS Watch list:\n<one per line>` (`1 variable` for one); at most 10 lines, then `(and K more)`.

Parser rules (exact errors): `force` and `clearAi` are booleans (`force must be a boolean`, `clearAi must be a boolean`); `force` without symbols in `remove` is `force needs remove`; `clearAi` together with `add` or `remove` is `clearAi cannot be combined with add or remove`. `wantsFullList` stays true for an empty call and `list: true`; a request with `clearAi` is not an empty call.

Wiring (`adsTools.ts`): the callback shows `vscode.window.showWarningMessage(confirmRemoveText(symbols), { modal: true }, 'Remove')` and is raced against the call's `signal` and a 120 s timer; abort or timeout answers `false`, and a dialog answer that arrives afterwards is ignored (VS Code cannot close a modal programmatically, so the race, not the dialog, decides). Not influenced by `iecode.ads.aiWrites`: that setting governs PLC writes only.

- [ ] **Step 1: Write the failing tests**

`watchList.test.ts`:

```ts
test('clearAi removes every AI entry that no wait holds and keeps the user\'s', async () => {
  const f = fake([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }, { symbol: 'B', ai: true }]);
  const h = await f.w.hold('B');
  const r = await f.w.aiEdit([], [], { clearAi: true });
  assert.deepEqual(r.removed, ['A']);
  assert.deepEqual(r.held, ['B']);
  assert.deepEqual(f.list().map(e => e.symbol), ['U', 'B']);
  await h.release();
  assert.deepEqual(f.list().map(e => e.symbol), ['U']);
});

test('removeUser removes exactly the confirmed user entries', async () => {
  const f = fake([{ symbol: 'U1', ai: false }, { symbol: 'U2', ai: false }]);
  const r = await f.w.aiEdit([], ['u1', 'U2'], { removeUser: ['u1'] });
  assert.deepEqual(r, { added: [], already: [], removed: ['u1'], kept: ['U2'], held: [], missing: [] });
  assert.deepEqual(f.list(), [{ symbol: 'U2', ai: false }]);
});

test('a user entry that a wait holds is not removed even when confirmed', async () => {
  const f = fake([{ symbol: 'U', ai: false }]);
  const h = await f.w.hold('U');
  const r = await f.w.aiEdit([], ['U'], { removeUser: ['U'] });
  assert.deepEqual(r.held, ['U']);
  await h.release();
  assert.deepEqual(f.list(), [{ symbol: 'U', ai: false }]);
});

test('userOwned names the requested entries the user added', () => {
  const f = fake([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }]);
  assert.deepEqual(f.w.userOwned(['u', 'a', 'zz']), ['u']);
});
```

`watchRequest.test.ts` (fake list as in `watchList.test.ts`; `confirm` records its calls):

```ts
test('force asks once for all user entries and removes them on yes', async () => {
  const f = fakeList([{ symbol: 'U1', ai: false }, { symbol: 'U2', ai: false }, { symbol: 'A', ai: true }]);
  const asked: string[][] = [];
  const r = await runWatchRequest(f.w, { add: [], remove: ['U1', 'U2', 'A'], force: true }, async s => { asked.push(s); return true; }, new AbortController().signal);
  assert.deepEqual(asked, [['U1', 'U2']]);
  assert.deepEqual(r.removed, ['U1', 'U2', 'A']);
  assert.deepEqual(r.declined, []);
  assert.deepEqual(f.list(), []);
});

test('a declined confirmation keeps the user entries and says so; AI entries still go', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }]);
  const r = await runWatchRequest(f.w, { add: [], remove: ['U', 'A'], force: true }, async () => false, new AbortController().signal);
  assert.deepEqual({ removed: r.removed, declined: r.declined, kept: r.kept }, { removed: ['A'], declined: ['U'], kept: [] });
  assert.deepEqual(f.list(), [{ symbol: 'U', ai: false }]);
});

test('without force nothing is asked and the user entry is kept', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }]);
  let asked = 0;
  const r = await runWatchRequest(f.w, { add: [], remove: ['U'] }, async () => { asked++; return true; }, new AbortController().signal);
  assert.equal(asked, 0);
  assert.deepEqual(r.kept, ['U']);
});

test('a confirmation that throws counts as no, and no confirmation is asked when no user entry is named', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }, { symbol: 'A', ai: true }]);
  const r = await runWatchRequest(f.w, { add: [], remove: ['U'], force: true }, async () => { throw new Error('x'); }, new AbortController().signal);
  assert.deepEqual(r.declined, ['U']);
  let asked = 0;
  await runWatchRequest(f.w, { add: [], remove: ['A'], force: true }, async () => { asked++; return true; }, new AbortController().signal);
  assert.equal(asked, 0);
});

test('the confirmation does not block other list edits while it is open', async () => {
  const f = fakeList([{ symbol: 'U', ai: false }]);
  let answer!: (v: boolean) => void;
  const p = runWatchRequest(f.w, { add: [], remove: ['U'], force: true }, () => new Promise<boolean>(r => { answer = r; }), new AbortController().signal);
  await f.w.aiEdit(['B'], []);            // returns while the dialog is open
  assert.deepEqual(f.list().map(e => e.symbol), ['U', 'B']);
  answer(true);
  assert.deepEqual((await p).removed, ['U']);
});
```

`toolInput.test.ts`: `parseWatchInput({ remove: ['a'], force: true })` is `{ ok: true, value: { add: [], remove: ['a'], force: true } }`; `{ force: true }` fails with `force needs remove`; `{ force: 'yes', remove: ['a'] }` with `force must be a boolean`; `{ clearAi: true }` is ok; `{ clearAi: true, add: ['a'] }` fails with `clearAi cannot be combined with add or remove`; `wantsFullList({ add: [], remove: [], clearAi: true })` is false.

`adsToolText.test.ts`:

```ts
test('confirmRemoveText lists the entries and cuts a long list', () => {
  assert.equal(confirmRemoveText(['MAIN.a']), 'An AI tool asks to remove 1 variable you added from the ADS Watch list:\nMAIN.a');
  assert.equal(confirmRemoveText(['a', 'b']), 'An AI tool asks to remove 2 variables you added from the ADS Watch list:\na\nb');
  const many = Array.from({ length: 13 }, (_, i) => `S${i}`);
  assert.equal(confirmRemoveText(many).split('\n').slice(-2).join('|'), 'S9|(and 3 more)');
});

test('watch result: a declined removal has its own line', () => {
  assert.equal(watchResultText({ ...wbase, result: { ...none, declined: ['U'], removed: ['A'] } }),
    'Removed: A\nNot removed (the user did not confirm): U\nWatch list: 3 symbols\nADS target: local');
});
```
(`none` gains `declined: []`; B1's `watchResultText` tests keep their strings.)

`mcpTools.test.ts` manifest test: `ads_watch` properties now include `clearAi` and `force` (both `boolean`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (`runWatchRequest`, `confirmRemoveText`, `userOwned`, options).

- [ ] **Step 3: Implement**

`aiEdit` options as specified: a symbol of `remove` that is the user's counts as removable only when it is in `removeUser` (case-insensitive); with `clearAi` the removable set is every AI entry; held entries go to `held` and stay (the postponed-removal bookkeeping of the current code applies to AI entries only; a held user entry is never removed later). `runWatchRequest`, parser rules, `confirmRemoveText` and the wiring as specified above. `adsTools.watch` calls `runWatchRequest(host.list, input, confirmRemove, signal)` inside the existing `leased` and try/catch and logs `AI removed N variables the user added (confirmed)` to the IECode output (`output.info`) when something was removed with `force`.

`package.json` `iecode_ads_watch` properties:
`"clearAi": { "type": "boolean", "description": "Remove every entry you added (the user's entries stay; entries a running wait uses stay until it ends). Cannot be combined with add or remove." }`,
`"force": { "type": "boolean", "description": "With remove: also remove entries the user added, after the user confirmed in a dialog. Without it only your own entries can be removed." }`;
`modelDescription`: replace `you can only remove those, not the ones the user added.` by `you can remove only those, unless you pass force: true with remove, which asks the user once to confirm removing their entries. clearAi: true removes all entries you added.`

`README.md` line 69: replace `the AI can only remove those` by `the AI can only remove those unless the user confirms a dialog`.

`CHANGELOG.md`: `- \`ads_watch\` can clear everything the AI added (\`clearAi\`) in one call, and can remove entries you added after you confirm a dialog (\`remove\` with \`force\`). Without the confirmation your entries stay.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/package.json extension/CHANGELOG.md extension/README.md
git commit -s -m "Let the AI clear its watch entries and remove the user's after a confirmation" -m "Cleaning up after a debugging session took one remove call per symbol and was impossible for entries the user added. The confirmation is asked once, outside the list's step chain, so a dialog left open cannot block other edits."
```

---

### Task B3a: Group labels on watch entries (pure model)

**Files:**
- Create: `extension/src/core/watchGroups.ts`, `extension/test/watchGroups.test.ts`
- Modify: `extension/src/core/adswatch.ts` (`WatchEntry`, `parseWatchList`, `watchEdit`, `watchRename`)
- Test: `extension/test/adswatch.test.ts`

**Interfaces:**
- Consumes: `WatchEntry` from `adswatch.ts`.
- Produces:
  ```ts
  // adswatch.ts
  export interface WatchEntry { symbol: string; ai: boolean; groups?: string[] }   // groups only ever on AI entries; key absent when none
  // watchGroups.ts
  export const MAX_GROUP_LENGTH = 64;
  export const groupKey = (name: string): string => name.trim().toLowerCase();
  export function groupNameError(name: string): string | undefined;                  // `group must not be blank` | `group is longer than 64 characters`
  export function isActive(e: WatchEntry, off: readonly string[]): boolean;          // no group, or at least one group not in `off`; `off` holds group keys
  export function activeSymbols(entries: WatchEntry[], off: readonly string[], held: readonly string[]): string[]; // entries that are active or held, order kept
  export interface GroupSummary { name: string; count: number; on: boolean }
  export function groupSummaries(entries: WatchEntry[], off: readonly string[]): GroupSummary[];   // order of first appearance, name = first spelling
  export function addToGroup(current: WatchEntry[], symbols: string[], group: string): { entries: WatchEntry[]; grouped: string[]; refused: string[] };
  export function dropGroup(current: WatchEntry[], group: string): { entries: WatchEntry[]; removed: string[] };
  ```

Rules: `addToGroup` labels only entries with `ai === true`; a requested symbol that is a user entry is `refused` (requested spelling), one that is not in `current` is ignored; an entry already in the group is in `grouped` and unchanged; group comparison is by `groupKey`, the stored spelling is the first one used. `dropGroup` removes the label from every entry; an entry left with no group **and** that was labelled (had a group) is removed, an entry with another group stays with it; `removed` lists the stored symbols. `watchEdit` taking an AI entry over (`byAi = false` and the entry exists) clears its groups (`{ symbol, ai: false }`, no `groups` key); `watchRename` keeps `groups` untouched for an AI entry but, as it makes the entry the user's, also clears them. `parseWatchList` reads `groups` when it is an array of non-blank strings, drops blanks, and sets the key only when at least one remains.

- [ ] **Step 1: Write the failing tests**

`watchGroups.test.ts`:

```ts
const e = (symbol: string, ai: boolean, groups?: string[]): WatchEntry => (groups ? { symbol, ai, groups } : { symbol, ai });

test('an entry is sampled when it has no group or one of its groups is on', () => {
  assert.equal(isActive(e('a', true), ['t1']), true);
  assert.equal(isActive(e('a', true, ['T1']), ['t1']), false);
  assert.equal(isActive(e('a', true, ['T1', 'T2']), ['t1']), true);
});

test('activeSymbols keeps held symbols of a switched-off group', () => {
  const list = [e('a', true, ['T1']), e('b', false)];
  assert.deepEqual(activeSymbols(list, ['t1'], []), ['b']);
  assert.deepEqual(activeSymbols(list, ['t1'], ['A']), ['a', 'b']);
});

test('groupSummaries counts members in order of first appearance', () => {
  assert.deepEqual(groupSummaries([e('a', true, ['T1']), e('b', true, ['t1', 'T2'])], ['t2']),
    [{ name: 'T1', count: 2, on: true }, { name: 'T2', count: 1, on: false }]);
});

test('addToGroup labels AI entries and refuses the user\'s', () => {
  const r = addToGroup([e('a', true), e('u', false)], ['a', 'U', 'A', 'nope'], ' T1 ');
  assert.deepEqual(r, { entries: [e('a', true, ['T1']), e('u', false)], grouped: ['a'], refused: ['U'] });
  assert.deepEqual(addToGroup(r.entries, ['a'], 't1').entries, r.entries);   // no duplicate label
});

test('dropGroup keeps entries of other groups and removes the rest', () => {
  const r = dropGroup([e('a', true, ['T1']), e('b', true, ['T1', 'T2']), e('c', true)], 'T1');
  assert.deepEqual(r, { entries: [e('b', true, ['T2']), e('c', true)], removed: ['a'] });
});

test('group names are validated', () => {
  assert.equal(groupNameError('  '), 'group must not be blank');
  assert.equal(groupNameError('x'.repeat(65)), 'group is longer than 64 characters');
  assert.equal(groupNameError('T1'), undefined);
});
```

`adswatch.test.ts`:

```ts
test('parseWatchList keeps groups, drops blanks and leaves old entries untouched', () => {
  assert.deepEqual(parseWatchList([{ symbol: 'a', ai: true, groups: ['T1', ' ', 5] }, { symbol: 'b', ai: true, groups: [] }, 'c']),
    [{ symbol: 'a', ai: true, groups: ['T1'] }, { symbol: 'b', ai: true }, { symbol: 'c', ai: false }]);
});

test('the user taking over or renaming an AI entry clears its groups', () => {
  assert.deepEqual(watchEdit([{ symbol: 'a', ai: true, groups: ['T1'] }], ['A']), [{ symbol: 'a', ai: false }]);
  assert.deepEqual(watchRename([{ symbol: 'a', ai: true, groups: ['T1'] }], 'a', 'a2'), [{ symbol: 'a2', ai: false }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile error `Cannot find module '../src/core/watchGroups'`.

- [ ] **Step 3: Implement** `watchGroups.ts` and the `adswatch.ts` changes as specified (`watchEdit` line 373 currently spreads `{ ...e, ai: false }`; build the object without `groups` instead; `watchRename` line 393 already creates `{ symbol: next, ai: false }`, only the same-name path needs a test).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass, existing `watchEdit`/`parseWatchList` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/watchGroups.ts extension/src/core/adswatch.ts extension/test/watchGroups.test.ts extension/test/adswatch.test.ts
git commit -s -m "Add group labels to ADS watch entries" -m "Groups are a label on AI entries, so the saved list needs no new structure and old lists load unchanged. Groups on user entries are not allowed: the AI could otherwise hide something the user watches by switching a group off."
```

---

### Task B3b: Groups in `WatchList` and the host (switch, remove, active list)

**Files:**
- Modify: `extension/src/core/watchList.ts` (deps, `save`, `aiEdit` group option, `setGroup`, `removeGroup`, `groupState`, hold handling)
- Modify: `extension/src/ads/host.ts` (`groupsOff`, `setGroupsOff`, `setEntries(entries, active?)`, `watched()`, constructor)
- Modify: `extension/src/views/adsWatch.ts` (picker filter uses `entries()`)
- Test: `extension/test/watchList.test.ts`

**Interfaces:**
- Consumes: B3a (`activeSymbols`, `addToGroup`, `dropGroup`, `groupKey`, `isActive`), B1/B2 `AiEditResult`, `AiEditOptions`.
- Produces:
  ```ts
  export interface WatchListDeps {
    entries(): WatchEntry[];
    /** Saves the list; `active` are the symbols to sample (the list minus switched-off groups, plus held symbols). */
    set(entries: WatchEntry[], active: string[]): Promise<unknown>;
    /** Keys (`groupKey`) of the switched-off groups. */
    groupsOff(): string[];
    setGroupsOff(keys: string[]): Promise<unknown>;
  }
  export interface AiEditOptions { removeUser?: string[]; clearAi?: boolean; group?: string }   // group is new
  // AiEditResult gains:  grouped: string[]; ungrouped: string[]; switchedOn: boolean
  setGroup(name: string, enabled: boolean): Promise<{ found: boolean; members: number }>;
  removeGroup(name: string): Promise<{ found: boolean; removed: string[]; held: string[] }>;
  groupState(name: string): 'on' | 'off' | 'none';
  // AdsHost
  watched(): string[];                   // now the sampled (active) symbols
  entries(): WatchEntry[];               // unchanged: the whole saved list, parked entries included
  groupsOff(): string[];                 // workspaceState `iecode.adsWatchOff`
  setGroupsOff(keys: string[]): Promise<void>;
  setEntries(entries: WatchEntry[], active?: string[]): Promise<WatchItem[]>;
  ```

Rules:
- Every save goes through a private `save(next)` that computes `active = activeSymbols(next, deps.groupsOff(), heldSymbols)`, refuses with `watchLimitError(active.length)` **before** anything is written, and calls `deps.set(next, active)`. All existing `deps.set(...)` calls become `save(...)`.
- `aiEdit` with `opts.group`: the added symbols and the requested adds that already exist as AI entries are labelled with `addToGroup`; user entries land in `ungrouped`; if the group was switched off it is switched on in the same step (`switchedOn: true`, its key removed from `groupsOff` before the save).
- `setGroup`: `found` is false when no entry has the group (nothing changes). Otherwise the limit is checked with the new state first, then `setGroupsOff` is written, then `save(entries)` re-evaluates the sampled list.
- `removeGroup`: `dropGroup`; entries a wait holds stay (they lose the label and are reported in `held`); the group's key leaves `groupsOff`.
- `hold` of a symbol that exists but is parked (all its groups off): the token is registered first, then `save(current)` makes it sampled; a failing save undoes the token. The last `release` of a hold on an entry that is parked again (its groups are all off and it was not added by the hold) saves once more so it stops being sampled. `userEdit` and the rest of the hold logic stay as they are.
- Host: `setEntries` keeps the groups when it rebuilds `kept` (`e.groups?.length ? { symbol, ai: e.ai, groups: e.groups } : { symbol, ai: e.ai }`), sends only the active symbols to the CLI, sets `items_` to those, and remembers them in `private active: string[] | undefined`; `watched()` returns `this.active ?? activeSymbols(this.entries(), this.groupsOff(), [])`. `adsWatch.ts` `iecode.adsWatchAdd` builds its already-watched set from `host.entries()` so a parked symbol is not offered again. The view shows sampled entries only; **Clear** (`userEdit(() => [])`) clears parked entries too, as it clears the whole saved list.

- [ ] **Step 1: Write the failing tests**

Replace `fake()` in `watchList.test.ts` (the existing tests keep working through the same `list()` and `sets`):

```ts
function fake(initial: WatchEntry[] = [], offInitial: string[] = []) {
  let list = initial;
  let off = offInitial;
  let active: string[] = [];
  const sets: WatchEntry[][] = [];
  const w = new WatchList({
    entries: () => list,
    set: async (e, a) => { await Promise.resolve(); list = e; active = a; sets.push(e); },
    groupsOff: () => off,
    setGroupsOff: async k => { await Promise.resolve(); off = k; },
  });
  return { w, list: () => list, sets, active: () => active, off: () => off };
}
```

```ts
test('add with a group labels the entries; switching the group off stops sampling but keeps the entries', async () => {
  const f = fake();
  const r = await f.w.aiEdit(['A', 'B'], [], { group: 'T1' });
  assert.deepEqual([r.added, r.grouped, r.ungrouped, r.switchedOn], [['A', 'B'], ['A', 'B'], [], false]);
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: true, groups: ['T1'] }, { symbol: 'B', ai: true, groups: ['T1'] }]);
  assert.deepEqual(await f.w.setGroup('t1', false), { found: true, members: 2 });
  assert.deepEqual(f.active(), []);
  assert.equal(f.list().length, 2);
  await f.w.setGroup('T1', true);
  assert.deepEqual(f.active(), ['A', 'B']);
});

test('adding to a switched-off group switches it on', async () => {
  const f = fake([{ symbol: 'A', ai: true, groups: ['T1'] }], ['t1']);
  const r = await f.w.aiEdit(['B'], [], { group: 'T1' });
  assert.equal(r.switchedOn, true);
  assert.deepEqual(f.off(), []);
  assert.deepEqual(f.active(), ['A', 'B']);
});

test('a symbol in two groups is sampled until both are off', async () => {
  const f = fake();
  await f.w.aiEdit(['A'], [], { group: 'T1' });
  await f.w.aiEdit(['A'], [], { group: 'T2' });
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: true, groups: ['T1', 'T2'] }]);
  await f.w.setGroup('T1', false);
  assert.deepEqual(f.active(), ['A']);
  await f.w.setGroup('T2', false);
  assert.deepEqual(f.active(), []);
});

test('a group switched off while a wait holds a symbol keeps it sampled until the wait ends', async () => {
  const f = fake();
  await f.w.aiEdit(['P'], [], { group: 'T1' });
  const h = await f.w.hold('P');
  await f.w.setGroup('T1', false);
  assert.deepEqual(f.active(), ['P']);
  await h.release();
  assert.deepEqual(f.active(), []);
  assert.equal(f.list().length, 1);
});

test('a hold on a parked entry starts sampling it and parks it again on release', async () => {
  const f = fake([{ symbol: 'P', ai: true, groups: ['T1'] }], ['t1']);
  const h = await f.w.hold('P');
  assert.deepEqual(f.active(), ['P']);
  await h.release();
  assert.deepEqual(f.active(), []);
  assert.deepEqual(f.list(), [{ symbol: 'P', ai: true, groups: ['T1'] }]);
});

test('removeGroup removes the entries no other group needs and reports held ones', async () => {
  const f = fake();
  await f.w.aiEdit(['A', 'B'], [], { group: 'T1' });
  await f.w.aiEdit(['B'], [], { group: 'T2' });
  await f.w.setGroup('T1', false);
  const h = await f.w.hold('A');
  const r = await f.w.removeGroup('T1');
  assert.deepEqual(r, { found: true, removed: [], held: ['A'] });
  assert.deepEqual(f.list().map(e => e.symbol), ['A', 'B']);
  await h.release();
  assert.deepEqual(await f.w.removeGroup('T2'), { found: true, removed: ['B'], held: [] });
  assert.deepEqual(f.off(), []);
});

test('a user entry cannot join a group', async () => {
  const f = fake([{ symbol: 'U', ai: false }]);
  const r = await f.w.aiEdit(['U'], [], { group: 'T1' });
  assert.deepEqual([r.already, r.ungrouped, r.grouped], [['U'], ['U'], []]);
  assert.deepEqual(f.list(), [{ symbol: 'U', ai: false }]);
});

test('an unknown group changes nothing', async () => {
  const f = fake([{ symbol: 'A', ai: true }]);
  assert.deepEqual(await f.w.setGroup('nope', false), { found: false, members: 0 });
  assert.deepEqual(await f.w.removeGroup('nope'), { found: false, removed: [], held: [] });
  assert.equal(f.sets.length, 0);
  assert.equal(f.w.groupState('nope'), 'none');
});

test('switching a group on over the limit is refused and the group stays off', async () => {
  const user = Array.from({ length: 150 }, (_, i) => ({ symbol: `S${i}`, ai: false }));
  const parked = Array.from({ length: 60 }, (_, i) => ({ symbol: `P${i}`, ai: true, groups: ['T1'] }));
  const f = fake([...user, ...parked], ['t1']);
  await assert.rejects(f.w.setGroup('T1', true), /200/);
  assert.deepEqual(f.off(), ['t1']);
});

test('the user taking an AI entry over drops its group', async () => {
  const f = fake([{ symbol: 'A', ai: true, groups: ['T1'] }]);
  await f.w.userEdit(c => watchEdit(c, ['a']));
  assert.deepEqual(f.list(), [{ symbol: 'A', ai: false }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile errors (deps shape, `setGroup`, `group` option).

- [ ] **Step 3: Implement** `watchList.ts` and the host wiring as specified. Constructor of `AdsHost`: `new WatchList({ entries: () => this.entries(), set: (e, a) => this.setEntries(e, a), groupsOff: () => this.groupsOff(), setGroupsOff: k => this.setGroupsOff(k) })`; the constructor's initial `items_` already uses `this.watched()`, which now means the sampled list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass, including the unchanged wait-hold tests.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test
git commit -s -m "Switch watch groups on and off in the watch list owner" -m "The list owner already serializes edits and knows the wait holds, so the sampled list (groups on, plus held symbols) is computed there and the host only receives it. Parked entries stay in the saved list."
```

---

### Task B3c: Group input, group results and the full-list view

**Files:**
- Modify: `extension/src/core/toolInput.ts` (`group`, `enable`, `removeGroup`)
- Modify: `extension/src/core/watchRequest.ts` (`runWatchRequest` group operations)
- Modify: `extension/src/core/adsToolText.ts` (`watchListText`, `watchResultText`)
- Modify: `extension/src/ads/adsTools.ts` (`parked`, `off` into the texts)
- Modify: `extension/package.json`, `extension/CHANGELOG.md`
- Test: `extension/test/toolInput.test.ts`, `adsToolText.test.ts`, `watchRequest.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Consumes: B3a/B3b (`groupNameError`, `groupSummaries`, `WatchList.setGroup/removeGroup/groupState`), B2 (`runWatchRequest`, `WatchRunResult`).
- Produces:
  ```ts
  // toolInput.ts: WatchRequest gains  group?: string; enable?: boolean; removeGroup?: boolean
  // watchRequest.ts
  export interface GroupOp { name: string; action: 'on' | 'off' | 'removed' | 'none'; members: number }   // 'none': no such group
  export interface WatchRunResult extends AiEditResult { declined: string[]; groupOp?: GroupOp }
  // adsToolText.ts
  export function watchListText(items: WatchItem[], entries: WatchEntry[], off?: readonly string[]): string;   // off = group keys
  // WatchResultInput gains:  group?: string; parked: number
  ```

Parser rules (exact errors, in this order of checking): `group` is a non-blank string of at most 64 characters (`groupNameError`); `enable` and `removeGroup` are booleans; `enable needs group`; `removeGroup needs group`; `enable and removeGroup cannot be combined`; `removeGroup cannot be combined with add or remove`; `group cannot be combined with remove; use removeGroup to remove a whole group`; `group needs add, enable or removeGroup`; `clearAi cannot be combined with add, remove or group` (replaces the B2 text for `group`; `clearAi` with `add`/`remove` keeps `clearAi cannot be combined with add or remove` only when no group is set). Fields are omitted from the parsed value when absent.

`runWatchRequest` order: (1) `removeGroup` -> `list.removeGroup(group)`, its `removed`/`held` merged into the result, `groupOp: { action: 'removed' }` or `'none'`; (2) otherwise the `aiEdit(add, remove, { group, removeUser, clearAi })` of B2; (3) `enable !== undefined` -> `list.setGroup(group, enable)` after the edit, `groupOp: { action: enable ? 'on' : 'off' }` (`'none'` when the group does not exist). A group switched on only because an add landed in it is reported by `switchedOn`, not by `groupOp`.

Result lines (exact), after the B1 diff lines and before the `Error:` lines: `Group T1: a, b` (symbols labelled by this call); `Group T1 switched on (it was off)` when `switchedOn`; `Not grouped (added by the user): U`; `Group T1 switched on (3 symbols)`; `Group T1 switched off (3 symbols, not sampled now)`; `Group T1 removed`; `No group named T1`. The count line becomes `Watch list: 3 symbols` or, when `parked > 0`, `Watch list: 3 symbols, 2 switched off`.

`watchListText` (full list) is byte-identical when no entry has a group. Otherwise each listed entry with groups gets ` [group T1, T2]` after its `[added by AI]` marker; then, if parked entries exist (entries not among `items`), `Switched off (not sampled): MAIN.b [group T2]`; then `Groups: T1 on (1), T2 off (1)`. An empty `items` list with parked entries prints `The ADS watch list is empty.` first.

- [ ] **Step 1: Write the failing tests**

`toolInput.test.ts`:

```ts
test('parseWatchInput reads the group fields and rejects contradictory ones', () => {
  assert.deepEqual(parseWatchInput({ add: ['a'], group: ' T1 ' }), { ok: true, value: { add: ['a'], remove: [], group: 'T1' } });
  assert.deepEqual(parseWatchInput({ group: 'T1', enable: false }), { ok: true, value: { add: [], remove: [], group: 'T1', enable: false } });
  assert.deepEqual(parseWatchInput({ group: 'T1', removeGroup: true }), { ok: true, value: { add: [], remove: [], group: 'T1', removeGroup: true } });
  const bad = (raw: unknown, error: string) => assert.deepEqual(parseWatchInput(raw), { ok: false, error });
  bad({ enable: true }, 'enable needs group');
  bad({ removeGroup: true }, 'removeGroup needs group');
  bad({ group: 'T1', enable: true, removeGroup: true }, 'enable and removeGroup cannot be combined');
  bad({ group: 'T1', removeGroup: true, add: ['a'] }, 'removeGroup cannot be combined with add or remove');
  bad({ group: 'T1', remove: ['a'] }, 'group cannot be combined with remove; use removeGroup to remove a whole group');
  bad({ group: 'T1' }, 'group needs add, enable or removeGroup');
  bad({ group: ' ', add: ['a'] }, 'group must not be blank');
  bad({ group: 'T1', add: ['a'], clearAi: true }, 'clearAi cannot be combined with add, remove or group');
});

test('wantsFullList is false for a group operation', () => {
  assert.equal(wantsFullList({ add: [], remove: [], group: 'T1', enable: false }), false);
});
```

`watchRequest.test.ts` (list fake of B3b; `yes = async () => true`):

```ts
test('add into a group, switch it off, switch it on, remove it', async () => {
  const f = fakeList();
  const sig = new AbortController().signal;
  const a = await runWatchRequest(f.w, { add: ['A', 'B'], remove: [], group: 'T1' }, yes, sig);
  assert.deepEqual([a.added, a.grouped], [['A', 'B'], ['A', 'B']]);
  const off = await runWatchRequest(f.w, { add: [], remove: [], group: 'T1', enable: false }, yes, sig);
  assert.deepEqual(off.groupOp, { name: 'T1', action: 'off', members: 2 });
  assert.deepEqual(f.active(), []);
  const on = await runWatchRequest(f.w, { add: [], remove: [], group: 'T1', enable: true }, yes, sig);
  assert.deepEqual(on.groupOp, { name: 'T1', action: 'on', members: 2 });
  const gone = await runWatchRequest(f.w, { add: [], remove: [], group: 'T1', removeGroup: true }, yes, sig);
  assert.deepEqual([gone.groupOp?.action, gone.removed], ['removed', ['A', 'B']]);
  const none = await runWatchRequest(f.w, { add: [], remove: [], group: 'T9', enable: true }, yes, sig);
  assert.deepEqual(none.groupOp, { name: 'T9', action: 'none', members: 0 });
});

test('add with enable: false prepares a switched-off group', async () => {
  const f = fakeList();
  await runWatchRequest(f.w, { add: ['A'], remove: [], group: 'T1', enable: false }, yes, new AbortController().signal);
  assert.deepEqual(f.active(), []);
  assert.equal(f.list().length, 1);
});
```

`adsToolText.test.ts`:

```ts
test('watch result: group lines', () => {
  const r = { ...none, declined: [], added: ['a'], grouped: ['a'], ungrouped: ['U'], switchedOn: true };
  assert.equal(watchResultText({ ...wbase, group: 'T1', parked: 2, result: r }),
    'Added: a\nGroup T1: a\nGroup T1 switched on (it was off)\nNot grouped (added by the user): U\nWatch list: 3 symbols, 2 switched off\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
  const op = (action: 'on' | 'off' | 'removed' | 'none') => watchResultText({ ...wbase, parked: 0, result: { ...none, declined: [], grouped: [], ungrouped: [], switchedOn: false, groupOp: { name: 'T1', action, members: 3 } } });
  assert.equal(op('on'), 'Group T1 switched on (3 symbols)\nWatch list: 3 symbols\nADS target: local');
  assert.equal(op('off'), 'Group T1 switched off (3 symbols, not sampled now)\nWatch list: 3 symbols\nADS target: local');
  assert.equal(op('removed'), 'Group T1 removed\nWatch list: 3 symbols\nADS target: local');
  assert.equal(op('none'), 'No group named T1\nWatch list: 3 symbols\nADS target: local');
});

test('the full list shows groups and the parked entries; without groups it is unchanged', () => {
  const entries = [{ symbol: 'MAIN.a', ai: true, groups: ['T1'] }, { symbol: 'MAIN.b', ai: true, groups: ['T2'] }];
  assert.equal(watchListText([item('MAIN.a')], entries, ['t2']),
    'MAIN.a : INT [added by AI] [group T1]\nSwitched off (not sampled): MAIN.b [group T2]\nGroups: T1 on (1), T2 off (1)');
  assert.equal(watchListText([], entries.slice(1), ['t2']),
    'The ADS watch list is empty.\nSwitched off (not sampled): MAIN.b [group T2]\nGroups: T2 off (1)');
});
```
(The `none` fixture of B1/B2 gains `grouped: [], ungrouped: [], switchedOn: false`; `wbase` gains `parked: 0`.) Existing `watch list text marks who added the entries` stays green unchanged.

`mcpTools.test.ts` manifest test: `ads_watch` property set is exactly `add, clearAi, enable, force, group, list, remove, removeGroup`, `group.maxLength === 64`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: FAIL (fields, texts, `group` in `runWatchRequest`).

- [ ] **Step 3: Implement** the parser, `runWatchRequest` group steps, the two text functions and `adsTools.watch` (`off: host.groupsOff()` into `watchListText` via the local `list(host)` helper, `parked: host.entries().length - host.watched().length`, `group: input.group`).

`package.json` `iecode_ads_watch` properties:
`"group": { "type": "string", "maxLength": 64, "description": "Name of a group. With add: the added symbols join the group (and a switched-off group is switched on). With enable or removeGroup: the group to switch or remove. Only entries you added can be in a group." }`,
`"enable": { "type": "boolean", "description": "With group: true samples the group again, false stops sampling its symbols without removing them." }`,
`"removeGroup": { "type": "boolean", "description": "With group: remove the group and the entries that belong to no other group." }`;
`modelDescription`: append `Entries can be put in named groups (add with group); a group can be switched off (group with enable: false) so its symbols are not sampled but stay in the list, or removed (group with removeGroup: true). A symbol in two groups is sampled while one of them is on.`

`CHANGELOG.md`: `- \`ads_watch\` supports named groups: symbols added with \`group\` can be switched off (\`enable: false\`) to keep the sample rate for the few that matter, switched on again, or removed in one call. Only entries the AI added can be in a group; the list shows the switched-off ones.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/package.json extension/CHANGELOG.md
git commit -s -m "Expose watch groups through ads_watch" -m "A boolean removeGroup replaces the idea of an empty remove with a group, which a client cannot tell from an unset field. Contradictory combinations are refused with their own error instead of guessed."
```

---

### Task B4: Persisted list, report entries that no longer resolve

**Files:**
- Create: `extension/src/core/unresolved.ts`, `extension/test/unresolved.test.ts`
- Modify: `extension/src/core/adsToolText.ts` (`unresolvedText`, `watchResultText` field)
- Modify: `extension/src/ads/host.ts` (`unresolved` owner, reset on target change)
- Modify: `extension/src/ads/adsTools.ts` (`watch`)
- Modify: `extension/CHANGELOG.md`
- Test: `extension/test/unresolved.test.ts`, `extension/test/adsToolText.test.ts`

**Interfaces:**
- Consumes: `WatchItem` from `adswatch.ts`; B1-B3c `watchResultText`.
- Produces:
  ```ts
  export interface UnresolvedEntry { symbol: string; error: string }
  export class UnresolvedNotes {
    /** Items with an error that were not reported yet. `exclude` (symbols of this call's add) are marked reported without being returned. A symbol that resolves or leaves the list is forgotten, so it is reported again if it breaks again. */
    take(items: WatchItem[], exclude?: string[]): UnresolvedEntry[];
    /** Forget everything (the target changed: the old answers say nothing about the new one). */
    reset(): void;
  }
  export function unresolvedText(entries: UnresolvedEntry[]): string | undefined;
  // WatchResultInput gains:  unresolved: UnresolvedEntry[]
  // AdsHost gains:  readonly unresolved: UnresolvedNotes   (reset() in the target-change branch of the configuration listener)
  ```

Persistence recap (no new storage): the list, the `ai` flags, the groups (`iecode.adsWatch`) and the switched-off groups (`iecode.adsWatchOff`) are in `workspaceState` and are re-sent by `afterHello` on every host start. This task only makes a saved entry that stopped resolving visible, once. It is kept in the list (a rebuild may bring it back), and nothing retries it from the extension.

Text (exact), placed after the `Error:` lines and before the count line, in diff and full mode alike: `Not resolved on the target (kept in the list; rebuild the project or remove them):\nMAIN.a : Symbol not found` (one line per entry). `undefined` for an empty list.

- [ ] **Step 1: Write the failing tests**

```ts
const it = (symbol: string, error: string | null = null): WatchItem => ({ symbol, type: error ? '' : 'INT', numeric: false, error });

test('an unresolved entry is reported once, and again after it resolved and broke', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('a', 'Symbol not found'), it('b')]), [{ symbol: 'a', error: 'Symbol not found' }]);
  assert.deepEqual(n.take([it('a', 'Symbol not found')]), []);
  assert.deepEqual(n.take([it('a')]), []);
  assert.deepEqual(n.take([it('a', 'Symbol not found')]), [{ symbol: 'a', error: 'Symbol not found' }]);
});

test('an entry removed from the list is forgotten; reset forgets everything', () => {
  const n = new UnresolvedNotes();
  n.take([it('a', 'e')]);
  n.take([]);
  assert.equal(n.take([it('a', 'e')]).length, 1);
  n.reset();
  assert.equal(n.take([it('a', 'e')]).length, 1);
});

test('symbols of this call are marked reported without being returned', () => {
  const n = new UnresolvedNotes();
  assert.deepEqual(n.take([it('X', 'e')], ['x']), []);
  assert.deepEqual(n.take([it('X', 'e')]), []);
});
```

`adsToolText.test.ts`:

```ts
test('unresolved text and its place in the watch result', () => {
  assert.equal(unresolvedText([]), undefined);
  assert.equal(unresolvedText([{ symbol: 'MAIN.a', error: 'Symbol not found' }]),
    'Not resolved on the target (kept in the list; rebuild the project or remove them):\nMAIN.a : Symbol not found');
  assert.equal(watchResultText({ ...wbase, unresolved: [{ symbol: 'MAIN.a', error: 'Symbol not found' }], addErrors: ['MAIN.x : e'], result: { ...none, added: ['MAIN.x'] } }),
    'Added: MAIN.x\nError: MAIN.x : e\nNot resolved on the target (kept in the list; rebuild the project or remove them):\nMAIN.a : Symbol not found\nWatch list: 3 symbols\nNew values arrive every 100 ms; use ads_scope for the history.\nADS target: local');
});
```
(`wbase` gains `unresolved: []`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile error `Cannot find module '../src/core/unresolved'`.

- [ ] **Step 3: Implement** `UnresolvedNotes` (a `Set` of lower-case keys of reported symbols; `take` first drops keys whose item has no error or is no longer listed), `unresolvedText`, the text-function field; `host.ts`: `readonly unresolved = new UnresolvedNotes()` and `this.unresolved.reset()` next to `this.buffer.clear()` in the target-change branch; `adsTools.watch`: `unresolved: host.unresolved.take(host.items(), result.added)` after the edit (every call, so an empty list call right after a restart reports the stale entries once).

`CHANGELOG.md`: `- \`ads_watch\` says once which saved entries no longer resolve on the target (for example after a rebuild renamed a variable), and keeps them in the list.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src extension/test extension/CHANGELOG.md
git commit -s -m "Report saved watch entries that stopped resolving, once" -m "The list already survives a restart in workspaceState, but an entry broken by a rebuild stayed silent in the diff output and would otherwise be repeated on every call. One report per symbol until it resolves again keeps the result short."
```

---

### Task B6: Release

**Files:**
- Modify: `docs/ads-mcp-wishlist.md` (section 4 and 8 rows to Done)
- Modify: `extension/CHANGELOG.md` (read through, merge the five lines into one block if the wording overlaps)
- No code.

- [ ] **Step 1: Full test run**

Run: `cd extension && npm test`
Expected: all pass; note the new count for the wishlist.

- [ ] **Step 2: Manual check against a simulation target** (VS Code window with the extension development host, PLC simulation in run mode with a few readable variables, Claude Code connected; use a throwaway project, no machine)

1. `ads_watch { add: ["<var1>", "<var2>"] }` answers with `Added:`, `Watch list: 2 symbols`, `New values arrive every …` and the last line `ADS target: <target>`; `ads_watch {}` shows the full list with `[added by AI]`.
2. `ads_watch { add: ["<var3>", "<var4>"], group: "T1" }`, then `ads_watch { group: "T1", enable: false }`: the ADS Watch view no longer shows var3 and var4, `ads_watch {}` shows them under `Switched off (not sampled)` and `Groups: T1 off (2)`; `ads_scope` has no samples for them. `enable: true` brings them back.
3. Wait hold: switch T1 off, start `ads_wait { symbol: "<var3>", condition: "changes" }`: it must see samples although the group is off; after the wait the entry is parked again.
4. Remove an entry you added in the view, then call `ads_watch { remove: ["<that entry>"] }`: the result says `Not removed (added by the user, only the user can remove them)`. With `force: true` the modal dialog appears once, listing the entries; Cancel leaves it in the list and prints `Not removed (the user did not confirm)`; Remove removes it. Leave the dialog open for 2 minutes in one more call: the call ends with the `did not confirm` text and a later click changes nothing.
5. `ads_watch { clearAi: true }` removes everything the AI added and leaves the user's entries and the view in sync.
6. Persistence and unresolved entries: add `<var1>` (AI), one group `T2` with two symbols (switched off) and a name that does not exist (`MAIN.noSuchVar`). Reload the VS Code window (**Developer: Reload Window**, then a full VS Code restart). Call `ads_watch {}`: the list, the AI markers, the group and the off state are unchanged, and `MAIN.noSuchVar` is listed once under `Not resolved on the target`; a second `ads_watch {}` does not repeat it. Then rename a variable in the PLC source, rebuild and activate the configuration in XAE (restart the runtime), call `ads_watch {}`: the old name is reported once; remove it with `remove`.
7. `ads_write` (with `iecode.ads.aiWrites` set to `confirm`) and `ads_wait` results end with `ADS target: <target>`; the first word of the write result is still `Written.`.

Record the outcome per step in the pull request description.

- [ ] **Step 3: Update the wishlist**

In `docs/ads-mcp-wishlist.md` move the four section-4 rows (diff result, groups, remove user entries / clear AI, persist and report) and the section-8 target row to the `## Implemented` table as Done, with the test file names (`watchList.test.ts`, `watchGroups.test.ts`, `watchRequest.test.ts`, `unresolved.test.ts`, `toolInput.test.ts`, `adsToolText.test.ts`, `writeGate.test.ts`) and the `npm test` count; the "persist" row notes that the list was already stored and this release adds the unresolved report. Leave the per-symbol rate row and the "interval and buffer through MCP" row in section 4 untouched.

- [ ] **Step 4: Commit**

```bash
git add docs/ads-mcp-wishlist.md extension/CHANGELOG.md
git commit -s -m "Mark the watch list wishes as done" -m "Diff results, groups, clean-up, the unresolved report and the target line are built and were checked against a simulation target, including a restart of VS Code."
```

---

## Open decisions

1. **Where the target line goes.** The wishlist says "header". This plan puts `ADS target: <target>` on the **last** line of watch, write and wait results so the verdict words (`Written.`, `Not written:`, `Outcome unknown:`, `Condition met`) stay first for clients, prompts and tests that match on them. Recommendation: last line. Choose header only if you accept changing those first words' position (a one-line change in B5, but it breaks every prefix match).
2. **Forced removal of the user's entries: one modal dialog for MCP and Copilot alike.** Copilot could use its native tool confirmation (`prepareInvocation`), MCP has nothing comparable. Recommendation: the same modal dialog in `adsTools.ts` for both, so behaviour and text are identical; the cost is that Copilot users with "Always Allow" for the tool still see the dialog, which is intended.
3. **Removing a group deletes the AI entries that belong to no other group.** The alternative is to keep them as ungrouped AI entries. Recommendation: delete (the group was the reason they were added; `clearAi` and `remove` exist for the other case).

## Self-review

- **Spec coverage:** wishlist section 4 rows: diff + `list` (B1), groups (B3a-c), AI removes user entries after confirmation and clears AI entries (B2), persist and report unresolved (B4; the storage part already existed, stated at the top); section 8 target row (B5). The other section-4 rows (per-symbol rate, interval and buffer via MCP) are listed as out of scope. Rough-plan review focus 1-5 map to tests: 1 `a group switched off while a wait holds…`; 2 `a symbol in two groups…`; 3 `an unresolved entry is reported once…`; 4 `watch result: the full list replaces the count; an empty call is the list alone` plus `wantsFullList`; 5 `a declined confirmation keeps…`.
- **Type consistency:** `AiEditResult` is created in B1 with six fields; B2 adds `declined` through `WatchRunResult`; B3b adds `grouped`, `ungrouped`, `switchedOn` to `AiEditResult` (B1/B2 test fixtures are updated in B3c: `none` gains the three fields, `wbase` gains `parked`, `unresolved` in B4, `target` in B5). `WatchRequest` grows by `list` (B1), `clearAi`/`force` (B2), `group`/`enable`/`removeGroup` (B3c); `wantsFullList` and the parser rules are extended in the task that adds the field. `WatchListDeps.set` gains the `active` parameter in B3b; `host.setEntries(entries, active?)` matches. `watchResultText` gains `target` (B5), `group`/`parked` (B3c), `unresolved` (B4); each task states its own fixture changes.
- **Ordering risk:** B1-B5 tests build on fixtures (`none`, `wbase`) that later tasks widen; each later task lists the fixture edit. Because B5 runs second, the strings of B1's tests end with `ADS target: local` after B5 (stated in B5).
- **Placeholders:** none; the `<var1>` style names appear only in the manual check as stand-ins for variables of the simulation project, which cannot be named in a public plan.
- **Known limits, accepted:** the parked entries are invisible in the ADS Watch view (only `ads_watch {}` lists them); the stored list (parked included) is not capped, only the sampled list is limited to 200; the confirmation dialog cannot be closed by VS Code when the call times out, it is only ignored.


## Review amendments (2026-11-10)

From the engineering review of this plan. These override the task text above where they differ.

1. **Result shape (B1, B2, B3b).** The three keys B3b adds to `AiEditResult` (`grouped`, `ungrouped`, `switchedOn`) are optional and omitted when no group is involved, so the exact `deepEqual` assertions of B1 and B2 stay valid. `removeGroup` results follow the same rule.
2. **Shared test fake (B2, B3b, B3c).** Move the list fake of `watchList.test.ts` into `extension/test/watchFixtures.ts` (exported `fakeList`) in B2; B3b changes it once (`set(entries, active)`, `groupsOff`, `setGroupsOff`) and lists `watchRequest.test.ts` among its test files.
3. **Stale group keys (B3b).** `save()` prunes `groupsOff` keys that have no member. Tests: a key left after the user's Clear, after a take-over and after a released hold; a new group never reports "it was off".
4. **Limits (B3b).** The 200 limit applies to the active (sampled) list in `host.setEntries`; the stored list (parked included) is capped at 1000 entries with the error `At most 1000 variables can be kept in the watch list.` Test both.
5. **Mid-wait target (B5).** `adsTools.wait` captures `host.target()` before `runWait`. Test: a target change during the wait names the old target. Refusals before any host contact, `Wait cancelled.` and failure texts of a host that did not start get no target line; the text of B5 is corrected to say so.
6. **Confirmation dialog (B2).** Use the gate policy's `dialogMs` (as the write gate does) instead of a fixed 120 s, serialise the dialogs, and re-check `!ai` inside the list step before removing a user entry; tests for a changed entry between confirm and edit and for two parallel `force` calls.
7. **Groups and the host (B3b).** State what happens to `host.setWatched` (dead code: delete it, or adapt it so it keeps `groups`). `ads_scope` and `ads_read` keep answering for parked symbols with `Parked in group <name>` instead of "Not watched". Switching a group off drops the history of its symbols; the result text says so. `removeGroup` of a held entry removes it when the wait ends (set `rec.added`), with a test.
8. **Partial failure (B3c).** `setGroupsOff` is written only after `save()` succeeded. If `enable: true` fails on the limit after an add, the result still shows the diff of the add. Parser rules: `removeGroup` with `clearAi` and `group` with `list: true` are errors.
9. **B4.** Report only errors that mean "not found", not transient ones (no connection, timeout); a transient error does not mark the symbol as reported.
10. **B1.** `lmTools.ts` now validates the watch input (`Invalid arguments: ...`); this is an intended change and goes into the master list and the CHANGELOG. B3a: `watchRename` already drops groups (`adswatch.ts:393`); only `watchEdit` changes.


## Review amendments, round 2 (2026-11-10)

From the second, independent review. These override round 1 and the task text.

1. **One state commit (B3b, replaces round 1 item 3 in part).** `save(next, off)` takes the next entries and the next switched-off group names as arguments and computes the active list from them. `host.setEntries(entries, active, off)` persists entries and `off` in one `workspaceState` update before it contacts the host; the persisted state is the intended state, and `afterHello` resyncs the host after a failed host call. No separate `setGroupsOff` after `save`. Tests: failure before the save, after the save, at the host call.
2. **Group and enable are one transition (B3b, B3c).** `add` with `group` and `enable` computes the final state once and validates only that (200 active limit on the final active list). `add` with `enable: false` parks without ever sampling; a bare `enable` does not run an add step. Tests: 200 active plus one parked entry; large switched-off group; repeated switch-off; a concurrent wait.
3. **Cancel protection (B2).** The signal and the deadline are checked inside the serialised list step right before the mutation; an abort during the dialog aborts the whole call before any change (no AI entries removed either). One confirmation coordinator per window, injected through the host and shared by MCP and Copilot, with the gate's `dialogMs`, `operationMs` and `maxQueued`. Tests: abort before the call, during the dialog, after consent before the edit, late consent after a timeout, MCP and Copilot in parallel; a user entry removed and re-added under the same name needs a new consent.
4. **Green after every task (B3b, B4).** B3b migrates every `WatchList` construction in the tests, including the failure fakes (`watchList.test.ts` lines 94-110). B4 uses real not-found fixtures and separate transient fixtures; the exclude test marks a real missing symbol. The history note of round 1 item 7 goes into the exact B3c expectations.
5. **Hold release (B3b).** `release` computes the active list from the tokens that remain after the release; the old whole-list check `watchLimitError(next.length)` in `hold` is replaced by the active-list check. Tests: wait on a parked symbol ends and the symbol stops being sampled; more than 200 stored but fewer active entries.
6. **Result text and history (B3b, B3c).** `switched off (N symbols, not sampled now)` counts only symbols that really leave the active set (another group or a hold keeps a symbol active). History is dropped by set difference as `ScopeBuffer.setItems` does. `rec.added` is set only for entries orphaned by the removal, not for an entry still in another group.
7. **Unresolved notes (B4).** State is observed at confirmed item updates; fetching pending notes is separate. Parked or unknown state never counts as removed. The classification matches the real CLI text (`Symbol '<x>' not found on ...` plus the hidden hint), tested with that text.
8. **Group limits (B3a, B3b).** At most 8 groups per entry, 50 groups in total, names up to 64 characters, checked before the mutation; entries without groups stay unchanged.
9. **B1 overlap.** `add` and `remove` naming the same symbol in one call is an error: `A is in both add and remove`. Test with a new and an existing symbol, case-insensitive.
10. **Target line and text limit (B5).** Reserve space for the target line and status lines and cut only the list part; a note counts as delivered only when it is in the final text. Tests on the real tool result.
11. **Parked reads (round 1 item 7, corrected).** `ads_read` still reads a parked symbol once and adds `(parked in group X, not sampled)`; `ads_scope` says there is no running history for it. No change to the one-shot read. The manifest text and the intended-change table say so.
12. **Persisted groups (B3a).** `parseWatchList` drops `groups` for `ai: false`, trims, de-duplicates case-insensitively and drops invalid names. Tests: user entry with groups, duplicate spellings.
13. **B6 step 2.4:** `Add an entry in the view, then try to remove it through the tool`; the dialog wait comes from the policy in use.
