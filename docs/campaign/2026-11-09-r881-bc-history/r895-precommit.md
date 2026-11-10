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

## Amendment 1: a move observed AFTER the run (2026-11-10, not pre-committed)

This is written after the runs, so it is not a prediction. It names one move the text above did not word.

**What moved.** PaymentPractices' `PaymentPracticeBuilders`, demo data, serve, master (47 of 57 scored before its 4-hour cap)
against `lethal/r895` (57 of 57). 46 of master's 47 are identical in verdict and killing test. The one difference is **M0019**
(`swap-find-direction`, the hung mutant): `timeout-killed` by `VendorPaymentPractices_SizeEmpty` before, and `timeout-killed` by
`VendorExclFromPaymentPractices` after.

**Why.** R197 orders `VendorExclFromPaymentPractices` first for M0019 (it already killed earlier mutants of the procedure).
- On master, al-runner ran `VendorPaymentPractices_SizeEmpty` first; it timed out, and `VendorExclFromPaymentPractices` came back
  as a cascade not-run row, which the covering loop skips (R639), so the mutant was scored on `SizeEmpty`.
- With the change, the request is cut at that timeout. `VendorExclFromPaymentPractices` has no row, so it runs alone, as bcdev runs
  each method. It hangs too, so the earlier-ordered test decides.

**How it fits.** It is the mechanism this pre-commitment allows, with one difference: the text allows "timeout-killed by T, to killed
by a test ordered before T". Here the verdict class stays `timeout-killed`, and only the killing test moves to the earlier-ordered
one. The orchestrator accepted this move on 2026-11-10, as observed. No non-hung mutant moved.

## Amendment 2: the same move on M0048, observed AFTER the run (2026-11-10, not pre-committed)

**The one-shot comparison.** The same file and demo data on the one-shot transport, which R-895 does not change (lane worktree, master),
scored all 57. Against `lethal/r895` on serve, 55 are identical in verdict and killing test. The 2 differences are both hung
`swap-find-direction` mutants, each of the kind in amendment 1:
- **M0019:** the move above.
- **M0048** (the customer-side twin, which master's serve run never reached): `timeout-killed` by `CustomerExclFromPaymentPractices`
  on one-shot, and `timeout-killed` by `ReportDataSetForCustomersByPeriod` after.

**Why.** In both runs, `BuildPaymentPracticeDataForCustomer`'s earlier mutants (M0041 to M0043, M0047) were killed by
`ReportDataSetForCustomersByPeriod`, so R197 orders it first for M0048. On one-shot, al-runner ran `CustomerExclFromPaymentPractices`
first, which hung, so `ReportDataSetForCustomersByPeriod` came back as a cascade not-run row and was skipped (R639). After the change it
runs alone, hangs too, and decides. The verdict class is unchanged; only the killing test moves to the earlier-ordered one. Sent to the
orchestrator with this amendment, as observed.

## Amendment 3: run 002, after the R-896 merge, observed AFTER the runs (2026-11-10, not pre-committed)

**Why new proofs.** On the merged head, R-894's hang refusal (on master) refuses both `swap-find-direction` sites, so
`PaymentPracticeBuilders` has no hang left and R-895 changes nothing there: master and the merged head gave **55 of 55 identical**
(verdict, killing test, mutant code; `/coord/handoff/R-895/pp/master002*`, `after002*`). The cut was proved on a new invented fixture
instead (`/coord/handoff/R-895/fixture2/`): a loop whose step is a call into another codeunit, which the hang check does not follow.

**The fixture, master against the merged head, serve.**
- Master hit its 90-minute cap after 8 of 10 mutants; the merged head scored all 10 in 2,969 s.
- Of master's 8, 6 are identical.
- The 2 differences are hung mutants, M0007 (`empty-block`) and M0008 (`return-value`) in `Stepper.Next`: `timeout-killed` by
  `CountsToThree` on master, and `timeout-killed` by `CountsAgain` after.

**Why.** LethAL's order for this procedure runs `CountsAgain` first (the store's per-test rows show it).
- On master, al-runner ran `CountsToThree` first, which hung; `CountsAgain` and `CountsThird` came back as cascade rows and were
  skipped, so the mutant was scored on `CountsToThree`, after 2,344 s plus a 542 s reproduction.
- After, the request is cut at `CountsToThree`. `CountsAgain` has no row, so it runs alone, hangs, and decides (181 s, plus a 181 s
  reproduction).

The move is the same kind as amendments 1 and 2: the verdict class is unchanged and the killing test moves to the earlier-ordered one.
No non-hung mutant moved.
