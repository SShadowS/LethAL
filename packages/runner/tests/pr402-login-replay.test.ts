// PR-402 (docs/superpowers/specs/2026-11-24-pr402-login-replay-switch.md, R1182 step 1): `alRunnerV3.loginReplay`.
// ALRUNNER_LOGIN_REPLAY=1 only on MUTANT-RUN serve daemons; every other al-runner process keeps =0 (PR-360).
// The env is read from what each spawn site really hands to its spawn seam (serverSpawn / spawn), never from the helper.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  AlRunnerV3Backend,
  type AlRunnerV3Config,
  AlRunnerV3LoginReplayError,
} from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { gatedBuilds, loginReplayFor } from "../src/al-runner-v3-pins";
import { mergeChildEnv } from "../src/al-runner-v3-seed";
import { v3SectionPassThrough } from "../src/cli";
import { lendingRunnerBuild } from "../src/orchestrator";
import { sessionFingerprint } from "../src/resume";
import { type LanesRig, OPTS, cleanRigs, lanesRig, ref } from "./helpers/v3-lanes-rig";

afterEach(cleanRigs);

const A = ref("A");
const REPLAY = "ALRUNNER_LOGIN_REPLAY";
const CHECK = "ALRUNNER_LOGIN_REPLAY_CHECK";
const SEQ = "AL_STRICT_SEQUENTIAL";

type Priv = {
  lane: unknown;
  closeLane(lane: unknown, why: string): Promise<void>;
  spawnRestarted(...a: unknown[]): Promise<unknown>;
  startDaemon(...a: unknown[]): Promise<unknown>;
  spawnCodeunit(o: Record<string, unknown>): Promise<unknown>;
  spawnDaemon(...a: unknown[]): Promise<unknown>;
};
const priv = (r: LanesRig) => r.b as unknown as Priv;

async function baseline(r: LanesRig): Promise<void> {
  r.b.baselinePhase(true);
  try {
    await r.b.activate(null);
    for (const t of r.suite) await r.b.run(t, OPTS);
  } finally {
    await r.b.baselinePhase(false, true);
  }
}
const prefetch = (r: LanesRig, mutantId: string) =>
  r.b.prefetchMutants([{ mutantId, refs: [A] }], { batchPlans: [{ mutantId, refs: [A] }] });

/** The daemons the rig's fake serve started: `mutant` ones carry AL_STRICT_SEQUENTIAL (PR-340), the others do not. */
const daemonEnvs = (r: LanesRig) =>
  r.serve.envs.map((env) => ({ env, mutant: env?.[SEQ] === "1" }));

describe("PR-402: the env each spawn site hands to its spawn seam", () => {
  /** A baseline daemon, as the backend's own `spawnDaemon(..., mutantRun = false)` starts one (the rig's baseline is one-shot). */
  async function baselineDaemon(r: LanesRig): Promise<void> {
    await priv(r).spawnDaemon(priv(r).lane, { testIsolation: "test", runSelectedOnly: false }, 60);
  }

  test("off: the one-shot baseline, a baseline daemon and a mutant daemon all carry =0", async () => {
    const r = await lanesRig({ lanes: 0, mutants: ["M0001"] });
    await baseline(r);
    await baselineDaemon(r);
    await prefetch(r, "M0001");
    const ds = daemonEnvs(r);
    expect(ds.some((d) => d.mutant)).toBe(true);
    expect(ds.some((d) => !d.mutant)).toBe(true);
    for (const d of ds) expect(d.env?.[REPLAY]).toBe("0");
    expect(r.one.envs.length).toBeGreaterThan(0);
    for (const env of r.one.envs) expect(env?.[REPLAY]).toBe("0");
  });

  // Red (a): `=1` put in `extra` instead of after v3ChildEnv (it is overwritten with =0). Red (b): `=1` reaching the baseline.
  test("on: a mutant daemon started by startDaemon carries =1; the baseline daemon and the one-shot baseline carry =0", async () => {
    const r = await lanesRig({ lanes: 0, mutants: ["M0001"], loginReplay: true });
    await baseline(r);
    await baselineDaemon(r);
    expect(r.one.envs.length).toBeGreaterThan(0);
    for (const env of r.one.envs) expect(env?.[REPLAY]).toBe("0");
    const baselineDaemons = daemonEnvs(r).length;
    expect(baselineDaemons).toBe(1);
    expect(daemonEnvs(r)[0]?.mutant).toBe(false);
    expect(daemonEnvs(r)[0]?.env?.[REPLAY]).toBe("0");
    const start = spyOn(priv(r), "startDaemon");
    await prefetch(r, "M0001");
    expect(start).toHaveBeenCalledTimes(1);
    const mutantDaemons = daemonEnvs(r).slice(baselineDaemons);
    expect(mutantDaemons.length).toBeGreaterThan(0);
    for (const d of mutantDaemons) {
      expect(d.mutant).toBe(true);
      expect(d.env?.[REPLAY]).toBe("1");
    }
  });

  test("on: a mutant daemon RESTARTED by spawnRestarted carries =1 too", async () => {
    const r = await lanesRig({ lanes: 0, mutants: ["M0001", "M0002"], loginReplay: true });
    await baseline(r);
    await prefetch(r, "M0001");
    await r.b.activate("M0001");
    await r.b.run(A, OPTS);
    await priv(r).closeLane(priv(r).lane, "probe");
    const before = r.serve.envs.length;
    const restarted = spyOn(priv(r), "spawnRestarted");
    await r.b.activate("M0002"); // never prefetched: a live call, on a closed lane, needs a daemon
    await r.b.run(A, OPTS);
    expect(restarted).toHaveBeenCalledTimes(1);
    const after = daemonEnvs(r).slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const d of after) {
      expect(d.mutant).toBe(true);
      expect(d.env?.[REPLAY]).toBe("1");
    }
  });

  test("on: a one-shot call (spawnCodeunit) carries =0", async () => {
    const r = await lanesRig({ lanes: 0, mutants: ["M0001"], loginReplay: true });
    await priv(r).spawnCodeunit({
      id: 79100,
      stopSeconds: 60,
      coverageJson: undefined,
      cwd: r.root,
      activeDir: r.batch,
      testDir: r.root,
    });
    expect(r.one.envs.length).toBeGreaterThan(0);
    for (const env of r.one.envs) expect(env?.[REPLAY]).toBe("0");
  });

  test("on with an ambient ALRUNNER_LOGIN_REPLAY_CHECK=1: the mutant daemon's real child env has =1 and no _CHECK", async () => {
    const saved = process.env[CHECK];
    process.env[CHECK] = "1";
    try {
      const r = await lanesRig({ lanes: 0, mutants: ["M0001"], loginReplay: true });
      await baseline(r);
      await prefetch(r, "M0001");
      const mutant = daemonEnvs(r).find((d) => d.mutant);
      if (mutant === undefined) throw new Error("no mutant daemon");
      expect(Object.hasOwn(mutant.env ?? {}, CHECK)).toBe(false);
      const child = mergeChildEnv(mutant.env ?? {});
      expect(child[REPLAY]).toBe("1");
      expect(Object.hasOwn(child, CHECK)).toBe(false);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, CHECK);
      else process.env[CHECK] = saved;
    }
  });
});

describe("PR-402: the spawn-time guard", () => {
  test("flag on with no fact read: a mutant daemon's spawn throws the code; the baseline daemon is not touched", async () => {
    const r = await lanesRig({
      lanes: 0,
      mutants: ["M0001"],
      loginReplay: true,
      loginReplayFact: false,
    });
    await baseline(r); // baseline daemons and one-shots need no fact
    for (const d of daemonEnvs(r)) expect(d.env?.[REPLAY]).toBe("0");
    const err = await prefetch(r, "M0001").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlRunnerV3LoginReplayError);
    expect((err as AlRunnerV3LoginReplayError).code).toBe("al-runner-v3-login-replay-unsupported");
    expect(daemonEnvs(r).some((d) => d.env?.[REPLAY] === "1")).toBe(false);
  });

  // Red (d): drop AlRunnerV3LoginReplayError from sendKillPairOn's rethrow list: the pair is "skipped" and the run goes on.
  test("the guard fires in the MUTANT phase (a kill pair): the session refuses with the code, never a skipped pair", async () => {
    const r = await lanesRig({
      lanes: 0,
      mutants: ["M0001"],
      loginReplay: true,
      rows: (m) => [
        {
          method: "A",
          status: m === "M0001" ? "fail" : "pass",
          ...(m === "M0001" ? { message: "killed by A" } : {}),
        },
        { method: "B", status: "pass" },
      ],
    });
    await baseline(r);
    await prefetch(r, "M0001");
    await r.b.activate("M0001");
    // the fact goes (a rig that lost it), and the mutant daemon with it: the pair needs a new mutant daemon
    r.b.seams.loginReplayFact = false;
    await priv(r).closeLane(priv(r).lane, "probe");
    const err = await r.b.sendKillPair("M0001", A).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlRunnerV3LoginReplayError);
    expect(String(err)).toContain("al-runner-v3-login-replay-unsupported");
    expect(r.notices.filter((n) => n.startsWith("al-runner-v3-pair-skipped"))).toEqual([]);
  });
});

describe("PR-402: config, wiring, fingerprint and lending build", () => {
  const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };
  const v = (extra: object) => validateAlRunnerV3Config({ ...base, ...extra }, () => true);

  test("config: absent stays absent, true/false are kept, anything else is refused by name", () => {
    expect("loginReplay" in v({})).toBe(false);
    expect(v({ loginReplay: true }).loginReplay).toBe(true);
    expect(v({ loginReplay: false }).loginReplay).toBe(false);
    for (const bad of ["yes", "true", 1, null, [true]])
      expect(() => v({ loginReplay: bad })).toThrow(
        '"alRunnerV3.loginReplay" must be true or false',
      );
  });

  test("config to backend: the CLI mapping passes loginReplay only when on", () => {
    expect(v3SectionPassThrough(v({ loginReplay: true })).loginReplay).toBe(true);
    expect("loginReplay" in v3SectionPassThrough(v({}))).toBe(false);
    expect("loginReplay" in v3SectionPassThrough(v({ loginReplay: false }))).toBe(false);
  });

  test("the backend's getter reads the cfg", () => {
    const getter = Object.getOwnPropertyDescriptor(AlRunnerV3Backend.prototype, "loginReplay")?.get;
    if (getter === undefined) throw new Error("no loginReplay getter");
    const get = (loginReplay?: boolean) =>
      getter.call({ cfg: { loginReplay } as AlRunnerV3Config }) as boolean;
    expect(get(true)).toBe(true);
    expect(get(false)).toBe(false);
    expect(get(undefined)).toBe(false);
  });

  test("no shipped gate record carries the `login-replay` fact; only `matches` allows the flag", () => {
    expect(gatedBuilds().length).toBeGreaterThan(0);
    for (const g of gatedBuilds()) expect(loginReplayFor(g)).toBe(false);
    expect(loginReplayFor(undefined)).toBe(false);
    expect(loginReplayFor({ batchFacts: { "login-replay": "diverged" } })).toBe(false);
    expect(loginReplayFor({ batchFacts: { "login-replay": "matches" } })).toBe(true);
  });

  // Red (e): drop `v3LoginReplay` from sessionFingerprint's input handling.
  test("fingerprint: on and off differ, and off is today's digest", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const none = sessionFingerprint(f);
    expect(sessionFingerprint({ ...f, v3LoginReplay: true })).not.toBe(none);
    expect(sessionFingerprint({ ...f, v3LoginReplay: true })).not.toBe(
      sessionFingerprint({ ...f, v3StopGroups: true }),
    );
    expect(none).toBe("9349b4c9edc905ff2627fabf927415d531d474d105727b56247fe761be5d5154");
  });

  test("the lending build carries ` login-replay` only when on, before isolation-auto", () => {
    const v3 = { version: "v", binarySha256: "s" };
    const stub = (extra: object) =>
      ({ environmentChoice: { value: "saas" }, ...extra }) as unknown as Parameters<
        typeof lendingRunnerBuild
      >[0];
    const off = lendingRunnerBuild(stub({}), v3);
    expect(off).not.toContain("login-replay");
    expect(lendingRunnerBuild(stub({ loginReplay: true }), v3)).toBe(`${off} login-replay`);
    expect(
      lendingRunnerBuild(
        stub({ refusedCutTail: true, stopGroups: true, loginReplay: true, isolationAuto: true }),
        v3,
      ),
    ).toBe(`${off} refused-cut-tail stop-groups login-replay isolation-auto`);
  });
});
