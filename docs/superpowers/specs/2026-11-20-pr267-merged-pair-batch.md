# PR-267 spec-light: one kill-pair batch per packed prefetch call (R1151, PR-242's L2')

lethal-preproc, 2026-11-20. Pre-committed before any code. Background: PR-242's spec
(`2026-11-19-pr242-live-request-fixed-cost.md`, amendment 1) and R1151.

## 1. What changes
- **Today** (`prefetchWindow` in packages/runner/src/al-runner-v3-backend.ts): after a PACKED prefetch call (PR-241,
  `unitSizes` given), `batchKillPairs` runs once PER UNIT. That is one or more live requests per unit with kills, as
  when the units were prefetched one by one.
- **After:** `batchKillPairs` runs ONCE for the whole call, over all its plans.
  - It still chunks by memory cost (`groupsThatFit`, R987) with whole kills only, so a packed call with more kills
    than fit still sends several requests.
  - An unpacked call (no `unitSizes`) is unchanged.
  - Packing is still off by default (`LETHAL_V3_PACK_ENTRIES`), so default runs are unchanged. The combined DO run sets
    256.
- **Unchanged:** every confirmation condition of a stored pair, which all sit in `takeStoredPair` and `batchKillPairs`'
  per-kill logic:
  - a pair serves only its own kill and codeunit;
  - the pair's request comes after the prefetch request that produced the kill. A merged batch still runs after the
    whole packed prefetch, as each per-unit batch did;
  - PR-102's cut (`through`, the last failing covering test in baseline order) and the refusal counters;
  - R612's cut and its single re-send;
  - R1014's budget stop;
  - a failed chunk stores nothing and leaves each of its kills to today's path.
- **Order:** every unit of a packed call is scored after the packed prefetch and its pair batch already, so scoring
  order is unchanged.

## 2. Measured (`/coord/handoff/PR-267/`)
- PR-241's A/B on DO's e-document slice (4 `--only` files, 3 lanes) ran 45 pair-batch requests in BOTH arms, packed
  (`PACK_ENTRIES=64`) and unpacked. Packing saved prefetch requests (73 -> 59) but no pair requests, which is R1151's
  finding.
- The events do not record unit boundaries, so the merged count cannot be read offline from them (`pairs.py` showed
  that scoring's own live requests have the same shape). The live A/B below is the measurement.
- **Prediction** (PR-242's `pack-sim.py`, a lower bound): on a full DO run at 64 entries, pair-batch requests about
  950 -> about 635, about 157 s of wall; at 128 entries about 245 s.

## 3. Pre-committed tests (unit, `pr241-pack-entries.test.ts`)
- **The PR-241 test "kill pairs are batched per unit"** becomes: two units, one kill each, packed, give ONE pair
  request and 2 stored pairs.
- **Pair for pair:** a packed call of 3 units with kills (some units with none) stores exactly the pairs (keys, codeunit,
  NONE and M rows, `through`) that the same plans store prefetched unit by unit (unpacked).
  - Every one of those kills is then served by `takeStoredPair`, and none is served to another mutant.
- **The byte budget still splits a merged batch:** a high measured cost gives several pair requests, whole kills only.
- **Unpacked is unchanged:** one batch per call, as today.

**Red checks, both directions:**
- the per-unit loop restored turns the ONE-request test red;
- a merged batch that drops the plans of all but the first unit turns the pair-for-pair test red.

## 4. Pre-committed live A/B (after VERIFY and an Opus review; when PR-235 frees its peak-18 slot)
- **The setup:** PR-241's `ab.sh` slice (same `--only`, `--workers 3`, no budget), `LETHAL_V3_PACK_ENTRIES=64`, fresh
  stores, two arms today on one checkout (the branch head):
  - **P (per unit):** the branch's merge base on master, today's code.
  - **M (merged):** the branch head.
  - No switch is added to the code just for this A/B.
  - Both run on `current` 4ebfe7913 (or whichever `current` the gate table names that day, the same for both), pinned
    to the same CPUs, heavy slot `--peak 18`, one after the other.
- **BLOCK** if any of these fails:
  - every mutant's verdict and killing test equal between P and M;
  - `pairBatchStored` and `pairBatchServed` equal between P and M;
  - `pairBatchRequests` in M below P (P is predicted near 45);
  - the refusal counters 0 in both (`notAfterKill`, `cutBeforeKiller`, `otherCodeunit`, `notPrefetched`).
- **Reported:** live request counts, the slice's mutant-phase wall (one run each, so speed is indicative only; the
  combined DO run carries the real figure).

## 5. Gates
Every leg `selectLegs` names, on the final head.

## 6. Amendment 1 (2026-11-20, the Opus build review and a reading of PR-241's arms; before the live A/B)
- **§1's "PR-102's cut ... unchanged" is not strictly true (review SF2).**
  - The cut goes out only in a request sent with `runSelectedOnly` (PR-102), and that flag is decided PER REQUEST.
    One entry can turn it off for all, for example a per-test call id under `--isolate-tests`, a codeunit in
    `neverFlag`, a baseline/discovered mismatch, or a gapped exclusion.
  - A merged pair chunk mixes kills from several units, so one unit's kill can now drop another's cut. Per-unit
    batches already mixed kills within a unit; this widens the scope, it is not a new kind.
  - It is verdict-safe: with no cut the pair's rows cover the whole codeunit, and `takeStoredPair` without `through`
    passes the cut check. It can move the A/B's per-reason counts (fewer `through`, so fewer `cutBeforeKiller`), and a
    pair may run more tests.
  - Not cut at flag changes the way `packCut` does: the review judged rewording enough, and the A/B reads the counts.
- **§4's "refusal counters 0 in both" was wrong for today's code.**
  - PR-241's arms (19 November) both read `stored 346, served 316, refused 30`: some refusals are by design (a pair
    stored for a kill that scoring then reaches live, R778).
  - **The BLOCK becomes:** `pairBatchStored` equal between P and M. `pairBatchServed` and `pairBatchRefused` equal, OR
    any difference lies only in `cutBeforeKiller` and is named mutant by mutant from the flag-mixing above. Every
    mutant's verdict and killing test equal (unchanged, the first BLOCK). `pairBatchRequests` in M below P.
  - The per-reason counts (`notAfterKill`, `cutBeforeKiller`, `otherCodeunit`, `notPrefetched`) are reported for both
    arms.
- **§3's serving assertion was missing from the first build (review SF1).** It is added: after the packed prefetch the 4
  killed mutants are scored and each pair is served with no send (`pairBatchServed` 4, `pairBatchRefused` 0), and a
  mutant that was not killed has no pair. It is red-checked: pairs stamped with an old `seq` turn it red.
