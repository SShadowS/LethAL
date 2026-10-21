> **R-514 reuse probe: pre-commitment (r2; written before any live run).** One probe, two runs,
> on Cronus28 against `fixtures/sandbox-hang` + `fixtures/sandbox-hang-tests` (5 tests, 38 mutants,
> the hang gate's fixture). It answers two review items that no unit test or gate can:
>
> - **I1:** what BC's first call after a publish costs, against steady state, on these tests. On a
>   reused batch nothing runs between the publish and mutant 1's first covering run, so that run
>   absorbs the first-call cost. If the cost is large, a cold mutated run can time out while the
>   warm unmutated confirm passes, which is a false kill even under the 2x rule.
> - **I4:** a live witness for direction 2: on a resume that reuses the baseline, the fixture's 5
>   real hangs stay `timeout-killed`, each with exactly one unmutated confirm.
>
> It runs on the BUILT R-514 fix (I4 tests the fix). It is evidence, not a gate: no baseline file,
> no receipt.

## Why not a plain `lethal run`

The CLI has no clean way to stop a run part-way. It has no SIGINT handler, and killing the process
mid-run can leave a hung BC session (the hang fixture's mutants loop forever) and a held lease.
Run 1 must stop at a known point with the batch's baseline recorded and at least one verdict
carryable. So the probe is a one-off script, `scripts/r514-probe/probe.ts`, modelled on
`packages/runner/itest/hang.itest.ts` (no gate changes):

- Build the backend exactly as `hang.itest.ts`'s `runLeg` does, in its `single` mode
  (`groupRuns: { enabled: false }`, `stopHungSessions: true`, `mutantTimeoutMs: 20_000`, the same
  `lease` block), with ONE scratch store file and ONE scratch quarantine dir shared by both runs.
  The script loads the fixture config through the same loader the gate uses. The agent running it
  never opens, prints or greps that config, and passes no credential on a command line.
- **Run 1:** the backend is a subclass whose `activate(id)` throws
  `new Error("R514 probe: planned stop before the second mutant")` when `id` is a mutant id that
  differs from the first mutant id it saw. It throws BEFORE calling the real `activate`, so nothing
  for that mutant reaches BC. `activateOnce` rethrows a plain `Error`, so the session rejects through
  its own `finally` (ClearActive, lease release). No hang is ever started, and nothing is
  quarantined.
- **Run 2:** a fresh, unwrapped backend, the same settings plus `resume: "last"`. Its batch has work
  left, so it is deployed, and its baseline is reused from run 1's snapshot.
- Finally: the gate's `teardown` (`force-reset-lease`), and print the measurements below from the
  scratch store (`test_results`, `baseline_snapshots`, `suspect_snapshots`) and the two reports.
- Expected wall time: run 1 about 1 to 2 minutes (deploy, 5-test baseline, one mutant), run 2
  about 5 to 8 minutes (deploy, 37 mutants, 5 stops at 20 s).

## How to run it (Cronus28, under a lease)

1. `bun scripts/coord-status.ts`: Cronus28 must show no other lease holder. Take the Cronus28 lease
   the way coord grants it, and run nothing else on Cronus28 until step 4.
2. The LethAL Control app at `extensions/lethal-control/app.json`'s version is on Cronus28
   (`lethal doctor --config fixtures/sandbox-hang/lethal.config.local.json` reports
   `control-version`; read its OUTPUT only), and `fixtures/sandbox-hang-tests` is published as for
   `itest:hang`.
3. `LETHAL_R514_PROBE=1 bun scripts/r514-probe/probe.ts` (foreground; it refuses to start without
   the variable).
4. Check the printed `force-reset-lease OK`, then release the Cronus28 lease.

## Predictions (pre-committed; each one is checked by the script and printed PASS or FAIL)

**Run 1**
- P1. The session rejects with the planned-stop error, and with nothing else.
- P2. Exactly one mutant row: line 34, `lethal.empty-block`, `killed`. (Mutants run in manifest
  order, and the first is line 34. If the first row is any other mutant, run 2's figures below
  change by that row, and the probe is VOID: stop, report, re-plan. No run 2.)
- P3. `baseline_snapshots` holds exactly one row for run 1 (batch 0); `suspect_snapshots` is
  empty.

**Run 2 (I4)**
- P4. Exactly one `resume-baseline-reused` warning, naming run 1's batch 0. No baseline row in run
  2 (no `test_results` row with a NULL `mutant_row_id`).
- P5. 38 mutants; exactly one carried (P2's); `baselineGreen` true; `counts.errors` 0; `quarantined`
  undefined.
- P6. Every `EXPECTED_ON` verdict (from `hang.itest.ts`), per mutant: killed 24, survived 9,
  timeout-killed 5, every kill at `killPosition` 1. No mutant with cause `reused-budget-stale`,
  `unstable` or `stranded`.
- P7. The 5 `timeout-killed` are line 37 `void-method-call`, 43 `empty-block`, 44
  `remove-assignment`, 73 `remove-assignment`, 145 `void-method-call`. For each one:
  - exactly one covering row with outcome `timeout`, BC's stop wording ("stopped the session",
    "StopSession") and `duration_ms` in [20 000, 50 000);
  - exactly ONE unmutated confirm row (same `mutant_row_id`, `mutant_code` NULL, the same test,
    outcome `pass`) with `duration_ms` at most 10 000 (2 x duration <= the 20 000 budget).
  Total: 5 timeout confirm rows.

**I1 (measured; the prediction is a bound)**
- M1. Run 2's FIRST `test_results` row after its deploy (the first covering run of mutant 2, line 35
  `remove-assignment`, a survivor): its `duration_ms` minus the median `duration_ms` of the same
  test's other `pass` rows with a non-null `mutant_code` in run 2.
- M2. The same "first row minus median" for each of the 5 tests (its first run in run 2).
- M3. Run 1's first baseline row minus the median of that test's run-2 `pass` rows, printed for
  context only (a baseline row may carry coverage overhead, R58).
- Prediction: M1 at most 2 000 ms; every M2 at most 2 000 ms.

## What result changes the plan

- **Any of P4 to P7 fails:** the fix is wrong live. BLOCK the R514 landing (status stays `fixed
  in <commit>, live gate pending`, with the failing check named) and re-plan. In particular a hang
  ending `reused-budget-stale`, `unstable` or `stranded` means the confirm or the 2x rule misjudges
  a real hang, which is the direction this probe exists for.
- **M1 or any M2 above 5 000 ms** (a quarter of the 20 000 ms budget; a false kill needs a
  first-call cost of about half the budget, so this keeps a factor of 2): the first-call cost is
  material. Before R514 closes, add an unmutated warm-up on a reused batch: before the mutant loop,
  one unmutated run of each test codeunit's first covering test, its answer discarded except for
  the existing lease, in-flight and attestation handling. Re-plan that change with its own tests.
- **M1/M2 above 2 000 ms but at most 5 000 ms:** the prediction missed, but the size is not
  material. Record the figures in R514's closing text and file a roadmap item to re-measure on a
  larger test app; no code change.
- **P1 to P3 fail:** the probe did not set up what it meant to. VOID; fix the script, not the plan.
- Anything else is a PASS; quote all M figures in R514's closing text.
