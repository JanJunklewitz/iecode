# Plan B: History of One Object, Rename Pairing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List the commits that changed one method, property, action or whole object, following renames and moves, and open the change of one commit as a diff. The same pairing logic also detects renamed items in the config diff.

**Architecture:** `core/renameMatch.ts` pairs removed and added items by text similarity (generic, pure). `core/objectHistory.ts` walks `git log --follow` of the file, decodes the file at each commit, compares the section text of the followed identity and follows a rename through `renameMatch`. `commands/objectHistory.ts` shows the result in a QuickPick and opens a diff of the two section texts through a small virtual document scheme.

**Tech Stack:** TypeScript (`node --test`), `core/git.ts` (`log`, `show`), VS Code QuickPick and `TextDocumentContentProvider`.

**Spec:** [master plan](2026-11-18-object-analysis-master-plan.md) (decision 3); TODO items "Per-object history and staging" (history part) and the rename remark of the config diff item.

## Global Constraints

- See the master plan. History is read-only. The command works on the committed history; uncommitted edits appear as one top entry "Working copy" only when the section differs from HEAD.
- At most 200 commits per request (`git log -n200`), the list says when it is cut.

## Review Focus

1. A method renamed in one commit and edited in the next: the history shows both commits under the new name, with the rename marked.
2. A method deleted and a different one added in the same commit with unrelated text: no rename is invented (similarity below 0.7, or two candidates with equal score, means no pairing).
3. The file itself renamed (git detects it, `--follow`) and the object `Name` attribute changed in the same commit.
4. A commit where the file does not decode (conflict markers committed, or not valid XML): the entry is shown as "not readable" and the walk continues with the next commit.
5. A section that exists only in the working copy or only in old commits (deleted): history still lists the commits up to its deletion.

## File Structure

- Create `extension/src/core/renameMatch.ts`, `extension/src/core/objectHistory.ts`, `extension/src/commands/objectHistory.ts`.
- Modify `extension/src/core/configdiff.ts`, `extension/src/core/configdiff` consumers (`views/configDiffHtml.ts`, `changesToText` in `core/confighistory.ts`), `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.
- Tests: `extension/test/renameMatch.test.ts`, `extension/test/objectHistory.test.ts`, additions to `extension/test/configdiff.test.ts`.

### Task 1: Rename pairing

**Files:** Create `extension/src/core/renameMatch.ts`, `extension/test/renameMatch.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export function similarity(a: string, b: string): number          // common non-blank trimmed lines / max(lines of a, lines of b); 1 for two empty texts
  export function pairRenames<T>(removed: T[], added: T[], text: (t: T) => string, threshold?: number): { from: T; to: T; score: number }[]
  ```
  Default threshold 0.7. A pair needs a unique best partner on both sides; ties give no pair.

- [ ] **Step 1: Write the failing tests:** `similarity of equal texts is 1 and of disjoint texts 0`; `blank lines and indentation are ignored`; `pairRenames pairs a renamed item whose body changed by one line out of ten`; `pairRenames gives no pair when two added items fit equally well`; `pairRenames gives no pair below the threshold`; `pairRenames never uses an item twice`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** both functions; greedy by descending score after the uniqueness check.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add text-similarity pairing for renamed items` (body: history and the config diff both need to tell "renamed" from "deleted plus added").

### Task 2: Object history

**Files:** Create `extension/src/core/objectHistory.ts`, `extension/test/objectHistory.test.ts`.

**Interfaces:**
- Consumes: `decode`, `parseView` (view text split into sections, `model.ts`), `pairRenames` (Task 1), `log`, `show` from `core/git.ts`. `log` currently has no `--follow`; add an optional parameter `follow?: boolean` that adds `--follow` and requires exactly one path.
- Produces:
  ```ts
  export interface HistoryEntry { commit: string; short: string; date: string; author: string; subject: string; key: string; change: 'added' | 'changed' | 'renamed' | 'removed' | 'unreadable'; renamedFrom?: string; before?: string; after?: string }
  export function sectionTextOf(view: string, key: string): string | undefined
  export async function objectHistory(root: string, file: string, key: string | 'FILE', max?: number): Promise<{ entries: HistoryEntry[]; cut: boolean }>
  ```
  `key` is `kindName` as `model.ts` keys sections (`METHOD:Start`); `'FILE'` follows the whole object (all sections). Entries newest first; each carries the before / after section text so the diff needs no second git call.

- [ ] **Step 1: Write the failing tests** (throwaway repo as `merge.test.ts`, small `.TcPOU` writer helper in the test):
  - `a changed method gets one entry per commit that changed its text`; commits that touch only other methods give none.
  - `a rename keeps the history`: commit 2 renames `Start` to `Begin` (body changed by one line); `objectHistory(…, 'METHOD:Begin')` lists commit 2 as `renamed` with `renamedFrom: 'METHOD:Start'` and commit 1 as `added` under the old name.
  - `an unrelated delete plus add is not a rename` (Review Focus 2).
  - `a renamed file is followed` (`git mv` plus `Name` attribute change in one commit).
  - `a commit with conflict markers in the XML is reported as unreadable and the walk goes on`.
  - `the list is cut at max and says so`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement.** Per commit (oldest to newest after reading all with `showMany`/`show`): decode, extract `sectionTextOf`, compare with the previous readable version. Missing in new and present in old: collect as removed; present only in new: added; pair with `pairRenames` on the section texts of that commit; a pair continues the followed identity. Decode failures give an `unreadable` entry and do not update the previous version.
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `Add per-object history that follows renames` (body: `git log -L` cannot see sections inside the XML, so the history compares section texts commit by commit).

### Task 3: History command and diff

**Files:** Create `extension/src/commands/objectHistory.ts`; modify `extension/src/extension.ts`, `extension/package.json`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `objectHistory` (Task 2); `spansOf` (Plan A Task 1) to find the section at the cursor of an `iecode` document; the project tree `Node` for methods / properties / actions (`views/tree.ts`).
- Produces: command `iecode.objectHistory` (tree context menu on objects and members, editor context menu and command palette in the ST view); virtual scheme `iecode-section` (`query`: `commit`, `file`, `key`, `side`).

- [ ] **Step 1: Write the failing test** for the pure label: `historyItemLabel(e: HistoryEntry): { label: string; description: string }` in `core/objectHistory.ts` (`a1b2c3d  Fix cooling alarm`, description `Ada Lovelace, 2026-11-02`, `renamed from Start` suffix, `not readable` for `unreadable`).
- [ ] **Step 2: Run, expect FAIL; implement; run, expect PASS.**
- [ ] **Step 3: Wire** the command: QuickPick of entries (placeholder names the object and, when cut, "showing the newest 200"), selecting an entry runs `vscode.diff` between the `before` and `after` side of `iecode-section` URIs (title `<key> @ <short>`). A top entry "Working copy" when the section differs from HEAD.
- [ ] **Step 4: Run** `npm test` and `npm run compile`; manual F5 check on a repository with a renamed method.
- [ ] **Step 5: Commit** `Show the history of one object and diff a commit` (body: previously only whole-file compare existed).

### Task 4: Renamed items in the config diff

**Files:** Modify `extension/src/core/configdiff.ts`, `extension/src/views/configDiffHtml.ts`, `extension/src/core/confighistory.ts` (`changesToText`), `extension/test/configdiff.test.ts`, `CHANGELOG.md`.

**Interfaces:**
- Consumes: `pairRenames` (Task 1); entry keys have the form `category/Name/field…` (`tasks/PlcTask/CycleTime`, `symbols/PlcTask Inputs/MAIN.bStart/BaseType`).
- Produces: `ConfigChange.kind` gains `'renamed'` with `from?: string` (the old `category/Name` prefix) and `key` the new one; `diffConfig` keeps its signature. The entries of a renamed item that are equal after the rename are not listed any more; the changed ones stay as `changed` under the new key.

- [ ] **Step 1: Write the failing tests:** `a renamed task is one renamed change and not N removed plus N added entries`; `a renamed task with a changed cycle time shows renamed plus one changed entry`; `two removed and two added tasks with different values give no rename`; `a rename inside a hidden category stays hidden` (filters still apply); `changesToText prints "renamed A -> B"`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement** in `diffConfig`: after computing `removed` / `added`, group both by the first two key segments, `pairRenames` on the joined `field=value` lines of each group, emit one `renamed` change per pair and drop the paired removed/added entries whose `field=value` appears on both sides. Render in `configDiffHtml.ts` and `changesToText` (`renamed Old → New`). Read both consumers' handling of `kind` first; no other consumer may see an unknown kind.
- [ ] **Step 4: Run** `npm test`. Expected: PASS (existing config diff tests unchanged).
- [ ] **Step 5: Commit** `Detect renamed items in the config diff` (body: a renamed task or symbol showed as a full delete plus add; closes the "rename detection" item left open in the config diff plan).
