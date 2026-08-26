import { describe, expect, test } from "bun:test";
import { assertNotInstrumentedEvidence } from "../itest/notinstrumented-evidence";
import type { RunEvent, RunEventInput } from "../src/events";
import {
  buildExcludedSites,
  declarativeSitesView,
  notInstrumentedView,
} from "../src/excluded-sites";
import { buildReport } from "../src/report";
import type { SessionReport } from "../src/report";

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
      {
        file: "src/Both.Page.al",
        kinds: "page_declaration",
        sites: 3,
        reason: "not-instrumentable",
      },
      {
        file: "src/OnlySkipped.Query.al",
        kinds: "query_declaration",
        sites: 2,
        reason: "not-instrumentable",
      },
    ]);
    expect(merged.files.filter((f) => f.reason === "declarative")).toEqual([
      { file: "src/Both.Page.al", kinds: "page_declaration", sites: 5, reason: "declarative" },
      {
        file: "src/OnlyDeclarative.Page.al",
        kinds: "page_declaration",
        sites: 1,
        reason: "declarative",
      },
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

/**
 * Task 3: `buildReport`'s `notInstrumented` and `declarativeSites` must be VIEWS over its own
 * `excludedSites`, not a third parallel computation that happens to agree. Built as real events +
 * statics, the same pattern `operator-filter.test.ts`'s `reportFor` helper uses (report-fold.test.ts
 * established the pattern) — NOT the legacy bag shim, which predates `excludedSites` and could not
 * exercise this path.
 */
describe("buildReport derives both legacy fields from excludedSites (not in parallel)", () => {
  const CAPS = {
    authoritative: true,
    coverage: "procedure",
    deploy: "publish",
    isolation: "session",
  } as const;

  function buildReportForTest(input: {
    readonly totalFiles: number;
    readonly notInstrumentedFiles: readonly { file: string; kinds: string; sites: number }[];
    readonly declarativeSiteFiles: readonly { file: string; kinds: string; sites: number }[];
  }) {
    const events: RunEvent[] = (
      [
        {
          type: "mutation-set-generated",
          siteCount: 3,
          deployedCount: 3,
          totalFiles: input.totalFiles,
          instrumentableFiles: input.totalFiles,
          notInstrumentedFiles: input.notInstrumentedFiles,
          declarativeSiteFiles: input.declarativeSiteFiles,
          excludedByOnly: 0,
          excludedByOperator: 0,
        },
        { type: "baseline-batch-finished", batchIndex: 0, verdicts: [] },
        { type: "session-finished", elapsedMs: 10 },
      ] as RunEventInput[]
    ).map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
    return buildReport({ caps: CAPS }, events);
  }

  test("the report's own views equal the views of its own excludedSites", () => {
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

// The offline half of Task 4's red-check. A second live gate run would prove the same thing and
// cost a billed environment; this proves it from the two properties that compose to it.
describe("the notInstrumented gate assertion rejects a gutted view", () => {
  const EXPECTED = { fileCount: 1, siteCount: 5, files: ["src/DataScopeQuery.Query.al"] };

  // Property (a): gutting the view leaves the COUNTS untouched, which is why a count-only
  // assertion would have passed and why this task exists at all.
  test("a gutted view keeps fileCount and siteCount and empties files", () => {
    const merged = buildExcludedSites({
      skipped: [{ file: "src/DataScopeQuery.Query.al", kinds: "query_declaration", sites: 5 }],
      declarative: [],
      totalFiles: 29,
    });
    const honest = notInstrumentedView(merged);
    const gutted = { ...honest, files: [] };
    expect(gutted.fileCount).toBe(honest.fileCount); // 1, unchanged
    expect(gutted.siteCount).toBe(honest.siteCount); // 5, unchanged
    expect(gutted.files).toEqual([]);
  });

  // Property (b): the gate's own assertion rejects that report.
  test("the gate assertion throws on the gutted report and passes on the honest one", () => {
    const merged = buildExcludedSites({
      skipped: [{ file: "src/DataScopeQuery.Query.al", kinds: "query_declaration", sites: 5 }],
      declarative: [],
      totalFiles: 29,
    });
    const honest = notInstrumentedView(merged);

    // The cast is deliberate: `assertNotInstrumentedEvidence` reads exactly two fields off
    // `SessionReport` (`notInstrumented` and `validity.caveats`), and constructing a whole valid
    // `SessionReport` would add fifty irrelevant fields without making the test prove more.
    const reportWith = (ni: typeof honest): SessionReport =>
      ({
        notInstrumented: ni,
        validity: { caveats: ["uninstrumentable-files"] },
      }) as unknown as SessionReport;

    // GREEN on the honest view.
    expect(() => assertNotInstrumentedEvidence(reportWith(honest), EXPECTED)).not.toThrow();

    // RED on the gutted one, and specifically on the FILES assertion, not the counts.
    expect(() =>
      assertNotInstrumentedEvidence(reportWith({ ...honest, files: [] }), EXPECTED),
    ).toThrow(/notInstrumented files mismatch/);
  });
});
