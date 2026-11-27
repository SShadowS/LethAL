# PR-472 pre-commitment (R197, R1174): `--no-kill-ledger`, a per-run opt-in on bcdev with no ledger order and so no re-walk

Coord PR-472 (lethal-preproc, 2026-11-27). Ruling (lethal-orchestrator, 2026-11-27): build option (a) as a per-run OPT-IN on
bcdev; the default stays today's (the ledger, plus R1174's re-walk). Measurement: `/coord/handoff/PR-472/findings.md`.

## Why an opt-in, not a default
- **Measured, read-only:**
  - 0 `ledger-order-survived` flips in every real bcdev store (161 scanned; only PR-327's probe, built to flip, has any).
  - Per area, R1174's re-walk costs, in seconds of test time: email 2,911, queue2 2,849, subs 1,761, narrow-tm 4,495.
  - Against those, dropping the ledger adds at most +901, +878, +69 and +1,533 s to kills.
  - On edocs the re-walk costs 0, and dropping the ledger adds up to +8,232 s (upper bounds).
- **So the trade differs per file.** DOTests can choose per run: on for survivor-heavy files (Email, Queue, Subs), off for
  E-Docs. No upper-bound guess becomes a default.

## The change
- **`lethal run --no-kill-ledger`** (`SessionConfig.killLedger: false`): every mutant's covering tests are tried in the
  no-ledger order (narrowest test first, then the name; `orderCoveringTests` with an empty ledger), so R197's reordering is
  off for the run.
- **Sound by construction.** R1174's re-walk triggers only when the ledger order crosses test codeunits against the no-ledger
  order. With the ledger off the two orders are the same, so no re-walk is asked for, and the door it guards cannot open.
- **bcdev only:** with another backend the flag is refused by name (al-runner v3 never re-walks).
- **The report gets a caveat, `kill-ledger-off`.** It names the trade: the R1174 re-walk is not needed, but a kill can take
  more tests to reach, with the per-area figures above as the reference. The flag's help text says the same.
- **Default unchanged,** so every gate and the default path move nothing.

## Proof
- **Red tests, both directions** (on the R1174 re-walk rig, `pr327c-rewalk.test.ts`'s shape):
  - flag on: the tests run in the no-ledger order, and no re-walk happens, where the ledger would cross codeunits;
  - flag off: today's ledger order and today's re-walk;
  - each red-checked;
  - the flag is refused on al-runner v3.
- **0 verdict moves with the flag on, on the bcdev fixtures:**
  - `lethal run --backend bcdev --no-kill-ledger` on sandbox-app (itest:bcdev's fixture) and on sandbox-data (itest:tables'),
    on bc2 or bc3 after setup;
  - each mutant's verdict, joined on the full site key, equals the gate's frozen baseline;
  - killingTest moves are expected (the order changes which killer is met first) and are listed, not counted;
  - any verdict move is a BLOCK.
- **Then:** VERIFY, the gates per legs.ts on the final head with the default (unchanged), and CI.
- **A note for lethal-bugs:** a LethAL change is a new pin for DOTests; the flag is off unless passed.
- **Not run now:** the scoped A/B of the real kill cost; it runs only if the default is ever reconsidered.

## Amendment 1 (2026-11-27, from the Opus build review, before any live run)
- **Correction: a verdict CAN move with the flag on, in one direction only.**
  - In the default, a mutant is killed if the ledger's order kills it, or, after a survivor, if the R1174 re-walk in the
    no-ledger order kills it. With the flag, only the no-ledger order counts.
  - So the flag's kills are a SUBSET of the default's. A kill that happens only in the ledger order, because it rests on state
    an earlier-run test codeunit left, is a SURVIVOR with the flag.
  - Arguably that is the more honest verdict, since the kill depended on test order. But it is a verdict move, and the text
    must say so.
  - The caveat, the help text and this spec say exactly that: killed -> survived only, for order-dependent kills; never
    survived -> killed.
- **The proof on the fixtures, restated:**
  - expected 0 verdict moves on sandbox-app and sandbox-data with the flag on, since their tests are not written to share
    state across codeunits;
  - a move from killed to survived is reported by site key with its killer and the no-ledger walk, and checked to be
    order-dependent (it is not a BLOCK by itself);
  - any move from survived or no-coverage to killed, or any other direction, is a BLOCK;
  - a red test pins the one direction on the R1174 rig.
- **Resume and lending cannot mix the two modes:** `killLedgerOff` joins the resume fingerprint only when on (as
  `v3CarryWalkOff` does), and a resume across a change of the flag is refused by name.
- **Also added:** a test of the CLI-to-session wiring (`runFromCliWithAccept`); the flag's row in README's run-flag table;
  and the resume message no longer claims a carried kill seeds the ledger when the flag is on.
