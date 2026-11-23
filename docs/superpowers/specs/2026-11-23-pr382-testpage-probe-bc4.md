# PR-382 pre-commitment: can BC observe a kill by a RelationFieldNo-refused TestPage test? A probe on bc4 first

Written 2026-11-23, before any server call. Task PR-382 (the owner's ruling q-20261123T112833-7e045797: apply the
refused-test check to PR-365's kept codeunits before anything is reported from them).

## Why a probe, not the sample (measured, read-only)
- **The population:** of PR-365's 1,504, the 214 that survived in t1 while a refused test covers them in y3
  (`/coord/handoff/PR-382/strata.tsv`): 185 through codeunit 68984's refused tests, 29 through both 68975's and 68984's,
  0 through 68975's alone. 162 are in Page files.
- **The blind spot:** all 7 refused tests (3 in 68975, 4 in 68984) are in bcdev's `tests-testpage-refused` list on bc4
  (PR-357's bc17 run, `events.ndjson`): LethAL does not send a test that may open a TestPage. A bcdev sample would read
  every at-risk mutant `survived` on BC because the would-be killers never run: an empty-versus-empty "0 false survivors".
- So first: can BC run these tests at all, outside LethAL's fenced session?

## The probe (one test, then at most one mutant)
- **The test:** `CDO Variant Setup UI Tests.U_FieldPickerHopIntoAnUnpinnableKey_TakesTheValueTyped` (codeunit 68984).
  - **Guard (orchestrator):** no company created or deleted, no Commit. Checked from the source: the test is
    `AutoRollback`; `Initialize` seeds the setup row only; the company-creating library helper is called only by the Azure
    tests. If a step shows otherwise, stop and report.
- **Step 1, the unmutated test PASSES first:** run that one method through the dev endpoint's own test runner
  (`bcdev_test_run`, bc4, port 7449), with whatever DO build bc4 holds and no active mutant (`LC Mutation Active` empty,
  read by id).
  - **Pass:** the runner executes TestPage tests; go to step 2.
  - **Refused, unsupported, or the test does not run:** the dev runner cannot observe these kills either. Take option (b):
    record in R1187 that the refused tests' kills are not observable on BC through LethAL or the dev runner, and stop.
  - **Runs and FAILS unmutated:** stop and report (a baseline that is not green cannot show a kill).
- **Step 2, one mutant (only after step 1 passes):** a hand-built artifact: LethAL's instrumented build of DO with the
  selector changed to report ONE mutant active, published to bc4 over the dev endpoint, the same test run, then bc4
  restored to the build it held. The mutant: one of the 214 whose y3 covering tests include this test, chosen by seed 382
  among those. Its own pre-commitment amendment (the build, the restore, the version rules) is written before step 2 runs.
  - **Reading:** BC fails the test under the mutant = a refused test kills it, so the t1 survivor is a false survivor.
    BC passes = no kill by this test.
- **Then the sample** (the 214 stratified as above, plus the owner's kept-survivor stratum from PR-381's predicate on c3
  once it exists, expected 0 refused-test kills) is pre-committed separately, by the same path, if step 2 works.

## Rules
- A lease on bc4 for every server call (standing yes for probes); doctor before and after; released only when healthy.
- Apps read by id only (R433). No source text leaves /coord; names and counts only.
- Not a measurement: a static reach argument (option (c)).
