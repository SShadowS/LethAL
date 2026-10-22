# R-572 live gates on the final head: pre-commitment

Committed by lethal-code on 2026-10-22, before any live gate ran on `lethal/r572` at 81a74d28.

## Why
The corpus re-prices (`2026-10-21-r572-reprice-precommitment.md`, `2026-10-22-r572-reprice-precommitment-r2.md`)
prove the mutant SETS. They do not prove the live gates on the final head. Two changes touch every gate:
- `IDENTITY_SCHEME` goes from 40 to 41, which changes every mutant key. The frozen baselines are keyed by key, and
  are read across schemes by mutated-text hash.
- R572's refusal rules run inside every gate's mutant generation.

## Prediction
Each gate below gives the SAME verdict for every mutant as its committed baseline, with its pinned extras, as listed
on its page under `docs/gates/`:
- `itest:bcdev` on a bc server;
- `itest:tables` on a bc server;
- `itest:hang` on a bc server (the loop and hang fixture);
- `itest:alrunner -- --parallel=3`, every leg.

None of these fixtures has a loop shape that R572 newly refuses: the fixtures set's re-price delta was 0 in both runs.
So no mutant leaves any gate.

## Stop rules
- **A differing verdict** is a BLOCK, recorded per mutant.
- **A key-only refusal.** If a gate refuses to compare, or fails, because of the scheme bump ALONE (keys that no longer
  join, with verdicts not compared), that is a STOP, reported to the orchestrator. It needs a re-record under R332
  with its own pre-commitment, never a quiet fix.
- Each gate's first line (`[itest target]`, or the al-runner build) is recorded with its log.
