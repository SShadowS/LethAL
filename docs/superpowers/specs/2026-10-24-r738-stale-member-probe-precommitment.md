# R-738 pre-commitment (2026-10-24): a real `lethal run` over a tests app left stale by its own altool publish

Committed before any server call. Probe: `scripts/r738-probe/` (lethal/r738; README there), built offline, plan
`/coord/handoff/R-738/plan.md` (opus plan review applied). Server: bc2 (BC 28.4 W1), under lethal-preproc's lease,
after `bc-linux-setup.ts --server bc2` (own lease). **Do not rebuild after this commit.**

| build | what | sha256 |
|---|---|---|
| T1 | R738 Probe Target (9ab6e9c7-80ec-440d-b1d9-13bf0799890d) 1.0.0.1: `Answer()`, `Other(X)`, `Scale(X)` | 270a09a6c201ae9ef715db2cf35ee6dbc4701fcc0397026b502bb445fc4fee3d |
| Q | R738 Probe Tests (e08e9874-95dd-4a77-b4d4-bb1fdee916d2) 1.0.0.1, against T1: TestAnswer, TestOther, TestScale, TestFails | 5a305238dd71795561d0d4808c9db85a9e7f2a16381e218cb02a3aef7d82c3f1 |
| TS | the run's SOURCE `target/` (no `Answer`; `Scale(X; Y)`), compiled offline against the shared symbol cache to prove the run can compile it | ae3d35c93444fdd691440f9c6bb2a43e3b3f3affd1d3484aa8dee4e1b02f55e4 |

A second id set for a re-run (only after an addendum here): target ed1d8576-28e2-4c30-bff1-827dd234b9b1, tests
2dcfea83-366b-4775-9b7f-003247b39755.

## Steps (`drive.ts --all`, once)
1. Publish T1, then Q, directly; read both installed at 1.0.0.1.
2. Run `lethal run --project scripts/r738-probe/target --tests scripts/r738-probe/tests --backend bcdev --config
   fixtures/sandbox-app/lethal.config.bc2.json --selector-id 93797 --control-id 93798 --table-id 93799 --db <fresh>
   --out report.json --progress-out events.ndjson`, keeping its full stdout and stderr and its exit code. The bcdev
   coverage mode is the default, "fenced", so the baseline runs through RunMutant -> LC Run Method -> RunOneMethod.
3. Read the target and tests rows by id.

Then cleanup: uninstall and unpublish Q, then every row of the target; read back absent. After the run, check that bc2
has no quarantine record and clear any with `clear-quarantine`.

## Predictions
- **N1:** LethAL's altool publish of the instrumented target is accepted (as R-728).
- **N2:** at the baseline, TestOther passes and TestFails fails with "genuine failure". TestAnswer and TestScale do
  not pass, in ONE of these shapes, recorded verbatim (message and call stack) from the `baseline-batch-finished`
  event:
  - (a) a test line, outcome fail or error, carrying BC's text (expected: "... does not have a member with that ID");
  - (b) the line-count wrapper "RunMutant returned 0 test lines, expected exactly 1; server: <BC text>";
  - (c) "expected exactly one method X, found 0";
  - (d) anything else.
- **N3 (the risk): the run does NOT refuse.** In values:
  - exit code 0 (or LethAL's normal non-zero for a non-green baseline, recorded as is);
  - `baselineGreen` false;
  - TestAnswer and TestScale have classification `[]` in the event, and the report's `staleTestApp` is empty;
  - `Scale`'s mutants read `no-coverage` (their only covering test is stale), while `Other`'s are killed by TestOther.

## Readings, decided now
- **Void run:** a refusal or crash for any reason before the baseline (compile, publish, lease, quarantine, config)
  is NOT a reading of N3. Fix the probe, write an addendum here, and re-run with the second id set: BC keeps the target's
  record at LethAL's minted version (R605), so T1 1.0.0.1 cannot be installed again.
- **N1 fails** (the publish is refused): stop. Record the error (R709's `UpgradeNotRestoredError` should fire), read
  the target and tests rows, and report before anything else. Cleanup may be impossible there; recovery is an owner
  restart of bc2.
- **N2 is (c), or the run refuses by name** (StaleTestAppError or another named refusal): no silent drop. R738 closes
  with the measurement, and nothing is built.
- **N3 holds:** build the refusal on the EXACT measured text and shape, in a NEW describer beside
  `describeStaleTestApp` (never inside it, and never counted as found-none, so `TestCodeunitDiscoveryError` cannot
  fire), with its own error class extending `Error` directly. It refuses only when the object BC names is one of the
  target's declared object ids, and the recovery it names is republishing the tests app built against the current
  target. Red tests: the measured shape refuses; a genuinely failing test still reads as failing; a member error naming
  a non-target object does not refuse; the found-0 path is unchanged.
- **TestAnswer and TestScale differ** (removed member vs changed signature): record both texts; the build covers what
  is measured, and the rest is filed.

## Leftovers
bc2 keeps installed-version records for the target (at LethAL's minted version) and the tests (1.0.0.1) until a
restart (R605), plus the control app's registry, op and progress rows for this run (fresh ids, harmless) until a
restart.

## Addendum 1 (2026-10-24, before run 2): the live proof on the BUILT head
Run 1 (19:16:59Z) gave N1, N2 shape (a) and N3, as recorded in `/coord/handoff/R-738/measure.md`. The refusal was then
built (`StaleTargetMemberError`, lethal/r738 7dd4a991). Run 2 repeats the same probe on the built head as the live
proof, with the SECOND id set: target ed1d8576-28e2-4c30-bff1-827dd234b9b1, tests 2dcfea83-366b-4775-9b7f-003247b39755.
bc2 holds run 1's records. Same AL, same object ids, rebuilt only for the ids:

| build | sha256 |
|---|---|
| T1 | 4c5c282b0dd48365bf22cfa6e87040c57c3aafb3cb12d3da27b9517b94b5015c |
| Q | 50600b6d4abb1623f327556c46d3b33b9ceb82d28c4578efd09d462fa9c1effe |
| TS | f0385c811be415314908b4c4387657fbb3ec6443f2c5bd0bcee757b5c76cc58b |

**Prediction (run 2):**
- the publish is accepted (N1);
- the `lethal run` REFUSES with `StaleTargetMemberError`, exit non-zero;
- its message names `R738 Tests.TestAnswer` and `R738 Tests.TestScale`, and object 93790, and says to republish the
  tests app;
- `TestFails` is NOT named;
- no report is written, no `coverage-split` event is emitted, and no mutant is scored.

Anything else is a BLOCK on the build. Run 2 leaves records for the second id set on bc2 until a restart.
