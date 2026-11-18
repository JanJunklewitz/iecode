# Plan A: Expiry of auto-approved AI writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Part of the [small items master plan](2026-11-17-small-items-master-plan.md). Revised by the eng review of 2026-11-18 (R4, R10, R13, R14): the arming is stored as the time it happened, not as the time it ends.

**Goal:** `iecode.ads.aiWrites: "auto"` only auto-approves for a limited time after the user armed it; afterwards every AI write is confirmed again until the user re-arms.

**Architecture:** The arming is a user setting `iecode.ads.aiWritesArmedAt` (the time stamp of the arming, written by the command), so every window sees the same value and gets a configuration event; `globalState` is not shared live between windows (`mcpServer.ts:78`). The window is `[armedAt, armedAt + aiWritesAutoMinutes)`. All decisions live in a pure module `extension/src/core/writeArming.ts`; `aiSettings.ts`, `adsWrite.ts`, `lmTools.ts` and `adsWatch.ts` only read the settings and pass them in.

**Tech Stack:** TypeScript (`node --test`), VS Code settings API.

**Spec:** `TODO.md` item "ADS write allowlist and ARMED expiry" (the allowlist part is done as `iecode.ads.aiWritePaths`); prior art named there (SAFE / ARMED mode, armed expires after a fixed time).

## Global Constraints

- Public repository: no internal names in code, tests, docs or commits. Commits: English subject plus a 1-3 sentence why-body, GitHub noreply address as author and `Signed-off-by` (`git commit -s`).
- Decisions in `extension/src/core/` (node tests cannot load `vscode`); `src/ads/` and `src/views/` only wire.
- Fail closed: an unreadable, invalid or future arming time counts as not armed, which means "confirm", never "allow".
- `off` and `confirm` behave exactly as today (byte-identical texts); only `auto` changes.
- Tests: `cd extension && npm test`.

## Decisions (taken by the planner, 2026-11-17; revised by the eng review 2026-11-18)

1. **Fixed window, not sliding.** Auto-approve lasts `iecode.ads.aiWritesAutoMinutes` (integer, default 60, 1 to 1440) from the moment the user armed it. A write does not extend it. Reason: a sliding window never lapses during a busy agent session, which is exactly when it should.
2. **Expired means "confirm", not "off".** The agent keeps working; the user sees the dialog again. The extension never rewrites `aiWrites` on its own.
3. **Arming only through the command.** Choosing **Auto-approve** in **IECode: Set AI Write Access…** (also when it is already `auto`) writes `aiWrites = "auto"` and `aiWritesArmedAt = now` (ISO 8601, UTC) to the user settings. Choosing **Off** or **Confirm each write** writes `aiWritesArmedAt = ""` together with the new value, so a later hand edit back to `auto` is not armed. A hand edit of `aiWrites` to `auto` without a valid `aiWritesArmedAt` counts as not armed. Reason: writing settings from a configuration event would run in every open window at once; the command is one window.
4. **The arming time, not the end time, is stored** (eng review R13, found by the outside voice). The first draft stored `aiWritesAutoUntil` and rejected an end time more than `minutes` ahead. Lowering the minutes then made a running window "not armed" only until the remaining time fell below the new minutes, after which it turned **armed again by itself** with no event and no refresh of the view label. With `armedAt`, the window is `armedAt + minutes`: lowering the minutes shortens it for good, an expired window stays expired. Raising the minutes extends the current arming (a deliberate edit of the user's own settings, documented in the setting text). An `armedAt` in the future (hand-edited, or a clock turned back) counts as not armed, so editing the time stamp cannot create a permanent auto mode.
5. **No pop-up on expiry.** The ADS Watch view description shows the state and refreshes at each change of the minutes left and at the expiry (R10); the next write dialog says why it asks.
6. **Existing users:** after the update an `auto` setting without a time stamp is not armed; the CHANGELOG says so.
7. **The arming time does not travel with Settings Sync** (eng review R4). Application-scoped settings are synced; without `"ignoreSync": true` on `aiWritesArmedAt`, arming on one PC would auto-approve writes on every synced PC (another PLC) for the rest of the window. With it, every PC must be armed on its own. A manifest test pins the scopes and the flag.
8. **Rejected shape:** a marker file in the MCP discovery folder (the pattern of `mcpServer.ts` `connected()`) would avoid writing `settings.json`, but it exists only for local Windows windows (`eligible()`), and Copilot also runs in remote windows. The setting works everywhere and fires a configuration event in every window.

## Review Focus

1. A setting `aiWritesArmedAt` that is not a date (`"tomorrow"`, `42`): not armed, no exception. (Task 1, `autoState treats a bad time stamp as not armed`)
2. The window has passed: a write that starts at `armedAt + minutes` is confirmed. (Task 1, `autoState expires exactly at the end of the window`)
3. Armed when the gate decided, expired before the request is sent (MCP path) or before the Copilot invoke step: the gate refuses, it never writes unconfirmed. (Task 2, `writeGate.test.ts`: `an auto approval that lapses before the send is refused`)
4. The workspace redirects the target (`workspaceTarget() === true`) while armed: still "confirm", and the dialog note keeps the existing redirect text, not the expiry text. (Task 1, `autoNote prefers the redirect note`)
5. `aiWritesAutoMinutes` lowered while armed: the window shrinks at once and never comes back by itself. (Task 1, `a lowered minutes setting ends a window for good`)
6. An arming time in the future: not armed. (Task 1, `an arming time in the future is not armed`)
7. The AI write settings stay application-scoped and the arming time is not synced: a change to `window` scope would let a cloned repository arm auto-approve. (Task 2, `the AI write settings are application-scoped and the arming time is not synced`)
8. The view label turns to "expired" at the expiry, not up to a minute later. (Task 1, `nextRefreshMs`)

## File Structure

- Create `extension/src/core/writeArming.ts`: arming state, effective decision, texts.
- Modify `extension/src/ads/aiSettings.ts` (readers for the two new settings, `aiWriteState()`), `extension/src/ads/adsWrite.ts`, `extension/src/ads/lmTools.ts` (decision and note through `aiWriteState()`; the command writes or clears the time stamp), `extension/src/views/adsWatch.ts` (description text, refresh timer while armed), `extension/src/ads/claudeConnect.ts` (connected message names the state), `extension/package.json` (two settings), `extension/CHANGELOG.md`.
- Test: `extension/test/writeArming.test.ts` (new), `extension/test/writeGate.test.ts` (one case).

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
    | { kind: 'notArmed' }                                           // auto, but no valid arming time (missing, bad, in the future)
    | { kind: 'expired'; untilMs: number };
  export function autoState(o: { setting: string; armedAt: unknown; minutes: number; nowMs: number }): AutoState;
  /** The setting the write decision uses: 'auto' turns into 'confirm' unless armed. */
  export function effectiveSetting(setting: string, s: AutoState): string;
  /** Note appended to the confirmation text; the redirect note wins when the workspace redirects the target. */
  export function autoNote(s: AutoState, redirected: boolean): string;
  /** ADS Watch view description part, undefined for notAuto. */
  export function autoLabel(s: AutoState): string | undefined;
  export function armedAtNow(nowMs: number): string;                 // new Date(nowMs).toISOString()
  /** Delay of the next view refresh while armed: the next whole-minute change of the label or the expiry, whichever is first; undefined when not armed. */
  export function nextRefreshMs(s: AutoState): number | undefined;
  export const REDIRECT_NOTE: string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const M = 60_000, NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const st = (armedAt: unknown, minutes = 60, nowMs = NOW, setting = 'auto') => autoState({ setting, armedAt, minutes, nowMs });
test('clampAutoMinutes keeps 1..1440 integers and falls back to 60', () => {
  assert.equal(clampAutoMinutes(30), 30); assert.equal(clampAutoMinutes(0), 60); assert.equal(clampAutoMinutes(1441), 60);
  assert.equal(clampAutoMinutes(2.5), 60); assert.equal(clampAutoMinutes('30'), 60); assert.equal(clampAutoMinutes(undefined), 60);
});
test('autoState: off and confirm are notAuto', () => {
  assert.deepEqual(st(iso(NOW), 60, NOW, 'confirm'), { kind: 'notAuto' });
});
test('autoState: armed inside the window with the time left', () => {
  assert.deepEqual(st(iso(NOW - 18 * M)), { kind: 'armed', untilMs: NOW + 42 * M, leftMs: 42 * M });
});
test('autoState expires exactly at the end of the window', () => {
  assert.equal(st(iso(NOW - 60 * M)).kind, 'expired');
  assert.equal(st(iso(NOW - 60 * M + 1)).kind, 'armed');
});
test('autoState treats a bad time stamp as not armed', () => {
  for (const armedAt of [undefined, '', 'tomorrow', 42, null, {}]) assert.equal(st(armedAt).kind, 'notArmed');
});
test('an arming time in the future is not armed', () => {
  assert.equal(st(iso(NOW + 1)).kind, 'notArmed');
  assert.equal(st(iso(NOW)).kind, 'armed');
});
test('a lowered minutes setting ends a window for good', () => {
  // armed 10 min ago for 60 min, lowered to 5: expired now and at every later time (the first draft re-armed itself here)
  const armedAt = iso(NOW - 10 * M);
  for (const later of [0, 20 * M, 40 * M, 49 * M]) assert.equal(st(armedAt, 5, NOW + later).kind, 'expired');
});
test('a raised minutes setting extends the current arming', () => {
  assert.equal(st(iso(NOW - 70 * M), 90).kind, 'armed');
});
test('effectiveSetting turns auto into confirm unless armed', () => {
  assert.equal(effectiveSetting('auto', { kind: 'armed', untilMs: 1, leftMs: 1 }), 'auto');
  assert.equal(effectiveSetting('auto', { kind: 'expired', untilMs: 1 }), 'confirm');
  assert.equal(effectiveSetting('auto', { kind: 'notArmed' }), 'confirm');
  assert.equal(effectiveSetting('off', { kind: 'notAuto' }), 'off');
  assert.equal(effectiveSetting('confirm', { kind: 'notAuto' }), 'confirm');
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
  assert.equal(REDIRECT_NOTE, ' (the workspace settings set the ADS target or port, so auto-approve does not apply)');
  assert.equal(autoNote({ kind: 'expired', untilMs: NOW }, true), REDIRECT_NOTE);
  assert.equal(autoNote({ kind: 'armed', untilMs: NOW, leftMs: 1 }, true), REDIRECT_NOTE);
});
test('autoLabel for the watch view', () => {
  assert.equal(autoLabel({ kind: 'armed', untilMs: 0, leftMs: 42 * M + 1 }), 'AI writes: auto (43 min left)');
  assert.equal(autoLabel({ kind: 'armed', untilMs: 0, leftMs: 10_000 }), 'AI writes: auto (1 min left)');
  assert.equal(autoLabel({ kind: 'expired', untilMs: 0 }), 'AI writes: auto expired, confirming');
  assert.equal(autoLabel({ kind: 'notArmed' }), 'AI writes: auto not armed, confirming');
  assert.equal(autoLabel({ kind: 'notAuto' }), undefined);
});
test('armedAtNow is an ISO time stamp', () => {
  assert.equal(armedAtNow(NOW), iso(NOW));
});
test('nextRefreshMs', () => {
  // label "43 min left" changes to "42 min left" when leftMs drops to 42 min: 1 ms from now
  assert.equal(nextRefreshMs({ kind: 'armed', untilMs: 0, leftMs: 42 * M + 1 }), 1);
  assert.equal(nextRefreshMs({ kind: 'armed', untilMs: 0, leftMs: 42 * M }), M);
  // the last minute: refresh at the expiry itself
  assert.equal(nextRefreshMs({ kind: 'armed', untilMs: 0, leftMs: 10_000 }), 10_000);
  assert.equal(nextRefreshMs({ kind: 'expired', untilMs: 0 }), undefined);
  assert.equal(nextRefreshMs({ kind: 'notArmed' }), undefined);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd extension && npm test`
Expected: compile error `Cannot find module '../src/core/writeArming'`.

- [ ] **Step 3: Implement `writeArming.ts`**

`autoState`: `setting !== 'auto'` -> notAuto; `armedAt` must be a string that `Date.parse` accepts, else notArmed; `armedMs > nowMs` -> notArmed; `untilMs = armedMs + minutes * 60000`; `untilMs <= nowMs` -> expired; else armed with `leftMs = untilMs - nowMs`. `autoLabel` rounds minutes up (`Math.ceil(leftMs / 60000)`). `nextRefreshMs`: `leftMs % 60000 || 60000` while armed. The redirect note string moves here from `adsWrite.ts:28` and `lmTools.ts:162` (`REDIRECT_NOTE`, exported; both call sites use it in Task 2).

- [ ] **Step 4: Run to verify they pass**

Run: `cd extension && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/src/core/writeArming.ts extension/test/writeArming.test.ts
git commit -s -m "Add the arming state for auto-approved AI writes" -m "Auto-approve stayed on until the user switched it off by hand. The window runs from the stored arming time, so a lowered duration ends it for good; storing the end time instead let a shortened window turn armed again by itself."
```

---

### Task 2: Wire the settings, the gate, Copilot, the command and the view

**Files:**
- Modify: `extension/package.json`, `extension/src/ads/aiSettings.ts`, `extension/src/ads/adsWrite.ts:20-28`, `extension/src/ads/lmTools.ts:157-163,205-215`, `extension/src/views/adsWatch.ts:100-118`, `extension/src/ads/claudeConnect.ts:135`, `extension/CHANGELOG.md`
- Test: `extension/test/writeGate.test.ts` (one case), `extension/test/writeArming.test.ts` (manifest case)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces in `aiSettings.ts`:
  ```ts
  export function aiWriteState(nowMs = Date.now()): { setting: string; auto: AutoState; effective: string; redirected: boolean };
  /** The command's write: aiWrites and aiWritesArmedAt together (Global); armedAt is armedAtNow() for 'auto', '' otherwise. */
  export async function setAiWrites(value: 'off' | 'confirm' | 'auto', nowMs = Date.now()): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

`writeGate.test.ts`, next to `gate refuses when the access got stricter after the user confirmed` (line 356) and with the same fake clock and deps: `an auto approval that lapses before the send is refused`: `decision` returns `'allow'` on its first call and `'confirm'` afterwards (the window ended between the decision and `beforeSend`); an MCP write is refused with the text that names the confirmation, and `send` is never called. A second case for `via: 'Copilot'` with `op.prepared = { decision: 'allow' }` and `decision()` returning `'confirm'`: refused with the "settings changed after this write was prepared" text. (The pure `writeStillApproved('allow', 'confirm') === false` is already pinned at `adswatch.test.ts:336`; these cases prove that the gate asks again at the right points.)

`writeArming.test.ts`:

```ts
test('the AI write settings are application-scoped and the arming time is not synced', () => {
  const props = /* the manifest's configuration properties, read the way mcpTools.test.ts reads package.json; contributes.configuration may be an array of sections */;
  for (const k of ['iecode.ads.aiWrites', 'iecode.ads.aiWritePaths', 'iecode.ads.aiWritesAutoMinutes', 'iecode.ads.aiWritesArmedAt']) assert.equal(props[k].scope, 'application', k);
  assert.equal(props['iecode.ads.aiWritesArmedAt'].ignoreSync, true);
});
```

Run `cd extension && npm test`: the gate cases may already pass (they pin existing behaviour against the new wiring); the manifest case fails until Step 2.

- [ ] **Step 2: Settings in `package.json`**

`iecode.ads.aiWritesAutoMinutes`: integer, default 60, minimum 1, maximum 1440, `scope: application`, `markdownDescription`: `How long **Auto-approve** of \`iecode.ads.aiWrites\` lasts after you arm it with **IECode: Set AI Write Access…**. Afterwards every AI write is confirmed again until you arm it again. Changing it changes the current arming too: a lower value can end it at once, a higher one extends it.`
`iecode.ads.aiWritesArmedAt`: string, default `""`, `scope: application`, `ignoreSync: true` (Decision 7), `markdownDescription`: `Set by **IECode: Set AI Write Access…**: when you last chose Auto-approve (cleared when you choose Off or Confirm). Not meant to be edited; a time in the future is ignored. Not synced with Settings Sync, so each PC is armed on its own.` Add to the `aiWrites` `auto` enum description: `Lasts iecode.ads.aiWritesAutoMinutes (default 60) from arming, then each write is confirmed again.`

- [ ] **Step 3: Wire**

- `aiSettings.ts`: read both settings with `inspect(...).globalValue` (same rule as `aiWritesSetting`), compute `autoState`, `effectiveSetting`, `workspaceTarget()`.
- `adsWrite.ts`: `decision: () => { const w = aiWriteState(); return aiWriteDecision(w.effective, w.redirected); }`; the dialog note is `autoNote(w.auto, w.redirected)`.
- `lmTools.ts` prepare step: same two replacements. Command `iecode.adsAiWrites`: every pick calls `setAiWrites(pick.value)` (arms on `auto`, clears on the others, Decision 3); the `auto` pick's `detail` gains `Lasts ${minutes} min, then each write is confirmed again.`; when armed its `description` is `(current, ${n} min left)`.
- `adsWatch.ts`: the description uses `autoLabel(aiWriteState().auto)` instead of the fixed `'AI writes: auto'`; refresh on changes of `aiWrites`, `aiWritesArmedAt`, `aiWritesAutoMinutes`, and while the state is `armed` with a one-shot `setTimeout(nextRefreshMs(state))` that is re-scheduled after each refresh (cleared on every refresh and on dispose), so the label turns to "expired" at the expiry and not up to a minute later.
- `claudeConnect.ts:135`: `AI writes are currently "${w.setting}"` becomes `"${autoLabel(w.auto) ?? w.setting}"` without the prefix duplication (use the label text after `AI writes: ` when defined).
- CHANGELOG under `## Unreleased` / `### Claude Code and ADS`: ``- Auto-approved AI writes now end after `iecode.ads.aiWritesAutoMinutes` (default 60) from the moment you choose Auto-approve in **IECode: Set AI Write Access…**; afterwards every AI write is confirmed again. An `auto` setting from an earlier version is not armed until you choose it again, and the arming is not synced to other PCs. The ADS Watch view shows the minutes left.``

- [ ] **Step 4: Run the tests**

Run: `cd extension && npm test`
Expected: compiles, all pass.

- [ ] **Step 5: Manual check (F5, about 10 min)**

Set `aiWritesAutoMinutes` to 1, arm with the command, watch the view say `auto (1 min left)`, write through Copilot or Claude Code without a dialog, wait 60 s: the label says `expired` at once; write again: the dialog shows with the expiry note. Arm with 60, set the minutes to 1: `expired`; wait two minutes: still `expired`. Choose Confirm, then edit `aiWrites` back to `auto` by hand: `not armed`. Edit `aiWritesArmedAt` to a date one day ahead: `not armed`.

- [ ] **Step 6: Commit**

```bash
git add extension/package.json extension/src/ads/aiSettings.ts extension/src/ads/adsWrite.ts extension/src/ads/lmTools.ts extension/src/views/adsWatch.ts extension/src/ads/claudeConnect.ts extension/CHANGELOG.md extension/test/writeGate.test.ts extension/test/writeArming.test.ts
git commit -s -m "Let auto-approved AI writes lapse" -m "The arming time is a user setting so every window sees it; globalState is not shared live between windows, and Settings Sync skips it so another PC is never armed. Expired auto falls back to confirm instead of off, so the agent keeps working and the user is asked again."
```

## Done when

`npm test` green, manual check done, TODO item "ADS write allowlist and ARMED expiry" ticked, wishlist section 8 gets a row "Expiry of auto-approve" set to Done with the test file name.
