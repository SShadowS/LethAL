# R-522 (R530): gate pre-commitment

Written before any gate runs on `lethal/r522`. The change is R530's hang refusal for self-inserting report data
items (`inSelfInsertItem` in `loop-hazard.ts`, plus a widened `altersOpenItemFilter`). It also closes R522 and
R524-R529 by ruling and files R696. Measurement: `/coord/handoff/R-522/measure.md`.

## Prediction

**No gate figure changes.** Every gate's verdicts, killing tests, notes and refusals stay equal per mutant to its
committed baseline.

Why:
- No fixture report calls `Insert`, so no fixture item is self-inserting.
- The new predicate, asked of every node of all 22 `fixtures/*` projects on the build head, refuses **0** sites
  (`/coord/handoff/R-522/fixcheck530.ts`, output `fixcheck530.out`).
- The widened `altersOpenItemFilter` adds only self-inserting items, of which the fixtures have none.

## Legs

From `selectLegs` on the diff's paths: `packages/builtin-tier1/` selects `itest:bcdev`, `itest:tables`,
`itest:chunked` and `itest:alrunner-v3`. The docs paths, `CHANGELOG.md` and `ROADMAP.md` select none.

Each BC gate runs on a server whose proof row in `docs/gates/servers.md` lists it, under a coord lease. A gate
prints "identity scheme changed" lines only while its baseline lags `IDENTITY_SCHEME`. Those lines are not a
difference.

## What counts as a failure

Any differing verdict, `killingTest`, note set or refusal set on any leg is a BLOCK. If a leg fails, the gate is
not re-recorded. The prediction above is wrong, and the cause is found first.

Hang-capable sites (the three BaseApp reports) are proven offline only (R164). No fixture is added for them.
