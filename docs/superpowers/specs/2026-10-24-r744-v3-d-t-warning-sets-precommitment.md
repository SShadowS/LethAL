# R744: warning-code sets for al-runner-v3 legs D1, D1c and T: pre-commitment (lane bugs, R-735, 2026-10-24)

Committed before the pinning run. Never edited after; changes go in a dated addendum file.

## Why
R736 made every gate leg pin its exact set of warning-event codes (`GATE_WARNINGS` in
`packages/runner/itest/gate-expected.ts`). R736's al-runner-v3 proof did not run the legs that need
`LETHAL_ITEST_V3_TABLES=1` (T) and `LETHAL_ITEST_V3_CDO` (D1, D1c), so those legs have no entry and end
INFRA-FAIL `GateWarningsUnrecordedError` (observed on R-735's head 58843760, log
`/coord/handoff/R-735/v3/gate.log`). `scripts/al-runner-v3-update.ts` sets both variables, so the daily
update gate infra-fails the same way (fail-closed: `current` does not move).

## The sets (observed at 58843760; per-code analysis in `/coord/handoff/R-735/pins.md`)
- `al-runner-v3/D1` and `al-runner-v3/D1c`, exactly:
  `app-json-backslash-path`, `dependency-report-source-unavailable`, `only-narrowed-run`,
  `tests-only-narrowed-baseline`.
  - `only-narrowed-run` and `tests-only-narrowed-baseline`: the D legs run one file (`only`) and one test
    pattern (`testsOnly`).
  - `app-json-backslash-path`: the pinned CDO checkout's own tracked `Cloud/app.json` names its logo with a
    backslash; the rewrite is a plain string replace with no platform branch, so it fires on every machine.
  - `dependency-report-source-unavailable`: five Continia apps in the pinned `Test/.alpackages` carry a version
    component above 65535; decided by those pinned files' bytes.
  - All four are decided by pinned input: the gate refuses the D legs unless the checkout is at 5f2a71d,
    clean, with the pinned corpus fingerprint, slice sha256 and the sha256 of all 17 `.alpackages` apps.
- `al-runner-v3/T`, exactly the existing `TABLES` set: `non-executable-sites-dropped`,
  `not-instrumentable-files-skipped` (the table fixture `fixtures/sandbox-data`, the same as `itest:tables`).
- No code is left out as environment-dependent: none of the six depends on the machine, OS or a checkout
  state the gate does not verify.

## Predictions (any miss is a BLOCK)
- P1. With the three entries added (and nothing else in `GATE_WARNINGS` changed), the full
  `LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_TABLES=1 LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396
  bun run itest:alrunner-v3` on the submitted R-735 head passes all 15 legs, update-gate outcome pass.
- P2. D1, D1c and T each observe exactly their set above.
