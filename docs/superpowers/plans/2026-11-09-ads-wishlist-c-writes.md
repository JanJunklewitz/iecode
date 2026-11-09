# Plan C: Writes, Journal, Restore and Write Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [master plan](2026-11-09-ads-wishlist-master-plan.md); task C0 is the prerequisite of every CLI-touching task in all plans.

**Goal:** An agent sets several values in one confirmed call, can pulse a command bit, sees why a bit reads back differently, can undo a test session's writes, and cannot write outside an allowed area or to persistent data by accident.

**Architecture:** The write gate stays the one path of every AI write (`extension/src/core/writeGate.ts`). All decisions are pure modules in `extension/src/core/` (the node tests cannot load `vscode`): `hostProtocol.ts` (version table, new), `writeText.ts` (item types, texts, read-back rule, confirmation text, new), `writeExec.ts` (one write call: single, batch, pulse, journal; new), `writeJournal.ts` (new), `writePolicy.ts` (new). `src/ads/host.ts`, `adsWrite.ts`, `adsTools.ts`, `lmTools.ts` and `mcpTools.ts` only wire them. The CLI watch host gets one new op, `writeMany` (one ADS sum write plus one sum read-back), gated by protocol version 2.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads` 7.0.389.

**Spec:** [wishlist sections 5 and 8](../../ads-mcp-wishlist.md); roadmap [2026-11-06-ads-mcp-wishlist.md](2026-11-06-ads-mcp-wishlist.md) Phase 4 and decisions D9, D10, D14, D21, D23; master-plan user decisions 1 and 2 (2026-11-09); style reference [2026-11-06-ads-wait.md](2026-11-06-ads-wait.md).

## Global Constraints

- Public repository: no internal project, module, machine or symbol names or data in code, tests, docs or commits; examples use generic names (`MAIN.nCount`, `MAIN.bStart`, `GVL.Test`). Commit author and `Signed-off-by` use the GitHub noreply address; `git commit -s`; English subject plus a 1-3 sentence why-body.
- "Sent in one ADS request" is the promise; never "same cycle" (user decision 1; the same-cycle write is in `TODO.md`).
- The sum write uses no fallback to single writes (D10). The conservative outcome is `unknown`: "Not written" only with proof from the host (D21). Per-item `notWritten` only for codes that C1 proves to be device rejections without effect.
- Old calls stay byte-identical: `ads_write { symbol, value }` keeps its result texts, `WriteOp` keeps its fields (`symbol`, `value`, `targetKey`, `via`, `prepared`), `ads_scope`, `ads_read`, `ads_watch`, `ads_wait` are untouched. The only intended changes of existing output are named in C5 (BOOL read-back wording) and C3c (a single write now reads the old value first, invisible in the text).
- Every tool is declared once in `extension/package.json` and served by both `buildMcpTools` and `lmTools.ts`; new parameters are optional. No new tool is added in this plan, only parameters of `ads_write`.
- Protocol: one immutable entry per protocol number in the table in `extension/src/core/hostProtocol.ts`; replies change additively; the extension accepts hosts from protocol 1 up to its own and switches off only the missing features; a newer host is refused with "Update the extension" (roadmap D14, D23). One bump per release: this plan adds protocol 2.
- Tests: `cd extension && npm test` (runs `tsc -p .` first). C# tests only through the **PowerShell** tool: `dotnet test cli/tests/IECode.Core.Tests` and `dotnet test cli/tests/IECode.Automation.Tests`. Never chain `dotnet build` and `dotnet test` in one command, never run them in parallel with each other or with `npm test` or any other heavy process (memory crash on this machine).
- Pure decisions live in `extension/src/core/`; nothing in `src/ads/` is unit-tested, so every rule that can be wrong goes into a core module first.
- Statements that depend on the SDK spike C1 are marked `[C1]`. Do not build a `[C1]` statement before C1's findings are recorded; the list is under "C1 findings" at the end of this file.

## Review Focus

1. One bad value in a batch: nothing is sent, the reason names the item (`writes[1] MAIN.nCount: ...`). (C2, C3b)
2. A timeout after sending: every item is `unknown`, none `written`; the text tells the agent not to write again. (C2, C3b, C3c)
3. A read-back failure after a successful write keeps the item `written`. (C2, C3b)
4. A pulse whose reset write fails: the result says the bit may still be set and names the symbol; a cancel or a settings change during the pulse never skips the reset. (C4)
5. Restore after the PLC restarted or a rebuild renamed a symbol: values that cannot be written back are listed with a reason, not skipped silently, and one stale symbol does not block the others. (C6b)
6. A write outside the allowed paths never reaches the dialog, also not in Copilot's confirmation, and not inside a batch (the whole batch is refused and every offending symbol is named). (C7a)
7. An older CLI (protocol 1) keeps every scalar tool working; only the batch form reports "needs a newer iecode CLI: batch write", and it does so before the dialog opens. (C0, C3c)

## File Structure

- Create `extension/src/core/hostProtocol.ts`: version table, `negotiate`, `HostCaps`, missing-feature text.
- Create `extension/src/core/writeText.ts`: `WriteItem`, `WriteItemResult`, `readBackChanged`, batch texts, `confirmMessage`.
- Create `extension/src/core/writeExec.ts`: `executeWrite` (single, batch, pulse, journal).
- Create `extension/src/core/writeJournal.ts`, `extension/src/core/writePolicy.ts`.
- Modify `extension/src/core/writeGate.ts` (`WriteOp.items`, `WriteResult` kind `done`, `GateDeps.policy`, `writeResultText`), `adswatch.ts` (`PROTOCOL` re-export, `HostError` mapping of `writeMany`), `toolInput.ts` (`parseWriteInput`, `writeKey`), `mcpTools.ts`, `adsToolText.ts` (no change expected; `writeResultText` lives in `writeGate.ts`, not here).
- Modify `extension/src/ads/host.ts` (hello check, caps, `writeMany`, `requires`), `adsWrite.ts`, `adsTools.ts` (`journal`, `restorePlan`, `persistentOf`, `requires`), `lmTools.ts`, `aiSettings.ts`; `extension/package.json`, `extension/CHANGELOG.md`, `cli/README.md`, `docs/ads-mcp-wishlist.md`.
- CLI: `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`, `AdsLink.cs`.
- Tests: `extension/test/hostProtocol.test.ts`, `writeText.test.ts`, `writeExec.test.ts`, `writeJournal.test.ts`, `writePolicy.test.ts` (new); `writeGate.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`, `adswatch.test.ts` (extended); `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `FakeLink.cs`.

## Order

C0 -> C5 -> C3a -> C3b -> C7a (all extension only, release train T1 possible) -> C1 -> C2 -> C3c -> C4 -> C6a -> C6b -> C7b -> C8. C1 needs only a simulation target and can run while the extension-only tasks are built. C3c is the first task that needs C2's host op; C4 with a single item works on protocol 1.

---

### Task C0: Protocol version table (prerequisite for every CLI task of every plan)

**Why first:** today `host.ts:365` refuses any host whose protocol differs from the extension's, so the first CLI release that bumps the protocol would switch off every ADS tool for users whose CLI is older than their extension (the CLI is installed separately, `extension/src/cli/iecode.ts`). C0 replaces the equality check by the rules of roadmap D14/D23 and adds no protocol change itself (the table has one entry; `WatchHost.Protocol` stays 1).

**Files:**
- Create: `extension/src/core/hostProtocol.ts`
- Test: `extension/test/hostProtocol.test.ts`
- Modify: `extension/src/core/adswatch.ts` (line 4: `PROTOCOL` becomes a re-export), `extension/src/ads/host.ts` (hello check in `start()`, caps lifecycle, `requires`, `knownMissing`), `cli/README.md` ("Live values": protocol table)

**Interfaces:**
- Consumes: nothing (the module has no imports, so `adswatch.ts` can re-export from it without a cycle).
- Produces:
  ```ts
  export interface ProtocolEntry { readonly ops: readonly string[]; readonly features: readonly string[] }
  export type ProtocolTable = Readonly<Record<number, ProtocolEntry>>;
  /** Immutable (deep-frozen). Entry N is complete: it lists everything protocol N offers, not only the change. */
  export const PROTOCOL_TABLE: ProtocolTable;
  /** The highest key of PROTOCOL_TABLE: what this extension speaks. */
  export const PROTOCOL: number;
  /** Words for a feature in user-facing texts; a feature without a label is printed by its id. */
  export const FEATURE_LABELS: Readonly<Record<string, string>>;
  export class HostCaps {
    constructor(readonly protocol: number, private readonly table?: ProtocolTable);
    supportsOp(op: string): boolean;
    supports(feature: string): boolean;
    /** undefined when supported, else the text of featureMissingText. */
    missing(feature: string): string | undefined;
  }
  export type Negotiation = { ok: true; caps: HostCaps } | { ok: false; error: string; action?: 'install' };
  export function negotiate(hostProtocol: unknown, table?: ProtocolTable): Negotiation;
  export function featureMissingText(feature: string, installedProtocol: number, table?: ProtocolTable): string;
  /** Violations of the table rules (numbering gaps, an entry that drops something the previous one had, an empty entry); [] = fine. */
  export function tableProblems(table: ProtocolTable): string[];
  ```
- Rules (the compatibility contract, D14/D23):
  1. `negotiate(p)` accepts an integer `p` with `1 <= p <= own` that has an entry; `own` = highest key. Capabilities are exactly the entry of `p`.
  2. `p > own`: refused with `The iecode CLI speaks ADS host protocol <p>, newer than this extension (<own>). Update the extension.` and no `action` (the "Install CLI" button would not help).
  3. `p` not an integer, `< 1`, or without an entry: refused with `The iecode CLI sent an unknown ADS host protocol version (<JSON of p>). Update the iecode CLI with "IECode: Install CLI…".` and `action: 'install'`.
  4. Missing feature text: `this needs a newer iecode CLI: <label> (installed: ADS host protocol <p>, needed: <since>). Update it with "IECode: Install CLI…"` where `<since>` is the lowest protocol whose entry lists the feature; a feature no entry lists gives `this needs a newer iecode CLI: <label>. Update it with "IECode: Install CLI…"`. Lower case start and no final period, so it reads after `Not written: ` and `sentence()` adds the period.
  5. Entries are additive: every op and feature of entry N-1 is in entry N. Entries of released protocols never change; a protocol that is not released yet may still grow until its release task freezes it with a pin test (C8 does this for 2).
  6. Capabilities belong to one host process: `host.ts` clears them on every start, stop, exit and restart, so a restarted host never inherits the capabilities of its predecessor.
- Entry 1 (the pin): `{ ops: ['watch', 'read', 'write', 'interval'], features: [] }`. Scalar read, write, watch and `ads_wait` need nothing beyond these ops.

- [ ] **Step 1: Write the failing tests** (`extension/test/hostProtocol.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, PROTOCOL_TABLE, ProtocolTable, negotiate, featureMissingText, tableProblems } from '../src/core/hostProtocol';

const BASE = ['watch', 'read', 'write', 'interval'];
// a synthetic table proves the rules without depending on what the real table offers today
const T2: ProtocolTable = {
  1: { ops: BASE, features: [] },
  2: { ops: [...BASE, 'futureOp'], features: ['futureThing'] },
};

test('the real table is well formed, deep-frozen and PROTOCOL is its highest entry', () => {
  assert.deepEqual(tableProblems(PROTOCOL_TABLE), []);
  assert.equal(PROTOCOL, Math.max(...Object.keys(PROTOCOL_TABLE).map(Number)));
  assert.ok(Object.isFrozen(PROTOCOL_TABLE) && Object.isFrozen(PROTOCOL_TABLE[1]) && Object.isFrozen(PROTOCOL_TABLE[1].ops));
});

test('entry 1 is pinned: a released protocol never changes', () => {
  assert.deepEqual(PROTOCOL_TABLE[1], { ops: ['watch', 'read', 'write', 'interval'], features: [] });
});

test('tableProblems finds gaps, dropped features and empty entries', () => {
  assert.match(tableProblems({ 1: { ops: BASE, features: [] }, 3: { ops: BASE, features: [] } })[0], /gap/);
  assert.match(tableProblems({ 1: { ops: BASE, features: ['a'] }, 2: { ops: BASE, features: [] } })[0], /protocol 2 drops "a"/);
  assert.match(tableProblems({ 1: { ops: [], features: [] } })[0], /protocol 1 has no ops/);
});

test('a protocol-1 host serves scalar read, write, watch and wait', () => {
  const n = negotiate(1, T2);
  assert.ok(n.ok);
  if (!n.ok) return;
  // ads_wait needs no op beyond watch; the scalar write is op "write"
  for (const op of ['watch', 'read', 'write', 'interval']) assert.equal(n.caps.supportsOp(op), true, op);
  assert.equal(n.caps.supportsOp('futureOp'), false);
});

test('a feature the old host lacks reports "needs a newer iecode CLI"', () => {
  const n = negotiate(1, T2);
  assert.ok(n.ok);
  if (!n.ok) return;
  assert.equal(n.caps.supports('futureThing'), false);
  assert.equal(n.caps.missing('futureThing'),
    'this needs a newer iecode CLI: futureThing (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…"');
  assert.equal(featureMissingText('nobodyOffersThis', 1, T2), 'this needs a newer iecode CLI: nobodyOffersThis. Update it with "IECode: Install CLI…"');
});

test('the current host works with every feature', () => {
  const n = negotiate(2, T2);
  assert.ok(n.ok);
  if (!n.ok) return;
  assert.equal(n.caps.supports('futureThing'), true);
  assert.equal(n.caps.supportsOp('futureOp'), true);
  assert.equal(n.caps.missing('futureThing'), undefined);
});

test('a newer host is refused with "update the extension" and no install action', () => {
  assert.deepEqual(negotiate(3, T2), { ok: false, error: 'The iecode CLI speaks ADS host protocol 3, newer than this extension (2). Update the extension.' });
});

test('a host with an unreadable or unknown protocol is refused with the install action', () => {
  for (const p of [0, -1, 1.5, '2', null, undefined, NaN]) {
    const n = negotiate(p, T2);
    assert.equal(n.ok, false, String(p));
    if (!n.ok) { assert.match(n.error, /^The iecode CLI sent an unknown ADS host protocol version \(/); assert.equal(n.action, 'install'); }
  }
  const gap = negotiate(2, { 1: { ops: BASE, features: [] }, 3: { ops: BASE, features: [] } });
  assert.equal(gap.ok, false);
});

test('an unknown feature name is never supported', () => {
  const n = negotiate(2, T2);
  assert.ok(n.ok);
  if (n.ok) assert.equal(n.caps.supports('typo'), false);
});

test('the real table accepts its own protocol and refuses the next one', () => {
  assert.equal(negotiate(PROTOCOL).ok, true);
  assert.equal(negotiate(1).ok, true);
  assert.equal(negotiate(PROTOCOL + 1).ok, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npm test`
Expected: compile error `Cannot find module '../src/core/hostProtocol'`.

- [ ] **Step 3: Implement `hostProtocol.ts`** with the interfaces and rules above. `PROTOCOL_TABLE` is built through a `deepFreeze` helper; `PROTOCOL` is computed from the keys; `FEATURE_LABELS` is `{}` for now (C2 adds `writeMany: 'batch write'`). Replace `export const PROTOCOL = 1;` in `adswatch.ts` by `export { PROTOCOL } from './hostProtocol';` (keep the name exported: `host.ts` and `adswatch.test.ts` import it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npm test`
Expected: all pass, including the 10 new ones; `adswatch.test.ts` `assert.equal(PROTOCOL, 1)` still holds.

- [ ] **Step 5: Wire it into `host.ts`** (not unit-testable; reviewed by reading and by the manual check in C8)
  - Field `private caps: HostCaps | undefined;`. In `start()` next to `this.gen = -1;` set `this.caps = undefined;`. In `exited()` and `stop()` set `this.caps = undefined;`.
  - Hello branch (today `if (msg.protocol !== PROTOCOL) { fail(new StartError(...)); child.kill(); return; }`): `const n = negotiate(msg.protocol); if (!n.ok) { fail(new StartError(n.error, n.action)); child.kill(); return; } if (this.proc === child) this.caps = n.caps;` before `hello = true; resolve();`.
  - New public methods:
    ```ts
    /** Capabilities of the running host; undefined while no host runs. */
    hostCaps(): HostCaps | undefined;
    /** Starts the host if needed; the "needs a newer iecode CLI" text when the feature is missing, the start failure's text when it cannot start, else undefined. */
    requires(feature: string): Promise<string | undefined>;
    /** Synchronous: the missing-feature text if the running host is known to lack the feature (Copilot's prepare step cannot await). */
    knownMissing(feature: string): string | undefined;
    ```
    `requires` calls `ensure(true)` in a `try` and returns `(e as Error).message` on failure.
  - `import { HostCaps, negotiate } from '../core/hostProtocol';` and drop `PROTOCOL` from the `adswatch` import in `host.ts` if it is unused afterwards.

- [ ] **Step 6: Document the table in `cli/README.md`** under "Live values": a table "Protocol versions" with one row, `1 | watch, read, write, interval | first release`, and the sentence "A client accepts every protocol from 1 up to its own and switches off only the features an older host lacks; a host newer than the client is refused."

- [ ] **Step 7: Run `cd extension && npm test` again** (compile of `host.ts`). Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add extension/src/core/hostProtocol.ts extension/test/hostProtocol.test.ts extension/src/core/adswatch.ts extension/src/ads/host.ts cli/README.md
git commit -s -m "Accept older iecode CLI hosts and gate features by protocol version" -m "The strict protocol equality check would switch off every ADS tool after a CLI release for users whose CLI is older than the extension. One immutable table now says what each protocol offers, so only the newer features report a missing CLI; a host newer than the extension is still refused."
```

---

### Task C5: Read-back wording (BOOL)

**Why:** both "the PLC reset the bit" and "the write was rejected" read as `reads back as FALSE (the PLC may change it again)` today. ADS reports an error code for a rejection (the result is then `Not written` or `Outcome unknown`), so a successful write whose read-back differs from the request means the PLC changed the value.

**Files:**
- Create: `extension/src/core/writeText.ts` (starts here with `sentence` and `readBackChanged`; C3a/C3b/C4 extend it)
- Test: `extension/test/writeText.test.ts`, `extension/test/writeGate.test.ts`
- Modify: `extension/src/core/writeGate.ts` (`writeResultText`; the local `sentence` const at line 81 moves to `writeText.ts`)

**Interfaces:**
- Produces: `export const sentence: (s: string) => string;` (strips one trailing dot) and `export function readBackChanged(requested: string, readBack: string): boolean;`. `readBackChanged` is true only when both texts are BOOL literals (`TRUE`, `FALSE`, `1`, `0`, any case, trimmed) with different truth values; everything else is false (integers, REAL, enums, strings stay as today: the existing tests `writeGate.test.ts:425` and `mcpTools.test.ts:120` write `1`/`5` with a different read-back and must stay green unchanged).
- Text when `readBackChanged`: `Written (accepted by ADS), but <symbol> then reads back as <readBack>, not <requested>: the PLC changed it after the write. Read it again before acting on it.` Otherwise `writeResultText` is byte-identical to today.

- [ ] **Step 1: Write the failing tests**

```ts
// writeText.test.ts
test('readBackChanged compares BOOL literals only', () => {
  assert.equal(readBackChanged('TRUE', 'FALSE'), true);
  assert.equal(readBackChanged('1', 'FALSE'), true);
  assert.equal(readBackChanged(' false ', 'TRUE'), true);
  assert.equal(readBackChanged('TRUE', '1'), false);
  assert.equal(readBackChanged('1', '5'), false);      // not BOOL: unchanged behaviour
  assert.equal(readBackChanged('3.5', '3.0'), false);
  assert.equal(readBackChanged('abc', 'abd'), false);
});
// writeGate.test.ts
test('writeResultText tells a bit the PLC reset from a plain read-back', () => {
  const o = op('MAIN.bStart', { value: 'TRUE' });
  assert.equal(writeResultText({ kind: 'written', readBack: 'FALSE' }, o),
    'Written (accepted by ADS), but MAIN.bStart then reads back as FALSE, not TRUE: the PLC changed it after the write. Read it again before acting on it.');
  assert.equal(writeResultText({ kind: 'written', readBack: 'TRUE' }, o), 'Written. MAIN.bStart reads back as TRUE (the PLC may change it again).');
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile error for `writeText`, then (after a stub) the assertion fails.
- [ ] **Step 3: Implement** `writeText.ts`; in `writeGate.ts` import `sentence` and `readBackChanged` and branch in the `written` case when `r.readBack !== null && readBackChanged(op.value, r.readBack)`.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass, the old `writeResultText for all kinds` test unchanged.
- [ ] **Step 5: CHANGELOG** (under `## Unreleased` / `### Claude Code and ADS`, after the `ads_scope` line): `- `ads_write` tells a bit the PLC reset from a plain read-back: when a BOOL reads back as the opposite of what was written, the result says "accepted by ADS" and that the PLC changed it after the write.`
- [ ] **Step 6: Commit**

```bash
git add extension/src/core/writeText.ts extension/test/writeText.test.ts extension/src/core/writeGate.ts extension/test/writeGate.test.ts extension/CHANGELOG.md
git commit -s -m "Say when the PLC changed a bit right after an accepted write" -m "A rejected write and a bit that the PLC resets right away both read back FALSE, so an agent could not tell them apart. A rejection always comes with an error code, so a BOOL that differs after a successful write is the PLC's doing; other types keep the old text."
```

---

### Task C3a: Batch input and model (pure)

**Files:**
- Modify: `extension/src/core/toolInput.ts` (`parseWriteInput`, new `MAX_WRITES`), `extension/src/core/writeGate.ts` (`WriteOp.items`, `itemsOf`, `featureOf`, `WriteResult` kind `done`), `extension/src/core/writeText.ts` (item types)
- Test: `extension/test/toolInput.test.ts`, `extension/test/writeGate.test.ts`

**Interfaces:**
- Produces in `writeText.ts`:
  ```ts
  export interface WriteItem { symbol: string; value: string }   // C4 adds pulseMs?: number
  export type WriteItemResult =
    | { symbol: string; status: 'written'; readBack: string | null; readBackError?: string }
    | { symbol: string; status: 'notWritten'; reason: string }
    | { symbol: string; status: 'unknown'; reason: string };
  ```
- Produces in `toolInput.ts`:
  ```ts
  export const MAX_WRITES = 20;
  export type WriteInput = { symbol: string; value: string } | { writes: WriteItem[] };
  export function parseWriteInput(raw: unknown): Parsed<WriteInput>;
  ```
  A call with `writes` returns `{ writes }` only (no `symbol`/`value` keys); a call without `writes` returns exactly `{ symbol, value }` as today.
- Produces in `writeGate.ts`:
  ```ts
  export interface WriteOp { /* unchanged fields */ items?: WriteItem[] }   // batch: all items in order; symbol/value mirror items[0]
  export const itemsOf = (op: WriteOp): WriteItem[] => op.items ?? [{ symbol: op.symbol, value: op.value }];
  /** The protocol feature an op needs beyond scalar write: more than one item needs "writeMany". */
  export const featureOf = (op: WriteOp): string | undefined => itemsOf(op).length > 1 ? 'writeMany' : undefined;
  export type WriteResult = /* existing three kinds */ | { kind: 'done'; items: WriteItemResult[] };
  ```
- Parse rules and exact error texts: both forms (`writes` together with `symbol` or `value`): `use either symbol and value or writes, not both`; `writes` not an array: `writes must be an array of { symbol, value } objects`; an element not an object: same text; empty: `writes must not be empty`; more than 20: `writes has more than 20 entries`; per item `writes[1].symbol must be a string`, `writes[1].value must be a string`, `writes[0].symbol must not be blank`, length limits as the single form with the `writes[i].` prefix; duplicates (trimmed, case-insensitive): `writes[2] repeats writes[0]: MAIN.a`. `value` may be the empty string (STRING variables), as today.

- [ ] **Step 1: Write the failing tests** (`toolInput.test.ts`)

```ts
test('parseWriteInput keeps the single form exactly and accepts a batch', () => {
  assert.deepEqual(parseWriteInput({ symbol: 'MAIN.x', value: '1' }), { ok: true, value: { symbol: 'MAIN.x', value: '1' } });
  assert.deepEqual(parseWriteInput({ writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '' }] }),
    { ok: true, value: { writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '' }] } });
});
test('parseWriteInput refuses a bad batch before any dialog, with the item named', () => {
  const err = (raw: unknown) => { const p = parseWriteInput(raw); assert.equal(p.ok, false); return p.ok ? '' : p.error; };
  assert.equal(err({ symbol: 'a', value: '1', writes: [{ symbol: 'b', value: '2' }] }), 'use either symbol and value or writes, not both');
  assert.equal(err({ writes: 'x' }), 'writes must be an array of { symbol, value } objects');
  assert.equal(err({ writes: [] }), 'writes must not be empty');
  assert.equal(err({ writes: Array.from({ length: 21 }, (_, i) => ({ symbol: `S${i}`, value: '1' })) }), 'writes has more than 20 entries');
  assert.equal(err({ writes: [{ symbol: 'a', value: '1' }, { symbol: 'b' }] }), 'writes[1].value must be a string');
  assert.equal(err({ writes: [{ symbol: ' ', value: '1' }] }), 'writes[0].symbol must not be blank');
  assert.equal(err({ writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'B', value: '1' }, { symbol: ' main.A ', value: '2' }] }), 'writes[2] repeats writes[0]: MAIN.a');
  assert.equal(parseWriteInput({ writes: Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, value: '1' })) }).ok, true);
});
```
`writeGate.test.ts`:
```ts
test('itemsOf and featureOf', () => {
  assert.deepEqual(itemsOf(op('MAIN.x')), [{ symbol: 'MAIN.x', value: '1' }]);
  assert.equal(featureOf(op('MAIN.x')), undefined);
  const b = op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }] });
  assert.equal(itemsOf(b).length, 2);
  assert.equal(featureOf(b), 'writeMany');
  assert.equal(featureOf(op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }] })), undefined);
});
test('a batch op goes through the gate like a single write: one dialog, one send', async () => {
  const r = rig();                                  // the existing helper; decision 'confirm'
  const b = op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }] });
  const p = r.gate.run(b, new AbortController().signal);
  await tick(); r.confirms[0].answer.resolve(true);
  await p;
  assert.equal(r.confirms.length, 1);
  assert.equal(r.sent.length, 1);
});
```
Adapt `rig()`/`tick` names to the helpers that exist in `writeGate.test.ts` (lines 29-72).

- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors (`itemsOf`, `featureOf`, `items`).
- [ ] **Step 3: Implement** the types, `parseWriteInput` (reuse `str`, `asObject`; item objects parsed by one small helper that prefixes errors with `writes[i].`) and the gate additions. The gate itself needs no logic change: it treats the op as one operation.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass; existing `toolInput` and gate tests unchanged.
- [ ] **Step 5: Commit**

```bash
git add extension/src/core/toolInput.ts extension/src/core/writeGate.ts extension/src/core/writeText.ts extension/test/toolInput.test.ts extension/test/writeGate.test.ts
git commit -s -m "Model a batch write and parse it before any dialog" -m "A batch needs one confirmation and one result with an entry per item, so the op and the result get a list form while the single form stays byte-identical. Duplicates, an empty list and both forms at once are refused at parse time, before anything can open a dialog."
```

---

### Task C3b: Batch texts, confirmation text and Copilot key (pure)

**Files:**
- Modify: `extension/src/core/writeText.ts`, `extension/src/core/writeGate.ts` (`writeResultText`, `writeResultIsError`), `extension/src/core/toolInput.ts` (`writeKey`)
- Test: `extension/test/writeText.test.ts`, `extension/test/writeGate.test.ts`, `extension/test/toolInput.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The dialog text; one item: "Write S := V on <where>?<note>", several: header, then one line per item. */
  export function confirmMessage(items: readonly WriteItem[], where: string, note: string): string;
  /** Batch lines for a `done` result; `items` are the requested items (same order as `results`). */
  export function doneText(items: readonly WriteItem[], results: readonly WriteItemResult[]): string;
  export function doneIsError(results: readonly WriteItemResult[]): boolean;   // any item not 'written'
  // toolInput.ts
  export function writeKey(input: WriteInput): string;   // single: JSON.stringify([symbol, value]) as today; batch: JSON.stringify(['batch', [[symbol, value], ...]])
  ```
  `confirmMessage` passes every symbol and value through `oneLine` (from `adswatch.ts`), as `adsWrite.ts`' `show` does today.
- Exact texts (pin them):
  - `confirmMessage([{MAIN.x,1}], 'A:851 (ws)', '')` = `Write MAIN.x := 1 on A:851 (ws)?` (byte-identical to today's MCP dialog and, with `where = host.target()`, to Copilot's).
  - Batch: `Write 2 values on A:851 (ws)?\nMAIN.a := 1\nMAIN.b := 2`; with a note: `Write 2 values on A:851 (ws)? (the workspace settings set the ADS target or port, so auto-approve does not apply)\nMAIN.a := 1\nMAIN.b := 2`.
  - `writeResultText` for a batch op (`op.items` with more than one item), kind `refused`: `Not written: <reason>. None of the 3 writes was sent.`; kind `unknown`: `Outcome unknown for all 3 writes: <reason>. Do not write again on your own; read MAIN.a, MAIN.b, MAIN.c and ask the user.`; a single op keeps today's texts.
  - `done` result, more than one item, header `Sent in one ADS request (3 writes): 1 written, 1 not written, 1 outcome unknown.` (parts with a zero count are left out), then one line per item:
    - `MAIN.a: written, reads back as 5 (the PLC may change it again)`; with C5's rule a BOOL that differs: `MAIN.a: written (accepted by ADS), but then reads back as FALSE, not TRUE: the PLC changed it after the write`
    - `MAIN.b: written, but it could not be read back: link down`
    - `MAIN.c: not written: <reason>`
    - `MAIN.d: outcome unknown: <reason>`
    - trailer lines, only when they apply: `Read the items without a read-back before acting on their values.` and `Do not write the unknown items again on your own; read them and ask the user.`
  - `done` with exactly one item (a pulse or a one-item restore, C4/C6b): header `Write sent: 1 written.` or `Write sent: 1 not written.` or `Write sent: outcome unknown.`, same item line.
  - `writeResultIsError`: `done` is an error when `doneIsError` (any item not `written`).

- [ ] **Step 1: Write the failing tests** (pin every text above):

```ts
test('confirmMessage: one item is byte-identical to the old dialog, several list every write', () => {
  assert.equal(confirmMessage([{ symbol: 'MAIN.x', value: '1' }], 'A:851 (ws)', ''), 'Write MAIN.x := 1 on A:851 (ws)?');
  assert.equal(confirmMessage([{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }], 'A:851 (ws)', ''),
    'Write 2 values on A:851 (ws)?\nMAIN.a := 1\nMAIN.b := 2');
  assert.equal(confirmMessage([{ symbol: 'MAIN.a', value: '1\nevil' }], 'T', ''), 'Write MAIN.a := 1 evil on T?');   // oneLine
});
test('writeResultText for a batch: refused, unknown and done', () => {
  const o = op('MAIN.a', { items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }, { symbol: 'MAIN.c', value: '3' }] });
  assert.equal(writeResultText({ kind: 'refused', reason: "writes[1] MAIN.b: 'zz' is not a valid INT" }, o),
    "Not written: writes[1] MAIN.b: 'zz' is not a valid INT. None of the 3 writes was sent.");
  assert.equal(writeResultText({ kind: 'unknown', reason: 'no reply' }, o),
    'Outcome unknown for all 3 writes: no reply. Do not write again on your own; read MAIN.a, MAIN.b, MAIN.c and ask the user.');
  const done = writeResultText({ kind: 'done', items: [
    { symbol: 'MAIN.a', status: 'written', readBack: '1' },
    { symbol: 'MAIN.b', status: 'notWritten', reason: 'ADS error 0x6 (symbol not found)' },
    { symbol: 'MAIN.c', status: 'unknown', reason: 'ADS error 0x7' }] }, o);
  assert.equal(done, [
    'Sent in one ADS request (3 writes): 1 written, 1 not written, 1 outcome unknown.',
    'MAIN.a: written, reads back as 1 (the PLC may change it again)',
    'MAIN.b: not written: ADS error 0x6 (symbol not found)',
    'MAIN.c: outcome unknown: ADS error 0x7',
    'Do not write the unknown items again on your own; read them and ask the user.'].join('\n'));
});
test('a read-back failure keeps the item written and adds the trailer', () => { /* MAIN.b: written, but it could not be read back: link down + "Read the items without a read-back before acting on their values." */ });
test('writeResultIsError is true when any batch item is not written', () => { /* all written -> false; one unknown -> true; one notWritten -> true */ });
test('writeKey keys the whole batch and keeps the single key', () => {
  assert.equal(writeKey({ symbol: 'MAIN.x', value: '1' }), JSON.stringify(['MAIN.x', '1']));
  assert.notEqual(writeKey({ writes: [{ symbol: 'A', value: '1' }, { symbol: 'B', value: '2' }] }), writeKey({ writes: [{ symbol: 'A', value: '1' }, { symbol: 'B', value: '3' }] }));
  assert.notEqual(writeKey({ writes: [{ symbol: 'A', value: '1' }] }), writeKey({ symbol: 'A', value: '1' }));
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors, then assertion failures.
- [ ] **Step 3: Implement.** `writeResultText` branches on `op.items && op.items.length > 1` for `refused`/`unknown`, and on `done` for the item lines; the single-item texts stay in the existing switch. Item lines reuse C5's `readBackChanged`.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: Commit**

```bash
git add extension/src/core/writeText.ts extension/src/core/writeGate.ts extension/src/core/toolInput.ts extension/test/writeText.test.ts extension/test/writeGate.test.ts extension/test/toolInput.test.ts
git commit -s -m "Add the texts of a batch write: dialog, result and Copilot key" -m "The dialog and the result must name every item so a user confirms what is sent and an agent sees what landed. The single-write dialog and result stay byte-identical; the texts say one ADS request and never promise the same cycle."
```

---

### Task C7a: Allow-list of path prefixes for AI writes

**Files:**
- Create: `extension/src/core/writePolicy.ts`; Test: `extension/test/writePolicy.test.ts`
- Modify: `extension/src/core/writeGate.ts` (`GateDeps.policy`), `extension/src/ads/aiSettings.ts` (`aiWritePathsSetting`), `extension/src/ads/adsWrite.ts` (`policy`), `extension/src/ads/lmTools.ts` (`prepareInvocation`), `extension/package.json` (setting), `extension/CHANGELOG.md`

**Interfaces:**
- Produces:
  ```ts
  export interface WritePolicySettings { allowedPaths: string[] }
  export function evaluateWritePolicy(symbol: string, s: WritePolicySettings): { allowed: boolean; reason?: string };
  /** One reason for a whole op naming every symbol outside the allowed paths; undefined when all are allowed. */
  export function writePolicyReason(symbols: readonly string[], s: WritePolicySettings): string | undefined;
  // writeGate.ts
  export interface GateDeps { /* existing */ policy?(op: WriteOp): string | undefined }   // a returned text refuses the op
  // aiSettings.ts
  export function aiWritePathsSetting(): string[];   // user value only, like aiWritesSetting
  ```
- Rules: empty list = no restriction (default). A prefix matches the symbol itself and everything below it: after the (trimmed, case-insensitive) prefix the symbol continues with `.` or `[` or ends; a prefix ending in `.` matches by `startsWith`. `MAIN.Sim` does not match `MAIN.Simulation.x`. Blank entries are ignored; a non-empty array with only blank entries refuses everything (safe default). Reason text: `MAIN.Other is outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: MAIN.Sim, GVL.Test)`; several symbols: `MAIN.a, MAIN.b are outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: GVL.Test)`.
- Gate behaviour: `policy` is asked first in `process()` and again in `refusalBeforeSend()` (the setting may change while a dialog is open); a returned text ends the op as `refused` with that text, so no dialog opens. `adsWrite.ts` passes `policy: op => writePolicyReason(itemsOf(op).map(i => i.symbol), { allowedPaths: aiWritePathsSetting() })`.
- Copilot: `prepareInvocation` computes the same reason; when set it returns only `{ invocationMessage: 'Not writing: outside the allowed paths' }` (no confirmation), and `invoke` ends in the gate with the refusal text.
- Manifest: setting `iecode.ads.aiWritePaths` (`type: array` of string, `default: []`, `scope: application`, markdownDescription: "Path prefixes AI tools may write, e.g. `MAIN.Sim` or `GVL.Test`. A prefix matches the symbol itself and everything below it, not other names that merely start with the same letters. Empty (default): every symbol is allowed. User settings only, so a workspace cannot widen it. Also applies to a restore."). The wishlist row names `iecode.ads.aiWrites`, but that is the existing mode setting (off/confirm/auto); the new setting is `aiWritePaths`.

- [ ] **Step 1: Write the failing tests** (`writePolicy.test.ts`, gate test)

```ts
test('an empty list allows everything', () => assert.deepEqual(evaluateWritePolicy('MAIN.x', { allowedPaths: [] }), { allowed: true }));
test('a prefix matches the symbol and its children, not a longer name', () => {
  const s = { allowedPaths: ['MAIN.Sim', 'GVL.Test'] };
  for (const ok of ['MAIN.Sim', 'main.sim.bStart', 'MAIN.Sim.aValues[2]', ' GVL.Test.nX ']) assert.equal(evaluateWritePolicy(ok, s).allowed, true, ok);
  assert.deepEqual(evaluateWritePolicy('MAIN.Simulation.x', s), { allowed: false, reason: 'MAIN.Simulation.x is outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: MAIN.Sim, GVL.Test)' });
  assert.equal(evaluateWritePolicy('MAIN.Other', s).allowed, false);
});
test('a prefix with a trailing dot matches by start', () => assert.equal(evaluateWritePolicy('GVL.x', { allowedPaths: ['GVL.'] }).allowed, true));
test('blank entries are ignored and an all-blank list refuses everything', () => {
  assert.equal(evaluateWritePolicy('MAIN.Sim.x', { allowedPaths: ['', ' ', 'MAIN.Sim'] }).allowed, true);
  assert.equal(evaluateWritePolicy('MAIN.Sim.x', { allowedPaths: ['', ' '] }).allowed, false);
});
test('a batch reason names every symbol outside', () => {
  assert.equal(writePolicyReason(['GVL.Test.a', 'MAIN.a', 'MAIN.b'], { allowedPaths: ['GVL.Test'] }),
    'MAIN.a, MAIN.b are outside the paths the user allows for AI writes (iecode.ads.aiWritePaths: GVL.Test)');
  assert.equal(writePolicyReason(['GVL.Test.a'], { allowedPaths: ['GVL.Test'] }), undefined);
});
// writeGate.test.ts
test('gate refuses a write outside the allowed paths without a dialog, also inside a batch', async () => { /* deps.policy returns text; confirms.length === 0; result { kind: 'refused', reason: text }; sent.length === 0 */ });
test('gate asks the policy again right before sending', async () => { /* policy ok at first, text after the dialog answer -> refused, send not called */ });
```
- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile error `Cannot find module '../src/core/writePolicy'`.
- [ ] **Step 3: Implement** `writePolicy.ts`, the `GateDeps.policy` hook, the settings reader (`inspect<string[]>('aiWritePaths')?.globalValue ?? []`, filtered to strings), the wiring and the manifest entry.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass; `mcpTools.test.ts` rigs build a gate without `policy`, so they are unchanged.
- [ ] **Step 5: CHANGELOG:** `- New setting `iecode.ads.aiWritePaths` limits AI writes to the path prefixes you list (for example `MAIN.Sim`), so auto-approve can be used on a simulation without risk to a real target. A write outside the list is refused before any dialog opens; empty (default) keeps today's behaviour.`
- [ ] **Step 6: Commit**

```bash
git add extension/src/core/writePolicy.ts extension/test/writePolicy.test.ts extension/src/core/writeGate.ts extension/test/writeGate.test.ts extension/src/ads/aiSettings.ts extension/src/ads/adsWrite.ts extension/src/ads/lmTools.ts extension/package.json extension/CHANGELOG.md
git commit -s -m "Let the user limit AI writes to path prefixes" -m "Auto-approve on a simulation is only safe if the agent cannot reach other symbols, and the user setting must not be widenable by a workspace. The check sits in the gate, so it covers MCP, Copilot and batches, and a refused write never opens a dialog."
```

---

### Task C1: SDK contract check for `SumSymbolWrite` (spike, about 2 h)

**Purpose:** roadmap D21 forbids claiming per-item write proof the SDK does not give. C2's classification and C3's result texts rest on these measurements. Nothing from this task is merged except the recorded findings.

**Files:**
- Throwaway: a console project **outside the repository** (for example under the session scratchpad), referencing `Beckhoff.TwinCAT.Ads` 7.0.389 (the version pinned in `cli/`).
- Record: the "C1 findings" section at the end of this file. Commit only this file.

**Set-up:** a local TwinCAT runtime in run mode with a small test PLC using generic variables: `MAIN.bFlag : BOOL`, `MAIN.nCount : INT`, `MAIN.rValue : REAL`, `MAIN.sText : STRING(80)`, `MAIN.aInts : ARRAY[0..199] OF INT`, one `VAR PERSISTENT` variable, one variable in an input mapping (`AT %I*`).

**Checklist (measure each, write the observed result into the findings table):**

- [ ] 1. **Overload:** list the public constructors and write methods of `SumSymbolWrite` in 7.0.389 (reflection or IntelliSense): exact signature, how values are passed (`object[]`, by symbol or by name), the result type and its members (aggregate code, per-item codes, `Failed`, anything that tells device-origin from SDK-origin), and the `SumFallbackMode` members. Choose the overload that takes the symbols already used by `AdsLink.PrepareRead` (`SumAccessMode.ValueByName`). Record the exact call C2 will use.
- [ ] 2. **Cardinality and order:** write 1, 2, 20 and 200 values; for each, is the per-item result list exactly as long as the input and in input order? Prove the order with distinct values per symbol and a read-back.
- [ ] 3. **Per-item failures:** provoke and record the exact `AdsErrorCode` and whether the other items were written (read them back): (a) a symbol that went stale (rename it in the PLC project, download, keep the old symbol object); (b) an invalid index or offset (array element out of range if the SDK allows building it); (c) a value of the wrong CLR type for the symbol (does the SDK throw before sending, or return a code?); (d) a variable the PLC rejects writes to, if one exists; (e) a mix, item 2 of 3 failing.
- [ ] 4. **Device versus SDK codes:** for each code of step 3, decide whether it comes from the device (it appears in a network trace of the ADS response) or is synthesized by the SDK (marshalling, client state). Use the TwinCAT ADS Monitor, or Wireshark on AMS/TCP port 48898 with a route to the same machine's IP NetId so the traffic leaves the local router. Record which codes are "device rejection, no effect on that item" candidates.
- [ ] 5. **Aggregate failure:** make the whole request fail: wrong port (no such runtime), disposed client, runtime stopped mid-request if possible. Record `Failed`, the aggregate code, whether per-item results exist at all (the read adapter drops them when `r.Failed`, `AdsLink.cs:126`), and whether any item could have been written. Look for an aggregate error that provably comes back before any sub-write runs (for example "service not supported"); if none can be shown, every aggregate failure stays `unknown`.
- [ ] 6. **Splitting and request count:** does the SDK split a request above some size into several ADS requests (count them in the trace for 20, 200 and 1000 items)? "One ADS request" in the texts holds only for the sizes where there is no split; the tool limit of 20 must be below that.
- [ ] 7. **Fallback modes:** with `SumFallbackMode` set to the "none" member, confirm that a device without sum-command support (or a forced failure) throws or fails instead of writing item by item; record what happens with the "all" member only to document why it is not used.
- [ ] 8. **Timing:** duration of one 20-item sum write and the following 20-item sum read against the simulation, to size the host's 10 s request timeout (`REQUEST_MS`, `host.ts:14`).
- [ ] 9. **Persistent flag (input for C7b):** for the persistent and the `%I*` variable, what does the online symbol report (`ISymbol.IsPersistent`, flags, area)? One line each.
- [ ] 10. **Decide and record** the three sets C2 needs: `NoEffectCodes` (codes proven to be device rejections without effect, possibly empty), `NotSentAggregateCodes` (aggregate codes proven to precede every sub-write, possibly empty), and the verdict "per-item results survive an aggregate failure: yes/no".

**Go/no-go:** if the SDK offers no usable per-item result (step 1 or 2 fails), C2 still ships the batch with every non-zero outcome `unknown` and both sets empty; record that decision here and drop the `notWritten` examples that depend on it. If no sum write is available at all, stop and ask the user (the fallback to single writes is excluded by D10).

- [ ] **Commit the findings**

```bash
git add docs/superpowers/plans/2026-11-09-ads-wishlist-c-writes.md
git commit -s -m "Record the SumSymbolWrite contract check" -m "The batch write may only claim per-item proof the SDK actually gives; the measured codes, their origin and the aggregate-failure behaviour are recorded before the result model is built."
```

---

### Task C2: `writeMany` in the CLI (protocol 2)

**Depends on C0 and C1.** Statements marked `[C1]` come from the findings.

**Files:**
- Modify: `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`, `AdsLink.cs`, `extension/src/core/hostProtocol.ts`, `extension/test/adswatch.test.ts` (line 22: `assert.equal(PROTOCOL, 2)`), `cli/README.md`
- Test: `cli/tests/IECode.Automation.Tests/AdsWatchBackendTests.cs`, `FakeLink.cs`, `cli/tests/IECode.Core.Tests/WatchHostTests.cs`, `extension/test/hostProtocol.test.ts`

**Interfaces:**
- Produces (C#, `IECode.Core.Ads`):
  ```csharp
  public static class WriteStatus { public const string Written = "written", NotWritten = "notWritten", Unknown = "unknown"; }
  public sealed record WriteManyItem(string Symbol, string Status,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Value = null,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ReadBackError = null,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Error = null,
      [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] uint? AdsCode = null);
  // IWatchBackend
  /// Prepares every value first (any failure: WriteNotSentException naming "writes[i] <symbol>: ...", nothing sent), then one
  /// sum write, then one sum read-back of the written items. Whole-request failure after sending: AdsFault (outcome unknown).
  IReadOnlyList<WriteManyItem> WriteMany(IReadOnlyList<(string Symbol, string Value)> writes);
  // WatchHost
  public const int Protocol = 2, MaxSymbols = 200, MaxWrites = 20;
  ```
- Produces (C#, `IECode.Automation`, internal): `ILinkSymbol.Prepare(string text): object` (throws `WriteNotSentException`; `Write(string)` stays and is implemented as Prepare plus the ADS write), `IAdsLink.PrepareWrite(IReadOnlyList<ILinkSymbol> symbols): ISymbolWrite`, `ISymbolWrite.Write(IReadOnlyList<object> values): SumWrite`, `record SumWrite(AdsErrorCode Code, IReadOnlyList<AdsErrorCode>? Items)`; `BeckhoffLink.PrepareWrite` builds the SDK sum write with no fallback `[C1: exact overload and SumFallbackMode member]`. `AdsWatchBackend`'s internal constructor gets an optional `IReadOnlySet<uint>? noEffectCodes = null` (default `WriteOutcomes.NoEffect`, filled from C1, possibly empty) and `IReadOnlySet<uint>? notSentAggregateCodes = null` (default empty or from C1).
- Wire format (additive; protocol 1 clients never send it):
  ```text
  ← {"id":5,"op":"writeMany","writes":[{"symbol":"MAIN.a","value":"1"},{"symbol":"MAIN.b","value":"2"}]}
  → {"id":5,"ok":true,"data":{"items":[{"symbol":"MAIN.a","status":"written","value":"1"},{"symbol":"MAIN.b","status":"notWritten","error":"Write MAIN.b: ... (0x...)","adsCode":1808}]}}
  ```
  `status` is `written` (with `value`, or `value` absent and `readBackError`), `notWritten` (device rejection proven by `NoEffectCodes`, with `error` and `adsCode`) or `unknown` (any other non-zero code, a result count that differs from the request, with `error`). `ok:false` with `"written":"no"` = nothing sent (invalid request, unknown or non-single symbol, unparsable value, duplicate symbol, more than 20 writes); `ok:false` without `written` = failed after sending, outcome unknown for every item.
- Backend algorithm: (1) one `Loader(link, ReadVersion(link), n)` and `Lookup` per symbol (not `Find` per item, which reads the symbol version each time); not found or not single value: `WriteNotSentException($"writes[{i}] {symbol}: ...")`; (2) `Prepare` each value, same exception with index and symbol; (3) `PrepareWrite(...).Write(values)` inside `Call("Write ...")`; aggregate `Code != NoError` or `Items is null`: `NotSentAggregateCodes` contains the code then `WriteNotSentException`, else `AdsFault(Text(...), code, connectionLost)`; (4) result count differs from the request: every item `unknown` with error `ADS returned <k> results for <n> writes`; (5) per item: `NoError` = written; code in `NoEffectCodes` = `notWritten`; else `unknown`, error text `Text($"Write {symbol}", code)`; (6) one `PrepareRead` sum read of the written items; a failed or throwing read-back sets `ReadBackError` on those items and never changes `written`.

- [ ] **Step 1: Write the failing C# tests** (`AdsWatchBackendTests.cs`; extend `FakeLink` with `PrepareWrite` returning a scripted `Func<IReadOnlyList<object>, SumWrite> SumWriteFn`, counters `SumWrites` and `SumReads`, and `FakeSymbol.Prepare` with the parse rule of today's `Write`)

```csharp
private static readonly IReadOnlySet<uint> NoEffect = new HashSet<uint> { 0x1 };   // a test-only marker; the real set comes from C1
private static FakeSymbol Sym(string n) => Int(n);

[Fact] public void WriteMany_prepares_every_value_before_anything_is_sent()
{   // MAIN.n0 "1", MAIN.n1 "zz", MAIN.n2 "3"
    var e = Assert.Throws<WriteNotSentException>(() => b.WriteMany([("MAIN.n0","1"),("MAIN.n1","zz"),("MAIN.n2","3")]));
    Assert.Equal("writes[1] MAIN.n1: 'zz' is not a valid INT.", e.Message);
    Assert.Equal(0, link.SumWrites); Assert.Null(s0.Written);
}
[Fact] public void WriteMany_unknown_symbol_sends_nothing() { /* message starts "writes[1] MAIN.nope: Symbol 'MAIN.nope' not found"; SumWrites == 0 */ }
[Fact] public void WriteMany_non_single_value_symbol_sends_nothing() { /* WriteNotSentException, SumWrites == 0 */ }
[Fact] public void WriteMany_sends_one_sum_write_and_reads_back_with_one_sum_read()
{   // SumWriteFn -> all NoError; link.Sum = Ok((short)1, (short)2)
    var items = b.WriteMany([("MAIN.n0","1"),("MAIN.n1","2")]);
    Assert.Equal(1, link.SumWrites); Assert.Equal(1, link.SumReads);
    Assert.Equal([new WriteManyItem("MAIN.n0", "written", "1"), new WriteManyItem("MAIN.n1", "written", "2")], items);
}
[Fact] public void WriteMany_a_device_code_marks_only_that_item_not_written()
{   // codes: NoError, 0x1, NoError; read-back sum read has 2 items
    Assert.Equal(["written", "notWritten", "written"], items.Select(i => i.Status));
    Assert.Equal(0x1u, items[1].AdsCode); Assert.Contains("0x1", items[1].Error);
}
[Fact] public void WriteMany_an_unclassified_code_is_unknown() { /* code 0x2 not in the set -> "unknown", Error contains 0x2, no read-back for it */ }
[Fact] public void WriteMany_a_result_count_mismatch_is_unknown_for_every_item()
{   // 3 writes, SumWriteFn returns 2 codes
    Assert.All(items, i => { Assert.Equal("unknown", i.Status); Assert.Equal("ADS returned 2 results for 3 writes", i.Error); });
}
[Fact] public void WriteMany_a_whole_request_failure_is_an_ads_fault_not_a_not_sent()
{   // SumWrite(Code: 0x745, Items: null)
    var f = Assert.Throws<AdsFault>(() => b.WriteMany(...)); Assert.Equal(0x745u, f.AdsCode);
}
[Fact] public void WriteMany_an_exception_from_the_link_is_an_ads_fault() { /* AdsFault, not WriteNotSentException */ }
[Fact] public void WriteMany_a_failed_read_back_keeps_written() { /* link.Sum throws: status "written", Value null, ReadBackError contains the message */ }
[Fact] public void WriteMany_resolves_the_symbol_table_once_for_the_whole_batch() { Assert.Equal(1, link.Uploads); /* and VersionReads grows by one, not by n */ }
```
`WatchHostTests.cs` (extend `FakeBackend` with `Func<IReadOnlyList<(string Symbol, string Value)>, IReadOnlyList<WriteManyItem>> WriteManyFn` and a call counter):
```csharp
[Fact] public void Start_EmitsHelloFirst()  // existing test: expect protocol 2
[Fact] public void WriteMany_reply_has_one_entry_per_item()
{   // {"id":5,"op":"writeMany","writes":[...2...]}; ok:true; data.items.Length == 2; items[0].symbol/status/value; "readBackError" absent when null
}
[Theory] public void WriteMany_validation_failures_say_written_no_and_call_no_backend(string request, string error)
{   // missing writes; writes not an array; empty -> "writes must not be empty."; 21 entries -> "At most 20 writes are allowed.";
    // an entry without string value -> "writes[1] needs string 'symbol' and 'value'."; duplicate (case-insensitive) -> "Duplicate symbol: MAIN.A"
    // each: ok false, written "no", error == the text, backend counter 0
}
[Fact] public void WriteMany_not_sent_exception_says_written_no() { /* WriteManyFn throws WriteNotSentException */ }
[Fact] public void WriteMany_ads_fault_has_no_written_field_and_keeps_the_code() { /* AdsFault(…, 0x745, false): ok false, no "written", adsCode 0x745 */ }
[Fact] public void A_protocol_1_client_sees_no_change_in_the_existing_ops() { /* the existing write/read/watch/interval tests stay green unchanged */ }
```
- [ ] **Step 2: Run to verify they fail.** PowerShell: `dotnet test cli/tests/IECode.Core.Tests --filter "FullyQualifiedName~WatchHostTests"`; expected: compile errors (`WriteMany`, `WriteManyItem`). Then `dotnet test cli/tests/IECode.Automation.Tests --filter "FullyQualifiedName~AdsWatchBackendTests"`; expected: compile errors. One command per call, no build chained.
- [ ] **Step 3: Implement** the interfaces and algorithm above; bump `Protocol` to 2; `DoWriteMany(root)` parses `writes` with `WriteNotSentException` for every validation failure (unlike `Str`, which throws `IECodeException` and so reads as "unknown" in the client); update the `<summary>` of `WatchHost` is not needed. Update the existing `FakeBackend` and `FakeSymbol`/`FakeLink` for the new members.
- [ ] **Step 4: Run to verify they pass.** PowerShell, separately: `dotnet test cli/tests/IECode.Core.Tests`, then `dotnet test cli/tests/IECode.Automation.Tests`. Expected: all pass (existing tests unchanged except the hello protocol assertion).
- [ ] **Step 5: Extension side: protocol 2 entry.** Failing test first in `hostProtocol.test.ts`:
```ts
test('protocol 2 adds batch write and drops nothing', () => {
  assert.equal(PROTOCOL, 2);
  assert.deepEqual(PROTOCOL_TABLE[2], { ops: ['watch', 'read', 'write', 'interval', 'writeMany'], features: ['writeMany'] });
  assert.equal(FEATURE_LABELS.writeMany, 'batch write');
  assert.deepEqual(tableProblems(PROTOCOL_TABLE), []);
  const old = negotiate(1);
  assert.ok(old.ok && old.caps.missing('writeMany') === 'this needs a newer iecode CLI: batch write (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…"');
  const cur = negotiate(2);
  assert.ok(cur.ok && cur.caps.supports('writeMany'));
});
```
Run `cd extension && npm test` (fails), add the entry and label, set `adswatch.test.ts` line 22 to `assert.equal(PROTOCOL, 2)`, run again (passes). The existing test `negotiate(PROTOCOL + 1)` now refers to 3.
- [ ] **Step 6: `cli/README.md`:** add the `writeMany` line to the request list, the reply description (statuses, `written:"no"` rules) and the table row `2 | + writeMany | batch write`. Do not claim the same cycle.
- [ ] **Step 7: Commit**

```bash
git add cli extension/src/core/hostProtocol.ts extension/test/hostProtocol.test.ts extension/test/adswatch.test.ts
git commit -s -m "Add a writeMany op to the ADS host as one sum write" -m "A batch must be prepared completely before anything is sent and may not fall back to single writes, so the backend converts every value first and then sends one sum write. Per-item outcomes are classified conservatively: only codes proven to have no effect are not-written, everything else is unknown."
```

---

### Task C3c: Wire the batch write (host, execution, MCP, Copilot, manifest)

**Depends on C2, C3a, C3b, C7a, C0.**

**Files:**
- Create: `extension/src/core/writeExec.ts`; Test: `extension/test/writeExec.test.ts`
- Modify: `extension/src/ads/host.ts` (`writeMany`), `adsWrite.ts`, `adsTools.ts` (`requires`), `extension/src/core/mcpTools.ts`, `extension/src/core/adswatch.ts` (`writeManyStage`), `extension/src/ads/lmTools.ts`, `extension/package.json`, `extension/CHANGELOG.md`, `extension/test/mcpTools.test.ts`, `extension/test/adswatch.test.ts`

**Interfaces:**
- Consumes: `WriteOp`, `WriteResult`, `itemsOf`, `sendOutcome` (writeGate), `WriteItemResult` (writeText), `HostError`, `RequestTimeout` (adswatch).
- Produces:
  ```ts
  // adswatch.ts: how far a writeMany got, from the reply data or the rejection
  export type WriteManyStage =
    | { kind: 'items'; items: WriteItemResult[] }
    | { kind: 'notSent'; reason: string }
    | { kind: 'unknown'; reason: string };
  export function writeManyStage(outcome: { data: unknown } | { error: unknown }, writes: readonly { symbol: string }[]): WriteManyStage;
  // host.ts
  export interface HostWriteManyResult { items: WriteItemResult[] }
  writeMany(writes: { symbol: string; value: string }[], beforeSend?: () => string | undefined): Promise<HostWriteManyResult>;  // throws WriteNotSent / WriteOutcomeUnknown like write()
  // writeExec.ts
  export interface ExecDeps {
    writeOne(item: WriteItem, beforeSend: () => string | undefined): Promise<{ value: string | null; readBackError?: string }>;   // host.write
    writeMany(items: WriteItem[], beforeSend: () => string | undefined): Promise<{ items: WriteItemResult[] }>;                   // host.writeMany
  }
  export function executeWrite(op: WriteOp, beforeSend: () => string | undefined, deps: ExecDeps): Promise<WriteResult>;
  // core/mcpTools.ts, AdsToolFns (optional so existing fakes keep compiling)
  requires?(feature: string): Promise<string | undefined>;
  ```
- `writeManyStage` rules: `data.items` must be an array of the same length as `writes`, each item with the same symbol (case-insensitive) in the same order and a status of `written`/`notWritten`/`unknown`; otherwise `{ kind: 'unknown', reason: 'The ADS host answered a batch write with a result that does not match the request' }`. A `HostError` with `written === 'no'` is `notSent`; every other rejection, a `RequestTimeout` (`Write of N values timed out`) included, is `unknown` (the host.ts text adds `; the values may or may not have been written`). Item mapping: `written` with `value` string = `{ status:'written', readBack: value }`; with `readBackError` = `readBack: null` plus the error; `notWritten` and `unknown` carry `reason` from `error` (fallback `no reason given`); an unknown status text is `unknown`.
- `executeWrite`: a single op (no `items`) calls `writeOne` and returns the same `WriteResult` as today (`written` / `sendOutcome(e)`), so single-write behaviour is byte-identical; an op with `items` calls `writeMany` once and returns `{ kind: 'done', items }` or the `sendOutcome` mapping of its rejection. One item in `items` goes through `writeOne` and is wrapped as `done` with one item (protocol 1 compatible).
- Gate side: `adsWrite.ts` `send` builds `ExecDeps` from `host.write`/`host.writeMany`, wraps `beforeSend` to log `AI write <symbol> := <value> on <target> via <via>` for one item and `AI write batch of <n> on <target> via <via>: <symbol> := <value>, ...` for several (each through `show`), and `confirm` uses `confirmMessage(itemsOf(op), `${op.targetKey} (${workspaceName()})`, note)`.
- Feature check before the dialog: `adsTools().requires = feature => host.requires(feature)`. In `mcpTools.ts` the `ads_write` handler, after parsing and before `gate.run`: `const need = featureOf(op); if (need && d.tools.requires) { const missing = await d.tools.requires(need); if (missing) return { text: `Not written: ${sentence(missing)}.`, isError: true }; }` (for several items; `Not written: this needs a newer iecode CLI: batch write (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…".`). The batch op is built as `{ symbol: items[0].symbol, value: items[0].value, items, targetKey, via: 'MCP' }`.
- Copilot (`lmTools.ts`): `invoke` and `prepareInvocation` parse `opts.input` with `parseWriteInput` (invalid: `Invalid arguments: <error>` and no confirmation); `writeKey(parsed.value)` replaces the local `writeKey`; `prepareInvocation` uses `confirmMessage(items, host.target(), note)`, and when `featureOf(op)` is set and `host.knownMissing(feature)` has text it returns only an `invocationMessage` (no confirmation), so the invoke step refuses without a dialog; `invoke` calls `host.requires(feature)` first like the MCP path.
- Manifest `iecode_ads_write`: add `writes` (array, `maxItems: 20`, items `{ symbol: string maxLength 512, value: string maxLength 4096 }`, both required), drop `required` of the top level (one of the two forms is required, the parser says which), and extend `modelDescription` with: `To set several values together, pass writes (1-20 items) instead of symbol and value: after one confirmation they are sent in one ADS request (not guaranteed to land in the same PLC cycle) and every item gets its own result. If any value is invalid nothing is sent. Every symbol must be named once.` The test `the manifest declares the six tools in client-neutral words` must stay green (no `adsWrite` or `Always Allow` in the description).

- [ ] **Step 1: Write the failing tests**

`adswatch.test.ts`:
```ts
test('writeManyStage maps a reply, a proof of not sent and everything else to unknown', () => {
  const w = [{ symbol: 'MAIN.a' }, { symbol: 'MAIN.b' }];
  assert.deepEqual(writeManyStage({ data: { items: [{ symbol: 'MAIN.a', status: 'written', value: '1' }, { symbol: 'main.b', status: 'notWritten', error: 'ADS error 0x1' }] } }, w),
    { kind: 'items', items: [{ symbol: 'MAIN.a', status: 'written', readBack: '1' }, { symbol: 'MAIN.b', status: 'notWritten', reason: 'ADS error 0x1' }] });
  assert.deepEqual(writeManyStage({ data: { items: [{ symbol: 'MAIN.a', status: 'written', readBackError: 'link down' }, { symbol: 'MAIN.b', status: 'unknown' }] } }, w),
    { kind: 'items', items: [{ symbol: 'MAIN.a', status: 'written', readBack: null, readBackError: 'link down' }, { symbol: 'MAIN.b', status: 'unknown', reason: 'no reason given' }] });
  assert.deepEqual(writeManyStage({ error: new HostError("writes[1] MAIN.b: 'zz' is not a valid INT.", 'no') }, w), { kind: 'notSent', reason: "writes[1] MAIN.b: 'zz' is not a valid INT." });
  assert.equal(writeManyStage({ error: new HostError('x', undefined) }, w).kind, 'unknown');
  assert.equal(writeManyStage({ error: new RequestTimeout('t') }, w).kind, 'unknown');
  assert.equal(writeManyStage({ data: { items: [{ symbol: 'MAIN.a', status: 'written', value: '1' }] } }, w).kind, 'unknown');                 // count mismatch
  assert.equal(writeManyStage({ data: { items: [{ symbol: 'MAIN.b', status: 'written' }, { symbol: 'MAIN.a', status: 'written' }] } }, w).kind, 'unknown'); // misaligned
  assert.equal(writeManyStage({ data: 'x' }, w).kind, 'unknown');
});
```
`writeExec.test.ts` (fake `ExecDeps`, records calls):
```ts
test('a single op calls writeOne once and returns today\'s result', async () => { /* { kind:'written', readBack:'5' }; writeMany not called */ });
test('a batch op calls writeMany once with the items in order and returns done', async () => {});
test('one item in the list goes through writeOne and is wrapped as done', async () => { /* protocol-1 compatible */ });
test('a not-sent rejection of a batch is refused, any other rejection is unknown', async () => { /* WriteNotSent -> refused; WriteOutcomeUnknown / plain Error -> unknown */ });
test('beforeSend refusal reaches the host and ends the op refused', async () => {});
```
`mcpTools.test.ts`:
```ts
test('ads_write with writes reaches the gate once with the item list and the first item mirrored', async () => {
  const r = rig();
  const res = await result(r.session.handle(call(7, 'ads_write', { writes: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }] })));
  assert.equal(r.sent.length, 1);
  assert.deepEqual(r.sent[0].op, { symbol: 'MAIN.a', value: '1', items: [{ symbol: 'MAIN.a', value: '1' }, { symbol: 'MAIN.b', value: '2' }], targetKey: 'A:851', via: 'MCP' });
});
test('a batch on a protocol-1 host is refused before the gate, a single write still goes through', async () => {
  const r = rig({ requires: async f => f === 'writeMany' ? 'this needs a newer iecode CLI: batch write (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…"' : undefined });
  const b = await result(r.session.handle(call(8, 'ads_write', { writes: [{ symbol: 'A', value: '1' }, { symbol: 'B', value: '2' }] })));
  assert.equal(b.isError, true);
  assert.equal(b.content[0].text, 'Not written: this needs a newer iecode CLI: batch write (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…".');
  assert.equal(r.sent.length, 0);
  const s = await result(r.session.handle(call(9, 'ads_write', { symbol: 'MAIN.x', value: '5' })));
  assert.equal(s.isError, false);
  assert.equal(r.sent.length, 1);
});
test('a batch with a bad item never reaches the gate', async () => { /* writes with a duplicate: isError, text "Invalid arguments: writes[1] repeats writes[0]: MAIN.a", sent.length 0 */ });
test('a done result with an unknown item is an error', async () => { /* send.impl returns done with one unknown item -> isError true, text starts "Sent in one ADS request (2 writes):" */ });
test('a batch that times out after sending is outcome unknown for all, never written', async () => { /* send never answers; gate/host maps to unknown; text "Outcome unknown for all 2 writes: ..." */ });
```
`mcpTools.test.ts` `fns()` gets no `requires` by default (optional), so older tests are unchanged; the `descriptors` fixture is unchanged.

- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors (`writeManyStage`, `executeWrite`, `requires`).
- [ ] **Step 3: Implement** `writeManyStage`, `executeWrite`, `host.writeMany` (same structure as `write`: `ensure(true)`, no-await guard with `procKey`, `caps` check as a last defence: `if (!this.caps?.supports('writeMany')) throw new WriteNotSent(this.caps?.missing('writeMany') ?? 'The ADS host is not running.')`, `send(child, { op: 'writeMany', writes })`, `writeManyStage`, `this.written` entries for each written item with a read-back, `itemsChanged.fire()`), the `adsWrite.ts`, `adsTools.ts`, `mcpTools.ts`, `lmTools.ts` and manifest changes. `send` of `adsWrite.ts` becomes `return executeWrite(op, wrappedBeforeSend, deps)`; its `catch` keeps the `output.warn(...)` log with `show`.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass; the existing `ads_write reaches gate.run with via MCP and the bound target` test (exact `deepEqual` of the op) is unchanged.
- [ ] **Step 5: CHANGELOG** (`### Claude Code and ADS`): `- `ads_write` takes `writes` (up to 20 symbol and value pairs) to set several values after one confirmation. They are sent in one ADS request (not guaranteed to land in the same PLC cycle) and the result lists every item: written, not written or outcome unknown. If any value is invalid nothing is sent. Needs the matching iecode CLI release; with an older CLI the single write keeps working and the batch says "needs a newer iecode CLI".`
- [ ] **Step 6: Commit**

```bash
git add extension
git commit -s -m "Wire the batch write through the gate, MCP and Copilot" -m "The batch runs under one confirmation that lists every write, is refused before the dialog when the installed CLI is too old, and keeps a result per item. One execution module serves the single and the batch form so the single write stays unchanged."
```

---

### Task C4: Pulse mode (`pulseMs`)

**Files:**
- Modify: `extension/src/core/toolInput.ts` (`pulseMs`), `writeText.ts` (`WriteItem.pulseMs`, `PulseOutcome`, texts, `oppositeBool`), `writeExec.ts` (pulse), `extension/src/ads/adsWrite.ts`, `extension/package.json`, `extension/CHANGELOG.md`
- Test: `extension/test/toolInput.test.ts`, `writeText.test.ts`, `writeExec.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface WriteItem { symbol: string; value: string; pulseMs?: number }
  export type PulseOutcome =
    | { ms: number; heldMs: number; reset: string; state: 'done' }
    | { ms: number; heldMs: number; reset: string; state: 'notSent' | 'unknown'; reason: string };
  // WriteItemResult 'written' and 'unknown' get an optional `pulse?: PulseOutcome`
  export function oppositeBool(value: string): string | undefined;      // TRUE/1 -> 'FALSE', FALSE/0 -> 'TRUE', else undefined
  export const MIN_PULSE_MS = 10, MAX_PULSE_MS = 5000;
  // writeExec.ts ExecDeps gets:
  sleep(ms: number): Promise<void>;
  now(): number;                                                       // monotonic ms
  readBefore(symbols: string[]): Promise<{ symbol: string; type: string | null; value: string | null; error?: string }[]>;  // never throws
  ```
- Input: `pulseMs` in the single form (`{ symbol, value, pulseMs }`; the parsed single form then carries `pulseMs` only when given, so the plain form stays `{ symbol, value }`) and per item in `writes`. Errors: `pulseMs must be a whole number from 10 to 5000`; `pulseMs needs a BOOL value (TRUE, FALSE, 1 or 0), not "5"`; `only one write per call can set pulseMs`. A single form with `pulseMs` becomes an op with `items: [{ symbol, value, pulseMs }]` (so the result is `done`).
- Semantics (all under the one confirmation): (1) `readBefore` the pulse symbol; its type must be `BOOL`, else nothing is sent: `pulseMs works on BOOL variables only; MAIN.n is INT`; a read error: `cannot check the type of MAIN.b: <error>`; (2) send the whole call (single, or one sum write) with the pulse item at its requested value; (3) if the pulse item is `written` or `unknown` (an unknown first write may have set the bit, so the reset is still tried; `notWritten` skips it): `sleep(pulseMs)`, then write the opposite value with `writeOne` (a plain `write` op, so it needs no new protocol feature); `heldMs` is the measured time between the two requests; (4) the reset always runs: no check of the gate's approval, deadline, cancellation or the AI-write setting happens for it (the bit must return to idle); only the host's own target guard applies.
- Texts (pin): confirmation line `MAIN.bStart := TRUE (pulse 200 ms, then FALSE)`; a single pulse reads `Write MAIN.bStart := TRUE (pulse 200 ms, then FALSE) on A:851 (ws)?`. Item lines: `MAIN.bStart: pulsed TRUE for 214 ms (asked 200 ms, timed by the extension, not cycle-exact), then FALSE`; reset not sent: `MAIN.bStart: written TRUE, but the reset to FALSE was not sent: <reason>. MAIN.bStart may still be TRUE; reset it or ask the user.`; reset unknown: `MAIN.bStart: written TRUE, but the reset to FALSE has an unknown outcome: <reason>. MAIN.bStart may still be TRUE; read it, reset it or ask the user.`; `doneIsError` is true when a pulse reset is not `done`.
- Manifest: `pulseMs` (number, 10-5000) on the top level and on `writes[]` items, described as: `BOOL only: write the value, wait pulseMs, then write the opposite value, all after the one confirmation; the timing is kept by the extension and is not cycle-exact. At most one write per call.`

- [ ] **Step 1: Write the failing tests** (names and key assertions)
  - `toolInput.test.ts`: `pulseMs parses on the single form and per item and keeps the plain form untouched` (`{symbol:'MAIN.b',value:'TRUE',pulseMs:200}` -> value has `pulseMs: 200`; `{symbol,value}` deepEqual has no `pulseMs` key); `pulseMs is refused when out of range, fractional, on a non-BOOL value or twice` (the three exact error texts above; 9 and 5001 and 10.5 fail; 10 and 5000 pass).
  - `writeText.test.ts`: `oppositeBool` table; the pulse lines and `confirmMessage` pulse line (strings above); `doneIsError` true for a failed reset.
  - `writeExec.test.ts` with a scripted `sleep`/`now`:
    - `a pulse writes the value, waits, then writes the opposite` — `calls` log is `['readBefore MAIN.b','writeOne MAIN.b=TRUE','sleep 200','writeOne MAIN.b=FALSE']`; result item `pulse` `{ ms: 200, heldMs: <fake now diff>, reset: 'FALSE', state: 'done' }`.
    - `a pulse on a non-BOOL is refused before anything is sent` — `readBefore` returns type `INT`; `writeOne` never called; `refused` with `pulseMs works on BOOL variables only; MAIN.n is INT`.
    - `an unreadable type refuses the pulse` (`cannot check the type of MAIN.b: link down`).
    - `a failing reset says the bit may still be set` — second `writeOne` throws `WriteNotSent('x')` -> `state: 'notSent'`; throws plain `Error` -> `state: 'unknown'`; texts as pinned.
    - `a pulse item that was not written gets no reset` (batch with `notWritten`).
    - `an unknown first write still tries the reset`.
    - `the reset runs although the gate has been disposed or the approval is gone` — the `beforeSend` passed to the first write is not passed to the reset (`writeOne` for the reset receives `() => undefined`).
    - `a pulse in a batch uses one sum write for the call and a plain write for the reset` — `writeMany` once, `writeOne` once.
    - `pulse bounds` — 10 and 5000 accepted.
- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors, then assertion failures.
- [ ] **Step 3: Implement.** `adsWrite.ts` provides `sleep` (`setTimeout`), `now` (`performance.now`) and `readBefore` (`host.read`, errors turned into the `error` field).
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: CHANGELOG:** `- `ads_write` can pulse a command bit: `pulseMs` (10-5000) writes a BOOL, waits, then writes the opposite value after one confirmation, so a start does not depend on the PLC resetting the bit. The timing is kept by the extension and is not cycle-exact; the result says how long the bit was held and, if the reset failed, that it may still be set.`
- [ ] **Step 6: Commit**

```bash
git add extension
git commit -s -m "Add pulse mode to ads_write" -m "A command start should not depend on the PLC resetting the bit. The reset is always attempted, also after a cancel or when the first write's outcome is unknown, and a failed reset is reported with the symbol that may still be set; the timing lives in the extension and the result says it is not cycle-exact."
```

---

### Task C6a: Write journal

**Files:**
- Create: `extension/src/core/writeJournal.ts`; Test: `extension/test/writeJournal.test.ts`
- Modify: `extension/src/core/writeExec.ts`, `toolInput.ts` (`journal: true`), `mcpTools.ts`, `extension/src/ads/host.ts` (`readonly journal = new WriteJournal()`), `adsTools.ts` (`journal()`), `adsWrite.ts`, `lmTools.ts`, `package.json`, `CHANGELOG.md`
- Test also: `writeExec.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface JournalEntry {
    seq: number; time: number; targetKey: string; symbol: string;
    oldValue: string | null; oldValueError?: string;          // value read just before the write
    newValue: string; outcome: 'written' | 'unknown';
    via: 'MCP' | 'Copilot'; kind: 'write' | 'restore'; restored?: boolean;
    pulse?: boolean; persistent?: boolean;                    // persistent: C7b
  }
  export class WriteJournal {
    constructor(maxEntries = 500, now: () => number = Date.now);
    record(e: Omit<JournalEntry, 'seq' | 'time'>): void;
    entries(targetKey?: string): JournalEntry[];              // oldest first
    dropped(): number;                                        // entries cut by the cap
    markRestored(symbols: string[], targetKey: string): void;
  }
  export function journalText(entries: readonly JournalEntry[], opts: { target: string; dropped: number; clock: (ms: number) => string }): string;
  // WriteInput gains { journal: true }; AdsToolFns gains journal(): ToolText
  ```
- What is recorded: every item of an executed AI write with outcome `written` or `unknown` (not `notWritten`, not a refused op), with the old value read right before the write by `readBefore` (a failed read gives `oldValue: null` and `oldValueError`; the write is never blocked by it). Writes of the user in the ADS Watch view (`views/adsWatch.ts:207`) are not AI writes and are not journaled. The journal is per window and in memory (a window reload empties it; see Open decisions).
- Text (pin): `Writes through the ADS tools in this session on A:851 (3):` then one line per entry `10:15:02  MAIN.nMode: 1 -> 2`, `10:15:02  MAIN.bStart: FALSE -> TRUE (pulse)`, `10:15:09  MAIN.nSet: outcome unknown, wanted 7 (was 3)`, a restore entry `10:20:00  MAIN.nMode: 2 -> 1 (restore)`, a restored write ends with ` [restored]`, an unreadable old value `MAIN.sText: ? -> abc (old value not read: link down)`; a cut journal adds `(12 older entries dropped)` at the end; empty: `No writes through the ADS tools in this session on A:851.`
- `journal: true` is read-only: it needs no gate, no AI-write permission and no confirmation; in Copilot `prepareInvocation` returns only an `invocationMessage` for it and `invoke` returns the text. Exactly one of `symbol`+`value`, `writes`, `journal`, `restore` is allowed: `use either symbol and value, writes, journal or restore`.

- [ ] **Step 1: Write the failing tests**
  - `writeJournal.test.ts`: `records in order with sequence numbers and times from the clock`; `the cap drops the oldest and counts them`; `entries filters by target`; `markRestored flags every entry of the symbols on that target only`; `journalText pins every line form above` (including the unknown, pulse, restore, unreadable-old-value and dropped lines and the empty text).
  - `writeExec.test.ts`: `a written item is journaled with the old value read before the write` (`calls`: `readBefore` precedes `writeOne`); `a failed old-value read is journaled with the error and does not block the write`; `a not-written item is not journaled`; `an unknown item is journaled as unknown`; `a batch journals every written item once`; `a pulse item is journaled once, flagged pulse`; `a refused op is not journaled`.
  - `toolInput.test.ts`: `journal: true is a call of its own` (`{ journal: true }` -> `{ ok: true, value: { journal: true } }`; with `symbol` -> the exclusive-forms error; `journal: false` is treated as absent).
  - `mcpTools.test.ts`: `ads_write journal reaches no gate and returns the journal text` (`r.sent.length === 0`, `isError` false, also when the decision is `refuse`).
- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors.
- [ ] **Step 3: Implement**; `executeWrite` calls `readBefore` for every item (C4 only did so for the pulse symbol) and records through an optional `journal` in `ExecDeps` (`record(entry)`); `adsWrite.ts` passes `host.journal`.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: CHANGELOG:** `- `ads_write` with `journal: true` lists what the AI wrote in this window (time, symbol, old and new value, pulses, unknown outcomes), without a confirmation.`
- [ ] **Step 6: Commit**

```bash
git add extension
git commit -s -m "Keep a journal of AI writes with the old values" -m "A test session changes many variables and the user must be able to see and undo them. The old value is read just before each write; a failed read never blocks the write and the journal stays in memory per window."
```

---

### Task C6b: Restore

**Depends on C6a, C3c** (a restore of several values is one batch).

**Files:**
- Modify: `extension/src/core/writeJournal.ts` (`planRestore`), `writeText.ts` (`restoreText`), `toolInput.ts` (`restore: true`), `writeGate.ts` (`WriteOp.restore`), `writeExec.ts`, `mcpTools.ts`, `extension/src/ads/adsTools.ts` (`restorePlan`), `lmTools.ts`, `package.json`, `CHANGELOG.md`
- Test: `writeJournal.test.ts`, `writeText.test.ts`, `writeExec.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RestorePlan { writes: WriteItem[]; skipped: { symbol: string; reason: string }[]; remaining: number }
  /** Reverse-chronological: per symbol the oldest not yet restored write decides the value to restore. `current` = result of a read of every journaled symbol (error text per symbol when it cannot be read now). */
  export function planRestore(entries: readonly JournalEntry[], targetKey: string, current: ReadonlyMap<string, string | undefined>, max?: number /* 20 */): RestorePlan;
  // WriteOp.restore?: boolean   // dialog header "Restore"; the journal marks the symbols restored after the batch
  // WriteInput { restore: true }; AdsToolFns.restorePlan(): Promise<RestorePlan>
  ```
- Rules: only `kind: 'write'` entries not yet `restored` on this `targetKey` count (entries of another target are listed as skipped: `MAIN.x: written on another target (B:851)`); `outcome: 'unknown'` entries count (the old value is still the wanted one); per symbol the first (oldest) entry's `oldValue` wins; `oldValue: null` is skipped with `old value was not read (<oldValueError>)`; a symbol `current` reports as unreadable is skipped with `cannot be read now: <error>` (renamed by a rebuild, target restarted without it); more than `max` writes: the first 20 are planned and `remaining` counts the rest (the text says to call restore again). The restore goes through the gate as one op: `items` = the plan, `restore: true`, so the dialog is `Restore 2 values on A:851 (ws)?\nMAIN.a := 1\nMAIN.b := 2` (`confirmMessage` takes an optional `restore` flag) and the allow-list (C7a) applies. One item uses the single path (protocol 1 compatible); several need `writeMany`.
- Texts (pin): nothing to do: `Nothing to restore: no AI write of this session is left that has a known old value on A:851.`; after the gate, `writeResultText` for a restore op adds a footer built by `restoreText(plan, result)`: `Skipped (not restored): MAIN.c (old value was not read (link down)), MAIN.d (cannot be read now: Symbol 'MAIN.d' not found)` and `2 more writes are left in the journal; call restore again.`; the item lines are the batch lines of C3b.
- Order inside the tool call: `plan = await tools.restorePlan()` (reads the current values with `host.read`, builds the plan), empty -> text without a gate call, else `gate.run(op)`; after a `done` result the symbols of `written` items are `journal.markRestored`; restore writes are journaled with `kind: 'restore'` and never planned again.
- Copilot: `prepareInvocation` builds the plan (it may be async) and stores `restoreKey = writeKey of the plan items` under the input key; `invoke` rebuilds the plan and refuses with `the journal changed after the confirmation was shown; call restore again` when the keys differ.

- [ ] **Step 1: Write the failing tests**
  - `writeJournal.test.ts` (fixed entries, `current` map): `restore takes the oldest old value per symbol and the newest first order` (entries MAIN.a 1->2, MAIN.a 2->3, MAIN.b 7->8 -> writes `[MAIN.b := 7, MAIN.a := 1]`); `unknown outcomes are restored too`; `an unread old value is skipped with its reason`; `a symbol that cannot be read now is skipped, the others stay` (the "PLC restarted / rebuild renamed it" case, Review Focus 5); `entries of another target are skipped with a reason`; `restored and restore entries are not planned again`; `more than 20 writes plan 20 and report the rest`.
  - `writeText.test.ts`: the exact texts above, including the dialog header `Restore 2 values on A:851 (ws)?\nMAIN.b := 7\nMAIN.a := 1`.
  - `writeExec.test.ts`: `a restore op marks the written symbols restored and journals the writes as restore`; `a restore item that was not written stays unrestored`.
  - `mcpTools.test.ts`: `restore with nothing to do returns the text and never reaches the gate`; `restore goes through the gate as one op with the restore flag`; `restore of several values on a protocol-1 host says needs a newer iecode CLI: batch write`; `restore with the journal empty`.
  - `toolInput.test.ts`: `restore: true is a call of its own` and exclusive with the other forms.
- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors.
- [ ] **Step 3: Implement** `planRestore`, `restoreText`, the `restore` form in `mcpTools.ts` and `lmTools.ts`, and `adsTools.restorePlan` (`host.read` of the journaled symbols, one request).
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: Manifest:** `journal` (boolean) and `restore` (boolean) on `iecode_ads_write`, described as: `journal: true lists what was written in this session (read-only, no confirmation). restore: true writes the old values of this session's writes back after one confirmation, newest write first, at most 20 per call, and lists what cannot be restored.` CHANGELOG: `- `ads_write` with `restore: true` writes the old values of this session's AI writes back after one confirmation and lists what could not be restored (for example a variable that no longer exists after a rebuild).`
- [ ] **Step 6: Commit**

```bash
git add extension
git commit -s -m "Add restore of a session's AI writes" -m "After a test session the user wants the machine back as it was. The restore is an ordinary confirmed batch, skips what cannot be restored with a stated reason instead of failing the whole batch, and never plans its own writes again."
```

---

### Task C7b: Persistent and configuration guard

**Step 0 is a check, then one of two variants is built** (user decision 2, 2026-11-09: look at the build output first; if it does not mark persistent symbols, the user lists path prefixes in a setting). The shared part is built in both cases.

**Files:**
- Modify: `extension/src/core/writePolicy.ts`, `writeGate.ts` (`WriteOp.persistent?: string[]`), `writeText.ts`, `toolInput.ts` (`confirmPersistent`), `writeJournal.ts` (`persistent`), `mcpTools.ts`, `extension/src/ads/adsTools.ts` (`persistentOf`), `aiSettings.ts`, `lmTools.ts`, `package.json`, `CHANGELOG.md`; variant A also `extension/src/core/adsinterface.ts`
- Test: `writePolicy.test.ts`, `writeText.test.ts`, `toolInput.test.ts`, `mcpTools.test.ts`, `writeJournal.test.ts`; variant A also `adsinterface.test.ts` (use the existing fixture style)

- [ ] **Step 0: Check the build output.** Build a test PLC project that has a `VAR_GLOBAL PERSISTENT` variable, a `VAR PERSISTENT` variable inside a program, an ordinary variable and an `AT %I*` input mapping; open the built `.tmc` and run `fromTmc` (`extension/src/core/adsinterface.ts:97`) over it. Record in "C1 findings" (new subsection "C7b check"): (a) which XML element or property of the `.tmc` differs for the persistent variables, if any; (b) the `area` value `fromTmc` gives for each of the four variables (`AdsSymbol.area`); (c) the `ISymbol.IsPersistent` result of C1's item 9. **Decision rule:** the build output "marks persistent symbols" only if one marker (a property, flag or area) is present for every persistent variable and absent for the ordinary one. Yes: build variant A below; no: variant B only. Do not build both sources unless the check shows partial coverage (then A plus B).
- **Shared interfaces:**
  ```ts
  export interface WritePolicySettings { allowedPaths: string[]; persistentPaths?: string[] }   // persistentPaths: variant B
  /** Symbols of `symbols` that are persistent or guarded: by the build marker (variant A, lower-case names) or by path prefix (variant B, same prefix rule as the allow-list). */
  export function persistentIn(symbols: readonly string[], s: { persistentPaths?: string[]; buildPersistent?: ReadonlySet<string> }): string[];
  export function persistentRefusal(persistent: readonly string[]): string;
  // WriteInput: confirmPersistent?: boolean on the single and the batch form
  // AdsToolFns.persistentOf?(symbols: string[]): Promise<string[]>
  ```
- Behaviour: for an op with persistent symbols and no `confirmPersistent: true` the tool layer refuses before the gate: `Not written: MAIN.nCfg is PERSISTENT data (it survives a PLC restart). Call again with confirmPersistent: true if the user asked for this write.` (several: `MAIN.nCfg, MAIN.nOther are PERSISTENT data (they survive a PLC restart). Call again with confirmPersistent: true if the user asked for these writes.`); with the flag the op carries `persistent: [...]` and the dialog gets one line per symbol, `PERSISTENT: MAIN.nCfg survives a PLC restart.`, after the item lines (`confirmMessage` takes the list), also in Copilot's confirmation; the journal entry has `persistent: true` and `journalText` appends ` [PERSISTENT]`. A restore (C6b) that touches persistent symbols needs `confirmPersistent: true` on the restore call. `confirmPersistent` never weakens the allow-list (C7a still refuses first).
- **Variant B (path-prefix setting, always built unless A covers everything):** setting `iecode.ads.persistentPaths` (array of string, default `[]`, `scope: application`): "Path prefixes of persistent or configuration data. AI writes to them are refused unless the call sets `confirmPersistent: true`, and the dialog marks them. Same matching as `iecode.ads.aiWritePaths`." `aiSettings.persistentPathsSetting()`.
- **Variant A (only if Step 0 says the build output marks them):** `AdsSymbol` gets `persistent?: boolean` set by `fromTmc` from the marker; `toSnapshot` and the CSV output stay unchanged (do not change `SNAPSHOT_FORMAT` output); `adsTools.persistentOf` reads the symbols of the built projects (`fromBuild`, as `ads_symbols` does) and returns the persistent ones, merged with variant B's prefixes.

- [ ] **Step 1: Write the failing tests**
  - `writePolicy.test.ts`: `persistentIn matches by prefix like the allow-list` (`['GVL.Cfg']` matches `GVL.Cfg.nX`, not `GVL.Config.nX`; empty list matches nothing); `persistentIn merges build markers (variant A)` (skip when variant A is not built); `persistentRefusal pins the single and the plural text`.
  - `writeText.test.ts`: `confirmMessage lists a PERSISTENT line per symbol` — `Write MAIN.nCfg := 5 on A:851 (ws)?\nPERSISTENT: MAIN.nCfg survives a PLC restart.` and for a batch the item lines first, then the PERSISTENT lines.
  - `toolInput.test.ts`: `confirmPersistent is an optional boolean on the single and the batch form` (non-boolean: `confirmPersistent must be true or false`); plain forms still deepEqual `{ symbol, value }`.
  - `mcpTools.test.ts`: `a write to a persistent symbol without confirmPersistent is refused before the gate` (exact text above, `r.sent.length === 0`); `with confirmPersistent the op carries the persistent list and reaches the gate once`; `a write outside the allowed paths is refused first even with confirmPersistent`.
  - `writeJournal.test.ts`: `the journal marks persistent entries and journalText shows [PERSISTENT]`.
- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile errors.
- [ ] **Step 3: Implement** the shared part, then the variant(s) decided in Step 0.
- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.
- [ ] **Step 5: Manifest and CHANGELOG:** `confirmPersistent` (boolean) on `iecode_ads_write` ("Set to true only when the user explicitly asked to write persistent or configuration data; such writes are refused without it."); setting `iecode.ads.persistentPaths`. CHANGELOG: `- AI writes to persistent or configuration data are refused unless the call sets `confirmPersistent: true`; the confirmation then marks the variable as PERSISTENT and the write journal lists it. List the affected path prefixes in `iecode.ads.persistentPaths` (the build output does not mark them)` (adapt the last clause to the Step 0 result).
- [ ] **Step 6: Commit**

```bash
git add extension docs/superpowers/plans/2026-11-09-ads-wishlist-c-writes.md
git commit -s -m "Refuse persistent writes unless the call confirms them" -m "A persistent value survives a PLC restart, so a test session must not change it by accident. The marker comes from the build output when it has one (checked first, as decided); otherwise the user lists path prefixes."
```

---

### Task C8: Release

**Files:** `extension/CHANGELOG.md`, `docs/ads-mcp-wishlist.md`, `extension/test/hostProtocol.test.ts`, `cli/README.md`

- [ ] **Step 1: Freeze protocol 2.** Failing test first in `hostProtocol.test.ts`: `entry 2 is pinned: a released protocol never changes` with the exact `PROTOCOL_TABLE[2]` content (including any feature that D or E tasks added to the unreleased entry before the release). Run `cd extension && npm test` (passes at once if the entry is final; the test is the guard against later edits).
- [ ] **Step 2: Full suites, one after the other.** `cd extension && npm test`; then in PowerShell `dotnet test cli/tests/IECode.Core.Tests`; then `dotnet test cli/tests/IECode.Automation.Tests`. Expected: all green, nothing else running.
- [ ] **Step 3: Manual check against a simulation target** (record the outcome in the PR; the target is a local TwinCAT runtime with generic test variables `MAIN.bStart BOOL`, `MAIN.nMode INT`, `MAIN.nSet INT`, `MAIN.sText STRING`, a variable the PLC program resets itself, a persistent one):
  1. Current CLI and extension, `iecode.ads.aiWrites = confirm`: `ads_write { symbol, value }` shows the old dialog text and the old result.
  2. `ads_write { writes: [3 items] }`: one dialog listing all three; result header `Sent in one ADS request (3 writes): 3 written.`; the three values are on the PLC.
  3. A batch with one bad value (`zz` for an INT): nothing written, text names `writes[1] ...`.
  4. A batch with a stale or unknown symbol: nothing written, text names the item.
  5. `pulseMs: 200` on a BOOL: bit is set, then reset; the text shows the measured hold time. A pulse on an INT is refused. A pulse on the bit the PLC program resets itself shows the PLC's change correctly (C5 text when it differs).
  6. `journal: true` lists the writes with old values; `restore: true` shows one dialog and puts the old values back; a symbol removed by a rebuild is listed as skipped.
  7. `iecode.ads.aiWritePaths = ["MAIN.Sim"]`: a write to `MAIN.nMode` is refused without a dialog; a batch with one outside symbol is refused as a whole.
  8. Persistent symbol: refused without `confirmPersistent`, dialog shows the PERSISTENT line with it.
  9. **Older CLI:** put the previously released CLI in `iecode.cliPath`; `ads_read`, `ads_watch`, `ads_wait` and a single `ads_write` work; a batch answers `Not written: this needs a newer iecode CLI: batch write (installed: ADS host protocol 1, needed: 2). Update it with "IECode: Install CLI…".` and opens no dialog.
  10. **Newer CLI:** a protocol-3 host (or a test double that sends `{"event":"hello","protocol":3}`) is refused with `Update the extension.`
  11. Restart the host (change the target setting back and forth) and repeat 9: the capabilities do not leak from the previous host.
  12. The still-open `ads_wait` live check of the master plan: `ads_wait` on a changing value, in the same session.
- [ ] **Step 4: Wishlist.** In `docs/ads-mcp-wishlist.md` move the rows "`ads_write` with several symbols in one call", "Pulse mode", "Read-back text...", "List what a session wrote ... restore", "Allow-list of path prefixes (name: `iecode.ads.aiWritePaths`)" and "Refuse PERSISTENT or configuration writes" to **Done**, with the test names and counts of `npm test` and `dotnet test`; fix the allow-list row's setting name. Keep "Same-cycle write" as Out of scope and "Show the connected target in every tool result header" untouched (Plan B).
- [ ] **Step 5: CHANGELOG** has the lines of C3c, C4, C5, C6a/b, C7a/b (already added per task); add under `### Setup` or `### Claude Code and ADS`: `- The extension accepts an older iecode CLI: only the features the CLI lacks (batch write) are switched off, with a message that names the feature. A CLI newer than the extension is refused with "Update the extension".`
- [ ] **Step 6: Commit**

```bash
git add extension/CHANGELOG.md docs/ads-mcp-wishlist.md extension/test/hostProtocol.test.ts cli/README.md
git commit -s -m "Release the ADS write tools: batch, pulse, journal, restore, guards" -m "Protocol 2 is frozen with a pin test so later CLI work cannot change what the released version means. The wishlist rows move to Done with their tests and the manual check against a simulation target is recorded."
```

---

## C1 findings

_To be filled in by task C1. Each row: the question, the observed result, the date and SDK version, and which later task statement depends on it._

| # | Question | Observed | Used by |
|---|---|---|---|
| 1 | Exact `SumSymbolWrite` overload, value passing, result type, `SumFallbackMode` members | | C2 (`BeckhoffLink.PrepareWrite`, `ISymbolWrite`) |
| 2 | Result count and order for 1, 2, 20, 200 items | | C2 step (4), C3c `writeManyStage` alignment check |
| 3 | Per-item codes and whether the other items were written | | C2 `NoEffectCodes` |
| 4 | Which codes are device-made, which SDK-made | | C2 `NoEffectCodes` |
| 5 | Aggregate failure: `Failed`, code, per-item results present?, any code that provably precedes every sub-write | | C2 `NotSentAggregateCodes`, C3b texts for `unknown` |
| 6 | Splitting above which size; ADS request count for 20 / 200 / 1000 | | C3c "one ADS request" claim, `MaxWrites = 20` |
| 7 | Behaviour with the "none" fallback mode | | C2 `BeckhoffLink.PrepareWrite` |
| 8 | Duration of a 20-item write and read-back | | host request timeout (`REQUEST_MS`) |
| 9 | Online `IsPersistent` / flags for persistent and `%I*` variables | | C7b Step 0 |
| 10 | Decision: `NoEffectCodes`, `NotSentAggregateCodes`, "per-item results survive an aggregate failure" | | C2 |

Statements in this plan that depend on these rows: C2 (`BeckhoffLink` construction, both code sets, count-mismatch handling), C3b/C3c (the words "one ADS request" and the `notWritten` examples), C7b Step 0 (row 9), C8 check 4.

## Open decisions

1. **Journal lifetime:** in memory per window (a reload empties it) versus saved in `workspaceState`. Recommendation: in memory. A restore after a reload would act on values the user no longer remembers, and a stale persisted journal could write old values onto a target that has moved on.
2. **Old-value read before every AI write:** the journal needs it, and it adds one ADS read request per write call (single or batch). Recommendation: keep it for every write (also gives the type check of pulse). If the user dislikes the extra request, the alternative is to read only when `journal` or `pulseMs` is used, which loses the old value of ordinary writes.
3. **Read-back note beyond BOOL (C5):** today only a BOOL that reads back as the opposite gets the "changed by the PLC" wording, because the existing tests pin the other types. Recommendation: BOOL only for now; extend to integers and REAL (setpoints the PLC clamps) in a later change that updates the two pinned examples.

## Self-review

- **Spec coverage:** wishlist section 5 (batch, same-cycle excluded, pulse, read-back, journal/restore) = C3a-c, C4, C5, C6a/b; section 8 allow-list = C7a, persistent = C7b, "target in every result header" belongs to Plan B; the prerequisite of every CLI plan = C0; SDK contract (D21) = C1; D9/D10/D14/D21/D23 = C0, C1, C2, C3b, C3c; user decisions 1 (one ADS request, texts never say same cycle: C3b header, manifest text) and 2 (check build output first: C7b Step 0).
- **Types across tasks:** `WriteItem` (C3a, `pulseMs` added in C4), `WriteItemResult` (C3a, `pulse` added in C4), `WriteOp.items`/`restore`/`persistent` (C3a, C6b, C7b), `WriteResult.done` (C3a), `ExecDeps` (C3c, extended in C4 and C6a), `HostCaps`/`negotiate`/`featureOf` string `'writeMany'` (C0, C2, C3a, C3c), TS item statuses `written | notWritten | unknown` equal the C# `WriteStatus` constants, TS `value`/`readBackError`/`error`/`adsCode` equal the C# `WriteManyItem` members in camelCase.
- **Placeholders:** the only open items are marked `[C1]` and the "C1 findings" table; tests that say `/* ... */` list their exact assertions in the sentence before them and follow the pattern of the shown test in the same step.
- **Contradictions found in the code:** `writeResultText` lives in `extension/src/core/writeGate.ts:83`, not in `adsToolText.ts`; the wishlist names the allow-list setting `iecode.ads.aiWrites`, which already is the off/confirm/auto mode (this plan uses `iecode.ads.aiWritePaths`); the hello check is at `host.ts:365`, not `:338`; the rough plan's `WriteManyResult` became `IReadOnlyList<WriteManyItem>`; `ads_write`'s manifest `required` (`symbol`, `value`) must go for the `writes` form; existing tests pin `WriteOp` with `deepEqual` (`mcpTools.test.ts:122`) and the read-back text with differing values (`writeGate.test.ts:425`, `mcpTools.test.ts:120`), so `items` is optional and C5 is BOOL only; `adswatch.test.ts:22` asserts `PROTOCOL === 1` and changes with C2.
