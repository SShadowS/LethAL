# R-658 fix plan r2 (Plan agent, Opus, read-only; saved by lethal-bugs)

Based on origin/master c67a89fc and lethal/r658 a6170d0a. It folds in the r1 deep review
(`review-plan-r1-deep.md`: I1-I5, M1-M11) and the orchestrator's rulings:
1. the baseline stop is ON by default for every user, with I1-I3, and named in the user docs and the change notes;
2. a NEW `confirm-stopped` cause, with the full ripple;
3. NO bc1 for the hang leg: everything is offline now, and the live BASELINE leg runs later on a restarted bc2 or bc3,
   with a STOP rule;
4. hub modes are R661.

## 1. Root cause
- `runViaTransport` wires the stop only when `stopHungSessions && mutantId !== ""`, and `runMany`'s unmutated warm
  replay only with the flag. So every unmutated RunMutant (the baseline, the R516 cold confirm, the C02-06 second run,
  the R206 replay) is abandoned at its budget.
- The op marker then stays `run` (D2): the release is refused with `op-in-flight`, and later acquires get
  `operation-orphaned`.

## 2. Changes
1. **`bcdev-backend.ts`:**
   - `runViaTransport`: wire the hook when `(mutantId === "" || cfg.stopHungSessions === true)`. Rewrite the R53
     comment.
   - `runMany`: `stopHungSessions: cfg.stopHungSessions === true || opts.confirmation === true` (I5).
2. **`run-mutant-transport.ts`, `dispatch`'s 408 branch (M5):** when `mutantId === ""` the text reads "…was stopped
   server-side so it would not strand the server". The control-app text stays.
3. **`orchestrator.ts`, `dispatchUnmutated`:**
   - Before `store.recordTestResult`, map OUR stop's `stopRefusal === "stopped-after-completion"` (R204) and
     `leaseInvalidReason === "op-stopped"` (I2) to `outcome "timeout"`, keeping the message. This happens before
     `classifyLeaseVerdict`, so `op-stopped` never reaches `handleBaselineLeaseOutcome`.
   - The `requiresUnsafeLatch` → `quarantineInFlight` branch is unchanged, plus the tombstone sentence (M7):
     - for `confirmed`: "LethAL's stop was confirmed and tombstoned the op, but BC never sent its 408; the
       control-app lease will read clean and must not be trusted until an NST restart";
     - for `unknown`: the same, with "may have tombstoned".
4. **`orchestrator.ts`, the `baseline-batch-finished` classification:** `"baseline-test-stopped"` when
   `outcome === "timeout" && stopState !== undefined`.
5. **`orchestrator.ts`, the cold confirm:**
   - **I1:** destructure `cause` from `runFenced`. When `cause === "stop-outcome-unconfirmed"`, or the confirm is
     `in-flight-unknown` with a `stopState`, call `quarantineInFlight` (with the tombstone sentence) and set
     `cause "stranded"`. This comes BEFORE the `lostAck "completed"` → `result-lost` branch.
   - **I3:** a branch before the final `else` (`unstable`): `stopState !== undefined && (outcome === "timeout" ||
     stopRefusal !== undefined)` gives `verdict "error"`, `cause "confirm-stopped"`, no quarantine.
   - A confirm's `op-stopped` is mapped the same way. Fix the "unreachable in practice" comment and the R514 comment
     (M9).
6. **`events.ts`:** `"baseline-test-stopped"` in `BASELINE_CLASSIFICATIONS`.
7. **`report-fold.ts`:** a `baselineStoppedTests` set.
8. **`report.ts`:**
   - Caveat `"baseline-test-stopped"`, with its interpretation; `MutantErrorCause` `"confirm-stopped"`, with its
     interpretation.
   - `SessionReport.baselineStopped?: { tests: string[]; reusedFromRun?: number }`. There is no `diagnosis` (M11);
     `reusedFromRun` comes from the R192 snapshot's `runId` (M6).
   - The banner.
9. **`explain.ts`:** `EXPLAIN_SCHEMA_VERSION` 18 → 19 (it enumerates causes; precedent R534 and R516).
10. **`doctor.ts`, `checkLease` (M8):** only for `opKind === "run"`: "restart the NST first (that is what ends a
    surviving session), then `lethal force-reset-lease`".
11. **No control-app change, and no version bump.**
12. **Hub modes:** R661, not covered here.

## 3. Semantics
- **A stopped baseline test** (an AL-stop 408, R204's completed-then-stopped, or our own `op-stopped`):
  - `timeout`, not green, `stop: false`;
  - the classification `baseline-test-stopped`, and not counted as unsupported, permissions or TestPage;
  - the caveats `baseline-red` and `baseline-test-stopped`;
  - no quarantine, and the lease releases.
- **A stop with no 408:** today's quarantine, plus the tombstone sentence.
- **A stopped cold confirm:** `error` with `confirm-stopped`. Its note: "confirming <m>: unmutated, the test also ran
  past its <N> ms budget and LethAL stopped it (BC's 408), so the <fail|timeout> under the mutant is not attributed to
  it (R658)". A confirm with a stop but no 408 becomes `stranded`, and is quarantined (I1).
- **The banner:** "BASELINE TEST STOPPED: <n> baseline test(s) ran past --baseline-timeout-ms (<ms> ms) and LethAL
  stopped them on the server (BC confirmed with its 408). They are not green and cover no mutant; the server was left
  clean. Raise --baseline-timeout-ms if a test is slow rather than hung." On reuse, add "(from run <id>'s reused
  baseline)". Then up to 10 names.
- **Ruling 1, where users are told** (the report has no release-notes field; its in-report surface is the caveat
  interpretation and the banner):
  - `CHANGELOG.md` [Unreleased] "Changed": "LethAL now stops a BASELINE test, a kill confirm or a warm replay that
    runs past its budget, even without `--stop-hung-sessions` (R658). The flag still governs mutants."
  - `README.md`: the TestPage paragraph.
  - The `cli.ts` `--stop-hung-sessions` help.
  - `docs/using-lethal-from-an-agent.md`: the consent bullet, and `confirm-stopped` in the cause list.

## 4. Tests first (each with the single revert that turns it red)
- **Wiring:**
  - W1: an unmutated run with the flag OFF has the hook.
  - W2: an unmutated run with the flag ON has the hook.
  - W3: with the flag OFF, a mutant has no hook.
  - W4: with the flag ON, a mutant has the hook.
  - W5: the hook carries its own attemptId and opSeq.
  - W6: `runMany({confirmation:true})` with the flag OFF sends `stopHungSessions: true`. Twin: a mutant `runMany`
    with the flag OFF sends `false`.
- **Baseline:**
  - O1: a stopped test is not green and not quarantined, and the next test runs.
  - O2: a confirmed stop with no 408 quarantines, with the confirmed sentence.
  - O2b: `unknown` says "may".
  - O3: stopped-after-completion is `baseline-test-stopped`, not unsupported.
  - O3b: a plain error stays unsupported.
  - O4: a timeout with no stopState is not `baseline-test-stopped`.
  - O5: `op-stopped` gives a timeout with no lease loss, and the session continues.
  - O5b: a `lost` verdict still reaches `handleBaselineLeaseOutcome`.
- **Confirm:**
  - C1: a stopped confirm is `confirm-stopped`, not unstable.
  - C2: a failing confirm stays unstable.
  - C3: a stop with no 408, with the fake reconciling `completed` (the tombstone), quarantines as stranded. Twin: no
    stop and a reconciled `completed` stays `result-lost`, unquarantined.
  - C4: stopped-after-completion at the confirm is `confirm-stopped`.
- **Report:**
  - R1: the fold, the caveat and the banner.
  - R2: `baseline-red` with no stopped test gives no field and no caveat.
  - R3: a reused snapshot keeps the classification and names `reusedFromRun` (snapshot rows are the full verdict
    JSON, so `stopState` survives).
- **Doctor:**
  - D1: `opKind run` gives restart-first.
  - D2: `publish` or `none` gives today's text.
- **Transport:**
  - T1: the baseline 408 text is neutral.
  - T2: the mutant 408 text is unchanged.
- **Fixture order:** F1: `orderCoveringTests` puts `Hang Tests.DrainQueueEmptiesTheQueue` before
  `Hang Z Baseline Tests.SleepsPastTheBaselineBudget`. Red if the codeunit is renamed to sort first.

## 5. Schema ripple (CLAUDE.md order)
1. `events.ts`, then `report-fold.ts`, then `report.ts` (type, builder, banner, both maps; basis "R658").
2. `explain.ts` v19.
3. `bun scripts/generate-schemas.ts`: it writes report-v3 (in place), explain-v19 and stream-v1. Keep the v18
   archive.
4. A `schemas/README.md` row.
5. `schemas.test.ts`: the root-required list is unchanged; add "v18 kept" and the older-reports expectation.
6. The counts in `interpretation.test.ts` and `report.test.ts`.
7. `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`.

The report schema stays report-v3 in place (an additive field; R516 precedent). If a ruling says v4, the ripple is
larger. The sample reports (`docs/campaign/2026-08-16-gift-card/rehearsal.report.json`,
`examples/credit-limit/demo.report.json`) still validate as they are. A strict live regeneration needs a BC server:
bc1 is allowed for that, or it can wait.

## 6. itest:hang BASELINE leg (built offline now; run later on a restarted bc2 or bc3, never bc1)
- **The fixture:** a new `fixtures/sandbox-hang-tests/src/HangBaselineTests.Codeunit.al`, codeunit 79451 "Hang Z
  Baseline Tests", `TestPermissions = Disabled`:
  - `SleepsPastTheBaselineBudget`: `Logic.DrainQueue(3)`, then `Sleep(25000)`, with no assert;
  - `ZPassesAfterTheStoppedTest`: an empty body.

  The tests app goes from 1.0.0.3 to 1.0.0.4; the target is unchanged.
- **Why DrainQueue (I4):** it is the only arm with no hanging mutant (R179 ceded its loop hang), and its EXPECTED_ON
  rows (lines 101-107) are all `killed`. With input 3, every mutant terminates.
- **Why the old legs do not move** (at the 120 s default the test passes in about 25 s and covers DrainQueue):
  1. `lethal run --dry-run` on sandbox-hang lists the same set as `hang.single.baseline.json`.
  2. F1: the existing killer runs first, and the new test can never kill.
  3. The extra baseline rows fall outside `manyDistinct`, and `singleRows`/`singleDistinct` stay equal.
  4. The limit: coverage is only seen live. The prediction is "no figure moves"; the cost is about 25 s per leg, plus
     up to 7 × 25 s per grouped leg.
- **The leg:** `runLeg("baseline")` with `baselineTimeoutMs 10000`, `testsOnly` `**/HangBaselineTests.Codeunit.al`
  and the operator `conditional-boundary`. Order: ON, SINGLE, BASELINE, OFF. M4: `stopHungSessions` is absent from both
  configs.
- **Assertions:**
  1. `SleepsPastTheBaselineBudget` is a `timeout` with "stopped the session" and "StopSession", its duration in
     [10000, 15000).
  2. `Z…` passes on the coverage path, with NO target member in its coverage (I4).
  3. Every mutant is `no-coverage`.
  4. `baselineGreen` is false.
  5. The caveats include `baseline-red`, `baseline-test-stopped` and `tests-narrowed`, and not `stop-hung-sessions`.
  6. `baselineStopped.tests` is exactly the one test.
  7. `unsupportedTests` is empty, and there is no `permissionsRefused`.
  8. There is no `quarantined`, and the quarantine dir is empty.
  9. There are no lease warnings.
  10. A probe acquire under the owner `hang-itest-baseline-probe` is granted, then released.
- **Teardown (M2):** on a non-STOP failure, wait until dispatch + 25 s + 15 s before the force-reset.
- **Predictions:**
  - the stop at 10000 ms, and the 408 under 11000 ms;
  - the release and the probe acquire are granted;
  - the leg takes under 3 min;
  - `RunMutantWithCoverage` stops as `RunMutant` did, with no recording state left behind.
- **The STOP rule.** It fires on any of:
  - no AL-stop 408 within 40 s;
  - a `quarantined` event;
  - the probe acquire refused;
  - `Z…` showing target coverage.

  When it fires:
  - exit 5, and no further leg;
  - no force-reset, no `RecoverOp`, no unpublish;
  - the wrapper holds that server's coord lease, heartbeat-only, until the owner's restart and re-setup.
- **The first run on the restarted server** re-proves the existing legs at tests app 1.0.0.4 and control 1.0.0.23:
  - ON: `EXPECTED_ON`, `warmKills 4`, `coldConfirmsOn 4`, `stoppedCallsOn 6`, 46 group calls, 40 distinct;
  - SINGLE: 24 / 9 / 5, with no re-record;
  - OFF as today.

  A verdict difference is a BLOCK. If only identity keys move, R332 applies.
- **Figures and docs:**
  - `HANG_FIGURES` gains `baselineBudgetMs 10000` and `baselineSleepMs 25000` (`gate-expected.ts` and the
    `hang.md` block);
  - the receipt's `sublegs` gains `stop-baseline`;
  - the `hang.md` leg and the OFF wording;
  - `servers.md`: hang unproven on bc2 and bc3 until then.

## 7. The gates the diff touches
- **Offline:**
  - typecheck and the unit tests;
  - `compile:fixtures`;
  - the schemas;
  - `itest:alrunner` and `itest:alrunner-v3` (they share the orchestrator and report code).
- **bc1 (normal gates are allowed there):**
  - `itest:bcdev` (every baseline now has the hook; prediction: no figure moves);
  - `itest:chunked` (the I5 replay);
  - `itest:lend` (R3 snapshot reuse, `--resume`);
  - recommended: `itest:tables`, `itest:harden`, `itest:bcdev-names` and `itest:bcdev-wrapped`;
  - not `itest:envtool`: it needs its external environment, so `itest:bcdev` stands in.
- **Deferred:** `itest:hang`, to the restarted bc2 or bc3.

## 8. Risks
- **False kill:** none. I1 closes the tombstone "completed" seam, and the tombstone guard refuses the stop at the
  boundary.
- **Stranded server:** a stop with no 408 is quarantined and named, but the lease reads clean to others. Across
  sessions the client refuses by name (`container-needs-recycle`), and the doctor says restart first.
- **Mutant-stop regression:** W3, W4, W6's twin and T2, and live the ON and SINGLE legs.
- **The unmeasured coverage-path stop (I4):** the leg's STOP rule.
- **Timing:**
  - 150 s against the ~362 s proxy ceiling, and the confirm at 210 s;
  - a `--baseline-timeout-ms` above about 330 s lets the proxy cut first: today's path, with an optional warning;
  - the drain is 5 s.

## 9. Review items: how each is handled
- I1: change 5, C3 and its twin.
- I2: change 3, O5 and O5b.
- I3: change 5, C4.
- I4: §6, F1.
- I5: change 1, W6.
- M1: assertion 1.
- M2: the teardown.
- M3: assertion 10.
- M4: the config check.
- M5: change 2, T1 and T2.
- M6: R3.
- M7: O2b.
- M8: D1 and D2.
- M9: the docs.
- M10: R661.
- M11: `diagnosis` dropped.

## 10. Open rulings, and the order of work
- **The report schema:** v3 in place (recommended), or v4.
- **Small?** No.
- **Merge before the live leg?** NOT recommended: the default-on wiring would put every user's baseline overrun on the
  unmeasured coverage-path stop (I4). The recommendation is ONE merge after the BASELINE leg passes.
- **The order of work:**
  1. Pre-commit the leg's predictions and STOP rule.
  2. Write the tests and red-check them.
  3. Make changes 1-12.
  4. The schema ripple.
  5. The docs.
  6. Build the fixture, compile it, and dry-run.
  7. The offline gates, then the bc1 gates.
  8. Review.
  9. On the restarted bc2 or bc3: the full itest:hang.
  10. Merge.
