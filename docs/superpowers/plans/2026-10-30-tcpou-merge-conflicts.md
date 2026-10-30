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
- Commits: subject + 1-3 sentence body on *why*; no attribution trailers. Every commit is signed off (`git commit -s`): the PR check in `.github/workflows/ci.yml` rejects commits without `Signed-off-by`.

## Review Focus

1. **User already edited the conflicted file by hand** – auto-resolve rebuilds from git stages and would discard those edits → modal confirmation when the working file differs from what git left (`git checkout -m`-style check: working file != `git show :<path>` is not possible for unmerged paths, so compare against a re-created conflict via `git merge-file` of the raw XML stages). The re-created conflict can differ from git's (labels, merge drivers), so this check is conservative: any difference asks. Unsaved edits in an open XML or ST editor of the file also ask. Test in Task 3 (pure check) and Task 4.
6. **Structural conflicts** – a conflict that spans a section header (both sides add a method with the same name, one side renames or deletes a method the other changed) makes `parseView` throw `Duplicate section` or splits marker content across sections. Auto-resolve does not try to repair that: when `encode` throws, it refuses and points to the XML merge editor. Test in Task 3.
7. **Graphical implementations** – the ST view shows non-ST bodies (FBD, LD, SFC, CFC) only as a read-only placeholder (`src/model.ts`, `IMPLEMENTATION (<lang>, read-only …)`). Encoding into ours would silently drop theirs' changes to them. When any section with a non-ST body differs between ours and theirs, auto-resolve refuses. Test in Task 3.
2. **Delete/modify conflict** (stage 2 or 3 missing) – auto-resolve must refuse with a clear message, not write an empty file. Test in Task 3.
3. **Rebase** – during `git rebase`, stage 2 is the upstream, not the user's commit; "ours wins" then means upstream wins. Label the markers from the actual refs and say "ours (stage 2)" in the result message instead of "HEAD". Test of labels in Task 2.
4. **BOM + CRLF** – TwinCAT files are UTF-8 with BOM and CRLF; the written file must keep both. Test in Task 3.
5. **diff3 conflict style** (`merge.conflictStyle=diff3`/`zdiff3` in the user's git config) – markers contain `|||||||`; `findConflicts` already handles it. Labels alone don't switch the style off, so call `git -c merge.conflictStyle=merge merge-file …` to keep the output predictable. Test in Task 2.

---

### Task 0: Dev launch from the repo root + reproducible conflict repo

The Extension Development Host started from the shell could not open a real project repo; F5 from the repo root found no launch config (it lives in `extension/.vscode`). Fix both, and give every later task a real conflict to test against.

**Files:**
- Create: `.vscode/launch.json` (repo root)
- Create: `extension/scripts/conflict-repo.sh`

- [ ] **Step 1:** Root `.vscode/launch.json` with one `extensionHost` config "Run IECode (pick a folder)": `--extensionDevelopmentPath=${workspaceFolder}/extension`, folder via `promptString` input, `outFiles` `${workspaceFolder}/extension/out/**/*.js`, `preLaunchTask` that runs `npm run compile` with `cwd` `${workspaceFolder}/extension` (define it in root `.vscode/tasks.json`).
- [ ] **Step 2:** `conflict-repo.sh <target-dir>` (add `*.sh text eol=lf` to `.gitattributes` so Git Bash on Windows can run it; all git calls with `-c core.autocrlf=false` and fixed `user.name`/`user.email`, and the target repo gets a `.gitattributes` with `*.TcPOU -text`, because the repo's own rules don't follow the copied file): `git init`, copy `samples/FB_Motor.TcPOU`, commit; branch `a` changes the `Start` method body *and* its `<LineIds>` *and* the `FolderPath` attribute of `Start`; branch `b` changes the same body line differently, its `<LineIds>`, and `FolderPath` differently; checkout `a`, `git merge b` (expected to conflict). Prints the target dir.
- [ ] **Step 3: Verify:** run the script into the scratchpad, `git status --short` shows `UU FB_Motor.TcPOU`, and `grep -c '^<<<<<<<'` ≥ 2. Press F5 in the root workspace, enter that folder → the Development Host window opens it.
- [ ] **Step 4: Commit** `Dev: launch config at repo root and conflict test repo script`.

### Task 1: Drop the LineIds cleanup prompt

The ST-view tolerance and the CodeLens are already committed (`752ff68`, `d486595`). Only the removal below is left.

**Files:** `extension/src/extension.ts`

- [ ] **Step 1:** Remove `offerLineIdsCleanup` and its two call sites from `src/extension.ts` (superseded by Auto-resolve in Task 4; a LineIds-only conflict is covered there). Keep `toXmlOnConflict` and the watcher.
- [ ] **Step 2: Run** `npm test` → 0 fail.
- [ ] **Step 3: Commit** `Editor: drop the LineIds cleanup prompt` (body: auto-resolve in Task 4 replaces it; one place to resolve XML conflicts instead of two).

### Task 2: git stages and three-way merge helpers

**Files:**
- Modify: `extension/src/core/git.ts`
- Test: `extension/test/merge.test.ts` (new; creates a temp repo with `fs.mkdtemp` and real `git` commands, like `scripts/e2e.sh` does; every git call passes `-c core.autocrlf=false -c user.name=… -c user.email=…`, like `test/iotree.test.ts`, so Windows runs (`release.yml` tests on Windows) see the same bytes as Linux CI)

**Interfaces – Produces:**
- `stage(root: string, n: 1 | 2 | 3, file: string): Promise<string | undefined>` – `git show :<n>:<rel>`; undefined when the stage doesn't exist.
- `mergeText(ours: string, base: string, theirs: string, labels: { ours: string; base: string; theirs: string }): Promise<{ text: string; conflicts: number }>` – writes three temp files, runs `git -c merge.conflictStyle=merge merge-file -p -L <ours> -L <base> -L <theirs> <o> <b> <t>` (do **not** use the rejecting `git()` helper for it). Exit 0-127 is the conflict count (git caps it at 127); exit 255 (git's "negative on error"), any other code, a signal or stderr output with exit ≥ 128 → throw. Temp files are removed in `finally`.
- `mergeLabels(root: string): Promise<{ ours: string; theirs: string }>` – `ours` = current branch name (or short HEAD); `theirs` = first existing of `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REBASE_HEAD`, `REVERT_HEAD` as `git name-rev --name-only` or short hash, fallback `'incoming'`.

- [ ] **Step 1: Failing tests:**
  - `stage returns base/ours/theirs of a conflicted file and undefined for a missing stage`
  - `mergeText merges disjoint changes cleanly` → `conflicts === 0`, both changes in `text`
  - `mergeText reports a conflict with the given labels` → `conflicts === 1`, `text` matches `/^<{7} ours-label$/m` and `/^>{7} theirs-label$/m`, no `|||||||` line even with `git config merge.conflictStyle diff3` set in the temp repo
  - `mergeText throws when git merge-file fails` → a missing temp dir or invalid input path rejects instead of returning a conflict count of 255
  - `mergeLabels names the incoming side during a merge` → `theirs` resolves to the same commit as `MERGE_HEAD` (assert by `git rev-parse`, not by the exact `name-rev` text)
  - `stage and mergeLabels during a cherry-pick and a rebase` → stage 2 is the side being applied onto (during rebase: upstream), `theirs` comes from `CHERRY_PICK_HEAD` / `REBASE_HEAD`
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
- Produces: `autoResolve(file: string): Promise<{ xml: string; codeConflicts: number; snapshot: Snapshot }>` (does not write), `editedSinceConflict(...)` and `class AutoResolveError extends Error`.

Algorithm (the part the signature doesn't determine):
1. `root = repoRoot(file)`; `ours = stage(2)`, `theirs = stage(3)`; either missing → `AutoResolveError('<name>: deleted on one side; resolve in Source Control')`. `base = stage(1) ?? ''`.
2. Any of the three encrypted → `AutoResolveError`.
3. Strip BOM, `decode()` each (base `''` → view `''`).
4. `mergeText(oursView, baseView, theirsView, { ...mergeLabels, base: 'base' })`.
5. Any section whose body is not ST (placeholder line in the view) differs between ours and theirs → `AutoResolveError('<name>: graphical implementation changed on both sides; use the XML merge editor')`.
6. `xml = encode(oursXml, merged.text)`; a `ViewError` (e.g. `Duplicate section` from markers around a section header) → `AutoResolveError('<name>: conflict in the object structure; use the XML merge editor')`. BOM and EOL come from the working file on disk, not from stage 2 (with `core.autocrlf=true` and no `-text` attribute the stages are LF).
7. Return `{ xml, codeConflicts: merged.conflicts, snapshot }` where `snapshot` holds the three stages and the working file text it was computed from, so the caller can re-check before writing.

Also produce the pure `editedSinceConflict(file, stages, labels, workingText): Promise<boolean>` (Review Focus 1) for Task 4.

- [ ] **Step 1: Failing tests** (temp repo built like Task 0's script, but in TS):
  - `autoResolve leaves only code conflicts` → `decode(xml)` contains exactly one `<<<<<<<` block, `xml` has no marker outside CDATA (assert `decode` doesn't throw and `xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')` has no marker line)
  - `autoResolve keeps ours' XML attributes` → `FolderPath` value from branch `a`
  - `autoResolve takes a method added only by theirs` → `decode(xml)` contains `//==== METHOD Added ====`
  - `autoResolve keeps BOM and CRLF` → `xml` starts with `﻿`, has no lone `\n`
  - `autoResolve refuses a delete/modify conflict` → rejects with `AutoResolveError`
  - `autoResolve refuses a structural conflict` → both branches add `METHOD Added` with different bodies → rejects with `AutoResolveError`, nothing thrown past it
  - `autoResolve refuses a changed graphical implementation` → a fixture section with an FBD body changed differently on both sides → rejects with `AutoResolveError`
  - `editedSinceConflict detects manual edits` → `false` for the file git wrote, `true` after changing one line outside the markers
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
  - existing `iecode.openAsXml`: its handler in `extension.ts` takes only `Uri` today; change it to accept `Uri | SourceControlResourceState` (use `.resourceUri`) in place, no second registration.
- Context key `iecode.conflictedFiles: string[]` (object files containing a conflict marker), refreshed on active editor change and on the object-file watcher. `resourcePath` is the URI's `fsPath`, so store for each file the `fsPath` of its `file:` URI **and** of its `iecode:` URI (the ST editor). Build both through `vscode.Uri`, so drive-letter spelling (`c:` vs `C:`, see the note in `test/e2e/index.ts`) is normalised the same way VS Code does it. Check the bar in the XML and the ST editor on Windows in Task 5, by menu visibility, not only by running the command.

Behaviour of `iecode.autoResolveXml`:
1. If an open XML or ST editor of the file is dirty, or `editedSinceConflict` is true (Review Focus 1, ignoring BOM/EOL) → modal "Overwrite your edits in <name>?" with "Overwrite"; otherwise no prompt. Cancel writes nothing.
2. Right before writing, re-read the stages and the working file; if they differ from `snapshot` (the user or git changed something during the prompt) → "<name> changed meanwhile; run Auto-resolve again." and write nothing. Otherwise write `xml` (BOM kept), then open the ST view (`iecode.openAsST`).
3. Message: `codeConflicts === 0` → "<name>: merged. Stage it in Source Control." else "<name>: XML merged (ours wins). <n> code conflict(s) left in the ST view."
4. `AutoResolveError` → `showErrorMessage(e.message)`.

Menus (`package.json`):
- `editor/title` (group `navigation@1..3`): the three commands, `when` `resourcePath in iecode.conflictedFiles` (`openAsXml` only when `resourceScheme == iecode`).
- `scm/resourceState/context` (group `inline` for auto-resolve, `navigation` for the others): `when` `scmProvider == git && scmResourceGroup == merge`, without a file-type filter: VS Code caches that menu per resource state and can't filter it by extension (see `src/commands/compare.ts`, Source Control submenu). The commands refuse other files with `IECode: auto-resolve works on .TcPOU/.TcDUT/.TcGVL/.TcIO files.` (Accepted trade-off: the entry shows on every conflicted file in the Merge Changes group.)
- XML-conflict warning in `extension.ts` gets buttons "Auto-resolve XML" / "Open Merge Editor".

- [ ] **Step 1:** Implement `src/commands/conflicts.ts` and the `package.json` contributions.
- [ ] **Step 2: Run** `npm test` → pass (compile check; logic is covered by Task 3, UI by Task 5).
- [ ] **Step 3: Commit** `Conflict bar: auto-resolve XML, XML merge editor, open as XML`.

### Task 5: End-to-end check in a real VS Code

**Files:**
- Modify: `extension/test/e2e/index.ts`
- Modify: `extension/scripts/e2e.sh` (create the conflict with the Task 0 script logic in its own repo `$TMP/conflict`, not in the `$TMP` repo the existing e2e steps edit `FB_Motor.TcPOU` in; `CODE` default stays, document the Windows value in a comment: `CODE="$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe"`)

- [ ] **Step 1:** e2e steps, each an `assert`:
  - opening the conflicted file → active editor scheme is `file` (XML conflict, no redirect to ST)
  - `executeCommand('iecode.autoResolveXml', uri)` → active editor scheme `iecode`, text has one `<<<<<<<`
  - `vscode.executeCodeLensProvider` on that document → 3 lenses with titles `Accept Current Change`, `Accept Incoming Change`, `Accept Both Changes`
  - `executeCommand('iecode.mergeAccept', doc.uri, start, 'current')` + save → file on disk has no marker line, `decode` works
- [ ] **Step 2: Run** `CODE=… sh scripts/e2e.sh` → "e2e passed" (or the existing success output).
- [ ] **Step 3: Manual check:** F5 from the root (Task 0) on a fresh `conflict-repo.sh` folder: Source Control → Merge Changes → right click → *Auto-resolve XML Conflicts* → ST view with coloured block and three lenses → Accept → Save → stage.
- [ ] **Step 4:** `extension/CHANGELOG.md`: under `## Unreleased`, heading `### Editor` (append if it exists), one bullet per user-visible behaviour (conflict bar, auto-resolve, ST CodeLens). Do not change `version` in `package.json`; the maintainer bumps at release.
- [ ] **Step 5: Commit** `e2e: merge conflict flow; changelog`.
