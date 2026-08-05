import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainFromCli, helpText, parseCliConfig } from "../src/cli";
import {
  ADMISSIBLE_INTERPRETATIONS,
  EXPLAIN_SCHEMA_VERSION,
  MalformedReportError,
  assertExplainableReport,
  explain,
} from "../src/explain";
import type { Interpretation } from "../src/interpretation";
import {
  CAVEAT_INTERPRETATIONS,
  ERROR_CAUSE_INTERPRETATIONS,
  GUARD_EVIDENCE_INTERPRETATIONS,
  QUARANTINE_INTERPRETATION,
  REPORT_SCHEMA_VERSION,
  STRANDED_SKIP_INTERPRETATION,
} from "../src/report";
import type { Caveat, MutantOutcome, SessionReport } from "../src/report";
import { ATTRIBUTION_INTERPRETATIONS } from "../src/selection";
import type { CoverageAttribution } from "../src/selection";

// ————————————————————————————————————————————————————————————————————————————————————————
// Fixtures. A literal `SessionReport` rather than a run-shaped builder ON PURPOSE: `explain`'s
// real input is a JSON file read off disk (`lethal explain <report.json>`), so the input space it
// must survive is "whatever is in that file", not "whatever a live run can produce". The
// end-to-end fixtures at the bottom of this file are the real committed campaign reports.
// ————————————————————————————————————————————————————————————————————————————————————————

function survivorMutant(
  code: string,
  attribution: CoverageAttribution,
  guardObserved?: boolean,
): MutantOutcome {
  return {
    mutantCode: code,
    file: "src/Posting/Foo.Codeunit.al",
    line: 42,
    operatorName: "lethal.negate-conditional",
    verdict: "survived",
    batchIndex: 0,
    durationMs: 120,
    procedureName: "ComputeTotal",
    startIndex: 100,
    endIndex: 110,
    originalText: "Qty > 0",
    mutatedText: "Qty <= 0",
    coveringTests: ["Foo Tests.ComputesTotal"],
    coverageAttribution: attribution,
    ...(guardObserved !== undefined ? { guardObserved } : {}),
    runner: "fenced",
    astHash: `hash-${code}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
  };
}

function errorMutant(code: string, cause?: "deadline-exceeded" | "unstable"): MutantOutcome {
  return {
    mutantCode: code,
    file: "src/Posting/Foo.Codeunit.al",
    line: 77,
    operatorName: "lethal.void-method-call",
    verdict: "error",
    batchIndex: 0,
    durationMs: 0,
    procedureName: "PostBatch",
    startIndex: 200,
    endIndex: 220,
    originalText: "Rec.SetCurrentKey(No);",
    mutatedText: "",
    coveringTests: [],
    failureNote: "deadline exceeded running Foo Tests.PostsBatch (infrastructure, not a kill)",
    ...(cause !== undefined ? { cause } : {}),
    runner: "fenced",
    astHash: `hash-${code}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
  };
}

function reportFixture(over: Partial<SessionReport> = {}): SessionReport {
  const base: SessionReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    validity: {
      reliability: "narrowed",
      caveats: ["narrowed"],
      scoreDescribes: "3 scored mutant(s) in src/Posting/** (2 of 40 .al files)",
      baselineTests: { total: 12, failing: 0 },
      scoredMutants: { scored: 3, recorded: 4 },
      executionContexts: [
        {
          runner: "fenced",
          guiAllowed: false,
          clientType: "ODataV4",
          basis: "test fixture",
          verdictCount: 4,
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
      killed: 1,
      survived: 2,
      noCoverage: 0,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 1,
      deadlineExceeded: 1,
    },
    mutationScore: 1 / 3,
    mutants: [
      survivorMutant("M0001", "exact", true),
      survivorMutant("M0002", "object", true),
      errorMutant("M0003", "deadline-exceeded"),
    ],
    unsupportedTests: [],
    notInstrumented: { totalFiles: 40, fileCount: 0, siteCount: 0, files: [] },
    only: { patterns: ["src/Posting/**"], excludedFileCount: 38 },
    timings: {
      totalMs: 1000,
      generateMutationSetMs: 10,
      deployMs: 500,
      baselineMs: 200,
      mutantsMs: 120,
      perMutant: { count: 1, meanMs: 120, medianMs: 120, p95Ms: 120, maxMs: 120 },
    },
    untargetedTriggerCount: 0,
  };
  return { ...base, ...over };
}

function reportWithCaveat(caveat: Caveat): SessionReport {
  const base = reportFixture();
  return { ...base, validity: { ...base.validity, caveats: [caveat] } };
}

/**
 * Every `Interpretation`-shaped object reachable in `value`, with the JSON path it sits at.
 *
 * "Interpretation-shaped" is `meaning: string` + `basis: string` — the two required members of the
 * type. Walks arrays and plain objects; the path is only for the failure message.
 */
function interpretationsIn(
  value: unknown,
  path = "$",
): readonly { readonly path: string; readonly value: Interpretation }[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => interpretationsIn(v, `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.meaning === "string" && typeof record.basis === "string") {
    return [{ path, value: record as unknown as Interpretation }];
  }
  return Object.entries(record).flatMap(([k, v]) => interpretationsIn(v, `${path}.${k}`));
}

// ————————————————————————————————————————————————————————————————————————————————————————
// The four tests the plan specifies (task-4-brief.md Step 1), verbatim in intent.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the plan's own four tests", () => {
  test("every survivor carries a machine field beside its prose", () => {
    const out = explain(reportFixture());
    expect(out.survivors.length).toBeGreaterThan(0);
    for (const s of out.survivors) {
      expect(typeof s.executionProven).toBe("boolean");
      expect(s.interpretation.basis.length).toBeGreaterThan(0);
    }
  });

  test("the header records BOTH schema versions", () => {
    const out = explain(reportFixture());
    expect(out.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
    expect(out.derivedFromReportSchemaVersion).toBe(2);
    expect(out.derivedFromReportSchemaVersion).toBe(REPORT_SCHEMA_VERSION);
  });

  test("it states what is proven and what is not — never what test to write", () => {
    const out = explain(reportFixture());
    const text = JSON.stringify(out).toLowerCase();
    expect(text).not.toMatch(/write a test|add an assertion|you should test/);
  });

  test("it does NOT restate a caveat in fresh prose — it emits the shared constant", () => {
    const out = explain(reportWithCaveat("baseline-red"));
    expect(out.caveats[0]?.interpretation).toBe(CAVEAT_INTERPRETATIONS["baseline-red"]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// The admissibility mechanism itself. The regex above is a lexical spot-check: it catches three
// phrasings and nothing else, and a projection that wrote "strengthen these 19 tests" would sail
// straight through it. THIS is the test that decides what ships — every interpretation the
// projection emits must be REFERENCE-IDENTICAL to a member of the registry, so prose written
// inline in explain.ts cannot reach the output at all, whatever it says.
//
// The registry members are, by construction, keyed to a machine value and co-located with it
// (report.ts / selection.ts) and carry a basis that `interpretation.test.ts` resolves against the
// real ROADMAP.md. Identity is what couples those three guarantees to the projection.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the admissibility rule, made executable", () => {
  const registry = new Set<Interpretation>(ADMISSIBLE_INTERPRETATIONS);

  test("the registry is exactly the co-located constants — nothing invented, nothing missed", () => {
    const expected = new Set<Interpretation>([
      ...Object.values(ATTRIBUTION_INTERPRETATIONS),
      ...Object.values(CAVEAT_INTERPRETATIONS),
      ...Object.values(GUARD_EVIDENCE_INTERPRETATIONS),
      ...Object.values(ERROR_CAUSE_INTERPRETATIONS),
      QUARANTINE_INTERPRETATION,
      STRANDED_SKIP_INTERPRETATION,
    ]);
    expect(registry).toEqual(expected);
  });

  test("every interpretation in the output is a registry member BY IDENTITY", () => {
    // Exercised over a report that reaches every emitting branch at once.
    const base = reportFixture();
    const out = explain({
      ...base,
      validity: {
        ...base.validity,
        reliability: "narrowed-degraded",
        caveats: ["baseline-red", "narrowed", "tests-narrowed"],
      },
      baselineGreen: false,
      mutants: [
        survivorMutant("M0001", "exact", true),
        survivorMutant("M0002", "object", false),
        survivorMutant("M0003", "all-green"),
        errorMutant("M0004", "deadline-exceeded"),
        errorMutant("M0005", "unstable"),
        errorMutant("M0006"),
      ],
      testsOnly: ["test/Posting/**"],
      quarantined: { reason: "test in-flight-unknown running Foo Tests.PostsBatch (mutant M0004)" },
      resumedFrom: { runId: 7, carriedMutants: 3, skippedStranded: 2 },
    });
    const found = interpretationsIn(out);
    expect(found.length).toBeGreaterThan(6);
    const foreign = found.filter((f) => !registry.has(f.value)).map((f) => f.path);
    expect(foreign).toEqual([]);
  });

  test("no shipped interpretation tells a reader what test to write", () => {
    // Scans the REGISTRY, not one fixture's output: a phrase added to a constant that a fixture
    // happens not to trigger would otherwise ship unseen.
    const banned = /write a test|add an assertion|you should test|strengthen (these|this|the)/i;
    const offenders = ADMISSIBLE_INTERPRETATIONS.filter(
      (i) => banned.test(i.meaning) || banned.test(i.entailedNegative ?? ""),
    ).map((i) => i.meaning.slice(0, 60));
    expect(offenders).toEqual([]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// Survivors: the section the subsystem exists for.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — survivors", () => {
  test("executionProven is TRUE only for an exact (member-level) attribution", () => {
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", true),
          survivorMutant("M0002", "object", true),
          survivorMutant("M0003", "all-green", true),
        ],
      }),
    );
    expect(out.survivors.map((s) => [s.mutantCode, s.executionProven])).toEqual([
      ["M0001", true],
      ["M0002", false],
      ["M0003", false],
    ]);
  });

  test("each survivor's interpretation is the shared attribution constant, by identity", () => {
    const out = explain(
      reportFixture({
        mutants: [survivorMutant("M0001", "exact", true), survivorMutant("M0002", "object", true)],
      }),
    );
    expect(out.survivors[0]?.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS.exact);
    expect(out.survivors[1]?.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS.object);
  });

  test("guardObserved's THREE states stay three — absent is never folded into false", () => {
    const out = explain(
      reportFixture({
        mutants: [
          survivorMutant("M0001", "exact", true),
          survivorMutant("M0002", "exact", false),
          survivorMutant("M0003", "exact"),
        ],
      }),
    );
    expect(out.survivors.map((s) => s.guardEvidence)).toEqual([
      "observed",
      "not-observed",
      "not-measured",
    ]);
    expect(out.survivors[1]?.guardInterpretation).toBe(
      GUARD_EVIDENCE_INTERPRETATIONS["not-observed"],
    );
    expect(out.survivors[2]?.guardInterpretation).toBe(
      GUARD_EVIDENCE_INTERPRETATIONS["not-measured"],
    );
  });

  test("only `survived` mutants become survivors", () => {
    const out = explain(
      reportFixture({
        mutants: [survivorMutant("M0001", "exact", true), errorMutant("M0002", "unstable")],
      }),
    );
    expect(out.survivors.map((s) => s.mutantCode)).toEqual(["M0001"]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// Tool mechanics — the half of the line the projection IS allowed to be prescriptive about.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — tool mechanics", () => {
  test("a deadline-exceeded error is projected as not-a-verdict, with R91's prescription", () => {
    const out = explain(reportFixture({ mutants: [errorMutant("M0003", "deadline-exceeded")] }));
    expect(out.notMeasured.map((n) => n.mutantCode)).toEqual(["M0003"]);
    expect(out.notMeasured[0]?.interpretation).toBe(
      ERROR_CAUSE_INTERPRETATIONS["deadline-exceeded"],
    );
    // The prescription is about LethAL's own machinery, so it names the flag.
    expect(out.notMeasured[0]?.interpretation?.meaning).toContain("--mutant-timeout-ms");
  });

  test("an error with NO recorded cause carries no interpretation — and says nothing instead", () => {
    // The honest shape: LethAL records `cause` at only the two call sites that know it, so a
    // stranded operation reaches the report with `cause` absent. Inventing a meaning here would
    // be exactly the free-floating claim the keying rule exists to refuse.
    const out = explain(reportFixture({ mutants: [errorMutant("M0003")] }));
    expect(out.notMeasured[0]?.cause).toBeUndefined();
    expect(out.notMeasured[0]?.interpretation).toBeUndefined();
    expect(out.notMeasured[0]?.failureNote).toContain("deadline exceeded running");
  });

  test("a quarantined session is reported as a tool condition, not as a clean result", () => {
    const out = explain(
      reportFixture({ quarantined: { reason: "test in-flight-unknown running X (mutant M0004)" } }),
    );
    const q = out.toolConditions.find((c) => c.condition === "quarantined");
    expect(q?.interpretation).toBe(QUARANTINE_INTERPRETATION);
    expect(q?.detail).toContain("in-flight-unknown");
  });

  test("stranded skips are reported with their count; zero produces no condition at all", () => {
    const withSkips = explain(
      reportFixture({ resumedFrom: { runId: 7, carriedMutants: 3, skippedStranded: 2 } }),
    );
    const s = withSkips.toolConditions.find((c) => c.condition === "stranded-skips");
    expect(s?.count).toBe(2);
    expect(s?.interpretation).toBe(STRANDED_SKIP_INTERPRETATION);

    const noSkips = explain(
      reportFixture({ resumedFrom: { runId: 7, carriedMutants: 3, skippedStranded: 0 } }),
    );
    expect(noSkips.toolConditions.map((c) => c.condition)).not.toContain("stranded-skips");
  });

  test("a clean run reports no tool conditions", () => {
    expect(explain(reportFixture()).toolConditions).toEqual([]);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// The split contract (brief Step 3), stated in the output itself.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the split contract", () => {
  test("the output states that structure is versioned and prose is NOT", () => {
    const out = explain(reportFixture());
    expect(out.contract.structureStableUnder).toBe("explainSchemaVersion");
    expect(out.contract.proseIsContractual).toBe(false);
    const note = out.contract.note.toLowerCase();
    expect(note).toContain("do not parse");
    expect(note).toContain("without a version bump");
    // Why parsing prose is unnecessary rather than merely discouraged.
    expect(note).toContain("structured field");
  });

  test("the score arrives with its own qualifications, verbatim from the report", () => {
    const report = reportFixture();
    const out = explain(report);
    expect(out.score.mutationScore).toBe(report.mutationScore);
    expect(out.score.reliability).toBe("narrowed");
    expect(out.score.scoreDescribes).toBe(report.validity.scoreDescribes);
    expect(out.score.excludedFromScore).toEqual({ errors: 1, noCoverage: 0, knownSurvivors: 0 });
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// R113: `explain` is the first consumer to meet the blind `JSON.parse(...) as SessionReport` cast.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("assertExplainableReport — a foreign report is refused, never silently narrowed", () => {
  test("an unrecognised caveat throws, naming the value and the closed set", () => {
    const base = reportFixture();
    const bad = {
      ...base,
      validity: { ...base.validity, caveats: ["narrowed", "stale-tst-app"] },
    } as unknown as SessionReport;
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/stale-tst-app/);
    expect(() => explain(bad)).toThrow(/baseline-red/); // the closed set is named
  });

  test("an unrecognised coverage attribution throws", () => {
    const bad = reportFixture({
      mutants: [{ ...survivorMutant("M0001", "exact", true), coverageAttribution: "member" }],
    } as unknown as Partial<SessionReport>);
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/member/);
  });

  test("a survivor with NO attribution throws — executionProven cannot be defaulted", () => {
    const survivor = survivorMutant("M0001", "exact", true);
    const { coverageAttribution: _dropped, ...withoutAttribution } = survivor;
    const bad = reportFixture({ mutants: [withoutAttribution] });
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/M0001/);
  });

  test("an unrecognised error cause throws", () => {
    const bad = reportFixture({
      mutants: [{ ...errorMutant("M0003"), cause: "flaky" }],
    } as unknown as Partial<SessionReport>);
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/flaky/);
  });

  test("a report from another schema version is refused, naming both versions", () => {
    const bad = reportFixture({ schemaVersion: 1 });
    expect(() => explain(bad)).toThrow(MalformedReportError);
    expect(() => explain(bad)).toThrow(/\b1\b/);
    expect(() => explain(bad)).toThrow(new RegExp(`\\b${REPORT_SCHEMA_VERSION}\\b`));
  });

  test("non-report JSON is refused rather than projected into an empty answer", () => {
    for (const value of [null, 42, "a string", [], { hello: "world" }]) {
      expect(() => assertExplainableReport(value)).toThrow(MalformedReportError);
    }
  });

  test("a well-formed report passes through unchanged", () => {
    const report = reportFixture();
    expect(assertExplainableReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// End to end, on the REAL committed reports from the campaign this subsystem was measured in.
//
// `rung1.report.json` is the run behind the $18.56 sentence: 107 survivors, of which **88 are
// `object`** (coverage placed them at OBJECT level — some test touched the codeunit, no test is
// measured to have executed the procedure) and **19 are `exact`**. An agent had to derive that
// split by hand from a report that could not state it. This asserts the projection now does.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("explain — the real campaign reports", () => {
  const campaignDir = join(import.meta.dir, "..", "..", "..", "docs", "campaign", "2026-08-03-do");
  const load = (name: string): SessionReport =>
    assertExplainableReport(JSON.parse(readFileSync(join(campaignDir, name), "utf8")));

  test("rung1: the 88/19 split the $18.56 sentence had to be derived by hand", () => {
    const out = explain(load("rung1.report.json"));
    const proven = out.survivors.filter((s) => s.executionProven);
    const unproven = out.survivors.filter((s) => !s.executionProven);
    expect(out.survivors.length).toBe(107);
    expect(unproven.length).toBe(88);
    expect(proven.length).toBe(19);
    // And the 88 carry the entailed negative that stops a reader writing 88 pointless tests.
    for (const s of unproven) {
      expect(s.interpretation).toBe(ATTRIBUTION_INTERPRETATIONS[s.attribution]);
      expect(s.interpretation.entailedNegative).toBeDefined();
    }
  });

  test("every committed campaign report projects without throwing", () => {
    for (const name of [
      "rung1.report.json",
      "rung1.resumed-run.report.json",
      "rung1.run2-partial.report.json",
      "rung2.report.json",
      "rung3.independent-confirm.report.json",
      "rung3.redcheck.report.json",
    ]) {
      const out = explain(load(name));
      expect(out.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
      const foreign = interpretationsIn(out)
        .filter((f) => !new Set<Interpretation>(ADMISSIBLE_INTERPRETATIONS).has(f.value))
        .map((f) => `${name}${f.path}`);
      expect(foreign).toEqual([]);
    }
  });

  test("the quarantined partial run names the quarantine rather than reading as a result", () => {
    const out = explain(load("rung1.run2-partial.report.json"));
    expect(out.toolConditions.map((c) => c.condition)).toContain("quarantined");
  });
});

// ————————————————————————————————————————————————————————————————————————————————————————
// `lethal explain <report.json>` — the wiring.
// ————————————————————————————————————————————————————————————————————————————————————————

describe("lethal explain — CLI", () => {
  test("parses the report path as a positional", () => {
    expect(parseCliConfig(["explain", "out/report.json"])).toEqual({
      mode: "explain",
      reportPath: "out/report.json",
    });
  });

  test("a missing report path is refused by name, not as a bare ENOENT later", () => {
    expect(() => parseCliConfig(["explain"])).toThrow(/<report\.json>/);
    expect(() => parseCliConfig(["explain", ""])).toThrow(/<report\.json>/);
  });

  test("help documents the subcommand and the field that decides what a survivor is worth", () => {
    const text = helpText("0.0.0");
    expect(text).toContain("lethal explain");
    expect(text).toContain("executionProven");
  });

  async function runCli(contents: string): Promise<{ code: number; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-explain-cli-"));
    const path = join(dir, "report.json");
    await writeFile(path, contents, "utf8");
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const code = await explainFromCli({ mode: "explain", reportPath: path });
      return { code, out: lines.join("\n") };
    } finally {
      log.mockRestore();
    }
  }

  test("prints the projection as JSON and exits 0", async () => {
    const { code, out } = await runCli(JSON.stringify(reportFixture()));
    expect(code).toBe(0);
    const printed = JSON.parse(out);
    expect(printed.explainSchemaVersion).toBe(EXPLAIN_SCHEMA_VERSION);
    expect(printed.survivors).toHaveLength(2);
    expect(printed.contract.proseIsContractual).toBe(false);
  });

  test("a corrupt caveat is refused THROUGH the CLI too — not just at the library boundary", async () => {
    const base = reportFixture();
    const corrupted = JSON.stringify({
      ...base,
      validity: { ...base.validity, caveats: ["stale-tst-app"] },
    });
    await expect(runCli(corrupted)).rejects.toThrow(MalformedReportError);
  });

  test("a file that is not JSON is refused naming the file", async () => {
    await expect(runCli("not json at all")).rejects.toThrow(/not valid JSON/);
  });

  test("a missing file is refused naming what to pass instead", async () => {
    await expect(
      explainFromCli({ mode: "explain", reportPath: join(tmpdir(), "lethal-no-such-report.json") }),
    ).rejects.toThrow(/--out/);
  });
});
