# Small Items Master Plan (2026-11-17)

> **Status: master plan; the sub-plans A to D are TDD plans.** Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Branch: `feature/ads-state-and-tree-filter` (from `feature/ads-local-netid`).

**Goal:** Build four small items from the priority list in `TODO.md`: the expiry of auto-approved AI writes, a notice when sampling had a hole, the `ads_state` tool, and a filter for the project tree.

**Architecture:** Same rules as the ADS wishlist plans: decisions in pure `extension/src/core/` modules with node tests, `src/ads/` and `src/views/` only wire, every ADS tool declared once in `extension/package.json`. CLI changes join the still unreleased ADS host protocol entry 2.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads`.

**Spec:** the priority list in [TODO.md](../../../TODO.md) ("Priorities: small items worth doing next", items 2, 3, 4 and 7) and the wishlist [ads-mcp-wishlist.md](../../ads-mcp-wishlist.md) (sections 2, 7 and 8).

## Global Constraints

- Public repository: no internal names, symbol paths or data in code, tests, docs or commits. Commits: English subject plus a 1-3 sentence why-body, GitHub noreply address as author and `Signed-off-by` (`git commit -s`). Cosmetic changes in separate commits.
- `npm test` (in `extension/`) green after every task; C# tests only through the PowerShell tool, build and test as separate commands, nothing heavy in parallel. A running `iecode mcp` locks `cli/src/IECode.Cli/bin`; build the test projects only in that case, or stop the MCP server first.
- Old tool calls keep byte-identical results unless a sub-plan names the change (Plan B adds notice lines only when an event happened; Plan A changes the `auto` behavior and the ADS Watch view description).
- Every user-visible change gets a CHANGELOG line under `## Unreleased`.

## Sub-plans

| Plan | Item | CLI | Size `[estimated]` |
|---|---|---|---|
| [A](2026-11-17-small-items-a-auto-write-expiry.md) | Auto-approved AI writes expire after `iecode.ads.aiWritesAutoMinutes` (default 60) | no | 0.5 day |
| [B](2026-11-17-small-items-b-sampling-notice.md) | Notice in the tools, the ADS Watch view and the ADS Scope after a connection loss, a reload or a stop | yes (additive `reloaded` event) | 1 day |
| [C](2026-11-17-small-items-c-ads-state.md) | New tool `ads_state`: PLC run state, TwinCAT system state (router port 10000), cycle time and counter, restart and online change detection | yes (op `state`) | 1 day plus 30 min on a simulation |
| [D](2026-11-17-small-items-d-tree-filter.md) | Filter the project tree by name words and `@kind` | no | 0.5 day |

Plans B and C supersede tasks E3 and E4 of [Plan E](2026-11-09-ads-wishlist-e-runtime-and-plc.md); they take over its amendments where still valid and say where they differ.

## Order

```
1. Plan D   extension only, independent of the ADS code
2. Plan A   extension only; touches adsWatch.ts and lmTools.ts
3. Plan B   CLI event, then extension; touches host.ts, adsTools.ts, adsWatch.ts, adsScope.ts
4. Plan C   CLI op, then extension; touches host.ts, adsTools.ts, lmTools.ts, hostProtocol.ts, package.json
```

Why: D and A need no PLC and no CLI and ship value at once. B before C because both touch `host.ts` and `adsTools.ts`, and B is the smaller change. B and C both end with a manual check on a simulation target; they can share one session.

## Decisions (planner, 2026-11-17; the user delegated every decision)

1. **Auto expiry (A):** fixed window from arming, not sliding; expired means "confirm", never "off"; the arming time is a user setting written only by **IECode: Set AI Write Access…**, because `globalState` is not shared live between windows; a time further ahead than the window counts as not armed.
2. **Sampling notice (B):** notice only, no keep-alive (it would keep the full sampling load running and needs a reproduction first); an explicit `reloaded` event from the CLI so a download with an unchanged list is visible; cursor by event id. Expected notices per case come from earlier measurements (route cut, download, PLC restart), listed in Plan B; online change is unmeasured and part of its manual check.
3. **`ads_state` (C):** joins protocol entry 2 (unreleased); a 32-bit counter drop near the top is reported as "restart or wrap", a count that rose too little as "stopped or restarted in between"; no "everything is reset" claim; the TwinCAT system state is read with `ReadState` on the router port 10000 (answers on every TwinCAT PC), so config mode, a stopped PLC and an unreachable target are told apart.
4. **Tree filter (D):** `@kind` words plus name words; object names only (members and libraries later); live input box; session only.

## Not in scope

- Keep-alive of sampling after the last AI call (Plan E decision 8): a TODO item only if the H1 reproduction in Plan B confirms the idle stop as the cause.
- Searching member names and library sources in the tree filter.
- Per-symbol rates, alarms, PLC-cycle timestamps (Plan E, E2, E6, E7).

## Definition of done

- All four sub-plans' "Done when" lists fulfilled.
- `TODO.md`: priority items 2, 3, 4 and 7 ticked; the wishlist rows of sections 2, 7 and 8 updated with the test names.
- One pull request per plan or one for the branch; CLI changes need the CLI release that freezes protocol entry 2 (C8 of the 2026-11-09 master plan).

## First action

Start Plan D, Task 1: write `extension/test/treeFilter.test.ts`.

## Prior measurements used (2026-11-18)

Measurements from an earlier ADS project on simulation targets (October 2026) were taken into Plans B and C, without code, names or data: which ADS codes and symbol-version changes a route cut, a download and a PLC restart produce; that port 10000 answers `ReadState` on every TwinCAT PC; and that a bare TCP connect to the router port 48898 breaks concurrent ADS connections on that PC, so no plan probes router ports. Not covered there: the PLC task counters (`_TaskInfo`, `OnlineChangeCnt`) and online changes; Plan C step 1 and Plan B's manual check measure them.
