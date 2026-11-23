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

## Step 1's first run (2026-11-23 11:39-11:40Z, `/coord/handoff/PR-382/probe/result.md`): stopped
- The dev runner DID execute the TestPage test, and it FAILED unmutated: "The part with ID = 1589389838 was not found on the
  page." (at `OpenCardOnFirstLine`). By the rule above: stop. Step 2 was not started.
- A deviation: "no op in flight" was read from doctor, not `LC Mutation Active` by id (see amendment 1 on why that read is
  not needed for a plain build).

## Amendment 1 (2026-11-23, before any publish): a plain DO build on bc4, step 1 again, then an exact restore
Under the owner's standing yes ("lethal bcdev runs on DO ... including instrumenting and then restoring DO", on a leased BC).
- **bc4's present state, read by app id under a lease (11:42-11:44Z, doctor ok before and after; `/coord/handoff/PR-382/amend/`):**
  DO `30.0.20780.19322` (a version LethAL minted: an instrumented build left by the last bcdev run), published Dev, installed;
  DO Test `30.0.0.1`, Dev, installed; LethAL Control `1.0.0.29`. The resident DO package was downloaded as the restore copy
  (8,655,233 bytes, sha256 `4bd73e99...`; a full package, 592 `.al` files against 589 in a plain build, so republishable).
- **Why the first run may have failed:** the installed DO is an instrumented build, and the test app (30.0.0.1, built against
  plain DO) did not find a page part. Unknown until measured; a plain build settles it.
- **The probe build:** DO from `/work/src/DO/Cloud` (DO's own source, read-only; no fetch), copied to `/coord/handoff/PR-382/`,
  with ONLY its `app.json` version changed, to `30.0.20780.19323` (one above the resident, so the publish is an upgrade and
  not refused as a downgrade). Compiled with `alc` against bc4's symbols (PR-67's `cache-bc4`). No LethAL instrumentation, so
  it has no selector: no mutant can be active in it, which is why `LC Mutation Active` need not be read for this step (the
  control API has no reader for it; reading the table by hand is not attempted).
- **The order on bc4 (one lease for the whole sequence; doctor before):**
  1. Publish the probe build over the dev endpoint (sync). The test app stays installed, as PR-67's 30.0.20774.41536 publish
     showed; read both versions back by id.
  2. Step 1 again: the same one method through `bcdev_test_run`.
     - **Pass:** the runner executes TestPage tests on a matching build. Step 2 needs its own amendment (the mutant artifact).
     - **Fails the same way:** the test is red on BC with a plain matching build: kills through it cannot be read on BC.
       Take option (b) in R1187.
     - **Fails otherwise:** stop, report the text.
  3. **The exact restore to the present state:** unpublish the test app FIRST (unpublishing the target cascades to its
     dependents), then unpublish the probe build, then publish the downloaded resident package (`30.0.20780.19322`), then
     republish DO Test `30.0.0.1` (`/coord/handoff/PR-67/build/do-test-new.app`, its manifest checked: id and version match the
     installed one). Read all three back by id; they must equal the recorded state. Doctor after.
- **Stops:** any HTTP 401, any call over its timeout (a hang), an OutOfMemory publish refusal, or a read-back that differs:
  stop at once, keep the lease, and file one `kraken coord ask --kind bc-restart` with the state reached. No second attempt
  before kraken answers.

## Amendment 2 (2026-11-23, before any publish): the restore is an upgrade, never a downgrade
- **Why:** amendment 1's restore republished the resident `30.0.20780.19322` after the probe's `30.0.20780.19323`. BC refuses
  a lower version of an app whose data was kept on uninstall, so that restore needs `deleteData`, which deletes DO's data in
  bc4's company. Not done.
- **The restore instead (LethAL's own advice when a run leaves an instrumented build):** the downloaded resident package
  holds its full source (592 `.al` files, the instrumentation included). Extract it to `/coord/handoff/PR-382/restore-src/`,
  change ONLY its `app.json` version to `30.0.20780.19324`, compile with `alc` against the same symbols, and publish it as an
  upgrade over the probe build. Nothing is unpublished; DO Test `30.0.0.1` stays installed.
- **The read-back:** DO reads `30.0.20780.19324` (the resident's content one version up), DO Test `30.0.0.1`, Control
  `1.0.0.29`, by id; doctor clean. The restored build is recorded as "the resident content at one version up", not as the
  identical package.
- Steps 1 and 2 of amendment 1's order, and its stops, are unchanged.

## Amendment 3 (2026-11-23, before the run): red on BC, or a runner that cannot host the page part?
- **Measured under amendments 1 and 2 (`/coord/handoff/PR-382/run/result.md`):** the refused test failed unmutated on a plain
  DO build matching the test app, with "The part with ID = 1589389838 was not found on the page." bc4 was restored to the
  resident content at `30.0.20780.19324`.
- **The discriminator:** `CDO Variant Setup UI Tests.U1_CreateLineFromLinesPart_LinePersisted` (codeunit 68984), NOT a
  refused test: it opens the same card (`OpenEdit`) and drives the same `EMailTemplateLines` part. It passed at baseline in
  c3 (al-runner). Guards checked from the source: `AutoRollback`, no Commit, no company created or deleted.
- **The run:** one lease, doctor before. One `bcdev_test_run` call on bc4's restored build with both methods: U1 and the
  refused `U_FieldPickerHopIntoAnUnpinnableKey_TakesTheValueTyped`, so both read the same build in the same session kind. No
  publish. No mutant is active: doctor shows no control operation in flight, and LethAL clears the active row at teardown
  (the control API has no reader for `LC Mutation Active`; this stands in for the read by id, as before).
- **The reading:**
  - **U1 passes, the refused test fails as before:** the runner hosts that part; the refused test is red on BC as built.
  - **U1 fails with the same "part ... not found":** the runner's session cannot host that page part for any test; the
    refused test's result says nothing about the test itself (R1170's client-session work).
  - **U1 fails otherwise, or the refused test now passes:** stop and report the texts.
- Doctor after; released only when healthy; the stops of amendment 1 apply.
