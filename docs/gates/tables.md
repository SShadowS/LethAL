# itest:tables

`LETHAL_ITEST_TABLES=1 bun run itest:tables` runs the table fixture, `fixtures/sandbox-data` with
`fixtures/sandbox-data-tests`. This is where Tier-2 operators and table-trigger mutation are
measured. It needs a gitignored `fixtures/sandbox-data/lethal.config.local.json` (not
sandbox-app's).

## Frozen figures

```json gate-figures
{
  "gate": "itest:tables",
  "baselines": {
    "tables.baseline.json": { "killed": 314, "survived": 70, "no-coverage": 22 }
  },
  "constants": {
    "TABLES_FIGURES.totalMutantSites": 428,
    "TABLES_FIGURES.killed": 314,
    "TABLES_FIGURES.survived": 70,
    "TABLES_FIGURES.noCoverage": 22,
    "TABLES_FIGURES.untargetedTriggerCount": 0,
    "TABLES_FIGURES.groupedCalls": 399,
    "TABLES_FIGURES.warmKills": 15,
    "TABLES_FIGURES.killPositions": [
      { "mutantCode": "M0179", "killingTest": "ProcessedRequiresCategory", "killPosition": 5 },
      { "mutantCode": "M0183", "killingTest": "FlaggedFiresModifyTrigger", "killPosition": 4 },
      { "mutantCode": "M0175", "killingTest": "CategoryGuardNeedsCalcFields", "killPosition": 2 },
      { "mutantCode": "M0005", "killingTest": "BandReportSumsBands", "killPosition": 3 },
      { "mutantCode": "M0009", "killingTest": "BandReportSumsBands", "killPosition": 3 }
    ],
    "TABLES_FIGURES.platformArtifactKills": 4,
    "TABLES_FIGURES.assertionScreenDiscrimination": "partial",
    "TABLES_FIGURES.testPageRefused": ["Data Tests.PageActionComputesNonZero"],
    "TABLES_FIGURES.declarativeSites": { "siteCount": 1, "fileCount": 1, "file": "src/DataMainList.Page.al", "kinds": "page_declaration" },
    "TABLES_FIGURES.notInstrumented": { "fileCount": 1, "siteCount": 5, "files": ["src/DataScopeQuery.Query.al"] }
  }
}
```

What the figures mean:

- 314 / 70 / 22 over 406 is killed / survived / no-coverage, over the deployed mutants. The fixture
  has 428 mutant sites before precedence removes some.
- `untargetedTriggerCount` is 0: no trigger mutant had to run every test.
- `groupedCalls` is 399 (R198, R206): 314 + 70 scored mutants, plus 15 warm-kill replays. This is
  the check that the grouped covering loop is really used.
- `warmKills` is 15: kills at group positions 2 to 5. This fixture keeps no session state, so a
  warm kill here only says the killer was not first in the order. Five named mutants pin the
  positions. Their ids moved with R254 and R-463, but they are the same mutants.
- Exactly one test is expected to fail in the baseline run: `Data Tests.PageActionComputesNonZero`.
  It opens a `TestPage`, which the fenced session refuses. The gate checks that exactly this test
  fails, by name, and that the report names the refusal. It must not be relaxed to "the baseline is
  not green", and must not go back to "the baseline is green".
- `platformArtifactKills` is 4: kills screened as platform artifacts (R72, R138, R143).
- The assertion screen's `discrimination` is `partial` (R132). The screen separates kills here,
  because one arm raises errors through `Library Assert`. `itest:bcdev` pins the `vacuous` case.
- `declarativeSites` is 1 site in 1 file (R144). A declarative site, such as a page property,
  produces no mutant. The gate checks that the report says so.
- `notInstrumented` is 5 sites in `query 79332 "Data Scope Query"`. A query is not a kind LethAL
  instruments, so its sites are skipped and do not change the counts above.

## History

The figures in this section are as of each step.

- CLAUDE.md used to carry older figures: 301 / 68 / 18 over 387, 382 group calls, 13 warm kills
  and 2 platform-artifact kills. R254 and R-463 moved the baseline and the itest, and CLAUDE.md was
  not updated. This page is now the record, and the pin test keeps it in step.

- GH-24 (`f25d647`) re-recorded the gate at 301 / 68 / 18 over 387 deployed mutants (407 raw
  specs). It added 10 mutants and changed none. R254 then added a reportextension arm (killed 301
  to 310), and R-463 added `CountBand` (310 to 314). The reasons for each step are in the comments
  on `EXPECTED` in `tables.itest.ts`.
- R30 grew the gate from 64 / 9 / 2 over 75. It added a `tableextension` (5 mutants, all killed) and
  a `page`/`pageextension` pair whose 4 mutants are no-coverage.
- R78 took it to 69 / 9 / 9 over 87. It added a small `codeunit`/`page` pair that only a TestPage
  test can reach, so its 3 mutants measure the R69 gap. R69 is now closed: recovery was measured at
  2.30% of a real app's mutants, and the routed path was deleted (`c1da575`). So those three
  no-coverage mutants are permanent. They show what "we do not recover this, and we say so" looks
  like in a gate.
- R70 took it to 71 / 9 / 10 over 90. It added `table 79309` and `page 79324 "Data Scope Probe"`,
  two objects of different kinds with the same name. All four gates were blind to that shape. The
  `void-method-call` mutant at the `SetRange` site is the detector. Under the R70 bug, Tier 2 claims
  that site instead, and precedence (design §3.2) deletes the Tier-1 mutant. The regression then
  shows as a changed operator name, which the per-mutant baseline catches.
- R82 took it to 109 / 17 / 10 over 136. `codeunit 79311 "Data Swap Ops"` has six arms that
  measure `lethal.swap-call-arguments` live. All 30 verdicts were pre-committed before the run, and
  all 30 matched. Four of its sites carry both a swap and a `void-method-call` mutant: the operator
  adds mutants rather than replacing them. Arm E matters most. A swap there is killed by a BC length
  overflow, under a test that asserts nothing. That is a false kill, and it exposed R86: no kill
  recorded why it died.
- R72 took it to 113 / 18 / 10 over 141. It added `Data Commit Ops.CommitThenRunValueForm`, the
  same shape as `CommitThenRun` but using `Codeunit.Run`'s return value. A 2x2x2 experiment on
  Cronus281 measured that this one factor decides whether BC refuses the write transaction. Its
  `remove-commit` mutant was the first anywhere to be both killed and screened as a platform
  artifact (`SessionReport.platformArtifactKills`). The verdict deliberately stays killed. All five
  new verdicts were pre-committed in
  `docs/superpowers/specs/2026-08-08-r72-value-form-arm-precommitment.md`, and all five matched.
- R136 took it to 157 / 25 / 10 over 192. It changed three operators: `swap-modify-flag` now covers
  `Insert` and `Delete` as well as `Modify`, and `swap-find-direction` and `validate-to-assign` are
  new. It added eleven arms across two new tables. All 51 verdicts were pre-committed in
  `docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md`, and all 51 matched.
- Arm K's three untagged kills come from a duplicate primary key: a blank `Code[20]` key on a
  second insert. They were the live evidence for R138, which is now closed. `swap-modify-flag`'s
  `Insert` mutants declare `run-trigger-skipped-insert`. That raised the platform-artifact count to
  3: the `remove-commit` kill plus the two killed `Insert` sites, arms A and K. The gate pins both
  mechanisms by name, and the `Insert` group mutant by mutant. Only one of arm K's three kills came
  from this operator. The other two reach the same duplicate key through Tier-1 operators that
  mutate the trigger itself, and they stay untagged. So the blind spot shrank but did not close.
- R143 narrowed that tag, and the count fell to 2. `insertSkipCanRaise` now reads the receiver
  table's `OnInsert`. It drops the tag where that trigger provably does not assign the primary key.
  So arm A, an honest assertion kill on `Data Trigger Probe` (whose `OnInsert` only sets a
  Boolean), left the screen, and arm K stayed. No verdict moved.
- R134 took it to 183 / 31 / 10 over 224 (243 raw). `codeunit 79317 "Data Filter Ops"` has seven
  arms that measure the new `lethal.flip-filter-literal`. It is the first operator that mutates a
  filter string, which BC parses at run time, rather than AL code, which `alc` compiles. All 32
  verdicts were pre-committed in `docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md`,
  and all 32 matched. Six spans carry both a flip and a `void-method-call` mutant. At two of them
  the verdicts disagree in opposite directions: arm D's flip survives while its deletion is killed,
  and arm G's flip is killed while its deletion survives. No total can fake that.
  `assertFilterLiteralEvidence` pins it. It also pins arm H's refusal: a closed range is classified,
  then runs out of options, so no flip mutant is made. All four flip kills carry the arm's own
  `Error(...)` text, naming the exact predicted count, in `killingTestFailure`. So none of them is
  a BC filter rejection that was scored killed without an assertion. At that time the gate pinned
  the assertion screen as `vacuous`, because all 52 tests raised errors through bare `Error(...)`.
- R141 took it to 187 / 31 / 10 over 228 (248 raw). It added one arm, `CountTaggedInBand`. Its
  `SetFilter` literal holds an inner quote (`<>''`), so the operator refuses it by character
  (`REFUSED_CHARACTERS`) before classifying anything. That is a different code path from arm H. The
  result that matters is an absence: `flip-filter-literal` still makes exactly six mutants, not
  seven. `assertFilterLiteralEvidence` checks both kinds of refusal by procedure name. The arm's four
  other mutants are all killed, each with the arm's own `Error(...)` text. Both counts behind those
  kills were measured on Cronus283 before the arm was written (`scripts/r141-filter-probe/`).
- R132 took it to 191 / 31 / 10 over 232 (252 raw), and moved the screen's `discrimination` from
  `vacuous` to `partial`. `codeunit 79318 "Data Assert Ops"` is a twin pair. Its two procedures have
  the same shape. Their covering tests differ only in how they raise: one through Microsoft's
  `Library Assert`, the other through bare `Error(...)`. All four mutants are killed, so the
  verdicts are a control. The only difference is which side of the screen each kill lands on.
  `assertAssertionScreenTwinPair` pins that mutant by mutant. The `vacuous` case moved to
  `itest:bcdev`. This proves the pipeline works. It says nothing about how precise the rule is
  (26.1% on the one hand-classified corpus). The test app depends on Microsoft's `Library Assert`.
- R144 added `declarativeSites`. The mutant totals did not change.
- R161 took it to 194 / 32 / 10 over 236 (256 raw). The four new mutants are all one shape:
  `if <bad condition> then Error(...)`, the ordinary BC guard clause. Before, the tool made no
  mutant there, because the `Error` call sits in a `then` branch without `begin`/`end`. Three are
  killed by the `asserterror` written for that guard. The fourth survives:
  `Data Ops.InsertWithoutTrigger`'s `DataMain.Delete(false)`. Its only covering test deletes the
  row first, so the branch is never taken. That is covered but unreached, not no-coverage. All four
  were pre-committed in `docs/superpowers/specs/2026-08-19-r161-branch-slot-precommitment.md`, and
  all four matched.
- Three later operators took it to 201 / 34 / 11 over 246 (266 raw) without changing the fixture.
  `swap-additive` (R159) added 8: six killed and two survived, both survivors in `Data Main`.
  `remove-not` (R163) added 1, killed. The forward direction of `swap-modify-flag` (R165) added 1,
  no-coverage. `swap-enum-member` (R162) finds no site here, so it is measured elsewhere.
- R171 took it to 213 / 34 / 12 over 259 (279 raw). It was the only one of these waves to add
  fixture code. `negate-guard` claims four guards already present: three killed, one in the
  pageextension that no test covers. `codeunit 79319 "Data Set Ops"` adds nine more, all killed. That
  arm exists because the corrected cession of `remove-not` adds no site on any other fixture. All
  thirteen were pre-committed in `docs/superpowers/specs/2026-08-20-r171-build-precommitment.md`
  and all matched. That includes the control at `DataSetOps` line 38, which stays
  `negate-conditional`.
- R159's `flip-boolean-literal` took it to 219 / 41 / 12 over 272 (292 raw): thirteen more, six
  killed and seven survived. The survivors are the point. Four of the seven are behaviours this
  suite does not assert. `CommitBeforeCodeunitRunSucceeds` checks that the row exists and that
  `Flagged` is set, but never reads `Amount`, which three of the mutants double through
  `OnInsert`. `DeleteRunTriggerLeavesTombstone` checks a return value, not the tombstone's own
  field. At those sites `empty-block` kills the procedure while the finer flip survives, which
  answers R159's point 2. The score fell from 0.8623 to 0.8423.
- R159's `remove-assignment` took it to 252 / 57 / 15 over 324 (344 raw). It added 52 mutants in
  one wave: 33 killed, 16 survived, 3 no-coverage. The survivors are the expected shape: an
  assignment whose target is never read again is an equivalent mutant, and nothing that reads only
  the source can see that. The score fell from 0.8423 to 0.8155.
- R159's `toggle-blank-string` took it to 259 / 60 / 15 over 334 (354 raw). Its arm,
  `codeunit 79320 "Data Blank Ops"`, kills two sites through a duplicate primary key with nothing
  asserted. The operator declares no `PlatformKillMechanism`, because changing a written value is
  ordinary changed behaviour, and leaves the assertion screen to flag it. `ClassifyCode` is killed
  through `Library Assert` next to those two, so the screen separates them.
  `assertBlankStringScreenSeparates` pins both directions mutant by mutant.
- R159's `shift-integer` took it to 267 / 63 / 15 over 345 (365 raw). Three of its eleven are the
  `Data Commit Ops` survivors that every value-changing operator finds there. The other eight are in
  `codeunit 79325 "Data Shift Ops"`, a twin pair that controls four operators. The shape
  `if Amount = 10 then exit(1); exit(0);` gives an `empty-block`, a `negate-conditional`, a
  `shift-integer` and a `return-value` mutant in each half. All eight are killed for the same reason,
  so the only difference across the pair is the screen. `assertShiftScreenTwinPair` pins all eight
  mutant by mutant. All eleven were pre-committed in
  `docs/superpowers/specs/2026-08-26-r159-shift-integer-build-precommitment.md` and all matched.
  This was also the first live proof that R166 mattered: the two halves have the same
  `astSubtreeHash`, and only the procedure name tells them apart.
- The operator's other cession, an integer literal in a loop's exit condition, has no arm on any
  fixture and never will. R164 rules that a site that can hang must not enter any gate other than
  `itest:hang`. It is proven offline in `packages/builtin-tier1/tests/shift-integer.test.ts`.
- R180 (killed 267 to 280) and `toggle-blank-temporal` (280 to 299) followed. See the comments on
  `EXPECTED.killed` in `tables.itest.ts`.
