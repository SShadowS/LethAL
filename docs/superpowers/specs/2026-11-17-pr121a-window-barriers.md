# PR-121 (a) pre-commitment: under the split, no entries cap on windows

Coord PR-121 (lethal-code, 2026-11-17). Measurement: `/coord/handoff/PR-121/a-result.md`.
- **Run:** PR-94's DO slice at `--workers 3`.
- **Finding:** 32.5% of lane time is spent waiting at window barriers. `cutWindows`' entries cap (`ENTRIES_CHUNK_CAP × lanes` = 768)
  lets one dense procedure scope fill a window alone. Then one lane works and the others wait.

Spec-adversary r1 is folded in:
- **The bound:** no request is sized by the window.
- **M1:** longest-first is DROPPED. It held back every store row until the manifest-first unit finished, and its measured gain was
  only ~96 s.
- **M2:** stated, and measured.
- **M3:** the per-request checks are structural.
- **L1-L6.**

## The change
- **Only under the split prefetch** (`runMutantsParallel`'s `split`, which is on in production whenever v3 runs with
  `--workers` > 1): `splitWindowCaps(lanes)` returns `{ timeMs: WINDOW_TIME_CAP_MS × lanes, entries: Infinity }`. Only the time
  cap closes a window.
- **Unit hand-out stays in manifest order.**
- **Nothing else changes:** N = 1 (`runMutantsOnBackend`'s own `cutWindows` call), and the paced path.

## Why it is safe
- **Verdicts.** A window "never changes a verdict" (`mutant-windows.ts`). A unit is a procedure scope, run on one lane in
  manifest order. R197's ledger is per scope and learns during the walk, not at commit (review: checked). A scope split
  across windows still runs its parts in sequence.
- **No request is sized by the window** (review: traced, holds):
  - a lane prefetches only its unit, chunked by `groupsThatFit` (≤ 256 entries, ≤ 16 unmeasured, ≤ 4 GiB per request);
  - kill pairs are per unit and chunked the same way;
  - `prepareBatch` sends nothing;
  - the warm-up is per session;
  - live requests and the echo are per mutant;
  - PR-88's `costByCall` is per session.
  A larger window can only make a unit larger (two pieces of a scope join), which adds chunks, never entries per chunk.
- **What a stop or a crash loses** (M1):
  - a graceful stop (signal, budget, memory guard) keeps every finished result, as today;
  - a hard kill (OOM, `timeout -k`, a container restart) loses the unrecorded part of one window. That window is still bounded
    by the time cap, 600 s × lanes of estimated test time. Wall time is 0.7-5.8 times the estimate (R940), so on DO at 3 lanes
    a window can be up to ~58 min of wall, where today it is ~768 entries;
  - `--resume` re-scores what is left out, per mutant.
- **Memory pacing (M2):** lanes above 0 are asked `mayStart(k)` once per window, at launch. With fewer, larger windows, a running
  lane is re-checked less often. The backstop is unchanged: R948's per-group guard stops the session loudly as a budget stop,
  never with a wrong verdict. This is measured below, and if a memory stop or lane hold appears that the before arm does not
  show, the default is reverted.

## Predictions (pre-committed)
1. **0 verdict and 0 `killingTest` moves:**
   - `itest:alrunner-v3` passes unchanged at N = 1;
   - with `LETHAL_ITEST_V3_WORKERS=3`, the D legs' N = 3 tables equal N = 1 (R766);
   - the DO slice: `report-diff --by-line --subset` between the arms shows 0 differences in verdict and `killingTest`.
   - **A move (L3)** is a BLOCK until investigated: the before arm is run a second time, and the move counts against the fix only
     if the two before arms agree with each other.
   - `itest:chunked` (bcdev) does not run this path.
2. **The DO slice** (`/coord/handoff/PR-121/slice.sh`, `--workers 3`, fresh store; before = the head without the fix, after = with
   it, run one after the other):
   - the mutants phase falls by at least 20%;
   - the time at window barriers (`gaps.ts`, inner gaps over 5 s) falls by at least half;
   - **per request** (M3, from the after arm's `serve-request-timed` and `serve-request-sized` events): every request holds at most
     256 entries, and each request's growth over its daemon's floor stays within `ENTRIES_REQUEST_BUDGET_BYTES` plus the
     reading's slack;
   - no memory stop, and no `al-runner-v3-lane-memory-hold` warning the before arm does not have;
   - **reported, not judged:** the longest stretch with no `mutant-scored` event in each arm (M1), and LethAL's own peak RSS
     (L6).
   - **The environment (L2):** `memory.current` and the held heavy slots are recorded at each arm's start. If lane starts or holds
     differ between the arms for a reason outside the run (another job), the pair is re-run.
   - **Caveats (L1):** on the slice the after arm is likely one window, so this proves "no entries-cap barrier", not the
     time-only close. The DO-wide size (a-result: at most ~4,580 s of t14) is not predicted, and is reported by the next DO
     window.
3. **Unit tests, each red when its rule is reverted:**
   - under the split, a window is not closed by entries alone, and is still closed by time;
   - the N = 1 path's windows (`runMutantsOnBackend`) keep the entries cap.

   Pinned, not red-checked: records still commit in manifest order (`OrderedCommit` is untouched).
   `r766-parallel-v3.test.ts`'s hand-out assumptions stay as they are, since the order is unchanged.
