# R198 probe — can ONE call run N test methods with today's isolation, and can a second session see where it is?

Measured 2026-09-03 against **Cronus283** (BC 28, runtime 17.0), from a clean publish of this probe.
Re-runnable: `deploy-probe.ps1 -ProjectPath <this dir> -ContainerName Cronus283 -SymbolPath
fixtures/sandbox-data-tests/.alpackages` (the `bc-measure` skill), then `drive.ps1`. Raw output of
the measured run is in `results.measured.txt` (`drive.ps1` writes `results.log`, which is gitignored).

## Why this exists

R198's first design (`docs/superpowers/specs/2026-09-02-r198-run-mutant-many.md`) was refused by
adversarial review with three platform questions nobody had measured: whether N methods in one
run stay isolated from each other, whether a `Commit` from the runner leaks a test's writes, and
whether a second session (the R53 stop hook) can know which method a group is inside. The user's
question was sharper: *why one HTTP call per test at all; can the runner iterate itself and keep
progress somewhere that survives the rollback?* This probe measures that, on the real platform
runner, with `Test Suite Mgt.` driven exactly as `RunMethod.Codeunit.al` drives it today.

## The two shapes measured

- **GROUP**: one suite, N `Test Method Line`s with `Run = true`, ONE `RunAllTests`, and the suite's
  `"Test Runner Id"` pointed at the probe's own runner (`R198GroupRunner.Codeunit.al`): Microsoft's
  130450 copied with `TestIsolation = Function`, progress written to a dedicated table and
  `Commit()`ed from `OnBeforeTestRun`/`OnAfterTestRun`, and `OnBeforeTestRun` returning `false`
  after the first failure. The stock 130450 (`TestIsolation = Codeunit`) is the control.
- **LOOP**: one call, but today's one-method suite run (`RunOneMethod`, verbatim in shape) repeated
  N times in request order by the API codeunit, which writes and commits progress BETWEEN runs and
  exits at the first failure. The stock runner, untouched.

Both keep everything Microsoft's runner does (results into `Test Method Line`, its own `Commit()`
after every method in `PlatformAfterTestRun`) by delegating to `Test Runner - Mgt`.

## What was measured

| # | question | result |
|---|---|---|
| E1 | **Control.** Stock runner (Codeunit isolation), T1 inserts key `K1` asserting nothing, T2 asserts it absent, one run | **T2 FAILS**: `LEAK: K1 written by T1_InsertFixedKey in session 418 is visible in the next method`. Grouping under the stock runner produces exactly the false kill the review feared (F5, arm K's shape). `K1` is gone after the run (rolled back at codeunit end). |
| E2 | Same pair, Function-isolation runner, no progress writes | **T2 passes.** Each method rolled back on its own inside one run. |
| E3 | Same pair, Function runner, progress `Commit()`ed in BOTH triggers | **T2 passes, `K1` absent after.** A commit from the runner's triggers does not carry the test's writes. Same with the commit in `OnBeforeTestRun` only (E3b). |
| E4 | A second session reads progress while the group sleeps in T3 | **Reads `T3_Sleep / before / session 426`** from session 427, mid-run. Cross-session progress works, from a plain committed table row. |
| E5 | Stop at the first failure: T1, T2, T4 (fails), T5, T6 | **T4 = failure, T5 and T6 = 0 (not run).** Trace `B4 A4FAIL S5 S6 S7`: a method skipped by `OnBeforeTestRun = false` never reaches `OnAfterTestRun`. |
| E6 | What a test method itself sees | T6 reads the row the runner wrote for it (`index=6 name=T6_ReadProgress phase=before`), same session as the runner. |
| E7 | LOOP: eight methods, one call | **530 ms, ~45 ms per method** for a full suite rebuild plus run, and T2 passes after T1 (isolation by construction). |
| E7b | GROUP: three methods, one call | 123 ms, **~40 ms per method**. The platform runs each DECLARED method once, in declaration order; repeats in the request collapse. |
| E7c | Today's shape: eight separate one-method calls | **571 ms from the client on a container**, ~71 ms per call. On the hosted sandbox the same call is ~430 ms, of which ~300 ms is the round trip and the fence. |
| E7d | LOOP with stop at first failure | T4 = failure, **T5 skipped**, never run. |
| E8 | **Stop inside a group.** T1, T7 (a 45 s bounded loop), T5. A stop asked for T1, then one for T7 | **`stop for T1: refused: runner is at T7_Hang/before (index 7)`**, then `stopped session 448 inside T7_Hang`, and the held call returned **HTTP 408 after 3.9 s** ("The session was stopped by an AL StopSession call"), not after 45 s. Progress after: still `T7_Hang/before`, the marker of a session that died inside method 7. Same in LOOP mode (E8b, 408 after 3.9 s). |
| E9 | Rows left behind by all of the above | **0.** Nothing leaked across calls, including from the stopped sessions. |

Traces (`B<i>`/`A<i>` per trigger, from an instance global) also show that the platform keeps ONE
runner instance for the whole group, calls `OnBeforeTestRun` for every declared method whether or
not it is selected (the stock `PlatformBeforeTestRun` refuses the unselected ones), and numbers
methods by declaration position.

## What this decides

1. **The user's idea works as stated for the database half**: the runner (or the loop) sets a
   "current method" row, commits it, and it is readable inside the tests and from another session
   while the run is in progress, and a stop can refuse against it (E4, E6, E8). Progress does not
   need to live on the lease row, so the review's F4 is avoided by construction.
2. **A `SingleInstance` variable cannot do the cross-session half.** It is per session, and the
   stop hook is another session. A committed row in a dedicated table is the mechanism.
3. **Function isolation is necessary for GROUP** (E1 vs E2): the stock runner leaks between
   methods of one run. It is not proven sufficient: `TestIsolation` promises database rollback,
   and a test codeunit's own globals, its `OnRun`, and any `RequiredTestIsolation` it declares are
   shared or unmeasured across a grouped run (gpt-5.6-sol's E3/E5/E9 hazards). GROUP also runs in
   declaration order, which discards R197's killer-first order inside a codeunit.
4. **LOOP has none of those caveats**, because every method is its own `CODEUNIT.Run` exactly as
   today, in request order, and it costs ~25 ms more per method than GROUP on a container against
   the ~300 ms round trip it removes on the hosted sandbox. That is the shape the second draft
   should take.

## What is NOT measured here

- The hosted sandbox. The saving is a prediction from run 2's 0.43 s per call and this probe's
  ~45 ms per looped method; the next hosted run measures it.
- A group whose method count pushes one HTTP request past a gateway's idle timeout; the second
  draft caps the group.
- The window between a method's last instruction and the loop's `after` write. It is AL
  statements, not I/O, and the op-level tombstone (R53's `already-completed`) still stands behind
  the per-method one.
