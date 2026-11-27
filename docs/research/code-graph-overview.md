# Code graph overview

A knowledge graph of the whole repository, built with [graphify](https://github.com/safishamsi/graphify).
This note records the result so it can be consulted without rebuilding the graph.
The raw outputs (`graph.json`, `graph.html`, `GRAPH_REPORT.md`) live in `graphify-out/`,
which is **not committed** (excluded locally via `.git/info/exclude`).

Snapshot: built 2026-11-27 on `main` at `2bc4bff` (release 0.2.23). Numbers below describe that snapshot.

## How it was built

| Step | Detail |
| --- | --- |
| Corpus | 441 files, ~606k words: 380 code, 53 docs, 8 images |
| Code | Deterministic AST extraction, no LLM: 5095 nodes, 15539 edges |
| Docs and images | Semantic extraction by 8 subagents: 361 nodes, 472 edges, 13 hyperedges |
| Merge | 5456 nodes, 16011 edges before graph build |
| Graph | 5477 nodes, 15336 edges, 222 communities (201 shown, 21 thin omitted) |
| Edge provenance | 92% EXTRACTED, 8% INFERRED (1299 edges, average confidence 0.84), 0% AMBIGUOUS |

Token usage of the semantic pass was not recorded (chunk files carry placeholder zeros).

To rebuild or query: `/graphify` (full build), `/graphify --update` (changed files only),
`graphify query "<question>"`, `graphify explain "<symbol>"`, `graphify path "A" "B"`.

## Health check

The graph is usable but not lossless:

- 138 edges with a dangling endpoint, 30 self-loops.
- 675 edges merged when the graph was built (same endpoints, different relation or location).
- 228 isolated symbol nodes (at most one connection), for example `Count`, `TypeName`, `IsSingleValue`.
  Likely missing edges or undocumented members, not necessarily dead code.
- Ten test files (`extension/test/*.test.ts`) produced no symbols and are absent from the code graph.
- Every doc and image was read to its last line; no partial extraction.

## God nodes (most connected)

| Rank | Node | Edges |
| --- | --- | --- |
| 1 | `IECodeException` | 103 |
| 2 | `adsTools()` | 70 |
| 3 | `activate()` | 68 |
| 4 | `WatchHostTests` | 65 |
| 5 | `Rig` | 64 |
| 6 | `McpBridgeTests` | 63 |
| 7 | `AdsFault` | 57 |
| 8 | `AdsHost` | 57 |
| 9 | `decode()` | 54 |
| 10 | `SymbolIndex` | 51 |

`IECodeException` is analysed in [code-graph-iecodeexception.md](code-graph-iecodeexception.md).
`activate()` (extension entry point) and `decode()` are the other two high-betweenness bridges:
each touches 17 or more communities because it is shared infrastructure, not because those
communities depend on each other.

## Communities

Only the 40 largest were named by hand; the rest keep the default label `Community N`.
Cohesion is low everywhere (0.04 to 0.24), which is expected for a codebase organised by feature
with shared helpers. The highest cohesion is `MCP Bridge Tests` (0.24), the lowest `ADS Tool Dialogs` (0.04).

### Extension (TypeScript)

| Community | Size | Main files and symbols |
| --- | --- | --- |
| ADS Tool Dialogs | 118 | `adsTools.ts`, `askRemoval`, `confirmRemove`, `dialogs` |
| Object Analysis Commands | 90 | `analysis.ts`, `engineering.ts`, `commands/impact.ts`, `SEVERITY`, `OBJECT_KINDS` |
| Capture Run | 85 | `captureRun.ts`, `CAPTURE_DEFAULT_PRE/POST`, `WaitInput` |
| Extension Host Settings | 77 | `host.ts`, `settingsWrite.ts`, `AdsState` |
| Object Creation | 71 | `objects.ts`, `createObject`, `BUILTIN_TYPES` |
| ADS Host Leases | 69 | `AdsHost`, `scopeSummary`, `acquire` |
| IO-Link Masters | 68 | `iolinkmasters.ts`, `extractBox`, `IoLinkDevice` |
| Project File Commands | 67 | `commands/projectFiles.ts`, `editProject` |
| Analysis Roots | 64 | `analysisRoots.ts`, `globToRegExp`, `DEFAULT_ROOT_PRAGMAS` |
| Config Diff | 60 | `configdiff.ts`, `diffConfig`, `configToYaml` |
| Blame Command | 57 | `commands/blame.ts`, `registerBlame` |
| Watch Groups | 57 | `watchGroups.ts`, `WatchEntry`, `addToGroup` |
| Log Scanning | 57 | `logscan.ts`, `scanFile`, `BUILT_IN_FORMATS` |
| Tree Filter | 55 | `treeFilter.ts`, `filterKey` |
| Object Staging | 55 | `commands/objectStage.ts`, `Snapshot` |
| Config Fields & Log FS | 53 | `configFields.ts`, `logFs.ts` |
| Array Init Checks | 53 | `arrays.ts`, `checkArrayInit` |
| CLI Entry Point | 48 | `cli.ts`, `main`, `difftool` |
| ADS LM Tools | 47 | `mcpTools.ts`, `registerAdsLmTools`, `toolInput.ts` |
| Project Check | 47 | `commands/projectCheck.ts` |
| ADS Interface Types | 46 | `adsinterface.ts`, `AdsSymbol`, `AdsChange` |
| ADS Write Gate | 45 | `adsWrite.ts`, `adsWriteGate`, `aiSettings.ts` |
| Write Decision Policy | 45 | `gatePolicyFor`, `GatePolicy`, `PreparedWrites` |
| XTI Stats Script | 43 | `xtistats.js` |

### CLI (C#)

| Community | Size | Main files and symbols |
| --- | --- | --- |
| Watch Host Backend | 89 | `TargetCommands.RunWatchHost`, `UnavailableBackend` |
| ADS Faults & Watch Host | 80 | `WatchHost`, `AdsFault`, `AdsCode`, `ConnectionLost` |
| Beckhoff Link | 76 | `BeckhoffLink`, `IAdsLink`, `Symbol.Prepare/Write` |
| ADS Backend Tests | 71 | `AdsWatchBackendTests`, `SumWrite`, `AdsException` |
| CLI Tools & Library Cmds | 62 | `LibraryCommands`, `DoctorCommand`, `RepTool.Install` |
| Library Identity | 58 | `LibraryId`, `LibraryReference`, `IsNewest` |
| XAE Shell Options | 49 | `XaeShell`, `ShellOptions`, `ComCall.Release` |
| Rep Tool | 49 | `RepTool`, `Profile`, `TwinCatDir` |
| ADS Client Symbols | 48 | `AdsClient`, `AmsNetId`, `Symbol`, `BaseType` |
| Bridge Link Channel | 47 | `Link`, `Channel`, `Link.ReadLoop` |
| Sum Reader/Writer | 46 | `BeckhoffLink`, `SumReader`, `SumWriter` |
| Workspace Commands | 46 | `WorkspaceCommands.Build/Graph/List`, `Artifacts.Find` |
| MCP Command & Bridge | 44 | `McpCommand`, `McpBridge.Call` |
| COM Call Retry | 42 | `ComCall.Retry/IsBusy/IsFileLocked` |
| XAE Login & Release | 42 | `XaeShell.Login/SelectUserDb`, `WorkspaceCommands.Release` |
| MCP Bridge Tests | 52 | `McpBridgeTests` (frame limit, duplicate ids, oversized replies) |

The CLI and extension talk over the ADS MCP bridge. The bridge appears on both sides
(`McpBridge` and `Link` in C#, `mcpPipe.ts` and `mcpTools.ts` in TypeScript).

## Import cycles

One cycle was found: `extension/src/core/adsinterface.ts` and `extension/src/core/tmc.ts` import each other.
That is the only 2-file cycle the graph reports.

## Doc-derived groups (hyperedges)

Groups of three or more concepts that belong together, taken from the plans and research notes:

- Side-effect-free build and pre-flight items of the CLI build workflow.
- Branches merged into the combined all-in-one branch (object analysis, ADS tools, object checks, tree filter, log viewer).
- AI write-safety mechanisms for ADS tools: write gate, persistent guard, batch write, allowlist.
- ADS MCP stdio bridge stack: relay, wire contract, selection, window server, session.
- `ads_wait` pipeline: condition, watch-list holds, run, pending data.
- Log viewer core pipeline: format, scan, store, filter, search worker, session.
- `ads_scope` options built on the change log (wishlist A).
- `ads_write` features that share one write gate (wishlist C).
- CLI features gated by the protocol version table.
- Object analysis sub-plans that share foundations (graph, unused objects, impact and Mermaid).
- Plans that produce `Finding` results (IO-link checks, structure checks, OOP rules, unused view).
- CLI build pipeline decisions: preflight, TC line guard, isolate, root cause.
- The three demo GIFs of the extension, all recorded on the same PLC workspace.

## Cross-document links the graph inferred

All INFERRED, so treat as hints:

- Research idea "Beckhoff TcProjectCompare" is semantically similar to the shipped "Config Changes" panel.
- The CLI mockup (`mockup/index.html`) matches the command table in `cli/README.md`.
- Install channels in `README.md` match the distribution channels in the mockup.
- "Compare by identity, not by line" (xti-diff research) is the rationale for the Config Changes panel.

## Follow-up questions the graph suggests

- Are the 228 isolated symbols real gaps or an extraction blind spot?
- Should `ADS Tool Dialogs` (cohesion 0.04) be split into smaller modules?
- Can the `adsinterface.ts` / `tmc.ts` cycle be broken?
