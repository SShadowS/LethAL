# R-554: is a request-page trigger mutant unreached on BC? (pre-commitment)

Committed to master BEFORE the live run. Lane `lethal-preproc`, 2026-10-09.

## The question

R554 says the request-page trigger mutants in R-550's report arm survive because they are covered but never reached.
"Never reached" was measured on al-runner only. On BC it was ASSUMED from `UseRequestPage(false)`. A request page that
was reached but not checked would survive in the same way, because no test reads `Shown`.

BC can now answer this directly. A mutant at statement grain carries `guardReached`: whether its own statement began
executing while it was active (GH-24, control app 1.0.0.19 and later). It also carries `reachedBy`: the tests whose run
reached it.

## The run

- Fixture: `fixtures/sandbox-wrapped` and `-tests`, as published on Cronus28 for `itest:bcdev-wrapped` (R-560b
  confirmed them 2026-10-09).
- Two legs, as in that gate: `coverageMode: "fenced"`, and `"procedure"` (the hub).
- Runner: the probe `scripts/r554-probe/bc-reach.ts`, which uses the same setup as the gate's `runLeg` and keeps
  both reports. One Cronus28 lease, released after the run.

## Expected result, per leg, for both `Wrapped Y Band` (wrapped) and `Wrapped Y Band Twin` (unwrapped)

**A. The request page: `OnOpenPage`, 3 mutants per report (`empty-block`, `remove-assignment`,
`flip-boolean-literal`).** Each one must be:
- `survived`, with no killing test;
- `reachGrain` `statement`, with `guardReached: false` and `reachedBy: []`;
- covered, meaning `coveringTests` is not empty and includes `BandYRun` (or `BandYRunTwin` for the twin).

So each one is covered but not reached.

**B. The control: `OnPreReport`, `empty-block` and `remove-assignment`.** These also survive (`Total := 0` on a
fresh report changes nothing), but BandYRun runs that trigger. Each one must be:
- `survived`;
- `guardReached: true`, with `BandYRun` (or `BandYRunTwin`) in `reachedBy`.

So B has the same verdict and the same object as A, and differs only in reach.

**C. No error or hang.** No row of either report is `error`, `timeout-killed`, or quarantined. The session baseline
is green on both legs.

**D. Unchanged verdicts.** All 28 report-arm verdicts equal `bcdev.wrapped.baseline.json`.

## How the result is read

- **A and B hold on both legs:** BC agrees with al-runner. R554 is closed BY RULING: the survivors are labelled
  correctly as covered but unreached; they deploy as they do now; and the remaining cost is a misleading `survived`
  label, not a false kill.
- **Any request-page mutant reads `guardReached: true`:** BC reaches the request page even with
  `UseRequestPage(false)`. The assumption is false. R554 stays open, and a plan follows.
- **B reads `false` or is missing:** the probe cannot tell reached from unreached on this object, so A proves
  nothing. That is reported as INCONCLUSIVE, not as agreement.
- **A or B missing on the hub leg only:** reported, and the ruling rests on the fenced leg alone.
- **Any error or hang:** a BLOCK, reported as it is.

## Census (offline, no BC)

Count the deployed mutants that sit inside a `requestpage` node, per corpus: BaseApp (BC.History w1-28), DC, DO, CDO
and the repo fixtures. Each count is split into files whose object is `#if`-wrapped and files that are not. Only
counts and paths are recorded, never source text. At most 2 corpus jobs run at once, container-wide.
