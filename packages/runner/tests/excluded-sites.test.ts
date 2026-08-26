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
