# Plan B: Watch List Management

> **For agentic workers:** rough sub-plan of the [master plan](2026-11-09-ads-wishlist-master-plan.md). Expand each task into TDD steps with superpowers:writing-plans before building it.

**Goal:** The AI manages its part of the watch list with small results, groups, a way to clean up, and a list that survives a restart.

**Architecture:** All list changes already go through `WatchList` (`extension/src/core/watchList.ts`, the serialized owner with wait holds). Groups, persistence and removal rules are added there as pure logic; `adsTools.ts` and `host.ts` only wire. No CLI change.

**Tech Stack:** TypeScript, `node --test`.

**Spec:** [wishlist sections 4 and 8](../../ads-mcp-wishlist.md), roadmap Phase 1.

## Global Constraints

See the master plan. In addition: an entry the user added is never removed by the AI without a user confirmation; wait holds keep their entries until the waits end.

## Review Focus

1. A group switched off while a wait holds one of its symbols: the entry stays until the wait ends.
2. A symbol in two groups: it is removed from the host list only when no enabled group contains it.
3. A persisted entry whose symbol no longer exists after a build: reported once, not retried every second.
4. `ads_watch {}` on a list of 55 entries still shows the full list; only add and remove calls get the short result.
5. The user declines the confirmation to remove their own entry: the entry stays and the result says so.

## File Structure

- `extension/src/core/watchList.ts`: groups, `clearAi`, persistence snapshot and restore.
- `extension/src/core/adsToolText.ts`: `watchResultText` (diff form), group lines.
- `extension/src/core/toolInput.ts`: `parseWatchInput` gains `list`, `group`, `enable`, `clearAi`, `force`.
- `extension/src/ads/adsTools.ts`, `host.ts`, `extension/package.json`: wiring, confirmation, storage.
- Tests: `extension/test/watchList.test.ts`, `adsToolText.test.ts`, `toolInput.test.ts`.

## Tasks

### B1: Diff result and `list` option (roadmap Phase 1)

**Interfaces:** `ads_watch` input `list?: boolean`; result lines `Added: …`, `Removed: …`, `Not removed (added by the user): …`, per-item errors of added symbols, `Watch list: N symbols`. Empty call or `list: true` returns the full list as today; the failure path keeps the full list.

### B2: Clear the AI-added entries and remove user entries after confirmation

**Interfaces:** `ads_watch { clearAi: true }` removes every AI-added entry that no wait holds; `ads_watch { remove: [...], force: true }` asks the user once through a confirmation dialog (injected callback, like the write gate) before removing entries the user added.

### B3: Named groups

**Interfaces:** `add` gets an optional `group: string`; `ads_watch { group: "T1", enable: false | true }` switches a group; `remove` with `group` and no symbols removes the whole group. `WatchList` keeps `groups: Map<string, Set<string>>`; the host list is the union of enabled groups plus ungrouped entries.

### B4: Persist the AI watch list, report entries that no longer resolve

**Interfaces:** `WatchList.snapshot(): StoredList` and `restore(s: StoredList)`; stored in `workspaceState`; after restore the first `watch` reply's item errors name entries that do not resolve, once, with the hint to rebuild or remove them.

### B5: Connected target in every result header

**Interfaces:** one helper `targetHeader(target: string): string` in `adsToolText.ts` used by watch, write and wait results (reads already print `Values on <target>:`).

### B6: Release

CHANGELOG entry; wishlist rows to Done; manual check with an XAE/VS Code restart (persistence) against a simulation target.

## Order

B1 → B5 → B2 → B3 → B4 → B6. B1 and B5 are small and ship first; B3 depends on the B2 removal rules.
