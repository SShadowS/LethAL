// R586 step 9: `lethal doctor` on an al-runner-v3-only config: one `al-runner-v3` check, which
// reads the binary's `--version`, its `.gated` pin and `bcVersion` against the package folder.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256OfFile } from "../src/al-runner-v3-pin";
import { buildDoctorDeps } from "../src/cli";
import { runDoctor } from "../src/doctor";
import type { SpawnFn } from "../src/publisher";

const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

async function setup(gated: boolean): Promise<{ bin: string; deps: string }> {
  dir = await mkdtemp(join(tmpdir(), "lethal-r586-doctor-"));
  const bin = join(dir, "al-runner");
  await writeFile(bin, "binary");
  const deps = join(dir, "deps");
  await mkdir(deps);
  if (gated) {
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({ version: VERSION, binarySha256: await sha256OfFile(bin), lethalCommit: "abcdef1" }),
    );
  }
  return { bin, deps };
}

const spawn: SpawnFn = async () => ({ exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });

describe("doctor: al-runner-v3", () => {
  test("a gated binary passes, and the check is the only one", async () => {
    const { bin, deps } = await setup(true);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: "28.0.46665.47126" } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const r = await runDoctor(d.cfg, d.deps);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([["al-runner-v3", true]]);
  });

  test("an ungated binary fails the check by name", async () => {
    const { bin, deps } = await setup(false);
    const cfg = { alRunnerV3: { path: bin, packagesDir: deps, bcVersion: "28.0.46665.47126" } };
    const d = await buildDoctorDeps(cfg, { alRunnerSpawn: spawn });
    const r = await runDoctor(d.cfg, d.deps);
    expect(r.ok).toBe(false);
    expect(r.checks[0]?.detail).toMatch(/al-runner-v3-ungated-build/);
  });

  test("a config the run would refuse throws here too", async () => {
    await expect(buildDoctorDeps({ alRunnerV3: { packagesDir: "/d", bcVersion: "28.0" } })).rejects.toThrow(
      /four-number/,
    );
  });
});
