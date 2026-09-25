# C02-02: Record the artifact id per batch in the report and store, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every batch a run publishes leaves its `(batchIndex, artifactId, sha256)` in the store and in the `--out` report as `artifacts[]`, instead of only the LAST batch's id surviving in `runs.artifact_id`.

**Architecture:** The orchestrator already holds `compiled: CompiledArtifact | null` per batch (`packages/runner/src/orchestrator.ts`, step 3d, `cfg.store.recordArtifact(...)`). It gains two jobs there: write one row per batch into a new `batch_artifacts` table, and put `artifactId`/`sha256` on the `batch-published` event it already emits a few lines later. The report is built from the fold's statics plus the event stream (`buildReport(statics, events)`, `report.ts`), and the per-batch facts arrive only as events, so the fold collects those fields into `FoldedReport.artifacts` and `buildReport` copies it to `SessionReport.artifacts`.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, `bun test`.

**Spec:** GitHub issue #12 (child 2 of epic #10, c02): "Report gains `artifacts[]` (batchIndex, artifactId, sha256); today only `runs.artifact_id` holds the last batch." Consumers downstream: C02-04 (run named mutants against an already-published artifact) and C02-01 (`artifactId`/`batchIndex` on `ExplainSurvivor`). Neither is built here.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Fail loudly on contract violations: throw, never return a plausible empty default.
- `SessionReport.artifacts` is **OPTIONAL in the type and schema, ALWAYS written by this build** (an empty array included), exactly like `groupedCalls` (`report.ts`, R198's doc comment). R157's rule (`REPORT_SCHEMA_VERSION` doc comment in `report.ts`): an added optional field is free, an added required one bumps the version. **Do not bump `REPORT_SCHEMA_VERSION`.** A bump would make `explain.ts` refuse every archived v2 report and would force regenerating the committed sample reports live, which the lane may not do.
- `BatchArtifact` carries `appVersion` too (it is on `CompiledArtifact` and on the event already). After a multi-batch run only the HIGHEST `batchIndex` entry is still installed: every batch publishes the same app id, so a later publish replaces the earlier one. The doc comment says so; C02-04 needs it.
- No console banner line for `artifacts` (same as `groupedCalls`: it is machine data, not a finding).
- The `batch-published` event fields are optional too (`appVersion` beside them already is, "so older streams still parse").
- No live gate is needed or allowed for this task. The committed sample reports are NOT regenerated. Orchestrator ruling 2026-09-25, on precedent: `groupedCalls` (R198) and `warmKills` (R206) are optional, always-written fields added after the gift-card sample was last written (2026-08-27), and neither regenerated it. Regenerating needs a live run, which is the owner's call. `schemas.test.ts` still validates the sample because the field is optional; that test proves schema conformance, not that the sample is current, and the submit note must not claim otherwise.

## Review Focus

1. **A backend that returns no artifact** (`deploy()` returns `null`: al-runner, and test fakes such as `resume.test.ts`'s `CountingBackend`, which advertises `deploy: "publish"` yet returns `null`) publishes no artifact. Expected: `artifacts: []` is written, never absent and never a fabricated entry. Pinned in Task 3.
2. **A resumed run whose batch is carried** (R192, `replayCarriedBatch`, no publish). Expected: that batch has NO `artifacts[]` entry in this run's report, because nothing was published for it in this run. The mutants still carry `batchIndex`, so a consumer joining `mutants[].batchIndex` to `artifacts[]` must meet "no entry" rather than a stale id borrowed from the prior run. Pinned in Task 4.
3. **Half an identity on the event**: `artifactId` without `sha256` or the other way round. Expected: the fold throws. Pinned in Task 3.
4. **The same `batchIndex` published twice in one stream**, whether or not either event carries an identity. Expected: the fold throws. (The version-conflict retry at `orchestrator.ts` step 3 re-publishes inside ONE deploy step and emits ONE `batch-published`; this pins that it stays that way.) Pinned in Task 3; the store's primary key refuses it too (Task 1).
5. **A multi-batch run** (`maxGuardsPerBatch: 1`). Expected: two DIFFERENT artifact ids, one per batch, the report and the store agreeing row for row, and `runs.artifact_id` still equal to the LAST batch's (existing behaviour, kept). Pinned in Task 2.

---

### Task 1: Store: one row per published batch

**Files:**
- Modify: `packages/runner/src/store.ts` (the `SCHEMA` string near line 187; `recordArtifact` near line 607)
- Modify: every caller of `recordArtifact` (only `packages/runner/src/orchestrator.ts` step 3d; `grep -rn "recordArtifact" packages` to confirm)
- Test: `packages/runner/tests/store.test.ts` (existing `recordArtifact` tests near lines 116 and 153)

**Interfaces:**
- Produces:
  - Table `batch_artifacts (run_id INTEGER NOT NULL REFERENCES runs(id), batch_index INTEGER NOT NULL, artifact_id TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, app_version TEXT NOT NULL, PRIMARY KEY (run_id, batch_index))`, added to `SCHEMA` with `CREATE TABLE IF NOT EXISTS`. A new TABLE needs no migration step: see the R90 `publish_outcomes` comment in the same file.
  - `recordArtifact(runId: number, info: { batchIndex: number; appVersion: string; appId: string; artifactId: string; sha256: string }): void`. It keeps its current `UPDATE runs ...` (last batch wins, unchanged) AND does a plain `INSERT` into `batch_artifacts` in the same transaction. Plain INSERT on purpose: a second row for the same `(run_id, batch_index)` is a bug, and SQLite's primary-key error is the loud failure.
  - `artifactsForRun(runId: number): BatchArtifact[]` (`BatchArtifact` is defined in Task 3's Interfaces; declare it ONCE, in `store.ts` or a small shared module, and re-export it from `report.ts`), ordered by `batch_index`.

- [ ] **Step 1: Write the failing tests** in `store.test.ts`, next to the existing `recordArtifact` tests:

```ts
test("recordArtifact keeps one row per batch, and runs.artifact_id is the last batch's", () => {
  const store = new ResultsStore(":memory:");
  const runId = store.createRun(/* same args as the neighbouring recordArtifact test */);
  const a = "0123456789abcdef0123456789abcdef";
  const b = "fedcba9876543210fedcba9876543210";
  store.recordArtifact(runId, { batchIndex: 0, appVersion: "1.0.1.1", appId: APP, artifactId: a, sha256: "a".repeat(64) });
  store.recordArtifact(runId, { batchIndex: 1, appVersion: "1.0.1.2", appId: APP, artifactId: b, sha256: "b".repeat(64) });
  expect(store.artifactsForRun(runId)).toEqual([
    { batchIndex: 0, artifactId: a, sha256: "a".repeat(64), appVersion: "1.0.1.1" },
    { batchIndex: 1, artifactId: b, sha256: "b".repeat(64), appVersion: "1.0.1.2" },
  ]);
  const row = store.db.query("SELECT artifact_id FROM runs WHERE id = ?").get(runId) as { artifact_id: string };
  expect(row.artifact_id).toBe(b);
  store.close();
});

test("recordArtifact refuses a second row for the same batch, and changes nothing when it does", () => {
  // same setup; record batchIndex 0 with artifact A, then batchIndex 0 again with artifact B
  // (different appVersion and sha256); the second call must throw, and afterwards ALL FOUR
  // legacy runs columns (app_version, app_id, artifact_id, artifact_sha256) still hold A's
  // values and artifactsForRun still returns only A. This is what proves the UPDATE and the
  // INSERT share one transaction.
});

test("artifactsForRun is empty for a run that published nothing", () => {
  // createRun, no recordArtifact; expect(store.artifactsForRun(runId)).toEqual([])
});
```

Copy the `createRun` arguments and `APP` constant from the existing test at `store.test.ts:116`; do not invent them.

- [ ] **Step 2: Run and see them fail**: `bun test packages/runner/tests/store.test.ts`. Expected: FAIL (`artifactsForRun` is not a function; `batchIndex` is not a known property is a typecheck error, not a test failure, so also expect it there).
- [ ] **Step 3: Implement** the table, the extended `recordArtifact` (wrap the UPDATE and INSERT in `this.db.transaction(...)`), and `artifactsForRun`. Update the one orchestrator caller to pass `batchIndex: batchIdx`.
- [ ] **Step 4: Also add a migration-shape test**: open a `lethal.sqlite` whose schema predates the table (the pattern used for old `runs` columns in `resume.test.ts:714` or `runner-provenance.test.ts:258`), then `recordArtifact` + `artifactsForRun` work. This is what proves `CREATE TABLE IF NOT EXISTS` covers old databases.
- [ ] **Step 5: Run** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/store.test.ts`. Expected: PASS.
- [ ] **Step 6: Red-checks**: (a) change the INSERT to `INSERT OR REPLACE`: the "refuses a second row" test goes red; (b) remove the transaction wrapper: the same test goes red on the runs columns. Restore both.
- [ ] **Step 7: Commit** `feat(store): record every published batch's artifact id (C02-02)`.

### Task 2: Orchestrator: the event carries the identity

**Files:**
- Modify: `packages/runner/src/events.ts` (the `batch-published` member, near line 167)
- Modify: `packages/runner/src/orchestrator.ts` (the `emit({ type: "batch-published", ... })` right after step 3e, near line 3773)
- Test: `packages/runner/tests/orchestrator.test.ts`, in `describe("runSession — Layer 5A deployment identity")` (near line 3182), which uses `PhaseBackend` (it returns a real-shaped `CompiledArtifact`)

**Interfaces:**
- Consumes: `recordArtifact`'s new `batchIndex` (Task 1), `artifactsForRun` (Task 1).
- Produces: on the `batch-published` event, `readonly artifactId?: string; readonly sha256?: string;` (the existing optional `appVersion` stays) with a doc comment: present exactly when the backend compiled an artifact (`compiled !== null`), both or neither; absent on a `deploy: "none"` backend and on older streams. Emitted as `...(compiled !== null ? { artifactId: compiled.artifactId, sha256: compiled.sha256 } : {})`.
- Worker deploys (`orchestrator.ts` ~4358-4376, the parallel-worker path) discard their returned artifact today and emit nothing. They deploy the SAME `batchDir`, whose `artifactId` `prepareArtifactDir` already baked in, so they are copies of the batch's artifact, not new identities. Leave that path unchanged and add one comment line there saying `artifacts[]` records the primary publish per batch. Only non-authoritative backends can have workers (`orchestrator.ts` ~3310-3321).

- [ ] **Step 1: Write the failing test** in the Layer 5A describe block:

```ts
test("every published batch's identity reaches both the event and the store (C02-02)", async () => {
  const dirs = await makeProject();
  // add a second carrier file so maxGuardsPerBatch: 1 splits the run in two, exactly as the
  // test near orchestrator.test.ts:1264 does ("SandboxExtra.Codeunit.al", codeunit 79002)
  const store = new ResultsStore(":memory:");
  const events: RunEvent[] = [];
  const report = await runSession({
    backend: new PhaseBackend(), store, ...dirs, selectorIds,
    maxGuardsPerBatch: 1, emit: [(e) => events.push(e)],
  });
  expect(report.batches).toBe(2);
  const published = events.flatMap((e) =>
    e.type === "batch-published" ? [{ batchIndex: e.batchIndex, artifactId: e.artifactId, sha256: e.sha256, appVersion: e.appVersion }] : []);
  expect(published).toHaveLength(2);
  const runId = /* the single run's id: SELECT id FROM runs */;
  expect(store.artifactsForRun(runId)).toEqual(published);
  expect(new Set(published.map((p) => p.artifactId)).size).toBe(2);
  for (const p of published) {
    expect(p.artifactId).toMatch(/^[0-9a-f]{32}$/);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  const last = store.db.query("SELECT artifact_id FROM runs LIMIT 1").get() as { artifact_id: string };
  expect(last.artifact_id).toBe(published[1]?.artifactId);
  store.close();
});
```

**The oracle must be independent of the code under test.** Give `PhaseBackend` a `returned: CompiledArtifact[]` list that records each exact object `deploy()` returns, and make its `sha256` differ per artifact (for example derived from the artifact id) instead of the current constant. Then compare the event list, `artifactsForRun`, and `runs.artifact_id` each against `backend.returned` (`{ batchIndex: i, artifactId, sha256, appVersion }` of `returned[i]`), never against each other: event and store agreeing only proves they agree, and both could copy the wrong identity. If `PhaseBackend` echoes the same `artifactId` for both batches, that is a fixture bug to fix in the fixture (the orchestrator mints one per batch via `newArtifactId()`), not a reason to drop the "two distinct ids" line.

- [ ] **Step 2: Run and see it fail**: `bun test packages/runner/tests/orchestrator.test.ts -t "C02-02"`. Expected: FAIL (`artifactId` undefined on the event).
- [ ] **Step 3: Implement** the two optional event fields and the conditional spread at the emit site.
- [ ] **Step 4: Run** typecheck, clean dist, `bun test packages/runner`. Expected: PASS, and no other orchestrator/events test changes.
- [ ] **Step 5: Red-check**: drop the spread at the emit site; the new test must go red on `published`. Restore.
- [ ] **Step 6: Commit** `feat(runner): batch-published names the artifact it published (C02-02)`.

### Task 3: Report: fold and build `artifacts[]`

**Files:**
- Modify: `packages/runner/src/report-fold.ts` (`FoldedReport` near line 90; the `case "batch-published"` near line 297; the return object near line 557)
- Modify: `packages/runner/src/report.ts` (`SessionReport`, next to `groupedCalls` near line 1236; `buildReport`'s object near line 2335)
- Regenerate: `bun scripts/generate-schemas.ts` (updates `schemas/report-v2.schema.json` and `schemas/stream-v1.schema.json`)
- Update: `packages/runner/tests/schemas.test.ts` only if it pins something this changes. The ROOT `required` set must NOT change; if it does, the field was made required by mistake.
- Update snapshots: `bun test packages/runner/tests/report-equality.test.ts --update-snapshots` (or wherever the report-equality snapshot lives: `grep -rln report-equality packages/runner/tests`). Read the snapshot diff: it must add `artifacts` and change nothing else.
- Test: `packages/runner/tests/report-fold.test.ts` (uses `foldEvents(STATICS, seq([...]))`, see lines 95-140)

**Interfaces:**
- Consumes: the event fields from Task 2.
- Produces:
  - `FoldedReport.artifacts: readonly BatchArtifact[]` (required on the internal type; always set).
  - Exported from `report.ts`: `export interface BatchArtifact { readonly batchIndex: number; readonly artifactId: string; readonly sha256: string; readonly appVersion: string; }`
  - `SessionReport.artifacts?: readonly BatchArtifact[]`, sorted by `batchIndex`, with a doc comment that says: one entry per batch THIS run published; optional in the schema for archived reports, always written by this build, `[]` included; empty on a `deploy: "none"` backend; a batch carried by `--resume` (R192) has no entry, because nothing was published for it in this run; `runs.artifact_id` in the store still holds only the last one.

- [ ] **Step 1: Write the failing fold tests** in `report-fold.test.ts`, built from the existing "accepts the quarantined path" event list (line ~117) so every mandatory event is present:

```ts
const ID0 = "0123456789abcdef0123456789abcdef";
const ID1 = "fedcba9876543210fedcba9876543210";

test("artifacts[] lists each published batch's identity, sorted by batchIndex", () => {
  // two batch-published events, batchIndex 1 FIRST then 0, each with artifactId + sha256 + appVersion
  // expect(foldEvents(STATICS, events).artifacts).toEqual([{ batchIndex: 0, artifactId: ID0, sha256: "a".repeat(64), appVersion: "1.0.1.1" }, { batchIndex: 1, artifactId: ID1, sha256: "b".repeat(64), appVersion: "1.0.1.2" }])
});
test("artifacts[] is [] when batch-published carries no identity (deploy: none)", () => {
  // the existing event list unchanged; expect(...artifacts).toEqual([])
});
test("THROWS on half an identity", () => {
  // artifactId without sha256 -> toThrow(/artifactId.*sha256|sha256.*artifactId/s); and the reverse
});
test("THROWS when one batchIndex is published twice", () => {
  // three cases, each toThrow(/batch 0.*published twice/): both events with an identity; both
  // WITHOUT one; one without then one with
});
test("THROWS when an identity event has no appVersion", () => {
  // artifactId + sha256 present, appVersion absent -> toThrow
});
```

Also add, in the orchestrator test from Task 2: `expect(report.artifacts).toEqual(store.artifactsForRun(runId))`. And one `deploy: "none"` end-to-end check: pick an existing `runSession` test whose backend's `deploy()` returns `null` and assert `report.artifacts` is `[]` (not `undefined`).

- [ ] **Step 2: Run and see them fail**: `bun test packages/runner/tests/report-fold.test.ts`.
- [ ] **Step 3: Implement.** In the fold: keep a `Set<number>` of EVERY published batchIndex and a `Map<number, BatchArtifact>`. On `batch-published`: if the set already holds the batchIndex throw `foldEvents: batch <n> published twice ...` (checked first, identity or not); add it; if exactly one of `artifactId`/`sha256` is present throw `foldEvents: batch-published for batch <n> carries artifactId without sha256 (or the reverse) ...`; if both are present but `appVersion` is absent throw; if all three are present set the map entry. `finalize()` returns entries sorted by `batchIndex`. In `buildReport`: `artifacts: input.artifacts`.
- [ ] **Step 4: Regenerate schemas and snapshots** as listed under Files, read both diffs.
- [ ] **Step 5: Run** typecheck, clean dist, full `bun test`. Expected: PASS. `bunx biome check` on every touched file.
- [ ] **Step 6: Red-checks** (report each, red then restored green):
  - remove the half-identity throw: the "half an identity" test goes red;
  - move the duplicate check inside the "identity present" branch: the identity-less duplicate cases go red;
  - remove the sort: the "sorted by batchIndex" test goes red (this is why that test emits batch 1 first);
  - write `artifacts: input.artifacts.length > 0 ? input.artifacts : undefined` in `buildReport`: the `deploy: "none"` test goes red.
- [ ] **Step 7: Commit** `feat(report): artifacts[] names every published batch (C02-02)`.

### Task 4: Resume: a carried batch has no entry

**Files:**
- Test: `packages/runner/tests/resume.test.ts` (the R192 test around lines 925-960, with `maxGuardsPerBatch: 1` and `resume: "last"`)

**Interfaces:**
- Consumes: `SessionReport.artifacts` (Task 3).

`CountingBackend` in that file returns `null` from `deploy()`, so as written `report.artifacts` would be `[]` in both runs and an assertion on it would pass whether or not the carried batch is handled: the "passes for the wrong reason" hazard. Give it an opt-in that returns a `CompiledArtifact` (a fresh 32-hex `artifactId` and a 64-hex `sha256` per deploy; build the remaining fields the way `PhaseBackend.compileArtifact` does at `orchestrator.test.ts:3116`) and use it in this test only.

- [ ] **Step 1: Write the failing assertions** in that test (or a sibling that reuses its setup): first run `(firstReport.artifacts ?? []).map((a) => a.batchIndex)` equals `[0, 1]`, after `expect(firstReport.artifacts).toBeDefined()` (the field is optional in the type); the resumed run, read the same way, equals `[1]`; and the resumed batch-1 `artifactId` differs from the first run's batch-1 id.
- [ ] **Step 2: Run** `bun test packages/runner/tests/resume.test.ts`. Expected: FAIL only until the backend opt-in exists; once it does, this should PASS with no production change (the carried path emits no `batch-published`). If it does not pass, stop and report: that is a real finding, not a test to adjust.
- [ ] **Step 3: Red-check**: temporarily make `replayCarriedBatch`'s caller emit a `batch-published` with the prior run's identity for the carried batch; the test must go red. Restore.
- [ ] **Step 4: Full loop**: typecheck, clean dist, `bun test`, biome on touched files.
- [ ] **Step 5: Commit** `test(resume): a carried batch publishes no artifact (C02-02)`.

## Out of scope, on purpose

- **A carried batch's prior artifact.** A batch carried by `--resume` keeps verdicts measured against the PRIOR run's artifact, and this report does not name it (the fold drops the per-mutant `mutant-carried.fromRunId` today; only `resumedFrom.runId` survives). Getting that id needs the store (`artifactsForRun(<prior run>)`) and a batch mapping across runs. That is C02-01's problem when it puts `artifactId` on a survivor, and its plan will say how. Do not add it here.
- **Re-running an earlier batch's artifact.** Only the last batch stays installed. `appPath` is not recorded.

## Submit note must say

- Which red-checks were run and their red/green output lines.
- That `REPORT_SCHEMA_VERSION` did not move and the schema root `required` set did not change.
- That no committed sample report was regenerated, and why that is correct (optional field).
