# Upstream repros (R-996)

Every invented repro LethAL filed upstream at aldevtools/BusinessCentral.AL.Runner, as one regression set. Each folder is one
AL app with test codeunits and no corpus source text. `manifest.json` names, per repro, its issue, where BC's result comes from
(`bcEvidence`: measured on BC, or inferred from the issue), what to re-run when it flips (`rerun`: projects, roadmap items) and
BC's result per test (`tests`).

`bun scripts/upstream-repros.ts --candidate <al-runner> [--current <al-runner>]` runs every repro on both builds and reports per
test: `flipped` (now matches BC: re-run what it names), `regressed` (matched BC on current, not now: a finding), `still-differs`,
`still-matches`, or `error` (the repro did not run). The daily update (`al-runner-v3-update.ts`, `gateOne`) runs it for every new
candidate and logs the report; it never decides the gate.

Adding a repro: a folder `u<issue>-<topic>` with `app.json` (its own app id) and `src/`, an entry in `manifest.json`, then
`bun scripts/upstream-repros.ts --candidate /work/tools/al-runner-v3/current/al-runner` to see it run. A repro must run with
`al-runner test --bc-version 28 <folder>` alone (no package cache), as these do. A repro of several apps (an install order) keeps
each app in a subfolder and lists them, in the order `al-runner test` takes them, in the entry's `apps` (R-997: `u8056-install-order`).

## Coverage (R-997)

In the set (13 repros, 44 tests, about 50 s for both builds): #7811, #7812, #7818, #7819, #7853, #7854, #7922, #8006, #8027,
#8032 (two apps), #8036 (its nine named tests), #8038, #8056. These are the issues the open roadmap items cite as their own finding.
BC's result is measured only for #8006's values; every other expectation is inferred from its issue, and `bcEvidence` says so.
#7853 is closed and passes now: it stays as a guard.

Not in the set yet: issues an open item cites as related, without a repro of their own here: #7832, #7834, #7924, #7934, #7964
(R995, R946; some of their cases are tests in `u8036-refusals` that the manifest does not compare). Not in the set on purpose:
`/coord/handoff/R-982/repro-tenantset` (no open issue) and `/coord/handoff/R-985/repro2` (#7760, which no open item cites).

`u7853-system-grant` borrows Microsoft's Guided Experience app id, name and publisher, because the System package grants its
internals to that identity. It is a local al-runner repro only: never publish it to a BC server.
