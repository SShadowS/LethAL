// R586 step 9: `lethal doctor` on an al-runner-v3-only config: one `al-runner-v3` check, which
// reads the binary's `--version`, its `.gated` pin and `bcVersion` against the package folder.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256OfFile, v3InstallHint } from "../src/al-runner-v3-pin";
import { buildDoctorDeps } from "../src/cli";
import { runDoctor } from "../src/doctor";
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
  test("a gated binary passes, and the check is the only one", async () => {
    const { bin, deps } = await setup(true);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: BC } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const r = await runDoctor(d.cfg, d.deps);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["al-runner-v3", true]]);
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
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const { alRunnerV3 } = d.deps;
    if (alRunnerV3 === undefined) throw new Error("no al-runner-v3 dep");
    const r = await runDoctor(d.cfg, { alRunnerV3 });
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["al-runner-v3", true]]);
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
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: failing });
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
