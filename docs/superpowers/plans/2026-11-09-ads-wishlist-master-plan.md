# ADS Wishlist Master Plan

> **Status: master plan; the sub-plans A to E are detailed TDD plans** (each with open decisions at its end). Run them with superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Build every wish of the ADS MCP wishlist that is not implemented yet, in an order that fixes wrong results first, saves the most agent time next, and touches the CLI only once it pays off.

**Architecture:** The tool logic stays where it is (pure modules in `extension/src/core/`, wiring in `extension/src/ads/`, tools declared once in `extension/package.json`). Work that needs the PLC side (batch write, structs, online symbols, state, per-symbol rate, alarms) goes through the CLI watch host and is gated by a protocol version table, so an older CLI only loses the new features.

**Tech Stack:** TypeScript (`node --test`), C# .NET (xUnit), `Beckhoff.TwinCAT.Ads`.

**Spec:** [../../ads-mcp-wishlist.md](../../ads-mcp-wishlist.md) (what is wanted and its status), [2026-11-06-ads-mcp-wishlist.md](2026-11-06-ads-mcp-wishlist.md) (roadmap, design decisions D1-D24, still valid), [2026-11-06-ads-wait.md](2026-11-06-ads-wait.md) (done, the pattern to copy).

## Global Constraints

These apply to every sub-plan.

- Public repository: no internal project, module or machine names, symbol paths or data in code, tests, docs or commits. Commit author and `Signed-off-by` use the GitHub noreply address; commit messages are English with a 1-3 sentence why-body.
- Every tool is declared once in `extension/package.json` (`languageModelTools`) and served by both `buildMcpTools` and `lmTools.ts`; the manifest parity test must stay green. New parameters are optional; old calls keep byte-identical results unless a task says otherwise (Phase 1 output of `ads_watch` is the one intended change).
- Decisions live in pure `extension/src/core/` modules, because the node tests cannot load `vscode`. `src/ads/` only wires.
- Writes keep the write gate guarantees: one confirmation per AI write operation, "Not written" only with proof, "outcome unknown" after a timeout.
- CLI changes: one immutable entry per protocol number in a version table in `host.ts`; replies change additively; the extension accepts hosts from protocol 1 up to its own and switches off only the missing features (roadmap D14, D23). Task C0 builds this table; every other CLI-touching task depends on it.
- Tests: `cd extension && npm test`. `dotnet test` only through the PowerShell tool, never chained with `dotnet build`, nothing heavy in parallel.
- One pull request per sub-plan wave (see below), each with its CHANGELOG line in the style of the `ads_wait` entry.

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

```
Wave 1 (extension only)   A1 -> A2 -> A3 -> A4 -> A5      B1 (parallel to A, shares adsToolText.ts: merge A first)
Wave 2 (extension only)   B2-B5, C5, C6a, C7a, D1-D4, E1, E8
Wave 3 (CLI + extension)  C0 -> C1 -> C2 -> C3 -> C4, C5, C6b, C7b
                          D5, D6, D7 (after C0)     E2, E3, E4 (after C0); E5 (after A3, no CLI)
Wave 4 (spikes, go/no-go) E6 alarms, E7 PLC-cycle notifications
```

Why this order:

1. **A1 first.** The scope silently drops value changes and the table looks complete; an agent already drew a wrong conclusion from it. This is a correctness bug, not a feature.
2. **A and B before the CLI work.** They need no protocol change, so they ship without a CLI release and with no version skew risk.
3. **C0 before every CLI feature.** The protocol table is the shared prerequisite; without it each feature would break users whose CLI is older than their extension.
4. **Spikes last.** Alarms and notifications have open questions (licence, threading, task identity); they get a throwaway spike and a go/no-go note before any design is built.

Shared files that force sequential merges: `adsToolText.ts`, `toolInput.ts`, `package.json`, `adsTools.ts`, `host.ts`. Plans A and B touch the same text module; merge A first, then rebase B. CLI tasks of C, D and E all touch `WatchProtocol.cs` and `WatchHost.cs`; build them one after the other on one branch per wave.

## Release trains

| Train | Contents | CLI release needed |
|---|---|---|
| T1 | Plans A, B, wave-2 extension-only tasks | no |
| T2 | C0-C8, D5-D7, E2-E5 | yes, with protocol bump (one per release) |
| T3 | E6, E7 if the spikes say go | yes |

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
8. Plan E3: if the stale-sampling cause is the idle stop, sampling stays alive 300 s after the last AI call (`iecode.ads.aiKeepAliveSeconds`).
9. All other open decisions listed at the end of Plans A to E are taken as the plans' own recommendations (for example: journal in memory only, `edges` with `changesOnly` is an error, `ads_config` is a session override, per-symbol rates go in a `rates` map, hidden variables are listed and not readable).

## Definition of done per sub-plan

- Wishlist rows changed from New or Planned to Done, with the test names in the table.
- `npm test` green; `dotnet test` green for CLI tasks.
- A manual check against a simulation target for every tool that changed, recorded in the PR (the `ads_wait` live check is still open and is done together with Plan A).
- CHANGELOG entry per user-visible change.

## First action

Expand Plan A, task A1 into TDD steps and build it.
