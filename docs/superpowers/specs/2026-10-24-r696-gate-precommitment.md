# R-696 (R696): gate pre-commitment

Written before any gate runs on `lethal/r696`. The change is R696's hang refusal for loops that move the record they
walk: `inMovedWalk` in `loop-hazard.ts`, shapes B (Next-driven loops) and A (report data items). It also files R702 and
adds a note to R529. The measurement, the probe and the plan are in `/coord/handoff/R-696/`; the probe's own
pre-commitment is a67f292f.

## Prediction

**No gate figure changes.** Every gate's verdicts, killing tests, notes and refusals stay equal per mutant to its
committed baseline.

Why: asked of every node of the 21 `fixtures/*` projects that have an `app.json`, the production predicate refuses
**0** nodes that master does not (`/coord/handoff/R-696/scripts/fixcount.ts`, seam off against on). No fixture holds a
Next-driven loop that moves the record it walks, or a report data item that does.

## Legs

From `selectLegs` on the diff's paths:
- `packages/builtin-tier1/` selects `itest:bcdev`, `itest:tables`, `itest:chunked` and `itest:alrunner-v3`;
- `itest:alrunner-v3` runs all 12 legs (`LETHAL_ITEST_V3_TABLES=1`, `LETHAL_ITEST_V3_CDO=/work/lethal-wt/cdo-r396`);
- the docs paths, `CHANGELOG.md` and `ROADMAP.md` select none.

Each BC gate runs on a server whose proof row in `docs/gates/servers.md` lists it, under a coord lease.

## What counts as a failure

- Any differing verdict, `killingTest`, note set or refusal set on any leg is a BLOCK.
- A failing leg is not re-recorded. The prediction above was wrong, and the cause is found first.
- The hang shapes (the journal renumber loops, Resend Attachments, Update Contract Prices) are proven offline only
  (R164). No fixture is added for them.

## Recorded for the record (not a gate figure)

**Known stops.** On BaseApp, the production predicate refuses all five known forever stops; master refuses none
(`/coord/handoff/R-696/m10.md`).

**Cost on the final code.** Specs removed against the rule off:

| Corpus | Removed | Of | Share |
|---|---:|---:|---:|
| BaseApp | 6,495 | 743,985 | 0.87% |
| DC | 1,257 | 200,517 | 0.63% |
| DO | 239 | 81,017 | 0.29% |
| CDO | 150 | 57,376 | 0.26% |
