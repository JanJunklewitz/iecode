# Plan D: Object Graph

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One model of which PLC object or member references which, where the entry points are (PLC tasks and configured roots), and which objects are reachable; the base for "unused objects" (Plan E), "impact" and Mermaid export (Plan F).

**Architecture:** `core/objectGraph.ts` extracts per-file reference edges with the existing `SymbolIndex` (`lang/index.ts`), assembles them into a graph, adds the implicit edges TwinCAT creates (override, interface call, `FB_init`) and answers reachability both ways. `core/analysisRoots.ts` finds the roots. `core/analysisState.ts` keeps the graph per PLC project up to date. No VS Code API in the first three tasks.

**Tech Stack:** TypeScript (`node --test`); `lang/lexer.ts`, `lang/parser.ts`, `lang/index.ts`; `core/plcArchive.ts` (`parsePlcArchive`, `Task.calls`).

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decisions 5 and 6, open question 2). Note: the existing "Dependency graph" (`views/graph.ts`, `core/workspace.ts`) is a graph of PLC projects and libraries, not of objects; this plan builds the object level.

## Global Constraints

- See the master plan. Anything the analysis cannot resolve counts as reachable, never as unused.
- Library objects (`IndexedObject.library` set) are graph nodes (so edges into them resolve) but are never reported.
- Node ids: object `FB_X` (upper-cased for lookup, original spelling kept for display), member `FB_X.Start`. Variables are not nodes in this plan (an access to a variable is an edge to its owning object, and for a member variable of the same object it is no edge).

## Review Focus

1. **Interface call:** `itf.M()` where `itf : I_X` makes `FB_A.M` and `FB_B.M` reachable for every `FB_A`, `FB_B` that `IMPLEMENTS I_X` and are themselves reachable.
2. **Override:** a method of a derived function block is reachable when the same-named method of any base in the `EXTENDS` chain is reachable and the derived block is reachable; `SUPER^.M()` makes the base method reachable.
3. `FB_init`, `FB_exit`, `FB_reinit` of a reachable function block are reachable without any textual call.
4. An identifier that cannot be resolved (unknown name, call through a pointer, library without source) marks every member of that name in the project reachable, with the reason `by-name`.
5. Recursive and mutually recursive calls, and an object that extends itself by mistake, terminate.
6. **Qualified task call (measured on a real project):** a project has two task files; one calls `MAIN`, the other a program of a visualization library with a namespace prefix (`<Lib>.<Program>`). The call resolves through `SymbolIndex.find`, which skips a known namespace prefix; if the library has no source in the index, the call is a note, not a root and not an error. The same project has 141 visualization files, so the visualization text roots below matter in practice.
7. Objects named only in a visualization file (`.TcVIS`) or in `iecode.analysis.rootObjects` are roots.

## File Structure

- Create `extension/src/core/objectGraph.ts`, `extension/src/core/analysisRoots.ts`, `extension/src/core/analysisState.ts`.
- Modify `extension/package.json` (setting `iecode.analysis.rootObjects`, array of strings, default `[]`), `extension/src/extension.ts` (construct `AnalysisState`), `CHANGELOG.md`.
- Tests: `extension/test/objectGraph.test.ts`, `extension/test/analysisRoots.test.ts`, `extension/test/analysisState.test.ts`. Build indexes in tests with `SymbolIndex.update(file, viewText)` from small view-text strings, as `lang.test.ts` does.

### Task 1: Per-file reference edges

**Files:** Create `extension/src/core/objectGraph.ts`, `extension/test/objectGraph.test.ts`.

**Interfaces:**
- Consumes: `SymbolIndex.resolve(file, line, col): Location | undefined`, `IndexedObject`, `tokenize(view, true)`, `sections` / `HEADER_RE` (section of a line).
- Produces:
  ```ts
  export type NodeId = string
  export interface GraphNode { id: NodeId; name: string; kind: SymbolKind; file: string; line: number; library: boolean; owner?: NodeId }
  export interface FileEdges { nodes: GraphNode[]; refs: { from: NodeId; to: NodeId; line: number }[]; unresolved: { from: NodeId; name: string; line: number }[] }
  export function fileEdges(index: SymbolIndex, obj: IndexedObject): FileEdges
  ```
  `from` is the member node when the identifier sits inside a METHOD / PROPERTY / ACTION / TRANSITION section, otherwise the object node; the declaration part of an object counts for the object node. Skip identifier tokens that are comments, strings, pragmas, keywords, elementary types, the declared name itself, and those that resolve to the object's own variables or to a local.

- [ ] **Step 1: Write the failing tests:** `a call of a method of another function block is an edge from the calling member to the called member`; `a type name in a declaration is an edge to the object`; `a reference to a GVL variable is an edge to the GVL`; `a reference to an own variable or a local gives no edge`; `identifiers in comments and strings give no edge`; `an unknown identifier is listed as unresolved with its line`; `a program with no references gives only its own node`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `fileEdges` with one `resolve` call per identifier token (reuse the token stream, not `wordAt`); dot chains come through `resolve` as it already walks qualifiers. Note in a code comment that `resolve` scans all GVLs for an unqualified name and measure that in Task 4.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Extract reference edges per PLC object` (body: the existing dependency graph only knows projects; unused-object and impact analysis need object-level edges).

### Task 2: Graph, implicit edges, reachability

**Files:** Modify `extension/src/core/objectGraph.ts`, `extension/test/objectGraph.test.ts`.

**Interfaces:**
- Consumes: `FileEdges` (Task 1); `SymbolIndex.membersOf`, `classChain` from `lang/inheritance.ts` for EXTENDS chains; `PlcSymbol.implements`.
- Produces:
  ```ts
  export interface ObjectGraph { nodes: Map<NodeId, GraphNode>; out: Map<NodeId, Set<NodeId>>; in: Map<NodeId, Set<NodeId>>; byNameUnresolved: Map<string, NodeId[]> }
  export function assemble(files: FileEdges[], index: SymbolIndex): ObjectGraph        // adds implicit edges
  export interface Reach { reachable: Map<NodeId, { via: NodeId | null; reason: 'root' | 'call' | 'interface' | 'override' | 'implicit' | 'by-name' }> }
  export function reach(g: ObjectGraph, roots: NodeId[]): Reach
  export function whyReachable(r: Reach, id: NodeId): { id: NodeId; reason: string }[]     // root first
  export interface UnusedFinding { id: NodeId; confidence: 'unreferenced' | 'only-from-unused' }
  export function findUnused(g: ObjectGraph, r: Reach): UnusedFinding[]
  export function callersOf(g: ObjectGraph, id: NodeId): NodeId[]
  export function reachedFrom(g: ObjectGraph, id: NodeId, roots: NodeId[]): NodeId[]       // the roots from which `id` is reachable
  ```
  `reach` is a fixed-point walk: after each pass, apply the implicit rules (interface, override, `FB_init` / `FB_exit` / `FB_reinit` of a reachable owner, by-name for unresolved names) until nothing is added. `findUnused` skips library nodes and nodes of library projects; `unreferenced` means no inbound edge from anything (reachable or not), `only-from-unused` means every inbound edge comes from an unreachable node.

- [ ] **Step 1: Write the failing tests**, one per Review Focus 1 to 5 plus: `an object called only by an unused object is only-from-unused`; `an object nobody references is unreferenced`; `whyReachable returns the path from the task program to a method`; `a library node is never listed as unused`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions. The unresolved-name rule matches member names case-insensitively across all nodes of the analysed project.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add reachability with interface, override and init rules` (body: without the implicit edges every interface implementation would show up as unused).

### Task 3: Roots

**Files:** Create `extension/src/core/analysisRoots.ts`, `extension/test/analysisRoots.test.ts`.

**Interfaces:**
- Consumes: `parsePlcArchive(xml)` returning `Task` (kind `'task'`, `calls: Scalar[]` with `.value` the called program name); the `.plcproj` file list of a unit (`PlcProject` from `core/plcproj.ts`, check which field lists compile files and `.TcTTO` / `.TcVIS` entries).
- Produces:
  ```ts
  export interface RootSources { taskFiles: string[]; visuTexts: string[]; extra: string[] }   // raw file texts and the configured patterns
  export function rootsOf(g: ObjectGraph, src: RootSources): { roots: NodeId[]; notes: string[] }
  export function globToRegExp(pattern: string): RegExp                                       // `*`, `?`, case-insensitive
  ```
  Roots: every task call that names a node; every node whose name appears as a whole word in a visualization file text (reason note `visualization`); every node matching `extra`; every node carrying the pragma `{attribute 'TcRpcEnable'}` (the parser keeps pragmas as tokens; if the object / member pragma is not available from `PlcSymbol`, scan the declaration view text before the first `FUNCTION_BLOCK` / `METHOD` keyword). A task call that names no node produces a note, not an error. A project with no task file produces the note `no tasks found, nothing can be reported as unused` and the caller must then report no findings.

- [ ] **Step 1: Write the failing tests:** `task calls become roots`; `a name used in a visualization text is a root`; `a configured glob matches objects case-insensitively`; `a call to an unknown program gives a note`; `no task file means roots is empty and the note says so`; `the TcRpcEnable pragma makes an object a root`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Find the entry points for the reachability analysis` (body: tasks alone miss objects that only a visualization or RPC attribute reaches, and those would be false "unused" findings).

### Task 4: Analysis state per PLC project

**Files:** Create `extension/src/core/analysisState.ts`, `extension/test/analysisState.test.ts`; modify `extension/package.json`, `extension/src/extension.ts`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `WorkspaceState` (`state.ts`: `current`, `onDidChange`), `Unit`, `SymbolIndex` as the extension builds it (read how `lang/index.ts` / `lang/providers.ts` feed it before wiring; reuse that index, do not build a second one), Tasks 1 to 3.
- Produces:
  ```ts
  export interface UnitAnalysis { unit: string; graph: ObjectGraph; reach: Reach; roots: NodeId[]; unused: UnusedFinding[]; notes: string[]; skipped?: 'library' | 'no-tasks' }
  export class AnalysisState { analysisOf(unitId: string): UnitAnalysis | undefined; onDidChange: Event<string[]>; dispose(): void }
  ```
  Per-file `FileEdges` are cached by the object's view text; a changed or removed file recomputes only that file, then `assemble` and `reach` run again for its unit. A unit of a library project yields `skipped: 'library'`.

- [ ] **Step 1: Write the failing tests** (no VS Code: inject the index and a file reader): `a changed file recomputes only its own edges` (spy on `fileEdges` calls); `a library unit is skipped`; `a unit without task file is skipped with the note`; `a generated project of 500 objects with 200 lines each analyses in under 10 s` (loose bound; print the measured time and write it in the PR).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `AnalysisState` and construct it in `extension.ts` next to the other state objects; it computes lazily on the first `analysisOf` call, not at startup.
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual check: `iecode.analysis.rootObjects` appears in settings.
- [ ] **Step 5: Commit** `Keep the object graph per PLC project up to date` (body: Plans E and F both read the same analysis; recomputing per file keeps typing in the ST view cheap).
