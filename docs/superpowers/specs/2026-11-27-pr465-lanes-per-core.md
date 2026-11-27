# PR-465 (R1232): lanes per core against entries per hour on DO — pre-commitment r2 (measure only)

lethal-code, 2026-11-27. Written before any run. Nothing is built; changing a default is a separate task.
- **r1** was 18b298b47.
- **r2** answers its spec-adversary (B1-B3, S1-S5, N1-N3) and replaces r1 entirely.

## The question

- PR-463 found that the login is CPU. On server1, the same work's CPU time grew up to 3× as the cores' busy share
  rose.
- Do more lanes per core LOSE throughput, not only share it? And what `--workers` should DO default to?

## What a lane is (B1, read from al-runner's source and checked by a guard)

- LethAL's entries each name ONE codeunit test. al-runner runs one pass per entry, one after another; a pass with one
  unit runs on the calling thread.
- So a serve daemon running entries keeps about ONE test thread busy, whatever `AL_TEST_THREADS` or the core count
  says. **A lane is a daemon.**
- **The premise, corrected (N1):** c5's capture ran `--workers 8` on `taskset -c 0-11`: 8 lanes on 12 logical CPUs (6
  P-cores with hyperthreads), 0.67 lanes per logical CPU. The oversubscription in PR-439 (load1 89) came from OTHER
  jobs on the host, not from LethAL's own lanes.

## Cores (B3)

- **The arms run on ONE P-core: logical CPUs 1 and 2** (hyperthread siblings, 5.1 GHz), the kind of core a DO run
  uses.
  - Sharing a hyperthread is part of what is measured.
  - The L3 cache is shared with the other P-cores, so it cannot be isolated: the outside load on 0-11 is named.
- Everything runs at nice 10.

## Arms

- **W1, W2, W4:** 1, 2 and 4 daemons on CPUs 1-2.
  - That is 0.5, 1 and 2 lanes per logical CPU (c5 ran 0.67).
  - Memory: about 3.5 GiB per daemon, about 14 GiB at W4. Each run holds one heavy slot of `--peak 15`.
- **Order:** W1, W2, W4, W4, W2, W1.

## The work, the SAME per lane (S1)

- **The set:** the first requests of PR-453's captured life 1905189 that carry no kill-pair (`#`) entry, in capture
  order, until their entries sum to ≥ 600.
  - Every captured field is passed through; resources as captured; replay off.
- **The order:** every lane runs that whole set once, starting at a rotated offset (lane i starts at request
  ⌊i × K / W⌋ of K and wraps).
  - So all lanes are busy for the same work, concurrent lanes run different requests, and there is no shared-queue
    tail.
- **EPH** = W × (the set's entries) / makespan. The makespan runs from the timed start to the LAST lane's end. Each
  lane's end time is reported. The spread between the first and last lane end bounds the tail.
- **The claim's scope (S2):** "daemons serving fixed captured request shapes (8-lane split prefetch)". W1 here is NOT
  `--workers 1`, whose requests are shaped differently.

## Cache and warm-up (S3)

- The daemons share one `ALRUNNER_CACHE`, pre-filled by staging.
- Each run starts its daemons and warms them up ONE AFTER ANOTHER (one NONE request each), before the timed start.
- The cache directory's listing (names, sizes) is hashed at the timed start and end. A change flags the run.

## Measured per run (S4, S5)

- **Counters:** each daemon is started under `perf stat -e instructions:u,cycles:u --delay -1 --control fifo:…`,
  enabled at the timed start and disabled at the end.
  - perf reports at daemon exit, so threads that ended are included.
  - The run is VOID if perf's running share is below 100%.
  - The run is VOID if cpu_atom's counts are above 1% of cpu_core's (a thread ran outside the P-core).
  - IPC = Σ instructions / Σ cycles; instructions per entry; cycles per entry.
- **Lane-thread guard (B1):** every daemon's threads' on-CPU time over the window comes from schedstat.
  - The run is VOID if any daemon has more than one thread with ≥ 20% of that daemon's on-CPU time.
- **Rows:** md5 of each request's sorted rows. They must be equal for the same request in every lane and run.
- **Outside load:**
  - the busy share of CPUs 1-2 minus the daemons' own CPU;
  - the busy share of the other P-cores (0, 3-11);
  - host load1 at start and end.

## Claim rules (pre-committed)

- **The same work:** rows equal; instructions per entry within ±3% across arms. If either fails, the arm is VOID.
- **"Wk beats Wj":** both runs of Wk have a higher EPH than both runs of Wj, AND the median gain is ≥ 5%. Otherwise
  "no difference shown".
- **IPC inflation shown:** W4's IPC is ≥ 15% below W1's in both pairs (N3: cycles per entry is reported, not a second
  test).
- **Outside load:** a run is flagged if the other P-cores' busy share differs by > 0.15 from its arm's other run. A
  claim resting on a flagged run is reported "under load" and not used for the recommendation.
- **The curve:** EPH and IPC against lanes per logical CPU (0.5, 1, 2).
- **Recommendation (B2):**
  - r* = the lanes per logical CPU of the SMALLEST arm whose median EPH is within 5% of the best arm's.
  - `--workers` = r* × the logical CPUs of the run's affinity, capped at `MAX_V3_WORKERS` (8).
  - If no arm differs by ≥ 5%: "no change shown".

## Smoke first

- One W2 pass on 2 requests, checked by hand before the real runs:
  - perf counted both daemons, with a running share of 100% and cpu_atom ≈ 0;
  - the thread guard reads one busy thread per daemon;
  - the rows' md5 are equal across lanes;
  - the cache-listing hash works.

## Not covered

- Other P-core counts, real LethAL orchestration (queue, prefetch shapes per `--workers`), and the kill-pair confirm
  lane.
- E-cores: they are a different curve, and DO runs on P-cores.
