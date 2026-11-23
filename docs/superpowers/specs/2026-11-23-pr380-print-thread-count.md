# PR-380: PR-292's "the JS thread stays free" test, without a clock

Written 2026-11-23. Replaces test 1 of `docs/superpowers/specs/2026-11-21-pr292-bound-print-worker.md` §3.

## Why
- Master CI failed on 8847f29c8 (unit-linux): test 1 counted a 1 ms `setInterval`'s ticks while `printAlTree` printed a
  48 MB tree, and asserted at least 5. A loaded runner ticked fewer. It is a wall-clock assertion, which CLAUDE.md rules out
  ("assert phase ordering with call counters on stateful fakes, never wall-clock timing").

## What the test must prove, and how
- **The claim:** the per-send print does not run on LethAL's JS thread. All of its blocking work (the walk, the reads, the
  hash) is `printWalkedSync`, so "the JS thread stays free" is the same claim as "printWalkedSync does not run on it".
- **The counter:** `printWalkedSync` counts its own calls in a module-level counter, read by `printsOnThisThread()`. A
  worker loads its own copy of the module, so a print done in the pool leaves the main thread's count unchanged.
- **The test:** `printAlTree` and `printTestDir` of a small tree leave the count unchanged. Then, as a positive control,
  two direct `printWalkedSync` calls equal the worker's answers and move the count by exactly 2, so an unchanged count is
  never empty-versus-empty.
- **Not chosen:** a "started" message from the worker, then a main-thread step before "done" (the orchestrator's example).
  Without a wait inside the worker, a fast worker can finish before the main thread runs, so the order is not deterministic,
  and a wait needs a test-only protocol in the product's worker. The counter needs neither.

## Red checks
- `printInWorker` returning `printWalkedSync(...)` on the main thread (the print back on the JS thread): test 1 red.
- The counter's increment removed: test 1 red (the positive control).

## Checks
One light VERIFY (CPUs 12-21; PR-344's arms hold 0-11), Opus review, selectLegs' gates, CI.
