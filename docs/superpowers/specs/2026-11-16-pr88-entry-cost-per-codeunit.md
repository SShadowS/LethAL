# PR-88 pre-commitment: read the serve daemon's TRUE peak per request (R987's sensor); per-codeunit cap lines and a request event (R1058, part 1)

Coord PR-88 (2026-11-16). Scope set by the orchestrator after two spec-adversary passes on wider drafts (option A).

## Why this, and not a new estimator
R987 (al-runner-v3-backend.ts `noteEntryCost`, `costByCall`) charges each request's average growth per test entry to every
call in it. Each call keeps its highest value; costs never fall. Two adversary passes showed that every rule which LOWERS a
cost from a reading can run the container out of memory:
- entries of one codeunit differ in cost per mutant (a mutant killed early holds less than a survivor);
- a per-call count limit bounds entries, not bytes;
- readings clean enough to lower from (no L4 cut, no R998 left-out names) may be rare.

So R987's "never falls" stays: it is what makes the estimate safe. R1058's order dependence comes from that same rule, and stays
open. The follow-up is R1091: per-codeunit calibration requests, with a probe first.

## What is measurably wrong today: the sensor
`readProcessRssBytes` (al-runner-v3-baseline-check.ts) reads `VmRSS`, the CURRENT resident size. The request loop samples it
every 200 ms (`RSS_SAMPLE_MS`) plus once after the answer. A peak between two samples is missed, so G (peak minus floor) reads
low, the cost reads low, and later requests of that call are packed bigger than is safe.

**Measured** (`/coord/handoff/PR-88/hwm-probe.ts`, this container, three runs): a child allocated about 300 MB in under 200 ms
and freed it.
- The 200 ms sampler read 91, 95 and 165 MB.
- `VmHWM` read after resetting it with `/proc/<pid>/clear_refs` (value `5`) read 316-317 MB.
- The reset works on our own child.

## The change
1. **True peak per request.**
   - Right before a request is sent to a daemon, its high-water mark is reset: write `5` to `/proc/<pid>/clear_refs`.
   - Right after the reset, `VmHWM` is read. The reset counts as VERIFIED only if `VmHWM` is then within 64 MiB of `VmRSS`.
   - After the answer, the request's peak is `max(VmHWM, the sampled peak)`. The existing sampler stays, as a floor under the
     reading.
   - **When the reset is not verified** (the write fails, `VmHWM` is missing or unreadable, or it is not near `VmRSS`), the
     reading uses the sampled peak alone, exactly as today. A warning, `al-runner-v3-peak-unverified`, is printed once per
     session.
   - **A daemon whose process exited before the read** (a cut answer, R895) gives no reading. Today it gives one, so this
     only removes readings; it never lowers a cost.
2. **The estimator is unchanged:** same division, same "keep the highest", never falls. The only difference is the sensor.
   Readings can only be equal or higher than today's, so costs are equal or higher, and requests are equal or smaller.
3. **Reporting.**
   - The once-per-session `al-runner-v3-entries-cap-lowered` warning becomes one line per call whose cap falls below 256,
     printed once per call: "requests carrying codeunit <id> hold about N test entries (its highest measured cost: X MiB per
     entry, from a <hwm|sampled> peak)".
   - A new debug event `serve-request-sized` goes in the events stream only, not the report. It carries:
     - the request's test entries per call;
     - floor, start, sampled peak, `VmHWM` (when verified) and G;
     - the peak source (`hwm` or `sampled`);
     - each call's cost after the reading.
4. **Assumption, stated:** the peak is the al-runner process's own. A child process it spawns (for example the .NET sidecar)
   is outside both today's reading and the new one.

## Effects
- **Verdicts:** unchanged by design. Packing changes no verdict class: PR-51 handles timeouts, batch refusal is judged at 256
  regardless of readings, kill pairs are never split, and PR-56's drift guard re-runs on a fresh daemon. The killing test may
  differ (R197). Under `--time-budget` or R948's memory gate, which mutants are scored before the stop can differ. That is
  safe-direction and stated.
- **Packing:** requests are equal or smaller wherever the sampler under-read. That is more requests in total: a cost, and the
  point.

## Predictions (pre-committed)
- **`itest:alrunner-v3`:** every per-mutant verdict and killing test unchanged. Its serve pins (`boundChecks`,
  `prefetchRequests`, `pairBatchRequests`, `entriesSent` in `N1S_PINS` and the other `*_PINS`) MAY move, because the readings
  are higher. **Procedure, as R987 did:**
  1. After the build, run the gate once in OBSERVE mode: the pins compared but not enforced, printed per leg.
  2. Record the moved pins, with the leg and the reading that moved each, in an addendum to this spec. That addendum is
     committed BEFORE the gate is run for real.
  3. Run the gate against the addendum's figures.
  A verdict or killing-test change in the observe run is a BLOCK, not a figure to record.
- **DO, next window (lethal-bugs):** its stderr shows `serve-request-sized` events with peak source `hwm`. A window where
  every event is `sampled` means the reset failed there, which is reported, not assumed. The per-codeunit cap lines name
  codeunits; CDOeDocPrePostValid is expected among them. No DO verdict expectation changes.
- **Unit tests** (each red when its rule is reverted):
  - the reset before send and the read after;
  - the verification (an unreset `VmHWM` far from `VmRSS` falls back);
  - `max(HWM, sampled)`;
  - an exited daemon gives no reading;
  - the warning once;
  - the per-call cap lines;
  - the event's fields;
  - the estimator unchanged: today's tests pass as they are.
  A fake `/proc` reader is injected (tests never read `/proc`, as today: `rssReader`).
