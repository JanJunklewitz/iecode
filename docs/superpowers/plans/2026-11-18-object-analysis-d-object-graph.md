# Plan D: Object Graph

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One model of which PLC object or member references which, where the entry points are (PLC tasks and configured roots), and which objects are reachable; the base for "unused objects" (Plan E), "impact" and Mermaid export (Plan F).

**Architecture:** `core/unitIndex.ts` (Task 0, shared with Plan H) builds **one `SymbolIndex` per PLC project** from the files on disk (master decision 8). `core/objectGraph.ts` extracts per-file reference edges with it, assembles them into a graph, adds the implicit edges TwinCAT creates (override, interface call, `FB_init`) and answers reachability both ways. `core/analysisRoots.ts` finds the roots. `core/analysisState.ts` keeps the graph per project up to date and computes asynchronously in slices. No VS Code API in Tasks 0 to 3 (Task 0 takes its inputs as parameters).

**Tech Stack:** TypeScript (`node --test`); `lang/lexer.ts`, `lang/parser.ts`, `lang/index.ts`; `core/plcArchive.ts` (`parsePlcArchive`, `Task.calls`).

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decisions 5 and 6, open question 2). Note: the existing "Dependency graph" (`views/graph.ts`, `core/workspace.ts`) is a graph of PLC projects and libraries, not of objects; this plan builds the object level.

## Global Constraints

- See the master plan. Anything the analysis cannot resolve counts as reachable, never as unused.
- Library objects (`IndexedObject.library` set) are graph nodes (so edges into them resolve) but are never reported.
- Node ids: object `FB_X` (upper-cased for lookup, original spelling kept for display), member `FB_X.Start`. A node from a library source gets the library as prefix (`<lib>::FB_X`, from `IndexedObject.library` of the resolved `Location.file`), so a workspace object and a library object (or two libraries) with the same name are two nodes (`SymbolIndex` keeps both in `byFile`, only `byName` prefers one). Variables are not nodes in this plan (an access to a variable is an edge to its owning object, and for a member variable of the same object it is no edge). The graph is per PLC project: two projects with an object of the same name never share a node.
- A member is never reported as unused when it **implements an interface member or overrides a base member** (contract members): deleting it breaks the build, and a library may call it through the interface. **It is also reachable** (reason `contract`) whenever its owner is reachable, so that what it calls is not reported either (callback and event-handler designs). The members of an interface are never reported on their own (only the whole interface object can be unused). Implementers of an interface include implementers of its sub-interfaces (`I_Y EXTENDS I_X`: a call through `I_X` reaches `FB_A.M` of `FB_A IMPLEMENTS I_Y`) and `IMPLEMENTS` inherited from a base class: reuse `classChain` and the interface closure of `lang/inheritance.ts` (export `interfaceClosure`).
- **Completeness:** `UnitAnalysis.complete` is false when a file of the unit failed to decode or parse, is encrypted (`PlcObject.encrypted`; its callees are invisible), or a task call names no node. When it is false, `unreferenced` / `only-from-unused` findings are not produced at all (the notes say why), never partial.
- Property accessor sections (`GET`, `SET`) belong to their property: `from` is the property node.
- A section whose implementation is not ST has no text in the view; its raw XML is scanned for words (master decision 9).

## Review Focus

1. **Interface call:** `itf.M()` where `itf : I_X` makes `FB_A.M` and `FB_B.M` reachable for every `FB_A`, `FB_B` that `IMPLEMENTS I_X` and are themselves reachable.
2. **Override:** a method of a derived function block is reachable when the same-named method of any base in the `EXTENDS` chain is reachable and the derived block is reachable; `SUPER^.M()` makes the base method reachable.
3. `FB_init`, `FB_exit`, `FB_reinit` of a reachable function block are reachable without any textual call.
4. An identifier that cannot be resolved (unknown name, call through a pointer, library without source) marks every member of that name in the project reachable, with the reason `by-name`.
5. Recursive and mutually recursive calls, and an object that extends itself by mistake, terminate.
6. **Qualified task call (measured on a real project):** a project has two task files; one calls `MAIN`, the other a program of a visualization library with a namespace prefix (`<Lib>.<Program>`). The call resolves through `SymbolIndex.find`, which skips a known namespace prefix; if the library has no source in the index, the call is a note, not a root and not an error. The same project has 141 visualization files, so the visualization text roots below matter in practice.
7. Objects named only in a visualization file (`.TcVIS`) or in `iecode.analysis.rootObjects` are roots.
8. **Non-ST bodies:** a function called only from a CFC / FBD / LD / SFC body is reachable (reason `non-st`), and the word scan of that body makes edges from its own section node, not from the whole object.
9. **Contract members:** `FB_A.M` that implements `I_X.M` is never listed as unused, even when nothing calls `I_X.M`; the same for an override of a base method and for an implementation of a library interface whose source is not in the index.
10. **Name clash across projects:** two PLC projects of the workspace both have `MAIN` and a GVL with the same name; each project's analysis resolves into its own objects only (a library project in the workspace that the application references is part of that application's index).
11. **Unsaved edits:** the analysis reads the files on disk; a dirty ST view does not change the result until saved.

## File Structure

- Create `extension/src/core/unitIndex.ts`, `extension/src/core/objectGraph.ts`, `extension/src/core/analysisRoots.ts`, `extension/src/core/analysisState.ts`.
- Modify `extension/src/lang/index.ts` (`resolveAt`, GVL name map, `add(obj)`), `extension/src/lang/librarySources.ts` (`librariesOf(unit)`), `extension/src/lang/inheritance.ts` (export `interfaceClosure`), `extension/package.json` (settings `iecode.analysis.rootObjects`, array of strings, default `[]`, and `iecode.analysis.rootPragmas`, array of strings, default `["TcRpcEnable", "call_after_init", "call_after_global_init_slot", "call_after_online_change_slot", "OPC.UA.DA"]`), `extension/src/extension.ts` (construct `AnalysisState`), `CHANGELOG.md`.
- Tests: `extension/test/unitIndex.test.ts`, `extension/test/objectGraph.test.ts`, `extension/test/analysisRoots.test.ts`, `extension/test/analysisState.test.ts`. Build indexes in tests with `SymbolIndex.update(file, viewText)` from small view-text strings, as `lang.test.ts` does.

### Task 0: Per-unit index (shared with Plan H)

**Files:** Create `extension/src/core/unitIndex.ts`, `extension/test/unitIndex.test.ts`; modify `extension/src/lang/index.ts`, `extension/src/lang/librarySources.ts`.

**Interfaces:**
- Consumes: `Unit` (`core/workspace.ts`; `unit.plc` is a `PlcProject` from `core/projects.ts` with `objects`, `references`, `isLibrary`; `WorkspaceModel.edges` with `link: 'workspace' | 'pinned'`), `LibrarySources` (`lang/librarySources.ts`, workspace-wide, keyed by library name, capped at 60 libraries, dependency list private), `decode`.
- Produces:
  ```ts
  export interface UnitIndexInput { readFile(file: string): Promise<string | undefined>; libraryObjects(unit: Unit): { key: string; view: string; library: string }[]; namespaces(unit: Unit): Map<string, string> }
  export async function buildUnitIndex(unit: Unit, model: Pick<WorkspaceModel, 'units' | 'edges'>, input: UnitIndexInput, notes: string[]): Promise<{ index: SymbolIndex; skipped: { file: string; reason: 'unreadable' | 'encrypted' | 'not-st' }[] }>
  ```
  The index holds the unit's own object files (from disk, `decode` of each), the object files of the workspace library projects the unit references with `link: 'workspace'` (a `pinned` edge means the unit uses the compiled library, so the workspace source is **not** indexed; the compiled library comes through `libraryObjects`), and the library sources of the unit's references plus their transitive dependencies (new `LibrarySources.librariesOf(unit)`). Namespaces per unit (`index.setNamespaces`, built from `unit.plc.references` placeholders) so `find()` skips a `<Lib>.` prefix. Parsed library `IndexedObject`s are shared between unit indexes through a new `SymbolIndex.add(obj)` (parsing every library view again for every unit costs time and memory times the number of units). Files that cannot be read, are encrypted or do not decode are returned in `skipped` (they make an analysis incomplete).
  `lang/providers.ts` keeps its own workspace-wide editor index; nothing there changes.

- [ ] **Step 1: Write the failing tests** (inject the reader and the library data): `two units with a MAIN each get separate indexes`; `a workspace library project referenced with link workspace is indexed, a pinned one is not`; `namespaces make a Lib.FB_X name resolve`; `a library object parsed once is shared by two unit indexes` (spy on parsing); `an unreadable and an encrypted file are reported in skipped`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `buildUnitIndex`, `LibrarySources.librariesOf(unit)` (references plus transitive dependencies, using the dependency data `LibrarySources` already loads) and `SymbolIndex.add`.
- [ ] **Step 4: Run tests.** Expected: PASS, and the existing `lang.test.ts` still passes.
- [ ] **Step 5: Commit** `Build a symbol index per PLC project` (body: the editor index is one workspace-wide map keyed by object name, so two applications with the same MAIN or GVL name resolve into each other; analyses and lint rules need per-project resolution).

### Task 1: Per-file reference edges

**Files:** Create `extension/src/core/objectGraph.ts`, `extension/test/objectGraph.test.ts`.

**Interfaces:**
- Consumes: `SymbolIndex.resolve(file, line, col): Location | undefined` (`Location.symbol` and `Location.owner` give the target and its object), `IndexedObject`, `tokenize(view, true)`, `sections` / `HEADER_RE` (section of a line), `nonStBodies(xml)` (`model.ts`: raw XML of every non-ST implementation by section key).
- Produces:
  ```ts
  export type NodeId = string
  export interface GraphNode { id: NodeId; name: string; kind: SymbolKind; file: string; line: number; library: boolean; owner?: NodeId }
  export interface FileEdges { nodes: GraphNode[]; refs: { from: NodeId; to: NodeId; line: number }[]; unresolved: { from: NodeId; name: string; line: number }[]; words: { from: NodeId; word: string }[] }
  export function fileEdges(index: SymbolIndex, obj: IndexedObject, nonSt?: Map<string, string>): FileEdges
  ```
  `from` is the member node when the identifier sits inside a METHOD / PROPERTY (also GET / SET) / ACTION / TRANSITION section, otherwise the object node; the declaration part of an object counts for the object node. `EXTENDS` / `IMPLEMENTS` names in the header are edges from the object to the base / interface. Skip identifier tokens that are comments, strings, pragmas, keywords, elementary types, the declared name itself, and those that resolve to the object's own variables or to a local. `words` holds, per non-ST section, every identifier-like word of its raw XML (`[A-Za-z_]\w*`); `assemble` turns a word that equals (case-insensitively) the name of a node of the project into a reference by name (reason `non-st`), a word that matches nothing is dropped.

- [ ] **Step 1: Write the failing tests:** `a call of a method of another function block is an edge from the calling member to the called member`; `a type name in a declaration is an edge to the object`; `EXTENDS and IMPLEMENTS give edges to the base and the interface`; `a reference to a GVL variable is an edge to the GVL`; `a reference to an own variable or a local gives no edge`; `identifiers in comments and strings give no edge`; `an unknown identifier is listed as unresolved with its line`; `a program with no references gives only its own node`; `__NEW(FB_X) and ARRAY OF FB_X give an edge to FB_X`; `a call inside a property GET is an edge from the property`; `a non-ST body gives words attributed to its own section`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `fileEdges` with one `resolve` call per identifier token (reuse the token stream, not `wordAt`); dot chains come through `resolve` as it already walks qualifiers. Note on cost: every `resolve` call (`lang/index.ts` lines 95 to 136) splits the view into lines, recomputes the offset, **and runs `inTrivia`, which tokenizes the whole file again** (lines 101 and 149 to 151); for a name that is not local, not an own member and not an object it also loops over every indexed file looking for a GVL variable (lines 132 to 136). One call per identifier would be quadratic. So Task 1 first adds (own commit, in `lang/index.ts`) `resolveAt(obj, line, col, offset)`: the same lookup without `inTrivia` (`fileEdges` already drops comment, string and pragma tokens) and with a cached line-offset table per `IndexedObject`, plus a map from GVL variable name to location maintained in `update()` / `remove()`; `resolve` keeps its behaviour and calls the shared part. Tests: `resolveAt gives the same result as resolve for every identifier of a fixture`, and a performance test with one 5000-line GVL, 20000 identifier tokens and **a few thousand library objects loaded into the index**; print the time, fail above 2 s per file.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Extract reference edges per PLC object` (body: the existing dependency graph only knows projects; unused-object and impact analysis need object-level edges).

### Task 2: Graph, implicit edges, reachability

**Files:** Modify `extension/src/core/objectGraph.ts`, `extension/test/objectGraph.test.ts`.

**Interfaces:**
- Consumes: `FileEdges` (Task 1); `SymbolIndex.membersOf`, `classChain` from `lang/inheritance.ts` for EXTENDS chains; `PlcSymbol.implements`.
- Produces:
  ```ts
  export interface ObjectGraph { nodes: Map<NodeId, GraphNode>; out: Map<NodeId, Edge[]>; in: Map<NodeId, Edge[]>; byNameUnresolved: Map<string, NodeId[]> }
  export interface Edge { to: NodeId; from: NodeId; line: number; reason: 'call' | 'type' | 'extends' | 'implements' | 'non-st' | 'interface' | 'override' | 'contract' | 'implicit' }   // call-site lines and reasons are kept: Plan F lists callers with their lines, `whyReachable` explains implicit edges
  export function assemble(files: FileEdges[], index: SymbolIndex): ObjectGraph        // adds implicit edges
  export interface Reach { reachable: Map<NodeId, { via: NodeId | null; reason: 'root' | 'call' | 'interface' | 'override' | 'contract' | 'implicit' | 'by-name' | 'non-st' }> }   // roots are records: two tasks that call one program stay distinguishable (`roots: { id: NodeId; task: string }[]` in Task 3)
  export function reach(g: ObjectGraph, roots: NodeId[]): Reach
  export function whyReachable(r: Reach, id: NodeId): { id: NodeId; reason: string }[]     // root first
  export interface UnusedFinding { id: NodeId; confidence: 'unreferenced' | 'only-from-unused' }
  export function findUnused(g: ObjectGraph, r: Reach): UnusedFinding[]
  export function callersOf(g: ObjectGraph, id: NodeId): NodeId[]
  export function reachedFrom(g: ObjectGraph, id: NodeId, roots: NodeId[]): NodeId[]       // the roots from which `id` is reachable
  ```
  `reach` is a fixed-point walk: after each pass, apply the implicit rules (interface, override, `FB_init` / `FB_exit` / `FB_reinit` of a reachable owner, by-name for unresolved names and for `non-st` words) until nothing is added. `findUnused` skips library nodes and nodes of library projects, contract members (a member that implements an interface member or overrides a base member, including a base or interface that is not in the index; the members of an interface), and members of an unused object (the object carries the finding); `unreferenced` means no inbound edge from anything (reachable or not), `only-from-unused` means every inbound edge comes from an unreachable node.

- [ ] **Step 1: Write the failing tests**, one per Review Focus 1 to 5, 8 and 9 plus: `an object called only by an unused object is only-from-unused`; `an object nobody references is unreferenced`; `whyReachable returns the path from the task program to a method`; `a library node is never listed as unused`; `an interface method nobody calls is not listed, nor its implementations`; `a call through I_X reaches FB_A.M when FB_A implements I_Y that extends I_X`; `IMPLEMENTS inherited from a base class counts`; `a contract member of a reachable owner is reachable and what it calls is not unused`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the functions. The unresolved-name rule matches member names case-insensitively across all nodes of the analysed project.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add reachability with interface, override and init rules` (body: without the implicit edges every interface implementation would show up as unused).

### Task 3: Roots

**Files:** Create `extension/src/core/analysisRoots.ts`, `extension/test/analysisRoots.test.ts`.

**Interfaces:**
- Consumes: `parsePlcArchive(xml)` returning `Task` (kind `'task'`, `calls: Scalar[]` with `.value` the called program name); the object list of a unit: `PlcProject` lives in `core/projects.ts` (not `core/plcproj.ts`, which edits `.plcproj` text); `plc.objects` carries tasks with type `'TASK'` and visualizations under `'OTHER'` (`projects.ts` lines 170 to 172), filter visualizations by the extension `.TcVIS`.
- Produces:
  ```ts
  export interface RootSources { taskFiles: string[]; visuTexts: string[]; extra: string[]; rootPragmas: string[] }   // raw file texts and the configured patterns / pragma names
  export function rootsOf(g: ObjectGraph, index: SymbolIndex, src: RootSources): { roots: { id: NodeId; task?: string }[]; notes: string[] }   // `index` gives the declaration text for the pragma scan
  export function globToRegExp(pattern: string): RegExp                                       // `*`, `?`, case-insensitive
  ```
  Roots: every task call that names a node; every node whose name appears as a whole word in a visualization file text (reason note `visualization`); every node matching `extra`; every node carrying one of the configured pragmas `iecode.analysis.rootPragmas` (defaults `TcRpcEnable`, `call_after_init`, `call_after_global_init_slot`, `call_after_online_change_slot`, `OPC.UA.DA`; also a property with `monitoring := 'call'`): the parser keeps pragmas as tokens; if the object / member pragma is not available from `PlcSymbol`, scan the declaration view text before the first `FUNCTION_BLOCK` / `METHOD` keyword; every GVL or program that declares an `AT %I*` / `%Q*` variable (linked to IO, used without any code reference; reason `io`). TcHMI projects are not scanned (not a PLC project file type here): the note says so. A task call that names no node produces a note, not an error. A project with no task file produces the note `no tasks found, nothing can be reported as unused` and the caller must then report no findings.

- [ ] **Step 1: Write the failing tests:** `task calls become roots`; `a name used in a visualization text is a root`; `a configured glob matches objects case-insensitively`; `a call to an unknown program gives a note`; `no task file means roots is empty and the note says so`; `a configured pragma (TcRpcEnable, call_after_init, OPC.UA.DA) makes an object or member a root`; `a GVL with an AT %I variable is a root`; `two tasks that call one program give two root records`; `a library-interface callback target is reachable (reason contract) and what it calls is not reported`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Find the entry points for the reachability analysis` (body: tasks alone miss objects that only a visualization or RPC attribute reaches, and those would be false "unused" findings).

### Task 4: Analysis state per PLC project

**Files:** Create `extension/src/core/analysisState.ts`, `extension/test/analysisState.test.ts`; modify `extension/package.json`, `extension/src/extension.ts`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `WorkspaceState` (`state.ts`: `current`, `onDidChange`), `Unit` (`core/workspace.ts`: `group`, `plc: PlcProject` with `objects`, `isLibrary`; `edges` give the workspace library projects a unit references), `LibrarySources` (`lang/librarySources.ts`, the compiled libraries; the editor index in `lang/providers.ts` shows how they are fed), `SymbolIndex`, Tasks 1 to 3. **Do not reuse the editor index** of `lang/providers.ts`: it is one `SymbolIndex` for the whole workspace keyed by object name and holds unsaved editor text (master decision 8). `core/adsinterface.ts` `fromSource` already builds its own `SymbolIndex` from `{ file, view }` pairs; do the same per unit.
- Produces:
  ```ts
  export interface UnitAnalysis { unit: string; graph: ObjectGraph; reach: Reach; roots: { id: NodeId; task?: string }[]; unused: UnusedFinding[]; notes: string[]; complete: boolean; skipped?: 'library' | 'no-tasks' }
  export class AnalysisState {
    peek(unitId: string): UnitAnalysis | undefined          // cached result or undefined; never blocks
    request(unitId: string): Promise<UnitAnalysis>           // computes if needed, in slices
    onDidChange: Event<string[]>; dispose(): void
  }
  ```
  The index comes from `buildUnitIndex` (Task 0). What is cached per file, by mtime and size (not by editor text), is the **decoded view and the token stream**; resolved edges are **not** cached across changes, because a reference resolves through other files (a callee's declaration, a base class, a GVL variable's type) and an unchanged caller can resolve differently after another file changed. A change of any file of the unit therefore re-runs `fileEdges` for the whole unit (cheap with `resolveAt`, measured in the test below); an incremental scheme is a later step and only if that measurement says it is needed. `complete` is false when `buildUnitIndex` reported skipped files or a task call names no node (Global Constraints). The trigger is a file-watcher event or a save, never a keystroke. The computation yields to the event loop every 25 files (`setImmediate`) and honours a cancellation token, so a first run on a 400-file project does not freeze the extension host. A unit with `plc.isLibrary` yields `skipped: 'library'` (use `plc.isLibrary`, **not** `Unit.group`: `discover()` marks every PLC of a solution that contains any library as group `library`, which would skip an application). `peek` lets the tree ask without waiting: it shows nothing until the result exists, then `onDidChange` refreshes it.

- [ ] **Step 1: Write the failing tests** (no VS Code: inject the file reader and the library views): `a changed file re-decodes only itself but the unit's edges are recomputed` (spy on decode and `fileEdges`); `a change in a callee's declaration changes the resolution of an unchanged caller`; `an encrypted file makes the analysis incomplete and no unused findings are produced`; `a library unit is skipped`; `a unit without task file is skipped with the note`; `two units with a MAIN each resolve into their own objects` (Review Focus 10); `the analysis yields between slices` (a reader that records the event-loop turns); `a generated project of 500 objects with 200 lines each analyses in under 10 s` (loose bound; print the measured time and write it in the PR; the real project of the master plan has 359 object files).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `AnalysisState` and construct it in `extension.ts` next to the other state objects; it computes lazily on the first `request` call, not at startup.
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual check: `iecode.analysis.rootObjects` appears in settings.
- [ ] **Step 5: Commit** `Keep the object graph per PLC project up to date` (body: Plans E and F both read the same analysis; recomputing per file keeps typing in the ST view cheap).
