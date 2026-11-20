# PR-243 spec-light: DO's most expensive tests under mutation, and a report section for them

Coord PR-243, lethal-code, 2026-11-19. Offline from y3 (`/coord/handoff/PR-204/`: store, events, report; al-runner
`edge-4ebfe7913`). Scripts: `tests.py` (`tests.txt`), `reach-top10.txt`. Names and numbers only.

## 1. Why ten tests take 44% of the per-mutant test time
Own time under mutation over every test is 11,736 s. The top 10 take 5,123 s (43.7%); the top one alone 1,517 s (12.9%).
- **It is breadth, not slowness under mutation.** Cost is roughly (mutants covered) × (time per run).
  - The top test, `CDO eDoc Send Prof Subs Tests.OnBeforeSendPath_WhenBatchWrapsRecordRefInVariant_…`, covers 3,234
    mutants and ran 2,179 times.
  - Its mean is 696 ms against 627 ms at baseline (×1.11). It is a slow end-to-end test that covers very many procedures.
  - Most of the top 10 run at ×0.8 to ×1.5 of their baseline. A few are slower under mutation (×2.0 to ×2.7: the
    `CDO Setup Data Tests` batch tests), as loops run longer under some mutants.
- **They rarely kill.**
  - Kill rate (named killer ÷ mutants covered): the top test 1.3%; 7 of the top 10 under 3%; 3 of the top 20 kill nothing.
  - 25 of the top 50 kill under 1% of what they cover, and take 2,619 s.
- **Their time goes to SURVIVORS:** 4,105 of the top 10's 5,123 s, where every covering test runs whatever the order.
- **They often do not reach the mutated statement.** Over the survivors each covers, the top tests reach the site in 49% to
  69% (100% only for the two narrow `SetDefaultSendCode…` tests). This is batched-baseline reach (R926), which PR-235
  re-measures unbatched.

## 2. LethAL levers that keep verdicts
1. **R1148 reach pruning** (PR-232 spec; PR-235 measuring). This is the lever for this time, because it is survivor time:
   a top test that never reaches the statement does not need to run. The safe codeunit-order rule, and the session-state
   hazard, are in PR-232's spec.
2. **Stop a mutant's run at its first failure, R1098.** Upstream #8210 is closed, with draft PR #8496
   (`stopAtFirstFailure: "request" | "group"`). Adopting it, once a gated build has it, saves the tests run after a kill
   (PR-101 measured about 10% of serve on a DO slice). It changes no verdict: a kill is a kill at its first failure, and
   the reproduction runs anyway.
3. **Ordering a slow, rarely-killing test later.** It saves time ONLY after lever 2, and only on killed mutants (y3: 592
   s of per-mutant time in all, against 9,829 s for survivors). So it is worth little on DO.
   - Its risk: `test-order.ts` removed duration as a key because it made `killingTest` nondeterministic between two runs.
   - If wanted, use a deterministic cost key: the baseline's member count is already key 2. A static cost class (for
     example the test's covered-procedure count) would be one too.
   - **Recommendation: do not build it** until lever 2 is in and a run shows killed-mutant time is worth chasing.

## 3. The report section: "Most expensive tests under mutation"
**Why:** the user's own lever is the test project's shape. Ten broad end-to-end tests that rarely kill dominate DO's
time, and only the user can split or narrow them. Today the report does not show it.

**Proposal:** a `SessionReport` field `costlyTests`: the top N (default 20) tests by own time under mutation. Each entry:
- `test` (qualified name), `file`, `line`;
- `coveredMutants`, `runs`;
- `ownMs` and its share of all per-mutant test time;
- `meanMs`, `baselineMs`;
- `kills` (as the named killing test) and `killRate`;
- `msUnderSurvivors`;
- once reach is measured per run, `reachRate` (the share of covered survivors whose statement it reached).

Plus one banner line, for example "the 10 most expensive tests take 44% of the mutation time; the top one, 12.9%, kills
1.3% of what it covers".

**What it must not say:** "remove this test". A rarely-killing test can still be the ONLY killer of some mutants. With
first-failure stops, only the named killer is known, so the section names kills, never "unique kills".

**Where the data comes from:** per-test own time is in the store (`test_results.own_duration_ms`), and on the event stream
per run. The fold must aggregate per test from events (`report-fold.ts`), so a report rebuilt from events matches.

**The ripple** (CLAUDE.md, "Adding a SessionReport field ripples"):
- `events.ts` if a new event is needed (the existing per-test rows may suffice);
- `report-fold.ts`'s accumulator; `report.ts`'s type, builder and banner;
- `bun scripts/generate-schemas.ts`; `tests/schemas.test.ts` (the root-required list and older reports);
- `report-equality` snapshots; the committed sample reports regenerated live.
- Optional in the schema, so older reports stay valid.

**Size and privacy:** at most N entries; names, paths and numbers only, which the redaction ruling allows to publish.

## 4. Next steps
- **Build the report section:** a pre-commitment with the exact field and banner, then the ripple, then a fold test and an
  equality test (event fold = store fold). Unit-only; no gate figure moves.
- **R1098:** adopt `stopAtFirstFailure` when a gated build carries #8496. That is the update gate's and bugs' domain.
- **No ordering change now.**
