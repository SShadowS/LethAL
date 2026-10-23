# R-675 pre-commitment: the v3 refusal marker anywhere means error; leg C and the session need the exact start

Source: the adopted plan's §5, verbatim and now binding
(`docs/superpowers/plans/2026-10-23-r675-v3-refusal-marker-anywhere.md`, master 83526a06). The build review is
`/coord/reviews/R-675-build/review-r1.md` (APPROVE; its follow-ups are in c5d2565e). Committed to master by
lethal-code before any live run.

## 0. Head

**lethal/r675 at c5d2565e**: code 10fe5dc0, status 546864e4 and the follow-ups c5d2565e, on master 83526a06. Every
run checks this sha and a clean tree. If master moves, an addendum names the new head.

## 1. Change (plan §5)

- `isV3RefusalText(m)` lives in `al-runner-rows.ts`, with `V3_REFUSAL_PREFIX` moved there. It is
  `m.includes("NotRun: out-of-scope:")`.
  - K1(a) (`v3RowVerdict`), the v3 branch of `serveDaemonReusable`, `r672Unkept`, `refusalRowShape` and
    `commit-under-test-isolation` read it unchanged.
  - `V3_TYPE_PREFIX` is deleted.
- Leg C's `message-has-no-type-prefix` reads `diverged` unless `Fails`' message starts with `boom 5` and
  `AssertAreEqual`'s starts with `Assert.AreEqual failed.`. Its `measured` says `prefix "…"` or `reworded "…"`.
- The session refusal stays, and `MESSAGE_PREFIX_REASON` is the plan's §1f text, with the review's Nit A wording.
- The K1(a) and `r672Unkept` texts say "holds v3's refusal marker (R675)" (Nit B).
- **Known limit,** named in R675: a user Assert whose message quotes the marker loses its kill and scores `error`.
  That is the safe direction, measured 0 times in 13,773 kills.

## 2. Measured (`/coord/handoff/R-675/measure.md`)

- 0 of 13,773 kills (7,538 v3, 4,689 v2, 1,546 bcdev) contain the marker, `NotRun:` or `out-of-scope`.
- 0 of 1,180 stored v3 `fail` rows and 0 of 63,264 `pass` rows contain the marker.
- Every stored refusal row has `notRun: true` and the marker at position 0.
- The two probe messages are `boom 5` and `Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). R667
  values differ.`, on alpha.2 (91253f2d6) and edge (57f1e4f98), in all six logs.

## 3. Prediction

1. **alpha.2, 12 legs:** every leg PASS. Leg C reads its **27** facts as in
   `/coord/handoff/R-672/live/step1-alpha2.log`, with `message-has-no-type-prefix` = **`matches`**.
2. **edge, 12 legs:**
   - `message-has-no-type-prefix` = `matches`;
   - leg C GATE-FAILs on exactly the six pre-existing readings of `/coord/handoff/R-672/live/step2-edge.log`, with no
     new reading;
   - X HELD at X (b); T HELD on exactly M0157-M0159 and M0161-M0164; K skipped;
   - S1, S3, N1, L1, Y-A, Y-B, D1 and D1c PASS;
   - per-mutant verdicts, `killingTest` and failure texts as R-672's.
3. **The serve-entries chain** (`chain.sh` with `Q=/coord/handoff/R-672/live`, `NOV2=1`):
   - report-diff 0 against R-672's seven reports;
   - E0-T and E2 HELD on the same 7 rows;
   - the counters equal R-672's: E1 1/1/1, live 3, pair 3; E2 8/8/8, live 305, pair 290; E3a 1/1/1, live 51,
     coverage 37, echo 74; E3b 1/1/1, live 51, echo 37; every request, entry, pair and fallback count equal.

Any moved verdict, killing test, failure text, fact reading or daemon count is a BLOCK. No live leg reaches the new
branches. Their evidence is the unit red checks.

## 4. Holds

The same driver as R-672 (`/coord/handoff/R-675/live/run.sh`). A `HOLD` file in that folder stops any new step.
No itest runs while an orchestrator hold is on.
