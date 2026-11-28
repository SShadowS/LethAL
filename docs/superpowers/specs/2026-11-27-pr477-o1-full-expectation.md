# PR-477 (R1149): restore leg O1's full corpus-set expectation — pre-commitment r1

lethal-code, 2026-11-27. Written after measuring the trigger and before any code.

## The trigger is met (measured)

- **Run:** leg O1 alone (`LETHAL_ITEST_V3_LEGS=O1`) on `current` = edge-e5176a9fd (sha256 9b0e90bd…), 2026-11-27
  (`/coord/handoff/PR-477/o1-current.log`).
- **Result:** in the CDO set, every W entry's 8 write tests and every C entry's 6 commit tests PASS: InsertRow,
  InsertDepRow, CommitLocalRow and CommitDepRow included, in all 8 W and C entries.
  - The f9116dc96 row-insert refusal is gone (#8239's fix).
  - O1 passes, but today it judges those 4 tests as "pass, or HELD when refused by exactly the f9116dc96 text (no pin
    field)".

## The change

- `judgeOrderProbe` (itest/alrunner-v3-legs.ts) LOSES the held path: the branch that turns "refused with exactly
  `O1_PARTNER_LOGIN_TEXT`" into `held` when the pin has no `o1.partnerLoginRefusal`.
  - Without a pin field, the 4 partner-login row-insert tests are judged like every other W or C test: anything but
    `pass` is a `gate-fail`.
  - The "all or none" bookkeeping (`partnerHeld`) goes with it.
- **The `pinned` path STAYS.** `main-ccd0f823d`'s pin (al-runner-v3-pins.ts) carries `o1.partnerLoginRefusal`, and a
  gated build that still refuses needs it.
  - No gated build relies on the held path: a `held` O1 does not pass the update gate, so every accepted build either
    passes O1 or carries the pin field.
- No pin changes: edge-e5176a9fd's pin has no `o1.partnerLoginRefusal`, which is right for a build that passes.

## Pre-committed

1. **On current (e5176a9fd), leg O1 PASSES with the held path removed.** The full v3 gate (all legs, tables on) PASSES
   too, and the update gate's O1 against current is unchanged (pass).
2. **Unit tests (r784-order-probe.test.ts), red both ways:**
   - (a) no pin field, the 4 tests refused with exactly the f9116dc96 text in every W and C entry → `gate-fail`.
     Today: `held`; red if the held path is put back.
   - (b) no pin field, all pass → `pass`.
   - (c) the pinned path: with `pinned`, exactly-refused → pass (as today); a pass there → `gate-fail` (as today).
   - (d) no pin field, a PARTIAL refusal → `gate-fail` (as today, now through the ordinary rule).
   - Existing tests that pinned `held` are re-pinned to `gate-fail`, each named in the result.
3. **R1149 → done**, naming this run and the pinned build that keeps the field.

## Not in scope

- Removing `o1.partnerLoginRefusal` from the pin type: a gated pin (main-ccd0f823d) uses it.
