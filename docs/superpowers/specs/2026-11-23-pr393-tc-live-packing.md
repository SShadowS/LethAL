# PR-393 pre-commitment: a live exercise of PR-344's tail packing in leg TC (R1198)

Status: pre-commitment (coord PR-393, lethal-preproc, 2026-11-23), before the build. Related: [[R1198]], PR-344, PR-347
(`2026-11-23-pr347-refused-cut-tail-default.md`, the TC table), R849.

## Why
`refusedCutTail` is on by default since PR-347, and PR-344's packing with it. Packing has never run live. On DO after PR-365
and in TC, every refused-cut mutant has exactly one stable tail test, so every pack set is one test and 0 packs are sent
(R1198).

## The change: one procedure and two tests in the tailcut fixture
- `fixtures/sandbox-tailcut`, codeunit 76100, gains `procedure Halve(N: Integer): Integer begin exit(N div 2); end;`.
- `fixtures/sandbox-tailcut-tests`, codeunit 76150, gains, after T5:
  - `T6_HalveZero`: `Halve(0) = 0`;
  - `T7_HalveTen`: `Halve(10) = 5`.
  Both are stable tail tests (they read no global).
- **The census** (`scripts/census-fixture-mutants.ts` on the new target, run before this spec): 12 mutants, the 10 of
  PR-347's table plus two on Halve, `lethal.empty-block` (returns 0) and `lethal.return-value` `exit(0)`.

## The per-mutant table: the 10 rows of PR-347 unchanged, plus
| site | mutation | off | on (default) | alone truth |
|---|---|---|---|---|
| Halve | empty-block (returns 0) | `error` (cut) | killed by T7 (alone) | killed by T7 |
| Halve | `exit(0)` | `error` (cut) | killed by T7 (alone) | killed by T7 |

Both return 0: T6 passes (0 div 2 = 0) and T7 fails (0 is not 5). So the killer is T7 whichever tail test the walk reaches
first. Counts: TC-on is 10 killed, 1 survived, 1 error; TC-alone is 10 killed, 2 survived; TC-off is 2 killed, 10 error.

## The judge
- **(a3) A real pack was sent, asserted right after (a2):** TC-on's `refusedCutTailStats().packs` is exactly **2**, one per
  Halve mutant. Each Halve mutant's first tail call packs [T, its mate]; reproductions are forced calls and never pack; no
  other mutant has two stable tail tests. `failedPacks` is 0.
  - `servedFromPack` is recorded, not pinned: it is 1 per mutant if the walk reaches T6 first, 0 if T7 first.
  - A failure names the counts and fails before (b).
- **(b)-(d) and (f)** take the two new rows. (c)'s one exception stays IsBig `N >= 5`. (f)'s counts are unchanged (the Halve
  mutants are killed in both TC-on and TC-alone).
- The stable list in the stability notice becomes T1, T2, T3, T5, T6, T7; T4 stays unstable.

## The baseline (R332 and R849, all in the branch, never on master)
1. Delete `al-runner-v3.tailcut.baseline.json` in the branch.
2. Commit the R849 expected file `itest/expected/al-runner-v3.tailcut.baseline.json` in the branch, built by
   `/coord/handoff/PR-347/build-expected.ts` from the new `TC_TABLE` (verdicts and killers from the table, never the run).
3. Record once (TC leg only), then review: it must equal the expected file.
4. Commit the baseline, and delete the expected file (R849 calls it stale once equal).
5. Confirm with a TC-only run, then the full v3 gate on the final head.

## Red checks
- **Live, in an uncommitted scratch worktree, TC leg only:**
  - (1) break packing (`tailPackMates` returns no mates): (a3) goes red with packs 0;
  - (2) corrupt a packed result (a stored mate row has its outcome flipped before it is stored): (b) goes red on the Halve
    rows.
- **Unit:** each new judge clause red in both directions, as for (a1)-(f).

## Predictions
- **TC:** (a1)-(f) and (a3) hold with the table above.
- **Every other v3 leg:** unchanged (no other fixture changes).
- **BC gates:** unchanged (the flag and the fixture are v3-only).
- **R1198 closes:** packing runs live in TC, with 2 packs sent.
