# Master Plan (as of 2026-11-01)

Overview of the open implementation plans: what each one delivers, where its code lives, its status, and the order to work on them. Each plan carries its own tasks, tests and review focus; this file only coordinates.

## Plans

| # | Plan | Goal | Code branch | Status |
|---|---|---|---|---|
| 1 | [TcPOU merge conflict resolution](2026-10-30-tcpou-merge-conflicts.md) | Resolve git merge conflicts in `.TcPOU/.TcDUT/.TcGVL/.TcIO` without touching XML: auto-resolve outside the ST code, the rest in the ST view with Accept Current / Incoming / Both. | `feature/merge-conflicts-and-xti-diff` | Code done: all tasks committed (Tasks 0-5). Open: the checks under "Before the PR". |
| 2 | [XTI config diff](2026-10-30-xti-config-diff.md) | Categorised, filterable diff of `.xti` files (PLC instance first), as a panel, a YAML diff and the CLI `config-diff`. | `feature/merge-conflicts-and-xti-diff` | Code done: all tasks committed (Tasks 1-5). Open: the manual panel check under "Before the PR". |

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
5. Done: the review notes (`## Plan review` and everything after it) moved to `internal/` (git-ignored). This repo is public; they contain local paths.

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
