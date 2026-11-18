# Object Analysis and History Master Plan (2026-11-18)

> **Status: master plan with sub-plans A to H, written 2026-11-18, eng-reviewed 2026-11-18 (see "Eng review" below; second opinion by a different model included).** Run the sub-plans with superpowers:subagent-driven-development or superpowers:executing-plans. Branch: `feature/object-analysis-and-history` (from `main`).

**Goal:** Two groups of TODO items that each share one foundation: (1) history, blame and staging per object (method / property / action) instead of per XML file; (2) a call graph of PLC objects that answers "what is unused", "what does a change affect", plus the checks that use the same inputs (IO links, XML structure, OOP rules).

**Architecture:** Same rules as the earlier plans: decisions in pure `extension/src/core/` modules with `node --test` tests, `src/commands/` and `src/views/` only wire. Two foundations, built once:

- **Object spans** (`core/objectSpans.ts`, Plan A): maps a line of the ST view to the XML lines it comes from, per section. Only blame (A) needs it; history (B) and staging (C) find the section at the cursor with `outline()` of `model.ts` and work on section text and XML node ranges.
- **Object graph** (`core/objectGraph.ts`, Plan D): who references whom between objects and members, plus the roots (PLC tasks). Unused (E), impact and Mermaid export (F) are users; the rule engine of H can reuse it.

**Tech Stack:** TypeScript (`node --test`), the `git` CLI through `core/git.ts`. No C# change in this master plan (see decision 1).

**Spec:** [TODO.md](../../../TODO.md) items "git blame per method", "Per-object history and staging", "Mark unused objects", "Dependency graph as Mermaid export", "IO link consistency checks", "XML structure checks and OOP rules" and the rename remark under "Semantic diff for system config files"; research in [feature-ideas.md](../../research/feature-ideas.md) (sections K, G, 6 and 7).

## Global Constraints

- Public repository: no internal names, symbol paths or data in code, tests, docs or commits. Commits: English subject plus a 1-3 sentence why-body, GitHub noreply address as author and `Signed-off-by` (`git commit -s`). Cosmetic changes in separate commits.
- `npm test` (in `extension/`) green after every task. Tests that need git build a throwaway repository with the shared helper `extension/test/helpers/gitRepo.ts` (Plan A Task 0 extracts it from `merge.test.ts`; every plan that needs a repository uses it).
- The ST view (`iecode:` document) can hold unsaved edits, the analyses read the file on disk: every feature that maps view lines to the disk file (blame, staging) is off for a dirty view document and says "save first".
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
| [G](2026-11-18-object-analysis-g-io-link-checks.md) | IO link consistency checks: dead link, type mismatch, unlinked variable, channel linked twice | `ioLinkSymbols` (G Task 0), `Finding` from H | 1.5 days |
| [H](2026-11-18-object-analysis-h-structure-checks.md) | XML structure checks and OOP rules as Problems-panel diagnostics, safe auto-fix | rule engine; G and E register rules in it | 3 days |

## Order

```
Shared first (tiny, each merged before its users start; each ships in the PR of the lane named):
  A Task 0   test/helpers/gitRepo.ts + model.ts exports sectionsOfXml   (Lane 1a; users: A, B, C tests, H structure rules)
  D Task 0   core/unitIndex.ts (per-project SymbolIndex)               (Lane 2; users: D, H OOP rules)
  H Task 0/1 xml.ts termination fix, core/findings.ts                  (Lane 3a; users: H, G)
  G Task 0   core/ioLinkSymbols.ts + systemProjectOf                   (Lane 2, first commit; users: F, G)

Lane 1 (git, no PLC needed):   A -> B -> C (Stage) -> C (Discard, own PR)      B Task 4 (config rename) is a separate PR
Lane 2 (graph):                G Task 0 -> D (Task 0 first) -> E -> F
Lane 3 (checks):               H (Tasks 0 to 2, then 3 after D Task 0, then 4) -> G (Tasks 1 and 2)
```

Why: A first because B and C cannot be tested without the helper and (for A) the span mapping. D before E and F for the same reason. The three shared files are small and sit in different lanes, so each is its own first task and is merged before its users start; this removes the "whichever is built first creates it" ambiguity of the first draft. The lanes then share only `package.json`, `extension.ts` (registration lines) and `CHANGELOG.md`; merge conflicts there are one-liners.

## Pull requests

Six PRs: Lane 1a (A to C Task 3: blame, history, Stage), Lane 1b (B Task 4: config diff rename detection, independent of the object history; needs only `renameMatch` from B Task 1), Lane 1c (C Task 4: Discard, shipped after Stage has been used once because it is destructive), Lane 2 (D to F), Lane 3a (H), Lane 3b (G, with G Task 0). Lane 3 is split because H alone (engine, structure rules, OOP rules, UI) is a 3-day review and G only needs its Task 1. This branch carries the plans only; the implementation commits go on lane branches cut from it. A shared first task that a lane depends on goes into that lane's PR; the next lane rebases on it after merge (no cross-lane stacking).

## Decisions (planner, 2026-11-18)

| ID | Plan | Decision | Rejected |
|---|---|---|---|
| 1 | D, G, H | Analyses live in TypeScript in `core/`, next to the parser and `SymbolIndex` they need. A CLI twin for CI (`iecode lint`) is **not** part of this master plan: the parser would have to be written a second time in C#. Rule results are plain data (`Finding`), so a CLI can follow once the rules are stable. | Porting the SymbolIndex to C# first. |
| 2 | A | Blame runs `git blame` on the raw XML and maps lines through the spans; a line on a section boundary (it also holds `<Declaration><![CDATA[` or `]]>`) is re-blamed past commits that changed only the tag text. | Own blame over decoded views at every commit (exact, but one decode per commit per request). |
| 3 | B | History compares the section text commit by commit over `git log --follow`; a renamed or moved member is paired by text similarity (`renameMatch`, threshold 0.7 of common non-blank lines, best unique match only). Moves between files are left for later. | `git log -L` (cannot see sections inside XML). |
| 4 | C | Staging **splices XML node ranges** (the member node and its `<LineIds>` entry, or the `<Declaration>` / `<Implementation>` of the main part) from the working copy into the index text, or the reverse for discard; the result is written with `git hash-object -w --no-filters` and `git update-index --cacheinfo`; the index version, not HEAD, is the base. A file with conflicts, an intent-to-add or untracked file, or a dirty view document is refused with a message. | `encode(indexXml, mixedView)` (first draft): `encode()` gives every added member a **new random GUID** (`model.ts` `build()`), so the staged member and the working copy would differ in `Id` for ever. Also `git apply --cached` patches (line offsets of XML are fragile). |
| 5 | D | An unused finding has a `confidence`: `unreferenced` (nothing mentions it, text search of visualization files and of non-ST bodies included), `only-from-unused` (referenced only by unused objects). A reference that cannot be resolved is treated as a reference to every member of that name (reason `by-name`). **Members that implement an interface member or override a base member are never reported** (removing them breaks the build; a library may call them). | Reporting every unreached object and letting the user sort out the false alarms. |
| 6 | D, E | Library projects get no unused findings (their users are outside the workspace); only application projects and standalone projects are analysed. Extra roots come from the setting `iecode.analysis.rootObjects` (names or globs). | Marking library objects too. |
| 7 | G | The symbol list for IO links comes from the build output (`.tmc`, the same source XAE resolves links against), with the existing stale warning; without a build the checks say "not built" and report nothing. | Re-deriving `AT %I*` variables from the source (aliases and nesting differ from the build). |
| 8 | D | The analysis builds **its own `SymbolIndex` per PLC project** from the files on disk (the project, the workspace library projects it references, library sources), not the editor index of `lang/providers.ts`. That index is workspace-wide and keyed by object name, so two applications that both have `MAIN` or the same GVL name would resolve into each other; it also holds unsaved editor text. Refresh is on save, not on keystroke. | Reusing the editor index (first draft): cheaper, but wrong in a workspace with more than one application. |
| 9 | D | Implementations that are not ST (CFC, FBD, LD, SFC) are invisible in the view. Their raw XML is scanned for words that name an object or member; every match is a reference by name (reason `non-st`). | Ignoring them: everything called only from a CFC body would be reported as unused. |
| 10 | F, G | A PLC side of an IO link has the form `TIPC^<plc>^<plc> Instance^<task> Inputs\|Outputs^<path>` (`shortName` in `core/iotree.ts` parses it, the tests of `iotree.test.ts` use it). One parser, `parsePlcLinkSide` in `core/ioLinkSymbols.ts`, returns `{ plc, area, path }`; any other `TIPC^` side (safety) is skipped. The first draft said every `TIPC^` side is a safety link, which would have skipped all PLC links. | Matching `TIPC^` by prefix only. |
| 11 | lint | The object checks of Plan H are named **Lint** (`iecode.lintObjects`, settings `iecode.lint.*`, collection `iecode-lint`), because the command `iecode.check` ("Check All Objects", runs XAE) already exists. | `iecode.checkObjects` next to `iecode.check` (first draft): two near-identical palette entries with different meaning. |
| 12 | A, C | Blame and staging read the file on disk. A dirty `iecode:` document has different line numbers, so lenses and stage commands are off for it. | Mapping unsaved edits (would need a diff of the buffer against the disk view per keystroke). |
| 13 | D, H | `core/unitIndex.ts` (`buildUnitIndex`) is shared: the graph analysis and the OOP lint rules both need a per-project index, and the editor index has the two flaws of decision 8. It also decides library handling per unit (pinned workspace edges use the compiled library, namespaces per unit). | Each plan building its own index. |
| 14 | C | Stage ships first; Discard (destructive) follows in its own PR. Index writes are narrowed, not atomic (git has no compare-and-swap for one entry); the CHANGELOG says so. | Claiming atomicity. |
| 15 | A | Blame refines the **old** last / first line of a section (head and tail runs), not only the current boundary lines, using the commit's own line numbers from the porcelain output. | Refining only the current boundary lines (first draft; would fail its own append test). |

## Check against a real project (2026-11-18)

The plans were checked read-only against a real XAE 4024 project (one PLC project, one system project, 1057 commits; only numbers are recorded here, no names). What changed because of it:

- **Plan G** was rewritten: 10 % of the links name array elements or `^` sub-paths that are not symbols of their own in the `.tmc`, so a naive lookup would report about 90 dead links where there are 2; the size rule was dropped (`Size` is not `BitSize / 8`); an `<UnrestoredVarLinks>` block full of old links must be ignored. Details and numbers in Plan G.
- **Plan D** got the qualified task call and the 141 visualization files as cases.
- **Plan H** got a baseline: 359 object files, zero violations of the structure rules (so a finding on a healthy project is a rule bug).
- Confirmed unchanged: the area / symbol model of `linksOfFile` and `parseTmc` (139 ms for 7 MB), two tasks, `TcTTO` calls. Not yet measured: blame and history speed on a repository of that size (1057 commits; one sampled object file has 4); Plan A and B check it in their manual steps.

## Eng review (2026-11-18)

Method: every plan claim checked against the real code (`model.ts`, `xml.ts`, `core/git.ts`, `lang/index.ts`, `lang/providers.ts`, `core/iotree.ts`, `core/workspace.ts`, `extension.ts`), then two independent second opinions (a GitHub Copilot model and two Claude Opus reviewers, one per half of the set). All findings were triaged; accepted ones are in the plans. Most important corrections:

| Where | Finding | Fix |
|---|---|---|
| C | `encode()` gives an added member a random GUID and drops LineIds | XML splice instead (decision 4); edit units per property declaration / accessor; LineIds lists |
| C | non-atomic index write, dirty raw XML editor, non-UTF-8 bytes, mixed EOL, autocrlf double conversion | narrowed race plus documented, both editors checked, bytes round trip, `--no-filters`, Discard split off |
| A | boundary repair only looked at the current first/last line; `log -L` used working-copy line numbers | head and tail runs, commit's own line numbers (decision 15) |
| A, C | `execFile` ignores an `input` option | write to the child's stdin |
| B | log neighbours are not parent and child (merges); window edge reports "added" | compare with first parent, walk newest to oldest, member Id as identity |
| B | config rename grouping used two key segments (symbols have three) | per-category entity identity, re-diff paired entities |
| D | `resolve()` re-tokenizes the whole file per identifier | `resolveAt`, GVL name map, perf test with library objects |
| D | contract members exempt but unreachable: their callees reported | contract members of a reachable owner are reachable |
| D | CFC/SFC bodies invisible; interface inheritance; library identity; encrypted files; more roots (`call_after_init`, OPC, linked GVLs) | non-ST word scan, closure, `unitIndex`, completeness flag, configurable root pragmas |
| F, G | `TIPC^` prefix test would skip every PLC link; `systemProjects()` returns only IO-only projects | `parsePlcLinkSide`, `systemProjectOf` |
| G | type rule on parent matches; channel-twice ignores bit ranges; refresh triggers | exact matches only, ranges, source saves trigger a re-run |
| H | `parseXml` loops for ever on an unterminated `<?`; `Itf` methods have no Implementation; duplicate of existing missing-member diagnostic; fix coordinates | H Task 0, Itf exemption, rule dropped, `space`/`version` contract |

Not accepted: none rejected outright. Uncertain and left to the implementer with a named check: whether TwinCAT calls the base `FB_init` implicitly (rule `fb-init-super` is a hint, off until the documentation is read); whether XAE writes `TypeA` on every link (G Task 1 Step 1).

## Open questions (do not block A to F; each has a default)

1. **Which rules does TwinCAT itself enforce for double links?** Measured on the real project: 18 input channels feed 2 or more PLC variables (normal), 2 output channels have 2 or more sources. G's defaults stand (info for inputs, warning for outputs); still check the output case in XAE before G ships.
2. **Variables, not only objects:** unused GVL / FB variables are out of scope for E; the graph (D) keeps member granularity so it can follow.
3. **`iecode lint` for CI:** see decision 1; decide after H's rules have run on real projects for a while.
4. **Object moves between files in the history (B):** needs the changed-file list of every commit and a cross-file pairing; left out until someone needs it.

## Review focus for the whole set

Every plan's own Review Focus section lists its cases. The two that decide whether the features are trusted:

1. A boundary line of a section (first and last line) is attributed to the commit that changed its text, not its XML tag (A; known failure of an existing extension).
2. No object that a task reaches through an interface, an override, `FB_init` or a visualization is ever reported as unused (D, E).
