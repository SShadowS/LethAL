# R-351 plan: name renamed split members in the report, explain and the killer-first order

**Spec:** `H:/lethal-coord/tasks/R-351/task.md`, `docs/roadmap/R351.md`. Background: `docs/roadmap/R318.md`, `docs/superpowers/plans/2026-09-29-R-318-renamed-split-members.md` (Decision 6). HEAD `9912aaa5`, `IDENTITY_SCHEME` 4, report v3, explain v7. Offline only: no al-runner, no live BC.

**Terms.** A *renamed split member* is a procedure whose `#if` arms give it different names. Its manifest entries have `procedureName: ""` and `coverageArmNames` (the arm names no other declaration uses; `["Pick","Choose"]` in `r1`, `["Alpha"]` and `["Gamma"]` in `r4`). The field is set only when the list is non-empty (`project.ts`).

## Decisions

**D1. One shared member name, never an identity.** Add `memberGroupNameOf(m)` to `selection.ts`, beside `identityKeyOf`: `m.procedureName || m.triggerName || (m.coverageArmNames !== undefined ? JSON.stringify(m.coverageArmNames) : "")`. JSON of the list is unambiguous: it starts with `[` and holds `"`, which no AL identifier (quoted or not) can contain, so it cannot equal a real procedure or trigger name. No case folding: the list is fixed per member, and R318 rule 2 makes the lists of two members disjoint. `identityKeyOf` and `markIdentityOf` are NOT changed. A member whose every arm name is taken has no list and stays in `""` (R318's named open shape, 0 sites).

**D2. Report field: the list, not a display name.** `MutantOutcome.coverageArmNames?: readonly string[]`, copied verbatim from `o.mutant.coverageArmNames` in the row builder, a SITE property like `hangCapable`. Absent on every ordinary member, so older reports stay valid. Why the list: it is the fact the manifest holds, and a joined display string would be a new authored string that explain's string-provenance check would refuse. `SurvivorGroup.coverageArmNames?` too, else two groups in the JSON read the same (`file`, `codeunitName`, `procedureName: ""`). The group key becomes `${file}::${memberGroupNameOf(m) || "<object>"}`. The console banner prints `Repro R.Alpha` (names joined by `/`) instead of `Repro R.<object>`.

**D3. Filled from the event stream with no event change.** `mutant-scored` and `mutant-carried` already carry the whole `MutantManifestEntry`, and `stream-v1.schema.json` already lists `coverageArmNames` (R318). `report-fold.ts` passes `o.mutant` through. So `events.ts` and `report-fold.ts` need no edit.

**D4. Report schema: additive under v3, no bump.** R157's rule (`report.ts` above `REPORT_SCHEMA_VERSION`): an added OPTIONAL field is free. The CLAUDE.md ripple, step by step:
- `events.ts`, `report-fold.ts`: no-op (D3).
- `report.ts`: two optional type fields, the row spread, the group key, the banner.
- `bun scripts/generate-schemas.ts`: `report-v3.schema.json` gains two optional properties; `--check` then passes.
- `schemas.test.ts`: the root required set is unchanged (both fields are nested and optional); the older-reports test reads the frozen v2 file and is unchanged. Expect no edit; run it.
- `report-equality`: `golden-report-input.json` has no `coverageArmNames`, so the snapshot must NOT change. Run WITHOUT `--update-snapshots`; a diff there is a bug.
- Sample reports: **no live regeneration needed.** The only one `schemas.test.ts` validates is `docs/campaign/2026-08-16-gift-card/rehearsal.report.json`; an absent optional field validates. It is a record of the build that wrote it, and a rerun would add the field only if that project had a renamed member. Decided here; the orchestrator can overrule.
- No new `Caveat`.

**D5. explain names the member, additive under v7.** Today a renamed member's survivor reads `procedureName: ""` with no `triggerName`: nothing names it; same for its `gaps[]` and `noCoverageBlocks[]` entries. After: optional `coverageArmNames` on `ExplainSurvivor` and on the shared `location` object (so `ExplainGap` and `ExplainNoCoverageBlock`), copied field by field like `triggerName`. `EXPLAIN_SCHEMA_VERSION` doc: additive fields do not bump (v7 bumped only because `markKey` is required). Edit `schemas/explain-v7.schema.json` in place (hand-written, pinned against the declaration, not frozen). `explain.test.ts`: three new `[verbatim]` entries in `EXPLAIN_LEAF_PATHS`, a renamed row in `fullCoverageReport` with pairwise-distinct names, asserted in the whole-row verbatim test. The survivor required-set pin is unchanged.

**D6. Killer-first order.** `procedureScopeOf(m)` in `test-order.ts` returns `${m.codeunitName}|${memberGroupNameOf(m)}`. Order only; the verdict path does not read it.

**D7. No verdict or killingTest moves on the fixtures.** `coverageArmNames` is computed positionally on the original source, independent of preprocessor symbols (R318 Decision 4), and R318's census found 0 renamed members in the 70 fixture files. So for every fixture mutant `memberGroupNameOf(m)` equals today's `procedureName || triggerName || ""`, the ledger keys are the same strings, the buckets hold the same kills, and `orderCoveringTests` returns the same order for the same scoring order. `killingTest` (R197) depends only on that order, so it cannot change. A test pins it (T5).

**D8. Identity does not move.** No `IDENTITY_SCHEME` bump. Pinned by `preproc-instrumentation.test.ts` "identity keys are HEAD's, byte for byte" (r1 and r4 literals, `procedureName` segment `""`) and `resume.test.ts` `expect(IDENTITY_SCHEME).toBe(4)`. T4 also asserts both `r4` members' keys still have `""` in the name segment.

## Tests (in `preproc-instrumentation.test.ts`, reusing `R318_R1`, `R318_R4` and `instrument`; events built as `report.test.ts` builds them)
- **T1 (r1 row):** a `survived` member mutant and a `Plain` one through `buildReport`: the member row has `coverageArmNames: ["Pick","Choose"]`, the `Plain` row has no such key. Red: delete the row spread.
- **T2 (r4 groups):** one survived mutant per member: `survivorsByProcedure` has two groups, `["Alpha"]` and `["Gamma"]`; `renderConsole` shows `Repro R.Alpha` and `Repro R.Gamma` and no `<object>`. Red: restore the old group key, one group appears.
- **T3 (explain):** project T2's report plus one `no-coverage` member row: `survivors[].coverageArmNames` and `noCoverageBlocks[].coverageArmNames` name each member. Red: delete the survivor copy, then the `location` copy, one at a time.
- **T4 (test-order, `test-order.test.ts` style on real `r4` entries):** a kill by test `B` in the `Alpha` member; for a second `Alpha` mutant `[A,B]` orders `[B,A]`, for a `Gamma` mutant it stays `[A,B]`. Red: restore `procedureName || triggerName || ""`, the `Gamma` order becomes `[B,A]`.
- **T5 (fixture census):** `generateMutationSet` plus `writeInstrumentedProject` to a temp dir for `fixtures/sandbox-app`, `sandbox-data`, `sandbox-hang`, `sandbox-symbols`; for every mutant `memberGroupNameOf(m) === (m.procedureName || m.triggerName || "")`. Also assert the mutant count is non-zero per fixture, so an empty manifest cannot pass. Red: add `R318_R1` as a fifth project to the loop; the check must fail on its ten member mutants. Remove it. (Mutating the helper cannot red-check this test, since no fixture mutant carries the field; that is the fact it pins.)

## Tasks (each: typecheck, `rm -rf packages/*/dist`, the named tests, red-check, restore)
1. `selection.ts` `memberGroupNameOf`; `test-order.ts` `procedureScopeOf`; T4, T5. Red-checks as above.
2. `report.ts` fields, row spread, group key, banner; `bun scripts/generate-schemas.ts`; T1, T2. Run `schemas.test.ts` and `report-equality.test.ts` unchanged (both must pass with no snapshot update). Red-checks T1, T2.
3. `explain.ts` survivor and `location` copies; `schemas/explain-v7.schema.json`; `explain.test.ts` leaf pins and fixture row; T3. Red-check T3 (both copies) and confirm the reachability test goes red if the fixture row is removed.
4. `docs/roadmap/R351.md` status `done (<commit>)`, `bun scripts/roadmap-index.ts`; full `bun test` from the repo root; `bunx biome check` on touched files only.

## Open questions
None undecidable. The one call an orchestrator may want to overrule is D4's "no live sample regeneration".
