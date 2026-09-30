import { describe, expect, test } from "bun:test";
import {
  EXPECTED_LAYOUT,
  type LayoutReport,
  type LayoutRow,
  assertLayoutLegsEqual,
  assertLayoutRun,
} from "../itest/layout-fixture";

/** A report whose mutants are exactly `rows`, as a leg that measured them would record them. */
function reportOf(rows: readonly LayoutRow[]): LayoutReport {
  return {
    baselineGreen: true,
    batches: 2,
    mutants: rows.map((r) => {
      const [batch, code] = r.ref.split("/");
      return {
        batchIndex: Number(batch),
        mutantCode: code ?? "",
        file: r.file.replace(/\//g, "\\"),
        line: r.line,
        operatorName: r.operatorName,
        procedureName: r.procedureName,
        verdict: r.verdict,
        ...(r.killingTest !== undefined ? { killingTest: r.killingTest } : {}),
        coveringTests: r.coveringTests,
        coverageAttribution: r.coverageAttribution,
      };
    }),
  };
}

/** The spec's unfixed one-shot table: Twice's two mutants lose their test to GrowAboveTen. */
const UNFIXED: readonly LayoutRow[] = EXPECTED_LAYOUT.map((r) =>
  r.procedureName === "Twice"
    ? {
        ref: r.ref,
        file: r.file,
        line: r.line,
        operatorName: r.operatorName,
        procedureName: r.procedureName,
        verdict: "survived",
        coveringTests: ["Layout Tests.GrowAboveTen"],
        coverageAttribution: "exact",
      }
    : r,
);

describe("R353 layout oracle", () => {
  test("the pre-committed table passes, and pins 7 killed / 3 survived over ten refs", () => {
    expect(() => assertLayoutRun(reportOf(EXPECTED_LAYOUT), "one-shot")).not.toThrow();
    expect(EXPECTED_LAYOUT.map((r) => r.ref)).toEqual([
      "0/M0001",
      "0/M0002",
      "0/M0003",
      "1/M0001",
      "1/M0002",
      "1/M0003",
      "1/M0004",
      "1/M0005",
      "1/M0006",
      "1/M0007",
    ]);
    expect(EXPECTED_LAYOUT.filter((r) => r.verdict === "killed").length).toBe(7);
  });

  test("the unfixed table fails naming EVERY moved ref, not the first", () => {
    let message = "";
    try {
      assertLayoutRun(reportOf(UNFIXED), "one-shot");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("R353 layout one-shot");
    expect(message).toContain("1/M0006");
    expect(message).toContain("1/M0007");
    expect(message).not.toContain("1/M0005");
  });

  test("a missing and an extra ref are both named", () => {
    const rows = EXPECTED_LAYOUT.filter((r) => r.ref !== "0/M0003");
    const extra = EXPECTED_LAYOUT.find((r) => r.ref === "1/M0007");
    if (extra === undefined) throw new Error("no 1/M0007 row");
    expect(() => assertLayoutRun(reportOf([...rows, { ...extra, ref: "1/M0008" }]), "x")).toThrow(
      /0\/M0003 missing[\s\S]*1\/M0008 unexpected/,
    );
  });

  test("a covering-test set that gains one test fails, although the verdict holds", () => {
    const rows = EXPECTED_LAYOUT.map((r) =>
      r.ref === "0/M0001"
        ? { ...r, coveringTests: ["Layout Tests.AlphaIsBig", "Layout Tests.GrowAboveTen"] }
        : r,
    );
    expect(() => assertLayoutRun(reportOf(rows), "x")).toThrow(/0\/M0001/);
  });

  test("an attribution other than exact fails", () => {
    const rows = EXPECTED_LAYOUT.map((r) =>
      r.ref === "1/M0002" ? { ...r, coverageAttribution: "object" as const } : r,
    );
    expect(() => assertLayoutRun(reportOf(rows), "x")).toThrow(/1\/M0002/);
  });

  test("a one-batch run fails on the batch count", () => {
    expect(() => assertLayoutRun({ ...reportOf(EXPECTED_LAYOUT), batches: 1 }, "x")).toThrow(
      /2 batches/,
    );
  });

  test("the --server equality check names the two refs the unfixed one-shot leg moved", () => {
    expect(() =>
      assertLayoutLegsEqual(reportOf(EXPECTED_LAYOUT), reportOf(EXPECTED_LAYOUT), "--server"),
    ).not.toThrow();
    let message = "";
    try {
      assertLayoutLegsEqual(reportOf(EXPECTED_LAYOUT), reportOf(UNFIXED), "--server");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("1/M0006");
    expect(message).toContain("1/M0007");
    expect(message).not.toContain("1/M0005");
  });
});
