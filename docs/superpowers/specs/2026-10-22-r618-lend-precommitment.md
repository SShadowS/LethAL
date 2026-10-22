# R618 pre-commitment: `itest:lend`, the first live run (2026-10-22, lethal-preproc)

**Addendum (2026-10-22, after live run 1 and before any re-run; orchestrator ruling (a)).**
- **What run 1 showed.** On bc1 it was BLOCKED at R2 (`/coord/handoff/R-618/live-run-1.md`). L0, L1 and R1 were as
  below. R2 carried 7 where 9 were predicted: K's two no-coverage KEPT rows came back as fresh no-coverage.
- **The cause, read from the code.** In a PARTLY carried batch, `scoreBatch` records uncovered mutants from this
  session's coverage before any carry lookup, so a stored no-coverage is re-derived, not carried. A WHOLLY carried
  batch (`replayCarriedBatch`, R1) does carry it. This is the safe direction, and the asymmetry is filed as R621.
- **Corrected predictions for the re-run.** The same rule applies to EVERY partly carried leg. Gate code: lethal/r618
  at 7084eece.
  - **R2:** `carried` 7 = the KEPT rows minus M0016 and M0017, which come back as fresh `no-coverage`, not carried.
    `carryable` stays 9 (the resume warning still says 9 may be carried), `nonCarryableRows` 1, `groupedCalls` 8. In
    the R2 column of the table below, M0016 and M0017 read `n`, not `n c`.
  - **R3:** `carried` 15 = K2's 18 carryable rows minus the no-coverage M0016, M0017 and M0018, which are re-derived.
    `carryable` 18, `groupedCalls` 0. In the R3 column, M0016-M0018 read `n`, not `n c`.
  - **Unchanged:** every verdict, by key, equals the frozen table in every leg; R1 still carries all 19; every
    other leg is as below.
- **The re-run is the WHOLE gate** (all 8 sessions and every refusal), on bc1. Any other difference is a BLOCK.

Written 2026-10-22, before any live run of the gate and before any server call for it.
Gate code: branch `lethal/r618` at `c75a4da6`, plan
`docs/superpowers/plans/2026-10-22-r618-bc-lend-gate.md` r2. The expectations are the constants
`LEND_MUTANTS` and `LEND_FIGURES` in `packages/runner/itest/gate-expected.ts` at that commit; this
page states the same thing in words, so a difference between the two is itself a finding.

## Server and what it must hold

- **Server: `bc1`** (`192.168.2.157`, dev 7049, OData 7048, API 7052), under a coord lease in the
  running lane. LethAL Control 1.0.0.23 (`CONTROL_SHA256` c2a95948...), the build R-604 proved
  there. `itest:bcdev`'s fixture pair (`Sandbox App` 1.0.0.2 target, `Sandbox Tests` 1.0.0.4) as
  R-604 left it; this gate publishes only the instrumented target, exactly as `itest:bcdev` does.
- One passing run admits `(bc1, itest:lend)` only. bc2 and bc3 need their own run each (proof is
  per server).
- **This first run is also the measurement of baseline-snapshot reuse on the bc servers** (Q5).
  R192's reuse has never been seen live on bc1 to bc3. If R2 fails ONLY because no
  `resume-baseline-reused` is emitted (the batch's instrumented source hashed differently in L1 and
  R2), that is a measured fact about reuse, not a lend-order regression: the run stops, nothing is
  re-frozen, and the orchestrator rules. Any other difference is a BLOCK.

## Notation

A = L0's run; H = its test-app hash; D = its dependency fingerprint. H must contain
`|closed-world:public` and end in neither `|pending` nor `|closed-world:revoked` (I5; the gate
refuses by name otherwise). B = L1's run. Seeds are written by `seedRunFrom` (`itest/lend-seed.ts`)
as clones of A with one field changed. Run ids are assigned in creation order and are written
below by role, never by number.

## The 19 mutants, by identity key (the frozen table, `bcdev.baseline.json`)

Every key ends `|1` (operator major 1, no ordinal). Killers are `OverBudgetDetected`.

```
label  identity key                                                                                                              frozen
M0001  5c9b5c3e0234666484725bd281b0610957f03a54fadff8a87364e8cf29fd8222|Sandbox Logic|IsOverBudget|lethal.empty-block|1             killed
M0002  4004a181f8c0dc8bbe0c7c3051d719211b1ca22dadad08ae600b2df9f72fbe82|Sandbox Logic|IsOverBudget|lethal.return-value|1            killed
M0003  82a8a37831dd57841652a34ad1f5567a0c073ca19774f619b2022729a64fb9dc|Sandbox Logic|IsOverBudget|lethal.conditional-boundary|1    killed
M0004  b03dba085d6a4498f41e5e223ecb64c66e6eee1d2d2ef7ab55f84fa7c63835d7|Sandbox Logic|ClampPercent|lethal.empty-block|1             survived
M0005  241fff269e9c9b9a336099e4588ad85b0198a155d98dccc6e48adf1e551f6341|Sandbox Logic|ClampPercent|lethal.negate-conditional|1      survived
M0006  fc15ec3036dca5e21a2e79675b48f28e5815811f32dff4eb3426e0ff803575bb|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1    survived
M0007  58ade303c82ea175e1cabd4e46b8cd818e3a59a66b60578ef4d85077548d40e9|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1    survived
M0008  40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Sandbox Logic|ClampPercent|lethal.return-value|1            survived
M0009  2b34811c1b253fde93b24824f30d18d933316b7f64723b67d413a3b0d16956a6|Sandbox Logic|ApplyAudit|lethal.empty-block|1               survived
M0010  9b4f290c51c1ef232af4a294bb9a0a4c404064f20bac6e893fab28b45cdf7785|Sandbox Logic|ApplyAudit|lethal.void-method-call|1          survived
M0011  63c4f230d49983a82f9a54edf57f787ba2196df2de23c5374a9921c523fc408f|Sandbox Logic|LogAudit|lethal.empty-block|1                 survived
M0012  5cba655a6ac203ce40d31b0b4974a7b2f308cfec342a35d8e1a4f8d8c09c5c03|Sandbox Logic|LogAudit|lethal.negate-conditional|1          survived
M0013  63b9fa65d3452236af3d725f80a805268813f9012185c0296fe552908eae1d6d|Sandbox Logic|LogAudit|lethal.shift-integer|1               survived
M0014  77ee7e3d0adfcd76e1ae34e9067dcebc5c466f1172a857c730b0d43f7085d15c|Sandbox Logic|LogAudit|lethal.empty-block|1                 survived
M0015  d8f839f87361f4d85b7ccd435b318285a82e1e3610237d66488e17b8bdd61de3|Sandbox Logic|LogAudit|lethal.remove-assignment|1           survived
M0016  e7216a276891ae7f02f66d83d4fad98fdc3ca56552d617d1f70fa371f7cfc667|Sandbox Pricing|DiscountedPrice|lethal.empty-block|1        no-coverage
M0017  4b61c09033d7c8404656624ea1865b451a890db32d8212d97f8a77e9a5c2634a|Sandbox Pricing|DiscountedPrice|lethal.conditional-boundary|1  no-coverage
M0018  98656555452a91ccc91c88a8a0bc3f58192db5f5153792b959447d06cff62cf1|Sandbox Pricing|DiscountedPrice|lethal.return-value|1       no-coverage
M0019  d7143458adf859fcca3a104795916421514185dbe83b5e6366d0f68f86e9389d|Sandbox Pricing|DiscountedPrice|lethal.swap-additive|1      no-coverage
```

These are `LEND_MUTANTS` at the gate commit; `itest/lend-seed.test.ts` pins them equal to
`bcdev.baseline.json` by key, verdict and killer. Labels are not compared: every
comparison is by key (`compareMutants`), and K's rows carry rotated codes and lines on purpose.

KEPT = {M0001, M0002, M0004, M0005, M0006, M0007, M0008, M0016, M0017} (2 killed, 5 survived,
2 no-coverage). RERUN = the other 10.

## Per leg, per mutant

Cell: verdict (k = killed by OverBudgetDetected, s = survived, ks = known-survivor,
n = no-coverage), then `c` when the row is `carried: true`. Every leg's verdicts equal the frozen
table by key (known-survivor read as survived).

| label | L0 | L1 | R1 | R2 | R3 | N0 | N1 | N5 |
|---|---|---|---|---|---|---|---|---|
| M0001 | k | k | k c | k c | k c | k | k | k |
| M0002 | k | k | k c | k c | k c | k | k | k |
| M0003 | k | k | k c | k | k c | k | k | k |
| M0004 | s | ks | s c | s c | s c | ks | s | s |
| M0005 | s | ks | s c | s c | s c | ks | s | s |
| M0006 | s | ks | s c | s c | s c | ks | s | s |
| M0007 | s | ks | s c | s c | s c | ks | s | s |
| M0008 | s | ks | s c | s c | s c | ks | s | s |
| M0009 | s | ks | s c | s | s c | ks | s | s |
| M0010 | s | ks | s c | s | s c | ks | s | s |
| M0011 | s | ks | s c | s | s c | ks | s | s |
| M0012 | s | ks | s c | s | s c | ks | s | s |
| M0013 | s | ks | s c | s | s c | ks | s | s |
| M0014 | s | ks | s c | s | s c | ks | s | s |
| M0015 | s | ks | s c | s | s c | ks | s | s |
| M0016 | n | n | n c | n c | n c | n | n | n |
| M0017 | n | n | n c | n c | n c | n | n | n |
| M0018 | n | n | n c | n | n c | n | n | n |
| M0019 | n | n | n c | n | n | n | n | n |

Counts (`counts.killed / survived / noCoverage / knownSurvivors`, `groupedCalls`):

| leg | k / s / n / ks | groupedCalls | other |
|---|---|---|---|
| L0 | 3 / 12 / 4 / 0 | 15 | baseline green; A holds exactly one snapshot, key H; at least one baseline test reports a duration (R272) |
| L1 | 3 / 0 / 4 / 12 | 3 | |
| R1 | 3 / 12 / 4 / 0 | 0 | no artifact; `resumedFrom` = {F, 19, 0} |
| R2 | 3 / 12 / 4 / 0 | 8 | `resumedFrom` = {K, 9, 0}; zero baseline tests report a duration; the sentinel row (M0004's key) carried from K with `priorDurationMs` 987654 |
| R3 | 3 / 12 / 4 / 0 | 0 | `resumedFrom` = {K2, 18, 0}; as many baseline tests report a duration as in L0 |
| N0 | 3 / 0 / 4 / 12 | 3 | |
| N1 | 3 / 12 / 4 / 0 | 15 | |
| N5 | 3 / 12 / 4 / 0 | 15 | |

Every one of the 8 sessions' own run rows records hash H, proven, deps D.

## Seeds, in creation order, and the order each site really checks (M6)

1. After L1: **F** = clone(A), unfinished, all 19 rows. R1 = `--resume-run F`.
   `--resume-run`'s real order: run exists, project, **finished (R618, new)**, backend equality,
   step 1 (`assertLends`), scheme, coverage mode, test app, symbols, fingerprint, `carry_hidden`,
   then step 2 and 3 (a warning with an empty carry), then the resume index.
2. After R1: **SP1** clone(A, no rows, hash `H|pending`, snapshot key `H|pending`); **SP2** (no
   rows, `H|pending`, snapshot key H); **SP3** (no rows, snapshot key H, then revoked: run and
   snapshot get `|closed-world:revoked`); **SP4** (no rows, hash `H|closed-world:revoked`, snapshot
   key H). Then **K** = clone(A), unfinished, rows KEPT plus M0003 written as `error`, codes and
   lines rotated among its rows, M0004's row `durationMs` 987654. R2 = `--resume`.
   `--resume`'s real order: `findResumableRun` SQL (same project, backend, fingerprint, scheme,
   unfinished, a carryable row), then step 1, test app, symbols, `carry_hidden`, then step 2 and 3.
   The snapshot site's real order: `findBaselineSnapshot` SQL (batch hash, key = this session's
   hash, owner of this scheme and mode, owner's hash = the snapshot's, proven, same deps, not
   `%|pending`, not suspect, not lost), then step 1, step 2, step 3 on the snapshot's own errors,
   then the R-236c scope check.
3. After R2: **SV3** = clone(A, no rows, backend `al-runner-v3`, runner build `r618-seed`, coverage
   fenced, snapshot key H); **K2** = clone(A), unfinished, all rows but M0019. R3 = `--resume-run
   K2`.
4. N0: a finished clone(A). N1: a finished clone(A, `al-runner-v3`, `r618-seed`). N5: a finished
   clone(A), then revoked. Each is created just before its session, so it is the latest finished
   run. History's real order: step 1, scheme, coverage mode, test app, symbols, `carry_hidden`,
   hidden files, step 2, step 3.
5. RN3: **KV** = clone(A), unfinished, all rows, `al-runner-v3`/`r618-seed`. RN1: **KP** =
   clone(A), unfinished, all rows, `H|pending`. RN2: **KR** = clone(A), unfinished, all rows, then
   revoked. RN4 uses A itself.

## Warnings: each leg emits EXACTLY these lend-site codes

(codes starting `history-`, `resume-`, `snapshot-`, or `carry-refused-renumbered`)

| leg | codes | text pinned |
|---|---|---|
| L0, L1, N0 | none | |
| R1 | `resume-reusing-run`, `resume-batch-carried` | contains `reusing run <F> — 19 mutant verdict(s) may be carried` |
| R2 | `resume-reusing-run`, `resume-baseline-reused` | reusing: contains `reusing run <K> — 9 mutant verdict(s) may be carried` and ` 1 prior 'error' verdict(s) will be re-executed.`; reused: contains `same as run <B>'s batch 0,` (B from L1's session, never from `findBaselineSnapshot`, M4) |
| R3 | `resume-reusing-run`, `snapshot-backend-build-changed` | exactly: `[lethal] run <SV3>'s batch 0 baseline snapshot is not reused: run <SV3> ran on al-runner-v3 and this session runs bcdev; a verdict is lent only within al-runner-v3 (R586). Batch 0's baseline is re-run.` |
| N1 | `history-backend-build-changed` | exactly: `[lethal] --skip-known-survivors: run <N1 seed> ran on al-runner-v3 and this session runs bcdev; a verdict is lent only within al-runner-v3 (R586), so no survivor from it is skipped: every mutant is executed.` |
| N5 | `history-test-app-changed` | contains `the latest finished run, run <N5 seed>, was measured against test app H\|closed-world:revoked,` |

## Refusals (each throws before `createRun` and before the lease; no new run row)

| leg | session | the message starts | and contains |
|---|---|---|---|
| RN3 | `--resume-run <KV>` | `--resume-run <KV> ran on backend al-runner-v3, but this session uses bcdev — verdicts are not interchangeable across backends` | |
| RN1 | `--resume` | `--resume: run <KP> was measured against test app H\|pending` (so `--resume` picked KP, not KV) | `none of its verdicts is carried (R247, R495)` |
| RN2 | `--resume-run <KR>` | `--resume-run <KR>: run <KR> was measured against test app H\|closed-world:revoked` | `none of its verdicts is carried (R247, R495)` |
| RN4 | `--resume-run <A>` | `--resume-run <A>: run <A> already finished; nothing to resume.` | |

## Cost

8 BC sessions (L0, L1, R1, R2, R3, N0, N1, N5) and 4 refusals. The refusals make the pre-lease
reads a session always makes (test-app package, harness) but take no lease. R1 and R3 deploy:
R1 no (its batch is carried whole), R3 yes (M0019 needs a batch). Expected 3 to 6 minutes on bc1
(15 to 40 s per session from the r589 store, plus four short refusals).

## Not pre-committed here (and why)

`killingTestFailure`, durations other than the sentinel, `killPosition` (all 1 on this fixture,
asserted by `itest:bcdev`), and the run ids themselves. Not reachable on bcdev (docs/gates/lend.md):
the resume sites' step 1, the snapshot site's R557 check, another `runner_build`,
`carry-refused-renumbered`.
