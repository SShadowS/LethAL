import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReport } from "../src/report";
import {
  BASELINE_CODEUNIT,
  type BaselineLegInput,
  DRAIN_KEY,
  type HangTestRow,
  SLEEPS,
  SLEEPS_METHOD,
  Z,
  ZZ,
  ZZ_METHOD,
  Z_METHOD,
  baselineLegFailures,
  copyEvidence,
  quarantineStopReasons,
  stopHungSessionsFindings,
  writeLegState,
} from "./hang-baseline-leg";

/**
 * R-658: each of the BASELINE leg's assertions, and each STOP trigger the gate can judge offline,
 * goes red in its failure direction (pre-commitment 00d508c4 §4 and §5).
 */

type Mutant = SessionReport["mutants"][number];

const [drainHash = "", , , drainOp = ""] = DRAIN_KEY.split("|");

function mutant(over: Partial<Mutant>): Mutant {
  return {
    mutantCode: "M0001",
    file: "src/HangLogic.Codeunit.al",
    line: 38,
    operatorName: "lethal.conditional-boundary",
    verdict: "no-coverage",
    batchIndex: 0,
    astHash: "aaaa",
    codeunitName: "Hang Logic",
    procedureName: "CountUpTo",
    operatorMajor: 1,
    coveringTests: [],
    ...over,
  } as Mutant;
}

const row = (over: Partial<HangTestRow>): HangTestRow => ({
  op_kind: null,
  mutant_code: null,
  mutant_row_id: null,
  codeunit_name: BASELINE_CODEUNIT,
  method: Z_METHOD,
  outcome: "pass",
  duration_ms: 5,
  failure_message: null,
  ...over,
});

const STOP_MSG = "The server stopped the session because StopSession was called.";

function good(): BaselineLegInput {
  const mutants = [
    mutant({ mutantCode: "M0001", line: 38 }),
    mutant({ mutantCode: "M0002", line: 63, procedureName: "NextRow", astHash: "bbbb" }),
    mutant({
      mutantCode: "M0003",
      line: 103,
      procedureName: "DrainQueue",
      astHash: drainHash,
      operatorName: drainOp,
      verdict: "killed",
      killPosition: 1,
      killingTest: ZZ_METHOD,
      coveringTests: [ZZ],
    }),
    mutant({ mutantCode: "M0004", line: 141, procedureName: "SpinUntil", astHash: "cccc" }),
    mutant({ mutantCode: "M0005", line: 146, procedureName: "SpinUntil", astHash: "dddd" }),
  ];
  const report = {
    mutants,
    counts: { killed: 1 },
    baselineGreen: false,
    validity: {
      caveats: [
        "baseline-red",
        "baseline-test-stopped",
        "tests-narrowed",
        "operator-narrowed",
        "session-warm",
      ],
    },
    unsupportedTests: [],
    baselineStopped: { tests: [SLEEPS], budgetMs: 10_000 },
  } as unknown as SessionReport;
  return {
    report,
    testRows: [
      row({
        method: SLEEPS_METHOD,
        outcome: "timeout",
        duration_ms: 10_100,
        failure_message: STOP_MSG,
      }),
      row({ method: Z_METHOD }),
      row({ method: ZZ_METHOD }),
      row({
        method: ZZ_METHOD,
        mutant_code: "M0003",
        mutant_row_id: 3,
        outcome: "fail",
        op_kind: "many",
      }),
      row({ method: ZZ_METHOD, mutant_code: "M0003", mutant_row_id: 3, outcome: "fail" }),
    ],
    baselineVerdicts: [
      { name: SLEEPS, outcome: "timeout", classification: ["baseline-test-stopped"] },
      { name: Z, outcome: "pass", classification: [] },
      { name: ZZ, outcome: "pass", classification: [] },
    ],
    quarantinedEvents: 0,
    quarantineRecords: 0,
    warnings: [
      { code: "operator-narrowed-run", message: "narrowed" },
      {
        code: "tests-only-narrowed-baseline",
        message: "[lethal] --tests-only narrowed the baseline to 3 test(s) from 1 pattern(s).",
      },
    ],
    baselineSnapshotRows: 0,
    repro: [],
    sessionLiveness: { missing: 0, singleRows: 3, singleDistinct: 3 },
    probe: { granted: true, released: true },
    elapsedMs: 120_000,
  };
}

type Edit = (i: BaselineLegInput) => BaselineLegInput;
const withReport = (i: BaselineLegInput, over: Record<string, unknown>): BaselineLegInput => ({
  ...i,
  report: { ...i.report, ...over } as SessionReport,
});
const mapMutant = (i: BaselineLegInput, code: string, over: Partial<Mutant>): BaselineLegInput =>
  withReport(i, {
    mutants: i.report.mutants.map((m) => (m.mutantCode === code ? { ...m, ...over } : m)),
  });
const mapRow = (i: BaselineLegInput, n: number, over: Partial<HangTestRow>): BaselineLegInput => ({
  ...i,
  testRows: i.testRows.map((r, k) => (k === n ? { ...r, ...over } : r)),
});
const caveatsWithout = (i: BaselineLegInput, c: string): BaselineLegInput =>
  withReport(i, { validity: { caveats: i.report.validity.caveats.filter((x) => x !== c) } });

describe("R-658 baselineLegFailures", () => {
  test("the predicted leg passes", () => {
    expect(baselineLegFailures(good())).toEqual([]);
  });

  const cases: ReadonlyArray<readonly [string, string, Edit]> = [
    // STOP trigger 1 is judged here: no 408 means no timeout row with BC's words in the window.
    ["A1", "the stopped test passed", (i) => mapRow(i, 0, { outcome: "pass" })],
    [
      "A1",
      "no stop words (trigger 1)",
      (i) => mapRow(i, 0, { failure_message: "deadline exceeded" }),
    ],
    ["A1", "StopSession missing", (i) => mapRow(i, 0, { failure_message: "stopped the session" })],
    ["A1", "under the budget", (i) => mapRow(i, 0, { duration_ms: 9_999 })],
    ["A1", "at the window's end (trigger 1)", (i) => mapRow(i, 0, { duration_ms: 15_000 })],
    [
      "A1",
      "two baseline rows",
      (i) => ({ ...i, testRows: [...i.testRows, i.testRows[0] as HangTestRow] }),
    ],
    ["A1", "no classification", (i) => ({ ...i, baselineVerdicts: i.baselineVerdicts.slice(1) })],
    ["A2", "Z failed", (i) => mapRow(i, 1, { outcome: "fail" })],
    [
      "A2",
      "Z shows target coverage (trigger 4)",
      (i) => mapMutant(i, "M0001", { coveringTests: [Z] }),
    ],
    ["A3", "ZZ failed (trigger 5)", (i) => mapRow(i, 2, { outcome: "fail" })],
    [
      "A3",
      "the stopped test counted as covering (trigger 5)",
      (i) => mapMutant(i, "M0003", { coveringTests: [SLEEPS, ZZ] }),
    ],
    ["A3", "ZZ lost its coverage (trigger 5)", (i) => mapMutant(i, "M0003", { coveringTests: [] })],
    ["A3", "ZZ covers another mutant", (i) => mapMutant(i, "M0002", { coveringTests: [ZZ] })],
    [
      "A4",
      "a sixth mutant",
      (i) =>
        withReport(i, {
          mutants: [...i.report.mutants, mutant({ mutantCode: "M0006", astHash: "eeee" })],
        }),
    ],
    ["A5", "DrainQueue survived", (i) => mapMutant(i, "M0003", { verdict: "survived" })],
    ["A5", "killed at position 2", (i) => mapMutant(i, "M0003", { killPosition: 2 })],
    ["A5", "another killer", (i) => mapMutant(i, "M0003", { killingTest: SLEEPS_METHOD })],
    ["A5", "the key moved", (i) => mapMutant(i, "M0003", { astHash: "ffff" })],
    ["A6", "one mutated row", (i) => ({ ...i, testRows: i.testRows.slice(0, 4) })],
    ["A6", "a mutated row passed", (i) => mapRow(i, 4, { outcome: "pass" })],
    ["A7", "another mutant survived", (i) => mapMutant(i, "M0004", { verdict: "survived" })],
    ["A7", "two kills counted", (i) => withReport(i, { counts: { killed: 2 } })],
    ["A8", "the baseline read green", (i) => withReport(i, { baselineGreen: true })],
    ["A9", "no baseline-red", (i) => caveatsWithout(i, "baseline-red")],
    ["A9", "no baseline-test-stopped", (i) => caveatsWithout(i, "baseline-test-stopped")],
    ["A9", "no tests-narrowed", (i) => caveatsWithout(i, "tests-narrowed")],
    ["A9", "no operator-narrowed", (i) => caveatsWithout(i, "operator-narrowed")],
    [
      "A9",
      "stop-hung-sessions present",
      (i) =>
        withReport(i, {
          validity: { caveats: [...i.report.validity.caveats, "stop-hung-sessions"] },
        }),
    ],
    ["A10", "a quarantined event (trigger 2)", (i) => ({ ...i, quarantinedEvents: 1 })],
    [
      "A10",
      "report.quarantined (trigger 2)",
      (i) => withReport(i, { quarantined: { reason: "x" } }),
    ],
    ["A10", "a quarantine record (trigger 2)", (i) => ({ ...i, quarantineRecords: 1 })],
    [
      "A11",
      "a lease warning",
      (i) => ({ ...i, warnings: [...i.warnings, { code: "lease-renew-failed", message: "" }] }),
    ],
    ["A11", "a warning missing", (i) => ({ ...i, warnings: i.warnings.slice(1) })],
    [
      "A11",
      "a warning twice",
      (i) => ({ ...i, warnings: [...i.warnings, ...i.warnings.slice(0, 1)] }),
    ],
    [
      "A11",
      "the narrowing names 4 tests",
      (i) => ({
        ...i,
        warnings: [
          i.warnings[0] as BaselineLegInput["warnings"][number],
          { code: "tests-only-narrowed-baseline", message: "narrowed the baseline to 4 test(s)" },
        ],
      }),
    ],
    ["A12", "a baseline snapshot", (i) => ({ ...i, baselineSnapshotRows: 1 })],
    ["A13", "no baselineStopped", (i) => withReport(i, { baselineStopped: undefined })],
    [
      "A13",
      "a second stopped test",
      (i) => withReport(i, { baselineStopped: { tests: [SLEEPS, Z], budgetMs: 10_000 } }),
    ],
    [
      "A13",
      "reused from a run",
      (i) =>
        withReport(i, { baselineStopped: { tests: [SLEEPS], budgetMs: 10_000, reusedFromRun: 1 } }),
    ],
    ["A14", "an unsupported test", (i) => withReport(i, { unsupportedTests: [Z] })],
    ["A14", "permissionsRefused", (i) => withReport(i, { permissionsRefused: { tests: [Z] } })],
    ["A15", "a kill not reproduced", (i) => ({ ...i, repro: ["R577 hang/baseline: x"] })],
    [
      "A16",
      "a row without a session id",
      (i) => ({ ...i, sessionLiveness: { ...i.sessionLiveness, missing: 1 } }),
    ],
    [
      "A17",
      "two rows share a session",
      (i) => ({ ...i, sessionLiveness: { ...i.sessionLiveness, singleDistinct: 2 } }),
    ],
    [
      "A18",
      "probe acquire refused (trigger 3)",
      (i) => ({ ...i, probe: { granted: false, released: false } }),
    ],
    [
      "A18",
      "probe release refused (trigger 3)",
      (i) => ({ ...i, probe: { granted: true, released: false } }),
    ],
    ["A20", "five minutes", (i) => ({ ...i, elapsedMs: 300_000 })],
  ];
  for (const [n, what, edit] of cases) {
    test(`${n} goes red: ${what}`, () => {
      const failures = baselineLegFailures(edit(good()));
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.some((f) => f.startsWith(`${n}: `))).toBe(true);
    });
  }
});

describe("R-658 quarantineStopReasons (D-C, trigger 7)", () => {
  const report = (cause?: string) =>
    ({
      mutants: [mutant(cause !== undefined ? ({ cause } as Partial<Mutant>) : {})],
    }) as unknown as SessionReport;
  test("a clean leg is no STOP, and an unrelated cause is none either", () => {
    expect(
      quarantineStopReasons("ON", { report: report(), quarantinedEvents: 0, quarantineRecords: 0 }),
    ).toEqual([]);
    expect(
      quarantineStopReasons("ON", {
        report: report("kill-not-reproduced"),
        quarantinedEvents: 0,
        quarantineRecords: 0,
      }),
    ).toEqual([]);
  });
  test("an event, a record, a stranded and a confirm-stopped mutant each STOP", () => {
    expect(
      quarantineStopReasons("ON", { report: report(), quarantinedEvents: 1, quarantineRecords: 0 }),
    ).toHaveLength(1);
    expect(
      quarantineStopReasons("SINGLE", {
        report: report(),
        quarantinedEvents: 0,
        quarantineRecords: 2,
      }),
    ).toHaveLength(1);
    expect(
      quarantineStopReasons("ON", {
        report: report("stranded"),
        quarantinedEvents: 0,
        quarantineRecords: 0,
      }),
    ).toHaveLength(1);
    expect(
      quarantineStopReasons("SINGLE", {
        report: report("confirm-stopped"),
        quarantinedEvents: 0,
        quarantineRecords: 0,
      }),
    ).toHaveLength(1);
  });
});

describe("R-658 stopHungSessionsFindings (A19)", () => {
  test("absent from both is clean; present, even false, in either is a finding", () => {
    expect(stopHungSessionsFindings({ a: 1 }, { b: 2 })).toEqual([]);
    expect(stopHungSessionsFindings({ stopHungSessions: true }, {})).toHaveLength(1);
    expect(stopHungSessionsFindings({ stopHungSessions: false }, {})).toHaveLength(1);
    expect(stopHungSessionsFindings({}, { stopHungSessions: true })).toHaveLength(1);
  });
});

describe("R-658 leg marker and evidence", () => {
  test("writeLegState writes the state, skips an unset path, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "r658-marker-"));
    try {
      const p = join(dir, "baseline-leg.state");
      writeLegState(p, "armed");
      expect(readFileSync(p, "utf8")).toBe("armed\n");
      writeLegState(p, "stop");
      expect(readFileSync(p, "utf8")).toBe("stop\n");
      writeLegState(undefined, "passed");
      expect(() => writeLegState(join(dir, "no", "such", "dir", "x"), "stop")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("copyEvidence copies each leg's store and quarantine dir, and reports an unset dir", () => {
    const root = mkdtempSync(join(tmpdir(), "r658-evidence-"));
    try {
      const scratch = join(root, "scratch");
      mkdirSync(join(scratch, "quarantine-baseline"), { recursive: true });
      writeFileSync(join(scratch, "hang-on.sqlite"), "db");
      writeFileSync(join(scratch, "quarantine-baseline", "r.json"), "{}");
      const out = join(root, "out");
      const lines = copyEvidence(scratch, out, ["on", "baseline"]);
      expect(lines).toEqual([
        "evidence: copied hang-on.sqlite",
        "evidence: copied quarantine-baseline",
      ]);
      expect(readFileSync(join(out, "hang-on.sqlite"), "utf8")).toBe("db");
      expect(existsSync(join(out, "quarantine-baseline", "r.json"))).toBe(true);
      expect(copyEvidence(scratch, undefined, ["on"])[0]).toContain("unset");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("R-658 the fixture names", () => {
  test("the gate's names are the fixture's, in source order", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "fixtures",
        "sandbox-hang-tests",
        "src",
        "HangBaselineTests.Codeunit.al",
      ),
      "utf8",
    );
    expect(src.match(/^codeunit 79451 "([^"]+)"/)?.[1]).toBe(BASELINE_CODEUNIT);
    const procs = [...src.matchAll(/\[Test\]\s*procedure (\w+)\(/g)].map((m) => m[1]);
    expect(procs).toEqual([SLEEPS_METHOD, Z_METHOD, ZZ_METHOD]);
  });
});
