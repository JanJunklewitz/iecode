# Plan C: Stage and Discard One Method

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage or discard the change of one method, property, action or the main declaration of a PLC object instead of the whole file.

**Architecture:** `core/objectStage.ts` builds a "mixed" ST view (index text with one section taken from the working copy, or the working copy with one section taken from the index) and turns it into XML with `encode()`. `core/git.ts` writes the staged result into the index with `git hash-object -w` and `git update-index --cacheinfo`. A CodeLens per changed section ("Stage", "Discard") in the ST view wires it.

**Tech Stack:** TypeScript (`node --test`), `git` plumbing through `core/git.ts`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 4); TODO item "Per-object history and staging" (staging part). Depends on Plan A Task 1 only for the section-at-cursor lookup in the wiring task; the core tasks do not.

## Global Constraints

- See the master plan. The index and the working copy are the only things written; HEAD, other files and bytes of the XML outside the chosen section stay identical (tested).
- Discard is destructive: a modal confirmation that names the method, no undo promise; the working file is rewritten only if it is unchanged since the lens was computed (compare content hash).
- Refuse, with a message and no write: the file has merge conflicts (index stages 1 to 3, or conflict markers), is untracked (offer "Stage whole file" instead), or does not decode.

## Review Focus

1. **Bytes outside the section:** staged XML differs from the index version only inside the chosen section (CDATA of that section and its `<LineIds>` entry as `encode()` writes them). Everything else, including GUIDs, is byte-identical.
2. A method that exists only in the working copy (new) is staged as an addition; one that exists only in the index (deleted in the working copy) is staged as a removal.
3. Staging the main declaration while a method is also changed: the method change stays unstaged.
4. Two staged sections in sequence: the second stage builds on the index result of the first, not on HEAD.
5. A file with CRLF line endings keeps CRLF in the index version.

## File Structure

- Create `extension/src/core/objectStage.ts`, `extension/src/commands/objectStage.ts`.
- Modify `extension/src/core/git.ts` (`writeIndexBlob`, `readIndex`), `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.
- Tests: `extension/test/objectStage.test.ts`.

### Task 1: Mixed view and staged XML

**Files:** Create `extension/src/core/objectStage.ts`, `extension/test/objectStage.test.ts`.

**Interfaces:**
- Consumes: `decode`, `encode`, `parseView` from `model.ts`; `sectionTextOf` (Plan B Task 2; if Plan B is not built yet, add the two-line helper to `model.ts` and let Plan B import it).
- Produces:
  ```ts
  export function changedSections(baseXml: string, workXml: string): { key: string; state: 'added' | 'removed' | 'changed' }[]
  export function stageSection(baseXml: string, workXml: string, key: string): string          // new base xml: only `key` taken from work
  export function discardSection(baseXml: string, workXml: string, key: string): string        // new work xml: only `key` taken from base
  ```
  `base` is the index text for staging and the index text again for discarding. Both throw `ViewError` when either side does not decode or the key is in neither.

- [ ] **Step 1: Write the failing tests** (fixture `.TcPOU` strings, base and work differing in the main declaration, method `Start` body, a new method `Stop`, a removed action):
  - `changedSections lists exactly the sections whose text differs, with their state`.
  - `stageSection takes one changed method and leaves the others as in base`: `decode(result)` equals the base view with only that section replaced.
  - `bytes outside the section are identical`: remove the section's CDATA ranges and its `<LineIds>` entry from both strings (use `parseXml` offsets) and compare the rest byte for byte, including CRLF fixture.
  - `stageSection adds a new method and removes a deleted one`.
  - `stageSection on the main declaration keeps the method change unstaged`.
  - `discardSection restores one section in the work copy and keeps the other edits`.
  - `a key in neither side throws`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** by building the mixed view text (split both views with `parseView`, swap the section, re-join in base order, new sections appended after the last base section or removed) and `encode(baseXml, mixedView)`. Check `encode()` with an added section keeps `<LineIds>` consistent with what the existing `merge`/`encode` tests expect; do not edit `encode()` in this plan.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Build index and working XML with one section swapped` (body: staging a method needs the XML of "index plus this method", which only encode() can produce without touching other bytes).

### Task 2: Index access

**Files:** Modify `extension/src/core/git.ts`, `extension/test/objectStage.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export function readIndex(root: string, file: string): Promise<string | undefined>                 // `git show :<file>`, undefined when not in the index
  export function indexHasConflict(root: string, file: string): Promise<boolean>                     // `git ls-files -u -- <file>` non-empty
  export function writeIndexBlob(root: string, file: string, content: string): Promise<void>         // hash-object -w --stdin, then update-index --cacheinfo <mode>,<sha>,<path> keeping the existing file mode
  ```
  `content` is written as UTF-8 bytes unchanged (BOM and line endings preserved: pass a `Buffer` through, not a re-encoded string; read the working file as bytes and decode with the same BOM handling `xml.ts` uses).

- [ ] **Step 1: Write the failing tests** (throwaway repo): `readIndex returns the staged text and undefined for an untracked file`; `writeIndexBlob changes the index but not the working file or HEAD` (`git diff --cached` shows the change, `git diff` shows the rest); `a BOM and CRLF survive the round trip`; `indexHasConflict is true during a conflicted merge` (create a conflict with two branches as `merge.test.ts` does).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** with the existing `git()` helper; `writeIndexBlob` needs stdin: extend the helper with an optional `input` parameter instead of adding a second spawn path.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Read and write one file of the git index` (body: plumbing for per-section staging; `git apply --cached` was rejected because XML line offsets make patches fragile).

### Task 3: Stage and discard commands

**Files:** Create `extension/src/commands/objectStage.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: Tasks 1 and 2; `spansOf` (Plan A Task 1); `registerBlame`'s CodeLens provider pattern (Plan A Task 3) is not required, this registers its own provider for scheme `iecode`.
- Produces: `registerObjectStage(ctx: vscode.ExtensionContext): void`; commands `iecode.stageSection(uri, key)` and `iecode.discardSection(uri, key)`; setting `iecode.stage.codeLens` (default `true`).

- [ ] **Step 1: Write the failing test** for `stageGuard(input: { tracked: boolean; conflict: boolean; decodes: boolean }): { ok: true } | { ok: false; message: string }` in `core/objectStage.ts` (one message per refusal; untracked offers "Stage whole file").
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire** the CodeLens provider (lenses "Stage Method" and "Discard Method" above each section header whose `changedSections(indexXml, workXml)` entry exists; computed lazily per document version), the two commands (guard, then `stageSection` and `writeIndexBlob`; for discard a modal `showWarningMessage` naming the method, then re-read the file, abort if its hash changed, write the new working XML) and a refresh of the SCM view (`git.refresh` command if the built-in Git extension is present; otherwise nothing).
- [ ] **Step 4: Run** `npm test` and `npm run compile`; manual F5 check: edit two methods, stage one, `git diff --cached` shows only that method, `git status` still lists the file as partly staged; discard the other.
- [ ] **Step 5: Commit** `Stage and discard single methods from the ST view` (body: a changed `.TcPOU` could only be staged as a whole, which mixed unrelated method edits into one commit).
