# C02-08 `itest:agreement`: pre-committed predictions

Committed ALONE, before the first live run of `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`.
Every prediction below is a gate assertion: any one failing exits 1. A differing verdict or killer
is a BLOCK, never close enough.

Target: `Cronus28`. Fixtures: `fixtures/sandbox-harden` (`LethAL Sandbox Harden` `1.0.0.0`) and
`fixtures/sandbox-harden-tests` (`LethAL Sandbox Harden Tests` `1.0.0.0`), with the answer key read
from `fixtures/sandbox-harden-answers/src/HardenAnswerKey.Codeunit.al` (`LethAL Sandbox Harden
Answers` `1.0.0.0`). Control app: `LethAL Control` `1.0.0.19` (`MIN_CONTROL_VERSION`). Plan:
`docs/superpowers/plans/2026-09-26-C02-08-verify-agreement-gate.md`, Task 3 and Task 4. Fixture
table: `packages/runner/itest/harden-expected.ts` (`EXPECTED`, `ANSWER_KILLERS`) and
`docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md`.

Written from Task 0's re-checked facts
(`.superpowers/sdd/2026-09-26-C02-08-verify-agreement-gate/task-0-report.md`, F1 to F12, no
errata) and from an offline read of what each operator writes. Nothing here comes from a live run
of this gate.

## Before anything runs

- The config's `selectorIds` equal `{ selectorId: 79547, controlId: 79548, tableId: 79549 }`, the
  constant both full runs use (R261: verify reads the config, the full run reads the constant).
- The scratch suite's `[Test]` method names are unique across its codeunits (`killingTest` is
  compared by bare method name).

## The five mutants

By `(file, line, operator, procedure)` from `EXPECTED`, and by identity key read from
`packages/runner/itest/harden.baseline.json` (each suffix matches exactly one baseline row). All
five have the frozen verdict `survived`. All five are in batch 0, the batch of `A`'s last
`artifacts[]` entry, and each is found as exactly one mutant of `A` by `file`, `line` and
`operatorName`; its verify id is `<batchIndex>/<mutantCode>`.

| Role | file:line | operator | procedure | Identity key (suffix) | Frozen verdict |
|---|---|---|---|---|---|
| S1 | `src/HardenLogic.Codeunit.al:6` | `lethal.conditional-boundary` | `IsLarge` | `58ade303...\|Harden Logic\|IsLarge\|lethal.conditional-boundary\|1` | `survived` |
| S2 | `src/HardenLogic.Codeunit.al:14` | `lethal.remove-setrange` | `CountInCategory` | `2e821ee4...\|Harden Logic\|CountInCategory\|lethal.remove-setrange\|1` | `survived` |
| S3 | `src/HardenLogic.Codeunit.al:23` | `lethal.swap-find-direction` | `FirstAmount` | `33880a1a...\|Harden Logic\|FirstAmount\|lethal.swap-find-direction\|1` | `survived` |
| S4 | `src/HardenLogic.Codeunit.al:31` | `lethal.validate-to-assign` | `SetAmount` | `cf136219...\|Harden Logic\|SetAmount\|lethal.validate-to-assign\|1` | `survived` |
| S5 | `src/HardenLogic.Codeunit.al:40` | `lethal.remove-assignment` | `BonusFor` | `96a63130...\|Harden Logic\|BonusFor\|lethal.remove-assignment\|1` | `survived` |

S3's hash prefix `33880a1a` is shared with the `negate-guard` mutant on the same line (killed); the
operator name separates the two keys. S5's key is exactly the key of the one mark in
`fixtures/sandbox-harden/lethal.equivalent.json`.

## What each operator writes (read offline, not predicted)

C02-06's run-1 failure came from predicting a mutant from the operator's NAME. So each mutated line
below was produced by running the real operators (`generateMutationSet` on `fixtures/sandbox-harden`,
the spec's `before` span and `after.text`, spliced into the source line). The instrumented build
puts this text behind a runtime guard; the behaviour under the active mutant is the line shown.

| | original line | mutated line |
|---|---|---|
| S1 | `exit(Amount > 100);` | `exit(Amount >= 100);` |
| S2 | `Entry.SetRange(Category, WantedCategory);` | `;` (the call is removed) |
| S3 | `if Entry.FindFirst() then` | `if Entry.FindLast() then` |
| S4 | `Entry.Validate(Amount, NewAmount);` | `Entry.Amount := NewAmount;` |
| S5 | `Bonus := 0;` | `;` (the assignment is removed) |

## Step 1: source run `A`

`runSession(sandbox-harden, sandbox-harden-tests)` into a fresh `mkdtemp` store, with
`equivalenceMarks: await loadEquivalenceMarks(PROJECT_DIR)` and no `resume` key.

- Per mutant equal to `harden.baseline.json` (`diffMutants`, zero diffs). The baseline is read only;
  `assertMatchesBaseline` is never called.
- `assertHardenVerdicts` and `assertHardenMarks` pass.
- 21 deployed; killed 16 / survived 5 / no-coverage 0; `batches` 1.
- All five planted mutants in the batch of the last `artifacts[]` entry.
- No quarantine.
- `A`'s store is closed before verify opens it.

## Step 2: the scratch suite

`writeScratchSuite(TEST_DIR, ANSWERS_FILE, <scratch>/tests-with-answers)`: a copy of
`fixtures/sandbox-harden-tests` with `app.json` byte-identical, plus the answer key renumbered to
codeunit `79574 "Harden Verify Answers"`. It discovers exactly these 11 tests:

- `Harden Tests.IsLargeSeparatesSmallFromLarge`
- `Harden Tests.CountInCategoryCountsRows`
- `Harden Tests.FirstAmountReadsARow`
- `Harden Tests.SetAmountStoresTheAmount`
- `Harden Tests.AmountValidateDoublesIt`
- `Harden Tests.BonusForPaysOnlyAboveTen`
- `Harden Verify Answers.IsLargeAtTheBoundary`
- `Harden Verify Answers.CountInCategoryIgnoresOtherCategories`
- `Harden Verify Answers.FirstAmountReadsTheFirstRow`
- `Harden Verify Answers.SetAmountRunsValidation`
- `Harden Verify Answers.BonusForTwiceOnOneInstance`

## Step 3: `lethal verify`

Driven through `verifyFromCli` with `--db <A's store>`, `--artifact <A's last artifact>`,
`--tests <scratch>`, `--config <the fixture config>` and `--survivors <S1..S5 ids>`.

- Exit code **0**, equal to the printed `exitCode`; `ok: true`; `refused` and `quarantined` absent.
- Exactly five result rows, and their ids equal the five requested ids as a set.
- `newTests` is exactly the five `Harden Verify Answers.*` tests, each `codeunitId` 79574,
  `state: "stable"`, two runs both `outcome: "pass"` and `fresh: true`, with two DIFFERENT
  `sessionId`s.
- **S1:** `verdict: "killed"`, `killingTest` = `{ codeunitId: 79574, codeunitName: "Harden Verify
  Answers", method: "IsLargeAtTheBoundary" }`, `killedByNewTest: true`, `killedBy: "other"`,
  `killingTestFailure` contains `IsLarge(100) should be false, got true`.
  Why: the test asserts `IsLarge(100)` is false. The mutant runs `exit(Amount >= 100);`, and
  `100 >= 100` is true, so the test raises its own `Error(...)`.
- **S2:** `killed`, `killingTest` `{ 79574, "Harden Verify Answers",
  "CountInCategoryIgnoresOtherCategories" }`, `killedByNewTest: true`, `killedBy: "other"`,
  `killingTestFailure` contains `CountInCategory(A) should be 2, got 3`.
  Why: the test inserts rows `A`, `A`, `B` and asks for `A`. With the `SetRange` call replaced by
  `;`, `Entry.Count()` counts the whole table, so the `B` row counts and the result is 3.
- **S3:** `killed`, `killingTest` `{ 79574, "Harden Verify Answers", "FirstAmountReadsTheFirstRow" }`,
  `killedByNewTest: true`, `killedBy: "other"`, `killingTestFailure` contains
  `FirstAmount() should be 7, got 9`.
  Why: the test inserts entry 1 (Amount 7) then entry 2 (Amount 9), keyed on `"Entry No."`. The
  mutant runs `if Entry.FindLast() then`, which reads entry 2, so it returns 9.
- **S4:** `killed`, `killingTest` `{ 79574, "Harden Verify Answers", "SetAmountRunsValidation" }`,
  `killedByNewTest: true`, `killedBy: "other"`, `killingTestFailure` contains
  `SetAmount(Entry, 5) should leave Doubled 10, got 0`.
  Why: the mutant runs `Entry.Amount := NewAmount;`. A plain assignment does not fire the field's
  `OnValidate` trigger (`Doubled := Amount * 2`), so `Doubled` stays at its `Init()` value 0.
- **S5:** `verdict: "skipped"`, `reason: "reader-marked-equivalent"`, `mark.key` equal to the
  committed mark's key (`96a63130...|Harden Logic|BonusFor|lethal.remove-assignment|1`).
- No row carries `invalidBaseline`.
- `counts`: `{ killed: 4, survived: 0, error: 0, skipped: 1 }`.
- `BcDevMcpBackend.prototype.publishTestApp` is called exactly **1** time during the call.
- `testApp.sha256` equals a FRESH read-back of the published test app taken after the call.
- `testApp.name` is `LethAL Sandbox Harden Tests` and `testApp.version` is `1.0.0.0`, equal to the
  scratch copy's `app.json` (which is the committed tests app's identity, unchanged). The app verify
  published is therefore the scratch suite, stated rather than inferred.
- At least one lease acquire is observed during the call; no new record in the quarantine dir; a
  lease acquire right after the call succeeds, and is released.

`killedBy: "other"` because each answer test raises a bare `Error(...)` in its own codeunit, which
is inside the tests app, so `killedByOf` finds neither an assertion prefix nor a first frame in
another app.

### The failure texts are hypotheses

The four `killingTestFailure` substrings are pre-committed HYPOTHESES, read from the answer key's
AL (`Error('IsLarge(100) should be false, got true')`, `Error('CountInCategory(A) should be 2, got
%1', Got)`, `Error('FirstAmount() should be 7, got %1', Got)`, `Error('SetAmount(Entry, 5) should
leave Doubled 10, got %1', Entry.Doubled)`) with `%1` filled by the values reasoned above. A
mismatch is a BLOCK like any other.

Prior live evidence, from C02-03's leg B (`sandbox-harden-answers` alone, the same four method
bodies, logs `itest-harden-1.log` and `itest-harden-2.log` under
`H:/lethal-coord/handoff/C02-03-001/`): S1 killed by `IsLargeAtTheBoundary`, S2 by
`CountInCategoryIgnoresOtherCategories`, S3 by `FirstAmountReadsTheFirstRow`, S4 by
`SetAmountRunsValidation`, in both runs. That supports the verdicts and killers. It does NOT support
the texts: those logs print no `killingTestFailure`, so the texts rest on the AL alone. This
evidence is never used to correct a prediction after C02-08 runs.

## Step 4: fresh full run `B`

`runSession(sandbox-harden, <scratch>)` into a NEW `mkdtemp` store directory whose store file is
asserted absent before the run; no `resume` key; the fixture's marks.

- `assertFreshFullRun(B)` passes: no `resumed` in `validity.caveats`, no `resumedFrom`, no mutant
  with `carried: true`.
- `B.baselineGreen === true`; `B.staleTestApp` absent (the server ran the scratch suite verify
  published, all 11 tests present); `B.validity.reliability === "full"`.
- 21 deployed, and no mutant the table does not predict. Per mutant, matched by `file`, `line`,
  `operatorName`:
  - the 16 rows `EXPECTED` marks `killed`: `killed`, killer NOT asserted (plan Open question 5:
    with the answer tests added several tests can kill one mutant, and which is recorded depends on
    R197's order);
  - S1 `killed` by `IsLargeAtTheBoundary`, S2 by `CountInCategoryIgnoresOtherCategories`, S3 by
    `FirstAmountReadsTheFirstRow`, S4 by `SetAmountRunsValidation` (only the answer test kills
    each: leg A proved the base test does not);
  - S5 `survived`, `readerMark` equal to the committed mark, and `readerMarkedEquivalent` is
    `{ matched: [S5], stale: [], contradicted: [] }`.
- `likelyEquivalentSurvivors` lists S5 only.
- Counts: killed 20 / survived 1 / no-coverage 0.
- No quarantine.

## Step 5: agreement

- `compareVerifyToFullRun(verify, A, B)`: five compared rows, every row `agree: true`, zero diffs.
- Negative control `compareVerifyToFullRun(verify, A, A)`: exactly four diffs, one per S1 to S4 id,
  each containing `verify killed by <K method>, full run survived` with `<K method>` that row's
  answer-key killer above. Those four rows `agree: false`; S5's row `agree: true`.

The negative control proves, on live data, that a VERDICT difference is detected. It does not
live-control a wrong killer or a stale mark; those are controlled offline only (Task 1 cases b, c,
d, o, p).

## Step 6: the wall-time ratio

Owner ruling: record now, gate later.

- Printed: `verify.timings.totalMs / B.timings.totalMs`, with both numbers; and
  `verify.timings.totalMs / A.timings.totalMs`, printed only (`A` is colder).
- GATED: `verify.timings.totalMs < B.timings.totalMs`.
- RECORDED, not gated: the ratio against 0.20, with `ABOVE the epic's 20% line` printed when it is.
- The PREDICTION, stated before the run: the ratio to `B` is ABOVE 0.20 on this fixture. Evidence,
  all on `sandbox-app`: 0.389 (C02-06b run 2, warm), 0.351 (orchestrator, merged tree 06805a0,
  3297 / 9384 ms), 0.148 (C02-06b run 1, a cold full run as denominator). On this fixture, C02-03's
  leg A took 13450 ms and 10284 ms (`timings.totalMs`, runs 1 and 2). Verify does more work here
  than on `sandbox-app`: four survivors with their covering tests, plus five new tests each run
  twice unmutated, on top of fixed costs (a compile, one publish, a lease, a baseline) that do not
  shrink with the fixture.
- A ratio below 0.20 is also reported, not celebrated: it would most likely mean a cold
  denominator.

Either way the epic's 20% criterion stays OPEN. This gate does not meet it and does not gate it;
Task 7 files it as a roadmap item.

## Step 7: restore

In a `finally` once step 3 began. The resident artifact is decided by
`DeploymentVerifier.verify({ appId, artifactId })` for candidate `B` then candidate `A`; exactly one
must be accepted, else no publish and the manual recovery text is printed. The committed
`fixtures/sandbox-harden-tests` is compiled with `backend.compileTestApp` and published inside one
`runNamedMutants` call's `inLease` (one request: the resident run's S1 code with methods
`[Harden Tests.IsLargeSeparatesSmallFromLarge]`, expected `survived`). The fresh read-back hash
equals the compiled hash. A gate failure and a restore failure are both kept and thrown together.

After EACH agreement run, `LETHAL_ITEST_HARDEN=1 bun run itest:harden` passes unchanged (S1 to S4
`survived` again): the runtime proof the answer tests left the server.

## Not exercised live

A verify `error` row, a `skipped` row against a stale mark, a wrong killer in `B`, and a resumed
`B`. All four are pinned offline in Task 1 (in that order: case i; cases d and p; cases b and o; cases h1 to h4).

## The stop rule

Any difference from the lines above is reported to the owner with the per-mutant table (id, key
suffix, verify, full, agree). Nothing above is edited after commit; a correction is appended below,
as C02-06's "Correction after live run 1" was.
