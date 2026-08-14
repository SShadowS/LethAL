import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BcDevConfigSection, LethalConfigFile } from "../src/cli";
import { DOCTOR_AL_RUNNER_ONLY_CAVEAT, buildDoctorDeps, renderDoctorReport } from "../src/cli";
import { runDoctor } from "../src/doctor";
import type { SpawnFn } from "../src/publisher";

/**
 * R146 — `lethal doctor` refused an al-runner-only project outright, so the one check written FOR
 * al-runner users (R131's artifact-cache report) was unreachable by the users who only use
 * al-runner.
 *
 * The shape of the fix is set by R110's lesson, and it is the whole reason this is not simply "stop
 * throwing". The environment, the lease, the quarantine record and the LethAL Control version are
 * live-BC concerns with NO meaning on this path. Rendering them as `[ok]` would repeat exactly the
 * failure the withdrawn lease check made: a check that structurally cannot fail, printed green, in
 * the scenario the tooling exists for. So they are ABSENT, and a caveat names them.
 *
 * `tool-paths` is absent for a MEASURED reason rather than an assumed one. R146's own row lists
 * `alc` among the candidates, "needed for the target compile on both backends". That is wrong:
 * `buildBackend`'s al-runner branch returns before `defaultAlToolPaths`/`resolveAlToolPaths` are
 * ever reached, because al-runner compiles the bundle with its own compiler and LethAL's
 * `ArtifactCompiler` is constructed only on the bcdev branch. Checking alc here would fail configs
 * that `lethal run --backend al-runner` accepts.
 */

/** A directory that does not exist, so the cache check reports a measured absence and this suite
 *  never walks whatever multi-GB artifact cache the machine running it happens to hold. */
const NO_CACHE_DIR = join(tmpdir(), "lethal-doctor-al-runner-no-cache");

const AL_RUNNER_ONLY: LethalConfigFile = { alRunner: { alRunnerPath: "C:/tools/al-runner.exe" } };

const BCDEV_RAW: Partial<BcDevConfigSection> = {
  mcpCommand: ["bun", "mcp"],
  company: "CRONUS",
  controlSymbolPath: "C:/lethal-control.app",
  packageCachePath: "C:/pkg",
  server: "https://host",
  serverInstance: "BC",
  username: "admin",
  password: "hunter2",
};

/** Answers `--version` the way a real v2 binary does (measured 2026-08-07: `al-runner v2.0.0.0`,
 *  exit 0). Records what it was asked, so a test can prove the probe is the REAL one. */
function v2Spawn(line = "al-runner v2.1.2.0"): { calls: string[][]; spawn: SpawnFn } {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: line, stderr: "" };
  };
  return { calls, spawn };
}

async function depsFor(configFile: LethalConfigFile, spawn: SpawnFn) {
  return buildDoctorDeps(configFile, {
    alRunnerCacheDir: NO_CACHE_DIR,
    alRunnerSpawn: spawn,
    alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
  });
}

describe("lethal doctor on an al-runner-only project (R146)", () => {
  test("produces a REPORT rather than throwing", async () => {
    const { cfg, deps } = await depsFor(AL_RUNNER_ONLY, v2Spawn().spawn);
    const report = await runDoctor(cfg, deps);
    expect(report.ok).toBe(true);
  });

  test("checks exactly the two things that mean something here", async () => {
    // Not "the live-BC checks pass" and not "the live-BC checks fail" — ABSENT. R110: a check that
    // structurally cannot fail, rendered as `[ok]`, was green in exactly the scenario the recovery
    // tooling exists for.
    const { cfg, deps } = await depsFor(AL_RUNNER_ONLY, v2Spawn().spawn);
    const report = await runDoctor(cfg, deps);
    expect(report.checks.map((c) => c.name)).toEqual(["al-runner", "al-runner-cache"]);
  });

  test("the al-runner check runs the REAL probe `run` runs, not a doctor-only opinion", async () => {
    // Constraint 3 of the doctor design: every check calls the refusal's own machinery. Here that
    // is `AlRunnerBackend.status()`, which spawns `--version` and refuses a non-v2 binary — the
    // same call `runSession` makes before a session starts.
    const { calls, spawn } = v2Spawn();
    const { cfg, deps } = await depsFor(AL_RUNNER_ONLY, spawn);
    const report = await runDoctor(cfg, deps);
    expect(calls).toEqual([["C:/tools/al-runner.exe", "--version"]]);
    expect(report.checks.find((c) => c.name === "al-runner")?.detail).toContain("v2.1.2.0");
  });

  test("and it can FAIL — a v1 binary is not reported green", async () => {
    // The property that separates this from a vacuous check. v1.0.31 rejected `--version` outright,
    // and a v2-only argv pointed at v1 produces WRONG VERDICTS rather than an error, which is why
    // `status()` refuses it.
    const { cfg, deps } = await depsFor(AL_RUNNER_ONLY, v2Spawn("al-runner v1.0.31").spawn);
    const report = await runDoctor(cfg, deps);
    const check = report.checks.find((c) => c.name === "al-runner");
    expect(check?.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("a binary that cannot be spawned fails rather than throwing out of the report", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT: al-runner");
    };
    const { cfg, deps } = await depsFor(AL_RUNNER_ONLY, spawn);
    const report = await runDoctor(cfg, deps);
    expect(report.checks.find((c) => c.name === "al-runner")?.ok).toBe(false);
    // The other check still ran: one failing probe must never take down the rest of the report.
    expect(report.checks.map((c) => c.name)).toEqual(["al-runner", "al-runner-cache"]);
  });

  test("the caveat NAMES what was not checked, and reaches the rendered report", async () => {
    // Without this, a green al-runner doctor reads as a green bcdev doctor. That is the failure
    // this row exists to prevent, and it is not one an absent check can announce by itself.
    const { cfg, deps, caveat } = await depsFor(AL_RUNNER_ONLY, v2Spawn().spawn);
    expect(caveat).toBe(DOCTOR_AL_RUNNER_ONLY_CAVEAT);
    const rendered = renderDoctorReport(await runDoctor(cfg, deps), caveat);
    expect(rendered).toContain(DOCTOR_AL_RUNNER_ONLY_CAVEAT);
    for (const absent of ["environment", "quarantine", "control-version", "lease", "alc"]) {
      expect(DOCTOR_AL_RUNNER_ONLY_CAVEAT).toContain(absent);
    }
  });

  test("a config that is NEITHER al-runner NOR bcdev NOR envTool still refuses", async () => {
    // Point 3 of the row: that is a real mistake worth refusing, and widening doctor to accept
    // everything would have thrown it away along with the bug.
    await expect(buildDoctorDeps({}, { alRunnerCacheDir: NO_CACHE_DIR })).rejects.toThrow(
      /no "bcdev", "envTool" or "alRunner" section/,
    );
  });
});

describe("the al-runner check follows the config, not the backend flag (R146)", () => {
  test("a bcdev project that ALSO declares alRunner gets the check alongside the live-BC ones", async () => {
    const { cfg, deps } = await depsFor(
      { bcdev: BCDEV_RAW, alRunner: { alRunnerPath: "C:/tools/al-runner.exe" } },
      v2Spawn().spawn,
    );
    expect(deps.alRunner).toBeDefined();
    expect(cfg).toBeDefined();
  });

  test("CONTROL: a bcdev-only config's check list is EXACTLY what it was before R146", async () => {
    // Passes with this row's change present and with it removed alike, so the change cannot pass by
    // having quietly widened every other config's report.
    const { deps } = await depsFor({ bcdev: BCDEV_RAW }, v2Spawn().spawn);
    expect(deps.alRunner).toBeUndefined();
    expect(deps.toolPaths).toBeDefined();
    expect(deps.envStatus).toBeDefined();
    expect(deps.quarantine).toBeDefined();
    expect(deps.controlVersion).toBeDefined();
    expect(deps.lease).toBeDefined();
  });
});

describe("runDoctor refuses to report on nothing (R146)", () => {
  test("a deps object with no checks at all THROWS rather than reporting ok", async () => {
    // `checks.every(...)` on an empty array is `true`, so a future config shape that produced no
    // deps would print "ok: every check passed" having checked nothing. Empty-vs-empty agreement is
    // this project's signature bug, and it would land in the command whose whole job is to say
    // whether things are healthy.
    await expect(runDoctor({}, {})).rejects.toThrow(/no checks/i);
  });
});
