# R-635 pre-commitment, addendum 2: re-run every leg on the new head

Committed by lethal-code on 2026-10-22, before any leg below runs. It amends `2026-10-22-r635-entries-precommitment.md`
(fcdf21ca) and addendum 1 (a8639bec). Everything not restated stands, including the binary (edge alpha.4, sha256
0642f9b2…8720), the commands, the comparisons, the STOP rules and addendum 1's move of `coverage.cobertura.xml`.

## Why
1. **E2 stopped on `al-runner-v3-entries-warmup-dirty`.** The edge build rewords the Commit refusal (#5607), so R612's
   allowlist, anchored on alpha.2's wording, did not keep the warm-up row. That is the fail-safe, working as designed.
   No verdict was scored.
2. **R612's probe was re-run on the edge build** (`/coord/handoff/R-635/edge-reasons.md`). After every kept reason the
   daemon answered the next request correctly and warm, with tables empty and SingleInstance at its default.
   - Only the Commit wording changed.
   - HttpClient is now a plain `fail`.
   - The cascade and no-callee rows are gone: a test that does not compile now stops the whole request (exit 3).
3. **`V3_SERVE_SAFE_REFUSALS`'s `commit` entry now also keeps the edge wording,** anchored at both ends (lethal/r635
   ec6a2680). This passed delta build review r2 (`/coord/reviews/R-635-build/review-r2.md`, APPROVE).
4. **Earlier legs:** E0-S and E1 PASSED on 7a8f63b3. E0-T showed an expected edge-binary difference. Because the code
   changed, every leg re-runs.

## The amendment
- **The code under test is lethal/r635 at ec6a2680.** The common environment's HEAD check names this sha.
- **ALL seven legs re-run in the original order:** E0-S, E1, E0-T, E2, E0-D, E3a, E3b. The earlier runs are kept as
  history, never as evidence for this head.
- **E0-T's expected edge-binary difference:**
  - The 7 mutants M0157–M0159 and M0161–M0164 are covered only by `Data Tests.DoubleInsertWithoutKeyTriggerRaises`.
  - Edge refuses that test as a deferred duplicate-key Insert, upstream #5623's intended rule. R641 (R-639, merged at
    711c94d9) reads it as the `refused` defect verdict, never a kill.
  - So these 7 mutants are expected as `error` in E0-T. That is pre-named here as an edge-binary difference, not a
    STOP. E2 is held to E0-T per mutant with 0 differences, these 7 included.
- **The other edge changes:**
  - HttpClient as a plain `fail`;
  - a non-compiling test stopping the whole request.
  These are named. Any per-mutant consequence shows in each control against its baseline, and is recorded with its
  cause.
- **The headline is unchanged:** E3a's and E3b's CDO wall time, against bcdev's 53–80 s, one-shot's 378 s and E0-D
  measured beside them, plus the measured `baselineMs` and `secondEchoMismatches`.
