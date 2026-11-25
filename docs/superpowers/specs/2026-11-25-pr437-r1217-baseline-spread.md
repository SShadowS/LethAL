# PR-437 pre-commitment v4 (R1217): spread the whole-codeunit daemon baseline over the lanes

Coord PR-437 (lethal-preproc, 2026-11-25). Written before any code. Evidence lives in `/coord/handoff/PR-437/`:
- `premise.md`: the measured share, offline from earlier runs' events;
- `code-map.md`: the code read at bc61c7e88, with line numbers;
- `code-answers.md`: lethal-code's answers on R1190 r2.

It starts from R1190's parked r2 (`2026-11-25-pr434-per-test-baseline-spread.md`).

**History.**
- v1's review (`spec-review-v1.md`: 1 blocker, 8 serious, 8 minor) gave v2.
- v2's delta review (`spec-review-v2.md`: 2 blockers, 6 serious, 5 minor) gave v3.
- v3 is a simpler shape. **The decision loop is today's loop, unchanged in order; only where its daemon answers come from
  changes.** One-shots get two reserved memory slots.
- v1's answers are cited as A<n> and v2's as B<n>, in §"Answers".
- v3's delta review (`spec-review-v3.md`: 2 serious and 7 smaller findings, no redesign) gave v4. Its answers are C1-C9:
  each is marked "(C<n>)" where it changed the text, and listed in §"Answers".

## What was measured
- **The prize holds at every load (premise.md).** In every full DO run on record, the baseline phase is 3.6-6.8% of the
  run's wall: c3, c3off, c4, c5, PR-330/A1, PR-359/A1 and PR-359/B2, at loads from about 5 to 146.
- **Today the fill runs on ONE lane,** and lanes k ≥ 1 sit idle until the mutants phase.
- **The cross-check samples (R951, 12 one-shots) are 61-76% of the phase** in those full runs (PR-359/A1: 42%). PR-119
  runs at most ONE beside the loop. So the requests and the samples must both be spread.
- **Memory (spec-review-v2.md, c5's own logs; 8 workers at heavy-slot `--peak 22`):**
  - the lane gate measured 3.4-3.8 GiB per lane, and 5 of 8 lanes started;
  - in the baseline phase, LethAL's process tree (1 daemon, at most 1 sample, LethAL itself) had a median of 6.97 GiB and a
    max of 9.74 GiB.
  - So about 5 slots of about 3.8 GiB.
  - On c5's figures (1,403 s of requests, 997 s of samples):
    - 3 daemons and 2 samples give about max(468, 499) s, roughly 31% of today's phase;
    - 4 daemons and 1 sample give about 61%.
  - **So the lanes leave room for two one-shots.**
  - **The baseline daemon's own size (C9).** c5's baseline tree is bimodal:
    - about 4.5-6.2 GiB with no sample in flight (the daemon and LethAL);
    - about 7.6-9.7 GiB with one.
    - So a sample one-shot adds about 3-3.5 GiB, and the baseline daemon is about 3.5-4.7 GiB.
    - With `R0` = 4.5 GiB and a one-shot slot of 3.5 GiB, three daemons and two slots need 3·4.5 + 2·3.5 + 4 (LethAL) =
      24.5 GiB declared, and two daemons need 20.
    - Hence `--peak 25` in outcome 1.
- **Sample time varies about 10× with load and build.** Every cost claim is a paired comparison between interleaved arms
  (the owner's server1 speed rule).

## The change (v3)
**0. One worker is exactly today's code (A13).** The laned fill is entered only when all three hold:
- the session built lanes (`lanes(n)`, n ≥ 2);
- `LETHAL_V3_BASELINE_LANES` is not `1`;
- at the fill's start, the memory guard is on and reads a cgroup limit.

Otherwise `fillDaemonBaseline` runs unchanged, and so do the order-pinned tests (R1001's 10 requests, PR-119's 6
requests, its overlap 1/1 and throw order, R955) and the DB, DBI and DBM legs.

**1. One tree (r2-A3, A11).**
- Every baseline daemon request, on any lane, is sent LANE 0's request base (`sourcePaths` from lane 0's `realActive`).
- `checkBound(lane 0)` runs before each request.
- Every one-shot of the fill runs on lane 0's tree, in lane 0's cwd: samples, lane samples, too-slow runs, replacements.
- Coverage paths are then lane 0's whoever answered, so `keptCoverage`, `coverageOf`'s F1 root and
  `compareBaselineAnswers` stay correct.
- The daemon process stays the lane's own: its cwd, pid, stderr file, `inFlight`, stats and closes.
- The build gives `baselineRequest`, `batchRequest` and `plain` a request-base lane apart from the daemon lane. The
  one-worker path passes lane 0 for both.

**2. Where the answers come from: lane workers fill a store ahead of the loop.**
- Units are PR-115 batch groups (contiguous slices of `ids`) or single codeunits.
- Workers on joined lanes pull whole units from one shared queue, in `ids` order.
- Lane 0's worker starts at once. Lane k ≥ 1 joins under change 3.
- **Inside a unit, a worker does what today's `send` does:**
  - `spent()`;
  - `memoryGate(true)` per request (today's container-wide backstop, unchanged);
  - `checkBound(lane 0)`;
  - the batch request, or the single request;
  - on `batchFailed`, the unit's codeunits re-sent alone, in order;
  - `signalled()` after, which drops that request's answers, a whole batch included.
- **It stores per position, and NEVER the raw answer (r2-A1; DO coverage documents are about 67 MB each):**
  - `keptAnswer(got)` (or "no usable answer");
  - `wallMs`;
  - the answering lane.
- **The halt (A7, B9, C7) has two kinds.**
  - **The LOOP's halt** (a drop, a stop, a uniform refusal) is checked before EVERY request. After the loop has decided,
    no further request is sent.
  - **A WORKER's throw halt** is checked at unit start only. A worker still finishes the unit it holds (unless `spent()`
    or `signalled()` ends it), so every position before a later throw is filled (A5).
- **The batching latch** is read at unit start. Request and batch counts then depend on timing, and verdicts do not
  (PR-115). This is accepted, and named.
- **A worker that throws** records `{ threw }` at the position and sets the halt.

**3. Lanes joining, with two slots kept for one-shots (A1-A3, B6, B7).**
- **No lane k ≥ 1 joins:**
  - before lane 0's first answer (warm cache, r2-A8);
  - while `R0` has no reading.
- **`R0`** is the highest anon-RSS reading of any baseline daemon so far, at least `est`. A reading of 0 (a restart gap)
  is no reading. The same reads update it.
- **At each unit boundary, a lane that has not joined joins only if both of `decideLanes`' checks hold for
  `T = (joined + 1)·R0 + 2·S`.**
  - **`joined` counts lane 0 (C5).** The first join's `T` is `2·R0 + 2·S`.
  - **`S`** is `BASELINE_ONESHOT_SLOT_BYTES` = 3.5 GiB, the two reserved one-shot slots. That is c5's measured one-shot
    increment (3-3.5 GiB, C9), and it is above `est`.
  - The two checks:
  - cgroup: `used − ownDaemons + T + lethalTerm ≤ max − LANE_RESERVE_BYTES`;
  - declared: `T + LANE_LETHAL_BYTES ≤ declaredPeakGib()`.
- **`ownDaemons`** is the anon RSS of the job's baseline daemons. A running one-shot has no pid to read, so it is in
  `used` and also in `T`'s slots: a conservative double count, accepted and named (B7).
- **A "no" is asked again at the next boundary.** It never waits and never stops the fill.
- **A joined lane never leaves** until the fill ends.
- **Request-time admission is gone** (v2's A4). The joined daemons and the two one-shot slots were all charged at join, so
  a request needs no new check beyond today's `memoryGate`. That also removes v2's spin hazard (B3).
- **The memory gate's over-bound path** closes only baseline daemons whose lane has no request in flight, and retries this
  on every poll (A4, A12).
- **A memory stop** (`memoryStopped`) stops every worker and the loop, as today.

**4. The loop: today's `fillDaemonBaseline` body, in today's order.**
- It walks `ids` in order. At each position, instead of calling `send`, it awaits that position's stored outcome. Every
  rule after that point is today's code, in today's order:
  - `hasEveryRow`;
  - the uniform watch with R1001;
  - `unusable ≥ 2`;
  - `tooSlow`;
  - samples, `replace`, `pending`;
  - R955;
  - R951's minimum;
  - `dropDaemonBaseline`.
- **Only positions the loop walked enter `answers` (A6).** Stored outcomes past a stop or a drop are discarded and never
  served, so nothing bypasses `tooSlow`.
- **On a drop, a stop, a uniform refusal, or a throw it reaches,** the loop sets the halt.
- **At a position whose outcome will never come** (the workers settled):
  - when `memoryStopped` holds and no stop handle is set, it rethrows the recorded `AlRunnerV3MemoryBoundError`, from
    whatever position it was recorded at (C4): today that error is loud, and a gap must not swallow it;
  - otherwise it is a stop ONLY when `spent() || signalled() || memoryStopped`;
  - otherwise it rethrows the earliest recorded throw at or after that position, if any;
  - otherwise it throws `al-runner-v3-baseline-fill-gap` by name (A5).
- **Throws in position order (r2-A6).** A recorded throw is rethrown when the loop reaches its position, so an earlier
  drop or stop wins. The immediate memory-bound throw (no stop handle) still goes through the `finally` below (A15).

**5. One-shots: PR-119 generalised from one in flight to two (B2).**
- **Until the first lane k ≥ 1 has joined (C2),** the slots are not charged. PR-119 then runs exactly as today: at most one
  sample beside, admitted by `admit`, with `roomForRequest`/`beforeRequest` before each of lane 0's requests. This
  includes every fill in which no lane joins.
- **Once a lane has joined,** the two slots charged at join stand in for those memory reads.
- **Every one-shot of the fill** (planned samples, lane samples, replacement checks, too-slow runs) takes one of the two
  reserved slots.
- **A planned sample** starts beside the loop, exactly where PR-119 starts it today (same conditions: `got` usable, the
  last position not concurrent), if a slot is free.
- **An "in place" one-shot** (too-slow, a backward replacement, a sample with no free slot) first frees a slot by settling
  the OLDEST in-flight sample, as PR-119's `settle` does. So at most two one-shots run at once, whatever kind.
- **Results are applied by the loop only, oldest first.** Before any decisive act (a drop, a uniform stop, a replacement,
  a too-slow run, the end), the loop settles every in-flight sample, as PR-119 settles its one. An earlier sample's drop
  wins.
- **An in-place one-shot that throws (C6)** first has the older in-flight samples settled and applied. If one of them
  drops, the fill drops and returns; otherwise the throw is rethrown. So position order holds.
- **A sample's own writes stay where they are today, inside `crossCheckSample`:** `compared`, and on a skip
  `uncleanCalls` and `noteSkip`.
  - With two in flight, a second sample can therefore make those writes even when the first one's result then drops the
    daemon baseline.
  - That is accepted and named, because every direction is safe:
    - after a drop, `compared` is no longer read for this fill;
    - an `uncleanCalls` mark only keeps that codeunit off the daemon later (it runs one-shot).
  - Its result itself is applied only when the loop settles it, in order.
- `crossCheckSample`'s first statement stays `memoryGate(true)`, queued before its first await (PR-119's assertion).
- **Knob (A17).** `LETHAL_V3_SEQUENTIAL_SAMPLES=1` (or the seam `concurrentSamples: false`) means no sample beside: one
  at a time, in place, as today's sequential mode.

**6. Per-lane samples (r2-A9, B1, B4, B5, B12, B13, C1, C3).**
- **Which.** Each lane, lane 0 INCLUDED (C1), with at least one walked position past its first answered codeunit, is
  sampled once at its SECOND answered codeunit in `ids` order (a warm daemon, across units, B4).
  - Lane 0's first answer is position 0, which is never sampled, today included.
  - A lane whose only walked answer is its first one needs no sample: a fresh daemon's first answer is today's index-0
    standard.
- **Who chooses.** The loop, when it walks that position.
- **A planned sample or a replacement pick answered by lane k** counts as lane k's sample only if it is NOT lane k's first
  answered codeunit (C1). Otherwise lane k still needs its own sample.
- **A lane sample is a sample in every respect (B1).**
  - It takes the sample branch at its position, so the one-shot's answer (fresh durations) stands, exactly as for a
    planned sample.
  - A differing compare drops the daemon baseline.
  - So a too-slow codeunit never keeps a warm duration.
- **Counted apart (C3).** `crossCheckSample` and `apply` take a lane-sample flag.
  - A lane sample writes `laneSampled` (compared clean) or `laneSampledSkipped`, never `compared` or `sampledSkipped`.
  - On a skip, it still adds the codeunit to `uncleanCalls` and notes the skip, as any sample does.
  - It never calls `replace` and never touches `SamplePlan`.
  - R951's minimum counts planned compares only, as today; lane samples are not in it.
  - `judgeDaemonBaseline`'s second identity gains both lane terms:
    `served + skipped + replaced + laneSampled + laneSampledSkipped = expected`.
  - Its first identity is unchanged.
  - DB and DBM have no lanes, so the lane terms are 0 there.
- **A skipped lane sample** (a `SKIPPABLE_NO_ANSWER` reason) or an unusable one leaves lane k still needing a sample, which
  is taken at that lane's next walked answered codeunit (B5).
- **Every lane with a walked position needs one clean compare,** on a stop too. Otherwise the daemon baseline drops by
  name: `baseline-lane-unsampled:<k>`, in the safe direction.

**7. Closes (r2-A12, R866).**
- After the workers settle, every joined lane k ≥ 1's baseline daemon is closed in a `finally`.
- The `finally` awaits every one-shot still in flight. Only a throw is acted on there, as PR-119 does.
- Lane 0's daemon closes at the fill's end, as today. No daemon and no one-shot outlives the fill.

**8. Knob.** `LETHAL_V3_BASELINE_LANES` is read at construction:
- unset: the spread;
- `1`: today's path;
- any other value: refused by name.

**9. Run-ahead (r2-A7).**
- Workers may answer positions the loop has not walked yet. The halt bounds this to the units already held.
- Their side effects are today's per request: refusal closes, the storm notice, `test-data-off`.
- Outcome 1's warning codes check this.

**10. The cobertura file.** Two concurrent one-shots in lane 0's cwd each write `coverage.cobertura.xml`. That already
happens today, and nothing in v3 reads it. Accepted, and named.

**11. Receipt.** PR-115's and PR-119's lines stay. One more plain line names:
- the daemons that answered, and their units;
- the lanes not admitted, with the rule and figures;
- the lane samples;
- the most one-shots in flight at once.

## Pre-committed outcomes (any difference is a BLOCK)
1. **DO, paired.**
   - Four scoped runs on the PR head, interleaved A, B, A, B:
     - c5's settings (`isolation: test`) on `current`;
     - `--only` one busy file, so the baseline is the full suite (1979 tests) and the mutants phase is short;
     - `--workers 5`;
     - CPUs 0-11 through heavy-slot `--peak 25` (C9: three daemons and two slots need 24.5);
     - PR-439's driver (LethAL's own pid; the watchdog TERMs only it);
     - a FRESH store and no resume in every arm;
     - A with `LETHAL_V3_BASELINE_LANES=1`, B unset.
   - Every arm proves the fill ran: PR-115's and PR-119's lines, `served > 0`, and no reused baseline.
   - Across all four arms:
     - per mutant: verdict, killing test, and covering-test set equal (A8);
     - `baseline-batch-finished`'s per-test outcome and classification equal;
     - skipped sets equal by name.
   - **The one allowance (B10, C8), derived mechanically from each arm's `daemonBaselineReport`.**
     - A codeunit answered one-shot in one arm and by a daemon in another (any pair of the four arms) is listed. The
       reason can be a too-slow run, a sample, a lane sample or a replacement.
     - A mutant whose covering tests include a listed codeunit may differ only from the DAEMON arm's `timeout-killed` to
       a non-timeout verdict in the ONE-SHOT arm. That is the safe direction: a fresh duration gives a budget at least
       `floor`.
     - Its skipped-set difference is listed the same way.
     - Nothing else may differ.
   - B's warning codes equal A's.
   - **In B:**
     - the daemon baseline is not dropped;
     - the receipt shows more than one daemon, and two one-shots in flight at some point;
     - LethAL's peak process-tree RSS (the driver's `tree_MiB`, not the shared cgroup's peak, B11) stays under the
       declared 25 GiB.
   - **Cost (C9):** each B's baseline phase is at most 65% of the mean of the A arms beside it.
     - The review's timeline on c5's figures (lane 0 alone for its first unit, each joining lane's cold compile, the
       last sample in place) gives about 48% with three daemons and about 58% with two.
     - Load is recorded per arm.
     - **A cost miss is a BLOCK on landing:** the change does not land, and the measurement is recorded in R1217.
2. **v3 gate:** every existing figure is unchanged, with each leg's warning set.
3. **New leg DBM-W (A9, B8).**
   - DBM's fixture (4 codeunits, batch size 2), laned with `workers` 2, admission forced open by the memory seams.
   - A seam holds lane 0 after its first unit until lane 1 has taken a unit.
   - Per-mutant figures equal DBM's.
   - `daemonBaselineReport` equals DBM's, except `samplesOverlapped`/`samplesSequential`, which are timing.
   - Lane 1's sample is the planned last sample (`baselineSampleIds(4)` = {1, 3}; units [0, 1], [2, 3]), so
     `laneSampled` = 0 and no extra one-shot runs.
   - The warning set equals DBM's, and the receipt shows 2 daemons.
4. **Unit tests, red both ways:**
   - the one-worker path is today's: the knob at 1, no lanes, or no readable guard each take `fillDaemonBaseline`;
   - lane k's request carries lane 0's `sourcePaths` and `checkBound(lane 0)`; every one-shot's tree and cwd are lane 0's;
   - stored outcomes hold no raw answer;
   - joins:
     - each of the two checks refuses alone;
     - `T` counts the two one-shot slots;
     - a 0 reading never admits;
     - none joins before lane 0's first answer, and the fill still finishes when none joins;
   - never more than two one-shots in flight, in-place kinds included; an in-place one-shot first settles the oldest;
   - the over-bound path closes an idle lane on a later poll, never one in flight;
   - the halt: after a drop at position p, no worker takes a new unit;
   - only walked positions are served: an outcome stored past a stop is never in `daemonBaseline`;
   - a typed throw after a gap is rethrown, never read as fill-gap; a gap with no throw and no stop throws fill-gap;
   - a throw at a later position loses to a drop at an earlier one;
   - the uniform watch and `unusable` see `ids` order whatever the completion order (a fake whose lanes answer out of
     order);
   - a unit goes to one lane, in order; a failed batch is re-sent alone by the same worker;
   - lane samples:
     - each lane with a walked position is sampled once, at its second answer;
     - a planned sample on it counts;
     - a too-slow lane sample serves the one-shot's durations (B1);
     - a skipped lane sample is replaced by that lane's next answer;
     - an unsampled lane drops by name, on a stop too;
     - `judgeDaemonBaseline` holds with the lane term;
   - every joined lane is closed and every one-shot settled at the end, including on the immediate memory-bound throw;
   - the knobs: `LETHAL_V3_BASELINE_LANES=1` gives one worker and a bad value is refused; sequential samples give none
     beside.

## Answers
- **v1 (A1-A17):**
  - **A1-A3:** change 3 (decideLanes' two checks; `R0` as the highest reading; slots charged at join).
  - **A4:** request-time admission is removed.
  - **A5:** change 2 (finish the unit) and change 4 (earliest throw).
  - **A6:** change 4 (only walked positions served).
  - **A7:** the halt.
  - **A8:** outcome 1's covering sets.
  - **A9:** DBM-W.
  - **A10 and A14:** the loop itself starts and applies samples, as today.
  - **A11:** change 1.
  - **A12:** change 3.
  - **A13:** change 0.
  - **A15:** change 4 and change 7.
  - **A16:** outcome 1's tree RSS.
  - **A17:** change 5.
- **v2 (B1-B13):**
  - **B1:** a lane sample is a sample in every respect.
  - **B2:** every one-shot takes one of the two slots.
  - **B3:** no request-time admission is left to spin on.
  - **B4:** the second answer, across units.
  - **B5:** a skipped lane sample is replaced.
  - **B6:** two slots are reserved at join (v4: `--peak 25`, from C9).
  - **B7:** the double count is named; `R0` is the highest reading.
  - **B8:** the timing counters are left out of DBM-W.
  - **B9:** the halt is checked at unit start.
  - **B10:** the safe-direction allowance.
  - **B11:** the job's own tree RSS.
  - **B12:** the loop chooses; a planned or picked sample counts.
  - **B13:** "walked".

- **v3 (C1-C9):**
  - **C1:** a planned or picked sample counts for lane k only past its first answer; lanes k ≥ 0 are sampled.
  - **C2:** PR-119 runs exactly as today until a lane joins.
  - **C3:** the lane-sample flag, counters and identity; no `replace` for lane samples.
  - **C4:** the memory-bound error is rethrown at a gap.
  - **C5:** `joined` counts lane 0.
  - **C6:** an in-place throw settles older samples first.
  - **C7:** the loop's halt is checked before every request.
  - **C8:** the allowance is derived mechanically, any arm pair.
  - **C9:** `R0`, the slot size and `--peak 25`; the cost bar is 65%, and a miss blocks landing.
- **Unit tests added by v4 (red both ways):**
  - a lane's first answer never counts as its sample, and lane 0 is sampled warm;
  - with no lane joined, at most one sample runs beside, through `admit`;
  - a skipped lane sample calls no `replace` and the identity holds with `laneSampledSkipped`;
  - a gap with `memoryStopped` and no stop handle rethrows the memory-bound error;
  - the first join's `T` is `2·R0 + 2·S`;
  - an in-place throw after an older dropping sample drops;
  - after the loop drops, no worker sends another request.

## Predictions (not gates)
At the next full DO run on `current`: the baseline phase falls to about 30-50% of its paired figure. That saves about 2-4%
of the run's wall, from c5's 6.8%. It is read from TIMING and the phase events, and reported.

## Amendment 1 (2026-11-25, from the build; no outcome bar or prediction changes)
1. **DBM-W's warning set is DBM's plus `al-runner-v3-lanes-started`.** Every `--workers 2` session prints that code when
   its mutants phase starts lanes, so it is not a difference the spread makes.
2. **DBM-W runs as a third session inside leg DBM** (`dbm-w-daemon`), not as a separate leg name, because it compares
   against DBM's own result.
   - It runs only when DBM's batching seam is on (units [0, 1] and [2, 3] need batches of 2).
   - Otherwise it prints "not applicable" with the reason.
   - Its figures go under the new expected key `al-runner-v3/dbm-w-daemon`.
3. **C4 covers every stop.** With no stop handle, the loop can reach a stop caused by `memoryStopped` (a sample that got
   no answer) before the position where a worker recorded the memory-bound error.
   - So after the final settle, `stopped && memoryStopped && no stop handle && an error recorded` rethrows that error.
   - Today's error stays loud.
4. **Two counting choices the spec left open:**
   - R1001's `cleanCompared` counts planned compares only, as R951's minimum does.
   - A lane sample running beside the loop whose skip becomes known only when it settles leaves its lane needing a
     sample. That need is met by a later counting sample on the lane, or the daemon baseline drops by name
     (`baseline-lane-unsampled:<k>`), in the safe direction.

## Amendment 2 (2026-11-25, from build review 1, `/coord/handoff/PR-437/build-review-1.md`; no outcome bar changes)
1. **"A lane's first answer" (change 6, C1) means every position answered by the lane's FIRST REQUEST,** a whole batch
   included, not only its first codeunit.
   - Inside one batch request from a fresh daemon, the second codeunit is not a warm answer.
   - So a lane's sample is taken from its second request or later. A lane whose walked answers all came from its first
     request needs no sample: a fresh daemon's first answer is today's index-0 standard.
   - DBM-W is unchanged: lane 1 sends one request, so `laneSampled` = 0.
2. **Before the first join (C2), the loop's in-place one-shots count too.** While one runs, lane 0's worker sends only
   when `roomForRequest` admits it, and otherwise waits for that one-shot. Today an in-place one-shot blocks the only
   requester.
3. **R955 per position.** The loop checks `spent()` at the top of each position and stops there. That stops earlier than
   today inside a batch, which is the safe direction.
4. **A recorded worker throw is rethrown only after the in-flight samples are settled,** as C6 does, so an earlier drop
   wins.
