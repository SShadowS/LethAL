# PR-103 pre-commitment (reduced): where a serve request's retained memory comes from (R1100); the affine bound withdrawn

Coord PR-103 (lethal-code, 2026-11-17). Measured first: `/coord/handoff/PR-103/measure.md`.

## The withdrawn design, and why
- **The design.** The first draft of this spec proposed an affine, max-only bound on a request's memory (`J_c + s_c * n_c` per
  codeunit, D chosen by a backtest). A spec-adversary pass sank it. Its replay scripts are in
  `/coord/handoff/PR-103/adversary/`.
- **What the readings really measure.** In DO t12, a request's measured growth `g` (peak - floor) is mostly memory the daemon
  already held at the request's start:
  - the 391 requests with `g >= 0.9 GiB` had retained memory (start - floor) of p50 0.86 GiB;
  - those requests grew from their start by only p50 0.12 GiB;
  - growth from start is p50 0.121 and p99 0.143 GiB at any entry count.
- **The likely source.** Retained memory jumps 0.5-0.65 GiB between readings with no measured request between them. The
  likely source is the lazy warm-up proofs that `ensureDaemon` runs before `startRss` is read (`requestOne`).
- **Why the bound failed.**
  - A per-codeunit fixed jump misses that daemon state. The draft's own pre-committed backtest gave 7 underpredictions on t12
    and 4 on t13 at D=4, so the build stops by its own rule.
  - Pair slopes from mixed readings come out too low.
  - The memory guard (R948), PR-98's lane gate and the heavy slots are sized for the observed requests of at most 1.22 GiB,
    not for 4 GiB.

## What this PR does instead
1. **R1100 is corrected** with the diagnosis above.
2. **An events-only probe.** The `serve-request-sized` event gains:
   - **`lane`**: the lane index;
   - **`kind`**: `prefetch` or `live`, the request's kind;
   - **`daemonRequest`**: the daemon's request count at this request (`daemon.requests`, as R952 counts it);
   - **`fresh: true`**: present when `ensureDaemon` started a new daemon for this request;
   - **`proved`**: the number of codeunits `ensureDaemon` proved lazily for this request, present only when more than 0;
   - **`proveGrowth`**: the daemon's RSS just after those proofs minus its RSS just before them, in bytes. It is present only
     when `proved > 0` and both reads succeeded on the same pid.

   From these, a window's events show whether retained memory comes from the lazy proofs: `start - floor` against the
   accumulated `proveGrowth` per daemon. With lanes (t14 runs `--workers 3`), every reading is separated by lane.
3. **The follow-up is filed as its own roadmap item:** sizing on a request's growth from start PLUS the target daemon's current
   retained memory, with:
   - the R948 guard reserving the request's bound;
   - PR-98's lane gate charging the highest floor plus the bound;
   - the `daemonMaxRssGb` recycle check covering a recycled daemon's first request.

   Its proof needs a Contoso leg (R-972: per-entry cost is real there) and a lanes leg.

## Predictions (pre-committed)
- **Nothing changes but the events.**
  - Sizing, verdicts, warnings, the report and the explain schema are unchanged.
  - `costByCall` and `groupsThatFit` are untouched.
  - The extra RSS read happens only when a lazy proof runs, and it reads `/proc`, which is cheap.
- **`itest:alrunner-v3` passes unchanged, every pin.**
- **`schemas/stream-v1.schema.json` gains the six optional fields; no other schema moves.**
- **Unit tests, each red when its rule is reverted:**
  - a request after a lazy proof carries `proved` and `proveGrowth`;
  - a request without one carries neither;
  - `fresh` on a new daemon's first request;
  - `daemonRequest` counts as R952 does;
  - `lane` and `kind` are right on a prefetch and on a live request.
