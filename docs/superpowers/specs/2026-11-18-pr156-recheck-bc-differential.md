# PR-156 pre-commitment (measure only): the BC differential for PR-144's isolated recheck (its P5)

Coord PR-156 (lethal-code, 2026-11-18). PR-144's recheck (opt-in, default off) turns a v3 withheld kill into a kill when the kill
reproduces with its test run alone. Its spec's P5: no default-on until BC confirms the recheck's kills. Fixture: PR-162's
`sandbox-recheck` and `sandbox-recheck-tests` (invented code, ids 76000-76099). Leg RC records v3's side; its page is
`docs/gates/alrunner-v3.md` §"Leg RC".

## Part (a): the fixture on BC
- **Where:** bc2 or bc3, under lethal-code's own lease. The publish is not covered by `bc-linux-setup.ts`, so it needs the owner's
  yes: q-20261118T191953-72a792ca. Nothing runs before it.
- **How:**
  1. Build both projects against that server's symbols (`alc`), publish the target and the tests app by content.
  2. Run one `lethal run --backend bcdev` with `--project fixtures/sandbox-recheck --tests fixtures/sandbox-recheck-tests`, a fresh
     store, `--stop-hung-sessions` and selector ids inside 76000-76049.
  3. Afterwards uninstall (data deleted) and unpublish both apps, the tests app first.
- **The v3 hang check:** leg RC already ran this exact scope on v3, with 0 timeout-killed (`/coord/handoff/PR-162/rc-confirm.log`).

## What is compared (the `lethal.remove-assignment` mutant of `C := '7'` in each procedure, by full site key)
| mutant | recheck (leg RC, recorded) | prediction for BC |
|---|---|---|
| `Sevens` | `killed` by `A1_OneSeven` | **`killed` by `A1_OneSeven`**: it asserts `Sevens(1) = '7'` directly, and nothing earlier in its codeunit feeds it. BC confirms the recheck's kill. |
| `SevensB` | `error` (rule (e) holds it back: `B2_SeesTheMark` passes in a codeunit run and fails alone) | **`killed` by `B1_OneSevenAndMarks`**: B1 asserts `SevensB(1) = '7'` itself. The recheck's `error` is then the conservative side: a kill it withholds, never a false kill. |

- **What this fixture does and does not test.**
  - It tests that the recheck's one kill (`Sevens`) is real on BC.
  - It does NOT contain P5's harder shape: a kill whose ONLY killing test depends on state an earlier refused test set. Here B2's
    dependence on `Marked` is not on SevensB's killing path, because B1 kills first.
  - So this part can confirm a recheck kill. It cannot show the false kill H1 warns of; part (b) samples that on real code.
- **`A0` and `B0` on BC:** they `Evaluate` a 10-NUL text into a Decimal, then `Error` when it does not parse. BC's answer is not
  predicted; it is recorded (red or green) and decides only the baseline-red caveat on BC.

## Part (b): a sample of DO's 294 recovered kills on bc4
- **Needs its own owner yes:** q-20261118T191953-697aec50. If it is allowed, its sample and predictions are pre-committed in an
  amendment here, before it runs.

## Predictions (part a)
- **P1:** BC `killed` the `Sevens` mutant, by `A1_OneSeven`: the recheck's kill is confirmed.
- **P2:** BC `killed` the `SevensB` mutant, by `B1_OneSevenAndMarks`: the recheck's `error` is conservative.
- **If P1 breaks** (BC does not kill `Sevens`): the recheck's only kill here is false on BC, the option stays off, and PR-144's rules
  are revisited.
- **If P2 breaks:** recorded and explained; it does not make a recheck kill false.
