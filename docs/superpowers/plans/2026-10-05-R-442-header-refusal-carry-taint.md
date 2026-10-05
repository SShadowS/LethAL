# R-442 plan (r2)

## Part 1: confirmed, and wider than r1 said
A site that a run numbers no ordinal for, but a later run does (or the other way round), moves its twins'
ordinals, so a recorded key can name another mutant. Probes (survey.md, r2 section) confirm four ways:
header refusal (the R442 case), the `"A|B"`/`"B|C"` name collision, `preproc-undecided` (sol's commented
`#if`), and `--only` (run 1 `--only Good.al`, run 2 full: A reads Good's `known-survivor`, no edit at all).
Edits that add or remove sites stay R391's (open). Equivalence marks stay R443's: R-442 does not make them safe.

## The coarse tuple
`coarse = astHash|operatorName|operatorMajor`, one shared function in project.ts that replaces
`looseIdentityTupleOf` everywhere (R307's current-run `carryDisabled` included). Why it is a superset of every
twin, whatever `|` the names or scopes hold: the tuple string is `hash|name|scope|op|major` and a key adds
`|ordinal` only above 0. The hash is hex, operator names come from the built-in registry and hold no `|` and
are never all digits, and the major is an integer. So two equal strings share the first field (hash) and,
read from the right, the operator and major (an ordinal tail cannot pose as a major: the field before it would
then be an all-digit operator name). A unit test pins the premise over every registered operator name.
Key formation is unchanged. Cost: it is wider than r1's loose tuple. One file refused at a time costs other
files' mutants on average 10.7 of 387 (max 31) on sandbox-data, 33.9 of 269 (max 66) on sandbox-probes, 14.7 of
80 on sandbox-coverage-probe, 0 on the small fixtures (loose: 0.1, 2.3, 0). Paid only while a site is hidden,
plus one remeasure after.

## What each run records: `runs.carry_hidden` (JSON, one new column)
`{"tuples": [...], "files": [...]}`, written by a store setter right after `generateMutationSet`.
- `tuples`: coarse tuples of sites the run generated but numbered nothing for: header-refused files (as today)
  and sites dropped by `--lines` / `--changed-since`.
- `files`: sorted paths of files hidden whole whose sites cannot be listed exactly: outside `--only` /
  `--exclude` (never walked), `preproc-undecided` (walked, but under an "undecided" semantic context that counts
  both arms' declarations, so a typed operator can miss a site the decided build emits), and files no selector
  var fits (xmlport, query). This is the fail-closed sentinel, narrowed: a file hidden in BOTH runs moves no
  ordinal, so carry from run P to run C needs only `files_P == files_C`. A persistent undecided file or a
  repeated `--only` therefore costs nothing; a change costs one run without carry.
- NULL = recorded before R442, or the run died before generation: untrusted. Fresh and clean runs record
  `{"tuples":[],"files":[]}`. Other R-307 refusals reserve exact entries, and the operator filter cannot move
  another operator's ordinal: neither is recorded.

## Readers
- History (`priorSurvivorKeys`): P NULL, or `files_P != files_C` -> no keys and a warning naming the reason
  (new callbacks, like the scheme one). Otherwise drop P's rows whose coarse tuple (from `ast_hash`,
  `operator_name`, `operator_major`) is in `tuples_P`. `tuples_C` stays on `filterHistory`'s `carryDisabled`.
- Resume: `getRun` returns the field; `resolveResume` refuses a NULL run by name (both `--resume` and
  `--resume-run`, like R325). At the FINAL `resumeState` construction (after `identityOrdinalsOf`, where today
  the current set REPLACES the index's), set `carryDisabled = tuples_C ∪ tuples_P` whenever resuming, and refuse
  by name there if `files_P != files_C`. That gates per-mutant carry and `batchCarriesEntirely`'s whole-batch
  replay (both read `carriedVerdictFor`). Stranded skips stay ungated (R53/R307 ruling).
- verify: copies the source run's value verbatim through its own `createRun` path (NULL stays NULL).
- Fix R307's warning sentence "the next run without this refusal carries them normally".

## IDENTITY_SCHEME stays 9
Keys are formed as before. Old scheme-9 runs can still poison, but their column is NULL, so they carry nothing:
one full re-run per project, without staling marks files (a bump would).

## Ripple
Store: column, migrate entry, setter, `getRun` field, `priorSurvivorKeys` filter and callbacks. Orchestrator:
record the two lists in `generateMutationSet`, setter call, resume union and refusals, warning codes,
loose -> coarse (`RefusedFile.looseTuples` renamed; it never reaches the report stream). selection.ts:
`isCarryDisabled` reads coarse. verify: copy. Tests: refusal-sites.test.ts's pinned project.ts function list.
No SessionReport, event schema or report field changes.

## Tests (identity-refusals.test.ts; red-check each by reverting the one named piece)
Coverage fixture first: SurviveBackend's baseline coverage must name every procedure the tests expect scored
(Table 50100 `Compute`, plus `Other` below). The oracle for "not carried" is always `carried !== true` AND the
mutant id in the backend's activate log, never `survived` alone.
1. Bad/Good history, same fixture holds a control: Good also has `Other`, a distinct body. After run 1 assert the
   stored `tuples` is non-empty. Run 2 (newline, history): Bad's 3 executed; `Other`'s mutants `known-survivor`.
   Red: drop the row filter (Bad carried); drop the setter (NULL: control loses its skip).
2. `"A|B"`/`"B|C"` (sol's names), same flow. Red: build the filter from the loose tuple.
3. Commented `#if` (sol #2): run 1 A undecided; run 2 comment removed -> no history carry, A executed, warning
   names A. Control: comment kept in run 2 -> Good carries. Red: drop the `files` comparison.
4. `--only`: run 1 `--only Good.al`, run 2 full -> A executed. Control: run 2 same `--only` -> carries. Red:
   leave out-of-scope paths unrecorded.
5. `--lines`: run 1 full, run 2 lines on Good only -> Good executed. Red: drop the lines tuples.
6. Resume (sol #3): run P refuses Bad-X; resume with Bad-X repaired and a new Bad-Y (other body) refused. Bad-X's
   and Good-Y's mutants executed, and the resume deploys (no whole-batch replay). Red: today's replacing line.
   Plus: resume after an undecided file is fixed is refused by name.
7. Legacy NULL: seed a finished run with survived rows, scheme 9, matching symbols, coverage mode and test app,
   column NULL. History skips nothing and warns; `--resume` and `--resume-run` both refuse by name. Red: NULL
   read as empty lists. Also: a fresh store's first run records empty lists; a seeded NULL run with verdict rows
   (the crash window) carries nothing.
8. verify, through `runVerify`'s real writer, with a source holding non-empty lists, empty lists and NULL: each
   copied exactly. Red: drop the copy (the non-empty case goes NULL).
9. Changed expectation, intended: the existing "history" test's last step (Bad removed) now remeasures the 3
   twins (P recorded their tuples); only the run after that skips them. Same for the "resume" control.
10. Premise: every registered operator name has no `|` and is not all digits.

## Part 2
`importsOf` (refusal-sites.test.ts): an external specifier yields an edge with origin `external:<spec>` (typed
or not), so the EMIT allow-list rejects any unlisted external value import; `import type` stays allowed.
Dynamic `import(...)`: read string literals and no-substitution templates (`isStringLiteralLike`); any other
argument yields an edge with origin `unclassified-dynamic-import`, which the allow-list rejects. Red-check
each, planted in project-emit.ts with Edit and restored: `import { readFileSync } from "node:fs"`,
``import(`node:fs`)``, `import("node:" + "fs")`. Control: `import type` from node:fs stays green.
`require(...)` is out of scope (ruling).

## Changes since r1
- sol #1 (`|` collisions): loose tuple -> coarse tuple, with the proof above and test 2.
- sol #2 (`preproc-undecided`): `files` list and test 3; the audit also found `--only`/`--exclude` (test 4),
  `--lines` (test 5) and no-carrier files.
- sol #3 (resume overwrite): union at the final `resumeState`; test 6 with two refusal tuples.
- sol #4 (dynamic imports): templates read, unclassifiable targets rejected, three red-checks.
- sol #5 (oracles): carried/activate oracle, same-fixture control, coverage fixture, verify with three values,
  legacy test with every other gate matching, changed expectation (test 9), fresh `[]` and crash-window NULL.
- Marks: R443, not claimed. `require`: out of scope.
