import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RC_DOUBLE_KILLER,
  RC_TRIPLE_LOST_TEST,
  type RcRow,
  V3_RC_LEG,
  judgeRecheckLeg,
} from "../itest/alrunner-v3-legs";
import { PENDING_FIRST_RECORD } from "../itest/baseline-guard";

/**
 * PR-144, leg RC (pre-commitment: docs/superpowers/specs/2026-11-18-pr144-withheld-kill-recheck.md §0b).
 * Offline: the table judge, the fixture's shape, and the leg's wiring. The live run is the gate's.
 */

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const recovered = (code: string): RcRow => ({
  mutantCode: code,
  procedureName: "Double",
  verdict: "killed",
  killingTest: RC_DOUBLE_KILLER,
  killReproduced: true,
  isolatedRecheck: {
    withheldFailure: "x",
    afterTest: "A0_Refuses",
    killerGreenInMainBaseline: true,
  },
});
const kept = (
  code: string,
  note = `[recheck kept error: rule (e): the recheck baseline lost Recheck B Tests.${RC_TRIPLE_LOST_TEST}]`,
): RcRow => ({
  mutantCode: code,
  procedureName: "Triple",
  verdict: "error",
  failureNote: `NotRun: out-of-scope: ... this failure is not trusted: x ${note}`,
  withheldKill: { failure: "x", afterTest: "B0_Refuses" },
});
const CAVEATS = ["isolated-recheck-kills", "withheld-kills"];
const GOOD = [recovered("M1"), recovered("M2"), kept("M3"), kept("M4")];

describe("judgeRecheckLeg: the pre-committed table", () => {
  test("the pre-committed shape passes", () => {
    expect(judgeRecheckLeg(GOOD, CAVEATS)).toEqual([]);
  });

  test("fails by name on 0 withheld kills in the main pass", () => {
    const f = judgeRecheckLeg(
      [{ mutantCode: "M1", procedureName: "Double", verdict: "survived" }],
      [],
    );
    expect(f[0]).toContain("0 withheld kills");
  });

  test("fails by name when no Double mutant is recovered", () => {
    const f = judgeRecheckLeg([kept("M3")], ["withheld-kills"]);
    expect(f).toContain("RC: no Double mutant was recovered");
  });

  test("fails by name when any Triple mutant is recovered", () => {
    const triple = { ...recovered("M9"), procedureName: "Triple" };
    const f = judgeRecheckLeg([...GOOD, triple], CAVEATS);
    expect(f.some((x) => x.includes("Triple mutant(s) recovered") && x.includes("M9"))).toBe(true);
  });

  test("a Double killed by another test, or not reproduced, fails", () => {
    expect(
      judgeRecheckLeg(
        [{ ...recovered("M1"), killingTest: "B1_TriplesAndBumps" }, kept("M3")],
        CAVEATS,
      ),
    ).not.toEqual([]);
    expect(
      judgeRecheckLeg([{ ...recovered("M1"), killReproduced: false }, kept("M3")], CAVEATS),
    ).not.toEqual([]);
  });

  test("a Double still withheld fails", () => {
    const stuck: RcRow = { ...kept("M5"), procedureName: "Double" };
    expect(
      judgeRecheckLeg([...GOOD, stuck], CAVEATS).some((x) => x.includes("still a withheld kill")),
    ).toBe(true);
  });

  test("a Triple note that does not name rule (e) and B2_SeesTheBump fails", () => {
    expect(
      judgeRecheckLeg([recovered("M1"), kept("M3", "[recheck kept error: rule (c): x]")], CAVEATS),
    ).not.toEqual([]);
    expect(
      judgeRecheckLeg(
        [recovered("M1"), kept("M3", "[recheck kept error: rule (e): lost T9]")],
        CAVEATS,
      ),
    ).not.toEqual([]);
  });

  test("a missing caveat fails", () => {
    expect(judgeRecheckLeg(GOOD, ["withheld-kills"])).not.toEqual([]);
    expect(judgeRecheckLeg(GOOD, ["isolated-recheck-kills"])).not.toEqual([]);
  });

  test("mutants in Bump and Count are outside the prediction", () => {
    const bump: RcRow = {
      mutantCode: "M7",
      procedureName: "Bump",
      verdict: "error",
      withheldKill: { failure: "x" },
    };
    expect(judgeRecheckLeg([...GOOD, bump], CAVEATS)).toEqual([]);
  });
});

describe("the fixture is the one pre-committed", () => {
  const logic = read("fixtures/sandbox-recheck/src/RecheckLogic.Codeunit.al");
  const tests = read("fixtures/sandbox-recheck-tests/src/RecheckTests.Codeunit.al");
  test("the app: Double, Triple, Bump, Count over a SingleInstance counter", () => {
    expect(logic).toContain('codeunit 76000 "Recheck Logic"');
    expect(logic).toContain("exit(X * 2);");
    expect(logic).toContain("exit(X * 3);");
    expect(logic).toMatch(/procedure Bump\(\)/);
    expect(logic).toMatch(/procedure Count\(\): Integer/);
    expect(logic).toMatch(/codeunit 76001 "Recheck State"\s*\{\s*SingleInstance = true;/);
  });
  test("the tests, in declared order", () => {
    const at = (s: string) => tests.indexOf(`procedure ${s}()`);
    const order = [
      "A0_Refuses",
      "A1_Doubles",
      "B0_Refuses",
      "B1_TriplesAndBumps",
      "B2_SeesTheBump",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(tests).toContain('codeunit 76050 "Recheck A Tests"');
    expect(tests).toContain('codeunit 76051 "Recheck B Tests"');
    expect(tests).toContain("Logic.Double(2) <> 4");
    expect(tests).toContain("Logic.Triple(2) <> 6");
    expect(tests).toContain("Logic.Count() <> 1");
    // B1 bumps BEFORE asserting Triple.
    expect(tests.indexOf("Logic.Bump();")).toBeLessThan(tests.indexOf("Logic.Triple(2)"));
  });
  test("runtime 17, own id ranges", () => {
    for (const d of ["sandbox-recheck", "sandbox-recheck-tests"]) {
      expect(JSON.parse(read(`fixtures/${d}/app.json`)).runtime).toBe("17.0");
    }
  });
});

describe("the leg is wired", () => {
  const itest = read("packages/runner/itest/al-runner-v3.itest.ts");
  test("RC is a default leg and has a registered, pending baseline the leg refuses to start without", () => {
    expect(V3_RC_LEG).toBe("RC");
    expect(PENDING_FIRST_RECORD).toContain("al-runner-v3.recheck.baseline.json");
    expect(existsSync(join(REPO, "packages/runner/itest/al-runner-v3.recheck.baseline.json"))).toBe(
      false,
    );
    expect(itest).toContain(
      'preflightGateBaseline(RECHECK_BASELINE_PATH, "al-runner-v3 itest leg RC")',
    );
  });
  test("the table is judged before the own-baseline compare, and the leg runs the isolation test config", () => {
    const leg = itest.slice(
      itest.indexOf("async function legRC"),
      itest.indexOf("const MOE_WRE_PINS"),
    );
    expect(leg).toContain("judgeRecheckLeg(r.mutants, r.validity.caveats)");
    expect(leg).toContain('make("test"');
    expect(leg).toContain('transport: "serve-entries"');
    expect(leg).toContain("recheckWithheldKills: true");
    expect(leg).toContain("workers: 1");
    const branch = itest.slice(itest.indexOf("leg === V3_RC_LEG"));
    expect(branch.indexOf("await legRC(scratch)")).toBeLessThan(
      branch.indexOf("assertGateBaseline("),
    );
  });
  test("the leg is a gate page section with the pre-committed figures", () => {
    const page = read("docs/gates/alrunner-v3.md");
    expect(page).toContain("### Leg RC: the withheld-kill recheck (PR-144)");
    expect(page).toContain("A1_Doubles");
    expect(page).toContain("B2_SeesTheBump");
  });
});
