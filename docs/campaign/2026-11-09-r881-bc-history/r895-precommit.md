# R-895 pre-commitment: stop a hanging mutant's serve call at its first timed-out test (R897), design B1

Committed before any build or comparison run, 2026-11-09. Coord task R-895. Plan: `/coord/handoff/R-895/plan.md`, revised by its opus
review to design B1. Measurements: `/coord/handoff/R-895/measurements.md`. The orchestrator chose B1 with the conditions below.

## The change (serve-entries transport only; one-shot unchanged)

1. When a streamed `test` line is a timeout row (`Test exceeded Ns timeout.`, notRun), the client stops reading and kills the daemon.
   A daemon is closed after a timeout row today anyway (R612). The sidecar dies with it (measured).
2. The stopped entry stands with the rows it has; later entries are re-sent on a fresh daemon, as today's R612 cut does.
3. A test of the stopped mutant's codeunit that has no row, and that the orchestrator asks for (R197 order, up to the first non-pass),
   is run ALONE: one live request, that exact test (`runSelectedOnly`), the same mutant and the same per-test limit. If that test
   times out too, the mutant ends `timeout-killed` there (condition 3).

## What may move, and nothing else (condition 1)

- A **hung** mutant (one whose covering run holds a timeout row) may move from `timeout-killed` by T to `killed` by a test that LethAL
  orders before T. Today such a test X got a cascade not-run row (al-runner ran it after T), and the covering loop skipped it. Now it
  runs alone, as bcdev runs each method.
- A hung mutant **never** moves to `survived`, `no-coverage` or `error`.
- **No non-hung mutant moves**: verdict, killing test and note all unchanged.

## Proof, per mutant, every move listed by name (condition 2)

1. **Invented repro** (`/coord/handoff/R-892/repro-timeout/` as a LethAL target and tests project, a mutant that makes the loop
   endless), today against after: the same verdict for the hung mutant, unless a move of the allowed kind; the cost drops from about
   (tests reaching the loop) x limit to about one limit plus short calls.
2. **PaymentPractices, `PaymentPracticeBuilders`, demo data, serve** (R-892's `pp/` setup): today the run cannot finish (cut at 1 h).
   After: all 57 scored. Every mutant scored in R-892's no-data run that is not hung there must keep its verdict. Every hung mutant is
   listed with its verdict and killing test.
3. **The full v3 gate:** every leg and every per-mutant figure unchanged. No gate fixture hangs (R164), and serve is unchanged without a
   timeout row.

Red tests, each red both ways:
- a timeout row mid-stream gives a partial answer that keeps T's row and re-sends the rest;
- an answer with no timeout row is never cut (a plain fail row must not trigger it);
- a kill pair whose M entry is the stopped one keeps T's timeout, not an error;
- a missing earlier-ordered test is fetched alone, and a second timeout ends the mutant `timeout-killed`.
