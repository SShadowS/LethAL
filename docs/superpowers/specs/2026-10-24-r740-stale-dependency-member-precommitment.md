# R-740 pre-commitment (2026-10-24): a real `lethal run` over a tests app left stale by a DEPENDENCY upgrade

Committed before any server call. Probe: `scripts/r740-probe/` (lethal/r740; README there), built offline. Plan:
`/coord/handoff/R-740/plan.md` (opus plan review applied). Server: bc2 (BC 28.4 W1), under lethal-preproc's lease,
after `bc-linux-setup.ts --server bc2` (its own lease). **Do not rebuild after this commit.**

| build | what | sha256 |
|---|---|---|
| L1 | R740 Probe Lib (916727ff-fac6-40f5-bc66-38800422d6d6) 1.0.0.1: `Helper()`, `Other()` | 01dfeae65b99dd30c8e7118c56f463ab0daac8a77ffb4f9144e2e528b62d8fb0 |
| L2 | the same app at 1.0.0.2, WITHOUT `Helper` | a74d8693f6f7cc86c8d4a50d4dd20f17a6dd7470650283ee1c90cc6e0750327f |
| P | R740 Probe Target (157d4738-4e4d-410b-b1be-743a3ba29106) 1.0.0.1, the run's source: `Scale(X)`, `Plus(X)`; no dependency on L | bc00a206cb78a13adc6202203f30362ff034438033eb554a7b5213e950e7d364 |
| Q | R740 Probe Tests (a2a9b0bb-7274-42ae-8eee-89f12b23a6f2) 1.0.0.1, against L1 and P: TestLib (calls `Lib.Helper()`, then `Logic.Scale`), TestPlus, TestFails | aa19468d3fd94032ea5069f7d96567d7cf8d8f627d2ca5a84f4fe07dba2046fb |

Offline mutation listing of the target: 5 mutants. `Scale` has 2 (empty-block, return-value), and its ONLY covering
test is TestLib. `Plus` has 3 (empty-block, return-value, swap-additive), covered by TestPlus. Second id set, for a
re-run after an addendum only: L edbf191d-45cd-45dd-bd38-f9910c0d60a7, P ef6468b3-8053-4383-a69a-8114dd06fd12, Q
a3014e4e-2f3e-4185-8fce-0519bd133e3a.

## Steps (`drive.ts --all`, once)
1. Publish L1, P, then Q directly; read all three back, installed at 1.0.0.1.
2. Publish L2 through LethAL's deployer (altool, as R-728's step 3). Record whether it threw, with its full text,
   the L, P and Q rows, and the version the dev endpoint serves for L.
3. Guard: L must be installed at exactly 1.0.0.2 and Q at 1.0.0.1, or the step refuses and no run starts. Then run
   `lethal run --project scripts/r740-probe/target --tests scripts/r740-probe/tests --backend bcdev --config
   fixtures/sandbox-app/lethal.config.bc2.json --selector-id 93837 --control-id 93838 --table-id 93839 --db <fresh>
   --out report.json --progress-out events.ndjson`, with full stdout, stderr and the exit code.
4. Read the L, P and Q rows.

Then cleanup: Q, then P, then L (every row); read back absent; check bc2 for quarantine.

## Predictions
- **M1:** step 2 is ACCEPTED (no throw). L is installed at 1.0.0.2 and Q stays installed at 1.0.0.1, as R-728.
- **M2:** at the baseline:
  - TestLib fails as an ordinary test line (shape (a)), with "Function ID <n> was called. The object with ID 93820 does
    not have a member with that ID." first;
  - TestPlus passes;
  - TestFails fails with "genuine failure".
- **M3 (the risk): no refusal by any name.** The run exits 0. In detail:
  - `staleTestApp` is null;
  - `unsupportedTests` = {TestFails, TestLib};
  - `caveats` holds `baseline-red` (so "silent" here means NO NAMED CAUSE: "SCOPE: degraded" will show, as in R-738
    run 1);
  - per mutant: Scale's 2 read `no-coverage`, and Plus's 3 are killed by TestPlus.
  - Allowed and recorded, without voiding: the warnings `test-digests-unavailable` and/or
    `test-app-dependencies-unproven`. The dependency fingerprint reads L's served package and its installed row, and
    the old L1 stays published.

## Readings, decided now
- **Void run:** a failure for a cause unrelated to L, P or Q (setup, config, lease, a quarantine, an object-id clash)
  before the baseline. Write an addendum and re-run with set 2.
- **M1 fails** (L2 refused, "could not be restored"): a finding. Stop at step 3's guard, read the rows, report, do not
  re-run. Recovery may need an owner restart of bc2.
- **The run's publish of P is refused** (`UpgradeNotRestoredError`, or any publish error naming Q or L): a finding,
  not a void run. It would recur on set 2. Report, do not re-run.
- **M2 differs** (TestLib answers "found 0", or Q fails to load): `StaleTestAppError` would fire with a wrong remedy.
  "Silent" is then closed, but the wrong remedy is a new finding to file. R740 does not close on it.
- **M3 fails** (a named refusal with a fitting cause): R740 closes with the measurement.
- **M3 holds:** report the measurement and a proposal to the orchestrator BEFORE building (the brief), weighing:
  - (A) a named refusal with a neutral remedy ("recompile and republish the app that makes this call against the
    dependencies installed now"), quoting the failure's first stack frame (it names the calling object and app);
  - (B) a named warning plus a baseline classification (annotate and continue, as R35 and R69), with the full report
    caveat ripple counted.

## Realism
The state is reachable only through a publish that skips recompiling dependents: altool (measured, R-728), or
presumably a dev-endpoint publish with dependency publishing set to "ignore" (unmeasured). A direct dev-endpoint
publish with the default option refuses instead (R709). How often a real project reaches it is not measured.

## Leftovers
bc2 keeps installed-version records for L (1.0.0.2), P (LethAL's minted version) and Q (1.0.0.1) until a restart
(R605), plus the control app's run rows.

## Addendum 1 (2026-10-24, before run 2): the live proof on the BUILT head
Run 1 (20:37:50Z) gave M1, M2 and M3 (`/coord/handoff/R-740/measure.md`). The orchestrator ruled (A), and the refusal
was built (`StaleDependencyMemberError`, lethal/r740 f5991df3). Run 2 repeats the probe on the built head with the
SECOND id set (L edbf191d-45cd-45dd-bd38-f9910c0d60a7, P ef6468b3-8053-4383-a69a-8114dd06fd12, Q
a3014e4e-2f3e-4185-8fce-0519bd133e3a), because bc2 holds run 1's records. Same AL, same object ids, rebuilt only for
the ids:

| build | sha256 |
|---|---|
| L1 | 93f913ac830b3db732a44eb52c1da262bf69d8978bfda7b8b8e20beed0662185 |
| L2 | 1b282640565b5e9d505b7a6ef78a73536b0fce2a1d1d2f3b9705ed265e69eb6b |
| P | 228751a669ca7c6d3e834631c2798f918e719006b233a3c6b5481652f436fa35 |
| Q | c4f2118392d667f9b7667f0895a7d91dfccd61ca5542fa98155c9bd423fb70b6 |

**Prediction (run 2):**
- M1 again (L2 accepted through altool; Q stays installed);
- the `lethal run` REFUSES with `StaleDependencyMemberError`, exit non-zero;
- its message names `R740 Tests.TestLib`, object 93820, and the calling frame
  `R740 Tests(CodeUnit 93840).TestLib line 2 - R740 Probe Tests ...`;
- it does NOT name the target or `TestFails`, and it is not `StaleTargetMemberError`;
- no report is written, no `coverage-split` event is emitted, and no mutant is scored.

Anything else is a BLOCK on the build. Run 2 leaves records for the second id set on bc2 until a restart.
