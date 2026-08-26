# Excluded-Sites Spine (A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two duplicated "sites we deliberately did not mutate" records with one `excludedSites` record keyed by reason, keeping `notInstrumented` and `declarativeSites` as derived views, and add the first check that can actually fail when the `notInstrumented` half is broken.

**Architecture:** A new pure module builds the merged record from the two arrays the `mutation-set-generated` event already carries, and derives both legacy views from it. `buildReport` consumes the views instead of the raw arrays, so the views become the only path and cannot silently diverge. The new field ships OPTIONAL, so no schema version bump.

**Tech Stack:** Bun, TypeScript, `bun:test`, biome. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-excluded-sites-and-report-schema-design.md`

**Scope note:** This plan covers **A only**. E (the standard mutation-testing report schema) gets its own plan once A lands, because E's `Ignored` entries consume `excludedSites`' final field names and writing E's code against names that do not exist yet would produce exactly the placeholder-shaped tasks this format forbids.

## Global Constraints

- **No `!` non-null assertions** (biome `noNonNullAssertion: error`). Destructure, then check `undefined`.
- **`exactOptionalPropertyTypes` is ON.** Build optional props with `...(v !== undefined ? { k: v } : {})`. This applies to `ExcludedSiteFile.detail`.
- **Cite greppable NAMES, never `file.ts:123`** (R117). `scripts/line-citations.test.ts` enforces it and will redden.
- **Build loop order matters:** `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Skipping the dist clean produces ~21 phantom failures from stale compiled `*.test.js`.
- **Lint only what you touched:** `bunx biome check <paths>`. Repo-wide `biome check .` is noisy with pre-existing debt.
- **`excludedSites` is OPTIONAL.** R157's rule: an added optional field is free, an added required field is a new shape and bumps `REPORT_SCHEMA_VERSION`. Making it required is a LATER release's job, together with deleting the views.
- **The views' `fileCount` stays `files.length`.** See Task 1's warning. Only the merged record's `fileCount` is distinct-files.

---

### Task 1: The pure spine module

**Files:**
- Create: `packages/runner/src/excluded-sites.ts`
- Create: `packages/runner/tests/excluded-sites.test.ts`

**Interfaces:**
- Consumes: `NotInstrumentedFile` and `DeclarativeSiteFile` from `./report`.
- Produces: `ExclusionReason`, `ExcludedSiteFile`, `ExcludedSites`, `buildExcludedSites`, `notInstrumentedView`, `declarativeSitesView`. Task 2 and Task 3 both import from here.

> **The trap in this task.** Today BOTH report fields compute `fileCount` as `files.length` (see `buildReport` in `report.ts`, where `notInstrumented.fileCount` is `input.notInstrumented.files.length` and `declarativeSites.fileCount` is `input.declarativeSites.length`). Within one reason, rows and distinct files are the same thing, because a file appears at most once per list. Across reasons they are NOT: a file can appear under both. So `ExcludedSites.fileCount` is **distinct files** and each view's `fileCount` stays **its own row count**. Applying distinct-files to the views changes a number `itest:tables` pins and will fail the live gate.

- [ ] **Step 1: Write the failing test**

Create `packages/runner/tests/excluded-sites.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  buildExcludedSites,
  declarativeSitesView,
  notInstrumentedView,
} from "../src/excluded-sites";

// Hand-written, deliberately NON-EMPTY, and deliberately including a file that appears under
// BOTH reasons. The whole point of this suite is that it cannot pass on an all-zero input:
// every fixture the repo could otherwise have reached for has notInstrumented.fileCount === 0
// (all nine committed campaign reports do), so a derived-vs-derived or zero-vs-zero comparison
// would be vacuous. See the spec's §1.6.
const SKIPPED = [
  { file: "src/Both.Page.al", kinds: "page_declaration", sites: 3 },
  { file: "src/OnlySkipped.Query.al", kinds: "query_declaration", sites: 2 },
] as const;

const DECLARATIVE = [
  { file: "src/Both.Page.al", kinds: "page_declaration", sites: 5 },
  { file: "src/OnlyDeclarative.Page.al", kinds: "page_declaration", sites: 1 },
] as const;

describe("buildExcludedSites", () => {
  test("merges both reasons, counting DISTINCT files and total sites", () => {
    const merged = buildExcludedSites({
      skipped: SKIPPED,
      declarative: DECLARATIVE,
      totalFiles: 40,
    });

    expect(merged.totalFiles).toBe(40);
    expect(merged.siteCount).toBe(11); // 3 + 2 + 5 + 1
    expect(merged.files).toHaveLength(4); // rows
    expect(merged.fileCount).toBe(3); // DISTINCT files — Both.Page.al is one file, two rows
  });

  test("every row carries the reason that produced it", () => {
    const merged = buildExcludedSites({
      skipped: SKIPPED,
      declarative: DECLARATIVE,
      totalFiles: 40,
    });

    expect(merged.files.filter((f) => f.reason === "not-instrumentable")).toEqual([
      { file: "src/Both.Page.al", kinds: "page_declaration", sites: 3, reason: "not-instrumentable" },
      { file: "src/OnlySkipped.Query.al", kinds: "query_declaration", sites: 2, reason: "not-instrumentable" },
    ]);
    expect(merged.files.filter((f) => f.reason === "declarative")).toEqual([
      { file: "src/Both.Page.al", kinds: "page_declaration", sites: 5, reason: "declarative" },
      { file: "src/OnlyDeclarative.Page.al", kinds: "page_declaration", sites: 1, reason: "declarative" },
    ]);
  });

  test("an empty input is a real zero, not an absent record", () => {
    const merged = buildExcludedSites({ skipped: [], declarative: [], totalFiles: 12 });
    expect(merged).toEqual({ totalFiles: 12, siteCount: 0, fileCount: 0, files: [] });
  });
});

describe("the derived views reproduce today's shapes exactly", () => {
  const merged = buildExcludedSites({
    skipped: SKIPPED,
    declarative: DECLARATIVE,
    totalFiles: 40,
  });

  test("notInstrumentedView", () => {
    // fileCount is this view's OWN row count (2), NOT the merged distinct-file count (3).
    expect(notInstrumentedView(merged)).toEqual({
      totalFiles: 40,
      fileCount: 2,
      siteCount: 5,
      files: [
        { file: "src/Both.Page.al", kinds: "page_declaration", sites: 3 },
        { file: "src/OnlySkipped.Query.al", kinds: "query_declaration", sites: 2 },
      ],
    });
  });

  test("declarativeSitesView", () => {
    expect(declarativeSitesView(merged)).toEqual({
      siteCount: 6,
      fileCount: 2,
      files: [
        { file: "src/Both.Page.al", kinds: "page_declaration", sites: 5 },
        { file: "src/OnlyDeclarative.Page.al", kinds: "page_declaration", sites: 1 },
      ],
    });
  });

  test("a view drops `reason`, so it is assignable to the legacy shape", () => {
    for (const f of notInstrumentedView(merged).files) {
      expect(Object.keys(f).sort()).toEqual(["file", "kinds", "sites"]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/runner/tests/excluded-sites.test.ts`
Expected: FAIL, cannot resolve module `../src/excluded-sites`.

- [ ] **Step 3: Write the implementation**

Create `packages/runner/src/excluded-sites.ts`:

```ts
/**
 * ONE record of the sites LethAL deliberately did not mutate, because there were two.
 *
 * `NotInstrumentedFile` (R5, "this FILE cannot carry the injected selector var") and
 * `DeclarativeSiteFile` (R144, "this SITE is not executable AL") have the same shape and the same
 * stated purpose, and `DeclarativeSiteFile`'s own doc comment already calls it a SIBLING of the
 * first. A third consumer is coming: the standard mutation-testing report schema's `Ignored`
 * status. Rather than a third copy, both become views over this.
 *
 * The two views are the ONLY way the legacy fields are produced (`buildReport` consumes them, not
 * the raw arrays), so they cannot drift into a parallel implementation that agrees by accident.
 */
import type { DeclarativeSiteFile, NotInstrumentedFile } from "./report";

/** Why a site or file was excluded. `buildReport` maps each to its legacy view. */
export type ExclusionReason = "not-instrumentable" | "declarative";

export interface ExcludedSiteFile {
  readonly file: string;
  /** Object kind(s) this file declares, e.g. `"page_declaration"` — from `describeObjectKinds`. */
  readonly kinds: string;
  /**
   * The counting rule DIFFERS by reason, and flattening them would be a lie:
   *
   *  - `declarative` counts specs PRE-filter, where they are dropped inside the visit loop.
   *  - `not-instrumentable` counts `fileSpecs.length` AFTER dedup and the `--operator` filter, and
   *    a file whose specs are entirely filtered away leaves the list altogether, because
   *    `generateMutationSet`'s `if (fileSpecs.length === 0) continue;` precedes its
   *    `canCarryMutationSelectorVar` check.
   *
   * Changing either is a separate decision with its own live-gate consequences.
   */
  readonly sites: number;
  readonly reason: ExclusionReason;
  /** Free-text detail for reasons that have one. Neither current reason does. */
  readonly detail?: string;
}

export interface ExcludedSites {
  /** Every `.al` file scanned — the denominator, which only `notInstrumented` had a home for. */
  readonly totalFiles: number;
  readonly siteCount: number;
  /**
   * DISTINCT FILES, which is NOT `files.length`: a file can be excluded under both reasons and
   * therefore appear as two rows. Each VIEW's `fileCount` is that view's own row count, because
   * within one reason a file appears at most once — and because `itest:tables` pins the
   * declarative one.
   */
  readonly fileCount: number;
  readonly files: readonly ExcludedSiteFile[];
}

export function buildExcludedSites(input: {
  readonly skipped: readonly NotInstrumentedFile[];
  readonly declarative: readonly DeclarativeSiteFile[];
  readonly totalFiles: number;
}): ExcludedSites {
  const files: ExcludedSiteFile[] = [
    ...input.skipped.map((f) => ({ ...f, reason: "not-instrumentable" as const })),
    ...input.declarative.map((f) => ({ ...f, reason: "declarative" as const })),
  ];
  return {
    totalFiles: input.totalFiles,
    siteCount: files.reduce((n, f) => n + f.sites, 0),
    fileCount: new Set(files.map((f) => f.file)).size,
    files,
  };
}

/** Rows of one reason, stripped back to the legacy three-field shape. */
function rowsOf(excluded: ExcludedSites, reason: ExclusionReason): NotInstrumentedFile[] {
  return excluded.files
    .filter((f) => f.reason === reason)
    .map((f) => ({ file: f.file, kinds: f.kinds, sites: f.sites }));
}

export function notInstrumentedView(excluded: ExcludedSites): {
  readonly totalFiles: number;
  readonly fileCount: number;
  readonly siteCount: number;
  readonly files: readonly NotInstrumentedFile[];
} {
  const files = rowsOf(excluded, "not-instrumentable");
  return {
    totalFiles: excluded.totalFiles,
    fileCount: files.length,
    siteCount: files.reduce((n, f) => n + f.sites, 0),
    files,
  };
}

export function declarativeSitesView(excluded: ExcludedSites): {
  readonly siteCount: number;
  readonly fileCount: number;
  readonly files: readonly DeclarativeSiteFile[];
} {
  const files = rowsOf(excluded, "declarative");
  return {
    siteCount: files.reduce((n, f) => n + f.sites, 0),
    fileCount: files.length,
    files,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/runner/tests/excluded-sites.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
bun run typecheck
rm -rf packages/*/dist
bunx biome check packages/runner/src/excluded-sites.ts packages/runner/tests/excluded-sites.test.ts
```
Expected: typecheck exit 0, biome reports no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/excluded-sites.ts packages/runner/tests/excluded-sites.test.ts
git commit -m "feat(report): one excluded-sites record, with both legacy shapes as derived views"
```

---

### Task 2: Add the optional report field, and prove it costs no schema bump

**Files:**
- Modify: `packages/runner/src/report.ts` (the `SessionReport` interface, beside `declarativeSites`)
- Modify: `schemas/report-v2.schema.json` (regenerated, never hand-edited)

**Interfaces:**
- Consumes: `ExcludedSites` from Task 1.
- Produces: `SessionReport.excludedSites?: ExcludedSites`, which Task 3 populates and E later reads.

- [ ] **Step 1: Add the field to `SessionReport`**

In `packages/runner/src/report.ts`, immediately after the `declarativeSites` field, add:

```ts
  /**
   * Every site or file LethAL deliberately did not mutate, in ONE record keyed by reason — the
   * merge of `notInstrumented` and `declarativeSites`, which remain as views derived from it.
   *
   * OPTIONAL, deliberately. R157's rule is that an added optional field is free and an added
   * REQUIRED field is a new shape and bumps `REPORT_SCHEMA_VERSION`; `declarativeSites` and
   * `preprocessorSymbols` were both added as required while this number stayed 2, which is why an
   * archived v2 report is rejected by the published v2 schema. This field becomes required in the
   * same release that DELETES the two views, so the removal costs one bump instead of two.
   */
  readonly excludedSites?: ExcludedSites;
```

Add the import at the top of the file, beside the other local imports:

```ts
import type { ExcludedSites } from "./excluded-sites";
```

> **Circular import check:** `excluded-sites.ts` imports `NotInstrumentedFile` / `DeclarativeSiteFile` from `report.ts`, and `report.ts` now imports `ExcludedSites` from `excluded-sites.ts`. Both are `import type`, which is erased at compile time, so no runtime cycle exists. If `tsc` complains, move the three shared interfaces into `excluded-sites.ts` and re-export them from `report.ts`, rather than duplicating them.

- [ ] **Step 2: Regenerate the published schema**

Run: `bun scripts/generate-schemas.ts`
Expected: `schemas/report-v2.schema.json` gains an `excludedSites` property and its root `required` array is UNCHANGED.

- [ ] **Step 3: Verify the version constant did not move and the pins still hold**

Run: `bun test packages/runner/tests/schemas.test.ts`
Expected: PASS. Specifically "the committed schemas are what the generator produces from today's types" passes because you regenerated, and "the root required set of every published schema is pinned (R157)" passes because the field is optional. **If that second test reddens, the field was declared required — go back to Step 1.**

- [ ] **Step 4: Confirm `REPORT_SCHEMA_VERSION` is still 2**

```bash
grep -n "export const REPORT_SCHEMA_VERSION" packages/runner/src/report.ts
```
Expected: `= 2`. If you changed it, revert that change.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/report.ts schemas/report-v2.schema.json
git commit -m "feat(report): SessionReport.excludedSites, optional so it costs no schema bump (R157)"
```

---

### Task 3: Make the views the only path

**Files:**
- Modify: `packages/runner/src/report-fold.ts` (`foldEvents`'s return, where `notInstrumented` and `declarativeSites` are assembled)
- Modify: `packages/runner/src/report.ts` (`buildReport`'s count computation, where `fileCount` / `siteCount` are derived)
- Test: `packages/runner/tests/report-fold.test.ts` if it exists, otherwise `packages/runner/tests/excluded-sites.test.ts`

**Interfaces:**
- Consumes: `buildExcludedSites`, `notInstrumentedView`, `declarativeSitesView` from Task 1; `SessionReport.excludedSites` from Task 2.
- Produces: a `SessionReport` whose `notInstrumented` and `declarativeSites` are computed from `excludedSites` and nowhere else.

> **This is the task that makes A worth doing.** Adding `excludedSites` alongside two independently-computed legacy fields would leave three parallel computations that agree by accident. After this task there is one computation and two projections of it.

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/excluded-sites.test.ts`:

```ts
import { buildReport } from "../src/report";

describe("buildReport derives both legacy fields from excludedSites (not in parallel)", () => {
  test("the report's own views equal the views of its own excludedSites", () => {
    // Build a report through the real fold, with a mutation-set-generated event carrying both
    // populations. Replace the helper call below with this repo's existing fold-test harness if
    // one is already present in packages/runner/tests. Do NOT invent a second harness.
    const report = buildReportForTest({
      totalFiles: 40,
      notInstrumentedFiles: [
        { file: "src/Both.Page.al", kinds: "page_declaration", sites: 3 },
        { file: "src/OnlySkipped.Query.al", kinds: "query_declaration", sites: 2 },
      ],
      declarativeSiteFiles: [
        { file: "src/Both.Page.al", kinds: "page_declaration", sites: 5 },
        { file: "src/OnlyDeclarative.Page.al", kinds: "page_declaration", sites: 1 },
      ],
    });

    const excluded = report.excludedSites;
    if (excluded === undefined) throw new Error("excludedSites must be present on every report");

    expect(report.notInstrumented).toEqual(notInstrumentedView(excluded));
    expect(report.declarativeSites).toEqual(declarativeSitesView(excluded));

    // And the merged record is not just the sum of the two views: Both.Page.al is ONE file.
    expect(excluded.fileCount).toBe(3);
    expect(report.notInstrumented.fileCount).toBe(2);
    expect(report.declarativeSites.fileCount).toBe(2);
  });
});
```

**Do not write `buildReportForTest` from scratch.** Two harnesses already construct a `FoldStatics` plus event list and call `buildReport`:

- `packages/runner/tests/operator-filter.test.ts` — its local helper passes `{ caps: CAPS, ...statics }` and is the smaller of the two.
- `packages/runner/tests/report-equality.test.ts` — its helper stamps the events first.

Read both, reuse whichever already emits a `mutation-set-generated` event (that is the event carrying `notInstrumentedFiles` and `declarativeSiteFiles`), and extend it with the two populations above. Only write a new helper if neither emits that event.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/runner/tests/excluded-sites.test.ts`
Expected: FAIL, `excludedSites must be present on every report`.

- [ ] **Step 3: Populate `excludedSites` in the fold**

In `packages/runner/src/report-fold.ts`, replace the two assembled fields in `foldEvents`'s returned object (the `FoldedReport` interface). Where it currently reads:

```ts
    notInstrumented: { totalFiles, files: notInstrumentedFiles },
    declarativeSites: declarativeSiteFiles,
```

write:

```ts
    excludedSites: buildExcludedSites({
      skipped: notInstrumentedFiles,
      declarative: declarativeSiteFiles,
      totalFiles,
    }),
```

and delete the two lines it replaces. Add the import:

```ts
import { buildExcludedSites } from "./excluded-sites";
```

- [ ] **Step 4: Derive the two views where the counts are computed**

In `packages/runner/src/report.ts`, inside `buildReport`, the block that currently computes `notInstrumented.fileCount` from `input.notInstrumented.files.length` and `declarativeSites.fileCount` from `input.declarativeSites.length` now reads its input from `excludedSites` instead:

```ts
    excludedSites: input.excludedSites,
    notInstrumented: notInstrumentedView(input.excludedSites),
    declarativeSites: declarativeSitesView(input.excludedSites),
```

Add the import:

```ts
import { declarativeSitesView, notInstrumentedView } from "./excluded-sites";
```

Adjust the intermediate `notInstrumentedSites` / `declarativeSiteCount` locals: they are now computed inside the views, so delete them if nothing else reads them. Run `grep -n "notInstrumentedSites\|declarativeSiteCount" packages/runner/src/report.ts` and remove only the now-unused ones.

- [ ] **Step 5: Run the full suite**

```bash
bun run typecheck
rm -rf packages/*/dist
bun test
```
Expected: 2550+ pass, 0 fail. **Every existing test that asserts on `notInstrumented` or `declarativeSites` is now an equivalence check on the derived views**, which is the acceptance criterion for "byte-identical output for the same input". If any of them fail, the views do not reproduce the old shapes — fix the views, not the tests.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check packages/runner/src/report.ts packages/runner/src/report-fold.ts packages/runner/src/excluded-sites.ts packages/runner/tests/excluded-sites.test.ts
git add packages/runner/src/report.ts packages/runner/src/report-fold.ts packages/runner/tests/excluded-sites.test.ts
git commit -m "refactor(report): notInstrumented and declarativeSites become views over excludedSites"
```

---

### Task 4: A live check for the `notInstrumented` half that can actually fail

**Files:**
- Create: `fixtures/sandbox-data/src/DataScopeQuery.Query.al` (name and object kind confirmed in Step 1)
- Create: `docs/superpowers/specs/2026-08-26-excluded-sites-fixture-precommitment.md`
- Modify: `packages/runner/itest/tables.itest.ts` (the `EXPECTED` block, and a new assertion)

**Interfaces:**
- Consumes: `SessionReport.notInstrumented` as produced by Task 3.
- Produces: a non-zero `notInstrumented` population on a live gate, where today every gate reports zero.

> **Why this task exists.** The obvious landing proof for A ("it is verdict-neutral, so all four gates stay frozen") CANNOT FAIL for this half. No itest references `notInstrumented`, and every fixture file is a carrier kind (`CARRIER_KINDS` in `packages/schemata/src/compile.ts`), so the population is empty on every gate run. Derive the view permanently empty and all four gates still pass. The declarative half is already checked this way in `tables.itest.ts`; this is the same treatment one field over.
>
> The reviewer's alternative — compare against committed campaign data — was checked and does not work: all nine reports under `docs/campaign/` have `notInstrumented.fileCount === 0`.

- [ ] **Step 1: Choose the object kind by measuring, not by guessing**

The fixture object must be a NON-carrier kind that at least one operator claims a site in. Run:

```bash
grep -nA12 "export const CARRIER_KINDS" packages/schemata/src/compile.ts
```

to list the carrier kinds, then pick `query` or `xmlport` from what is left. Write a minimal object of that kind containing one mutation site an operator will claim (an `if`/comparison in a trigger is the reliable choice, since `negate-conditional` claims it), and confirm with:

```bash
bun scripts/census-operator-sites.ts fixtures/sandbox-data /tmp/sites.json && grep -c "DataScopeQuery" /tmp/sites.json
```
Expected: at least 1. If 0, the object has no claimed site and the fixture proves nothing — add a site until it does.

- [ ] **Step 2: Compile the fixture**

Run: `bun run compile:fixtures`
Expected: exit 0. **This step is not optional.** Nothing else compiles fixture AL: LethAL publishes the target on every run but treats the TEST APP as the user's own workflow, so a broken fixture leaves the gate measuring the previously published build (R56).

- [ ] **Step 3: Write the pre-commitment BEFORE running the gate**

Create `docs/superpowers/specs/2026-08-26-excluded-sites-fixture-precommitment.md` stating, before any live run:

- The exact `notInstrumented.files` rows expected: one row, `src/DataScopeQuery.Query.al`, its `kinds` string, and its `sites` count.
- That `counts.killed`, `counts.survived` and `counts.noCoverage` are **UNCHANGED** at whatever `tables.itest.ts`'s `EXPECTED` block currently holds. Read those values from the file; do not copy them from any document, including this plan, because restated figures go stale.
- The reasoning: a non-carrier file contributes no deployable mutant, so a moved mutant total means the object kind is carrier after all, or the site was claimed in a file that also carries mutants.

Commit it before the run. `lethal campaign` gates refuse a pre-commitment that is not committed and clean in git, and the same discipline applies here.

- [ ] **Step 4: Add the assertion to the gate**

In `packages/runner/itest/tables.itest.ts`, extend the `EXPECTED` block with a `notInstrumented` entry mirroring how `declarativeSites` is already pinned there, and assert it BY FILE, not by count alone:

```ts
  notInstrumented: {
    fileCount: 1,
    siteCount: 1, // replace with the value the pre-commitment names
    files: ["src/DataScopeQuery.Query.al"],
  },
```

and beside the existing `declarativeSites` assertion:

```ts
assert.equal(
  report.notInstrumented.fileCount,
  EXPECTED.notInstrumented.fileCount,
  "notInstrumented fileCount mismatch",
);
assert.equal(
  report.notInstrumented.siteCount,
  EXPECTED.notInstrumented.siteCount,
  "notInstrumented siteCount mismatch",
);
assert.deepEqual(
  report.notInstrumented.files.map((f) => f.file).sort(),
  [...EXPECTED.notInstrumented.files].sort(),
  "notInstrumented files mismatch: a permanently-empty derived view passes a count check but not this one",
);
```

- [ ] **Step 5: Run the live gate in the foreground**

Run: `LETHAL_ITEST_TABLES=1 bun run itest:tables`
Expected: PASS, with the mutant totals unchanged and `notInstrumented` matching the pre-commitment. Minutes, not seconds. **Run it in the foreground and never poll.** Needs a gitignored `fixtures/sandbox-data/lethal.config.local.json`.

A differing verdict is a BLOCK, not "close enough". If totals moved, stop and diagnose before touching the baseline.

- [ ] **Step 6: Append the outcome to the pre-commitment and commit**

Append an `## OUTCOME` section recording what the run produced, without editing anything above it. Then:

```bash
git add fixtures/sandbox-data/src/DataScopeQuery.Query.al \
        packages/runner/itest/tables.itest.ts \
        docs/superpowers/specs/2026-08-26-excluded-sites-fixture-precommitment.md
git commit -m "test(tables): pin notInstrumented on a real non-carrier object, so the view can fail"
```

- [ ] **Step 7: Red-check the assertion**

Use the `mutation-red-checker` subagent, or by hand: make `notInstrumentedView` return `{ ...view, files: [] }`, re-run `itest:tables`, confirm the new assertion goes RED naming the file mismatch, then restore and confirm green. **Report both outputs.** An assertion that stays green under a gutted view is the exact failure this task exists to prevent.

---

## Self-Review

**Spec coverage.** §1.2 shape → Task 1 and 2. §1.3 optional-then-required → Task 2, Steps 3 and 4. §1.4 the two counting rules → Task 1's warning box and the `sites` doc comment. §1.5 views → Task 1 and 3. §1.6 the check that can fail → Task 4, both halves (unit fixture in Task 1, live in Task 4). §1.7 gates cited by path → Task 4 Step 3 forbids restating figures. §1.8 explain caveat → **no task, deliberately**: A as specified adds no caveat, and §1.8 says the roadmap-first ordering applies only if implementation finds it needs one. §2 (E) → out of scope by the header's scope note. §5 open questions 1 and 3 → question 1 belongs to E; question 3 is resolved by Task 4 Step 1, which measures rather than guesses.

**Placeholders.** Two steps intentionally defer to a `grep` rather than naming a value: Task 3 Step 1 (reuse the existing fold harness) and Task 4 Step 1 (pick the object kind). Both name the exact command and the exact acceptance criterion, so neither is a "figure it out" instruction. Task 4's `siteCount: 1` is marked as replaceable by the measured value.

**Type consistency.** `buildExcludedSites` / `notInstrumentedView` / `declarativeSitesView` are spelled identically in Tasks 1, 3 and the tests. `ExcludedSites` is the type name in Tasks 1, 2 and 3. The views return the legacy shapes, so `SessionReport.notInstrumented` and `.declarativeSites` keep their declared types unchanged.
