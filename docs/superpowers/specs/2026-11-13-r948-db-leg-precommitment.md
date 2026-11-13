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

## Amendment 1 (2026-11-13, before any gate ran): DB's served count and the new leg DBI

Build now lethal/r948 at a6088667 (adds a review round: lending-tag order, memory stop under `--workers`, hold release on throw).
- **DB, added:** `served === codeunits - sampled` (daemon answers actually taken by calls; with a single codeunit `served` is 0 by
  rule, so this bites only with two or more codeunits).
- **New leg DBI** (after DB in the default legs, not in `V3_GATE_LEGS`): the ISO leg's session (S1's project under `isolateTests`),
  serve-entries, `daemonBaseline: true`, the guard on with the fixed 1-of-32 GiB reader. Predicted: 22 mutants, 3 killed / 14 survived /
  5 no-coverage, per mutant equal to `bcdev.baseline.json` as ISO; `executionContexts[0].isolateTests` true; no state notes;
  `daemonBaselineReport()` with `dropped` undefined, `baselineDaemon` true, `perTestRequests` > 0, `sampledPerTest.length` ==
  `compared` == the sample rule's count for `perTestRequests`, `served` > 0 and `served === perTestRequests - sampled`; warning set
  exactly `["al-runner-v3-isolate-tests", "al-runner-v3-memory-guard"]`.
- The memory guard's refusal path is unit-tested only (the gate's reader is fixed under the bound); the legs exercise the pass path.
- Falsifiers as above, for DBI too; every leg other than DB and DBI unchanged.

## Amendment 2 (2026-11-13, before any gate ran): a named skip is a note, not a BLOCK

Build now lethal/r948 at 6400433e (2596b7fe plus origin/master merged, including R-945; S1E's pins are unchanged by that merge).
A daemon answer the fill skips (a row too slow to stand under the budget rule, a request error, a refused or foreign row) is named in
`daemonBaselineReport()` (`skippedTooSlow`, `skippedError`, `skippedOther`, `sampledSkipped`) and printed as a note. The exact-count
checks above become: `served + skippedTooSlow + skippedError + skippedOther === expected` (DB: codeunits less the sample; DBI:
per-test requests less the sample) and `compared + sampledSkipped === sampled`. A silent drop (nothing taken, nothing named) still
fails, and `dropped` must still be undefined. The prediction stays: no skips on an unloaded container (`served` equal to `expected`);
a run with named skips passes and is reported with its skip list.

## Amendment 3 (2026-11-13, after the first gate run, before any change to K): leg K moves, and this file said it would not

**What happened.** The first full v3 gate on 0604b3cb (`/coord/handoff/R-948/v3gate.log`) passed every leg, DB and DBI as predicted
above (DB: 22 mutants, 0 differences, serve counters equal to S1E_PINS; DBI: 22, 0 differences, `served` 1 of 2 per-test requests
with 1 sampled), and D1, D1c and T, but **BLOCKed at K**: its warning set gained `al-runner-v3-memory-guard`. "Every other leg is
unchanged" above was wrong: K is the one leg that builds its backend through `cli.ts`'s `buildBackend`, which turns on both the daemon
baseline and the guard for every serve-entries session. The survey behind that sentence looked only at legs constructing the
backend directly.

**K's new predictions** (committed before K's expectations are edited or the gate re-run):
- Per mutant equal to `bcdev.baseline.json` (3 killed / 14 survived / 5 no-coverage over 22, the 5 all in `SandboxPricing`), as
  before.
- `serveSpawns` **2** (was 1): the baseline's own daemon and the mutant phase's.
- `oneShotTestCalls` **1** (unchanged in number): now the cross-check sample of K's single test codeunit, no longer the one-shot
  baseline.
- Warning set gains exactly `al-runner-v3-memory-guard`.
- K's guard reads the REAL cgroup (only DB and DBI fix the reader): on a container above `memory.max` - 4 GiB the leg would wait or
  stop. Gate runs therefore start only under the interim admission rule (current + 2 GiB < 28 GiB); a guard stop in K is reported,
  not a regression.
Every leg other than DB, DBI and K: unchanged.
