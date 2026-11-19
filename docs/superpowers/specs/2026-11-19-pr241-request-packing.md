# PR-241 (DO speed lever 2): al-runner's fixed per-request cost, and packing prefetch requests — spec-light, measure first

lethal-preproc, 2026-11-19 (coord PR-241, from PR-231's ranking). Offline only: y3's events, no run. Build and the A/B only
after the orchestrator's ruling. Scripts and outputs: `/coord/handoff/PR-241/` (`fixed.py`/`fixed.txt`,
`pack.py`/`pack.txt`); the code facts from a read-only survey (names, not lines).

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
