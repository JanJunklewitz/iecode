# Plan A: Object Spans and Blame per Method

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show who last changed a method, property or action of a PLC object (and per line on hover), counted on the lines of the ST view, not on the XML.

**Architecture:** `core/objectSpans.ts` maps every line of `decode(xml)` to the XML line it comes from, per section. `core/blame.ts` turns `git blame --porcelain` of the raw XML into per-section results and repairs the two boundary lines of each section. `commands/blame.ts` wires a CodeLens per section header (resolved lazily, only for visible lenses), a hover per line and a toggle command. Plans B and C reuse `objectSpans` for the section-at-cursor lookup. Task 0 extracts the shared git test helper that A, B and C tests use.

**Tech Stack:** TypeScript (`node --test`), `git` through `core/git.ts`, VS Code `CodeLensProvider` / `HoverProvider`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 2) and the TODO item "git blame per method".

## Global Constraints

- See the master plan. Blame is read-only: nothing here writes a file or the index.
- A section's blame is "the newest commit that changed any of its view lines"; uncommitted lines show "Not committed yet".
- Spans and blame are computed from the file **on disk**. A dirty `iecode:` document (unsaved edits) has different line numbers: no lens, no hover until it is saved (master decision 12).
- `git blame` runs with `-w` (whitespace and line-ending-only changes do not steal a line) and a 15 s timeout; a timeout gives no lens and one status-bar note, never an error popup.

## Review Focus

1. **Appended last line:** a commit that appends a line to a method body changes the XML line that held `]]></ST>` of the previous last line; that previous line must stay with its old commit. Same for a prepended first line (`<ST><![CDATA[`). This is the known failure of an existing extension.
2. A file that is untracked, in a merge conflict (`ConflictError` from `decode`) or longer than 20000 view lines: no lens, no error popup.
3. A section whose implementation is not ST (the view shows a read-only marker line): the lens still works for the declaration; marker lines have no line blame.
4. CRLF files: view lines are LF-normalised, XML line numbers must still match `git blame` output.
5. A file renamed in history: blame follows it (git does this by default); the lens text must not mention the old name.
6. **Unsaved view:** a dirty `iecode:` document shows no lens and no hover; after save they come back (the line numbers match the disk again).
7. A body with `]]>` inside the code is stored as several CDATA segments (`toCdata` writes `]]]]><![CDATA[>`) and `cdataText` joins them: view lines after the split map to the XML line of their own segment, not to the first segment's.
8. An empty declaration or implementation (`<![CDATA[]]>`, or no CDATA at all) is one empty view line in `decode()`; spans must count it.

## File Structure

- Create `extension/test/helpers/gitRepo.ts` (Task 0), `extension/src/core/objectSpans.ts`: pure; XML text in, spans out.
- Create `extension/src/core/blame.ts`: pure parsing and section folding; git access injected.
- Modify `extension/src/core/git.ts`: add `blame` and `lineHistory`; extend the private `git()` helper with `opts?: { input?: string | Buffer; timeout?: number }` (Plan C reuses `input`); modify `extension/src/model.ts`: export a `sectionsOfXml(xml)` wrapper around `collect()`.
- Create `extension/src/commands/blame.ts`: CodeLens, hover, toggle.
- Modify `extension/test/merge.test.ts` (use the helper), `extension/src/extension.ts`, `extension/package.json` (command `iecode.toggleBlame`, setting `iecode.blame.enabled`, default `false`), `CHANGELOG.md`.
- Tests: `extension/test/objectSpans.test.ts`, `extension/test/blame.test.ts`.

### Task 0: Shared git test helper and `sectionsOfXml`

**Files:** Create `extension/test/helpers/gitRepo.ts`; modify `extension/test/merge.test.ts`, `extension/src/model.ts`.

Two separate commits: the helper (below) and the export `sectionsOfXml(xml)` plus the `XmlSection` interface in `model.ts` (a wrapper around `parseOrConflict` + `findMain` + `collect`, `decode` unchanged; test: `sectionsOfXml` lists the same keys `decode` writes headers for). Plans C and H use the export, so it must not wait for Task 1.

**Interfaces:**
- Produces: `export function tempRepo(): { dir; file; git(...a): string; tryGit(...a): void; commit(content, msg): void; write(relPath, content: string | Buffer): void; commitAll(msg): void; cleanup(): void }` : the `tempRepo()` of `merge.test.ts` (no signing, fixed identity) plus `write` / `commitAll` for tests with several files and byte-exact (CRLF, BOM) content. `tsc -p .` compiles `test/helpers/*.ts`; the test glob `out/test/*.test.js` does not pick the helper up as a test.

- [ ] **Step 1:** Move `tempRepo` out of `merge.test.ts`, add `write` and `commitAll`, import it in `merge.test.ts`. One change: `merge.test.ts` passes `-c core.autocrlf=false` on **every** git call, which would override a repository config set by a test (Plan C needs a repository with `core.autocrlf=true`). The helper instead runs `git config core.autocrlf false` once after `init` (local config), so a test can change it with `git('config', 'core.autocrlf', 'true')`; the merge tests behave the same. No new test: the existing merge tests are the proof.
- [ ] **Step 2: Run** `npm test`. Expected: PASS, the same number of tests as before.
- [ ] **Step 3: Commit** `Share the throwaway git repository helper between tests` (body: blame, history and staging tests all need real repositories with byte-exact content; three more copies of the helper would drift).

### Task 1: Object spans

**Files:** Create `extension/src/core/objectSpans.ts`, `extension/test/objectSpans.test.ts`; modify `extension/src/model.ts`.

**Interfaces:**
- Consumes: `parseXml`, `XNode.innerStart/innerEnd`, `XNode.cdata` from `xml.ts`; `Kind`, `findMain` / `collect` of `model.ts` (not exported: add `export function sectionsOfXml(xml: string): XmlSection[]` that runs `parseOrConflict` + `findMain` + `collect`, export the `XmlSection` interface, keep `decode` unchanged).
- Produces:
  ```ts
  export interface ViewMap { viewFirst: number; viewLast: number; xmlLines: number[]; boundaryFirst: boolean; boundaryLast: boolean }   // xmlLines[i] = XML line (1-based) of view line viewFirst + i
  export interface SectionSpan { key: string; kind: Kind; name: string; viewFirst: number; viewLast: number; header?: number; decl?: ViewMap; impl?: ViewMap }
  export function spansOf(xml: string): SectionSpan[]
  export function xmlLineOfViewLine(spans: SectionSpan[], viewLine: number): { span: SectionSpan; xmlLine?: number; boundary: boolean } | undefined
  ```
  Lines: view lines 0-based, XML lines 1-based; `viewFirst/viewLast` inclusive; `boundaryFirst/Last` say the first / last body line shares its XML line with `<![CDATA[` of the first segment / `]]>` of the last segment (a body in several CDATA segments has interior lines that share an XML line with a segment boundary; they are not flagged because the text on both sides of the split is the same code).
  The view of `decode()` has **no blank separator between sections**: sections are joined with `\n` and the whole text ends with one `\n`, so `decode(xml).split('\n')` has one more (empty) element than there are view lines. Mirror `decode()` lines 142 to 159 exactly (header line `//==== KIND Name ====` for non-MAIN, declaration text, then `//---- IMPLEMENTATION ----` plus the ST text or the read-only marker).

- [ ] **Step 1: Write the failing tests** (`objectSpans.test.ts`, fixture: a `.TcPOU` string with a main declaration, one method with ST implementation, one property with GET, one action with a non-ST implementation; CRLF in a second fixture):
  - `spans cover the whole view without gaps`: the union of `[viewFirst, viewLast]` over all spans equals `0 .. N - 1` where `N = decode(xml).split('\n').length - 1` (the last element is the empty string after the final newline).
  - `every body line maps to the XML line that holds the same text`: for each mapped view line, `xml.split('\n')[xmlLine - 1]` (BOM removed, as `readFile` of the view does) contains the view line's text; for a line that contains `]]>` compare against the XML line with `]]]]><![CDATA[>` collapsed back to `]]>`.
  - `first and last body line are flagged as boundary`; interior lines are not.
  - `crlf input gives the same xml line numbers as lf input`.
  - `the read-only implementation marker has no xml line`: `xmlLineOfViewLine` returns `xmlLine: undefined`.
  - `a body with two CDATA segments maps each line to its own segment` (fixture with `]]]]><![CDATA[>` inside the code; Review Focus 7).
  - `an empty declaration and an empty implementation are one view line each` (Review Focus 8).
- [ ] **Step 2: Run** `npm test -- --test-name-pattern "spans|xml line"` (the script is `tsc -p . && node --test out/test/*.test.js`; extra arguments reach `node --test`). Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `spansOf` by walking `sectionsOfXml(xml)` in order and counting view lines as above; map each line through the CDATA segments of the node (`XNode.cdata` has `start`, `end`, `text`; a view line's XML line is the number of `\n` before the segment text offset plus one, with offsets counted segment by segment).
- [ ] **Step 4: Run tests.** Expected: PASS, and the existing `model.test.ts` still passes.
- [ ] **Step 5: Commit** `Map ST view lines back to XML lines per section` (body: blame and the section lookup of history and staging need to know which XML lines belong to one method).

### Task 2: Blame core and boundary repair

**Files:** Create `extension/src/core/blame.ts`, `extension/test/blame.test.ts`; modify `extension/src/core/git.ts`.

**Interfaces:**
- Consumes: `SectionSpan`, `xmlLineOfViewLine` (Task 1).
- Produces:
  ```ts
  export interface LineBlame { commit: string; author: string; time: number; summary: string; uncommitted: boolean; origLine: number; origPath: string }   // origLine / origPath: the line number and path in `commit` itself (porcelain header and `filename` line), not in the working file
  export function parseBlamePorcelain(out: string): LineBlame[]          // index = xml line - 1
  export type RefineLine = (current: LineBlame) => Promise<LineBlame>
  export interface SectionBlame { key: string; last: LineBlame; authors: string[]; lines: (LineBlame | undefined)[] }  // lines indexed by view line - span.viewFirst
  export function blameSections(spans: SectionSpan[], xml: LineBlame[], refine: RefineLine): Promise<SectionBlame[]>
  // git.ts
  export function blame(root: string, file: string): Promise<LineBlame[]>                 // git blame --porcelain -w, 15 s timeout
  export function lineHistory(root: string, commit: string, origPath: string, origLine: number): Promise<{ commit: string; removed?: string; added?: string }[]>   // git log -L o,o:<origPath> <commit> -w -p -n 3, newest first (the `-w` combination was probed with git 2.49: accepted). Uses the commit and line numbers of the blame porcelain, so uncommitted lines above, or a renamed file, cannot shift the line; `-n 3` bounds the run time on long histories
  ```
  **Which lines are refined.** git blames the XML line that carries a CDATA tag. After an append, the old last line `b;]]></ST>` became `b;` and is blamed on the appending commit even though its code did not change, and it is then an *interior* line, not a boundary line (same at the head for a prepend). So the candidates are not "the current boundary lines": for each section, take the maximal **tail run** of lines blamed on the same commit as the last body line, and the maximal **head run** for the first body line; the first line of the tail run and the last line of the head run are the candidates (the old last / first line), plus the boundary lines themselves. At most four lines per section, usually none (a candidate whose commit is older than the rest needs no check). `refine` runs `lineHistory` for the candidate and walks back past commits whose removed and added text differ only by tag text. The caller invokes `blameSections` **per section on demand** (Task 3, lazy lens), not for the whole file at once.

- [ ] **Step 1: Write the failing tests.**
  - `parseBlamePorcelain reads author, time, summary and the not committed yet marker` (feed a captured porcelain sample, including a repeated commit whose header is abbreviated on later lines).
  - `blameSections takes the newest commit over the section lines` (pure, fake `LineBlame[]`, a `refine` that must not be called).
  - `a boundary line newer than the interior is refined` (fake `refine` returning the older commit; assert it was called once and its result is used).
  - Integration, throwaway repo (`test/helpers/gitRepo.ts`; these tests are **mandatory acceptance criteria**, the first draft's algorithm would have failed the first one): commit 1 creates a `.TcPOU` with a method body `a;` / `b;`; commit 2 appends `c;` as new last line; commit 3 appends `d;` and `e;`. Assert after `blameSections` with the real `refine` (below) that `a;` and `b;` are blamed on commit 1, `c;` on commit 2, `d;` and `e;` on commit 3 (the stolen `b;` is an interior line). Same for a prepended first line. Same with an unrelated uncommitted line inserted above the section in the working file (the refine must use the commit's own line numbers).
  - `refine via lineHistory skips commits whose removed and added text differ only by tag text`: strip text up to and including `<![CDATA[` and the closing pattern `]]></ST>` / `]]></Declaration>` plus what follows on both sides; equal means skip. Do not strip a `]]>` that is code (it is stored split as `]]]]><![CDATA[>`).
  - `a commit that only changes line endings or indentation does not take over the lines` (commit 2 rewrites the file with CRLF instead of LF; blame still names commit 1; proves `-w`).
  - `blame of an untracked file and of a file outside a repository gives an empty list, not an exception`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the three functions and the real `refine` (`makeRefine(root)` in `blame.ts`, built on `lineHistory`; use the first history entry whose stripped texts differ; if none, keep the current commit). `blame` runs `git blame --porcelain -w -- <file>` through the existing `git()` helper of `git.ts`, which gets the optional `opts` parameter in this task: `timeout`, and `input`. **`execFile` ignores an `input` option** (it exists only for `spawnSync`); implement it by writing to the child's stdin like `showMany` does (`p.stdin.end(input)`), with a test (`git hash-object --stdin` with `input` returns the expected sha). Return `[]` for an untracked file (git exits non-zero).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Blame per section with repaired boundary lines` (body: git blames the XML line that carries the CDATA tag, so an appended line steals the attribution of the old last line).

### Task 3: CodeLens, hover and toggle

**Files:** Create `extension/src/commands/blame.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `blameSections`, `makeRefine`, `blame` (Task 2); `spansOf` (Task 1); the `iecode` document scheme of the ST view (`extension/src/extension.ts`, `openView`).
- Produces: `registerBlame(ctx: vscode.ExtensionContext): void`; command `iecode.toggleBlame`; setting `iecode.blame.enabled`.

- [ ] **Step 1: Write the failing test** for the one pure piece: `lensText(b: SectionBlame, now: number): string` in `core/blame.ts`, e.g. `Ada Lovelace, 3 weeks ago: Fix cooling alarm (a1b2c3d)`; `Not committed yet` for uncommitted; relative time buckets (minutes, hours, days, weeks, months, years) with fixed `now` in the test.
- [ ] **Step 2: Run, expect FAIL; implement `lensText`; run, expect PASS.**
- [ ] **Step 3: Wire** `registerBlame`: a `CodeLensProvider` for scheme `iecode`. `provideCodeLenses` returns one unresolved lens per section header line (line 0 for MAIN) and nothing for a dirty document; `resolveCodeLens` (VS Code calls it only for visible lenses) runs `blameSections` for that one section and sets the title from `lensText`. The lens command opens the commit diff of that section (Plan B's command if present; until then a no-op command with the hash as tooltip). A `HoverProvider` for the same scheme shows author, date, subject and hash of the line (boundary lines refined), also nothing for a dirty document. Cache the raw `blame()` result and the spans per file keyed by `git rev-parse HEAD` plus file mtime; drop the cache on a file-watcher change of the real file. Respect `iecode.blame.enabled`; `iecode.toggleBlame` flips the setting. Use `vscode.EventEmitter` `onDidChangeCodeLenses` after a cache drop or a save of the document.
- [ ] **Step 4: Run** `npm test` (all pass) and `npm run compile`. Manual F5 check on a repository with TwinCAT objects: lens above a method, hover on its first and last line, toggle off removes lenses, an unsaved edit hides the lens until saved. **Measure** and write in the PR: wall time of `blame()` for the largest object file of a real repository (the real project has 1057 commits; this is the number the plan could not check) and of one `lineHistory` call. If one blame takes more than 2 s, the default stays `false` and the setting description says so.
- [ ] **Step 5: Commit** `Show blame per method in the ST view` (body: the XML line blame of git is useless for method-level questions; opt-in because every opened ST view costs a git call).
