// R586 step 9: `lethal doctor` on an al-runner-v3-only config: one `al-runner-v3` check, which
// reads the binary's `--version`, its `.gated` pin and `bcVersion` against the package folder.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256OfFile, v3InstallHint } from "../src/al-runner-v3-pin";
import { buildDoctorDeps } from "../src/cli";
import { runDoctor } from "../src/doctor";
import { homeDir } from "../src/home";
import type { SpawnFn } from "../src/publisher";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
const BC = "28.0.46665.47126";
let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

const sysApp = (version: string) =>
  buildFakeAppWithEntries({
    "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="${version}" /></Package>`,
  });

async function setup(gated: boolean, withSystemApp = true): Promise<{ bin: string; deps: string }> {
  dir = await mkdtemp(join(tmpdir(), "lethal-r586-doctor-"));
  const bin = join(dir, "al-runner");
  await writeFile(bin, "binary");
  const deps = join(dir, "deps");
  await mkdir(deps);
  if (withSystemApp) await writeFile(join(deps, "Microsoft_System Application.app"), sysApp(BC));
  if (gated) {
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({
        version: VERSION,
        binarySha256: await sha256OfFile(bin),
        lethalCommit: "5eb544ef0aafeab402ac050e4a9e7481a8e67790",
      }),
    );
  }
  return { bin, deps };
}

const spawn: SpawnFn = async () => ({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });

describe("doctor: al-runner-v3", () => {
  test("a gated binary passes, beside the environment check", async () => {
    const { bin, deps } = await setup(true);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const r = await runDoctor(d.cfg, d.deps);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([
      ["al-runner-v3", true],
      ["al-runner-v3-environment", true],
    ]);
  });

  const envCheck = async (section: Record<string, unknown>, projectDir?: string) => {
    const { bin, deps } = await setup(true);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC, ...section } };
    const d = await buildDoctorDeps(cfg, {
      alRunnerSpawn: spawn,
      ...(projectDir !== undefined ? { projectDir } : {}),
    });
    const r = await runDoctor(d.cfg, d.deps);
    return r.checks.find((c) => c.name === "al-runner-v3-environment");
  };
  const launchDir = async (environmentType: string | undefined) => {
    const p = await mkdtemp(join(tmpdir(), "lethal-r938-doctor-"));
    if (environmentType !== undefined) {
      await mkdir(join(p, ".vscode"));
      await writeFile(
        join(p, ".vscode", "launch.json"),
        JSON.stringify({ configurations: [{ environmentType }] }),
      );
    }
    return p;
  };

  test("R938: doctor reports the config's environment, and where it came from", async () => {
    const c = await envCheck({ environment: "onprem" });
    expect([c?.ok, c?.detail]).toEqual([
      true,
      "al-runner-v3: environment: onprem (alRunnerV3.environment)",
    ]);
  });

  test("R938: doctor reads the target's launch.json when the config is silent", async () => {
    const p = await launchDir("Sandbox");
    try {
      const c = await envCheck({}, p);
      expect(c?.ok).toBe(true);
      expect(c?.detail).toContain("saas (the target's .vscode/launch.json)");
    } finally {
      await rm(p, { recursive: true, force: true });
    }
  });

  test("R938: with nothing stated anywhere, doctor FAILS with run's refusal text", async () => {
    const p = await launchDir(undefined);
    try {
      const c = await envCheck({}, p);
      expect(c?.ok).toBe(false);
      expect(c?.detail).toContain('set alRunnerV3.environment to "onprem" or "saas"');
    } finally {
      await rm(p, { recursive: true, force: true });
    }
  });

  test("an ungated binary fails the check by name", async () => {
    const { bin, deps } = await setup(false);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const r = await runDoctor(d.cfg, d.deps);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toMatch(/al-runner-v3-ungated-build/);
  });

  test("M8: a package folder with no System Application fails the check by name, never OK", async () => {
    const { bin, deps } = await setup(true, false);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const r = await runDoctor(d.cfg, d.deps);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toMatch(/al-runner-v3-system-application-not-found/);
  });

  // R834: a config with BOTH sections got no v3 check before.
  const BCDEV = {
    server: "https://host",
    serverInstance: "env-4711",
    username: "admin",
    password: "pw",
    mcpCommand: ["bun", "mcp"],
    company: "CRONUS",
    controlSymbolPath: "/lethal-control.app",
    packageCachePath: "/no/such/pkg",
  };

  test("R834: an alRunnerV3 section beside a bcdev section still gets the al-runner-v3 check", async () => {
    const { bin, deps } = await setup(true);
    const cfg = { bcdev: BCDEV, alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn, platform: "linux" });
    const { alRunnerV3 } = d.deps;
    if (alRunnerV3 === undefined) throw new Error("no al-runner-v3 dep");
    const r = await runDoctor(d.cfg, { alRunnerV3 });
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["al-runner-v3", true]]);
  });

  test("R834: a bad section beside a bcdev section is a failed check, not a throw", async () => {
    const cfg = { bcdev: BCDEV, alRunnerV3: { packagesDir: "/d", bcVersion: "28.0" } };
    const d = await buildDoctorDeps(cfg, { platform: "linux" });
    const { alRunnerV3 } = d.deps;
    if (alRunnerV3 === undefined) throw new Error("no al-runner-v3 dep");
    const r = await runDoctor(d.cfg, { alRunnerV3 });
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toMatch(/four-number/);
  });

  test("R834: beside a bcdev section, Windows is a failed check, not a pass and not a throw", async () => {
    const { bin, deps } = await setup(true);
    const cfg = { bcdev: BCDEV, alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn, platform: "win32" });
    const { alRunnerV3 } = d.deps;
    if (alRunnerV3 === undefined) throw new Error("no al-runner-v3 dep");
    const r = await runDoctor(d.cfg, { alRunnerV3 });
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toMatch(/al-runner-v3-windows-unsupported/);
  });

  test("R834: the install hint names the absolute home path and says the default finds it", () => {
    const hint = v3InstallHint();
    // The hint is about a Linux install, so it always writes forward slashes.
    expect(hint).toContain(`${homeDir()}/.local/bin/al-runner`);
    expect(hint).not.toContain("to ~/.local");
    expect(hint).toContain("with no alRunnerV3.path set");
  });

  test("R834: a bcdev-only config gets no al-runner-v3 check", async () => {
    const d = await buildDoctorDeps({ bcdev: BCDEV });
    expect(d.deps.alRunnerV3).toBeUndefined();
  });

  test("R834: a missing binary fails the check and prints the install command", async () => {
    const { deps } = await setup(true);
    const cfg = {
      bcdev: BCDEV,
      alRunnerV3: { path: join(dir, "absent"), packagesDir: deps, bcVersion: BC },
    };
    const failing: SpawnFn = async () => ({ exitCode: 127, stdout: "", stderr: "not found" });
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: failing, platform: "linux" });
    const { alRunnerV3 } = d.deps;
    if (alRunnerV3 === undefined) throw new Error("no al-runner-v3 dep");
    const r = await runDoctor(d.cfg, { alRunnerV3 });
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toContain(v3InstallHint());
  });

  test("R834: doctor reports a missing alcPath by name; a runnable one passes", async () => {
    const { bin, deps } = await setup(true);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC, alcPath: "/x/alc" } };
    const bad = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn, alcRunnable: () => false });
    const r1 = await runDoctor(bad.cfg, bad.deps);
    expect(r1.ok).toBe(false);
    expect(r1.checks[0]?.detail).toMatch(/al-runner-v3-alc-not-found/);
    const good = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn, alcRunnable: () => true });
    expect((await runDoctor(good.cfg, good.deps)).ok).toBe(true);
  });

  test("a config the run would refuse throws here too", async () => {
    await expect(
      buildDoctorDeps({ alRunnerV3: { packagesDir: "/d", bcVersion: "28.0" } }),
    ).rejects.toThrow(/four-number/);
  });
});
