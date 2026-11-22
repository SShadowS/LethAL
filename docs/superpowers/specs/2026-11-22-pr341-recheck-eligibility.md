# PR-341 pre-commitment (R1178): keep the first withheld-ELIGIBLE held error, so PR-144's recheck does not depend on walk order

Status: pre-commitment (coord PR-341, lethal-preproc, 2026-11-22), before the build. Rulings (orchestrator, 2026-11-22): part
1 is this flag-independent fix; part 2 (the bound-check cost of refusedCutTail's tail calls, R1156) is design only, in a later
note. Evidence: `/coord/handoff/PR-302/`, `/coord/handoff/combined-do/`, and R1178. Names and numbers only.

## The defect (R1178)
- PR-81 holds a walk's `error` and goes on. Only the FIRST held error is kept (`orchestrator.ts`, `heldErr`); later ones are
  only noted.
- At the end, `adoptHeldError` gives the mutant that first error's note. PR-144's recheck picks a mutant only when that note
  is a withheld kill (`withheldKillOf`, rule (a)).
- So whether a mutant is rechecked depends on which held error the walk reads first, which depends on R197's ledger order.
- On DO, t1's resume read the plain `Report.SaveAs` refusal first for M2519, M2548 and M2549. c2 had won them back through
  the recheck; in t1 they stayed `error`.

## The change
- At the hold: if the kept held error is not withheld-eligible (`withheldKillOf(verdict, cause, failureNote) === undefined`)
  and this held error is, this one becomes the kept one, and the old one moves to the noted list. Otherwise unchanged
  (first kept, later noted).
- The mutant's verdict stays `error` (cause `runner-refused` either way).
- Only `failureNote` can change, and only from a non-eligible note to an eligible one of the same walk. PR-144's rules (b)-(e)
  still decide any recovery: the kill reproduces in the recheck, the killer passes alone at the recheck baseline, the same
  build and source, and nothing is lost.
- No flag. It is a correction, so it applies to every run.

## Predictions
- **v3 gate:** a verdict can move only in leg RC (`sandbox-recheck`, the one leg with `recheckWithheldKills` on), and only if
  it has a mutant with two or more held errors where a non-eligible one comes first.
  - Before any gate, I scan the gate fixtures' frozen v3 baselines and reports for such walks. The prediction (moves, or
    none) is recorded in an amendment before the gate runs.
- **BC gates:** unaffected (`withheldKillOf` and PR-144 are v3 only; the hold rule is shared, but on bcdev
  `runner-refused` errors are not produced the same way). The scan covers them too.
- **Tests (red before the build):**
  1. a walk holding a non-eligible error and then an eligible one keeps the eligible note (so `recheckTargetsOf` lists it);
  2. eligible first, then non-eligible: unchanged, the first kept;
  3. two non-eligible: unchanged;
  4. the verdict and cause stay `error` / `runner-refused` in 1-3.

## Not in this change
- R1179 (carried kills never reach the ledger on `--resume`) is filed separately. It is a design question, and it was found
  here.
  - The orchestrator's ruling: seed the ledger from the carried kills in scoring order. That is PR-341 part 3, with its own
    pre-commitment.

## Amendment 1 (2026-11-22, the gate scan, before any gate)
- **The scan:** every committed frozen baseline (`packages/runner/itest/*.baseline.json`, the v3 legs' and the BC gates'),
  every string field. Not one note contains "after the error:", the text a walk that held two or more errors writes.
- **So no gate fixture has a walk with two held errors,** and this change can move no gate's verdict or note.
- **Prediction:** every gate leg (v3 and BC) passes unchanged, the RC leg included.
- **Unit suites:** pr81, pr51, pr144, orchestrator, resume, pr116 and pr225 pass with 0 snapshot moves (1,187 + 119 tests).
- **The fix's red check:** the new test "a non-eligible held error, then an eligible one" was red before the change and is
  green after it.
