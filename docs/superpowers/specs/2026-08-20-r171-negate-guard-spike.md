# R171 spike: is `negate-guard` worth building, and does the cession seam close?

Written before the live half was run. The pre-committed verdicts in §5 were fixed BEFORE the
operator was registered anywhere, and are not edited afterwards; the outcome is appended.

## 0. What prompted it

The question asked was whether "how close to the cyclomatic complexity do we have mutants" is a
useful metric. Measured across this repo's fixtures, the COUNT form is not: complexity and mutant
count correlate at r=0.48, only 6.1% of mutants (20 of 330) are decision-flavoured, and 75 of 94
procedures have complexity 1 while carrying up to 7 mutants each. Most operators fire on statements
and call sites, so count tracks how much code there is.

The per-SITE form is useful, and `scripts/census-branch-conditions.ts` is it: for each branch
condition, does any operator claim a site at it or inside it. That census produced R171.

## 1. How many sites, after the cessions?

`scripts/r171-guard-spike.ts` runs the candidate over a corpus WITHOUT registering it, the way the
R159 spike ran `swap-additive`: registering moves every frozen gate figure, and a spike has to be
answerable before that cost is paid.

**Measured on `do-rel2/Cloud`** (554 files, 4,389 `if` guards in procedure/trigger bodies):

| condition kind | claimed | marginal |
| --- | ---: | ---: |
| `call_expression` | 1,068 | 949 |
| `identifier` | 620 | 620 |
| `member_expression` | 252 | 252 |
| `quoted_identifier` | 27 | 27 |
| `parenthesized_expression` | 18 | 17 |
| `in_expression` | 13 | 13 |
| **total** | **1,998** | **1,878** |

Marginal means no shipped operator claims ANY site inside that condition today, so the mutant is
additive rather than a second claim on a covered span. R13's bar is 13 marginal sites. This is 144x
it.

The 1,998 is 15 below the census gap of 2,013 because the operator cedes `unary_expression`
conditions to `remove-not` — those 15 are §4's seam, not a loss.

## 2. Hazards, as subsets of the 1,998

| hazard | count | share |
| --- | ---: | ---: |
| empty `then` branch (equivalent by inspection) | 12 | 0.6% |
| `then` textually identical to `else` (equivalent) | 0 | 0% |
| guard inside a loop whose branch `exit`s or `break`s | 20 | 1.0% |
| degenerate replacement text | 0 | 0% |

The 20 loop-exit guards are R164's non-termination cost reached by a different route: the mutation
can remove a loop's only exit even though the guard is not itself a loop condition. They score
`timeout-killed` under `--stop-hung-sessions` and quarantine without it, which is a known cost on the
default path rather than a wrong verdict. Loop CONDITIONS are refused outright, which costs 4 marginal
sites of 1,895 — buying back a whole hazard class for 0.2% of the yield.

## 3. Does it compile? Measured twice, because once is not the same question

**Naive splice** (`scripts/r171-compile-probe.ts`): mutant text from the operator's own `generate()`,
spliced into the source, one compile per mutant against real `alc.exe`. A probe project carrying
every claimed condition shape: **11 of 11 compile, 0 failed**, on a baseline that compiles clean
first so a green result cannot come from a broken baseline.

**Real emit path** (`scripts/r171-emit-probe.ts`): LethAL never emits the naive form. It compiles ONE
artifact carrying every mutant behind a runtime guard, and the guard's shape comes from
`MutationSpec.parentContext`. A wrong hint produces an artifact that fails to compile even when the
splice succeeded, and no unit test would catch it because unit tests compare strings. Run with
`negate-guard` alongside every shipped Tier-1 and Tier-2 operator so dedup and containment see a
realistic mix: **50 mutants emitted, 11 from `negate-guard`, artifact compiles with 0 errors**, and
the probe refuses to report a pass unless it can find the emitted dispatch, which it prints verbatim:

```al
end else if MutationSelector.Active('M0002') then begin
  begin
        if not (GuardRow.Get(No)) then
```

This is the check `swap-multiplicative` failed. Its safety proof was true about its operands and
silent about the RESULT type, and a live run refuted it. The claim here is narrower and is now
checked rather than argued: AL requires the condition of an `if` to be Boolean or the ORIGINAL would
not compile, `not` of a Boolean is Boolean, and the operand is parenthesized so precedence cannot
bite.

Conformance: 6 cases, PASS, including three refusals (comparison, `not`, `while`).

## 4. The cession seam

`remove-not` refuses a parenthesized operand and its doc comment says why: `not (A = B)` is "ceded to
`negate-conditional`". Correct for comparisons. Wrong for everything else, because
`negate-conditional` claims `comparison_expression` and `logical_expression` and nothing more — so
`not (X in [...])` was ceded to an operator that does not want it, and reached by neither.

Fix: cede only the inner kinds `negate-conditional` actually claims. Measured on the same corpus,
`remove-not` goes **1,106 -> 1,121 sites**: exactly the 15 the census predicted, 12 `in_expression`
and 3 `member_expression`. The control still holds — `not (A = B)` and `not (A and B)` stay refused,
pinned by two conformance cases, and the probe confirms `negate-guard` claims none of the three
`not (...)` guards, so the two operators do not double-claim.

**But no fixture has such a site.** Measured across `sandbox-app`, `sandbox-data`, `sandbox-hang`,
`sandbox-probes` and `gift-card`: zero newly-claimed sites, and the full unit suite passes unchanged.
That is not reassurance, it is the R56 shape — a change no live gate exercises. Landing it means
either adding a fixture arm that covers it or saying plainly that it is unmeasured live.

## 5. Live half: pre-committed verdicts

`negate-guard` claims **4 sites in `sandbox-data`** and **2 in `examples/gift-card`**; `sandbox-app`
and `sandbox-hang` gain nothing, so `itest:bcdev`, `itest:alrunner` and `itest:hang` cannot move.

The gift-card demo is the cheap live probe (8 tests, ~20 s). Predicted BEFORE registering the
operator:

| # | site | mutation | predicted verdict | why |
| --- | --- | --- | --- | --- |
| G1 | `Gift Card Mgt.Redeem`, `if GiftCard.Blocked then Error(...)` | `if not (GiftCard.Blocked) then` | **killed** | every redeem test uses an unblocked card, so the flip raises `CardBlockedErr` on the happy path |
| G2 | `Gift Card Mgt.BlockExpiredCards`, `if GiftCard.FindSet() then` | `if not (GiftCard.FindSet()) then` | **no-coverage** | no test calls `BlockExpiredCards`; its other seven mutants are already `no-coverage` |

Derived totals if both hold: 45 recorded (43 + 2), killed 25 -> **26**, survived 11 unchanged,
no-coverage 7 -> **8**, scored 36 -> **37**, mutation score 69.4% -> **70.3%**.

Secondary prediction, about the SCREEN rather than the verdict: G1's kill is produced by the
application's own `Error(CardBlockedErr)`, not by a test assertion, so R121's screen flags it and the
suite's discrimination stays **`vacuous`** — 26 of 26 flagged. That is the expected reading on this
suite and is not a finding about the operator.

### 5b. `sandbox-data`'s four arms, pre-committed

Fixed before that run, after §5's gift-card result was known and before `sandbox-data` was touched.

| # | site | predicted | why |
| --- | --- | --- | --- |
| D1 | `Data Find Ops.FirstLevelInRange`, `if Probe.FindFirst() then exit(Probe."Level")` | **killed** by `FindFirstPicksTheLowestKeyInRange` | rows exist, so the flip skips the `exit` and the procedure returns 0 instead of the level |
| D2 | `Data Find Ops.LastLevelInRange`, `if Probe.FindLast() then exit(Probe."Level")` | **killed** by `FindLastPicksTheHighestKeyInRange` | same shape |
| D3 | `DataMainListExt.PageExt` `OnOpenPage`, `if Main.Get('P-EXT') then` | **no-coverage** | every existing mutant in that pageextension trigger is `no-coverage`; no test opens the page |
| D4 | `Data Ops.InsertWithoutTrigger`, `if DataMain.Get(MainNo) then DataMain.Delete(false)` | **killed** | LEAST CONFIDENT. R161 measured this branch as covered-but-unreached: the only covering test deletes the row first, so `Get` returns false and the branch never runs. Flipped, it runs `Delete(false)` on a record that was never read, which should raise. If BC instead treats it as a silent no-op the mutant SURVIVES and this prediction is wrong |

Derived totals if all four hold: 250 deployed (246 + 4), killed 201 -> **204**, survived 34
unchanged, no-coverage 11 -> **12**.

## 6. What this spike did NOT measure

- **Equivalent-mutant rate beyond the syntactic check.** The 12 empty-`then` guards are equivalent by
  inspection; a semantically equivalent flip with a non-empty body is not detectable here and no
  Tier-1 operator detects it.
- **One corpus, one vendor.** A codebase with more comparison-shaped guards would shift every number.

## Recommendation

**Build `negate-guard`.** 1,878 marginal sites against a bar of 13, compile-proven on both the naive
and the real emit path, on the existing guarded emit path, needing no new activation mechanism and no
new `PlatformKillMechanism` (R163 already ruled that a branch flip is ordinary changed behaviour, and
adding a tag here but not to `negate-conditional` would say the two differ when they do not). Landing
cost is one re-freeze of `itest:tables` (+4) and one of the demo (+2), both with pre-committed
verdicts.

**Take the seam fix WITH a fixture arm, not on its own.** It is 15 sites, correct by construction and
compile-proven, and it costs nothing anywhere — which is precisely the problem: no gate would notice
if it broke. Adding an arm to `sandbox-data` that carries `not (<expr> in [<set>])` makes it real.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**All six pre-committed verdicts matched, including the one flagged least confident.**

`examples/gift-card`, run 2026-08-20 against Cronus281 with the operator registered temporarily:

| # | predicted | measured | killing test |
| --- | --- | --- | --- |
| G1 | killed | **killed** | `RedeemReducesBalance` |
| G2 | no-coverage | **no-coverage** | — |

Totals landed exactly as derived: 45 recorded, killed 26, survived 11, no-coverage 8, score
**70.3%**, and the assertion screen reported 26 of 26 flagged, discrimination `vacuous`, as predicted.

`fixtures/sandbox-data`, narrowed to this operator:

| # | predicted | measured | killing test |
| --- | --- | --- | --- |
| D1 | killed by `FindFirstPicksTheLowestKeyInRange` | **killed**, by that test | `FindFirstPicksTheLowestKeyInRange` |
| D2 | killed by `FindLastPicksTheHighestKeyInRange` | **killed**, by that test | `FindLastPicksTheHighestKeyInRange` |
| D3 | no-coverage | **no-coverage** | — |
| D4 | killed (LEAST CONFIDENT) | **killed** | `InsertWithoutTriggerKeepsAmount` |

D4 held for the predicted reason, and the failure text says so in the platform's own words:
`The Data Main does not exist. Identification fields and values: No.=''`. The flip ran
`Delete(false)` on a record that was never read.

The raw-site count moved 266 -> **270**, which `itest:tables` refused on before printing anything
else — the +4 predicted, confirmed by the gate itself.

### The finding worth more than the counts

**D4 is a measured instance of discrimination, not reach.** R159's standing objection to any new
operator is that `empty-block` already destroys the guarded body, so a new mutant may only be a
finer-grained version of a gap that is already covered. At `src/DataOps.Codeunit.al` line 91-92 the
two mutants disagree, under the SAME covering test:

| mutant | site | verdict |
| --- | --- | --- |
| R161 branch-slot: delete `DataMain.Delete(false)` | line 92, the body | **survived** (`covered-but-unreached`) |
| R171 guard flip: `if not (DataMain.Get(MainNo)) then` | line 91, the guard | **killed** |

Deleting the body of a branch that never executes changes nothing, so the suite cannot notice.
Flipping the guard makes the branch execute when it must not, and the suite notices immediately.
Same statement, same test, opposite verdicts. That is the objection answered by measurement rather
than by argument.

### What the live half did not settle

All three kills on `sandbox-data` and the one on gift-card were flagged by R121's screen as not
produced by a test assertion — including D4, where the mutated program raised BC's own error rather
than failing an assertion. That is the expected reading on these suites (both are bare `Error(...)`
style, so the screen is `vacuous` and separates nothing) and it is exactly the class R163's ruling
already covers: a branch flip that errors on its own wrong behaviour is legitimately killed. It is
recorded here so nobody later reads these four kills as evidence the screen was applied and passed.

### Status

BUILT. The recommendation above was taken in full: `negate-guard` is registered, the seam fix landed
WITH the `sandbox-data` arm §4 asked for (`codeunit 79319 "Data Set Ops"`), and both gates are
re-frozen — `itest:tables` at 213/34/12 over 259, the demo at 45. All thirteen build verdicts were
pre-committed in `2026-08-20-r171-build-precommitment.md` and all thirteen matched.
