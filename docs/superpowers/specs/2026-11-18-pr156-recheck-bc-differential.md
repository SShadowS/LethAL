# PR-156 pre-commitment (measure only): the BC differential for PR-144's isolated recheck (its P5)

Coord PR-156 (lethal-code, 2026-11-18). PR-144's recheck (opt-in, default off) turns a v3 withheld kill into a kill when the kill
reproduces with its test run alone. Its spec's P5: no default-on until BC confirms the recheck's kills. Fixture: PR-162's
`sandbox-recheck` and `sandbox-recheck-tests` (invented code, ids 76000-76099). Leg RC records v3's side; its page is
`docs/gates/alrunner-v3.md` §"Leg RC".

## Part (a): the fixture on BC
- **Where:** bc2 or bc3, under lethal-code's own lease. The publish is not covered by `bc-linux-setup.ts`, so it needs the owner's
  yes: q-20261118T191953-72a792ca. Nothing runs before it.
- **How:**
  1. Build both projects against that server's symbols (`alc`), publish the target and the tests app by content.
  2. Run one `lethal run --backend bcdev` with `--project fixtures/sandbox-recheck --tests fixtures/sandbox-recheck-tests`, a fresh
     store, `--stop-hung-sessions` and selector ids inside 76000-76049.
  3. Afterwards uninstall (data deleted) and unpublish both apps, the tests app first.
- **The v3 hang check:** leg RC already ran this exact scope on v3, with 0 timeout-killed (`/coord/handoff/PR-162/rc-confirm.log`).

## What is compared (the `lethal.remove-assignment` mutant of `C := '7'` in each procedure, by full site key)
| mutant | recheck (leg RC, recorded) | prediction for BC |
|---|---|---|
| `Sevens` | `killed` by `A1_OneSeven` | **`killed` by `A1_OneSeven`**: it asserts `Sevens(1) = '7'` directly, and nothing earlier in its codeunit feeds it. BC confirms the recheck's kill. |
| `SevensB` | `error` (rule (e) holds it back: `B2_SeesTheMark` passes in a codeunit run and fails alone) | **`killed` by `B1_OneSevenAndMarks`**: B1 asserts `SevensB(1) = '7'` itself. The recheck's `error` is then the conservative side: a kill it withholds, never a false kill. |

- **What this fixture does and does not test.**
  - It tests that the recheck's one kill (`Sevens`) is real on BC.
  - It does NOT contain P5's harder shape: a kill whose ONLY killing test depends on state an earlier refused test set. Here B2's
    dependence on `Marked` is not on SevensB's killing path, because B1 kills first.
  - So this part can confirm a recheck kill. It cannot show the false kill H1 warns of; part (b) samples that on real code.
- **`A0` and `B0` on BC:** they `Evaluate` a 10-NUL text into a Decimal, then `Error` when it does not parse. BC's answer is not
  predicted; it is recorded (red or green) and decides only the baseline-red caveat on BC.

## Part (b): a sample of DO's 294 recovered kills on bc4
- **Needs its own owner yes:** q-20261118T191953-697aec50. If it is allowed, its sample and predictions are pre-committed in an
  amendment here, before it runs.

## Amendment 1 (coord PR-170, lethal-code, 2026-11-18): part (b)'s sample, rule and predictions, before any run
- **The owner's yes:** q-20261118T191953-697aec50 (allowed). The run uses bc4 under lethal-code's own lease. DO 30 is instrumented,
  then restored above the instrumented version as in PR-155. DO's source and the reports stay under `/coord/handoff/PR-170/`.
- **The population:** PR-144 arm M's `killed` rows (`/coord/handoff/PR-144/m.report.json`), joined to x3's withheld-kill rows
  (`/coord/handoff/R-984/x3.run.report.json`) on the full site key (file, line, operator, startIndex, endIndex): 294 rows, all
  `killReproduced`. In 18 of them, the first line of arm M's killing failure is not x3's withheld failure (`other`). In 11 of
  those 18, the killer is not among x3's covering tests.
- **The sample (`/coord/handoff/PR-170/sample.ts`, output `sample.tsv`):** 58 rows.
  - All 18 `other` rows: a different first failure line from x3's. This does not show that a different test killed: x3's
    withheld row does not name its failing test.
  - The first 40 of the other 276, ranked by the sha256 of the site key. No seed to choose.
  - Scope: the sample's 57 lines (`--lines`), so other mutants on those lines also run. They are recorded but not counted.
  - Tests: the 12 test codeunits that hold a sampled killer (`tests-only.txt`, 287 tests).
- **The run:**
  1. **v3 hang check:** the exact scope on al-runner-v3 (`--workers 1`). It must show 0 timeout-killed before bc4 is leased.
  2. **bcdev:** one `lethal run --backend bcdev --stop-hung-sessions` on bc4, with a fresh store, on PR-67's `do-app` and
     `do-test-new`.
     - The app's `.al` tree is byte-identical to x3's.
     - `do-test-new` differs from x3's tests by its `app.json` version and one extra codeunit, outside `tests-only.txt`.
     - A baseline hang (R1113) that stops the run is reported, not retried.
  3. **Restore:** DO, above the instrumented version.
  4. **Release:** the lease is released only when bc4 is healthy.
- **Checks before any row is classified. Each one stops the count, named:**
  - the bcdev report's `sourceSha256` is `8e2db184…`, its `identityScheme` is 48 and its `preprocessorSymbols` are empty;
    - **Corrected while the bcdev leg ran, before any row was classified.** This line first said `84fb7d1f…` (x3's and arm
      M's). The hash covers `app.json` as well as the `.al` files.
    - PR-67's `do-app` differs from x3's source only in `app.json`'s version (30.0.20775.33549, bumped for PR-155's DO
      restore; measured by diff). PR-155's bcdev and v3 reports both carry `8e2db184…`.
    - **A second correction, after the bcdev leg and before any row was classified.** The check stopped by name: the run
      carries `69fbb10d…`. PR-155's DO restore rewrote `app.json` at 19:05:41Z, after PR-155's runs, so `8e2db184…`
      was the `app.json` state before that, not the one this run saw.
    - **Measured with LethAL's own `readTargetSource` and `hashSourceSnapshot`:**
      - `do-app` as it is hashes to `69fbb10d…`;
      - the same snapshot with only `app.json` replaced by x3's hashes to `84fb7d1f…`, x3's hash exactly.
    - So the `.al` tree is x3's, byte for byte, and the check is `69fbb10d…`. Evidence: `/coord/handoff/PR-170/srchash.txt`.
  - every sampled site key is in the bcdev report;
  - every sampled verdict is `killed`, `survived`, `no-coverage` or `error`;
  - "the killer at BC's baseline" (green, red, refused or not run) is read from the bcdev run's baseline events
    (`bc/events.ndjson`), and those events are present.
- **The classes, per sampled row, joined to the bcdev report by the full site key:**
  - **K:** BC `killed`, by any test.
  - **N (not measured on BC):** BC did not kill it, and either the arm-M killer was red, refused or not run at BC's baseline, or
    the row is `error`.
  - **S (a candidate false kill):** BC did not kill it, and the arm-M killer was green at BC's baseline. This includes
    `no-coverage`. For each S row, record:
    - whether the killer was in BC's `coveringTests` for the row. If not, the cause to name is coverage, not state;
    - whether bcdev's call ran another test before the killer. Under a mutant, bcdev runs all of the mutant's covering tests in
      one `RunMutantMany` call, which is one session. Each test method is its own `Codeunit.Run`, so the database and the test
      codeunit's globals reset between methods, but session state does not: SingleInstance codeunits, WorkDate and
      GlobalLanguage;
    - from the killer's test source, read by name: does its failing path depend on such session state, on x3's `afterTest`,
      or on anything else that differs between v3 and BC?
  - For each K row, record whether bcdev's call ran a test before the killer.
- **What this sample can and cannot show about H1.**
  - In 56 of the 58 rows, x3's `afterTest` does not cover the mutant, so bcdev never runs it under the mutant, and arm M never
    did. For those rows, this run does not test H1. It tests whether v3's run-alone kills agree with bcdev's model.
  - **M0153 and M0156** (arm-M codes) are the two rows whose `afterTest` covers the mutant. They are the only rows that bear on
    H1, and they are reported by name.
  - `afterTest` is in the killer's codeunit in 52 rows, and in another codeunit in 6 (`sample.tsv` columns `afterCodeunit`
    and `afterCoversMutant`, resolved through x3's `testMethods`).
- **Predictions (measured = K + S, per stratum):**
  - **P3:** at least 90% of the measured `x3Failure` rows (the 40) are K, with at least 20 measured.
  - **P4:** at least 80% of the measured rows of the whole sample are K.
  - **P5:** M0153 and M0156 are K.
  - **"Not measured", per stratum:** if more than half of a stratum (`x3Failure`, `other`) is N, its share is reported as "not
    measured". P3 fails to be measured below 20 measured rows. The 18 `other` rows are always reported on their own. In 11 of
    them the killer failed x3's main baseline, so they are the rows most likely to land in N.
  - N is counted and named. It is not a prediction.
- **What follows:**
  - **P3 and P4 hold:** evidence that v3's run-alone kills agree with bcdev's per-mutant model on DO. It is not evidence on H1,
    except for the two rows of P5. A default-on change still needs its own pre-commitment and a ruling.
  - **P5 breaks:** the row is read as above. If its kill rests on state from an earlier test, H1 is real on DO, the option
    stays off, and a roadmap item names the row.
  - **P3 or P4 breaks:** each S row's cause is filed (coverage, session state, or another v3 vs BC difference). The option
    stays off until those causes are read.
- **Revised before any run** after the spec-adversary review (2026-11-18): the class checks, S including `no-coverage`, the
  per-stratum rule, P5 narrowed to the two rows that can bear on H1, and the `afterCodeunit` column resolved through
  `testMethods`.

## Predictions (part a)
- **P1:** BC `killed` the `Sevens` mutant, by `A1_OneSeven`: the recheck's kill is confirmed.
- **P2:** BC `killed` the `SevensB` mutant, by `B1_OneSevenAndMarks`: the recheck's `error` is conservative.
- **If P1 breaks** (BC does not kill `Sevens`): the recheck's only kill here is false on BC, the option stays off, and PR-144's rules
  are revisited.
- **If P2 breaks:** recorded and explained; it does not make a recheck kill false.
