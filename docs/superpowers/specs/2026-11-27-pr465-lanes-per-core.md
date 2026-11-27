# PR-465 (R1232): lanes per core against entries per hour on DO — pre-commitment r1 (measure only)

lethal-code, 2026-11-27. Written before any run. Nothing is built; changing a default is a separate task.

## The question

- PR-463 found that the login is CPU. On server1, the same work's CPU time grew up to 3× as the cores' busy share
  rose.
- So more runnable threads than cores may LOSE throughput, not only share it.
- How many lanes per core gives DO the most entries per hour?

## What a "lane" is in LethAL today (read from the code)

- `--workers N` starts N al-runner `serve` daemons. LethAL does not set `AL_TEST_THREADS`, so each daemon runs as many
  test threads as it has pinned cores (`available_parallelism`).
- A request's codeunits spread over those threads.
- So a real DO run has up to about N × cores runnable test threads. PR-439 and c5 ran 3 workers on 12 cores.

## Arms (fixed core set: cores 12-16, 5 cores; everything at nice 10)

- **W1:** 1 daemon at default threads (5): up to 5 runnable threads, 1 per core.
- **W2:** 2 daemons at default threads: up to 10, 2 per core.
- **W3:** 3 daemons at default threads: up to 15, 3 per core (c5's shape: 3 per core).
- **Order:** W1, W2, W3, W3, W2, W1, interleaved so slow drift brackets every arm.
  - Each run starts its daemons fresh and sends one warm-up request per daemon, outside the timing.
- **Memory:** about 3.5 GiB per daemon, about 11 GiB at W3. Each run holds one heavy slot of `--peak 12`.

## The fixed entry set

- The first 30 requests of PR-453's captured life 1905189 that carry no kill-pair (`#`) entry, with every captured
  field passed through and the resources as captured.
- **App:** today's staging of DO with today's selector. Its mutation set must equal PR-458's staging (compared on
  the `mutation-set-generated` event), else VOID.
- **The queue:** the requests go to one shared queue, and each daemon takes the next request when it is free (as
  LethAL's parallel queue does). Replay is off, as in the life.

## Measured per run

- **Makespan:** the wall time from the first timed request sent to the last answered. Entries per hour (EPH) =
  entries / makespan.
- **Rows:** md5 of each request's sorted rows. They must be equal across all six runs, which proves the same work.
- **Counters:** `perf stat -e instructions:u,cycles:u` over every daemon pid for the makespan (core + atom summed).
  - IPC = instructions / cycles;
  - instructions per entry and cycles per entry.
- **Outside load:**
  - the busy share of cores 12-16 from /proc/stat, minus the daemons' own CPU (utime + stime) = OTHER processes'
    share;
  - host load1 at start and end.
- **Tail:** the time from the last-but-one daemon going idle to the end, reported. A long tail lowers W2's and W3's
  EPH unfairly.

## Claim rules (pre-committed)

- **The work is the same:** rows are equal across the runs, and instructions per entry are within ±3% across arms.
  If either fails, that arm is VOID.
- **"Wk beats Wj":**
  - BOTH runs of Wk have a higher EPH than BOTH runs of Wj;
  - the median gain is ≥ 5%.
  - Otherwise: "no difference shown".
- **IPC inflation shown:**
  - W3's IPC is ≥ 15% below W1's in both pairs;
  - cycles per entry rise by at least as much.
- **Outside load:**
  - Each run is flagged if its OTHER busy share differs by > 0.15 from its arm's other run.
  - A claim that rests on a flagged run is reported as "under load" and is not used for the recommendation.
- **Recommendation:** the SMALLEST W whose median EPH is within 5% of the best arm's. Workers per core =
  W / 5 cores × the default threads.
  - If no arm differs by ≥ 5%, the recommendation is "no change shown; keep the current default".
  - The tail is stated, and its effect is computed (EPH without the tail).

## Not covered

- Other core counts (the curve is for 5 cores only), real LethAL orchestration overhead, and the kill-pair confirm
  lane.
- `AL_TEST_THREADS` below the core count is a second knob, not measured here.
