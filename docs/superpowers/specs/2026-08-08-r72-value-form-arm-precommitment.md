# R72 — pre-committed verdicts for the `CommitThenRunValueForm` arm

**Written BEFORE the live run that measures them.** This file exists so a contradiction between what
this design predicts and what Cronus283 answers is a FINDING, recorded as one, rather than something
reconciled quietly afterwards. R73's own `remove-commit` prediction was contradicted by the gate, and
that contradiction WAS the finding: it is what eventually produced the 2x2x2 probe and the correct
rule. The same discipline R82's six swap arms used (its §5), applied to a much smaller change.

Date: 2026-08-08. Gate: `LETHAL_ITEST_TABLES=1 bun run itest:tables`, `fixtures/sandbox-data` +
`fixtures/sandbox-data-tests`, Cronus283.

## Why the fixture had to grow at all

R72 was unblocked by measurement, not by code. `scripts/r72-probe/` settled that BC aborts the
transaction when `Codeunit.Run`'s return value is CONSUMED with a write open — in both call frames,
with and without a prior `Commit()` — and that the bare statement form survives in every cell. Two
further arms (B1/B2) measured the guard form `if not Codeunit.Run(X) then ...` and it aborts too.

`Data Commit Ops.CommitThenRun` uses the STATEMENT form. That is exactly why its `remove-commit`
mutant SURVIVED on this gate, and why the prediction rather than the gate was wrong. So no fixture
site could produce the artifact, and a detector built anyway would have been proven only against a
constructed string — the R31 shape R72 exists to avoid.

`CommitThenRunValueForm` is the missing site: the same procedure, the same callee, one difference.

## The change

- `fixtures/sandbox-data/src/DataCommitOps.Codeunit.al` — new `procedure CommitThenRunValueForm():
  Boolean`, which writes, `Commit()`s, then `Ran := Codeunit.Run(Codeunit::"Data Commit Target")`
  and `exit(Ran)`.
- `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al` — new `[Test]
  CommitBeforeValueFormCodeunitRunSucceeds`, covering it.
- No new AL object. The callee is the EXISTING `Data Commit Target`, deliberately, so the
  return-value form is the only difference between the two arms.

## Aggregate prediction

| figure | before | after |
| --- | --- | --- |
| `totalMutantSites` (raw specs) | 148 | **154** |
| deployed mutants | 136 | **141** |
| killed | 109 | **113** |
| survived | 17 | **18** |
| no-coverage | 10 | **10** |
| `untargetedTriggerCount` | 0 | **0** |
| expected baseline failures | 1 (`Data Tests.PageActionComputesNonZero`) | **1, unchanged** |

Raw 154 minus deployed 141 is the usual dedup: at every `Commit()` site Tier-1
`lethal.void-method-call` and Tier-2 `lethal.remove-commit` both propose the same deletion, and §3.2
precedence keeps the Tier-2 one. Six raw specs are added, five deploy.

`mutationScore` must be exactly `113 / (113 + 18)`.

## Per-mutant prediction — all five new mutants, and the reason for each

Keyed on (procedure, operator, mutated text) rather than on mutant code, because codes renumber.

| # | operator | site | predicted | why |
| --- | --- | --- | --- | --- |
| 1 | `lethal.empty-block` | the whole `CommitThenRunValueForm` body | **killed** | the body never runs, so the function returns Boolean's default `false`, and the test's `if not CommitOps.CommitThenRunValueForm() then Error(...)` fires |
| 2 | `lethal.void-method-call` | `DataMain.Init()` | **survived** | every field is assigned immediately after, so deleting `Init()` on a fresh local record changes nothing. Same reason M0005/M0010 survive at the two existing `Init()` sites; a fixture that manufactured an assertion to kill this would be testing the fixture |
| 3 | `lethal.void-method-call` | `DataMain.Insert(false)` | **killed** | the row is never written, and the test asserts `DataMain.Get(Target.CommitRunNo())` succeeds |
| 4 | **`lethal.remove-commit`** | `Commit()` | **killed — AND this is the platform artifact** | the write stays open across `Ran := Codeunit.Run(...)`, BC aborts the transaction, the caller never regains control. The verdict is `killed` and MUST stay `killed` |
| 5 | `lethal.return-value` | `exit(Ran)` -> `exit(not (Ran))` | **killed** | returns `false` on the success path, so the test's first assertion fires |

Row 4 is the one the whole change exists for. **It must arrive `killed`, not `survived` and not
`error`.** A `survived` there would mean the value form does not abort on this container, which
would contradict a measurement taken on Cronus281 six hours earlier and would have to be
investigated as a BC-version or container difference rather than absorbed.

## What must ALSO hold, and would be a finding if it did not

- **No pre-existing mutant may move.** `assertMatchesBaseline` checks that per mutant. The new test
  gives `Data Commit Target`'s mutants a second covering test; every one of them is killed by both
  tests for the same reason (both assert the callee flagged the row), so nothing should move.
- **`Codeunit.Run` in the value form must NOT gain a `lethal.void-method-call` mutant.** It sits in
  expression position, and that operator requires statement position. If one appears, the raw count
  is 155 rather than 154 and the operator's guard has regressed.
- **The report must NAME the artifact.** `SessionReport.platformArtifactKills` must be present,
  `killedCount` 1, listing exactly the row-4 mutant under `write-txn-codeunit-run`, and
  `validity.caveats` must contain `platform-artifact-kills`.
- **The verdict must not move.** `killed` 113 and `mutationScore` `113/131` are asserted with the
  screen firing. If shipping the screen changed either number, the screen would be a re-score, which
  R72 and R121 both forbid.

## The one thing this arm does NOT prove

That the screen finds every platform-produced kill. It finds this operator's, at this shape. Arm E
of R82 — a swap killed by a BC field-length overflow under a test that asserts nothing — sits in the
same fixture, in the same run, and is NOT screened, because `lethal.swap-call-arguments` tags no
sites. That is stated in the report's own interpretation rather than left for a reader to discover.
