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

| site (the identity; see the note below) | operator | position | prefix elapsed in run 3 |
|---|---|---|---|
| **`CDOVariantMatchCache.Codeunit.al:70`** (`InvalidateCache`) | `void-method-call` | 158 | **88.3 s** |
| `CDOVariantMatchCache.Codeunit.al:71` (`InvalidateCache`) | `void-method-call` | 158 | 72.9 s |
| `CDOTemplateVariantMgt.Codeunit.al:913` (`UpdateLineFromCriteria`) | `empty-block` | 110 | 36.1 s |

Nothing else exceeds 45 s. The first has 1.9% of headroom at run 3's speed.

**Named by SITE, not by mutant code, and that correction is itself worth recording.** An earlier
draft of this table called them M0020, M0021 and M0456. Mutant codes RESTART PER BATCH: run 3 has
three batches, 741 mutants and only 633 distinct codes, so `M0020` names three different mutants
(`CDOTemplateVariantEntry.Table.al:148 empty-block` in batch 0, `CDOTemplateVariantMgt.Codeunit.al:72
remove-not` in batch 1, and the cache mutant above in batch 2). The positions in this table were
computed from unique store row ids and are correct; only the labels were ambiguous. Found by
smoke-testing the run-3-vs-run-4 comparison script against run 3 twice before run 4 existed: it
reported "633 mutants" for a 741-mutant run, which is the same shape of defect as R118's
field-wise read that returned a fraction of a row and looked complete. The comparison keys on
`(file, line, operator, procedure, astHash, startIndex, endIndex)`, which resolves all 741.

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


---

## MEASURED: run 4, 2026-09-04 (binary `b0c8b0d`, control app 1.0.0.18, 86.2 min)

Every load-bearing number held; two deviated and both are explained below, in the safe direction
and as consequences of the cost cut rather than defects.

### What held

- **The verdict table is IDENTICAL to run 3 across all 741 mutants** - same verdict AND same
  `killingTest` - with **0 errors**. 448 killed, 8 timeout-killed, 237 survived, 48 no-coverage.
  Compared on a key of (file, line, operator, procedure/trigger, astHash, identityOrdinal), which
  resolves all 741 uniquely.
- **All four new causes are zero**: `session-reused`, `warm-prefix-unstable`,
  `warm-timeout-unconfirmed`, `warm-confirmation-incomplete`, and `unstable` is zero too. Every
  one of the 201 warm kills confirmed: its call's prefix passed unmutated in a fresh session.
- **R206's eight moved verdicts all stand**, each now carrying a confirmed warm position:
  `CDOVariantMatchCache` 82/82/83/84 at 7/2/9/4 and `CDOTemplateVariantMgt` 531/533/533/913 at
  7/3/3/110.
- **The named near-cap risk did not fire.** Both 158-method replays confirmed
  (`CDOVariantMatchCache.Codeunit.al:70` and `:71`, `killPosition` 158), as did the 110-method one.
  Predicted 0 `warm-confirmation-incomplete`, measured 0.
- **The session guard fired on nothing**, and its data is live: 15,004 answered rows, **0** without
  a session id, 2,357 distinct sessions.
- **The cost cut landed and beat its target.** Per-method median **281 ms -> 105 ms** (target was
  140-200 ms), p90 624 ms -> 152 ms. Survivors' total **3,165 s -> 1,082 s** against a 2,400 s
  target. Wall clock **111.0 -> 86.2 min**, while doing strictly more work.

### Deviation 1: `warmKills` 201, predicted 198 - the prediction was an undercount by construction

198 was computed from run 3's stored row ORDER. A `timeout-killed` mutant records exactly ONE
covering row, because BC's 408 discards the prefix's per-method answers (R198 s4), so that method
forced **every** timeout to position 1 whether or not it was warm. Run 4's recorded positions show
3 of the 8 timeouts are warm (positions 2, 2, 20): 198 + 3 = 201. The field measures something the
old data structurally could not, which is the point of adding it.

### Deviation 2: `groupedCalls` 895, predicted 896 - five fewer cap continuations

Both runs scored 585 mutants through the covering loop. Run 3: 698 calls = 585 + **113**
continuations (a call that hits the server's 90 s headroom cap answers `cap`, and the cursor
continues in a new call). Run 4: 895 = 585 + **108** continuations + 201 replays + **1** lost-ack
retry. At 105 ms per method instead of 281, five fewer calls reached the cap. The lost ack was a
connection timeout on a 112-method call that R194 reconciled as COMPLETE server-side and re-ran
once; run 3 had none.

### A refinement the gates should carry

The store-level liveness rule says the distinct session ids among grouped rows equal the group
calls that ANSWERED. On the sandbox that is 13,533 rows across **886** sessions against
`groupedCalls` 895 minus 8 stopped calls minus **1 lost ack** = 886. A hosted run shows that
"calls that did not answer" includes a lost ack, not only a 408 - the container gates have no
lost acks, so only this run could surface it.
