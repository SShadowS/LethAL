import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { verdictFromRunnerTest } from "../src/al-runner-backend";
import type { RunOpts, TestMethodRef, TestVerdict } from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { testsInAlSource } from "../src/discovery";
import { MalformedReportError, explain } from "../src/explain";
import { type MutantOutcome, REPORT_SCHEMA_VERSION, type SessionReport } from "../src/report";
import { testMethodsOf } from "../src/report-fold";

/**
 * R272: explain lists a gap's covering tests with file:line, ordered by reach then name; the
 * baseline duration is shown and never a key (R197 measured it unstable between runs).
 */

beforeAll(async () => {
  await initParser();
});

describe("R272: discovery gives each test the line of its name", () => {
  test("regex path: a multi-line attribute run, a quoted name, CRLF", () => {
    const lf = [
      'codeunit 50100 "Line Tests"',
      "{",
      "    Subtype = Test;",
      "",
      "    [Test]",
      "    [HandlerFunctions('ConfirmYes')]",
      "    procedure First()",
      "    begin",
      "    end;",
      "",
      "    [Test]",
      '    procedure "Second One"()',
      "    begin",
      "    end;",
      "}",
      "",
    ];
    for (const eol of ["\n", "\r\n"]) {
      const refs = testsInAlSource("t/Line.Codeunit.al", lf.join(eol));
      expect(refs.map((r) => [r.method, r.line])).toEqual([
        ["First", 7],
        ["Second One", 12],
      ]);
    }
  });

  test("tree path, a split header (R424): each arm at its own name's line", () => {
    const src = [
      'codeunit 50102 "Split Tests"',
      "{",
      "    Subtype = Test;",
      "",
      "    [Test]",
      "#if CLEAN25",
      "    procedure Split()",
      "#else",
      "    procedure Split()",
      "#endif",
      "    begin",
      "    end;",
      "}",
      "",
    ].join("\n");
    expect(testsInAlSource("t/Split.Codeunit.al", src).map((r) => [r.method, r.line])).toEqual([
      ["Split", 7],
      ["Split", 9],
    ]);
  });

  test("tree path: both #if arms of one test are discovered, each at its own line", () => {
    // R403's whole-member shape. The `#pragma` between `[Test]` and `procedure` stops the regex
    // matching that arm, so the `[Test]` count (2) differs from the regex count (1) and the TREE
    // path decides (`testsOfFile`); the arm spellings differ in case, as AL allows.
    const src = [
      'codeunit 50101 "Arm Tests"',
      "{",
      "    Subtype = Test;",
      "",
      "#if LETHALX",
      "    [Test]",
      "#pragma warning disable AA0137",
      "    procedure Foo()",
      "    begin",
      "    end;",
      "#else",
      "    [Test]",
      "    procedure FOO()",
      "    begin",
      "    end;",
      "#endif",
      "}",
      "",
    ].join("\n");
    expect(Array.from(src.matchAll(/\[Test\]\s*procedure/gi)).length).toBe(1); // the regex path's view
    const refs = testsInAlSource("t/Arm.Codeunit.al", src);
    expect(refs.map((r) => [r.method, r.line])).toEqual([
      ["Foo", 8],
      ["FOO", 13],
    ]);
  });
});

describe("R272: testMethodsOf, one record per name", () => {
  const ref = (method: string, line: number, file = "t/A.al"): TestMethodRef => ({
    codeunitId: 1,
    codeunitName: "A Tests",
    method,
    file,
    line,
  });

  test("a name found at two places has no location and says why", () => {
    const out = testMethodsOf([ref("Foo", 7), ref("Foo", 12), ref("Bar", 20)], new Map());
    expect(out).toEqual([
      { name: "A Tests.Bar", file: "t/A.al", line: 20 },
      { name: "A Tests.Foo", file: "t/A.al", lineAmbiguous: true },
    ]);
  });

  test("Foo and FOO in two arms are one test at two places: a row each, both ambiguous", () => {
    const out = testMethodsOf([ref("Foo", 7), ref("FOO", 12), ref("Bar", 20)], new Map());
    expect(out).toEqual([
      { name: "A Tests.Bar", file: "t/A.al", line: 20 },
      { name: "A Tests.FOO", file: "t/A.al", lineAmbiguous: true },
      { name: "A Tests.Foo", file: "t/A.al", lineAmbiguous: true },
    ]);
  });

  test("the same place twice keeps its line; the smallest of the batches' durations is kept", () => {
    // Listed largest LAST, so keeping the last or the first measurement both read wrong.
    const out = testMethodsOf(
      [ref("Foo", 7), ref("Foo", 7)],
      new Map([["A Tests.Foo", [50, 42, 90]]]),
    );
    expect(out).toEqual([{ name: "A Tests.Foo", file: "t/A.al", line: 7, baselineDurationMs: 42 }]);
  });

  test("sorted by code unit, not by locale", () => {
    const out = testMethodsOf([ref("b", 1), ref("B", 2), ref("a", 3)], new Map());
    expect(out.map((t) => t.name)).toEqual(["A Tests.B", "A Tests.a", "A Tests.b"]);
  });
});

describe("R272: each backend's duration is the test's own", () => {
  const ref: TestMethodRef = { codeunitId: 1, codeunitName: "A", method: "M" };

  test("al-runner: the runner's own per-test figure, never the call's wall clock", () => {
    const v = verdictFromRunnerTest(
      ref,
      "A.M",
      { status: "pass", durationMs: 17 },
      5000,
      undefined,
    );
    expect(v.durationMs).toBe(5000); // the timeout budget's figure is unchanged
    expect(v.measuredDurationMs).toBe(17);
    const none = verdictFromRunnerTest(ref, "A.M", { status: "pass" }, 5000, undefined);
    expect("measuredDurationMs" in none).toBe(false);
    const fail = verdictFromRunnerTest(
      ref,
      "A.M",
      { status: "fail", durationMs: 9, message: "boom" },
      5000,
      undefined,
    );
    expect("measuredDurationMs" in fail).toBe(false);
  });

  test("bcdev: the per-test call's wall clock on a pass, on both paths", async () => {
    const backend = Object.create(BcDevMcpBackend.prototype) as BcDevMcpBackend;
    const answers: TestVerdict[] = [];
    const stub = async () => {
      const v = answers.shift();
      if (v === undefined) throw new Error("no answer");
      return v;
    };
    Object.assign(backend, { runOnHub: stub, runViaTransport: stub });
    const run = (coverage: RunOpts["coverage"]) =>
      backend.run(ref, { coverage, timeoutMs: 1000 } as RunOpts);
    answers.push({ ref, outcome: "pass", durationMs: 300 });
    expect((await run("procedure")).measuredDurationMs).toBe(300);
    answers.push({ ref, outcome: "pass", durationMs: 400 });
    expect((await run("none")).measuredDurationMs).toBe(400);
    answers.push({ ref, outcome: "fail", durationMs: 500 });
    expect("measuredDurationMs" in (await run("none"))).toBe(false);
    // A recovered reply's duration is the time until it was declared lost (R236b).
    answers.push({ ref, outcome: "pass", durationMs: 600, replyRecovered: "readback" });
    expect("measuredDurationMs" in (await run("none"))).toBe(false);
    // A clock stepped back gives a negative `Date.now()` delta: not a duration (it would make
    // `testMethods` invalid and explain refuse the whole report). 0 is a real, if quick, one.
    answers.push({ ref, outcome: "pass", durationMs: -3 });
    expect("measuredDurationMs" in (await run("procedure"))).toBe(false);
    answers.push({ ref, outcome: "pass", durationMs: 0 });
    expect((await run("procedure")).measuredDurationMs).toBe(0);
  });
});

describe("R272: explain's gaps[].coveringTests", () => {
  interface Row {
    readonly code: string;
    readonly gap: string;
    readonly covering: readonly string[];
    readonly reachedBy?: readonly string[];
    readonly verdict?: MutantOutcome["verdict"];
  }
  const row = (r: Row): MutantOutcome => ({
    mutantCode: r.code,
    file: "src/Foo.Codeunit.al",
    line: 11,
    operatorName: "lethal.negate-conditional",
    verdict: r.verdict ?? "survived",
    batchIndex: 0,
    durationMs: 10,
    procedureName: "DoIt",
    startIndex: 100,
    endIndex: 110,
    originalText: "Qty > 0",
    mutatedText: "Qty <= 0",
    coveringTests: [...r.covering],
    coverageAttribution: "exact",
    reachGrain: "statement",
    ...(r.reachedBy !== undefined
      ? { guardReached: r.reachedBy.length > 0, reachedBy: [...r.reachedBy] }
      : {}),
    runner: "fenced",
    astHash: `hash-${r.code}`,
    codeunitName: "Foo Mgt.",
    operatorMajor: 1,
    gapId: r.gap,
    blockStartLine: 10,
    blockEndLine: 20,
  });
  const report = (
    rows: readonly Row[],
    testMethods?: SessionReport["testMethods"],
  ): SessionReport => {
    const mutants = rows.map(row);
    const n = (v: MutantOutcome["verdict"]) => mutants.filter((m) => m.verdict === v).length;
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      validity: {
        reliability: "full",
        caveats: [],
        scoreDescribes: "fixture",
        baselineTests: { total: 4, failing: 0 },
        scoredMutants: { scored: n("killed") + n("survived"), recorded: mutants.length },
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
      testFiles: {},
      ...(testMethods !== undefined ? { testMethods } : {}),
      backend: "bcdev",
      authoritative: true,
      baselineGreen: true,
      batches: 1,
      counts: {
        killed: n("killed"),
        survived: n("survived"),
        noCoverage: 0,
        timeoutKilled: 0,
        knownSurvivors: 0,
        unstable: 0,
        errors: 0,
        deadlineExceeded: 0,
      },
      mutationScore: 0,
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
    };
  };
  const METHODS: SessionReport["testMethods"] = [
    { name: "T.Alpha", file: "t/T.al", line: 5, baselineDurationMs: 900 },
    { name: "T.Beta", file: "t/T.al", line: 9, baselineDurationMs: 10 },
    { name: "T.Gamma", lineAmbiguous: true },
    { name: "T.Unused", file: "t/T.al", line: 30 },
  ];

  test("ordered by survivors reached, then by name; the duration is copied, never a key", () => {
    const out = explain(
      report(
        [
          {
            code: "M1",
            gap: "G1",
            covering: ["T.Beta", "T.Alpha", "T.Gamma"],
            reachedBy: ["T.Gamma"],
          },
          {
            code: "M2",
            gap: "G1",
            covering: ["T.Alpha", "T.Beta"],
            reachedBy: ["T.Gamma", "T.Beta"],
          },
          { code: "M3", gap: "G1", covering: ["T.Beta"], verdict: "killed" },
        ],
        METHODS,
      ),
    );
    const [gap] = out.gaps ?? [];
    expect(gap?.reachMeasuredMembers).toBe(2);
    expect(gap?.coveringTests).toEqual([
      { name: "T.Gamma", lineAmbiguous: true, reachedMembers: 2 },
      { name: "T.Beta", file: "t/T.al", line: 9, reachedMembers: 1, baselineDurationMs: 10 },
      { name: "T.Alpha", file: "t/T.al", line: 5, reachedMembers: 0, baselineDurationMs: 900 },
    ]);
  });

  test("no measured reach: no reachedMembers, and the order is by name alone", () => {
    const out = explain(
      report([{ code: "M1", gap: "G1", covering: ["T.Beta", "T.Alpha"] }], METHODS),
    );
    const [gap] = out.gaps ?? [];
    expect(gap?.reachMeasuredMembers).toBe(0);
    expect(gap?.coveringTests?.map((t) => [t.name, "reachedMembers" in t])).toEqual([
      ["T.Alpha", false],
      ["T.Beta", false],
    ]);
  });

  test("a report without testMethods: no coveringTests at all, never []", () => {
    const [gap] = explain(report([{ code: "M1", gap: "G1", covering: ["T.Beta"] }])).gaps ?? [];
    expect(gap).toBeDefined();
    expect(gap !== undefined && "coveringTests" in gap).toBe(false);
    expect(gap !== undefined && "reachMeasuredMembers" in gap).toBe(false);
  });

  test("a covering test missing from testMethods refuses", () => {
    expect(() =>
      explain(report([{ code: "M1", gap: "G1", covering: ["T.Nowhere"] }], METHODS)),
    ).toThrow(MalformedReportError);
  });

  test("a malformed or repeated testMethods entry refuses", () => {
    const rows = [{ code: "M1", gap: "G1", covering: ["T.Beta"] }];
    expect(() => explain(report(rows, [...(METHODS ?? []), { name: "T.Beta" }]))).toThrow(
      MalformedReportError,
    );
    expect(() =>
      explain(report(rows, [{ name: "T.Beta", line: 0 }] as SessionReport["testMethods"])),
    ).toThrow(MalformedReportError);
  });
});
