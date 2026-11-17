# PR-119 (R1107): run the daemon fill's cross-check samples beside the daemon

Status: r2 (coord PR-119, lethal-preproc, 2026-11-17). r2 answers the spec-adversary review of r1 (§0). The pre-commitment of
the proof runs (§7) is committed to master, with this spec's final text, before any proof run.

## 0. Review of r1 (opus spec-adversary), finding by finding
- **1, 2 (medium): the in-flight promise applied its side effects when it finished, not when it was settled.**
  - That broke two claims: "one one-shot at a time" (a backward replacement pick ran a second, unadmitted one-shot beside a
    live daemon request, whose gate could close that daemon), and "the first drop wins".
  - **Fixed at the root.** The in-flight promise is `crossCheckSample`'s raw result, and nothing more. The loop applies it at
    the settle point: drop, keep, replace with the loop's real position. So a backward pick is sequential by construction.
  - The missing settle point (the `got === undefined && isSample` branch) is added (§4).
- **3 (medium): a watch would stop the session 15 s into an over-bound reading, where the sequential fill closes its daemon and
  waits.** Dropped. The fill runs no `watchMemory()`. The per-request pre-check (§3) is the guard, and an over-bound gate keeps
  today's close-then-wait. The r1 claims about the watch are gone.
- **4 (low-medium): the v3 gate hardly exercises the change.** Only DBM can overlap (once), and nothing asserted it. DBM gets a
  fixed memory reader and asserts `samplesOverlapped >= 1` (§7.1). The r1 text about DB/DBI pinning skips and replacements was
  wrong: `judgeDaemonBaseline` reads them as notes.
- **5, 6 (low): the proof's predictions** would false-block on allowed differences (replacements, skip order, too-slow moves),
  and the wall bar was tight and memory-dependent. Rewritten (§7.2): equality only where it must hold, a listed set of allowed
  differences, and the wall bar conditional on the overlap count, with `memory.current` at the fill's start recorded.
- **7 (low): `finally` preferred a loop throw over the sample's own throw.** Now the sample's error wins, as it would come first
  in sequential order, and the loop's error is named in a warning.
- **8 (low, noted): a stop while the first sample is in flight** keeps more unvouched answers than the sequential fill. No
  verdict rests on them: a stop in the baseline scores no mutant, and R1008 re-runs the baseline on resume. Left as is, stated.

## 1. Why
- `fillDaemonBaseline` (al-runner-v3-backend.ts) answers every suite codeunit through one serve daemon. R948 cross-checks a
  sample of them (`baselineSampleIds`: index 1, the last, and every 10th) against a fresh one-shot process, test by test.
- Each sample runs while the daemon idles, because `check()` is awaited in the loop.
- On DO's 735fb42 arm, on master with PR-115's batched baseline (PR-118), the baseline took 67.0 s. Of that, the 9 samples
  took 35.2 s (53%), and the daemon's own work about 32 s (R1107, `/coord/handoff/PR-118/result.md`).

## 2. The change
At most ONE cross-check sample is in flight beside the loop.
1. **Start.** When the loop reaches a sample and the daemon's answer `got` is in hand, it settles any in-flight sample (§4).
   Then:
   - if the seam is on and admission (§3) says yes, it starts `crossCheckSample(...)` as the in-flight sample and moves on to
     the next codeunit;
   - otherwise it runs `check()` in place, as today.
2. **The in-flight promise is free of side effects** beyond `crossCheckSample`'s own: on a skip, it adds to `uncleanCalls` and
   calls `noteSkip`, and it increments `compared` before comparing.
   - `uncleanCalls` is read only at a fill's start and when serving, which happens after the fill. `noteSkip` and `compared`
     are stats.
   - It resolves to `{ raw: <crossCheckSample's result> }` or `{ threw: <the original error object> }`, and never rejects.
3. **Applied at the settle point (§4), in the order `check()` applies it today:**
   - `dropped`: `dropDaemonBaseline(why, detail, shots)`, then the fill returns;
   - `compared`: `answers.set` / `shots.set`, and `cleanCompared += 1`;
   - `skipped`: `answers.delete(id)`, then `replace(skipped, <the loop's position at the settle>)`. A backward pick is
     compared there, sequentially.
   - `stop`: `stopped = true`, and the loop breaks;
   - `threw`: rethrow the original error object.
4. **Unchanged:**
   - the too-slow one-shot (R790);
   - the per-test fill, whose samples stay sequential;
   - every comparison and drop rule;
   - what is served: nothing before the fill ends.
5. **The switch:** an internal seam `concurrentSamples`, `true` by default. `LETHAL_V3_SEQUENTIAL_SAMPLES=1` sets it `false`,
   for the proof runs. No config key.

## 3. Memory
`memoryGate(true)` counts every held reservation at `memoryEstimate()` (3 GiB). Over the bound, it closes the baseline daemons
and polls, then stops.
- **Admission, before a sample starts in flight:** one side-effect-free read of the guard (`memoryGuard.read()`; no wait, no
  close, no reservation). It admits only if `usedBytes + (memoryHeld + 2) x memoryEstimate() <= boundBytes`, which covers the
  sample's one-shot plus the next daemon request.
  - No guard (off, or no limit): admitted.
  - An unreadable reading: not admitted (sequential).
- **Before each daemon request's own `memoryGate(true)` while a sample is in flight:** the same read, with `memoryHeld + 1`.
  If it says no, the loop settles the in-flight sample (§4) first.
  - So a daemon request's gate counts an in-flight reservation only when the read admitted both.
  - The sample's own one-shot gate runs on `memoryChain` before the next daemon gate, so it can only close an idle daemon
    (review: checked and holding).
- **No `watchMemory()` in this fill** (review #3).
- **Durations:** a sample's kept durations come from its one-shot, and the daemon's come from requests that may run beside
  one. Under contention both can only be longer. That lengthens budgets (`max(2 x duration, floor)`) or adds R790 too-slow
  re-runs, the safe direction. The too-slow one-shot settles any in-flight sample first, so at most one one-shot runs at a
  time.

## 4. The settle points
The in-flight sample is settled, and its result applied per §2.3, at each of these points. A non-ok result ends the step there:
1. before a sample is started or run in place;
2. before the too-slow one-shot;
3. before a daemon request whose memory read says no (§3);
4. in the `got === undefined && isSample` branch, before its `replace` (review #2);
5. before the R1001 uniform stop:
   - settle;
   - a `dropped` or `stop` result wins (no uniform throw);
   - otherwise re-read the uniform condition with `cleanCompared - cleanBefore >= 1`.
6. before the "two serve requests in a row gave no usable answer" drop;
7. before each `break` from the loop;
8. after the loop, before R951's clean-sample count;
9. **in `finally`, before `closeLane`:**
   - if the loop is throwing and the sample `threw` too, the sample's error is thrown, and the loop's error is named in a
     warning (`al-runner-v3-baseline-sample-error-order`);
   - if the loop is throwing and the sample did not throw, the loop's error stands;
   - the sample never outlives the fill.

**R1001 counts clean compares.** `cleanCompared` is incremented only when a settled sample was `compared` with no difference.
It is equivalent to `compared` in the sequential path, since a differing compare always drops. `compared` keeps feeding
`daemonBaselineReport()`.

## 5. No lane gate
No lane daemon lives during a fill: `deploy` closes them, and lanes start after the baseline.

## 6. Stats
- `baselineStats` gains:
  - `samplesOverlapped`: started in flight;
  - `samplesSequential`: run in place, because admission said no, the seam was off, or it was a backward pick;
  - `sampleMemoryAtStart`: `memory.current` read at the fill's start, or none.
- The counters are printed in the existing `[lethal] al-runner-v3 baseline batching (PR-115): ...` line's neighbour,
  `... baseline samples (PR-119): N overlapped, M sequential`.

## 7. The proof (pre-committed on master before any proof run)
1. **The v3 gate:** every leg passes unchanged.
   - DBM, the only leg with more than one sample over more than one request, gets a fixed `memoryReader` seam (as DBI has) and
     asserts `samplesOverlapped >= 1`.
   - DB and DBI cannot overlap: DB has 1 codeunit, and DBI's codeunits are all per-test.
2. **DO's 735fb42 arm** (PR-118's setup), on the PR head, one after the other in one heavy slot:
   - (a) `LETHAL_V3_SEQUENTIAL_SAMPLES=1`;
   - (b) concurrent.

   **Equal:**
   - every per-mutant verdict and `killingTest`;
   - `daemonBaselineReport()`'s `requests`, `sampledCodeunits`, `compared` and `dropped`.

   **Allowed to differ:**
   - `replacements` (a skipped sample's forward pick is taken after the settle position);
   - the order of `skippedError` / `sampledSkipped`;
   - `skippedTooSlow` and `served`: only more re-runs, from longer durations.

   **The wall:** if (b) has `samplesOverlapped >= 6` (9 samples; the last never overlaps), its baseline wall is at most
   (a)'s minus 15 s. With fewer, the wall is reported, not judged, with `sampleMemoryAtStart` and the admission refusals.

   **Memory:**
   - PR-118's sampler: the fill's peak at most daemon + one one-shot + 0.5 GiB;
   - no memory stop.
3. **A larger corpus (R1107's gate):** an RSS time series of the fill on a BaseApp-size corpus, sequential and concurrent.
   - The corpus is named in the pre-commitment, from `scripts/corpus-build-cache.ts list`.
   - Predictions:
     - no memory stop in either leg;
     - either admission admits and the peak stays under the bound, or it refuses and the stats say "sequential";
     - per-mutant identical over the run's scope.
4. **Unit tests, each red when its rule is reverted (call counters on stateful fakes, never wall-clock):**
   - a sample in flight overlaps the next daemon request;
   - the result is applied only at settle;
   - a `dropped` wins over a later uniform stop, over the two-unusable drop, and at the loop's end;
   - the sample's throw beats a loop throw in `finally`;
   - a differing compare does not unlock R1001;
   - `replace` picks after the settle position, and a backward pick runs after the in-flight sample settled, never beside it;
   - the `got === undefined && isSample` branch settles first;
   - admission no means sequential; an unreadable reading means sequential;
   - a daemon request whose read says no settles the sample before its gate;
   - the too-slow one-shot settles first;
   - the seam off means today's call order exactly.
