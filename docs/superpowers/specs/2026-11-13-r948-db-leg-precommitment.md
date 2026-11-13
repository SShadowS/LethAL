# R-948 pre-commitment: v3 gate leg DB (the baseline through one serve daemon) and what else moves

Committed before the leg or the changed gate ever ran, 2026-11-13. Coord task R-948 (R961). Build: lethal/r948 at ab34ff6a (commits
0546dc06, eebec7cb, 08487399, ab34ff6a). al-runner: the gated `current`, edge-2bd87774f.

## The new leg DB

S1E's project and transport (serve-entries), plus `daemonBaseline: true` and the memory guard on (`memoryHeadroomGb: 4`, the reader
fixed at 1 GiB used of 32 GiB so the leg is host-independent). Not a new baseline file. Predicted, every item checked by the leg:
- **Per mutant equal** to `bcdev.baseline.json` (verdict, killingTest, note set), exactly as S1E: 22 mutants, 3 killed / 14 survived /
  5 no-coverage. Baseline green; no state, refused-nearby, Sleep or runner-refusal notes; Sleep index 0 + 0; kills reproduced.
- **S1E_PINS unchanged:** pairRequests 3, liveRequests 1, boundChecks 3, warmups 1, entriesSent 48, pairBatchRequests 1 / stored 3 /
  served 3 / refused 0, echoMismatches 0 (baseline requests are not counted in boundChecks; the identity
  boundChecks = warmups + prefetch + live + coverage holds).
- **The daemon baseline was used, not dropped:** `daemonBaselineReport()` has `dropped` undefined, `baselineDaemon` true, `codeunits`
  >= 1, `requests` == `codeunits`, `sampledCodeunits.length` == `compared` == the sample rule's count for that n (2nd and last
  codeunit plus every 10th, cap 16, never index 0), `perTestRequests` 0.
- **Warning set exactly** `["al-runner-v3-memory-guard"]`.
- The one-shot process count for the fixture equals its sample count, not its codeunit count.

## Every other leg

Unchanged: the gate's other legs build the backend without `daemonBaseline` and without the guard, so their figures, warning sets and
pins do not move. A difference in any of them is a BLOCK. DB is not in `V3_GATE_LEGS` (like ISO); it is in the default legs after S1E.

## What would falsify the build

Any DB per-mutant difference from `bcdev.baseline.json`; the daemon baseline dropped (`dropped` set) or not used; a sample count off
the rule; any warning beyond the guard's line; any other leg moving.
