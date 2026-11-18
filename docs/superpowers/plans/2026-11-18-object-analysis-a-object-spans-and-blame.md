# Plan A: Object Spans and Blame per Method

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show who last changed a method, property or action of a PLC object (and per line on hover), counted on the lines of the ST view, not on the XML.

**Architecture:** `core/objectSpans.ts` maps every line of `decode(xml)` to the XML line it comes from, per section. `core/blame.ts` turns `git blame --porcelain` of the raw XML into per-section results and repairs the two boundary lines of each section. `commands/blame.ts` wires a CodeLens per section header, a hover per line and a toggle command. Plans B and C reuse `objectSpans`.

**Tech Stack:** TypeScript (`node --test`), `git` through `core/git.ts`, VS Code `CodeLensProvider` / `HoverProvider`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 2) and the TODO item "git blame per method".

## Global Constraints

- See the master plan. Blame is read-only: nothing here writes a file or the index.
- A section's blame is "the newest commit that changed any of its view lines"; uncommitted lines show "Not committed yet".

## Review Focus

1. **Appended last line:** a commit that appends a line to a method body changes the XML line that held `]]></ST>` of the previous last line; that previous line must stay with its old commit. Same for a prepended first line (`<ST><![CDATA[`). This is the known failure of an existing extension.
2. A file that is untracked, in a merge conflict (`ConflictError` from `decode`) or longer than 20000 view lines: no lens, no error popup.
3. A section whose implementation is not ST (the view shows a read-only marker line): the lens still works for the declaration; marker lines have no line blame.
4. CRLF files: view lines are LF-normalised, XML line numbers must still match `git blame` output.
5. A file renamed in history: blame follows it (git does this by default); the lens text must not mention the old name.

## File Structure

- Create `extension/src/core/objectSpans.ts`: pure; XML text in, spans out.
- Create `extension/src/core/blame.ts`: pure parsing and section folding; git access injected.
- Modify `extension/src/core/git.ts`: add `blame` and `lineHistory`.
- Create `extension/src/commands/blame.ts`: CodeLens, hover, toggle.
- Modify `extension/src/extension.ts`, `extension/package.json` (command `iecode.toggleBlame`, setting `iecode.blame.enabled`, default `false`), `CHANGELOG.md`.
- Tests: `extension/test/objectSpans.test.ts`, `extension/test/blame.test.ts`.

### Task 1: Object spans

**Files:** Create `extension/src/core/objectSpans.ts`, `extension/test/objectSpans.test.ts`.

**Interfaces:**
- Consumes: `parseXml`, `XNode.innerStart/innerEnd`, `XNode.cdata` from `xml.ts`; `Kind`, the section order of `decode()` in `model.ts` (`collect()` is not exported; export it, or export a `sectionsOfXml(xml)` that wraps it, and keep `decode` unchanged).
- Produces:
  ```ts
  export interface ViewMap { viewFirst: number; viewLast: number; xmlFirst: number; boundaryFirst: boolean; boundaryLast: boolean }
  export interface SectionSpan { key: string; kind: Kind; name: string; viewFirst: number; viewLast: number; header?: number; decl?: ViewMap; impl?: ViewMap }
  export function spansOf(xml: string): SectionSpan[]
  export function xmlLineOfViewLine(spans: SectionSpan[], viewLine: number): { span: SectionSpan; xmlLine?: number; boundary: boolean } | undefined
  ```
  Lines: view lines 0-based, XML lines 1-based; `viewFirst/viewLast` inclusive; `boundaryFirst/Last` say the first / last body line shares its XML line with `<![CDATA[` / `]]>`.

- [ ] **Step 1: Write the failing tests** (`objectSpans.test.ts`, fixture: a `.TcPOU` string with a main declaration, one method with ST implementation, one property with GET, one action with a non-ST implementation; use CRLF in a second fixture):
  - `spans cover the whole view without gaps`: the union of `[viewFirst, viewLast]` over all spans equals `0 .. decode(xml).split('\n').length - 1`.
  - `every body line maps to the XML line that holds the same text`: for each mapped view line, `xml.split('\n')[xmlLine - 1]` contains the view line's text (trimmed of tag text).
  - `first and last body line are flagged as boundary`; interior lines are not.
  - `crlf input gives the same xml line numbers as lf input`.
  - `the read-only implementation marker has no xml line`: `xmlLineOfViewLine` returns `xmlLine: undefined`.
  - `a part with two CDATA segments maps the first one only and flags nothing else` (fixture with `]]]]><![CDATA[>` inside the code).
- [ ] **Step 2: Run** `npm test -- --test-name-pattern "spans|xml line"` (the project script runs all tests; filter with node's `--test-name-pattern` if needed). Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `spansOf` by walking the same sections in the same order as `decode()`, counting view lines exactly as `decode()` joins them (header line, declaration lines, `//---- IMPLEMENTATION ----`, implementation lines, one blank separator as `decode()` emits it; read `decode()` lines 142 to 175 before coding and mirror it). XML line of an offset = number of `\n` before it plus one.
- [ ] **Step 4: Run tests.** Expected: PASS, and the existing `model.test.ts` still passes.
- [ ] **Step 5: Commit** `Map ST view lines back to XML lines per section` (body: blame, history and staging all need to know which XML lines belong to one method).

### Task 2: Blame core and boundary repair

**Files:** Create `extension/src/core/blame.ts`, `extension/test/blame.test.ts`; modify `extension/src/core/git.ts`.

**Interfaces:**
- Consumes: `SectionSpan`, `xmlLineOfViewLine` (Task 1).
- Produces:
  ```ts
  export interface LineBlame { commit: string; author: string; time: number; summary: string; uncommitted: boolean }
  export function parseBlamePorcelain(out: string): LineBlame[]          // index = xml line - 1
  export type RefineLine = (xmlLine: number, current: LineBlame) => Promise<LineBlame>
  export interface SectionBlame { key: string; last: LineBlame; authors: string[]; lines: (LineBlame | undefined)[] }  // lines indexed by view line - span.viewFirst
  export function blameSections(spans: SectionSpan[], xml: LineBlame[], refine: RefineLine): Promise<SectionBlame[]>
  // git.ts
  export function blame(root: string, file: string): Promise<LineBlame[]>
  export function lineHistory(root: string, file: string, line: number): Promise<{ commit: string; removed?: string; added?: string }[]>   // git log -L line,line:file -p, newest first
  ```
  `blameSections` calls `refine` only for a boundary line whose commit is newer than every interior line of its section (so most files cause no extra git call).

- [ ] **Step 1: Write the failing tests.**
  - `parseBlamePorcelain reads author, time, summary and the not committed yet marker` (feed a captured porcelain sample, including a repeated commit whose header is abbreviated on later lines).
  - `blameSections takes the newest commit over the section lines` (pure, fake `LineBlame[]`, a `refine` that must not be called).
  - `a boundary line newer than the interior is refined` (fake `refine` returning the older commit; assert it was called once and its result is used).
  - Integration, throwaway repo (as `merge.test.ts`): commit 1 creates a `.TcPOU` with a method body `a;` / `b;`; commit 2 appends `c;` as new last line. Assert after `blameSections` with the real `refine` (below) that line `b;` is blamed on commit 1 and `c;` on commit 2. Same for a prepended first line.
  - `refine via lineHistory skips commits whose removed and added text differ only by tag text`: strip everything up to and including `<![CDATA[` and from `]]>` on both sides; equal means skip.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** the three functions and the real `refine` (`makeRefine(root, file)` in `blame.ts`, built on `lineHistory`; use the first history entry whose stripped texts differ; if none, keep the current commit). `blame` runs `git blame --porcelain -- <file>` through the existing `git()` helper of `git.ts`; cap output at the helper's limit and return `[]` for an untracked file (git exits non-zero).
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Blame per section with repaired boundary lines` (body: git blames the XML line that carries the CDATA tag, so an appended line steals the attribution of the old last line).

### Task 3: CodeLens, hover and toggle

**Files:** Create `extension/src/commands/blame.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `blameSections`, `makeRefine`, `blame` (Task 2); `spansOf` (Task 1); the `iecode` document scheme of the ST view (`extension/src/extension.ts`, `openView`).
- Produces: `registerBlame(ctx: vscode.ExtensionContext): void`; command `iecode.toggleBlame`; setting `iecode.blame.enabled`.

- [ ] **Step 1: Write the failing test** for the one pure piece: `lensText(b: SectionBlame, now: number): string` in `core/blame.ts`, e.g. `Ada Lovelace, 3 weeks ago: Fix cooling alarm (a1b2c3d)`; `Not committed yet` for uncommitted; relative time buckets (minutes, hours, days, weeks, months, years) with fixed `now` in the test.
- [ ] **Step 2: Run, expect FAIL; implement `lensText`; run, expect PASS.**
- [ ] **Step 3: Wire** `registerBlame`: a `CodeLensProvider` for scheme `iecode` returning one lens per non-MAIN section header line plus one at line 0 for MAIN; the lens command opens the commit diff of that section (Plan B's command if present, otherwise `git show` text in an untitled editor; keep it a no-op command with the hash as tooltip until Plan B lands); a `HoverProvider` for the same scheme showing author, date, subject and hash of the line (boundary lines refined). Cache results per file keyed by `git rev-parse HEAD` plus file mtime; drop the cache on `onDidChangeTextDocument` of the real file. Respect `iecode.blame.enabled`; `iecode.toggleBlame` flips the setting.
- [ ] **Step 4: Run** `npm test` (all pass) and `npm run compile`. Manual F5 check on a repository with TwinCAT objects: lens above a method, hover on its first and last line, toggle off removes lenses. Record the result in the PR.
- [ ] **Step 5: Commit** `Show blame per method in the ST view` (body: the XML line blame of git is useless for method-level questions; opt-in because every opened ST view costs a git call).
