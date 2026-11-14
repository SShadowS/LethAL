# Upstream repros (R-996)

Every invented repro LethAL filed upstream at aldevtools/BusinessCentral.AL.Runner, as one regression set. Each folder is one
AL app with test codeunits and no corpus source text. `manifest.json` names, per repro, its issue, where BC's result comes from
(`bcEvidence`: measured on BC, or inferred from the issue), what to re-run when it flips (`rerun`: projects, roadmap items) and
BC's result per test (`tests`).

`bun scripts/upstream-repros.ts --candidate <al-runner> [--current <al-runner>]` runs every repro on both builds and reports per
test: `flipped` (now matches BC: re-run what it names), `regressed` (matched BC on current, not now: a finding), `still-differs`,
`still-matches`, or `error` (the repro did not run). The daily update (`al-runner-v3-update.ts`, `gateOne`) runs it for every new
candidate and logs the report; it never decides the gate.

Adding a repro: a folder `u<issue>-<topic>` with `app.json` (its own app id, ids in the 50100-50399 range) and `src/`, an entry in
`manifest.json`, then `bun scripts/upstream-repros.ts --candidate /work/tools/al-runner-v3/current/al-runner` to see it run. A
repro must run with `al-runner test --bc-version 28 <folder>` alone (no package cache), as these do.

## Not yet in the set (open upstream issues an open roadmap item cites)

| issue | roadmap | repro source | why not yet |
|---|---|---|---|
| #7853 | R946 | `/coord/handoff/R-981/i7853` | a compile-time difference (alc AL0161 on the System package); needs the platform System package |
| #7922 | R946 | `/coord/handoff/R-981/o7922` | needs Base Application from a package cache |
| #8032 | R994 | `/coord/handoff/R-982/repro-wildcard`, `repro-xmlskip`, `repro-tenantset` | to curate: BC's result per test from the issue |
| #8036 | R995 | `/coord/handoff/R-983/repro` | to curate |
| #8038 | R997 | `/coord/handoff/R-985/repro`, `repro2` | needs Published Application rows and a permission set |
| #8056 | R942 | `/coord/handoff/R-942/` (install order of 4+ apps) | several apps installed in order |
