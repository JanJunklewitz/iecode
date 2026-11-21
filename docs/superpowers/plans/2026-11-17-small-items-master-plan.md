# Small Items Master Plan (2026-11-17)

> **Status: master plan; the sub-plans A to D are TDD plans, eng-reviewed 2026-11-18 (decisions R1 to R26 below are in the sub-plans).** Run them with superpowers:subagent-driven-development or superpowers:executing-plans. Branch: `feature/ads-state-and-tree-filter` (from `feature/ads-local-netid`) for A, B and C; Plan D on its own branch `feature/tree-filter` from `origin/main` (R8).

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
| [B](2026-11-17-small-items-b-sampling-notice.md) | Notice in the tools, the ADS Watch view and the ADS Scope after a connection loss, a reload or a stop | yes (additive `reloaded` event) | 1.5 days (grew with R2, R15 to R18) |
| [C](2026-11-17-small-items-c-ads-state.md) | New tool `ads_state`: PLC run state, TwinCAT system state (router port 10000), cycle time and counter, restart and online change detection | yes (op `state`) | 1.5 days plus 30 min on a simulation (grew with R1, R19 to R23) |
| [D](2026-11-17-small-items-d-tree-filter.md) | Filter the project tree by name words and `@kind` | no | 0.5 day |

Plans B and C supersede tasks E3 and E4 of [Plan E](2026-11-09-ads-wishlist-e-runtime-and-plc.md); they take over its amendments where still valid and say where they differ.

## Order

```
Lane 1 (branch feature/tree-filter from origin/main, own PR):
  1. Plan D   extension only; tree.ts, extension.ts, package.json
Lane 2 (branch feature/ads-state-and-tree-filter, stacked on the protocol 2 work):
  2. Plan A   extension only; aiSettings.ts, adsWrite.ts, lmTools.ts, adsWatch.ts
  3. Plan B   CLI event, then extension; WatchHost.cs, AdsWatchBackend.cs, host.ts, adsTools.ts, adsWatch.ts, adsScope.ts
  4. Plan C   CLI op, then extension; WatchHost.cs, AdsWatchBackend.cs, host.ts, adsTools.ts, lmTools.ts, hostProtocol.ts, package.json
  5. Simulation session (about 2.5 h): TODO.md priority 1 live check, Plan B Task 3 step 3, Plan C Task 1 step 1 and Task 2 step 5
```

Why: D and A need no PLC and no CLI and ship value at once; D shares no file with the protocol 2 stack except `package.json` and `CHANGELOG.md`, so it does not wait for that stack (R8). B before C because both touch `WatchHost.cs`, `AdsWatchBackend.cs`, `host.ts` and `adsTools.ts`, and C changes B's loss text (Plan B Decision 8). Plan C Task 1 step 1 (checking the system-info names, 30 min) needs the simulation before C is coded; it can run at the start of the shared session, the rest of C's checks at its end. The `TODO.md` priority 1 live check needs the same simulation and has no code, so it joins the session (R9).

Lanes 1 and 2 can run in parallel worktrees; inside lane 2 the order is fixed (shared files).

## Pull requests

1. Lane 1: one PR for Plan D from `feature/tree-filter`.
2. Lane 2 sits on 15 commits of the protocol 2 work (batch write, struct read, online symbols) that have no upstream PR yet. Open that PR first (from `feature/ads-local-netid`, its own master plan of 2026-11-09); then one PR for A to C from this branch, which GitHub shows as a diff against that base. CLI changes of B and C need the CLI release that freezes protocol entry 2 (C8 of the 2026-11-09 master plan), and that release waits for Plan C (R24): an older extension refuses a CLI with a higher protocol (`hostProtocol.ts:55-58`), so a later entry 3 would switch off every ADS tool of an older extension after a CLI update. If the release cannot wait, C detects the op by the host's `Unknown op 'state'.` reply instead of opening entry 3.

## Decisions (planner, 2026-11-17; the user delegated every decision)

1. **Auto expiry (A):** fixed window from arming, not sliding; expired means "confirm", never "off"; the arming time is a user setting written only by **IECode: Set AI Write Access…**, because `globalState` is not shared live between windows; amended by R13: the setting holds the arming time, a future one counts as not armed, and Off or Confirm clears it.
2. **Sampling notice (B):** notice only, no keep-alive (it would keep the full sampling load running and needs a reproduction first); an explicit `reloaded` event from the CLI so a download with an unchanged list is visible; cursor by event id. Expected notices per case come from earlier measurements (route cut, download, PLC restart), listed in Plan B; online change is unmeasured and part of its manual check.
3. **`ads_state` (C):** joins protocol entry 2 (unreleased); a 32-bit counter drop near the top is reported as "restart or wrap", a count that rose too little as "stopped or restarted in between"; no "everything is reset" claim; the TwinCAT system state is read with `ReadState` on the router port 10000 (answers on every TwinCAT PC), so config mode, a stopped PLC and an unreachable target are told apart.
4. **Tree filter (D):** `@kind` words plus name words; object names only (members and libraries later); live input box; session only.

### Decisions of the eng review (2026-11-18; the user delegated every decision)

| ID | Plan | Decision |
|---|---|---|
| R1 | C | The `state` op reads port 10000 with its own link and answers while the PLC port is down; a PLC part that cannot be read is `plcError`, not a fault. Without this, config mode (the reason for reading port 10000) could never be reported, because the host does not connect when port 851 is missing. |
| R2 | B | A reconnect resolve, and a `watch` resolve, emit `reloaded` when the symbol version changed since the last successful resolve; the backend keeps that version across `Drop()`, and a pending reason survives a loss. Without this the measured download case (connection lost first) shows no reload. |
| R3 | B | `SamplingLog` is fed only from the host's `state` events; `started` resets the connection baseline and is recorded only after a `stopped`. Otherwise every idle stop also reads as a loss and every host start as a restore. |
| R4 | A | The arming time setting (`iecode.ads.aiWritesArmedAt` after R13) gets `"ignoreSync": true`; a manifest test pins the scopes. Otherwise Settings Sync arms auto-approve on every synced PC. |
| R5 | D | One short-name table: `TYPE_SHORT` moves to `core/treeFilter.ts`, `KIND_WORDS` is derived from it. |
| R6 | D | Enter applies the current text at once; Escape clears the pending timer before restoring. |
| R7 | D | The `visibleIn` cache is keyed by the `Unit` object and cleared on a model change. |
| R8 | all | Plan D on its own branch and PR from `origin/main`; the protocol 2 stack gets its own PR before A to C. |
| R9 | all | One simulation session for the `TODO.md` priority 1 live check and the manual checks of B and C. |
| R10 | A | The ADS Watch label refreshes at the next minute change or at the expiry (`nextRefreshMs`), not on a fixed 60 s interval. |
| R11 | B | The reload reason keeps the evaluation order of `WatchHost.cs:139`; `SymbolVersionChanged()` is not called more often than today. |
| R12 | C | `DeviceState` is widened to `int` (Beckhoff's `StateInfo.DeviceState` is a `short`), and the PLC fields are nullable for R1. |

Taken after the outside voice (GitHub Copilot CLI, 2026-11-18), each checked against the code first:

| ID | Plan | Decision |
|---|---|---|
| R13 | A | Store the arming time (`aiWritesArmedAt`), not the end time; the command clears it on Off and Confirm. The end-time draft re-armed a shortened window by itself. |
| R14 | A | Prove the expiry at the gate (`writeGate.test.ts`, allow then confirm before the send) instead of re-pinning `writeStillApproved`, which is already pinned. The manifest test moves to the task that adds the settings. |
| R15 | B | `NoticeReader` (pure, tested) owns the cursor; `take()` reads and advances in one step. |
| R16 | B | `ads_scope` warns on every call when its window holds a hole (`gapsIn`, `gapWarning`); breaking the plotted line becomes a `TODO.md` item. |
| R17 | B | On a target change the log is cleared after the restart, so no "gap" spans two targets. |
| R18 | B | The scope's notice is a status message the webview applies while paused. |
| R19 | B, C | The state tracker lives in `AdsHost` (survives MCP sessions); the first call says it has nothing to compare with; the loss text no longer promises a restart verdict. |
| R20 | C | The three counters are looked up and read one by one; the two finding families use their own counters. |
| R21 | C | Texts claim what the codes show: "port missing" only for `0x6`; counter findings worded as evidence; a changed cycle time is its own finding; elapsed time from `performance.now()`. |
| R22 | C | Time budget written down; port 10000 read with a 1000 ms timeout. |
| R23 | C | A PLC connection loss seen by `state` still marks the host lost (else an empty watch list never reconnects). |
| R24 | B, C | The CLI release that freezes protocol entry 2 waits for Plan C; no entry 3 (an older extension refuses a newer protocol). Fallback: unknown-op detection. |
| R25 | D | Group nodes are filtered and expanded while filtering. |
| R26 | D | Kind words in the order of `TYPE_SHORT`; the pinned error text follows it. |

Not taken from the outside voice: breaking the ADS Scope plot at holes in this plan (R16 keeps the text warning and makes the plot a `TODO.md` item, because the webview drawing code has no tests and the AI reader, the item's goal, is covered by the text).

## Not in scope

- Keep-alive of sampling after the last AI call (Plan E decision 8): a TODO item only if the H1 reproduction in Plan B confirms the idle stop as the cause.
- Searching member names and library sources in the tree filter.
- Per-symbol rates, alarms, PLC-cycle timestamps (Plan E, E2, E6, E7).
- Breaking the ADS Scope plot at sampling holes: a `TODO.md` item added by Plan B Task 3 (R16).

## Definition of done

- All four sub-plans' "Done when" lists fulfilled.
- `TODO.md`: priority items 1, 2, 3, 4 and 7 ticked (1 by the simulation session); the wishlist rows of sections 2, 7 and 8 updated with the test names.
- Pull requests as in "Pull requests" above.

## First action

Create `feature/tree-filter` from `origin/main`, then start Plan D, Task 1: write `extension/test/treeFilter.test.ts`.

## Prior measurements used (2026-11-18)

Measurements from an earlier ADS project on simulation targets (October 2026) were taken into Plans B and C, without code, names or data: which ADS codes and symbol-version changes a route cut, a download and a PLC restart produce; that port 10000 answers `ReadState` on every TwinCAT PC; and that a bare TCP connect to the router port 48898 breaks concurrent ADS connections on that PC, so no plan probes router ports. Not covered there: the PLC task counters (`_TaskInfo`, `OnlineChangeCnt`) and online changes; Plan C step 1 and Plan B's manual check measure them.

## Eng review (2026-11-18)

Target: this master plan and the sub-plans A to D, checked against the code at `b851431`. The user delegated every decision; each decision was taken by the reviewer and applied to the sub-plans (IDs R1 to R26 in "Decisions of the eng review" above).

### Scope challenge

- Already done elsewhere: nothing. `origin/main` has release 0.2.17 but still `WatchHost.Protocol = 1`; protocol entry 2 exists only in the unmerged stack under this branch, so "entry 2 is unreleased" holds.
- Complexity: about 35 files and 4 new pure modules (`writeArming`, `samplingLog`, `plcState`, `treeFilter`). No smaller arrangement keeps the commitments: each module follows the repo's pattern (pure decision module plus thin wiring), and the four items are independent TODO priorities of a day or less each. Scope accepted as is; Plan D moved to its own branch (R8); the TODO priority 1 live check joined the simulation session (R9).
- Reality rows: premise-table pass (protocol 2 unreleased, `TYPE_SHORT`, `writeStillApproved`, `Drop()` clearing the version, `Link()` throwing while disconnected: all read in the code; unverified=2: the system-info symbol names and the online change behaviour, both measured by planned simulation steps); already-done pass; surface-check pass (`iecode ads serve`, **IECode: Set AI Write Access…**, `iecode.refresh` exist); binding-decisions pass (no branch decisions recorded); numbers pass (sizes are `[estimated]`); deferred-asks pass (no linked issue); pr-count finding, fixed by "Pull requests" (R8).

```
REALITY: premise-table pass unverified=2 (system-info names, online change; measured in the simulation session) cli/src/IECode.Automation/AdsWatchBackend.cs:368
REALITY: already-done pass origin/main still has Protocol = 1, no small-items code on main cli/src/IECode.Core/Ads/WatchHost.cs:11
REALITY: surface-check pass iecode ads serve, Set AI Write Access, iecode.refresh exist cli/src/IECode.Cli/Commands/TargetCommands.cs:102
REALITY: binding-decisions pass no recorded branch decisions; planner decisions 1-4 kept or amended by R-ids docs/superpowers/plans/2026-11-17-small-items-master-plan.md:42
REALITY: numbers pass sizes are [estimated], no measured numbers claimed docs/superpowers/plans/2026-11-17-small-items-master-plan.md:22
REALITY: deferred-asks pass no linked issue; TODO items 2,3,4,7 covered, item 1 joined (R9) TODO.md:7
REALITY: pr-count finding protocol 2 stack has no PR; Plan D split to its own PR (R8) docs/superpowers/plans/2026-11-17-small-items-master-plan.md:47
```

### Findings and dispositions

Own review:

| # | Severity, confidence | Where | Finding | Disposition |
|---|---|---|---|---|
| 1 | CRITICAL 9/10 | C, `AdsWatchBackend.cs:60,371` | In config mode the PLC port is missing, `Connect()` fails and `Link()` throws "Not connected", so a system state read through that connection could never report config mode. | Accepted, R1 |
| 2 | CRITICAL 8/10 | B, `AdsWatchBackend.cs:368`, `WatchHost.cs:238` | `Drop()` clears `_watchVersion` and the reconnect resolve was excluded from `reloaded`, so a download during a loss (the measured case) shows no reload. | Accepted, R2 |
| 3 | CRITICAL 8/10 | B, `host.ts:549,563` | `stop()` and `exited()` call `setState(false)`; feeding the log from `setState` turns idle stops into losses and each new host's connect into a restore. | Accepted, R3 |
| 4 | CRITICAL 7/10 | A, manifest | Application-scoped settings are synced; the arming time would arm other PCs. | Accepted, R4 |
| 5 | INFO 7/10 | D, `tree.ts:36` | `KIND_WORDS` would be a second hand-kept copy of `TYPE_SHORT`. | Accepted, R5 |
| 6 | INFO 8/10 | D, input box | Enter within 200 ms applied a stale value; a timer after Escape re-applied the abandoned text. | Accepted, R6 |
| 7 | INFO 7/10 | D, `tree.ts:51` | A cache keyed by unit and generation goes stale on a model reload. | Accepted, R7 |
| 8 | INFO 8/10 | master, git | 15 unmerged commits under the branch, no upstream PR; D shares no code file with them. | Accepted, R8 |
| 9 | INFO 7/10 | master, `TODO.md:7` | The priority 1 live check needs the same simulation as B and C. | Accepted, R9 |
| 10 | INFO 7/10 | A | A 60 s interval shows "1 min left" up to a minute after the expiry. | Accepted, R10 |
| 11 | INFO 7/10 | B, `WatchHost.cs:139`, `AdsWatchBackend.cs:171` | Deriving the reason must not call `SymbolVersionChanged()` more often (it sets `_stale`). | Accepted, R11 |
| 12 | INFO 6/10 | C | Beckhoff `StateInfo.DeviceState` is a `short` (medium confidence; verify in the SDK while coding). | Accepted, R12 |

Outside voice (GitHub Copilot CLI, model `gpt-6.1-sol`); every point was checked against the code before deciding:

| # | Copilot severity | Finding | Check | Disposition |
|---|---|---|---|---|
| O1 | critical | A lowered minutes setting made a window "not armed" and later armed again by itself; Off and Confirm left a reusable time stamp. | Confirmed by the rule `untilMs - nowMs > minutes`. | Accepted, R13 |
| O2 | medium | Not marking the host lost on a PLC failure in `state` leaves an empty-list host "connected" for good. | Confirmed: `Tick` polls only with items (`WatchHost.cs:96`). | Accepted, R23 |
| O3 | medium | The first `ads_state` call has no baseline; a tracker per tools object loses it on an MCP reconnect. | Confirmed, `mcpServer.ts:162`. | Accepted, R19 |
| O4 | medium | Texts overstate: "port missing" for any error, missed restarts, a changed period reads as slow. | Confirmed. | Accepted, R21 |
| O5 | medium | Time budget not established (two state reads, version read, possible symbol upload). | Confirmed; real times unknown until the simulation. | Accepted, R22 |
| O6 | medium | One missing counter would discard the others (`Find` throws). | Confirmed, `AdsWatchBackend.cs:404-412`. | Accepted, R20 |
| O7 | medium | A consumed notice does not protect later reads of a history with the hole; the plot joins across it. | Confirmed. | Partly: text warning accepted (R16); plot break deferred to `TODO.md` |
| O8 | medium | `log.clear()` before `restart()` records the old stop into the new log. | Confirmed, `host.ts:119-133`. | Accepted, R17 |
| O9 | medium | The paused scope does not post (`adsScope.ts:60`), so the notice would not show. | Confirmed. | Accepted, R18 |
| O10 | medium | Group nodes have no id and return all units; a collapsed group hides every hit. | Confirmed, `tree.ts:60-70,139-143`. | Accepted, R25 |
| O11 | medium | Entry 3 after a released entry 2 breaks older extensions with a newer CLI. | Confirmed, `hostProtocol.ts:55-58`. | Accepted, R24 |
| O12 | medium | A's added assertion already exists (`adswatch.test.ts:336`); B's wiring had an untested cursor. | Confirmed. | Accepted, R14 and R15 |
| O13 | low | A's manifest test came before the settings; D's pinned kind order differed from `TYPE_SHORT`; port 10000 is already used by `Target.cs`. | Confirmed. | Accepted, R14, R26, Plan C Decision 6 |

### Architecture

```
Plan B event flow (after R2, R3, R15 to R18)

 PLC --ADS--> AdsWatchBackend --Resolve/ReadWatched--> WatchHost (CLI, one thread)
                | keeps the last resolved version         | events: state, items, samples,
                | across Drop() (R2)                      | reloaded (poll, reconnect, watch; R2)
                                                          v
 AdsHost.handle()  -- state ----> SamplingLog.state()    (host events only, R3)
                   -- reloaded -> SamplingLog.record()
 AdsHost.stop()/exited() ------> record(stopped)         hello -> record(started), only after a stop
 target change: restart(), then log.clear() (R17)
                                                          |
          +-----------------------+-----------------------+---------------------+
          v                       v                       v                     v
 NoticeReader.take() per   gapsIn()/gapWarning()   ADS Watch view          ADS Scope
 MCP session / Copilot     on every ads_scope      message, 120 s          note message, also paused (R18)
 (R15)                     (R16)
```

```
Plan C state op (after R1, R23)

 ads_state -> host.requires('plcState') -> {op:'state'} -> WatchHost.DoState (no _connected check)
   -> ReadPlcState: port 10000 ReadState (own link, 1000 ms) -> SystemState or null
                    PLC link connected? ReadState + counters looked up one by one -> fields, TaskNote
                    no link or fault -> PlcError, PlcAdsCode (+ MarkLost if a connection loss, R23)
                    neither part answered -> AdsFault -> ok:false
   -> extension: parsePlcState -> AdsHost.stateTracker.observe(key, wall, mono) -> stateText
```

Second shapes considered: Plan A, a marker file instead of a setting (rejected: it exists only for local Windows windows); Plan B, an event log owned by the CLI (rejected: the CLI cannot record its own stop or exit). The other new modules follow the existing core pattern. Red flags left after R5 (hand-synced list) and R15 (cursor logic in the wiring): none.

### Code quality

Covered by findings 5 to 7, 10 to 12 and O4, O6, O13. No shared-code extraction proposed: the one duplicate (the redirect note in `adsWrite.ts:28` and `lmTools.ts:162`) is already folded into `writeArming.ts` by Plan A.

### Test review

```
CODE PATHS                                              USER FLOWS
[+] A writeArming.ts (pure)                             [+] Arm, write, expire
  ├── autoState: notAuto/armed/expired/bad/future [★★★]   ├── [★★★] gate refuses after expiry (writeGate.test.ts, R14)
  ├── lowered minutes ends for good (R13)        [★★★]   └── [MANUAL] F5 check, Plan A Task 2 step 5
  ├── nextRefreshMs, labels, notes               [★★★]
  └── manifest scopes and ignoreSync (R4)        [★★ ]
[+] B WatchHost reloaded (CLI)                          [+] Download, restart, idle stop
  ├── poll reasons, order kept (R11)             [★★★]   ├── [MANUAL→SIM] Plan B Task 3 step 3, items 1-8
  ├── reconnect and watch resolve (R2)           [★★★]   └── [GAP→SIM] online change: unmeasured
  └── backend version across Drop()              [★★ ]
[+] B samplingLog.ts (pure)
  ├── loss only from host events, start baseline [★★★]
  ├── NoticeReader once per event (R15)          [★★★]
  ├── gapsIn and gapWarning (R16)                [★★★]
  └── noticeText coalescing and caps             [★★★]
  host.ts and adsScope.ts wiring (R17, R18)      [MANUAL]
[+] C state op (CLI)                                    [+] Run, stop, restart, config mode
  ├── task validation and default                [★★★]   └── [MANUAL→SIM] Plan C Task 1 step 1, Task 2 step 5
  ├── answer while disconnected, nothing reachable (R1) [★★★]
  ├── MarkLost on a PLC loss (R23)               [★★★]
  └── counters one by one, ADS code (R20, R21)   [★★★]
[+] C plcState.ts (pure)
  ├── tracker rules incl. cycle time, monotonic  [★★★]
  └── stateText incl. first call, config mode    [★★★]
[+] D treeFilter.ts (pure)                              [+] Filter, Enter, Escape, clear, reload
  ├── parse, match, visibleIn, message           [★★★]   └── [MANUAL] Plan D Task 2 step 5 (incl. groups, R25)
  └── kind words derived (R5, R26)               [★★★]

COVERAGE: every pure decision has a planned test; wiring and VS Code behaviour by manual or simulation checks.
GAPS: 2, online change (unmeasured, part of the simulation) and VS Code restoring the collapsed state after a filter (manual).
```

No prompt or eval files change (tool descriptions only; the repo has no eval suite). Tests made obsolete: none.

### Performance

No issue beyond R22. Scale: the sampling log holds at most 50 events; `visibleIn` is linear in the objects of one unit and cached per unit (R7); `ads_state` runs only on demand, no polling.

### Failure modes

| Path | Realistic failure | Covered by | The user sees |
|---|---|---|---|
| A arming | clock turned back | a future `armedAt` is not armed (test) | dialog with the "not armed" note |
| A arming | Settings Sync | `ignoreSync` (manifest test) | the other PC stays "not armed" |
| B reload | download during a loss | R2 tests | "lost and restored" plus "reloaded" |
| B notice | two MCP calls at once | `NoticeReader` test | one notice, once |
| B history | notice consumed, later scope over the hole | `gapWarning` test | a warning line on every scope call |
| C state | config mode | R1 tests | "config mode" and "PLC not reachable" |
| C state | silent router port | 1000 ms timeout, field left out (test) | the state without the system line |
| D filter | model reload while filtering | cache cleared on reload (manual) | a new file appears if it matches |

No failure mode is untested, unhandled and silent at once: 0 critical gaps.

### What already exists

- `writeStillApproved` and the gate's second check before the send (`writeGate.ts:226-290`): Plan A reuses them; only the decision input changes.
- `Target.cs` reads port 10000 for `iecode target state`: Plan C reuses its constant and wording.
- `ReportOnce`, `MarkLost`, the dead-handle guard and the symbol version check in `WatchHost.cs` and `AdsWatchBackend.cs`: Plan B adds a reason, not a second mechanism.
- `hostNote` and `gapNote` in `adsToolText.ts` cover a stale newest sample; Plan B adds holes inside the window.
- `featureMissingText` and `host.requires`: Plan C's answer for an old CLI.

### Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Plan D | `extension/src/core`, `extension/src/views` (tree), `extension.ts`, manifest | — |
| Plan A | `extension/src/core`, `extension/src/ads`, `extension/src/views` (adsWatch), manifest | — |
| Plan B | `cli/src/IECode.Core/Ads`, `cli/src/IECode.Automation`, `extension/src/core`, `extension/src/ads`, `extension/src/views` | A (shared `adsWatch.ts`) |
| Plan C | the modules of B, plus manifest and protocol table | B |
| Simulation session | none (checks) | B and C built; C Task 1 step 1 before C is coded |

Lane 1: Plan D on its own branch. Lane 2: A, then B, then C. Launch both lanes; merge lane 1 on its own. Conflict flag: `extension/package.json` and `extension/CHANGELOG.md` in both lanes (trivial).

### Implementation tasks

- [ ] **T1 (P1, human: ~1 day / CC: ~30 min)** — Plan C — `state` op answers without the PLC connection and still marks a lost PLC (R1, R23)
  - Surfaced by: finding 1, O2
  - Files: `cli/src/IECode.Core/Ads/WatchHost.cs`, `cli/src/IECode.Automation/AdsWatchBackend.cs`
  - Verify: `State_op_while_disconnected_answers_with_the_system_state`, `State_op_with_a_lost_PLC_part_marks_a_connected_host_lost`
- [ ] **T2 (P1, human: ~4 h / CC: ~20 min)** — Plan B — `reloaded` after a reconnect or watch resolve (R2, R11)
  - Surfaced by: finding 2
  - Files: `WatchHost.cs`, `AdsWatchBackend.cs`, `WatchProtocol.cs`
  - Verify: `Reconnect_after_a_symbol_version_change_emits_reloaded`, `Dead_handles_with_a_changed_version_keep_the_handle_reason`
- [ ] **T3 (P1, human: ~3 h / CC: ~15 min)** — Plan B — log fed by host events only; `NoticeReader`; clear after restart (R3, R15, R17)
  - Surfaced by: finding 3, O8, O12
  - Files: `extension/src/core/samplingLog.ts`, `extension/src/ads/host.ts`, `extension/src/ads/adsTools.ts`
  - Verify: `a stop is not a loss and a new host's first connect is not a restore`, `NoticeReader shows each event once, also to overlapping calls`
- [ ] **T4 (P1, human: ~3 h / CC: ~15 min)** — Plan A — arming time instead of end time, cleared by Off and Confirm, not synced (R4, R13, R14)
  - Surfaced by: finding 4, O1, O12
  - Files: `extension/src/core/writeArming.ts`, `extension/src/ads/aiSettings.ts`, `extension/src/ads/lmTools.ts`, `extension/package.json`
  - Verify: `a lowered minutes setting ends a window for good`, `an auto approval that lapses before the send is refused`
- [ ] **T5 (P2, human: ~3 h / CC: ~15 min)** — Plan C — counters one by one, honest texts, tracker in the host, time budget (R19 to R22)
  - Surfaced by: O3 to O6
  - Files: `AdsWatchBackend.cs`, `extension/src/core/plcState.ts`, `extension/src/ads/host.ts`
  - Verify: `ReadPlcState_reads_the_counters_that_resolve`, `a changed cycle time is reported instead of slow`, `the first call says there is no baseline`
- [ ] **T6 (P2, human: ~2 h / CC: ~10 min)** — Plan B — gap warning in `ads_scope`, scope notice while paused (R16, R18)
  - Surfaced by: O7, O9
  - Files: `extension/src/core/samplingLog.ts`, `extension/src/ads/adsTools.ts`, `extension/src/views/adsScope.ts`
  - Verify: `gapWarning names the holes`; Plan B manual check item 8
- [ ] **T7 (P2, human: ~3 h / CC: ~15 min)** — Plan D — one kind table, input timing, cache, groups (R5 to R7, R25, R26)
  - Surfaced by: findings 5 to 7, O10, O13
  - Files: `extension/src/core/treeFilter.ts`, `extension/src/views/tree.ts`, `extension/src/extension.ts`
  - Verify: `kind words are derived from the short names`; Plan D manual check
- [ ] **T8 (P2, human: ~30 min / CC: ~5 min)** — master — Plan D branch from `origin/main`; entry 2 release waits for C (R8, R24)
  - Surfaced by: finding 8, O11
  - Files: none (git and release order)
  - Verify: `git log origin/main..feature/tree-filter` shows only Plan D commits
- [ ] **T9 (P2, human: ~2.5 h / CC: n/a)** — master — one simulation session (R9)
  - Surfaced by: finding 9
  - Files: the Findings sections of Plans B and C, `TODO.md`
  - Verify: Findings filled, `TODO.md` priority 1 ticked
- [ ] **T10 (P3, human: ~2 h / CC: ~10 min)** — follow-up — break the ADS Scope plot at sampling holes
  - Surfaced by: O7 (deferred part)
  - Files: `extension/src/views/adsScope.ts`
  - Verify: manual, scope over a cut connection

Effort ratios assumed: features about 30x, tests about 50x; the simulation session is not compressible.

### Unresolved decisions

None: the user delegated every decision; all 26 are taken and applied to the sub-plans.

### Completion summary

- Step 0: Scope Challenge — scope accepted as-is (Plan D moved to its own branch, no feature cut)
- Reality rows: 7/7 applicable rows emitted, 2 unverified premises (system-info names, online change behaviour; both measured by planned simulation steps)
- Architecture Review: 5 issues found (findings 1 to 4, 8)
- Code Quality Review: 6 issues found (findings 5 to 7, 10 to 12)
- Test Review: diagram produced, 2 gaps identified (both covered by manual or simulation checks)
- Performance Review: 0 issues of its own (R22 came from the outside voice)
- NOT in scope: written (section "Not in scope" above)
- What already exists: written
- TODOS.md updates: 1 item (scope plot break), added by Plan B Task 3
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: GitHub Copilot CLI (`gpt-6.1-sol`), completed; 13 findings, 12 accepted, 1 partly accepted
- Parallelization: 2 lanes, 2 parallel / 3 sequential (A, B, C)
- Lake Score: 26/26 decisions took the complete option

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | GitHub Copilot CLI (user request) | Independent 2nd opinion | 1 | completed | 13 findings, 12 accepted, 1 partly |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open (all resolved into the plans) | 13 issues (11 findings, 2 test gaps), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** GitHub Copilot CLI, plan review phase, completed, 13 findings (1 critical, 11 medium, 1 low). The Codex outside voice of the skill was not used; the user asked for Copilot instead.
- **CROSS-MODEL:** overlap with the own review on the protocol and the PLC connection area (findings 1 and 2 vs O2, O11); Copilot added the auto re-arm (O1), history holes (O7), the paused scope (O9) and the group nodes (O10), all confirmed in the code.
- **VERDICT:** no review CLEAR; every finding is resolved into the sub-plans, so the plans are ready to implement. eng review required for a CLEAR status (a re-run would log clean).

NO UNRESOLVED DECISIONS
