# R969: the `itest:lend` leg RL (resume across a lease reset) — pre-commitment

Coord task PR-04, part 1. Written and committed before the first live run of the leg. R969's built half (LethAL Control 1.0.0.26,
R-990): a `--resume-run` across a lease reset carries verdicts when the database id is unchanged. This leg is its live proof.

## What changes in the gate
1. Every session of `lend.itest.ts` reads the database id from the same `HarnessInfo` read as the generation, as the CLI does
   (`cli.ts`, R969 review). Until now the gate's sessions recorded no database id, the safe direction: a resume across a reset
   refuses.
2. L0 also asserts that run A records a non-empty database id.
3. A new last leg, RL, after RP (the reset changes the generation that the earlier legs' snapshot reuse depends on):
   - Seed `LR = seedRunFrom(store, A)`: an unfinished full clone of A. `seedRunFrom` copies the database id (R680's trap, done in R-990).
   - `performForceResetLease(odataCfg)`, the mechanics of `lethal force-reset-lease`, with no restart.
   - Session RL with `--resume-run LR`.

## Predictions (on bc1, LethAL Control 1.0.0.26, the current fixtures)
Every earlier leg (L0 to RP) passes unchanged: same codes, figures and per-mutant table. The database id changes nothing while the
generation is unchanged.

Then:
1. The reset returns `reset`, and the new generation differs from the old one. The old one equals run A's recorded generation.
2. RL's lend-site warnings are exactly `resume-reusing-run` and `resume-across-lease-reset`.
   - There is no `resume-baseline-reused`: the snapshot is keyed on the generation, and none exists under the new one.
3. The `resume-across-lease-reset` text contains `carrying run LR's verdicts across a lease reset: database id <A's id> unchanged,
   server generation <old> -> <new>`.
4. `resume-reusing-run` names LR and 22 carryable (`LEND_FIGURES.resumeWhole.carryable`, as R1).
5. RL ran its baseline here (`ranHere` > 0) and deployed once (R621: a batch holding a stored no-coverage is not carried whole).
6. The carried mutants are, by key, every mutant but the 5 no-coverage ones (`carriedInPartBatch(ALL)`, as R1).
   `resumedFrom` = `{ runId: LR, carriedMutants: LEND_FIGURES.resumeWhole.carried, skippedStranded: 0 }`.
7. RL's per-mutant table equals `bcdev.baseline.json` (`assertFrozen`): every carried verdict equals the seed's.
8. RL's run row records A's database id and the new generation.

## Not measured here
The negative leg: a real in-memory restart changes both ids, and the resume refuses. It waits for the next server1 restart (R969).
`groupedCalls` of RL is printed, not predicted: R1's figure belongs to a reused snapshot.

Any difference from 1-8, or any earlier leg moving, is a BLOCK to explain before submit.
