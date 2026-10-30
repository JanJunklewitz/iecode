# Master Plan (as of 2026-10-30)

Overview of the open implementation plans: what each one delivers, where its code lives, its status, and the order to work on them. Each plan carries its own tasks, tests and review focus; this file only coordinates.

## Plans

| # | Plan | Goal | Code branch | Status |
|---|---|---|---|---|
| 1 | [TcPOU merge conflict resolution](2026-10-30-tcpou-merge-conflicts.md) | Resolve git merge conflicts in `.TcPOU/.TcDUT/.TcGVL/.TcIO` without touching XML: auto-resolve outside the ST code, the rest in the ST view with Accept Current / Incoming / Both. | `feature/merge-conflicts-and-xti-diff` | In progress: ST-view tolerance and CodeLens are committed (`752ff68`, `d486595`, merged from `fix/merge-conflicts-in-st-view`; tests green on top of 0.2.4). Task 0 (root launch config, conflict repo script) is open. Task 1 Step 1 (remove `offerLineIdsCleanup`) is open. Tasks 2-5 are open. |
| 2 | [XTI config diff](2026-10-30-xti-config-diff.md) | Categorised, filterable diff of `.xti` files (PLC instance first), as a panel, a YAML diff and the CLI `config-diff`. | `feature/merge-conflicts-and-xti-diff` | Planned. Research done: [docs/research/xti-diff](../../research/xti-diff/README.md). |

Backlog without a plan yet: see [TODO.md](../../../TODO.md) (AI interface for ADS variable access, SYS folder detection).

## Order and dependencies

1. **Plan 1 first.** It is already started; its earlier work is merged onto the current `main` (0.2.4) on this branch.
2. **Plan 2 second**, on the same branch. It shares no code with plan 1; both touch `extension/src/extension.ts`, `extension/package.json` (commands, menus) and `CHANGELOG.md`, which is why they run one after the other on one branch instead of in parallel.
3. Both plans can be split into separate PRs later (docs, plan 1, plan 2), since they do not depend on each other's interfaces.

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
- Work branch for both plans: `feature/merge-conflicts-and-xti-diff`.
