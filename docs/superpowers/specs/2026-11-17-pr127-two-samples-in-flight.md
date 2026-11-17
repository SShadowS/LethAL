# PR-127 (R1112): up to two of the daemon fill's cross-check samples in flight

Status: r4 (coord PR-127, lethal-preproc, 2026-11-17). It builds on PR-119's design
(`2026-11-17-pr119-concurrent-baseline-samples.md`, r5), whose rules hold unless this file changes them. r4 answers the
opus review of the built diff (§0b); r3 answered the delta review of r2 (§0a); r2 answered the reviews of r1 (§0). r4 is
amendment 1 of the pre-commitment (3ce00972); the proof's predictions (§7) are unchanged.

## 0b. The review of the built diff (opus; lethal-code on deviation 3), finding by finding
- **No high or medium finding.** It is safe to run the proofs.
- **L1: a stop found by the loop's own re-check discarded the queue, so an older in-flight drop was lost**, though the
  sequential fill would have applied it. `send()`'s stop already applied it.
  - No verdict risk: a stopped baseline scores nothing, and a partial baseline is never stored for reuse.
  - Fixed so both paths match the sequential fill: §2.7 now applies the queue in stop mode.
  - lethal-code found no batch-path case where the two paths differ beyond that warning.
- **L2:** the re-check right after the queue-full settle was redundant (the post-admission one always follows). Removed.
- **L4:** two `finally` tests depended on a hold's cap. They are now held by a flag.
- **L3, L5, L6 (noted):**
  - the "younger stop at quiesce" branch is a backstop that production cannot reach;
  - under a drop, K = 2 runs more requests before the fill returns (P2 expects no drop);
  - discarded entries are counted in no stat.

## 0a. Delta review of r2 (opus), finding by finding
- **D1 (low-medium, R955): admission's `await memoryChain` was a wait with no stop re-check after it.** The re-check now
  sits right before the start, after admission (§2.5).
- **D2 (low):** `finally` now walks the queue oldest first, and the first non-ok entry decides (§4.6).
- **D3 (low, also in today's code): a started sample could outlive the fill when `sample-gate-not-queued` fires.** The
  entry is now queued before the check throws (§2.5).
- **Stated:**
  - every discard comes with a throw, a drop or a stop, so R951's count is never read with discarded entries in it
    (§2.3);
  - a re-check inside `apply` returns `stop`, and only that propagates (§2.7).
- **D4:**
  - "the compared codeunits" is now defined (§7.2);
  - `requests` stays strict, except a re-send after a request error, traced by its event;
  - P3's vacuous verdict clause is dropped. The pre-commitment of the proof runs (§7) is committed to master with this spec's final text before any
proof run.

## 0. Reviews of r1 (opus spec-adversary; lethal-code), finding by finding
- **No high finding.** No false kill. No answer is kept or served that the sequential fill would drop, beyond PR-119's
  accepted replacement differences.
- **A1 (medium): a one-shot could start after the budget was spent.** Waiting for the oldest entry is now the common case,
  and nothing re-checked the stop before the next sample started. The same gap was in quiesce. Fixed: §2.7.
- **A2 (medium): a younger entry's throw could beat an older error already thrown, and a younger throw could turn an older
  drop or stop into a refusal.** Fixed by the discarded list: §2.3, §4.6.
- **A3 (medium): the settle inside `send()` was defined twice.** It is now one rule: settle the oldest, read again, and so on
  until the read says yes (§3).
- **lethal-code (medium): "which samples run is unchanged" is false when a sample is skipped.** The oldest settles later
  under K = 2, so R951's forward pick, which depends on the settle position, can land later. I7 is weakened, and §7.2's
  sample equality is conditional (as PR-119 r3 did).
- **A L1:** after a `stop` from the oldest, the younger entries were still applied after the loop. They are now discarded.
  - Applying a younger `dropped` after a stop is not done. A stopped baseline scores no mutant, and R1008 re-runs the
    baseline on resume.
- **A L2:** `samplesPaired` counted a sample whose partner had already finished. It now counts only while the partner's
  process still runs (§5).
- **A L3:** §7.2 lost PR-119's list of allowed differences; "the same sampled codeunits" was vacuous (it is the planned
  list); durations must be left out. Rewritten in §7.2.
- **A L4:** admission now awaits `memoryChain` when the queue is not empty (§3).
- **A L5:** the default falls back to K = 1 if P3 fails (§7.3). A bad seam value is refused like a bad environment value.
- **lethal-code, the lows:**
  - `send()`'s loop returns on a non-ok settle;
  - a backward pick inside `send()` is followed by a fresh read and `spent()`;
  - a queue-full settle among a batch's cached answers holds, and gets a unit test.

## 1. Why
- On DO 735fb42's whole project, batched, the 9 cross-check one-shots summed 199-250 s, against 132-189 s of daemon
  requests (PR-124's B-on, PR-125's re-run). The baseline phase took 231-288 s.
- Each whole-DO one-shot takes 12-14 s on a quiet box (PR-125): a 7 s workspace compile, 4.4 s of coverage, 0.2 s of tests.
- The fill settles a sample before it starts the next one (PR-119 allows one in flight). A one-shot takes longer than
  the daemon requests between two samples, so the daemon waits, and the chain of one-shots is the critical path.

## 2. The change
1. **The in-flight sample becomes a queue,** `inflight: InFlight[]`, oldest first, holding at most `K` entries.
   - `K = seams.samplesInFlight ?? env`, where `LETHAL_V3_SAMPLES_IN_FLIGHT` is `1` or `2` (default `2`).
   - Any other value of either is refused by name (`AlRunnerV3SamplesInFlightRefusedError`; the environment value at
     construction, the seam at the fill's start).
   - `concurrentSamples: false` and `LETHAL_V3_SEQUENTIAL_SAMPLES=1` keep their meaning: nothing in flight.
   - Each entry has `done`, a flag set when its promise resolves.
2. **Every result is applied in the order the samples started (FIFO).** That is the order the sequential fill applies
   them in. A promise holds only `crossCheckSample`'s raw result, and never rejects (PR-119 §2.2).
3. **The discarded list.** When an applied entry's result ends the step, every younger entry moves from the queue to
   `discarded`, and none of them is ever applied. Ending the step means:
   - `threw`, `dropped` or `stop`;
   - a `skipped` whose `replace` returned `dropped` or `stop`.

   In the sequential fill those younger samples would not have started. `finally` awaits the discarded entries, and a
   throw from one of them is named in a warning (`al-runner-v3-baseline-sample-discarded-error`), never thrown.
   - **Invariant:** a discard happens only with a throw, a drop (the fill returns) or a stop (R951's check is skipped). A
     discarded entry may have counted `compared` inside `crossCheckSample`, so R951's count of clean samples is never read
     after a discard. A future discard without a stop would break this and must not be added.
4. **The settle operations:**
   - `settleOldest(when)` applies the oldest entry. A non-ok result triggers §2.3 and is returned.
   - `settleAll(when)` calls `settleOldest` until the queue is empty or a result is not `ok`.
5. **Starting a sample** (settle point 1):
   - while the queue is full (`inflight.length === K`), the oldest entry is settled; a non-ok result is handled as today
     (return, or break);
   - then admission (§3), which may await `memoryChain`;
   - then the stop re-check (§2.7), right before anything starts (r3, D1);
   - admitted: the sample starts, and its entry is appended BEFORE the `sample-gate-not-queued` check, so a throw there
     leaves it for `finally` to await (r3, D3);
   - refused: `settleAll`, the stop re-check again, then the sample runs in place (`check`), as today.
6. **No one-shot runs in place beside a running one-shot (quiesce).**
   - When `apply` is about to run a backward replacement pick in place, it first awaits the promises of every younger
     entry still queued, without applying them.
   - Then the stop re-check (§2.7) runs. A pick also does not start if any quiesced younger entry resolved to `stop`.
     Then the skipped sample is `answers.delete` only, and the younger `stop` is applied next, in order.
   - Otherwise the pick runs and is applied, and the younger entries are applied after it, in their order. That is the
     sequential order: the older sample, its backward pick, the younger sample.
   - A forward pick only marks `pending`, as today, and starts nothing.
   - The too-slow one-shot and every other in-place `check` are preceded by `settleAll`.
7. **The stop re-check** after every wait (a `settleOldest`, a `settleAll`, a quiesce): if `stopHandle.spent()`,
   `stopHandle.signalled()` or `memoryStopped` holds, nothing new starts. The loop sets `stopped` and breaks. The queue is
   NOT discarded: the after-loop `settleAll("stop")` applies it in stop mode, as PR-119 and `send()`'s stop do (r4, build
   review L1). Every queued entry started at an earlier position, so the sequential fill would have applied it, an older
   drop included. In stop mode a `skipped` is `answers.delete` only, so nothing new starts. Only a RESULT that ends the
   step discards (§2.3).
   - Inside `apply`, after a quiesce, or inside `send()`, the re-check returns `stop` as a value. Only that propagates to
     the loop, which then breaks; `apply` never breaks the loop itself.
8. **Every other settle point drains the whole queue (`settleAll`), as PR-119's single settle did:**
   - before the too-slow one-shot;
   - in the `got === undefined && isSample` branch, before its `replace`;
   - before the R1001 uniform stop;
   - before the two-unusable drop;
   - after the loop, unless the queue was discarded.
   - The one in `send()` is in §3.

## 3. Memory
`E = memoryEstimate()`; `S_i` is the size of in-flight entry i, taken at its admission (PR-119 §3: the larger of `E` and the
daemon's RSS); `memoryHeld` counts each in-flight entry's reservation at `E` once its gate has run.
- **Admission of a new sample of size S:**
  - With the queue not empty, first await `memoryChain`, so every in-flight reservation is in `memoryHeld`.
  - Admitted only if `used + memoryHeld x E + sum over queued entries of max(0, S_i - E) + S + E <= bound`.
  - With an empty queue this is PR-119's formula.
  - Unchanged: no guard means admitted; an unreadable reading or RSS means not admitted; the last position is never
    admitted.
- **The pre-check in `send()`, before every daemon request (a batch, a single, and the re-send after `batchFailed`), while
  the queue is not empty:**
  1. Await `memoryChain`.
  2. Require `used + memoryHeld x E + sum over queued entries of max(0, S_i - E) + E <= bound`.
  3. If it says no, `settleOldest`.
     - A non-ok result returns from `send()`: `dropped` -> `{ dropped: true }`, `stop` -> `{ stop: true }`.
     - Otherwise go back to step 1, until the read says yes or the queue is empty.
  4. Then check `spent()` (PR-119's re-check), also after a settle that ran a backward pick in place.
- **Each started sample must still queue its memory gate before its first await** (PR-119's
  `al-runner-v3-sample-gate-not-queued` check, unchanged).
- **A sample's own gate can only close an idle daemon:** samples and quiesced picks start between requests, and the gates
  run in order on `memoryChain`.
- **Precedent:** two one-shots in one scratch cwd with one `ALRUNNER_CACHE` already run in `fillIsolatedRun`'s parallel
  workers.
- Still no `watchMemory()` in this fill.

## 4. The invariants (each one gets a red test both ways, §7.4)
1. **I1, FIFO:** results are applied in start order. "The first drop wins" means the oldest one. An entry younger than a
   result that ends the step is never applied (§2.3).
2. **I2:** at most `K` one-shots of this fill run at any time.
   - A backward replacement pick, the too-slow one-shot and an in-place `check` each run with no other one-shot of the
     fill running.
3. **I3, R955:** after a stop, no new one-shot starts.
   - A stop is a `stop` result, `spent()`, `signalled()` or `memoryStopped`.
   - It is checked after every wait (§2.7).
   - A `skipped` result applied at or after a stop is `answers.delete` only (PR-119).
4. **I4:** nothing is served before the fill ends, and no entry outlives the fill (`finally` awaits both the queue and the
   discarded list).
5. **I5:** each daemon request's pre-check counts every queued entry beyond its reservation, and settles the oldest until
   the read says yes.
6. **I6, errors:**
   - A queued entry that threw throws its original error when it is applied (FIFO).
   - In `finally`: if the loop's error came from applying an entry, or from that entry's pick, it stands, and every
     younger entry is discarded (a warning only).
   - If the loop's error is the loop's own (a daemon request, a check), `finally` walks the queue oldest first, and the
     first non-ok entry decides (r3, D2):
     - `threw`: that error is thrown, with PR-119's `al-runner-v3-baseline-sample-error-order` warning;
     - `dropped` or `stop`: the loop's error stands (PR-119 r5);
     - every younger entry is discarded (a warning only).
   - A discarded entry's throw is never thrown.
7. **I7:**
   - Unchanged: the planned samples (`baselineSampleIds`), how each is compared, R1001's `cleanCompared`, and that R951's
     minimum of clean samples is enforced.
   - May differ, as in PR-119: which codeunit replaces a skipped sample (the forward pick depends on the settle position,
     which comes later under K = 2), and so the actual set of compared codeunits when a sample is skipped.

## 5. Stats
- `samplesOverlapped` and `samplesSequential` are as in PR-119, counted per entry.
- **New: `samplesPaired`,** the samples that started while an older entry's process still ran (its `done` still false).
- The console line becomes
  `[lethal] al-runner-v3 baseline samples (PR-119): N overlapped, M sequential, P paired (in flight at most K).`
- `daemonBaselineReport()` gains `samplesPaired` and `samplesInFlight` (K).

## 6. Not changed
The sample plan, `crossCheckSample`, the drop rules, batching, the per-test fill (sequential), the too-slow rule, and what
is served.

## 7. The proof (pre-committed on master before any proof run)
1. **The v3 gate, `itest:alrunner-v3`:** every leg passes, with every figure unchanged.
   - DBM keeps `concurrentSamples` true and asserts `samplesOverlapped >= 1`.
   - DBM cannot pair: of its 2 samples, the last is never admitted. So pairing is not exercised by the gate. That is
     stated, not hidden: the unit tests and P2 carry it.
2. **P2, DO 735fb42, (a) `LETHAL_V3_SAMPLES_IN_FLIGHT=1` against (b) the default 2,** one after the other in one heavy slot.
   Setup as PR-124's (config PR-67's `v3.json`, `--workers 1`).
   - **"The compared codeunits"** is the planned samples, less `sampledSkipped`, plus the values of `replacements`,
     taken from `daemonBaselineReport()` in the stderr's daemon-baseline line, or else from the `baseline-one-shot-timed`
     events with reason `cross-check`.
   - **`requests`** is strict, except a re-send after a request error (`batchFailed`), traced by its event; that is
     reported.
   - **The arm** (`--changed-since 735fb42^`), whole runs. **Equal (a difference is a BLOCK):**
     - every per-mutant verdict and killingTest, by PR-107's join;
     - `requests`;
     - the planned samples;
     - and, when neither leg skipped a sample, the compared codeunits and `compared`.
   - **The whole project,** baseline only (one SIGTERM at `baseline-batch-finished`). **Equal:**
     - each test's status and failure text, durations left out;
     - `requests`;
     - the planned samples;
     - and, when neither leg skipped a sample, the compared codeunits.
   - **Allowed to differ, reported (PR-119 §7.2's list):**
     - `replacements`, and the order of `skippedError` / `sampledSkipped`;
     - `skippedTooSlow` and timed-out skips (more only, from contention);
     - `served`, either way;
     - the warning codes that follow from those (only those; any other warning difference is a BLOCK);
     - a session refused by an error, where the sequential fill would have dropped first (PR-119 r5).
     - Longer kept one-shot durations can lengthen budgets (the safe direction). Any verdict difference is still a BLOCK
       until it is traced.
   - **The wall:** if (b)'s whole-project run has `samplesPaired >= 3`, its baseline phase is at least 40 s shorter than
     (a)'s, provided both legs' load averages at their start are within 50% of each other. Otherwise it is reported, not
     judged.
   - **Memory:** the whole-project leg's own al-runner children peak at most at the daemon's peak plus twice the largest
     one-shot peak plus 0.5 GiB; no memory stop in any leg.
3. **P3, BaseApp 28.6 × the 12 FA test codeunits (PR-119's P3 setup), (a) against (b), baseline only:**
   - the same per-test statuses and refusal texts (a baseline-only run scores no mutant, so no verdict is compared);
   - no memory stop, and the peak under the guard's bound.
   - It pairs at most once (samples at 1, 10, 11, and 11 is never admitted), so it is a memory and equality check, not a
     wall check.
   - **If P3 fails, the default becomes K = 1** until a ruling.
4. **Unit tests (call counters on stateful fakes, never wall-clock), each red when its rule is reverted:**
   - **I1:** a younger entry that finishes first is applied second; an older drop wins and the younger is discarded.
   - **I2:**
     - a backward pick waits for a running younger entry;
     - at most K processes run at once;
     - K = 1 behaves as PR-119.
   - **I3:**
     - the budget spent during the queue-full wait starts no third one-shot;
     - the budget spent during admission's chain wait starts nothing (r3, D1);
     - an older in-flight drop is still applied when the loop's re-check stops the fill (r4, L1);
     - a younger `stop` found at quiesce cancels the pick;
     - a `stop` from the oldest discards the younger;
     - a `skipped` applied after a stop starts nothing.
   - **I4:** `finally` awaits the queue and the discarded list.
   - **I5:** the pre-check counts both entries and settles the oldest until the read says yes; it returns on a non-ok
     settle.
   - **I6:**
     - A threw, B threw: A's error;
     - A stop, B threw: a clean stop and a warning;
     - the loop's own error with B threw: B's error and the order warning;
     - the loop's own error with A dropped (unapplied) and B threw: the loop's error, and B is warned about (r3, D2);
     - a `sample-gate-not-queued` throw: the started sample is still awaited (r3, D3).
   - **The queue-full settle:**
     - a third sample settles only the oldest;
     - one lands among a batch's cached answers, with a skip whose forward pick is the next codeunit of the same batch.
   - **`samplesPaired`:** not counted when the older entry had already finished.
   - **Admission** awaits `memoryChain` when the queue is not empty.
   - **The environment and seam values,** and the refusal of bad values.
