# C02-06 `itest:verify`: pre-committed predictions

Committed ALONE, before the first live run of `LETHAL_ITEST_VERIFY=1 bun run itest:verify`
(`packages/runner/itest/verify.itest.ts`). Target: `Cronus28`, fixture `fixtures/sandbox-app` +
`fixtures/sandbox-tests` (sandbox-tests `1.0.0.3`, sandbox-app `1.0.0.1`). Plan:
`docs/superpowers/plans/2026-09-26-C02-06-lethal-verify.md`, Task 8 and decisions 9 and 11.

Every prediction below is a gate assertion: any one failing exits 1. A differing verdict is a
BLOCK, never "close enough".

## The three mutants, by identity key in `packages/runner/itest/bcdev.baseline.json`

| Role | Identity key (suffix) | Frozen verdict |
|---|---|---|
| the survivor the new test kills | `Sandbox Logic\|ClampPercent\|lethal.negate-conditional` | `survived` |
| the survivor nothing kills | `Sandbox Logic\|LogAudit\|lethal.negate-conditional` | `survived` |
| the refused kill | `Sandbox Logic\|IsOverBudget\|lethal.return-value` | `killed` (by `OverBudgetDetected`) |

Each suffix matches exactly one baseline row and exactly one mutant of the step-1 report, and all
three are in the batch whose artifact is the report's last `artifacts[]` entry.

## Step 1: the full run

`runSession` on `sandbox-app` + `sandbox-tests` into a fresh temp store: 3 killed / 12 survived /
4 no-coverage, per mutant equal to `bcdev.baseline.json`, no quarantine. Its `timings.totalMs`
and its last `artifacts[]` entry (the `--artifact` value) are kept.

## Step 2: the scratch test project

A copy of `fixtures/sandbox-tests` in an OS temp dir, `app.json` unchanged (version `1.0.0.3`),
with ONE method added to codeunit `79100 "Sandbox Tests"`:

```al
[Test]
procedure ZzC0206ClampKeepsMidValue()
begin
    if SandboxLogic.ClampPercent(50) <> 50 then
        Error('ZzC0206: ClampPercent(50) must return 50');
end;
```

Unmutated, `ClampPercent(50)` is 50 and the test passes. Under the negation `50` returns `0`, so
the test raises its own bare `Error(...)`.

## Step 3: `lethal verify` with the new test

Driven through `verifyFromCli` (the CLI code path) with `--db <temp store>`, `--artifact <step 1>`,
`--tests <scratch copy>`, `--config <the itest config>`, and both survivors as `<batch>/<code>`.

- Exit code **5** (a survivor stays alive), equal to the printed `exitCode`; `ok: false`.
- `newTests` is exactly one entry: `Sandbox Tests.ZzC0206ClampKeepsMidValue`, `codeunitId` 79100,
  `state: "stable"`, both runs `outcome: "pass"`, `fresh: true`, with two DIFFERENT `sessionId`s.
- The ClampPercent row: `verdict: "killed"`, `killingTest` = `{ codeunitId: 79100,
  codeunitName: "Sandbox Tests", method: "ZzC0206ClampKeepsMidValue" }`, `killedByNewTest: true`,
  `killedBy: "other"` (a bare `Error(...)` the test itself raised), and `killingTestFailure`
  contains `ZzC0206: ClampPercent(50) must return 50`.
- The LogAudit row: `verdict: "survived"`, `testsRun` includes
  `Sandbox Tests.ZzC0206ClampKeepsMidValue`.
- Neither row carries `invalidBaseline`.
- `counts`: killed 1, survived 1, error 0, skipped 0.
- `testApp.sha256` equals a FRESH read-back of the published test app taken after the call.
- `quarantined` absent; no new record in the quarantine dir (verify's CLI path uses the default
  `~/.lethal/quarantine`); a lease acquire right after the call succeeds, and is released.
- At least one lease acquire happened during the call (the spy that step 5 relies on observes).

## Step 4: restore, the "survived" leg

In a `finally` once step 3 began: the same call with the UNCHANGED `fixtures/sandbox-tests`.

- Exit code **5**.
- `newTests` empty.
- Both rows `survived`. The ClampPercent `survived` is the runtime proof that the new test is gone
  from the server.
- `testApp.sha256` equals a fresh read-back after the call.

## Step 5: refusals against the real store

Each exit **6**, and NO lease acquire during the call (a spy on `LeaseClient.acquire`), and no
`verifyRunId` in the output.

- `IsOverBudget|lethal.return-value` (frozen `killed`) as the only survivor:
  `refused.reason: "not-a-survivor"`.
- A random 32-hex `--artifact` with the ClampPercent id: `refused.reason: "unknown-artifact"`.

## Step 6: the wall-time ratio

Printed: step 3's `timings.totalMs` over step 1's `timings.totalMs`. Recorded, NOT gated (plan
decision 9, ruling 4). A small fixture's full run does not dwarf verify's fixed costs, so a ratio
above 20% here is not a failure. The epic's 20% acceptance is C02-08's on `sandbox-harden`.

## Not exercised live

The `source-changed` refusal: it would mean editing `fixtures/sandbox-app` during a gate. It is
pinned offline in Task 2.
