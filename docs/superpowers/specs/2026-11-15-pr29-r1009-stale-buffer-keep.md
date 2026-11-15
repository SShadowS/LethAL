# PR-29 pre-commitment: the stale-buffer refusal joins the serve keep-list (R1009)

Status: pre-commitment (coord PR-29, lethal-code, 2026-11-15), before any build or run. Related: R1009, R-998 (the keep-list
entries it added, its pre-commitment `2026-11-14-r998-fewer-daemon-closes-precommitment.md`), R945, R981, R1004, R1007.
Evidence: `/coord/handoff/R1009-trace/` (the reduction), `/coord/handoff/R1009-keep/probe/` (the measurement). Invented AL only.

## Why

R-998's DO window left 10 daemon closes by a refusal in a mutant request; 7 of them were one family, `a stale <table> buffer
from its own write, after a lock other than LockTable or a ReadIsolation read in the open transaction (not pinned)` (R1009).
Each close costs DO a new daemon and its warm-up (t1: about 100 s each). The family could not be measured until its trigger
was known. Reduced on 2026-11-15 and posted on #8139: own `Insert`, another record variable modifies the row, `Commit()`,
`RecordRef.Open` + `LockTable()` (the lock that starts the new write transaction), own `Delete`. Upstream says a serve daemon
keeps running after this refusal (#8139).

## The measurement (done, before this pre-commitment)

R-967's kit (R-998's copy, `/coord/handoff/R1009-keep/probe/`, edge-5a58a0f16, `ALRUNNER_SEED=1`):
- Refuser 51006 does that shape, with R-937's standard writes after the lock (so the `Commit` never commits them). One-shot:
  `NotRun: out-of-scope: a stale R1009 Keep Row buffer from its own write, after a lock other than LockTable or a ReadIsolation
  read in the open transaction (not pinned)`: DO's text with the probe's table name.
- Serve: all 40 refuser requests refused (47 rows); 27 readers on one kept daemon all equal to the control; 20 fresh daemons
  one answer, equal to it; the pid unchanged; no panic text. **CLEAN.**

## What changes

1. `V3_SERVE_SAFE_REFUSALS` (`al-runner-server.ts`) gains `stale-buffer-after-lock`, for exactly that text with the table
   name as a parameter, anchored at both ends. Not kept (not measured): `a Delete through a stale ... buffer, with triggers or
   events: not pinned`, #7964's `after a rollback ...` and `after a failed guarded Codeunit.Run ...`.
2. Leg C's `serve-keep-reasons` (still one warn fact) runs one more invented test codeunit with that shape in its one serve
   request, judged by the new entry. A build that rewords the text reads `unkept` and fails the gate (R1000).

## Where the keep-list is read, and why no verdict moves

The entry changes every reader of `V3_SERVE_SAFE_REFUSALS` / `serveDaemonReusable`, for this text only:
1. **Close or keep** (the live, prefetch and coverage paths): the daemon serves the next request instead of a new one. Measured
   clean above. The refused row itself is read as today (a refusal; what follows it in its codeunit is v3's cascade).
2. **The baseline fill** (R1007): a non-sample row with this refusal is kept from the daemon instead of being re-run in a fresh
   process. The one-shot text equals the serve text (measured), so the row is the same.
3. **A whole batch refused** (`batchRefusalReason`): a warm-up or batched prefetch whose every entry met this refusal no longer
   stops the session as `batch-refused`; its rows are read as any kept refusal.
4. **R1004/R998's left-out tests** (`leftOutRows`): a test whose baseline row is this refusal is no longer left out of the
   warm-up and mutant entries. A refused test covers no mutant (only green tests cover), and running it is what LethAL did
   before R1004; what follows it in its codeunit stays v3's cascade, as today.
These are arguments; the DO window below compares per mutant.

## Predictions

- `itest:alrunner-v3` on `current` (edge-5a58a0f16) passes every leg. Leg C's `serve-keep-reasons` reads `matches`, its
  `measured` naming the new case as `refusal`. No pinned verdict, figure or leg outcome moves.
- At the next DO window that carries this change (R-984's config, lethal-bugs): the stale-buffer family closes no daemon in a
  mutant request (R-998's window: 7 of 10), and every mutant both windows score has the same verdict and killing test as in
  t1/t2b/t3/t4. Any difference is a BLOCK.
