# R-329 (roadmap R329): pre-commitment for the gates (2026-10-24)

Written BEFORE any live run of the R-329 head (`lethal/r329`), from `/coord/handoff/R-329/measure.md`. Any difference
is a BLOCK.

## What changes
- `projectObserves` (`packages/engine/src/semantic/trigger-skip.ts`) reads each indexed codeunit's
  `attribute_argument_list` nodes from a list collected once per `SymbolTable`, not by walking every codeunit on every
  call.
- `objectsOfType` (`packages/builtin-tier1/src/loop-hazard.ts`) reads codeunits and tables (with their
  tableextensions) from a name index built once per context, in `projectObjects` order.
- Both are memos of pure scans: the mutation set, its keys and their order do not change.

## The identity gate (offline)
- `corpus-snapshot.ts diff fixtures --branch <r329>`: 0 differences over every fixture project.
- BaseApp (`/work/src/BC.History/BaseApp/Source/Base Application`): the branch's `prod-identity-keys.ts` dump is
  byte-identical to master's (58af15f5; master's generation code is unchanged up to 1279b38f).

## The live gates: every per-mutant verdict unchanged
The legs come from `selectLegs` on the diff: `bcdev`, `tables`, `chunked`, `alrunner-v3` (copied literally; the final
diff's output is quoted in the submit note).
- Every gate passes, with every per-mutant verdict and killing test unchanged against its committed baseline (scheme
  42), and every gate-page figure unchanged. No scheme-change line.
- `itest:alrunner-v3` runs all 12 legs, with `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set.
- BC legs run on servers proven for them, one gate per server, each under a lease; parallel gates in separate
  worktrees.

## The figures (reported, not gated)
Unprofiled wall time and peak RSS of one BaseApp generation, master against the branch, same driver
(`/coord/handoff/R-329/profile-gen.sh`, `PROF=0`), run one after the other on one heavy slot. The profile predicts the
two cuts remove up to about 75% of the wall time (an upper bound: the call tree is nested).
