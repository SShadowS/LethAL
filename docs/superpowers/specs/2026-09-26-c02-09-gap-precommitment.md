# C02-09 `itest:verify` gap extension: pre-committed predictions

Committed ALONE, before the first live run of `LETHAL_ITEST_VERIFY=1 bun run itest:verify` with
gap ids (`packages/runner/itest/verify.itest.ts`). Target: `Cronus28`, control app `1.0.0.19`,
fixture `fixtures/sandbox-app` + `fixtures/sandbox-tests`. Plan: C02-09 Task 8. The earlier steps
of this gate keep their own pre-commitment, `2026-09-26-c02-06-verify-precommitment.md`.

Every prediction below is a gate assertion: any one failing exits 1. A difference is a BLOCK. No
prediction is edited after the run.

## How the predictions were resolved

Offline, before writing this file, on the checkout at `5174830`: `generateMutationSet` and
`writeInstrumentedProject` on `fixtures/sandbox-app` (the same path Task 2's
`packages/runner/tests/gap-id-fixtures.test.ts` drives), each manifest entry joined to its
`bcdev.baseline.json` verdict by identity key (`keyOf`), and the real `explain()` run over the
resulting report. All 19 entries joined; none was left over on either side. The measurement
matched the plan's prediction exactly (4 gaps of 5 / 2 / 3 / 2, one no-coverage block of 4,
IsOverBudget in neither list), so nothing here departs from the brief.

The gap ids below are what that measurement produced. They hash the file path, the block's
offsets and its text, so they hold for this checkout's bytes (the fixture files are LF). The gate
asserts them: a live manifest whose ids differ from the offline writer's is a regression in the
chain this gate exists to prove.

Identity keys are `astHash|codeunitName|procedureName|operatorName|operatorMajor`, as in
`packages/runner/itest/bcdev.baseline.json`. The hash is shortened to 8 characters here; the gate
compares full keys.

## Prediction 1: `explain(report).gaps`, on the step-1 report

Exactly **4** entries, **12** members in total (the 12 survivors, each in exactly one gap). Every
entry has `unobservedBlock: true`, `survived` equal to its member count, `killed`, `noCoverage`
and `other` 0, and `artifactId` equal to the step-1 report's last `artifacts[]` entry.

| Gap | Gap id | Block lines | Members (identity key) |
|---|---|---|---|
| ClampPercent body | `G72826da4c976` | 11-15 | `b03dba08\|Sandbox Logic\|ClampPercent\|lethal.empty-block\|1`, `241fff26\|...\|lethal.negate-conditional\|1`, `fc15ec30\|...\|lethal.conditional-boundary\|1`, `58ade303\|...\|lethal.conditional-boundary\|1`, `40277aa1\|...\|lethal.return-value\|1` |
| ApplyAudit body | `G140fcb49d7d2` | 18-20 | `2b34811c\|Sandbox Logic\|ApplyAudit\|lethal.empty-block\|1`, `9b4f290c\|...\|lethal.void-method-call\|1` |
| LogAudit body | `G4e97ec8a420a` | 23-27 | `63c4f230\|Sandbox Logic\|LogAudit\|lethal.empty-block\|1`, `5cba655a\|...\|lethal.negate-conditional\|1`, `63b9fa65\|...\|lethal.shift-integer\|1` |
| LogAudit then-block | `Gd09a2f841d4e` | 24-26 | `77ee7e3d\|Sandbox Logic\|LogAudit\|lethal.empty-block\|1`, `d8f839f8\|...\|lethal.remove-assignment\|1` |

The two LogAudit `empty-block` keys, resolved offline: `63c4f230...` (line 23, the procedure
body) is in the body gap `G4e97ec8a420a`; `77ee7e3d...` (line 24, the `then` block) is in the
then-block gap `Gd09a2f841d4e`. The `return-value` member of ClampPercent is the one on
`exit(Value)`; `return-value.ts` skips `exit(0)`.

## Prediction 2: `explain(report).noCoverageBlocks`, and IsOverBudget

Exactly **1** entry: the DiscountedPrice body (`Sandbox Pricing`, block lines 4-8), 4 members:
`e7216a27|Sandbox Pricing|DiscountedPrice|lethal.empty-block|1`,
`4b61c090|...|lethal.conditional-boundary|1`, `98656555|...|lethal.return-value|1`,
`d7143458|...|lethal.swap-additive|1`.

IsOverBudget's three rows (all `killed`) carry ONE gap id, `G9890e48cccd0`, and that id is in
neither list.

## Prediction 3: step 4b, a gap by id

After step 4 passed, inside the same restore guard: `lethal verify` through `verifyFromCli` with the
repo's unchanged `fixtures/sandbox-tests`, `--artifact` and `--survivors` BOTH read from the
LogAudit then-block entry of `explain(report).gaps` (`artifactId` and `gapId`), never typed in.

- Exit code **5**, equal to the printed `exitCode`. No `refused`, no `quarantined`.
- Exactly **2** results. Their identity keys (joined to the step-1 report by
  `<batchIndex>/<mutantCode>`) are exactly the then-block's two: `77ee7e3d...|lethal.empty-block`
  and `d8f839f8...|lethal.remove-assignment`.
- Both `survived`, both with `gapId` equal to the requested id.
- Exactly **one** lease acquire.

## Prediction 4: step 5, two new refusals

Each exits **6** with zero lease acquires and no verify run row, against the step-1 artifact:

- 5c: `G000000000000` refuses `unknown-gap`. The step first asserts that no row of the step-1
  report has that gap id, so the refusal is not an accident of the id.
- 5d: IsOverBudget's gap id, read off its killed rows (predicted `G9890e48cccd0`), refuses
  `gap-has-no-survivor`.

## Prediction 5: no verdict moves

Step 1's per-mutant diff against `bcdev.baseline.json` stays empty: the manifest's new gap fields
moved no verdict. `itest:bcdev` is run once as well and stays at its frozen 3 / 12 / 4,
`groupedCalls` 15, `warmKills` 0.
