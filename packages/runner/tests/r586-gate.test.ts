// R586 T19 (the itest half): leg T's `held` rule (r4 I-3) and the update-gate outcome (r3 F6).
import { describe, expect, test } from "bun:test";
import {
  V3_GATE_LEGS,
  classifyLegT,
  gateOutcome,
  knownDifferenceKeys,
} from "../itest/al-runner-v3-gate";
import type { NormalizedMutant } from "../itest/mutant-equality";

const row = (
  key: string,
  verdict: string,
  killingTest: string | null = null,
): NormalizedMutant => ({
  key,
  verdict,
  killingTest,
  coverageFiltered: verdict === "no-coverage",
  errorClass: null,
});

// BC: K1 killed by DoubleInsert; v3 (own): K1 survived (#5603, a known row). K2 equal everywhere.
const bc = [row("K1", "killed", "DoubleInsert"), row("K2", "killed", "T2"), row("K3", "survived")];
const own = [row("K1", "survived"), row("K2", "killed", "T2"), row("K3", "survived")];

describe("leg T: held only for a known row moving to its BC verdict", () => {
  test("the known differences are the BC-vs-own rows", () => {
    expect([...knownDifferenceKeys(bc, own)]).toEqual(["K1"]);
  });
  test("no difference is a pass", () => {
    expect(classifyLegT(own, own, bc).outcome).toBe("pass");
  });
  test("a #5603 fix turning the known survivor into BC's kill is held, never gate-fail", () => {
    const now = [
      row("K1", "killed", "DoubleInsert"),
      row("K2", "killed", "T2"),
      row("K3", "survived"),
    ];
    expect(classifyLegT(own, now, bc).outcome).toBe("held");
  });
  test("a known row moving to a NON-BC verdict, or another killing test, is gate-fail", () => {
    expect(
      classifyLegT(
        own,
        [row("K1", "no-coverage"), own[1] as NormalizedMutant, own[2] as NormalizedMutant],
        bc,
      ).outcome,
    ).toBe("gate-fail");
    expect(
      classifyLegT(
        own,
        [row("K1", "killed", "Other"), own[1] as NormalizedMutant, own[2] as NormalizedMutant],
        bc,
      ).outcome,
    ).toBe("gate-fail");
  });
  test("an UNLISTED row's difference is gate-fail, even beside a held one", () => {
    const now = [row("K1", "killed", "DoubleInsert"), row("K2", "survived"), row("K3", "survived")];
    expect(classifyLegT(own, now, bc).outcome).toBe("gate-fail");
  });
  test("a missing or an extra row is gate-fail", () => {
    expect(classifyLegT(own, own.slice(0, 2), bc).outcome).toBe("gate-fail");
    expect(classifyLegT(own, [...own, row("K9", "killed", "X")], bc).outcome).toBe("gate-fail");
  });
});

describe("the update-gate outcome", () => {
  const all = (v: "pass" | "held" | "gate-fail" | "infra-fail") =>
    Object.fromEntries(V3_GATE_LEGS.map((l) => [l, v])) as Record<string, typeof v>;
  test("pass needs EVERY leg of the exact set", () => {
    expect(gateOutcome(all("pass"))).toBe("pass");
    const { D1c: _dropped, ...missing } = all("pass");
    expect(gateOutcome(missing)).toBe("infra-fail");
  });
  test("gate-fail wins; held only when nothing failed", () => {
    expect(gateOutcome({ ...all("pass"), T: "held" })).toBe("held");
    expect(gateOutcome({ ...all("pass"), T: "held", S1: "gate-fail" })).toBe("gate-fail");
    expect(gateOutcome({ ...all("pass"), C: "infra-fail" })).toBe("infra-fail");
  });
});
