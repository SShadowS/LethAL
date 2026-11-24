// PR-256 (docs/superpowers/specs/2026-11-22-pr256-stop-groups.md, R1146): `alRunnerV3.stopGroups`. Mutant requests
// carry `stopAfterFirstFailure` and one `stopGroup` per ENTRY; a row upstream skipped after a failure is recognised
// only by the strict rule 3, and is then no verdict, no refusal and no daemon close. The lane rig emulates the stop
// (the fake daemon skips a group's later tests after its first failing row). Call counters only, never time.
import { afterEach, describe, expect, test } from "bun:test";
import {
  AlRunnerV3StopGroupsError,
  type V3Row,
  assertStopShape,
  recognisedStopSkips,
} from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { gatedBuilds, stopGroupsFor } from "../src/al-runner-v3-pins";
import type { TestVerdict } from "../src/backend";
import { lendingRunnerBuild } from "../src/orchestrator";
import { sessionFingerprint } from "../src/resume";
import {
  CU,
  ECHO,
  type FakeRow,
  type LanesRig,
  OPTS,
  type RowsFn,
  TIMEOUT_1S,
  cleanRigs,
  lanesRig,
  ref,
  stopSkipText,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const [A, B, C] = ["A", "B", "C"].map(ref) as [
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
  ReturnType<typeof ref>,
];
const MUTANTS = ["M0001", "M0002", "M0003"];
const pass = (method: string): FakeRow => ({ method, status: "pass" });
const fail = (method: string, message = `killed by ${method}`): FakeRow => ({
  method,
  status: "fail",
  message,
});
const skip = (method: string, failed: string): FakeRow => ({
  method,
  status: "error",
  notRun: true,
  message: stopSkipText(`Codeunit${CU}.${failed}`),
});

/** `under(m)`: the rows a mutant's entry gives before the stop (NONE and STATIC give `none`). */
async function rig(o: {
  stopGroups?: boolean;
  stopGroupsFact?: boolean;
  methods?: string[];
  none?: FakeRow[];
  under: (m: string) => FakeRow[];
  pairBatch?: boolean;
}): Promise<LanesRig> {
  const methods = o.methods ?? ["A", "B"];
  const none = o.none ?? methods.map(pass);
  const rows: RowsFn = (m) => (m === "NONE" || m === "STATIC" ? none : o.under(m));
  return lanesRig({
    lanes: 0,
    methods,
    mutants: MUTANTS,
    rows,
    ...(o.stopGroups !== undefined ? { stopGroups: o.stopGroups } : {}),
    ...(o.stopGroupsFact !== undefined ? { stopGroupsFact: o.stopGroupsFact } : {}),
    ...(o.pairBatch === true ? { pairBatch: true } : {}),
  });
}

async function baseline(r: LanesRig): Promise<void> {
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
  } finally {
    await r.b.baselinePhase(false, true);
  }
}

const prefetch = (
  r: LanesRig,
  plans: readonly { mutantId: string; refs: readonly ReturnType<typeof ref>[] }[],
) => r.b.prefetchMutants(plans, { batchPlans: plans });

type Body = {
  stopAfterFirstFailure?: boolean;
  entries?: { id: string; test: string; stopGroup?: string; resources: Record<string, string> }[];
};
const bodyOf = (r: LanesRig, i: number): Body => JSON.parse(r.serve.bodies[i] ?? "{}") as Body;
const bodies = (r: LanesRig): Body[] => r.serve.bodies.map((_, i) => bodyOf(r, i));
const mutantOf = (b: Body) => b.entries?.map((e) => e.resources["active-mutant.txt"]) ?? [];
const outcome = (v: TestVerdict) => [v.outcome, v.runnerRow ?? ""];
const closes = (r: LanesRig) => [...r.b.daemonCloses().byReason].filter(([k]) => k !== "deploy");

describe("PR-256: per-entry stop groups on mutant requests", () => {
  test("1: a skip after a plain fail of a green covering test in the same entry: no refusal, no close, stopSkipped 1, the mutant killed by F", async () => {
    const r = await rig({
      stopGroups: true,
      under: (m) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), pass("B")]),
    });
    await baseline(r);
    const before = r.serve.bodies.length;
    await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
    // the mutant request: the stop, and one group per entry (the echo its own)
    const sent = bodies(r).slice(before);
    const mine = sent.filter((b) => mutantOf(b).includes("M0001"));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.stopAfterFirstFailure).toBe(true);
    expect(mine[0]?.entries?.map((e) => [e.id, e.stopGroup])).toEqual([
      ["M0001|echo", "M0001|echo"],
      [`M0001|${CU}`, `M0001|${CU}`],
    ]);
    // every NONE request of the session (baseline, warm-up) went without the stop and without groups
    for (const b of bodies(r).filter((x) => mutantOf(x).every((m) => m === "NONE"))) {
      expect(b.stopAfterFirstFailure).toBeUndefined();
      expect(b.entries?.some((e) => e.stopGroup !== undefined) ?? false).toBe(false);
    }
    await r.b.activate("M0001");
    const a = await r.b.run(A, OPTS);
    expect(outcome(a)).toEqual(["fail", ""]);
    expect(a.failureMessage).toContain("killed by A");
    expect(r.b.stopGroupsStats().skipped).toBe(1);
    expect(closes(r)).toEqual([]);
    expect(r.notices.filter((n) => /refus/i.test(n))).toEqual([]);
  });

  // amendment 1 item 2: a baseline-red test before a covering one never fires the stop: the request holding
  // it goes without the stop, so the covering test is measured as with the flag off
  test("2: a test red at baseline before a covering one: no stop, no refusal, no close, the covering test as flag-off", async () => {
    const run = async (on: boolean) => {
      const r = await rig({
        stopGroups: on,
        none: [fail("A", "red at baseline"), pass("B")],
        under: () => [fail("A"), pass("B")],
      });
      await baseline(r);
      const before = r.serve.bodies.length;
      await prefetch(r, [{ mutantId: "M0001", refs: [B] }]);
      await r.b.activate("M0001");
      const b = await r.b.run(B, OPTS);
      return { r, b, sent: bodies(r).slice(before) };
    };
    const off = await run(false);
    const on = await run(true);
    expect(outcome(on.b)).toEqual(outcome(off.b));
    expect(on.b.outcome).toBe("pass");
    expect(on.b.selection).toBeUndefined();
    expect(on.sent.some((x) => x.stopAfterFirstFailure === true)).toBe(false);
    expect(on.sent.some((x) => x.entries?.some((e) => e.stopGroup !== undefined))).toBe(false);
    expect(on.r.b.stopGroupsStats()).toEqual({
      skipped: 0,
      uncounted: 0,
      reruns: 0,
      heldForRed: 1,
    });
    expect(closes(on.r)).toEqual([]);
  });

  test("2b: a non-covering, state-dependent failure fires the stop: the skip is no refusal, not counted, and the covering test is re-run alone as flag-off", async () => {
    const run = async (on: boolean) => {
      const r = await rig({ stopGroups: on, under: () => [fail("A"), pass("B")] });
      await baseline(r);
      await prefetch(r, [{ mutantId: "M0001", refs: [B] }]);
      await r.b.activate("M0001");
      return { r, b: await r.b.run(B, OPTS) };
    };
    const off = await run(false);
    const on = await run(true);
    expect(outcome(on.b)).toEqual(outcome(off.b));
    expect(on.b.outcome).toBe("pass");
    expect(on.b.selection).toBe("alone");
    expect(on.r.b.stopGroupsStats()).toEqual({
      skipped: 0,
      uncounted: 1,
      reruns: 1,
      heldForRed: 0,
    });
    expect(closes(on.r)).toEqual([]);
    expect(on.r.notices.filter((n) => /refus/i.test(n))).toEqual([]);
  });

  test("N1: a scan-gap re-send counts its skips once", async () => {
    let calls = 0;
    const r = await rig({
      stopGroups: true,
      methods: ["A", "B", "C", "D"],
      under: (m) => {
        if (m !== "M0001") return [pass("A"), pass("B"), pass("C"), pass("D")];
        calls += 1;
        // the first answer leaves out B, a kept test: PR-94's scan gap discards it and re-sends unflagged
        return calls === 1
          ? [fail("A"), pass("C"), pass("D")]
          : [fail("A"), pass("B"), pass("C"), pass("D")];
      },
    });
    await baseline(r);
    await prefetch(r, [{ mutantId: "M0001", refs: [ref("A"), ref("C")] }]);
    expect(r.notices.some((n) => n.startsWith("al-runner-v3-selected-only-scan-gap"))).toBe(true);
    expect(calls).toBe(2);
    // the re-send's B, C, D after A (a covering, green, plain fail) once; the discarded answer's C, D never
    expect(r.b.stopGroupsStats()).toMatchObject({ skipped: 3, uncounted: 0 });
  });

  test("N1: entries after an R612 cut are counted once, by their re-send", async () => {
    const r = await rig({
      stopGroups: true,
      under: (m) =>
        m === "M0002"
          ? [
              pass("A"),
              {
                method: "B",
                status: "error",
                notRun: true,
                message: "NotRun: out-of-scope: other",
              },
            ]
          : [fail("A"), pass("B")],
    });
    await baseline(r);
    await prefetch(
      r,
      MUTANTS.map((mutantId) => ({ mutantId, refs: [A, B] })),
    );
    expect(closes(r).map(([k]) => k)).toContain("refusal");
    // M0003 was after the cut: re-sent, and counted there only
    expect(
      bodies(r).filter((b) => mutantOf(b).includes("M0003") && b.stopAfterFirstFailure === true),
    ).toHaveLength(2);
    expect(r.b.stopGroupsStats().skipped).toBe(2);
  });

  test("amendment 1 item 1: the fact present but the §6 Sleep rule in force: refused by name, no stop sent", async () => {
    const r = await rig({
      stopGroups: true,
      under: (m) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), pass("B")]),
    });
    await baseline(r);
    r.b.seams.sleepRuleRetired = false;
    await expect(prefetch(r, [{ mutantId: "M0001", refs: [A, B] }])).rejects.toThrow(
      "al-runner-v3-stop-groups-unsupported",
    );
    expect(r.serve.bodies.some((b) => b.includes("stopAfterFirstFailure"))).toBe(false);
  });

  test("3: a skip naming a test of ANOTHER entry is a refusal", async () => {
    // one packed request: M0001's entry fails A (its B is a real skip); M0002's entry passes A and its B
    // names A anyway (only another entry failed A)
    const r = await rig({
      stopGroups: true,
      under: (m) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), skip("B", "A")]),
    });
    await baseline(r);
    const before = r.serve.bodies.length;
    await prefetch(r, [
      { mutantId: "M0001", refs: [A, B] },
      { mutantId: "M0002", refs: [A, B] },
    ]);
    const packed = bodies(r)
      .slice(before)
      .filter((b) => mutantOf(b).includes("M0001") && mutantOf(b).includes("M0002"));
    expect(packed).toHaveLength(1);
    expect(r.b.stopGroupsStats().skipped).toBe(1);
    await r.b.activate("M0002");
    expect((await r.b.run(B, OPTS)).outcome).toBe("error");
    expect(closes(r).map(([k]) => k)).toContain("refusal");
  });

  test("4: the pinned text on a request sent without the stop is a refusal (flag off)", async () => {
    const r = await rig({ under: () => [fail("A"), skip("B", "A")] });
    await baseline(r);
    await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
    await r.b.activate("M0001");
    expect((await r.b.run(B, OPTS)).outcome).toBe("error");
    expect(r.b.stopGroupsStats().skipped).toBe(0);
    expect(closes(r).map(([k]) => k)).toContain("refusal");
  });

  test("6: the walk asks for a skipped ref: it is re-run alone without the stop, once, and its verdict equals the flag-off one", async () => {
    const under = (m: string) => (m === "M0001" ? [fail("A"), fail("B")] : [pass("A"), pass("B")]);
    const verdicts = async (on: boolean) => {
      const r = await rig({ stopGroups: on, under });
      await baseline(r);
      await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
      await r.b.activate("M0001");
      const a = await r.b.run(A, OPTS);
      const before = r.serve.bodies.length;
      const b = await r.b.run(B, OPTS);
      const again = await r.b.run(B, OPTS);
      return { r, a, b, again, sent: bodies(r).slice(before) };
    };
    const off = await verdicts(false);
    const on = await verdicts(true);
    expect(on.r.b.stopGroupsStats().skipped).toBe(1);
    expect(outcome(on.a)).toEqual(outcome(off.a));
    expect(on.a.failureMessage).toBe(off.a.failureMessage);
    expect(outcome(on.b)).toEqual(outcome(off.b));
    expect(on.b.failureMessage).toBe(off.b.failureMessage);
    expect(on.b.selection).toBe("alone");
    expect(outcome(on.again)).toEqual(outcome(off.b));
    // exactly one request: B alone, under M0001, with no stop and no group
    expect(on.sent).toHaveLength(1);
    expect(on.r.b.stopGroupsStats().reruns).toBe(1);
    const re = on.sent[0];
    expect(mutantOf(re ?? {})).toEqual(["M0001", "M0001"]);
    expect(re?.entries?.[1]?.test).toBe(`Codeunit${CU}.B`);
    expect(re?.stopAfterFirstFailure).toBeUndefined();
    expect(re?.entries?.some((e) => e.stopGroup !== undefined)).toBe(false);
    expect(closes(on.r)).toEqual([]);
  });

  test("7: a kill pair (per kill and batched) and a NONE confirm carry no stop and no groups", async () => {
    for (const pairBatch of [false, true]) {
      const r = await rig({
        stopGroups: true,
        pairBatch,
        under: (m) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), pass("B")]),
      });
      await baseline(r);
      await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
      await r.b.activate("M0001");
      expect((await r.b.run(A, OPTS)).outcome).toBe("fail");
      await r.b.sendKillPair("M0001", A);
      await r.b.activate(null);
      await r.b.run(A, OPTS);
      await r.b.activate("M0001");
      await r.b.run(A, OPTS);
      const pairs = bodies(r).filter(
        (b) => mutantOf(b).includes("NONE") && mutantOf(b).includes("M0001"),
      );
      expect(pairs.length).toBeGreaterThan(0);
      for (const b of bodies(r).filter((x) => mutantOf(x).includes("NONE"))) {
        expect(b.stopAfterFirstFailure).toBeUndefined();
        expect(b.entries?.some((e) => e.stopGroup !== undefined)).toBe(false);
      }
      // and the mutant's own prefetch did carry it
      expect(
        bodies(r).some((b) => b.stopAfterFirstFailure === true && mutantOf(b)[0] === "M0001"),
      ).toBe(true);
    }
  });

  test("8: a mixed request is refused by name before it is sent, by the typed error, never as pair-skipped", async () => {
    const e = (id: string, group?: string) => ({
      id,
      test: `Codeunit${CU}.`,
      ...(group !== undefined ? { stopGroup: group } : {}),
    });
    expect(() =>
      assertStopShape({ stopAfterFirstFailure: true, entries: [e("M|echo", "M|echo"), e("M|1")] }),
    ).toThrow(AlRunnerV3StopGroupsError);
    expect(() => assertStopShape({ entries: [e("M|echo", "M|echo"), e("M|1", "M|1")] })).toThrow(
      "al-runner-v3-stop-groups-shape",
    );
    expect(() => assertStopShape({ stopAfterFirstFailure: true, entries: [e("M|echo")] })).toThrow(
      "al-runner-v3-stop-groups-shape",
    );
    expect(() =>
      assertStopShape({
        stopAfterFirstFailure: true,
        entries: [e("M|echo", "M|echo"), e("M|1", "M|1")],
      }),
    ).not.toThrow();
    expect(() => assertStopShape({ entries: [e("M|echo"), e("M|1")] })).not.toThrow();

    // the pair path: a pair request bent into a mixed shape throws the typed error out of sendKillPair
    const r = await rig({
      stopGroups: true,
      under: (m) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), pass("B")]),
    });
    await baseline(r);
    await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    const before = r.serve.bodies.length;
    r.b.seams.entriesBodyTamper = (body) => {
      const first = (body.entries as Record<string, unknown>[] | undefined)?.[0];
      if (first !== undefined) first.stopGroup = "bent";
    };
    await expect(r.b.sendKillPair("M0001", A)).rejects.toThrow(AlRunnerV3StopGroupsError);
    expect(r.serve.bodies.length).toBe(before);
    expect(r.notices.filter((n) => n.startsWith("al-runner-v3-pair-skipped"))).toEqual([]);
  });

  test("9: flag off: every request byte-identical to the flag absent, and none carries the stop or a group", async () => {
    const under = (m: string) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), pass("B")]);
    const session = async (stopGroups?: boolean) => {
      const r = await rig({ ...(stopGroups !== undefined ? { stopGroups } : {}), under });
      await baseline(r);
      await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
      await r.b.activate("M0001");
      await r.b.run(A, OPTS);
      await r.b.run(B, OPTS);
      await r.b.sendKillPair("M0001", A);
      return r.serve.bodies.map((b) => b.replace(/lethal-v3lanes-[A-Za-z0-9]+/g, "<root>"));
    };
    const absent = await session();
    const off = await session(false);
    expect(off).toEqual(absent);
    expect(absent.length).toBeGreaterThanOrEqual(3);
    for (const b of absent) {
      expect(b).not.toContain("stopGroup");
      expect(b).not.toContain("stopAfterFirstFailure");
    }
  });

  test("the flag on without the build fact `stop-groups`: the mutant request is refused by name", async () => {
    const r = await rig({
      stopGroups: true,
      stopGroupsFact: false,
      under: () => [pass("A"), pass("B")],
    });
    await baseline(r);
    await expect(prefetch(r, [{ mutantId: "M0001", refs: [A, B] }])).rejects.toThrow(
      "al-runner-v3-stop-groups-unsupported",
    );
  });

  test("stopSkipped is in the serve-entries line only with the flag on", async () => {
    const lines = async (on: boolean) => {
      const r = await rig({
        stopGroups: on,
        under: (m) => (m === "M0001" ? [fail("A"), pass("B")] : [pass("A"), pass("B")]),
      });
      await baseline(r);
      await prefetch(r, [{ mutantId: "M0001", refs: [A, B] }]);
      const said: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => said.push(a.map(String).join(" "));
      try {
        await r.b.close();
      } finally {
        console.warn = warn;
      }
      return said.filter((l) => l.includes("serve-entries (R635)"));
    };
    const [onLine] = await lines(true);
    const [offLine] = await lines(false);
    expect(onLine).toContain("stop-skipped rows (PR-256) 1");
    expect(offLine).toBeDefined();
    expect(offLine).not.toContain("PR-256");
  });
});

describe("PR-256 rule 3: strict recognition (each condition alone)", () => {
  const row = (method: string, status: V3Row["status"], message?: string, notRun = false): V3Row =>
    ({
      codeunit: CU,
      method,
      name: `Codeunit${CU}.${method}`,
      status,
      notRun,
      ...(message !== undefined ? { message } : {}),
    }) as V3Row;
  const skipRow = (method: string, failed: string, cu = CU) =>
    row(method, "error", stopSkipText(`Codeunit${cu}.${failed}`), true);
  const green = [row("A", "pass"), row("B", "pass"), row("C", "pass")];
  type In = Parameters<typeof recognisedStopSkips>[0];
  const ok: In = {
    requestStop: true,
    entryGroup: `M0001|${CU}`,
    codeunit: CU,
    rows: [row("A", "fail", "killed by A"), skipRow("B", "A")],
    covering: new Set(["a", "b"]),
    baseline: green,
  };
  type Part = { [K in keyof In]?: In[K] | undefined };
  /** [skipped, counted] positions. */
  const got = (o: Part) => {
    const r = recognisedStopSkips({ ...ok, ...o } as In);
    return [[...r.skipped], [...r.counted]];
  };

  test("all hold: the skip row is skipped and counted", () => {
    expect(got({})).toEqual([[1], [1]]);
    expect(got({ rows: [row("A", "fail", "x"), skipRow("B", "A"), skipRow("C", "A")] })).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });
  // amendment 1 item 2: these stay refusals (a contract violation, fail closed): not skipped at all
  test("4: the request without the stop: not a skip", () => {
    expect(got({ requestStop: false })).toEqual([[], []]);
  });
  test("4: an entry without a group: not a skip", () => {
    expect(got({ entryGroup: undefined })).toEqual([[], []]);
  });
  test("naming no EARLIER failed row of the entry (or of another codeunit): not a skip", () => {
    expect(got({ rows: [skipRow("B", "A"), row("A", "fail", "x")] })).toEqual([[], []]);
    expect(got({ rows: [skipRow("B", "C")] })).toEqual([[], []]);
    expect(got({ rows: [row("A", "fail", "x"), skipRow("B", "A", ECHO)] })).toEqual([[], []]);
    expect(got({ rows: [row("A", "pass"), skipRow("B", "A")] })).toEqual([[], []]);
    expect(got({ rows: [row("A", "error", TIMEOUT_1S), skipRow("B", "A")] })).toEqual([[], []]);
  });
  test("another text: not a skip", () => {
    expect(
      got({
        rows: [row("A", "fail", "x"), row("B", "error", "NotRun: out-of-scope: other", true)],
      }),
    ).toEqual([[], []]);
  });
  // amendment 1 item 2: rule 3's strict conditions only decide the COUNT; the row is still a skip
  test("5: F a refusal-marked or notRun fail: a skip, not counted", () => {
    expect(
      got({
        rows: [row("A", "fail", "NotRun: out-of-scope: something refused"), skipRow("B", "A")],
      }),
    ).toEqual([[1], []]);
    expect(got({ rows: [row("A", "fail", "x", true), skipRow("B", "A")] })).toEqual([[1], []]);
  });
  test("2b: F not a covering test of the mutant: a skip, not counted", () => {
    expect(got({ covering: new Set(["b"]) })).toEqual([[1], []]);
    expect(got({ covering: undefined })).toEqual([[1], []]);
  });
  test("2: F red, or refused, at baseline: a skip, not counted", () => {
    expect(got({ baseline: [row("A", "fail", "red"), row("B", "pass")] })).toEqual([[1], []]);
    expect(
      got({ baseline: [row("A", "error", "NotRun: out-of-scope: x", true), row("B", "pass")] }),
    ).toEqual([[1], []]);
    expect(got({ baseline: [row("B", "pass")] })).toEqual([[1], []]);
  });
});

describe("PR-256 rule 7: the key, the fact, the fingerprint, the lending build", () => {
  const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };
  test("absent stays absent, a boolean is kept, anything else is refused by name", () => {
    expect("stopGroups" in validateAlRunnerV3Config(base)).toBe(false);
    expect(validateAlRunnerV3Config({ ...base, stopGroups: true }).stopGroups).toBe(true);
    expect(validateAlRunnerV3Config({ ...base, stopGroups: false }).stopGroups).toBe(false);
    for (const bad of ["true", 1, null, [true]])
      expect(() => validateAlRunnerV3Config({ ...base, stopGroups: bad })).toThrow(
        '"alRunnerV3.stopGroups" must be true or false',
      );
  });

  // The pin was "no shipped record carries the fact yet". The first that does is edge-e5176a9fd (gated row f8185a042,
  // 2026-11-24), so the flag is now ALLOWED on that build: a real change of what a run may do. The pin is therefore
  // the exact set of shipped records that allow it. A new record reading `matches` fails here until it is named, so
  // every build that allows the flag is added on purpose (fix-stopgroups-pin; that row's [skip ci] push ran no unit test).
  test("exactly the named shipped gate records allow the flag (`stop-groups` reads `matches`), and only `matches` allows it", () => {
    expect(gatedBuilds().length).toBeGreaterThan(0);
    expect(
      gatedBuilds()
        .filter((g) => stopGroupsFor(g))
        .map((g) => g.version),
    ).toEqual(["al-runner 3.0.0-alpha.15+edge.20261124 (e5176a9fd)"]);
    expect(stopGroupsFor(undefined)).toBe(false);
    expect(stopGroupsFor({ batchFacts: { "stop-groups": "diverged" } })).toBe(false);
    expect(stopGroupsFor({ batchFacts: { "stop-groups": "matches" } })).toBe(true);
  });

  test("the fingerprint changes with the flag, and today's digest does not move without it", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const none = sessionFingerprint(f);
    expect(sessionFingerprint({ ...f, v3StopGroups: true })).not.toBe(none);
    expect(none).toBe("9349b4c9edc905ff2627fabf927415d531d474d105727b56247fe761be5d5154");
  });

  test("the lending build carries ` stop-groups` only when on, before isolation-auto", () => {
    const v3 = { version: "v", binarySha256: "s" };
    const stub = (extra: object) =>
      ({ environmentChoice: { value: "saas" }, ...extra }) as unknown as Parameters<
        typeof lendingRunnerBuild
      >[0];
    const off = lendingRunnerBuild(stub({}), v3);
    expect(off).not.toContain("stop-groups");
    expect(lendingRunnerBuild(stub({ stopGroups: true }), v3)).toBe(`${off} stop-groups`);
    expect(
      lendingRunnerBuild(stub({ refusedCutTail: true, stopGroups: true, isolationAuto: true }), v3),
    ).toBe(`${off} refused-cut-tail stop-groups isolation-auto`);
  });
});
