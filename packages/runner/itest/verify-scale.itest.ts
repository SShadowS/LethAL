#!/usr/bin/env bun
/**
 * R270: `lethal verify` wall time at scale, on `sandbox-data`. MEASUREMENT mode: every number is
 * printed and written to LETHAL_VERIFY_SCALE_OUT, and the 0.20 line is recorded, never asserted.
 * NOT a `bun:test` file: a standalone script run by `bun run itest:verify-scale`.
 *
 * Skips cleanly (exit 0) unless LETHAL_ITEST_VERIFY_SCALE=1. `--compile-only` runs offline: it
 * writes the scratch suite and compiles it with alc against the tests app's `.alpackages`, then
 * exits, touching no server.
 *
 * Reads the gitignored `fixtures/sandbox-data/lethal.config.local.json` (never edited: verify gets
 * a TEMP copy carrying the selector ids, R261) and needs `fixtures/sandbox-data-tests/.alpackages`.
 * `tables.baseline.json` is read only. The steps:
 *   1. setup: config, control and BC versions, the temp config;
 *   2. the scratch suite: the committed 68 tests plus five no-op tests, app.json unchanged;
 *   3. source run A, committed suite, fresh store, per verdict equal to tables.baseline.json;
 *   4. V1, V2, V3: `verifyFromCli` over all 68 survivors of A with the scratch suite;
 *   5. scaling points: the first k survivors, k in SCALING_K (never gated);
 *   6. one library `runVerify` over the 68, with its event timeline (not lethal verify's time);
 *   7. B1, B2: fresh full runs with the scratch suite, the denominators;
 *   8. print and write every number;
 *   9. in a finally once 3 began: restore the committed tests app, checked by a fresh read-back;
 *      a restore that did not prove itself KEEPS the scratch dir (its run stores name the artifact).
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { hashPackage } from "../src/baseline-snapshot";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import {
  odataBaseUrl,
  resolveSelectorIds,
  validateBcDevConfig,
  validatePreprocessorSymbols,
  validateSelectorIdsConfig,
  verifyFromCli,
} from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { discoverTests } from "../src/discovery";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { loadInstalledArtifact } from "../src/named-mutants";
import { defaultQuarantineDir, runNamedMutants, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import { QuarantineStore } from "../src/quarantine-store";
import type { SessionReport } from "../src/report";
import { quarantineResourceKey } from "../src/resource-key";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import type { PublishedTestApp } from "../src/test-app-publish";
import { scanTestPageTests } from "../src/testpage-scan";
import { runVerify } from "../src/verify";
import type { VerifyOutput } from "../src/verify";
import { preflightReadOnlyBaseline } from "./baseline-guard";
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import { type NormalizedMutant, keyOf } from "./mutant-equality";
import { assertFreshFullRun } from "./verify-agreement";
import {
  type StampedEvent,
  allSurvivorIds,
  assertOnlyExpectedTestPageRefusal,
  assertVerifyMeasured,
  finishScratch,
  firstSurvivorIds,
  foldLibraryTimeline,
  noOpTestCodeunit,
  restoreResident,
  runSummary,
  verdictDiffs,
  worstRatio,
} from "./verify-scale";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-data");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
const ALPACKAGES = join(TEST_DIR, ".alpackages");
/** Read only, and refused at startup when missing (R332). This gate never writes it. */
const BASELINE_PATH = join(HERE, "tables.baseline.json");
/** The ids `tables.itest.ts` uses; verify reads them from the temp config (R261). */
const SELECTOR_IDS = { selectorId: 79399, controlId: 79398, tableId: 79397 };
const BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";

const SURVIVORS = 68;
/** 68, not the plan's 69: one of the 69 `[Test]` strings in DataTests.Codeunit.al is inside R79's
 *  comment, and discovery (correctly) does not count it. So the scratch suite has 73. */
const COMMITTED_TESTS = 68;
const NOOP_TESTS = 5;
const NOOP_CODEUNIT_ID = 79396;
const NOOP_CODEUNIT_NAME = "Data Verify Scale NoOp";
/** As `newTests[].test` prints them, from the same constants `noOpTestCodeunit` is given. */
const NOOP_NAMES: readonly string[] = Array.from(
  { length: NOOP_TESTS },
  (_, i) => `${NOOP_CODEUNIT_NAME}.VerifyScaleNoOp${i + 1}`,
);
const SCRATCH_TESTS = COMMITTED_TESTS + NOOP_TESTS;
const SCALING_K = [1, 5, 16] as const;
/** The restore's one request, a green committed test, taken from discovery at restore time
 *  (`restoreResident`). Its verdict is printed, not asserted. */
const RESTORE_TEST = { codeunitName: "Data Tests", method: "InsertDoublesAmountWeak" } as const;
const RECOVERY =
  "The container may carry the scratch test app. Republish fixtures/sandbox-data-tests by hand and compare its read-back hash before any other gate.";

async function assertSymbols(): Promise<void> {
  const symbols = await readdir(ALPACKAGES).catch(() => [] as string[]);
  if (!symbols.some((n) => n.toLowerCase().endsWith(".app"))) {
    throw new Error(
      `${ALPACKAGES} holds no .app symbols (it is gitignored). Copy them from a checkout that has them before running this gate.`,
    );
  }
}

/** Step 2: the committed suite (with .alpackages) plus the no-op codeunit, app.json unchanged. */
async function writeScratchSuite(dest: string): Promise<void> {
  await cp(TEST_DIR, dest, { recursive: true });
  await writeFile(
    join(dest, "src", "DataVerifyScaleNoOp.Codeunit.al"),
    noOpTestCodeunit(NOOP_CODEUNIT_ID, NOOP_CODEUNIT_NAME, NOOP_TESTS),
    "utf8",
  );
  assert.equal(
    await readFile(join(dest, "app.json"), "utf8"),
    await readFile(join(TEST_DIR, "app.json"), "utf8"),
    "step 2: the scratch app.json is byte-identical",
  );
  const committed = await discoverTests(TEST_DIR);
  const scratch = (await discoverTests(dest)).map((r) => `${r.codeunitName}.${r.method}`);
  assert.equal(committed.length, COMMITTED_TESTS, "step 2: committed suite test count");
  assert.equal(scratch.length, SCRATCH_TESTS, "step 2: scratch suite test count");
  assert.equal(new Set(scratch).size, scratch.length, "step 2: no test name twice");
  for (const n of NOOP_NAMES) assert.ok(scratch.includes(n), `step 2: ${n} discovered`);
}

if (import.meta.main && process.argv.includes("--compile-only")) {
  const root = await mkdtemp(join(tmpdir(), "lethal-itest-verify-scale-compile-"));
  try {
    await assertSymbols();
    const tools = await defaultAlToolPaths();
    if (!tools) throw new Error("could not locate alc.exe under the AL Language extension install");
    const scratch = join(root, "tests-with-noop");
    await writeScratchSuite(scratch);
    const outputDir = join(root, "out");
    await mkdir(outputDir, { recursive: true });
    const packageCachePath = join(scratch, ".alpackages");
    const compiled = await new ArtifactCompiler(
      { alcPath: tools.alcPath, packageCachePath, outputDir },
      defaultArtifactIo,
    ).compileProject({ projectDir: scratch, packageCachePath, name: "verify-scale-scratch" });
    console.log(
      `compile-only PASS: scratch suite (${SCRATCH_TESTS} tests) compiled with ${tools.alcPath}: ${compiled.appPath} sha256 ${compiled.sha256}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(0);
}

if (!process.env.LETHAL_ITEST_VERIFY_SCALE) {
  console.log(
    "skipped (set LETHAL_ITEST_VERIFY_SCALE=1 and LETHAL_VERIFY_SCALE_OUT=<path>, populate the gitignored fixtures/sandbox-data/lethal.config.local.json, and publish fixtures/sandbox-data-tests to that container to run this)",
  );
  const challenged = await emitSkipped("verify-scale", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md.`,
    );
  }
  return JSON.parse(text) as T;
}

/** The last artifact a store records, with its app id; undefined when it records none. */
function lastRecorded(path: string): { artifactId: string; appId: string } | undefined {
  const s = new ResultsStore(path);
  try {
    const row = s.db
      .query(
        "SELECT run_id, batch_index, artifact_id FROM batch_artifacts ORDER BY run_id DESC, batch_index DESC LIMIT 1",
      )
      .get() as { run_id: number; batch_index: number; artifact_id: string } | null;
    if (row === null) return undefined;
    const appId = s.trustedArtifactRecord(row.run_id, row.batch_index)?.appId;
    if (appId === null || appId === undefined) return undefined;
    return { artifactId: row.artifact_id, appId };
  } finally {
    s.close();
  }
}

async function main(): Promise<void> {
  preflightReadOnlyBaseline(BASELINE_PATH, "verify-scale itest");
  const outPath = process.env.LETHAL_VERIFY_SCALE_OUT;
  if (outPath === undefined || outPath === "") {
    throw new Error("LETHAL_VERIFY_SCALE_OUT=<path> is required: it receives every number");
  }
  await assertSymbols();

  // ---- 1. Setup.
  const configPath = itestConfigPath(PROJECT_DIR);
  const configFile = await readJson<LethalConfigFile>(configPath, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc.exe/altool.exe under the AL Language extension install");
  }
  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-verify-scale-"));
  /** ONE quarantine dir for A, B1, B2, the library runVerify and the restore, so the product's own
   *  consult refuses the restore when an earlier leg stranded the server, instead of publishing into
   *  it. A scratch dir, never the real ~/.lethal store (see bcdev.itest.ts). `verifyFromCli` takes
   *  no quarantine dir and always consults ~/.lethal, so step 7 and the restore ALSO read ~/.lethal
   *  (read-only) through `refuseRealQuarantine`. */
  const quarantineDir = join(scratch, "quarantine");
  /** Read-only on ~/.lethal: throws naming the record when `verifyFromCli` (steps 4 and 5) recorded a
   *  strand there, which the shared scratch dir above cannot see. Never writes or clears it. */
  const refuseRealQuarantine = async (where: string): Promise<void> => {
    const rec = await new QuarantineStore(defaultQuarantineDir()).read(
      quarantineResourceKey({ server: bcdev.server, serverInstance: bcdev.serverInstance }),
    );
    if (rec !== null) {
      throw new Error(
        `${where}: ${defaultQuarantineDir()} records this server quarantined (${rec.opKind}: ${rec.detail}, recorded ${rec.recordedAtIso}); not continuing`,
      );
    }
  };
  const tempConfig = join(scratch, "lethal.config.verify-scale.json");
  await writeFile(
    tempConfig,
    JSON.stringify({ ...configFile, selectorIds: SELECTOR_IDS }, null, 2),
    "utf8",
  );
  assert.deepEqual(
    resolveSelectorIds(
      {},
      validateSelectorIdsConfig((await readJson<LethalConfigFile>(tempConfig, "temp")).selectorIds),
    ),
    SELECTOR_IDS,
    "step 1: the temp config's selectorIds (what verify reads) equal the full runs' (R261)",
  );
  const outputDir = join(scratch, "publish");
  await mkdir(outputDir, { recursive: true });
  const odataCfg = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const deploymentVerifier = new DeploymentVerifier(odataCfg);
  /** A new backend per use, as verify-agreement.itest.ts builds one per leg. */
  const connect = (): BcDevMcpBackend =>
    new BcDevMcpBackend(
      {
        mcpCommand: bcdev.mcpCommand,
        project: PROJECT_DIR,
        server: bcdev.server,
        serverInstance: bcdev.serverInstance,
        company: bcdev.company,
        packageCachePath: bcdev.packageCachePath,
        controlSymbolPath: bcdev.controlSymbolPath,
        ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
        ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
        // As tables.itest.ts: an absent field is a no-op, a present one must reach the backend.
        ...(bcdev.coverageMode !== undefined ? { coverageMode: bcdev.coverageMode } : {}),
      },
      undefined,
      {
        compiler: new ArtifactCompiler(
          { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
          defaultArtifactIo,
        ),
        deployer: new ContainerDeployer(
          {
            altoolPath: toolPaths.altoolPath,
            server: bcdev.server,
            serverInstance: bcdev.serverInstance,
            username: bcdev.username,
            password: bcdev.password,
            ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
          },
          defaultDeployerIo,
        ),
        verifier: deploymentVerifier,
        harnessVerifier,
      },
      (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
    );
  const lease = {
    client: new LeaseClient(odataCfg),
    serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
  };
  /** Full runs begun so far: none may begin between A and the last verify on A's artifact. */
  let fullRunsBegun = 0;
  /** One full run into its own fresh store, wall-clocked from connect to close. No `resume`. */
  const fullRun = async (leg: string, dbPath: string, testDir: string) => {
    fullRunsBegun++;
    const started = Date.now();
    const backend = connect();
    const store = new ResultsStore(dbPath);
    let report: SessionReport;
    try {
      report = await runSession({
        backend,
        store,
        projectDir: PROJECT_DIR,
        testDir,
        instrumentedDir: join(scratch, `instr-${leg}`),
        selectorIds: SELECTOR_IDS,
        lease,
        resourceServer: bcdev.server,
        resourceServerInstance: bcdev.serverInstance,
        quarantineDir,
      });
    } finally {
      store.close();
      await backend.close();
    }
    return { report, outerMs: Date.now() - started };
  };
  const storeFor = async (leg: string) =>
    join(await mkdtemp(join(scratch, `store-${leg}-`)), "verify-scale.sqlite");
  const aDb = await storeFor("a");
  const b1Db = await storeFor("b1");
  const b2Db = await storeFor("b2");
  /** Every full run that began, in order A, B1, B2: the restore's candidates. */
  const began: { leg: string; path: string }[] = [];
  /** Set only when step 9 ran and did not prove itself: the `finally` then KEEPS the scratch dir. */
  let restoreFailed = false;

  try {
    const base = await harnessVerifier.fetchExtensionInstalled(BASE_APPLICATION_ID);
    const controlVersion = await harnessVerifier.fetchControlVersion();
    console.log(`verify-scale itest: LethAL Control ${controlVersion}`);
    console.log(`verify-scale itest: BC build (Base Application) ${base.versions.join(", ")}`);

    // ---- 2. The scratch suite.
    const scratchTests = join(scratch, "tests-with-noop");
    await writeScratchSuite(scratchTests);
    console.log(`step 2 PASS: scratch suite at ${scratchTests}, ${SCRATCH_TESTS} tests`);

    let gateErr: unknown;
    try {
      // ---- 3. Source run A, committed suite.
      began.push({ leg: "A", path: aDb });
      const { report: a, outerMs: aOuterMs } = await fullRun("a", aDb, TEST_DIR);
      console.log(`step 3: A ${runSummary(a)}`);
      const committed = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as NormalizedMutant[];
      const aDiffs = verdictDiffs(committed, a);
      assert.deepEqual(
        aDiffs,
        [],
        `step 3: A differs from tables.baseline.json:\n${aDiffs.join("\n")}`,
      );
      assertOnlyExpectedTestPageRefusal(a);
      const ids = allSurvivorIds(a, SURVIVORS);
      const aArtifact = a.artifacts?.at(-1)?.artifactId;
      if (aArtifact === undefined) throw new Error("step 3: A carries no artifacts[]");
      console.log(
        `step 3 PASS: A ${a.counts.killed}/${a.counts.survived}/${a.counts.noCoverage}, verdicts equal tables.baseline.json; artifact ${aArtifact}; totalMs ${a.timings.totalMs}, outer ${aOuterMs} ms`,
      );

      /** One `lethal verify` through the CLI code path against A, wall-clocked around the call. */
      const verify = async (label: string, survivors: readonly string[]) => {
        assert.equal(fullRunsBegun, 1, `${label}: no full run may begin between A and a verify`);
        assert.equal(
          lastRecorded(aDb)?.artifactId,
          aArtifact,
          `${label}: A's store's last artifact is the one verify names`,
        );
        let text = "";
        const started = Date.now();
        const code = await verifyFromCli(
          {
            mode: "verify",
            dbPath: aDb,
            artifact: aArtifact,
            testDir: scratchTests,
            survivors,
            configPath: tempConfig,
          },
          {
            write: (t) => {
              text += t;
            },
          },
        );
        const ms = Date.now() - started;
        const out = JSON.parse(text) as VerifyOutput;
        assert.equal(out.exitCode, code, `${label}: printed exitCode = returned exit code`);
        assertVerifyMeasured(out, survivors, NOOP_NAMES);
        console.log(
          `${label} PASS: ${survivors.length} survivors, exit ${code}, ${ms} ms (runVerify totalMs ${out.timings.totalMs})`,
        );
        return { ms, timings: out.timings };
      };

      // ---- 4. V1, V2, V3: the gated workload, every survivor.
      const vs = [];
      for (const n of [1, 2, 3]) vs.push(await verify(`step 4 V${n}`, ids));
      const vMs = vs.map((v) => v.ms);

      // ---- 5. Scaling points, never gated.
      const scaling = [];
      for (const k of SCALING_K) {
        const r = await verify(`step 5 k=${k}`, firstSurvivorIds(a, SURVIVORS, k));
        scaling.push({ k, ms: r.ms, timings: r.timings });
      }

      // ---- 6. One library runVerify, with its event timeline.
      assert.equal(fullRunsBegun, 1, "step 6: no full run may begin before the library call");
      assert.equal(lastRecorded(aDb)?.artifactId, aArtifact, "step 6: A's artifact is last");
      const events: StampedEvent[] = [];
      const libBackend = connect();
      const libStore = new ResultsStore(aDb);
      let libOut: VerifyOutput;
      let returnedAt: number;
      try {
        libOut = await runVerify(
          { artifact: aArtifact, survivors: ids, testDir: scratchTests },
          {
            store: libStore,
            backend: libBackend,
            lease,
            resourceServer: bcdev.server,
            resourceServerInstance: bcdev.serverInstance,
            preprocessorSymbols: validatePreprocessorSymbols(configFile.preprocessorSymbols),
            quarantineDir,
            emit: [(e) => events.push({ at: Date.now(), event: e })],
          },
        );
        returnedAt = Date.now();
      } finally {
        libStore.close();
        await libBackend.close();
      }
      assertVerifyMeasured(libOut, ids, NOOP_NAMES);
      const timeline = foldLibraryTimeline(libOut, events, returnedAt);

      // ---- 7. B1, B2: the denominators, the scratch suite, each a fresh store.
      const aByKey = new Map(a.mutants.map((m) => [`${m.batchIndex}/${m.mutantCode}`, keyOf(m)]));
      const bs = [];
      await refuseRealQuarantine("step 7");
      for (const [leg, db] of [
        ["B1", b1Db],
        ["B2", b2Db],
      ] as const) {
        began.push({ leg, path: db });
        const { report: b, outerMs } = await fullRun(leg.toLowerCase(), db, scratchTests);
        console.log(`step 7: ${leg} ${runSummary(b)}`);
        assertFreshFullRun(b);
        const d = verdictDiffs(committed, b);
        assert.deepEqual(
          d,
          [],
          `step 7: ${leg} differs from tables.baseline.json:\n${d.join("\n")}`,
        );
        assertOnlyExpectedTestPageRefusal(b);
        assert.equal(b.staleTestApp, undefined, `step 7: ${leg} has no staleTestApp`);
        assert.equal(
          b.validity.baselineTests.total,
          SCRATCH_TESTS,
          `step 7: ${leg} ran ${SCRATCH_TESTS} baseline tests`,
        );
        for (const id of ids) {
          const key = aByKey.get(id);
          const hits = b.mutants.filter((m) => keyOf(m) === key);
          assert.ok(
            key !== undefined && hits.length === 1 && hits[0]?.verdict === "survived",
            `step 7: ${leg}: ${id} (${key}) is not exactly one survived mutant: ${hits.map((m) => m.verdict).join(", ")}`,
          );
        }
        console.log(
          `step 7 PASS: ${leg} ${b.counts.killed}/${b.counts.survived}/${b.counts.noCoverage}, totalMs ${b.timings.totalMs}, outer ${outerMs} ms`,
        );
        bs.push({ leg, totalMs: b.timings.totalMs, outerMs });
      }

      // ---- 8. Print and write every number. No 0.20 assertion in measurement mode.
      const bOuter = bs.map((b) => b.outerMs);
      const ratio = worstRatio(vMs, bOuter);
      const vSpread = Math.max(...vMs) / Math.min(...vMs);
      const minB = Math.min(...bOuter);
      console.log(`V ms: ${vMs.join(", ")}; max(V)/min(V) = ${vSpread.toFixed(3)}`);
      for (const b of bs)
        console.log(`${b.leg}: timings.totalMs ${b.totalMs}, outer ${b.outerMs} ms`);
      console.log(
        `worstRatio max(V)/min(B outer) = ${ratio.toFixed(4)}${ratio < 0.2 ? " (UNDER 0.20)" : " (NOT under 0.20)"}`,
      );
      console.log(
        `spread: V min ${Math.min(...vMs)} max ${Math.max(...vMs)}; B min ${minB} max ${Math.max(...bOuter)}`,
      );
      for (const s of scaling) {
        console.log(`scaling k=${s.k}: ${s.ms} ms, / min(B outer) = ${(s.ms / minB).toFixed(4)}`);
      }
      console.log("library runVerify timeline (not lethal verify's wall time)");
      for (const [k, v] of Object.entries(timeline)) console.log(`  ${k}: ${v}`);
      await writeFile(
        outPath,
        `${JSON.stringify(
          {
            controlVersion,
            bcBuild: base.versions,
            survivors: SURVIVORS,
            a: { totalMs: a.timings.totalMs, outerMs: aOuterMs, artifactId: aArtifact },
            verifies: vs,
            vMaxOverMin: vSpread,
            denominators: bs,
            worstRatio: ratio,
            underLine: ratio < 0.2,
            spread: {
              vMin: Math.min(...vMs),
              vMax: Math.max(...vMs),
              bMin: minB,
              bMax: Math.max(...bOuter),
            },
            scaling: scaling.map((s) => ({ ...s, overMinB: s.ms / minB })),
            libraryTimeline: timeline,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`step 8: numbers written to ${outPath}`);
    } catch (err) {
      gateErr = err;
    }

    // ---- 9. Restore the committed tests app. Always, once step 3 began.
    let restoreErr: unknown;
    if (began.length > 0) {
      try {
        await restore();
      } catch (err) {
        restoreErr = err;
        restoreFailed = true;
      }
    }
    if (gateErr !== undefined || restoreErr !== undefined) {
      const describe = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
      throw new Error(
        [
          gateErr !== undefined
            ? `steps 3 to 8 FAILED: ${describe(gateErr)}`
            : "steps 3 to 8 passed",
          restoreErr !== undefined
            ? `step 9 (restore) FAILED: ${describe(restoreErr)}. ${RECOVERY} Scratch kept at ${scratch}.`
            : "step 9 (restore) PASSED: the committed tests app is back, by a fresh read-back",
        ].join("\n"),
      );
    }
  } finally {
    await finishScratch(scratch, restoreFailed, {
      rm: (p) => rm(p, { recursive: true, force: true }).catch(() => {}),
      list: (p) => readdir(p),
      log: (line) => console.error(line),
    });
  }

  /** Step 9: `restoreResident` decides; this supplies the server touches and the publish. */
  async function restore(): Promise<void> {
    await refuseRealQuarantine("step 9");
    await restoreResident({
      began,
      lastRecorded,
      checkResident: (c) => deploymentVerifier.verify({ appId: c.appId, artifactId: c.artifactId }),
      testDir: TEST_DIR,
      carrier: RESTORE_TEST,
      scan: scanTestPageTests,
      log: (line) => console.log(line),
      publish: async (resident, restoreMethod, testPageRefused) => {
        const store = new ResultsStore(resident.path);
        const backend = connect();
        try {
          const rec = store.artifactRecordById(resident.artifactId);
          if (rec === null || rec.appPath === null || rec.instrumentedDir === null) {
            throw new Error("the resident run did not record its installed files");
          }
          const installed = {
            fromRunId: rec.runId,
            batchIndex: rec.batchIndex,
            appPath: rec.appPath,
            instrumentedDir: rec.instrumentedDir,
          };
          const { artifact, manifest } = await loadInstalledArtifact(store, installed);
          // ponytail: any installed mutant carries the publish; the restore measures nothing.
          const [anyMutant] = manifest.mutants;
          if (anyMutant === undefined)
            throw new Error("step 9: the resident manifest has no mutant");
          const compiled = await backend.compileTestApp(TEST_DIR, artifact);
          const runId = store.createRun({
            projectPath: PROJECT_DIR,
            backend: "itest-verify-scale-restore",
            appVersion: "0.0.0.0",
          });
          let published: PublishedTestApp | undefined;
          const res = await runNamedMutants({
            backend,
            store,
            runId,
            installed,
            requests: [{ mutantId: anyMutant.mutantId, methods: [restoreMethod] }],
            lease,
            resourceServer: bcdev.server,
            resourceServerInstance: bcdev.serverInstance,
            quarantineDir,
            // R-236c: the product's own scan, so a carrier that may open a TestPage is never sent.
            testPageRefused,
            inLease: async (fence) => {
              published = await backend.publishTestApp(fence, compiled);
            },
          });
          assert.ok(published !== undefined, "step 9: the publish returned no identity");
          assert.equal(published.sha256, compiled.sha256, "step 9: published sha256 = compiled");
          const fresh = await backend.fetchPublishedAppPackage({
            publisher: compiled.publisher,
            name: compiled.name,
          });
          assert.ok(fresh instanceof Uint8Array, "step 9: a fresh read-back must answer");
          assert.equal(hashPackage(fresh), compiled.sha256, "step 9: fresh read-back = compiled");
          assert.equal(res.quarantined, undefined, `step 9: no quarantine (${res.quarantined})`);
          console.log(
            `step 9 PASS: restored ${compiled.name} against ${resident.artifactId} (${resident.leg}); fresh read-back equal; carrier verdict ${res.outcomes.map((o) => o.verdict).join(", ")}`,
          );
        } finally {
          store.close();
          await backend.close();
        }
      },
    });
  }

  console.log("verify-scale itest: PASS (measurement mode, the 0.20 line is recorded, not gated)");
  await emitPassed("verify-scale", { sublegs: ["verify-scale"], artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  await emitFailed("verify-scale", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
