# PR-332 pre-commitment: re-measure costliest-first scope order with load-robust criteria (R1165)

lethal-code, 2026-11-22. A measurement only: no code changes. PR-281 built `LETHAL_V3_UNIT_ORDER=costliest` (opt-in) and
measured it (`/coord/handoff/PR-281/result.md`, `ab/compare.txt`). Its wall prediction missed (B / A 1.13 against ≤ 0.85).
R1165 put the miss down to heavier outside load on both B arms (per-test time 1.65 × A's). This file's premise does not
support that diagnosis.

## The premise, measured from PR-281's arms before writing this (v2, after the Opus review)
- **The sources:**
  - `/coord/handoff/PR-332/premise.txt`, from the lane lines;
  - `premise-concurrency.txt`, from each request's lane and timing in `events.ndjson`, plus each arm's `/usr/bin/time`
    CPU.
  - A1 is left out (void).
- **The measures:**
  - E, the utilisation: busy lane-s ÷ (lanes × the mutant-phase wall);
  - the arm's own CPU: user plus system, its children included (`time.txt`);
  - "outside CPU": the container cgroup's CPU over the arm minus the arm's own.

| arm | order | wall s | E | the arm's own CPU s | outside CPU s | baseline ms/test | ms/test, 6-8 requests at once | fixed ms per request |
|---|---|---|---|---|---|---|---|---|
| A2 | manifest | 2,354 | 0.649 | 11,651 | 3,097 | 26.3 | 29.4 | 69 |
| A3 | manifest | 2,366 | 0.588 | 11,178 | 2,438 | 27.8 | 25.0 | 79 |
| B1 | costliest | 2,513 | 0.732 | 12,829 | 9,034 | 36.9 | 42.1 | 120 |
| B2 | costliest | 2,844 | 0.713 | 13,488 | 4,282 | 26.7 | 48.1 | 155 |

- **B2 ran on a box like A's, and was still the slowest arm.**
  - Its baseline phase, the same work in either order just before the mutant phase, was as fast as A's (26.7 ms/test).
  - Its outside CPU was close to A2's, and its host load mean was lower (76 against 92).
  - Yet at the same concurrency (6-8 requests at once) its tests took 1.6 × A's, and its fixed cost per request doubled.
- **B used 10-16% more CPU of its own** for the same 3,597 mutants.
- **So the slowdown may come from the order itself, not only from outside load.** A plausible reason is the heavy scopes
  running together on all lanes at the start, but that is not measured.
- **Normalising by the mutant phase's own ms/test is therefore invalid.** It divides away a slowdown the order may cause
  (the review's blocking finding). Normalised instead by the arm's BASELINE ms/test, which the order cannot touch:
  - A is 89.5 and 85.1, B is 68.1 and 106.5;
  - mean B / mean A = 1.00. **No gain.**
- **E is not judged.** A lane waiting for CPU counts as busy, and costliest-first's one long lane raises E by construction.
- **The prediction is therefore open:** no gain is the default expectation. The A/B decides between a gain, no gain, and a
  loss.
- **The limit, if there is a gain:** in both B arms, lane 0 was busy for 99% of the wall. So B's wall is the largest
  procedure scope run alone. A further gain needs that scope split, which is not built (it would move R197's ledger order).

## The arms and their order
- **The arms:** A = `LETHAL_V3_UNIT_ORDER` unset (manifest order, today's default). B = `LETHAL_V3_UNIT_ORDER=costliest`.
- **The order:** A B B A B A A B (8 arms), counterbalanced, so a drift in load over the series falls on both letters
  alike.
  - The pairs are (1,2), (3,4), (5,6) and (7,8). Each pair holds one A and one B, adjacent in time.
- **Unchanged from PR-281:**
  - PR-274's 22-file DO slice (`/coord/handoff/PR-274/slice.txt`), its config `v3.json` (the binary main-ccd0f823d by path)
    and its warmed cache;
  - 8 lanes, `--profile slim`, no budget and no CPU pinning;
  - a fresh store per arm, every other `LETHAL_*` variable unset, and one head for every arm (master at the run, recorded).
- **The slot:** `--peak 20`, watchdog at 22 GiB of tree RSS (PR-281's tree peaked at 16.7 GiB; PR-303 amendment 3 found
  22 refused on page cache before R1172).

## When an arm may start, and when it is void (the box)
- **The series starts only on a calm box:**
  - after bugs' PR-330 full-DO A/B has ended;
  - when no other lane announces a timed job;
  - with the orchestrator told at the start.
- **Each arm's start gate**, on two checks 60 s apart:
  - other holders' declared heavy-slot peaks total ≤ 4 GiB;
  - CPU pressure `some avg60` ≤ 20%.
  - A gate that waits more than 30 min is logged, and the series pauses there. An arm never starts without the gate.
- **Recorded per arm:**
  - every 6 s, PR-281's `box.tsv` fields: host load, CPU pressure (avg10 AND avg60), memory pressure, container
    `memory.current`, tree RSS, the container cgroup's `usage_usec`, and other holders' declared GiB;
  - the arm's own CPU, from `/usr/bin/time -v` (user plus system, its children included);
  - the BOOTTIME − MONOTONIC gap, at the start and end (a suspend);
  - the baseline phase's median ms per test (the `kind:"baseline"` requests).
- **Outside CPU** = the cgroup's `usage_usec`, read straight before and straight after the timed command in `arm.sh`
  (unfiltered, the same window as `/usr/bin/time`), minus the arm's own CPU, divided by `time.txt`'s elapsed time
  (cores). It sees load inside the container, not on the host. Host load is recorded but is not a void reason (it
  includes the arm itself).
- **Void:**
  - outside CPU above 2.0 cores on average (PR-281's arms by this rule: A2 1.16, A3 0.94, B2 1.33, B1 3.12);
  - or other holders' declared GiB total > 8 for more than 20% of the arm's samples;
  - or the gap grew (the box slept);
  - or the arm is not COMPLETE.
  - **The re-run:** a void arm is re-run once, AT ONCE (the next arm in the series), under its own letter. This keeps the
    pair adjacent in time. A second void leaves that pair incomplete.
- **At least 3 complete pairs are needed.** With fewer, the result is INCONCLUSIVE and nothing is claimed.

## What is judged
- **V, the hard claim, on EVERY arm, void ones included (BLOCK on any miss):**
  - every arm scores the dry run's deployed mutant count (3,597 under PR-281's head);
  - every arm has the same verdict and the same `killingTest` per mutant as arm 1, with no missing mutant (equality is
    transitive, so arm 1 is enough as the reference);
  - no arm shows `al-runner-v3-daemon-churn`;
  - every arm's session-first warm-up runs in the same mode and size.
  - A miss blocks any default flip and is filed as a correctness item.
- **On the complete pairs only:**
  - **P1, the wall in its pair:** B's mutant-phase wall is below A's in every complete pair but at most one.
  - **P2, the wall normalised by the arm's baseline:** mean of (the mutant-phase wall ÷ the arm's baseline median ms per
    test) for B ÷ the same for A ≤ 0.90.
  - **G, no extra work:** mean of the arm's own CPU for B ÷ the same for A ≤ 1.05.
    - PR-281's arms give 1.15, so a gain is unlikely to pass on G alone.
    - CPU time also rises under outside contention, so G can fail from load. That direction only ever hides a gain.
  - **L, a loss (judged only if a P fails):** B's wall above A's in every complete pair but at most one, AND mean CPU of
    B ÷ A > 1.05.
- **Reported, not judged:**
  - E and the idle tail;
  - the raw wall ratio and its range;
  - the mutant phase's ms per test, by concurrency;
  - the fixed cost per request;
  - each arm's box figures and the spread within each letter.

## What follows
- **V, P1, P2 and G all hold:** propose making `costliest` the default, as a separate task with its own gates. That task
  changes the default and keeps `manifest` as the opt-out. Then, and only then, revisit `MAX_V3_WORKERS` past 8 (PR-274's
  follow-up 2).
- **V holds and L holds:** costliest-first costs work. R1165 is closed by a ruling: `costliest` stays opt-in, and a new
  item asks why a reordered queue costs CPU (the fixed cost per request, and per-test time at equal concurrency).
- **V, P1 and P2 hold, and G fails: "faster but costs CPU".** `costliest` stays opt-in. A new item names the trade: the
  wall it saves against the CPU it adds, and why it adds that CPU. Whether the trade is worth a default is then the
  orchestrator's call.
- **V holds and none of the above:** no gain measured. R1165 is closed by a ruling: `costliest` stays opt-in.
- **INCONCLUSIVE:** R1165 stays open with the arms recorded.

## The tools (written at run time, under `/coord/handoff/PR-332/ab/`, from PR-281's)
- **`arm.sh`:** PR-281's arm with these changes:
  - the knob's letters are swapped (B sets `costliest`);
  - the start gate described above;
  - `--peak 20`;
  - CPU pressure avg60 recorded beside avg10 in `box.tsv`;
  - the cgroup's `usage_usec` read straight before and after the timed command.
- **`series.sh`:** the 8 arms in the order above.
- **`compare.py`:** PR-281's compare, plus the arm's own CPU, outside CPU, the baseline median ms per test (from the
  `kind:"baseline"` requests, which PR-281's filter dropped), the baseline-normalised wall, the per-pair
  table, the void rule and the verdict of each rule above.
- **Before the series:** each arm is smoke-tested once with `--dry-run`, which runs no tests, and the compare is run on
  PR-281's own arms. The compare must reproduce this file's premise table.
- **How long it takes:** about 7-8 h for 8 arms (about 45 min plus baseline each), before any gate waits or re-runs.
