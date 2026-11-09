# Plan C: Writes, Journal, Restore and Write Safety

> **For agentic workers:** rough sub-plan of the [master plan](2026-11-09-ads-wishlist-master-plan.md). Expand each task into TDD steps with superpowers:writing-plans before building it. C0 must be built before any other CLI-touching task of the master plan.

**Goal:** An agent sets several values in one confirmed call, can pulse a command bit, sees why a bit reads back differently, can undo a test session's writes, and cannot write outside an allowed area.

**Architecture:** The extension keeps the write gate (`extension/src/core/writeGate.ts`); the CLI watch host gets a `writeMany` op (one ADS sum write). C0 adds the protocol version table first. Pure decisions (batch result model, journal, allow-list, guard) live in `extension/src/core/`.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads` 7.0.389.

**Spec:** [wishlist section 5 and 8](../../ads-mcp-wishlist.md), roadmap Phase 4 (D9, D10, D21), roadmap Global Constraints (D14, D23).

## Global Constraints

See the master plan. In addition:

- "Sent in one ADS request" is the promise; never "same cycle" (user decision, same-cycle write is in `TODO.md`).
- The sum write uses no fallback to single writes.
- The conservative outcome is `unknown`: "Not written" only with proof from the host.

## Review Focus

1. One bad value in a batch: nothing is sent, reason per item.
2. A timeout after sending: every item is `unknown`, none `written`.
3. A read-back failure after a successful write: the item stays `written`.
4. A pulse whose second write fails: the result says the bit may still be set and names the symbol.
5. Restore after the PLC restarted: values that cannot be written back are listed, not skipped silently.

## File Structure

- `cli/src/IECode.Core/Ads/WatchProtocol.cs`, `WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`, `AdsLink.cs`: `WriteMany`, prepare/send split, protocol bump.
- `extension/src/ads/host.ts`: version table, feature gating, `writeMany` request.
- `extension/src/core/writeGate.ts`, `adsToolText.ts`, `toolInput.ts`: batch form, texts, input.
- `extension/src/core/writeJournal.ts` (new): journal, restore list.
- `extension/src/core/writePolicy.ts` (new): allow-list and persistent guard.
- `extension/src/ads/adsWrite.ts`, `lmTools.ts`, `mcpTools.ts`, `package.json`: wiring, Copilot confirmation text.
- Tests on both sides: `AdsWatchBackendTests`, `writeGate.test.ts`, `writeJournal.test.ts`, `writePolicy.test.ts`.

## Tasks

### C0: Protocol version table (prerequisite for every CLI task)

**Interfaces:** `PROTOCOL_TABLE: Record<number, { ops: string[]; features: string[] }>` in `host.ts`, immutable entries; `host.supports(feature: string): boolean`; hello with protocol 1..own is accepted, a newer host is refused with "update the extension"; a missing feature gives "needs a newer iecode CLI: <feature>"; capabilities reset on every host start. Tests: protocol-1 host with scalar read/write/watch/wait works, new feature reports "needs a newer CLI", current host works, newer host refused (roadmap T7).

### C1: SDK contract check for `SumSymbolWrite` (spike, about 2 h)

Against a simulation target with the pinned SDK: result count and order, which codes come from the device and which the SDK synthesizes, aggregate result on whole-request failure, whether item results survive it, whether the SDK splits a large request. Write the findings into this file under "C1 findings"; C2's result model claims only what they prove.

### C2: `writeMany` in the CLI

**Interfaces:** `IWatchBackend.WriteMany(IReadOnlyList<(string Symbol, string Value)>): WriteManyResult`; `AdsLink` splits conversion into `Prepare(text) → bytes` and a send step; all values are prepared first (any failure → `WriteNotSentException` for the whole batch); then one sum write, then one sum read-back. Protocol bump with C0's table entry. xUnit with a fake link: bad value sends nothing; per-item device code → only that item `notWritten`; unclassified code or wrong result count → `unknown`.

### C3: Batch write in the extension

**Interfaces:** `ads_write` accepts exactly one of `{ symbol, value }` or `{ writes: [{ symbol, value }, …] }` (1-20 items, duplicates and both forms refused before the dialog); `WriteResult` gets the batch form (`refused` / `unknown` / `done` with per-item `written` / `notWritten` / `unknown`); one confirmation dialog lists every write (also in Copilot's `prepareInvocation`, and `writeKey` keys the whole batch); `writeResultText` lists every item, `writeResultIsError` is true when any item is not `written`.

### C4: Pulse mode

**Interfaces:** `ads_write` item option `pulseMs?: number` (BOOL only, 10-5000): write the value, wait, write the opposite value, all under the single confirmation. Result: `pulsed`, or a failure naming which half failed and that the bit may still be set. Timing is extension-side and says so in the text (not cycle-exact).

### C5: Read-back wording

**Interfaces:** `writeResultText` distinguishes `accepted by ADS, then changed by the PLC (read back FALSE)` from a rejection (host error). Pure text change plus tests; no protocol change.

### C6: Write journal and restore

**C6a (extension only):** `WriteJournal` records `{ symbol, oldValue, newValue, time, outcome }` for every written item (old value read by the gate before the write); a read-only call `ads_write { journal: true }` lists the session's changes.
**C6b (needs C3):** `ads_write { restore: true }` writes the old values back in reverse order as one batch through the gate, with its own confirmation, listing what cannot be restored.

### C7: Write safety

**C7a (extension only):** setting `iecode.ads.aiWritePaths` (array of path prefixes, empty = no restriction); `evaluateWritePolicy(symbol, settings): { allowed: boolean; reason?: string }` in `writePolicy.ts`; a refused item never reaches the dialog.
**C7b:** first check whether the `.tmc` marks persistent symbols (user decision: check first, otherwise a path-prefix setting `iecode.ads.persistentPaths`). Writes to such symbols need an explicit `confirmPersistent: true` plus the dialog line `PERSISTENT`; the journal lists them.

### C8: Release

CHANGELOG entries; wishlist rows to Done; manual check of batch write, pulse and restore against a simulation target.

## Order

C0 → C1 → C2 → C3 → C4, C5, C6b, C7b. C6a, C7a and C5 need no CLI and can ship earlier in the first release train.
