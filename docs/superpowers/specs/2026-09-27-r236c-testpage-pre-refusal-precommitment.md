# Pre-commitment: R-236c TestPage pre-refusal on the live gates

Written and committed before any live run of the R-236c build (a4a151f). Nothing above
OUTCOME changes after a run.

## Container and protocol
`itest:tables` and `itest:chunked` run on Cronus284 (control app 1.0.0.20, sandbox-data pair
resident), under a coord lease; before them, Cronus284's orphaned probe lease (holder
SShadowS-PC:160544, pid confirmed gone) is cleared with `lethal force-reset-lease`, epoch
before/after recorded. `itest:bcdev` runs on Cronus28 (control app 1.0.0.20) under a coord lease
when free.

`itest:tables` cannot pass end to end at HEAD: `EXPECTED` holds 397 sites while GH-24's arm
generates 407 (docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md, section 5 and
OUTCOME). So it runs as GH-24's protocol RUN 1: `EXPECTED` set to section 5's figures in the
working tree only (407 sites, 301 / 68 / 18, score 301 / 369, groupedCalls 382, warmKills 13), the
committed `tables.baseline.json` KEPT. The edit is a patch in the scratchpad, reverted with
`git apply -R`, never committed.

## Predictions (every one BLOCKING)
1. `itest:tables` run 1: `assertVerdictTable` passes in full: `unsupportedTests` empty;
   `testPageRefused.tests` exactly `["Data Tests.PageActionComputesNonZero"]`; caveat
   `tests-testpage-refused` present and `tests-testpage-unsupported` absent;
   `baselineTests.failing` 0; `baselineGreen` false; counts 301 / 68 / 18; no quarantine; no
   `TestPageScanError`; `assertSessionLiveness` passes. The run then stops in
   `assertMatchesBaseline` with EXACTLY ten "present in after but missing from before"
   differences, all `Data Reach Ops`, and ZERO differences of any kind on the 377 existing mutants
   (verdict, killingTest, coverageFiltered, errorClass). The four `Data Value Card` /
   `Data Value Source` mutants stay `no-coverage`.
2. In that run's store, `Data Tests.PageActionComputesNonZero` has one `test_results` row per
   session, outcome `skip`, message starting "not run: LethAL refused this test before sending it".
3. `itest:bcdev`: PASS, 3 / 12 / 4, groupedCalls 15, warmKills 0, `vacuous`; no `testPageRefused`.
4. `itest:chunked`: PASS, both legs 17 / 7 / 2 with identical verdicts and killingTest, control
   warmKills 9 / groupedCalls 33, chunked 5 / 57; its reports carry
   `testPageRefused.tests == ["Data Tests.PageActionComputesNonZero"]`.

A verdict or field difference on any existing mutant, a count other than predicted, a
`TestPageScanError`, or a `tests-testpage-unsupported` caveat on a sandbox-data run is a BLOCK,
filed before anything else moves.

## OUTCOME
Run 2026-09-27 from `lethal/lane-bugs` at 84011ae (build a4a151f unchanged). Raw output kept outside
the repo in `%TEMP%/r236c/gate-{tables,chunked,bcdev}.txt`.

**Setup.** Cronus284 under coord lease attempt 010, then Cronus28 under attempt 054, one gate at a
time, both released. Cronus284's orphaned lease, before: `held by SShadowS-PC:160544:probes (live
token, op kind none, expires 2026-09-27T13:39:06.17Z, ALREADY EXPIRED)`. Pid 160544 did not exist.
`force-reset-lease`: `serverGeneration c78d51e705464afa973997e406ec065e ->
ef315cc0fd4c4c26974c0d6f1a79a4c8, epoch -> 377`. Doctor after: `lease: no lease held`, every
check passed. The EXPECTED patch was applied for `itest:tables` only and reverted with
`git apply -R` right after; `git diff packages/runner/itest/tables.itest.ts` was empty.

**Prediction 1: HELD.** Printed: `verdicts: killed=301 survived=68 noCoverage=18
baselineGreen=false score=0.8157181571815718 untargetedTriggers=0 declarativeSites=1`. No
`quarantined:` line, no `TestPageScanError`. The run passed `assertVerdictTable` (every R-236c
assert, the counts), `assertSessionLiveness`, `assertTriggerKillAndSurvive`,
`assertTrioTextEvidence` and `assertFilterLiteralEvidence`, then stopped in
`assertMatchesBaseline` (tables.itest.ts:1677), as predicted. The four `Data Value Card` /
`Data Value Source` mutants (M0384 to M0387) are `no-coverage`.
One gap in the evidence: the gate printed the thrown error as a bare `Error` plus its stack, with
NO message, so the diff lines were not in the output. The per-mutant check was therefore redone on
the same run's persisted rows (store run 9, 387 mutants), feeding them through the gate's own
`normalizeForComparison` and `diffMutants` against the committed `tables.baseline.json` (377).
Result: `10 diff(s)`, all ten `present in "after" but missing from "before"`, all `Data Reach Ops`
(Classify: empty-block x2, return-value, conditional-boundary x2, void-method-call,
remove-assignment; Touch: empty-block, shift-integer, remove-assignment). Zero differences of any
kind on the 377 existing mutants, and no `missing from "after"` line. No mutant has verdict
`error`, so `errorClass` (the one compared field the store does not carry) is null on both sides.

**Prediction 2: HELD.** Store run 9 (the gate's first session; the second never started) has
exactly one row for the test: codeunit 79310, method `PageActionComputesNonZero`, outcome `skip`,
duration 0, `session_id` null, message `not run: LethAL refused this test before sending it,
because it has a reachable call that may open a TestPage (Data Tests.PageActionComputesNonZero
calls ValueCard.OpenView on TestPage "Data Value Card").` The run's other 67 baseline rows are
`pass`.

**Prediction 3: HELD.** `itest:bcdev` on Cronus28: `verdicts: killed=3 survived=12 noCoverage=4
baselineGreen=true` on both sessions, `protocol-invariant probes PASS`, `bcdev itest: PASS`
(groupedCalls 15, warmKills 0 and `vacuous` are gate asserts). The gate does not print
`testPageRefused`; its two store runs (10, 11) hold zero `skip` rows and zero rows whose message
starts `not run: LethAL refused`.

**Prediction 4: HELD.** `itest:chunked`: `[unbounded] killed=17 survived=7 noCoverage=2 errors=0
warmKills=9 groupedCalls=33`, `[chunked 2] killed=17 survived=7 noCoverage=2 errors=0 warmKills=5
groupedCalls=57`, `chunked itest: PASS` (the per-mutant verdict and killingTest identity is a gate
assert). The gate neither prints nor keeps its reports, so the `testPageRefused` half was read from
one `lethal run` with the chunked leg's exact scope (`--only src/DataMain.Table.al
--max-methods-per-call 2`, selector ids 79399/79398/79397, scratch `--db`, `--out`) on Cronus284
under the same lease. It reproduced the chunked leg (17 / 7 / 2, warmKills 5, groupedCalls 57) and
its report carries:
- `testPageRefused.tests`: `["Data Tests.PageActionComputesNonZero"]`
- `validity.caveats`: `baseline-red, narrowed, tests-testpage-refused, session-warm,
  kills-without-assertion` (no `tests-testpage-unsupported`)
- `unsupportedTests`: `[]`; `validity.baselineTests`: total 68, failing 0; `baselineGreen` false
- banner: `TESTPAGE REFUSED, NOT RUN: 1 test(s) were not sent.` and `SCOPE: ... with 0 of 68
  baseline tests failing and 1 refused before sending (TestPage), not run`

No wedge on either container. No baseline was re-recorded and no test or figure was edited.
