// R586 T19 (the itest half): leg T's `held` rule (r4 I-3) and the update-gate outcome (r3 F6).
import { describe, expect, test } from "bun:test";
import {
  CDO_COMMIT,
  CDO_FINGERPRINT,
  V3_GATE_LEGS,
  cdoCheckoutRefusal,
  classifyLegT,
  gateOutcome,
  knownDifferenceKeys,
} from "../itest/al-runner-v3-gate";
import type { NormalizedMutant } from "../itest/mutant-equality";

describe("the D legs' CDO checkout guard (lane ruling 2026-10-21)", () => {
  const ok = {
    head: `${CDO_COMMIT}0123456789abcdef0123456789abcdef`,
    porcelain: "",
    fingerprint: `${CDO_FINGERPRINT}acb96562a01478cced5cf3295919f0a60c1d6dd18a702004`,
  };
  test("the measurement checkout (5f2a71d, clean, aa47c61c1fcbb7e3) is accepted", () => {
    expect(cdoCheckoutRefusal(ok)).toBeUndefined();
  });
  test("another commit is refused by name", () => {
    expect(cdoCheckoutRefusal({ ...ok, head: "c895a7d0000" })).toMatch(
      /al-runner-v3-cdo-checkout-refused: HEAD c895a7d0000, pre-committed 5f2a71d/,
    );
  });
  test("a dirty checkout is refused by name", () => {
    expect(cdoCheckoutRefusal({ ...ok, porcelain: " M Cloud/app.json\n" })).toMatch(
      /al-runner-v3-cdo-checkout-refused: not clean/,
    );
  });
  test("another corpus fingerprint is refused by name", () => {
    expect(cdoCheckoutRefusal({ ...ok, fingerprint: "0000000000000000ffff" })).toMatch(
      /al-runner-v3-cdo-checkout-refused: corpus fingerprint 0000000000000000, pre-committed aa47c61c1fcbb7e3/,
    );
  });
});

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
