# Plan B: History of One Object, Rename Pairing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List the commits that changed one method, property, action or whole object, following renames and moves, and open the change of one commit as a diff. The same pairing logic also detects renamed items in the config diff.

**Architecture:** `core/renameMatch.ts` pairs removed and added items by text similarity (generic, pure). `core/objectHistory.ts` walks `git log --follow --name-only` of the file (the path of the file can differ per commit), reads all versions with **one** `git cat-file --batch` call, decodes each, compares the section text of the followed identity and follows a rename through `renameMatch`. `commands/objectHistory.ts` shows the result in a QuickPick and opens a diff of the two section texts through a small virtual document scheme.

**Tech Stack:** TypeScript (`node --test`), `core/git.ts` (`log`, `show`), VS Code QuickPick and `TextDocumentContentProvider`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 3); TODO items "Per-object history and staging" (history part) and the rename remark of the config diff item.

## Global Constraints

- See the master plan. History is read-only. The command works on the committed history; uncommitted edits appear as one top entry "Working copy" only when the section differs from HEAD.
- At most 200 commits per request (`git log -n200`), the list says when it is cut. The walk is cancellable (`withProgress` with a cancellation token) and reads all blobs with one git process, not one `git show` per commit (200 process starts on Windows take seconds).
- A property is one history target: `PROPERTY:X`, `GET:X` and `SET:X` count as one identity (the history of a property lists changes of any of the three).

## Review Focus

1. A method renamed in one commit and edited in the next: the history shows both commits under the new name, with the rename marked.
2. A method deleted and a different one added in the same commit with unrelated text: no rename is invented (similarity below 0.7, or two candidates with equal score, means no pairing). Two tiny methods (under 3 non-blank lines, e.g. `;` or one assignment) are never paired: identical one-liners are not evidence of a rename.
3. The file itself renamed (git detects it, `--follow`) and the object `Name` attribute changed in the same commit.
4. A commit where the file does not decode (conflict markers committed, or not valid XML): the entry is shown as "not readable" and the walk continues with the next commit.
5. A section that exists only in the working copy or only in old commits (deleted): history still lists the commits up to its deletion.

## File Structure

- Create `extension/src/core/renameMatch.ts`, `extension/src/core/objectHistory.ts`, `extension/src/commands/objectHistory.ts`.
- Modify `extension/src/core/git.ts` (`blobsAt`, `historyCommits`), `extension/src/core/configdiff.ts` and all three consumers of `ConfigChange` (`views/configDiffHtml.ts`, `views/configDiff.ts`, `changesToText` in `core/confighistory.ts`; found by grep, the first draft named only two), `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.
- Tests: `extension/test/renameMatch.test.ts`, `extension/test/objectHistory.test.ts`, additions to `extension/test/configdiff.test.ts`.

### Task 1: Rename pairing

**Files:** Create `extension/src/core/renameMatch.ts`, `extension/test/renameMatch.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export function similarity(a: string, b: string): number          // common non-blank trimmed lines (as multisets) / max(lines of a, lines of b); 0 when either side has no non-blank line
  export function pairRenames<T>(removed: T[], added: T[], text: (t: T) => string, opts?: { threshold?: number; minLines?: number }): { from: T; to: T; score: number }[]
  ```
  Defaults: threshold 0.7, `minLines` 3 (an item with fewer non-blank lines is never paired; the config diff passes 2). A pair needs a unique best partner on both sides; ties give no pair. Text is the whole section text (declaration and implementation) so a renamed method whose declaration line changes still matches on the body.

- [ ] **Step 1: Write the failing tests:** `similarity of equal texts is 1 and of disjoint texts 0`; `blank lines and indentation are ignored`; `repeated lines count as often as they occur` (multiset, so `a;a;a;` against `a;` is not 1); `pairRenames pairs a renamed item whose body changed by one line out of ten`; `pairRenames gives no pair when two added items fit equally well`; `pairRenames gives no pair below the threshold`; `pairRenames never uses an item twice`; `two one-line items with equal text are not paired` (`minLines`); `two removed and one added empty method give no pair`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** both functions; greedy by descending score after the uniqueness check.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add text-similarity pairing for renamed items` (body: history and the config diff both need to tell "renamed" from "deleted plus added").

### Task 2: Object history

**Files:** Create `extension/src/core/objectHistory.ts`, `extension/test/objectHistory.test.ts`.

**Interfaces:**
- Consumes: `decode`, `parseView` (view text split into sections, `model.ts`; it throws `ViewError` on a duplicate section, which counts as `unreadable`), `pairRenames` (Task 1). New in `core/git.ts`, both read-only:
  ```ts
  export function historyCommits(root: string, file: string, max: number): Promise<{ commit: Commit; path: string; parentPath?: string; parents: number }[]>   // git log --follow -z --name-status --format=<marker + fields + %P> -n<max> -- <file>; newest first; `path` is the file's path in that commit, `parentPath` its path in the first parent (differs only for an `R` entry); `-z` because paths with non-ASCII characters are quoted otherwise; a merge commit prints no name line: reuse the last known path
  export function blobsAt(root: string, items: { ref: string; file: string }[]): Promise<Map<string, string>>            // one `git cat-file --batch`; `file` is a **repo-relative** path used as given (no `rel()`); `ref` may be `<sha>^`; key `${ref}:${file}`; missing blobs left out
  ```
  `showMany(root, ref, files)` stays as a thin wrapper that applies `rel()` and calls `blobsAt` (existing tests keep passing); `log` keeps its signature. Bytes that are not valid UTF-8 are decoded lossily by the existing helpers; history is read-only, so that is acceptable here (Plan C refuses instead, because it writes).
- Produces:
  ```ts
  export interface HistoryEntry { commit: string; short: string; date: string; author: string; subject: string; key: string; change: 'added' | 'changed' | 'renamed' | 'removed' | 'unreadable'; renamedFrom?: string; before?: string; after?: string }
  export function sectionTextOf(xml: string, view: string, key: string): string | undefined    // key PROPERTY:X returns PROPERTY, GET and SET text of X joined, so a property is one identity; the raw XML of a non-ST body (`nonStBodies(xml)`) is appended, because the view shows only a marker line for CFC / FBD / SFC and a change there would be invisible
  export async function objectHistory(root: string, file: string, key: string | 'FILE', max?: number): Promise<{ entries: HistoryEntry[]; cut: boolean }>
  ```
  `key` is `kindName` as `model.ts` keys sections (`METHOD:Start`); `'FILE'` follows the whole object (all sections). Entries newest first; each carries the before / after section text so the diff needs no second git call.

- [ ] **Step 1: Write the failing tests** (`test/helpers/gitRepo.ts`, small `.TcPOU` writer helper in the test that takes method name and body and writes CRLF bytes through `write`):
  - `a changed method gets one entry per commit that changed its text`; commits that touch only other methods give none.
  - `a rename keeps the history`: commit 2 renames `Start` to `Begin` (body changed by one line); `objectHistory(…, 'METHOD:Begin')` lists commit 2 as `renamed` with `renamedFrom: 'METHOD:Start'` and commit 1 as `added` under the old name.
  - `an unrelated delete plus add is not a rename` (Review Focus 2).
  - `a renamed file is followed` (`git mv` plus `Name` attribute change in one commit).
  - `a commit with conflict markers in the XML is reported as unreadable and the walk goes on`.
  - `the list is cut at max and says so`.
  - `a merge does not create entries for the other branch`: two branches change different methods of the same file, then merge; each method's history lists only its own commit.
  - `the oldest commit of the window is not reported as added` when the method exists in its parent (`max` smaller than the history).
  - `a method deleted and re-created under an old name is a new identity` (different `Id`, no similarity).
  - `a changed non-ST (CFC) body is an entry`.
  - `a property is one identity`: a commit that changes only its `GET` body is listed for `PROPERTY:X`.
  - `blobsAt reads many commits of one file with one process` (assert result for three refs; `historyCommits` returns the renamed path for the commit before the rename).
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Walk **from the newest commit to the oldest**, starting with the selected `key`, and compare **each commit with its first parent**, not with the neighbour in the log (log order interleaves parallel branches, so neighbours are not parent and child, and merges would show phantom changes and reverts). Load both sides with one `blobsAt` call: `{ref: sha, file: path}` and `{ref: sha + '^', file: parentPath ?? path}`. This also removes the truncation problem: the oldest commit of the window has a real parent blob, so an existing method is not reported as added; a method is `added` only when its parent blob is missing or has no such section. Per pair: decode both, `sectionTextOf`, compare. Identity of the followed member: the `Id` attribute of its XML node is the primary evidence (same `Id` under another name is a rename); when the `Id` is not found in the parent (member deleted and re-created, or an old file), pair the sections removed in the parent and added in the child with `pairRenames` on their texts and, if paired, switch the followed key to the old name. Decode failure of either side gives one `unreadable` entry for that commit and the walk continues with the older commits (the changes of the gap are not assigned to any commit; the list says "history gap"). A merge commit (`parents > 1`) is compared with its first parent like any other and gets the note `merge`.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add per-object history that follows renames` (body: `git log -L` cannot see sections inside the XML, so the history compares section texts commit by commit).

### Task 3: History command and diff

**Files:** Create `extension/src/commands/objectHistory.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `objectHistory` (Task 2); `outline()` (`model.ts`, works on the document text, also for unsaved documents; B no longer depends on Plan A) to find the section at the cursor of an `iecode` document; the project tree `Node` for methods / properties / actions (`views/tree.ts`).
- Produces: command `iecode.objectHistory` (tree context menu on objects and members, editor context menu and command palette in the ST view); virtual scheme `iecode-section` (`query`: `commit`, `file`, `key`, `side`).

- [ ] **Step 1: Write the failing test** for the pure label: `historyItemLabel(e: HistoryEntry): { label: string; description: string }` in `core/objectHistory.ts` (`a1b2c3d  Fix cooling alarm`, description `Ada Lovelace, 2026-11-02`, `renamed from Start` suffix, `not readable` for `unreadable`).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire** the command: QuickPick of entries (placeholder names the object and, when cut, "showing the newest 200"), selecting an entry runs `vscode.diff` between the `before` and `after` side of `iecode-section` URIs (title `<key> @ <short>`). A top entry "Working copy" when the section differs from HEAD.
- [ ] **Step 4: Run** `npm test` and `npm run compile`; manual F5 check on a repository with a renamed method. **Measure** and write in the PR: wall time of the history of one object over 200 commits on a real repository (not yet measured; if it is above 5 s, lower the default of 200 and say so in the list header).
- [ ] **Step 5: Commit** `Show the history of one object and diff a commit` (body: previously only whole-file compare existed).

### Task 4: Renamed items in the config diff (own PR, independent of Tasks 1 to 3 except `renameMatch`)

**Files:** Modify `extension/src/core/configdiff.ts`, `extension/src/views/configDiffHtml.ts`, `extension/src/core/confighistory.ts` (`changesToText`), `extension/test/configdiff.test.ts`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `pairRenames` (Task 1); entry keys of `core/configmodel.ts` (`tasks/PlcTask/CycleTime`, `symbols/PlcTask Inputs/MAIN.bStart/BaseType`). The entity is **not** always the first two segments: for symbols it is the first three (`symbols/<area>/<symbol>`); grouping symbols by two segments would pair a whole data area. Step 1 reads `configmodel.ts` (`symbols()`, `fields()`, `item()`) and writes `entityOf(key): { entity: string; field: string } | undefined` per category (unknown category: no rename detection) before any test.
- Produces: `ConfigChange.kind` gains `'renamed'` with `from?: string` (the old entity prefix) and `key` the new one; `diffConfig` keeps its signature. The entries of a renamed item that are equal after the rename are not listed any more; the changed ones stay as `changed` under the new key.

- [ ] **Step 1: Write the failing tests:** `two symbols renamed in one data area give two renames, not one area-wide pairing`; `a candidate that matches only in hidden / noise fields (layout, GUIDs) is not a rename` (noise classification of each field is kept); `a renamed task is one renamed change and not N removed plus N added entries`; `a renamed task with a changed cycle time shows renamed plus one changed entry`; `two removed and two added tasks with different values give no rename`; `a rename inside a hidden category stays hidden` (filters still apply); `changesToText prints "renamed A -> B"`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** in `diffConfig`: after computing `removed` / `added`, group both by `entityOf(key).entity`, `pairRenames` (with `minLines: 2`) on the joined `field=value` lines of each entity, emit one `renamed` change per pair, then **re-diff the two paired entities field by field under the new key** (equal fields vanish, differing fields become `changed` entries under the new key; removing equal `field=value` pairs alone would leave differing fields as removed plus added under two different prefixes). Render in `configDiffHtml.ts`, `views/configDiff.ts` and `changesToText` (`renamed Old → New`). Read the three consumers' handling of `kind` first (`grep ConfigChange`); no consumer may see an unknown kind without a branch for it.
- [ ] **Step 4: Run** `npm test`. Expected: PASS (existing config diff tests unchanged).
- [ ] **Step 5: Commit** `Detect renamed items in the config diff` (body: a renamed task or symbol showed as a full delete plus add; closes the "rename detection" item left open in the config diff plan).
