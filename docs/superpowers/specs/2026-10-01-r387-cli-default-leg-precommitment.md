# R387: the CLI-default leg of `itest:alrunner`, prediction written BEFORE the leg first runs

R387 flips two al-runner defaults inside `buildBackend` (`packages/runner/src/cli.ts`): `serverMode`
becomes `true`, and `selectorMode` becomes `"resource"` when the server is on. Coverage stays OFF by
default (plan section 2b). A new leg of `itest:alrunner` runs `fixtures/sandbox-app` through
`buildBackend` with an `alRunner` section that sets no transport key, so it measures exactly what a
CLI user gets with no config. This file states what that leg must report, per mutant, before it has
ever run. The leg either matches it or the change is wrong.

Plan: `docs/superpowers/plans/2026-10-01-R-387-al-runner-fast-defaults.md` (r2, approved), section 4.

## The prediction

**3 killed / 16 survived / 0 no-coverage over 19 mutants.**

The control is leg A, the existing one-shot leg with coverage ON, frozen in
`packages/runner/itest/al-runner.baseline.json` at 3 / 12 / 4. Every mutant has the SAME verdict and
the SAME killing test as in that baseline, except the four mutants of `SandboxPricing.Codeunit.al`.
Those are `no-coverage` in leg A and `survived` here, because coverage is off by default: every mutant
runs every green test, and nothing can be classified as unreached. Their killing test is none.

This is also, row for row, the al-runner baseline as it stood before R220 turned coverage on in the
gate (`git show db711deb^:packages/runner/itest/al-runner.baseline.json`), which was 3 / 16 / 0 with
these same four rows `survived`. So the prediction is "the CLI with no config reaches the verdicts the
one-shot, no-coverage transport reached", now through `--server` and the resource selector.

## The per-mutant table

Identity key = the baseline's `key` (`astSubtreeHash|object|procedure|operator|occurrence`). Hashes
are the full values from `al-runner.baseline.json`.

| # | identity key | leg A (frozen) | this leg | killing test |
| --- | --- | --- | --- | --- |
| 1 | `241fff269e9c9b9a336099e4588ad85b0198a155d98dccc6e48adf1e551f6341\|Sandbox Logic\|ClampPercent\|lethal.negate-conditional\|1` | survived | survived | none |
| 2 | `2b34811c1b253fde93b24824f30d18d933316b7f64723b67d413a3b0d16956a6\|Sandbox Logic\|ApplyAudit\|lethal.empty-block\|1` | survived | survived | none |
| 3 | `4004a181f8c0dc8bbe0c7c3051d719211b1ca22dadad08ae600b2df9f72fbe82\|Sandbox Logic\|IsOverBudget\|lethal.return-value\|1` | killed | killed | `OverBudgetDetected` |
| 4 | `40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5\|Sandbox Logic\|ClampPercent\|lethal.return-value\|1` | survived | survived | none |
| 5 | `4b61c09033d7c8404656624ea1865b451a890db32d8212d97f8a77e9a5c2634a\|Sandbox Pricing\|DiscountedPrice\|lethal.conditional-boundary\|1` | no-coverage | **survived** | none |
| 6 | `58ade303c82ea175e1cabd4e46b8cd818e3a59a66b60578ef4d85077548d40e9\|Sandbox Logic\|ClampPercent\|lethal.conditional-boundary\|1` | survived | survived | none |
| 7 | `5c9b5c3e0234666484725bd281b0610957f03a54fadff8a87364e8cf29fd8222\|Sandbox Logic\|IsOverBudget\|lethal.empty-block\|1` | killed | killed | `OverBudgetDetected` |
| 8 | `5cba655a6ac203ce40d31b0b4974a7b2f308cfec342a35d8e1a4f8d8c09c5c03\|Sandbox Logic\|LogAudit\|lethal.negate-conditional\|1` | survived | survived | none |
| 9 | `63b9fa65d3452236af3d725f80a805268813f9012185c0296fe552908eae1d6d\|Sandbox Logic\|LogAudit\|lethal.shift-integer\|1` | survived | survived | none |
| 10 | `63c4f230d49983a82f9a54edf57f787ba2196df2de23c5374a9921c523fc408f\|Sandbox Logic\|LogAudit\|lethal.empty-block\|1` | survived | survived | none |
| 11 | `77ee7e3d0adfcd76e1ae34e9067dcebc5c466f1172a857c730b0d43f7085d15c\|Sandbox Logic\|LogAudit\|lethal.empty-block\|1` | survived | survived | none |
| 12 | `82a8a37831dd57841652a34ad1f5567a0c073ca19774f619b2022729a64fb9dc\|Sandbox Logic\|IsOverBudget\|lethal.conditional-boundary\|1` | killed | killed | `OverBudgetDetected` |
| 13 | `98656555452a91ccc91c88a8a0bc3f58192db5f5153792b959447d06cff62cf1\|Sandbox Pricing\|DiscountedPrice\|lethal.return-value\|1` | no-coverage | **survived** | none |
| 14 | `9b4f290c51c1ef232af4a294bb9a0a4c404064f20bac6e893fab28b45cdf7785\|Sandbox Logic\|ApplyAudit\|lethal.void-method-call\|1` | survived | survived | none |
| 15 | `b03dba085d6a4498f41e5e223ecb64c66e6eee1d2d2ef7ab55f84fa7c63835d7\|Sandbox Logic\|ClampPercent\|lethal.empty-block\|1` | survived | survived | none |
| 16 | `d7143458adf859fcca3a104795916421514185dbe83b5e6366d0f68f86e9389d\|Sandbox Pricing\|DiscountedPrice\|lethal.swap-additive\|1` | no-coverage | **survived** | none |
| 17 | `d8f839f87361f4d85b7ccd435b318285a82e1e3610237d66488e17b8bdd61de3\|Sandbox Logic\|LogAudit\|lethal.remove-assignment\|1` | survived | survived | none |
| 18 | `e7216a276891ae7f02f66d83d4fad98fdc3ca56552d617d1f70fa371f7cfc667\|Sandbox Pricing\|DiscountedPrice\|lethal.empty-block\|1` | no-coverage | **survived** | none |
| 19 | `fc15ec3036dca5e21a2e79675b48f28e5815811f32dff4eb3426e0ff803575bb\|Sandbox Logic\|ClampPercent\|lethal.conditional-boundary\|1` | survived | survived | none |

Totals: killed 3 (rows 3, 7, 12), survived 16, no-coverage 0. The four bold rows are the only
difference from leg A, and in the recorded baseline they also carry `coverageFiltered: false` where
leg A carries `true`.

## What the leg asserts besides the table

These are mechanism checks, independent of the config the leg passes in:

- **Server.** Exactly one `--server` spawn per backend instance (one per worker), and NO one-shot
  test spawn (no argv with `--test`).
- **Resource.** The selector resource file exists after `deploy()`, its content changes on each
  `activate()` to the id being activated, and the number of compiles is one per batch, not one per
  mutant. The compile count is read from the client side, because the daemon compiles internally and
  does not report it: al-runner's output cache keys on the bundle's `*.al` text (R222), so the leg
  hashes every `.al` file of the active bundle at each `activate()` and counts how many distinct
  hashes it saw. That must equal the number of `deploy()` calls (one batch on this fixture), never
  the number of activations.
- **Provenance.** The BC build and the platform-app directory the transport selected are RECORDED and
  printed beside leg A's. Server mode does not send R147's platform-app pin, so a difference is
  reported, not asserted away. If the daemon does not name them, that is stated, not inferred.
- **Ordering.** The leg runs after every existing leg (R345: one al-runner session at a time).

## What would falsify it

- **Any row other than 5, 13, 16 and 18 differing from leg A**, in verdict or in killing test.
- **Any of rows 5, 13, 16 and 18 not `survived`.** `no-coverage` there means coverage was turned on by
  default, which plan section 2b forbids in this task; `killed` means a test reached code no test
  calls.
- **A matching table with a failed mechanism check.** The defaults did not take effect and the leg
  measured the one-shot static path, which would give this same table. That is why the mechanism
  checks exist: the table alone cannot tell the two paths apart.

## Baseline

`packages/runner/itest/al-runner.cli-default.baseline.json`, recorded ONCE under R332's record mode
(`LETHAL_ITEST_RECORD_BASELINE=al-runner.cli-default.baseline.json`), which exits 3 and is never a
pass. The recorded file must equal the table above row for row before it is committed.

## What this does NOT claim

"Verdicts do not move" is claimed for the measured fixtures only: `sandbox-app` by this leg, and the
R321 and R353 legs as before. A hanging test under `--server` runs under the daemon's one long request
deadline rather than a per-test timeout; that is checked offline with a never-answering fake daemon,
not live.
