# PR-127 (R1112): up to two of the daemon fill's cross-check samples in flight

Status: r1 (coord PR-127, lethal-preproc, 2026-11-17). It builds on PR-119's design
(`2026-11-17-pr119-concurrent-baseline-samples.md`, r5), whose rules hold unless this file changes them. The pre-commitment
of the proof runs (§7) is committed to master with this spec's final text before any proof run.

## 1. Why
- On DO 735fb42's whole project, batched, the 9 cross-check one-shots summed 199-250 s, against 132-189 s of daemon
  requests (PR-124's B-on, PR-125's re-run). The baseline phase took 231-288 s.
- Each whole-DO one-shot takes 12-14 s on a quiet box (PR-125): a 7 s workspace compile, 4.4 s of coverage, 0.2 s of tests.
- The fill settles a sample before it starts the next one (PR-119 allows one in flight). A one-shot takes longer than
  the daemon requests between two samples, so the daemon waits, and the chain of one-shots is the critical path.

## 2. The change
1. **The in-flight sample becomes a queue,** `inflight: InFlight[]`, oldest first, holding at most `K` entries.
   - `K = seams.samplesInFlight ?? env`, where `LETHAL_V3_SAMPLES_IN_FLIGHT` is `1` or `2` (default `2`). Any other value
     is refused by name at construction (`AlRunnerV3SamplesInFlightRefusedError`).
   - `concurrentSamples: false` and `LETHAL_V3_SEQUENTIAL_SAMPLES=1` keep their meaning: nothing in flight.
2. **Every result is applied in the order the samples started (FIFO).** That is the order the sequential fill applies
   them in. A promise still holds only `crossCheckSample`'s raw result (PR-119 §2.2).
3. **The two settle operations:**
   - `settleOldest(when)` applies the oldest entry.
   - `settleAll(when)` applies the entries one by one, oldest first, and stops at the first one that is not `ok`.
     - A `dropped` result returns `dropped`, and the fill returns. The younger entries are not applied; `finally` awaits
       them and acts on `threw` alone (PR-119 §4.9).
     - A `stop` result returns `stop`. The younger entries are not applied (§4.3).
4. **Starting a sample** (settle point 1):
   - the oldest entry is settled only while the queue is full (`inflight.length === K`);
   - otherwise nothing is settled;
   - then admission runs (§3). Admitted: the sample is appended. Refused: the queue is drained (`settleAll`), and the
     sample runs in place (`check`), as today.
5. **Every other settle point drains the whole queue (`settleAll`), as PR-119's single settle did:**
   - before the too-slow one-shot;
   - in the `got === undefined && isSample` branch, before its `replace`;
   - before the R1001 uniform stop;
   - before the two-unusable drop;
   - after the loop;
   - and in `send()` when the memory pre-check says no (§3).
6. **No one-shot runs in place beside a running one-shot.**
   - When `apply` reaches a backward replacement pick (`replace` with no forward pick, so `check` in place), it first
     waits for every younger entry's promise to finish. It does not apply them yet (`quiesce`).
   - Then it runs the pick in place and applies it, and only after that may the younger entries be applied, in their
     order.
   - This keeps the sequential order: the older sample, its backward pick, then the younger sample.
   - A forward pick only marks `pending`, as today, and starts nothing.

## 3. Memory
`E = memoryEstimate()`; `S_i` is the size of in-flight entry i, taken at its admission (PR-119 §3: the larger of `E` and the
daemon's RSS); `memoryHeld` already counts each in-flight entry's reservation at `E`.
- **Admission of a new sample of size S:** admitted only if
  `used + memoryHeld x E + sum over in-flight of max(0, S_i - E) + S + E <= bound`.
  - With an empty queue this is PR-119's formula.
  - The other rules are unchanged: no guard means admitted; an unreadable reading or RSS means not admitted; the last
    position is never admitted.
- **The pre-check before each daemon request in `send()`, while the queue is not empty:**
  - First await `memoryChain`, so every in-flight reservation is in `memoryHeld`.
  - Then require `used + memoryHeld x E + sum over in-flight of max(0, S_i - E) + E <= bound`.
  - If it says no, settle the oldest entry and read again, until the read says yes or the queue is empty. Then check
    `spent()` again (PR-119).
- **Each started sample must still queue its memory gate before its first await** (PR-119's
  `al-runner-v3-sample-gate-not-queued` check, unchanged).
- A sample's own gate runs while no daemon request is in flight: samples start between requests. So, as in PR-119, it can
  only close an idle daemon.
- Still no `watchMemory()` in this fill.

## 4. The invariants (each one gets a red test both ways, §7.4)
1. **I1, FIFO:** results are applied in start order. "The first drop wins" means the oldest one.
2. **I2:** at most `K` one-shots of this fill run at any time.
   - A backward replacement pick, the too-slow one-shot and an in-place `check` each run with no other one-shot of the fill
     running.
3. **I3, R955:** after a stop, no new one-shot starts.
   - A stop is a `stop` result, `spent()`, `signalled()` or `memoryStopped`.
   - A `skipped` result applied at or after a stop is `answers.delete` only (PR-119).
   - Entries younger than a `stop` result are awaited and not applied, because in the sequential fill they would not have
     started.
4. **I4:** nothing is served before the fill ends, and the fill does not end with an entry in flight (`finally` awaits all
   of them).
5. **I5:** each daemon request's pre-check counts every in-flight entry beyond its reservation.
6. **I6, errors:** a sample that threw throws its original error when it is applied (FIFO).
   - In `finally`, the oldest unapplied `threw` wins over the loop's error, with PR-119's
     `al-runner-v3-baseline-sample-error-order` warning.
7. **I7:** which samples run, how each is compared, R1001's `cleanCompared`, and R951's clean count are unchanged.

## 5. Stats
- `samplesOverlapped` and `samplesSequential` are as in PR-119, counted per entry.
- **New: `samplesPaired`,** the samples that started while another entry was in flight.
- The console line becomes
  `[lethal] al-runner-v3 baseline samples (PR-119): N overlapped, M sequential, P paired (in flight at most K).`

## 6. Not changed
The sample set (`baselineSampleIds`), `crossCheckSample`, the drop rules, batching, the per-test fill (sequential), the
too-slow rule, and what is served.

## 7. The proof (pre-committed on master before any proof run)
1. **The v3 gate, `itest:alrunner-v3`:** every leg passes, with every figure unchanged.
   - DBM keeps `concurrentSamples` true and asserts `samplesOverlapped >= 1`.
   - DBM cannot pair (2 samples, and the last is never admitted), so pairing is not exercised by the gate. That is stated,
     not hidden: the unit tests and P2 carry it.
2. **P2, DO 735fb42, (a) `LETHAL_V3_SAMPLES_IN_FLIGHT=1` against (b) the default 2,** one after the other in one heavy slot:
   - **the arm** (`--changed-since 735fb42^`), whole runs: 0 per-mutant differences in verdict or killingTest; the same
     sampled codeunits; the same warning codes;
   - **the whole project,** baseline only: the same sampled codeunits, the same warning codes, and the same per-test
     baseline results.
   - **The wall:** if (b)'s whole-project run has `samplesPaired >= 3`, its baseline phase is at least 40 s shorter than
     (a)'s, provided both legs' load averages at their start are within 50% of each other. Otherwise it is reported, not
     judged.
   - **Memory:** the whole-project leg's own al-runner children peak at most at the daemon's peak plus twice the largest
     one-shot peak plus 0.5 GiB; no memory stop.
3. **P3, BaseApp 28.6 × the 12 FA test codeunits (PR-119's P3 setup), (a) against (b), baseline only:** the same per-test
   baseline and the same mutant verdicts by join; no memory stop; peak under the guard's bound.
4. **Unit tests (call counters on stateful fakes, never wall-clock), each red when its rule is reverted:**
   - I1 FIFO: a younger entry that finishes first is applied second, and an older drop wins over a younger drop;
   - I2: a backward pick waits for a running younger entry; at most K processes at once; K = 1 behaves as PR-119;
   - I3: a `stop` from the oldest discards the younger result; a `skipped` younger result after a stop starts nothing;
   - I4: `finally` awaits every entry;
   - I5: the pre-check counts both entries, and settles the oldest until the read says yes;
   - I6: a younger entry's throw loses to an older entry's throw; the loop's throw loses to any entry's throw;
   - the queue-full settle: a third sample settles only the oldest;
   - the environment and seam values, and the refusal of a bad value.
