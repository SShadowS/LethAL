# R-307: one bad file is skipped and named, not a whole-run abort (r3)

Base: `lethal/lane-code` at `134c2cda` (master `19b70fc5` merged). Items: `docs/roadmap/R307.md` and
`R374.md` (closed by Task 1), with R299, R305, R308. Owner rule: no crash first. r3 answers
`H:/lethal-coord/reviews/R-307-plan/rulings-r2.md`; see "Changes from r2" and "Changes from r1" at
the end.

## The idea

Every per-file throw in schemata depends on ONE file's source and specs. So `generateMutationSet`
runs the writer's own per-file steps once per file, as a trial, before the file joins `files`. A
file whose trial throws the new typed error `FileRefusedError` is refused whole. It never enters
`planArtifacts`, `assignMutantIds`, a batch or a verdict. Any other exception still aborts the run,
so an unforeseen bug never becomes an excluded file. The trial and the writer call ONE extracted
function, `instrumentOneFile`, so they cannot drift. The writer keeps every throw; one that fires
after a clean trial is a new LethAL bug and still aborts.

Identity ordinals move from per batch to per RUN (R374, Task 1). The refused files' twins are
reserved in that one numbering, so no surviving mutant can take a refused mutant's key.

**A refused file still runs.** It is published uninstrumented: `prepareBatchProject` copies it as it
copies every file with no mutant, and tests that call it still run it. It only loses its mutants.

## 1. Throw sites

Per-file refusals are decided in `generateMutationSet`, in the file loop, after dedup, the
`--operator`/`--lines` filters and `canCarryMutationSelectorVar`, and before `files.push`. No mutant
id or ordinal exists yet. "All of that file" holds by construction: the whole `InstrumentedFile` is
never pushed. `producedInstrumentable` gains the file's operators only AFTER its trial succeeds, so
an operator whose only sites sit in refused files still trips the "deploys nothing" refusal.

| Site | Decision | Reason |
|---|---|---|
| `assertNoOverlap` (engine `printer.ts`) | per file, typed | Edits of one file's source only. |
| Injector unsupported kind + the three anchor throws (`compile.ts`) | per file, typed | One file's objects. |
| Latch no-owner + R303/R316/var-keyword throws (`injectReachLatches`) | per file, typed | One file's members. |
| `objectHeadersOf` no header; `assertNoUnsupportedObjectMix` (R299); `attributeHeader` (`project.ts`) | per file, typed | One file. R299 stays open: it asks for per-OBJECT dropping. |
| "no reach grain" (writer) | backstop, untyped | Built from the same `ided`; no input reaches it. |
| Manifest object vs compiled/parsed declarations, both directions | whole run, before baseline | Section 4. |
| Gap-id collision (writer, across files) | whole run | A hash collision between two files; no one file is at fault. |
| Duplicate basename (`prepareBatchProject`) | whole run, unchanged | A layout conflict: every file is copied flat, refused or not. |
| `dedupeSpecs` throws | whole run | An operator bug, not a file property. Called outside the `try`. |
| Generation refusals (`--only`, `--operator`, `--lines`, snapshot) | whole run | Caller input. |

**`FileRefusedError`** lives in `@lethal/engine` (the lowest package; `assertNoOverlap` is there)
and extends `Error` directly. Structured fields, filled by each throw site: `file`, `shape`
(`"overlap"`, `"unsupported-kind"`, `"latch-owner"`, `"no-anchor"`, `"no-header"`, `"object-mix"`,
`"site-before-header"`), `objects?: {type, id, name}[]`, `lines?: [first, last]`. The message text
is kept for the thrown error and is NEVER copied into a report.

## 2. Report: the refused row, the diagnostic, the scope

`ExcludedSites` (`excluded-sites.ts`) gets reason `"instrumentation-refused"`. `skipped`
(`NotInstrumentedFile`) does not fit: no reason field, and its caveat would be false here.

- **`detail` is a formatted diagnostic (I5).** `formatRefusal(err)` builds it from the structured
  fields only: `<shape> in <file>: <fixed sentence per shape>; objects <type>:<id> "<name>", ...;
  lines <first>-<last>`. The `type:id` form never occurs in AL, so no header line is copied. A
  test pins the exact string per shape, and asserts no trimmed source line of the refused file
  longer than 12 characters appears in any `detail`.
- `kinds` comes from `describeObjectKinds`, so R308's gap applies. Not fixed here.
- **Scope beside the score.** `reliability` is `narrowed` (or `narrowed-degraded`) when any row has
  the new reason, never `full`. `scoreDescribes` gains "; N file(s) refused, M site(s) not
  mutated", so `renderConsole`'s SCOPE line prints it beside the score. New Caveat
  `"files-refused"` with its `CAVEAT_INTERPRETATIONS` entry. Warning `instrumentation-refused-files`
  names each file.
- **Ripple:** `events.ts` (`mutation-set-generated.refusedFiles?`, optional, present only when
  non-empty, so older streams stay valid), `report-fold.ts` pass-through, `excluded-sites.ts`,
  `report.ts`, `bun scripts/generate-schemas.ts`, caveat counts in `interpretation.test.ts` and
  `report.test.ts`; `schemas.test.ts` and `report-equality` run unchanged.
- **Versions.** `REPORT_SCHEMA_VERSION` stays 3 (its rule bumps for renamed, removed, re-meant or
  new required fields; this adds optional values). `EXPLAIN_SCHEMA_VERSION` 8 to 9 (R233 bumps on
  any widened value domain; `caveat` widens); freeze `schemas/explain-v8.schema.json`. IDENTITY_SCHEME
  bumps in Task 1 (section 3). **Race rule for both numbers:** R-214 holds IDENTITY_SCHEME 5 and may
  bump explain too; whichever of R-307 and R-214 merges to master second takes the next free number
  at its merge, regenerates, and says so in its merge commit.
- **No live sample regeneration.** No `SessionReport` field is added and no committed sample has a
  refused file. If `report-equality` moves anyway, stop and tell the orchestrator before any lease.

## 3. Identity

**Run-wide ordinals (R374, Task 1).** `generateMutationSet` numbers identity ordinals ONCE over
every instrumented file's deduped specs plus the reserved entries, and returns
`identityOrdinals: ReadonlyMap<key, number>`, keyed by `file, start, end, operator` (the key
`narrowFilesToSubset` already uses). `writeInstrumentedProject` takes it as a REQUIRED input, looks
every row up, throws if one is missing, and no longer numbers per batch. Scripts that call the
writer get the map from `generateMutationSet` (a required input, so none forgets it). The tuple
fields come from one new `project.ts` helper, `identityFieldsOf(spec, headerName)`, which the
writer's row build also uses: `astSubtreeHash`, `procedureNameOf`, `triggerNameOf`, operator name
and version, and the header regex's object name (`objectHeadersOf` + `attributeHeader`). Order:
file, start, then operator name, which is the order `assignMutantIds` gives the same specs.

**Reservation, exact case.** For a file refused as `overlap`, `unsupported-kind`, `latch-owner`,
`no-anchor` or `object-mix`, the header rule succeeded, so each deduped spec yields the exact tuple
the writer would give it. These are computed before the trial, from the spec set alone, and join
the numbering as reserved entries: they take a number and produce no row.

**Fail closed, header case (I3).** For `no-header` and `site-before-header` the writer's header rule
gives no name, and guessing one would be a new identity rule. So no reservation. Instead the run
records the refused file's LOOSE tuples (subtree hash, member, operator, major: no object name).
For that run, every mutant whose loose tuple matches: is not matched by history
(`filterHistory`), is not carried by `--resume`/`--resume-run` (`buildResumeIndex` consumers), and
takes no equivalence mark (`applyEquivalenceMarks`). Its key is still written, so the next run
without the refusal carries normally. Warning `identity-carry-disabled` names the refused file and
the count, and the refused row's `detail` says "identity carry disabled for N mutant(s)".

**What is stable (ruling confirmed).** Against a later run where the refused file instruments, every
surviving key is identical, twins included, in any batching. Against `--exclude Bad`, every
surviving row is identical, M-ids included, except a twin of a reserved entry, whose ordinal is
higher by the number of reserved twins before it: a lost match there only costs a re-run. M-ids
are per-batch labels and may shift.

**Scheme.** Run-wide numbering moves a key wherever batching split twins, so IDENTITY_SCHEME goes to
"the next scheme" (race rule, section 2). R325 then refuses previous-scheme keys on all four paths
by name.

**Which committed frozen baselines move: none, to be PROVEN offline in Task 1.** Measured on
`134c2cda`: every committed `*.baseline.json` gate and campaign baseline was recorded in ONE batch
(the campaign reports say `"batches": 1`; only `itest:alrunner`'s layout leg batches, at 7 guards,
and its baseline has zero duplicate keys, so no twin is split there). In one batch, run-wide and
per-batch numbering are the same numbering, and no gate fixture has a refused file (any refusal
aborts a run today, and every gate passes). The 31 to 78 duplicate keys in the `2026-08-03-do` and
`2026-08-08-r85` baselines predate R193 ordinals and are not touched. **Hard gate:** if Task 1's
offline proof finds ANY key that moves in a committed baseline, stop. That needs a pre-commitment,
an R332 re-record with the owner's yes, and a live gate. This plan does not go past that point.

## 4. Manifest objects against declarations (C2)

One function, `assertManifestObjectsDeclared(manifestKeys, declared, mapped, exempt)`, runs before
any baseline. `manifestKeys` are the batch manifest's `objectType:codeunitId` keys.
- **Direction A:** a declared key that has mutants but no line-map entry throws the existing
  "declares X but no line map was built" message. A declared key with NO mutant and no entry is
  refused on R298's path (`refusedByKey`, named once by `nameRefusals`), not thrown: it cannot
  affect a verdict. Real shape: R305's split-header file, today a whole-run abort when a test
  touches it. The `lookup` throw then cannot fire and is deleted.
- **Direction B:** a manifest key absent from `declared` throws ("a mutant is attributed to X, which
  the compiled app does not declare"), unless exempt.
- **The exemption rule:** a key is exempt only when the object is named in the run's coverage
  refusals, whose mutants already read `no-coverage` by a named refusal: `coverageRefusedObjects`
  (R298: inside a `#if ... #endif` object wrapper, or after one, so an inactive arm is not
  compiled), plus, on al-runner, the index's own refused and multi-object files (upstream #3713).
  No other absence is allowed.
- **bcdev** (`bcdev-backend.ts`): the index is built after compile and BEFORE publish
  (`indexArtifact`, `indexInstalled`). `declared` = `methodIndex.declaredObjects()` (compiled
  symbols). Fenced mode checks A and B against the line map; procedure (hub) mode checks B against
  `declared`; coverage `none` reads no coverage and skips the check.
- **al-runner** (`al-runner-backend.ts`): the index is built lazily after a test and from parsed
  source. The check builds it EAGERLY at deploy, before baseline, when coverage is on:
  `this.coverageIndex = await buildAlRunnerCoverageIndex(activeDir)`, then B against its parsed
  `declared`. A holds by construction there (the map and `declared` come from one parse).

## 5. When the run still refuses

Only when nothing is left to measure: at least one file was refused and no file is left to
instrument. A plain `Error` (exit 1, like the empty `--lines` refusal), naming every refused file
and its shape. Everything else runs, with the scope shown.

## Tasks

Build loop per CLAUDE.md (native parser if needed, `bun run typecheck`, `rm -rf packages/*/dist`,
`bun test` from repo root, `bunx biome check <touched files>`). No al-runner, no live BC. Each
red-check reverts one named line, pins the exact failing assertion, and restores. **Tell the
orchestrator before any `project.ts` commit** (R-214 edits it; the preproc lane is coord-only).
Merge master first.

**T1. R374: run-wide ordinals and the scheme bump** (schemata `project.ts`, `index.ts`; runner
`orchestrator.ts`, the writer's script callers).
- `identityFieldsOf`, `identityOrdinals` from `generateMutationSet`, the writer's required input.
  IDENTITY_SCHEME to the next scheme, doc comment: "keys move only where batching split twins".
- Test (a), the reviewer's case: codeunit "Twin" holding two identical `X := X + 1;` statements in
  one procedure (B, C), and table "Twin" with the same procedure and statement (Bad), batched with
  `maxGuardsPerBatch` so Bad is alone in batch 0 and B, C share batch 1. Keys are Bad 0, B 1, C 2.
  (Refusal half in T6.)
- Test (b), R374's case: twins in two batches get distinct keys; with history "one survived",
  `--skip-known-survivors` runs the other. Red-check for both: restore per-batch numbering in the
  writer; (a) gives B ordinal 0 and (b) skips the killed twin, each failing on the exact key.
- Four transition tests on test (b)'s key, pinned to `IDENTITY_SCHEME` and `IDENTITY_SCHEME - 1`,
  never literals: history skips nothing from a previous-scheme store, `--resume-run` and
  `--resume last` refuse it by name, marks from it are stale. Each has a current-scheme control that
  does carry.
- Literal-pin sweep, as R-318's Task 6A: `grep -rn "IDENTITY_SCHEME = \|identityScheme\"\?: *[0-9]"
  packages scripts fixtures docs CHANGELOG.md` and the report-equality snapshot.
  `fixtures/sandbox-harden/lethal.equivalent.json` gets the new scheme after an offline test proves
  every mark key is still produced by `generateMutationSet` on that fixture;
  `docs/using-lethal-from-an-agent.md` and `CHANGELOG.md` (every older store stops resuming, marks
  need re-setting). Committed reports keep the scheme they recorded.
- **Offline baseline proof:** a test that runs `generateMutationSet` + `planArtifacts` on every gate
  fixture (with the layout leg's 7 guards) and asserts run-wide keys equal per-batch keys. Any
  difference is the hard gate in section 3.
- Close R374 `done (<commit>)`.

**T2. `FileRefusedError`, typed throws, `formatRefusal`** (engine `printer.ts`, schemata
`compile.ts`, `project.ts`). Each existing throw test also asserts `instanceof`, `shape` and the
structured fields. Red-check: one site throws a plain `Error`; its `instanceof` assertion fails.

**T3. Extract `instrumentOneFile`; add the trial** (`project.ts` verbatim move; `orchestrator.ts`):
reserved or loose entries first, then `try { instrumentOneFile(...) } catch (e) { if (!(e instanceof
FileRefusedError)) throw e; ... }`, then `producedInstrumentable`, then `files.push`. Test: the
`sandbox-data` manifest is byte-identical before and after. Test (I4): two requested operators, one
with sites only in a refused file: the run refuses naming that operator. Red-check: add to
`producedInstrumentable` before the trial; no refusal.

**T4. One test per shape** (`packages/runner/tests/per-file-skip.test.ts`). Each asserts the exact
refused row (`file`, `kinds`, `sites`, `reason`, exact `detail`), that the good file writes, that no
manifest row names the bad file, and the no-source rule.
- Mix (R299): table + enum + codeunit in one file. Red-check: move `assertNoUnsupportedObjectMix` out
  of `instrumentOneFile`; no row, and the write throws `object-mix`.
- Injector: a plain codeunit plus an R305 split-header codeunit in one file. Step 1 confirms it
  throws on master; if not, report it and move it to T4b. Red-check: the catch tests a class that
  never matches; the exact `unsupported-kind` error escapes.
- No header: `namespace Demo; codeunit 50100 "A"` on ONE line (the regex anchors at line start).
  Site before header: the same line followed by a second object on its own line. Step 1 confirms
  both on master. These drive the fail-closed test in T6.
- An unforeseen error aborts: a stubbed plain `Error` propagates. Red-check: catch everything; a row
  appears.

**T4b. Sites no real AL reaches:** latch no-owner (`compile.test.ts` says no real statement sits
outside every member) and `assertNoOverlap` (operator specs are laminar; insertions are zero width).
Hand-built node and hand-built partial-overlap spec pair through `instrumentOneFile`: exact
`shape`, fields and `detail`. Red-check: throw a plain `Error` at that site.

**T5. Section 4.** (a) R305 split-header file, no mutant, declared: no throw, exact refusal reason.
Red-check: delete the refuse branch. (b) Direction A: declared key with a mutant and no entry
(hand-built): exact throw. Red-check: drop the mutant test. (c) Direction B: manifest key not
declared, not exempt (hand-built manifest): exact throw. Red-check: skip B. (d) Exempt: an R298
`#if` wrapped object with mutants in the arm the build compiles out: no throw. Red-check: empty the
exemption; it throws. (e) al-runner: the index is built at deploy (a call-counter fake), and (c) on
parsed declarations throws before any baseline call. Red-check: leave the build lazy; the counter
shows the baseline ran first.

**T6. Identity with refusals.** (a) T1's case with Bad refused (an enum added to its file): B and C
keep ordinals 1 and 2, so each key equals its own run-1 key, and the resume index carries only each
one's own run-1 verdict. Red-check: drop the reserved entries; B takes ordinal 0 (Bad's run-1 key)
and C takes 1 (B's run-1 key), failing on the exact keys. (b) Fail closed: T4's no-header file refused, with a twin by
loose tuple in a good file that survived in a prior run: history does not skip it, resume does not
carry it, no mark applies, and the warning names the count. Red-check: pass an empty loose set;
the twin is skipped. (c) `--exclude Bad` comparison: non-twin rows deep-equal, twin ordinals higher
by exactly the reserved count.

**T7. Layout and execution.** (a) `a/Dup.Codeunit.al` refused and `b/Dup.Codeunit.al` good: the run
still refuses with `prepareBatchProject`'s exact duplicate-basename message. (b) Fake backend
(`orchestrator.test.ts`): Bad's file sits in the batch dir byte-identical; a test calling Good and
Bad keeps Good's coverage; a test that calls Good's `P2` then fails in Bad makes P2's mutants,
covered only by it, `error` with the baseline note, never `survived`. Red-checks: exclude refused
files from the batch copy (the batch-dir assertion fails); let the fake pass the failing test (the
exact `error` assertion fails).

**T8. Refusal and scope.** All refused: exact message, exit 1. One refused, one good: runs,
`reliability` `narrowed`, SCOPE line holds "1 file(s) refused". Red-check: drop the refused term
from the reliability condition. Then the section 2 ripple, explain v9, and a fold test (a stream
without `refusedFiles` folds to today's bytes).

**T9. Measure the trial's cost.** No caching. RUST-03's W4
(`docs/superpowers/specs/2026-09-28-rust-03-precommitment.md`): `bun scripts/measure-peak.ts bun
packages/runner/src/cli.ts run --project "U:/Git/BC.History/BaseApp/Source/Base Application"
--dry-run`, three runs on master and three on this branch, same day. Gate in owner order: no crash;
median peak at or under 16,384 MB and at or under master's same-day median plus 5%. Wall time is
reported against master's (RUST-03 final: 5,001 MB, 493.72 s), not gated. Diff the outputs: any
refused BaseApp file is a finding; list it. A miss is filed and reported before landing.

**T10. Roadmap.** R307 `done (<commit>)`; a line on R299 (now a named per-file skip, open for
per-object dropping); file the no-header regex gap if T4 confirms it (re-check the next free id in
every worktree first); `bun scripts/roadmap-index.ts`.

## Changes from r2

- **Open question:** confirmed; keys stay stable against a later run where Bad instruments (s3).
- **C1:** R374 is Task 1: run-wide ordinals, IDENTITY_SCHEME to the next scheme (race rule),
  transition tests on `IDENTITY_SCHEME`/`IDENTITY_SCHEME - 1` over four paths with controls, the
  literal-pin sweep, an offline proof that no committed baseline moves, and a hard gate if one
  does. Reviewer's case and R374's case tested and red-checked (T1, T6).
- **C2:** manifest keys checked in both directions before baseline, with a written `#if`
  exemption; bcdev (built before publish, wording fixed) and al-runner (built eagerly at deploy)
  both specified; tests for both holes (T5).
- **I3:** no guessed reservation for `no-header`/`site-before-header`; carry, history and marks
  are turned off for loose-tuple matches and the report says so; real header-refusal shapes (T4, T6).
- **I4:** `producedInstrumentable` only after the trial; two-operator test (T3).
- **I5:** `detail` is `formatRefusal`'s diagnostic from structured fields, never the throw text.

## Changes from r1

- **C1:** reserved identity ordinals for refused files (now run-wide, above).
- **C2:** the unmapped throw stays for objects with mutants; the trial-time guard is removed.
- **I3:** duplicate-basename test; rows compared against `--exclude Bad`.
- **I4:** a refused file still runs; coverage and baseline errors pinned (T7).
- **I5:** no majority threshold; exit 1 only when nothing is left to measure.
- **I6:** reliability `narrowed`, SCOPE line, explain 8 to 9.
- **M7:** no caching; W4 measured against the RUST-03 ceiling.
- **M8:** typed `FileRefusedError`, never a generic catch; no source in `detail`; exact red-checks.

## Open questions

None.
