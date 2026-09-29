# R231: re-freeze pre-commitment for the gift-card rehearsal and credit-limit demo stages

Written and committed BEFORE either stage's `<stage>.baseline.json` is deleted. It states what a
measured run already showed, so the re-freeze can be checked against it rather than accepted as
whatever the next run happens to produce.

## Why a re-freeze

R231 moves both committed sample reports to report schema v3 (plan
`docs/superpowers/plans/2026-09-30-R-231-batch-qualified-mutant-lists.md`, section 5 and ruling 2).
They were regenerated live on Cronus28 on 2026-09-29 under the coord lease (lane `bugs`, attempt
067). The run matched on every verdict and every count, but `lethal campaign compare` reported
DIFFERENT against both committed baselines. The ruling made that a STOP. The owner then approved a
deliberate re-freeze of both stages on 2026-09-30.

The differences come from work that landed AFTER these baselines were frozen, not from R231.
Evidence from that run is under `.superpowers/` in the r231 worktree (gitignored scratch):
`r231-compare-*.txt`, `r231-mutant-summary.txt`, `r231-campaign-compare-*.txt`.

Setup: Cronus28 (BC 28.4, DK), LethAL Control 1.0.0.20 installed, backend `bcdev`, one batch.
The apps are Credit Limit Demo 1.0.0.0 with its test app 1.0.0.0 (published fresh from this tree on
2026-09-29), and Gift Card Demo 1.0.0.0 with its test app 1.0.0.0.

## 1. Verdicts and counts: unchanged

Mutants are joined by file, procedure, operator, astHash and line. Over all 102 mutants (42 demo,
60 rehearsal) there are **0 verdict differences**.

| stage | deployed | killed | survived | no-coverage | score |
|---|---|---|---|---|---|
| demo (credit-limit) | 42 | 23 | 8 | 11 | 74.19% |
| rehearsal (gift-card) | 60 | 34 | 15 | 11 | 69.39% |

These are the committed figures, unchanged. The rows that carry each demo do not move. In
credit-limit these are the three planted survivors. In gift-card they are `GetBalance`
remove-setrange survived, `Redeem` conditional-boundary survived, and `BlockExpiredCards` fully
no-coverage.

## 2. killingTest: 18 differences, all attributed to R197 (killer-first order)

Since R197, the covering tests run killer-first, so a mutant several tests can kill is credited to
a different one of them. Every mutant below is `killed` both before and after. Only the name of
the killing test moves.

### demo (14)

| mutant | object / procedure | operator | line | old killingTest | new killingTest |
|---|---|---|---|---|---|
| M0003 | Credit Limit Mgt / RegisterOrder | empty-block | 9 | OrderUnderLimitIsAllowed | InvoicedOrdersStopCounting |
| M0004 | Credit Limit Mgt / RegisterOrder | void-method-call | 10 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0006 | Credit Limit Mgt / RegisterOrder | remove-assignment | 13 | OrderUnderLimitIsAllowed | InvoicedOrdersStopCounting |
| M0008 | Credit Limit Mgt / RegisterOrder | remove-assignment | 15 | OrderUnderLimitIsAllowed | OpenOrdersCountTowardTheLimit |
| M0011 | Credit Limit Mgt / RegisterOrder | void-method-call | 17 | OrderUnderLimitIsAllowed | OpenOrdersCountTowardTheLimit |
| M0012 | Credit Limit Mgt / CheckCreditLimit | empty-block | 21 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0013 | Credit Limit Mgt / CheckCreditLimit | negate-guard | 22 | OrderUnderLimitIsAllowed | OpenOrdersCountTowardTheLimit |
| M0014 | Credit Limit Mgt / CheckCreditLimit | void-method-call | 23 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0015 | Credit Limit Mgt / WouldExceedLimit | empty-block | 30 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0016 | Credit Limit Mgt / WouldExceedLimit | void-method-call | 31 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0017 | Credit Limit Mgt / WouldExceedLimit | negate-conditional | 33 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0022 | Credit Limit Mgt / WouldExceedLimit | remove-assignment | 37 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0023 | Credit Limit Mgt / WouldExceedLimit | swap-additive | 37 | OrderOverLimitIsBlocked | OpenOrdersCountTowardTheLimit |
| M0025 | Credit Limit Mgt / WouldExceedLimit | return-value | 39 | OrderUnderLimitIsAllowed | OpenOrdersCountTowardTheLimit |

### rehearsal (4)

| mutant | object / procedure | operator | line | old killingTest | new killingTest |
|---|---|---|---|---|---|
| M0002 | Gift Card / OnValidate | negate-conditional | 18 | IssueCreatesCard | IssueRequiresCustomer |
| M0008 | Gift Card Mgt / Issue | empty-block | 12 | IssueCreatesCard | IssueRejectsNegativeAmount |
| M0024 | Gift Card Mgt / Redeem | empty-block | 31 | RedeemReducesBalance | RedeemBlockedCardFails |
| M0026 | Gift Card Mgt / Redeem | negate-guard | 34 | RedeemReducesBalance | RedeemBlockedCardFails |

Every other mutant keeps its killingTest (or keeps having none).

## 3. Identity keys: one twin group, attributed to R193 (twin ordinals)

This is rehearsal `Gift Card Mgt / Redeem / lethal.void-method-call`, astHash prefix
`d888e09ae498`. There are three byte-identical call statements at lines 35, 38 and 41.

- Committed baseline: the key `...|Redeem|lethal.void-method-call|1` appears **three times**.
- Re-freeze: the keys are `...|1` (M0027, line 35), `...|1|1` (M0029, line 38) and `...|1|2` (M0031, line 41).

Since R193, twins are numbered in source order and the ordinal is appended when it is non-zero. All
three are `killed` before and after, with the same killers: RedeemBlockedCardFails,
RedeemExpiredCardFails and RedeemMoreThanBalanceFails. The report carries `identityOrdinal` 1 and 2
on M0029 and M0031.

No other key changes in either stage.

## 4. Report shape: expected differences

- **R231 itself.**
  - `schemaVersion` 2 -> 3.
  - The string lists hold `<batchIndex>/<mutantCode>` entries, which here means `0/Mxxxx`.
  - `readerMarkedEquivalent` entries would gain `batchIndex`. Neither stage has any.
- **New report-level fields** (absent from the committed v2 reports):
  - `artifacts[]` (`appVersion`, `batchIndex`, `sha256`);
  - `groupedCalls` (measured 44 demo, 65 rehearsal);
  - `warmKills` (measured 13 demo, 16 rehearsal);
  - `identityScheme` (3);
  - `likelyEquivalentSurvivors` (`count`, and `byRisk[]` with `risk`, `meaning` and `mutants`);
  - in demo only: `excludedSites` and `unplaceableCount` / `unplaceableMutants` (both empty);
  - `validity.caveats` gains `session-warm` beside `kills-without-assertion`.
- **New per-mutant fields:**
  - `reachedBy`, `reachGrain`, `gapId`;
  - `blockStartLine`, `blockEndLine`, `procedureStartLine`, `procedureEndLine`;
  - `guardReached`, `killPosition`, `equivalenceRisk`, and `identityOrdinal` (section 3).
- **Changed, run-specific:**
  - Every `killingTestFailure` callstack now names `LC Run Many` / `RunMutantMany` in LethAL Control **1.0.0.20**, where it used to name `LC Run Method` / `RunMutant` 1.0.0.16. The target's minted app version in the stack changes with each run.
  - Messages that carry a test's own amount change with the killer (for example, 400 becomes 600).
  - Timings, durations and artifact ids change.

The measured values of `groupedCalls`, `warmKills` and `killPosition` are facts about run order.
They are recorded here, but the gate on this re-freeze is sections 1 to 3. A change to a verdict, a
count, a killingTest or a key that is not listed above is a STOP.

## 5. The demo report becomes UNREDACTED, on purpose

The committed `examples/credit-limit/demo.report.json` carries
`[redacted: third-party source, see this directory's README]` in its `originalText` and
`mutatedText` (62 fields). The re-frozen report carries the real text.

That source is `examples/credit-limit`, LethAL's own public example app, which is already in this
repository in full. The report is on the first-party allowlist
(`scripts/redact-first-party-reports.json`), and `bun scripts/redact-campaign-report.ts --check`
passes on it. The CLAUDE.md rule forbids publishing a third-party project's source. This is not
third-party source.
