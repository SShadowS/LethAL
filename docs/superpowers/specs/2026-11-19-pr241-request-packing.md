# PR-241 (DO speed lever 2): al-runner's fixed per-request cost, and packing prefetch requests — spec-light, measure first

lethal-preproc, 2026-11-19 (coord PR-241, from PR-231's ranking). Offline only: y3's events, no run. Build and the A/B only
after the orchestrator's ruling. Scripts and outputs: `/coord/handoff/PR-241/` (`fixed.py`/`fixed.txt`,
`pack.py`/`pack.txt`); the code facts from a read-only survey (names, not lines).

## 0a. Amendment 1 (2026-11-19, the orchestrator's rulings and a read-only state check, before the build)
- **RULED:** run the A/B (Q1), arm B at 64 entries (Q2), live requests after (Q3). Build the off-by-default knob with red
  tests both ways (off = exactly today's requests; on = consecutive units of one lane up to the cap, never across lanes).
- **The cross-unit risk, stated precisely (replaces §2's "Isolation" bullet):**
  - Packing does not change what an entry sees from al-runner. Per-entry reset, within one request and across requests on
    one daemon, is MEASURED for seven state kinds plus Commit (PR-24's carry probe, `/coord/handoff/PR-24/carry-probe/`;
    gate leg O1 on every gated build). No verdict reads al-runner's per-request `baselineMs` (timing only); a kill is
    judged against LethAL's session baseline rows and the kill pairs. The per-request `setupMs` reloads unchanged sources.
  - Two things LethAL decides PER REQUEST would change, and the build AVOIDS both instead of accepting them:
    1. `runSelectedOnly` is one flag per request: a unit is packed only if the request's flag is the same with and
       without it, so no unit's excluded tail starts running hidden.
    2. The PR-56 kept-refusal drift guard checks the request after a kept refusal: that next request is never packed.
  - Per-unit bookkeeping stays per unit (`prefetched`, `timedOutMutants`, `pairStore`, each unit's `batchKillPairs`).
    Never pack across a deploy or across modes.
  - Still unmeasured, as today: the .NET helper's state across requests, a leaked row, and Random values at a different
    position in a request. The per-mutant comparison is the guard.
- **§3 recorded figures add:** live-request count, entries per live request and live wall (for lethal-code's PR-242,
  which pre-commits the live saving per packing factor against arm B).

## 0b. Amendment 2 (2026-11-19, the build done; the A/B pre-committed before it runs)
- **Built** on `lethal/pr-241` cd660eb34 (VERIFY 15,194/0; Opus build review: no BLOCK, its three should-fixes applied):
  `LETHAL_V3_PACK_ENTRIES=<n>`, off by default. Under it, one packed request is ONE `prefetchMutants` call over the lane's
  consecutive units (`unitSizes` marks them); `batchKillPairs` still runs per unit. **Packing is OFF under a time
  budget** (R912's deadline clamp would otherwise drop a whole packed request), so §2's "a stop loses at most one window"
  holds.
- **The A/B** (`/coord/handoff/PR-241/ab.sh`), after PERF-10's control ends, on `current` (4ebfe7913):
  - PR-94's DO e-document slice (`--only` its four codeunits, R-942's source and the PR-67 v3 config), `--workers 3`,
    NO `--time-budget` (an outer `timeout` of 7,200 s only), fresh stores, heavy slot `--peak 18`.
  - One checkout (`lethal/pr-241`); arms run back to back: A (knob unset), B (`LETHAL_V3_PACK_ENTRIES=64`), then A2
    (unset again) to see drift.
- **Pre-committed bounds for B against A** (the slice's unit sizes are not known offline; these are y3's ratios):
  1. B's prefetch requests ≤ 45% of A's;
  2. B's prefetch setup+baseline lane-seconds ≤ 50% of A's;
  3. B's mutant-phase wall at least 4% below A's AND below A2's (drift check);
  4. live requests: B within ±2% of A (lethal-code's PR-242 amendment 1, master bced1dccc: per-unit pair batches);
  5. **must hold, or no adoption:** every mutant's verdict equal to A's per mutant on the full site key;
     `killingTest` may differ only as R197's ledger orders it (named per mutant); the timeout-killed set equal; no new
     warning code; daemon peak RSS per request recorded, and no lane's peak above A's by more than R987's per-request
     budget (4 GiB).
- A miss of 1-3 on this slice is reported as measured (the slice may have different unit sizes than y3), not explained
  away; a miss of 5 is a BLOCK for adoption.

## 0d. Amendment 4 (2026-11-19, coord PR-246, before any further A/B): §1's packing estimate was WRONG; the corrected figure
- **The error:** §1 said y3's requests are small because "the unit, not a cap, sets the size", and `pack.py` merged
  requests by entries alone. Both came from the code survey's inference, never measured against y3's sizing events.
- **Measured now** (`/coord/handoff/PR-246/sized.py`, `pack-budget.py`; y3's `serve-request-sized` events, one per request,
  each listing its codeunit calls, entries and measured per-entry cost):
  - y3's prefetch requests are bound by R987's **4 GiB measured-cost budget**: cost/budget p50 0.85, p90 1.65. DO's entries
    are memory-heavy, so a request fills the budget at ~20 entries. The 16-unmeasured cap bit once in 5,052 requests.
  - Re-simulated with the budget enforced (the cap packing goes through): 64 entries: 5,052 -> 4,899 prefetch requests,
    **~94 s wall saved** (not ~1,770 s); 128: ~101 s; 256: ~105 s.
- **So lever 2 as packing is about 0.4% of the mutant phase on DO**, and amendment 3's small 73 -> 59 on the slice had the
  same cause. The knob stays as merged (off by default, verdict-neutral); no speed A/B of packing is worth running on DO.
- **Where the fixed cost could still be cut** (for the orchestrator; not measured here): R987's per-request budget
  (requests would grow only if the 4 GiB per-request budget grew, against the container's 32 GiB and 3 lanes), or the
  per-entry memory growth itself (upstream #8026, resource files that entries replace), which is what makes DO's requests
  small; and upstream's per-request floor (R1092).

## 0c. Amendment 3 (2026-11-19, the A/B's result): packing is SAFE; its speed is NOT shown on this slice
Run 20:27-21:52Z, arms A, B (64), A2 back to back on `lethal/pr-241` cd660eb34, `current` 4ebfe7913; outputs
`/coord/handoff/PR-241/ab-{A,B,A2}/`, comparison `ab-compare.py`/`ab-compare.txt`.
- **Bound 5 (correctness): MET.** 1,006 mutants in every arm; per mutant on the full site key, 0 verdict and 0
  `killingTest` differences (A-B, A-A2, A2-B); counts identical (390 killed / 423 survived / 154 no-coverage / 39 error);
  timeout-killed sets equal (0); warning-code sets identical. B did pack: 69.4 entries per prefetch request against 56.1.
- **Bound 4 (live within ±2%): MET.** 75 live requests (1,504 entries) in every arm.
- **Bound 1 (prefetch requests ≤ 45% of A): MISSED.** 59 against 73 (81%). This slice's units are already large (A sent
  56.1 entries per prefetch request; y3 sent 22.8), so packing had little to merge: 14 fewer requests, about 13-19
  lane-seconds of fixed cost at the per-request cost measured in the same arms.
- **Bounds 2 and 3 (fixed cost ≤ 50%; mutant phase ≥ 4% faster): met on paper, but CONFOUNDED, so not claimed.**
  - Mutant phase: A 1,371.7 s, B 709.9 s, A2 1,143.8 s; prefetch setup+baseline: A 120.9 s, B 55.6 s, A2 98.4 s.
  - The box changed speed under the arms: during A, three other lanes' full VERIFY runs and a v3 itest ran
    (`/coord/locks/heavy-peaks.tsv`, 20:28-21:00Z); A2 had no logged heavy job but was still slower than B.
  - The proof it was the box: LIVE requests are identical in every arm and packing never touches them, yet their
    setup+baseline was A 130.9 s, B 59.2 s, A2 107.2 s, the same fall as prefetch's (B/A 0.45 live, 0.46 prefetch).
    So packing's own share of B's speed is about nil here; the rest is box noise.
- **So:** the knob is correct (verdict-neutral, red-tested, A/B-equal) and stays off by default. Its speed claim still rests
  on §1's model (fixed cost per request × requests removed), unproven live.
- **To prove the speed** (proposed, for the orchestrator): a slice chosen for SMALL units (y3-like ≤ 25 entries per
  prefetch request, picked from y3's events), on a quiet box with the arms interleaved (A, B, A, B), judged on
  requests removed × the per-request fixed cost measured in the same arm, which is robust to box speed, and on wall.

## 1. Measured offline (y3: `/coord/handoff/PR-204/y3.run.events.ndjson`, 7,959 `serve-request-timed` events, 3 lanes)
- **The "fixed" cost IS fixed.** Least squares per kind, cost = a + b·entries + c·tests:
  - prefetch (5,052 requests): setup 973 ms + al-runner baseline 577 ms; entries and tests explain ~nothing (R² 0.01-0.02;
    slopes -6 ms/entry, +0.4 ms/test). Flat by size bucket: 2-4 entries 1.42 s, 40+ entries 1.63 s.
  - live (2,692): setup 955 + baseline 563 ms, R² 0.01.
  - plus ~0.3 s per request outside al-runner (transport, queueing), also flat.
  - **Total: ~12,000 lane-s of setup+baseline (~4,000 s wall)**, as PR-231 ranked it, and it scales only with the number
    of requests.
- **Why requests are small** (the survey): LethAL sends one prefetch request per lane per procedure-scope UNIT, cut by
  `groupsThatFit` (caps: 256 entries, 16 unmeasured entries, a 4 GiB measured-cost budget, R987). y3's prefetch averaged
  22.8 entries, far below every cap: the unit, not a cap, sets the size. Nothing packs several units into one request,
  and no knob sizes requests.
- **Packing simulated** (`pack.py`: per lane, in order, consecutive prefetch requests merged up to an entries cap; any
  other request breaks a run):

  | entries cap | prefetch requests | fixed cost saved (wall) |
  |---|---|---|
  | (today) | 5,052 | 0 |
  | 32 | 3,242 | ~1,110 s |
  | 64 | 2,171 | ~1,770 s (7.4% of the 23,928 s mutant phase) |
  | 128 | 1,710 | ~2,050 s |
  | 256 | 1,308 | ~2,300 s |

  A 2,000-test cap on top changes little (64 entries: 1,766 s). Live requests (1,662 s of fixed cost) are a separate pot:
  one mutant's groups each; not studied here.

## 2. What bigger requests would cost (the survey; to be measured by the A/B)
- **Kill waste:** none ADDED by packing. Every entry of a request runs even after a kill today (R1098: 10.7% of serve time
  on a slice; upstream `stopAfterFirstFailure` waits on the next pin, R1146), and prefetch already runs all of a unit's
  entries; packing changes which request they ride in, not whether they run.
- **Timeouts:** a timeout cut keeps rows up to the timed-out test and re-sends the rest of the request once (R895, R1147);
  a bigger request re-sends more entries but loses no work, plus one setup and the restart it pays today (23 restarts on
  y3). The keep rule (R612) still closes the daemon at the first unkept entry.
- **Memory:** daemon RSS grows ~linearly with entries (R987: Contoso ~77 MB per entry over a 1.35 GB floor; 64 entries
  6.3 GB, 256 entries 21 GB). Packing goes through `groupsThatFit`, so R987's 4 GiB measured-cost budget and the
  16-unmeasured cap still bound every request; DO's per-entry cost is not known offline and the A/B records it.
- **The tail and the time budget:** results arrive at a request's end (no streaming); a packed request delays its units'
  results and lengthens the last request of a lane (y3's 40+-entry prefetch requests took 36 s on average). Windows only
  set budget checks; a stop loses at most one window.
- **Isolation:** a request today holds one unit's mutants; packing puts different procedures' entries in one request on
  one workspace load. Entries are isolated per entry as today, but any state al-runner keeps across entries of a request
  now spans units: the per-mutant comparison is the guard.

## 3. Proposal: a DO-slice A/B, measure-only (after the ruling)
- **Build (behind an env knob, off by default, for the A/B only):** `LETHAL_V3_PACK_ENTRIES=<n>` packs consecutive
  prefetch units of a lane into one request through `groupsThatFit` up to n entries (R987's caps unchanged). No default
  changes until the A/B decides.
- **Slice:** a DO slice of about one hour on `current` (PR-94's slice or a t11-sized one), 3 lanes, after PERF-10's control.
- **Arms:** A = master; B = `LETHAL_V3_PACK_ENTRIES=64`; same build, same slice, same lanes, run back to back (and A again
  after B, to see drift).
- **Pre-committed predictions (from §1, scaled to the slice):** B's prefetch requests ≤ 45% of A's; B's setup+baseline
  lane-seconds ≤ 50% of A's; B's mutant phase faster by ≥ 4% of A's.
- **Must hold (any miss is a BLOCK for adoption, not a "close enough"):** every mutant's verdict equal per mutant on the full
  site key; `killingTest` may move only as R197's ledger orders it; daemon peak RSS per request ≤ R987's budget; no new
  warning code; timeout-killed set equal.
- **Recorded:** requests per kind, entries per request, setup/baseline/outside ms, daemon peak RSS per request, restarts,
  the lane tail (last request end per lane), mutant-phase wall.

## 4. Decisions for the orchestrator
- **Q1:** run the A/B (it needs the env-knob build first, ~small), or park lever 2 behind R1148 (lever 1, larger)?
- **Q2:** the cap for arm B: 64 (recommended: R987's measured-safe size, 7.4% predicted) or 128?
- **Q3:** study live requests' 1,662 s as its own item now, or after the A/B?

## 5. Not covered
- The fixed cost itself (the setup and per-request baseline al-runner pays) is upstream's floor (R1092); packing only
  pays it less often.
