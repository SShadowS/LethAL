// R602: the pure halves of legs MO and WR of `itest:alrunner-v3`: the durable killer constants (built
// from the measured `--mode none` runs, never written by record mode) and the judges that read them.
import { describe, expect, test } from "bun:test";
import {
  type V3RowFacts,
  V3_MO_KILLERS,
  V3_WR_KILLERS,
  judgeKillers,
  judgeWrArms,
} from "../itest/alrunner-v3-legs";
import { ARMS_REFUSAL } from "../itest/wrapped-fixture";

const ARMS_FILE = "src/WrappedArms.Codeunit.al";

/** The rows a perfect run would give: each killer killed by its own test. */
const killedRows = (ks: typeof V3_MO_KILLERS): V3RowFacts[] =>
  ks.map(([mutantCode, file, line, op, test]) => ({
    mutantCode,
    file,
    line,
    operatorName: `lethal.${op}`,
    verdict: "killed",
    killingTest: test,
  }));

describe("R602: the killer constants", () => {
  test("their sizes are the measured `none` figures, and no WrappedArms row is in them", () => {
    expect(V3_MO_KILLERS).toHaveLength(6);
    // 60 kills under `none`, minus the two WrappedArms kills (M0001, M0003) the by-name refusal costs.
    expect(V3_WR_KILLERS).toHaveLength(58);
    expect(V3_WR_KILLERS.some((k) => k[1] === ARMS_FILE)).toBe(false);
    for (const ks of [V3_MO_KILLERS, V3_WR_KILLERS]) {
      expect(new Set(ks.map((k) => k[0])).size).toBe(ks.length);
    }
  });
});

describe("judgeKillers: each constant killer must be killed by the same test", () => {
  test("a run that kills every killer by its test has no problem", () => {
    expect(judgeKillers(killedRows(V3_MO_KILLERS), V3_MO_KILLERS)).toEqual([]);
    expect(judgeKillers(killedRows(V3_WR_KILLERS), V3_WR_KILLERS)).toEqual([]);
  });

  test("a lost kill (survived or no-coverage) is named, with the test it lost", () => {
    for (const verdict of ["survived", "no-coverage"]) {
      const rows = killedRows(V3_MO_KILLERS).map((r, i) =>
        i === 0
          ? {
              mutantCode: r.mutantCode,
              file: r.file,
              line: r.line,
              operatorName: r.operatorName,
              verdict,
            }
          : r,
      );
      const got = judgeKillers(rows, V3_MO_KILLERS);
      expect(got).toHaveLength(1);
      expect(got[0]).toContain("M0001");
      expect(got[0]).toContain(verdict);
      expect(got[0]).toContain("ControlDoubles");
    }
  });

  test("a kill by ANOTHER test, a missing mutant and a moved site are each named", () => {
    const rows = killedRows(V3_MO_KILLERS);
    const other = rows.map((r, i) => (i === 1 ? { ...r, killingTest: "Elsewhere" } : r));
    expect(judgeKillers(other, V3_MO_KILLERS)).toHaveLength(1);
    expect(judgeKillers(rows.slice(1), V3_MO_KILLERS)).toHaveLength(1);
    const moved = rows.map((r, i) => (i === 2 ? { ...r, line: r.line + 1 } : r));
    expect(judgeKillers(moved, V3_MO_KILLERS)).toHaveLength(1);
  });

  test("a killer list that matches nothing is not an empty pass", () => {
    expect(judgeKillers([], V3_MO_KILLERS)).toHaveLength(6);
  });
});

describe("judgeWrArms: the by-name refusal is exactly the three WrappedArms rows", () => {
  const arms = (n: number): V3RowFacts[] =>
    [1, 2, 3].slice(0, n).map((i) => ({
      mutantCode: `M000${i}`,
      file: ARMS_FILE,
      line: 6 + i,
      operatorName: "lethal.x",
      verdict: "no-coverage",
      failureNote: ARMS_REFUSAL,
    }));
  const other: V3RowFacts = {
    mutantCode: "M0004",
    file: "src/WrappedPairA.Codeunit.al",
    line: 10,
    operatorName: "lethal.x",
    verdict: "killed",
  };

  test("three refused WrappedArms rows and a clean neighbour pass", () => {
    expect(judgeWrArms([...arms(3), other], ARMS_REFUSAL)).toEqual([]);
  });

  test("a WrappedArms row that is not refused, or a refusal on another file, or only two rows, is named", () => {
    const loose = arms(3).map((r, i) => (i === 0 ? { ...r, verdict: "killed" } : r));
    expect(judgeWrArms([...loose, other], ARMS_REFUSAL)).toHaveLength(1);
    const leaked = { ...other, failureNote: ARMS_REFUSAL };
    expect(judgeWrArms([...arms(3), leaked], ARMS_REFUSAL)).toHaveLength(1);
    expect(judgeWrArms([...arms(2), other], ARMS_REFUSAL)).toHaveLength(1);
  });

  test("the refusal sentence is the one the code emits today", () => {
    expect(ARMS_REFUSAL).toBe(
      "coverage refused for Codeunit:78906 (src/WrappedArms.Codeunit.al): its file holds a #if object wrapper of a shape the al-runner coverage index has no rule for (two-arm, #elif, nested, or a multi-object file holding a wrapper; R602). Its mutants read no-coverage.",
    );
  });
});
