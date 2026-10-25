# R771 pre-commitment, addendum 1: one pinned refusal message text moves (no verdict)

Coord task R-771. On master BEFORE the pin fix it predicts. Amends
`2026-10-25-r771-edge-a157b2d34-pin-precommitment.md`.

## What happened
Step 2 (`--edge-rejudge a157b2d34` at a0b6e49c, 18:25Z) came back `held`, so `current` stayed `edge-dcdf9e821`
and step 3 did not run. Receipt: `/work/tools/al-runner-v3/rejudge/edge-a157b2d34@a0b6e49c1de71917ac973b05ac74d73022fccd10/receipt.json`.
Every leg passed except C. Every other prediction held: `PIN edge-a157b2d34 applies`, X (b) pinned,
`T: pinned 7 rows`, N1E pinned pass, K skipped, X (d) 2 / 3 / 0 with "Sleep rule RETIRED".

C held on one fact, `duplicate-key-insert-raises`: `pin-mismatch: pinned refused, read refused`. The verdict is the
pinned one (`refused`, BC differs, #5788). Only the refusal message text differs:
- pinned (alpha.5's, via `ALPHA5_READINGS`): `... whether the test runner raises it at the end of the test is not pinned`
- measured on a157b2d34: `... whether the test runner raises it at the end of the test is measured only for
  TestIsolation = Codeunit and the default TransactionModel`

The held 16:09 `gate.log` (`/work/tools/al-runner-v3/held/edge-a157b2d34/`) already showed the new text. The
original pre-commitment's "Leg C ... IDENTICAL to edge-dcdf9e821" was wrong on this one message: a misreading, not a
build change.

## The fix
The `edge-a157b2d34` pin overrides only `legC["duplicate-key-insert-raises"].measured` with the new text; verdict,
`bc`, issue and evidence are unchanged. `ALPHA5_READINGS` is not edited, so the alpha.5 and dcdf9e821 pins cannot
move. A test shows the old text is held on the a157b2d34 pin.

## Predictions (replacing steps 1-3 of the original; sequenced by the orchestrator after R-784 and R-788)
1. `--regate <last of the pin fix, R-784 and R-788 merges>` for current (`edge-dcdf9e821`): as each of those
   pre-commitments predicts; outcome `pass`.
2. `--edge-rejudge a157b2d34`: as the original step 2, the seven `C: pinned:` lines (six `gone` plus
   `duplicate-key-insert-raises` `refused`), no `pin-mismatch` and no `C: held:` line, and outcome `pass`; `current` moves.
3. As the original step 3.
