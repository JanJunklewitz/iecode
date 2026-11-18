# Object Analysis and History Master Plan (2026-11-18)

> **Status: master plan with sub-plans A to H, written 2026-11-18, not yet eng-reviewed.** Run the sub-plans with superpowers:subagent-driven-development or superpowers:executing-plans. Branch: `feature/object-analysis-and-history` (from `main`).

**Goal:** Two groups of TODO items that each share one foundation: (1) history, blame and staging per object (method / property / action) instead of per XML file; (2) a call graph of PLC objects that answers "what is unused", "what does a change affect", plus the checks that use the same inputs (IO links, XML structure, OOP rules).

**Architecture:** Same rules as the earlier plans: decisions in pure `extension/src/core/` modules with `node --test` tests, `src/commands/` and `src/views/` only wire. Two foundations, built once:

- **Object spans** (`core/objectSpans.ts`, Plan A): maps a line of the ST view to the XML lines it comes from, per section. Blame (A), history (B) and staging (C) are three users of it.
- **Object graph** (`core/objectGraph.ts`, Plan D): who references whom between objects and members, plus the roots (PLC tasks). Unused (E), impact and Mermaid export (F) are users; the rule engine of H can reuse it.

**Tech Stack:** TypeScript (`node --test`), the `git` CLI through `core/git.ts`. No C# change in this master plan (see decision 1).

**Spec:** [TODO.md](../../../TODO.md) items "git blame per method", "Per-object history and staging", "Mark unused objects", "Dependency graph as Mermaid export", "IO link consistency checks", "XML structure checks and OOP rules" and the rename remark under "Semantic diff for system config files"; research in [feature-ideas.md](../../research/feature-ideas.md) (sections K, G, 6 and 7).

## Global Constraints

- Public repository: no internal names, symbol paths or data in code, tests, docs or commits. Commits: English subject plus a 1-3 sentence why-body, GitHub noreply address as author and `Signed-off-by` (`git commit -s`). Cosmetic changes in separate commits.
- `npm test` (in `extension/`) green after every task. Tests that need git build a throwaway repository with the `git` CLI, as `extension/test/merge.test.ts` does.
- XML is never rewritten except through `encode()` in `extension/src/model.ts`; no plan may change bytes outside the sections it names. Every write path gets a "bytes outside the section are identical" test.
- Analyses never claim more than they know: a result that depends on a guess says so (Plan D `confidence`), and a file that does not parse is reported, not skipped silently.
- Every user-visible change gets a CHANGELOG line under `## Unreleased`.

## Sub-plans

| Plan | Item | Foundation | Size `[estimated]` |
|---|---|---|---|
| [A](2026-11-18-object-analysis-a-object-spans-and-blame.md) | Object spans, then blame per method (CodeLens, hover) | builds `objectSpans` | 1.5 days |
| [B](2026-11-18-object-analysis-b-object-history.md) | History of one object across commits, renames and moves; the same rename pairing for the config diff | uses `objectSpans`; builds `renameMatch` | 2 days |
| [C](2026-11-18-object-analysis-c-object-staging.md) | Stage and discard one method instead of the whole file | uses `objectSpans` | 1.5 days |
| [D](2026-11-18-object-analysis-d-object-graph.md) | Object graph: references, task roots, reachability both ways, "why reachable" | builds `objectGraph` | 2.5 days |
| [E](2026-11-18-object-analysis-e-unused-objects.md) | Mark unused objects: tree decoration, Problems hint, list command | uses `objectGraph` | 1 day |
| [F](2026-11-18-object-analysis-f-impact-and-mermaid.md) | Impact view (tasks, callers, IO links) and Mermaid export of the project and the object graph | uses `objectGraph` | 1.5 days |
| [G](2026-11-18-object-analysis-g-io-link-checks.md) | IO link consistency checks: dead link, size mismatch, unlinked variable, channel linked twice | independent | 1.5 days |
| [H](2026-11-18-object-analysis-h-structure-checks.md) | XML structure checks and OOP rules as Problems-panel diagnostics, safe auto-fix | rule engine; G and E register rules in it | 3 days |

## Order

```
Lane 1 (git, no PLC needed):   A -> B -> C
Lane 2 (graph):                D -> E -> F
Lane 3 (checks):               H (engine + structure rules) -> G (IO rules) ; E registers its rule in H when both exist
```

Why: A first because B and C cannot be tested without the span mapping. D before E and F for the same reason. H's engine is small and G, E plug into it, so H's first two tasks (engine, structure rules) go before G; H's OOP rules can follow later. The lanes share no source file except `package.json`, `extension.ts` (registration lines) and `CHANGELOG.md`, so they can run in parallel worktrees; merge conflicts there are one-liners.

## Pull requests

One PR per lane: Lane 1 (A to C), Lane 2 (D to F), Lane 3 (G, H). This branch carries the plans only; the implementation commits go on the same branch or on lane branches cut from it, as the executor prefers.

## Decisions (planner, 2026-11-18)

| ID | Plan | Decision | Rejected |
|---|---|---|---|
| 1 | D, G, H | Analyses live in TypeScript in `core/`, next to the parser and `SymbolIndex` they need. A CLI twin for CI (`iecode lint`) is **not** part of this master plan: the parser would have to be written a second time in C#. Rule results are plain data (`Finding`), so a CLI can follow once the rules are stable. | Porting the SymbolIndex to C# first. |
| 2 | A | Blame runs `git blame` on the raw XML and maps lines through the spans; a line on a section boundary (it also holds `<Declaration><![CDATA[` or `]]>`) is re-blamed past commits that changed only the tag text. | Own blame over decoded views at every commit (exact, but one decode per commit per request). |
| 3 | B | History compares the section text commit by commit over `git log --follow`; a renamed or moved member is paired by text similarity (`renameMatch`, threshold 0.7 of common non-blank lines, best unique match only). Moves between files are left for later. | `git log -L` (cannot see sections inside XML). |
| 4 | C | Staging builds the new index file with `encode(indexXml, mixedView)` and writes it with `git hash-object -w` and `git update-index --cacheinfo`; the index version, not HEAD, is the base. A file with conflicts or an untracked file is refused with a message. | Writing patches into the index with `git apply --cached` (line offsets of XML are fragile). |
| 5 | D | An unused finding has a `confidence`: `unreferenced` (nothing mentions it, text search of visualization files included), `only-from-unused` (referenced only by unused objects), `via-guess` is never reported as unused but listed as reachable with the reason. Unknowns are treated as reachable. | Reporting every unreached object and letting the user sort out the false alarms. |
| 6 | D, E | Library projects get no unused findings (their users are outside the workspace); only application projects and standalone projects are analysed. Extra roots come from the setting `iecode.analysis.rootObjects` (names or globs). | Marking library objects too. |
| 7 | G | The symbol list for IO links comes from the build output (`.tmc`, the same source XAE resolves links against), with the existing stale warning; without a build the checks say "not built" and report nothing. | Re-deriving `AT %I*` variables from the source (aliases and nesting differ from the build). |

## Check against a real project (2026-11-18)

The plans were checked read-only against a real XAE 4024 project (one PLC project, one system project, 1057 commits; only numbers are recorded here, no names). What changed because of it:

- **Plan G** was rewritten: 10 % of the links name array elements or `^` sub-paths that are not symbols of their own in the `.tmc`, so a naive lookup would report about 90 dead links where there are 2; the size rule was dropped (`Size` is not `BitSize / 8`); an `<UnrestoredVarLinks>` block full of old links must be ignored. Details and numbers in Plan G.
- **Plan D** got the qualified task call and the 141 visualization files as cases.
- **Plan H** got a baseline: 359 object files, zero violations of the structure rules (so a finding on a healthy project is a rule bug).
- Confirmed unchanged: the area / symbol model of `linksOfFile` and `parseTmc` (139 ms for 7 MB), two tasks, `TcTTO` calls. Not yet measured: blame and history speed on a repository of that size (1057 commits; one sampled object file has 4); Plan A and B check it in their manual steps.

## Open questions (do not block A to F; each has a default)

1. **Which rules does TwinCAT itself enforce for double links?** Measured on the real project: 18 input channels feed 2 or more PLC variables (normal), 2 output channels have 2 or more sources. G's defaults stand (info for inputs, warning for outputs); still check the output case in XAE before G ships.
2. **Variables, not only objects:** unused GVL / FB variables are out of scope for E; the graph (D) keeps member granularity so it can follow.
3. **`iecode lint` for CI:** see decision 1; decide after H's rules have run on real projects for a while.
4. **Object moves between files in the history (B):** needs the changed-file list of every commit and a cross-file pairing; left out until someone needs it.

## Review focus for the whole set

Every plan's own Review Focus section lists its cases. The two that decide whether the features are trusted:

1. A boundary line of a section (first and last line) is attributed to the commit that changed its text, not its XML tag (A; known failure of an existing extension).
2. No object that a task reaches through an interface, an override, `FB_init` or a visualization is ever reported as unused (D, E).
