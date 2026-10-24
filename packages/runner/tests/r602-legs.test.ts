// R602: the pure halves of legs MO and WR of `itest:alrunner-v3`: the durable killer constants (built
// from the measured `--mode none` runs, never written by record mode) and the judges that read them.
import { describe, expect, test } from "bun:test";
import {
  V3LegEnvironment,
  V3_GATE_LEGS,
  gateOutcome,
  legOutcomeOfError,
} from "../itest/al-runner-v3-gate";
import { AlRunnerCoverageFrameError } from "../src/al-runner-coverage";

describe("R602 ruling: MO and WR are update-gate legs, and a frame error there is a gate-fail", () => {
  test("(a) the update gate's judged set includes MO and WR, and a failing MO or WR fails the gate", () => {
    expect(V3_GATE_LEGS as readonly string[]).toContain("MO");
    expect(V3_GATE_LEGS as readonly string[]).toContain("WR");
    const pass = Object.fromEntries(V3_GATE_LEGS.map((l) => [l, "pass"]));
    expect(gateOutcome(pass as never)).toBe("pass");
    for (const leg of ["MO", "WR"]) {
      expect(gateOutcome({ ...pass, [leg]: "gate-fail" } as never)).toBe("gate-fail");
    }
  });

  test("(b) a frame error inside MO or WR is gate-fail", () => {
    const err = new AlRunnerCoverageFrameError("x");
    expect(legOutcomeOfError(err, "MO")).toBe("gate-fail");
    expect(legOutcomeOfError(err, "WR")).toBe("gate-fail");
  });

  test("(c) a frame error in any other leg, or with no leg, is unchanged (infra-fail)", () => {
    const err = new AlRunnerCoverageFrameError("x");
    for (const leg of ["S1", "L1", "Y-A", "K", "T"]) {
      expect(legOutcomeOfError(err, leg)).toBe("infra-fail");
    }
    expect(legOutcomeOfError(err)).toBe("infra-fail");
    expect(legOutcomeOfError(new V3LegEnvironment("e"), "MO")).toBe("infra-fail");
  });
});
import {
  type V3RowFacts,
  V3_MO_KILLERS,
  V3_WR_KILLERS,
  V3_WR_STATE_NOTES,
  judgeKillers,
  judgeStateNotes,
  judgeWrArms,
  moWrTransportRefusal,
} from "../itest/alrunner-v3-legs";
import { ARMS_REFUSAL } from "../itest/wrapped-fixture";

describe("R602 build review B1: WR pins its six state notes exactly", () => {
  test("the constant is the measured set (pin and edge): six, all BandYRun/BandYRunTwin kills", () => {
    expect(V3_WR_STATE_NOTES).toEqual([
      "0/M0071",
      "0/M0072",
      "0/M0078",
      "0/M0085",
      "0/M0086",
      "0/M0092",
    ]);
  });
  test("the measured notes pass; none, an extra and a missing note are each named", () => {
    expect(judgeStateNotes([...V3_WR_STATE_NOTES].reverse(), V3_WR_STATE_NOTES)).toEqual([]);
    expect(judgeStateNotes([], V3_WR_STATE_NOTES)).toHaveLength(1);
    expect(judgeStateNotes([...V3_WR_STATE_NOTES, "0/M0001"], V3_WR_STATE_NOTES)).toHaveLength(1);
    expect(judgeStateNotes(V3_WR_STATE_NOTES.slice(1), V3_WR_STATE_NOTES)).toHaveLength(1);
    // MO pre-commits none.
    expect(judgeStateNotes(["0/M0001"], [])).toHaveLength(1);
    expect(judgeStateNotes([], [])).toEqual([]);
  });
});

describe("R602 build review minor 8: MO and WR refuse a transport other than one-shot, by name", () => {
  test("serve-entries is refused; one-shot and unset are not", () => {
    expect(moWrTransportRefusal("MO", "serve-entries")).toContain(
      "al-runner-v3-itest-leg-transport-refused",
    );
    expect(moWrTransportRefusal("WR", "one-shot")).toBeUndefined();
    expect(moWrTransportRefusal("WR", undefined)).toBeUndefined();
  });
});

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
