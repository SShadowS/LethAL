# PR-50 pre-commitment: the remaining hang shapes (R1052, R1063)

Status: pre-commitment (coord PR-50, lethal-code, 2026-11-16), before the build. Method, bar and evidence sets: PR-37, PR-44 and
PR-48 (`2026-11-16-pr48-hang-refusal-precision.md`; `/coord/handoff/PR-48/timeouts.tsv`, extended with t7 when it ends). Evidence:
`/coord/handoff/PR-50/`. Invented AL only in anything committed.

## The candidates (each built behind its own switch, measured alone, then decided)

Refusals (`loop-hazard.ts`):
- **H (R1052).** A progress call inside an assignment's right side (`X := Adv(Pos)`, where `Adv` moves an exit-read name) counts
  as the statement's call for R830. That covers the `remove-assignment` of the statement, and R1050's rule 2 for the `empty-block`
  of its block.
- **I (R1052).** `empty-block` of a block inside a loop is refused when the block holds the loop's only way out (`exit`, `break`
  or `Error`) and the loop's own condition cannot end it (`until false`, `while true`). This is R446's shape in block form.
- **L (R1063).** R1050's progress analysis follows a local copy that feeds the exit name inside a progress procedure:
  `Next := Pos; Skip(T, Next); Pos := Next`.
- **E (R1063, rule B).** `until Y = X` with an up-counter Y; a bound read through a second variable (`Limit := X; ... until
  N < Limit`); and the search going on past a write to X later in an outer `foreach`.

Give-backs (rule B over-refusals, R1063):
- **W.** An earlier non-default write of X in the same block (`X := 5; X := 1000; ...`): the later assignment is not refused.
- **S.** The up-counter's start must be provably at least 0: a local set from a literal of at least 0 before the loop, or reset
  in the outer loop. A parameter or global counter does not count.

## Decision, per candidate, measured alone on the 72 BC.History modules, DO and every fixture

- A refusal (H, I, L, E):
  - kept if it removes **no scored site** anywhere (cheap insurance for the PR-34 incident class);
  - kept if it reaches PR-37's bar, about 1 timeout-killed per 8 scored sites lost;
  - dropped otherwise.
  It must move no fixture site and no emit golden, or it is dropped and the moved sites are named.
- A give-back (W, S): kept if no site it gives back is in the timeout evidence set. No fixture or golden may move.
Each dropped candidate gets an addendum with its figures, and R1052 or R1063 records what is left.

## Predictions

1. Unit tests, red both ways, per candidate (the refuse and keep cases of the shapes above).
2. Few corpus sites per candidate (R1052: "neither shape was met in a corpus run yet").
3. `itest:alrunner-v3` passes every leg; no gate's mutant set moves.
4. The DO sites that move are listed for lethal-bugs' next window pre-commitment.
5. Folded in: when t7 ends, its timeout-killed sites are checked against PR-48's 14 given-back sites and PR-50's give-backs.
