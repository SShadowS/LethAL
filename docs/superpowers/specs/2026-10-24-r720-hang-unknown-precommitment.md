# R720 / R721 pre-commitment: R196's hang check matches an "unknown" target by name

Coord task R-327b, lane lethal-code. Branch `lethal/r327b`, code at `bc0f9a8f` (fix `a6a1a022`, follow-up `bc0f9a8f`).
Committed to master before any live gate runs on the branch.

## The change
`classifyHangCapable` (`packages/builtin-tier1/src/loop-hazard.ts`) used to decline when a loop write's target did
not resolve. Now it matches the target by NAME against the enclosing loops' exit conditions and any enclosing `for`'s
control variable (`loopReadsNameAt`) when the engine's three-state lookup (`declarationStateAt`, new in
`packages/engine/src/semantic/receiver.ts`) says "unknown" rather than provably absent. The same applies to a member
target's receiver. This covers:
- members swallowed into the global var section (R720);
- globals declared inside a var-section `#if` (R721);
- every-arm-ambiguous names (R302);
- the `for` control variable in R-364's unindexed objects.

It only adds refusals.

## Offline evidence already in hand
- **Fixtures corpus diff** (`bun scripts/corpus-snapshot.ts diff fixtures --branch`, merge-base `a913261f`): 23
  projects, added 0, removed 0, tuples moved 0, ordinals moved 0, tags changed 0. **Identical.**
- **Shape sweep** (`scripts/r402-shape-sweep.ts`): 168 cases, problems 0.
- **Unit tests:** `r720-unknown-hang.test.ts` (15) is red-checked in each direction.

## Predictions for the live gates (selectLegs: bcdev, tables, chunked, alrunner-v3)
The fixtures emit the identical mutant set, so for every gate:
- every frozen per-mutant row (verdict, `killingTest`, note set, refusal set) is **unchanged**;
- every total is unchanged;
- no baseline is re-recorded.

Any difference is a BLOCK.

Both hang shapes are proven offline only (R164): no hang-capable site enters any gate other than `itest:hang`, and
this change adds none.
