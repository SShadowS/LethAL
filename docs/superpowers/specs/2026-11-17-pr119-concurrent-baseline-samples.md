# PR-119 (R1107): run the daemon fill's cross-check samples beside the daemon

Status: r1 (coord PR-119, lethal-preproc, 2026-11-17). For the spec-adversary before any build. The pre-commitment of the
proof runs (§7) is committed to master, with this spec's final text, before any proof run.

## 1. Why
- `fillDaemonBaseline` (al-runner-v3-backend.ts) answers every suite codeunit through one serve daemon. R948 cross-checks
  a sample of them (`baselineSampleIds`: index 1, the last, every 10th) against a fresh one-shot process, test by test.
- Each sample runs while the daemon idles: `check()` is awaited in the loop.
- PR-118 measured this on DO's 735fb42 arm, on master with PR-115's batched baseline:
  - the baseline took 67.0 s;
  - the 9 samples took 35.2 s (53%);
  - the daemon's own work was about 32 s.
- Overlapping a sample with the daemon's next requests could save up to about 30 s of 67 s. Batching made the samples the
  larger part (R1107, `/coord/handoff/PR-118/result.md`).

## 2. The change
At most ONE cross-check sample is in flight beside the loop. A sample that is not admitted (§3) runs sequentially, as
today.
1. **Start.** When the loop reaches a sample (`isSample`) and the daemon's answer `got` is in hand, it starts
   `check(id, got, pos)` as an in-flight promise. It does not await it, if both hold:
   - (a) no sample is already in flight, else it first settles that one (§4);
   - (b) the admission check (§3) says yes.

   Otherwise it awaits the sample in place, as today.
2. **Never rejects.** The in-flight promise is wrapped so that it resolves `{ step: "ok" | "stop" | "dropped" | "threw",
   error? }`. A throw inside `check` is caught and carried as `threw`, with the original error object.
3. **Settled at every boundary (§4).** The loop goes on with the next codeunit's daemon request while the sample's one-shot
   runs.
4. **Unchanged:**
   - the too-slow one-shot (R790);
   - the per-test fill (`fillPerTestBaseline`: its own samples stay sequential, out of scope);
   - every comparison rule;
   - the replacement rule (R951), with §5's fix;
   - the drop rules;
   - what is served (nothing before the fill ends).
5. **The switch.** An internal seam `concurrentSamples` (default `true`), and the environment variable
   `LETHAL_V3_SEQUENTIAL_SAMPLES=1`, which sets it `false` for the proof runs. No config key.

## 3. Memory (R1107 fix 2)
`memoryGate(true)` counts every held reservation at `memoryEstimate()` (3 GiB). Over the bound it closes the baseline
daemons and polls, then stops the session. So a daemon request whose gate counts an in-flight sample's reservation could
close the fill's own daemon, or stop the run, where the sequential fill would not.
- **Admission, before a sample starts in flight:** a side-effect-free, single read of the guard
  (`memoryGuard.read()`, no wait, no close, no reservation). It admits only if
  `usedBytes + (memoryHeld + 2) x memoryEstimate() <= boundBytes`: the sample's one-shot plus the next daemon request.
  - No guard (off, or no limit): admitted.
  - An unreadable reading: NOT admitted (sequential).
- **While a sample is in flight, before each daemon request's own `memoryGate(true)`:** the same side-effect-free check,
  with `memoryHeld` (which already holds the sample's reservation) + 1. If it says no, the loop first settles the
  in-flight sample (§4), then calls `memoryGate(true)` as today. So a daemon request's gate never sees an in-flight
  sample's reservation unless the check admitted both.
- **`watchMemory()`** (R970) runs for the whole fill while any sample is in flight. It is started at the first in-flight
  sample and stopped when the fill ends. A watch stop makes the in-flight sample end at its stop and the loop's next gate
  answer no, as in the per-test baseline.
- **Durations** (R1107 fix 4): a sample's kept durations come from its one-shot, which now runs under contention, so they
  can only be longer. That only lengthens budgets (`max(2 x duration, floor)`), the safe direction. R790's too-slow
  re-run settles the in-flight sample before it starts, so at most one one-shot runs at a time.

## 4. Outcome precedence (R1107 fix 1)
**Settling** = awaiting the in-flight promise, clearing it, and applying its result:
- `ok`: nothing more;
- `dropped`: the fill returns at once (the drop was already recorded by `check`; no later loop event may record
  another);
- `stop`: `stopped = true`, and the loop breaks;
- `threw`: rethrow the original error object.

The in-flight sample is settled at each of these points, and its non-ok result wins over the loop's own event there:
1. before a sample is started while one is in flight;
2. before the too-slow one-shot;
3. before a daemon request whose memory check says no (§3);
4. **before the R1001 uniform stop** (`uniformWatch.observe` returned a value):
   - settle;
   - if the sample's result is `dropped` or `stop`, that wins (the fill does not throw the uniform error);
   - else the uniform condition is re-read with the CLEAN count below.
5. **before the "two serve requests in a row gave no usable answer" drop:** settle; a sample's drop wins.
6. before each `break` from the loop (a `send` that answered `stop`);
7. after the loop, before R951's clean-sample count;
8. in `finally`, before `closeLane(lane, "baseline-end")`. A throw already in flight wins: the sample's own throw is then
   dropped, but never outlives the fill.

- **R1001 counts clean compares, not attempts.** `crossCheckSample` increments `baselineStats.compared` before it compares.
  A new counter `cleanCompared` is incremented only when a sample returns `compared` with no difference, and the uniform
  condition reads `cleanCompared - cleanBefore >= 1`.
  - `compared` keeps its meaning: it feeds `daemonBaselineReport().compared`, which gates pin.
  - R951's "enough clean samples" count stays as today (`compared - comparedBefore`, read after every sample settled).
- **R951's clean-sample count after the loop** is read only after the last in-flight sample settled.

## 5. R951's replacement (R1107 fix 3)
A sample that settles as `skipped` calls `replace(skipped, pos)`.
- With an in-flight sample, `pos` must be the loop's position when it settles, not the sample's start position. Codeunits
  the loop passed meanwhile were answered by the daemon and kept or served as non-samples, so they cannot become forward
  picks.
- `check()` receives a function that reads the loop's current position at settle time.
- A forward pick still goes into `pending` and is compared when the loop reaches it. A backward pick (the last codeunit)
  is compared at settle time, sequentially.

## 6. No lane gate (R1107 fix 5)
No lane daemon lives during a fill: `deploy` closes them, and lanes start after the baseline. The lane gate is not charged.
Stated, with no code.

## 7. The proof (pre-committed on master before any proof run)
1. **The v3 gate:** every leg passes unchanged. DB/DBI pin `daemonBaselineReport()`: requests, sampled, compared, served,
   skipped and replacements must be equal, and they are, since the same samples run with the same results.
2. **DO's 735fb42 arm** (PR-118's setup), on the PR head, one after the other in one heavy slot:
   - (a) `LETHAL_V3_SEQUENTIAL_SAMPLES=1`;
   - (b) concurrent.

   Predictions:
   - per-mutant verdict and killingTest identical between (a) and (b);
   - `daemonBaselineReport()` equal, except durations;
   - the baseline wall of (b) at most (a)'s minus 20 s (PR-118: 67 s, of which 35 s were samples);
   - the RSS time series (PR-118's sampler) shows the fill's peak at most daemon + one one-shot (~3.3 GiB on DO), and no
     memory stop.
3. **A larger corpus (the R1107 gate):** an RSS time series of the fill on a BaseApp-size corpus, sequential and
   concurrent. Which corpus is named in the pre-commitment from the corpus-build cache. Predictions:
   - the admission check either admits (and the peak stays under the bound) or falls back to sequential (named in the
     events/stats);
   - no memory stop in either leg;
   - per-mutant identical over the run's scope.
4. **Unit tests, each red when its rule is reverted:**
   - a sample in flight overlaps the next daemon request (call counters on stateful fakes, never wall-clock);
   - a sample's `dropped` wins over a later uniform stop, over the two-unusable drop, and at the end;
   - a sample's throw is rethrown as the original object;
   - the clean counter: a differing compare does not unlock R1001;
   - `replace` picks after the settle position;
   - admission no means sequential; an unreadable reading means sequential;
   - a daemon request whose check says no settles the sample before its gate;
   - the too-slow one-shot settles first;
   - `finally` settles;
   - the seam off means today's order exactly.

## 8. Stats and events
- `baselineStats` gains `samplesOverlapped` and `samplesSequential` (admission said no, or the seam is off).
- They are printed in the baseline batching line's neighbour, the existing `[lethal] al-runner-v3 baseline ...` stats line.
- PR-113's `baseline-one-shot-timed` events are unchanged; a sample's `wallMs` now overlaps daemon time.
