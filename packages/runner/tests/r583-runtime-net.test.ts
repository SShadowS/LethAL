import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SELECTOR_RESOURCE_FOLDER, SELECTOR_RESOURCE_NAME } from "@lethal/schemata";
import { resourceLegFailures } from "../itest/cli-default-leg";
import {
  AlRunnerBackend,
  AlRunnerTargetCompileError,
  ResourceSelectorRuntimeError,
  assertResourceSelectorRuntime,
} from "../src/al-runner-backend";
import { AL_RUNNER_PREDEFINED_PROBE_TEST } from "../src/al-runner-predefined-probe";
import { OneShotTransport } from "../src/al-runner-transport";
import {
  type DryRunCliConfig,
  type RunCliConfig,
  alRunnerAdvisory,
  dryRunFromCli,
  runFromCli,
} from "../src/cli";
import { runSession } from "../src/orchestrator";
import { AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0 } from "../src/preprocessor-symbols";
import type { SpawnFn } from "../src/publisher";
import { ResultsStore } from "../src/store";
import { fakeProbeSpawn, maskFor, probeFailed } from "./helpers/al-runner-predefined";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { fakeAlRunnerServer } from "./helpers/fake-al-runner-server";
import { removeRunScratchAfterAll, scratchDirs } from "./helpers/scratch";

// R583. al-runner from f23b9b5f on compiles at the app's own `runtime`; LethAL's resource selector
// needs 14.0 (AL0666). Below that the run is refused by name. And a run al-runner did not fully
// compile is never scored: on 069cbf32 such a run exits 3 and its tests still PASS.

const scratch = scratchDirs();
removeRunScratchAfterAll();

const NEEDS =
  "which the resource selector needs (NavApp.GetResourceAsText, AL0666); set app.json runtime ≥ 17.0 or alRunner.selectorMode static";
const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
const QUALIFIED = "Codeunit79100.PostingUpdatesTotal";
const OPTS = { coverage: "none" as const, timeoutMs: 1000 };
const AL0666 = (dir: string) =>
  `SourceFile(${dir}/MutationSelector.Codeunit.al@12:25): error AL0666: 'GetResourceAsText' is not available in runtime version '13.0'. The supported runtime versions are: '14.0' or greater.`;

describe("R583 §2: assertResourceSelectorRuntime", () => {
  const check = (appJson: Record<string, unknown>) => () =>
    assertResourceSelectorRuntime(appJson, "resource");

  test("1: runtime 13.0 with the resource selector is refused by name; static is not", () => {
    expect(check({ runtime: "13.0" })).toThrow(ResourceSelectorRuntimeError);
    expect(check({ runtime: "13.0" })).toThrow(`runtime 13.0 is below 14.0, ${NEEDS}`);
    expect(() => assertResourceSelectorRuntime({ runtime: "13.0" }, "static")).not.toThrow();
  });

  test("2: runtime 14.0 and 17.0 are allowed", () => {
    expect(check({ runtime: "14.0" })).not.toThrow();
    expect(check({ runtime: "17.0" })).not.toThrow();
  });

  test('3: runtime "9.0" is refused, so the compare is numeric', () => {
    expect(check({ runtime: "9.0" })).toThrow(ResourceSelectorRuntimeError);
  });

  test("4: an unparseable runtime is refused (fail closed)", () => {
    for (const runtime of ["fourteen", "14", 14, null, "", "14.0.1"]) {
      expect(check({ runtime })).toThrow(ResourceSelectorRuntimeError);
    }
  });

  test("5: no runtime field is allowed (al-runner compiles at its newest)", () => {
    expect(check({})).not.toThrow();
  });

  test("the advisory says to raise the runtime instead of calling resource faster", () => {
    const low = alRunnerAdvisory({ selectorMode: "static" }, [], "13.0");
    expect(low).toContain('needs app.json runtime 14.0 or above and this app declares "13.0"');
    expect(low).not.toContain('"resource" is faster');
    expect(alRunnerAdvisory({ selectorMode: "static" }, [], "17.0")).toContain(
      '"alRunner.selectorMode": "resource" is faster',
    );
  });
});

/** A batch dir `deploy()` accepts, with the given app.json. */
async function batch(root: string, appJson: Record<string, unknown>): Promise<string> {
  const d = join(root, "batch");
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  await writeFile(join(d, "app.json"), JSON.stringify(appJson), "utf8");
  await writeFile(
    join(d, "mutant-manifest.json"),
    JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
    "utf8",
  );
  return d;
}

describe("R583 §2: deploy() decides the selector mode once", () => {
  test("6: activate() uses the mode decided at deploy, not the config read again", async () => {
    const root = scratch("lethal-r583-mode-");
    const cfg: { selectorMode: "static" | "resource" } & Record<string, unknown> = {
      alRunnerPath: "al-runner",
      instrumentedDir: join(root, "instr"),
      testDir: "/tests",
      selectorObjectId: 50000,
      selectorMode: "resource",
    };
    const backend = new AlRunnerBackend(cfg as never, async () => {
      throw new Error("no spawn expected");
    });
    await backend.deploy(await batch(root, { runtime: "17.0" }));
    cfg.selectorMode = "static";
    await backend.activate("M0001");
    const active = join(root, "instr", "active");
    expect(
      await readFile(join(active, SELECTOR_RESOURCE_FOLDER, SELECTOR_RESOURCE_NAME), "utf8"),
    ).toBe("M0001");
    expect(await readFile(join(active, "MutationSelector.Codeunit.al"), "utf8")).not.toContain(
      "M0001",
    );
  });

  test("deploy() refuses a resource selector on an active/app.json below 14.0", async () => {
    const root = scratch("lethal-r583-deploy-");
    const backend = new AlRunnerBackend({
      alRunnerPath: "al-runner",
      instrumentedDir: join(root, "instr"),
      testDir: "/tests",
      selectorObjectId: 50000,
      selectorMode: "resource",
    });
    await expect(backend.deploy(await batch(root, { runtime: "13.0" }))).rejects.toThrow(
      `runtime 13.0 is below 14.0, ${NEEDS}`,
    );
  });
});

/** A one-shot backend (static selector, no deploy) whose every spawn answers `answer()`. */
async function oneShotBackend(
  answer: (dir: string) => { exitCode: number; envelope?: unknown; stderr?: string },
) {
  const dir = scratch("lethal-r583-oneshot-");
  await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  await writeFile(
    join(dir, "mutant-manifest.json"),
    JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
    "utf8",
  );
  const spawn: SpawnFn = async () => {
    const a = answer(dir);
    return {
      exitCode: a.exitCode,
      stdout: a.envelope === undefined ? "" : alRunnerStdout(a.envelope),
      stderr: a.stderr ?? "",
    };
  };
  const backend = new AlRunnerBackend(
    { alRunnerPath: "al-runner", instrumentedDir: dir, testDir: "/tests", selectorObjectId: 50000 },
    spawn,
  );
  return { backend, dir };
}

const passRow = { name: QUALIFIED, status: "pass", durationMs: 5 };

describe("R583 §3: a run al-runner did not fully compile is never scored", () => {
  test("7 (one-shot): compilationErrors beside passing rows make the row error, on exit 0 and exit 3", async () => {
    for (const exitCode of [0, 3]) {
      const { backend } = await oneShotBackend((dir) => ({
        exitCode,
        envelope: {
          tests: [passRow],
          exitCode,
          compilationErrors: [{ file: dir, errors: ["<bundled>: EMIT-ZERO (1 AL error(s))"] }],
        },
      }));
      await backend.activate("M0001");
      const v = await backend.run(ref, OPTS);
      expect([exitCode, v.outcome]).toEqual([exitCode, "error"]);
      expect(v.failureMessage).toContain("did not fully compile the target bundle");
      expect(v.failureMessage).toContain("EMIT-ZERO");
    }
  });

  test("7 (--server): a summary carrying compilationErrors makes every row error", async () => {
    const dir = scratch("lethal-r583-server-");
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    await writeFile(
      join(dir, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
      "utf8",
    );
    const server = fakeAlRunnerServer([passRow], {
      summary: {
        exitCode: 3,
        compilationErrors: [{ file: "V2_active", errors: [AL0666("/x/active")] }],
      },
    });
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: true,
      },
      undefined,
      server.spawn,
    );
    backend.useMutantBudgetFloor(180_000, 120_000);
    try {
      await backend.activate("M0001");
      const v = await backend.run(ref, OPTS);
      expect(v.outcome).toBe("error");
      expect(v.failureMessage).toContain("did not fully compile the target bundle (exit 3)");
      expect(v.failureMessage).toContain("AL0666");
      // On the baseline the same answer stops the session by name.
      await backend.activate(null);
      await expect(backend.run(ref, OPTS)).rejects.toBeInstanceOf(AlRunnerTargetCompileError);
    } finally {
      await backend.close();
    }
  });

  test("9 (one-shot): each stderr marker counts with an empty compilationErrors, and only for its own invocation", async () => {
    const req = {
      sourceDir: "/instr/active",
      testDir: "/tests",
      qualifiedTest: QUALIFIED,
      testTimeoutSeconds: 5,
      deadlineMs: 5000,
    };
    const env = alRunnerStdout({ tests: [passRow], exitCode: 0, compilationErrors: [] });
    const markers = [
      `<bundled>: EMIT-ZERO — 0 sources emitted, 1 AL error(s):\n  ${AL0666("/instr/active")}`,
      "<bundled>: EMIT-EXCLUDED — LethAL Sandbox App: 1 object(s) could not be compiled and were dropped from the module: [MutationSelector.Codeunit].",
      "PARTIAL-EMIT-DROP — LethAL Sandbox App: 3 declared vs 2 emitted, no diagnostics. Declared: [A, B, C]. Emitted: [A, B].",
    ];
    for (const marker of markers) {
      const stderrs = [`al-runner 2.12.0 · BC 28.5 · 2 apps\n${marker}\n  → 1P/0F/0E`, ""];
      const spawn: SpawnFn = async () => ({
        exitCode: 0,
        stdout: env,
        stderr: stderrs.shift() ?? "",
      });
      const transport = new OneShotTransport("al-runner", spawn);
      const first = await transport.send(req);
      expect([marker.slice(0, 30), first.kind]).toEqual([marker.slice(0, 30), "error"]);
      if (first.kind === "error") expect(first.targetCompile).toBe(true);
      // The next invocation's own stderr is clean, so it scores normally.
      expect((await transport.send(req)).kind).toBe("tests");
    }
  });

  test("11: a TEST-app EMIT-EXCLUDED does not refuse; an absent row is per-test error, as before", async () => {
    const testDir = "/tests";
    const entry = {
      file: testDir,
      errors: [
        "<bundled>: EMIT-EXCLUDED for Sandbox Tests: 1 object(s) dropped from the module — tests they declare are missing: [Unreached.Codeunit].",
        `SourceFile(${testDir}/Unreached.Codeunit.al@3:5): error AL0118: The name 'X' does not exist in the current context`,
      ],
    };
    const stderr = `<bundled>: EMIT-EXCLUDED — Sandbox Tests: 1 object(s) could not be compiled and were dropped from the module: [Unreached.Codeunit].\n<bundled>: AL diagnostics that identified the excluded object(s):\n  SourceFile(${testDir}/Unreached.Codeunit.al@3:5): error AL0118: x\n  → 1P/0F/0E`;
    const answer = (tests: unknown[]) => () => ({
      exitCode: 1,
      envelope: { tests, exitCode: 1, compilationErrors: [entry] },
      stderr,
    });
    // The baseline, where a target entry would throw: the row is absent, so per-test error.
    const absent = (await oneShotBackend(answer([]))).backend;
    await absent.activate(null);
    const v = await absent.run(ref, OPTS);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("pre-dispatch-rejected");
    expect(v.failureMessage).toContain(`no test named "${QUALIFIED}"`);
    // A row that is there is read as before.
    const present = (await oneShotBackend(answer([passRow]))).backend;
    await present.activate(null);
    expect((await present.run(ref, OPTS)).outcome).toBe("pass");
  });
});

// Test 8, at session level through the REAL backend and runSession (template: r518).
const APP_JSON = JSON.stringify({
  id: "5c1d8e2a-3b4f-4a6d-9e7f-2a1b3c4d5e6f",
  name: "R583 Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const TARGET_AL = `codeunit 79000 "R583 Target"
{
    procedure Target()
    begin
        Helper();
    end;

    local procedure Helper()
    begin
    end;
}
`;
const TESTS_AL = `codeunit 79100 "R583 Tests"
{
    Subtype = Test;

    [Test]
    procedure Covers()
    begin
    end;
}
`;

describe("R583 §3: the baseline refuses the session", () => {
  test("8: a baseline whose target did not fully compile stops runSession with AlRunnerTargetCompileError", async () => {
    const root = scratch("lethal-r583-session-");
    const projectDir = join(root, "app");
    const testDir = join(root, "tests");
    const backendDir = join(root, "backend");
    await Bun.write(join(projectDir, "app.json"), APP_JSON);
    await Bun.write(join(projectDir, "R583Target.Codeunit.al"), TARGET_AL);
    await Bun.write(join(testDir, "R583Tests.Codeunit.al"), TESTS_AL);
    const active = join(backendDir, "active");
    let baselineRuns = 0;
    const spawn: SpawnFn = async (argv) => {
      if (argv.includes("--version"))
        return { exitCode: 0, stdout: "al-runner v2.12.0.0", stderr: "" };
      const t = argv.indexOf("--test");
      const wanted = t >= 0 ? argv[t + 1] : undefined;
      if (wanted === undefined) return { exitCode: 0, stdout: "", stderr: "" };
      if (wanted === AL_RUNNER_PREDEFINED_PROBE_TEST) {
        return fakeProbeSpawn(
          probeFailed(maskFor(new Set(AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0))),
        ).spawn(argv);
      }
      for (const f of await readdir(active)) {
        if (/exit\(MutantId = '[^']+'\);/.test(await readFile(join(active, f), "utf8")))
          throw new Error("fake al-runner: a mutant ran, so the baseline was scored");
      }
      baselineRuns += 1;
      const envelope = {
        tests: [{ name: wanted, status: "pass", durationMs: 5 }],
        exitCode: 3,
        compilationErrors: [{ file: active, errors: ["<bundled>: EMIT-ZERO (1 AL error(s))"] }],
      };
      return { exitCode: 3, stdout: alRunnerStdout(envelope), stderr: "" };
    };
    const backend = new AlRunnerBackend(
      { alRunnerPath: "al-runner", instrumentedDir: backendDir, testDir, selectorObjectId: 50000 },
      spawn,
    );
    try {
      await expect(
        runSession({
          backend,
          store: new ResultsStore(":memory:"),
          projectDir,
          testDir,
          instrumentedDir: join(root, "instr"),
          selectorIds: { selectorId: 50000, controlId: 50001, tableId: 50002 },
          mutantTimeoutMs: 20_000,
        }),
      ).rejects.toThrow(/baseline refused: al-runner did not fully compile the target bundle/);
      expect(baselineRuns).toBe(1);
    } finally {
      await backend.close();
    }
  });
});

describe("R583 §2: the CLI refuses before anything is instrumented", () => {
  async function project(runtime: string): Promise<{ app: string; tests: string; config: string }> {
    const root = scratch("lethal-r583-cli-");
    const app = join(root, "app");
    const tests = join(root, "tests");
    await mkdir(app, { recursive: true });
    await mkdir(tests, { recursive: true });
    await writeFile(join(app, "app.json"), JSON.stringify({ ...JSON.parse(APP_JSON), runtime }));
    await writeFile(join(app, "R583Target.Codeunit.al"), TARGET_AL);
    await writeFile(join(tests, "R583Tests.Codeunit.al"), TESTS_AL);
    const config = join(root, "lethal.config.json");
    await writeFile(config, "{}");
    return { app, tests, config };
  }
  function spies() {
    const calls = { buildBackend: 0, runSession: 0 };
    const stop = new Error("reached runSession");
    return {
      calls,
      stop,
      deps: {
        validateSelectorIdsForProject: async () => {},
        buildBackend: async () => {
          calls.buildBackend++;
          throw stop;
        },
        runSession: async () => {
          calls.runSession++;
          throw stop;
        },
      },
    };
  }
  const run = (p: { app: string; tests: string; config: string }): RunCliConfig => ({
    mode: "run",
    projectDir: p.app,
    testDir: p.tests,
    backendKind: "al-runner",
    dbPath: ":memory:",
    configPath: p.config,
    skipKnownSurvivors: false,
    workers: 1,
    keepEnv: false,
    allowExpiringEnv: false,
  });
  const dry = (p: { app: string; config: string }): DryRunCliConfig => ({
    mode: "dry-run",
    projectDir: p.app,
    dbPath: ":memory:",
    configPath: p.config,
    configExplicit: true,
    backendKind: "al-runner",
  });

  test("12: lethal run refuses runtime 13.0 under the default (resource) selector, building nothing", async () => {
    const p = await project("13.0");
    const s = spies();
    const r = runFromCli(run(p), s.deps);
    await expect(r).rejects.toBeInstanceOf(ResourceSelectorRuntimeError);
    await expect(r).rejects.toThrow(`runtime 13.0 is below 14.0, ${NEEDS}`);
    expect(s.calls).toEqual({ buildBackend: 0, runSession: 0 });
  });

  test("12: lethal run --dry-run refuses it too", async () => {
    const p = await project("13.0");
    await expect(dryRunFromCli(dry(p))).rejects.toBeInstanceOf(ResourceSelectorRuntimeError);
  });

  test("12 control: runtime 17.0 gets past the refusal", async () => {
    const p = await project("17.0");
    const s = spies();
    await expect(runFromCli(run(p), s.deps)).rejects.toBe(s.stop);
  });
});

describe("R583 §4: resourceLegFailures", () => {
  const ok = () => ({
    deploys: 1,
    activations: 3,
    problems: [] as string[],
    alHashes: new Set(["h"]),
  });

  test("10: clean evidence passes", () => {
    expect(resourceLegFailures(ok())).toEqual([]);
  });

  test("10: 'no resource file' evidence fails, as do a second compile and an idle leg", () => {
    expect(
      resourceLegFailures({
        ...ok(),
        problems: ["deploy 1: no resource file /x/res/active-mutant.txt"],
      }),
    ).toEqual(["resource: deploy 1: no resource file /x/res/active-mutant.txt"]);
    expect(resourceLegFailures({ ...ok(), alHashes: new Set(["h", "i"]) })).toHaveLength(1);
    expect(resourceLegFailures({ ...ok(), deploys: 0, activations: 0 })).toHaveLength(2);
  });
});
