# PR-10: what today's al-runner update frees (edge-5a58a0f16) — pre-commitment

Committed before any PR-10 run. al-runner edge-5a58a0f16 (`current` since 2026-11-15 07:57:56). Every config is a copy with
`alRunnerV3.path` pinned to that build, so no run depends on where `current` points. LethAL master (named per run). Evidence and
scripts: `/coord/handoff/PR-10/`.

## What flipped
`scripts/upstream-repros.ts --candidate 5a58a0f16 --current a184cfc79` (`flips.json`) gives 10 rows flipped to BC:
- #7586 `RecordRef.GetTable` of an unassigned Variant (1 row);
- #8036 `RecordRef.ReadPermission` on a RecordRef that is not open (1 row);
- #8038 a permission denial on a FlowField over a system table, for a published app under its own set (1 row);
- #7760 an unassigned XmlElement (3 rows) and CopyStream between never-created streams (1 row);
- #8006, 1753 dates (3 rows). This is a wrong-verdict class, left to PR-15 by the orchestrator.

Their refusal texts on a184cfc79, normalised, were looked up in every store (PR-05's 349, plus R-902, R-913, R-961, R-985 and
PR-06's; `sightings.tsv`):

| key | sightings | where |
|---|---|---|
| #8038 FlowField | 150 tests / 16 tests | Guided Experience (R-985), Extension Management (R-982 #31) |
| #8036 ReadPermission | 5 error mutants | Email (R-975) |
| #7760 XmlElement | 3 error mutants | SAF-T (R-958) |
| #7586 GetTable | 2 + 2 error mutants | Statistical Accounts (R-902), Digital Vouchers (PR-06) |
| #7760 CopyStream | 0 | — |

VAT Group Management, which the #7586 rerun note names, has no GetTable sighting in any store: its tests stop at #8028 first. It
is not re-run.

## Method
**Freed tests** (Guided Experience: 84 freed tests; Extension Management: 8), as PR-06:
1. `scripts/triage-baseline.ts` (a fresh baseline; how many freed tests run, pass, fail).
2. Discovery: baseline narrowed to the freed tests' files, `--operator lethal.empty-block`. It finds the covered files.
3. Scoring: every test, mutants only from those files.
4. Per-mutant comparison with the reference, by identity key, on the mutants both scored.
   - Allowed: survived or no-coverage -> killed.
   - Any other move is a BLOCK, explained before submit. A survived -> no-coverage on a trigger gets PR-06's coverage-"none"
     ground truth.

**Freed error mutants** (12):
1. Scoring with every test, `--only` the mutant's file and `--lines` its line.
2. Comparison by identity key with the reference.
   - Allowed: error -> killed, survived or no-coverage.
   - Still `error` is a finding: the flip does not reach the corpus shape. Named, not a BLOCK.
   - The reference's other mutants on those lines are compared too, under the freed-test rule above.

Ledger: `bun scripts/refusal-ledger.ts --run <id>` over every new store; each NEW cause is named.

Every run goes through `scripts/heavy-slot.sh`, retrying only on exit 75. Budgets: triage 900 s, discovery 1,800 s, scoring
3,600 s.

## References
| key | reference (build) |
|---|---|
| guided | R-985/guided (edge-847b1fa5a) |
| extmgmt | R-932/extmgmt.run (its own build, read at compare) |
| email | R-975/email.fresh (edge-736fc7677) |
| saft | R-958/runs/saft (edge-c8fe56e05) |
| sa | R-902/sa (alpha.13 edge-3096bf68) |
| dv | PR-06 pinned-runs/982-9 (edge-a184cfc79) |

## Predictions
1. Guided Experience: most of its 84 freed tests run on 5a58a0f16, and it gains (at least one allowed move).
2. Extension Management: its 8 freed tests run, and it gains.
3. Each of the 12 freed error mutants leaves `error` (to killed, survived or no-coverage).
4. No BLOCK outside the PR-06 attribution shape (trigger survived -> no-coverage, explained by ground truth).
