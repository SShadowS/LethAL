# itest:bcdev

`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` runs `fixtures/sandbox-app` with
`fixtures/sandbox-tests` on a BC server, through the bcdev backend. This is the authoritative
backend: its verdicts are the reference that other backends are compared with. The connection
comes from the gitignored config in `fixtures/sandbox-app/` that `LETHAL_ITEST_CONFIG` names, and
its paired `.vscode/launch.<x>.json` (see [servers.md](servers.md)).

## Frozen figures

```json gate-figures
{
  "gate": "itest:bcdev",
  "baselines": {
    "bcdev.baseline.json": { "killed": 3, "survived": 12, "no-coverage": 4 }
  },
  "constants": {
    "BCDEV_FIGURES.totalMutantSites": 19,
    "BCDEV_FIGURES.killed": 3,
    "BCDEV_FIGURES.survived": 12,
    "BCDEV_FIGURES.noCoverage": 4,
    "BCDEV_FIGURES.groupedCalls": 15,
    "BCDEV_FIGURES.warmKills": 0,
    "BCDEV_FIGURES.assertionScreenDiscrimination": "vacuous"
  },
  "notPinned": {
    "killPositionOfEveryKill": 1,
    "sessionReusedRows": 0
  }
}
```

What the figures mean:

- 3 / 12 / 4 over 19 is killed / survived / no-coverage.
- `groupedCalls` is 15 (R198). That is one `RunMutantMany` call for each scored mutant (3 killed
  plus 12 survived). If the counter stopped being wired, it would read 0 and the gate would fail.
- Since R582 every kill is re-run once under the mutant after its confirm passed (R577's rule),
  and must fail again to stay killed. `groupedCalls` stays 15 because all 3 kills are at position
  1, so each re-run is one single `RunMutant` call, not a group call. Both runs check that every
  kill carries `killReproduced` and has exactly 2 mutated rows for its killing test in that run
  (the fixture's store is persistent, so the check reads only the run it made).
- `warmKills` is 0 (R206). Every kill is at `killPosition` 1. No row is `session-reused`. The gate
  also checks session ids in the results store: the number of distinct ids among grouped rows must
  equal the number of group calls that answered.
- The assertion screen's `discrimination` is `vacuous` (R132). The assertion screen (R121) flags a
  kill whose failure text does not come from an assertion library. This suite raises errors only
  through bare `Error(...)`, so the screen flags every kill and separates nothing. `itest:tables`
  used to pin this case; it gave it up when its fixture gained an assertion arm (see
  [tables.md](tables.md)).
- `killPosition` 1 and zero `session-reused` rows are written as literals in the gate's
  assertions, so the pin test cannot check them.

## History

- R161 (2026-08-19) re-ran this gate after adding guard-clause mutants elsewhere. It was
  unchanged, at the figures of that time (3 / 10 / 3). `sandbox-app` has no site for that
  operator; this was measured.
- R193 and R197 (2026-09-02) re-recorded the baseline. R193 added identity ordinals for twins.
  R197 made covering tests run killer-first.
- From R220 until R654 the .NET al-runner gate was compared with this gate's table mutant by
  mutant (history: [alrunner.md](alrunner.md)). Since R654 the Rust al-runner's legs S1 and K
  are compared with it the same way; see [alrunner-v3.md](alrunner-v3.md).
- R589 (2026-10-21): the gate passed on `bc1`, `bc2` and `bc3`, per mutant equal to its baseline,
  on the pre-runtime-17 fixtures. It passed on `bc1` again under R-583's runtime-17 code. The
  baseline was recorded on Cronus28 (DK), so this also shows the W1 company changes no verdict
  here. Cronus28 is now parked. Which servers the gate may run on now: the proof table in
  [servers.md](servers.md) (proof is per server).
- R582 (2026-10-22) switched R577's "a kill must reproduce" rule on for bcdev. No verdict and no
  counter moved here (`docs/superpowers/specs/2026-10-22-r582-bcdev-kill-reproduction-precommitment.md`).
