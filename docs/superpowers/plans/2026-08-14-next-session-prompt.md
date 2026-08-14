# The operator-waves plan is COMPLETE. This file is now its closing record.

Written 2026-08-14 to survive a restart, and rewritten the same day when the last task landed. The
plan is `docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`.

## One-line status

**All three waves are closed.** Wave A (R136, three operators) at `1d259ca`, Wave C (cross-gate
confirmation) with the other three gates unmoved, and Wave B (R134, the filter-literal operator) at
`4f5e896` for the gate and `57f6a30` for the close-out. Nothing from this plan is left to do.

## Where the work lives

- Plan: `docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`
- Wave A spec + pre-commitment: `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md`,
  `docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md`
- Wave B spec + pre-commitment: `docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md`,
  `docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md`
- Session ledger (gitignored scratch):
  `.superpowers/sdd/2026-08-12-r134-r136-operator-waves/progress.md`

## What the tables gate now measures

Frozen at **killed 183 / survived 31 / no-coverage 10 over 224 deployed mutants (243 raw specs)**,
score 183/214, `untargetedTriggerCount` 0, `platformArtifactKills.killedCount` 1, assertion screen
`vacuous`, exactly one baseline failure by name (`Data Tests.PageActionComputesNonZero`).

Wave A moved it from 113/18/10 over 141 to 157/25/10 over 192 with all 51 pre-committed verdicts
matching. Wave B moved it to its current figures with all 32 pre-committed verdicts matching, on a
purely additive baseline diff, so no pre-existing mutant moved.

Wave B's own claim rests on two survivors and one pair, not on its four kills: arm B's flip survives
a weak existence-only assertion, arm D's flip is genuinely equivalent across a boundary gap, and
arms C and D are the same rule and the same mutation shape with opposite verdicts. The four kills
were additionally checked against `killingTestFailure`, and each carries the arm's own bare
`Error(...)` naming the exact predicted count, so none of them is BC rejecting a mutated filter.

## Rows this plan filed that are STILL OPEN

- **R137** — `swap-rec-xrec`'s conformance refusals assert nothing: an empty `expectedSpecs` passes
  unconditionally because the runner never checks for extras.
- **R138** — the platform-artifact screen cannot see run-trigger-flag kills. Wave A's arm K is its
  live demonstration.
- **R139** — a stale published TEST app is indistinguishable from genuinely failing tests. Cost a
  full gate run in EACH of the two waves, three days apart, on the same fixture. The row now carries
  both occurrences and the related stale-symbol-cache trap.
- **R140** — fallback 2 manufactures a false `survived` where member-level attribution declines.
- **R141** — `flip-filter-literal`'s character-class refusals have no live negative anywhere; only
  ladder exhaustion (arm H) was measured.

## Procedures that bit, worth keeping

- Build loop order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`.
- **No two live gates at once.** The lease and op-marker are machine-global across containers.
- Publishing the TEST app is the operator's own workflow; the gate publishes only the target. Before
  blaming a wave's own AL, check the container's installed test-app version against `app.json`, and
  recompile the target into the test project's `.alpackages` (a stale build can hide behind an
  unchanged version string).
- Deleting `packages/runner/itest/tables.baseline.json` is the ONLY sanctioned way to authorize a
  re-record. Back it up first, since `git checkout -- <path>` is blocked by a safety hook.
- A secret-scanning rule blocks a script that reads a JSON property named `key`. Do not work around
  it; check the same thing another way. Here, `git diff --numstat` on the baseline proved more than
  the blocked script would have: a purely additive diff IS the "no pre-existing mutant moved" claim.
