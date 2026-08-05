# Rung 3 — result

**The report is legible to an agent, and the improvement it produced is real — red-checked.**

## The headline

| | before | after | red-check (agent's tests removed) |
|---|---|---|---|
| mutation score | 19.5% | **72.3%** | **19.5%** |
| killed | 25 (+1 timeout) | 105 (+2 timeout) | 25 (+1 timeout) |
| survived | 107 | 41 | 107 |
| no-coverage | 15 | **0** | 15 |
| baseline tests | 56, 0 failing | 80, 0 failing | 56, 0 failing |

**The red-check is the load-bearing part.** Removing
`Test/Src/AutomaticDocuments/CDOAutStatementFeatureTests.Codeunit.al` returned the run to
**exactly** the frozen rung-1 baseline — 25 / 107 / 15 / 1 — mutant for mutant. The agent's 24 tests
are what produced the improvement; nothing else moved.

The unnarrowed leg was not run, and the reason is not cost: both measurements used the **same**
`--tests-only Src/AutomaticDocuments/**` narrowing, so the narrowing is a constant across the
comparison, and the agent's tests live inside that glob. An unnarrowed run adds tests, which can only
add kills. The narrowed comparison against a pre-committed frozen baseline is the stronger check
here.

## Against the pre-commitment

Written before the agent started. Diffed after.

| predicted | what happened |
|---|---|
| **Attack the 19 `exact`-attributed survivors** | Partially. It went after the untested feature path instead — a better call, see below. |
| **Trap: the 88 `object`-attributed survivors** | **Caught, unprompted.** *"'survived' here means 'some test touched the codeunit', not 'a test executed this line'. Do not read those 87 as weak assertions."* Exactly the trap, identified from the `coverageAttribution` field alone. |
| **Trap: `remove-setrange` (18) likely equivalent** | Not treated as equivalent — it wrote decoy `CDO E-Mail Log` rows differing in exactly one of template / table / customer / document type / zero planned date, which kills `SetRange` removals **legitimately**. My prediction was wrong: these were killable, and it found the construction that kills them. |
| **Trap: `remove-commit`, telemetry `empty-block`** | Not reached; the feature-path work dominated. |
| **Correct not to attempt all 107** | Held. It attacked a coherent feature path rather than a list. |

**Where it beat the prediction.** I framed the task as "kill survivors". It reframed the report:
*"The headline is not 'weak assertions' — it is one whole feature path has no tests at all."* It
identified `CreateOrSendAutStatements` as the sole caller of nine unreached procedures, accounting
for ~102 of the 122 non-killed mutants. That is the correct reading and it is not the one I
pre-committed.

**Something I did not predict at all.** It found that `Tableextension 6175383 CDO Customer`
lines 300–359 hold a near-verbatim copy of `CheckForStatement` / `EntriesInPeriod` / `CalcBalance` /
`BalanceDue`, and that `CDO Aut Stat Bal Check Tests` tests *that copy* — which is why the logic
looks covered while the codeunit's own copy is not. That is a genuine finding about the codebase,
produced from a mutation report.

## What the agent found that this project already knew — and had not connected

Its first verification run came back `baseline-red` with all 22 new tests reporting
`RunMutant returned 0 test lines, expected exactly 1`. It correctly diagnosed this as **not** a test
bug: `continia test run <env> 68964` returned HTTP 500 while 68929 ran fine, because **codeunit 68964
did not exist on the server**. The test app publishes under a fixed version (`28.4.0.0`), and a
same-version publish does not replace the installed app. `lethal` parsed the new source and knew 78
test names while the server still ran the old build.

**That is R31/R56's class — the stale-published-app failure that has already cost this project two
debugging sessions — rediscovered independently by an agent reading a mutation report.** The fix it
found (bump `Test/app.json`) belongs in the runbook.

## Two real test bugs it found and fixed by running things

1. **`Any.AlphabeticText` repeats its sequence across test methods.** Harmless for the existing suite
   (all `AutoRollback`), fatal here because `CreateOrSendAutStatements` commits — the leftover email
   template collided on the next test with *"The record in table Email Template Header already
   exists."* Replaced with fixed per-test codes that delete themselves before re-inserting, including
   the committed `CDO E-Mail Log` rows.
2. **`PeriodStatement_NegativeBalanceBlock_WhenBalanceIsZero` failed**, and it probed rather than
   forced: asserted `Net Change (LCY) = 0` in setup, which passed — so the guard was not blocking; the
   statement report simply renders empty at zero balance, so no PDF and no journal line. **It deleted
   the test and documented why** rather than contorting the code to make a kill.

## The fence

**Zero false denials across 40 Bash commands in the first session; one true denial in the second** —
a `lethal run` missing `--only`/`--tests-only`, which the agent then supplied. The C2 fix
(`(?<![\w-])lethal\b`, so the pattern does not match the agent's own `do-lethal` workspace path)
held under real use.

**What actually blocked the first session was my own `--permission-mode acceptEdits`**, not the
fence. The agent wrote 19 tests it could not compile or run, and — correctly — asked for approval
rather than claiming verification it had not done. On resume with
`--dangerously-skip-permissions`, which is precisely what the fence exists to make tolerable, it
completed the loop.

That first session also produced a clean measurement of what a report-only reader gets wrong without
tools: its file did not compile. `'CDO Aut. Statement Feature Tests'` is 32 characters and AL's
object-name limit is 30 (`AL0305`). One error in 49 KB of AL — and no way to find it without the
compiler.

## The reading rule, applied

Committed before the run: **confusion is a hard finding; success is weak evidence.** The agent ran
without `--bare`, inheriting this machine's `CLAUDE.md`, plugins and skills, so it is a
stronger-than-typical reader.

Therefore: this rung produced **no evidence that the report is illegible**, and **weak evidence that
it is legible**. What it does establish more firmly is narrower and worth stating plainly — the
report contained enough signal for a capable reader to locate an untested feature path, distinguish
attribution artefacts from genuine gaps, and write tests that a mutation red-check confirms are
load-bearing.

## Cost

$6.67 / 58 turns (analysis, no execution) + $11.89 / 60 turns (verification and repair) = **$18.56**.
