# R-586 pre-commitment r6: leg C's `timeout-is-cpu` and `sleep-is-noop`, and X (d)'s baseline line

Written 2026-10-21 by the builder, after leg C's first live run and BEFORE any leg re-runs. This is a delta on
dcdd1489 (r4) and abe76fa6 (r5). Everything in them stands except the three places below. A differing fact verdict
in leg C, or a differing X (d) row, is a BLOCK.

## Leg C's first run: BLOCKED

- Run on `alrunner 3.0.0-alpha.2 (91253f2d6)`, lethal/r586 at 9a963a6c. Log:
  `/coord/handoff/R-586/gate/C.log`.
- 21 of the 23 facts read as pre-committed. Two did not:
  - `sleep-is-noop` read `gone`. On codeunit 50660, `LongSleepThenAssert` PASSED, with durationMs 0, in a call of
    about 30 ms. r4 predicted that it fails with "after sleep <n>".
  - `timeout-is-cpu` read `diverged`. r4's `WallSpin3s` (a loop on `CurrentDateTime()` for 3000 ms) PASSED ALONE
    in 22 ms at `--test-timeout-secs 2`. r4 predicted a timeout row.
- The cause of both is one fact. v3 alpha.2 runs a VIRTUAL AL clock: `Sleep(N)` returns at once and moves
  `CurrentDateTime()` forward by N. The clock does not follow wall time either.
  - The builder re-ran `scripts/r586-probe/sleep-noop-probe.sh` (exit 0, 31 ms): `LongSleepThenAssert` passes with
    and without `--test-timeout-secs 3`.
  - The lane confirmed it independently on a scratch copy: after `Sleep(600000)`, `CurrentDateTime() - Started`
    reads "10 minutes 1 millisecond", with durationMs 0 and a 122 ms call. A no-Sleep control reads 1 ms.
- So r4's wall-clock spin was an invalid probe on v3. It never burned 3 s of CPU, because the clock it read was not
  wall time.

## Why r4 got it wrong

- The lane's own premise was wrong. `sleep-noop-recheck.md`'s "after sleep 7" came from a probe that sets a counter
  to 7 and asserts `Counter <> 8`, so it fails whatever the clock does. Its TIMING evidence (Sleep rows of 0 ms)
  stands; its clock claim was never tested.
- r4's shape was never measured. The committed `scripts/r586-probe/extras/ProbeSleep.Codeunit.al`
  (`LongSleepThenAssert` reads `CurrentDateTime()` around `Sleep(600000)`) is not the probe the recheck ran:
  that one used Sleep(1500), Sleep(600000) x2, Sleep(2000) x2 and a busy loop. r4 carried the recheck's line over
  to a file it had not run on.
- The wall-clock spin for `timeout-is-cpu` was the builder's choice, ruled acceptable at checkpoint 1. It rested on
  the unchecked belief that `CurrentDateTime()` follows wall time on v3.

## (a) `timeout-is-cpu`, r6

- **Probe.** `Probe Logic.Burn(N)` is a loop with a fixed iteration count and no clock reads:
  `for I := 1 to N do S := (S + I) mod 1000;`. Two test codeunits:
  - 50656 "Probe Burn Long", whose `CpuBurnLong` calls `Burn(110000000)`;
  - 50658 "Probe Burn Short", whose `CpuBurnShort` calls `Burn(55000000)`.
- **Calibrated once**, 2026-10-21, in this container, on alpha.2, with light single-codeunit runs. This is probe
  calibration, not a gate result. The base argv is
  `<v3> test --output-json --isolation test --package-cache <deps> --bc-version 28.0.46665.47126 --no-download --codeunit <id> <app> <tests>`.

  | Iterations | Timeout flag | Core | Exit | Wall | CPU (user) | Row |
  |---|---|---|---|---|---|---|
  | 110,000,000 | none | free | 0 | 3.018 s | 2.998 s | pass, durationMs 2985 |
  | 110,000,000 | `--test-timeout-secs 2` | free | 7 | 2.039 s | 2.023 s | error, notRun, "Test exceeded 2s timeout.", durationMs 2004 |
  | 55,000,000 | none | free | 0 | 1.495 s | 1.489 s | pass, durationMs 1467 |
  | 55,000,000 | `--test-timeout-secs 2` | `taskset -c 0` beside `taskset -c 0 sh -c 'while :; do :; done'` | 0 | 3.171 s | 1.523 s | pass, durationMs 3105 |
  | 55,000,000 | none | the same shared core | 0 | 3.153 s | 1.526 s | pass, durationMs 3102 |

- **The fact:**
  - alone: `--test-timeout-secs 2 --codeunit 50656`. `CpuBurnLong` (3 s of CPU) gives a notRun row
    "Test exceeded 2s timeout.";
  - shared: `--test-timeout-secs 2 --codeunit 50658` under `taskset -c 0`, beside the busy loop. `CpuBurnShort`
    (1.5 s of CPU) PASSES, and its row's durationMs is over 2000 (wall over N).
- `matches` = both. Anything else is `diverged`, and that refuses the session. A wall-time stop would stop the shared
  run, and no stop at all would let the alone run pass. Each direction has a red-going unit test.
- **Prediction for the re-run:** `matches`.

## (b) `sleep-is-noop`, r6

- **Restated.** Sleep returns at once AND advances the AL clock by the requested time. The fact is measured on
  codeunit 50660 (no CPU-bound sibling), twice: with `--test-timeout-secs 3` and with no flag.
- **Classifier (`classifySleep`), per call,** over the rows of `ShortSleep`, `LongSleepA`, `LongSleepB` and
  `LongSleepThenAssert`:
  - `gone` if any of those rows took its real time (durationMs ≥ 1000), or was stopped as a timeout row (notRun,
    message starting "Test exceeded"). So `LongSleepThenAssert` (600 s, over N) stopped as a timeout row reads
    `gone`. That is upstream's proposed #5605 fix, where slept virtual time counts toward `--test-timeout-secs`.
  - `defect-present` if the call is under 1 s, every one of those rows passes with durationMs under 100, and
    `LongSleepThenAssert` passes (elapsed ≥ 600000).
  - `diverged` for any other combination, for example fast but the clock not advanced (`LongSleepThenAssert` fails).
    It is never `matches`. A `diverged` defect fact refuses the session, as a contract fact does.
  - `unmeasurable` if there is no document, or a row is missing and none reads `gone`.
- **The fact's verdict:**
  - `gone` if either call reads `gone`. The fix stops a long Sleep only under a timeout flag, so the flag-free call
    may stay instant;
  - otherwise the two calls' common verdict, if they agree;
  - otherwise `unmeasurable` if either is unmeasurable, and `diverged` if not.
- An `unmeasurable` defect fact does not refuse the session, because §6 is fail-closed independently of it; it is
  warned by name. In the gate's leg C it is a miss, since the leg predicts `defect-present`. The warning is
  `[lethal] al-runner-v3-defect-unmeasurable: <fact>: ...`, which `status()` prints through `v3DefectWarnings`.
  A unit test pins it and goes red without the warning (red check: 19 pass / 1 fail; restored 20 / 0).
- Unit tests pin each of the four outcomes. Among them, `LongSleepThenAssert` stopped as a timeout row reads `gone`.
- **Prediction for the re-run:** `defect-present`.
- A `gone` never changes the §6 rule by itself. It prints `al-runner-v3-defect-gone`, and §6's fail-closed rule is
  relaxed only after a measurement, never by assumption.

## (c) X (d), r6

- r5's baseline line "`LongSleepThenAssert` fails (Sleep does nothing) and goes to `unsupportedTests`" is withdrawn.
  It PASSES, stays green, and is not a covering test of the Sleeper mutants.
- r6 baseline: `ShortSleep`, `LongSleepA`, `LongSleepB`, `LongSleepThenAssert` and `SleeperDoubles` are all green.
  NO ProbeSleep test is in `unsupportedTests`, and the leg asserts that.
- The M0001-M0005 table, the error set {M0003, M0004}, the hit-count and note assertions, the M0002 twin and the
  4 + 5 index are unchanged from r5.

## Leg C, r6 summary

- 23 facts.
- These read `defect-present`: `upstream-compile-errors`, `duplicate-key-insert-raises`, `sleep-is-noop`,
  `refusal-cascade`, `codeunit-runs-whole`, `quoted-name-unselectable` and `commit-under-test-isolation`.
- Every other fact reads `matches`, `timeout-is-cpu` included.
