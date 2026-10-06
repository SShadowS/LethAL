import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainFromCli, parseCliConfig } from "../src/cli";
import { type ExplainOutput, MalformedReportError, explain } from "../src/explain";
import {
  type ExplainSuggestedOutput,
  SUGGESTIONS_LABEL,
  SUGGESTION_KINDS,
  SUGGESTION_TEXTS,
  SuggestionsUnavailableError,
  suggest,
  suggestionKindOf,
} from "../src/explain-suggest";
import { type MutantOutcome, REPORT_SCHEMA_VERSION, type SessionReport } from "../src/report";
import type { CoverageAttribution } from "../src/selection";
import { typeLeafPaths } from "./helpers/type-leaf-paths";

/**
 * R273: `lethal explain --suggest`. A suggested fix kind per gap, in its own labelled section,
 * derived only from each survivor's measured `reach` and coverage `attribution` (owner ruling
 * 2026-10-06). The default output and the tests that police it are untouched; this file pins the
 * new section on its own.
 */

interface Row {
  readonly code: string;
  readonly gap: string;
  readonly batch?: number;
  readonly attribution?: CoverageAttribution;
  readonly guardReached?: boolean;
  readonly grain?: "statement" | "enclosing";
  readonly marked?: boolean;
  readonly verdict?: MutantOutcome["verdict"];
  readonly risk?: string;
}

const LINES: Record<string, readonly [number, number]> = {
  G1: [10, 20],
  G2: [30, 40],
  G3: [50, 60],
  G4: [70, 80],
};

function row(r: Row): MutantOutcome {
  const [blockStartLine, blockEndLine] = LINES[r.gap] ?? [90, 99];
  return {
    mutantCode: r.code,
    file: "src/Foo.Codeunit.al",
    line: blockStartLine + 1,
    operatorName: "lethal.negate-conditional",
    verdict: r.verdict ?? "survived",
    batchIndex: r.batch ?? 0,
    durationMs: 10,
    procedureName: "DoIt",
    startIndex: 100,
    endIndex: 110,
    originalText: "Qty > 0",
    mutatedText: "Qty <= 0",
    coveringTests: ["Foo Tests.DoesIt"],
    ...(r.attribution !== undefined ? { coverageAttribution: r.attribution } : {}),
    ...(r.guardReached !== undefined
      ? { guardReached: r.guardReached, reachedBy: r.guardReached ? ["Foo Tests.DoesIt"] : [] }
      : {}),
    reachGrain: r.grain ?? "statement",
    ...(r.marked === true ? { readerMark: { key: `k-${r.code}`, reason: "reviewed" } } : {}),
    ...(r.risk !== undefined ? { equivalenceRisk: r.risk } : {}),
    runner: "fenced",
    astHash: `hash-${r.code}-${r.gap}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
    gapId: r.gap,
    blockStartLine,
    blockEndLine,
  };
}

function report(rows: readonly Row[], over: Partial<SessionReport> = {}): SessionReport {
  const mutants = rows.map(row);
  const n = (v: MutantOutcome["verdict"]) => mutants.filter((m) => m.verdict === v).length;
  const scored = n("killed") + n("survived");
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    validity: {
      reliability: "full",
      caveats: [],
      scoreDescribes: "fixture",
      baselineTests: { total: 1, failing: 0 },
      scoredMutants: { scored, recorded: mutants.length },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: mutants.length,
        },
      ],
    },
    survivorsByProcedure: [],
    testFiles: { "Foo Tests": "test/Foo.Test.al" },
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: n("killed"),
      survived: n("survived"),
      noCoverage: n("no-coverage"),
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: scored === 0 ? 0 : n("killed") / scored,
    mutants,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, fileCount: 0, siteCount: 0, files: [] },
    declarativeSites: { siteCount: 0, fileCount: 0, files: [] },
    timings: {
      totalMs: 1,
      generateMutationSetMs: 1,
      deployMs: 1,
      baselineMs: 1,
      mutantsMs: 1,
      perMutant: { count: 1, meanMs: 1, medianMs: 1, p95Ms: 1, maxMs: 1 },
    },
    preprocessorSymbols: [],
    unplaceableCount: 0,
    unplaceableMutants: [],
    untargetedTriggerCount: 0,
    ...over,
  };
}

const suggested = (r: SessionReport, top?: number) =>
  suggest(r, explain(r, top !== undefined ? { topSurvivors: top } : {}));

/** One gap per kind arm, plus a killed sibling so the block is not all survivors. */
const KINDS_ROWS: readonly Row[] = [
  { code: "M0001", gap: "G1", attribution: "exact", guardReached: true },
  { code: "M0002", gap: "G1", attribution: "exact", verdict: "killed" },
  { code: "M0003", gap: "G2", attribution: "exact", guardReached: false },
  { code: "M0004", gap: "G3", attribution: "object", guardReached: false },
  { code: "M0005", gap: "G3", attribution: "all-green", guardReached: false },
  { code: "M0006", gap: "G4", attribution: "exact", grain: "enclosing" },
];

describe("R273: the kind per survivor, from reach and attribution only", () => {
  test("every arm of the table", () => {
    expect(suggestionKindOf("reached-unnoticed", "exact")).toBe("check-the-result");
    expect(suggestionKindOf("reached-unnoticed", "all-green")).toBe("check-the-result");
    expect(suggestionKindOf("reached-unnoticed", "not-measured")).toBe("check-the-result");
    expect(suggestionKindOf("covered-but-unreached", "exact")).toBe("cover-the-branch");
    // The review's two blockers: neither attribution measures entry into the procedure.
    expect(suggestionKindOf("unreached-and-uncovered", "object")).toBe("cover-the-statement");
    expect(suggestionKindOf("unreached-and-uncovered", "all-green")).toBe("cover-the-statement");
    for (const a of ["exact", "object", "all-green", "not-measured"] as const) {
      expect(suggestionKindOf("not-decided", a)).toBe("undecided");
    }
  });

  test("a combination survivorReachOf cannot produce throws, never defaults", () => {
    for (const a of ["object", "all-green", "not-measured"] as const) {
      expect(() => suggestionKindOf("covered-but-unreached", a)).toThrow(MalformedReportError);
    }
    for (const a of ["exact", "not-measured"] as const) {
      expect(() => suggestionKindOf("unreached-and-uncovered", a)).toThrow(MalformedReportError);
    }
  });

  test("through a report: each gap gets its arm's kind", () => {
    const s = suggested(report(KINDS_ROWS));
    expect(s.gaps.map((g) => [g.gapId, g.kind])).toEqual([
      ["G1", "check-the-result"],
      ["G2", "cover-the-branch"],
      ["G3", "cover-the-statement"],
      ["G4", "undecided"],
    ]);
    const g3 = s.gaps.find((g) => g.gapId === "G3");
    expect(g3?.members.map((m) => [m.mutantCode, m.attribution, m.reach])).toEqual([
      ["M0004", "object", "unreached-and-uncovered"],
      ["M0005", "all-green", "unreached-and-uncovered"],
    ]);
    // The registry text appears once per kind used, and never for undecided.
    expect(Object.keys(s.kinds)).toEqual([
      "check-the-result",
      "cover-the-branch",
      "cover-the-statement",
    ]);
    expect(s.label).toBe(SUGGESTIONS_LABEL);
  });

  test("coverage not measured: the statement marker alone decides, as explain's survivors do", () => {
    const s = suggested(
      report(
        [
          { code: "M0001", gap: "G1", guardReached: true },
          { code: "M0002", gap: "G2", guardReached: false },
        ],
        { coverageMode: "none" },
      ),
    );
    expect(s.gaps.map((g) => g.kind)).toEqual(["check-the-result", "undecided"]);
  });

  test("equivalenceRisk is carried verbatim; check-the-result's own text states the caveat", () => {
    const s = suggested(
      report([{ code: "M0001", gap: "G1", attribution: "exact", guardReached: true, risk: "R" }]),
    );
    expect(s.gaps[0]?.members[0]?.equivalenceRisk).toBe("R");
    expect(SUGGESTION_TEXTS["check-the-result"].suggestion).toContain("equivalent mutant");
    expect(SUGGESTION_TEXTS["cover-the-branch"].suggestion).toContain("unreachable");
  });
});

describe("R273: the gap kind and its members", () => {
  test("mixed, all undecided, all reader-marked", () => {
    const s = suggested(
      report([
        { code: "M0001", gap: "G1", attribution: "exact", guardReached: true },
        { code: "M0002", gap: "G1", attribution: "exact", guardReached: false },
        { code: "M0003", gap: "G2", attribution: "exact", grain: "enclosing" },
        { code: "M0004", gap: "G2", attribution: "object", grain: "enclosing" },
        { code: "M0005", gap: "G3", attribution: "exact", guardReached: true, marked: true },
        { code: "M0006", gap: "G3", attribution: "exact", guardReached: false, marked: true },
      ]),
    );
    expect(s.gaps.map((g) => g.kind)).toEqual(["mixed", "undecided", "reader-marked"]);
    expect(s.gaps[0]?.members.map((m) => m.kind)).toEqual(["check-the-result", "cover-the-branch"]);
  });

  test("every gap, every member, in gaps[] order (reader-marked ones included)", () => {
    const r = report([
      ...KINDS_ROWS,
      { code: "M0007", gap: "G2", attribution: "exact", guardReached: true, marked: true },
    ]);
    const out = explain(r);
    const s = suggest(r, out);
    expect(s.gaps.map((g) => [g.gapId, g.members.map((m) => m.mutantCode)])).toEqual(
      (out.gaps ?? []).map((g) => [g.gapId, [...g.members]]),
    );
    expect(s.gaps.find((g) => g.gapId === "G2")?.kind).toBe("mixed");
  });

  test("members join by gap id and code, never code alone: two batches reuse M0001", () => {
    const s = suggested(
      report([
        { code: "M0001", gap: "G1", batch: 0, attribution: "exact", guardReached: true },
        { code: "M0001", gap: "G2", batch: 1, attribution: "exact", guardReached: false },
      ]),
    );
    expect(s.gaps.map((g) => g.kind)).toEqual(["check-the-result", "cover-the-branch"]);
  });

  test("--top does not shorten the section", () => {
    const r = report(KINDS_ROWS);
    expect(suggested(r, 1)).toEqual(suggested(r));
    expect(explain(r, { topSurvivors: 1 }).survivors.length).toBe(1);
  });

  test("a report with gap ids and no survivors: a true empty, not a refusal", () => {
    const s = suggested(
      report([{ code: "M0001", gap: "G1", attribution: "exact", verdict: "killed" }]),
    );
    expect(s.gaps).toEqual([]);
    expect(s.kinds).toEqual({});
  });

  test("a report without gap ids is refused by name", () => {
    const r = report(KINDS_ROWS);
    const noGaps: SessionReport = {
      ...r,
      mutants: r.mutants.map(({ gapId: _g, blockStartLine: _s, blockEndLine: _e, ...m }) => m),
    };
    expect(explain(noGaps).gaps).toBeUndefined();
    expect(() => suggested(noGaps)).toThrow(SuggestionsUnavailableError);
  });
});

describe("R273: the section's own pins", () => {
  const strings = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(strings)
        : typeof v === "object" && v !== null
          ? Object.values(v).flatMap(strings)
          : [];
  const paths = (v: unknown, at: string): string[] =>
    Array.isArray(v)
      ? v.flatMap((x) => paths(x, `${at}[]`))
      : typeof v === "object" && v !== null
        ? Object.entries(v).flatMap(([k, x]) => paths(x, `${at}.${k}`))
        : [at];

  test("every string is a report value, the label, a registry text or a pinned value", () => {
    const r = report([
      ...KINDS_ROWS,
      { code: "M0007", gap: "G2", attribution: "exact", guardReached: true, risk: "R-text" },
    ]);
    const allowed = new Set<string>([
      ...strings(r),
      SUGGESTIONS_LABEL,
      ...strings(SUGGESTION_TEXTS),
      ...SUGGESTION_KINDS,
      "reached-unnoticed",
      "covered-but-unreached",
      "unreached-and-uncovered",
      "not-decided",
      "not-measured",
    ]);
    expect(strings(suggested(r)).filter((s) => !allowed.has(s))).toEqual([]);
  });

  test("every leaf the section emits is one ExplainSuggestions declares", () => {
    const declared = new Set(
      typeLeafPaths({
        files: [join(import.meta.dir, "../src/explain-suggest.ts")],
        root: "ExplainSuggestions",
        expectedLeafTypeNames: [
          "SuggestionKind",
          "GapSuggestionKind",
          "SurvivorReach",
          "ExplainAttribution",
        ],
      }),
    );
    const r = report([
      ...KINDS_ROWS,
      { code: "M0007", gap: "G2", attribution: "exact", guardReached: true, risk: "R-text" },
    ]);
    const emitted = [...new Set(paths(suggested(r), "$"))];
    expect(emitted.filter((p) => !declared.has(p))).toEqual([]);
    // And the fixture reaches every declared leaf, so the check above is not vacuous.
    expect([...declared].filter((p) => !emitted.includes(p))).toEqual([]);
  });
});

describe("R273: the CLI composes the section; the default output is unchanged", () => {
  test("--suggest is parsed for explain and refused for every other subcommand", () => {
    expect(parseCliConfig(["explain", "r.json", "--suggest"])).toEqual({
      mode: "explain",
      reportPath: "r.json",
      suggest: true,
    });
    expect(parseCliConfig(["explain", "r.json"])).toEqual({
      mode: "explain",
      reportPath: "r.json",
    });
    expect(() =>
      parseCliConfig(["export", "r.json", "--format", "mutation-elements", "--suggest"]),
    ).toThrow("--suggest is only accepted by `lethal explain`");
  });

  test("without --suggest no suggestions key; with it, everything else is identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r273-"));
    const reportPath = join(root, "report.json");
    await Bun.write(reportPath, JSON.stringify(report(KINDS_ROWS)));
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await explainFromCli({ mode: "explain", reportPath });
      await explainFromCli({ mode: "explain", reportPath, suggest: true });
      const plain = JSON.parse(String(log.mock.calls[0]?.[0])) as ExplainOutput;
      const withS = JSON.parse(String(log.mock.calls[1]?.[0])) as ExplainSuggestedOutput;
      expect("suggestions" in plain).toBe(false);
      expect(plain).toEqual(JSON.parse(JSON.stringify(explain(report(KINDS_ROWS)))));
      const { suggestions, ...rest } = withS;
      expect(rest).toEqual(plain);
      expect(suggestions.gaps.length).toBe(4);
    } finally {
      log.mockRestore();
      err.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a refusal prints nothing on stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-r273-"));
    const reportPath = join(root, "report.json");
    const r = report(KINDS_ROWS);
    await Bun.write(
      reportPath,
      JSON.stringify({
        ...r,
        mutants: r.mutants.map(({ gapId: _g, blockStartLine: _s, blockEndLine: _e, ...m }) => m),
      }),
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(explainFromCli({ mode: "explain", reportPath, suggest: true })).rejects.toThrow(
        SuggestionsUnavailableError,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
