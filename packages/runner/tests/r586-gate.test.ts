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
  formatLegTRow,
  gateOutcome,
  judgeLegT,
  knownDifferenceKeys,
  knownDifferencesRefusal,
  legOutcomeOfError,
  xbHeldFirst,
  xdBaselineLine,
  xdFailure,
} from "../itest/al-runner-v3-gate";
import { TABLES_KNOWN_DIFFERENCES } from "../itest/al-runner-v3-tables-known";
import { type NormalizedMutant, compareMutants } from "../itest/mutant-equality";
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

describe("R639 r9 §7: leg T's narrow held for a named refusal", () => {
  const err = (key: string, errorClass: string, killingTest: string | null = null) => ({
    ...row(key, "error", killingTest),
    errorClass,
  });
  const k2 = own[1] as NormalizedMutant;
  const k3 = own[2] as NormalizedMutant;
  test("T1: a known row going survived -> error/runner-refused is held, as a structured row and its one line", () => {
    const t = classifyLegT(own, [err("K1", "runner-refused"), k2, k3], bc);
    expect(t.outcome).toBe("held");
    expect(t.rows).toEqual([
      {
        key: "K1",
        kind: "held-refusal",
        known: true,
        own: own[0],
        now: err("K1", "runner-refused"),
      },
    ]);
    expect(t.rows.map((r) => formatLegTRow(r, "M0157"))).toEqual([
      "T: held: M0157 K1: survived/-/- -> error/runner-refused/- (a named refusal: v3 notRun or LethAL §6; not BC's verdict; re-pre-commit)",
    ]);
  });
  test("T2: an UNKNOWN row going to error/runner-refused is gate-fail", () => {
    expect(
      classifyLegT(own, [own[0] as NormalizedMutant, err("K2", "runner-refused"), k3], bc).outcome,
    ).toBe("gate-fail");
  });
  test("T3: a known row going to an error of another class, or a refusal with a killing test, is gate-fail", () => {
    expect(classifyLegT(own, [err("K1", "other"), k2, k3], bc).outcome).toBe("gate-fail");
    expect(classifyLegT(own, [err("K1", "runner-refused", "T"), k2, k3], bc).outcome).toBe(
      "gate-fail",
    );
  });
  test("T4 (I2): a known row whose ONLY difference from BC is its killing test, moving to error/runner-refused, is gate-fail", () => {
    const bc4 = [row("K4", "killed", "A")];
    const own4 = [row("K4", "killed", "B")];
    expect(classifyLegT(own4, [err("K4", "runner-refused")], bc4).outcome).toBe("gate-fail");
  });
  test("T5: a known row moving to error/runner-test-error (K1(a)'s class) is gate-fail", () => {
    expect(classifyLegT(own, [err("K1", "runner-test-error"), k2, k3], bc).outcome).toBe(
      "gate-fail",
    );
  });
});

describe("R647 r10 (a): judgeLegT classifies, compares and prints first, then judges in order", () => {
  const err = (key: string, errorClass: string, killingTest: string | null = null) => ({
    ...row(key, "error", killingTest),
    errorClass,
  });
  const k2 = own[1] as NormalizedMutant;
  const k3 = own[2] as NormalizedMutant;
  const heldNow = [err("K1", "runner-refused"), k2, k3];
  const codes = new Map([
    ["K1", "M0157"],
    ["K2", "M0002"],
    ["K3", "M0003"],
  ]);
  const judge = (
    now: readonly NormalizedMutant[],
    o: Partial<Parameters<typeof judgeLegT>[0]> = {},
    before: readonly NormalizedMutant[] = own,
  ) =>
    judgeLegT({
      classification: classifyLegT(before, now, bc),
      compare: compareMutants(before, now, { sameScheme: true }),
      counts: { killed: 290, survived: 57, noCoverage: 59 },
      total: 406,
      unsupportedTests: 3,
      sleepIndex: { target: 0, test: 0 },
      knownRefusal: undefined,
      codes,
      ...o,
    });
  const heldLine =
    "T: held: M0157 K1: survived/-/- -> error/runner-refused/- (a named refusal: v3 notRun or LethAL §6; not BC's verdict; re-pre-commit)";
  test("T-a1: held rows, the compare on that key only, counts 290 / 56 / 59: held (no count check)", () => {
    const j = judge(heldNow, { counts: { killed: 290, survived: 56, noCoverage: 59 } });
    expect(j.outcome).toBe("held");
    expect(j.lines).toEqual([heldLine]);
  });
  test("T-a2: pass rows, empty compare, counts 290 / 56 / 59: gate-fail", () => {
    const j = judge(own, { counts: { killed: 290, survived: 56, noCoverage: 59 } });
    expect(j.outcome).toBe("gate-fail");
    expect(j.failure).toMatch(/290 \/ 56 \/ 59.*pre-committed 290 \/ 57 \/ 59 over 406/);
  });
  test("T-a3: pass rows, empty compare, counts 290 / 57 / 59 over 406: pass", () => {
    expect(judge(own).outcome).toBe("pass");
    expect(judge(own, { total: 405 }).outcome).toBe("gate-fail");
  });
  test("T-a5: held rows with Sleep index 1 + 0 are gate-fail; with 0 + 0 held", () => {
    expect(judge(heldNow, { sleepIndex: { target: 1, test: 0 } }).outcome).toBe("gate-fail");
    expect(judge(heldNow, { sleepIndex: undefined }).outcome).toBe("gate-fail");
    expect(judge(heldNow, { sleepIndex: { target: 0, test: 0 } }).outcome).toBe("held");
  });
  test("T-a6: held rows with unsupportedTests 2 are gate-fail; with 3 held", () => {
    expect(judge(heldNow, { unsupportedTests: 2 }).outcome).toBe("gate-fail");
    expect(judge(heldNow, { unsupportedTests: 3 }).outcome).toBe("held");
  });
  test("T-a7: one held row and one gate-fail row: gate-fail", () => {
    const j = judge([err("K1", "runner-refused"), row("K2", "survived"), k3]);
    expect(j.outcome).toBe("gate-fail");
    expect(j.failure).toMatch(/1 gate-fail row/);
  });
  test("I1: a gate-fail classification with an EMPTY compare (a twin group) is gate-fail by the judge's own branch", () => {
    const twins = [row("K", "survived"), row("K", "survived")];
    expect(compareMutants(twins, twins, { sameScheme: true }).differences).toEqual([]);
    const j = judge(twins, {}, twins);
    expect(j.outcome).toBe("gate-fail");
    expect(j.failure).toMatch(/gate-fail row/);
  });
  test("T-a8 (M1): held rows with a knownDifferencesRefusal are gate-fail; with undefined held", () => {
    const j = judge(heldNow, { knownRefusal: "not the pinned 52" });
    expect(j.outcome).toBe("gate-fail");
    expect(j.failure).toMatch(/not the pinned 52/);
    expect(judge(heldNow, { knownRefusal: undefined }).outcome).toBe("held");
  });
  const sha = (m: NormalizedMutant, h: string): NormalizedMutant => ({
    ...m,
    mutatedTextSha256: h,
  });
  const ownSha = [sha(own[0] as NormalizedMutant, "a"), sha(k2, "b"), sha(k3, "c")];
  test("T-a9 (I1): pass rows but one text-only compare difference: gate-fail", () => {
    const now = [sha(own[0] as NormalizedMutant, "a"), sha(k2, "B"), sha(k3, "c")];
    const j = judge(now, {}, ownSha);
    expect(classifyLegT(ownSha, now, bc).outcome).toBe("pass");
    expect(j.outcome).toBe("gate-fail");
  });
  test("T-a10 (I1): held on K1, but the compare differs on K1 and K2: gate-fail", () => {
    const now = [sha(err("K1", "runner-refused"), "a"), sha(k2, "B"), sha(k3, "c")];
    expect(classifyLegT(ownSha, now, bc).outcome).toBe("held");
    const j = judge(now, {}, ownSha);
    expect(j.outcome).toBe("gate-fail");
    expect(j.failure).toMatch(/K2/);
  });
  test("T-a11 (I3): a failing step 2 (unsupportedTests 0) still returns every row line of step 0", () => {
    const j = judge(heldNow, { unsupportedTests: 0 });
    expect(j.outcome).toBe("gate-fail");
    expect(j.lines).toEqual([heldLine]);
  });
});

describe("R647 r10 (b): leg T's row lines, one format", () => {
  const err = (key: string, errorClass: string) => ({ ...row(key, "error"), errorClass });
  const k2 = own[1] as NormalizedMutant;
  const k3 = own[2] as NormalizedMutant;
  const lines = (now: readonly NormalizedMutant[], before: readonly NormalizedMutant[] = own) =>
    judgeLegT({
      classification: classifyLegT(before, now, bc),
      compare: compareMutants(before, now, { sameScheme: true }),
      counts: { killed: 290, survived: 57, noCoverage: 59 },
      total: 406,
      unsupportedTests: 3,
      sleepIndex: { target: 0, test: 0 },
      knownRefusal: undefined,
      codes: new Map([
        ["K1", "M0157"],
        ["K2", "M0002"],
      ]),
    }).lines;
  test("T-b1: held-bc, held-refusal and a known-key gate-fail each give the exact line", () => {
    expect(lines([row("K1", "killed", "DoubleInsert"), k2, k3])).toEqual([
      "T: held: M0157 K1: survived/-/- -> killed/-/DoubleInsert (the BC verdict, a known difference)",
    ]);
    expect(lines([err("K1", "runner-refused"), k2, k3])).toEqual([
      "T: held: M0157 K1: survived/-/- -> error/runner-refused/- (a named refusal: v3 notRun or LethAL §6; not BC's verdict; re-pre-commit)",
    ]);
    expect(lines([err("K1", "other"), k2, k3])).toEqual([
      "T: gate-fail: M0157 K1: survived/-/- -> error/other/- (a known row, but not to its BC verdict)",
    ]);
    expect(lines([own[0] as NormalizedMutant, row("K2", "survived"), k3])).toEqual([
      "T: gate-fail: M0002 K2: killed/-/T2 -> survived/-/-",
    ]);
  });
  test("T-b2: a missing row prints absent (code -), and a text-only compare difference its own line", () => {
    expect(lines(own.slice(0, 2))).toEqual(["T: gate-fail: - K3: survived/-/- -> absent"]);
    const before = own.map((m) => ({ ...m, mutatedTextSha256: m.key }));
    const now = before.map((m) => (m.key === "K2" ? { ...m, mutatedTextSha256: "other" } : m));
    expect(lines(now, before)).toEqual([
      "T: gate-fail: M0002 K2: mutant K2: mutated text differs under an unchanged key",
    ]);
  });
  test("T-b3: pass prints no row line", () => {
    expect(lines(own)).toEqual([]);
  });
  test("T-b4: 60 differing rows are 60 receipt lines, none cut", () => {
    const keys = Array.from({ length: 60 }, (_, i) => `R${i}`);
    const o = keys.map((k) => row(k, "survived"));
    const n = keys.map((k) => row(k, "killed", "SomeTest"));
    const j = judgeLegT({
      classification: classifyLegT(o, n, o),
      compare: compareMutants(o, n, { sameScheme: true }),
      counts: { killed: 290, survived: 57, noCoverage: 59 },
      total: 406,
      unsupportedTests: 3,
      sleepIndex: { target: 0, test: 0 },
      knownRefusal: undefined,
      codes: new Map(),
    });
    expect(j.lines.length).toBe(60);
    for (const [i, l] of j.lines.entries())
      expect(l).toBe(`T: gate-fail: - R${i}: survived/-/- -> killed/-/SomeTest`);
  });
});

describe("R647 r10 (c): X (d)'s baseline reason line and X (b)'s early receipt line", () => {
  const what = "X (d): M0001 lethal.empty-block no-coverage";
  test("X-c1: present and not pass: the not-green text is added", () => {
    expect(
      xdFailure(what, { outcome: "timeout", failureMessage: "Test exceeded 120s timeout." }),
    ).toBe(
      `${what}; X (d): SleeperDoubles is not green at baseline (timeout: Test exceeded 120s timeout.): the Sleep rule was not exercised; gate-fail`,
    );
  });
  test("X-c1: SleeperDoubles pass (baselineGreen false from another test): no text", () => {
    expect(xdFailure(what, { outcome: "pass" })).toBe(what);
  });
  test("X-c1: the verdict absent: no text, and the source line prints absent", () => {
    expect(xdFailure(what, undefined)).toBe(what);
    expect(xdBaselineLine(undefined)).toBe("X (d): SleeperDoubles baseline-batch-finished: absent");
    expect(xdBaselineLine({ outcome: "timeout", failureMessage: "m" })).toBe(
      "X (d): SleeperDoubles baseline-batch-finished: timeout: m",
    );
  });
  test("X-b1 (M5): the X (b) held line is in the receipt even when (d) then gate-fails", async () => {
    const got: string[] = [];
    const run = xbHeldFirst(
      ["X (b): exit 3: v3 now refuses"],
      (l) => got.push(l),
      async () => {
        throw new V3LegFailure("X (d): M0001 no-coverage");
      },
    );
    await expect(run).rejects.toBeInstanceOf(V3LegFailure);
    expect(got).toEqual(["X: X (b): exit 3: v3 now refuses"]);
  });
  test("X-b1: with nothing else failing, a held X (b) still makes the leg held", async () => {
    const got: string[] = [];
    await expect(
      xbHeldFirst(
        ["X (b): held"],
        (l) => got.push(l),
        async () => {},
      ),
    ).rejects.toBeInstanceOf(V3LegHeld);
    await expect(
      xbHeldFirst(
        [],
        (l) => got.push(l),
        async () => {},
      ),
    ).resolves.toBeUndefined();
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
