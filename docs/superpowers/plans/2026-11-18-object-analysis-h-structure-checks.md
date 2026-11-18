# Plan H: XML Structure Checks and OOP Rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` files after edits by hand or by AI, and the IEC 61131-3 OOP rules between objects, and show the results in the Problems panel; offer a fix only where it is safe.

**Architecture:** `core/findings.ts` defines `Finding` and a small rule registry (rule id, default severity, settings override). `core/structureRules.ts` holds rules that read one XML file; `core/oopRules.ts` holds rules that read the `SymbolIndex` (some already exist as `missingMembers` in `lang/inheritance.ts`). `commands/check.ts` runs them on open and save and on demand and publishes diagnostics and quick fixes. Plans E and G register their rules here.

**Tech Stack:** TypeScript (`node --test`), `xml.ts` (`parseXml` with offsets), `lang/index.ts`, `lang/inheritance.ts`, VS Code `DiagnosticCollection` / `CodeActionProvider`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 1); TODO item "XML structure checks and OOP rules"; research [feature-ideas.md](../../research/feature-ideas.md) section G (prior art: a validator MCP with structure checks, 21 OOP checks and auto-fix).

## Global Constraints

- See the master plan. No CLI in this plan (decision 1); findings are plain data so a CLI can reuse them.
- This plan is not `iecode check` (that command runs XAE "Check all objects"); the user-facing name is **IECode: Check Objects**, source `IECode`, to avoid the clash.
- A rule never throws on odd input: a file that does not parse gives one finding `xml-parse` and no other finding for that file.
- An automatic fix exists only for a finding whose fix cannot change plant behaviour; every fix is a minimal text splice (`minimalEdit` pattern of `core/projectCheck.ts`) and goes through a VS Code workspace edit the user can undo.

## Review Focus

1. A valid file from the repository's own fixtures (every `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` under `extension/test/fixtures`) produces **no** finding at default severities.
2. Method name in the XML attribute and in the declaration text differ only by case: TwinCAT treats names case-insensitively, so no finding.
3. A function block that extends a base which is a library object without source: the OOP rules say "not checked" (info), never an error.
4. An interface method implemented with a different return type or a different `VAR_INPUT` order is an error naming both signatures.
5. A file with a git conflict marker in the XML: one finding `merge-conflict` (reuse `hasXmlConflict`), nothing else.
6. **Real-project baseline (2026-11-18):** a scan of 359 object files of a real project (55 POU, 299 DUT, 5 GVL; BOM and CRLF) for the rules `guid-format`, `guid-unique`, `name-mismatch`, `file-name-mismatch` and `lineids-orphan` found no violation; one file has no `TcPlcObject` root (a project information file) and must give no finding or at most one `xml-parse` info, not an error. Task 2 ends with a manual run on such a project: more than a handful of findings on a project that builds in XAE means a rule is wrong.

## File Structure

- Create `extension/src/core/findings.ts`, `extension/src/core/structureRules.ts`, `extension/src/core/oopRules.ts`, `extension/src/commands/check.ts`.
- Modify `extension/src/extension.ts`, `extension/package.json` (command `iecode.checkObjects`, settings `iecode.check.enabled` default `true`, `iecode.check.rules` object rule id to `"error" | "warning" | "info" | "hint" | "off"`, `iecode.check.namingPrefixes` object), `CHANGELOG.md`.
- Tests: `extension/test/findings.test.ts`, `extension/test/structureRules.test.ts`, `extension/test/oopRules.test.ts`.

### Task 1: Findings and registry

**Files:** Create `extension/src/core/findings.ts`, `extension/test/findings.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type Level = 'error' | 'warning' | 'info' | 'hint'
  export interface Finding { rule: string; level: Level; message: string; file: string; line: number; col: number; endLine: number; endCol: number; fix?: { title: string; edit: { start: number; end: number; text: string } } }   // 0-based positions; fix offsets are into the file text
  export interface RuleInfo { id: string; description: string; level: Level | 'off' }
  export function applyLevels(findings: Finding[], overrides: Record<string, Level | 'off'>, defaults: Record<string, Level | 'off'>): Finding[]   // drops 'off', rewrites level
  export function offsetToPosition(text: string, offset: number): { line: number; col: number }
  ```

- [ ] **Step 1: Write the failing tests:** `applyLevels rewrites the level and drops off rules`; `a rule missing from both maps keeps its own level`; `offsetToPosition handles CRLF and the last line`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add the finding type and level overrides for object checks` (body: structure, OOP, IO link and unused rules should share one result type and one settings switch).

### Task 2: Structure rules

**Files:** Create `extension/src/core/structureRules.ts`, `extension/test/structureRules.test.ts`.

**Interfaces:**
- Consumes: `parseXml`, `XNode` offsets (`xml.ts`), `hasXmlConflict` (`model.ts`), `Finding`, `offsetToPosition`.
- Produces: `export function checkStructure(xml: string, file: string, opts?: { namingPrefixes?: Record<string, string> }): Finding[]` and `export const STRUCTURE_RULES: RuleInfo[]`. Rules (id, default level):
  - `xml-parse` error, `merge-conflict` error (one finding, stops further checks).
  - `guid-format` error: `Id` attribute of the object and of every `Method` / `Property` / `Action` / `Transition` that is not `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}` (hex, case-insensitive).
  - `guid-unique` error: the same `Id` twice in one file; fix: replace the later duplicate by a new random GUID (title "Generate a new Id").
  - `name-mismatch` error: `Name` attribute of a member differs from the name in the first line of its declaration (`METHOD`/`PROPERTY`/`ACTION` keyword; case-insensitive compare).
  - `file-name-mismatch` warning: object `Name` differs from the file name without extension (case-insensitive).
  - `member-structure` error: a `Method` without `Declaration` or without `Implementation`; a `Property` that has neither `Get` nor `Set`.
  - `lineids-orphan` warning: `<LineIds Name="X">` with no object or member of that name; fix: remove the node (the safe fix; TwinCAT regenerates `LineIds`).
  - `naming-prefix` hint, off unless `namingPrefixes` is set: `{ FUNCTION_BLOCK: 'FB_', INTERFACE: 'I_', ... }` compares the object name with the prefix of its kind (kind from the first declaration keyword; `ENUM` / `STRUCT` from the DUT declaration).

- [ ] **Step 1: Write the failing tests**, one valid-file test per Review Focus 1 and 2 (load the fixtures from `extension/test/fixtures`; assert zero findings) and one failing fixture string per rule asserting rule id, level, and the line of the first character of the offending attribute or node; `merge-conflict` test asserts exactly one finding; `lineids-orphan` fix: applying `fix.edit` to the text gives XML that still parses and whose other bytes are identical (compare with the orphan node cut out).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the rules; positions from node offsets (`attrs` have no offsets in `XNode`; if `xml.ts` lacks attribute offsets, search the opening-tag text for `Id="` between `node.start` and `node.innerStart` and keep that helper local).
- [ ] **Step 4: Run tests,** then run `checkStructure` over every object file of a real project (script in the scratchpad, not committed; print counts per rule only). Expected: PASS and, per Review Focus 6, no more than a handful of findings.
- [ ] **Step 5: Commit** `Check the structure of PLC object files` (body: hand and AI edits can leave a file TwinCAT refuses to load; these are the failures seen as bad GUIDs, name drift and stale LineIds).

### Task 3: OOP rules

**Files:** Create `extension/src/core/oopRules.ts`, `extension/test/oopRules.test.ts`.

**Interfaces:**
- Consumes: `SymbolIndex`, `IndexedObject`, `classChain`, `missingMembers` (`lang/inheritance.ts`), `PlcSymbol` (`kind`, `modifiers`, `extends`, `implements`, `scope`, `type`, `children`).
- Produces: `export function checkOop(index: SymbolIndex, obj: IndexedObject): Finding[]` and `export const OOP_RULES: RuleInfo[]`. Rules:
  - `missing-implementation` error: from `missingMembers` (abstract members and interface members not implemented by a non-abstract function block).
  - `signature-mismatch` error: a method that overrides a base-class method or implements an interface method must have the same return type and the same `VAR_INPUT` / `VAR_OUTPUT` / `VAR_IN_OUT` list (names, types, order, case-insensitive); the message prints both signatures.
  - `final-violation` error: `EXTENDS` of a `FINAL` function block, or a method overriding a `FINAL` method.
  - `abstract-instantiation` error: a variable (not `POINTER TO` / `REFERENCE TO`) whose type is an `ABSTRACT` function block.
  - `fb-init-super` warning: a function block with `EXTENDS` that defines `FB_init` whose implementation text has no `SUPER^.FB_init`.
  - `unresolved-base` info: base or interface not in the index (the check is incomplete), once per object.

- [ ] **Step 1: Write the failing tests** (view-text fixtures through `SymbolIndex.update`, as `lang.test.ts`): per rule one positive and one negative; `signature-mismatch` covers the interface case of Review Focus 4 and a differing parameter name only by case (no finding); `unresolved-base` covers Review Focus 3.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Signature compare is one function `sameSignature(a: PlcSymbol, b: PlcSymbol): boolean` used by both overrides and interface members.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Check object-oriented rules between function blocks` (body: the compiler finds these only at build time; the index already knows the hierarchy, so the editor can report them on save).

### Task 4: Problems panel, quick fixes, command

**Files:** Create `extension/src/commands/check.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: Tasks 1 to 3; the workspace index and file watching as `commands/projectCheck.ts` does (it is the template: one `DiagnosticCollection`, open documents plus every PLC project of the workspace, `enabled()` setting).
- Produces: `registerCheck(ctx, state): void`; command `iecode.checkObjects` (palette; checks every object file of the workspace and shows a summary message with the counts per rule); a `CodeActionProvider` offering `Finding.fix` as a quick fix.

- [ ] **Step 1: Write the failing test** for `summaryText(findings: Finding[]): string` in `core/findings.ts` (`12 findings: 3 errors, 9 warnings; most frequent: name-mismatch (5)`; `No findings` for none).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire:** on open and save of object files run `checkStructure` for that file and `checkOop` for it and the objects that extend or implement it (use the index to find them); publish through `applyLevels` with `iecode.check.rules`; whole-workspace run for the command with a progress notification. Respect `iecode.check.enabled`.
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check: break a GUID, a method name and an interface signature in a copy of a project; each shows in the Problems panel with the right line; the orphan LineIds fix removes the node and the file still opens in the ST view.
- [ ] **Step 5: Commit** `Show object checks in the Problems panel` (body: results were only available as data; save-time diagnostics catch a bad AI edit before the PLC project is built).
