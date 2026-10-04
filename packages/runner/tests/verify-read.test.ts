import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REACH_FILTER_OFF_REASONS, REACH_FILTER_STATES } from "../src/verify-reach";
import {
  READ_REACH_FILTER_OFF_REASONS,
  READ_REACH_FILTER_STATES,
  droppedNewTestsOf,
  reachFilterOf,
  reachNarrowingOf,
} from "../src/verify-read";

test("R-425: the reader's value lists are verify-reach.ts's", () => {
  expect([...READ_REACH_FILTER_STATES]).toEqual([...REACH_FILTER_STATES]);
  expect([...READ_REACH_FILTER_OFF_REASONS]).toEqual([...REACH_FILTER_OFF_REASONS]);
});

// R-425: the reader rule. A missing field is UNKNOWN, never "off", and narrowing is never inferred
// from `testsRun`. Pinned on a REAL v4 report: the R-384 gate's step-3 JSON, committed byte for
// byte. Its LogAudit row's `testsRun` lacks the new test, and nothing in a v4 report says why.

type Doc = Record<string, unknown> & { readonly results: Array<Record<string, unknown>> };

const V4_PATH = join(import.meta.dir, "fixtures", "verify-v4-r384-step3.json");
const loadV4 = (): Doc => JSON.parse(readFileSync(V4_PATH, "utf8")) as Doc;

const NEW_TEST = "Sandbox Tests.ZzC0206ClampRejectsAboveHundred";

function rowOf(doc: Doc, procedureName: string): Record<string, unknown> {
  const r = doc.results.find((x) => x.procedureName === procedureName);
  if (r === undefined) throw new Error(`no ${procedureName} row`);
  return r;
}

/** The v4 fixture as a v5 report would carry it, with the given run-level and row fields. */
function asV5(reachFilter: unknown, rows: Readonly<Record<string, boolean | undefined>>): Doc {
  const v4 = loadV4();
  return {
    ...v4,
    verifySchemaVersion: 5,
    ...(reachFilter !== undefined ? { reachFilter } : {}),
    results: v4.results.map((r) => {
      const n = rows[String(r.procedureName)];
      return n !== undefined ? { ...r, reachNarrowed: n } : r;
    }),
  };
}

describe("R-425: reading a REAL v4 report", () => {
  test("the fixture is the case it claims: LogAudit's testsRun lacks the new test", () => {
    const doc = loadV4();
    expect(doc.verifySchemaVersion).toBe(4);
    expect((doc.newTests as Array<{ test: string }>).map((t) => t.test)).toEqual([NEW_TEST]);
    expect(rowOf(doc, "LogAudit").testsRun).toEqual(["Sandbox Tests.ClampPercentRuns"]);
    expect(rowOf(doc, "ClampPercent").testsRun).toContain(NEW_TEST);
  });

  test("the run state is unknown (predates v5), never off", () => {
    expect(reachFilterOf(loadV4())).toEqual({ state: "unknown", why: "predates-v5" });
  });

  test("both rows, LogAudit included, read unknown, and no dropped list is derived", () => {
    const doc = loadV4();
    for (const name of ["ClampPercent", "LogAudit"]) {
      expect(reachNarrowingOf(doc, rowOf(doc, name))).toBe("unknown");
      expect(droppedNewTestsOf(doc, rowOf(doc, name))).toBeUndefined();
    }
  });

  test("a v4 document carrying the fields anyway is still predates-v5", () => {
    const v4 = loadV4();
    const doc: Doc = {
      ...v4,
      reachFilter: { state: "on" },
      results: v4.results.map((r) => ({ ...r, reachNarrowed: true })),
    };
    expect(reachFilterOf(doc)).toEqual({ state: "unknown", why: "predates-v5" });
    expect(reachNarrowingOf(doc, rowOf(doc, "LogAudit"))).toBe("unknown");
  });
});

describe("R-425: reading a v5 report", () => {
  test("on: narrowed and not-narrowed rows, and the dropped list is newTests minus testsRun", () => {
    const doc = asV5({ state: "on" }, { ClampPercent: false, LogAudit: true });
    expect(reachFilterOf(doc)).toEqual({ state: "on" });
    expect(reachNarrowingOf(doc, rowOf(doc, "ClampPercent"))).toBe("not-narrowed");
    expect(droppedNewTestsOf(doc, rowOf(doc, "ClampPercent"))).toBeUndefined();
    expect(reachNarrowingOf(doc, rowOf(doc, "LogAudit"))).toBe("narrowed");
    expect(droppedNewTestsOf(doc, rowOf(doc, "LogAudit"))).toEqual([NEW_TEST]);
  });

  test("off: the reason is read back, and rows are not narrowed", () => {
    const doc = asV5(
      { state: "off", reason: "coverage-mode-procedure" },
      { ClampPercent: false, LogAudit: false },
    );
    expect(reachFilterOf(doc)).toEqual({ state: "off", reason: "coverage-mode-procedure" });
    expect(reachNarrowingOf(doc, rowOf(doc, "LogAudit"))).toBe("not-narrowed");
  });

  test("the field absent is unknown (not decided), never off", () => {
    const doc = asV5(undefined, {});
    expect(reachFilterOf(doc)).toEqual({ state: "unknown", why: "not-decided" });
    expect(reachNarrowingOf(doc, rowOf(doc, "LogAudit"))).toBe("unknown");
    expect(droppedNewTestsOf(doc, rowOf(doc, "LogAudit"))).toBeUndefined();
  });

  test("a row without reachNarrowed is unknown even with the filter on", () => {
    const doc = asV5({ state: "on" }, { ClampPercent: false });
    expect(reachNarrowingOf(doc, rowOf(doc, "LogAudit"))).toBe("unknown");
  });

  test("a document that breaks the contract is thrown, never read as a plausible default", () => {
    const v4 = loadV4();
    const { verifySchemaVersion: _v, ...noVersion } = v4;
    expect(() => reachFilterOf(noVersion)).toThrow(/verifySchemaVersion/);
    expect(() => reachFilterOf(asV5({ state: "off" }, {}))).toThrow(/reason/);
    expect(() => reachFilterOf(asV5({ state: "on", reason: "no-reach-filter" }, {}))).toThrow(
      /reason/,
    );
    expect(() => reachFilterOf(asV5({ state: "maybe" }, {}))).toThrow(/state/);
    expect(() => reachFilterOf(asV5({ state: "off", reason: "because" }, {}))).toThrow(/reason/);
    const bad = asV5({ state: "on" }, {});
    expect(() =>
      reachNarrowingOf(bad, { ...rowOf(bad, "LogAudit"), reachNarrowed: "yes" }),
    ).toThrow(/reachNarrowed/);
    const { testsRun: _t, ...noTestsRun } = rowOf(
      asV5({ state: "on" }, { LogAudit: true }),
      "LogAudit",
    );
    expect(() => droppedNewTestsOf(asV5({ state: "on" }, {}), noTestsRun)).toThrow(/testsRun/);
  });
});
