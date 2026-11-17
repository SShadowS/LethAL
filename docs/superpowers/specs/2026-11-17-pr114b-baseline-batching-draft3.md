# PR-114 pre-commitment: batch the v3 daemon baseline's per-codeunit requests (R1106)

Coord PR-114 (lethal-code, 2026-11-17). Draft 3 includes:
- spec-adversary r1, which sank draft 1 with the OnRun carry door;
- the delta review of draft 2 (H1 a duplicate row crashes the session; H2 v3's SingleInstance lane; M3; M4; the lows);
- the orchestrator's conditions for (b);
- every probe below, all under `/coord/handoff/PR-114/` on edge-4ebfe7913.

## What is measured
- **`baselineMs` is per request.** v3 sets up the install baseline once per request (`corpus.rs` `baseline_run`). DO paid
  0.3-0.6 s per 1-entry baseline request, and about the same per 32-160-entry prefetch request.
- **A batch must be a plain request.** Entries refuse coverage. A plain request with no `test` and the complement in
  `excludeTests` runs exactly the batch (`probe2.ts`).
- **The OnRun carry door (`carry-probe.ts`).** In one request, a test codeunit's OnRun writes reach LATER codeunits (`Unit::carry`,
  ADR-070). Each later codeunit runs twice and streams a second row. With the OnRun codeunit sent alone, the batched others equal
  their single answers (`carry-gate1.txt`).
- **No other state path carries (`carry2-probe.ts`).** SingleInstance state, a SingleInstance temp table, a library global, a
  real row and a bound manual subscriber, written by a codeunit with no OnRun, did not reach a later codeunit in one request. The
  positive control fails its readers within one codeunit under `testIsolation: "codeunit"`.
- **v3's SingleInstance lane** (`lane/result.md`; `single_lane.rs`, ADR-066 amendments 4-5).
  - **The analysis:** in a request with 2+ test codeunits, v3 watches SingleInstance globals.
  - **The re-run:** v3 re-runs a dependent codeunit (one with a failed test that read a changed global first) ONLY when
    `strictOrder: true` (`bc_order`, single_lane.rs 811-816; serve.rs 376). Without it, v3 only adds `orderHints` to the
    summary.
  - **No green re-run.** Serve cannot re-run a green codeunit: `replay_every_dependent` is not settable.
  - **Proved by probe** (`lane/lane2-probe.ts`):
    - our body gives no re-run, `flagged` 0, and one `orderHints` entry;
    - the same body with `strictOrder: true` re-runs the reader (4 rows: the second reader row passes; `flagged` 1).
  - **The marker.** A re-run streams a second row with the same name; no row carries a lane marker.
- **DO at B = 8** (`mem/result.md`; 112 test codeunits, 3 with OnRun sent singly, fresh daemons, 2 runs):
  - setup plus install baseline: 96.8 -> 12.0 s, and 69.8 -> 15.2 s;
  - the requests' wall: 237.9 -> 57.2 s, and 170.6 -> 65.4 s;
  - the daemon peak: +103 to +129 MiB;
  - rows: equal per codeunit, name, status and order, over 1,979 rows, with no duplicates;
  - per-test coverage: equal for 1,978 of 1,979 tests. The one extra line is run-to-run noise: it flips when the codeunit runs
    alone too (`mem/line514.ndjson`).

## The change (`fillDaemonBaseline`)
- **The batch body.** Batches of up to B = 8 codeunits. A batch is one plain request with:
  - `sourcePaths`;
  - `testIsolation: "test"`;
  - `coverage` and `perTestCoverage`;
  - `excludeTests`: EVERY test codeunit LethAL's parse finds in the request's `sourcePaths` outside the batch, as
    `Codeunit<id>.`.

  It carries none of `test`, `runSelectedOnly`, `strictOrder`, `testSuites`, `testRunner` or `testDriver`; a unit test pins the
  exact field set. `strictOrder` is the lane's switch.
- **Never batched:**
  - a test codeunit with an `OnRun` trigger in any `#if` arm of the deployed test tree (OnRun carry sources; DO has 3 of 112);
  - the per-test fill (R866), R937's one-shot codeunits, the R1033 re-check and the mutant phase.
- **A batch has its own decode, in this order** (delta H1). Any check that fails discards the whole answer, closes the daemon
  (R612's rule) and re-sends EACH codeunit of the batch alone, today's request:
  1. every row's codeunit is in the batch (high 2 of r1);
  2. no test name appears twice. The scan runs BEFORE `serveDaemonReusable`, so `AlRunnerServeDuplicateRowError` is never
     reached; a duplicate is the OnRun carry and lane re-run signature;
  3. every row is one R612 keeps (delta M3: a dirty daemon's batch is not kept for the other codeunits);
  4. each codeunit has exactly its suite tests' rows (`hasEveryRow`).
- **Failure.** A batch request that fails (daemon error, transport, a timeout cut) re-sends its unanswered codeunits singly. The
  first discard in a session turns batching off for the rest of it, so repeated discards never repeat daemon closes. "Two
  requests in a row without a usable answer" counts single requests only.
- **Coverage (M4).**
  - Each codeunit's stored top-level coverage is the union of its own tests' per-test coverage, never the batch's document.
  - The R948 cross-check compares a batched sample's rows and per-test sets; the whole call only for a batch of 1.
  - Batching is enabled only on builds whose pin retires the §6 Sleep rule, read through ONE accessor (the field the verdict
    path reads).
- **Durations.**
  - Rows keep their `durationMs`; where a row has none, the batch's whole wall time stands.
  - `BaselineAnswer` carries the batch's one `callId`.
  - The request deadline is the sum of `v3CallDeadlineMs` over the batch's tests.
- **Ignored, recorded:** `orderHints` in a batch's summary is ignored. It is advisory, and a codeunit's verdict comes from its
  own entry in the mutant phase, which starts fresh, as today. Its count is noted in the stats line.
- **Events.** PR-113's baseline `serve-request-timed` gets the batch's real `entries` and `tests`.
- **`flagged`.** A batched row's `flagged` is ignored, the same as for a single row.

## Pins, gates and a contract leg
- **A new contract fact in leg C** of the v3 gate and update gate (condition 3), from `lane/lane2-probe.ts`'s invented app:
  - our body: no re-run, `flagged` 0, `orderHints` 1;
  - with `strictOrder: true`: a second reader row.

  A build that re-runs under our body, or stops re-running under `strictOrder`, fails the gate.
- **Expected pin moves**, stated by the observe run in an addendum before acceptance:
  - DB's `requests === codeunits` (DBI is unaffected: under `isolateTests` the fill skips every codeunit);
  - the R948 unit-test fakes that answer by `body.test`;
  - TIMING's baseline request count.

## Predictions (pre-committed)
- **0 verdict moves.** `itest:alrunner-v3` passes with every verdict unchanged.
- **The DO live check.** DO's 735fb42 changed arm (PR-113's `live/arm.sh`) on the PR head must show:
  - baseline requests fall from 75 to about (75 - 3)/8 + 3, plus fallbacks;
  - the baseline phase falls by at least 40 s of its 152.4 s;
  - `scripts/report-diff.ts --by-line --subset` against PR-113's live run: 0 differences.
- **A DO window baseline falls proportionally;** measured on the next window.
- **Unit tests, each red when its rule is reverted:**
  - the batch body's exact field set;
  - OnRun codeunits go alone;
  - an out-of-batch row discards;
  - a duplicate row discards, never throws, closes the daemon and re-sends singly;
  - an R612-unkept row discards;
  - a missing row re-sends;
  - a failed batch re-sends;
  - the first discard turns batching off;
  - the per-codeunit coverage union;
  - the sample comparison;
  - the §6 gate;
  - durations and `callId`;
  - the exclusion pattern (`Codeunit1.` vs `Codeunit11`);
  - the new leg C fact.
