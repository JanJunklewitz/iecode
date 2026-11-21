# Plan D: Filter the project tree by name and kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [small items master plan](2026-11-17-small-items-master-plan.md).

**Goal:** A filter button in the IECode project tree narrows the tree to the PLC objects whose name contains the typed text, optionally limited to kinds (`@fb motor`), with the folders on the way expanded.

**Architecture:** A pure module `extension/src/core/treeFilter.ts` parses the filter and decides which objects and folders of a PLC project stay visible. `ProjectTree` (`extension/src/views/tree.ts`) asks it in `getChildren` and expands folders while a filter is active. A live input box sets the filter; a context key switches the title buttons.

**Tech Stack:** TypeScript (`node --test`), VS Code TreeView API.

**Spec:** `TODO.md` item "Project view: search and filter in the tree" ("filter the tree by name and kind"); prior art: Explorer for TwinCAT ("Go to Object, Find in Folder / Project").

## Global Constraints

- Public repository: generic names in tests (`FB_Motor`, `MAIN`). Commits: English subject plus a 1-3 sentence why-body, noreply address, `git commit -s`.
- Decisions in `extension/src/core/`; `src/views/tree.ts` only wires.
- Without a filter the tree is unchanged (same nodes, same ids, same collapsed state).
- Tests: `cd extension && npm test`.

## Decisions (taken by the planner, 2026-11-17)

1. **Syntax:** words separated by spaces. A word starting with `@` is a kind (`@fb`, `@prg`, `@fun`, `@itf`, `@struct`, `@enum`, `@union`, `@alias`, `@gvl`, `@task`, `@texts`, `@images`; the short names the tree already shows, `TYPE_SHORT`, today in `tree.ts:36`, moved by Decision 6); several kinds are OR. Every other word must be contained in the object name, case-insensitive (AND). An unknown `@word` is an input error that lists the kinds.
2. **What is searched:** the names of the objects of the workspace PLC projects. Not searched: methods, properties and actions (would read every object file; a later item), library sources under References, system projects. While a filter is active the References nodes and the System Projects group are hidden.
3. **Live input:** `vscode.window.createInputBox` applies the filter 200 ms after the last key; Enter keeps it, Escape restores the filter from before the box opened. The filter lives for the session (not saved).
4. **Visible structure:** a project or group without a hit is hidden; folders that contain a hit are shown expanded; objects keep their normal children (members are not filtered). Expansion works through ids: while filtering, folder and unit ids get the suffix `#f<generation>`, so VS Code treats them as new nodes and uses `Expanded`.
5. **Feedback:** `TreeView.message` shows `Filter "<text>": <n> objects in <m> projects.` or `Filter "<text>": nothing found.`; the title shows **Clear Filter** while a filter is active (context key `iecode.treeFiltered`).
6. **One table of kind short names** (eng review 2026-11-18, R5). `TYPE_SHORT` moves from `tree.ts` to `core/treeFilter.ts` (exported) and `tree.ts` imports it; `KIND_WORDS` is derived from it (lower case, one-word entries only, so `VISUMANAGER` 'visu settings' and `OTHER` get no kind word). Two hand-kept lists would drift when a type is added. This replaces the original "move nothing out of `tree.ts`".
7. **Input box timing** (R6): Enter applies the current text at once (the pending 200 ms timer is cleared first); Enter on an invalid text keeps the box open with its validation message. Escape clears the pending timer before it restores the earlier filter, so a late timer cannot re-apply the abandoned text.
8. **Visibility cache** (R7): `visibleIn` results are cached in a `WeakMap` keyed by the `Unit` object and cleared on `setFilter` and on `state.onDidChange`; a cache keyed by unit id and generation would keep the hits of the old model after a reload.
9. **Own pull request from `origin/main`** (R8): the stack under this branch (protocol 2 work, 15 commits) touches neither `tree.ts` nor `extension.ts`, so Plan D is built on a branch from `origin/main` (`feature/tree-filter`) and ships on its own; only `package.json` and `CHANGELOG.md` may need a trivial merge later.
10. **Group nodes are filtered and expanded too** (R25, outside voice). Group nodes (`Applications`, `Libraries`, `Standalone PLC`) have no id today (`tree.ts` `case 'group'`), so a group the user collapsed stays collapsed and hides every hit, and `case 'group'` returns all units of the group. While filtering, `getChildren` of a group returns only units with hits, and group items get the id `group:<group>#f<generation>` and `Expanded`; without a filter they keep no id, as today. Whether VS Code brings back the user's own collapsed state after the filter is cleared is checked by hand (Task 2, step 5), not assumed.
11. **Kind list order** (R26): the error text lists the kind words in the order of `TYPE_SHORT` (`@fb @prg @fun @itf @enum @struct @union @alias @gvl @task @texts @images`), since `KIND_WORDS` is derived from it.

## Review Focus

1. Upper and lower case mixed (`motor` finds `FB_Motor`). (Task 1, `name words match case-insensitively`)
2. Only kind words (`@gvl`): every GVL, no name restriction. (Task 1, `kind words alone list every object of the kinds`)
3. An object in a nested folder: every folder on its path is visible, sibling folders without hits are not. (Task 1, `folders on the path to a hit are visible, others are not`)
4. Whitespace only or empty input: same as no filter. (Task 1, `an empty filter is no filter`)
5. A filter active while the workspace reloads (file added): the tree re-applies the filter to the new model. (Task 2, manual check; the cache rule of Decision 8)
6. Every kind word maps to a type whose short name it is, and every one-word short name has a kind word. (Task 1, `kind words are derived from the short names`)
7. Typing `motor` and pressing Enter within 200 ms filters by `motor`, not by `moto`. (Task 2, manual check)
8. A group the user collapsed before filtering opens while filtering and lists only projects with hits. (Task 2, manual check; Decision 10)

## File Structure

- Create `extension/src/core/treeFilter.ts`; test `extension/test/treeFilter.test.ts`.
- Modify `extension/src/views/tree.ts` (filter state, `getChildren`, ids and collapsible state), `extension/src/extension.ts:111-118` (commands, input box, message, context key), `extension/package.json` (two commands, `view/title` entries), `extension/CHANGELOG.md`, `README.md` of the extension if it lists the tree buttons (check with grep for `Refresh`).

---

### Task 1: Pure filter logic

**Files:**
- Create: `extension/src/core/treeFilter.ts`
- Test: `extension/test/treeFilter.test.ts`

**Interfaces:**
- Consumes: `PlcObject`, `ObjectType` (`core/projects.ts:9-24`).
- Produces:
  ```ts
  /** Moved from tree.ts unchanged (Decision 6); tree.ts imports it for the item descriptions. */
  export const TYPE_SHORT: Partial<Record<ObjectType, string>>;
  /** Derived from TYPE_SHORT: lower-case one-word short names -> type. fb, prg, fun, itf, struct, enum, union, alias, gvl, task, texts, images. */
  export const KIND_WORDS: Readonly<Record<string, ObjectType>>;
  export interface TreeFilter { text: string; words: string[]; kinds: ObjectType[] }   // words lower case
  export function parseTreeFilter(text: string): TreeFilter | undefined | { error: string };  // undefined = no filter
  export function objectMatches(f: TreeFilter, o: Pick<PlcObject, 'name' | 'type'>): boolean;
  /** Objects that match and every folder (rel path, '/' separated) on the way to one of them. */
  export function visibleIn(f: TreeFilter, objects: readonly PlcObject[]): { objects: Set<PlcObject>; folders: Set<string> };
  export function filterMessage(f: TreeFilter, objectCount: number, projectCount: number): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const obj = (rel: string, type: ObjectType = 'FUNCTION_BLOCK'): PlcObject =>
  ({ rel, file: `/p/${rel}`, name: rel.split('/').pop()!.replace(/\.\w+$/, ''), type });
test('an empty filter is no filter', () => {
  assert.equal(parseTreeFilter(''), undefined); assert.equal(parseTreeFilter('   '), undefined);
});
test('words and kinds are parsed', () => {
  assert.deepEqual(parseTreeFilter(' Motor  @fb @FUN axis'), { text: 'Motor  @fb @FUN axis', words: ['motor', 'axis'], kinds: ['FUNCTION_BLOCK', 'FUNCTION'] });
});
test('an unknown kind is an error that lists the kinds', () => {
  assert.deepEqual(parseTreeFilter('@xyz'), { error: 'Unknown kind "@xyz". Kinds: @fb @prg @fun @itf @enum @struct @union @alias @gvl @task @texts @images' });
});
test('name words match case-insensitively and all must match', () => {
  const f = parseTreeFilter('motor ctrl') as TreeFilter;
  assert.equal(objectMatches(f, { name: 'FB_MotorCtrl', type: 'FUNCTION_BLOCK' }), true);
  assert.equal(objectMatches(f, { name: 'FB_Motor', type: 'FUNCTION_BLOCK' }), false);
});
test('kind words alone list every object of the kinds', () => {
  const f = parseTreeFilter('@gvl') as TreeFilter;
  assert.equal(objectMatches(f, { name: 'GVL_Io', type: 'GVL' }), true);
  assert.equal(objectMatches(f, { name: 'MAIN', type: 'PROGRAM' }), false);
});
test('folders on the path to a hit are visible, others are not', () => {
  const objs = [obj('POUs/Motion/Axis/FB_Axis.TcPOU'), obj('POUs/Io/FB_Io.TcPOU'), obj('MAIN.TcPOU', 'PROGRAM')];
  const v = visibleIn(parseTreeFilter('axis') as TreeFilter, objs);
  assert.deepEqual([...v.folders].sort(), ['POUs', 'POUs/Motion', 'POUs/Motion/Axis']);
  assert.deepEqual([...v.objects].map(o => o.name), ['FB_Axis']);
});
test('kind words are derived from the short names', () => {
  for (const [w, t] of Object.entries(KIND_WORDS)) assert.equal(TYPE_SHORT[t]!.toLowerCase(), w);
  for (const s of Object.values(TYPE_SHORT)) if (!s!.includes(' ')) assert.ok(s!.toLowerCase() in KIND_WORDS, s);
  assert.equal('visu settings' in KIND_WORDS, false);
});
test('filterMessage counts objects and projects', () => {
  const f = parseTreeFilter('@fb motor') as TreeFilter;
  assert.equal(filterMessage(f, 12, 3), 'Filter "@fb motor": 12 objects in 3 projects.');
  assert.equal(filterMessage(f, 1, 1), 'Filter "@fb motor": 1 object in 1 project.');
  assert.equal(filterMessage(f, 0, 0), 'Filter "@fb motor": nothing found.');
});
```

- [ ] **Step 2: Run to verify they fail.** Run: `cd extension && npm test`. Expected: compile error `Cannot find module '../src/core/treeFilter'`.

- [ ] **Step 3: Implement `treeFilter.ts`.** Move `TYPE_SHORT` here and import it in `tree.ts` (Decision 6); derive `KIND_WORDS` from it.

- [ ] **Step 4: Run to verify they pass.** Run: `cd extension && npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/treeFilter.ts extension/src/views/tree.ts extension/test/treeFilter.test.ts
git commit -s -m "Add the filter logic for the project tree" -m "Finding one object in a large PLC project meant expanding folder after folder. VS Code's own type-to-find only searches expanded nodes, so the tree needs its own filter over the model."
```

---

### Task 2: Filter in the tree, commands and input box

**Files:**
- Modify: `extension/src/views/tree.ts`, `extension/src/extension.ts:111-118`, `extension/package.json`, `extension/CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces in `ProjectTree`:
  ```ts
  setFilter(f: TreeFilter | undefined): void;   // bumps the generation, fires onDidChangeTreeData
  filter(): TreeFilter | undefined;
  /** Hits of the current filter in the current model: { objects, projects }. */
  hits(): { objects: number; projects: number };
  ```

- [ ] **Step 1: Tree.** In `getChildren`: with a filter, the root lists only groups with a unit that has hits (no System Projects), and a group lists only its units with hits (Decision 10); `unit` children skip References and use `folderChildren` limited to `visibleIn(...)`; cache `visibleIn` per `Unit` object in a `WeakMap`, cleared on `setFilter` and on `state.onDidChange` (Decision 8). In `getTreeItem`: with a filter, `group`, `unit` and `folder` items are `Expanded` and get ids with `#f<generation>` (groups: `group:<group>#f<generation>`; without a filter groups keep no id).

- [ ] **Step 2: Commands and input box (`extension.ts`).** Keep the `TreeView` returned by `createTreeView('iecode.projects', ...)` in a const. `iecode.filterTree`: an input box with `title` `Filter the project tree`, `placeholder` `Name words and kinds, e.g. motor @fb (kinds: @fb @prg @fun @itf @gvl …)`, `value` the current text; `onDidChangeValue` debounced 200 ms: parse, set `validationMessage` on an error, else `tree.setFilter`; `onDidAccept` clears the timer and applies the current value at once, then hides the box only when the value parsed; Escape (`onDidHide` without accept) clears the timer and restores the previous filter (Decision 7). After each change: `view.message = filter ? filterMessage(...) : undefined` and `setContext('iecode.treeFiltered', !!filter)`. `iecode.clearTreeFilter` clears it. Re-apply the message on `state.onDidChange`.

- [ ] **Step 3: Manifest.** Commands `iecode.filterTree` (`Filter Project Tree…`, category `IECode`, icon `$(filter)`) and `iecode.clearTreeFilter` (`Clear Project Tree Filter`, icon `$(clear-all)`); `view/title` `navigation@0` with `view == iecode.projects && !iecode.treeFiltered` and `view == iecode.projects && iecode.treeFiltered` respectively. Hide `iecode.clearTreeFilter` from the command palette unless filtered (`commandPalette` `when: iecode.treeFiltered`).

- [ ] **Step 4: Run the tests.** Run: `cd extension && npm test`. Expected: compiles, all pass.

- [ ] **Step 5: Manual check (F5, about 10 min, on `testdata/`):** `motor` (or a name of the test data) narrows and expands; `@gvl` lists the GVLs; `@xyz` shows the error and keeps the old filter; type `motor` and press Enter at once: filtered by the full word; type, then Escape at once: the earlier filter stays; Escape restores; Clear brings back the unfiltered tree with its earlier collapsed state; a new file added while filtered appears if it matches; collapse the Applications group, then filter: the group opens and shows only the projects with hits; clear the filter: record whether VS Code restores the collapsed group and folders (Decision 10).

- [ ] **Step 6: CHANGELOG and commit**

CHANGELOG under `## Unreleased`, new heading `### Project tree`: ``- **Filter Project Tree…** (filter button of the IECode view) narrows the tree to the objects whose name contains the typed words, optionally limited to kinds such as `@fb` or `@gvl`; folders with hits open by themselves. Methods and library sources are not searched yet.``

```bash
git add extension/src/views/tree.ts extension/src/extension.ts extension/package.json extension/CHANGELOG.md
git commit -s -m "Filter the project tree by name and kind" -m "The filter changes node ids while active so VS Code expands the folders with hits, and restores the normal ids afterwards so the user's own collapsed state comes back."
```

## Done when

`npm test` green, manual check done, `TODO.md` item "Project view: search and filter in the tree" ticked with a note that member names are not searched yet.
