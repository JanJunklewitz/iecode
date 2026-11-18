# Plan F: Impact View and Mermaid Export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) "What is affected if I change or rename this object, member or variable": tasks, callers and IO links. (2) Export the project graph and the object graph as Mermaid text for docs and pull requests.

**Architecture:** `core/impact.ts` answers the impact question from `ObjectGraph` (Plan D) plus the IO links of the system project (`core/iotree.ts` `readProject`, `core/iolinks.ts` `toIoLink`). `core/graphExport.ts` renders Mermaid from `ObjectGraph`; the project graph reuses the existing `toMermaid` in `core/workspace.ts`, which no command calls yet. `commands/impact.ts` and `commands/graphExport.ts` wire QuickPick and clipboard / save.

**Tech Stack:** TypeScript (`node --test`), VS Code QuickPick, clipboard, save dialog (pattern: `views/umlDiagram.ts` `copyMermaid` / `saveMermaid`).

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md); research [feature-ideas.md](../../research/feature-ideas.md) section 6 ("Impact view" gap) and TODO item "Dependency graph as Mermaid export". Needs Plan D.

## Global Constraints

- See the master plan. Impact is read-only and says what it could not check (no tasks found, IO links not read, variable not resolved).
- Mermaid output is valid for the Mermaid flowchart syntax: node ids are sanitised, labels are quoted, and a graph larger than 300 nodes is exported per task or per selection only (the command asks), never as one unreadable block.

## Review Focus

1. The PLC side of an IO link, as `HwLink.left` has it, is `PlcTask Inputs^MAIN.bStart`; the impact of `MAIN.bStart` must find that link, and a same-named variable in another program must not. Real links also name array elements and sub-paths (`...iaState[3]`, `...stData^D[0]`): the impact of the array variable must find them (use `normalizeLinkPath` of `core/ioLinkSymbols.ts`, created by Plan G Task 1 or here, whichever is built first: lower-case, `[n]` removed, `^` as `.`).
2. Impact of a method called only through an interface lists the callers of the interface method.
3. Names with characters Mermaid cannot take as ids (dots, spaces, brackets, quotes, umlauts) export as valid text (test with a round trip through the id sanitiser: two different names never collapse to one id).
4. Impact of an unused object: "no task reaches it" and the callers list is empty or only unused objects.
5. A project with no IO links file or a `.tsproj` that does not parse: impact still lists code callers and says IO links were not read.

## File Structure

- Create `extension/src/core/impact.ts`, `extension/src/core/graphExport.ts`, `extension/src/commands/impact.ts`, `extension/src/commands/graphExport.ts`.
- Modify `extension/src/extension.ts`, `extension/package.json` (commands `iecode.showImpact`, `iecode.exportGraphMermaid`), `CHANGELOG.md`.
- Tests: `extension/test/impact.test.ts`, `extension/test/graphExport.test.ts`.

### Task 1: Impact model

**Files:** Create `extension/src/core/impact.ts`, `extension/test/impact.test.ts`.

**Interfaces:**
- Consumes: `ObjectGraph`, `callersOf`, `reachedFrom`, `Reach` (Plan D); `IoLink` (`core/iolinks.ts`, field `variable` such as `TIPC^PLC1^PLC1 Instance^PlcTask Inputs^MAIN.bStart`).
- Produces:
  ```ts
  export interface ImpactResult { target: NodeId; tasks: NodeId[]; directCallers: { id: NodeId; line: number }[]; transitiveCallers: number; ioLinks: IoLink[]; notes: string[] }
  export function ioVariablePath(link: IoLink): string | undefined          // 'main.bstart' from 'PlcTask Inputs^MAIN.bStart' via normalizeLinkPath; undefined for a side that is not a PLC area ('TIPC^' safety links, IO sides)
  export function impactOf(g: ObjectGraph, reach: Reach, roots: NodeId[], target: NodeId, links: IoLink[] | undefined, variable?: string): ImpactResult
  ```
  `variable` is an optional member variable path (`MAIN.bStart`) for impact of a variable rather than an object; IO links match when `ioVariablePath(link)` equals the variable path case-insensitively, or starts with it plus `.` (struct member). With `links` undefined the note says IO links were not read.

- [ ] **Step 1: Write the failing tests:** `ioVariablePath cuts the area path and keeps the symbol path` (inputs, outputs, an unrelated path gives undefined); `impact of an object lists tasks, direct callers and the count of transitive callers`; `impact of a variable finds its IO links and not a same-named variable of another program`; `a struct member link matches its struct variable`; `impact of a method called through an interface lists the interface callers`; `undefined links add a note`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Callers through an interface come from the implicit edges Plan D already added to `in`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Compute what a change to an object or variable affects` (body: renaming a variable silently broke IO links and task calls; this lists them before the rename).

### Task 2: Impact command

**Files:** Create `extension/src/commands/impact.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `impactOf` (Task 1); `AnalysisState.analysisOf`; `readProject` (`core/iotree.ts`) through the workspace's system project (`systemProjects` in `core/workspace.ts`), `toIoLink`; the symbol under the cursor via `SymbolIndex.resolve`.
- Produces: `registerImpact(ctx, analysis, state): void`; command `iecode.showImpact` (tree node `object` / `member`, ST editor context menu).

- [ ] **Step 1: Write the failing test** for the pure row builder `impactRows(r: ImpactResult): { label: string; detail?: string; kind: 'task' | 'caller' | 'io' | 'note'; target?: { file: string; line: number } }[]` in `core/impact.ts` (separator-free list: tasks first, then callers, then IO links with `io` side as label and the variable as detail, then notes).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire:** QuickPick from `impactRows`; caller rows jump to the code line, IO rows open the existing IO links view (`iecode.ioLinks`) for the system project, task rows reveal the task program. Show `ImpactResult.notes` as the first row when non-empty.
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check: impact of a program variable that is linked to a terminal channel.
- [ ] **Step 5: Commit** `Add an impact view for objects and variables` (body: the gap named in the research: nobody shows which IO links and tasks a rename touches).

### Task 3: Mermaid export

**Files:** Create `extension/src/core/graphExport.ts`, `extension/src/commands/graphExport.ts`, `extension/test/graphExport.test.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `ObjectGraph`, `UnusedFinding[]` (Plan D, optional), `toMermaid` of `core/workspace.ts` for the project graph.
- Produces:
  ```ts
  export function mermaidId(name: string): string                       // injective: sanitised text plus a short hash of the original when sanitising changed it
  export function objectGraphMermaid(g: ObjectGraph, opts: { unused?: UnusedFinding[]; only?: NodeId[]; members?: boolean }): string
  ```
  Output `flowchart LR`; a node is `id["Label"]` (quotes in labels escaped as `#quot;`), edges `a --> b`; unused nodes get `classDef unused stroke-dasharray: 4 3` and `class id unused`; `only` restricts to those nodes plus their direct neighbours; `members: false` (default) folds member nodes into their object. Commands: `iecode.exportGraphMermaid` asks "Project graph" or "Object graph", for the object graph asks the scope (one task or whole project when at most 300 nodes) and then "Copy" or "Save as .mmd".

- [ ] **Step 1: Write the failing tests:** `mermaidId is injective for names that differ only in characters it replaces`; `labels with quotes, brackets and umlauts are escaped`; `unused nodes get the unused class`; `members are folded into their object by default`; `only restricts to the nodes and their neighbours`; `the project graph export is the existing toMermaid output unchanged` (call both).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the two functions and the command (copy and save as in `views/umlDiagram.ts`).
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual check: paste the output into a Mermaid renderer and confirm it draws.
- [ ] **Step 5: Commit** `Export the project and object graphs as Mermaid` (body: `toMermaid` for projects existed but no command used it; the object graph export marks unused objects for review in pull requests).
