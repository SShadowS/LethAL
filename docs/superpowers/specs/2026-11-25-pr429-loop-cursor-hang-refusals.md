# PR-429 pre-commitment (R1212): static hang refusals for two loop-cursor shapes, at dispatch

**Source:** R1212, from PR-427's al-runner v3 hang check on DO's Email area (`/coord/handoff/PR-427/v3/report.json`).
- Two mutants there were `timeout-killed`, M2850 (`lethal.negate-conditional`) and M0657 (`lethal.void-method-call`);
  those are R1212's two shapes.
- A third, M2284 (`lethal.void-method-call`), scored `error`, not `timeout-killed`. It is a different shape and out of
  scope (below).
- Why M0657 hangs is measured on al-runner v3 only, which is not authoritative. BC's cursor after `Duplicate()` is
  assumed. Refusing is the safe direction either way: a refusal only removes a mutant, so it can never make a false kill.

Reviewed by spec-adversary plus two delta reviews (no BLOCK); every finding is folded in below.

## Where the rules live
Both rules are dispatch-time refusals in `loop-hazard.ts`, read by `openItemHangRefuses` (as `r893WalkJump` is), so a
refused site is COUNTED as `hang-refused` (R447) with no new wiring.
- Rule 1 is keyed on the operator, `lethal.negate-conditional`.
- Rule 2 sits beside `deletedCallHangs` (R830), so it covers EVERY operator whose site removes the call:
  `void-method-call`, and `empty-block` on a block holding it.
  - A block that ALSO holds the earlier move is not refused: emptying it removes the move too, so the cursor is not
    moved and cannot be left moved. That is M0657's own `if` block.
  - `emptiedRefusedBlockHangs` (which refuses a block if any statement in it would be refused) must not apply rule 2
    to such a block.
  - `deletedCallHangs` misses M0657 today because it reads `R.Next()` in the exit condition as the loop's progress.

A "loop over R" below is a `repeat … until C` or a `while C do` whose exit condition `C` contains a `Next` call on the
variable `R` (by name). `R.Next()`, `R.Next(1)` and `R.Next(-1)` count; any other argument does not.

## Rule 1 (`lethal.negate-conditional`): flipping the loop's own end-of-set test
Refuse when the site is inside `C` of a loop over `R` and the site is either:
- **(a) a comparison** of a `Next` call on `R` with the integer literal that means "at the end": `0` for any of the three
  forms, `1` for `Next()` and `Next(1)`, and `-1` for `Next(-1)` (the "it moved" value; `while R.Next() = 1 do` is on
  DO twice). Either order, `=` or `<>`.
  - For a `repeat` loop, the comparison at the EXACT span of `C` stays ceded to `loop-truncate`, as today (R164); a
    nested one, as in M2850, is refused.
  - For a `while` loop, any span is refused.
- **(b) a logical expression** with such a comparison as a direct operand (through parentheses), ONLY in the direction
  that can hang:
  - `or` in a `repeat … until` condition (flipped to `and`, `until (A) and (R.Next() = 0)` no longer exits at the end);
  - `and` in a `while` condition (flipped to `or`).

  The opposite flips exit sooner and stay scored. This covers a whole condition in brackets, which is not the exact span
  and so is not ceded.

Why it hangs: at the end of the set, `Next` returns 0 and does not move. Flipped, the test no longer ends the loop there,
so the loop repeats the last (or, for `Next(-1)`, the first) record for as long as the rest of `C` does not end it.
M2850's shape (invented names): `until (Found <> '') or (Setup.Next() = 0)`.

**Not refused:**
- a `Next` comparison outside a loop condition (`if R.Next() = 0 then`);
- a comparison not on `Next` (`Found <> ''`);
- `Next(n)` with any other argument;
- a loop over another variable.

**Accepted cost, named:** a refused site where the other operand always ends the loop, such as a counter bound, could
not have hung. That is lost coverage, never a wrong verdict.

## Rule 2 (every operator that removes the call): deleting a cursor restore
Refuse a site whose mutant removes a call `R.M(...)` when all of these hold:
- `M` re-positions a record cursor: `Get`, `GetBySystemId`, `Find`, `FindFirst`, `FindLast`, `FindSet`, `SetPosition`
  or `GotoRecord`;
- the call is in the body of a loop over `R`, at any depth, through inner loops over other variables too;
- EARLIER in that loop body, in source order, `R` is moved. Moved means any of:
  - assigned (`R := …`);
  - `R.Copy(…)`, `R.GetTable(…)`, `R.Open(…)`, or `R.TransferFields(…)` (R896 P1b's set);
  - another call from the re-positioning list.

  A field write (`R."F" := …`, `R.Validate(…)`) is not a move.

Why it hangs: the call restores the cursor that the earlier move took away. Without it, each iteration starts again
where the move left the cursor, so `Next` never reaches the end. M0657's shape (invented names): `Cur := Other.Duplicate();
Cur.Get(SavedId);` inside `repeat … until Cur.Next() = 0`.

**Not refused:**
- such a call before or after the loop;
- in a loop over another variable only;
- in a body with no earlier move of `R`;
- a call that does not re-position (`CalcFields`, `Modify`, `SetRange`).

**Accepted cost, named:** the move and the call in different branches (`if A then R := X.Duplicate() else R.Get(S)`)
is refused although it cannot hang. The source-order test does not follow branches. That is lost coverage only.

## Out of scope (back to R1212)
- M2284 removes a filter-setting call on the loop's record before a loop that walks that record and inserts into the
  same table. That is a filter removal; a narrow rule would need a data argument.
- `conditional-boundary` on `R.Next() <= 0` (0 sites on DO) is noted, not built.

## Pre-committed results
- **Unit tests,** each red-checked, on invented AL strings only (no fixture; R164):
  - Rule 1 positives: (a) nested `or` in a `repeat` (M2850's shape); `Next(-1)`; a `while` comparison;
    `while R.Next() = 1`; (b) the whole-condition `or` flip in a `repeat`; the `and` flip in a `while`.
  - Rule 1 negatives: `if R.Next() = 0`; another comparison in the condition; `Next(2)`; another variable's loop; the
    exact-span `until R.Next() = 0`, which stays ceded and yields no site at all; the `and` flip in a `repeat`; the
    `or` flip in a `while`.
  - Rule 2 positives: M0657's shape; the move by `Copy`; the call inside an inner loop; `empty-block` on a block holding
    the call but not the move.
  - Rule 2 negatives: before the loop; another variable's loop; no earlier move; a field write is not a move; a
    non-positioning call; `empty-block` on a block holding both the move and the call (M0657's `if` block).
  - Each refused site is counted as `hang-refused`.
- **Reach on DO,** measured with the built code by the dry-run mutation set (`generateMutationSet`, as `lethal run
  --dry-run` uses it). It compares the branch against its own merge-base, never a moving master. It runs on c4's DO
  source (`/coord/handoff/R-942/src/do-cloud`) and on PR-427's (`/coord/handoff/PR-427/do-app`). Each of these is a BLOCK
  if missed:
  - the only removed sites belong to the operators the rules name; no other operator's count moves except by sites the
    rules explain;
  - the rise in `hang-refused` equals the number of removed sites, per operator;
  - PR-427's M2850 and M0657 are removed, by site key;
  - M2284 is not removed;
  - every removed site fits its rule by inspection, listed in the result by site key with c4's and c5's verdict where
    present.
- **Reported:** the removed count per rule and per operator, and how many of them c4/c5 scored `timeout-killed`,
  killed or survived.
- **Gate fixtures:**
  - The same merge-base dry-run diff on every `fixtures/*` app is predicted to remove 0 sites. The spec review found no
    rule-1 shape; `sandbox-optin`'s `RefusedRestart` has `FindFirst` in a body with no earlier move, so rule 2 leaves it.
  - Any removal is listed and needs a pre-commitment before its gate runs.
  - Gates per `selectLegs`, including `itest:hang`: 0 moves.
