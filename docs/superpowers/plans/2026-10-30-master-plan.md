# Master Plan (as of 2026-10-30)

Overview of the open implementation plans: what each one delivers, where its code lives, its status, and the order to work on them. Each plan carries its own tasks, tests and review focus; this file only coordinates.

## Plans

| # | Plan | Goal | Code branch | Status |
|---|---|---|---|---|
| 1 | [TcPOU merge conflict resolution](2026-10-30-tcpou-merge-conflicts.md) | Resolve git merge conflicts in `.TcPOU/.TcDUT/.TcGVL/.TcIO` without touching XML: auto-resolve outside the ST code, the rest in the ST view with Accept Current / Incoming / Both. | `fix/merge-conflicts-in-st-view` | In progress: ST-view tolerance and CodeLens are committed (`752ff68`, `d486595`). Task 0 (root launch config, conflict repo script) is open. Task 1 Step 1 (remove `offerLineIdsCleanup`) is open. Tasks 2-5 are open. |
| 2 | [XTI config diff](2026-10-30-xti-config-diff.md) | Categorised, filterable diff of `.xti` files (PLC instance first), as a panel, a YAML diff and the CLI `config-diff`. | not created yet (suggestion: `feature/xti-config-diff` from `main`) | Planned. Research done: [docs/research/xti-diff](../../research/xti-diff/README.md). |

Backlog without a plan yet: see [TODO.md](../../../TODO.md) (AI interface for ADS variable access, SYS folder detection).

## Order and dependencies

1. **Plan 1 first.** It is already started, and its branch is behind `main` (based on 0.2.2, `main` is at 0.2.4). Before continuing, update it from `main`.
2. **Plan 2 second**, on its own branch from `main`. It shares no code with plan 1. Both touch `extension/src/extension.ts`, `extension/package.json` (commands, menus) and `CHANGELOG.md`, so expect small merge conflicts there; merge plan 1 into `main` before starting plan 2 to avoid them.
3. The two plans do not depend on each other's interfaces and could also run in parallel on separate worktrees, if the conflicts in the three shared files are acceptable.

## Corrections to the plans

- **Plan 1, Task 5:** the plan targets version `0.2.3` with a `## 0.2.3` changelog section. `main` already released 0.2.4. Use the next free version at execution time instead (as plan 2 does).

## Rules for both plans

- This repo is public. No company-internal content (project names, commit messages, customer data) in code, fixtures, docs or commit messages. Internal notes go into the git-ignored `internal/` folder.
- `npm test` (in `extension/`) stays green after every task. Run tests through the PowerShell tool.
- Commits: subject + 1-3 sentence body on *why*; no attribution trailers.

## Where things live

- Plans: `docs/superpowers/plans/`
- Research: `docs/research/`
- Open items: `TODO.md`
- These docs are collected on the branch `docs/plans`.
