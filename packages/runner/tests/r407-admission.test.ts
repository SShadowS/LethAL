import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { AlRunnerBackend, type AlRunnerProvisionResult } from "../src/al-runner-backend";
import type { AlRunnerCanaryResult } from "../src/al-runner-canary";
import {
  AlRunnerCoverageFrameError,
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import type {
  AlRunnerFrameProbeRequest,
  AlRunnerFrameProbeResult,
} from "../src/al-runner-frame-probe";
import type { ExecutionBackend } from "../src/backend";
import {
  type LethalConfigFile,
  type RunCliConfig,
  applyAlRunnerCoverageGuard,
  buildBackend,
  runFromCli,
  validateAlRunnerConfig,
} from "../src/cli";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { removeRunScratchAfterAll, scratchDirs } from "./helpers/scratch";

/**
 * R407 P3 (admission plumbing) and P5 (backstops). The frame probe and provisioning are fakes with
 * call counters; everything between them and the coverage index is production code.
 */

const scratch = scratchDirs();
removeRunScratchAfterAll();

const PAIR_FILE = "Pair.Codeunit.al";
/** Two codeunits in one file: P (lines 1-7, `exit;` at 5) then Q (8-14, `exit;` at 12). */
const PAIR = `codeunit 50104 P
{
    procedure Run()
    begin
        exit;
    end;
}
codeunit 50105 Q
{
    procedure Run()
    begin
        exit;
    end;
}
`;
const SINGLE = `codeunit 50106 S
{
    procedure Run()
    begin
        exit;
    end;
}
`;

const ADMITTED: AlRunnerFrameProbeResult = {
  outcome: "admitted",
  transport: "server",
  build: "al-runner v2.12.0-main.43f76177",
  lines: [45, 46, 47],
  labels: ["/x/inst/active/R407Pair.Table.al"],
};
const REFUSED: AlRunnerFrameProbeResult = {
  outcome: "refused",
  transport: "server",
  build: "al-runner v2.12.0-main.c39ad5de",
  refusal: "lines-differ",
  reason: "Probe B was reported hit at lines [33, 34, 35]",
};

function probeFake(answer: AlRunnerFrameProbeResult) {
  const calls: AlRunnerFrameProbeRequest[] = [];
  return {
    calls,
    frameProbe: async (req: AlRunnerFrameProbeRequest) => {
      calls.push(req);
      return answer;
    },
  };
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = scratch("lethal-r407-project-");
  await writeFile(
    join(dir, "app.json"),
    JSON.stringify({
      id: "11111111-1111-1111-1111-111111111111",
      runtime: "13.0",
      idRanges: [{ from: 50000, to: 79999 }],
    }),
    "utf8",
  );
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, "utf8");
  return dir;
}

const cfg = (serverMode?: boolean): LethalConfigFile => ({
  alRunner: {
    alRunnerPath: "al-runner",
    coverage: "al-runner",
    ...(serverMode !== undefined ? { serverMode } : {}),
  },
});

describe("R407 P3: the coverage guard runs the frame probe only when it must", () => {
  test("admitted: coverage stays al-runner, admission is true, one warning names the build", async () => {
    const dir = await project({ [PAIR_FILE]: PAIR });
    const probe = probeFake(ADMITTED);
    let provisions = 0;
    const warned: string[] = [];
    const out = await applyAlRunnerCoverageGuard(cfg(), dir, (l) => warned.push(l), {
      frameProbe: probe.frameProbe,
      provision: async () => {
        provisions += 1;
        return { elapsedMs: 0, ran: true, downloaded: false, detail: "", platformAppsDir: "/p" };
      },
    });
    expect(out.config.alRunner?.coverage).toBe("al-runner");
    expect(out.admitMultiObjectFiles).toBe(true);
    // The default transport is --server: the probe answers for it, and the daemon takes no pin.
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.serverMode).toBe(true);
    expect(probe.calls[0]?.platformAppsDir).toBeUndefined();
    expect(provisions).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("al-runner-coverage-frame-admitted");
    expect(warned[0]).toContain(`${PAIR_FILE} (more than one object)`);
    expect(warned[0]).toContain("al-runner build: al-runner v2.12.0-main.43f76177");
  });

  test("a one-shot session provisions once on its test project and probes PINNED", async () => {
    const dir = await project({ [PAIR_FILE]: PAIR });
    const probe = probeFake(ADMITTED);
    const provisioned: string[] = [];
    await applyAlRunnerCoverageGuard(cfg(false), dir, () => {}, {
      testDir: "/the/tests",
      frameProbe: probe.frameProbe,
      provision: async (c): Promise<AlRunnerProvisionResult> => {
        provisioned.push(c.testDir);
        return { elapsedMs: 0, ran: true, downloaded: false, detail: "", platformAppsDir: "/pin" };
      },
    });
    expect(provisioned).toEqual(["/the/tests"]);
    expect(probe.calls.map((c) => [c.serverMode, c.platformAppsDir])).toEqual([[false, "/pin"]]);
  });

  test("refused: coverage none, admission false, the warning names the probe's reason", async () => {
    const dir = await project({ [PAIR_FILE]: PAIR });
    const warned: string[] = [];
    const out = await applyAlRunnerCoverageGuard(cfg(), dir, (l) => warned.push(l), {
      frameProbe: probeFake(REFUSED).frameProbe,
    });
    expect(out.config.alRunner?.coverage).toBe("none");
    expect(out.admitMultiObjectFiles).toBe(false);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("al-runner-coverage-unsupported");
    expect(warned[0]).toContain("lines-differ: Probe B was reported hit at lines [33, 34, 35]");
  });

  test("no multi-object file: the probe and provisioning are never called", async () => {
    const dir = await project({ "S.Codeunit.al": SINGLE });
    const probe = probeFake(ADMITTED);
    let provisions = 0;
    const out = await applyAlRunnerCoverageGuard(cfg(false), dir, () => {}, {
      testDir: "/t",
      frameProbe: probe.frameProbe,
      provision: async () => {
        provisions += 1;
        return { elapsedMs: 0, ran: true, downloaded: false, detail: "" };
      },
    });
    expect([probe.calls.length, provisions]).toEqual([0, 0]);
    expect(out).toEqual({ config: cfg(false), named: [], admitMultiObjectFiles: false });
  });

  test("admission is NEVER a config key: the strict key check refuses it", async () => {
    expect(() =>
      validateAlRunnerConfig({ alRunnerPath: "a", admitMultiObjectFiles: true } as never),
    ).toThrow(/unknown key\(s\): admitMultiObjectFiles/);
  });
});

/** A deployable bundle holding the pair file (and its manifest). */
async function pairBundle(): Promise<string> {
  const d = scratch("lethal-r407-bundle-");
  await writeFile(join(d, PAIR_FILE), PAIR, "utf8");
  await writeFile(join(d, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  // buildBackend's default selector mode (resource, R387) declares its folder in the bundle's app.json.
  await writeFile(join(d, "app.json"), JSON.stringify({ id: "1", runtime: "13.0" }), "utf8");
  await writeFile(
    join(d, "mutant-manifest.json"),
    JSON.stringify({
      artifactId: "a".repeat(32),
      mutants: [{ objectType: "codeunit", codeunitId: 50105 }],
    }),
    "utf8",
  );
  return d;
}

const CANARY: AlRunnerCanaryResult = {
  asserterror: "defect-not-reproduced",
  tableGlobalVar: "defect-not-reproduced",
  transactionRollback: "defect-not-reproduced",
};

/**
 * runFromCli with the REAL buildBackend at `workers` workers and a fake runSession that deploys the
 * pair bundle, coverage on, into the main backend and every worker. Returns, per backend, `ok` or
 * the error deploy threw.
 */
async function deployEveryBackend(
  answer: AlRunnerFrameProbeResult,
  workers: number,
): Promise<{ results: string[]; probes: number }> {
  const projectDir = await project({ [PAIR_FILE]: PAIR });
  const configPath = join(projectDir, "lethal.config.json");
  await writeFile(
    configPath,
    JSON.stringify({ alRunner: { alRunnerPath: "al-runner", coverage: "al-runner" } }),
    "utf8",
  );
  const parsed: RunCliConfig = {
    mode: "run",
    projectDir,
    testDir: scratch("lethal-r407-tests-"),
    backendKind: "al-runner",
    dbPath: ":memory:",
    configPath,
    skipKnownSurvivors: false,
    workers,
    keepEnv: false,
    allowExpiringEnv: false,
  };
  const probe = probeFake(answer);
  const bundle = await pairBundle();
  const results: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(
      runFromCli(parsed, {
        validateSelectorIdsForProject: async () => {},
        runAlRunnerContractProbe: async () => ({
          facts: [],
          measuredProvisioning: "auto-provision",
          bannerOnStdout: true,
        }),
        runAlRunnerCanary: async () => CANARY,
        alRunnerFrameProbe: probe.frameProbe,
        runSession: async (sessionCfg) => {
          const all: ExecutionBackend[] = [sessionCfg.backend];
          for (let i = 0; i < workers && workers > 1; i++) {
            const b = sessionCfg.backendFactory?.(i);
            if (b !== undefined) all.push(b);
          }
          for (const b of all) {
            const ar = b as AlRunnerBackend;
            ar.useBuildSymbols([]);
            try {
              await ar.deploy(bundle);
              results.push("ok");
            } catch (e) {
              results.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
            }
          }
          throw new Error("stop after the deploys");
        },
      }),
    ).rejects.toThrow("stop after the deploys");
  } finally {
    warn.mockRestore();
  }
  return { results, probes: probe.calls.length };
}

describe("R407 P3: admission reaches the main backend AND every pre-built worker", () => {
  test("admitted at --workers 3: all four backends deploy the pair with coverage on", async () => {
    const { results, probes } = await deployEveryBackend(ADMITTED, 3);
    expect(probes).toBe(1);
    expect(results).toEqual(["ok", "ok", "ok", "ok"]);
  });

  test("refused: coverage is none, so no backend builds a coverage index at all", async () => {
    const { results } = await deployEveryBackend(REFUSED, 2);
    expect(results).toEqual(["ok", "ok", "ok"]);
  });

  test("buildBackend never admits unless told: the same deploy throws AlRunnerCoverageFrameError", async () => {
    const projectDir = await project({ [PAIR_FILE]: PAIR });
    const built = (await buildBackend(
      {
        backendKind: "al-runner",
        projectDir,
        testDir: "/t",
        stopHungSessions: false,
      } as never,
      { alRunner: { alRunnerPath: "al-runner", coverage: "al-runner" } },
      scratch("lethal-r407-built-"),
      undefined,
      {},
      undefined,
      undefined,
    )) as AlRunnerBackend;
    built.useBuildSymbols([]);
    await expect(built.deploy(await pairBundle())).rejects.toThrow(AlRunnerCoverageFrameError);
    await built.close();
  });
});

/** A backend with coverage on, admitted or not, over a scratch work dir. */
function backendOver(workDir: string, admit: boolean, spawn?: SpawnFn): AlRunnerBackend {
  const b = new AlRunnerBackend(
    {
      alRunnerPath: "al-runner",
      instrumentedDir: workDir,
      testDir: "/tests",
      selectorObjectId: 50000,
      coverage: "al-runner",
      ...(admit ? { admitMultiObjectFiles: true } : {}),
    },
    spawn,
  );
  b.useBuildSymbols([]);
  return b;
}

describe("R407 P5: the backend's backstops", () => {
  test("an index with a multi-object file and no admission throws at deploy", async () => {
    const b = backendOver(scratch("lethal-r407-work-"), false);
    await expect(b.deploy(await pairBundle())).rejects.toThrow(
      `bundle holds multi-object file(s) ${PAIR_FILE}, but no frame-probe admission reached this backend`,
    );
    await b.close();
  });

  test("control: a single-object bundle deploys without admission, as before", async () => {
    const d = await pairBundle();
    await writeFile(join(d, PAIR_FILE), SINGLE, "utf8");
    await writeFile(
      join(d, "mutant-manifest.json"),
      JSON.stringify({ artifactId: "a".repeat(32), mutants: [] }),
      "utf8",
    );
    const b = backendOver(scratch("lethal-r407-work-"), false);
    await b.deploy(d);
    await b.close();
  });

  test("an admitted multi-object index built before any deploy() throws", async () => {
    // No deploy: activeDir() falls back to cfg.instrumentedDir, the parent of the batch folders.
    const work = await pairBundle();
    const b = backendOver(work, true);
    await expect(b.coverageRefusals()).rejects.toThrow("was asked for before any deploy()");
    await b.close();
  });

  test("after deploy, the label check uses the index's OWN active folder: a batch sibling's label throws", async () => {
    const work = scratch("lethal-r407-work-");
    let label = "";
    const spawn: SpawnFn = async (argv) => {
      const out = argv[argv.indexOf("--coverage-out") + 1];
      if (out !== undefined) {
        await writeFile(
          out,
          `<coverage><packages><package><classes><class name="x" filename="${label}"><lines><line number="12" hits="1"/></lines></class></classes></package></packages></coverage>`,
          "utf8",
        );
      }
      return {
        exitCode: 0,
        stdout: alRunnerStdout({ tests: [{ name: "Codeunit79100.T", status: "pass" }] }),
        stderr: "",
      };
    };
    const b = backendOver(work, true, spawn);
    await b.deploy(await pairBundle());
    const ref = { codeunitId: 79100, codeunitName: "T", method: "T" };
    // In the deployed bundle (`<work>/active`), relative to LethAL's cwd as al-runner prints it.
    label = relative(process.cwd(), join(work, "active", PAIR_FILE));
    const ok = await b.run(ref, { coverage: "none", timeoutMs: 5000 });
    expect(ok.coverage?.entries).toEqual([
      { objectType: "Codeunit", objectId: 50105, procedure: "Run", line: 5 },
    ]);
    // A batch folder beside `active`: same file name, same app, outside the bundle.
    label = relative(process.cwd(), join(work, "batch-1", PAIR_FILE));
    await expect(b.run(ref, { coverage: "none", timeoutMs: 5000 })).rejects.toThrow(
      AlRunnerCoverageFrameError,
    );
    await b.close();
  });
});

describe("R407 P5: the label backstop, each label shape (index level)", () => {
  /** `<root>/inst/active` holds the file; `<root>/src` and `<root>/inst/batch-1` are siblings. */
  async function rooted(text: string) {
    const root = scratch("lethal-r407-labels-");
    const bundle = join(root, "inst", "active");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, PAIR_FILE), text, "utf8");
    const index = await buildAlRunnerCoverageIndex(bundle, {
      admitMultiObjectFiles: true,
      labelBase: root,
    });
    return { root, index };
  }
  const cobertura = (file: string) => [{ file, line: 12, hits: 1 }];
  const server = (file: string) => ({
    test: "Codeunit1.T",
    coverage: [{ file, statements: [{ line: 12, hits: 1, scope: "Run" }] }],
  });
  const outside: [string, (root: string) => string][] = [
    ["a relative SOURCE label", () => `src/${PAIR_FILE}`],
    ["a relative BATCH-SIBLING label", () => `inst/batch-1/${PAIR_FILE}`],
    ["an absolute SOURCE label", (root) => join(root, "src", PAIR_FILE)],
    ["an absolute BATCH-SIBLING label", (root) => join(root, "inst", "batch-1", PAIR_FILE)],
    ["a look-alike folder (active-old)", (root) => join(root, "inst", "active-old", PAIR_FILE)],
  ];
  for (const [name, labelOf] of outside) {
    test(`${name} on an admitted multi-object file throws, on both transports`, async () => {
      const { root, index } = await rooted(PAIR);
      const label = labelOf(root);
      expect(() => alRunnerCoverageFrom(cobertura(label), index)).toThrow(
        AlRunnerCoverageFrameError,
      );
      expect(() => alRunnerCoverageFromServer(server(label), index)).toThrow(
        AlRunnerCoverageFrameError,
      );
    });
    test(`${name} on a SINGLE-object file does not throw (unchanged)`, async () => {
      const { root, index } = await rooted(SINGLE);
      const label = labelOf(root);
      expect(() => alRunnerCoverageFrom(cobertura(label), index)).not.toThrow();
      expect(() => alRunnerCoverageFromServer(server(label), index)).not.toThrow();
    });
  }
  test("relative and absolute labels INSIDE the bundle resolve to Q.Run", async () => {
    const { root, index } = await rooted(PAIR);
    const want = [{ objectType: "Codeunit", objectId: 50105, procedure: "Run", line: 5 }];
    expect(alRunnerCoverageFrom(cobertura(`inst/active/${PAIR_FILE}`), index).entries).toEqual(
      want,
    );
    const abs = join(root, "inst", "active", PAIR_FILE);
    expect(alRunnerCoverageFromServer(server(abs), index).entries).toEqual(want);
  });
});
