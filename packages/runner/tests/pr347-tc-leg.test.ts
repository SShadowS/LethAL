// PR-347 (docs/superpowers/specs/2026-11-23-pr347-refused-cut-tail-default.md): leg TC's pure judge, the fixture's
// shape, and the leg's wiring. Pure: no server, no al-runner.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TC_NOT_RUN_TEST,
  TC_SESSIONS,
  TC_TABLE,
  type TcInput,
  type TcRow,
  type TcSession,
  V3_TC_LEG,
  judgeTailcutLeg,
} from "../itest/alrunner-v3-legs";
import { PENDING_FIRST_RECORD } from "../itest/baseline-guard";
import { GATE_WARNINGS } from "../itest/gate-expected";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const NOTE =
  "[refused-cut tail: Tailcut Tests.T1 measured alone, after a baseline refusal cut (PR-297)]";
const rowsOf = (s: TcSession, edit?: (r: TcRow & { key: string }) => TcRow): TcRow[] =>
  TC_TABLE.map((site) => {
    const want = site.expect[s];
    const r = {
      key: `${site.procedureName} ${site.operator}`,
      procedureName: site.procedureName,
      operatorName: site.operator,
      verdict: want.verdict,
      ...(want.killingTest !== undefined ? { killingTest: want.killingTest } : {}),
      ...(s === "TC-on" && site.tailKillOn ? { killingTestFailure: `boom ${NOTE}` } : {}),
    };
    return edit === undefined ? r : edit(r);
  });
const STABILITY =
  "[lethal] al-runner-v3-refused-cut-tail: codeunit 76150: tail tests measured alone at the end of the baseline (5 green of 5 cut): stable: T1_DoubleTwo, T2_IsBigTen, T3_SetsMark, T5_IsSmallOne; unstable: T4_SeesTheMark (PR-297)";
const green = (): TcInput => ({
  rows: { "TC-off": rowsOf("TC-off"), "TC-on": rowsOf("TC-on"), "TC-alone": rowsOf("TC-alone") },
  cutEntries: { off: 6, on: 6 },
  tailCalls: { stability: 5, mutant: 6 },
  tailNotices: [STABILITY],
  t0Evidence: { off: "T0_RefusedFormat off", on: "T0_RefusedFormat on" },
  notRun: {
    "TC-off": { notRunAtBaseline: [TC_NOT_RUN_TEST], caveat: undefined },
    "TC-on": { notRunAtBaseline: [TC_NOT_RUN_TEST], caveat: { survivors: 1, notRunTests: 1 } },
    "TC-alone": { notRunAtBaseline: [TC_NOT_RUN_TEST], caveat: { survivors: 2, notRunTests: 1 } },
  },
});
const withNotRun = (s: TcSession, patch: Partial<TcInput["notRun"][TcSession]>): TcInput => {
  const g = green();
  return { ...g, notRun: { ...g.notRun, [s]: { ...g.notRun[s], ...patch } } };
};
const edited = (s: TcSession, edit: (r: TcRow & { key: string }) => TcRow): TcInput => {
  const g = green();
  return { ...g, rows: { ...g.rows, [s]: rowsOf(s, edit) } };
};

describe("PR-347 leg TC: the judge", () => {
  test("the pre-committed table passes, and has the spec's 10 rows", () => {
    expect(TC_TABLE).toHaveLength(10);
    expect(judgeTailcutLeg(green())).toEqual([]);
  });

  // Red: drop the (a1) loop in judgeTailcutLeg.
  test("(a1) no PR-250 cut in TC-off or in TC-on fails first, by name, printing T0's evidence", () => {
    for (const which of ["off", "on"] as const) {
      const g = green();
      const fails = judgeTailcutLeg({ ...g, cutEntries: { ...g.cutEntries, [which]: 0 } });
      expect(fails).toHaveLength(1);
      expect(fails[0]).toStartWith("TC: no PR-250 cut");
      expect(fails[0]).toContain(`TC-${which}`);
      // the evidence is the failing session's own, never the other's
      expect(fails[0]).toContain(`T0_RefusedFormat ${which}`);
      expect(fails[0]).not.toContain(`T0_RefusedFormat ${which === "off" ? "on" : "off"}`);
    }
  });

  // Red: drop the stable / unstable set comparison, or the `mutant <= 0` condition.
  test("(a2) a tail that did not run fails by name, quoting a 'not run' notice", () => {
    const g = green();
    const none = judgeTailcutLeg({ ...g, tailNotices: [] });
    expect(none[0]).toStartWith("TC: the tail route did not run");
    const skipped = judgeTailcutLeg({
      ...g,
      tailNotices: [
        "[lethal] al-runner-v3-refused-cut-tail: the stability pass was not run (a stop signal came), so no tail test is measured alone",
      ],
    });
    expect(skipped[0]).toStartWith("TC: the tail route did not run");
    expect(skipped[0]).toContain("stability pass was not run (a stop signal came)");
    expect(judgeTailcutLeg({ ...g, tailCalls: { stability: 5, mutant: 0 } })[0]).toStartWith(
      "TC: the tail route did not run",
    );
    // T4 read stable: the notice names the wrong sets
    const wrong = STABILITY.replace(
      "stable: T1_DoubleTwo, T2_IsBigTen, T3_SetsMark, T5_IsSmallOne; unstable: T4_SeesTheMark",
      "stable: T1_DoubleTwo, T2_IsBigTen, T3_SetsMark, T4_SeesTheMark, T5_IsSmallOne; unstable: none",
    );
    expect(judgeTailcutLeg({ ...g, tailNotices: [wrong] })[0]).toStartWith(
      "TC: the tail route did not run",
    );
  });

  // Red: skip the per-mutant table loop in judgeTailcutLeg.
  test("(b) one moved verdict or killer in any of the three sessions is named by session and site", () => {
    for (const s of TC_SESSIONS) {
      const moved = edited(s, (r) =>
        r.key === "Double lethal.empty-block"
          ? { ...r, verdict: "survived", killingTest: undefined as never }
          : r,
      );
      const fails = judgeTailcutLeg(moved);
      expect(fails.some((f) => f.startsWith(`${s}: Double lethal.empty-block`))).toBe(true);
      const wrongKiller = edited(s, (r) =>
        r.key === "Triple lethal.return-value" ? { ...r, killingTest: "T2_IsBigTen" } : r,
      );
      expect(
        judgeTailcutLeg(wrongKiller).some((f) => f.startsWith(`${s}: Triple lethal.return-value`)),
      ).toBe(true);
    }
  });

  // Red: remove the `rows.length !== TC_TABLE.length` guard.
  test("(b) an EXTRA row in a session's report is named by its count", () => {
    for (const s of TC_SESSIONS) {
      const g = green();
      const extra: TcRow = {
        procedureName: "Ghost",
        operatorName: "lethal.empty-block",
        verdict: "killed",
      };
      const fails = judgeTailcutLeg({ ...g, rows: { ...g.rows, [s]: [...g.rows[s], extra] } });
      expect(fails.some((f) => f.startsWith(`${s}: 11 mutants, pre-committed 10`))).toBe(true);
    }
  });

  // Red: remove the `rows.length !== 1` condition (the first row alone would match the table).
  test("(b) a DUPLICATE row for one site is named by that site", () => {
    for (const s of TC_SESSIONS) {
      const g = green();
      const [first] = g.rows[s];
      if (first === undefined) throw new Error("no rows");
      const fails = judgeTailcutLeg({ ...g, rows: { ...g.rows, [s]: [...g.rows[s], first] } });
      expect(
        fails.some((f) => f.startsWith(`${s}: ${first.procedureName} ${first.operatorName} is `)),
      ).toBe(true);
    }
  });

  // Red: drop the (c) block (the IsBig boundary: error under TC-on, never survived).
  test("(c) TC-on = TC-alone but for exactly IsBig's boundary mutant, which stays error", () => {
    const g = green();
    const survived = edited("TC-on", (r) =>
      r.key === "IsBig lethal.conditional-boundary" ? { ...r, verdict: "survived" } : r,
    );
    const fails = judgeTailcutLeg(survived);
    expect(fails.some((f) => f.startsWith("TC: TC-on differs from TC-alone at"))).toBe(true);
    expect(judgeTailcutLeg(g)).toEqual([]);
  });

  // (f). Red: drop the `notRunAtBaseline` check (undefined, empty, extra, another name, unqualified: each a direction).
  test("(f) notRunAtBaseline: absent, empty, extra or another name fails, per session, printing the field", () => {
    for (const s of TC_SESSIONS) {
      for (const bad of [
        undefined,
        [],
        [TC_NOT_RUN_TEST, "Tailcut Tests.T4_SeesTheMark"],
        ["Tailcut Tests.T4_SeesTheMark"],
        ["T0_RefusedFormat"],
      ]) {
        const fails = judgeTailcutLeg(withNotRun(s, { notRunAtBaseline: bad }));
        expect(fails).toHaveLength(1);
        expect(fails[0]).toStartWith(`TC: ${s} notRunAtBaseline is `);
        expect(fails[0]).toContain(bad === undefined ? "absent" : JSON.stringify(bad));
      }
    }
  });

  // Red: drop the caveat check; each direction: present where none is pinned, absent where one is, wrong counts.
  test("(f) the caveat: TC-off none, TC-on 1 / 1, TC-alone 2 / 1; each wrong reading fails with its counts", () => {
    const off = judgeTailcutLeg(withNotRun("TC-off", { caveat: { survivors: 1, notRunTests: 1 } }));
    expect(off).toEqual([
      expect.stringContaining(
        "TC: TC-off survivors-beside-unrun-tests is survivors 1, notRunTests 1, pre-committed absent",
      ),
    ]);
    for (const s of ["TC-on", "TC-alone"] as const) {
      const absent = judgeTailcutLeg(withNotRun(s, { caveat: undefined }));
      expect(absent).toEqual([
        expect.stringContaining(`TC: ${s} survivors-beside-unrun-tests is absent`),
      ]);
      const want = s === "TC-on" ? 1 : 2;
      for (const c of [
        { survivors: want + 1, notRunTests: 1 },
        { survivors: want, notRunTests: 2 },
      ]) {
        expect(judgeTailcutLeg(withNotRun(s, { caveat: c }))).toEqual([
          expect.stringContaining(
            `TC: ${s} survivors-beside-unrun-tests is survivors ${c.survivors}, notRunTests ${c.notRunTests}`,
          ),
        ]);
      }
    }
  });

  // Red: drop the (d) loop.
  test("(d) a tail kill without the note is named", () => {
    const fails = judgeTailcutLeg(
      edited("TC-on", (r) =>
        r.key === "IsSmall lethal.return-value" ? { ...r, killingTestFailure: "boom" } : r,
      ),
    );
    expect(fails).toEqual([
      expect.stringContaining("IsSmall lethal.return-value was killed without"),
    ]);
  });
});

describe("PR-347 leg TC: the fixture and the wiring", () => {
  test("the fixture's tests and logic have the spec's shape", () => {
    const logic = read("fixtures/sandbox-tailcut/src/TailcutLogic.Codeunit.al");
    for (const p of ["Triple", "Double", "IsBig", "IsSmall"])
      expect(logic).toContain(`procedure ${p}(`);
    const tests = read("fixtures/sandbox-tailcut-tests/src/TailcutTests.Codeunit.al");
    const order = [
      "G0_TripleTwo",
      "T0_RefusedFormat",
      "T1_DoubleTwo",
      "T2_IsBigTen",
      "T3_SetsMark",
      "T4_SeesTheMark",
      "T5_IsSmallOne",
    ].map((n) => tests.indexOf(`procedure ${n}(`));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > (order[k - 1] ?? 0)))).toBe(true);
    expect(tests).toContain("Format(8, 2, '<Integer,2>')");
    const t4 = tests.slice(
      tests.indexOf("procedure T4_SeesTheMark("),
      tests.indexOf("procedure T5_IsSmallOne("),
    );
    expect(t4).toContain("if Logic.IsBig(5) then");
    expect(tests).toContain("Logic.IsSmall(1)");
    // Review S2: (f)'s pinned name is the fixture's own codeunit and procedure, so a rename fails here, not only live.
    expect(tests).toContain('codeunit 76150 "Tailcut Tests"');
    expect(TC_NOT_RUN_TEST).toBe(`${"Tailcut Tests"}.${"T0_RefusedFormat"}`);
    for (const d of ["sandbox-tailcut", "sandbox-tailcut-tests"])
      expect(JSON.parse(read(`fixtures/${d}/app.json`)).runtime).toBe("17.0");
  });

  test("TC is a default leg, its baseline is recorded (R849) and the leg refuses to start without it", () => {
    expect(V3_TC_LEG).toBe("TC");
    expect(PENDING_FIRST_RECORD).not.toContain("al-runner-v3.tailcut.baseline.json");
    // R332/R849: recorded once by the gate, equal per mutant to the pre-committed expected file (built from TC_TABLE),
    // which R849 then requires deleted as stale. So the record is held to TC_TABLE's TC-on column here.
    const recorded = JSON.parse(read("packages/runner/itest/al-runner-v3.tailcut.baseline.json"));
    const tally = (rows: readonly { verdict: string; killingTest: string | null }[]) =>
      rows.map((r) => `${r.verdict}/${r.killingTest ?? "-"}`).sort();
    expect(recorded.entries).toHaveLength(TC_TABLE.length);
    expect(tally(recorded.entries)).toEqual(
      tally(
        TC_TABLE.map((s) => ({
          verdict: s.expect["TC-on"].verdict,
          killingTest: s.expect["TC-on"].killingTest ?? null,
        })),
      ),
    );
    expect(read("packages/runner/itest/al-runner-v3.itest.ts")).toContain(
      'preflightGateBaseline(TAILCUT_BASELINE_PATH, "al-runner-v3 itest leg TC")',
    );
  });

  test("the three warning keys", () => {
    expect(
      Object.keys(GATE_WARNINGS)
        .filter((k) => k.includes("/TC-"))
        .sort(),
    ).toEqual(["al-runner-v3/TC-alone", "al-runner-v3/TC-off", "al-runner-v3/TC-on"]);
  });

  // Red: remove `refusedCutTail: false` from legRC's make().
  test("RC pins the flag off, explicitly; TC's off session passes false and its alone session isolates", () => {
    const itest = read("packages/runner/itest/al-runner-v3.itest.ts");
    const rc = itest.slice(
      itest.indexOf("async function legRC"),
      itest.indexOf("PR-347, leg TC:"), // the doc comment of legTC, which also says `refusedCutTail: false`
    );
    expect(itest.indexOf("PR-347, leg TC:")).toBeGreaterThan(itest.indexOf("async function legRC"));
    expect(rc).toContain("refusedCutTail: false");
    const tc = itest.slice(
      itest.indexOf("async function legTC"),
      itest.indexOf("const MOE_WRE_PINS"),
    );
    expect(tc).toContain('name === "TC-off" ? { refusedCutTail: false }');
    expect(tc).toContain('name === "TC-alone" ? { isolateTests: true }');
    expect(tc).toContain("judgeTailcutLeg(");
    const branch = itest.slice(itest.indexOf("leg === V3_TC_LEG"));
    expect(branch.indexOf("await legTC(scratch)")).toBeLessThan(
      branch.indexOf("assertGateBaseline("),
    );
  });
});
