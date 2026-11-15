# PR-18 L1 pre-commitment: keep the serve daemon after DO's ZipArchive.Dispose and FormatRegion refusals

Lane lethal-bugs, coord PR-18 (lever 1 of the DO speed plan), 2026-11-15. Committed before the DO window that measures it
together with lethal-code's L4 (PR-20, `docs/superpowers/specs/2026-11-15-pr20-l4-entry-cut.md`). Split agreed with code
(keep-list owner): lethal-bugs builds L1, code reviews.

## Why

R-984's DO window t3 (`/coord/handoff/R-984/result.md`) spent 4,593 s of 12,600 on 46 daemon restarts. A restart costs a
compile (27-42 s, measured by PR-18's traced run, `/coord/handoff/PR-18/trace.ndjson`) plus a warm-up that runs the whole
suite unmutated (111 entries, 1,973 tests, 37-69 s): about 100 s. 33 of the 46 came from two refusal families:
- 24: `DotNet System.IO.Compression.ZipArchive.Dispose: a .NET write over the bytes an AL OutStream held before the call
  (what the Blob then holds is not pinned)`;
- 9: `Format of a value (standard format 4) while CurrReport.FormatRegion is 'en-GB' is not pinned (docs/probes-needed.md)`.

## The change (branch lethal/pr-18, head d12165a4)

`V3_SERVE_SAFE_REFUSALS` gains `zip-dispose-over-held-bytes` and `format-region-std4`, each exactly the measured text (en-GB and
standard format 4 only). Leg C's `serve-keep-reasons` gains a FormatRegion case (report 50686, codeunit 50687); the zip family
needs the .NET helper, which leg C's daemon runs without, so it is kept but not judged there (as R945's .NET families).

Basis: R-967's kit on edge-847b1fa5a and edge-5a58a0f16, isolation "test" and "codeunit" (`/coord/handoff/PR-18/probe/README.md`,
invented AL): per family and build, 72 kept-daemon reader answers and 40 fresh-daemon answers all equal to the control, the pid
unchanged, no panic text. Not measured (named in the code): the .NET helper's own state across requests on a kept daemon; the
per-mutant comparison below is where a leak there would show.

## Predictions for the combined DO window (L1 + L4, resumed from dos3.sqlite, budget 12,600 s, edge-847b1fa5a)

1. **Verdicts:** every mutant scored in this window and also in t1, t2b or t3 has the same verdict and killing test (0 differ).
   Any difference is a BLOCK (shared with L4's prediction 1).
2. **Closes:** 0 daemon closes by either family (t3: 33).
3. **Restarts:** at most 15 warm-ups in the window (t3: 46), and warm-up wall time at most 1,500 s (t3: 4,593 s). Scaled if the
   window reaches more or fewer mutants than t3: at most 15 per 337 scored covered mutants.
4. `itest:alrunner-v3` on the merged head passes every leg; `serve-keep-reasons` judges `format-region-std4: refusal`. (Its
   overall reading stays `diverged` on edge-5a58a0f16 because of R998's cases, R1026, unless that is fixed first.)
