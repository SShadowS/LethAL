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
import { OneShotTransport, compileFindingsOf, compileOwnerOf } from "../src/al-runner-transport";
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
      expect(v.failureMessage).toContain("the target bundle did not fully compile");
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
      expect(v.failureMessage).toContain("did not fully compile this run (exit 3)");
      expect(v.failureMessage).toContain("the target bundle did not fully compile: V2_active");
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

  test("11 (one-shot, MEASURED): a test-app EMIT-EXCLUDED is not the target's; the exit 3 stays today's error", async () => {
    // output-shapes.md (a): exit 3, a `skipped` row, `suiteErrors` (no compilationErrors).
    const testDir = `${SHAPE}/sandbox-tests`;
    const spawn: SpawnFn = async () => ({
      exitCode: 3,
      stdout: alRunnerStdout({
        tests: [{ name: "Shape Unreached Test.ReadsResource", status: "skipped" }, passRow],
        exitCode: 3,
        suiteErrors: [{ file: testDir, errors: [TEST_APP_SUITE_ERROR] }],
      }),
      stderr: TEST_APP_ONESHOT_STDERR,
    });
    const res = await new OneShotTransport("al-runner", spawn).send({
      sourceDir: `${SHAPE}/app`,
      testDir,
      qualifiedTest: QUALIFIED,
      testTimeoutSeconds: 5,
      deadlineMs: 5000,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.targetCompile).toBeUndefined();
      expect(res.detail).toBe(TEST_APP_ONESHOT_STDERR);
    }
  });

  test("11 (--server, MEASURED): a V2_sandbox-tests entry does not refuse; rows are read as before", async () => {
    const root = scratch("lethal-r583-srv11-");
    const dir = join(root, "instr");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    await writeFile(
      join(dir, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
      "utf8",
    );
    const testDir = join(root, "sandbox-tests");
    const server = fakeAlRunnerServer([passRow], {
      summary: { exitCode: 3, compilationErrors: [testAppServerEntry(testDir)] },
    });
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir,
        selectorObjectId: 50000,
        serverMode: true,
      },
      undefined,
      server.spawn,
    );
    backend.useMutantBudgetFloor(180_000, 120_000);
    try {
      await backend.activate(null);
      expect((await backend.run(ref, OPTS)).outcome).toBe("pass");
    } finally {
      await backend.close();
    }
  });
});

// Measured on 069cbf32 (/coord/handoff/R-583/output-shapes.md); only the scratch root is shortened.
const SHAPE = "/scratch/r583/shape-a";
const TEST_APP_SUITE_ERROR =
  "<bundled>: EMIT-EXCLUDED for Shape Tests: 1 object(s) dropped from the module — tests they declare are missing: [Unreached.Codeunit]. 1 [Test] procedure(s) did not run and are reported as SKIPPED; the module's surviving 1 object(s) ran because nothing surviving references a dropped object.";
const TEST_APP_ONESHOT_STDERR = [
  "al-runner 2.12.0-r583.069cbf32 · BC 28.5.54151.55132 · 2 apps",
  "[1/2] app — 1 suites",
  "[2/2] sandbox-tests — 1 suites",
  "<bundled>: EMIT-EXCLUDED — Shape Tests: 1 object(s) could not be compiled and were dropped from the module, so any tests they declare are MISSING from this run: [Unreached.Codeunit]. Every dropped object is a test codeunit no surviving object in this module references, by name or by object id, so the remaining 1 object(s) still run — the 1 [Test] procedure(s) the dropped object(s) declare are reported as SKIPPED. The AL diagnostics that identified them follow.",
  "<bundled>: AL diagnostics that identified the excluded object(s):",
  `  SourceFile(${SHAPE}/sandbox-tests/Unreached.Codeunit.al@8:12): error AL0666: 'GetResourceAsText' is not available in runtime version '13.0'. The supported runtime versions are: '14.0' or greater.`,
  "  → 0P/0F/0E across 0 tests, 0 suite errors (1.2s)",
  "  → 1P/0F/0E across 2 tests, 1 suite errors (0.3s)",
  "      ! <bundled>: EMIT-EXCLUDED for Shape Tests: 1 object(s) dropped from the module — tests they declare are missing: [Unreached.Codeunit]. 1 [Test] procedure(s) did not run and are reported as SKIPPED; the module's surviving 1 object(s) ran because nothing surviving references a dropped object.",
  "seed: 1328831697",
].join("\n");
const testAppServerEntry = (testDir: string) => ({
  file: `V2_${testDir.split("/").pop() ?? ""}`,
  errors: [
    `EMIT-EXCLUDED: 1 object(s) dropped from the module — tests they declare are missing: [Unreached.Codeunit]. Every dropped object is a test codeunit no surviving object in this module references, by name or by object id, so the remaining 1 object(s) still run — the 1 [Test] procedure(s) the dropped object(s) declare are reported as skipped. The AL diagnostics that identified them follow.\nSourceFile(${testDir}/Unreached.Codeunit.al@8:12): error AL0666: 'GetResourceAsText' is not available in runtime version '13.0'. The supported runtime versions are: '14.0' or greater.`,
  ],
});
const DEPENDENCY_LINE =
  "Microsoft_Tests-TestLibraries v28.5.54151.55132: EMIT-EXCLUDED — 2 of this dependency's 203 object(s) could not be compiled and were dropped, so the loaded assembly provides only 201 of them: [Codeunit .\"Library - Azure KV Mock Mgmt.\", LibraryAzureADAuthFlow.Codeunit]. Dependent AL that touches a dropped object fails later with a cryptic NavNCLMissingMethodException, and a test that only touches the survivors passes while covering less than it claims. AL diagnostics that identified the dropped object(s): SourceFile(/tmp/al-runner-deps/p712696/Microsoft_Tests-TestLibraries_28_5_54151_55132/LibraryAzureKVMockMgmt.Codeunit.al@10:42): error AL0185: DotNet 'MockAzureKeyVaultSecretProvider' is missing | SourceFile(/tmp/al-runner-deps/p712696/Microsoft_Tests-TestLibraries_28_5_54151_55132/LibraryAzureADAuthFlow.Codeunit.al@37:71): error AL0133: Argument 1: cannot convert from 'DotNet \"System.Uri\"' to 'DotNet \"System.Uri\"'";

describe("R583 §3: who owns a compile diagnostic (one test per owner branch)", () => {
  const scope = {
    sourceDir: "/instr/active",
    testDir: "/work/fixtures/sandbox-tests",
    targetApp: { publisher: "LethAL", name: "LethAL Sandbox App" },
    testApp: { publisher: "LethAL", name: "LethAL Sandbox Tests" },
  };

  test("owner is the test DIRECTORY (one-shot envelope `file`): test", () => {
    expect(compileOwnerOf(scope.testDir, ["<bundled>: EMIT-ZERO (1 AL error(s))"], scope)).toBe(
      "test",
    );
  });

  test("owner is V2_<test dir basename> (--server): test", () => {
    const s = { ...scope, testDir: "/work/fixtures/tests" };
    expect(compileOwnerOf("V2_tests", ["EMIT-EXCLUDED: 1 object(s) dropped"], s)).toBe("test");
  });

  test("a HYPHENATED V2_ name (measured V2_sandbox-tests): test", () => {
    expect(compileOwnerOf("V2_sandbox-tests", ["EMIT-EXCLUDED: 1 object(s) dropped"], scope)).toBe(
      "test",
    );
  });

  test("a dependency module (measured Tests-TestLibraries line): a named warning, never a refusal", async () => {
    expect(
      compileOwnerOf("Microsoft_Tests-TestLibraries v28.5.54151.55132", [DEPENDENCY_LINE], scope),
    ).toBe("dependency");
    // End to end on one-shot: the measured stderr, exit 0, one pass. The row is scored, and the drop
    // is reported once, its per-process path masked.
    const stderr = [
      "[1/2] app — 1 suites",
      DEPENDENCY_LINE,
      "[2/2] sandbox-tests — 1 suites",
      "  → 0P/0F/0E across 0 tests, 0 suite errors (7.3s)",
      "  → 1P/0F/0E across 1 tests, 0 suite errors (2.3s)",
    ].join("\n");
    const { backend } = await oneShotBackend(() => ({
      exitCode: 0,
      envelope: { tests: [passRow], exitCode: 0 },
      stderr,
    }));
    await backend.activate(null);
    expect((await backend.run(ref, OPTS)).outcome).toBe("pass");
    await backend.run(ref, OPTS);
    const drops = backend.observedDependencyDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain("Microsoft_Tests-TestLibraries v28.5.54151.55132: EMIT-EXCLUDED");
    expect(drops[0]).toContain("/tmp/al-runner-deps/p<pid>/");
  });

  test("an unattributable entry refuses, named as such, with its owner", () => {
    const f = compileFindingsOf(
      [{ file: "<bundled>", errors: ["EMIT-ZERO (1 AL error(s))"] }],
      undefined,
      scope,
    );
    expect(f.dependency).toEqual([]);
    expect(f.refuse).toEqual([
      'a compile diagnostic not attributable to the test app or a dependency (owner "<bundled>"): <bundled>: EMIT-ZERO (1 AL error(s))',
    ]);
  });

  test("a block ends where the measured output ends it: a later line is never absorbed", () => {
    // The test-app block, then al-runner's own later lines, one of which names the selector. Under a
    // rule that ran to the next `→` or marker, the selector mention made the test block the target's.
    const stderr = [
      "<bundled>: EMIT-EXCLUDED — LethAL Sandbox Tests: 1 object(s) could not be compiled and were dropped from the module: [Unreached.Codeunit].",
      "<bundled>: AL diagnostics that identified the excluded object(s):",
      `  SourceFile(${scope.testDir}/Unreached.Codeunit.al@8:12): error AL0666: x`,
      "[2/2] active — 1 suites, MutationSelector.Codeunit.al loaded",
      "  → 1P/0F/0E across 1 tests, 0 suite errors (0.3s)",
    ].join("\n");
    expect(compileFindingsOf([], stderr, scope)).toEqual({ refuse: [], dependency: [] });
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
      ).rejects.toThrow(
        /baseline refused: al-runner did not fully compile this run .*the target bundle did not fully compile/,
      );
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
