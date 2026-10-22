// R586 T19 (the itest half): leg T's `held` rule (r4 I-3) and the update-gate outcome (r3 F6).
import { describe, expect, test } from "bun:test";
import {
  CDO_ALPACKAGES,
  CDO_COMMIT,
  CDO_FINGERPRINT,
  CDO_SLICE_SHA256,
  V3LegEnvironment,
  V3LegFailure,
  V3LegHeld,
  V3_GATE_LEGS,
  cdoCheckoutRefusal,
  classifyLegC,
  classifyLegT,
  classifyXb,
  dirtyFromStatus,
  failsClosedRefusal,
  gateOutcome,
  knownDifferenceKeys,
  knownDifferencesRefusal,
  legOutcomeOfError,
} from "../itest/al-runner-v3-gate";
import { TABLES_KNOWN_DIFFERENCES } from "../itest/al-runner-v3-tables-known";
import type { NormalizedMutant } from "../itest/mutant-equality";
import { AlRunnerV3CoverageJoinError } from "../src/al-runner-v3-sleep";

describe("the D legs' CDO checkout guard (lane ruling 2026-10-21)", () => {
  const ok = {
    head: `${CDO_COMMIT}0123456789abcdef0123456789abcdef`,
    porcelain: "",
    fingerprint: `${CDO_FINGERPRINT}acb96562a01478cced5cf3295919f0a60c1d6dd18a702004`,
    sliceSha256: CDO_SLICE_SHA256,
    alpackages: CDO_ALPACKAGES.map(([name, sha256]) => ({ name, sha256 })),
  };
  test("M14: another slice file (by hash) is refused by name", () => {
    expect(cdoCheckoutRefusal({ ...ok, sliceSha256: "0".repeat(64) })).toMatch(
      /al-runner-v3-cdo-checkout-refused: the slice's mutated file/,
    );
  });
  test("M14: a Test/.alpackages file changed, missing, added, or the folder empty, is refused", () => {
    const [first, ...rest] = ok.alpackages;
    expect(first).toBeDefined();
    const changed = [{ name: first?.name ?? "", sha256: "1".repeat(64) }, ...rest];
    expect(cdoCheckoutRefusal({ ...ok, alpackages: changed })).toMatch(/Test\/\.alpackages/);
    expect(cdoCheckoutRefusal({ ...ok, alpackages: rest })).toMatch(/Test\/\.alpackages/);
    expect(
      cdoCheckoutRefusal({
        ...ok,
        alpackages: [...ok.alpackages, { name: "X.app", sha256: "2".repeat(64) }],
      }),
    ).toMatch(/Test\/\.alpackages/);
    expect(cdoCheckoutRefusal({ ...ok, alpackages: [] })).toMatch(/Test\/\.alpackages/);
  });
  test("M14: the pinned dependency list is the measured 17 apps", () => {
    expect(CDO_ALPACKAGES.length).toBe(17);
  });
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
  test("RC-2: C held plus T held is held", () => {
    expect(gateOutcome({ ...all("pass"), C: "held", T: "held" })).toBe("held");
  });
});

describe("RC-2 (I-2): leg C, a fixed defect is held, never a blacklisting", () => {
  const DEFECTS = ["dup", "sleep"];
  const f = (fact: string, verdict: string) => ({
    fact,
    kind: DEFECTS.includes(fact) ? ("defect" as const) : ("contract" as const),
    verdict,
  });
  const asMeasured = [
    f("version", "matches"),
    f("dup", "defect-present"),
    f("sleep", "defect-present"),
  ];
  test("everything as pre-committed is a pass", () => {
    expect(classifyLegC(asMeasured, DEFECTS, 3).outcome).toBe("pass");
  });
  test("R612 (r3 §2): a warn fact diverged or unmeasurable is a pass plus the moved line; never gate-fail or held", () => {
    for (const verdict of ["diverged", "unmeasurable"]) {
      const r = classifyLegC(
        [...asMeasured, { fact: "w", verdict, measured: "commit: MOVED x" }],
        DEFECTS,
        4,
        ["w"],
      );
      expect(r.outcome).toBe("pass");
      expect(r.lines).toEqual([
        `al-runner-v3-serve-keep-reason-moved: w: ${verdict} (measured commit: MOVED x)`,
      ]);
    }
    expect(
      classifyLegC([...asMeasured, { fact: "w", verdict: "matches" }], DEFECTS, 4, ["w"]),
    ).toEqual({ outcome: "pass", lines: [] });
  });
  test("one defect fact moving defect-present -> gone is held", () => {
    const r = classifyLegC(
      [asMeasured[0], f("dup", "gone"), asMeasured[2]].flatMap((x) => (x === undefined ? [] : [x])),
      DEFECTS,
      3,
    );
    expect(r.outcome).toBe("held");
    expect(r.lines.join("\n")).toMatch(/held: dup: defect-present -> gone/);
  });
  test("a contract fact diverged is gate-fail, even beside a gone defect", () => {
    expect(
      classifyLegC(
        [f("version", "diverged"), f("dup", "gone"), f("sleep", "defect-present")],
        DEFECTS,
        3,
      ).outcome,
    ).toBe("gate-fail");
  });
  test("a defect fact diverged is gate-fail", () => {
    expect(
      classifyLegC(
        [f("version", "matches"), f("dup", "diverged"), f("sleep", "defect-present")],
        DEFECTS,
        3,
      ).outcome,
    ).toBe("gate-fail");
  });
  test("an unmeasurable fact is infra-fail; another fact count is gate-fail", () => {
    expect(
      classifyLegC(
        [f("version", "unmeasurable"), f("dup", "defect-present"), f("sleep", "defect-present")],
        DEFECTS,
        3,
      ).outcome,
    ).toBe("infra-fail");
    expect(classifyLegC(asMeasured.slice(0, 2), DEFECTS, 3).outcome).toBe("gate-fail");
  });
  test("R633 I1: every non-passing line carries what v3 returned (measured), so the receipt shows it", () => {
    const m = (fact: string, verdict: string, measured: string) => ({
      ...f(fact, verdict),
      measured,
    });
    const r = classifyLegC(
      [
        m("version", "diverged", "exit 7 HttpGet failed"),
        m("dup", "gone", "row pass"),
        m("sleep", "unmeasurable", "no document"),
      ],
      DEFECTS,
      3,
    );
    const text = r.lines.join("\n");
    expect(text).toMatch(/gate-fail: version: diverged.*measured exit 7 HttpGet failed/);
    expect(text).toMatch(/held: dup: .*measured row pass/);
    expect(text).toMatch(/infra-fail: sleep: unmeasurable.*measured no document/);
  });
});

describe("RC-2 (I-2): X (b) moving with #5602's fix is held", () => {
  const xb = (o: Partial<Parameters<typeof classifyXb>[0]>) =>
    classifyXb({ exitCode: 7, passed: 1, notRun: 1, parsed: true, compileError: false, ...o });
  test("as measured (exit 7, 1 pass, 1 not run) is a pass", () => {
    expect(xb({})).toBe("pass");
  });
  test("F3: v3 refusing the broken target with its parsed compile diagnostic (AL0118) is held", () => {
    expect(xb({ exitCode: 1, passed: 0, notRun: 0, compileError: true })).toBe("held");
  });
  test("F3: a crash is never held: a panic, a signal, unparseable output, or no compile diagnostic", () => {
    expect(xb({ exitCode: 101, passed: 0, notRun: 0, compileError: false })).toBe("gate-fail");
    expect(xb({ exitCode: -1, passed: 0, notRun: 0, compileError: true })).toBe("gate-fail");
    expect(xb({ exitCode: 1, passed: 0, notRun: 0, parsed: false, compileError: true })).toBe(
      "gate-fail",
    );
    expect(xb({ exitCode: 1, passed: 0, notRun: 0, compileError: false })).toBe("gate-fail");
  });
  test("anything else is gate-fail (a pass that should not be, or exit 0)", () => {
    expect(xb({ exitCode: 0, passed: 2, notRun: 0 })).toBe("gate-fail");
    expect(xb({ exitCode: 7, passed: 2, notRun: 0 })).toBe("gate-fail");
    expect(xb({ exitCode: 0, passed: 0, notRun: 0, compileError: true })).toBe("gate-fail");
  });
});

describe("RC-4 (M5): leg T's known set is pinned by key and transition", () => {
  const pinned = [["K1", "killed", "survived", "DoubleInsert", null]] as const;
  test("the measured set equal to the pinned one: no refusal", () => {
    expect(knownDifferencesRefusal(bc, own, pinned)).toBeUndefined();
  });
  test("the same COUNT with another key is refused", () => {
    const bc2 = [
      row("K1", "killed", "DoubleInsert"),
      row("K2", "killed", "T2"),
      row("K3", "killed", "T3"),
    ];
    const own2 = [
      row("K1", "killed", "DoubleInsert"),
      row("K2", "killed", "T2"),
      row("K3", "survived"),
    ];
    expect(knownDifferencesRefusal(bc2, own2, pinned)).toMatch(/K3/);
  });
  test("the same key with another transition is refused", () => {
    const own3 = [row("K1", "no-coverage"), row("K2", "killed", "T2"), row("K3", "survived")];
    expect(knownDifferencesRefusal(bc, own3, pinned)).toMatch(/K1/);
  });
  test("the committed table holds exactly 52 distinct keys", () => {
    expect(new Set(TABLES_KNOWN_DIFFERENCES.map((d) => d[0])).size).toBe(52);
  });
});

describe("RC-5 (M6): X (e)/(f) fail closed only on the five mutants", () => {
  const five = ["M0001", "M0002", "M0003", "M0004", "M0005"].map((mutantCode) => ({
    mutantCode,
    verdict: mutantCode === "M0001" || mutantCode === "M0005" ? "killed" : "error",
  }));
  test("the five, none survived, M0002 error: closed", () => {
    expect(failsClosedRefusal(five)).toBeUndefined();
  });
  test("ZERO mutants (or a short list) is a failure, not a vacuous pass", () => {
    expect(failsClosedRefusal([])).toMatch(/0 mutants, r5 5/);
    expect(failsClosedRefusal(five.slice(0, 4))).toMatch(/4 mutants/);
  });
  test("G6: a survivor is a failure", () => {
    const survived = five.map((m) =>
      m.mutantCode === "M0003" ? { ...m, verdict: "survived" } : m,
    );
    expect(failsClosedRefusal(survived)).toMatch(/a survivor \(M0003\)/);
  });
  test("G6: the control M0002 not reading error (no survivor anywhere) is a failure", () => {
    const control = five.map((m) => (m.mutantCode === "M0002" ? { ...m, verdict: "killed" } : m));
    expect(failsClosedRefusal(control)).toMatch(/the control M0002 does not read error/);
  });
});

describe("G5: the gate worktree's dirty rule", () => {
  test("a clean status is clean; an untracked file outside fixtures/ and packages/ (a gate output) is clean", () => {
    expect(dirtyFromStatus("")).toBe(false);
    expect(dirtyFromStatus("?? coverage.cobertura.xml\n?? scratch/out.log\n")).toBe(false);
  });
  test("any tracked change is dirty", () => {
    expect(dirtyFromStatus(" M bun.lock\n")).toBe(true);
    expect(dirtyFromStatus("D  scripts/x.ts\n")).toBe(true);
  });
  test("an UNTRACKED file under fixtures/ or packages/ is dirty (it would compile into a leg)", () => {
    expect(dirtyFromStatus("?? fixtures/sandbox-app/src/Extra.Codeunit.al\n")).toBe(true);
    expect(dirtyFromStatus("?? packages/runner/src/extra.ts\n")).toBe(true);
  });
});

describe("M2: environment refusals are infra-fail, verdict failures gate-fail", () => {
  test("each class maps by type, never by message text", () => {
    expect(legOutcomeOfError(new V3LegEnvironment("x differs"))).toBe("infra-fail");
    expect(legOutcomeOfError(new V3LegFailure("x"))).toBe("gate-fail");
    expect(legOutcomeOfError(new V3LegHeld(["a"]))).toBe("held");
    expect(legOutcomeOfError(new Error("a difference that differs, BLOCK"))).toBe("infra-fail");
  });
  test("F4: inside the gate a coverage join refusal is gate-fail (v3's path form moved)", () => {
    expect(legOutcomeOfError(new AlRunnerV3CoverageJoinError("x"))).toBe("gate-fail");
  });
  test("the three classes extend Error directly", () => {
    for (const C of [V3LegEnvironment, V3LegFailure, V3LegHeld])
      expect(Object.getPrototypeOf(C.prototype)).toBe(Error.prototype);
  });
});
