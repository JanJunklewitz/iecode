# Plan H: XML Structure Checks and OOP Rules

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Check `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` files after edits by hand or by AI, and the IEC 61131-3 OOP rules between objects, and show the results in the Problems panel; offer a fix only where it is safe.

**Architecture:** `core/findings.ts` defines `Finding` and a small rule registry (rule id, default severity, settings override). `core/structureRules.ts` holds rules that read one XML file; `core/oopRules.ts` holds rules that read the `SymbolIndex` (some already exist as `missingMembers` in `lang/inheritance.ts`). `commands/lint.ts` runs them on open and save and on demand and publishes diagnostics and quick fixes. Plans E and G register their rules here.

**Tech Stack:** TypeScript (`node --test`), `xml.ts` (`parseXml` with offsets), `lang/index.ts`, `lang/inheritance.ts`, VS Code `DiagnosticCollection` / `CodeActionProvider`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 1); TODO item "XML structure checks and OOP rules"; research [feature-ideas.md](../../research/feature-ideas.md) section G (prior art: a validator MCP with structure checks, 21 OOP checks and auto-fix).

## Global Constraints

- See the master plan. No CLI in this plan (decision 1); findings are plain data so a CLI can reuse them.
- The command `iecode.check` ("Check All Objects", runs XAE) already exists. To avoid two near-identical palette entries this plan says **Lint** everywhere: command `iecode.lintObjects` ("IECode: Lint Objects"), settings `iecode.lint.*`, diagnostic collection `iecode-lint`, source `IECode` (master decision 11).
- **Coordinates:** a `Finding` is bound to one representation: structure findings and their fixes address the **raw XML** (`file:` document), OOP findings address the decoded **ST view** (`iecode:` document); `Finding` gets `space: 'xml' | 'view'` and `version: string` (hash of the analysed text). A quick fix is **recomputed against the current document text** when the code-action request arrives (as `commands/projectCheck.ts` does) and refused if the hash differs; an XML fix is never offered on, or applied through, an `iecode:` document (it would go through `encode()` and corrupt ST).
- A rule never throws on odd input: a file that does not parse gives one finding `xml-parse` and no other finding for that file.
- An automatic fix exists only for a finding whose fix cannot change plant behaviour; every fix is a minimal text splice (`minimalEdit` pattern of `core/projectCheck.ts`) and goes through a VS Code workspace edit the user can undo.

## Review Focus

1. A valid file from the repository's own fixtures (every `.TcPOU` / `.TcDUT` / `.TcGVL` / `.TcIO` under `extension/test/fixtures`, today `ws/` and `plcproj-broken/`) produces **no** finding at default severities; a fixture that is broken on purpose goes on a named allowlist in the test with its reason. This includes the interface fixture `I_Motor.TcIO`: an `Itf` object has methods **without** `<Implementation>`, so `member-structure` must not require one there.
2. Method name in the XML attribute and in the declaration text differ only by case: TwinCAT treats names case-insensitively, so no finding.
3. A function block that extends a base which is a library object without source: the OOP rules say "not checked" (info), never an error.
4. An interface method implemented with a different return type or a different `VAR_INPUT` order is an error naming both signatures.
5. A file with a git conflict marker in the XML: one finding `merge-conflict` (reuse `hasXmlConflict`), nothing else.
6. **Real-project baseline (2026-11-18):** a scan of 359 object files of a real project (55 POU, 299 DUT, 5 GVL; BOM and CRLF) for the rules `guid-format`, `guid-unique`, `name-mismatch`, `file-name-mismatch` and `lineids-orphan` found no violation; one file has no `TcPlcObject` root (a project information file) and must give no finding or at most one `xml-parse` info, not an error. Task 2 ends with a manual run on such a project: more than a handful of findings on a project that builds in XAE means a rule is wrong.

## File Structure

- Create `extension/src/core/findings.ts`, `extension/src/core/structureRules.ts`, `extension/src/core/oopRules.ts`, `extension/src/commands/lint.ts`.
- Modify `extension/src/extension.ts`, `extension/package.json` (command `iecode.lintObjects`, settings `iecode.lint.enabled` default `true`, `iecode.lint.rules` object rule id to `"error" | "warning" | "info" | "hint" | "off"`, `iecode.lint.namingPrefixes` object), `CHANGELOG.md`.
- Tests: `extension/test/findings.test.ts`, `extension/test/structureRules.test.ts`, `extension/test/oopRules.test.ts`.

### Task 0: `parseXml` must terminate on malformed input

**Files:** Modify `extension/src/xml.ts`, `extension/test/core.test.ts` (or the test file that covers `parseXml`).

`xml.ts` lines 34 to 36: for `<?` and `<!` the scanner does `const close = src.indexOf('>', lt); i = close + 1;` without checking for `-1`. An unterminated `<?...` or `<!...` sets `i = 0` and loops for ever; every open or save of such a file would hang the extension host. Every lint run calls `parseXml` first.

- [ ] **Step 1: Write the failing tests:** `an unterminated processing instruction throws instead of looping`; `an unterminated declaration (<!DOCTYPE) throws`; both with a timeout guard (run `parseXml` in a worker or assert via a bounded loop counter injected for the test; a test that can hang is not acceptable).
- [ ] **Step 2: Run, expect FAIL (timeout); fix: throw `Unterminated ...` like the neighbouring cases; run, expect PASS.**
- [ ] **Step 3: Commit** `Stop parseXml from looping on an unterminated declaration` (body: i = indexOf + 1 reset the cursor to 0 when no `>` followed; a malformed file could hang the host).

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
  export function summaryText(findings: Finding[]): string      // `12 findings: 3 errors, 9 warnings; most frequent: name-mismatch (5)`; `No findings` for none (moved here from Task 4: Plan G needs it and must not wait for the UI task)
  ```
  `Finding.file` is an absolute path. Plan G anchors findings in `.tsproj` / `.xti`, Plan H in object files, so no rule may assume an object file.

- [ ] **Step 1: Write the failing tests:** `applyLevels rewrites the level and drops off rules`; `a rule missing from both maps keeps its own level`; `offsetToPosition handles CRLF and the last line`; `summaryText names counts per level and the most frequent rule, and says No findings for none`.
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
  - `guid-unique` error: the same `Id` twice in one file; fix (a quick fix the user picks, never automatic; the title says it changes the identity of that member: "Generate a new Id for the later duplicate"; it is not proven that nothing outside the node refers to that `Id`, so it carries no "safe" claim): replace the later duplicate by a new random GUID.
  - `name-mismatch` error: `Name` attribute of a member differs from the name after the first `METHOD` / `PROPERTY` keyword token of its declaration (case-insensitive compare; leading pragma and comment lines are skipped; members without a declaration (`Action`, `Transition`) and accessors `Get` / `Set` are skipped).
  - `file-name-mismatch` warning: object `Name` differs from the file name without extension (case-insensitive).
  - `member-structure` error: a `Method` without `Declaration`; a `Method` without `Implementation` unless its object element is `Itf` (interface methods have none); a `Property` that has neither `Get` nor `Set` unless under `Itf`. Check the exact shape of interface members against `I_Motor.TcIO` in Step 1 before fixing the rule text.
  - `lineids-orphan` warning: `<LineIds Name="X">` with no object, member or accessor of that name (the valid set is the `lineIdsName` of every section from `sectionsOfXml`, which includes `Obj.Prop.Get` / `.Set`); fix: remove the node (the safe fix; TwinCAT regenerates `LineIds`).
  - `naming-prefix` hint, off unless `namingPrefixes` is set: `{ FUNCTION_BLOCK: 'FB_', INTERFACE: 'I_', ... }` compares the object name with the prefix of its kind (kind from the first declaration keyword; `ENUM` / `STRUCT` from the DUT declaration).

- [ ] **Step 1: Write the failing tests**, one valid-file test per Review Focus 1 and 2 (load the fixtures from `extension/test/fixtures`; the repository has only six object fixtures, so add inline valid fixtures for the shapes it lacks: a struct and an enum DUT with members, an action, a transition, a CFC or SFC body, an interface with a property, a method whose declaration starts with a pragma or comment line; assert zero findings) and one failing fixture string per rule asserting rule id, level, and the line of the first character of the offending attribute or node; `merge-conflict` test asserts exactly one finding; `lineids-orphan` fix: applying `fix.edit` to the text gives XML that still parses and whose other bytes are identical (compare with the orphan node cut out).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the rules; positions from node offsets (`attrs` have no offsets in `XNode`; if `xml.ts` lacks attribute offsets, search the opening-tag text for `Id="` between `node.start` and `node.innerStart` and keep that helper local).
- [ ] **Step 4: Run tests,** then run `checkStructure` over every object file of a real project (script in the scratchpad, not committed; print counts per rule only). Expected: PASS and, per Review Focus 6, no more than a handful of findings.
- [ ] **Step 5: Commit** `Check the structure of PLC object files` (body: hand and AI edits can leave a file TwinCAT refuses to load; these are the failures seen as bad GUIDs, name drift and stale LineIds).

### Task 3: OOP rules

**Files:** Create `extension/src/core/oopRules.ts`, `extension/test/oopRules.test.ts`.

**Interfaces:**
- Consumes: a `SymbolIndex` **per PLC project** from `buildUnitIndex` (Plan D Task 0; the editor index of `lang/providers.ts` is workspace-wide and would resolve a base class into another application's object, and it holds unsaved text; this task waits for D Task 0), `IndexedObject`, `classChain` (`lang/inheritance.ts`), `PlcSymbol` (`kind`, `modifiers`, `extends`, `implements`, `scope`, `type`, `children`).
- Produces: `export function checkOop(index: SymbolIndex, obj: IndexedObject): Finding[]` and `export const OOP_RULES: RuleInfo[]`. Rules:
  - ~~`missing-implementation`~~ is **not** added here: `lang/providers.ts` lines 105 to 113 already publishes it as an error with a quick fix; a second rule would show two errors per function block.
  - `signature-mismatch` error: a method that overrides a base-class method or implements an interface method must have the same return type and the same `VAR_INPUT` / `VAR_OUTPUT` / `VAR_IN_OUT` list (names, types, order, case-insensitive); the message prints both signatures.
  - `final-violation` error: `EXTENDS` of a `FINAL` function block, or a method overriding a `FINAL` method.
  - `abstract-instantiation` error: a variable (not `POINTER TO` / `REFERENCE TO`, and not in a `VAR_IN_OUT` block, which is passed by reference and allowed) whose type is an `ABSTRACT` function block.
  - `fb-init-super` **hint**, off by default until verified: a function block with `EXTENDS` that defines `FB_init` whose implementation (comments and strings removed) has no `SUPER^.FB_init`. It is **unverified** whether TwinCAT runs the base `FB_init` implicitly (then an explicit call would run it twice) or requires the explicit call; the two reviewers of this plan disagreed. Step 1 of Task 3 checks the Beckhoff documentation for the supported XAE versions and either drops the rule or enables it with that wording.
  - `unresolved-base` info: base or interface not in the index (the check is incomplete), once per object.

- [ ] **Step 1: Write the failing tests** (view-text fixtures through `SymbolIndex.update`, as `lang.test.ts`): per rule one positive and one negative; `signature-mismatch` covers the interface case of Review Focus 4 and a differing parameter name only by case (no finding); `unresolved-base` covers Review Focus 3.
  Also: `VAR_IN_OUT x : FB_Abstract gives no abstract-instantiation`; `two units with the same base-class name resolve into their own objects`; `an inherited signature change is reported on the derived block`; `an object that instantiates an abstract type is reported although it neither extends nor implements the changed object`; first read the Beckhoff documentation for `FB_init` and `SUPER^` for the supported XAE versions and settle `fb-init-super` (drop it, or enable it with the documented wording).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Signature compare is one function `sameSignature(a: PlcSymbol, b: PlcSymbol): boolean` used by both overrides and interface members.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Check object-oriented rules between function blocks` (body: the compiler finds these only at build time; the index already knows the hierarchy, so the editor can report them on save).

### Task 4: Problems panel, quick fixes, command

**Files:** Create `extension/src/commands/lint.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: Tasks 1 to 3; the workspace index and file watching as `commands/projectCheck.ts` does (it is the template: one `DiagnosticCollection`, open documents plus every PLC project of the workspace, `enabled()` setting).
- Produces: `registerLint(ctx, state): void`; command `iecode.lintObjects` (palette; checks every object file of the workspace and shows a summary message with the counts per rule); a `CodeActionProvider` offering `Finding.fix` as a quick fix.

- [ ] **Step 1: No new test here:** `summaryText` and its test moved to Task 1; this task wires and is covered by the manual check below.
- [ ] **Step 2: Run** `npm test`; expected PASS (nothing new to implement before Step 3).
- [ ] **Step 3: Wire:** on open and save of object files run `checkStructure` for that file and `checkOop` for it and the objects that extend or implement it (use the index to find them); publish through `applyLevels` with `iecode.lint.rules` (structure findings on the `file:` XML document, OOP findings on the `iecode:` view document, see Global Constraints); the OOP rules run for the **whole unit** (debounced after a save, one `buildUnitIndex` per unit; with a few hundred objects that is cheap, and it catches objects that instantiate or depend on the changed one without extending it), not only for the saved object and its subclasses; the quick-fix provider recomputes the finding against the current text first; whole-workspace run for the command with a progress notification. Respect `iecode.lint.enabled`.
- [ ] **Step 4: Run** `npm test`, `npm run compile`. Manual F5 check: break a GUID, a method name and an interface signature in a copy of a project; each shows in the Problems panel with the right line; the orphan LineIds fix removes the node and the file still opens in the ST view.
- [ ] **Step 5: Commit** `Show object lint findings in the Problems panel` (body: results were only available as data; save-time diagnostics catch a bad AI edit before the PLC project is built).
