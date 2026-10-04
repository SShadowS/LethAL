# R-384 pre-commitment: verify's reach filter on `itest:verify` and `itest:agreement`

**Written blind** by an agent that did not see any R-384 gate output. The lane had already run both gates once, and the orchestrator ruled that the pre-commitment must come from an author who had not seen them. This author read none of `/coord/handoff/R-384/`, nothing under `/coord/reviews/R-384-*/` except `plan.r2.md`, and no gate output anywhere. Every prediction below comes from the code on branch `lethal/r384` (tip `3edff242`) and the fixtures' AL source.

Plan: `docs/superpowers/plans/2026-10-04-R-384-verify-reachability-filter.md`, section "Live check [r2]".

## The rule being predicted (from the code, not the plan)

- `verify.ts` `runVerify`: the filter is on when the backend's coverage mode is `fenced` and `--no-reach-filter` is not given. Neither gate passes a `coverageMode` (the itests build `BcDevMcpBackend` with none, and both `lethal.config.local.json` files set none), so the mode is `DEFAULT_COVERAGE_MODE` = `"fenced"` (`bcdev-backend.ts:127`). **Filter ON in every verify call below.**
- `narrow` runs whenever the filter is on and there is at least one request, **including when there are zero new tests** (`verify.ts`, the `narrow` closure; `orchestrator.ts` `select`). So the "on" line is printed in no-new-test steps too.
- `verify-reach.ts` `narrowVerifyRequests`: per survivor, `methods` = its source covering tests (never removed), then the filterable new tests whose coverage reaches it, then fail-closed new tests; each group in plan order. Reach = `coverageFilter` at member grain with `localsAreUnnameable = false` (fenced is not a hub mode), so a LOCAL procedure needs an exact member hit.
- `testsRun` = `measuredResultOf(o, sent, ...)` = **every method sent**, not only the ones executed before a kill. So `testsRun` is exactly `reach.methods.get(id)`.
- The state line (`reportReach`): `[lethal] verify: reach filter on (fenced coverage): <N> new test(s), <F> joined every survivor because their coverage could not be used; <P> mutant run(s) instead of <S·N> without the filter; <U> survivor(s) no new test reaches.` where N = `plan.newTests.length`, S = `running.length` (marked survivors excluded), P = joins. When U > 0 a second line follows: `[lethal] verify: survivors no new test reaches: <ids in request order>`.
- **Where the line goes:** `verifyFromCli` passes `log: (line) => process.stderr.write(...)` (`cli.ts:5317`). Neither itest on `lethal/r384` captures or asserts it (`git diff master...lethal/r384 -- packages/runner/itest` is empty). The predicted lines can be checked only by reading the gate's stderr. The plan's "captured `log` line" pin is not implemented in the branch's itests.

---

## Gate 1: `itest:verify` (`fixtures/sandbox-app`, `packages/runner/itest/verify.itest.ts`)

### Fixture facts used
- `fixtures/sandbox-app/src/SandboxLogic.Codeunit.al`: `ClampPercent` (public) at :10-15; `ApplyAudit` (public) at :17-20 calls `LogAudit` at :19; `LogAudit` is `local`, at :22-27.
- `fixtures/sandbox-tests/src/SandboxTests.Codeunit.al`: `OverBudgetDetected` (:11-19) calls only `IsOverBudget`; `ClampPercentRuns` (:22-26) calls `ClampPercent(50)` (:24) and `ApplyAudit(10)` (:25), so it reaches `ClampPercent` and, through `ApplyAudit` -> :19, `LogAudit`.
- So every survivor in `ClampPercent` or `LogAudit` has source covering tests = `[Sandbox Tests.ClampPercentRuns]`, and nothing else.
- Step 2 appends ONE test (itest's own text): `ZzC0206ClampRejectsAboveHundred`, body `if SandboxLogic.ClampPercent(150) <> 0 then Error(...)`. Its only call into the target app is `ClampPercent`. It never calls `ApplyAudit` or `LogAudit`.

### Step 3: verify `[ClampPercent negate-conditional, LogAudit negate-conditional]` with the new test

N = 1, S = 2 (no mark applies to sandbox-app; it has no `lethal.equivalent.json`).

| Survivor | Covering | New test reaches it? | Predicted `testsRun` | Verdict |
|---|---|---|---|---|
| ClampPercent `negate-conditional` (SandboxLogic :12) | ClampPercentRuns | **Yes.** `ZzC0206ClampRejectsAboveHundred` calls `ClampPercent(150)`; its fenced coverage hits lines :12-13 of `ClampPercent`, a public member, exact hit. | `["Sandbox Tests.ClampPercentRuns", "Sandbox Tests.ZzC0206ClampRejectsAboveHundred"]` | **killed**, by `ZzC0206ClampRejectsAboveHundred`, `killedByNewTest: true`, `killedBy: "other"` (at 150 the original returns 0 and the `or`->`and` mutant returns 150, so the test's own `Error` fires) |
| LogAudit `negate-conditional` (SandboxLogic :24) | ClampPercentRuns | **No.** The new test's only target-app call is `ClampPercent`; no line of `LogAudit` (:22-27) runs. `LogAudit` is local, so under fenced it needs an exact member hit; there is no object-level widening (`localsAreUnnameable = false`). | `["Sandbox Tests.ClampPercentRuns"]` | **survived** |

Predicted stderr:
```
[lethal] verify: reach filter on (fenced coverage): 1 new test(s), 0 joined every survivor because their coverage could not be used; 1 mutant run(s) instead of 2 without the filter; 1 survivor(s) no new test reaches.
[lethal] verify: survivors no new test reaches: <logAuditId>
```
(`<logAuditId>` is the `batch/code` the itest prints as "LogAudit" in its step-1 PASS line.) F = 0 because the itest's own step-3 assertions require both unmutated runs of the new test to pass fresh; if they did not, F would be 1 but step 3 would fail anyway (decision 13).

**Predicted gate result for step 3: FAIL.** `verify.itest.ts` on `lethal/r384` still asserts, unchanged from master:
```ts
assert.ok(
  (logAudit.testsRun ?? []).includes(NEW_TEST_QUALIFIED),
  `step 3: the new test ran against LogAudit (${logAudit.testsRun?.join(", ")})`,
);
```
The filter removes exactly that. Predicted message: `step 3: the new test ran against LogAudit (Sandbox Tests.ClampPercentRuns)`. The assertions before it (exit 5, one stable new test, ClampPercent killed by the new test, LogAudit survived) are predicted to PASS. This is the expected effect of R-384, not a product defect: the itest's assertion encodes the pre-R-384 "every new test joins every survivor" rule and has to be rewritten to the `testsRun` above. Counts would be `{ killed: 1, survived: 1, error: 0, skipped: 0 }`, but the counts assertion comes after the failing one and does not run.

### Step 4: verify the same two survivors with the unchanged `fixtures/sandbox-tests` (runs in the `finally`, whatever step 3 did)

N = 0, S = 2. No new test exists, so nothing joins.

| Survivor | Predicted `testsRun` | Verdict |
|---|---|---|
| ClampPercent `negate-conditional` | `["Sandbox Tests.ClampPercentRuns"]` | survived |
| LogAudit `negate-conditional` | `["Sandbox Tests.ClampPercentRuns"]` | survived |

Predicted stderr (the "on" line still prints, because `narrow` runs with zero new tests):
```
[lethal] verify: reach filter on (fenced coverage): 0 new test(s), 0 joined every survivor because their coverage could not be used; 0 mutant run(s) instead of 0 without the filter; 2 survivor(s) no new test reaches.
[lethal] verify: survivors no new test reaches: <clampId>, <logAuditId>
```
(Request order is the `--survivors` order, `[clampId, logAuditId]`.) Step 4's assertions predicted PASS. Side observation, not a failure: with N = 0 the line says "2 survivor(s) no new test reaches", which is true but noisy.

### Step 4b: verify gap `Gd09a2f841d4e` (LogAudit then-block) with the repo's tests (runs only if step 4 passed)

Gap members (itest `LOG_THEN_GAP`): LogAudit `empty-block` (the `begin..end` at SandboxLogic :24-26) and LogAudit `remove-assignment` (:25). N = 0, S = 2.

| Survivor | Predicted `testsRun` | Verdict |
|---|---|---|
| LogAudit `empty-block` | `["Sandbox Tests.ClampPercentRuns"]` | survived |
| LogAudit `remove-assignment` | `["Sandbox Tests.ClampPercentRuns"]` | survived |

Predicted stderr:
```
[lethal] verify: reach filter on (fenced coverage): 0 new test(s), 0 joined every survivor because their coverage could not be used; 0 mutant run(s) instead of 0 without the filter; 2 survivor(s) no new test reaches.
[lethal] verify: survivors no new test reaches: <id1>, <id2>
```
The two ids are the gap's members; their ORDER is **undecided** from the source (it is the order `parseVerifyRequest` expands the gap into, which follows the store's member order, not read here). Count and content are decided. Step 4b predicted PASS.

### Step 5a-5d: refusals
All refuse before any lease, so `narrow` never runs and **no** reach line is printed. Predicted PASS, unchanged.

### Gate 1 overall
**Predicted: FAIL at step 3** (the one LogAudit `testsRun` assertion), with steps 4, 4b passing, then the gate throws its combined `step 3 FAILED ... step 4 (restore) PASSED` error and never reaches steps 5 and 6. The verdicts are as predicted and do not move; only the itest's stale pin breaks.

---

## Gate 2: `itest:agreement` (`fixtures/sandbox-harden`, `packages/runner/itest/verify-agreement.itest.ts`)

### Fixture facts used
- `fixtures/sandbox-harden/src/HardenLogic.Codeunit.al`, all procedures public: `IsLarge` :4-7 (S1 at :6), `CountInCategory` :10-16 (S2 at :14), `FirstAmount` :19-26 (S3 at :23), `SetAmount` :29-32 (S4 at :31), `BonusFor` :36-44 (S5 at :40). (Line numbers inside that file; the listing above was concatenated after the 23-line table file.)
- Base suite `fixtures/sandbox-harden-tests/src/HardenTests.Codeunit.al`: each target procedure is called by exactly one base test. S1 <- `IsLargeSeparatesSmallFromLarge` (:16,:18); S2 <- `CountInCategoryCountsRows` (:32); S3 <- `FirstAmountReadsARow` (:46); S4 <- `SetAmountStoresTheAmount` (:58). `AmountValidateDoublesIt` (:69) calls `Entry.Validate` directly, never `SetAmount`, so it is not a member-grain covering test of S4.
- S5 is marked equivalent in `fixtures/sandbox-harden/lethal.equivalent.json`, so `planVerify` puts it in `skipped`, not `running`. **S = 4.**
- The new tests are the answer key `fixtures/sandbox-harden-answers/src/HardenAnswerKey.Codeunit.al`, renamed to codeunit 79574 "Harden Verify Answers". **N = 5**, in file order: `IsLargeAtTheBoundary` (K1), `CountInCategoryIgnoresOtherCategories` (K2), `FirstAmountReadsTheFirstRow` (K3), `SetAmountRunsValidation` (K4), `BonusForTwiceOnOneInstance` (K5).

### Reach of each new test (its only calls into `Harden Logic`)
- K1 (:13-19): `Logic.IsLarge(100)` at :17. Reaches S1 only.
- K2 (:23-36): `Entry.DeleteAll`, a test-local `InsertEntry` (`Entry.Insert`, no `OnInsert` in the table), `Logic.CountInCategory('A')` at :33. Reaches S2 only.
- K3 (:40-52): `Logic.FirstAmount()` at :49. Reaches S3 only.
- K4 (:56-65): `Logic.SetAmount(Entry, 5)` at :62 (which also fires the table's `Amount` `OnValidate`, an object no running survivor lives in). Reaches S4 only.
- K5 (:69-80): `Logic.BonusFor` at :74 and :77. Reaches only `BonusFor`, whose survivor S5 is skipped. **K5 reaches no running survivor.**

### Step 3: verify S1-S5 with the scratch suite

| Survivor | Predicted `testsRun` | New tests that reach it | Verdict |
|---|---|---|---|
| S1 `IsLarge` conditional-boundary | `["Harden Tests.IsLargeSeparatesSmallFromLarge", "Harden Verify Answers.IsLargeAtTheBoundary"]` | K1 only | **killed** by `IsLargeAtTheBoundary` (`IsLarge(100) should be false, got true`) |
| S2 `CountInCategory` remove-setrange | `["Harden Tests.CountInCategoryCountsRows", "Harden Verify Answers.CountInCategoryIgnoresOtherCategories"]` | K2 only | **killed** by `CountInCategoryIgnoresOtherCategories` (`... should be 2, got 3`) |
| S3 `FirstAmount` swap-find-direction | `["Harden Tests.FirstAmountReadsARow", "Harden Verify Answers.FirstAmountReadsTheFirstRow"]` | K3 only | **killed** by `FirstAmountReadsTheFirstRow` (`... should be 7, got 9`) |
| S4 `SetAmount` validate-to-assign | `["Harden Tests.SetAmountStoresTheAmount", "Harden Verify Answers.SetAmountRunsValidation"]` | K4 only | **killed** by `SetAmountRunsValidation` (`... should leave Doubled 10, got 0`) |
| S5 `BonusFor` remove-assignment | none (not sent) | n/a | **skipped**, `reader-marked-equivalent` |

`BonusForTwiceOnOneInstance` appears in no `testsRun`. Every running survivor's `testsRun` lacks four of the five new tests, which is the plan's "filter is not inert" proof (it asks for at least one).

Predicted stderr (U = 0, so no second line):
```
[lethal] verify: reach filter on (fenced coverage): 5 new test(s), 0 joined every survivor because their coverage could not be used; 4 mutant run(s) instead of 20 without the filter; 0 survivor(s) no new test reaches.
```
F = 0 because step 3 asserts all five new tests pass twice, fresh, in different sessions, and each calls a `Harden Logic` procedure, so its coverage has entries. No `verify-reach-fail-closed` warning: no survivor is in an `#if`-wrapped object (R298), each has an exact member hit (so R175's `unplaceable` cannot fire), and none is a table trigger.

Cap (`DEFAULT_MAX_NEW_TESTS` = 50): check 1, 2N = 10 <= 50 x (4 + 2) = 300; check 2, E = 10 + 4 = 14 <= 300. No refusal.

Counts `{ killed: 4, survived: 0, error: 0, skipped: 1 }`, exit 0, one test-app publish: step 3 predicted PASS. The branch's agreement itest asserts nothing about `testsRun` or the log line, so nothing in it breaks.

### Steps 4-7
Run B is a fresh `lethal run`, which does not go through verify's filter, and its per-mutant table is the existing pre-commitment's. Agreement (step 5): S1-S4 killed by the same answer test in verify and in B (in B, each Sx's covering tests are its base test plus its own K, and only the K kills), S5 skipped/marked on both sides. **Predicted: every row agrees, 4 killed and 1 skipped; gate PASS.** Step 6's "verify faster than B" should still hold and, with 4 mutant runs instead of 20, by a larger margin than before; the ratio itself is not predicted. Step 7's restore calls `runNamedMutants` directly with no `narrow`, so no reach line is printed there.

---

## Summary of predictions

| Gate step | Reach line | Per-survivor `testsRun` | Verdicts | Step result |
|---|---|---|---|---|
| verify step 3 | `1 new test(s), 0 joined ...; 1 mutant run(s) instead of 2 ...; 1 survivor(s) no new test reaches.` + LogAudit's id | Clamp: ClampPercentRuns + ZzC0206; LogAudit: ClampPercentRuns only | killed / survived | **FAIL** on the stale `testsRun includes new test` assertion for LogAudit |
| verify step 4 | `0 new test(s), 0 joined ...; 0 mutant run(s) instead of 0 ...; 2 survivor(s) no new test reaches.` + both ids | each: ClampPercentRuns | survived / survived | PASS |
| verify step 4b | same as step 4, ids in an undecided order | each: ClampPercentRuns | survived / survived | PASS |
| verify step 5 | none | n/a | refusals | not reached (gate throws after 4b) |
| agreement step 3 | `5 new test(s), 0 joined ...; 4 mutant run(s) instead of 20 ...; 0 survivor(s) no new test reaches.` | each Sx: its base test + its own Kx; K5 nowhere | 4 killed, S5 skipped | PASS |
| agreement steps 4-7 | none from verify | n/a | agrees with B on every row | PASS |

**Undecided:** only the order of the two ids in step 4b's second line.
