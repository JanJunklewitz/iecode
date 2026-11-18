# Plan E: Mark Unused Objects

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which objects and members no PLC task can reach: a mark in the project tree, a faded hint in the ST view and a list command with the reason.

**Architecture:** A pure `core/unusedView.ts` turns `UnitAnalysis` (Plan D) into display data (decoration per tree node, hint ranges per file, list rows). `views/tree.ts` and the ST diagnostics provider only read it. Findings are hints, never errors, and carry their confidence.

**Tech Stack:** TypeScript (`node --test`), VS Code `TreeItem` description / icon, `DiagnosticTag.Unnecessary`, QuickPick.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decisions 5 and 6); TODO item "Mark unused objects". Needs Plan D complete.

## Global Constraints

- See the master plan. Hints use `DiagnosticSeverity.Hint` with the `Unnecessary` tag; they never appear in the Problems count of errors or warnings.
- The marks are on by default only when the analysis has roots; the setting `iecode.analysis.markUnused` (boolean, default `true`) switches them off.
- Plan H may later register the same finding as a rule; the data function here (`unusedHints`) is the single source for both.

## Review Focus

1. A project without task file shows no marks and says why in the list command (not "nothing is unused").
2. A library project and library objects are never marked.
3. A member of an unused object is marked as part of it (one mark on the object, members not marked separately); a used object with one unused method marks only the method.
4. The mark disappears after the referencing code is added and the file is saved (state change event), without reloading the window.
5. A name that exists twice (workspace object and library object of the same name): the workspace object is judged, the library one is not.

## File Structure

- Create `extension/src/core/unusedView.ts`, `extension/src/commands/unused.ts`.
- Modify `extension/src/views/tree.ts` (description / tooltip of `object` and `member` nodes), `extension/src/lang/providers.ts` (hint diagnostics), `extension/src/extension.ts`, `extension/package.json` (command `iecode.showUnused`, setting), `CHANGELOG.md`.
- Tests: `extension/test/unusedView.test.ts`.

### Task 1: Display data

**Files:** Create `extension/src/core/unusedView.ts`, `extension/test/unusedView.test.ts`.

**Interfaces:**
- Consumes: `UnitAnalysis`, `UnusedFinding`, `whyReachable`-free (only findings are needed), `GraphNode`.
- Produces:
  ```ts
  export interface UnusedMark { id: NodeId; name: string; file: string; line: number; confidence: 'unreferenced' | 'only-from-unused'; text: string }   // text e.g. "Not referenced by any task or object" / "Only used by unused objects"
  export function unusedMarks(a: UnitAnalysis): UnusedMark[]               // members of an unused object are folded into the object
  export function marksByFile(marks: UnusedMark[]): Map<string, UnusedMark[]>
  export function emptyReason(a: UnitAnalysis): string | undefined         // 'library project' | 'no tasks found' | undefined
  ```

- [ ] **Step 1: Write the failing tests:** `members of an unused object are folded into the object mark`; `a used object with an unused method marks the method only`; `confidence text differs for unreferenced and only-from-unused`; `emptyReason names a skipped library and a project without tasks`; `marksByFile groups by file`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Turn unused findings into display data` (body: tree, editor and list should show the same set, so the folding of members lives in one tested function).

### Task 2: Tree mark, editor hint, list command

**Files:** Create `extension/src/commands/unused.ts`; modify `extension/src/views/tree.ts`, `extension/src/lang/providers.ts`, `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `AnalysisState.analysisOf`, `AnalysisState.onDidChange` (Plan D Task 4); Task 1.
- Produces: `registerUnused(ctx, analysis: AnalysisState): void`; command `iecode.showUnused` (palette and the unit node context menu).

- [ ] **Step 1: Write the failing test** for the one pure addition the tree needs: `treeDescription(mark: UnusedMark | undefined, base: string): string` in `core/unusedView.ts` (`unused` appended to the existing description, unchanged when no mark); assert both.
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire:** in `tree.ts` use `treeDescription` and a tooltip with `UnusedMark.text` for `object` and `member` nodes, and fire the tree's change event on `AnalysisState.onDidChange`; in `lang/providers.ts` publish one `Hint` diagnostic with `DiagnosticTag.Unnecessary` on the name range for each mark of the open file (a separate `DiagnosticCollection` `iecode-unused`, so it can be cleared alone); `iecode.showUnused` opens a QuickPick (one row per mark, `description` = confidence text, selecting jumps to the declaration; when `emptyReason` is set it shows only that reason as a message).
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check on a project with an unused function block, an interface implementation used only through an interface variable (must not be marked) and a library project.
- [ ] **Step 5: Commit** `Mark objects that no task reaches` (body: unused code was invisible; hints and tree marks are non-blocking, and the confidence is shown so a doubtful finding is not read as certain).
