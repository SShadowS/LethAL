# R-586 pre-commitment r5a: leg X (d)'s setup, one file more removed from the scratch test copy

Written 2026-10-21 by the lane, BEFORE leg X (d) has scored any mutant on any head. A delta on abe76fa6 (r5) and
c7c505e6 (r6). It changes ONE line of r5's "Setup": nothing else in r4, r5 or r6 moves.

## Why

On head 462a53aa, leg X (d) hit an infra-fail in `deploy()` before any mutant was scored: the backend's alc compile
proof of the TEST app (plan §3 step 2) rejected `probe-tests/src/ProbePermissions.Codeunit.al` with
`AL0169: The option value 'Restricted' is not valid` (`TestPermissions = Restricted;`, codeunit 50654), against
X (d)'s dependency apps (the Microsoft apps of `fixtures/sandbox-tests/.alpackages`). Log:
`/coord/handoff/R-586/gate/final/X.log`.

r5's offline check compiled only the probe APP with alc and generated the mutants through a stub backend; the
scratch test copy was never alc-compiled against X (d)'s dependencies, so r5 missed it.

## The change

r5's setup line for the scratch copy of `probe-tests` reads: "with `extras/ProbeSleep.Codeunit.al` added and
`ProbeCoverage.Codeunit.al` removed". It now reads: "with `extras/ProbeSleep.Codeunit.al` added, and
`ProbeCoverage.Codeunit.al` and `ProbePermissions.Codeunit.al` removed".

## Why no prediction moves

- `ProbePermissions.Codeunit.al` holds no `Sleep(` call (counted: 0), so the test-side Sleep index stays 5
  (`ShortSleep`, `LongSleepA`, `LongSleepB`, `LongSleepThenAssert` in ProbeSleep; `SleepHang` in ProbeHang), and
  the predicted index stays **4 + 5**.
- It is outside `--tests-only src/ProbeSleep.Codeunit.al`, so it is not a covering test of any Sleeper mutant.
- The M0001-M0005 verdicts, the error set {M0003, M0004}, the hit-count and note assertions and the M0002 twin are
  unchanged (r5, with r6's baseline line).
- The committed probe file itself is NOT changed; leg C's contract probe still uses it unchanged.
