# R-924 pre-commitment (2026-11-11): legs MOE and WRE, serve-entries for the multi-object and #if-wrapped shapes

Committed before the gate run that proves coord task R-924 (roadmap R918). Fast track, as R763: one observe run measured
the figures, and this file freezes them. Code: lethal/r-924 from master 8197dfac. Binary: the pinned `current`,
al-runner 3.0.0-alpha.14+edge.20261111 (42af5d384), pin edge-d72d3197d. Receipt: `/coord/handoff/R-924/observe-mowr.log`
(legs MO, MOE, WR, WRE: all four PASS).

## Legs MOE and WRE (join `V3_GATE_LEGS` and the default legs)
- **What they run:** MO's and WR's sessions unchanged (fixtures, ids, symbols, coverage on, `isolation: "test"`), with
  `transport: "serve-entries"`.
- **Pinned, each against its one-shot leg:**
  - the same checks: the `none`-kill killers, the counts (MOE **7 / 1 / 6** over 14; WRE **62 / 37 / 3** over 102), the
    WrappedArms refusal (WRE), the clean-leg checks with WR's state notes (WRE);
  - **0 per-mutant differences** against the ONE-SHOT legs' frozen baselines (`al-runner-v3.multiobject.baseline.json`,
    `al-runner-v3.wrapped.baseline.json`), compare only: a serve leg never records;
  - `GATE_WARNINGS`: `al-runner-v3/MOE` = `[]` (as MO), `al-runner-v3/WRE` = `["compiled-out-sites",
    "coverage-refused-mutants", "coverage-refused-object"]` (as WR);
  - serve counters: MOE warmups **1**, liveRequests **1**, boundChecks **3**, entriesSent **46**, pairRequests **7**,
    echoMismatches **0**; WRE warmups **1**, liveRequests **1**, boundChecks **3**, entriesSent **448**, pairRequests
    **62**, echoMismatches **0**.

## The widening this proves
The serve-entries DEFAULT no longer falls back for `multi-object-or-wrapped`. R761 kept the shapes off serve only because
they were measured on one-shot only; MOE and WRE measure them equal to one-shot per mutant. What stays shape-specific is
coverage placement, and the coverage index is built from the deployed text the same way under both transports (an object
it refuses, like WR's two-arm control, reads no-coverage on both). The name-shape check is unchanged (the `-` in a codeunit
name is R922, coord R-919).

## Every other leg
Unchanged, with the same figures. MO and WR keep refusing a non-one-shot `LETHAL_ITEST_V3_TRANSPORT`, as before.
