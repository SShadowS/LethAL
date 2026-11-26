# PR-455 (R1228): the re-confirm sample, what counts as a degraded tier — pre-commitment

lethal-code, 2026-11-26. This is written BEFORE any re-score. The live steps belong to lethal-bugs, on bc4, which was
freshly restarted (orchestrator). Evidence and lists: `/coord/handoff/PR-455/` (`findings.md`,
`sample-{edocs,queue2,subs}.tsv`). Counts and site keys only; the apps are a private ISV's.

## Why

- History cannot separate a degraded BC tier from a healthy one (`findings.md`):
  - failure-rate and call-profile drift are set by each project's tests;
  - kill concentration does not separate;
  - disagreement with al-runner rises late in three runs, but later mutants are other code.
- So we re-score a sample of kills on a FRESH tier. A kill made by a healthy tier should reproduce on a fresh one.

## The sample

- **Per area,** 15 LATE kills and 15 EARLY kills (the control): every kill of the period, sorted by old mutant id and
  evenly spaced.

  | area | late | early (control) |
  |---|---|---|
  | edocs | 8.9-11.04 h (15 of 44) | 0-8.9 h (15 of 31) |
  | queue2 | 2-3 h (15 of 43) | 0-1 h (15 of 132) |
  | subs | 5+ h (15 of 44) | 1-3 h (15 of 77) |

- **The control's code:**
  - edocs' and subs' early controls are from the same files as their late kills, so they are code-matched;
  - queue2's control is from OTHER code: late `CDOQueueEntry.Table.al`, early `CDOEMailJob.Table.al`. Its verdict
    rests on the absolute rule below more than on the gap.
- **The join** is lethal-bugs': the full site key (file, startLine, operator, startIndex, endIndex), never the old
  M-id, because fresh runs renumber.

## What is counted

- **A flip:** an old `killed` re-scored as `survived` (or as no longer reached: `no-coverage`).
- **An error re-score** (`error`, refused, stranded) is NOT a flip. It is counted and listed apart, and it shrinks
  that period's denominator.
- Per area and period: flips / re-scored (excluding errors).

## What counts as degraded (per area)

- **DEGRADED** when both hold:
  - late flips ≥ 5 of the re-scored late kills, AND
  - late flips − early flips ≥ 4.
  - Because queue2's control is other code, queue2 needs late flips ≥ 6, whatever the gap.
- **NOT DEGRADED (it was the code, or the tier was healthy)** when late flips ≤ early flips + 1.
- **INCONCLUSIVE:** anything else, or either period with fewer than 10 re-scored. It is reported as such and never
  rounded.
- **Bounds.** A healthy tier should re-score its own kills as kills, so a gap of 4 or more out of 15 is far beyond
  ordinary noise. The early flip count of each area is itself the measured noise floor of re-scoring on a fresh tier.

## What the result decides

- **If 2 or 3 areas are DEGRADED,** R1228 is common: tiers degrade with renews answered, within hours. The detector
  must then fail closed, latching like PR-454 and invalidating since the last good check, and must be strong.
- **If only edocs is DEGRADED,** R1228 is rare, tied to a lease-trouble episode. A canary that starts advisory
  (principle 4) is right-sized.
- **If none is DEGRADED,** edocs' late disagreement came from the code, and R1228 is re-scoped.
- **email and subs are taken as healthy** only if subs reads NOT DEGRADED.

## Cost (for lethal-bugs' window)

- **Per area,** a fresh run of the narrowed scope:
  - setup up to the first scored mutant: edocs 36 min, queue2 4 min, subs 8 min (from the original runs);
  - plus about 30 sites.
- **A kill that reproduces** costs one call (healthy kills took 34-86 s on average). A flip costs its whole covering
  set, up to the 330 s cap per call.
- **Expected:** about 2 h with few flips, up to about 4 h if many flip. The cost itself is a signal.
