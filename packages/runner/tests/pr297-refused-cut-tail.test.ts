// PR-297 (docs/superpowers/specs/2026-11-21-pr297-refused-cut-tail.md, section 5): `alRunnerV3.refusedCutTail`.
// A green test after a baseline-refusal cut is run ALONE under the mutant (R895's alone path) instead of scored
// `error`, if it passed alone once at the end of the baseline phase. The lane rig (a scripted serve daemon that
// leaves out an entry's `excludeTests`, as v3 does); call counters on the requests only, never time.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import type { TestVerdict } from "../src/backend";
import { lendingRunnerBuild } from "../src/orchestrator";
import { sessionFingerprint } from "../src/resume";
import {
  CU,
  type FakeRow,
  type LanesRig,
  OPTS,
  type Req,
  TIMEOUT_1S,
  cleanRigs,
  lanesRig,
  ref,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const UNLISTED = "NotRun: out-of-scope: the install baseline read resource active-mutant.txt";
const [A, B, R, C] = ["A", "B", "R", "C"].map(ref) as [
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
];
const NOTE = `refused-cut tail: Tests${CU}.C measured alone, after a baseline refusal cut (PR-297)`;

/** What C answers in the stability run (NONE, alone, at the end of the baseline phase). */
type Stab = "pass" | "fail" | "refused" | "timeout" | "missing" | "eof";
type State = { phase: "baseline" | "stability" | "mutants"; cBaseline: "pass" | "fail" };

/**
 * [A, B, R (refused at the baseline), C]. M0001 fails C only; M0003 fails A and C; M0002 fails nothing.
 * In the stability run C answers `stab`.
 */
async function tailRig(
  o: { flag: boolean; stab?: Stab; cBaseline?: "pass" | "fail"; methods?: string[] } = {
    flag: true,
  },
): Promise<{ r: LanesRig; state: State }> {
  const state: State = { phase: "baseline", cBaseline: o.cBaseline ?? "pass" };
  const stab = o.stab ?? "pass";
  // The stability run: NONE, in its phase, carrying C alone. Every other NONE answer (the baseline, the warm-up
  // that must equal it, a NONE confirm) is C's baseline row.
  const isStabilityRun = (m: string, req: Req | undefined) =>
    m === "NONE" &&
    state.phase === "stability" &&
    req?.tests.length === 1 &&
    req.tests[0] === `Codeunit${CU}.C`;
  const cRow = (m: string, req: Req | undefined): FakeRow | undefined => {
    if (isStabilityRun(m, req)) {
      if (stab === "missing") return undefined;
      if (stab === "fail") return { method: "C", status: "fail", message: "alone fail" };
      if (stab === "refused")
        return { method: "C", status: "error", notRun: true, message: UNLISTED };
      if (stab === "timeout") return { method: "C", status: "error", message: TIMEOUT_1S };
      return { method: "C", status: "pass" };
    }
    if (m === "NONE" || m === "STATIC")
      return state.cBaseline === "pass"
        ? { method: "C", status: "pass" }
        : { method: "C", status: "fail", message: "baseline fail" };
    if (m === "M0004") return { method: "C", status: "error", message: TIMEOUT_1S };
    return m === "M0001" || m === "M0003"
      ? { method: "C", status: "fail", message: "killed by C" }
      : { method: "C", status: "pass" };
  };
  const held: { rig?: LanesRig } = {};
  const r = await lanesRig({
    lanes: 0,
    methods: o.methods ?? ["A", "B", "R", "C"],
    refusedCutTail: o.flag,
    serve: {
      honorExcludes: true,
      eofAt: (_n, req) => stab === "eof" && isStabilityRun(req.mutants[0] ?? "", req),
    },
    mutants: ["M0001", "M0002", "M0003", "M0004"],
    rows: (m, _cu, _daemon, n) => {
      const c = cRow(m, held.rig?.serve.requests[n]);
      const rows: FakeRow[] = [
        {
          method: "A",
          ...(m === "M0003" ? { status: "fail", message: "killed by A" } : { status: "pass" }),
        },
        { method: "B", status: "pass" },
        { method: "R", status: "error", notRun: true, message: UNLISTED },
      ];
      if (c !== undefined) rows.push(c);
      return rows;
    },
  });
  held.rig = r;
  return { r, state };
}

/** The orchestrator's baseline step on the sole lane: the bracket, a null activation, one run per ref, then the end. */
async function baseline(r: LanesRig, state: State): Promise<void> {
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
    state.phase = "stability";
  } finally {
    await r.b.baselinePhase(false, true); // a completed baseline
    state.phase = "mutants";
  }
}

const noEcho = (r: LanesRig) => r.serve.requests;
/** Requests that carry exactly `Codeunit<CU>.C` as their one test, with the mutant they name. */
const aloneC = (r: LanesRig, mutant: string): Req[] =>
  noEcho(r).filter(
    (q) => q.tests.length === 1 && q.tests[0] === `Codeunit${CU}.C` && q.mutants[0] === mutant,
  );
const prefetch = (r: LanesRig, mutant: string, refs: readonly ReturnType<typeof ref>[]) =>
  r.b.prefetchMutants([{ mutantId: mutant, refs }], {
    batchPlans: ["M0001", "M0002", "M0003", "M0004"].map((mutantId) => ({ mutantId, refs })),
  });
const outcome = (v: TestVerdict) => [v.outcome, v.runnerRow ?? ""];

describe("PR-297: a green test after a baseline-refusal cut, run alone", () => {
  test("1: flag off (default): no stability run, no alone request, PR-250's error byte for byte", async () => {
    const { r, state } = await tailRig({ flag: false });
    await baseline(r, state);
    // the cut still fires: the codeunit is cut before R
    expect((r.b as unknown as { refusedCut(cu: number): unknown }).refusedCut(CU)).toBeDefined();
    expect(noEcho(r).filter((q) => q.tests.some((t) => !t.endsWith(".")))).toEqual([]);
    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(A, OPTS))).toEqual(["pass", ""]);
    const c = await r.b.run(C, OPTS);
    expect(outcome(c)).toEqual(["error", "runner-refused"]);
    expect(c.selection).toBeUndefined();
    expect(c.failureMessage).toBe(
      `baseline-refused-cut: Tests${CU}.C was not run under this mutant: codeunit ${CU}'s entry is cut before Codeunit${CU}.R, whose baseline refusal the daemon does not keep ("${UNLISTED}"); not measured (PR-250)`,
    );
    // no request ever carried one test alone
    expect(noEcho(r).filter((q) => q.tests.some((t) => !t.endsWith(".")))).toEqual([]);
  });

  test("2: flag on, stable C: a kill by C alone is `killed` with selection alone and the note; a mutant that survives is `survived`; the stability run is sent once", async () => {
    const { r, state } = await tailRig({ flag: true });
    await baseline(r, state);
    // exactly one NONE request carrying C alone, no mutant active, runSelectedOnly
    const stab = aloneC(r, "NONE");
    expect(stab).toHaveLength(1);
    expect(stab[0]?.selectedOnly).toBe(true);
    // the refused test never ran in that request
    expect(stab[0]?.hiddenRan).toEqual([]);

    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    expect(outcome(await r.b.run(A, OPTS))).toEqual(["pass", ""]);
    const k = await r.b.run(C, OPTS);
    expect(k.outcome).toBe("fail");
    expect(k.selection).toBe("alone");
    expect(k.failureMessage).toContain("killed by C");
    expect(k.failureMessage).toContain(NOTE);
    // the kill's own request: C alone, the mutant active, selected-only, nothing else
    const under = aloneC(r, "M0001");
    expect(under).toHaveLength(1);
    expect(under[0]?.selectedOnly).toBe(true);

    await prefetch(r, "M0002", [A, C]);
    await r.b.activate("M0002");
    expect(outcome(await r.b.run(A, OPTS))).toEqual(["pass", ""]);
    const s = await r.b.run(C, OPTS);
    expect(s.outcome).toBe("pass");
    expect(s.selection).toBe("alone");
    expect(s.failureMessage ?? "").not.toContain("PR-297");
    expect(aloneC(r, "M0002")).toHaveLength(1);
    // the stability run was not sent again
    expect(aloneC(r, "NONE")).toHaveLength(1);
    // the refused test never ran under a mutant, not even hidden
    expect(
      noEcho(r)
        .filter((q) => q.mutants.some((m) => m !== "NONE"))
        .flatMap((q) => q.hiddenRan),
    ).toEqual([]);
    // R itself keeps PR-250's error
    const rv = await r.b.run(R, OPTS);
    expect(outcome(rv)).toEqual(["error", "runner-refused"]);
    expect(rv.failureMessage).toContain("PR-250");
  });

  test("3: flag on, C fails alone in the stability run: C keeps PR-250's error under every mutant, never survived", async () => {
    const { r, state } = await tailRig({ flag: true, stab: "fail" });
    await baseline(r, state);
    expect(aloneC(r, "NONE")).toHaveLength(1);
    for (const m of ["M0001", "M0002"]) {
      await prefetch(r, m, [A, C]);
      await r.b.activate(m);
      await r.b.run(A, OPTS);
      const c = await r.b.run(C, OPTS);
      expect(outcome(c)).toEqual(["error", "runner-refused"]);
      expect(c.outcome).not.toBe("pass");
      expect(c.failureMessage).toContain("baseline-refused-cut");
      expect(c.selection).toBeUndefined();
      expect(aloneC(r, m)).toEqual([]);
    }
  });

  test("4: a tail with no green test (C fails at the baseline): no stability run, today's behaviour", async () => {
    const { r, state } = await tailRig({ flag: true, cBaseline: "fail" });
    await baseline(r, state);
    expect(noEcho(r).filter((q) => q.tests.some((t) => !t.endsWith(".")))).toEqual([]);
    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    const c = await r.b.run(C, OPTS);
    expect(outcome(c)).toEqual(["error", "runner-refused"]);
    expect(c.failureMessage).toContain("baseline-refused-cut");
    expect(noEcho(r).filter((q) => q.tests.some((t) => !t.endsWith(".")))).toEqual([]);
  });

  for (const stab of ["fail", "refused", "timeout", "missing", "eof"] as const) {
    test(`5: a stability run that gives ${stab} marks C unstable (fail closed): C keeps PR-250's error and is never retried`, async () => {
      const { r, state } = await tailRig({ flag: true, stab });
      await baseline(r, state);
      // one attempt, never retried
      expect(aloneC(r, "NONE")).toHaveLength(1);
      await prefetch(r, "M0001", [A, C]);
      await r.b.activate("M0001");
      await r.b.run(A, OPTS);
      const c = await r.b.run(C, OPTS);
      expect(outcome(c)).toEqual(["error", "runner-refused"]);
      expect(c.failureMessage).toContain("baseline-refused-cut");
      expect(aloneC(r, "M0001")).toEqual([]);
      expect(aloneC(r, "NONE")).toHaveLength(1);
    });
  }

  test("7: the NONE confirm of a tail kill runs C alone with no mutant (the verdict says alone; a forced alone run under NONE sends C alone), after the kill", async () => {
    const { r, state } = await tailRig({ flag: true });
    await baseline(r, state);
    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    const kill = await r.b.run(C, OPTS);
    expect(kill.outcome).toBe("fail");
    // the orchestrator's `aloneKill` reads exactly this: fail + selection alone
    expect(kill.selection).toBe("alone");
    const before = noEcho(r).length;
    // its confirm: NONE active, alone
    await r.b.activate(null);
    const none = await r.b.run(C, { ...OPTS, alone: true });
    expect(none.outcome).toBe("pass");
    expect(none.selection).toBe("alone");
    const sent = noEcho(r).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tests).toEqual([`Codeunit${CU}.C`]);
    expect(sent[0]?.mutants).toEqual(["NONE"]);
    expect(sent[0]?.selectedOnly).toBe(true);
    // and the reproduction: the mutant again, alone, through the PR-250 block (not an error)
    await r.b.activate("M0001");
    const repro = await r.b.run(C, { ...OPTS, alone: true });
    expect(repro.outcome).toBe("fail");
    expect(repro.selection).toBe("alone");
    expect(repro.failureMessage).toContain(NOTE);
    const last = noEcho(r).at(-1);
    expect(last?.tests).toEqual([`Codeunit${CU}.C`]);
    expect(last?.mutants).toEqual(["M0001"]);
  });

  test("a head test (A, before the cut) is never routed alone, and a stable C under a mutant that kills A is not run alone by the walk", async () => {
    const { r, state } = await tailRig({ flag: true });
    await baseline(r, state);
    await prefetch(r, "M0003", [A, C]);
    await r.b.activate("M0003");
    const a = await r.b.run(A, OPTS);
    expect(a.outcome).toBe("fail");
    expect(a.selection).toBeUndefined();
    expect(aloneC(r, "M0003")).toEqual([]);
    void B;
  });
});

const tailNotices = (r: LanesRig) =>
  r.notices.filter((n) => n.startsWith("al-runner-v3-refused-cut-tail:"));
const isStabilityReq = (q: Req) =>
  q.tests.length === 1 && q.tests[0] === `Codeunit${CU}.C` && q.mutants[0] === "NONE";
const sig = (q: Req) => JSON.stringify([q.mutants, q.tests, q.selectedOnly, q.excludes]);

describe("PR-297 review fixes", () => {
  test("B1: the stability pass leaves no trace on the daemon, warm-up or barrier state: the first mutant request warms the union as with the flag off", async () => {
    const off = await tailRig({ flag: false });
    await baseline(off.r, off.state);
    const offBaselineWarmups = off.r.b.entriesStats().warmups;
    await prefetch(off.r, "M0001", [A]);
    const on = await tailRig({ flag: true });
    await baseline(on.r, on.state);
    // no daemon is open, no warm-up was counted, and the barrier has not passed
    expect(on.r.b.barrierPassed()).toBe(false);
    expect(on.r.b.entriesStats().warmups).toBe(offBaselineWarmups);
    await prefetch(on.r, "M0001", [A]);
    // exactly ONE stability request; every other request is the flag-off run's
    expect(on.r.serve.requests.filter(isStabilityReq)).toHaveLength(1);
    expect(on.r.serve.requests.filter((q) => !isStabilityReq(q)).map(sig)).toEqual(
      off.r.serve.requests.map(sig),
    );
    // the union was warmed and judged at the first mutant request (the barrier opens only then)
    expect(on.r.b.entriesStats().warmups).toBe(off.r.b.entriesStats().warmups);
  });

  test("S1: a baseline that did not complete, a spent budget or a signal sends no stability request, and a baseline error is kept", async () => {
    const { r, state } = await tailRig({ flag: true });
    r.b.baselinePhase(true);
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
    state.phase = "stability";
    await expect(
      (async () => {
        try {
          throw new Error("baseline boom");
        } finally {
          await r.b.baselinePhase(false, false);
        }
      })(),
    ).rejects.toThrow("baseline boom");
    expect(aloneC(r, "NONE")).toEqual([]);
    for (const [spent, signalled] of [
      [true, false],
      [false, true],
    ] as const) {
      const x = await tailRig({ flag: true });
      x.r.b.useStopHandle({ spent: () => spent, signalled: () => signalled, stopForMemory() {} });
      await baseline(x.r, x.state);
      expect(aloneC(x.r, "NONE")).toEqual([]);
      // nothing was measured: C is unstable, today's error
      await prefetch(x.r, "M0001", [A, C]);
      await x.r.b.activate("M0001");
      await x.r.b.run(A, OPTS);
      expect(outcome(await x.r.b.run(C, OPTS))).toEqual(["error", "runner-refused"]);
    }
  });

  test("S1: any error inside the pass marks the tests unstable, is said once, and is never rethrown", async () => {
    const { r, state } = await tailRig({ flag: true });
    r.b.baselinePhase(true);
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
    state.phase = "stability";
    const stub = spyOn(r.b as unknown as { send: () => Promise<never> }, "send").mockRejectedValue(
      new TypeError("boom send"),
    );
    try {
      await r.b.baselinePhase(false, true);
    } finally {
      stub.mockRestore(); // only the pass is stubbed
      state.phase = "mutants";
    }
    expect(tailNotices(r).join("\n")).toContain("boom send");
    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    expect(outcome(await r.b.run(C, OPTS))).toEqual(["error", "runner-refused"]);
  });

  test("S2: a tail test that times out alone under a mutant is `timeout` and carries the note, its timeout wording intact", async () => {
    const { r, state } = await tailRig({ flag: true });
    await baseline(r, state);
    await prefetch(r, "M0004", [A, C]);
    await r.b.activate("M0004");
    await r.b.run(A, OPTS);
    const v = await r.b.run(C, OPTS);
    expect(v.outcome).toBe("timeout");
    expect(v.selection).toBe("alone");
    expect(v.failureMessage?.startsWith(TIMEOUT_1S)).toBe(true);
    expect(v.failureMessage).toContain(NOTE);
    expect(v.timeoutWordingUnknown).toBeUndefined();
    expect(v.reportedStopMs).toBe(1000);
  });

  test("S3: after the pass one line per codeunit names the stable and the unstable tail tests; at the end the alone-call counts; none with the flag off", async () => {
    const { r, state } = await tailRig({ flag: true });
    await baseline(r, state);
    expect(tailNotices(r)).toHaveLength(1);
    expect(tailNotices(r)[0]).toContain(`codeunit ${CU}`);
    expect(tailNotices(r)[0]).toContain("stable: C");
    expect(tailNotices(r)[0]).toContain("unstable: none");
    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    await r.b.run(C, OPTS);
    await r.b.close();
    const end = tailNotices(r).filter((n) => n.includes("alone calls"));
    expect(end).toHaveLength(1);
    expect(end[0]).toContain("stability 1");
    expect(end[0]).toContain("under a mutant 1");

    const bad = await tailRig({ flag: true, stab: "fail" });
    await baseline(bad.r, bad.state);
    expect(tailNotices(bad.r)[0]).toContain("stable: none");
    expect(tailNotices(bad.r)[0]).toContain("unstable: C");

    const off = await tailRig({ flag: false });
    await baseline(off.r, off.state);
    await off.r.b.close();
    expect(tailNotices(off.r)).toEqual([]);
  });

  test("S4: with the §6 Sleep rule not retired a stable tail test is NOT routed alone: PR-250's error, and the reason is said once", async () => {
    const { r, state } = await tailRig({ flag: true });
    await baseline(r, state);
    await prefetch(r, "M0001", [A, C]);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    r.b.seams.sleepRuleRetired = false;
    for (const m of ["M0001"]) {
      const c = await r.b.run(C, OPTS);
      expect(outcome(c)).toEqual(["error", "runner-refused"]);
      expect(c.failureMessage).toContain("baseline-refused-cut");
      expect(aloneC(r, m)).toEqual([]);
    }
    await r.b.run(C, OPTS);
    expect(tailNotices(r).filter((n) => n.includes("Sleep rule"))).toHaveLength(1);
  });
});

describe("PR-297: the key, the fingerprint, the lending build", () => {
  const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };
  test("6a: absent stays absent, a boolean is kept, anything else is refused by name", () => {
    expect("refusedCutTail" in validateAlRunnerV3Config(base)).toBe(false);
    expect(validateAlRunnerV3Config({ ...base, refusedCutTail: true }).refusedCutTail).toBe(true);
    expect(validateAlRunnerV3Config({ ...base, refusedCutTail: false }).refusedCutTail).toBe(false);
    for (const bad of ["true", 1, null, [true]])
      expect(() => validateAlRunnerV3Config({ ...base, refusedCutTail: bad })).toThrow(
        '"alRunnerV3.refusedCutTail" must be true or false',
      );
  });

  test("6b: the fingerprint changes with the flag, and today's digest does not move without it", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const none = sessionFingerprint(f);
    const on = sessionFingerprint({ ...f, v3RefusedCutTail: true });
    expect(on).not.toBe(none);
    // the digest of these inputs before PR-297 (the field adds no key when absent)
    expect(none).toBe("9349b4c9edc905ff2627fabf927415d531d474d105727b56247fe761be5d5154");
    // a resume under another value is another fingerprint: it refuses (the resume check compares fingerprints)
    expect(sessionFingerprint({ ...f, v3RefusedCutTail: false } as unknown as typeof f)).toBe(none);
  });

  test("6c: the lending build carries a tag only when on", () => {
    const v3 = { version: "v", binarySha256: "s" };
    const stub = (extra: object) =>
      ({ environmentChoice: { value: "saas" }, ...extra }) as unknown as Parameters<
        typeof lendingRunnerBuild
      >[0];
    const off = lendingRunnerBuild(stub({}), v3);
    const on = lendingRunnerBuild(stub({ refusedCutTail: true }), v3);
    expect(off).not.toContain("refused-cut-tail");
    expect(on).toBe(`${off} refused-cut-tail`);
    expect(lendingRunnerBuild(stub({ refusedCutTail: true, isolationAuto: true }), v3)).toBe(
      `${off} refused-cut-tail isolation-auto`,
    );
  });
});
