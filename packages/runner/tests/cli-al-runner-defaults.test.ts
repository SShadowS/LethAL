import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ResourceEvidence,
  type SpawnRecord,
  cliDefaultMechanismFailures,
  expectedOneShotArgvs,
  platformAppsAgreement,
  recordSpawns,
  watchResourceSelector,
} from "../itest/cli-default-leg";
import { AL_RUNNER_PROVISION_SENTINEL, type AlRunnerBackend } from "../src/al-runner-backend";
import type { AlRunnerCanaryResult } from "../src/al-runner-canary";
import type { AlRunnerCoverageIndex } from "../src/al-runner-coverage";
import { isPredefinedProbeArgv, predefinedProbeArgv } from "../src/al-runner-predefined-probe";
import { readTargetSource } from "../src/baseline-snapshot";
import type { LethalConfigFile, RunCliConfig } from "../src/cli";
import {
  alRunnerAdvisory,
  buildBackend,
  effectiveAlRunnerTransport,
  prepareAlRunnerSession,
  runFromCli,
  validateAlRunnerConfig,
  withAlRunnerCoverageGuard,
} from "../src/cli";
import { prepareBatchProject } from "../src/orchestrator";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { fakeAlRunnerServer } from "./helpers/fake-al-runner-server";
import { removeRunScratchAfterAll, scratchDirs } from "./helpers/scratch";

/**
 * R387: `buildBackend` gives an al-runner run `--server` and the resource selector by default.
 * Checked through the SAME evidence the gate's CLI-default leg collects (`cli-default-leg.ts`), so
 * these tests are also the offline red-check of that leg: turning either default back shows its
 * own mechanism failure here.
 */
const scratch = scratchDirs();
// runFromCli keeps its `lethal-XXXXXX` scratch folder when the run throws, as the tests below make it.
removeRunScratchAfterAll();
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
  // R517: as `runSession` does before the first run, at its defaults (no leg sets either).
  backend.useMutantBudgetFloor(180_000, 120_000);
  await backend.deploy(await batch());
  for (const id of ["M0001", "M0002", null]) {
    await backend.activate(id);
    const v = await backend.run(ref, { coverage: "none", timeoutMs: 1000 });
    expect(v.outcome).toBe("pass");
  }
  await backend.close();
  // `runSession` runs the R392 probe once per session; this driver does not, so record its argv.
  rec.record.oneShotArgv.push(probeArgv());
  return { backend, record: rec.record, ev };
}

/** The argv the R392 probe spawns for `drive()`'s binary, with scratch dirs shaped as the probe's. */
function probeArgv(pin?: string): string[] {
  const root = join(tmpdir(), "lethal-r392-probe-test");
  return predefinedProbeArgv("al-runner.exe", join(root, "src"), join(root, "tests"), pin);
}

/** The one-shot argvs the gate allows for `drive()`'s config (`runConfig`'s testDir is "/tests"). */
const ALLOWED = expectedOneShotArgvs({ alRunnerPath: "al-runner.exe", testDir: "/tests" });
const [provision = [], version = []] = ALLOWED.map((a) => [...a]);

const kinds = (failures: readonly string[]): string[] =>
  [...new Set(failures.map((f) => f.split(":")[0] ?? ""))].sort();

describe("R387: buildBackend's al-runner defaults", () => {
  test("no transport key: one --server daemon, no one-shot test spawn, resource selector, coverage off", async () => {
    const { backend, record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    expect(cliDefaultMechanismFailures(record, ev, ALLOWED)).toEqual([]);
    expect(record.serverArgv).toEqual([["al-runner.exe", "--server", "--test-timeout", "180"]]);
    expect(ev.activations).toBe(3);
    expect(ev.alHashes.size).toBe(1);
    expect(backend.capabilities().coverage).toBe("none");
  });

  test("R517: a daemon argv without --test-timeout 180 exactly once fails the server check", async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    const withArgv = (argv: string[]): SpawnRecord => ({ ...record, serverArgv: [argv] });
    expect(cliDefaultMechanismFailures(record, ev, ALLOWED)).toEqual([]);
    for (const argv of [
      ["al-runner.exe", "--server"],
      ["al-runner.exe", "--server", "--test-timeout", "60"],
      ["al-runner.exe", "--server", "--test-timeout", "180", "--test-timeout", "180"],
    ]) {
      expect(cliDefaultMechanismFailures(withArgv(argv), ev, ALLOWED)).toEqual([
        `server: expected --test-timeout 180 exactly once on the daemon argv, saw ${JSON.stringify(
          argv.flatMap((a, i) => (a === "--test-timeout" ? [argv[i + 1]] : [])),
        )}`,
      ]);
    }
  });

  test("the provisioning call (sentinel --test) is not a test spawn; a second one, or a real --test, fails", async () => {
    // Measured live 2026-10-01: `runSession` calls `provisionOnce` under `--server` too, a one-shot
    // `--test` whose filter matches no test. The first live record run counted it as a test spawn.
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    const withProvision: SpawnRecord = {
      ...record,
      oneShotArgv: [...record.oneShotArgv, provision],
    };
    expect(cliDefaultMechanismFailures(withProvision, ev, ALLOWED)).toEqual([]);
    const twice: SpawnRecord = {
      ...withProvision,
      oneShotArgv: [...withProvision.oneShotArgv, provision],
    };
    expect(kinds(cliDefaultMechanismFailures(twice, ev, ALLOWED))).toEqual(["server"]);
    const realTest: SpawnRecord = {
      ...withProvision,
      oneShotArgv: [...withProvision.oneShotArgv, ["al-runner.exe", "--test", "Sandbox Tests.X"]],
    };
    expect(kinds(cliDefaultMechanismFailures(realTest, ev, ALLOWED))).toEqual(["server"]);
  });

  test("one-shot calls are an allow-list: --version passes, a whole-suite run with no --test fails", async () => {
    // A whole-suite one-shot run carries no `--test`, so a check that counted `--test` alone would
    // pass it. Only provisioning and `status()`'s exact `[path, "--version"]` are allowed.
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    const allowed: SpawnRecord = {
      ...record,
      oneShotArgv: [...record.oneShotArgv, version, provision],
    };
    expect(cliDefaultMechanismFailures(allowed, ev, ALLOWED)).toEqual([]);
    const suite: SpawnRecord = {
      ...allowed,
      oneShotArgv: [
        ...allowed.oneShotArgv,
        ["al-runner.exe", "--isolation", "test", "src", "tests"],
      ],
    };
    expect(kinds(cliDefaultMechanismFailures(suite, ev, ALLOWED))).toEqual(["server"]);
    const versionPlus: SpawnRecord = {
      ...allowed,
      oneShotArgv: [...allowed.oneShotArgv, ["al-runner.exe", "--version", "extra"]],
    };
    expect(kinds(cliDefaultMechanismFailures(versionPlus, ev, ALLOWED))).toEqual(["server"]);
  });

  test("R392: the probe count must EQUAL the backend count (no cache): a second backend's missing probe fails, naming the counts", async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    const [server = []] = record.serverArgv;
    const twoWithBothProbes: SpawnRecord = {
      ...record,
      serverArgv: [server, server],
      oneShotArgv: [...record.oneShotArgv, probeArgv()],
    };
    expect(cliDefaultMechanismFailures(twoWithBothProbes, ev, ALLOWED, 2)).toEqual([]);
    const twoWithOneProbe: SpawnRecord = { ...twoWithBothProbes, oneShotArgv: record.oneShotArgv };
    const failures = cliDefaultMechanismFailures(twoWithOneProbe, ev, ALLOWED, 2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("expected 2");
    expect(failures[0]).toContain("saw 1");
  });

  test("the allow-list is EXACT:a stray sentinel element or another binary path does not pass", async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
    const base: SpawnRecord = { ...record, oneShotArgv: [...record.oneShotArgv, version] };
    const withArgv = (argv: string[]): SpawnRecord => ({
      ...base,
      oneShotArgv: [...base.oneShotArgv, argv],
    });
    // (d) the exact provision and version argvs pass (version already in `base`).
    expect(version).toEqual(["al-runner.exe", "--version"]);
    expect(cliDefaultMechanismFailures(withArgv(provision), ev, ALLOWED)).toEqual([]);
    // (a) a real test run that also carries the sentinel as an element.
    const realWithSentinel = withArgv([
      "al-runner.exe",
      "--output-json",
      "--isolation",
      "test",
      "--test",
      "Sandbox Tests.X",
      AL_RUNNER_PROVISION_SENTINEL,
      "--auto-provision",
      "/tests",
    ]);
    expect(kinds(cliDefaultMechanismFailures(realWithSentinel, ev, ALLOWED))).toEqual(["server"]);
    // (b) a whole-suite run (no --test) carrying the sentinel.
    const suiteWithSentinel = withArgv([
      "al-runner.exe",
      "--output-json",
      "--isolation",
      "test",
      AL_RUNNER_PROVISION_SENTINEL,
      "/tests",
    ]);
    expect(kinds(cliDefaultMechanismFailures(suiteWithSentinel, ev, ALLOWED))).toEqual(["server"]);
    // (c) the version probe of a different binary, ALONE: beside the real probe it would fail on
    // the count instead, and pass whether or not the path is checked.
    const otherVersion: SpawnRecord = {
      ...record,
      oneShotArgv: [...record.oneShotArgv, ["other-al-runner.exe", "--version"]],
    };
    expect(kinds(cliDefaultMechanismFailures(otherVersion, ev, ALLOWED))).toEqual(["server"]);
  });

  test("serverMode: false gives one-shot AND static, so both mechanism checks fail", async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe", serverMode: false });
    expect(kinds(cliDefaultMechanismFailures(record, ev, ALLOWED))).toEqual(["resource", "server"]);
    expect(record.serverArgv).toEqual([]);
    expect(
      record.oneShotArgv.filter(
        (a) => a.includes("--test") && !isPredefinedProbeArgv(a, "al-runner.exe"),
      ).length,
    ).toBe(3);
  });

  describe("R392: the predefined-symbol probe is allowed exactly once per backend, and required", () => {
    test("(a) the probe spawn removed: fails with 'probe did not run'", async () => {
      const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
      expect(cliDefaultMechanismFailures(record, ev, ALLOWED)).toEqual([]);
      const noProbe: SpawnRecord = {
        ...record,
        oneShotArgv: record.oneShotArgv.filter((a) => !isPredefinedProbeArgv(a, "al-runner.exe")),
      };
      expect(cliDefaultMechanismFailures(noProbe, ev, ALLOWED)).toEqual([
        "server: expected 1 R392 probe spawn(s) (one per backend), saw 0",
      ]);
    });

    test("(b) an ordinary one-shot --test beside the probe still fails; a pinned probe passes", async () => {
      const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
      const ordinary: SpawnRecord = {
        ...record,
        oneShotArgv: [...record.oneShotArgv, ["al-runner.exe", "--test", "Sandbox Tests.X"]],
      };
      const failures = cliDefaultMechanismFailures(ordinary, ev, ALLOWED);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("saw 1: al-runner.exe --test Sandbox Tests.X");
      // The probe's argv with a stray element is not the probe's argv.
      const stray: SpawnRecord = { ...record, oneShotArgv: [[...probeArgv(), "--define", "X"]] };
      expect(cliDefaultMechanismFailures(stray, ev, ALLOWED).join("\n")).toContain(
        "R392 probe spawn(s) (one per backend), saw 0",
      );
      const pinned: SpawnRecord = { ...record, oneShotArgv: [probeArgv("C:/pin")] };
      expect(cliDefaultMechanismFailures(pinned, ev, ALLOWED)).toEqual([]);
    });

    test("(c) a SECOND probe spawn fails", async () => {
      const { record, ev } = await drive({ alRunnerPath: "al-runner.exe" });
      const twice: SpawnRecord = { ...record, oneShotArgv: [...record.oneShotArgv, probeArgv()] };
      expect(cliDefaultMechanismFailures(twice, ev, ALLOWED)).toEqual([
        "server: expected 1 R392 probe spawn(s) (one per backend), saw 2",
      ]);
    });
  });

  test('explicit selectorMode: "static" with the server on fails ONLY the resource check', async () => {
    const { record, ev } = await drive({ alRunnerPath: "al-runner.exe", selectorMode: "static" });
    expect(kinds(cliDefaultMechanismFailures(record, ev, ALLOWED))).toEqual(["resource"]);
  });

  test("explicit one-shot plus resource is honoured: ONLY the server check fails", async () => {
    const { record, ev } = await drive({
      alRunnerPath: "al-runner.exe",
      serverMode: false,
      selectorMode: "resource",
    });
    expect(kinds(cliDefaultMechanismFailures(record, ev, ALLOWED))).toEqual(["server"]);
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

  /** A project with `Helper.Codeunit.al` twice (root and `Sub/`) and its renamed flat batch. */
  async function renamedBatch(): Promise<{ proj: string; dir: string }> {
    const proj = await project();
    const unit = (id: number) => `codeunit ${id} "H${id}"\n{\n}\n`;
    await writeFile(join(proj, "Helper.Codeunit.al"), unit(79100), "utf8");
    await mkdir(join(proj, "Sub"));
    await writeFile(join(proj, "Sub", "Helper.Codeunit.al"), unit(79101), "utf8");
    const dir = scratch("lethal-r219-batch-");
    await prepareBatchProject(proj, dir, { id: "x" }, "1.0.0.0");
    await writeFile(
      join(dir, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "b".repeat(32), mutants: [] }),
      "utf8",
    );
    return { proj, dir };
  }

  // R219 run 003: the coverage index resolves a shared file name against the project al-runner
  // labels coverage under. Revert: drop `sourceProjectDir` from `buildBackend`'s al-runner config.
  test("the coverage index of a renamed batch knows the project directory", async () => {
    const { proj, dir } = await renamedBatch();
    const backend = (await buildBackend(
      runConfig(proj),
      {
        alRunner: {
          alRunnerPath: "al-runner.exe",
          coverage: "al-runner",
          serverMode: false,
          selectorMode: "static",
        },
      },
      scratch("lethal-r219-cov-"),
      undefined,
      {},
      IDS,
    )) as AlRunnerBackend;
    backend.useBuildSymbols([]);
    await backend.deploy(dir);
    await backend.coverageRefusals();
    const { coverageIndex } = backend as unknown as { coverageIndex?: AlRunnerCoverageIndex };
    expect(coverageIndex?.exact?.projectDir).toBe(proj.split("\\").join("/").toLowerCase());
  });

  // R-219c (M2): on --server a coverage refusal stops the session, as it does one-shot, instead of
  // reading as an `error` verdict per test. Revert: drop the `ServerCoverageRefusal` rethrow in
  // `runViaServer`.
  test("a --server coverage refusal propagates out of run()", async () => {
    const { proj, dir } = await renamedBatch();
    const server = fakeAlRunnerServer([TEST], {
      perTestCoverage: [
        {
          test: TEST.name,
          coverage: [{ file: "/x/Helper.Codeunit.al", statements: [{ line: 2, hits: 1 }] }],
        },
      ],
    });
    const backend = (await buildBackend(
      runConfig(proj),
      {
        alRunner: {
          alRunnerPath: "al-runner.exe",
          coverage: "al-runner",
          serverMode: true,
          selectorMode: "static",
        },
      },
      scratch("lethal-r219-srv-"),
      undefined,
      { alRunnerServerSpawn: server.spawn },
      IDS,
    )) as AlRunnerBackend;
    backend.useBuildSymbols([]);
    backend.useMutantBudgetFloor(180_000, 120_000);
    await backend.deploy(dir);
    try {
      await expect(backend.run(ref, { coverage: "none", timeoutMs: 1000 })).rejects.toThrow(
        /neither inside the project .* nor directly in the batch/,
      );
    } finally {
      await backend.close();
    }
  });
});

/**
 * R505: al-runner c39ad5de labels coverage from the LIVE project, so with coverage on a backend
 * built from a session snapshot checks the project before and after every coverage-producing
 * call, on both transports, and a change stops the session (it never becomes a verdict).
 */
describe("R505: buildBackend watches the project while coverage is read", () => {
  const ORIGINAL = "codeunit 79100 Logic\n{\n}\n";
  const EDITED = "codeunit 79100 Logic\n{\n// x\n}\n";
  /** `during` runs INSIDE the al-runner call, between the pre-check and the post-check. */
  async function backendFor(
    serverMode: boolean,
    withSnapshot: boolean,
    during?: (proj: string) => void,
  ) {
    const proj = await project();
    await writeFile(join(proj, "Logic.Codeunit.al"), ORIGINAL, "utf8");
    const snapshot = await readTargetSource(proj);
    const inCall = () => during?.(proj);
    const server = fakeAlRunnerServer([TEST], { onRunTests: inCall });
    const spawnInCall: SpawnFn = async (...a) => {
      inCall();
      return oneShot(...a);
    };
    const backend = (await buildBackend(
      runConfig(proj),
      {
        alRunner: {
          alRunnerPath: "al-runner.exe",
          coverage: "al-runner",
          serverMode,
          selectorMode: "static",
        },
      },
      scratch("lethal-r505-"),
      undefined,
      { alRunnerSpawn: spawnInCall, alRunnerServerSpawn: server.spawn },
      IDS,
      ...(withSnapshot ? [snapshot] : []),
    )) as AlRunnerBackend;
    backend.useBuildSymbols([]);
    backend.useMutantBudgetFloor(180_000, 120_000);
    await backend.deploy(await batch());
    return { backend, proj };
  }
  const go = (backend: AlRunnerBackend) => backend.run(ref, { coverage: "none", timeoutMs: 1000 });

  for (const [transport, serverMode] of [
    ["one-shot", false],
    ["--server", true],
  ] as const) {
    // Revert: drop the `projectWatch` checks from `sendOneShot` / `ensureServerSuite`.
    test(`${transport}: an edited project stops the run, naming the file`, async () => {
      const { backend, proj } = await backendFor(serverMode, true);
      try {
        await writeFile(join(proj, "Logic.Codeunit.al"), "codeunit 79100 Logic\n{\n// x\n}\n");
        await expect(go(backend)).rejects.toThrow(/changed Logic\.Codeunit\.al.*--resume/);
      } finally {
        await backend.close();
      }
    });
    // Opus build review: each half of the bracket on its own. An edit made DURING the call is seen
    // only by the post-check (revert: drop the check after the call).
    test(`${transport}: an edit made during the call is caught after it`, async () => {
      const { backend } = await backendFor(serverMode, true, (proj) =>
        writeFileSync(join(proj, "Logic.Codeunit.al"), EDITED),
      );
      try {
        await expect(go(backend)).rejects.toThrow(/changed Logic\.Codeunit\.al/);
      } finally {
        await backend.close();
      }
    });
    // An edit made before the call and undone inside it is seen only by the pre-check (revert:
    // drop the check before the call).
    test(`${transport}: an edit undone during the call is caught before it`, async () => {
      const { backend, proj } = await backendFor(serverMode, true, (p) =>
        writeFileSync(join(p, "Logic.Codeunit.al"), ORIGINAL),
      );
      try {
        await writeFile(join(proj, "Logic.Codeunit.al"), EDITED);
        await expect(go(backend)).rejects.toThrow(/changed Logic\.Codeunit\.al/);
      } finally {
        await backend.close();
      }
    });
    // The control: an unchanged project runs.
    test(`${transport}: an unchanged project runs`, async () => {
      const { backend } = await backendFor(serverMode, true);
      try {
        expect((await go(backend)).outcome).toBe("pass");
      } finally {
        await backend.close();
      }
    });
  }

  // Revert: build the watch without a snapshot. The itests build no snapshot and must not be
  // watched (their fixtures do not change).
  test("without a session snapshot nothing is watched", async () => {
    const { backend, proj } = await backendFor(false, false);
    try {
      await writeFile(join(proj, "Logic.Codeunit.al"), "codeunit 79100 Logic\n{\n// x\n}\n");
      expect((await go(backend)).outcome).toBe("pass");
    } finally {
      await backend.close();
    }
  });
});

describe("R387: platformAppsAgreement reports the daemon's directory against leg A's", () => {
  const legA = "C:\\x\\28.1.1.1\\platform-apps";
  const said = (dir: string) => `[provision] platform apps already complete at ${dir}.\n`;
  test("agree, including a different spelling of the same directory", () => {
    expect(platformAppsAgreement(legA, said("C:/x/28.1.1.1/platform-apps/"))).toStartWith(
      "platform apps: AGREE,",
    );
  });
  test("differ", () => {
    expect(platformAppsAgreement(legA, said("C:\\x\\28.1.2.2\\platform-apps"))).toBe(
      `platform apps: DIFFER, leg A ${legA}, daemon C:\\x\\28.1.2.2\\platform-apps`,
    );
  });
  test("not named: no sentence, or only a directory inferred from [bc] selected", () => {
    const notNamed =
      "platform apps: the daemon named no platform-app directory on stderr (a stated limit, not inferred)";
    expect(platformAppsAgreement(legA, "[server] ready\n")).toBe(notNamed);
    expect(platformAppsAgreement(legA, "[bc] selected BC 28.1.1.1 (C:\\x\\28.1.1.1)\n")).toBe(
      notNamed,
    );
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
      backend.useMutantBudgetFloor(180_000, 120_000);
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
// R407: a multi-object project runs the frame probe; these pin the REFUSED path, as on c39ad5de.
const REFUSED_FRAME_PROBE = async () =>
  ({
    outcome: "refused",
    transport: "server",
    build: "al-runner v2.12.0-main.c39ad5de",
    refusal: "label-outside-bundle",
    reason: "labelled src/R407Pair.Table.al",
  }) as const;

async function alProject(files: Record<string, string>): Promise<string> {
  const dir = scratch("lethal-r387-guard-");
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, "utf8");
  return dir;
}

describe("R387: the coverage guard and the once-per-session preparation", () => {
  const cfg = (_dir: string): LethalConfigFile => ({
    alRunner: { alRunnerPath: "a", coverage: "al-runner" },
  });
  const refused = { frameProbe: REFUSED_FRAME_PROBE };

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
    const out = await withAlRunnerCoverageGuard(cfg(dir), dir, (l) => warned.push(l), refused);
    expect(out.alRunner?.coverage).toBe("none");
    expect(warned[0]).toContain("Two.Codeunit.al (more than one object)");
    // R383: the warning names the REAL reason, al-runner's frame for later objects, not #3713.
    expect(warned[0]).toContain("every object after a file's first at the wrong line");
    // R407: and the probe's own outcome and the build it ran against.
    expect(warned[0]).toContain("label-outside-bundle: labelled src/R407Pair.Table.al");
    expect(warned[0]).toContain("al-runner build: al-runner v2.12.0-main.c39ad5de");
    expect(warned[0]).not.toContain("R300");
  });

  test("R383 r3: a codeunit then a #if split-header codeunit falls back to none as multi-object", async () => {
    const split =
      "codeunit 50104 P\n{\n}\n#if FEATURE\ncodeunit 50105 Q\n#else\ncodeunit 50105 Q\n#endif\n{\n    procedure Q()\n    begin\n    end;\n}\n";
    const dir = await alProject({ "Split.Codeunit.al": split });
    const warned: string[] = [];
    const out = await withAlRunnerCoverageGuard(cfg(dir), dir, (l) => warned.push(l), refused);
    expect(out.alRunner?.coverage).toBe("none");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("Split.Codeunit.al (more than one object)");
  });

  test("R383: a multi-object file beside a wrapped one: ONE warning naming both, with both reasons", async () => {
    const dir = await alProject({ "Two.Codeunit.al": TWO_OBJECTS, "B.Codeunit.al": TWO_ARM });
    const warned: string[] = [];
    const out = await withAlRunnerCoverageGuard(cfg(dir), dir, (l) => warned.push(l), refused);
    expect(out.alRunner?.coverage).toBe("none");
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("Two.Codeunit.al (more than one object)");
    expect(warned[0]).toContain("B.Codeunit.al (an #if-wrapped object)");
    expect(warned[0]).toContain("R383");
    expect(warned[0]).toContain("R300");
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
    expect(out.config.alRunner?.coverage).toBe("none");
    expect(warned.filter((l) => l.startsWith("[lethal] al-runner settings:"))).toHaveLength(1);
    expect(warned).toHaveLength(2);
  });

  test("after a fallback the advisory says why coverage is off and never advises the key the user set", async () => {
    const dir = await alProject({ "B.Codeunit.al": TWO_ARM });
    const warned: string[] = [];
    await prepareAlRunnerSession(cfg(dir), dir, (l) => warned.push(l));
    const advisory = warned.find((l) => l.startsWith("[lethal] al-runner settings:")) ?? "";
    expect(advisory).toContain("turned off for this run");
    expect(advisory).toContain("B.Codeunit.al (an #if-wrapped object)");
    expect(advisory).not.toContain('"alRunner.coverage": "al-runner" runs only');
  });

  // R205: the guard judges the session's snapshot, not a disk that changed after it was taken.
  test("R205: prepareAlRunnerSession judges the snapshot: multi-object there, single on disk, falls back", async () => {
    const dir = await alProject({ "Two.Codeunit.al": TWO_OBJECTS });
    const snapshot = await readTargetSource(dir);
    await writeFile(join(dir, "Two.Codeunit.al"), "codeunit 50104 P\n{\n}\n", "utf8");
    const warned: string[] = [];
    const out = await prepareAlRunnerSession(cfg(dir), dir, (l) => warned.push(l), {
      snapshot,
      ...refused,
    });
    expect(out.config.alRunner?.coverage).toBe("none");
    expect(warned[0]).toContain("Two.Codeunit.al (more than one object)");
  });

  test("R205: prepareAlRunnerSession judges the snapshot: single there, multi-object on disk, keeps coverage", async () => {
    const dir = await alProject({ "Two.Codeunit.al": "codeunit 50104 P\n{\n}\n" });
    const snapshot = await readTargetSource(dir);
    await writeFile(join(dir, "Two.Codeunit.al"), TWO_OBJECTS, "utf8");
    const warned: string[] = [];
    const out = await prepareAlRunnerSession(cfg(dir), dir, (l) => warned.push(l), { snapshot });
    expect(out.config.alRunner?.coverage).toBe("al-runner");
    expect(warned.filter((l) => l.includes("al-runner-coverage-unsupported"))).toEqual([]);
  });

  test("prepareAlRunnerSession refuses a bad section before anything else", async () => {
    await expect(
      prepareAlRunnerSession({ alRunner: { alRunnerPath: "a", typo: 1 } as never }, "unused"),
    ).rejects.toThrow(/unknown key\(s\): typo/);
  });
});

/**
 * R387 review: the guard must run on the REAL entry point. `buildBackend` passes `coverage` straight
 * through, so a `runFromCli` that skipped `prepareAlRunnerSession` would hand al-runner's coverage a
 * project it cannot describe. Everything that would spawn al-runner is injected.
 */
describe("R387: runFromCli applies the coverage guard before any backend is built", () => {
  const CANARY: AlRunnerCanaryResult = {
    asserterror: "defect-not-reproduced",
    tableGlobalVar: "defect-not-reproduced",
    transactionRollback: "defect-not-reproduced",
  };

  async function coverageReachingBuild(
    files: Record<string, string>,
    /** R205: an edit made after `runFromCli`'s snapshot (inside id validation). */
    edit?: (projectDir: string) => Promise<void>,
  ): Promise<{
    readonly coverage: string | undefined;
    readonly warnings: readonly string[];
    readonly validated: ReadonlyMap<string, Buffer> | undefined;
    readonly built: ReadonlyMap<string, Buffer> | undefined;
  }> {
    const projectDir = await alProject(files);
    const configPath = join(projectDir, "lethal.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ alRunner: { alRunnerPath: "C:/al-runner.exe", coverage: "al-runner" } }),
      "utf8",
    );
    const parsed: RunCliConfig = {
      mode: "run",
      projectDir,
      // R445: a sibling, never the target folder itself (run refuses that layout by name).
      testDir: scratch("lethal-r387-tests-"),
      backendKind: "al-runner",
      dbPath: ":memory:",
      configPath,
      skipKnownSurvivors: false,
      workers: 1,
      keepEnv: false,
      allowExpiringEnv: false,
    };
    let coverage: string | undefined;
    let validated: ReadonlyMap<string, Buffer> | undefined;
    let built: ReadonlyMap<string, Buffer> | undefined;
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let warnings: string[] = [];
    try {
      await expect(
        runFromCli(parsed, {
          validateSelectorIdsForProject: async (_dir, _ids, source) => {
            validated = source;
            await edit?.(projectDir);
          },
          runAlRunnerContractProbe: async () => ({
            facts: [],
            measuredProvisioning: "auto-provision",
            bannerOnStdout: true,
          }),
          runAlRunnerCanary: async () => CANARY,
          alRunnerFrameProbe: REFUSED_FRAME_PROBE,
          buildBackend: async (_p, configFile, _s, _d, _deps, _ids, source) => {
            coverage = configFile.alRunner?.coverage;
            built = source;
            throw new Error("stop before a real backend build");
          },
        }),
      ).rejects.toThrow("stop before a real backend build");
      warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      warnSpy.mockRestore();
    }
    return { coverage, warnings, validated, built };
  }

  // R205: the entry point hands its ONE snapshot to the guard, the id check and the backend build.
  test("R205: an edit after runFromCli's snapshot changes neither the guard's verdict nor what the id check and build read", async () => {
    const { coverage, warnings, validated, built } = await coverageReachingBuild(
      { "Two.Codeunit.al": TWO_OBJECTS },
      async (dir) => writeFile(join(dir, "Two.Codeunit.al"), "codeunit 50104 P\n{\n}\n", "utf8"),
    );
    expect(coverage).toBe("none");
    expect(warnings.some((w) => w.includes("Two.Codeunit.al (more than one object)"))).toBe(true);
    expect(validated?.get("Two.Codeunit.al")?.toString("utf8")).toBe(TWO_OBJECTS);
    expect(built?.get("Two.Codeunit.al")?.toString("utf8")).toBe(TWO_OBJECTS);
  });

  test("a multi-object file reaches buildBackend with coverage none, and the named warning prints", async () => {
    const { coverage, warnings } = await coverageReachingBuild({ "Two.Codeunit.al": TWO_OBJECTS });
    expect(coverage).toBe("none");
    const guard = warnings.filter((w) => w.includes("al-runner-coverage-unsupported"));
    expect(guard).toHaveLength(1);
    expect(guard[0]).toContain("Two.Codeunit.al (more than one object)");
  });

  test("an #if-wrapped object reaches buildBackend with coverage none, and the named warning prints", async () => {
    const { coverage, warnings } = await coverageReachingBuild({ "B.Codeunit.al": TWO_ARM });
    expect(coverage).toBe("none");
    const guard = warnings.filter((w) => w.includes("al-runner-coverage-unsupported"));
    expect(guard).toHaveLength(1);
    expect(guard[0]).toContain("B.Codeunit.al (an #if-wrapped object)");
  });
});
