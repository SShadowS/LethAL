# PR-242 spec-light: the LIVE requests' fixed cost on DO, and how to pack or avoid them

Coord PR-242, lethal-code, 2026-11-19. Measure-only, offline from y3 (`/coord/handoff/PR-204/`, al-runner `edge-4ebfe7913`,
3 lanes). Coordinated with preproc's PR-241 (their prefetch-packing knob). Scripts and outputs are in this folder.

## 1. What the live requests are
**y3 totals:** 2,692 live requests, 11,934 lane-s of wall, of which 4,099 lane-s are al-runner's fixed cost (setup about
0.96 s plus its per-request baseline about 0.56 s per request). That is **about 1,366 s of wall over 3 lanes.**

**By reason** (y3's serve-entries summary line, plus the R653/R778 formulas in `al-runner-v3-backend.ts`):
- **R778 kill-pair batches: 1,634 requests.** `batchKillPairs` runs once per `prefetchMutants` call, which is one PR-99
  unit (`runUnit` in `orchestrator.ts`). The kills the unit's prefetched rows show get their NONE confirm and their R577
  reproduction as pairs (an echo plus the codeunit, NONE then M), chunked by memory cost (`groupsThatFit`).
  - The batches are tiny: 1,188 live requests carry 4 entries (ONE pair), 610 carry two.
  - Stored pairs: 6,027, of which 5,028 were served and 999 refused.
- **Per-kill confirmations, today's path (R653): about 1,058 requests,** for kills no stored pair served: the 999 refused
  pairs, kills whose rows did not come from a prefetch, and cut fallbacks.
  - **Why a stored pair is refused** (`takeStoredPair`): another codeunit than the killing call (`stored.cu !== id`); a
    kill not from prefetched rows; a pair that did not run after the kill's prefetch; or a cut that excludes the killer.
  - y3's files do not say which. The store records no path, and every kill reads kill position 1.
  - **The likely main cause:** the batch stores ONE pair per mutant, for the first codeunit in plan order with a failing
    test, but the orchestrator's kill ledger can pick a killer in ANOTHER codeunit. 3,291 of 6,033 y3 kills have covering
    tests in two or more codeunits, and for 2,451 of those the killer is not in the first-listed codeunit
    (`multi-cu.txt`). That has room for all 999, but it is not measured.
- **Recheck:** none of these. The withheld-kill recheck runs its own baseline, not live requests.

## 2. What may change, and what may not
A kill is confirmed by a NONE run that passes and an M reproduction that fails again, in that order, after the kill's
prefetch (R577, R653, R778).
- **Skipping a live request whose prefetch "already gives the verdict" is NOT allowed:** it would drop the confirmation.
- Every lever below keeps both runs and their order; it only changes which request carries them.

## 3. The levers, ranked by predicted wall saving per DO run
**L1: a stored pair for EVERY codeunit with a failing covering test** (not only the first), in the same batch request.
- **Owner:** LethAL (`batchKillPairs`).
- **Saving:** up to 999 per-kill requests × 1.5 s = **up to about 500 s** of wall, IF the refusals are mainly the
  cross-codeunit case.
- **Cost:** more entries per batch (memory, chunked as today); no extra request unless a batch needs another chunk.
- **Risk:** none to verdicts. A pair is still served only to the kill it was cut for (`stored.cu === id`, the cut
  check).
- **Next measurable step (M1):** measure-only counters per refusal reason in `takeStoredPair`, read on one DO run (or
  PR-235's resumed run). Build L1 only if the cross-codeunit share is large.

**L2: PR-241's packing, if a packed prefetch request is also ONE `prefetchMutants` call** (one pair batch for the
packed units' kills).
- **Owner:** preproc's PR-241 knob, one packing path for both. Preproc reports the builder's choice; if packing stays per
  request inside separate per-unit calls, the live saving is 0.
- **Predicted** (`pack-sim.py`/`.txt`; a lower bound: it reads 1,028 of the 1,368 units from the request order and counts
  only each unit's first batch request):
  - arm B (64 entries): pair-batch requests 950 → about 635, **about 157 s** saved;
  - 32 entries: about 80 s; 128 entries: about 245 s.
- **Pre-committed for preproc's A/B, arm B:** if the packed units share one `prefetchMutants` call, live requests drop by
  at least 300 against arm A on the same scope, and no kill's verdict, killing test or reproduction changes. Otherwise the
  live count is unchanged within ±2%.

**L3: a unit's pairs ride in the NEXT unit's prefetch request on the same lane** (a pair needs only `seq` after its
kill's prefetch).
- **Saving:** up to all 1,634 batch requests, **about 800 s**.
- **Cost:** scoring order changes, since a unit's mutants are scored only after the next unit's prefetch. The R197 kill
  ledger then sees kills later, and the look-ahead, budget and memory barriers need checking. The last unit of a lane
  still needs its own batch.
- **Status:** a design question, kept OUT of PR-241's A/B (preproc). Decide after L1 and L2 are measured.

## 4. Not live requests, for scale
Prefetch's fixed cost is PR-241's subject: about 1.5 s × 5,052 requests. Warm-ups are R1147 (timeout cuts) and the
refusal restarts.

## 5. Next steps
1. **M1:** the refusal-reason counters, measure-only, built in PR-242 (orchestrator, 2026-11-19).
   - **NOT read on PR-235's resumed run:** that run is ad85cd489's measurement and must stay one build's.
   - Read on the next full DO run on master (not PERF-10's fork build), or on a DO slice after PR-235.
   - It decides L1.
   - **The counters,** one per `takeStoredPair` refusal reason, printed in the serve-entries summary next to `refused`:
     another codeunit, not from prefetched rows, not after the kill's prefetch, cut excludes the killer.
   - **Pre-committed:** the four sum to `pairBatchRefused`. No verdict, request, event or report field changes; only the
     stderr summary line gains the split.
2. **L2:** preproc's A/B, arm B, confirms or refutes the prediction above.
3. **L3:** only after both, with an adversarial spec review of the scoring-order change.

## Amendment 1 (2026-11-19): PR-241's builder choice, so L2 becomes L2'
Preproc reports PR-241's build (its spec amendment 1, master f38e7b778):
- one packed prefetch request is ONE `prefetchMutants` call (the units' plans concatenated, `unitSizes` marking the
  boundaries);
- `batchKillPairs` still runs PER UNIT (the plans sliced by `unitSizes`), after the whole packed prefetch.

**So:**
- **For PR-241's A/B (arm B against arm A, the same scope),** the prediction that applies is the second branch of L2: the
  live-request count is unchanged within ±2%, and no kill's verdict, killing test or reproduction changes.
- **L2' (new, LethAL, PR-242's lever):** merge the per-unit pair batches of one packed call into one batch, chunked by
  memory cost as today.
  - Scoring order does not change: every unit of the pack is scored after the whole packed prefetch already, and the
    merged batch runs before the first of them, as each unit's batch does today.
  - A pair still serves only its own kill (`takeStoredPair`'s checks are unchanged).
  - **Predicted** (`/coord/handoff/PR-242/pack-sim.py`, a lower bound): on top of arm B, pair-batch requests about 950 →
    about 635, **about 157 s** of wall per DO run; at 128 entries about 245 s.
  - **Next:** a spec of its own, with red tests (the merged batch must store exactly what the per-unit batches stored,
    pair for pair) and an A/B against PR-241's arm B.
