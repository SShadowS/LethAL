// R766 step (b): the lanes of AlRunnerV3Backend. N serve lanes in one backend: lane 0 reads `active/`,
// lane k reads a copy `active.<k>/`, each with its own daemon, cwd and per-mutant state; the owner keeps
// deploy, the proof, the shared prefetch and `close`. Fakes only; call counters, no timing.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AlRunnerV3Backend,
  AlRunnerV3UnprovenBatchError,
  LANE_MIN_AVAILABLE_BYTES,
} from "../src/al-runner-v3-backend";
import { hashAlTree } from "../src/baseline-snapshot";
import {
  A,
  B,
  type FakeRow,
  OPTS,
  SLEEPER_AL,
  SUITE,
  type RowsFn,
  allPass,
  cleanRigs,
  laneBaseline,
  lanesRig,
} from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const plans = (ids: readonly string[]) => ids.map((mutantId) => ({ mutantId, refs: SUITE }));
const failing = (rows: FakeRow[], method: string, message: string): FakeRow[] =>
  rows.map((r) => (r.method === method ? { ...r, status: "fail" as const, message } : r));
/** The lane a request was sent for, from the tree it names. */
const laneOf = (active: string): number => {
  const m = /\/active(?:\.(\d+))?$/.exec(active.replace(/\\/g, "/"));
  if (m === null) throw new Error(`not a lane tree: ${active}`);
  return m[1] === undefined ? 0 : Number(m[1]);
};

describe("lanes(N): the guards", () => {
  test("N must be an integer of 2 or more, once, and before the first deploy", async () => {
    const r = await lanesRig({ lanes: 0 });
    expect(() => r.b.lanes(1)).toThrow(/al-runner-v3-lane-misuse: lanes\(1\)/);
    expect(() => r.b.lanes(2.5)).toThrow(/al-runner-v3-lane-misuse/);
    // The rig deployed already: lanes() after a deploy is refused by name.
    expect(() => r.b.lanes(2)).toThrow(/before the first deploy/);
    const fresh = new AlRunnerV3Backend({
      alRunnerPath: "x",
      instrumentedDir: "/tmp/x",
      testDir: "/tmp/t",
      packagesDir: "/tmp/p",
      bcVersion: "28.0.1.1",
      selectorObjectId: 1,
      alcPath: "a",
      transport: "serve-entries",
    });
    expect(fresh.lanes(3)).toHaveLength(3);
    expect(() => fresh.lanes(3)).toThrow(/already called/);
  });

  test("once lanes exist, the root's per-mutant methods throw by name", async () => {
    const r = await lanesRig({ lanes: 2 });
    await expect(r.b.activate(null)).rejects.toThrow(/lane-misuse: activate\(\)/);
    await expect(r.b.run(A, OPTS)).rejects.toThrow(/lane-misuse: run\(\)/);
    await expect(r.b.sendKillPair("M0001", A)).rejects.toThrow(/lane-misuse: sendKillPair\(\)/);
    expect(() => r.b.useCoveringBudgets("M0001", [])).toThrow(/lane-misuse: useCoveringBudgets/);
    expect(() => r.b.survivorNote([A])).toThrow(/lane-misuse: survivorNote/);
  });

  test("owner-only methods throw by name on a lane view; the delegated getters work", async () => {
    const r = await lanesRig({ lanes: 2 });
    const v = r.views[1];
    if (v === undefined) throw new Error("no lane 1");
    const owner: Array<[string, () => unknown]> = [
      ["deploy", () => v.deploy("x")],
      ["compileCheck", () => v.compileCheck("x")],
      ["compilePlainCheck", () => v.compilePlainCheck?.("x")],
      ["setNotify", () => v.setNotify?.()],
      ["decideTransport", () => v.decideTransport?.({ resume: false })],
      ["useDiscoveredTests", () => v.useDiscoveredTests?.([])],
      ["useSessionTests", () => v.useSessionTests?.([], [])],
      ["useMutantBudgetFloor", () => v.useMutantBudgetFloor?.(1, 1)],
      ["useBuildSymbols", () => v.useBuildSymbols([])],
      ["baselinePhase", () => v.baselinePhase?.(true)],
      ["noteReusedBaseline", () => v.noteReusedBaseline?.([])],
      ["prefetchMutants", () => v.prefetchMutants?.([])],
      ["status", () => v.status()],
      ["close", () => v.close()],
    ];
    for (const [name, call] of owner) {
      expect(call, name).toThrow(new RegExp(`lane-misuse: ${name}\\(\\) is owner-only`));
    }
    expect(v.laneIndex).toBe(1);
    expect(v.capabilities().kind).toBe("al-runner-v3");
    expect(v.killsMustReproduce).toBe(true);
    expect(v.inRunStopIsBudget).toBe(false);
    expect(v.inRunStopMs).toBe(1000);
    expect(v.dependencyPackageDirs?.()).toEqual(r.b.dependencyPackageDirs());
  });
});

describe("lane trees and daemons", () => {
  test("deploy copies the proved tree to active.<k>/ with its timestamps; each lane has its own cwd", async () => {
    const r = await lanesRig({ lanes: 3 });
    const want = await hashAlTree(join(r.scratch, "active"));
    const srcM = (await stat(join(r.scratch, "active", "Logic.Codeunit.al"))).mtimeMs;
    for (const k of [1, 2]) {
      const dir = join(r.scratch, `active.${k}`);
      expect(await hashAlTree(dir)).toBe(want);
      const m = (await stat(join(dir, "Logic.Codeunit.al"))).mtimeMs;
      expect(Math.abs(m - srcM)).toBeLessThan(2);
    }
    for (const k of [0, 1, 2]) expect(existsSync(join(r.scratch, `daemon-${k}`))).toBe(true);
    await laneBaseline(r);
    for (const [k, v] of r.views.entries()) {
      await v.activate("M0001");
      await v.run(A, OPTS);
      expect(k).toBe(v.laneIndex);
    }
    // Daemon d was started for the lane whose tree its requests name, in that lane's own cwd.
    const lanesSeen = new Map<number, number>();
    for (const q of r.serve.requests) lanesSeen.set(q.daemon, laneOf(q.active));
    expect([...lanesSeen.values()].sort()).toEqual([0, 1, 2]);
    for (const [d, k] of lanesSeen) {
      expect(r.serve.cwds[d]).toBe(join(resolve(r.scratch), `daemon-${k}`));
    }
  });

  test("a lane never touches another's tree: every request of a daemon names one tree, the lane's own", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    const real = async (k: number) =>
      realpath(join(r.scratch, k === 0 ? "active" : `active.${k}`));
    for (const v of r.views) {
      await v.activate("M0002");
      await v.run(A, OPTS);
      await v.run(B, OPTS);
    }
    const perDaemon = new Map<number, Set<string>>();
    for (const q of r.serve.requests) {
      perDaemon.set(q.daemon, (perDaemon.get(q.daemon) ?? new Set()).add(q.active));
    }
    expect(perDaemon.size).toBe(3);
    const lanes: number[] = [];
    for (const [, trees] of perDaemon) {
      expect(trees.size).toBe(1);
      const only = [...trees][0] ?? "";
      expect(only).toBe(await real(laneOf(only)));
      lanes.push(laneOf(only));
    }
    // Three daemons, three different trees: none shares another lane's `active.<k>/`.
    expect(lanes.sort()).toEqual([0, 1, 2]);
  });

  test("the bound check is the lane's own: a change in active.1/ stops lane 1 only, by name", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    await writeFile(join(r.scratch, "active.1", "Extra.Codeunit.al"), "codeunit 1 x { }");
    const [v0, v1, v2] = r.views;
    if (v0 === undefined || v1 === undefined || v2 === undefined) throw new Error("lanes");
    await v1.activate("M0001");
    const err = await v1.run(A, OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlRunnerV3UnprovenBatchError);
    expect(String(err)).toContain("active.1");
    for (const v of [v0, v2]) {
      await v.activate("M0001");
      expect((await v.run(A, OPTS)).outcome).toBe("pass");
    }
  });

  test("a lane copy that is not the proved tree refuses the deploy by name", async () => {
    await expect(
      lanesRig({
        lanes: 2,
        afterLaneCopy: (dir) => writeFile(join(dir, "Logic.Codeunit.al"), "codeunit 79000 x { }"),
      }),
    ).rejects.toThrow(/lane 1's copy .*active\.1 is not the tree alc proved/);
  });
});

describe("per-lane state", () => {
  test("`plan` is per lane: lane 1's covering budgets do not change lane 0's state note", async () => {
    const rows: RowsFn = (m, _cu, _d, _n) =>
      m === "M0001" || m === "M0002" ? failing(allPass(m, 0, 0, 0), "B", "boom") : allPass(m, 0, 0, 0);
    const r = await lanesRig({ lanes: 2, rows });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    v0.useCoveringBudgets("M0001", [
      { ref: A, budgetMs: 1000 },
      { ref: B, budgetMs: 1000 },
    ]);
    v1.useCoveringBudgets("M0002", [{ ref: B, budgetMs: 1000 }]);
    await v0.activate("M0001");
    await v1.activate("M0002");
    await v0.run(A, OPTS);
    const k0 = await v0.run(B, OPTS);
    await v1.run(A, OPTS);
    const k1 = await v1.run(B, OPTS);
    expect(k0.outcome).toBe("fail");
    expect(k0.backendNote).toContain("ran after covering test(s) A");
    // Lane 1's plan holds B only, so A is not a "covering test that ran before it" there.
    expect(k1.outcome).toBe("fail");
    expect(k1.backendNote).toBeUndefined();
  });

  test("the shared prefetch runs once on lane 0 with the N = 1 grouping, and any lane consumes a mutant's rows once", async () => {
    const r = await lanesRig({ lanes: 2 });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    await r.b.prefetchMutants(plans(["M0001", "M0002", "M0003"]));
    // One request on lane 0's daemon after its warm-up, all three mutants in it.
    expect(r.serve.requests.map((q) => [laneOf(q.active), q.mutants])).toEqual([
      [0, ["NONE"]],
      [0, ["M0001", "M0002", "M0003"]],
    ]);
    const n0 = r.serve.requests.length;
    await v1.activate("M0002");
    expect((await v1.run(A, OPTS)).outcome).toBe("pass");
    // Lane 1 used lane 0's prefetch: no request, and no daemon of its own.
    expect(r.serve.requests.length).toBe(n0);
    expect(r.serve.daemons.length).toBe(1);
    // Consumed once: the same mutant on lane 0 now runs live.
    await v0.activate("M0002");
    await v0.run(A, OPTS);
    expect(r.serve.requests.length).toBe(n0 + 1);
    expect(r.serve.requests.at(-1)?.mutants).toEqual(["M0002"]);
  });

  test("a kill pair is the lane's own: another lane's activity does not drop it", async () => {
    const rows: RowsFn = (m) => (m === "M0001" ? failing(allPass(m, 0, 0, 0), "A", "boom") : allPass(m, 0, 0, 0));
    const r = await lanesRig({ lanes: 2, rows });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    await r.b.prefetchMutants(plans(["M0001"]));
    await v0.activate("M0001");
    expect((await v0.run(A, OPTS)).outcome).toBe("fail");
    await v0.sendKillPair("M0001", A);
    // Lane 1 works in between (activate(null) and a run both reach `dropPair`).
    await v1.activate(null);
    expect((await v1.run(B, OPTS)).outcome).toBe("pass");
    const n1 = r.serve.requests.length;
    await v0.activate(null);
    expect((await v0.run(A, OPTS)).outcome).toBe("pass"); // the confirm, from the pair
    await v0.activate("M0001");
    expect((await v0.run(A, OPTS)).outcome).toBe("fail"); // the reproduction, from the pair
    expect(r.serve.requests.length).toBe(n1);
    expect(r.b.entriesStats().pairRequests).toBe(1);
  });

  test("a lane-scoped server error: lane 0's pair verdict is served to lane 0 only", async () => {
    const rows: RowsFn = (m) => (m === "M0001" ? failing(allPass(m, 0, 0, 0), "A", "boom") : allPass(m, 0, 0, 0));
    const r = await lanesRig({
      lanes: 2,
      rows,
      // The pair request (NONE's echo and M0001's echo in one request) gets an end of stream.
      serve: { eofAt: (_n, req) => req.ids.includes("NONE|echo") && req.ids.includes("M0001|echo") },
    });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    await r.b.prefetchMutants(plans(["M0001"]));
    await v0.activate("M0001");
    expect((await v0.run(A, OPTS)).outcome).toBe("fail");
    await v0.sendKillPair("M0001", A);
    // Lane 1's own confirm is an ordinary live pass: the stored server error is not its.
    await v1.activate(null);
    expect((await v1.run(A, OPTS)).outcome).toBe("pass");
    await v0.activate(null);
    const confirm = await v0.run(A, OPTS);
    expect(confirm.outcome).toBe("error");
    expect(confirm.operation).toBe("pre-dispatch-rejected");
    expect(confirm.failureMessage).toContain("transport failure");
  });

  test("a latch names the mutant on the lane that hit it; the first latch stands", async () => {
    // Lane 1's daemon (the second one started) disagrees with the baseline on NONE: its warm-up is refused.
    const rows: RowsFn = (m, _cu, d) =>
      m === "NONE" && d === 1 ? failing(allPass(m, 0, 0, 0), "B", "disagrees") : allPass(m, 0, 0, 0);
    const r = await lanesRig({ lanes: 2, rows });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    await v0.activate("M0001");
    await v0.run(A, OPTS); // lane 0's daemon is daemon 0: fine
    expect(r.b.latched()).toBeUndefined();
    await v1.activate("M0002");
    const v = await v1.run(A, OPTS);
    expect(v.operation).toBe("pre-dispatch-rejected");
    expect(r.b.latched()?.mutantId).toBe("M0002");
    expect(v0.latched()?.mutantId).toBe("M0002");
    // A later latch on another mutant does not replace it.
    await v0.activate("M0003");
    await v0.run(A, OPTS);
    expect(r.b.latched()?.mutantId).toBe("M0002");
  });

  test("the §6 Sleep window is never opened on a lane: a pass under a mutant with a Sleep index throws by name", async () => {
    const r = await lanesRig({ lanes: 2, targetAl: SLEEPER_AL });
    await laneBaseline(r);
    const v1 = r.views[1];
    if (v1 === undefined) throw new Error("lanes");
    await v1.activate("M0001");
    await expect(v1.run(A, OPTS)).rejects.toThrow(/lane-misuse: a pass under a mutant reached the §6/);
  });
});

describe("closing", () => {
  test("deploy and close shut every lane's daemon", async () => {
    const r = await lanesRig({ lanes: 3 });
    await laneBaseline(r);
    for (const v of r.views) {
      await v.activate("M0001");
      await v.run(A, OPTS);
    }
    expect(r.serve.daemons.length).toBe(3);
    expect(r.serve.closes).toEqual([]);
    await r.b.deploy(r.batch);
    expect([...r.serve.closes].sort()).toEqual([0, 1, 2]);
    // A lane that starts again after the re-deploy gets a new daemon; close() shuts it.
    await laneBaseline(r);
    const v2 = r.views[2];
    if (v2 === undefined) throw new Error("lanes");
    await v2.activate("M0002");
    await v2.run(A, OPTS);
    expect(r.serve.daemons.length).toBe(4);
    await r.b.close();
    expect([...r.serve.closes].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("the parallel gate: refusals and the memory hold", () => {
  const mk = (transport: "one-shot" | "serve-entries") =>
    new AlRunnerV3Backend({
      alRunnerPath: "x",
      instrumentedDir: "/tmp/x",
      testDir: "/tmp/t",
      packagesDir: "/tmp/p",
      bcVersion: "28.0.1.1",
      selectorObjectId: 1,
      alcPath: "a",
      transport,
    });

  test("serve-entries on a build that does not retire the §6 Sleep rule is refused by name (master: always)", () => {
    const b = mk("serve-entries");
    expect(b.sleepRuleRetiredForParallel()).toBe(false);
    expect(b.parallelRefusal()).toBe(
      "al-runner-v3-workers-refused: parallel v3 needs a build whose pin retires the §6 Sleep rule (R766, R768)",
    );
  });

  test("serve-entries on a retired build is allowed", () => {
    const b = mk("serve-entries");
    b.seams.sleepRuleRetired = true;
    expect(b.parallelRefusal()).toBeUndefined();
  });

  test("any transport but serve-entries is refused by name, retired or not", () => {
    const b = mk("one-shot");
    for (const retired of [false, true]) {
      b.seams.sleepRuleRetired = retired;
      expect(b.parallelRefusal()).toMatch(/al-runner-v3-workers-refused: --workers > 1 needs the serve-entries transport/);
    }
  });

  test("a lane beyond lane 0 starts only with 10 GB available; the hold is said once", () => {
    const b = mk("serve-entries");
    let avail = LANE_MIN_AVAILABLE_BYTES - 1;
    b.seams.availableBytes = () => avail;
    const notices: string[] = [];
    b.setNotify((code) => notices.push(code));
    expect(b.laneMayStart(0)).toBe(true); // lane 0 is never held
    expect(b.laneMayStart(1)).toBe(false);
    expect(b.laneMayStart(2)).toBe(false);
    expect(notices).toEqual(["al-runner-v3-lane-memory-hold"]);
    avail = LANE_MIN_AVAILABLE_BYTES;
    expect(b.laneMayStart(1)).toBe(true);
    expect(notices).toHaveLength(1);
  });
});
