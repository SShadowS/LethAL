import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RC_SEVENSB_AFTER_TEST,
  RC_SEVENSB_LOST_TEST,
  RC_SEVENS_AFTER_TEST,
  RC_SEVENS_KILLER,
  type RcRow,
  V3_RC_LEG,
  judgeRecheckLeg,
} from "../itest/alrunner-v3-legs";
import { PENDING_FIRST_RECORD } from "../itest/baseline-guard";
import { GATE_WARNINGS } from "../itest/gate-expected";

/**
 * PR-144, leg RC (pre-commitment: docs/superpowers/specs/2026-11-18-pr144-withheld-kill-recheck.md §0f,
 * amendment 6, with §0b and §0c). Offline: the table judge, the fixture's shape, and the leg's wiring. The live
 * run is the gate's.
 */

const REPO = join(import.meta.dir, "..", "..", "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

const SITE = { operatorName: "lethal.remove-assignment", originalText: "C := '7'" };
const sevens = (code = "M1"): RcRow => ({
  mutantCode: code,
  procedureName: "Sevens",
  ...SITE,
  verdict: "killed",
  killingTest: RC_SEVENS_KILLER,
  killReproduced: true,
  isolatedRecheck: { afterTest: RC_SEVENS_AFTER_TEST },
});
const sevensB = (
  code = "M2",
  note = `[recheck kept error: rule (e): the recheck baseline lost Recheck B Tests.${RC_SEVENSB_LOST_TEST}]`,
): RcRow => ({
  mutantCode: code,
  procedureName: "SevensB",
  ...SITE,
  verdict: "error",
  failureNote: `NotRun: out-of-scope: ... this failure is not trusted: x ${note}`,
  withheldKill: { failure: "x", afterTest: RC_SEVENSB_AFTER_TEST },
});
const CAVEATS = ["isolated-recheck-kills", "withheld-kills"];
const GOOD = [sevens(), sevensB()];

describe("judgeRecheckLeg: the pre-committed table", () => {
  test("the pre-committed shape passes", () => {
    expect(judgeRecheckLeg(GOOD, CAVEATS)).toEqual([]);
  });

  test("fails by name on 0 withheld kills in the main pass", () => {
    const f = judgeRecheckLeg(
      [{ ...sevens(), verdict: "survived", isolatedRecheck: undefined }],
      [],
    );
    expect(f[0]).toContain("0 withheld kills");
  });

  test("fails by name when the Sevens mutant is not recovered", () => {
    const stuck: RcRow = { ...sevensB("M1"), procedureName: "Sevens" };
    const f = judgeRecheckLeg([stuck, sevensB()], CAVEATS);
    expect(f.some((x) => x.includes("Sevens remove-assignment mutant was not recovered"))).toBe(
      true,
    );
    // The site is missing altogether.
    expect(
      judgeRecheckLeg([sevensB()], ["withheld-kills"]).some((x) => x.includes("no such mutant")),
    ).toBe(true);
  });

  test("fails by name when the SevensB mutant is recovered", () => {
    const recovered: RcRow = { ...sevens("M9"), procedureName: "SevensB" };
    const f = judgeRecheckLeg([sevens(), recovered], CAVEATS);
    expect(
      f.some(
        (x) => x.includes("SevensB remove-assignment mutant was recovered") && x.includes("M9"),
      ),
    ).toBe(true);
  });

  test("a Sevens kill by another test, or not reproduced, or without isolatedRecheck, fails", () => {
    for (const bad of [
      { killingTest: "A0_ParsesSevens" },
      { killReproduced: false },
      { isolatedRecheck: undefined },
    ])
      expect(judgeRecheckLeg([{ ...sevens(), ...bad }, sevensB()], CAVEATS)).not.toEqual([]);
  });

  test("a Sevens kill withheld after another test fails", () => {
    const f = judgeRecheckLeg(
      [{ ...sevens(), isolatedRecheck: { afterTest: "A1_OneSeven" } }, sevensB()],
      CAVEATS,
    );
    expect(f.some((x) => x.includes("pre-committed A0_ParsesSevens"))).toBe(true);
  });

  test("a SevensB note that does not name rule (e) and B2_SeesTheMark, or a wrong afterTest, fails", () => {
    expect(
      judgeRecheckLeg([sevens(), sevensB("M2", "[recheck kept error: rule (c): x]")], CAVEATS),
    ).not.toEqual([]);
    expect(
      judgeRecheckLeg(
        [sevens(), sevensB("M2", "[recheck kept error: rule (e): lost T9]")],
        CAVEATS,
      ),
    ).not.toEqual([]);
    expect(
      judgeRecheckLeg(
        [
          sevens(),
          { ...sevensB(), withheldKill: { failure: "x", afterTest: "B1_OneSevenAndMarks" } },
        ],
        CAVEATS,
      ),
    ).not.toEqual([]);
  });

  test("a SevensB mutant that is not a withheld kill fails", () => {
    const plain: RcRow = { ...sevensB(), withheldKill: undefined };
    expect(judgeRecheckLeg([sevens(), plain], CAVEATS)).toContain(
      "RC: the SevensB remove-assignment mutant is not a withheld kill",
    );
  });

  test("a missing caveat fails", () => {
    expect(judgeRecheckLeg(GOOD, ["withheld-kills"])).not.toEqual([]);
    expect(judgeRecheckLeg(GOOD, ["isolated-recheck-kills"])).not.toEqual([]);
  });

  test("other mutants are outside the judge", () => {
    const other: RcRow = {
      mutantCode: "M7",
      procedureName: "Sevens",
      operatorName: "lethal.remove-assignment",
      originalText: "T += Format(C)",
      verdict: "error",
      withheldKill: { failure: "x" },
    };
    const loop: RcRow = { mutantCode: "M8", procedureName: "SevensB", verdict: "survived" };
    expect(judgeRecheckLeg([...GOOD, other, loop], CAVEATS)).toEqual([]);
  });
});

describe("the fixture is the one pre-committed", () => {
  const logic = read("fixtures/sandbox-recheck/src/RecheckLogic.Codeunit.al");
  const tests = read("fixtures/sandbox-recheck-tests/src/RecheckTests.Codeunit.al");
  const loop = /for I := 1 to N do begin\s+C := '7';\s+T \+= Format\(C\);\s+end;/g;
  test("the app: Sevens and SevensB, each a loop of C := '7'; T += Format(C)", () => {
    expect(logic).toContain('codeunit 76000 "Recheck Logic"');
    expect(logic).toMatch(/procedure Sevens\(N: Integer\) T: Text/);
    expect(logic).toMatch(/procedure SevensB\(N: Integer\) T: Text/);
    expect(logic.match(loop)?.length).toBe(2);
    expect(logic).toContain("C: Char;");
    expect(read("fixtures/sandbox-recheck/src/RecheckRow.Table.al")).toContain(
      'table 76001 "Recheck Row"',
    );
  });
  test("the tests, in declared order", () => {
    const at = (s: string) => tests.indexOf(`procedure ${s}()`);
    const order = [
      "A0_ParsesSevens",
      "A1_OneSeven",
      "B0_ParsesSevens",
      "B1_OneSevenAndMarks",
      "B2_SeesTheMark",
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(tests).toContain('codeunit 76050 "Recheck A Tests"');
    expect(tests).toContain('codeunit 76051 "Recheck B Tests"');
    expect(tests).toContain("T := Logic.Sevens(10);");
    expect(tests).toContain("T := Logic.SevensB(10);");
    expect(tests.match(/Page\.RunModal\(0, R\);/g)?.length).toBe(2);
    expect(tests).toContain("Logic.Sevens(1) <> '7'");
    expect(tests).toContain("Logic.SevensB(1) <> '7'");
    // The Evaluate check comes before the RunModal, and B1 sets the GLOBAL Boolean before asserting.
    expect(tests.indexOf("if not Evaluate(D, T)")).toBeLessThan(
      tests.indexOf("Page.RunModal(0, R)"),
    );
    expect(tests).toMatch(/var\s+Logic: Codeunit "Recheck Logic";\s+Marked: Boolean;/);
    expect(tests.indexOf("Marked := true;")).toBeLessThan(tests.indexOf("Logic.SevensB(1)"));
    expect(tests).toContain("if not Marked then");
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
  test("RC's warning set is [] (amendment 3)", () => {
    expect(GATE_WARNINGS["al-runner-v3/RC"]).toEqual([]);
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
    expect(page).toContain("A1_OneSeven");
    expect(page).toContain("B2_SeesTheMark");
  });
});
