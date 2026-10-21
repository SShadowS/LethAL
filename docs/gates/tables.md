# itest:tables

`LETHAL_ITEST_TABLES=1 bun run itest:tables` runs the TABLE fixture (`fixtures/sandbox-data` +
`fixtures/sandbox-data-tests`), where Tier-2 operators and table-trigger mutation live. It needs a
gitignored `fixtures/sandbox-data/lethal.config.local.json` (not sandbox-app's: the two fixtures
target different containers).

## Frozen figures

```json gate-figures
{
  "gate": "itest:tables",
  "baselines": {
    "tables.baseline.json": { "killed": 314, "survived": 70, "no-coverage": 22 }
  },
  "notPinned": {
    "totalMutantSites": 428,
    "untargetedTriggerCount": 0,
    "groupedCalls": 399,
    "warmKills": 15,
    "killPositions": { "M0179": 5, "M0183": 4, "M0175": 2, "M0005": 3, "M0009": 3 },
    "platformArtifactKills": 4,
    "assertionScreenDiscrimination": "partial",
    "expectedBaselineFailure": "Data Tests.PageActionComputesNonZero",
    "declarativeSites": { "siteCount": 1, "fileCount": 1, "file": "src/DataMainList.Page.al" },
    "notInstrumented": { "siteCount": 5, "fileCount": 1, "file": "src/DataScopeQuery.Query.al" }
  }
}
```

What each means:

- **314 / 70 / 22** over 406 deployed mutants (428 sites before precedence).
- **`untargetedTriggerCount` 0**: no trigger mutant had to run every test.
- **`groupedCalls` 399** (R198, R206): 314 + 70 scored, plus 15 warm-kill replays. It is the
  anti-inertness pin for the grouped covering loop.
- **`warmKills` 15**: kills at group position 2 to 5. This fixture has no session state, so this is
  an ORDER fact, pinned by named mutants' positions as well (the ids moved with R254 and R-463; same
  mutants).
- **Exactly ONE expected baseline failure**, `Data Tests.PageActionComputesNonZero`, which opens a
  `TestPage` the fenced session refuses. The gate asserts that exactly that test fails, BY NAME, and
  that the refusal is NAMED in the report. It no longer asserts a blanket green baseline; flipping
  the old assertion to `false` would have gutted it.
- **`platformArtifactKills`**: kills screened as platform artifacts (R72, R138, R143).
- **`assertionScreen.discrimination` `partial`** (R132): R121's screen separates kills here,
  because one arm raises through `Library Assert`. `itest:bcdev` pins the `vacuous` case.
- **`declarativeSites` 1 site in 1 file** (R144): a declarative site produces no mutant; the gate
  asserts the report SAYS the refusal happened.
- **`notInstrumented`**: `query 79332 "Data Scope Query"`, a non-carrier kind; its 5 sites land in
  `skipped`, so the counts above are unchanged by it.

The figures above are newer than the last ones CLAUDE.md carried (301 / 68 / 18 over 387,
`groupedCalls` 382, `warmKills` 13, `platformArtifactKills` 2). The baseline and
`tables.itest.ts` moved with R254 and R-463 and CLAUDE.md was not updated; this page is now the
record, and the pin test keeps the baseline half honest.

## History (moved from CLAUDE.md; figures here are as of each step)

- Re-recorded for GH-24 in `f25d647` at 301/68/18 over 387 (407 raw specs), 10 mutants added, none
  changed. Since then R254 (the reportextension arm, 301 to 310 killed) and R-463 (`CountBand`, 310
  to 314) moved it; the per-step reasons are in the comments on `EXPECTED` in `tables.itest.ts`.
- R30 grew it from 64/9/2 over 75: a `tableextension` (5 new mutants, all killed) and a
  `page`/`pageextension` pair whose 4 mutants are `no-coverage`.
- R78 took it to 69/9/9 over 87: a minimal `codeunit`/`page` pair reachable ONLY through a TestPage
  test, so its 3 mutants are the measured statement of the R69 gap. **R69 is now CLOSED (recovery
  measured at 2.30% of a real app's mutants and the routed path DELETED, `c1da575`)**, so those
  three are permanent, not provisional: they are what "we do not recover this, and we say so" looks
  like in a gate.
- R70 took it to 71/9/10 over 90: `table 79309` / `page 79324 "Data Scope Probe"`, a cross-kind
  NAME COLLISION, the one shape all four gates were blind to. Its `void-method-call` at the
  `SetRange` site is the detector: under the R70 bug Tier 2 claims that site instead and §3.2
  precedence DELETES the Tier-1 mutant, so the regression appears as an OPERATOR NAME change the
  per-mutant baseline catches.
- R82 took it to 109/17/10 over 136: `codeunit 79311 "Data Swap Ops"`, six arms measuring
  `lethal.swap-call-arguments` live, with all 30 per-mutant verdicts PRE-COMMITTED before the run and
  all 30 matching. Four of its sites carry BOTH a swap and a `void-method-call` mutant: the operator
  adds mutants rather than displacing them. Arm E is the one to know about: a swap killed by a BC
  length overflow under a test that asserts NOTHING, i.e. a false kill, and it exposed R86 (no kill
  records why it died).
- R72 took it to 113/18/10 over 141: `Data Commit Ops.CommitThenRunValueForm`, the SAME shape as
  `CommitThenRun` with `Codeunit.Run`'s return value consumed, which is the one factor a 2x2x2 on
  Cronus281 measured as deciding BC's write-transaction refusal. Its `remove-commit` mutant is the
  first anywhere scored `killed` AND screened as a platform artifact
  (`SessionReport.platformArtifactKills`); the verdict deliberately does not move. All five new
  verdicts were pre-committed in `docs/superpowers/specs/2026-08-08-r72-value-form-arm-precommitment.md`
  and all five matched.
- R136 took it to 157/25/10 over 192: three operator changes (`swap-modify-flag` extended from
  `Modify` alone to `Insert`/`Delete`, plus the new `swap-find-direction` and `validate-to-assign`),
  eleven fixture arms across two new tables, with all 51 per-mutant verdicts PRE-COMMITTED in
  `docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md` and all 51 matching. Arm K's three
  untagged kills (a duplicate primary key from a blank `Code[20]` key on a second insert) were the
  live statement of R138, which is now CLOSED: `swap-modify-flag`'s `Insert` mutants declare
  `run-trigger-skipped-insert`, so `platformArtifactKills.killedCount` became 3 (the
  `remove-commit` kill plus the fixture's two KILLED `Insert` sites, arms A and K), and the gate pins
  BOTH mechanisms by name and the Insert group BY MUTANT. Only ONE of arm K's three kills was this
  operator's; the other two reach the same duplicate key through Tier-1 operators mutating the
  trigger itself and stay untagged, so the blind spot shrank rather than closed.
- **R143 NARROWED that tag and `platformArtifactKills.killedCount` became 2:** `insertSkipCanRaise`
  resolves the receiver's table, reads its `OnInsert` and drops the tag where that trigger provably
  does not assign the primary key, so arm A (an honest assertion kill on `Data Trigger Probe`, whose
  `OnInsert` sets a Boolean) LEFT the screen and arm K stayed. A receiver the project cannot resolve
  KEEPS the tag: for a screen the unsafe direction is under-tagging. No verdict moved.
- R134 took it to 183/31/10 over 224 (243 raw): `codeunit 79317 "Data Filter Ops"`, seven arms
  measuring the new `lethal.flip-filter-literal`, the first operator that mutates a filter STRING
  that BC re-parses at RUNTIME rather than AL that `alc` compiles, with all 32 per-mutant verdicts
  PRE-COMMITTED in `docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md` and all 32
  matching. Six spans carry BOTH a flip and a `void-method-call` mutant, and at two of them the
  verdicts DISAGREE in opposite directions (arm D's flip survives while the deletion is killed, arm
  G's flip is killed while the deletion survives), which is discrimination evidence no aggregate
  count can fake; `assertFilterLiteralEvidence` pins it, along with arm H's refusal (a closed range
  classifies fine, then exhausts the ladder, so it emits no flip mutant). All four flip kills carry
  the arm's own bare `Error(...)` text naming the exact predicted count in `killingTestFailure`, so
  none of them is a BC filter rejection scoring `killed` without an assertion. The gate then asserted
  R121's screen as **`vacuous`** here (all 52 tests raised via bare `Error(...)`).
- R141 took it to 187/31/10 over 228 (248 raw): ONE more arm, `CountTaggedInBand`, whose `SetFilter`
  literal carries an inner quote (`<>''`, not blank) and so hits the operator's CHARACTER refusal
  (`REFUSED_CHARACTERS` declines the string before anything is classified), a different code path
  from arm H's ladder exhaustion. The load-bearing result is an ABSENCE: `flip-filter-literal` still
  emits exactly SIX mutants, never seven, which `assertFilterLiteralEvidence` asserts by procedure
  name for both refusal kinds. Its four collateral mutants are all killed, each carrying the arm's
  own `Error(...)` text, and both counts behind those kills were MEASURED against Cronus283 before
  the arm was written (`scripts/r141-filter-probe/`).
- R132 took it to 191/31/10 over 232 (252 raw) and flipped `assertionScreen.discrimination` from
  **`vacuous`** to **`partial`**: `codeunit 79318 "Data Assert Ops"` is a TWIN PAIR whose two
  procedures are identical in shape and whose covering tests differ only in how they raise, one
  through Microsoft's `Library Assert` and one through bare `Error(...)`. All four of its mutants are
  killed, so the verdicts are a control and the only difference is which side of R121's screen each
  kill lands on, which `assertAssertionScreenTwinPair` pins BY MUTANT. The `vacuous` case did not
  disappear: `itest:bcdev` now asserts it. This is a PIPELINE proof and says nothing about the rule's
  precision (26.1% on the one hand-classified corpus). The test app declares a dependency on
  Microsoft's `Library Assert` (installed Global on both fixture containers; symbols come from the
  container's own dev endpoint).
- R144 added `declarativeSites` (see above); the mutant totals were UNCHANGED by it.
- R161 took it to 194/32/10 over 236 (256 raw): four mutants of ONE shape, `if <bad condition> then
  Error(...)`, the ordinary BC guard clause, where the tool previously emitted NOTHING because the
  `Error` call sits in an un-braced `then_branch`. Three are killed by the `asserterror` that exists
  for that guard and the fourth SURVIVES (`Data Ops.InsertWithoutTrigger`'s `DataMain.Delete(false)`,
  whose only covering test deletes the row first, so the branch is never taken:
  `covered-but-unreached`, not `no-coverage`). Pre-committed in
  `docs/superpowers/specs/2026-08-19-r161-branch-slot-precommitment.md`; all four matched.
- Three later operators took it to 201/34/11 over 246 (266 raw) without a fixture change:
  `swap-additive` (R159) adds 8, six killed and two survived, both survivors in `Data Main`;
  `remove-not` (R163) adds 1 killed; `swap-modify-flag`'s forward direction (R165) adds 1
  no-coverage. `swap-enum-member` (R162) finds NO site here, which is why it is measured elsewhere.
- R171 took it to 213/34/12 over 259 (279 raw), the only one of these waves to add a FIXTURE:
  `negate-guard` claims four guards already here (three killed, one in the uncovered
  pageextension), and `codeunit 79319 "Data Set Ops"` adds nine more, all killed. That arm exists
  because `remove-not`'s corrected cession adds ZERO sites on every other fixture. All thirteen
  verdicts were pre-committed in `docs/superpowers/specs/2026-08-20-r171-build-precommitment.md` and
  matched, including the CONTROL at `DataSetOps` line 38 staying `negate-conditional`.
- R159's `flip-boolean-literal` took it to 219/41/12 over 272 (292 raw): thirteen more, SIX killed
  and SEVEN survived, and the survivors are the point. Four of the seven are behaviours this suite
  does not assert (`CommitBeforeCodeunitRunSucceeds` checks the row exists and `Flagged` is set but
  never reads `Amount`, which three of them double through `OnInsert`, and
  `DeleteRunTriggerLeavesTombstone` checks a RETURN VALUE rather than the tombstone's own field).
  `empty-block` KILLS those procedures while the fine-grained flip SURVIVES, which answers R159's
  point 2. The score fell 0.8623 to 0.8423.
- R159's `remove-assignment` took it to 252/57/15 over 324 (344 raw): 52 mutants in one wave, 33
  killed, 16 survived, 3 no-coverage. The survivors are the expected shape: an assignment whose
  target is never read again is an equivalent mutant no source-derived layer can see. The score fell
  0.8423 to 0.8155.
- R159's `toggle-blank-string` took it to 259/60/15 over 334 (354 raw). Its arm `codeunit 79320
  "Data Blank Ops"` kills two sites through a DUPLICATE PRIMARY KEY with nothing asserted, declares
  no `PlatformKillMechanism` (changing a written value is ordinary changed behaviour) and leaves
  R121's screen to say so. `ClassifyCode` is killed through `Library Assert` beside those two, so
  the screen SEPARATES, and `assertBlankStringScreenSeparates` pins both directions BY MUTANT.
- R159's `shift-integer` took it to 267/63/15 over 345 (365 raw). Three of its eleven are the `Data
  Commit Ops` survivors every value-mutating operator finds there; the other eight are `codeunit
  79325 "Data Shift Ops"`, a TWIN PAIR that controls FOUR operators: `if Amount = 10 then exit(1);
  exit(0);` yields an `empty-block`, a `negate-conditional`, a `shift-integer` and a `return-value`
  mutant per half, all eight killed for the same reason, so the only variable across the pair is
  R121's screen. `assertShiftScreenTwinPair` pins all eight BY MUTANT. Pre-committed in
  `docs/superpowers/specs/2026-08-26-r159-shift-integer-build-precommitment.md`; all eleven matched.
  It is also the first live proof that R166 was load-bearing: the two halves share an
  `astSubtreeHash`, and only the enclosing procedure name separates them.
- The operator's OTHER cession, an integer literal in a loop's exit condition, has no arm on any
  fixture and never will: R164 rules that a hang-capable site must not enter a scored gate. It is
  proven offline in `packages/builtin-tier1/tests/shift-integer.test.ts`.
- R180 (267 to 280 killed) and `toggle-blank-temporal` (280 to 299) followed; see the comments on
  `EXPECTED.killed` in `tables.itest.ts`.
