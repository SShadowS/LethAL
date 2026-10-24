# R-326 (roadmap R326, R328; BaseApp generation round 2): pre-commitment for the gates (2026-10-24)

Written BEFORE any live run of the R-326 head (`lethal/r326`), from `/coord/handoff/R-326/measure.md`. Any difference
is a BLOCK.

## What changes
- `visibleDeclarationText` (`packages/engine/src/semantic/receiver.ts`) builds its blanked text in one pass over the
  object's original text instead of one full re-slice per procedure (cut C1, orchestrator ruling). The spans are in
  document order and never overlap, so it is the same string. No cache.
- A measurement script, `scripts/r326-w8-memory.ts`, with its test. No product code reads it.

## The identity gate (offline)
- `corpus-snapshot.ts diff fixtures --branch <r326>`: 0 differences over every fixture project. (This ran before
  this file was committed. No live gate has run.)
- BaseApp: the branch's `prod-identity-keys.ts` dump has the same sha256 as master 20a6923d's (`d73d7981...`).

## The live gates: every per-mutant verdict unchanged
The legs come from `selectLegs` on the diff: `bcdev`, `tables`, `chunked`, `alrunner-v3` (copied literally).
- Every gate passes, with every per-mutant verdict and killing test unchanged against its committed baseline (scheme
  42), and every gate-page figure unchanged. No scheme-change line.
- `itest:alrunner-v3` runs all 12 legs, with `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set.
- BC legs run on servers proven for them, one gate per server, each under a lease, in separate worktrees.

## Figures (reported, not gated)
- Unprofiled wall time and peak RSS of one BaseApp generation, master against the branch, same driver, one after the
  other on one heavy slot. The profile predicts at most about 20% less time (`visibleDeclarationText` was 19.7%).
- R326 and R328 on today's code, from the phase-boundary script: they are read at phase boundaries, not at RUST-03's
  in-loop p5 marker, and each item says so.
