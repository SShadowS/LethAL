# PR-381 pre-commitment: survivors in a run with tests v3 could not run at baseline carry a caveat, headline included (R1197)

Status: pre-commitment (coord PR-381, lethal-preproc, 2026-11-23), after the spec-adversary (1 BLOCK, 8 SHOULD-FIXes and
2 NITs, all taken below), before the build.
Rulings ([kraken, from the mantra; owner may overrule]):
- q-20261123T112833-7e045797: a survivor whose only possible killer is a refused test is unknown;
- q-...f6b3d303 and q-...41be73a7: the interim is a CAVEAT with the count, shown wherever a survivor count or score is shown,
  the headline included;
- the trigger is the whole test suite of the run (orchestrator, 2026-11-23), with the codeunit figure as a named hint.
The static call-graph reach that will narrow it is PR-383. Evidence:
- `/coord/handoff/PR-347/bc68874/` (9 false survivors on DO 68874);
- `/coord/handoff/PR-347/refused-codeunit-survivors.md` (with its correction);
- `/coord/handoff/PR-381/predicate/result.md` (y3 scoring);
- `/coord/handoff/PR-381/legs.txt`.
Related: [[R1197]], [[R1160]].

## Why
A test that al-runner v3 could not run at baseline can kill nothing, and v3 has no coverage for it. A mutant that only such a
test would kill reads `survived`. On DO 68874, 9 of 47 tail survivors were killed on BC by one test that v3 refused at
baseline (a NotRun cascade). Until PR-383 can say which survivors such a test reaches, every survivor of the run is flagged,
and no verdict changes.

## Which tests count: "not run at baseline" (adversary S2, S3)
- **Counted:** a baseline row v3 did not run to a verdict:
  - refused (`notRun`, `NotRun: out-of-scope: ...`, kept or cut alike);
  - timed out;
  - stopped (R658 `baselineStopped`, or a deadline).
  These tests would run on BC, so they hide kills only because of v3.
- **Not counted:** a test that ran and FAILED or errored with its own assertion or runtime error at baseline. It is red on BC
  as well, which is ordinary mutation testing.
- **The source of truth:** a NEW report field, `v3NotRunAtBaseline: string[]` (qualified test names), filled from the baseline
  rows the backend classes as refused, timed out or stopped. It is not `unsupportedTests`, which holds every non-green test
  (in c3: 237 errors, mostly refusals, and 7 fails).
- **The existing per-survivor hint is reused (S1):** the backend's `[v3-refused-test-nearby]` tag (`refusedNearbyNote`), whose
  source is `baselineRefused`. Confirm's noted and unnoted sampling reads it (`confirm.ts isNotedSurvivor`), so it is not
  changed. The report counts survivors carrying the tag as `sharingACodeunit`.
  - One source note: `baselineRefused` is cleared when a codeunit moves to method isolation, so the hint can be absent there.
    The trigger never depends on it.

## The rule (a pure function of the report, adversary S4)
`notRunSurvivors(report)`: when the backend is al-runner-v3, `v3NotRunAtBaseline` is non-empty, and the report has at least
one `survived` or `known-survivor` row (B1), then the caveat applies to every such row. It returns
`{ survivors, notRunTests, sharingACodeunit }`.
- **The callers:** `buildReport`, `explain`, every export, `confirm-merge`, the `--changed-since` list, and the offline c3
  script.
- **An older report** with no `v3NotRunAtBaseline`: readers say "tests not run at baseline: not recorded in this report"
  wherever they print survivors. They never print silence.
- **Kills, errors and no-coverage rows are unchanged.** No verdict changes anywhere.
- **Coverage off (S8):** with `al-runner-v3-coverage-off`, `sharingACodeunit` is omitted (covering tests are not real
  coverage). The caveat still applies.
- **Resume (BLOCK B1):** a batch carried by `--resume` runs no baseline. Its tests' baseline rows are read from the store, from
  the prior run that recorded the batch. If they cannot be read, the field holds what this session measured, and the caveat
  says "tests not run at baseline: unknown for N carried batches". It is never absent. The same goes for history-lent rows.
- **bcdev is OUT OF THIS PR'S SCOPE, not unaffected (S7; the orchestrator's ruling).** A survivor is unknown for the same
  reason on BC: BC's permission and TestPage refusals never run either. The owner's answer ties "unknown" to the reason, not
  to the backend. bcdev follows right after this PR as coord PR-385, with its own pre-commitment, and the tables gate
  re-recorded by R332's procedure (one refused TestPage test, with survivors).

## What the report and outputs carry
- **A new Caveat** `survivors-beside-unrun-tests`, with its `CAVEAT_INTERPRETATIONS` entry. It says what it means, that the
  count is an upper bound on the at-risk survivors, and how to narrow it (PR-383, or BC).
- **New optional `SessionReport` fields:** `v3NotRunAtBaseline` (names) and `survivorsBesideUnrunTests` (`{ survivors,
  notRunTests, sharingACodeunit? }`). Both are absent on bcdev and when the caveat does not apply. Optional, so the
  root-required list does not change.
- **The sentence,** in the report's raw number format, as `renderConsole` prints numbers (no thousands separators):
  "8618 survivors, all in a run with N tests v3 did not run at baseline (refused, timed out or stopped; such a test kills
  nothing, so a survivor only it would kill is unknown); K carry the nearby tag (a hint, not a bound)".
  - On a narrowed or `--tests-only` run it says "in this session's tests", not "the test app".
- **Every surface that prints a survivor count or score (S5):**
  - `renderConsole`: the `score:` line, the R844 "had they run, it would read X to Y" range (its upper bound gets the
    caveat), the withheld-kills line, and the banner;
  - `lethal explain`;
  - `confirm-merge`: `totals.score` and `provenance` ("N survivors, M of them measured on BC"). Only survivors still
    measured by v3 are counted there. The confirmation schema version bumps;
  - the `--changed-since` survivor list (`renderChangedLineSurvivors`), the pull-request surface;
  - the Stryker export (`mutation-elements.ts`). Its HTML score is the third-party bundle's, so the text goes into each
    survivor's `describe()` description, the new fields go into `config.lethal`, and one line goes into `lossesFor`;
  - campaign: `compare` and `freeze` print no survivor count or score, so nothing is added there.
    `mutant-equality.ts` does not compare the new per-report fields.
  - No MCP or other API exists, and the progress events print no score.
- **The ripple list:**
  - `report.ts`: type, builder, banner;
  - `report-fold.ts`, for the baseline rows' not-run class (from `baseline-batch-finished`);
  - `bun scripts/generate-schemas.ts`;
  - `tests/schemas.test.ts`: root-required unchanged; the older-reports expectation (no field);
  - `CAVEAT_INTERPRETATIONS`, and the counts in `interpretation.test.ts` (38 to 39) and `report.test.ts`;
  - **explain (S6):** `EXPLAIN_SCHEMA_VERSION` 34 to 35, a frozen `schemas/explain-v35.schema.json`, and the agent-contract
    text in `tests/agent-contract.test.ts`;
  - `report-equality`'s snapshot is a bcdev fixture with survivors and `unsupportedTests`, so it must stay byte-equal: a free
    scope-negative check;
  - the committed gift-card sample (bcdev) validates unchanged and is not regenerated.

## Predictions
- **c3** (DO, current, the flag off), through `notRunSurvivors` applied to c3's report plus its baseline rows from
  `events.ndjson` (the offline script in the build; c3 predates the field):
  - `v3NotRunAtBaseline` is the not-run subset of the 244 non-green tests (its exact count is pinned by the script before
    the build; the 7 FAILS are not in it);
  - `survivors` 8618 (c3 has no known-survivor rows);
  - `sharingACodeunit` 4886 (the tagged survivors, measured);
  - the caveat present.
- **The v3 gate:** no leg gains the caveat. From the control reports (`legs.txt`): RC has 2 non-green tests (A0 and B0,
  refusals) but 0 survivors; no other leg has a non-green test. The carry gate (`itest:alrunner-v3-carry`, 5 survivors) is
  checked the same way before the build (NIT), and stated in an amendment.
- **BC gates:** no move in this PR (bcdev is PR-385's scope).
- **PR-347's leg TC** (not yet recorded): TC-on and TC-alone have survivors beside T0 (refused), so they gain the caveat;
  TC-off has none. PR-347 re-predicts after this lands.

## Tests (red before the build), each surface asserted by its EXACT new sentence with its numbers, plus a negative twin
1. v3: a not-run test and a survivor: the caveat, the counts, the sentence.
2. v3: a not-run test and only kills and errors: no caveat, every verdict unchanged.
3. v3: survivors and only a FAILING baseline test (not not-run): no caveat.
4. bcdev: test 1's fixture with only the backend flipped: no caveat in THIS PR (its scope; PR-385 then turns this test
   around).
5. The hint: a tagged survivor counts in `sharingACodeunit`. Use a codeunit name with a dot ("X. Y Tests"), split at the
   LAST dot.
6. A fully carried `--resume` (B1): the caveat from the store's baseline rows; with none readable, the "unknown" sentence.
7. Known-survivor rows only (`--skip-known-survivors`): the caveat applies.
8. Coverage off: the caveat without `sharingACodeunit`.
9. Each surface (banner and score line, the R844 range, explain, confirm-merge, changed-since, the Stryker description and
   `config.lethal`): the sentence present; and absent on test 3's fixture.
- Each guard gets a red-going test in each direction.

## Amendment 1 (2026-11-23, the interface for PR-386, agreed with lethal-code; during the build)
- **The injection point:**
  `notRunSurvivors(report, reaches?: NotRunReach)`, where
  `NotRunReach = (test: string, mutant: Readonly<SessionReport["mutants"][number]>) => boolean | "unknown"`.
  - `test` is the qualified name as in `v3NotRunAtBaseline`.
  - A survivor is counted when SOME not-run test reaches it, and `"unknown"` counts as reaching, so a supplied function may
    only over-approximate.
  - The default is `ALWAYS_REACHES` (`() => true`): the whole-suite trigger above, so this PR's behaviour is exactly the
    spec's.
- **PR-386 (lethal-code), the static call-graph reach,** supplies a closure over the run's `MutantManifestEntry` list and the
  target and test sources it parses, keyed by the full site key. It resolves objectType, the object id, triggerName,
  procedureScope and the R318 arm names from the manifest, so a page and a codeunit with the same id never collide. A row
  missing from its index returns `"unknown"`. objectType and the id are NOT added to report rows; this PR stays the caveat only.
- **A consumer holding only a report.json** (no manifest, no sources) can build no PR-386 closure. It falls back to
  `ALWAYS_REACHES`, which is safe, and is this PR's default. That is by design, not a gap.
- **Tests:** a `reaches` returning false for every pair gives `survivors` 0 and no caveat; one returning `"unknown"` counts
  the survivor. Both are red-checked.

## Amendment 2 (2026-11-23, the Opus build review of 31f712b55: 1 BLOCK, 4 SHOULD-FIXes; before any gate)
- **The resume BLOCK above (B1) rested on an out-of-date premise, settled from the code.** Since R-646c there is no
  whole-batch replay: every non-skipped batch goes through `scoreBatch`. A reused R192 snapshot pushes its stored rows,
  `failureMessage` included, and `baseline-batch-finished` is emitted with no condition. Carrying and history lending
  happen after that emit. A baseline with a stopped test is never stored, so it runs again.
  - So carried and lent survivors always sit in a folded batch. The store read and the "unknown for N carried batches"
    sentence are dropped.
  - The batches that emit no baseline event (stranded-only, compile failure, quarantine) hold no survivors.
  - Test 6 becomes a `runSession` `--resume` test with a reused snapshot holding a refused row: the field and the caveat
    on the carried survivors.
- **The not-run class, widened (review B1 and S1).** Also counted:
  - a `deadline-exceeded` baseline row;
  - any row carrying the not-run marker (`V3_NOT_RUN_SUFFIX`, matched anywhere in the message), including "al-runner-v3
    contract:" notRun rows;
  - a baseline transport failure (the test never ran, and it would run on BC).
  - Not counted: the R-236c TestPage-scan skip, which BC refuses too (PR-387's scope, bcdev), and an ordinary fail.
- **Readers use the stored field (S2):** renderConsole, changed-since and the Stryker export build the sentence from
  `survivorsBesideUnrunTests` when it is present. They recompute only for confirm-merge's subset view and for older reports.
- **explain on an older v3 report (S3)** carries the "not recorded" marker, as every other reader does.
- **Tests (S4):** the withheld-kills line is asserted with withheld kills present, and each guard's red check is recorded in
  `/coord/handoff/PR-381/redcheck.md`.
- **NITs fixed:** the changed-since figure says "of the run"; confirm's "N survivors" counts known-survivors; "1 test" is
  singular; `NotRunView.backend` is required; report.ts no longer calls the static reach "planned".
- **PR-386 is closed as "no gain"** (lethal-code: on DO the closure equals `ALWAYS_REACHES`; a 2.6% ceiling). The app-level
  caveat is final (the owner agreed). Whether the unused `reaches` hook is removed is decided with lethal-code (PR-387) and
  stated in the result.
- **The predictions are unchanged in direction.** c3's `notRunTests` may grow above 237 if c3 has deadline, marker-only or
  transport-failure baseline rows. The offline script re-counts, and the result states the final figure.
