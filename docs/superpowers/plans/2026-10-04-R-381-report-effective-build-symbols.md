# R-381: the report records the target's effective build symbols (short plan, r1)

Task: `/coord/tasks/R-381/task.md`. Item: `docs/roadmap/R381.md`. Branch `lethal/lane-preproc` at master ab337484.

## 1. Today (code map, HEAD ab337484)

- **The effective set.** `effectiveBuildSymbols(projectDir, configSymbols, snapshot, backend)` (`preprocessor-symbols.ts:130`) returns the sorted, de-duplicated union of `app.json`, config, and on al-runner the predefined symbols (R392).
  - `runSession` computes it once (`orchestrator.ts` ≈:4607-4619) for the marks, the fingerprint and the store.
  - `generateMutationSet` computes it again for `evaluateArms` (≈:811).
  - `runSession` asserts the two are equal (`sameBuildSymbols`, ≈:4758; `BuildSymbolsDivergedError` otherwise).
- **Where it already lives:** the store (`runs.build_symbols`, `store.ts` ≈:609-618) and the in-process statics (`statics.buildSymbols`, `orchestrator.ts` ≈:6136). The statics are documented "carried only in-process ... not a report field", and today only the marks matching reads them (`report.ts` ≈:2372).
- **The report** has `preprocessorSymbols` (required, report.ts ≈:1350): the CONFIG set only. `excludedSites` carries the effective set only inside a `compiled-out` row's `detail`.
- **How the report is built.** `foldEvents(statics, events)` has ONE caller, `report.ts` ≈:2242, in-process. Statics never travel in the event stream; `preprocessorSymbols` is not in any event either.
- **Readers of the effective set** all read the store:
  - `--resume` (`store.ts` ≈:719 / `orchestrator.ts` ≈:3370);
  - `--resume-run` (≈:805 / `assertSameBuildSymbols` ≈:3298-3413);
  - R214 history (`symbolsChanged`, ≈:1641 / ≈:5233-5250);
  - verify (`verify.ts` ≈:584, ≈:747, ≈:1419-1521);
  - equivalence marks (`equivalence-marks.ts` ≈:244, ≈:277).
- **The agent guide's mark recipe** (`docs/using-lethal-from-an-agent.md` ≈:544-552, step 5) tells the reader to build the set by hand: config plus `app.json`, and on al-runner `CLEANSCHEMA1` to `CLEANSCHEMA25`.

## 2. Change

**(a) The field.** `SessionReport.buildSymbols?: string[]`.
- It is the target's effective build symbols, sorted and de-duplicated, exactly `statics.buildSymbols`.
- It is OPTIONAL in the type and the schema (report stays v3, acceptance 1), so older reports still validate.
- It is WRITTEN ON EVERY NEW REPORT, `[]` included. Absent then means "a report from before R-381", and `[]` means "built with no symbols". That is the difference R381 is about. This is deliberately unlike R-403's `testBuildSymbols`, which is written only when non-empty.
- The doc comment says it is the set the BUILD used: the one `evaluateArms` decided `compiled-out` sites with. It is not the config set; that is `preprocessorSymbols`.

**(b) The value is not computed again** (acceptance 4). The builder reads `statics.buildSymbols`, which is already the value `runSession` computed and asserted equal to generation's. The statics comment changes from "not a report field" to name the field.

**[orchestrator, at adoption] Banner change:** the report holds only the config and effective sets, so it cannot tell an `app.json` symbol from an al-runner predefined one; print `build symbols beyond config: [...]` with NO per-symbol source. Collapse ANY run of consecutive `CLEANSCHEMAn` names (the R392 probe can measure 26..40 or a bare `CLEANSCHEMA`), not only 1..25. Test both. The original wording below is superseded where it conflicts.
**(c) Banner.** One line, printed only when the effective set DIFFERS from the config set: `build symbols (effective): [...]`, plus a note on where the extra ones came from (`app.json`, al-runner predefined). On al-runner it always differs, so the line always prints there. The 25 `CLEANSCHEMA` names are collapsed to `CLEANSCHEMA1..25` when all of them are present. Where config and effective agree, nothing is printed, so bcdev reports without `app.json` symbols are unchanged.

**(d) The ripple** (acceptance 2), each item with whether it changes:

| Step | Changes? |
|---|---|
| `events.ts` | **No.** The value is static and known before any event; the report is built in-process from statics. No stream reader rebuilds a report (`foldEvents` has one caller). |
| `report-fold.ts` | **Doc only** (the `buildSymbols` statics comment). No accumulator, because nothing is folded. |
| `report.ts` | **Yes:** the type (optional field), the builder (always set from statics), the banner line. |
| `bun scripts/generate-schemas.ts` | **Yes:** `schemas/report-v3.schema.json` gains an optional property. `stream-v1` is unchanged, since there is no event. |
| `tests/schemas.test.ts` | **No change to the pinned root-required list** (the field is optional). One new assertion: the property exists and is NOT required. gift-card's committed report still validates, with no regeneration. |
| report-equality snapshot | **Yes:** `bun test <report-equality file> --update-snapshots`, reviewed so that the diff is only the new field. The same goes for any `orchestrator.test.ts` snapshot that prints a whole report. |
| committed sample reports | **No regeneration** (optional field). |

**(e) The agent guide** (acceptance 3). Step 5 of the mark recipe reads the set from `report.buildSymbols`, with a fallback to the old hand-built rule for reports that lack the field (from before R-381).

**(f) Code paths that read the store** (acceptance 3): **none switch.** The store is the source for runs with no report (an interrupted run being resumed, history across runs, verify against a stored run). The report field is the same value written from the same statics, so switching would gain nothing and would lose the no-report case. A test pins that the two agree for a run.

**(g) CHANGELOG.** One Added entry for `buildSymbols`, R381. While touching it, add the R-424 review note under R424's Changed entry: a split helper's body can now raise the same TestPageScanError problems as a plain helper (an unresolved receiver), not only the ruled TestPage case.

## 3. Inputs that move (acceptance 5)

- **Identity:** none (the symbols are in no identity key).
- **Fingerprint:** none. Its `preprocessorSymbols` key is ALREADY the effective set (`resume.ts` ≈:414, fed at `orchestrator.ts` ≈:4661), and nothing about it changes.
- **Explain:** none (no caveat, no explain field).
- **Report:** v3, one optional field.

## 4. Tests (test-first; each red on today's code; each red-checked)

- **Equality with the effective-set function** (acceptance 4), on `runSession`. `report.buildSymbols` equals `effectiveBuildSymbols(projectDir, config, snapshot, backend)` AND the store's `runs.build_symbols` for:
  - config only;
  - target `app.json` only;
  - both;
  - al-runner (predefined included);
  - a run with no symbols at all, which gives `[]`, present.
  - **[orchestrator, at adoption]** `effectiveBuildSymbols` is the same source the store row is written from, so the three can agree while all being wrong. Also assert LITERAL expected sets in the `app.json`-only and al-runner cases (written out in the test, not computed).
- **Same set as the build used:** a run where a site is `compiled-out`. The row's `detail` names the same set as `report.buildSymbols`.
- **Resume:** a resumed run's report carries the same `buildSymbols` as the original's.
- **Schema:**
  - optional and not required;
  - an old report without the field validates;
  - a new report with `[]` validates.
- **Banner:**
  - printed on al-runner, with the `CLEANSCHEMA1..25` collapse;
  - printed when `app.json` adds a symbol;
  - absent when the effective set equals the config set.
- **Red-checks:**
  - build the field from `cfg.preprocessorSymbols` instead of the statics (the `app.json` and al-runner cases go red);
  - omit the field when it is empty (the `[]` case);
  - print the banner unconditionally (the equal case);
  - mark the field required in the schema (the old-report case).

## 5. Gates

The report shape only gains a field; no verdict, discovery or digest changes. Live gates do not assert unknown report fields, so none can move. `itest:alrunner` once on the branch (local) checks the field and banner on a real run. Then close R381 and regenerate the index.
