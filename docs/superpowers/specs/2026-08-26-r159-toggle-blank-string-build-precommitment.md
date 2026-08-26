# R159 build: per-mutant pre-commitment for `toggle-blank-string`

Written before the gates were run against the built state. Every verdict below was fixed first; the
outcome is appended and nothing above it is edited.

What lands: `lethal.toggle-blank-string` registered (Tier 1, 1.0.0) and
`codeunit 79320 "Data Blank Ops"` with one covering test, which is the CONDITION the spike attached
to its recommendation rather than a follow-up.

## Why the arm is a condition and not a nicety

The operator declares no `PlatformKillMechanism`. Two of its kills on this fixture die on a
duplicate primary key with nothing asserted — the shape R138 tagged for `swap-modify-flag`'s
`Insert` — and the ruling is that changing a written VALUE is ordinary changed behaviour, with
R121's assertion screen left to tell a reader such a kill carried no assertion.

The spike could not test that ruling. Every kill it produced was flagged, because `sandbox-data`
raises through bare `Error(...)` and the rule has nothing to separate on: `vacuous`, exactly as R132
documents. Reading that as a pass would have been wrong, so it was recorded as unanswered.

`Data Blank Ops.ClassifyCode` is killed through Microsoft's `Library Assert`. Beside the two
duplicate-key kills it makes the screen SEPARATE rather than flag everything, and `tables.itest.ts`
now pins that BY MUTANT — a flagged total reads identically whether the screen separated anything or
not.

## 1. The seven `toggle-blank-string` sites

Six were MEASURED in the spike and are restated, not re-predicted. The seventh is in the new arm.

| # | site | mutation | verdict | killing test | screen |
| --- | --- | --- | --- | --- | --- |
| S1 | `Data Commit Ops.CommitThenFail:36` | `Category := 'A'` -> `''` | **survived** | — | — |
| S2 | `Data Commit Ops.CommitThenRun:50` | same | **survived** | — | — |
| S3 | `Data Commit Ops.CommitThenRunValueForm:87` | same | **survived** | — | — |
| S4 | `Data Flag Ops.InsertTwiceWithKeyTrigger:88` | `"No." := ''` -> `'x'` | **killed** | `DoubleInsertWithoutKeyTriggerRaises` | **MUST be flagged** — duplicate key, no assertion |
| S5 | `Data Key Probe.OnInsert:36` | `if "No." = ''` -> `= 'x'` | **killed** | `DoubleInsertWithoutKeyTriggerRaises` | **MUST be flagged** — same mechanism, other side |
| S6 | `Data Main.OnValidate:22` | `if "No." = ''` -> `= 'x'` | **killed** | `BlankNoValidateFails` | flagged (bare `Error`) |
| A3 | `Data Blank Ops.ClassifyCode:30` | `'ALPHA'` -> `''` | **killed** | `BlankStringKillIsAssertionEarned` | **must NOT be flagged** — `Assert.AreEqual` produced the failure |

S4/S5 against A3 is the pair the whole ruling rests on: identical operator, opposite sides of the
screen.

## 2. The arm's other three mutants — PREDICTED

`ClassifyCode` returns 1 for `'ALPHA'` and 0 otherwise, and the test asserts both directions through
`Library Assert`. Every mutation below makes it return 0 for `'ALPHA'`, so all four of the arm's
mutants are killed by the same test and none may be flagged.

| # | line | operator | mutation | predicted | why |
| --- | --- | --- | --- | --- | --- |
| A1 | 29 | `empty-block` | body -> `begin end` | **killed**, not flagged | returns 0 for both inputs; `AreEqual(1, …)` fails |
| A2 | 30 | `negate-conditional` | `=` -> `<>` | **killed**, not flagged | `'ALPHA'` no longer matches |
| A4 | 31 | `return-value` | `exit(1)` -> `exit(0)` | **killed**, not flagged | the matching branch returns 0 |

## 3. Derived totals

| | frozen | predicted |
| --- | ---: | ---: |
| deployed mutants | 324 | **334** |
| killed | 252 | **259** |
| survived | 57 | **60** |
| no-coverage | 15 | **15** |
| `assertionScreen.discrimination` | `partial` | **`partial`** |

Mutation score 259 / 319, about **0.8119**, down from 0.8155 — three survivors against seven kills.

gift-card gains its one site, MEASURED in the spike as killed by `IssueRequiresCustomer`:
59 -> **60** recorded, killed 33 -> **34**, score 68.8% -> **69.4%**.

`credit-limit`, `sandbox-app` and `sandbox-hang` contain no sites, so `itest:bcdev`,
`itest:alrunner` and `itest:hang` cannot move.

## 4. The raw site count is NOT predicted

Read from the run, as for every operator since R171.

---

## OUTCOME, appended after the runs. Nothing above is edited.

**All eleven matched.**

```
verdicts: killed=259 survived=60 noCoverage=15 baselineGreen=false
          score=0.8119122257053292 untargetedTriggers=0 declarativeSites=1
```

`totalMutantSites` came in at **354**, the number §4 declined to predict. The re-recorded baseline
gained **10 keys covering 10 mutants**, removed none, and **no pre-existing key changed verdict**:
seven `toggle-blank-string`, plus the arm's `empty-block`, `negate-conditional` and `return-value`.

gift-card re-froze at **60** recorded, 34 / 15 / 11, score **69.4%**, exactly as derived.

### The condition is satisfied: the screen SEPARATES

`assertBlankStringScreenSeparates` passed, which is the whole reason the arm exists. On one operator,
in one run, R121's screen:

- did **NOT** flag `Data Blank Ops.ClassifyCode`, killed by `Assert.AreEqual`
- **DID** flag `Data Flag Ops.InsertTwiceWithKeyTrigger` and `Data Key Probe.OnInsert`, both killed by
  a duplicate primary key with nothing asserted

Both directions hold, pinned by mutant rather than by a count. The no-`PlatformKillMechanism` ruling
is now MEASURED on this operator instead of inherited from `remove-assignment`'s precedent, and the
spike's open question is closed.

That is worth separating from what it does not show. This says the screen reports what the unit
tests say it reports, on a suite built to make it separable. It says nothing about the rule's
PRECISION — 26.1% on the one hand-classified corpus — which is the confusion R132 exists to prevent.
