# Master Plan (as of 2026-10-30)

Overview of the open implementation plans: what each one delivers, where its code lives, its status, and the order to work on them. Each plan carries its own tasks, tests and review focus; this file only coordinates.

## Plans

| # | Plan | Goal | Code branch | Status |
|---|---|---|---|---|
| 1 | [TcPOU merge conflict resolution](2026-10-30-tcpou-merge-conflicts.md) | Resolve git merge conflicts in `.TcPOU/.TcDUT/.TcGVL/.TcIO` without touching XML: auto-resolve outside the ST code, the rest in the ST view with Accept Current / Incoming / Both. | `feature/merge-conflicts-and-xti-diff` | In progress: ST-view tolerance and CodeLens are committed (`752ff68`, `d486595`, merged from `fix/merge-conflicts-in-st-view`; tests green on top of 0.2.4). Task 0 (root launch config, conflict repo script) is open. Task 1 Step 1 (remove `offerLineIdsCleanup`) is open. Tasks 2-5 are open. |
| 2 | [XTI config diff](2026-10-30-xti-config-diff.md) | Categorised, filterable diff of `.xti` files (PLC instance first), as a panel, a YAML diff and the CLI `config-diff`. | `feature/merge-conflicts-and-xti-diff` | Planned. Research done: [docs/research/xti-diff](../../research/xti-diff/README.md). |

Backlog without a plan yet: see [TODO.md](../../../TODO.md) (AI interface for ADS variable access, SYS folder detection).

## Order and dependencies

0. **Sync with `main` first.** The branch is based on 0.2.4 (`3dd2f0b`); `origin/main` has moved since (#12, `66f0907`, which also edits `extension.ts`, `package.json`, `cli.ts` and the changelog). Commit the plan edits first so the merge starts from a clean tree. `git fetch origin` before each merge; merge `origin/main` into the branch before Plan 1 Task 0, and again before Plan 2 Task 1, then run `npm test`. After the first merge, dry-run `CODE="$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" sh scripts/e2e.sh` in `extension/` once, so a Windows problem with the e2e script shows up before plan 1 depends on it.
1. **Plan 1 first.** It is already started; its earlier work is on this branch.
2. **Plan 2 second**, on the same branch. It shares no code with plan 1; both touch `extension/src/extension.ts`, `extension/package.json` (commands, menus) and `extension/CHANGELOG.md`, which is why they run one after the other on one branch instead of in parallel.
3. **One PR** for docs, plan 1 and plan 2 from `feature/merge-conflicts-and-xti-diff`. A later split is not planned: the interfaces are independent, but both plans edit `extension.ts`, `package.json` and the changelog, so plan 2 does not cherry-pick onto `main` without plan 1.

## Before the PR

Run on the final branch state, after plan 2 Task 5:

1. `git fetch origin`, then merge `origin/main` once more if it moved since the merge before plan 2 (no empty merge commit otherwise).
2. `npm test` in `extension/`.
3. `CODE="$LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" sh scripts/e2e.sh` in `extension/` (the script's default `CODE` is the macOS path).
4. Manual checks, again on this state: plan 1 Task 5 Step 3 (auto-resolve flow from Source Control) and plan 2 Task 4 Step 5 (Config Changes panel, persisted filter, Open as YAML).
5. Move everything from `## Plan review (plan-eng-review, 2026-10-30)` to the end of this file into `internal/` (git-ignored). This repo is public; the review notes are process material and contain local paths.

## Corrections to the plans

Already written into the sub-plans; listed here for reference.

- **Plan 1, Task 5 Step 4 and plan 2, Task 5:** do not bump `version` in `extension/package.json` and do not add a version section. Add the bullets under `## Unreleased` at the top of `extension/CHANGELOG.md` (the flow `main` uses since #12; the maintainer bumps at release). Plan 1 uses `### Editor`, plan 2 `### System project`; append to an existing heading of that name. The changelog lives in `extension/`, there is no root `CHANGELOG.md`.
- **Plan 1, Task 1:** the ST-view tolerance is already committed (`752ff68`, `d486595`). Only Step 1 is left; Step 2 expects 0 fail (83 pass, 1 skipped was measured at `207d381`, before the `main` merge; #12 adds test files); Step 3 commits only the removal of `offerLineIdsCleanup`.

## Rules for both plans

- This repo is public. No company-internal content (project names, commit messages, customer data) in code, fixtures, docs or commit messages. Internal notes go into the git-ignored `internal/` folder.
- `npm test` (in `extension/`) stays green after every task. Run tests through the PowerShell tool.
- Commits: subject + 1-3 sentence body on *why*; no attribution trailers. Every commit is signed off (`git commit -s`): the PR check in `.github/workflows/ci.yml` rejects commits without `Signed-off-by`.

## Where things live

- Plans: `docs/superpowers/plans/`
- Research: `docs/research/`
- Open items: `TODO.md`
- Work branch for both plans: `feature/merge-conflicts-and-xti-diff`.

## Plan review (plan-eng-review, 2026-10-30)

Target: `docs/superpowers/plans/2026-10-30-master-plan.md` (fixed). Evidence: repo at `207d381`, `origin/main` at `66f0907`, `npm test` run in `extension/` (84 tests: 83 pass, 1 skipped).

### Scope Challenge

Complexity: the master plan itself proposes no code files; it coordinates plan 1 (~10 files) and plan 2 (~9 files), which carry their own tasks. Below the 8-file / 2-class gate for this document; scope accepted as-is.

Findings:
1. [CRITICAL] (confidence: 9/10) master-plan.md:16 "its earlier work is merged onto the current `main` (0.2.4)". `origin/main` moved to `66f0907` (#12): 34 files, including `extension/src/extension.ts` (+24), `extension/package.json` (+122), `extension/src/cli.ts`, `extension/CHANGELOG.md`. All four are files both plans modify. `git merge-tree --write-tree HEAD origin/main` is clean today.
2. [CRITICAL] (confidence: 9/10) master-plan.md:22 "Use the next free version at execution time instead (as plan 2 does)". `origin/main:extension/CHANGELOG.md` now starts with `## Unreleased` and keeps `"version": "0.2.4"`; the changelog header says "Odd minor versions (0.1.x, 0.3.x …) are pre-releases". Plan 1 Task 5 Step 4 and plan 2 Task 5 both bump `version`; on one branch that is two bumps (0.2.5, 0.2.6) and a conflict with the upstream release flow.
3. [INFORMATIONAL] (confidence: 9/10) master-plan.md:17 and tcpou-merge-conflicts.md:149 say `CHANGELOG.md`; the file is `extension/CHANGELOG.md` (no root changelog). Factual correction, no question.
4. [INFORMATIONAL] (confidence: 9/10) tcpou-merge-conflicts.md:50-54: Task 1 says "already modified, uncommitted" and "currently 80 pass, 1 skipped"; the work is committed (`752ff68`, `d486595`) and the suite is 83 pass, 1 skipped. Only Step 1 (remove `offerLineIdsCleanup`, still at `extension/src/extension.ts:152,156,213`) is left; Steps 2-3 become "run tests, commit the removal". Factual correction, no question.
5. [INFORMATIONAL] (confidence: 8/10) master-plan.md:18 "Both plans can be split into separate PRs later ... since they do not depend on each other's interfaces". Interfaces are independent, but both plans edit `extension.ts`, `package.json` and the changelog, so cherry-picking plan 2 onto `main` without plan 1 conflicts in those files. The honest split is stacked (cut at the last plan-1 commit).
6. [INFORMATIONAL] (confidence: 7/10) master-plan.md:9 / tcpou-merge-conflicts.md:52: removing `offerLineIdsCleanup` in Task 1 leaves Tasks 1-3 without any LineIds-conflict help until the auto-resolve of Task 4 replaces it.

REALITY: premise-table finding 9 claims, 6 true, 2 false (main state line 16, `CHANGELOG.md` path line 17), unverified=1 (source branch name `fix/merge-conflicts-in-st-view`, line 9) master-plan.md:9-18
REALITY: already-done pass no plan-1/plan-2 symbol (`autoResolve`, `conflictedFiles`, `configDiff`) on origin/main; main moved (finding 1) master-plan.md:16
REALITY: surface-check pass `npm test` exists (extension/package.json:898) and runs green master-plan.md:27
REALITY: binding-decisions pass no logged branch decisions, no Binding decisions section master-plan.md:20
REALITY: numbers finding plan 1 "80 pass, 1 skipped" re-measured as 83 pass, 1 skipped [measured: npm test at 207d381] tcpou-merge-conflicts.md:53
REALITY: deferred-asks pass no linked issue master-plan.md:12
REALITY: pr-count finding one branch, "split into separate PRs later" without a stated cut (finding 5) master-plan.md:18

## Decision ledger

### R1: Bring origin/main into the branch before implementation
Finding: 1, CRITICAL, 9/10, master-plan.md:16, reviewer claude
Plan baseline: master-plan.md:16 assumes the branch sits on current `main` (0.2.4); no step to update it.
Runtime evidence: `git log HEAD..origin/main` = `66f0907` (#12); `git merge-tree` clean at `207d381`.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R1 when to take main | never stated | merge now, before Plan 1 Task 0, and again before Plan 2 Task 1 | merge once, before opening the PR | do nothing |
| R2 version/changelog | pending | pending | pending | pending |
| R3 PR shape | pending | pending | pending | pending |
| R4 offerLineIdsCleanup timing | pending | pending | pending | pending |
Question D2 (asked in German in chat; English record per repo language rule):
D2 — When do we bring origin/main (#12) into the branch?
Project/branch/task: master plan on feature/merge-conflicts-and-xti-diff; origin/main moved by #12 (66f0907) since the plan was written.
ELI10: The plan says the branch sits on current main. That is no longer true: #12 changed 34 files, including extension.ts, package.json, cli.ts and the changelog, which both plans also change. Today the merge is clean; every further task makes the later merge harder.
Stakes if we pick wrong: merging only at the end means conflicts in package.json/extension.ts after 10 tasks, and the tests never ran against the real main.
Recommendation: A because the merge is clean today and every task is then tested against the real main.
Completeness: A=10/10, B=6/10, C=3/10
Pros / cons:
A) Merge now and before plan 2 (recommended)
  ✅ Clean today (git merge-tree has no conflicts), about 2 min (human: ~10 min / CC: ~2 min)
  ✅ Every task tests against the real main, including the #12 commands and settings
  ❌ A second merge commit before plan 2; slightly busier history
B) Merge once before the PR
  ✅ Only one merge commit; history stays linear on 0.2.4 until the end
  ✅ No extra work during the implementation
  ❌ Conflicts in package.json/extension.ts/cli.ts pile up at the end
C) Do nothing
  ✅ No work and no change to the plan text needed
  ✅ The plan stays exactly as written
  ❌ Line 16 stays wrong; the PR against main has unchecked conflicts
Net: a 2-minute merge now against piled-up conflicts after 10 tasks.
Header: main sync
Options:
A) Merge now and before plan 2 (recommended)
Add a step "merge origin/main" before Plan 1 Task 0 and before Plan 2 Task 1; fix line 16. Clean merge today, ~2 min.
B) Merge once before the PR
Add one step "merge origin/main" before opening the PR; fix line 16. Conflicts handled once at the end.
C) Do nothing
Leave the plan as is; line 16 stays stale.

State: approved
Actual answer: A) Merge now and before plan 2 (recommended), D2 answered in chat 2026-10-30
Accepted scope: master plan gets step 0 "merge origin/main before Plan 1 Task 0 and again before Plan 2 Task 1, then npm test"; line 16 no longer claims the branch is on current main. Applied to "Order and dependencies". The merge itself is not done by this review.
History: none

### R2: Version and changelog handling for both plans
Finding: 2 (and 3), CRITICAL, 9/10, master-plan.md:22, reviewer claude
Plan baseline: master-plan.md:22 "Use the next free version at execution time"; plan 1 Task 5 Step 4 and plan 2 Task 5 each add a changelog section and bump `version`.
Runtime evidence: `origin/main:extension/CHANGELOG.md` top section is `## Unreleased`, `version` stays `0.2.4` (#12 added entries without a bump). Root `CHANGELOG.md` does not exist.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R1 when to take main | approved: merge before Plan 1 Task 0 and Plan 2 Task 1 (D2 A) | same | same | same |
| R2 version/changelog | each plan bumps to the next free version | no bump; both plans add bullets under `## Unreleased` in `extension/CHANGELOG.md` | one bump to 0.2.5 at the end of plan 2, one `## 0.2.5` section for both | keep as is: 0.2.5 after plan 1, 0.2.6 after plan 2 |
| R3 PR shape | pending | pending | pending | pending |
| R4 offerLineIdsCleanup timing | pending | pending | pending | pending |
Question D3 (asked in German in chat; English record per repo language rule):
D3 — How do both plans handle version and changelog?
Project/branch/task: master plan on feature/merge-conflicts-and-xti-diff; correction for plan 1 Task 5 and plan 2 Task 5.
ELI10: Both plans currently raise the extension version at the end, so one branch would produce 0.2.5 and 0.2.6. Upstream main has switched to an "Unreleased" changelog section and left the version at 0.2.4; the maintainer bumps at release time. If we bump ourselves, the PR fights that flow.
Stakes if we pick wrong: version conflicts with main in package.json and the changelog, and a version number the maintainer did not plan.
Recommendation: A because it matches the flow #12 just used on main and removes both version conflicts.
Completeness: A=10/10, B=7/10, C=4/10
Pros / cons:
A) Unreleased section, no bump (recommended)
  ✅ Same flow as #12 on main; no conflict on "version" in package.json
  ✅ Both plans write into one section, splitting into PRs stays easy
  ❌ The branch build still reports 0.2.4 although it has new features
B) One bump to 0.2.5 at the end
  ✅ A test VSIX from the branch carries its own version number
  ✅ Only one version change for both features
  ❌ Collides with the Unreleased flow on main; the maintainer has to rewrite it
C) Keep as is (two bumps)
  ✅ No change to the plan text; every plan closes with its own version
  ✅ Each plan alone is a releasable unit
  ❌ Two versions on one branch, both in conflict with main's Unreleased section
Net: matching upstream's release flow against a branch-local version number.
Header: Version
Options:
A) Unreleased section, no bump (recommended)
Both plans add bullets under `## Unreleased` in `extension/CHANGELOG.md` and leave `version` alone; corrections for plan 1 Task 5 and plan 2 Task 5 in the master plan.
B) One bump to 0.2.5 at the end
Plan 1 adds bullets without a bump; plan 2 Task 5 bumps to 0.2.5 and renames the section to `## 0.2.5`.
C) Keep as is (two bumps)
Each plan bumps to the next free version; only the changelog path is corrected.

State: approved
Actual answer: A) Unreleased section, no bump (recommended), D3 answered in chat 2026-10-30
Accepted scope: "Corrections to the plans" now tells plan 1 Task 5 Step 4 and plan 2 Task 5 to add bullets under `## Unreleased` in `extension/CHANGELOG.md` without a version bump. Findings 3 and 4 (changelog path, plan 1 Task 1 state and test count) recorded there as factual corrections.
History: none

### R3: PR shape for the two plans
Finding: 5, INFORMATIONAL, 8/10, master-plan.md:19, reviewer claude
Plan baseline: master-plan.md:19 "Both plans can be split into separate PRs later (docs, plan 1, plan 2), since they do not depend on each other's interfaces."
Runtime evidence: both plans edit `extension/src/extension.ts`, `extension/package.json` and `extension/CHANGELOG.md` (plan 1 Task 4/5, plan 2 Task 4/5); upstream merges PRs as single commits (`3dd2f0b Release 0.2.4 (#11)`, `66f0907 ... (#12)`), so a branch stacked on a squash-merged PR needs `git rebase --onto`.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R1 when to take main | approved (D2 A) | same | same | same |
| R2 version/changelog | approved (D3 A) | same | same | same |
| R3 PR shape | "split later", no cut stated | when plan 1 is done: open PR 1 (docs + plan 1) from this branch; plan 2 continues on a new branch cut from that point; after PR 1 merges, `git rebase --onto origin/main <last plan-1 commit>` | one PR for docs + both plans from this branch | keep the wording |
| R4 offerLineIdsCleanup timing | pending | pending | pending | pending |
Question D4 (asked in German in chat; English record per repo language rule):
D4 — How do the two plans reach main as PRs?
Project/branch/task: master plan on feature/merge-conflicts-and-xti-diff; line 19 says "split into separate PRs later".
ELI10: "Split later" sounds free but is not: both plans touch the same three files, so plan 2 cannot simply be cherry-picked onto main without plan 1. Upstream merges each PR as one commit, so a second PR built on the first has to be moved once (one rebase command) after the first is merged.
Stakes if we pick wrong: one giant PR (about 19 files plus docs) is hard to review for the risky auto-resolve part; an unplanned split later costs conflict resolution in package.json and extension.ts.
Recommendation: A because each PR stays reviewable on its own and the cut point is fixed now, not reconstructed later.
Completeness: A=9/10, B=7/10, C=4/10
Pros / cons:
A) Stacked PRs, cut after plan 1 (recommended)
  ✅ PR 1 (auto-resolve, risky) is reviewed and merged without waiting for plan 2
  ✅ Cut point is a known commit; one `git rebase --onto` after PR 1 merges (human: ~15 min / CC: ~3 min)
  ❌ Plan 2 moves to a new branch name; the master plan's "one branch" line changes
B) One PR for everything
  ✅ No rebase, no second branch; the branch name in the plans stays valid
  ✅ One review round for the maintainer
  ❌ About 19 code files plus docs in one PR; the overwrite risk of auto-resolve gets less attention
C) Keep "split later"
  ✅ No decision needed now; plan text unchanged
  ✅ Leaves room to decide after seeing the real diff size
  ❌ A later split means cherry-picks with conflicts in package.json, extension.ts and the changelog
Net: a fixed cut and one rebase against one big PR or an unplanned split.
Header: PR shape
Options:
A) Stacked PRs, cut after plan 1 (recommended)
When plan 1 is done, open PR 1 (docs + plan 1) from this branch; plan 2 continues on a new branch cut from that commit; after PR 1 merges, rebase it with `git rebase --onto origin/main <last plan-1 commit>`.
B) One PR for everything
Docs, plan 1 and plan 2 go to main in one PR from feature/merge-conflicts-and-xti-diff; line 19 says so.
C) Keep "split later"
Leave line 19 as it is.

State: approved
Actual answer: B) One PR for everything, D4 answered in chat 2026-10-30 (recommendation was A)
Accepted scope: "Order and dependencies" item 3 now states one PR for docs, plan 1 and plan 2 from feature/merge-conflicts-and-xti-diff, and why a later split is not planned. R1's second merge before Plan 2 Task 1 stays.
History: none

### R4: When to remove offerLineIdsCleanup
Finding: 6, INFORMATIONAL, 7/10, tcpou-merge-conflicts.md:52, reviewer claude
Plan baseline: plan 1 Task 1 Step 1 removes `offerLineIdsCleanup` before Task 4 adds auto-resolve.
Runtime evidence: `extension/src/extension.ts:152,156,213` on the branch; not on `origin/main`.
Comparison grid: not built; no question asked.
State: approved (no change)
Actual answer: none needed. D4 B (one PR) means the gap between Task 1 and Task 4 exists only on the work branch and never reaches `main` or a release. Keeping plan 1's order costs nothing.
Accepted scope: none
History: none

### Section 1: Architecture

Bounded probe on `origin/main` (`66f0907`), because #12 edited files both plans hook into: `openView` (2 hits), `xmlConflict` (3) and `registerIoYaml` (2) still exist in `extension/src/extension.ts`; `links-diff` still exists in `extension/src/cli.ts` (3); `extension/package.json` still has the `3_compare` groups (5) and the `iecode.ioLinksDiff` entries plan 2 sits next to. No anchor of either plan disappeared. No new components, data flows, security boundaries or build artifacts are introduced by the master plan itself.

No issues found.

### Section 2: Code quality

The master plan holds no code. Its rules match the sub-plans (`npm test` green after every task, English, commit body, public-repo rule with `/internal/` in `.gitignore:46`).

No issues found beyond findings 3 and 4 (factual corrections, applied).

### Section 3: Tests

```
GATES IN THE MASTER PLAN                       COVERAGE
[+] per task: npm test (extension/)            [★★ TESTED] 84 tests, 83 pass, 1 skipped at 207d381
[+] main sync (R1): npm test after merge       [★★ TESTED] same suite, runs against #12's 16 test files
[+] plan 1 e2e: scripts/e2e.sh (Task 5)        [GAP] runs once in plan 1, never after plan 2 or the second main merge
[+] manual checks: plan 1 T5 S3, plan 2 T4 S5  [GAP] each run once, before the final branch state exists
[+] one PR (R3)                                [GAP] no final gate before opening it
```

7. [INFORMATIONAL] (confidence: 7/10) master-plan.md:28 "`npm test` (in `extension/`) stays green after every task" is the only gate in the master plan. With one PR (D4 B) and a second `main` merge before plan 2 (D2 A), the e2e run of plan 1 (`extension/scripts/e2e.sh`; its default `CODE` is the macOS path) and both manual checks happen before the final branch state exists.

### R5: Final gate before opening the PR
Finding: 7, INFORMATIONAL, 7/10, master-plan.md:28, reviewer claude
Plan baseline: only "npm test after every task"; no step before the PR.
Runtime evidence: `extension/scripts/e2e.sh:5` `CODE="${CODE:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"`; `extension/test/e2e/index.ts` exists.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R1 main sync | approved (D2 A) | same | same | same |
| R2 version/changelog | approved (D3 A) | same | same | same |
| R3 PR shape | approved (D4 B, one PR) | same | same | same |
| R5 final gate | none | "Before the PR" section: merge `origin/main` once more if it moved, `npm test`, `CODE=… sh scripts/e2e.sh` with the Windows `CODE`, plan 1 Task 5 Step 3 and plan 2 Task 4 Step 5 manual checks on the final branch | `npm test` and `e2e.sh` only | nothing |
Question D5 (asked in German in chat; English record per repo language rule):
D5 — Do we add a final gate before the PR?
Project/branch/task: master plan on feature/merge-conflicts-and-xti-diff; one PR for both plans (D4).
ELI10: Today the only rule is "npm test after every task". The real VS Code test (e2e.sh) and the two click-through checks run once, in the middle, before plan 2 and the second main merge. The PR would then go out with a state nobody clicked through.
Stakes if we pick wrong: plan 2's extension.ts/package.json changes or the main merge can break the conflict bar or the panel, and only the maintainer notices.
Recommendation: A because the extra cost is one e2e run and about 15 minutes of clicking, and it covers the exact state the PR ships.
Completeness: A=10/10, B=7/10, C=4/10
Pros / cons:
A) Full gate: tests, e2e, manual (recommended)
  ✅ The shipped state is tested in a real VS Code, both features clicked through once more
  ✅ Catches breakage from the second main merge before the maintainer sees it (human: ~20 min / CC: ~5 min + your clicks)
  ❌ About 15 minutes of manual clicking at the end
B) npm test and e2e only
  ✅ Fully automatic, no manual clicking
  ✅ Still covers the conflict flow end to end in VS Code
  ❌ The Config Changes panel (plan 2) is never checked by hand on the final state
C) Nothing
  ✅ No extra step in the plan
  ✅ The per-task gates stay the only rule
  ❌ e2e and manual checks never run on what the PR contains
Net: about 20 minutes at the end against shipping a state nobody ran in VS Code.
Header: PR gate
Options:
A) Full gate: tests, e2e, manual (recommended)
Add "Before the PR": merge origin/main if it moved, npm test, e2e.sh with the Windows CODE, and the manual checks of plan 1 Task 5 Step 3 and plan 2 Task 4 Step 5 on the final branch.
B) npm test and e2e only
Add "Before the PR": merge origin/main if it moved, npm test, e2e.sh with the Windows CODE.
C) Nothing
No final gate; per-task npm test stays the only rule.

State: approved
Actual answer: A) Full gate: tests, e2e, manual (recommended), D5 answered in chat 2026-10-30
Accepted scope: new section "Before the PR" in the master plan: merge origin/main if it moved, npm test, e2e.sh with the Windows CODE, manual checks of plan 1 Task 5 Step 3 and plan 2 Task 4 Step 5 on the final branch.
History: none

### Section 4: Performance

The master plan adds no runtime path. The one scale risk in scope (real `.xti` files of 75k-320k lines, >100k changes with layout shown) is owned by plan 2's Review Focus 1 (`limitChanges`, 500 per category). Merging `main` twice costs seconds (`git merge-tree` clean).

No issues found.

Test Plan Artifact: `~/.gstack/projects/JanJunklewitz-iecode/hofmannp-feature-merge-conflicts-and-xti-diff-eng-review-test-plan-20261030-120839.md`.

### Outside Voice (Claude subagent, native fallback; Codex CLI not installed)

Plan subagent, completed within the 5-minute timer. Nine findings; parent verification:
- O1 High, CONFIRMED: `extension/src/commands/compare.ts:181` "VS Code can't filter that menu by file type (it is cached per resource state)"; main routes SCM clicks through the `iecode.scmCompare` submenu. Plan 1 (`tcpou-merge-conflicts.md:129`) and plan 2 (`xti-config-diff.md:171`) add `scm/resourceState/context` entries filtered by `resourceExtname`.
- O2 Medium, PARTLY CONFIRMED: `core.autocrlf=true` in the system gitconfig; this repo's `.gitattributes` has `*.TcPOU -text` etc., so repo files are safe, but plan 1's `mkdtemp` test repos have no attributes and `release.yml:49` runs `npm test` on Windows. Plan 1 Task 3 keeps "ours' EOL" from the index stage.
- O3 Medium, CONFIRMED: `extension/test/e2e/index.ts:9,29,77` edits `FB_Motor.TcPOU` in `$TMP` and expects it in `workingTreeChanges`; plan 1 Task 5 creates the conflict on the same file in the same repo.
- O4 Medium, CONFIRMED: corrections live only in the master plan; sub-plans still say `0.2.3`, version bump, "uncommitted", "80 pass".
- O5 Medium, factual correction applied: expected test count after the main merge is unknown; use "0 fail".
- O6 Medium, CONFIRMED: with one PR (D4 B) this review section (local paths with a username, chat-process notes) ships to the public repo.
- O7 Medium, UNVERIFIED (5/10): `resourcePath in iecode.conflictedFiles` vs fsPath drive-letter case on Windows (`tcpou-merge-conflicts.md:119,128`); e2e already notes "c: vs C:" at `extension/test/e2e/index.ts:31`.
- O8 Low, note only: the master plan has uncommitted review edits; commit before step 0.
- O9 Low: `e2e.sh` has never run on Windows; dry-run it before plan 1 instead of first at the PR gate.

Cross-model ledger (asked in German in chat as D6-D9 and D10-D12; options per row: A) Apply, B) Keep current, C) Investigate first, D) Defer):
| ID | Change if A | Current |
|---|---|---|
| R6 (O1) | plan 1: SCM entry filtered only by `scmResourceGroup == merge`, command refuses non-object files; plan 2: SCM entry through the `iecode.scmCompare` submenu / `scm()` dispatcher | `resourceExtname` filter in SCM menu |
| R7 (O2) | plan 1 temp repos use `-c core.autocrlf=false`; auto-resolve takes EOL and BOM from the working file | EOL from stage 2 |
| R8 (O3) | plan 1 Task 5 builds the conflict in its own subfolder repo under `$TMP` | same `$TMP` repo |
| R9 (O4) | write the master-plan corrections into both sub-plans | corrections only in master |
| R10 (O6) | move this review section to `internal/` before the PR; master plan keeps only the plan | review section in the public plan |
| R11 (O7) | plan 1: normalise paths for `iecode.conflictedFiles` (lower-case drive letter, `iecode:` mapped to `file:`) and check both editors on Windows | unspecified |
| R12 (O9) | add a Windows dry run of `e2e.sh` to step 0 | e2e first runs in plan 1 Task 5 |
State: approved (all seven)
Actual answer: A) Apply for R6-R12 (D6-D12, answered in chat 2026-10-30)
Accepted scope: R6, R7, R8, R11 written into plan 1 (Task 2 test file note, Task 3 step 5, Task 4 context key and SCM menu, Task 5 e2e repo); R6 into plan 2 Task 4 menus; R9 corrections written into plan 1 Task 1 and Task 5 Step 4 and plan 2 Task 5; R10 added as "Before the PR" step 5; R12 and the O8 commit note added to step 0.
History: none

Approval readiness: PASS. R1 (D2 A), R2 (D3 A), R3 (D4 B), R4 (no change, no question), R5 (D5 A), R6-R12 (D6-D12 A). No pending records.

### NOT in scope
- Plan-level review of each sub-plan's internals beyond the points above: each plan gets its own review when it starts.
- Running the `main` merge, the commits or the e2e dry run: this review only changes plan text.
- TODO.md backlog (ADS AI interface, SYS folder detection): no plan yet, unaffected.

### What already exists
- SCM submenu with a type dispatcher (`extension/src/commands/compare.ts`, `iecode.scmCompare`): reused by R6 instead of new filtered entries.
- Temp-repo git test pattern with `-c user.*` (`extension/test/iotree.test.ts`): reused by R7.
- `extension/scripts/e2e.sh` and `extension/test/e2e/index.ts`: extended by plan 1, run on Windows by R12 and the PR gate.
- `## Unreleased` changelog flow on `main` (#12): reused by R2.

### Failure modes
| Path | Realistic failure | Covered by | User sees |
|---|---|---|---|
| main merge (step 0) | conflict in `package.json` menus after #12 | `npm test` after merge; clean `merge-tree` today | merge conflict, loud |
| SCM menu entries | entry on wrong files or missing | R6 dispatcher / merge-group filter, manual check | wrong menu, visible |
| auto-resolve on Windows | CRLF lost when stages are LF | R7 (EOL from working file, autocrlf=false in tests, Windows test run in `release.yml`) | none after fix |
| conflict bar context key | `c:` vs `C:` hides the bar | R11 normalisation, Windows check in Task 5 | missing bar, visible |
| e2e on Windows | script fails under Git Bash | R12 dry run in step 0 | loud script error |

Critical gaps: 0.

### Parallelization
Sequential implementation, no parallelization opportunity (both plans share `extension.ts`, `package.json`, the changelog; decided order plan 1 then plan 2).

### Implementation Tasks
- [ ] **T1 (P1, human: ~15 min / CC: ~3 min)** — branch — Commit plan edits, merge `origin/main`, `npm test`
  - Surfaced by: Scope Challenge finding 1 (R1)
  - Files: none (merge)
  - Verify: `npm test` 0 fail
- [ ] **T2 (P1, human: ~20 min / CC: ~5 min)** — e2e — Windows dry run of `e2e.sh`
  - Surfaced by: Outside Voice O9 (R12)
  - Files: `extension/scripts/e2e.sh` only if it fails
  - Verify: script prints its success output with the Windows `CODE`
- [ ] **T3 (P1, human: ~1h / CC: ~20 min)** — release gate — "Before the PR" steps 1-5
  - Surfaced by: Section 3 finding 7 (R5), O6 (R10)
  - Files: `internal/` (review notes), this file
  - Verify: steps 1-4 green; `git diff origin/main --stat` shows no review section
_No new tasks from Architecture, Code Quality or Performance._ R6-R11 are carried by the sub-plan tasks they were written into.

### Unresolved decisions
None.

### Completion summary
- Step 0: Scope Challenge — scope accepted as-is
- Reality rows: 7/7 applicable rows emitted, 1 unverified premise
- Architecture Review: 0 issues found
- Code Quality Review: 0 issues found
- Test Review: diagram produced, 3 gaps identified
- Performance Review: 0 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user (no TODOS.md; TODO.md backlog unaffected)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: Claude Plan subagent (native fallback), completed; Codex CLI not installed, so no external-provider coverage. 9 findings, 7 accepted, 2 notes
- Parallelization: 1 lane, 0 parallel / 1 sequential
- Lake Score: 3/4 (D4 picked the 7/10 option)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | native fallback (Claude Plan subagent), Codex not installed | Independent 2nd opinion | 1 | unavailable (external), native completed | 9 findings, 7 accepted |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (resolved in plan) | 3 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, eng plan-review phase, unavailable (CLI not installed); native Claude subagent completed with 9 findings, which does not count as outside coverage.
- **VERDICT:** no review CLEAR; eng review findings are all resolved in the plan text, status stays issues_open per log rules. eng review required

NO UNRESOLVED DECISIONS
