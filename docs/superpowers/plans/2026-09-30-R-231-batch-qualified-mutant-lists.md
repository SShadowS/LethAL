# R-231: batch-qualified mutant lists (short plan)

**Problem.** `assignMutantIds` restarts at `M0001` per batch. Run-level report lists name mutants by
bare `mutantCode`, so on a multi-batch run a reader can join one batch's fact to another batch's row.
Not hypothetical: the committed `docs/campaign/2026-08-03-do/rung2.report.json` has 4 batches and
195 codes that occur in more than one batch (it predates these lists, so it carries none of them).

**Rows already carry `batchIndex`** (`MutantOutcome.batchIndex`, report.ts:1483), plus
`equivalenceRisk`, `readerMark` and `platformKillMechanism`. So no row change is needed first.

## 1. Every field (found by grep for `mutantCode`/`mutantId` in report lists, not memory)

| SessionReport path | Type / built | Readers | Meaning |
|---|---|---|---|
| `platformArtifactKills.byMechanism[].mutants` | report.ts:1098 / 2353-2361, 2398-2406 | tables.itest.ts:1026-1040, mutation-elements.ts:162 (count only) | killed mutants whose kill may be a platform artifact |
| `likelyEquivalentSurvivors.byRisk[].mutants` | report.ts:1357 / 2366-2385 | **mutation-elements.ts:199-201 (joins by code: WRONG JOIN today)**, harden-expected.ts:326-340, verify-agreement.itest.ts:569-574 | survivors whose operator declares an equivalence risk |
| `assertionScreen.flaggedMutants` | report.ts:1139 / 2441 | tables.itest.ts:1148-1150, 1389-1478 | kills with no `Assert.` text |
| `assertionScreen.runnerRefusalMutants` | report.ts:1151 / 2445 | none outside tests | flagged kills that are al-runner `out-of-scope:` refusals |
| `unplaceableMutants` | report.ts:1338 / report-fold.ts:270, 398, 639, fed by events.ts:283 (orchestrator.ts:4973, 7738) | mutation-elements.ts:198 (joins by code), bcdev.itest.ts:628 and tables.itest.ts:969 (print), scripts/r175-rung1-rerun-compare.ts:214 (archived v2 input, leave) | no-coverage because attribution could not name the member. **Also loses data today:** the fold adds codes to a `Set`, so two batches' `M0001` collapse into one entry while `unplaceableCount` counts two |
| `readerMarkedEquivalent.matched[].mutantCode`, `.contradicted[].mutantCode` | report.ts:1376-1392 / 2193-2216 via equivalence-marks.ts:71-86, 239-245 | verify-agreement.ts:47 (joins by code), harden-expected.ts:349-363, banner report.ts:2823, 2836 | a reader's mark matched, or refuted, on this mutant |
| `survivorsByProcedure[].survivorCodes` | report.ts:849 / 2265-2291 | tests only | survivors in one procedure. Safe today only because `planArtifacts` splits at FILE granularity (orchestrator.ts:1221), so a group's `file` implies its batch |

Also bare codes in human text: banner report.ts:2823, 2836, 2958 and equivalence-marks.ts:260.
Checked and clean: `explain.ts` (already keys rows and gaps by `batchIndex`), `verify.ts` (already
uses `<batchIndex>/<mutantCode>`), `campaign-*.ts` (reads none of these lists; baselines are per-row).
`group-call.mutantId` (events.ts:459) is only counted, never listed.

## 2. Fix shape

- **String lists** (the first five rows plus `survivorCodes`): each entry becomes the token
  `<batchIndex>/<mutantCode>`, for example `0/M0001`. Reason: element type stays `string`, and it is
  the exact id `lethal verify --survivors` already parses (verify.ts:182-212), so a list entry can be
  pasted into verify. One exported helper `mutantRef(batchIndex, code)` in report.ts, used by the
  builder, the fold, the banner, mutation-elements and verify.ts's inline copies.
  `survivorCodes` is tokenised too: its safety rests on a batching rule a later change could break.
- **Mark objects** (`matched`, `contradicted`): add a required `batchIndex: number` beside
  `mutantCode`, sort by `(batchIndex, mutantCode)`. Reason: they are already objects, and this is the
  `{ batchIndex, mutantCode }` shape verify's request and rows use; `mutantCode` keeps its meaning.
- **Events:** `coverage-split` already carries `batchIndex`, so the event keeps bare codes (no stream
  schema bump) and the FOLD qualifies them. That also fixes the `Set` collapse.
- Not "move onto the row": C02-01 already did that for risk and mark; the lists stay because gates
  pin them by name.

## 3. Schema version

`REPORT_SCHEMA_VERSION` (report.ts:185): **2 -> 3**. Under its R157 rule a changed MEANING bumps,
and every list element's meaning changes. `schemas/report-v2.schema.json` stays as a frozen archive
(like `explain-v4/v5`); `generate-schemas.ts` writes `report-v3.schema.json`.

**Side effect to decide:** `assertExplainableReport` (explain.ts:672) refuses any other version, so
`lethal explain` would refuse all 10 committed v2 reports, and schemas.test.ts:305-330 and 375 project
the third-party DO `rung2.report.json`, which cannot be regenerated. Proposal: explain accepts
`{2, 3}`, with a comment that explain reads none of the R231 lists.

## 4. Ripple checklist

- [ ] events.ts: doc comment only (codes stay per-batch there).
- [ ] report-fold.ts: `unplaceableMutants` accumulator becomes a list of tokens built with `e.batchIndex`.
- [ ] report.ts: types (doc comments + mark `batchIndex`), builder, banner, `mutantRef`, version 3.
- [ ] equivalence-marks.ts: input rows and output entries carry `batchIndex`; its render line.
- [ ] mutation-elements.ts:198-201 and `describe`: look up by `mutantRef(m.batchIndex, m.mutantCode)`.
- [ ] explain.ts:672: accepted versions (pending the decision above). verify.ts: use `mutantRef`.
- [ ] `bun scripts/generate-schemas.ts` (target file renamed in generate-schemas.ts:316-320).
- [ ] tests/schemas.test.ts: load v3 at :738; add `report-v3.schema.json` to the root-required pin
  (:871, set unchanged); the OLDER-reports test keeps validating r85 `rung2` against the frozen v2
  file; the gift-card "this build validates" tests (:771, :1132) need the regenerated report.
- [ ] `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`; tests/helpers/legacy-report.ts if it builds these lists.
- [ ] itest readers: harden-expected.ts, verify-agreement.ts:47 (also match `batchIndex`),
  verify-agreement.itest.ts:573, tables.itest.ts (byMechanism and three twin-pair helpers).
- [ ] No new Caveat, so `CAVEAT_INTERPRETATIONS` and interpretation counts are untouched.

## 5. Committed sample reports

Only the two that tests read as CURRENT-build output must move to v3:
`docs/campaign/2026-08-16-gift-card/rehearsal.report.json` and `examples/credit-limit/demo.report.json`
(schemas.test, agent-contract.test.ts:1369, verify.test.ts:878, 1478, README `lethal explain`). Both
are single-batch, so only `schemaVersion` and the list strings should change. Per CLAUDE.md, regenerate
LIVE on **Cronus28** (under a coord lease) with `lethal campaign freeze` for each stage, then diff: any
per-mutant verdict change is a block. Neither needs redaction: both are in
`scripts/redact-first-party-reports.json` (credit-limit passes `--check`; gift-card is allowlisted).
The other 8 committed reports stay archived v2, untouched.

## 6. The multi-batch test (fails today)

Mechanism: unit tests build two batches directly (outcomes and `coverage-split` events with
`batchIndex` 0 and 1, both `M0001`), the same split `maxGuardsPerBatch: 1` with two carrier files
produces in orchestrator.test.ts:1376-1421.
- `packages/runner/tests/report-fold.test.ts`: two `coverage-split` events, each `unplaceableMutants: ["M0001"]`.
  Assert `unplaceableMutants` equals `["0/M0001", "1/M0001"]` and its length equals `unplaceableCount` (2).
  Today: `["M0001"]`, length 1.
- `packages/runner/tests/mutation-elements.test.ts`: batch 0 `M0001` in file A survived with no risk,
  batch 1 `M0001` in file B survived under a `value-rewrite` operator. Assert file A's element is NOT
  described as likely equivalent. Today it is.
- `packages/runner/tests/report.test.ts`: same pair through `buildReport` with a batch-1 platform kill
  and a mark; every list entry resolves to exactly one row by `(batchIndex, mutantCode)`, and to the batch-1 row.

Red-check: with the tests in place, revert each fix (bare code in the fold, in mutation-elements, in
the builder); confirm each test goes red; restore; report both runs.

## 7. Tasks

1. **Red tests** (report-fold, mutation-elements, report tests above). Commit failing-first evidence in the task log.
2. **Fix + bump**: report.ts, report-fold.ts, equivalence-marks.ts, mutation-elements.ts, verify.ts,
   explain.ts, generate-schemas.ts, schemas/report-v3.schema.json, schemas.test.ts, report-equality
   snapshot, itest readers. `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`, biome on touched files, red-check.
3. **Live** on Cronus28: regenerate the two sample reports; run `itest:tables` and the harden and
   verify-agreement gates whose assertions changed; per-mutant equality.
4. **Roadmap**: R231 `done (<commit>)`, `bun scripts/roadmap-index.ts`.
