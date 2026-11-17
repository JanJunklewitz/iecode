# Plan A: Expiry of auto-approved AI writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [small items master plan](2026-11-17-small-items-master-plan.md).

**Goal:** `iecode.ads.aiWrites: "auto"` only auto-approves for a limited time after the user armed it; afterwards every AI write is confirmed again until the user re-arms.

**Architecture:** The arming is a user setting `iecode.ads.aiWritesAutoUntil` (a time stamp the command writes), so every window sees the same value and gets a configuration event; `globalState` is not shared live between windows (`mcpServer.ts:78`). All decisions live in a pure module `extension/src/core/writeArming.ts`; `aiSettings.ts`, `adsWrite.ts`, `lmTools.ts` and `adsWatch.ts` only read the settings and pass them in.

**Tech Stack:** TypeScript (`node --test`), VS Code settings API.

**Spec:** `TODO.md` item "ADS write allowlist and ARMED expiry" (the allowlist part is done as `iecode.ads.aiWritePaths`); prior art named there (SAFE / ARMED mode, armed expires after a fixed time).

## Global Constraints

- Public repository: no internal names in code, tests, docs or commits. Commits: English subject plus a 1-3 sentence why-body, GitHub noreply address as author and `Signed-off-by` (`git commit -s`).
- Decisions in `extension/src/core/` (node tests cannot load `vscode`); `src/ads/` and `src/views/` only wire.
- Fail closed: an unreadable, invalid or too-far-future arming time counts as not armed, which means "confirm", never "allow".
- `off` and `confirm` behave exactly as today (byte-identical texts); only `auto` changes.
- Tests: `cd extension && npm test`.

## Decisions (taken by the planner, 2026-11-17)

1. **Fixed window, not sliding.** Auto-approve lasts `iecode.ads.aiWritesAutoMinutes` (integer, default 60, 1 to 1440) from the moment the user armed it. A write does not extend it. Reason: a sliding window never lapses during a busy agent session, which is exactly when it should.
2. **Expired means "confirm", not "off".** The agent keeps working; the user sees the dialog again. The setting `aiWrites` itself is never rewritten by the extension.
3. **Arming only through the command.** Choosing **Auto-approve** in **IECode: Set AI Write Access…** (also when it is already `auto`) writes `aiWrites = "auto"` and `aiWritesAutoUntil = now + minutes` (ISO 8601, UTC) to the user settings. A hand edit of `aiWrites` to `auto` without a valid `aiWritesAutoUntil` counts as not armed. Reason: writing settings from a configuration event would run in every open window at once.
4. **A time too far ahead is invalid.** `aiWritesAutoUntil` more than `minutes` in the future (hand-edited) counts as not armed, so editing the time stamp cannot create a permanent auto mode.
5. **No pop-up on expiry.** The ADS Watch view description shows the state and refreshes once a minute; the next write dialog says why it asks.
6. **Existing users:** after the update an `auto` setting without a time stamp is not armed; the CHANGELOG says so.

## Review Focus

1. A setting `aiWritesAutoUntil` that is not a date (`"tomorrow"`, `42`): not armed, no exception. (Task 1, `autoState treats a bad time stamp as not armed`)
2. The clock of the arming window is passed: the write that starts one millisecond after `until` is confirmed. (Task 1, `autoState expires exactly at until`)
3. Copilot prepare step armed, invoke step expired (the time passed in between): the gate refuses with the existing "settings got stricter" path, it never writes unconfirmed. (Task 2, covered by `writeStillApproved` with `prepared: 'allow'`, `now: 'confirm'`; add the case to `adswatch.test.ts`)
4. The workspace redirects the target (`workspaceTarget() === true`) while armed: still "confirm", and the dialog note keeps the existing redirect text, not the expiry text. (Task 1, `autoNote prefers the redirect note`)
5. `aiWritesAutoMinutes` lowered while armed: the window shrinks at once (the far-future rule applies). (Task 1, `a lowered minutes setting shortens a running window`)

## File Structure

- Create `extension/src/core/writeArming.ts`: arming state, effective decision, texts.
- Modify `extension/src/ads/aiSettings.ts` (readers for the two new settings, `aiWriteState()`), `extension/src/ads/adsWrite.ts`, `extension/src/ads/lmTools.ts` (decision and note through `aiWriteState()`; the command writes the time stamp), `extension/src/views/adsWatch.ts` (description text, one-minute refresh while armed), `extension/src/ads/claudeConnect.ts` (connected message names the state), `extension/package.json` (two settings), `extension/CHANGELOG.md`.
- Test: `extension/test/writeArming.test.ts` (new), `extension/test/adswatch.test.ts` (one case).

---

### Task 1: Pure arming logic

**Files:**
- Create: `extension/src/core/writeArming.ts`
- Test: `extension/test/writeArming.test.ts`

**Interfaces:**
- Consumes: `aiWriteDecision(setting, workspaceTarget)` from `core/adswatch.ts` (unchanged).
- Produces:
  ```ts
  export const AUTO_MINUTES_DEFAULT = 60;
  export function clampAutoMinutes(raw: unknown): number;            // integer 1..1440, anything else -> 60
  export type AutoState =
    | { kind: 'notAuto' }                                            // setting is off or confirm
    | { kind: 'armed'; untilMs: number; leftMs: number }
    | { kind: 'notArmed' }                                           // auto, but no valid time stamp (missing, bad, too far ahead)
    | { kind: 'expired'; untilMs: number };
  export function autoState(o: { setting: string; until: unknown; minutes: number; nowMs: number }): AutoState;
  /** The setting the write decision uses: 'auto' turns into 'confirm' unless armed. */
  export function effectiveSetting(setting: string, s: AutoState): string;
  /** Note appended to the confirmation text; the redirect note wins when the workspace redirects the target. */
  export function autoNote(s: AutoState, redirected: boolean): string;
  /** ADS Watch view description part, undefined for notAuto. */
  export function autoLabel(s: AutoState): string | undefined;
  export function armUntil(nowMs: number, minutes: number): string;  // new Date(now + minutes*60000).toISOString()
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const M = 60_000, NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
test('clampAutoMinutes keeps 1..1440 integers and falls back to 60', () => {
  assert.equal(clampAutoMinutes(30), 30); assert.equal(clampAutoMinutes(0), 60); assert.equal(clampAutoMinutes(1441), 60);
  assert.equal(clampAutoMinutes(2.5), 60); assert.equal(clampAutoMinutes('30'), 60);
});
test('autoState: off and confirm are notAuto', () => {
  assert.deepEqual(autoState({ setting: 'confirm', until: iso(NOW + M), minutes: 60, nowMs: NOW }), { kind: 'notAuto' });
});
test('autoState: armed inside the window with the time left', () => {
  assert.deepEqual(autoState({ setting: 'auto', until: iso(NOW + 42 * M), minutes: 60, nowMs: NOW }), { kind: 'armed', untilMs: NOW + 42 * M, leftMs: 42 * M });
});
test('autoState expires exactly at until', () => {
  assert.equal(autoState({ setting: 'auto', until: iso(NOW), minutes: 60, nowMs: NOW }).kind, 'expired');
  assert.equal(autoState({ setting: 'auto', until: iso(NOW + 1), minutes: 60, nowMs: NOW }).kind, 'armed');
});
test('autoState treats a bad time stamp as not armed', () => {
  for (const until of [undefined, '', 'tomorrow', 42, null, {}]) assert.equal(autoState({ setting: 'auto', until, minutes: 60, nowMs: NOW }).kind, 'notArmed');
});
test('a time stamp further ahead than the minutes setting is not armed', () => {
  assert.equal(autoState({ setting: 'auto', until: iso(NOW + 61 * M), minutes: 60, nowMs: NOW }).kind, 'notArmed');
});
test('a lowered minutes setting shortens a running window', () => {
  assert.equal(autoState({ setting: 'auto', until: iso(NOW + 50 * M), minutes: 30, nowMs: NOW }).kind, 'notArmed');
});
test('effectiveSetting turns auto into confirm unless armed', () => {
  assert.equal(effectiveSetting('auto', { kind: 'armed', untilMs: 1, leftMs: 1 }), 'auto');
  assert.equal(effectiveSetting('auto', { kind: 'expired', untilMs: 1 }), 'confirm');
  assert.equal(effectiveSetting('auto', { kind: 'notArmed' }), 'confirm');
  assert.equal(effectiveSetting('off', { kind: 'notAuto' }), 'off');
});
test('autoNote texts', () => {
  assert.equal(autoNote({ kind: 'expired', untilMs: NOW }, false),
    ' (auto-approve expired; re-arm it with "IECode: Set AI Write Access…")');
  assert.equal(autoNote({ kind: 'notArmed' }, false),
    ' (auto-approve is not armed; arm it with "IECode: Set AI Write Access…")');
  assert.equal(autoNote({ kind: 'armed', untilMs: NOW, leftMs: 1 }, false), '');
  assert.equal(autoNote({ kind: 'notAuto' }, false), '');
});
test('autoNote prefers the redirect note', () => {
  assert.equal(autoNote({ kind: 'expired', untilMs: NOW }, true),
    ' (the workspace settings set the ADS target or port, so auto-approve does not apply)');
  assert.equal(autoNote({ kind: 'armed', untilMs: NOW, leftMs: 1 }, true),
    ' (the workspace settings set the ADS target or port, so auto-approve does not apply)');
});
test('autoLabel for the watch view', () => {
  assert.equal(autoLabel({ kind: 'armed', untilMs: 0, leftMs: 42 * M + 1 }), 'AI writes: auto (43 min left)');
  assert.equal(autoLabel({ kind: 'armed', untilMs: 0, leftMs: 10_000 }), 'AI writes: auto (1 min left)');
  assert.equal(autoLabel({ kind: 'expired', untilMs: 0 }), 'AI writes: auto expired, confirming');
  assert.equal(autoLabel({ kind: 'notArmed' }), 'AI writes: auto not armed, confirming');
  assert.equal(autoLabel({ kind: 'notAuto' }), undefined);
});
test('armUntil is an ISO time stamp minutes ahead', () => {
  assert.equal(armUntil(NOW, 60), iso(NOW + 60 * M));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd extension && npm test`
Expected: compile error `Cannot find module '../src/core/writeArming'`.

- [ ] **Step 3: Implement `writeArming.ts`**

`autoState`: `setting !== 'auto'` -> notAuto; `until` must be a string that `Date.parse` accepts, else notArmed; `untilMs - nowMs > minutes * 60000` -> notArmed; `untilMs <= nowMs` -> expired; else armed. `autoLabel` rounds minutes up (`Math.ceil(leftMs / 60000)`). The redirect note string is moved here from `adsWrite.ts:28` and `lmTools.ts:162` (one constant `REDIRECT_NOTE`, exported).

- [ ] **Step 4: Run to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/writeArming.ts extension/test/writeArming.test.ts
git commit -s -m "Add the arming state for auto-approved AI writes" -m "Auto-approve stayed on until the user switched it off by hand. A fixed window from the moment of arming lapses even during a busy session; a sliding window was rejected because it never lapses while the agent keeps writing."
```

---

### Task 2: Wire the settings, the gate, Copilot, the command and the view

**Files:**
- Modify: `extension/package.json`, `extension/src/ads/aiSettings.ts`, `extension/src/ads/adsWrite.ts:20-28`, `extension/src/ads/lmTools.ts:157-163,205-215`, `extension/src/views/adsWatch.ts:100-118`, `extension/src/ads/claudeConnect.ts:135`, `extension/CHANGELOG.md`
- Test: `extension/test/adswatch.test.ts` (one case)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces in `aiSettings.ts`:
  ```ts
  export function aiWriteState(nowMs = Date.now()): { setting: string; auto: AutoState; effective: string; redirected: boolean };
  export async function armAutoWrites(nowMs = Date.now()): Promise<void>;   // writes aiWrites and aiWritesAutoUntil (Global)
  ```

- [ ] **Step 1: Add the pinned stricter-settings case**

In `adswatch.test.ts`, extend the `writeStillApproved` test: `assert.equal(writeStillApproved('allow', 'confirm'), false)` with the comment "armed at prepare, expired at invoke".

- [ ] **Step 2: Settings in `package.json`**

`iecode.ads.aiWritesAutoMinutes`: integer, default 60, minimum 1, maximum 1440, `scope: application`, `markdownDescription`: `How long **Auto-approve** of \`iecode.ads.aiWrites\` lasts after you arm it with **IECode: Set AI Write Access…**. Afterwards every AI write is confirmed again until you arm it again.`
`iecode.ads.aiWritesAutoUntil`: string, default `""`, `scope: application`, `markdownDescription`: `Set by **IECode: Set AI Write Access…** when you choose Auto-approve: the time auto-approve ends. Not meant to be edited; a time further ahead than \`iecode.ads.aiWritesAutoMinutes\` is ignored.` Add to the `aiWrites` `auto` enum description: `Lasts iecode.ads.aiWritesAutoMinutes (default 60) from arming, then each write is confirmed again.`

- [ ] **Step 3: Wire**

- `aiSettings.ts`: read both settings with `inspect(...).globalValue` (same rule as `aiWritesSetting`), compute `autoState`, `effectiveSetting`, `workspaceTarget()`.
- `adsWrite.ts`: `decision: () => { const w = aiWriteState(); return aiWriteDecision(w.effective, w.redirected); }`; the dialog note is `autoNote(w.auto, w.redirected)`.
- `lmTools.ts` prepare step: same two replacements. Command `iecode.adsAiWrites`: picking `auto` calls `armAutoWrites()`; the `auto` pick's `detail` gains `Lasts ${minutes} min, then each write is confirmed again.`; when armed its `description` is `(current, ${n} min left)`.
- `adsWatch.ts`: the description uses `autoLabel(aiWriteState().auto)` instead of the fixed `'AI writes: auto'`; refresh on changes of `aiWrites`, `aiWritesAutoUntil`, `aiWritesAutoMinutes`, and with a 60 s `setInterval` only while the state is `armed` (cleared on dispose).
- `claudeConnect.ts:135`: `AI writes are currently "${w.setting}"` becomes `"${autoLabel(w.auto) ?? w.setting}"` without the prefix duplication (use the label text after `AI writes: ` when defined).
- CHANGELOG under `## Unreleased` / `### Claude Code and ADS`: ``- Auto-approved AI writes now end after `iecode.ads.aiWritesAutoMinutes` (default 60) from the moment you choose Auto-approve in **IECode: Set AI Write Access…**; afterwards every AI write is confirmed again. An `auto` setting from an earlier version is not armed until you choose it again. The ADS Watch view shows the minutes left.``

- [ ] **Step 4: Run the tests**

Run: `cd extension && npm test`
Expected: compiles, all pass.

- [ ] **Step 5: Manual check (F5, about 10 min)**

Set `aiWritesAutoMinutes` to 1, arm with the command, watch the view say `auto (1 min left)`, write through Copilot or Claude Code without a dialog, wait 60 s, write again: the dialog shows with the expiry note. Edit `aiWritesAutoUntil` to a date one day ahead: the view says `not armed`.

- [ ] **Step 6: Commit**

```bash
git add extension/package.json extension/src/ads/aiSettings.ts extension/src/ads/adsWrite.ts extension/src/ads/lmTools.ts extension/src/views/adsWatch.ts extension/src/ads/claudeConnect.ts extension/CHANGELOG.md extension/test/adswatch.test.ts
git commit -s -m "Let auto-approved AI writes lapse" -m "The arming time is a user setting so every window sees it; globalState is not shared live between windows. Expired auto falls back to confirm instead of off, so the agent keeps working and the user is asked again."
```

## Done when

`npm test` green, manual check done, TODO item "ADS write allowlist and ARMED expiry" ticked, wishlist section 8 gets a row "Expiry of auto-approve" set to Done with the test file name.
