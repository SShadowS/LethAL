import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_BY_SET,
  EXPECTED_NO_DEFINE,
  SYMBOL_SETS,
  type SymbolReport,
  type SymbolRow,
  assertSymbolBuild,
  symbolSetLabel,
} from "../itest/symbol-fixture";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
const A: readonly string[] = ["LETHALA"];
const B: readonly string[] = ["LETHALB"];

function rowsOf(label: string): readonly SymbolRow[] {
  const rows = EXPECTED_BY_SET[label];
  if (rows === undefined) throw new Error(`no table for ${label}`);
  return rows;
}

/** A report whose mutants are exactly `rows`, as a leg that measured them would record them. */
function reportOf(rows: readonly SymbolRow[], symbols: readonly string[]): SymbolReport {
  return {
    baselineGreen: true,
    preprocessorSymbols: symbols,
    mutants: rows.map((r, i) => ({
      mutantCode: `M${String(i + 1).padStart(4, "0")}`,
      file: "src/SymbolLogic.Codeunit.al",
      line: r.line,
      operatorName: r.operatorName,
      verdict: r.verdict,
      ...(r.killingTest !== undefined ? { killingTest: r.killingTest } : {}),
    })),
  };
}

describe("R321 symbol fixture tables", () => {
  test("each build passes against its own table", () => {
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALA]"), A), A, "one-shot")).not.toThrow();
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALB]"), B), B, "one-shot")).not.toThrow();
  });

  test("a leg that lost its defines fails, although the report still names the symbol", () => {
    // The shape of both red-checks: the #else build's verdicts under a set's own label and symbols.
    expect(() => assertSymbolBuild(reportOf(EXPECTED_NO_DEFINE, A), A, "one-shot")).toThrow(
      /R321 one-shot \[LETHALA\]: per-mutant verdicts differ/,
    );
    expect(() => assertSymbolBuild(reportOf(EXPECTED_NO_DEFINE, B), B, "--server")).toThrow(
      /R321 --server \[LETHALB\]: per-mutant verdicts differ/,
    );
  });

  test("the other set's build fails", () => {
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALB]"), A), A, "x")).toThrow(/R321/);
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALA]"), B), B, "x")).toThrow(/R321/);
  });

  test("a missing, an extra, or a re-attributed mutant fails", () => {
    const rows = rowsOf("[LETHALA]");
    expect(() => assertSymbolBuild(reportOf(rows.slice(1), A), A, "x")).toThrow(/R321/);
    const first = rows[0];
    if (first === undefined) throw new Error("empty table");
    expect(() => assertSymbolBuild(reportOf([...rows, first], A), A, "x")).toThrow(/R321/);
    const renamed = rows.map((r) =>
      r.killingTest !== undefined ? { ...r, killingTest: "Other" } : r,
    );
    expect(() => assertSymbolBuild(reportOf(renamed, A), A, "x")).toThrow(/R321/);
  });

  test("a red baseline, other recorded symbols, or another file fails", () => {
    const good = reportOf(rowsOf("[LETHALA]"), A);
    expect(() => assertSymbolBuild({ ...good, baselineGreen: false }, A, "x")).toThrow(/R321/);
    expect(() => assertSymbolBuild({ ...good, preprocessorSymbols: [] }, A, "x")).toThrow(/R321/);
    const moved = {
      ...good,
      mutants: good.mutants.map((m) => ({ ...m, file: "src/Other.Codeunit.al" })),
    };
    expect(() => assertSymbolBuild(moved, A, "x")).toThrow(/R321/);
  });

  test("a set with no pre-committed table is an error, the empty set included", () => {
    expect(() => assertSymbolBuild(reportOf(EXPECTED_NO_DEFINE, []), [], "x")).toThrow(
      /no pre-committed table/,
    );
  });

  test("non-vacuity: three builds, same 13 mutants, 5/8 each, pairwise different on 8", () => {
    const tables = [rowsOf("[LETHALA]"), rowsOf("[LETHALB]"), EXPECTED_NO_DEFINE];
    const key = (r: SymbolRow) => `${r.line}|${r.operatorName}`;
    for (const t of tables) {
      expect(t).toHaveLength(13);
      expect(t.map(key)).toEqual(tables[0]?.map(key) ?? []);
      expect(t.filter((r) => r.verdict === "killed")).toHaveLength(5);
    }
    const differ = (x: readonly SymbolRow[], y: readonly SymbolRow[]) =>
      x.filter((r, i) => r.verdict !== y[i]?.verdict).length;
    const [ta, tb, tn] = tables;
    if (ta === undefined || tb === undefined || tn === undefined) throw new Error("missing table");
    expect([differ(ta, tb), differ(ta, tn), differ(tb, tn)]).toEqual([8, 8, 8]);
  });

  test("drift: both symbol-sets.json files are the #else build plus SYMBOL_SETS, and every set has a table", () => {
    for (const project of ["sandbox-symbols", "sandbox-symbols-tests"]) {
      const onDisk: unknown = JSON.parse(
        readFileSync(join(FIXTURES, project, "symbol-sets.json"), "utf8"),
      );
      expect(onDisk).toEqual([[], ...SYMBOL_SETS.map((s) => [...s])]);
    }
    expect(Object.keys(EXPECTED_BY_SET).sort()).toEqual(SYMBOL_SETS.map(symbolSetLabel).sort());
  });
});
