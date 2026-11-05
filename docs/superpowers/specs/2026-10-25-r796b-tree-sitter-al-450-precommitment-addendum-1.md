# R796 pre-commitment, addendum 1 (2026-10-25): a hang guard for `#if`-split loop conditions

Adds to `2026-10-25-r796b-tree-sitter-al-450-precommitment.md` (c83e530c). Written after the build
(lethal/r796b 352ff081) and BEFORE any corpus dump or gate run of it.

## Why
- 4.5.0 parses some shapes that 4.4.1 refused whole. One of them is a loop condition split by `#if`:
  `while #if X (B < 5) or #endif (A < 10) do`. That condition is now a `preproc_operand_prefix` node.
- `loopConditionParts` (`loop-hazard.ts`) did not read that node. So `B := B + 1` in the body became a
  `remove-assignment` site, and removing it can hang the loop. That is a hang-capable site outside `itest:hang` (R164).
- The build fixes it: `loopConditionParts` reads `preproc_operand_prefix`, and `flip-boolean-literal` walks through it.
  These two source edits are not in the original pre-commitment.

## The amended prediction
- The guard can only REFUSE sites, or tag them hang-capable. So against the original table it can only:
  - lower BC.History's or DC's added count;
  - raise the removed count;
  - change a hang count.
- Every such row must be in a loop whose condition holds a `preproc_operand_prefix`. Each one is listed, file and
  operator, in the R796 text.
- If the dumps show no difference from the original table, the guard reached no corpus site. That reading is also
  accepted.
- Any OTHER difference from the original table is a BLOCK, as before.

## Also written down (no figure change; filed as R801)
- Ten R402 sweep shapes refused under 4.4.1 are admitted under 4.5.0: c7b, c7e, c7f, c8, s4, s4b, s4c, s4d, s8 and s12. Their spec counts are pinned in `scripts/fixtures/r402/expected.json`.
- Before the submit, `scripts/r402-shape-sweep.ts` (its alc half) must compile each one's instrumented artifact under all four builds. Any compile failure is a BLOCK.
- Fixtures, CDO and DO stay identical, and no gate figure moves, as originally pre-committed.
