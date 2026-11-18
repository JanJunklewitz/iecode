# Plan C: Stage and Discard One Method

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage or discard the change of one method, property, action or the main declaration of a PLC object instead of the whole file.

**Architecture:** `core/objectStage.ts` finds the XML node ranges of a section (`sectionRanges`) and **splices** the text of one section from one XML into the other: working copy into index text to stage, index text into working copy to discard. Nothing is decoded and re-encoded, so every byte outside the section, and the `Id` of an added member, stay as they are. `core/git.ts` reads the index version and writes the result with `git hash-object -w --no-filters` and `git update-index --cacheinfo`. A CodeLens per changed section ("Stage", "Discard") in the ST view wires it.

**Tech Stack:** TypeScript (`node --test`), `xml.ts` offsets, `git` plumbing through `core/git.ts`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decisions 4 and 12); TODO item "Per-object history and staging" (staging part). Depends on Plan A Task 0 (test helper), Task 2 (`git()` gets `opts.input`) and Task 1 (`sectionsOfXml`, `spansOf` for the section at the cursor).

**Why not `encode()`:** the first draft built a "mixed view" and ran `encode(indexXml, mixedView)`. `encode()` writes every added member with `randomUUID()` (`model.ts`, `build()`), so a staged new method would get an `Id` different from the one in the working file, and `git diff` would show that difference for ever; it also deletes the `<LineIds>` entry of every changed method, which would put different line mappings into index and working copy. A splice has neither problem.

## Global Constraints

- See the master plan. The index and the working copy are the only things written; HEAD, other files and bytes of the XML outside the chosen section stay identical (tested).
- Discard is destructive: a modal confirmation that names the method, no undo promise; the working file is rewritten only if it is unchanged since the lens was computed (compare content hash) and the `iecode:` document is not dirty.
- Refuse, with a message and no write: the file has merge conflicts (index stages 1 to 3, or conflict markers), is untracked or intent-to-add (index blob empty; offer "Stage whole file"), does not decode, or its view document is dirty ("save first").
- Line endings: text spliced in is converted to the line ending of the file it goes into (index text and working copy can differ under `core.autocrlf`); a BOM of the target is kept. A target with **mixed** line endings (both `\r\n` and a bare `\n`, as after some merges) is refused with a message: `detectEol` is a whole-file guess and would normalise it.
- Encoding: `git()` decodes stdout as UTF-8. A blob or working file that is not valid UTF-8 (an old ANSI file with umlauts, no BOM) would be written back with U+FFFD. Both writes read the bytes, and refuse with a message when `Buffer.from(text, 'utf8')` does not equal the original bytes.
- Not atomic, by design: git has no compare-and-swap for one index entry. The index entry is compared (`indexEntry` sha) right before `update-index`, which narrows the window to milliseconds; it does not close it. On a difference abort with "index changed, try again"; on `index.lock` retry once after 200 ms **and repeat the comparison**, then show the git message. Say this limit in the CHANGELOG line.
- The working copy can change between the lens and the click (a save in XAE): stage and discard both re-read the file and compare its hash with the one the lens was computed from; a difference aborts with "file changed, try again".
- A raw XML editor (`file:` scheme) can hold unsaved edits too: the guard checks **both** representations of the file (canonical path), before and again after the discard confirmation. The discard write goes to a temporary file in the same folder and is renamed over the original, so a failure cannot leave a truncated file; remaining limit: an external writer between the hash check and the rename.

## Review Focus

1. **Bytes outside the section:** staged XML differs from the index version only inside the chosen section (its node range and its `<LineIds>` entry). Everything else, including GUIDs, is byte-identical.
2. **Added member keeps its `Id`:** a method that exists only in the working copy is staged with the `Id` it has in the working file; afterwards `git diff` (working copy against index) shows nothing for that method. One that exists only in the index (deleted in the working copy) is staged as a removal.
3. Staging the main declaration while a method is also changed: the method change stays unstaged.
4. Two staged sections in sequence: the second stage builds on the index result of the first, not on HEAD.
5. A file with CRLF line endings keeps CRLF in the index version; with `core.autocrlf=true` and an LF index, spliced text becomes LF.
6. A property: when the property is new (or removed), staging `PROPERTY X` takes the whole node including its `GET` and `SET`; when it exists on both sides, `PROPERTY X` means **only its `<Declaration>`** and `GET` / `SET` are separate units (changing the property type while GET is also edited stages the type only). A `GET` added to an existing property goes **inside the property node** (before its end tag, the place `encode()` uses, `model.ts` lines 303 to 306), not at object level.
7. Changes outside every section (attributes of the object element, folders, pragmas in the XML header) are not stageable here; they stay unstaged and the plain file stage handles them. A non-ST body (CFC, FBD, SFC) changing counts as a change of its section (its raw XML is compared).

## File Structure

- Create `extension/src/core/objectStage.ts`, `extension/src/commands/objectStage.ts`.
- Modify `extension/src/core/git.ts` (`readIndex`, `indexEntry`, `indexHasConflict`, `writeIndexBlob`), `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.
- Tests: `extension/test/objectStage.test.ts`.

### Task 1: Section ranges and splice

**Files:** Create `extension/src/core/objectStage.ts`, `extension/test/objectStage.test.ts`.

**Interfaces:**
- Consumes: `sectionsOfXml`, `parseXml`, `XNode` offsets, `cdataText`, `nonStBodies`, `decode`, `hasXmlConflict`, `ViewError` (`model.ts`, `xml.ts`).
- Produces:
  ```ts
  export interface SectionRanges { key: string; units: { start: number; end: number }[]; whole?: { start: number; end: number }; lineIds: { start: number; end: number }[]; text: { decl?: string; impl?: string; raw?: string } }
  export function sectionRanges(xml: string): Map<string, SectionRanges>
  // units = the edit units of the section: a method / action / transition: its element; MAIN: its `<Declaration>` and `<Implementation>` children (no element of its own); an existing PROPERTY: its `<Declaration>` only; GET / SET: the accessor element.
  // whole = the full element incl. nested accessors, used only when a property is added or removed.
  // lineIds = every `<LineIds>` entry that belongs to the section: `Name="<object>"` for MAIN, `<object>.<member>` for a member, `<object>.<property>.Get` and `.Set` for accessors; a removed property takes all of them.
  export function changedSections(baseXml: string, workXml: string): { key: string; state: 'added' | 'removed' | 'changed' }[]
  export function stageSection(baseXml: string, workXml: string, key: string): string          // new base xml: only `key` taken from work
  export function discardSection(baseXml: string, workXml: string, key: string): string        // new work xml: only `key` taken from base
  ```
  `text` holds the decoded declaration and ST text (LF) and, for a non-ST body, the raw XML of the implementation; `changedSections` compares `text` and ignores `<LineIds>` (TwinCAT regenerates them). For a property that exists on both sides `GET` / `SET` are listed as their own keys; when the property is new or removed only `PROPERTY:X` is listed (Review Focus 6). Both operations throw `ViewError` when either side does not parse or the key is in neither.
  Placement of an added member: after the element of the nearest preceding member that exists in the target (preceding in the source file's order), else before the first `<LineIds>` or at the end of the object element (the place `encode()` uses); an added accessor inside its property element. Its `<LineIds>` entries go after the entry of the preceding member, else after the last `<LineIds>` entry, else at the object element's end. A removed member is cut with its line and all its `<LineIds>` entries. A changed member replaces its units and its `<LineIds>` entries (taken from the source side; removed when the source has none). The edit units of one section never overlap those of another section (that is what makes the sections stageable independently).

- [ ] **Step 1: Write the failing tests** (fixture `.TcPOU` strings, base and work differing in the main declaration, method `Start` body, a new method `Stop`, a removed action, a new property with `GET` and `SET`, a changed non-ST action body):
  - `changedSections lists exactly the sections whose text differs, with their state`, and does not list a section that differs only in its `<LineIds>`.
  - `stageSection takes one changed method and leaves the others as in base`: the result parses, `decode` equals the base view with only that section replaced.
  - `bytes outside the section are identical`: remove the section's node range and its `<LineIds>` entry from result and base using `parseXml` offsets and compare the rest byte for byte, for an LF and a CRLF fixture and with a BOM.
  - `an added method keeps its Id`: after `stageSection`, the `Id` attribute of `Stop` in the result equals the one in work (Review Focus 2); the result contains `Stop` exactly once.
  - `stageSection removes a deleted member and its LineIds`.
  - `stageSection on the main declaration keeps the method change unstaged`.
  - `a new property is staged with its GET and SET; an existing property stages GET alone`; `changing the property type and the GET body: staging the property leaves GET unstaged, and the reverse`; `a GET added to an existing property lands inside the property element`; `a removed property takes the LineIds of both accessors`.
  - `MAIN carries its own LineIds entry: staging the main declaration after changing its implementation takes the entry along`.
  - `a target with mixed line endings is refused`.
  - `a changed non-ST body is a change of its section and is staged byte for byte`.
  - `discardSection restores one section in the work copy and keeps the other edits`.
  - `line endings follow the target`: work CRLF into an LF base gives LF in the result.
  - `a key in neither side throws`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `sectionRanges` on `sectionsOfXml` / `parseXml` offsets and the three functions as text splices applied back to front (as `encode()` applies its edits; do not call `encode()`).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Stage a section by splicing its XML range` (body: staging a method needs "index plus this method" with every other byte untouched; encode() would give an added method a new Id and drop its LineIds).

### Task 2: Index access

**Files:** Modify `extension/src/core/git.ts`, `extension/test/objectStage.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export function readIndex(root: string, file: string): Promise<string | undefined>                 // `git show :<file>`, undefined when not in the index
  export function indexEntry(root: string, file: string): Promise<{ mode: string; sha: string; stage: number } | undefined>   // `git ls-files -s -- <file>`; first line
  export function indexHasConflict(root: string, file: string): Promise<boolean>                     // `git ls-files -u -- <file>` non-empty
  export function writeIndexBlob(root: string, file: string, content: string, expectSha: string): Promise<void>   // refuses when the entry's sha is no longer `expectSha`; hash-object -w --no-filters --stdin, then update-index --cacheinfo <mode>,<sha>,<path> keeping the existing mode
  ```
  `content` goes in through the `input` option of `git()` (Plan A Task 2: written to the child's stdin; `execFile` itself ignores an `input` option) as UTF-8 text with BOM and line endings as given. `readIndex` reads bytes and returns `undefined` plus a reason (`'not-utf8'`) for a blob that does not survive the UTF-8 round trip (Global Constraints). `--no-filters` matters: the text already has the index's line endings; a clean filter (`core.autocrlf`) would convert it a second time.

- [ ] **Step 1: Write the failing tests** (`test/helpers/gitRepo.ts`): `readIndex returns the staged text and undefined for an untracked file`; `writeIndexBlob changes the index but not the working file or HEAD` (`git diff --cached` shows the change, `git diff` shows the rest); `a BOM and CRLF survive the round trip`; `with core.autocrlf=true an LF index stays LF` (repository configured with `core.autocrlf=true`, working file CRLF, no `-text` attribute); `writeIndexBlob refuses when the index entry changed in between`; `an intent-to-add file has an empty index blob` (`git add -N`; `readIndex` returns `''`); `indexHasConflict is true during a conflicted merge` (conflict built as `merge.test.ts` does); `a blob with a non-UTF-8 byte (0xE4 in a comment) is refused`; `git hash-object with input returns the expected sha` (covers the stdin path); `the sha check is repeated after an index.lock retry` (stub the retry).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** with the existing `git()` helper and its new `opts.input`; retry `update-index` once on an `index.lock` error.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Read and write one file of the git index` (body: plumbing for per-section staging; `git apply --cached` was rejected because XML line offsets make patches fragile, and without --no-filters autocrlf would convert twice).

### Task 3: Stage command

**Files:** Create `extension/src/commands/objectStage.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: Tasks 1 and 2; `outline()` (`model.ts`) for the header line of a section (no dependency on Plan A's spans); its own `CodeLensProvider` for scheme `iecode` (Plan A's blame provider is separate, the two lenses sit side by side).
- Produces: `registerObjectStage(ctx: vscode.ExtensionContext): void`; command `iecode.stageSection(uri, key)`; setting `iecode.stage.codeLens` (default `true`).

- [ ] **Step 1: Write the failing test** for `stageGuard(input: { tracked: boolean; intentToAdd: boolean; conflict: boolean; decodes: boolean; dirty: boolean; mixedEol: boolean; utf8: boolean }): { ok: true } | { ok: false; message: string }` in `core/objectStage.ts` (one message per refusal; untracked and intent-to-add offer "Stage whole file"; dirty says "save first"; `dirty` is true when either the `iecode:` or the `file:` document of the path is dirty).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire** the CodeLens provider (lens "Stage Method" above each section header whose `changedSections(indexXml, workXml)` entry exists; unresolved until visible, computed per document version and cached with the content hash it was computed from; none for a dirty document), the command (guard; re-read the working file and abort if its hash differs from the lens hash; `stageSection`; `writeIndexBlob` with the index sha read for the lens) and a refresh of the SCM view (`git.refresh` command if the built-in Git extension is present; otherwise nothing).
- [ ] **Step 4: Run** `npm test` and `npm run compile`; manual F5 check: edit two methods, stage one, `git diff --cached` shows only that method, `git status` still lists the file as partly staged; add a new method, stage it, `git diff` shows nothing for it.
- [ ] **Step 5: Commit** `Stage single methods from the ST view` (body: a changed `.TcPOU` could only be staged as a whole, which mixed unrelated method edits into one commit).

### Task 4: Discard command (after Task 3 is merged and used once)

Discard is destructive and is shipped separately so that Stage can be used and judged first.

**Files:** Modify `extension/src/commands/objectStage.ts`, `extension/package.json`, `CHANGELOG.md`; tests in `extension/test/objectStage.test.ts`.

**Interfaces:**
- Produces: command `iecode.discardSection(uri, key)`; lens "Discard Method" next to "Stage Method"; `writeFileSafe(path, content)` (temporary file in the same folder, then rename) in `core/objectStage.ts` or the nearest existing file-writing helper (grep `rename` in `src/core` first).

- [ ] **Step 1: Write the failing tests:** `writeFileSafe leaves the original untouched when the write fails` (target folder made read-only is platform dependent: inject the write function and make it throw); `discardGuard refuses when the file: or the iecode: document is dirty, also when it became dirty after the confirmation` (pure guard taking a fresh "dirty now" reading).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire:** modal `showWarningMessage` naming the method ("cannot be undone"), then guard again, re-read the file, abort if its hash changed since the lens, `discardSection` on that text, `writeFileSafe`.
- [ ] **Step 4: Run** `npm test` and `npm run compile`; manual F5 check: discard one of two edited methods, the other edit stays; edit the file in the raw XML editor without saving, discard refuses.
- [ ] **Step 5: Commit** `Discard single methods from the ST view` (body: restoring one method needed a hand edit or a whole-file checkout).
