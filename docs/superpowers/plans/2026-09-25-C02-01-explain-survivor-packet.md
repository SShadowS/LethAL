# C02-01: Per-survivor packet fields in `lethal explain`, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `ExplainSurvivor` row carries `batchIndex`, `triggerName` (when it has one), the enclosing member's line span, its `equivalenceRisk`, its `readerMark`, and the `artifactId` it was scored against (or a token saying why there is none), so an agent can act on one survivor from the `explain` output alone.

**Architecture:** `lethal explain` reads ONE file, the report, and nothing else: no store, no project, no config (`cli.ts:1462`, "`lethal explain` reads only that file, no server, database or config"). So every new field must be on the report's MUTANT ROW (`MutantOutcome`), where `explain` can copy it, or be joinable by `batchIndex` (the artifact). No field is joined by `mutantCode`: **mutant ids restart per batch** (`orchestrator.ts:1073`, `packages/schemata/src/ids.ts:10-25`), so two batches can both hold an `M0001`. Three new row fields are added by this task: the procedure span (at manifest generation, where the enclosing node is already in hand, `project.ts:398`, carried to the row like `hangCapable`, R196), and `equivalenceRisk` and `readerMark` (in `buildReport`, where it already iterates the rows for the run-level lists, `report.ts:2089-2144`). `batchIndex` and `triggerName` are already on the row.

**Tech Stack:** Bun + TypeScript, `bun test`, tree-sitter-al (through `@lethal/engine`).

**Spec:** GitHub issue #11 (child 1 of epic #10, c02): "Add per-row `equivalenceRisk`, `readerMark`, `artifactId`, `batchIndex`, and the enclosing procedure's source span to `ExplainSurvivor`." Consumer downstream: the c02 survivor packet (`lethal harden`), not built here.

**Dependency:** Task 4 needs C02-02 (`SessionReport.artifacts`, `BatchArtifact`, plan `2026-09-25-C02-02-artifact-id-per-batch.md`) merged. Tasks 1 to 3 do not touch artifacts and go first. **Before starting Task 4, the lane must `git merge master` after C02-02 has landed there**, then re-run the full loop once before writing Task 4's first test. If C02-02 has not landed when Task 3 is done, stop and report; do not stub `artifacts` locally.

## Where each field comes from (the decision, with evidence)

| Field | Source | On the report row today? | What `explain` does |
|---|---|---|---|
| `batchIndex` | `MutantOutcome.batchIndex`, required (`report.ts:1398`), written by `buildReport` (`report.ts:1921`) | Yes, on every row of every committed report (148 of 148 rows in `rung1.report.json`) | Copies it. |
| `triggerName` | `MutantOutcome.triggerName`, optional (`report.ts:1499`), written at `report.ts:1950` | Yes, on trigger rows | Copies it. Needed because a trigger row's `procedureName` is `""`. |
| procedure span | The enclosing `procedure` node (`findEnclosingProcedure`, `packages/engine/src/ast/tree-walks.ts:112`), else the enclosing `trigger` node (`triggerNameOf`, `project.ts:428`) | **No.** Only the mutated span's `startIndex`/`endIndex` and `line` (`report.ts:1500`) | Task 1 adds it to the manifest and the row; Task 3 copies it. |
| `equivalenceRisk` | The operator registry, `EQUIVALENCE_RISK_BY_OPERATOR` (`report.ts:1866`), the same map the run-level `likelyEquivalentSurvivors` is built from | **No.** Only the run-level list, keyed by bare `mutantCode` (`report.ts:2089-2112`), which is ambiguous across batches (R231) | Task 2 puts it on each `survived` row; Task 3 copies it. |
| `readerMark` | The marks file (`statics.equivalenceMarks`), matched by R166 identity, exactly as the run-level `readerMarkedEquivalent` is (`report.ts:2118-2144`) | **No.** Only the run-level list, keyed by bare `mutantCode` (R231) | Task 2 puts `{ key, reason }` on each matched row; Task 3 copies it. |
| `artifactId` | `SessionReport.artifacts[].{batchIndex, artifactId}` (C02-02, not merged) | After C02-02, per batch | Joins by `batchIndex`, with the carried rule in Task 4. |

The run-level lists `likelyEquivalentSurvivors` and `readerMarkedEquivalent` are NOT changed here. Their batch ambiguity is R231 (filed separately); `mutation-elements.ts:199` joins the same list by bare `mutantCode` and belongs to R231 too.

Rejected alternatives, and why:
- **Join the run-level lists to survivors by `mutantCode`.** Wrong: ids restart per batch, so one batch's risk or mark would land on another batch's survivor, or a valid report would be refused as a "duplicate" (review round 1, finding 1).
- **Re-parse the project in `explain` to find the procedure span.** `explain` has no project path, and the source may have changed since the run. A re-parse would return the CURRENT file's lines next to a mutant measured on an older revision, silently.
- **Look `equivalenceRisk` up in the operator registry from `explain`.** It applies THIS build's tags to a run made by an older build, `explain`'s admissibility rule (1) keys every statement to a value the REPORT carries (`explain.ts`, module doc comment), and it would pull the engine and every operator into `explain`.
- **Resolve a carried survivor's artifact through the store.** `explain` opens no store by contract (`cli.ts:1462`). See Out of scope.

Public-repo rule: the span is two line numbers. No new field carries source text. `readerMark.reason` is the reader's own text, which the report ALREADY carries in `readerMarkedEquivalent.matched[].reason`; the row gets the same string. `scripts/redact-campaign-report.ts` redacts by a fixed list (`SOURCE_FIELDS`, line 39), so the new fields pass through it unchanged, which is correct.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`. An absent field is a MISSING KEY, never `k: undefined`; tests check absence with `"k" in row`, as `project.test.ts:243` does for `hangCapable`.
- Fail loudly: a report value `explain` BRANCHES on is validated in `assertExplainableReport` and refused with `MalformedReportError`. After this revision that adds only `carried` and `artifacts` (Task 4). The copied row fields are open values and are copied field by field (never an object spread), so an unexpected extra property cannot ride through.
- **`EXPLAIN_SCHEMA_VERSION` stays 4.** Its own rule (`explain.ts:150-171`): a bump is for a field renamed, removed, or changing meaning, or a value domain changing; "Additive FIELDS do not require a bump." Every change here is a new field. No existing field or value domain moves. Precedent: R150 added `survivorSelection` without a bump (`3a925bd`). `ArtifactIdAbsence` is a NEW field's domain.
- **`REPORT_SCHEMA_VERSION` stays 2.** R157's rule (`report.ts:142-158`): an added optional field is free, an added required one bumps. All four new `MutantOutcome` fields (`procedureStartLine`, `procedureEndLine`, `equivalenceRisk`, `readerMark`) are optional. The R157 root-required pin in `schemas.test.ts` must stay green UNCHANGED.
- **Every new `ExplainSurvivor` field is optional in the TYPE and in `schemas/explain-v4.schema.json`**, and NOT in the `survivors.items.required` list, even where this build always writes it (`batchIndex`, and exactly one of `artifactId`/`artifactIdAbsent`). Adding one to that list would make the edited v4 schema reject an explain output stored before this change. The R157 pin checks only ROOT `required` (`schemas.test.ts`, review round 1 finding 4), so Task 3 adds a pin for `survivors.items.required`.
- `explain-v4.schema.json` is HAND-WRITTEN (`scripts/generate-schemas.ts:8`, `schemas/README.md`). Edit it by hand. The report and stream schemas are generated: `bun scripts/generate-schemas.ts`.
- Committed sample reports are NOT regenerated (optional fields; same ruling as C02-02). No live gate is needed: no emitted AL changes (`compileSchemataForFile` is not touched), no verdict path reads the new fields, and the manifest fields change no hash that resume or baseline reuse reads (`astSubtreeHash` hashes `spec.before`; `hashAlTree` reads only `.al` files; review round 1 checked both).
- No em dashes in code comments or docs you write (house style).
- **Orchestrator rulings, 2026-09-25:** (a) R229 and R230 stay separate tasks, not fixed here. (b) `schemas/explain-v4.schema.json` is edited IN PLACE, on R150's precedent; a consumer holding an older copy of v4 that rejects unknown survivor properties is the known cost, recorded in the submit note. (c) `equivalenceRisk` stays an open string, as the report types it; no enum or engine constant is added. (d) Point 3 under "Found while planning" goes to the owner and does not block this task.

## Absence semantics (what each missing key means)

| Field | Present when | Absent means | Absent never means |
|---|---|---|---|
| `batchIndex` | Always, from this build | (only in an explain output written before this change) | |
| `triggerName` | The row is a trigger mutant | The mutant is in a procedure | |
| `procedureStartLine` / `procedureEndLine` | The report row has them | The report predates Task 1, or the site has no enclosing procedure or trigger | That the site is outside any member, for an archived report |
| `equivalenceRisk` | The row is `survived` and its operator declared a risk in the build that wrote the report | Not recorded: the operator declares none, or the report predates this task | "Not equivalent", or "low risk" |
| `readerMark` | A reader mark's key equals this row's R166 identity and the verdict is `survived` or `known-survivor` (the rule `readerMarkedEquivalent.matched` already uses) | Not recorded: no mark matched, the run had no marks file, or the report predates this task | That nobody ever looked at it |
| `artifactId` | This run recorded an artifact for `batchIndex` and the row is not carried | See `artifactIdAbsent`, which is then present | That the verdict came from that binary in every case, see Out of scope |
| `artifactIdAbsent` | `artifactId` is absent | `carried`, `not-recorded`, `not-published`, see Task 4 | |

## Review Focus

1. **An archived report without any of the new fields** (every committed campaign report: no `artifacts`, no row-level `equivalenceRisk`/`readerMark`, no procedure span). Expected: it still projects; every survivor has `batchIndex`; `equivalenceRisk`, `readerMark`, `procedureStartLine`, `procedureEndLine` are missing KEYS, not defaulted, even when the report's run-level `likelyEquivalentSurvivors` or `readerMarkedEquivalent` is present (those are never joined); and after Task 4 every survivor has `artifactIdAbsent` `not-recorded` or `carried`. Pinned in Task 3 (`"an archived report projects the new fields as absent, never defaulted"`) and Task 4 (`"rung1.resumed-run: carried survivors say carried, the rest say not-recorded"`).
2. **Two batches that both contain `M0001`.** Mutant ids restart per batch. Expected: `equivalenceRisk` and `readerMark` are decided per ROW (by the row's operator and the row's identity), so the batch-0 `M0001` and the batch-1 `M0001` get different values when their operators or identities differ, and a marked identity on a NON-surviving row gives that row no `readerMark`. Pinned in Task 2 (`"two batches reusing M0001 keep their own risk and mark"` and `"a killed row whose identity is marked carries no readerMark"`).
3. **A carried survivor, including one in a batch this run DID publish.** Carried rows are recorded inside a batch that is then deployed (`orchestrator.ts:4253-4290`); `resume.test.ts:899` has a run with exactly one carried mutant. Expected: `artifactIdAbsent: "carried"` and NO `artifactId`, even though `artifacts[]` has an entry for its `batchIndex`. Pinned in Task 4 (`"a carried survivor never borrows its batch's artifactId"`).
4. **A batch with no artifact beside a batch with one.** A backend may return `null` from `deploy()` for one batch and an artifact for another, and the run still scores survivors in both (`orchestrator.ts:3629-3793`). Expected: the survivor in the null batch gets `not-published`, the other gets its `artifactId`, and nothing throws. Pinned in Task 4 (`"a batch with no artifact says not-published beside a published one"`).
5. **A survivor whose procedure cannot be located.** A trigger mutant has no enclosing `procedure` and `procedureName: ""`: it must get the TRIGGER's span and its `triggerName`. A site with neither member gets no span keys. Measured 2026-09-25 against the installed grammar: the procedure node starts at the `procedure` keyword line with attributes EXCLUDED, and the trigger node covers `trigger ...` to its `end;`. Pinned in Task 1 (`"manifest entries carry the enclosing member's line span"`, `"a trigger mutant gets the trigger's span"`) and Task 3 (`"a trigger survivor carries triggerName and its span"`).

---

### Task 1: Manifest and report: the enclosing member's line span

**Files:**
- Modify: `packages/schemata/src/project.ts` (`MutantManifestEntry`, near `procedureScope` at line 133; the manifest push at lines 469-491)
- Modify: `packages/runner/src/report.ts` (`MutantOutcome`, next to `startIndex` at line 1500; `buildReport`'s row, next to `hangCapable` at line 1958)
- Regenerate: `bun scripts/generate-schemas.ts` (report-v2 and stream-v1: the stream carries `MutantManifestEntry` on mutant events, `events.ts:302,383,410`)
- Update snapshots if they move: `bun test packages/runner/tests/report-equality.test.ts --update-snapshots`. Read the diff: it may only ADD the two fields.
- Test: `packages/schemata/tests/project.test.ts` (beside the `hangCapable` test at line 243); one report-row test in the runner (see Step 5)

**Interfaces:**
- Produces, on both `MutantManifestEntry` and `MutantOutcome`:
  ```ts
  /**
   * C02-01: the 1-based first and last line of the member enclosing this mutant: its `procedure`,
   * or its `trigger` when there is no procedure (the same member `procedureName || triggerName`
   * names, selection.ts `identityKeyOf`). Computed with the same `lineOfIndex` over the same
   * source as `startLine`, so the two can never disagree about numbering. Starts at the
   * `procedure`/`trigger` keyword line: attributes above it are NOT part of the node (measured).
   * Absent when neither encloses the site, and on reports written before this field existed.
   * Line numbers only, never source text.
   */
  readonly procedureStartLine?: number;
  readonly procedureEndLine?: number;
  ```
- One private helper in `project.ts`: `enclosingMemberOf(spec): ALSyntaxNode | null`, returning `findEnclosingProcedure(spec.before)` or the nearest `ALNodeKind.trigger` ancestor. Reuse it in `triggerNameOf` only if that makes the diff smaller; do not refactor `procedureNameOf`.

- [ ] **Step 1: Write the failing test** in `project.test.ts`, following the `hangCapable` test's shape (same `writeInstrumentedProject` arguments, `NO_TIERS`, `TARGET_APP_ID`):

```ts
it("manifest entries carry the enclosing member's line span (C02-01)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lethal-"));
  try {
    // Line 2 is an attribute, line 3 the declaration, line 7 the mutated statement, line 8 `end;`.
    const src = `codeunit 51044 "Span" {
  [EventSubscriber(ObjectType::Table, Database::Customer, 'OnAfterInsertEvent', '', false, false)]
  local procedure Tagged()
  var
    X: Integer;
  begin
    X := 1;
  end;
}`;
    // build ONE spec on the assignment exactly as the hangCapable test does, then write the project
    const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
    const [entry] = manifest.mutants;
    expect({ start: entry.procedureStartLine, line: entry.startLine, end: entry.procedureEndLine })
      .toEqual({ start: 3, line: 7, end: 8 });
    // Oracle independent of lineOfIndex: the lines themselves, read off the literal.
    const lines = src.split("\n");
    expect(lines[entry.procedureStartLine - 1]).toMatch(/^\s*local procedure Tagged\(\)/);
    expect(lines[entry.procedureEndLine - 1]).toMatch(/^\s*end;\s*$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("a trigger mutant gets the trigger's span, not an absent one (C02-01)", async () => {
  // table 50100 "T" { trigger OnInsert() begin Y := 2; end; } on four lines, the trigger on line 2
  // expect procedureStartLine 2, procedureEndLine 5, and procedureName "" with triggerName "OnInsert"
});
```

  For the neither-member case, do NOT invent a source shape. First try to find a real one (`grep -rn "triggerName === undefined" packages/schemata/tests`, or a spec whose `before` is a table field property). If no operator emits a mutant outside a procedure or trigger, say so in the submit note and pin absence only at the report/explain level (Task 3), where a hand-built row can express it.

- [ ] **Step 2: Run and see them fail**: `bun test packages/schemata/tests/project.test.ts -t "C02-01"`. Expected: FAIL (`procedureStartLine` undefined).
- [ ] **Step 3: Implement** the helper and the two conditional spreads in the manifest push (`lineOfIndex(f.source, node.startIndex)` and `lineOfIndex(f.source, node.endIndex)`), next to `procedureScope`.
- [ ] **Step 4: Carry to the report**: in `buildReport`, next to the `hangCapable` spread at `report.ts:1958`, add both fields with the same conditional-spread shape, read off `o.mutant`. Nothing in `report-fold.ts` changes: it already copies `e.mutant` whole (`report-fold.ts:365`), and a carried row gets the CURRENT run's manifest entry (`replayCarriedBatch` records `m` from `manifest.mutants`, `orchestrator.ts:3549`), so carried rows get a span too.
- [ ] **Step 5: Report-row test.** In `packages/runner/tests/report.test.ts`, beside the R196 `hangCapable` row test (it builds events from a real `MutantManifestEntry` with its `mutant(id, over)` helper) and add: a mutant whose manifest entry has `procedureStartLine: 3, procedureEndLine: 8` shows both on its report row, and a mutant whose entry lacks them has neither KEY (`"procedureStartLine" in row` is false).
- [ ] **Step 6: Regenerate schemas and snapshots** (see Files). Confirm `schemas.test.ts` R157 root-required test is unchanged and green.
- [ ] **Step 7: Run** typecheck, clean dist, `bun test`. Expected: PASS. A whole-entry `toEqual` elsewhere that now fails for the new keys is updated by ADDING the keys to its expectation, never by loosening it to `toMatchObject`. List every such test in the submit note. Then run the `wiring-completeness` subagent on `MutantManifestEntry.procedureStartLine` to confirm no other manifest producer exists (`grep -rn "procedureScope" packages/*/src` is the quick check).
- [ ] **Step 8: Red-checks** (use `mutation-red-checker`; report red then restored green for each):
  - read the END line off `node.startIndex`: the span test goes red on `end`;
  - drop the trigger fallback: the trigger test goes red;
  - drop the `buildReport` spread: the Step 5 test goes red.
- [ ] **Step 9: Commit** `feat(report): each mutant row names its enclosing member's line span (C02-01)`.


### Task 2: Report rows carry `equivalenceRisk` and `readerMark`

**Files:**
- Modify: `packages/runner/src/report.ts` (`MutantOutcome`, next to the Task 1 span fields; `buildReport`'s row loop at `report.ts:1917-1960` and the marks block at `report.ts:2118-2144`)
- Modify: `packages/runner/src/equivalence-marks.ts` (export `SURVIVING_VERDICTS`, line 85; no behaviour change)
- Regenerate: `bun scripts/generate-schemas.ts` (report-v2 only; the stream does not change). Snapshots as in Task 1.
- Test: `packages/runner/tests/report.test.ts`, beside the R196 `hangCapable` row test (it has the `seq` and `mutant(id, over)` helpers and a `buildReport(STATICS, events)` call); give `STATICS` an `equivalenceMarks` override where a test needs one.

**Interfaces:**
- Produces on `MutantOutcome`:
  ```ts
  /** C02-01. The equivalence risk this row's OPERATOR declared (R172), on a `survived` row only:
   *  the same registry lookup `likelyEquivalentSurvivors` is built from, but per row, because
   *  mutant ids restart per batch and that list's bare `mutantCode`s cannot say which batch
   *  (R231). Absent: not recorded, which never means "not equivalent". */
  readonly equivalenceRisk?: string;
  /** C02-01. The reader's mark whose key equals this row's R166 identity, on a `survived` or
   *  `known-survivor` row (the rule `readerMarkedEquivalent.matched` uses). Absent: no mark
   *  matched, or the run had no marks file. A mark on any other verdict stays in `contradicted`
   *  and never appears here. `reason` is the reader's own words. */
  readonly readerMark?: { readonly key: string; readonly reason: string };
  ```
- One module-private `markIdentityOf(m: MutantOutcome): string`, holding the identity expression that is inline at `report.ts:2122-2131` today, used by BOTH the row and the run-level `applyEquivalenceMarks` call. Moved as is, `??` included: changing `??` to `||` is R229's fix, and after this refactor R229 changes one line and fixes both. A `Map<string, EquivalenceMark>` from `statics.equivalenceMarks` by key, built once. Both new fields are attached in the same loop that builds the row, after the row literal exists, with conditional spreads.
- The run-level `likelyEquivalentSurvivors` and `readerMarkedEquivalent` must come out byte-identical to today. Pinned by the test "run-level lists are unchanged by C02-01": BEFORE touching `report.ts`, run the first test's events through today's `buildReport` on master, and paste the COMPLETE two objects (`count`, `byRisk` with `meaning`, `matched`, `stale`, `contradicted`) into the test as literals. The test compares the new build's objects against those literals, never against values derived from the new rows.

- [ ] **Step 1: Write the failing tests** in `report.test.ts`. Operator facts are literals from the registry (`remove-assignment` declares `value-rewrite`, `packages/builtin-tier1/src/remove-assignment.ts:65`; `negate-conditional` declares none), not read back through `EQUIVALENCE_RISK_BY_OPERATOR`:

```ts
test("two batches reusing M0001 keep their own risk and mark (C02-01)", () => {
  // Batch 0: M0001, lethal.remove-assignment, astHash "hash-b0", survived.
  // Batch 1: M0001, lethal.negate-conditional, astHash "hash-b1", survived.
  // One mark, keyed to batch 1's identity: serializeKey(identityKeyOf(<batch-1 entry>)).
  // Copy the two-batch event shape (two mutation-set/baseline pairs) from an existing
  // multi-batch fold test; do not invent event fields.
  const report = buildReport({ ...STATICS, equivalenceMarks: [{ key: KEY_B1, reason: "R-b1" }] }, events);
  const row = (b: number) => report.mutants.find((m) => m.batchIndex === b && m.mutantCode === "M0001");
  expect(row(0)?.equivalenceRisk).toBe("value-rewrite");
  expect("readerMark" in (row(0) ?? {})).toBe(false);
  expect("equivalenceRisk" in (row(1) ?? {})).toBe(false);
  expect(row(1)?.readerMark).toEqual({ key: KEY_B1, reason: "R-b1" });
});

test("a killed row whose identity is marked carries no readerMark, and a killed risk row no risk (C02-01)", () => {
  // One batch: M0001 remove-assignment KILLED, marked; M0002 remove-assignment known-survivor, marked.
  // expect M0001 has neither key; M0002.readerMark toEqual its mark; M0002 has no equivalenceRisk
  // (risk is survived-only, like the run-level list). And the run-level list is unchanged:
  // readerMarkedEquivalent.contradicted names M0001, matched names M0002.
});

test("run-level lists are unchanged by C02-01", () => {
  // literals captured from master before the change; see the bullet above
});

test("row marks and the run-level matched list agree (C02-01)", () => {
  // Reuse the first test's events. The set of (batchIndex, mutantCode) rows carrying readerMark
  // equals, by mutantCode, readerMarkedEquivalent.matched. This pins that both read one identity
  // helper, so R229's fix cannot move one and not the other.
});
```
- [ ] **Step 2: Run and see them fail**: `bun test packages/runner/tests/report.test.ts -t "C02-01"`.
- [ ] **Step 3: Implement** as specified. Regenerate the report schema; confirm the R157 root pin is unchanged.
- [ ] **Step 4: Run** typecheck, clean dist, full `bun test`, biome on touched files.
- [ ] **Step 5: Red-checks** (these are load-bearing because the report keeps EVERY verdict's row, unlike `explain`):
  - look the mark up by `mutantCode` through `marked.matched` instead of by row identity: "two batches" goes red (both `M0001` rows get the mark);
  - drop the `SURVIVING_VERDICTS` filter on the row: "a killed row whose identity is marked" goes red;
  - drop the `verdict === "survived"` filter on the risk: the same test goes red on the known-survivor row;
  - give the row its own copy of the identity expression with `||`: "row marks and the run-level matched list agree" goes red only if the fixture has a trigger row, so add one trigger row (procedureName `""`, triggerName `OnInsert`) with a mark keyed the way the RUN-LEVEL list keys it today. Name that key constant `LEGACY_R229_TRIGGER_KEY` and comment it: it is today's `??` key, which is R229's BUG, not the correct identity; R229's fix changes this constant to the `serializeKey(identityKeyOf(...))` key. A test that reads it as the right key would obstruct R229. Report whether it went red; if it cannot, say so and drop this check rather than keep a check that proves nothing.
- [ ] **Step 6: Commit** `feat(report): each row carries its own equivalence risk and reader mark (C02-01)`.

### Task 3: `explain` copies the row fields

**Files:**
- Modify: `packages/runner/src/explain.ts` (`ExplainSurvivor` at line 251; `survivorOf` at line 663)
- Modify: `schemas/explain-v4.schema.json` (survivor item `properties` only)
- Test: `packages/runner/tests/explain.test.ts` (`survivorMutant` at line 42, `fullCoverageReport` at 365, `EXPLAIN_LEAF_PATHS` at 471, the verbatim test at 652), `packages/runner/tests/schemas.test.ts`

**Interfaces:**
- Produces on `ExplainSurvivor`, all optional, each copied from the row with a conditional spread:
  - `batchIndex?: number`: "the batch of THIS run the row was recorded in; for a carried row it is this run's batch, not the prior run's. Mutant ids restart per batch, so `(batchIndex, mutantCode)` names a row and `mutantCode` alone does not. Always written by this build; optional in the schema so an older explain output still validates."
  - `triggerName?: string`: "present on a trigger mutant, whose `procedureName` is `""`."
  - `procedureStartLine?: number`, `procedureEndLine?: number`: "verbatim from the report row; see `MutantOutcome.procedureStartLine`."
  - `equivalenceRisk?: string`: open string, as the report types it (ruling c). Absent: not recorded.
  - `readerMark?: { readonly key: string; readonly reason: string }`: built as `{ key: m.readerMark.key, reason: m.readerMark.reason }`, never spread.
- `EXPLAIN_CONTRACT.note`: add `readerMark.reason` to the list of prose fields not to parse, and update `PINNED_CONTRACT_NOTE` in the test in the same commit. Prose, so no bump; the equality pin makes the edit visible.
- Schema: add the six properties to `survivors.items.properties` (`integer`, `string`, and `readerMark` as an object with `additionalProperties: false` and `required: ["key", "reason"]`), and NOT to `survivors.items.required`.

- [ ] **Step 1: Make the fixture able to catch a swap.** Give `survivorMutant` an optional `batchIndex` parameter and set `procedureStartLine: 38, procedureEndLine: 51` (distinct from `line: 42` and `startIndex: 100`). In `fullCoverageReport`, give the three survivors batch indexes 1, 4 and 6, give one of them `equivalenceRisk: "value-rewrite"` AND `operatorName: "lethal.remove-assignment"` (the only way `buildReport` can produce that risk is the operator's registry value, `remove-assignment.ts:65`), another `readerMark` whose `key` is the real serialized identity of that row (`serializeKey` over its `astHash`, `codeunitName`, `procedureName`, `operatorName`, `operatorMajor`, `identityOrdinal`, as `report.ts:2122-2131` builds it), not a placeholder like `K-M0002`, and the third `triggerName: "OnValidate"` with `procedureName: ""` (so every new leaf is reached, which the "no dead entries" test needs). Extend the producibility test ("fullCoverageReport describes a state `buildReport` could actually produce") with: `equivalenceRisk` only on `survived` rows, `readerMark` only on `survived` or `known-survivor` rows, every `equivalenceRisk` equal to its operator's registry value (import the operator objects from `@lethal/builtin-tier1`), and every `readerMark.key` equal to the row's serialized identity. Extend the verbatim test's `rowValues` distinctness list with the two span values and `batchIndex`.
- [ ] **Step 2: Write the failing assertions.** Add all six fields to `survivorVerbatim` in the verbatim test (the whole-row `toEqual` near line 703), with `readerMark`/`equivalenceRisk`/`triggerName` compared as present-or-absent KEYS, and seven `[verbatim]` entries to `EXPLAIN_LEAF_PATHS` (`batchIndex`, `triggerName`, `procedureStartLine`, `procedureEndLine`, `equivalenceRisk`, `readerMark.key`, `readerMark.reason`). Then:

```ts
test("an archived report projects the new fields as absent, never defaulted (C02-01)", () => {
  // A pre-C02-01 row: no span, no row-level risk or mark. The RUN-level lists are present and
  // name this row's mutantCode, to prove explain never joins them.
  const row = { ...survivorMutant("M0001", "exact", true) };
  delete (row as { procedureStartLine?: number }).procedureStartLine;
  delete (row as { procedureEndLine?: number }).procedureEndLine;
  const report = reportFixture({
    mutants: [row],
    likelyEquivalentSurvivors: { count: 1, byRisk: [{ risk: "value-rewrite", mutants: ["M0001"], meaning: "m" }] },
    readerMarkedEquivalent: { matched: [{ mutantCode: "M0001", key: "K", reason: "R" }], stale: [], contradicted: [] },
  });
  const [s] = explain(report).survivors;
  expect(s?.batchIndex).toBe(row.batchIndex);
  for (const k of ["procedureStartLine", "procedureEndLine", "equivalenceRisk", "readerMark", "triggerName"]) {
    expect(k in (s ?? {})).toBe(false);
  }
});

test("a trigger survivor carries triggerName and its span (C02-01)", () => {
  // survivorMutant with procedureName "", triggerName "OnInsert", span 11 to 14
  // expect { procedureName: "", triggerName: "OnInsert", procedureStartLine: 11, procedureEndLine: 14 }
});
```
  And in `schemas.test.ts`, beside the R157 root pin:

```ts
test("the explain survivor row's required set is pinned (C02-01)", () => {
  // Nested required lists are not covered by the R157 root pin. A new survivor field added to
  // this list would make the edited v4 schema reject an explain output stored before it.
  const items = ((explainSchema.properties as Record<string, Schema>).survivors?.items ?? {}) as { required?: string[] };
  expect([...(items.required ?? [])].sort()).toEqual([
    "attribution", "codeunitName", "coveringTests", "executionProven", "file", "guardEvidence",
    "guardInterpretation", "interpretation", "line", "mutantCode", "mutatedText", "operatorName",
    "originalText", "procedureName", "reach", "reachInterpretation",
  ]);
});
```
  (That is today's list, `schemas/explain-v4.schema.json:150-181`. Write this test FIRST and see it pass on master before touching the schema.)
- [ ] **Step 3: Run and see them fail**: `bun test packages/runner/tests/explain.test.ts`. Expected: the verbatim test, the leaf-pin equality test and the trigger test go red; the new schema pin is green.
- [ ] **Step 4: Implement** the six fields, the schema properties and the contract note.
- [ ] **Step 5: Run** typecheck, clean dist, `bun test packages/runner`. Expected: PASS, including "the explain schema describes exactly the leaves ExplainOutput declares", the real-report schema validation, every committed campaign report projecting, and string provenance (every new string is on the report row).
- [ ] **Step 6: Red-checks**:
  - swap `procedureStartLine` and `procedureEndLine` in `survivorOf`: the verbatim test goes red;
  - emit `batchIndex: 0` instead of `m.batchIndex`: the verbatim test goes red (why the fixture uses 1, 4, 6);
  - drop the `triggerName` spread: the trigger test goes red;
  - add `"batchIndex"` to `survivors.items.required`: the new schema pin goes red;
  - drop `readerMark.reason` from the contract note but keep the old `PINNED_CONTRACT_NOTE`: the contract pin goes red.
- [ ] **Step 7: Commit** `feat(explain): survivors carry batch, trigger, span, equivalence risk and reader mark (C02-01)`.

### Task 4 (after C02-02 is merged into master and master is merged here): `explain` names the artifact

**Files:**
- Modify: `packages/runner/src/explain.ts`
- Modify: `schemas/explain-v4.schema.json`
- Test: `packages/runner/tests/explain.test.ts`, `packages/runner/tests/schemas.test.ts` (`expectedLeafTypeNames`, enum test)

**Interfaces:**
- Consumes: `SessionReport.artifacts?: readonly BatchArtifact[]` and `BatchArtifact` from `report.ts` (C02-02). Read C02-02's merged doc comment first; if its semantics differ from what this task assumes (one entry per batch THIS run recorded an artifact for; carried batches have none; `[]` when nothing was recorded), stop and report.
- Produces:
  ```ts
  /** Why a survivor has no `artifactId`. Tokens; consumers branch on the exact value.
   *  - `carried`: the verdict was carried by `--resume` from a prior run and measured against
   *    THAT run's artifact, which this report does not name. Wins even when this run recorded an
   *    artifact for the same batch index.
   *  - `not-recorded`: the report has no `artifacts` field at all: written before C02-02.
   *  - `not-published`: the report has `artifacts`, but no entry for this batch: the backend
   *    returned no artifact for it (al-runner, or a `deploy()` that returned `null`). Other
   *    batches of the same run may still have one. */
  export const ARTIFACT_ID_ABSENCES = ["carried", "not-recorded", "not-published"] as const;
  export type ArtifactIdAbsence = (typeof ARTIFACT_ID_ABSENCES)[number];
  ```
  and on `ExplainSurvivor`: `readonly artifactId?: string;` (verbatim from the `artifacts[]` entry whose `batchIndex` equals the row's) and `readonly artifactIdAbsent?: ArtifactIdAbsence;`. This build writes exactly one of the two on every row.
- The rule, in this order, in one small function. It never throws:
  1. `m.carried === true` gives `carried`. First on purpose: Review Focus 3.
  2. `report.artifacts === undefined` gives `not-recorded`.
  3. An entry with `batchIndex === m.batchIndex` gives its `artifactId`. Look up by the FIELD, never by array position.
  4. Otherwise `not-published`.
- `assertExplainableReport` additions, because both are now branched on: `mutant.carried` absent or boolean (like `guardObserved`); `artifacts` absent or an array of objects with an integer `batchIndex >= 0` and a string `artifactId`, no `batchIndex` twice (two entries would make rule 3 a guess). The id's 32-hex shape is a copied open value and is not checked here.
- `PROJECTION_AUTHORED_STRINGS` (test) gains `...ARTIFACT_ID_ABSENCES` ("authored tokens, like TOOL_CONDITIONS"). `expectedLeafTypeNames` gains `"ArtifactIdAbsence"` in `derivedExplainLeafPaths` (explain.test.ts:453) and in `schemas.test.ts`'s explain shape test. The schema gets `artifactId` (`string`) and `artifactIdAbsent` (`enum` equal to `ARTIFACT_ID_ABSENCES`), neither in `required` (the Task 3 pin enforces that), and the "every published enum equals the runtime domain it copies" test gains one line.

- [ ] **Step 1: Write the failing tests.** Fixture ids are literals, so the oracle is the fixture, never the lookup:

```ts
const A1 = "0123456789abcdef0123456789abcdef";
const A4 = "fedcba9876543210fedcba9876543210";
const artifacts = [
  { batchIndex: 1, artifactId: A1, sha256: "a".repeat(64), appVersion: "1.0.1.1" },
  { batchIndex: 4, artifactId: A4, sha256: "b".repeat(64), appVersion: "1.0.1.2" },
];

test("each survivor names the artifact its batch recorded", () => {
  // survivors M0001 in batch 1 and M0001 AGAIN in batch 4 (ids restart per batch). Indexes 1
  // and 4, not 0 and 1, so a lookup by array position fails here.
  // expect the batch-1 row's artifactId A1, the batch-4 row's A4; neither has artifactIdAbsent.
});

test("a carried survivor never borrows its batch's artifactId", () => {
  // the batch-4 survivor with carried: true; batch 4 IS in artifacts
  // expect artifactIdAbsent "carried" and "artifactId" in row false
});

test("a batch with no artifact says not-published beside a published one", () => {
  // artifacts has only batch 1; a non-carried survivor in batch 4 -> "not-published", no throw;
  // the batch-1 survivor still gets A1. And artifacts: [] -> every non-carried survivor "not-published".
});

test("a report without artifacts says not-recorded", () => {}); // reportFixture() as is
test("a malformed artifacts[] is refused", () => {
  // not an array; batchIndex 1 twice; batchIndex "1"; artifactId 7. Each toThrow(MalformedReportError)
});
test("a non-boolean carried is refused", () => {
  // carried: "true" -> toThrow(MalformedReportError), since it now decides artifactIdAbsent
});
```
  And in "explain: the real campaign reports":

```ts
test("rung1.resumed-run: carried survivors say carried, the rest say not-recorded (C02-01)", () => {
  const raw = load("rung1.resumed-run.report.json");
  const out = explain(raw);
  // Keyed by (batchIndex, mutantCode): mutant ids restart per batch.
  const id = (m: { batchIndex?: number; mutantCode: string }) => `${m.batchIndex}/${m.mutantCode}`;
  const carried = new Set(raw.mutants.filter((m) => m.verdict === "survived" && m.carried === true).map(id));
  expect(carried.size).toBe(54); // measured 2026-09-25: 108 survivors, 54 carried
  for (const s of out.survivors) {
    expect("artifactId" in s).toBe(false);
    expect(s.artifactIdAbsent).toBe(carried.has(id(s)) ? "carried" : "not-recorded");
  }
});
```
  Also, inside the existing "every committed campaign report projects without throwing" loop: every survivor has exactly one of `artifactId`/`artifactIdAbsent`. Extend `fullCoverageReport` so both leaves are reached (one survivor with an artifact, one carried), keeping its producibility test true (`resumedFrom.carriedMutants` must then count the carried row; that test already checks it).
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** typecheck, clean dist, full `bun test`, biome on touched files.
- [ ] **Step 5: Red-checks**:
  - move the `carried` check below the batch lookup: "never borrows" goes red;
  - look up `artifacts[m.batchIndex]` by position: "each survivor names the artifact" goes red;
  - treat an absent `artifacts` as `[]`: "not-recorded" goes red (it would say `not-published`), and so does the rung1.resumed-run test;
  - throw instead of rule 4 when `artifacts` is non-empty: "a batch with no artifact says not-published beside a published one" goes red;
  - drop the `carried` type check: "a non-boolean carried is refused" goes red.
- [ ] **Step 6: Commit** `feat(explain): survivors name the artifact they were scored against, or why not (C02-01)`.

## Out of scope, on purpose

- **`artifactId` is NOT "the binary behind this verdict", and C02-04/C02-06 must not treat it as one.** It is the artifact THIS run recorded for the row's batch, and nothing more. Three cases where the verdict came from elsewhere or from a copy:
  - **Carried rows.** A carried verdict was measured against a prior run's artifact. The token says so, but no identity is given, and on a resume of a resume `resumedFrom.runId` names only the IMMEDIATE prior run, which need not have published that batch (`orchestrator.ts:3529-3541`, `4308-4325`). Finding the real artifact needs per-verdict source run/batch provenance, which the report does not carry (the fold drops `mutant-carried.fromRunId`).
  - **Pool workers.** Parallel workers deploy independently and their returned artifacts are discarded (`orchestrator.ts:4350-4380`); `artifacts[]` records only the primary deploy. A verdict a worker produced ran against the worker's copy, whose identity nothing verifies.
  - **Later batches replace earlier ones.** Every batch publishes the same app id, so after a multi-batch run only the highest `batchIndex` is still installed (C02-02).
  A command that re-runs or verifies a survivor against "its" binary needs per-verdict provenance and verified worker identity first. That is its own task.
- **Changing the run-level `likelyEquivalentSurvivors` and `readerMarkedEquivalent`.** Their bare-`mutantCode` ambiguity, and `mutation-elements.ts:199`'s join on it, is R231.
- **An interpretation for `equivalenceRisk`.** The report's `meaning` strings (`EQUIVALENCE_RISK_EXPLANATIONS`, `report.ts:1849`) are plain strings, not `Interpretation`s with a `basis`, so the admissibility rule does not let `explain` emit them.
- **Procedure source text.** Only the span. `originalText` stays the only source field, and it is redacted in committed reports.
- **The marks-matching defects below** (R229, R230). They make `readerMark` absent on some rows; Task 2 only makes sure one fix covers both the row and the run-level list.

## Found while planning (not fixed here; filed as R229 and R230)

1. **R229.** `report.ts:2127` builds the marks identity with `procedureName: m.procedureName ?? m.triggerName ?? ""`. `procedureName` is always a string (`""` for a trigger), so `??` never reaches `triggerName`, while `identityKeyOf` uses `||` (`selection.ts:43`) and `EquivalenceMark.key`'s doc says marks are built with `serializeKey(identityKeyOf(entry))`. A mark on a trigger mutant therefore never matches and is reported `stale`. One character fix (`||`), plus a test.
2. **R230.** `parseEquivalenceMarks` refuses any key without exactly 5 `|` fields (`equivalence-marks.ts`), but `serializeKey` appends a sixth field for a twin with `identityOrdinal > 0` (`selection.ts:62`, R193). A twin after the first cannot be marked at all.
3. `EXPLAIN_SCHEMA_VERSION`'s rule says a value domain growing needs a bump, yet `$.caveats[].caveat` and `$.notMeasured[].cause` grew in place under v4 in `41daa29`, `3923862`, `0451532`, `59081aa` and `80eb608`. Either the rule or the practice is wrong. Not this task's to settle, and this task adds no value to an existing domain.


## Submit note must say

- Which red-checks were run, with their red and restored-green output lines, and whether Task 2's trigger-row check could go red.
- That `EXPLAIN_SCHEMA_VERSION` and `REPORT_SCHEMA_VERSION` did not move, that the R157 root-required pin is unchanged, that the new `survivors.items.required` pin is unchanged, and that no new field is in any schema `required` list except inside `readerMark`.
- That `explain-v4.schema.json` was edited in place (ruling b), and the known cost: a consumer holding an older v4 copy rejects the new survivor properties, because the item has `additionalProperties: false`.
- That the run-level `likelyEquivalentSurvivors` and `readerMarkedEquivalent` are byte-identical to before (Task 2).
- That no committed sample report was regenerated, and why (optional fields).
- Every existing test whose expectation was extended for the new keys (Task 1 Step 7).
- Whether a mutant outside any procedure or trigger exists (Task 1 Step 1), with the evidence.
- The merge commit that brought C02-02 in before Task 4.
