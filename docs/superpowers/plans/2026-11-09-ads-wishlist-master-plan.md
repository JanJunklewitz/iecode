# ADS Wishlist Master Plan

> **Status: master plan; the sub-plans A to E are detailed TDD plans** (each with open decisions at its end). Run them with superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Build every wish of the ADS MCP wishlist that is not implemented yet, in an order that fixes wrong results first, saves the most agent time next, and touches the CLI only once it pays off.

**Architecture:** The tool logic stays where it is (pure modules in `extension/src/core/`, wiring in `extension/src/ads/`, tools declared once in `extension/package.json`). Work that needs the PLC side (batch write, structs, online symbols, state, per-symbol rate, alarms) goes through the CLI watch host and is gated by a protocol version table, so an older CLI only loses the new features.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads`.

**Spec:** [../../ads-mcp-wishlist.md](../../ads-mcp-wishlist.md) (what is wanted and its status), [2026-11-06-ads-mcp-wishlist.md](2026-11-06-ads-mcp-wishlist.md) (roadmap, design decisions D1-D24, still valid), [2026-11-06-ads-wait.md](2026-11-06-ads-wait.md) (done, the pattern to copy).

## Global Constraints

These apply to every sub-plan.

- Public repository: no internal project, module or machine names, symbol paths or data in code, tests, docs or commits. Commit author and `Signed-off-by` use the GitHub noreply address; commit messages are English with a 1-3 sentence why-body.
- Every tool is declared once in `extension/package.json` (`languageModelTools`) and served by both `buildMcpTools` and `lmTools.ts`; the manifest parity test must stay green. New parameters are optional; old calls keep byte-identical results unless a task says otherwise (intended changes: the `ads_watch` result of B1, the target line of B5, the summary line of A4 for symbols with a change log, input validation in the Copilot scope and watch tools (A2, B1), the `ads_write` schema and description of C3c, and the stale warning tolerance of D1).
- Decisions live in pure `extension/src/core/` modules, because the node tests cannot load `vscode`. `src/ads/` only wires.
- Writes keep the write gate guarantees: one confirmation per AI write operation, "Not written" only with proof, "outcome unknown" after a timeout.
- CLI changes: one immutable entry per protocol number in a version table in `extension/src/core/hostProtocol.ts` (an entry is frozen by the CLI release, not by a merge: features of later plans join the open entry until a CLI with that protocol is released, then the next plan opens a new entry); replies change additively; the extension accepts hosts from protocol 1 up to its own and switches off only the missing features (roadmap D14, D23). Task C0 builds this table; every other CLI-touching task depends on it.
- Tests: `cd extension && npm test`. `dotnet test` only through the PowerShell tool, never chained with `dotnet build`, nothing heavy in parallel.
- Pull requests are cut as the delivery slices of "Second review round" below (A; B; the extension-only rest; then the CLI parts of C, D, E), each with its CHANGELOG lines in the style of the `ads_wait` entry. Release trains (below) only say when a CLI release is needed; they are not pull requests. If a plan's pull request grows past about 15 tasks, split it at a protocol boundary.

## Sub-plans

| Plan | Theme | Wishlist sections | CLI | Size (rough) |
|---|---|---|---|---|
| [A](2026-11-09-ads-wishlist-a-scope-fidelity.md) | Scope output that is correct and compact | 1, 2 (edges), 3 (sample age) | no | 2-3 days |
| [B](2026-11-09-ads-wishlist-b-watch-list.md) | Watch list management | 4, 8 (target in header) | no | 1.5-2 days |
| [C](2026-11-09-ads-wishlist-c-writes.md) | Writes, journal, restore, write safety | 5, 8 | yes (C0-C3) | 3-4 days |
| [D](2026-11-09-ads-wishlist-d-symbols-and-build-state.md) | Symbols, structs, enums, build state | 3, 6 | partly | 3-4 days |
| [E](2026-11-09-ads-wishlist-e-runtime-and-plc.md) | Runtime control, PLC state, capture, alarms | 2, 4, 7 | mostly | 4-6 days incl. spikes |

Sizes are `[estimated]` working days with an agent doing the typing; the PLC-side tasks carry the uncertainty.

## Order and dependencies

The task order inside each plan is the `## Order` section of that sub-plan; this table only fixes the order between plans, so it cannot drift from the task lists.

```
1. Plan A   (A1 done; A2-A8)                      extension only
2. Plan B   (B1 B5 B2 B3a-c B4 B6)                extension only, rebase on A
3. Plan C   C0 -> C5 -> C3a -> C1 (spike) -> C3b -> C7a   extension only, then C2 -> C3c -> C4 -> C6a -> C6b -> C7b -> C8 (CLI, protocol 2)
4. Plan D   D1-D4 (extension only), then D5, D5b, D6 (spike), D6b, D7, D7b (after C0), D8
5. Plan E   E1, E8 (extension only), E3 (diagnose first), E4, E5 (after A3), E2 (after its spike), then E6, E7 only after a go, E9
```

C0 is extension only and comes first inside Plan C; C1 (SDK spike for the batch write) runs before C3b so the "one ADS request" wording is not pinned before the spike has checked it.

Why this order:

1. **A1 first.** The scope silently drops value changes and the table looks complete; an agent already drew a wrong conclusion from it. This is a correctness bug, not a feature.
2. **A and B before the CLI work.** They need no protocol change, so they ship without a CLI release and with no version skew risk.
3. **C0 before every CLI feature.** The protocol table is the shared prerequisite; without it each feature would break users whose CLI is older than their extension.
4. **Spikes last.** Alarms and notifications have open questions (licence, threading, task identity); they get a throwaway spike and a go/no-go note before any design is built.

Shared files that force sequential merges: `adsToolText.ts`, `toolInput.ts`, `package.json`, `adsTools.ts`, `host.ts`. Plans A and B touch the same text module; merge A first, then rebase B. CLI tasks of C, D and E all touch `WatchProtocol.cs` and `WatchHost.cs`; build them one after the other on one branch per wave.

## Release trains

| Train | Contents | CLI release needed |
|---|---|---|
| T1 | Plans A, B and the extension-only tasks of C, D, E (C0, C5, C3a-b, C7a, D1-D4, E1, E8) | no |
| T2 | C1-C8, D5-D7b, E2-E5 | yes, with protocol bump (one per release) |
| T3 | E6, E7 if the spikes say go | yes |

**Gate before T2:** ship T1 and use it for a while. T2 starts only if the T1 tools measurably save agent time (fewer calls per diagnosis, no wrong conclusions from `ads_scope`); otherwise cut T2 to the items the user still asks for. The spikes C1 and D6 are cheap and may run earlier.

## Not in scope

- Same-cycle guarantee for a batch write: needs a PLC-side handshake; listed in `TODO.md`. Result texts say "one ADS request", never "same cycle".
- Order of two assignments inside one PLC cycle: needs PLC-side instrumentation.
- Event order across several PLC tasks: listed in `TODO.md`.
- Aliases for long paths (roadmap Phase 6): deferred until Plans A and B show whether path length still costs time.
- Built-in views that assume one library's naming convention; Plan E8 offers user-defined presets instead.

## Decisions (user, 2026-11-09)

1. Plan C, batch write: "sent in one ADS request" is enough. A same-cycle write is a TODO item (needs a PLC-side handshake).
2. Plan C7b, persistent and configuration guard: first check whether the build output marks persistent symbols; if it does not, the user lists path prefixes in a setting.
3. Plan E6, alarms: a spike decides whether the EventLogger proxy dependency is acceptable (licence, redistribution, remote access); no dependency before a go.
4. Plan E7, PLC-cycle timestamps: only for symbols of one task. Order across several tasks is a TODO item.
5. Plan B5: the target line `ADS target: <target>` goes on the last line of watch, write and wait results, so the verdict words stay first.
6. Plan A4: the summary line of every symbol that changed gets `changes=K (first at ..., last at ...)`; constant symbols stay byte-identical.
7. Plan C6: the old value is read before every AI write (one extra ADS read per write call), so the journal and restore are complete.
7a. (Review, 2026-11-10) A failed pre-read never blocks the write: the journal records the old value as unknown with the error. The old value is a best-effort "before", not atomic with the write; the restore text must say so.
8. Plan E3: if the stale-sampling cause is the idle stop, sampling stays alive 300 s after the last AI call (`iecode.ads.aiKeepAliveSeconds`). E3 diagnoses the cause first; without a reproduced cause no keep-alive is built.
9. All other open decisions listed at the end of Plans A to E are taken as the plans' own recommendations (for example: journal in memory only, `edges` with `changesOnly` is an error, `ads_config` is a session override, per-symbol rates go in a `rates` map, hidden variables are listed and not readable).

## Definition of done per sub-plan

- Wishlist rows changed from New or Planned to Done, with the test names in the table.
- `npm test` green; `dotnet test` green for CLI tasks.
- A manual check against a simulation target for every tool that changed, recorded in the PR (the `ads_wait` live check is still open and is done together with Plan A).
- CHANGELOG entry per user-visible change.

## First action

Build Plan A task A2 (A1 is done, commits 04a0232 and 9c1c6fc).

## Engineering review (2026-11-10)

Reviewed with `/plan-eng-review`. The user delegated every decision, so each choice below took the recommended option.

### Scope Challenge

Scope: about 50 tasks, 5 sub-plans, 13-19 estimated days, more than 8 files and 2 new classes, so the complexity gate applies. Decisions: scope accepted as-is, because the user already ordered "every wish"; structure: original arrangement of five plans kept, because merging plans would hide the shared-file merge order. Reality rows: already-done (finding R1), premise/surface/numbers checked against `adswatch.ts:4`, `host.ts:365`, `writeGate.ts:83`, `WatchHost.cs:11`; no linked issue for deferred-asks. `PLAN_REALITY` was not run (`gstack-plan-reality check` needs a review file; rows printed only).

### Decision ledger

| ID | Finding | Severity (conf.) | Decision | Applied to |
|---|---|---|---|---|
| R1 | "First action" tells to build A1, which is done (commits 04a0232, 9c1c6fc) | INFORMATIONAL (10/10) | Fixed | Master "First action" |
| R2 | Wave table drifted from the sub-plans (omits A6-A8, B6, C8, D5b/D6b/D7b/D8, E9; C0 and C6a in the wrong waves; C6a needs `writeExec.ts` from C3c) | CRITICAL (9/10) | Order per sub-plan `## Order`; master only orders the plans | Master "Order and dependencies" |
| R3 | PR granularity stated three ways (per wave, per train, "one PR for the whole plan" in B); T1 would be about 28 tasks | CRITICAL (8/10) | One PR per sub-plan, trains are CLI-release markers only | Master constraints and trains |
| R4 | "Old calls byte-identical except `ads_watch`" contradicts A4 suffix and B5 target line | INFORMATIONAL (9/10) | List all three intended changes | Master constraints |
| R5 | "One ADS request" wording is pinned in C3b before the C1 SDK spike | CRITICAL (8/10) | C1 moves before C3b | Plan C `## Order`, master order |
| R6 | Pre-read before every write: no stated behavior for a failed read at master level; not atomic with the write | INFORMATIONAL (7/10) | Recorded: a failed pre-read never blocks the write (C6a already says so); old value is best effort | Master decision 7a |
| R7 | Decision 8 (300 s keep-alive) precedes the diagnosis of the stale sampling | INFORMATIONAL (7/10) | E3 diagnoses first; no reproduced cause, no keep-alive | Master decision 8 |
| R8 | Whole plan commits about 50 tasks without a value gate | INFORMATIONAL (7/10, outside voice) | Gate before T2 after T1 is used | Master trains |
| R9 | `negotiate` refuses a host newer than the extension, although entries and replies are additive | INFORMATIONAL (5/10, medium confidence) | Kept as is (roadmap D14/D23 decided it); revisit if users report ADS tools off after a CLI update | none |
| R10 | `journal: true` (read-only) lives inside the mutating `ads_write` tool, so a client that gates the write tool also gates the journal | INFORMATIONAL (5/10, medium confidence) | Kept; C6a already exempts it from the plugin's own gate | none |

Approval readiness: PASS (R1-R8 applied by the user's delegation, "you make all decisions"; R9 and R10 kept).

### Review sections

- **Architecture:** no new module boundary beyond those in the sub-plans. Red flags: hand-synced task list in the master (R2, fixed by pointing at the sub-plans); two ways to order work (waves vs. sub-plan Order, fixed). Failure mode: older CLI with a newer extension is handled by C0; the reverse skew is R9.
- **Code quality:** hot shared files (`adsToolText.ts`, `toolInput.ts`, `package.json`, `adsTools.ts`, `host.ts`, `WatchProtocol.cs`, `WatchHost.cs`) force sequential merges, which the one-PR-per-plan rule now respects. No shared-code extraction proposed.
- **Tests:** every sub-plan lists test names before code; the pinned texts of C3b were the one place where tests preceded a fact (R5). No coverage gaps added at master level. Live checks need a simulation target; no allowance for its availability is in the estimates `[estimated]`.
- **Performance:** extra pre-read per write call (decision 7) is one ADS request; `ScopeBuffer` change log is capped (A3); `SCOPE_MAX_VALUES` default stays 2,000,000. No benchmarks invented.
- **Outside voice:** native Claude subagent (Codex not installed), completed. Findings 1, 4, 5, 6, 9 accepted (R8, R2, R5, R7, R4). Finding 2 partly wrong: C6a already states a failed pre-read never blocks the write (R6 only records it at master level). Finding 3 (persistent guard feasibility): C7b Step 0 and C1 step 9 already probe it before any build; fail-open of an empty prefix list is accepted by decision 2. Finding 8 (cut E6): rejected, the user decided on a spike (decision 3).

### NOT in scope

Same-cycle batch write (needs a PLC handshake, in `TODO.md`), event order across tasks, aliases for long paths, library-specific built-in views, a CI scan for internal names (the constraint stays discipline plus review).

### What already exists

A1 (done), `ads_wait` pattern, `WatchList` persistence in `workspaceState`, the hello check at `host.ts:365` that C0 replaces. No reusable code was missed.

### Worktree parallelization

Sequential implementation, no parallelization opportunity: the seven shared files serialise the plans.

### Implementation tasks

- [x] T1 (P1) Master plan: fix First action, order, PR rule, trains (R1-R3, R8), done in this review.
- [x] T2 (P1) Plan C order: C1 before C3b (R5), done.
- [x] T3 (P2) Plan E3: already starts with a reproduction and a decision table before any keep-alive code, so no change was needed (R7 only aligned the master wording).
- [x] T4 (P3) Plan A and B: PR wording aligned with the one-PR-per-plan rule.



### Second review round (independent model, 2026-11-10)

An independent reviewer read this plan and every sub-plan including the first amendments. The accepted corrections are in the section `## Review amendments, round 2` at the end of each sub-plan and below. Precedence if texts disagree: round 2 amendments, then round 1 amendments, then the task text of a sub-plan, then this master plan, then the roadmap.

**Delivery slices instead of one PR per plan (replaces the PR rule above).** The first rule made the T1 gate unreachable: the extension-only tasks of C, D and E sat in PRs that also carry CLI work. Pull requests are cut by deliverable:

| Slice | Contents | CLI release |
|---|---|---|
| PR1 | Plan A (A2-A8) | no |
| PR2 | Plan B | no |
| PR3 | Extension-only rest: X0 (move the Copilot registration into a table in `core/` and test it against the manifest), C0, C5, C3a, C3b, C7a, D1-D4 (not D2b), E1, E5, E8 | no |
| gate | Use PR1-PR3 for a while, then decide (below) | |
| PR4 | Plan C CLI part: C1 (spike, may run earlier), C2, C3c, C4, C6a, C6b, C7b, C8 | yes (protocol 2) |
| PR5 | Plan D CLI part: D2b, D5, D5b, D6, D6b, D7, D7b, D8 | same release as PR4 or protocol 3 |
| PR6 | Plan E CLI part: E3, E4, E2 (after go), E9; T3 (E6, E7) only after a go | with PR4/PR5 or next |

A sub-plan's own `## Order` stays valid inside its slices. E5 needs no CLI and moves to PR3 (it needs A3, A5, E1 and `ads_wait`). D2 (enum members) is in PR3, D2b (alias names on write, CLI) in PR5; the "T2" train name now means PR4-PR6.

**Gate before PR4 (concrete).** Baseline: write down 5 diagnosis tasks (for example a stuck sequence, a state-machine overview, a counter check) and count agent tool calls and wrong conclusions with the old tools. After PR1-PR3 are released, repeat them. PR4-PR6 start only for a feature family that a recorded real use case asks for (batch/pulse/restore, struct read and online symbols, runtime and alarms are three families). The estimates (13-19 days) exclude the availability of a simulation target and the live checks; add 30 % until a target is available `[estimated]`.

**Guards: what "fail closed" means (replaces the one-line claim).** The write guards refuse when they cannot decide (an error, an invalid setting, an unknown persistent classification). A symbol that the build output does not know, a stale build, or a build of another program counts as unknown, not as unprotected; unknown needs its own confirmation, never auto-approval. With an empty `persistentPaths` list and no marker in the build output nothing is classified persistent (accepted by decision 2; documented as a limit). The guards are not isolation: an agent with the same user rights can change settings or call the CLI directly, and a symbol allow-list does not separate a simulation from a machine (the same symbol names exist on both). Remove the sentence that auto-approve is "without risk to a real target".

**Wording corrections.** Decision 7: the pre-read is one read call to the host, but the host reads symbol by symbol (N ADS reads, sequential, on the host thread); the cost is N reads, not one request. Decision 6 is read as: constant numeric symbols stay byte-identical; non-numeric symbols with a change log get the `changes=K` form. The version table lives in `extension/src/core/hostProtocol.ts` (C0), not in `host.ts`.

**Intended output changes (table replaces the list).**

| Tool | Change | Task |
|---|---|---|
| `ads_watch` | diff result, `list`, group lines, target line last | B1, B3c, B5 |
| `ads_write`, `ads_wait` | target line; batch and `done` result kinds, new schema and description | B5, C3b, C3c |
| `ads_write` | BOOL read-back wording (neutral: the value read back differs) | C5 |
| `ads_scope` | `changes=K` lines, no-sample host note, options | A2-A7 |
| `ads_symbols` | build header, stale tolerance (also in the Interface view), enum members | D1, D2 |
| all ADS tools | sampling notices at the top of watch, scope, read | E3 |
| Copilot watch and scope tools | input validation (`Invalid arguments`) | A2, B1 |

All other results stay byte-identical; every task keeps a pinned test for an unchanged case.

**Status of the wishlist.** Rows already done by A1 (never drop a value change, say when rows are dropped) and the persisted watch list are set to Done in the wishlist before PR1 is opened; partly done rows are split into "done" and "remaining".

### Open questions to ask when the task starts

The reviews left some points open on purpose: they depend on a measurement, a spike or a product choice. Each sub-plan ends with a section `## Open questions to ask at task start`. When you start the named task, put the question to the user with the recommendation before writing code; do not decide it silently. A question is closed by writing the answer and the date under it.

| Question | Task | Plan |
|---|---|---|
| Protocol: keep refusing a host newer than the extension? | C0 | C |
| Journal read-only action inside the mutating `ads_write` tool? | C6a | C |
| Persistent marker: variant A (build output) or B (path prefixes) | C1, C7b | C |
| Memory budget of the change log and trimming strategy; rows versus characters | A3, A5 | A |
| Limits of the watch list (entries, groups) | B3a, B3b | B |
| Sample age per symbol with per-symbol rates | E2 | E |
| Keep-alive default and its CPU cost | E3 | E |
| Memory confirmation threshold in bytes | E1 | E |
| SystemInfo names, task index, counter reset, notification time base | E4, E7 | E |
| EventLogger package, history access, licence | E6 | E |
| Online symbol upload cost and the `P_` property names | D5, D6, D8 | D |

### Sub-plan review (2026-11-10)

Each sub-plan was reviewed separately (references checked against the code, architecture, tests, performance, failure modes). The accepted corrections are in the section `## Review amendments (2026-11-10)` at the end of each sub-plan; they override the task text. Counts: A 3 critical / 8 informational, B 5 / 10, C 6 / 9, D 6 / 9, E 6 / 4 findings. Cross-plan decisions: protocol entries are frozen by the CLI release (Plan C amendment 1); one missing-feature text and one capability API owned by C0 (Plans D, E); A3's `ChangeLog` shape is what E5 consumes; the guards refuse when they cannot decide, see "Guards" in the second round.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native Claude subagent (Codex not installed) | Independent 2nd opinion | 1 | completed (no outside provider coverage) | 9 findings, 5 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 3 | issues_open | master 10 issues, sub-plans A-E 61 issues (round 1) plus an independent second round (about 100 findings, accepted ones applied as round 2 amendments), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** native fallback completed; no external provider ran.
- **VERDICT:** Eng review applied to the master plan and to sub-plans A-E (amendments at the end of each); all accepted tasks done. Re-run is not needed unless the sub-plans change.


NO UNRESOLVED DECISIONS

