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
