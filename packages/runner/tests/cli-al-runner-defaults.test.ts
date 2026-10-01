import { describe, expect, spyOn, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ResourceEvidence,
  type SpawnRecord,
  cliDefaultMechanismFailures,
  recordSpawns,
  watchResourceSelector,
} from "../itest/cli-default-leg";
import { AL_RUNNER_PROVISION_SENTINEL, type AlRunnerBackend } from "../src/al-runner-backend";
import type { LethalConfigFile, RunCliConfig } from "../src/cli";
import {
  alRunnerAdvisory,
  buildBackend,
  effectiveAlRunnerTransport,
  prepareAlRunnerSession,
  validateAlRunnerConfig,
  withAlRunnerCoverageGuard,
} from "../src/cli";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { fakeAlRunnerServer } from "./helpers/fake-al-runner-server";
import { scratchDirs } from "./helpers/scratch";

/**
 * R387: `buildBackend` gives an al-runner run `--server` and the resource selector by default.
 * Checked through the SAME evidence the gate's CLI-default leg collects (`cli-default-leg.ts`), so
 * these tests are also the offline red-check of that leg: turning either default back shows its
 * own mechanism failure here.
 */
const scratch = scratchDirs();
const IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };
const TEST = { name: "Codeunit79100.A", status: "pass" };
const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" };

function runConfig(projectDir: string): RunCliConfig {
  return {
    mode: "run",
    projectDir,
    testDir: "/tests",
    backendKind: "al-runner",
    dbPath: "db",
    configPath: "cfg",
    skipKnownSurvivors: false,
    workers: 1,
    keepEnv: false,
    allowExpiringEnv: false,
  };
}

async function project(): Promise<string> {
  const dir = scratch("lethal-r387-proj-");
  await writeFile(
    join(dir, "app.json"),
    JSON.stringify({
      id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      idRanges: [{ from: 79000, to: 79199 }],
    }),
    "utf8",
  );
  return dir;
}

async function batch(): Promise<string> {
  const d = scratch("lethal-r387-batch-");
  await writeFile(join(d, "app.json"), JSON.stringify({ id: "x" }), "utf8");
  await writeFile(join(d, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  await writeFile(join(d, "Logic.Codeunit.al"), "codeunit 79100 Logic\n{\n}\n", "utf8");
  await writeFile(
    join(d, "mutant-manifest.json"),
    JSON.stringify({ artifactId: "b".repeat(32), mutants: [] }),
    "utf8",
  );
  return d;
}

const oneShot: SpawnFn = async () => ({
  exitCode: 0,
  stdout: alRunnerStdout({ tests: [TEST], passed: 1, failed: 0, errors: 0, total: 1, exitCode: 0 }),
  stderr: "",
});

/** Builds through `buildBackend` and drives one deploy and three activations, as a session would. */
async function drive(alRunner: NonNullable<LethalConfigFile["alRunner"]>): Promise<{
  backend: AlRunnerBackend;
  record: SpawnRecord;
  ev: ResourceEvidence;
}> {
  const proj = await project();
  const scratchDir = scratch("lethal-r387-scratch-");
  const rec = recordSpawns(oneShot, fakeAlRunnerServer([TEST]).spawn);
  const backend = (await buildBackend(
    runConfig(proj),
    { alRunner },
    scratchDir,
    undefined,
    { alRunnerSpawn: rec.spawn, alRunnerServerSpawn: rec.serverSpawn },
    IDS,
  )) as AlRunnerBackend;
  const ev = watchResourceSelector(backend, join(scratchDir, "al-runner-active", "active"));
  await backend.deploy(await batch());
  for (const id of ["M0001", "M0002", null]) {
    await backend.activate(id);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
    expect(v.outcome).toBe("pass");
  }
  await backend.close();
  return { backend, record: rec.record, ev };
}

const kinds = (failures: readonly string[]): string[] =>
  [...new Set(failures.map((f) => f.split(":")[0] ?? ""))].sort();

describe("R387: buildBackend's al-runner defaults", () => {
  test("no transport key: one --server daemon, no one-shot test spawn, resource selector, coverage off", async () => {
    const { backend, record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    expect(cliDefaultMechanismFailures(record, ev)).toEqual([]);
    expect(record.serverArgv).toEqual([["al-runner.exe", "--server"]]);
    expect(ev.activations).toBe(3);
    expect(ev.alHashes.size).toBe(1);
    expect(backend.capabilities().coverage).toBe("none");
  });

  test("the provisioning call (sentinel --test) is not a test spawn; a second one, or a real --test, fails", async () => {
    // Measured live 2026-10-01: `runSession` calls `provisionOnce` under `--server` too, a one-shot
    // `--test` whose filter matches no test. The first live record run counted it as a test spawn.
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    const provision = ["al-runner.exe", "--test", AL_RUNNER_PROVISION_SENTINEL];
    const withProvision: SpawnRecord = {
      ...record,
      oneShotArgv: [...record.oneShotArgv, provision],
    };
    expect(cliDefaultMechanismFailures(withProvision, ev)).toEqual([]);
    const twice: SpawnRecord = {
      ...withProvision,
      oneShotArgv: [...withProvision.oneShotArgv, provision],
    };
    expect(kinds(cliDefaultMechanismFailures(twice, ev))).toEqual(["server"]);
    const realTest: SpawnRecord = {
      ...withProvision,
      oneShotArgv: [...withProvision.oneShotArgv, ["al-runner.exe", "--test", "Sandbox Tests.X"]],
    };
    expect(kinds(cliDefaultMechanismFailures(realTest, ev))).toEqual(["server"]);
  });

  test("serverMode: false gives one-shot AND static, so both mechanism checks fail", async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe", serverMode: false });
    expect(kinds(cliDefaultMechanismFailures(record, ev))).toEqual(["resource", "server"]);
    expect(record.serverArgv).toEqual([]);
    expect(record.oneShotArgv.filter((a) => a.includes("--test")).length).toBe(3);
  });

  test('explicit selectorMode: "static" with the server on fails ONLY the resource check', async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe", selectorMode: "static" });
    expect(kinds(cliDefaultMechanismFailures(record, ev))).toEqual(["resource"]);
  });

  test("explicit one-shot plus resource is honoured: ONLY the server check fails", async () => {
    const { record, ev } = await drive({
      alRunnerPath: "al-runner.exe",
      serverMode: false,
      selectorMode: "resource",
    });
    expect(kinds(cliDefaultMechanismFailures(record, ev))).toEqual(["server"]);
  });

  test('coverage: "al-runner" reaches the backend', async () => {
    const proj = await project();
    const backend = (await buildBackend(
      runConfig(proj),
      { alRunner: { alRunnerPath: "al-runner.exe", coverage: "al-runner" } },
      scratch("lethal-r387-cov-"),
      undefined,
      {},
      IDS,
    )) as AlRunnerBackend;
    expect(backend.capabilities().coverage).toBe("al-runner");
  });
});

describe("R387: a hung suite under the default --server path", () => {
  test("a daemon that never answers runTests scores an ERROR after the one long deadline, never a timeout kill", async () => {
    // The server has one deadline for the whole suite (at least 10 minutes), where one-shot sends a
    // per-test timeout. This pins what a hang becomes there. The clock jumps 11 minutes per read
    // once the request is written, so the deadline passes without waiting for it.
    let offset = 0;
    let jumping = false;
    const realNow = Date.now.bind(Date);
    const now = spyOn(Date, "now").mockImplementation(() => {
      if (jumping) offset += 11 * 60 * 1000;
      return realNow() + offset;
    });
    try {
      const proj = await project();
      const fake = fakeAlRunnerServer([TEST], {
        silent: true,
        onRunTests: () => {
          jumping = true;
        },
      });
      const backend = (await buildBackend(
        runConfig(proj),
        { alRunner: { alRunnerPath: "al-runner.exe" } },
        scratch("lethal-r387-hang-"),
        undefined,
        { alRunnerSpawn: oneShot, alRunnerServerSpawn: fake.spawn },
        IDS,
      )) as AlRunnerBackend;
      await backend.deploy(await batch());
      await backend.activate("M0001");
      const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
      await backend.close();
      expect(fake.runs()).toBe(1);
      expect(v.outcome).toBe("error");
      expect(v.operation).toBe("pre-dispatch-rejected");
      expect(v.failureMessage).toMatch(/no summary line within 600000 ms/);
    } finally {
      now.mockRestore();
    }
  });
});

describe("R387: validateAlRunnerConfig refuses unknown keys and bad values by name", () => {
  test("a misspelled key is refused, naming it and the allowed keys", () => {
    expect(() => validateAlRunnerConfig({ alRunnerPath: "a", servermode: true } as never)).toThrow(
      /unknown key\(s\): servermode\. Allowed: alRunnerPath, packagesDir, serverMode, selectorMode, coverage/,
    );
  });

  test("stubsDir keeps its own diagnostic, not the generic unknown-key one", () => {
    expect(() => validateAlRunnerConfig({ alRunnerPath: "a", stubsDir: "s" } as never)).toThrow(
      /removed the --stubs flag/,
    );
  });

  test("bad values are refused, each by name", () => {
    expect(() =>
      validateAlRunnerConfig({
        alRunnerPath: "a",
        serverMode: "yes",
        selectorMode: "fast",
        coverage: "on",
      } as never),
    ).toThrow(
      /serverMode must be true or false.*selectorMode must be "static" or "resource".*coverage must be "al-runner" or "none"/,
    );
  });

  // Every shape the plan's audit found (docs, the gitignored configs, the tests) plus the new keys.
  const ACCEPTED: ReadonlyArray<LethalConfigFile["alRunner"]> = [
    { alRunnerPath: "a" },
    { alRunnerPath: "a", packagesDir: "p" },
    { alRunnerPath: "a", packagesDir: "p", serverMode: true },
    { alRunnerPath: "a", serverMode: false },
    { alRunnerPath: "a", selectorMode: "static" },
    { alRunnerPath: "a", selectorMode: "resource" },
    { alRunnerPath: "a", coverage: "al-runner" },
    { alRunnerPath: "a", coverage: "none" },
    {
      alRunnerPath: "a",
      packagesDir: "p",
      serverMode: false,
      selectorMode: "resource",
      coverage: "none",
    },
  ];
  for (const shape of ACCEPTED) {
    test(`accepts ${JSON.stringify(shape)}`, () => {
      expect(validateAlRunnerConfig(shape)).toEqual(shape as never);
    });
  }
});

describe("R387: effectiveAlRunnerTransport and the advisory line", () => {
  test("defaults: server on, resource, coverage none; server off gives static", () => {
    expect(effectiveAlRunnerTransport({})).toEqual({
      serverMode: true,
      selectorMode: "resource",
      coverage: "none",
    });
    expect(effectiveAlRunnerTransport({ serverMode: false })).toEqual({
      serverMode: false,
      selectorMode: "static",
      coverage: "none",
    });
  });

  test("the default config names only coverage, with the key that changes it", () => {
    const line = alRunnerAdvisory({});
    expect(line).toMatch(/^\[lethal\] al-runner settings: /);
    expect(line).toContain('"alRunner.coverage": "al-runner"');
    expect(line).not.toContain("serverMode");
    expect(line).not.toContain("selectorMode");
  });

  test("the old defaults name serverMode and selectorMode too", () => {
    const line = alRunnerAdvisory({ serverMode: false }) ?? "";
    expect(line).toContain('"alRunner.serverMode": true');
    expect(line).toContain('"alRunner.selectorMode": "resource"');
    expect(line).not.toContain("no gate has measured");
  });

  test("explicit one-shot plus resource is named as unmeasured", () => {
    expect(alRunnerAdvisory({ serverMode: false, selectorMode: "resource" })).toContain(
      "no gate has measured",
    );
  });

  test("the fastest measured settings print nothing", () => {
    expect(alRunnerAdvisory({ coverage: "al-runner" })).toBeUndefined();
  });
});

const TWO_ARM = `#if CLEAN27
codeunit 50103 B
{
}
#else
codeunit 50103 B
{
}
#endif
`;
const TWO_OBJECTS = "codeunit 50104 P\n{\n}\ncodeunit 50105 Q\n{\n}\n";

async function alProject(files: Record<string, string>): Promise<string> {
  const dir = scratch("lethal-r387-guard-");
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, "utf8");
  return dir;
}

describe("R387: the coverage guard and the once-per-session preparation", () => {
  const cfg = (_dir: string): LethalConfigFile => ({
    alRunner: { alRunnerPath: "a", coverage: "al-runner" },
  });

  test("a single #if-wrapped object falls back to none, with one warning naming the file", async () => {
    const dir = await alProject({ "B.Codeunit.al": TWO_ARM });
    const warned: string[] = [];
    const out = await withAlRunnerCoverageGuard(cfg(dir), dir, (l) => warned.push(l));
    expect(out.alRunner?.coverage).toBe("none");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("al-runner-coverage-unsupported");
    expect(warned[0]).toContain("B.Codeunit.al (an #if-wrapped object)");
  });

  test("a multi-object file falls back to none", async () => {
    const dir = await alProject({ "Two.Codeunit.al": TWO_OBJECTS });
    const warned: string[] = [];
    const out = await withAlRunnerCoverageGuard(cfg(dir), dir, (l) => warned.push(l));
    expect(out.alRunner?.coverage).toBe("none");
    expect(warned[0]).toContain("Two.Codeunit.al (more than one object)");
  });

  test("a clean project keeps coverage on and warns nothing", async () => {
    const dir = await alProject({ "A.Codeunit.al": "codeunit 50100 A\n{\n}\n" });
    const warned: string[] = [];
    const out = await withAlRunnerCoverageGuard(cfg(dir), dir, (l) => warned.push(l));
    expect(out.alRunner?.coverage).toBe("al-runner");
    expect(warned).toEqual([]);
  });

  test("prepareAlRunnerSession prints the guard warning and exactly ONE advisory line", async () => {
    const dir = await alProject({ "B.Codeunit.al": TWO_ARM });
    const warned: string[] = [];
    const out = await prepareAlRunnerSession(cfg(dir), dir, (l) => warned.push(l));
    expect(out.alRunner?.coverage).toBe("none");
    expect(warned.filter((l) => l.startsWith("[lethal] al-runner settings:"))).toHaveLength(1);
    expect(warned).toHaveLength(2);
  });

  test("prepareAlRunnerSession refuses a bad section before anything else", async () => {
    await expect(
      prepareAlRunnerSession({ alRunner: { alRunnerPath: "a", typo: 1 } as never }, "unused"),
    ).rejects.toThrow(/unknown key\(s\): typo/);
  });
});
