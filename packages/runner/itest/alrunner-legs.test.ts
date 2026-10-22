import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionReport } from "../src/report";
import {
  ALRUNNER_LEG_IDS,
  GROUP_NAMES,
  GateArgsRefusal,
  type GroupName,
  type LegId,
  LegRunner,
  type WorkerResult,
  combineWorkers,
  exitCodeFor,
  finalLine,
  fullRunSublegs,
  groupLegs,
  groupRanFailures,
  isFullRun,
  parallelVersionRefusal,
  parseGateArgs,
  resolveGroups,
  scheduleOrder,
  throwCollected,
  workerEnv,
} from "./alrunner-legs";

const ALL: readonly string[] = [
  "sandbox-a",
  "sandbox-b",
  "sandbox-server",
  "sandbox-resource",
  "cli-default",
  "layout-one-shot",
  "layout-server",
  "multiobject-one-shot",
  "multiobject-server",
  "multiobject-resource",
  "wrapped-one-shot",
  "wrapped-server",
  "wrapped-resource",
  "names-a1",
  "names-a2",
  "names-a3",
  "names-a4",
  "symbols-lethala-one-shot",
  "symbols-lethala-server",
  "symbols-lethala-resource",
  "symbols-lethalb-one-shot",
  "symbols-lethalb-server",
  "symbols-lethalb-resource",
];

/** The 17 names the receipt carried before R-587. */
const OLD_17 = [
  "one-shot",
  "server",
  "resource",
  "platform-pin",
  "layout-one-shot",
  "layout-server",
  "multiobject-one-shot",
  "multiobject-server",
  "multiobject-resource",
  "wrapped-one-shot",
  "wrapped-server",
  "wrapped-resource",
  "names-one-shot-al-runner",
  "names-one-shot-none",
  "names-server-al-runner",
  "names-server-none",
  "cli-default",
];

const report = (n: number) =>
  ({ mutants: Array.from({ length: n }, () => ({})) }) as unknown as SessionReport;

describe("the registry", () => {
  test("the 23 ids, pinned literally, unique, in run order", () => {
    expect([...ALRUNNER_LEG_IDS] as string[]).toEqual([...ALL]);
    expect(new Set(ALRUNNER_LEG_IDS).size).toBe(23);
  });

  test("the seven groups, and each id belongs to exactly one", () => {
    expect([...GROUP_NAMES]).toEqual([
      "sandbox",
      "layout",
      "multiobject",
      "wrapped",
      "names",
      "symbols-lethala",
      "symbols-lethalb",
    ]);
    expect(GROUP_NAMES.flatMap((g) => groupLegs(g))).toEqual([...ALRUNNER_LEG_IDS]);
  });

  test("every id is named in al-runner.itest.ts exactly once (the leg(...) call, or the symbol ids)", () => {
    // An unwired id makes a full PASS impossible (fails safe); this catches a wired-twice id and
    // names the drift. A typo cannot compile: `leg` takes a `LegId`.
    const src = readFileSync(join(import.meta.dir, "al-runner.itest.ts"), "utf8");
    for (const id of ALRUNNER_LEG_IDS) {
      const n =
        src.match(new RegExp(`(?:legs\\.leg\\(\\s*|(?:oneShot|server|resource): )"${id}"`, "g"))
          ?.length ?? 0;
      expect({ id, n }).toEqual({ id, n: 1 });
    }
  });

  test("I-2 wiring: the 15 leg calls of the collecting groups pass `failures`; 5 groups end in throwCollected", () => {
    // 18 legs: layout 2, multiobject 3, wrapped 3, names 4, and 3 call sites that run both symbol
    // sets. The sandbox group (5 legs) asserts directly, so a failed check there throws out of the leg.
    const src = readFileSync(join(import.meta.dir, "al-runner.itest.ts"), "utf8");
    expect(src.match(/[)}],\s*failures,?\s*\)/g)?.length ?? 0).toBe(15);
    expect(src.match(/throwCollected\("/g)?.length ?? 0).toBe(5);
    expect(src).not.toMatch(
      /if \(failures\.length > 0\) \{\n\s*throw new Error\(\n\s*`R(321|353|407|-300b|557):/,
    );
  });

  test("scheduleOrder is longest first, filtered to the selection", () => {
    expect(scheduleOrder(GROUP_NAMES)).toEqual([
      "wrapped",
      "names",
      "sandbox",
      "symbols-lethala",
      "symbols-lethalb",
      "multiobject",
      "layout",
    ]);
    expect(scheduleOrder(["layout", "wrapped"])).toEqual(["wrapped", "layout"]);
  });

  test("a group SCHEDULE does not name is a failure, never silently not started", () => {
    expect(() => scheduleOrder(["layout", "brand-new" as GroupName])).toThrow(
      /brand-new missing from SCHEDULE/,
    );
  });
});

describe("resolveGroups", () => {
  test("a group name gives that group; duplicates collapse; registry order", () => {
    expect(resolveGroups("names,layout,names")).toEqual(["layout", "names"]);
    expect(groupLegs("layout")).toEqual(["layout-one-shot", "layout-server"]);
  });

  test("a leg id, an unknown name or an empty list throws, listing the groups", () => {
    expect(() => resolveGroups("layout-server")).toThrow(
      /unknown group.*layout-server.*sandbox, layout/,
    );
    expect(() => resolveGroups("nope")).toThrow(/the groups are: sandbox/);
    expect(() => resolveGroups(" , ")).toThrow(/empty.*sandbox/);
  });
});

describe("what a run proves", () => {
  test("only exactly the 23 ids are a full run", () => {
    expect(isFullRun(ALL)).toBe(true);
    expect(isFullRun(ALL.slice(1))).toBe(false);
    expect(isFullRun([...ALL.slice(1), "sandbox-b"])).toBe(false);
    expect(isFullRun([...ALL.slice(1), "platform-pin"])).toBe(false);
    expect(isFullRun(OLD_17)).toBe(false);
  });

  test("fullRunSublegs returns the ids for a full run and throws otherwise", () => {
    expect(fullRunSublegs([...ALL].reverse())).toEqual(ALRUNNER_LEG_IDS);
    expect(() => fullRunSublegs(ALL.slice(0, 22))).toThrow(/ran 22/);
  });

  test("full: PASS and 0; partial: never PASS, says green, and 4", () => {
    expect(finalLine(ALL)).toBe("al-runner itest: PASS");
    expect(exitCodeFor(ALL)).toBe(0);
    const layout = ["layout-server", "layout-one-shot"];
    expect(finalLine(layout)).toBe(
      "al-runner itest: PARTIAL, 2 of 23 legs ran green (layout-one-shot, layout-server); NOT a gate pass, run without --legs for submit and merge",
    );
    expect(finalLine(ALL.slice(1))).not.toMatch(/itest: PASS/);
    expect(exitCodeFor(layout)).toBe(4);
  });

  test("groupRanFailures: a group must run exactly its own legs", () => {
    expect(groupRanFailures("layout", ["layout-one-shot", "layout-server"])).toEqual([]);
    expect(groupRanFailures("layout", ["layout-one-shot"]).join()).toContain(
      "not run: layout-server",
    );
    expect(
      groupRanFailures("layout", ["layout-one-shot", "layout-server", "sandbox-a"]).join(),
    ).toContain("another group: sandbox-a");
  });
});

describe("LegRunner (B1)", () => {
  const quiet = { log: () => {} };

  test("an unselected leg is never called and never ran", async () => {
    const r = new LegRunner(new Set<LegId>(["layout-server"]), quiet);
    let called = false;
    await expect(
      r.leg("layout-one-shot", async () => {
        called = true;
        return report(1);
      }),
    ).rejects.toThrow(/not selected/);
    expect(called).toBe(false);
    expect(r.ran).toEqual([]);
  });

  test("a leg that throws is not ran", async () => {
    const r = new LegRunner(new Set<LegId>(["layout-server"]), quiet);
    await expect(
      r.leg("layout-server", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(r.ran).toEqual([]);
  });

  test("a report with no mutant is not ran", async () => {
    const r = new LegRunner(new Set<LegId>(["layout-server"]), quiet);
    await expect(r.leg("layout-server", async () => report(0))).rejects.toThrow(/no mutant/);
    expect(r.ran).toEqual([]);
  });

  test("a passing leg is ran, after onDone, with start and done lines", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    const clock = [1000, 2500];
    const r = new LegRunner(new Set<LegId>(["layout-server"]), {
      log: (l) => lines.push(l),
      now: () => clock.shift() ?? 0,
      onDone: (id) => {
        seen.push(`${id} ran=${r.ran.length}`);
      },
    });
    await r.leg("layout-server", async () => report(2));
    expect(r.ran).toEqual(["layout-server"]);
    expect(seen).toEqual(["layout-server ran=0"]);
    expect(lines).toEqual(["leg layout-server: start", "leg layout-server: done in 1.5s"]);
  });

  test("I-2: a leg whose group's collected failures grew is not recorded, but returns its report", async () => {
    const lines: string[] = [];
    const written: string[] = [];
    const r = new LegRunner(new Set<LegId>(["layout-one-shot", "layout-server"]), {
      log: (l) => lines.push(l),
      onDone: (id) => {
        written.push(id);
      },
    });
    const failures: string[] = ["an earlier leg's failure"];
    const one = await r.leg("layout-one-shot", async () => report(1), failures);
    const two = await r.leg(
      "layout-server",
      async () => {
        failures.push("layout --server vs one-shot: differs");
        return report(2);
      },
      failures,
    );
    expect(one.mutants).toHaveLength(1);
    expect(two.mutants).toHaveLength(2);
    // A failure from before the leg does not count against it; one during it does.
    expect(r.ran).toEqual(["layout-one-shot"]);
    expect(written).toEqual(["layout-one-shot"]);
    expect(lines).toContain("leg layout-server: FAILED 1 check(s); not recorded");
    expect(lines.some((l) => l.startsWith("leg layout-server: done"))).toBe(false);
    // So even if the group-end throw were dropped, the group fails on its own record.
    expect(groupRanFailures("layout", r.ran).join()).toContain("not run: layout-server");
  });

  test("throwCollected: the group-end throw names its label and every failure, and only then", () => {
    expect(() => throwCollected("R353", "layout-leg", [])).not.toThrow();
    expect(() => throwCollected("R353", "layout-leg", ["a", "b"])).toThrow(
      "R353: 2 layout-leg check(s) failed:\n  - a\n  - b",
    );
  });

  test("after stop(), the next leg throws without starting", async () => {
    const r = new LegRunner(new Set<LegId>(["layout-server"]), quiet);
    r.stop("SIGTERM");
    let called = false;
    await expect(
      r.leg("layout-server", async () => {
        called = true;
        return report(1);
      }),
    ).rejects.toThrow(/not started: SIGTERM/);
    expect(called).toBe(false);
  });
});

describe("parseGateArgs", () => {
  const N = "a".repeat(32);
  const gate = {
    LETHAL_GATE_NONCE: "n",
    LETHAL_GATE_SHA: "s",
    LETHAL_GATE_GENERATION: "1",
    LETHAL_GATE_RECEIPT: "/r",
  };

  test("no arguments is the full sequential run", () => {
    expect(parseGateArgs([], {})).toEqual({ worker: false });
  });

  test("accepted forms", () => {
    expect(parseGateArgs(["--legs", "layout,names", "--parallel=2"], {})).toEqual({
      groups: ["layout", "names"],
      parallel: 2,
      worker: false,
    });
    expect(parseGateArgs(["--parallel"], {}).parallel).toBe(3);
    expect(parseGateArgs(["--parallel"], gate).parallel).toBe(3);
    expect(parseGateArgs(["--reports=/x"], {}).reports).toBe("/x");
    expect(
      parseGateArgs(["--worker", "--legs", "layout", "--reports", "/x", "--nonce", N], {}),
    ).toEqual({ groups: ["layout"], reports: "/x", worker: true, nonce: N });
  });

  const refused = (argv: string[], env: Record<string, string> = {}) =>
    expect(() => parseGateArgs(argv, env)).toThrow(GateArgsRefusal);

  test("each refusal", () => {
    refused(["--bogus"]);
    refused(["layout"]);
    refused(["--legs"]);
    refused(["--legs", ""]);
    refused(["--legs", "layout-server"]);
    refused(["--parallel=0"]);
    refused(["--parallel=4"]);
    refused(["--parallel=x"]);
    expect(() => parseGateArgs(["--parallel", "3"], {})).toThrow(/write --parallel=3/);
    refused(["--worker", "--reports", "/x", "--nonce", N]);
    refused(["--worker", "--legs", "layout,names", "--reports", "/x", "--nonce", N]);
    refused(["--worker", "--legs", "layout", "--nonce", N]);
    refused(["--worker", "--legs", "layout", "--reports", "/x"]);
    refused(["--worker", "--legs", "layout", "--reports", "/x", "--nonce", "short"]);
    refused(["--worker", "--legs", "layout", "--reports", "/x", "--nonce", N, "--parallel=2"]);
    refused(["--worker", "--legs", "layout", "--reports", "/x", "--nonce", N], {
      LETHAL_GATE_NONCE: "n",
    });
    refused(["--nonce", N]);
    refused(["--legs", "layout"], gate);
    refused(["--legs", "layout"], { LETHAL_ITEST_RECORD_BASELINE: "al-runner.baseline.json" });
    refused(["--parallel"], { LETHAL_ITEST_RECORD_SYMBOL_BASELINES: "1" });
  });

  test("--legs without a challenge is accepted, and a record run without --legs is", () => {
    expect(parseGateArgs(["--legs", "layout"], {}).groups).toEqual(["layout"]);
    expect(parseGateArgs([], { LETHAL_ITEST_RECORD_BASELINE: "x" })).toEqual({ worker: false });
  });
});

describe("workerEnv", () => {
  test("strips the four receipt keys, keeps the rest, pins the al-runner realpath", () => {
    const env = workerEnv(
      {
        LETHAL_GATE_NONCE: "n",
        LETHAL_GATE_SHA: "s",
        LETHAL_GATE_GENERATION: "1",
        LETHAL_GATE_RECEIPT: "/r",
        LETHAL_ITEST_ALRUNNER: "1",
        LETHAL_ALRUNNER_PATH: "/tools/current/al-runner",
        PATH: "/bin",
      },
      "/tools/f06ee78c/al-runner",
    );
    expect(env).toEqual({
      LETHAL_ITEST_ALRUNNER: "1",
      LETHAL_ALRUNNER_PATH: "/tools/f06ee78c/al-runner",
      PATH: "/bin",
    });
  });
});

describe("parallelVersionRefusal (M8)", () => {
  test("a source build is allowed; a release at or below 2.12.0 is refused", () => {
    expect(parallelVersionRefusal("al-runner v2.12.0-main.f06ee78c")).toBeUndefined();
    expect(parallelVersionRefusal("al-runner v2.13.0")).toBeUndefined();
    expect(parallelVersionRefusal("al-runner v3.0.0")).toBeUndefined();
    expect(parallelVersionRefusal("al-runner v2.12.0")).toMatch(/R345/);
    expect(parallelVersionRefusal("2.11.0.0")).toMatch(/R345/);
    expect(parallelVersionRefusal("al-runner v1.9.9")).toMatch(/R345/);
    expect(parallelVersionRefusal("no version here")).toMatch(/cannot read/);
  });
});

describe("combineWorkers (B2, I2, I4)", () => {
  const nonce = "b".repeat(32);
  const buildLine = "al-runner v2.12.0-main.f06ee78c";
  const done = (group: string, ran: readonly string[], over: Record<string, unknown> = {}) => ({
    runNonce: nonce,
    group,
    ran,
    buildLine,
    ...over,
  });
  const ok = (group: "layout" | "names"): WorkerResult => ({
    group,
    exitCode: 4,
    signal: null,
    done: done(group, groupLegs(group)),
  });

  test("every worker exited 4 with a good done-file: their legs ran, no failure", () => {
    const c = combineWorkers([ok("names"), ok("layout")], { nonce, buildLine });
    expect(c.failures).toEqual([]);
    expect(c.ran).toEqual([...groupLegs("layout"), ...groupLegs("names")]);
  });

  const failsNaming = (r: WorkerResult, pattern: RegExp, extra: { interrupted?: string } = {}) => {
    const c = combineWorkers([ok("names"), r], { nonce, buildLine, ...extra });
    expect(c.failures.join("\n")).toMatch(pattern);
    expect(c.ran).toEqual([...groupLegs("names")]);
  };

  test("each wrong outcome fails, naming the group, and its legs do not count", () => {
    failsNaming({ ...ok("layout"), exitCode: 0 }, /worker layout: exited 0/);
    failsNaming({ ...ok("layout"), exitCode: 1 }, /worker layout: exited 1/);
    failsNaming(
      { ...ok("layout"), exitCode: null, signal: "SIGKILL" },
      /worker layout: killed by SIGKILL/,
    );
    failsNaming(
      { group: "layout", exitCode: 4, signal: null },
      /worker layout: wrote no layout.done.json/,
    );
    failsNaming(
      { ...ok("layout"), done: done("layout", groupLegs("layout"), { runNonce: "c".repeat(32) }) },
      /worker layout: done-file nonce/,
    );
    failsNaming({ ...ok("layout"), done: done("names", groupLegs("layout")) }, /names group names/);
    failsNaming(
      { ...ok("layout"), done: done("layout", groupLegs("layout"), { buildLine: "other" }) },
      /worker layout: ran al-runner "other"/,
    );
    failsNaming(
      { ...ok("layout"), done: done("layout", ["layout-one-shot"]) },
      /not run: layout-server/,
    );
  });

  test("an interrupted run fails even when every worker reported green", () => {
    const c = combineWorkers([ok("layout")], { nonce, buildLine, interrupted: "SIGINT" });
    expect(c.failures.join()).toMatch(/interrupted by SIGINT/);
  });
});
