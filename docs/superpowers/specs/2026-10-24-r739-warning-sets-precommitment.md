# R739 pre-commitment: the warning-code sets after session console lines became events

Coord task R-739, lane lethal-code. Branch `lethal/r739`. Committed to master BEFORE the pinning commit and the
proving run. It builds on R736's sets (`2026-10-24-r736-gate-warning-sets-precommitment.md`) and R744's (R-735,
legs D1, D1c and T).

## Measured
- **Observe mode on head 922f1e11 (master merged).** Logs: `/coord/handoff/R-739/observe/`.
  - bc1: bcdev, bcdev-names, bcdev-wrapped, tables, chunked, harden, lend, verify, testapp, agreement.
  - bc3: hang.
  - al-runner-v3, with `LETHAL_ITEST_V3_TABLES=1` and `LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396` (the update
    gate's `V3_CDO_DEFAULT`, so the pins match the tree the daily gate judges).
- Every gate exited 3. An observe run is never a pass.

## Unchanged from R736 / R744
- bcdev, bcdev-names, bcdev-wrapped, tables, harden, lend, verify/run, testapp/run, agreement/a and agreement/b;
- hang, all four legs;
- al-runner-v3 S1, N1, x-s1, xd-*, L1, Y-A, Y-B, MO and K;
- al-runner-v3/T, as R744 predicts.

## New keys (R739 step 2), all `[]`
- `verify/step3`, `verify/step4`, `verify/step4b`;
- `testapp/step6`, `testapp/step7`;
- `agreement/verify`, `agreement/named`.

**Printed and never asserted:** `verify/refusals`, `testapp/step5-probe`, `testapp/step7-probe` (they throw or refuse
by design).

## Deliberate moves: each is a console line R739 turns into an event
| key | R736/R744 set | new set | why |
|---|---|---|---|
| chunked/control, chunked/chunked | [only-narrowed-run] | [fenced-coverage-no-procedure-lines, only-narrowed-run] | the bcdev fenced-coverage line, now an event. The test `Data Tests.NoTriggerValidateRunsWeak` validates a field with no OnValidate, so its only covered row is the field declaration, inside no procedure. The warning is true about a deliberately weak test, not a frame fault (chunked's frozen figures pass). Ruled 2026-10-24 (orchestrator): pin now; R746 makes the warning precise later, with its own pre-committed pin change. |
| al-runner-v3/WR | [compiled-out-sites] | [compiled-out-sites, coverage-refused-mutants, coverage-refused-object] | the wrapped fixture's two-arm `#if` wrapper has no rule in the v3 coverage index (by design, R298): `coverage-refused-object`, and the 3 mutants that therefore read no-coverage: `coverage-refused-mutants`. Both were console lines. |
| al-runner-v3/D1, al-runner-v3/D1c | R744: [app-json-backslash-path, dependency-report-source-unavailable, only-narrowed-run, tests-only-narrowed-baseline] | R744's set + resource-rebase-collision | the pinned CDO tree has three control-add-ins whose `Script/Start.js` and `Script/events.js` rebase onto one path (issue #20); `prepareBatchProject`'s collision line is now an event. **A deliberate move on R744's keys.** |

**Not asserted:** `al-runner-v3/N1E` shows `al-runner-v3-entries-prefetch-dropped`. N1E throws by design (#5798), and
its codes are printed, never asserted.

**Environment codes, in NO set (R739 plan r2):** `package-cache-leftover`, `package-cache-dangling` and
`al-runner-v3-dotnet-helper-missing`. None appeared.

## Servers and the server-independence claim
- **Proven on:** bc1 (the 10 BC gates above) and bc3 (hang). al-runner-v3 needs no server.
- **The sets claim to be server-independent.** The environment codes are excluded, so a code that appears on only
  one server would be a defect in the pins, not a fact about that server. The first run of each gate on bc2/bc3 is
  the check: a lane that sees a set difference there reports it as a BLOCK against R736/R739, and never adjusts the
  set. (Ruled 2026-10-24.)

## Prediction for the proving run (final head, after R-735's pins have landed)
- Every listed gate passes with exactly these sets.
- Every frozen per-mutant figure is unchanged. The change is warning routing only.
- Any other code difference is a BLOCK.
- envtool is not run (host-only, R683), and verify-scale is exempt (R736).
