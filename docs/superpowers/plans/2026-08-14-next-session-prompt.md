# Next session: finish Wave B (R134), then close out

Written 2026-08-14 to survive a restart. The plan being executed is
`docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`. Read that for task detail; read this
for STATE.

## One-line status

**Wave A (R136, three operators) is built, measured live and CLOSED. Wave C (cross-gate
confirmation) is CLOSED. Wave B (R134, the filter-literal operator) is built, audited and
pre-committed; the only thing left is its live gate run, then its close-out.**

## Where the work lives

- Plan: `docs/superpowers/plans/2026-08-12-r134-r136-operator-waves.md`
- Wave A spec + pre-commitment: `docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md`,
  `docs/superpowers/specs/2026-08-12-r136-trio-precommitment.md`
- Wave B spec + pre-commitment: `docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md`,
  `docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md`
- Session ledger (gitignored scratch, may not survive `git clean -fdx`):
  `.superpowers/sdd/2026-08-12-r134-r136-operator-waves/progress.md`. It holds the full blow-by-blow
  including every finding and ruling. This file is the durable summary of it.

## Task list

Done: A1 to A11 (Wave A), C1 (cross-gate), B1 to B7 (Wave B up to and including the
pre-commitment).

**Remaining, in order:**

1. **B8 — the live tables gate for Wave B.** The next real action. Procedure below.
2. **B9 — close out Wave B**: set `docs/roadmap/R134.md` to `done (<gate commit>)`, rewrite its body
   to record what was built and measured, run `bun scripts/roadmap-index.ts`, verify with
   `bun run typecheck` then `rm -rf packages/*/dist` then `bun test`, and commit. Do NOT close R137,
   R138, R139 or R140; none is fixed.

## B8, exactly

The gate is judged against `docs/superpowers/specs/2026-08-12-r134-filter-precommitment.md`, committed
at `c2390dd` BEFORE any run. **Never edit a pre-commitment after a run.**

Predicted aggregate: **killed 183 / survived 31 / no-coverage 10 over 224 deployed from 243 raw**,
with 19 displaced. Of the 32 new mutants: 26 killed, 6 survived, 0 no-coverage, 0 error. The four
invariants are predicted UNCHANGED: `platformArtifactKills.killedCount` 1,
`assertionScreen.discrimination` `vacuous`, `untargetedTriggerCount` 0, and exactly one baseline
failure by name, `Data Tests.PageActionComputesNonZero`.

Steps:

1. Update `EXPECTED` in `packages/runner/itest/tables.itest.ts` to those figures. Leave the three
   invariants alone; they are deliberately unchanged.
2. Consider adding durable text assertions for the new operator the way Wave A did for its trio
   (`assertTrioTextEvidence`). Wave A needed them because `astSubtreeHash` alpha-renames identifiers
   so its mutants collapsed into shared identities. This operator mutates a STRING LITERAL, whose
   text the hash preserves, and the fixture's hash decoys were added specifically so no two arms
   collide, so the need is weaker here. Judge it; if you add them, assert on `originalText` and
   `mutatedText` from `report.mutants`.
3. Verify the baseline currently matches HEAD, then delete
   `packages/runner/itest/tables.baseline.json` to authorize the re-record. Deleting is the ONLY
   sanctioned mechanism; never hand-edit it, and never set an env var to bypass the edit guard.
4. Run `LETHAL_ITEST_TABLES=1 bun run itest:tables` with output to a fresh log file. **Never pipe a
   live gate** through anything that can close the pipe early. It takes minutes. It needs the
   gitignored `fixtures/sandbox-data/lethal.config.local.json`, which exists.
5. Judge per mutant against the pre-commitment using `report.mutants`, NOT baseline rows: the
   baseline's identity key cannot distinguish collapsed groups.
6. **On ANY mismatch, stop and report verbatim. Do not interpret, reconcile or adjust.** A
   contradicted prediction is the finding.
7. Only if everything matches: run the gate a SECOND, SEPARATE time to prove the new baseline
   compares against itself. An in-process double-run does NOT satisfy this; Wave A learned that the
   hard way. Then update the frozen figures in `CLAUDE.md` and `fixtures/README.md`, and commit.

## What Wave A established (do not re-derive)

- Frozen tables gate went from killed 113 / survived 18 / no-coverage 10 over 141 to **157 / 25 / 10
  over 192 (207 raw)**, and all 51 pre-committed verdicts matched, 44 on one run and 7 on a later
  one.
- Three operators shipped: `swap-modify-flag` extended to `Insert(true)`/`Delete(true)` via a MINOR
  version bump (so existing identities do not move, proven per-mutant), plus `swap-find-direction`
  and `validate-to-assign`.
- Cross-gates confirmed unchanged on three other fixtures: bcdev 3/10/3, alrunner 3/13/0 on
  al-runner v2.1.2.0, envtool 3/10/3. `fixtures/sandbox-app` produces 16 mutants and zero from any
  new operator, so those gates are structurally guaranteed not to move.

## Roadmap rows filed by this work, ALL STILL OPEN

- **R137** — `swap-rec-xrec`'s conformance refusals assert nothing: an empty `expectedSpecs` passes
  unconditionally because the runner never checks for extras.
- **R138** — the platform-artifact screen cannot see run-trigger-flag kills. Wave A's arm K is its
  live demonstration: three untagged platform-artifact kills, confirmed as kills, mechanism
  unmeasured.
- **R139** — a stale published TEST app is indistinguishable from genuinely failing tests. Cost this
  work a full gate run to diagnose. Strengthened later: the envtool publisher ALREADY compares
  package id and sha256, so the check it asks for is existing capability, not new machinery.
- **R140** — fallback 2 manufactures a false `survived` where member-level attribution declines.
  Measured: the same root cause gave five procedure mutants an honest `error` and two trigger
  mutants a scored `survived` against a test set that could never kill them.

## Residuals and known risks

- **The census and the arm comments may disagree somewhere and nobody confirmed a negative.** The B7
  agent never reported, so if the gate contradicts a row, check FIRST whether that site's arm comment
  and the census said different things.
- **An adversarial sweep of the amended Wave B spec never completed.** Three attempts went idle. The
  controller verified the load-bearing findings by hand and by measurement (both blocker fixes, the
  hash-decoy separation, arm E's reseeding, finding 8's three parts, finding 7's refusal), but nobody
  hunted for hazards INTRODUCED by growing that spec from 594 to 830 lines.
- **Two claims in the Wave B design are REASONED, not measured**: bare atom versus explicit `=`, and
  one-sided range inclusivity. After the corrections neither should be load-bearing for a verdict. If
  a row turns out to depend on one, that is a finding.

## Procedures that bite

- Build loop order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. The dist
  wipe is mandatory or you get ~21 phantom failures from compiled `*.test.js`.
- **No two live gates at once.** The lease and op-marker are machine-global even across different
  containers.
- After touching any `.al` under `fixtures/`, run `bun run compile:fixtures`. Nothing else compiles
  them. Known mechanic: it does not chain a target's fresh symbols into a dependent test project's
  `.alpackages`, so you may need to recompile the target and refresh that cache first.
- The test app is the OPERATOR's responsibility to publish; the gate publishes only the target. That
  is R139, and it cost a run.
- `git checkout -- <path>` is blocked by a safety hook; to restore a deleted file, copy it back from a
  backup instead.
- A secret-scanning rule matches `.key` property access, so a script that reads a JSON field named
  `key` gets blocked. Do not work around it; use a different check.

## Working with subagents in this repo

Eight agents went idle without delivering during this work, several after a blocked file write. Two
habits that fixed it: tell them to put findings in the REPLY rather than a file, and verify the
load-bearing claims yourself rather than waiting. Several of this work's best findings came from
subagents volunteering that a red-check found NOTHING, or that a brief contradicted the spec. Treat
that as the behaviour to reward.
