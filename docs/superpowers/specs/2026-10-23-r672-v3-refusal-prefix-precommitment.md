# R-672 pre-commitment: one V3_TYPE_PREFIX for K1(a) and leg C; serve keeps a daemon only on a non-refusal row

Source: the adopted plan's §5, verbatim (`docs/superpowers/plans/2026-10-23-r672-v3-refusal-prefix.md`, master
6e42838d), which this file makes binding, plus the head and the full gate list. The build review is
`/coord/reviews/R-672-build/review-r1.md` (APPROVE). Committed to master by lethal-code before any live run.

## 0. Head

**lethal/r672 at cbc8da6e**: the build e11a42c6 and the status f9e82024, on master df1a1ac9 (R-656 included) merged
in. Every run checks this sha and a clean tree. If master moves, an addendum names the new head.

## 1. The change (plan §5)

`V3_TYPE_PREFIX = [A-Za-z_][\w.]*: ` (in `al-runner-rows.ts`) is the one prefix source for:
- K1(a) (`v3RowVerdict`), `refusalRowShape` and `commit-under-test-isolation`. They read v3's refusal as
  `^(?:V3_TYPE_PREFIX)?NotRun: out-of-scope:` (`isV3RefusalText`) instead of `startsWith("NotRun: out-of-scope:")`.
- The v3 branch of `serveDaemonReusable`. It keeps the daemon after a `pass`/`fail` row only when
  `!notRun && !isV3RefusalText(message)`.
- Leg C's `message-has-no-type-prefix`. It reads `^V3_TYPE_PREFIX` on `Fails` and `AssertAreEqual`, and replaces
  `AL_RUNNER_EXCEPTION_PREFIX`, of which it is a strict superset.

The session refusal stays. Its reason text is the plan's §3 text, verbatim.

## 2. Measured (`/coord/handoff/R-672/measure.md`)

- Every v3 refusal row on alpha.2 (91253f2d6) and edge (57f1e4f98) carries `notRun: true`, `status: "error"` and no
  prefix.
- 0 of 6,797 v3 kills, and 0 of 12,645 kills on any backend, contain `NotRun:`.
- Neither of leg C's two probe texts starts with a `<word>: `.

## 3. Gates and predictions, on the head above

1. **`bun scripts/verify.ts`:** PASS. Done: 9605 pass / 38 skip / 0 fail. The 38 skips are master's.
2. **`itest:alrunner-v3` on alpha.2** (`current`), all 12 legs (`LETHAL_ITEST_V3_TABLES=1`,
   `LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396`):
   - every leg PASS;
   - leg C reads its **27** facts as on a6233dfb, with `message-has-no-type-prefix` = **`matches`**.
3. **The same on edge 57f1e4f98** (`LETHAL_ALRUNNER_V3_CANDIDATE=1`):
   - `message-has-no-type-prefix` = `matches`;
   - leg C GATE-FAILs on its pre-existing edge readings only (`refusal-row-shape` = `unlike-bc`,
     `commit-under-test-isolation` = `defect-present`, and the readings `/coord/handoff/R-656/live/legC-edge.log`
     recorded), with no new reading;
   - every other leg's verdicts are as on its last edge run.
4. **The serve-entries legs E0-S, E1, E0-T, E2, E0-D, E3a and E3b,** through `/coord/handoff/R-653/live/chain.sh`
   with `Q=/coord/handoff/R-668/live` and `OUT=/coord/handoff/R-672/live`:
   - report-diff 0 against R-668's reports for all seven;
   - E0-T and E2 HELD on exactly the 7 pre-named rows;
   - the serve-entries counters equal R-668's (`/coord/handoff/R-668/live/E*.log`): `daemons` / `cachedFalse` /
     `warmups` are E1 1/1/1, E2 8/8/8, E3a 1/1/1 and E3b 1/1/1, and the request, entry, pair and fallback counts
     are equal too;
   - the chain's V2 step (`itest:alrunner`) is not run, because v2 is retired since R-654 S3.

Any moved verdict, killing test, failure text, fact reading or daemon count is a BLOCK. The gates cannot exercise
the new branches, because no build writes a prefix or a refusal without `notRun`. The unit red checks are the
evidence for those branches (`/coord/reviews/R-672-build/review-r1.md`).

## 4. Order and holds

One heavy job at a time, under the slot rule. **No `itest:alrunner-v3` runs while the orchestrator's R-670
owner-swap hold is on.**
