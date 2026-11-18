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
  - All 18 `other` rows.
  - The first 40 of the other 276, ranked by the sha256 of the site key. No seed to choose.
  - Scope: the sample's 57 lines (`--lines`), so other mutants on those lines also run. They are recorded but not counted.
  - Tests: the 12 test codeunits that hold a sampled killer (`tests-only.txt`, 287 tests).
- **The run:**
  1. **v3 hang check:** the exact scope on al-runner-v3 (`--workers 1`). It must show 0 timeout-killed before bc4 is leased.
  2. **bcdev:** one `lethal run --backend bcdev --stop-hung-sessions` on bc4, with a fresh store, on PR-67's `do-app` and
     `do-test-new` (the source is the same as x3's).
     - A baseline hang (R1113) that stops the run is reported, not retried.
  3. **Restore:** DO, above the instrumented version.
  4. **Release:** the lease is released only when bc4 is healthy.
- **The classes, per sampled row, joined to the bcdev report by the full site key:**
  - **K:** BC `killed`, by any test.
  - **N (not measured on BC):** BC did not kill it, and the arm-M killer was red, refused or not run at BC's baseline, or the
    mutant is `no-coverage`, `error` or missing from the report.
  - **S (a candidate false kill):** BC `survived`, and the arm-M killer was green at BC's baseline. For each S row, the
    killer's test source is read by name for this question: does its failing path depend on state that an earlier test of its
    codeunit left (x3's `afterTest`), or on anything else that differs between v3 and BC? Each S row is named with that answer.
- **Predictions (measured = K + S):**
  - **P3:** at least 90% of the measured `x3Failure` rows (the 40) are K.
  - **P4:** at least 80% of all measured rows are K. The 18 `other` rows are where H1's risk is largest, because their killer
    is not the test that failed in x3.
  - **P5:** no S row's kill rests on state from an earlier test of its codeunit. Arm M ran each test alone (isolation
    `"method"`), and so does bcdev (R890), so an earlier test's state cannot reach the killer on either side.
  - N is not a prediction. It is counted and named, and if N is more than half the sample, P3 and P4 are reported as "not
    measured".
- **What follows:**
  - **All of P3 to P5 hold:** this is evidence for P5 of PR-144 on real code. A default-on change still needs its own
    pre-commitment and a ruling.
  - **P5 breaks:** H1 is real on DO. The option stays off, and a roadmap item names the rows.
  - **P3 or P4 breaks without a P5 break:** each S row's cause is filed (a v3 vs BC difference), and the option stays off until
    those causes are read.

## Predictions (part a)
- **P1:** BC `killed` the `Sevens` mutant, by `A1_OneSeven`: the recheck's kill is confirmed.
- **P2:** BC `killed` the `SevensB` mutant, by `B1_OneSevenAndMarks`: the recheck's `error` is conservative.
- **If P1 breaks** (BC does not kill `Sevens`): the recheck's only kill here is false on BC, the option stays off, and PR-144's rules
  are revisited.
- **If P2 breaks:** recorded and explained; it does not make a recheck kill false.
