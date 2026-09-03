# Pre-commitment: the R206 build's gate numbers, written before any gate runs

Design: `2026-09-03-r206-warm-confirmation.md` (revision 5, approved). Code: `a4ece0b` (control
app 1.0.0.18 and the transport), `59081aa` (the orchestrator, store and report). This file is
committed BEFORE the first gate runs against that build, so a number that turns out wrong is a
finding and not an edit.

## The hang fixture's new arm (`Hang Logic.SpinUntil`, lines 138 to 148)

From `lethal run --project fixtures/sandbox-hang --dry-run` on the arm as committed: 40 mutants
in the fixture (31 before), the nine new ones below IN MANIFEST ORDER, which is the order they are
scored in and the order the kill ledger argument in the design's §6 depends on. T1 is
`SpinUntilAtZeroExitsEarly` (asserts -1 from `SpinUntil(0)`), T2 is `SpinUntilReachesTheTarget`
(asserts 3 from `SpinUntil(3)`). Under the gate's fenced coverage T1 covers one member and T2 two,
so T1 sorts first on the empty ledger; every guard-line kill is T1's at position 1, and the ledger
keeps T1 first for the loop's mutants, whose kills are T2's at position 2.

| line | operator | predicted verdict | killer | `killPosition` | why |
|---|---|---|---|---|---|
| 140 | `empty-block` (whole body) | killed | T1 | 1 | returns 0, T1 expects -1 |
| 141 | `conditional-boundary` (`<=` to `<`) | killed | T1 | 1 | `0 < 0` is false, the loop runs once, returns 1 |
| 142 | `return-value` (`exit(-1)`) | killed | T1 | 1 | the early exit returns something else |
| 143 | `remove-assignment` (`Counter := 0`) | survived | | | a fresh codeunit instance per test starts at 0 anyway (equivalent, as `CountUpTo`'s twin at line 35) |
| 143 | `shift-integer` (`Counter := 1`) | survived | | | T2: 1, 2, 3, returns 3; T1 exits early |
| 146 | `loop-truncate` (`until true`) | killed | T2 | 2 | one lap returns 1; T1 passes first, so a WARM fail, confirmed by replaying [T1, T2] |
| 145 | `void-method-call` (`Advance()`) | **timeout-killed** | T2 | 2 | `Counter` never moves; T1 passes first, so a WARM timeout, confirmed by replaying [T1, T2] with T2 inside its budget |
| 146 | `conditional-boundary` (`>=` to `>`) | killed | T2 | 2 | one extra lap returns 4; warm |
| 147 | `return-value` (`exit(Counter)`) | killed | T2 | 2 | warm |

Manifest order puts `loop-truncate` (line 146) BEFORE `void-method-call` (line 145); the ledger
argument holds either way, since the three guard-line kills come first and T1 leads 3 to 0 when the
loop's mutants start. After the four loop kills T2 leads 4 to 3, which affects nothing: no later
mutant is in this procedure, and the ledger is per procedure.

**The existing 31 rows are unchanged**, including `Advance`'s two hangs at lines 43 and 44, which
gain T2 as a second covering test: a members tie (2 each) with `CountUpToReachesTheLimit`, broken
by name, `C` before `S`, so they stay at position 1. That is the reason the test is named as it is.

## `itest:hang`, ON leg (`--stop-hung-sessions`)

- 40 mutants scored; `counts.errors` 0 (every replay succeeds).
- `timeoutKilled` **5** (the four existing plus line 145), and the fifth is NAMED as the arm's, so
  the gate's reasoning that a sixth hang means a cession stopped holding survives the bump.
- **`warmKills` 4** (lines 146, 145, 146, 147), `killPosition` 2 on each, 1 on every other kill.
- `groupedCalls` = scored (killed + survived + timeoutKilled) + 4.
- Zero `session-reused`. From the store: every `pass`/`fail` row carries a session id; the
  distinct ids among `op_kind = many` rows equal `groupedCalls` minus 5 (the five 408 calls carry
  no id); single-call rows' distinct ids equal their count.

## `itest:hang`, OFF leg

Unchanged in shape: it quarantines at the first hang it meets (line 37, before the new arm) and
scores fewer mutants than the ON leg.

## `itest:bcdev`

3 / 12 / 4, `killingTest` unchanged, **`warmKills` 0** (measured: run 304, all three kills at
position 1), `groupedCalls` 15, every killed mutant carrying `killPosition` 1, zero
`session-reused`, the store check above with nothing subtracted.

## `itest:tables`

299 / 63 / 15, `killingTest` unchanged, **`warmKills` 13** (measured: run 334: 6 at position 2, 4
at 3, 2 at 4, 1 at 5), `groupedCalls` **375** (362 + 13), `M0160` (`ProcessedRequiresCategory`)
at 5, `M0164` (`FlaggedFiresModifyTrigger`) at 4, `M0156` (`CategoryGuardNeedsCalcFields`) at 2,
zero `session-reused`, the store check with nothing subtracted.

## `itest:alrunner`

3 / 16 / 0, `groupedCalls` 0, `warmKills` 0, no `session-warm` caveat (no grouped call), every
kill `killPosition` 1 (the sequential path).

## Run 4 on the sandbox (after the gates)

The 8 R206 mutants `killed` with `killPosition` > 1 and a replay each; the 20 changed killers
unchanged from run 3; zero `session-reused`; survivors' total below 2,400 s (run 3: 3,165 s).

---

## Addendum, written 2026-09-04 BEFORE run 4 starts: the warm-kill count was wrong by 7x

The design's §2.2 says "Run 3 had 28 warm kills of 448". **That number is wrong, and it is wrong in
a way worth naming:** 28 is 8 moved verdicts plus 20 changed killers, i.e. the mutants whose
RESULT differed between run 2 and run 3. A warm kill is a different set: every kill whose killer
was not first in its call. Computed from run 3's own store
(`scratchpad/lethal-53470-run3/lethal.sqlite`, 693 grouped mutants, kill rows in call order):

- **456 kills, 258 at position 1 (cold), 198 WARM.** Positions: 84 at 2, 40 at 3, 14 at 4, 12 at 5,
  then a long tail to 158.
- The replays therefore run **1,811 test methods** in 198 extra calls, against 198 single-method
  cold confirmations they replace: about +1,613 method executions. At run 3's measured median of
  281 ms that is ~8 minutes on a 111-minute run; at §4's target of 140 to 200 ms, ~4.

### The named risk: two mutants sit within 2% of the server's headroom cap

R206 §2.3 says a replay can hit the cap where the mutated call did not, because the server refuses
to START a method when `elapsed + budget + grace > ceiling`, which with the 180 s budget floor and
the 300 s / 30 s defaults means `elapsed > 90 s`. Run 3's own prefix elapsed times say which
mutants are near it:

| mutant | position | prefix elapsed in run 3 | site |
|---|---|---|---|
| **M0020** | 158 | **88.3 s** | `CDOVariantMatchCache.InvalidateCache` |
| **M0021** | 158 | 72.9 s | `CDOVariantMatchCache.InvalidateCache` |
| M0456 | 110 | 36.1 s | `CDOTemplateVariantMgt.UpdateLineFromCriteria` |

Nothing else exceeds 45 s. M0020's replay has 1.9% of headroom at run 3's speed.

**Predicted, and this is the point of writing it down:** §4's per-method cut lands, so both replays
run in roughly half run 3's time (~45 s and ~37 s) and **`warm-confirmation-incomplete` is 0**. If
the cut does NOT land, M0020 is the mutant that caps first, its kill becomes an `error`, and the
count is 1 or 2 rather than 0 — which is the safe direction (a kill withheld, never invented) and
is a measurement of the cost cut rather than a defect in the confirmation.

### Run 4's numbers, pre-committed

- **Verdict table identical to run 3's** for all 741 mutants: 448 killed, 237 survived, the same
  8 cache mutants killed that run 2 had survive. Any mutant whose kill fails to confirm becomes an
  `error` and is a FINDING, not an edit.
- **`warmKills` 198**, **`groupedCalls` 896** (698 + 198).
- **`session-reused` 0**, and no `session-reuse-observed` warning: run 3's 408 texts already
  measured this environment handing every request a fresh session.
- **`warm-prefix-unstable` 0, `unstable` 0, `warm-timeout-unconfirmed` 0,
  `warm-confirmation-incomplete` 0.**
- **Survivors' total below 2,400 s** (run 3: 3,165 s over the same 237 survivors), which is §4's
  own measurement and the only number here that is a target rather than a reproduction.
