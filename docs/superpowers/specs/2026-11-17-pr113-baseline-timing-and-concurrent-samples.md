# PR-113 pre-commitment (part 2): baseline timing events; concurrent R948 samples withdrawn to R1107

Coord PR-113 (lethal-code, 2026-11-17). Part 1 (report-diff `--by-line`/`--subset`) is built at 7051b64b.
- **The first ruling** (orchestrator, 2026-11-17): part 2 = (1) baseline timing events + (2) concurrent one-shot samples;
  baseline reuse dropped (R1106 records why).
- **What changed after the spec-adversary pass:** ship (1) only. (2) is filed as R1107, with the adversary's findings and an RSS
  probe as its gate. (1)'s data then decides between R1106 (batching) and R1107.

## What was measured (`/coord/handoff/PR-113/trace/split.md`)
The DO 735fb42 `--changed-since` arm's baseline phase took 142.7 s:
- the daemon's 74 per-codeunit requests: about 108 s (about 11 s of test time);
- R948's 9 sequential one-shot samples: 33.3 s;
- compile: about 1%.

About 95 s per baseline is per-request overhead no event shows.

## Change 1: baseline timing (events and TIMING only; no verdict path)
- **Baseline requests.** Each baseline serve request (`baselineRequest`, and the per-test baseline fill, only while
  `inBaseline`) emits `serve-request-timed` with `kind: "baseline"` and al-runner's `timings`, as PR-100 does.
  - The mutant-phase coverage and echo windows (`plain()` outside the baseline) are NOT labelled baseline (adversary L6). They
    keep no event, as today.
- **One-shot calls.** A new event, `baseline-one-shot-timed` `{ codeunit, wallMs, reason }`, is emitted for each baseline
  one-shot call. `reason` is `cross-check` (an R948 sample), `too-slow` (R790's re-run) or `other`.
- **TIMING:**
  - `baseline` joins the serve request kinds (timing-summary.ts's `KINDS`);
  - "al-runner inside them" is split per kind, so adding baseline timings does not change what the existing figure meant;
  - a new line, `baseline one-shots: <n> (<s> s; cross-check <n>, too-slow <n>, other <n>)`, appears when n > 0.
- **The schema.** `V3RequestTimed.kind` gains `baseline`, and `schemas/stream-v1.schema.json` is regenerated. Nothing else
  moves.

## Predictions (pre-committed)
- **No verdict, warning-set or report change.** `itest:alrunner-v3` passes unchanged: every leg and pin. No leg pins these events
  (DB/DBI pin `daemonBaselineReport()`).
- **A live check.** A re-run of the DO 735fb42 changed arm on the PR head prints:
  - the baseline request count (74 in the trace);
  - the one-shots (9, about 33 s);
  - a per-kind al-runner split that shows where the per-request time goes.

  That split feeds R1106 and R1107.
- **Unit tests, each red when its rule is reverted:**
  - a baseline request emits `kind: "baseline"`;
  - a mutant-phase coverage window does not;
  - `baseline-one-shot-timed` for a cross-check and a too-slow re-run;
  - the TIMING lines, including the per-kind split.
