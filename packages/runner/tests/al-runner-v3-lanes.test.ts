// R766 step (b): the lanes of AlRunnerV3Backend. N serve lanes in one backend: lane 0 reads `active/`,
// lane k reads a copy `active.<k>/`, each with its own daemon, cwd and per-mutant state; the owner keeps
// deploy, the proof, the shared prefetch and `close`. Fakes only; call counters, no timing.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AlRunnerV3Backend, AlRunnerV3UnprovenBatchError } from "../src/al-runner-v3-backend";
import { hashAlTree } from "../src/baseline-snapshot";
import {
  A,
  B,
  type FakeRow,
  OPTS,
  type RowsFn,
  SLEEPER_AL,
  SUITE,
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
      environmentChoice: { value: "saas", source: "config" },
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

  // R926 review D: the isolation mode is shared by every lane, so a lane view answers `isolationOf`
  // with the shared backend's own value (reach compares a baseline's mode with the mode now).
  test("a lane view's isolationOf is the shared backend's", async () => {
    const r = await lanesRig({ lanes: 2 });
    const v = r.views[1];
    if (v === undefined) throw new Error("no lane 1");
    expect(v.isolationOf?.(7)).toBe("test");
    r.b.isolationOf = (cu: number) => (cu === 7 ? "method" : "test");
    expect(v.isolationOf?.(7)).toBe("method");
    expect(v.isolationOf?.(8)).toBe("test");
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
    const real = async (k: number) => realpath(join(r.scratch, k === 0 ? "active" : `active.${k}`));
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
      m === "M0001" || m === "M0002"
        ? failing(allPass(m, 0, 0, 0), "B", "boom")
        : allPass(m, 0, 0, 0);
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
    const rows: RowsFn = (m) =>
      m === "M0001" ? failing(allPass(m, 0, 0, 0), "A", "boom") : allPass(m, 0, 0, 0);
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
    // ... and so do useCoveringBudgets and sendKillPair for another mutant (each drops a pair first).
    await v1.activate("M0002");
    v1.useCoveringBudgets("M0002", [{ ref: A, budgetMs: 1000 }]);
    await v1.sendKillPair("M0002", A);
    const n1 = r.serve.requests.length;
    await v0.activate(null);
    expect((await v0.run(A, OPTS)).outcome).toBe("pass"); // the confirm, from the pair
    await v0.activate("M0001");
    expect((await v0.run(A, OPTS)).outcome).toBe("fail"); // the reproduction, from the pair
    expect(r.serve.requests.length).toBe(n1);
    expect(r.b.entriesStats().pairRequests).toBe(1);
  });

  test("R778 batch ON: a prefetch-tagged kill on lane 1 is served from lane 0's batch; a live kill on lane 1 is refused and sends today's pair", async () => {
    const rows: RowsFn = (m) =>
      m === "M0001" || m === "M0002"
        ? failing(allPass(m, 0, 0, 0), "A", "boom")
        : allPass(m, 0, 0, 0);
    const r = await lanesRig({ lanes: 2, rows, pairBatch: true });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    await r.b.prefetchMutants(plans(["M0001", "M0002"]));
    expect(r.b.entriesStats().pairBatchStored).toBe(2);
    // M0001: killed on lane 1 from lane 0's prefetch; its pair comes from lane 0's batch, no send.
    const n0 = r.serve.requests.length;
    await v1.activate("M0001");
    expect((await v1.run(A, OPTS)).outcome).toBe("fail");
    await v1.sendKillPair("M0001", A);
    expect(r.serve.requests.length).toBe(n0);
    expect(r.b.entriesStats()).toMatchObject({ pairBatchServed: 1, pairBatchRefused: 0 });
    // M0002: lane 0 consumes its prefetched rows, so lane 1's kill is a LIVE one: refused.
    await v0.activate("M0002");
    expect((await v0.run(A, OPTS)).outcome).toBe("fail");
    const n1 = r.serve.requests.length;
    await v1.activate("M0002");
    expect((await v1.run(A, OPTS)).outcome).toBe("fail");
    expect(r.serve.requests.length).toBeGreaterThan(n1); // the live kill (and lane 1's warm-up)
    const n2 = r.serve.requests.length;
    await v1.sendKillPair("M0002", A);
    expect(r.serve.requests.length).toBe(n2 + 1); // today's pair
    expect(r.serve.requests.at(-1)?.ids).toContain("NONE|echo");
    expect(r.b.entriesStats()).toMatchObject({ pairBatchServed: 1, pairBatchRefused: 1 });
  });

  test("a lane-scoped server error: lane 0's pair verdict is served to lane 0 only", async () => {
    const rows: RowsFn = (m) =>
      m === "M0001" ? failing(allPass(m, 0, 0, 0), "A", "boom") : allPass(m, 0, 0, 0);
    const r = await lanesRig({
      lanes: 2,
      rows,
      // The pair request (NONE's echo and M0001's echo in one request) gets an end of stream.
      serve: {
        eofAt: (_n, req) => req.ids.includes("NONE|echo") && req.ids.includes("M0001|echo"),
      },
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
      m === "NONE" && d === 1
        ? failing(allPass(m, 0, 0, 0), "B", "disagrees")
        : allPass(m, 0, 0, 0);
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
    await expect(v1.run(A, OPTS)).rejects.toThrow(
      /lane-misuse: a pass under a mutant reached the §6/,
    );
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
      environmentChoice: { value: "saas", source: "config" },
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

  // PR-98: R766's resume refusal is lifted; the transport and Sleep refusals stay (tests around this one).
  test("PR-98: a resume session is allowed with an explicit serve-entries transport", async () => {
    const b = mk("serve-entries");
    b.seams.sleepRuleRetired = true;
    await b.decideTransport({ resume: false });
    expect(b.parallelRefusal()).toBeUndefined();
    await b.decideTransport({ resume: true });
    expect(b.parallelRefusal()).toBeUndefined();
  });

  test("PR-98: a resume does not lift the Sleep refusal or the transport refusal", async () => {
    const sleeper = mk("serve-entries");
    await sleeper.decideTransport({ resume: true });
    expect(sleeper.parallelRefusal()).toMatch(/pin retires the §6 Sleep rule/);
    const oneShot = mk("one-shot");
    oneShot.seams.sleepRuleRetired = true;
    await oneShot.decideTransport({ resume: true });
    expect(oneShot.parallelRefusal()).toMatch(/needs the serve-entries transport/);
  });

  test("lanes() needs the serve-entries transport (R515's re-budget is per scope under lanes)", () => {
    expect(() => mk("one-shot").lanes(2)).toThrow(/needs the serve-entries transport/);
  });

  test("any transport but serve-entries is refused by name, retired or not", () => {
    const b = mk("one-shot");
    for (const retired of [false, true]) {
      b.seams.sleepRuleRetired = retired;
      expect(b.parallelRefusal()).toMatch(
        /al-runner-v3-workers-refused: --workers > 1 needs the serve-entries transport/,
      );
    }
  });

  // PR-98: the lane gate. Every input is a seam: no test reads the real /sys, /proc or env.
  const G = 2 ** 30;
  interface Priv {
    peakReading: { bytes: number; source: "hwm" | "sampled" } | undefined;
    union: Set<number>;
    oneShotCodeunits: ReadonlySet<number>;
  }
  const gated = (o: {
    peakGiB?: number;
    /** The cgroup: used and max in GiB; `max` absent = no limit; `used` absent = no cgroup. */
    usedGiB?: number;
    maxGiB?: number;
    /** The class file's declared GiB; `null` = no class file. */
    classGiB?: number | null;
    lethalGiB?: number;
    availGiB?: number;
  }) => {
    const b = mk("serve-entries");
    const p = b as unknown as Priv;
    if (o.peakGiB !== undefined) p.peakReading = { bytes: o.peakGiB * G, source: "hwm" };
    p.union = new Set([1]);
    const cg =
      o.usedGiB === undefined
        ? undefined
        : {
            usedBytes: o.usedGiB * G,
            ...(o.maxGiB !== undefined ? { maxBytes: o.maxGiB * G } : {}),
            source: "cg/memory.max",
          };
    b.seams.memoryReader = () => cg;
    b.seams.availableBytes = () => (o.availGiB ?? 90) * G;
    b.seams.lethalRss = () => (o.lethalGiB ?? 4) * G;
    b.seams.anonReader = () => 0;
    const cls = { gib: o.classGiB === undefined ? 30 : o.classGiB };
    b.seams.classFilePath = () => (cls.gib === null ? undefined : "/fake/heavy.class");
    b.seams.readTextFile = () => `other 1 ${cls.gib}\n`;
    const notices: string[] = [];
    b.setNotify((code, message) => notices.push(`${code}: ${message}`));
    return { b, p, notices, cls };
  };

  test("host freemem 90 GB but the cgroup at 26 of 32 GiB used starts no lane 1; a roomier cgroup does", () => {
    const full = gated({ peakGiB: 2, usedGiB: 26, maxGiB: 32 }); // 26 + 2 x 2 = 30 > 28
    expect(full.b.laneMayStart(0)).toBe(true); // lane 0 is never held
    expect(full.b.laneMayStart(1)).toBe(false);
    expect(full.notices).toHaveLength(1);
    expect(full.notices[0]).toContain("al-runner-v3-lane-memory-hold");
    expect(full.notices[0]).toContain("rule: cgroup");
    full.b.laneMayStart(2);
    expect(full.notices).toHaveLength(1); // said once
    expect(gated({ peakGiB: 2, usedGiB: 10, maxGiB: 32 }).b.laneMayStart(1)).toBe(true);
  });

  test("no peak reading yet: no lane above 0 starts, and the notice says unmeasured; a reading opens it", () => {
    const g = gated({ usedGiB: 1, maxGiB: 32 });
    expect(g.b.laneMayStart(1)).toBe(false);
    expect(g.notices[0]).toContain("unmeasured");
    // build review #1: asked before the batch's first prefetch, unmeasured caps nothing (or batch 0 could
    // never run lanes); each lane's laneMayStart still refuses until a reading exists, as above.
    expect(g.b.affordableLanes(4)).toBe(4);
    expect(g.b.laneMayStart(1)).toBe(false);
    g.p.peakReading = { bytes: 1 * G, source: "sampled" };
    expect(g.b.laneMayStart(1)).toBe(true);
    expect(g.b.affordableLanes(4)).toBe(4);
  });

  test("H1: lane 1 asked is charged one peak per distinct request mode of the batch", () => {
    // used 22, room 28, peak 2: one mode (4 GiB for 2 lanes) fits; two modes (8 GiB) do not.
    const one = gated({ peakGiB: 2, usedGiB: 22, maxGiB: 32 });
    expect(one.b.laneMayStart(1)).toBe(true);
    const two = gated({ peakGiB: 2, usedGiB: 22, maxGiB: 32 });
    two.p.union = new Set([7, 8]);
    (two.b as unknown as { isolationOf: (cu: number) => string }).isolationOf = (cu) =>
      cu === 7 ? "method" : "test";
    expect(two.b.laneMayStart(1)).toBe(false);
    expect(two.notices[0]).toContain("2 mode(s) x 2.0 GiB");
  });

  test("a batch with one-shot codeunits adds the one-shot estimate to each lane", () => {
    const g = gated({ peakGiB: 2, usedGiB: 22, maxGiB: 32 }); // 22 + 2 x 2 = 26 fits
    expect(g.b.laneMayStart(1)).toBe(true);
    g.p.oneShotCodeunits = new Set([1]); // 22 + 2 x (2 + 3) = 32 does not
    expect(g.b.laneMayStart(1)).toBe(false);
    expect(g.notices[0]).toContain("one-shot");
  });

  test("H2: window 2 with lanes 2 and 3 still resident: lane 1 asked is charged every resident lane", async () => {
    const r = await lanesRig({ lanes: 4 });
    await laneBaseline(r);
    for (const k of [0, 2, 3]) {
      const v = r.views[k];
      if (v === undefined) throw new Error(`no lane ${k}`);
      await v.activate("M0001");
      await v.run(A, OPTS);
    }
    const priv = r.b as unknown as Priv & { lanesCharged(upto: number): number };
    expect(priv.lanesCharged(1)).toBe(4); // lanes 0 and 1, plus resident 2 and 3
    priv.peakReading = { bytes: 2 * G, source: "hwm" };
    r.b.seams.memoryReader = () => ({ usedBytes: 22 * G, maxBytes: 32 * G, source: "cg" });
    r.b.seams.lethalRss = () => 4 * G;
    r.b.seams.anonReader = () => 0;
    r.b.seams.availableBytes = () => 90 * G;
    // charged = {0, 1, 2, 3} = 4 lanes x 2 GiB: 22 + 8 = 30 > 28. (Charging k + 1 = 2 lanes would fit.)
    r.b.seams.classFilePath = () => "/fake/class";
    r.b.seams.readTextFile = () => "other 1 30\n";
    expect(r.b.laneMayStart(1)).toBe(false);
  });

  test("build review #2: a lane that is itself resident and asks again in a later window is charged once", async () => {
    const r = await lanesRig({ lanes: 2 });
    await laneBaseline(r);
    for (const k of [0, 1]) {
      const v = r.views[k];
      if (v === undefined) throw new Error(`no lane ${k}`);
      await v.activate("M0001");
      await v.run(A, OPTS);
    }
    const priv = r.b as unknown as Priv & { lanesCharged(upto: number): number };
    expect(priv.lanesCharged(1)).toBe(2); // lanes 0 and 1, each once (max(k, holders) + 1 gave 3)
    priv.peakReading = { bytes: 2 * G, source: "hwm" };
    // used 24, room 28: 2 lanes x 2 GiB = 28 fits; 3 lanes (the double count) = 30 would not.
    r.b.seams.memoryReader = () => ({ usedBytes: 24 * G, maxBytes: 32 * G, source: "cg" });
    r.b.seams.lethalRss = () => 4 * G;
    r.b.seams.anonReader = () => 0;
    r.b.seams.availableBytes = () => 90 * G;
    r.b.seams.classFilePath = () => "/fake/class";
    r.b.seams.readTextFile = () => "other 1 30\n";
    expect(r.b.laneMayStart(1)).toBe(true);
  });

  test("M4: the lane's daemons' RssAnon is subtracted from the used memory, read per pid; unreadable counts 0", async () => {
    const r = await lanesRig({ lanes: 2, serve: { pid: (d) => 4000 + d } });
    // The fake pids are made up: nothing reads /proc for them.
    r.b.seams.requestRssReader = () => undefined;
    r.b.seams.rssReader = () => undefined;
    await laneBaseline(r);
    const v1 = r.views[1];
    if (v1 === undefined) throw new Error("no lane 1");
    await v1.activate("M0001");
    await v1.run(A, OPTS);
    const priv = r.b as unknown as Priv;
    priv.peakReading = { bytes: 2 * G, source: "hwm" };
    r.b.seams.memoryReader = () => ({ usedBytes: 26 * G, maxBytes: 32 * G, source: "cg" });
    r.b.seams.lethalRss = () => 4 * G;
    r.b.seams.classFilePath = () => "/fake/class";
    r.b.seams.readTextFile = () => "other 1 30\n";
    const asked: number[] = [];
    let anon = 0; // unreadable
    r.b.seams.anonReader = (pid) => {
      asked.push(pid);
      return anon;
    };
    // 26 + 2 x 2 = 30 > 28 with nothing subtracted (an unreadable pid counts 0).
    expect(r.b.laneMayStart(1)).toBe(false);
    expect(asked).toContain(4000); // lane 1's daemon (the baseline ran one-shot) was read by pid
    anon = 3 * G; // lane 1's daemon holds 3 GiB anonymous: 26 - 3 + 4 = 27 <= 28
    expect(r.b.laneMayStart(1)).toBe(true);
  });

  test("the declared peak is re-read at each decision: a lowered class file stops the next lane", () => {
    const g = gated({ peakGiB: 2, usedGiB: 5, maxGiB: 32, classGiB: 30 });
    expect(g.b.laneMayStart(1)).toBe(true);
    g.cls.gib = 6; // PR-73 lowered it: 2 lanes x 2 + 4 = 8 > 6
    expect(g.b.laneMayStart(1)).toBe(false);
    expect(g.notices[0]).toContain("rule: declared peak");
    expect(g.notices[0]).toContain("declared 6");
  });

  test("no class file in a limited cgroup uses 8 GiB, and the notice names that default", () => {
    const g = gated({ peakGiB: 2, usedGiB: 5, maxGiB: 32, classGiB: null });
    expect(g.b.laneMayStart(1)).toBe(true); // 2 x 2 + 4 = 8 <= 8
    expect(g.b.laneMayStart(2)).toBe(false); // 3 x 2 + 4 = 10 > 8
    expect(g.notices[0]).toContain("rule: declared peak");
    expect(g.notices[0]).toContain("default");
    expect(g.notices[0]).toContain("declared 8");
  });

  test("no readable cgroup, or an unlimited one: the freemem path, with the new bytes per lane", () => {
    for (const cgroup of [{}, { usedGiB: 5 }]) {
      // peak 4 GiB: 2 lanes = 8 GiB + the 10 GB that stays free = 18; the old 2.3 GiB rule would start it at 17.
      const tight = gated({ peakGiB: 4, availGiB: 17, ...cgroup });
      expect(tight.b.laneMayStart(1)).toBe(false);
      expect(tight.notices[0]).toContain("rule: free memory");
      expect(gated({ peakGiB: 4, availGiB: 18, ...cgroup }).b.laneMayStart(1)).toBe(true);
      // and the unmeasured rule holds here too
      expect(gated({ availGiB: 90, ...cgroup }).b.laneMayStart(1)).toBe(false);
    }
  });

  test("L1: LethAL's own process is charged up to 4 GiB, less its RSS, and never below zero", () => {
    // used 22.5, room 28, 2 lanes x 2 = 4: LethAL at 4 GiB adds 0 (26.5 fits); at 1 GiB it adds 3 (29.5 does not).
    expect(gated({ peakGiB: 2, usedGiB: 22.5, maxGiB: 32, lethalGiB: 4 }).b.laneMayStart(1)).toBe(
      true,
    );
    expect(gated({ peakGiB: 2, usedGiB: 22.5, maxGiB: 32, lethalGiB: 1 }).b.laneMayStart(1)).toBe(
      false,
    );
    // a LethAL bigger than 4 GiB adds nothing (not a negative term): 25.5 + 4 = 29.5 does not fit at 10 GiB either
    expect(gated({ peakGiB: 2, usedGiB: 25.5, maxGiB: 32, lethalGiB: 10 }).b.laneMayStart(1)).toBe(
      false,
    );
  });

  test("affordableLanes is the largest count the gate allows (at least 1), with one notice naming the rule", () => {
    const g = gated({ peakGiB: 2, usedGiB: 20, maxGiB: 32 }); // 20 + 2c <= 28: c <= 4
    expect(g.b.affordableLanes(6)).toBe(4);
    expect(g.b.affordableLanes(6)).toBe(4);
    expect(g.notices).toHaveLength(1);
    expect(g.notices[0]).toContain("al-runner-v3-lane-memory-fit");
    expect(g.notices[0]).toContain("6 lanes asked, 4 started");
    expect(g.notices[0]).toContain("rule: cgroup");
    expect(gated({ peakGiB: 2, usedGiB: 20, maxGiB: 32 }).b.affordableLanes(3)).toBe(3);
    expect(gated({ peakGiB: 2, usedGiB: 31, maxGiB: 32 }).b.affordableLanes(5)).toBe(1);
  });

  test("the lanes-started notice names bytes per lane, its parts, and the rule that limited the count", () => {
    const g = gated({ peakGiB: 2, usedGiB: 20, maxGiB: 32 });
    g.b.affordableLanes(6);
    g.b.noteLanes("4 of 6 lanes started: x (lane 0's warm-up 1.0 s)");
    const said = g.notices.find((n) => n.startsWith("al-runner-v3-lanes-started"));
    expect(said).toContain("lane gate: 2.0 GiB per lane = 1 mode(s) x 2.0 GiB hwm peak");
    expect(said).toContain("limited by: cgroup");
    const free = gated({ peakGiB: 2, usedGiB: 1, maxGiB: 32 });
    free.b.affordableLanes(3);
    free.b.noteLanes("3 of 3 lanes started: y (lane 0's warm-up 1.0 s)");
    // build review #3: with no gate refusal there is no "limited by" (a pacing limit is the message's own text)
    const freeSaid = free.notices.find((n) => n.startsWith("al-runner-v3-lanes-started"));
    expect(freeSaid).toContain("lane gate: 2.0 GiB per lane");
    expect(freeSaid).not.toContain("limited by");
  });

  test("the session's peak reading is the highest a serve request gave, with its source", async () => {
    const r = await lanesRig({ lanes: 2, serve: { pid: (d) => 5000 + d } });
    let rss = 3 * G;
    r.b.seams.requestRssReader = () => rss; // sampled alone: no peak probe
    r.b.seams.rssReader = () => undefined;
    await laneBaseline(r);
    const priv = r.b as unknown as Priv;
    expect(priv.peakReading).toBeUndefined(); // no serve request has run yet
    const v1 = r.views[1];
    if (v1 === undefined) throw new Error("no lane 1");
    await v1.activate("M0001");
    await v1.run(A, OPTS);
    expect(priv.peakReading).toEqual({ bytes: 3 * G, source: "sampled" });
    rss = 2 * G; // a lower reading never lowers it
    await v1.activate("M0003");
    await v1.run(A, OPTS);
    expect(priv.peakReading?.bytes).toBe(3 * G);
    rss = 5 * G;
    await v1.activate("M0002");
    await v1.run(A, OPTS);
    expect(priv.peakReading?.bytes).toBe(5 * G);
  });
});
