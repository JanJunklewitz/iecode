# TcPOU Merge Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve git merge conflicts in TwinCAT object files (`.TcPOU/.TcDUT/.TcGVL/.TcIO`) without touching XML: one click auto-resolves everything outside the ST code, the remaining code conflicts are resolved in the ST view with Accept Current / Incoming / Both.

**Architecture:** A conflicted object file gets a "conflict bar" (editor title + Source Control context menu) with three actions: *Auto-resolve XML*, *Open XML Merge Editor* (VS Code's built-in, as before), *Open as XML*. Auto-resolve is a semantic merge, not marker editing: read git's index stages `:1:` (base), `:2:` (ours), `:3:` (theirs), `decode()` each to the ST view, merge the three views with `git merge-file`, and `encode()` the result into the XML of *ours*. Conflict markers then only exist inside CDATA, which the ST view shows and the existing CodeLens (`src/lang/mergeConflicts.ts`) resolves.

**Tech Stack:** TypeScript, VS Code extension API, git CLI (`execFile`), `node --test`.

**Spec:** this conversation's decisions (no separate spec file):
- three stages: conflict bar → auto-resolve XML → resolve code conflicts in the ST view
- built-in XML merge stays available ("as before")
- XML-only differences (attributes such as `Id`, `FolderPath`): **ours (stage 2 / HEAD) wins**; sections added only by theirs get a new GUID (accepted)

## Global Constraints

- All code, comments, UI strings, commit messages in English.
- Match surrounding style: 2-space indent, single quotes, terse one-line comments explaining *why*.
- No new runtime dependencies; git via `execFile('git', …)` like `src/core/git.ts`.
- `npm test` (= `tsc -p . && node --test out/test/*.test.js`) must stay green after every task. Run tests through the PowerShell tool, not Git Bash.
- Existing behaviour without conflicts must not change (ST redirect, save, compare).
- Commits: subject + 1-3 sentence body on *why*; no attribution trailers.

## Review Focus

1. **User already edited the conflicted file by hand** – auto-resolve rebuilds from git stages and would discard those edits → modal confirmation when the working file differs from what git left (`git checkout -m`-style check: working file != `git show :<path>` is not possible for unmerged paths, so compare against a re-created conflict via `git merge-file` of the raw XML stages). Test in Task 3.
2. **Delete/modify conflict** (stage 2 or 3 missing) – auto-resolve must refuse with a clear message, not write an empty file. Test in Task 3.
3. **Rebase** – during `git rebase`, stage 2 is the upstream, not the user's commit; "ours wins" then means upstream wins. Label the markers from the actual refs and say "ours (stage 2)" in the result message instead of "HEAD". Test of labels in Task 2.
4. **BOM + CRLF** – TwinCAT files are UTF-8 with BOM and CRLF; the written file must keep both. Test in Task 3.
5. **diff3 conflict style** (`merge.conflictStyle=diff3`/`zdiff3` in the user's git config) – markers contain `|||||||`; `findConflicts` already handles it, `git merge-file` must be called with `--diff3` *off* explicitly (`-L` labels only) so output is predictable. Test in Task 2.

---

### Task 0: Dev launch from the repo root + reproducible conflict repo

The Extension Development Host started from the shell could not open a real project repo; F5 from the repo root found no launch config (it lives in `extension/.vscode`). Fix both, and give every later task a real conflict to test against.

**Files:**
- Create: `.vscode/launch.json` (repo root)
- Create: `extension/scripts/conflict-repo.sh`

- [ ] **Step 1:** Root `.vscode/launch.json` with one `extensionHost` config "Run IECode (pick a folder)": `--extensionDevelopmentPath=${workspaceFolder}/extension`, folder via `promptString` input, `outFiles` `${workspaceFolder}/extension/out/**/*.js`, `preLaunchTask` that runs `npm run compile` with `cwd` `${workspaceFolder}/extension` (define it in root `.vscode/tasks.json`).
- [ ] **Step 2:** `conflict-repo.sh <target-dir>`: `git init`, copy `samples/FB_Motor.TcPOU`, commit; branch `a` changes the `Start` method body *and* its `<LineIds>` *and* the `FolderPath` attribute of `Start`; branch `b` changes the same body line differently, its `<LineIds>`, and `FolderPath` differently; checkout `a`, `git merge b` (expected to conflict). Prints the target dir.
- [ ] **Step 3: Verify:** run the script into the scratchpad, `git status --short` shows `UU FB_Motor.TcPOU`, and `grep -c '^<<<<<<<'` ≥ 2. Press F5 in the root workspace, enter that folder → the Development Host window opens it.
- [ ] **Step 4: Commit** `Dev: launch config at repo root and conflict test repo script`.

### Task 1: Commit the existing ST-view tolerance (already on the branch)

**Files (already modified, uncommitted):** `extension/src/model.ts`, `extension/test/model.test.ts`, `extension/src/lang/conflicts.ts`, `extension/test/conflicts.test.ts`, `extension/src/lang/mergeConflicts.ts`, `extension/src/extension.ts`

- [ ] **Step 1:** Remove `offerLineIdsCleanup` and its two call sites from `src/extension.ts` (superseded by Auto-resolve in Task 4; a LineIds-only conflict is covered there). Keep `toXmlOnConflict` and the watcher.
- [ ] **Step 2: Run** `npm test` → all pass (currently 80 pass, 1 skipped).
- [ ] **Step 3: Commit** `ST view: tolerate conflicts in CDATA and LineIds, CodeLens to resolve them` (body: markers between XML elements didn't break the parser, so XML conflicts went undetected; VS Code's merge-conflict extension ignores the iecode: scheme).

### Task 2: git stages and three-way merge helpers

**Files:**
- Modify: `extension/src/core/git.ts`
- Test: `extension/test/merge.test.ts` (new; creates a temp repo with `fs.mkdtemp` and real `git` commands, like `scripts/e2e.sh` does)

**Interfaces – Produces:**
- `stage(root: string, n: 1 | 2 | 3, file: string): Promise<string | undefined>` – `git show :<n>:<rel>`; undefined when the stage doesn't exist.
- `mergeText(ours: string, base: string, theirs: string, labels: { ours: string; base: string; theirs: string }): Promise<{ text: string; conflicts: number }>` – writes three temp files, runs `git merge-file -p -L <ours> -L <base> -L <theirs> <o> <b> <t>`; exit code ≥ 0 is the conflict count (do **not** use the rejecting `git()` helper for it), < 0 / signal → throw.
- `mergeLabels(root: string): Promise<{ ours: string; theirs: string }>` – `ours` = current branch name (or short HEAD); `theirs` = first existing of `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REBASE_HEAD`, `REVERT_HEAD` as `git name-rev --name-only` or short hash, fallback `'incoming'`.

- [ ] **Step 1: Failing tests:**
  - `stage returns base/ours/theirs of a conflicted file and undefined for a missing stage`
  - `mergeText merges disjoint changes cleanly` → `conflicts === 0`, both changes in `text`
  - `mergeText reports a conflict with the given labels` → `conflicts === 1`, `text` matches `/^<{7} ours-label$/m` and `/^>{7} theirs-label$/m`, no `|||||||` line even with `git config merge.conflictStyle diff3` set in the temp repo
  - `mergeLabels names the merged branch during a merge` → `theirs === 'b'`
- [ ] **Step 2: Run** `npm test` → the new tests fail (functions missing).
- [ ] **Step 3: Implement** the three functions in `src/core/git.ts`.
- [ ] **Step 4: Run** `npm test` → all pass.
- [ ] **Step 5: Commit** `git: index stages and three-way text merge`.

### Task 3: Semantic auto-resolve of an object file

**Files:**
- Create: `extension/src/core/autoResolve.ts`
- Test: `extension/test/merge.test.ts`

**Interfaces:**
- Consumes: `stage`, `mergeText`, `mergeLabels` (Task 2); `decode`, `encode` from `src/model.ts`; `isEncrypted` from `src/core/projects.ts`.
- Produces: `autoResolve(file: string): Promise<{ xml: string; codeConflicts: number }>` (does not write) and `class AutoResolveError extends Error`.

Algorithm (the part the signature doesn't determine):
1. `root = repoRoot(file)`; `ours = stage(2)`, `theirs = stage(3)`; either missing → `AutoResolveError('<name>: deleted on one side; resolve in Source Control')`. `base = stage(1) ?? ''`.
2. Any of the three encrypted → `AutoResolveError`.
3. Strip BOM, `decode()` each (base `''` → view `''`).
4. `mergeText(oursView, baseView, theirsView, { ...mergeLabels, base: 'base' })`.
5. `xml = encode(oursXml, merged.text)`; re-add BOM and keep ours' EOL (encode already does).
6. Return `{ xml, codeConflicts: merged.conflicts }`.

- [ ] **Step 1: Failing tests** (temp repo built like Task 0's script, but in TS):
  - `autoResolve leaves only code conflicts` → `decode(xml)` contains exactly one `<<<<<<<` block, `xml` has no marker outside CDATA (assert `decode` doesn't throw and `xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')` has no marker line)
  - `autoResolve keeps ours' XML attributes` → `FolderPath` value from branch `a`
  - `autoResolve takes a method added only by theirs` → `decode(xml)` contains `//==== METHOD Added ====`
  - `autoResolve keeps BOM and CRLF` → `xml` starts with `﻿`, has no lone `\n`
  - `autoResolve refuses a delete/modify conflict` → rejects with `AutoResolveError`
- [ ] **Step 2: Run** `npm test` → fail.
- [ ] **Step 3: Implement** `src/core/autoResolve.ts`.
- [ ] **Step 4: Run** `npm test` → pass.
- [ ] **Step 5: Commit** `Auto-resolve: merge object files on the ST view instead of the XML`.

### Task 4: Conflict bar and commands

**Files:**
- Create: `extension/src/commands/conflicts.ts` (`register(ctx)`)
- Modify: `extension/src/extension.ts` (call `conflicts.register(ctx)`; in `openView` and the tab redirect, an XML conflict now shows the warning with buttons instead of plain text)
- Modify: `extension/package.json` (commands + menus)

**Interfaces:**
- Consumes: `autoResolve`, `AutoResolveError` (Task 3); new pure `hasXmlConflict(xml: string): boolean` in `src/model.ts` (true when `decode` throws `ConflictError`); `extension.ts`'s `xmlConflict(uri)` becomes a thin file-reading wrapper around it, and `commands/conflicts.ts` uses the same wrapper pattern.
- Produces commands (all accept `Uri | SourceControlResourceState | undefined`, falling back to the active editor; `iecode:` URIs map to `file:`):
  - `iecode.autoResolveXml` – title "Auto-resolve XML Conflicts", icon `$(wand)`
  - `iecode.openMergeEditor` – title "Open XML Merge Editor", icon `$(git-merge)`; runs `git.openMergeEditor` with the `file:` URI
  - existing `iecode.openAsXml`
- Context key `iecode.conflictedFiles: string[]` (fsPaths of object files containing a conflict marker), refreshed on active editor change and on the object-file watcher.

Behaviour of `iecode.autoResolveXml`:
1. If the working file was edited since git wrote the conflict (Review Focus 1: rebuild git's conflicted XML with `mergeText(oursXml, baseXml, theirsXml, labels)` and compare to the file, ignoring BOM/EOL) → modal "Overwrite your manual edits in <name>?" with "Overwrite"; otherwise no prompt.
2. Write `xml` (BOM kept), then open the ST view (`iecode.openAsST`).
3. Message: `codeConflicts === 0` → "<name>: merged. Stage it in Source Control." else "<name>: XML merged (ours wins). <n> code conflict(s) left in the ST view."
4. `AutoResolveError` → `showErrorMessage(e.message)`.

Menus (`package.json`):
- `editor/title` (group `navigation@1..3`): the three commands, `when` `resourcePath in iecode.conflictedFiles` (`openAsXml` only when `resourceScheme == iecode`).
- `scm/resourceState/context` (group `inline` for auto-resolve, `navigation` for the others): `when` `scmProvider == git && scmResourceGroup == merge && resourceExtname =~ /\\.(TcPOU|TcDUT|TcGVL|TcIO)$/i`.
- XML-conflict warning in `extension.ts` gets buttons "Auto-resolve XML" / "Open Merge Editor".

- [ ] **Step 1:** Implement `src/commands/conflicts.ts` and the `package.json` contributions.
- [ ] **Step 2: Run** `npm test` → pass (compile check; logic is covered by Task 3, UI by Task 5).
- [ ] **Step 3: Commit** `Conflict bar: auto-resolve XML, XML merge editor, open as XML`.

### Task 5: End-to-end check in a real VS Code

**Files:**
- Modify: `extension/test/e2e/index.ts`
- Modify: `extension/scripts/e2e.sh` (create the conflict with the Task 0 script logic inside `$TMP`; `CODE` default stays, document the Windows value in a comment: `CODE="$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe"`)

- [ ] **Step 1:** e2e steps, each an `assert`:
  - opening the conflicted file → active editor scheme is `file` (XML conflict, no redirect to ST)
  - `executeCommand('iecode.autoResolveXml', uri)` → active editor scheme `iecode`, text has one `<<<<<<<`
  - `vscode.executeCodeLensProvider` on that document → 3 lenses with titles `Accept Current Change`, `Accept Incoming Change`, `Accept Both Changes`
  - `executeCommand('iecode.mergeAccept', doc.uri, start, 'current')` + save → file on disk has no marker line, `decode` works
- [ ] **Step 2: Run** `CODE=… sh scripts/e2e.sh` → "e2e passed" (or the existing success output).
- [ ] **Step 3: Manual check:** F5 from the root (Task 0) on a fresh `conflict-repo.sh` folder: Source Control → Merge Changes → right click → *Auto-resolve XML Conflicts* → ST view with coloured block and three lenses → Accept → Save → stage.
- [ ] **Step 4:** `CHANGELOG.md`: new `## 0.2.3` → `### Editor` with one bullet per user-visible behaviour (conflict bar, auto-resolve, ST CodeLens); bump `version` in `package.json` to `0.2.3`.
- [ ] **Step 5: Commit** `e2e: merge conflict flow; changelog 0.2.3`.
