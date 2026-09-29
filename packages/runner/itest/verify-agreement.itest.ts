#!/usr/bin/env bun
/**
 * C02-08 Task 4: `lethal verify` against a FRESH full run, per mutant, on `sandbox-harden`. NOT a
 * `bun:test` file: a standalone script run by `bun run itest:agreement`, never picked up by
 * `bun test`.
 *
 * Skips cleanly (exit 0) unless LETHAL_ITEST_AGREEMENT=1.
 *
 * Reads the gitignored `fixtures/sandbox-harden/lethal.config.local.json` and needs
 * `fixtures/sandbox-harden-tests/.alpackages` (gitignored too). Both full runs use their own fresh
 * temp store; verify is driven through `verifyFromCli`, the CLI code path, against the source
 * run's store. `harden.baseline.json` is read only.
 *
 * Every prediction is pre-committed in
 * docs/superpowers/specs/2026-09-26-c02-08-agreement-precommitment.md. The steps:
 *   1. source run A with the base suite, per mutant equal to harden.baseline.json;
 *   2. a scratch copy of the base suite plus the answer key's five tests;
 *   3. verify the five planted survivors with it: 4 killed, 1 skipped, one test-app publish;
 *   4. fresh full run B with the scratch suite, per mutant against the pre-committed table;
 *   5. compare verify to B (every row agrees), and the negative control against A;
 *   6. the wall-time ratio: verify faster than B is gated, the 20% line only recorded;
 *   7. in a finally once 3 began: restore the committed tests app, checked by a fresh read-back.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import { hashPackage } from "../src/baseline-snapshot";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import {
  loadEquivalenceMarks,
  odataBaseUrl,
  resolveSelectorIds,
  validateBcDevConfig,
  validateSelectorIdsConfig,
  verifyFromCli,
} from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { discoverTests } from "../src/discovery";
import type { EquivalenceMark } from "../src/equivalence-marks";
import { formatFailure } from "../src/format-failure";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import { loadInstalledArtifact } from "../src/named-mutants";
import { defaultQuarantineDir, runNamedMutants, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import { type MutantOutcome, type SessionReport, mutantRef } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import type { PublishedTestApp } from "../src/test-app-publish";
import { scanTestPageTests } from "../src/testpage-scan";
import { VERIFY_EXIT } from "../src/verify";
import type { VerifyOutput, VerifyResult } from "../src/verify";
import { preflightReadOnlyBaseline } from "./baseline-guard";
import { itestConfigName, itestConfigPath } from "./config-path";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  ANSWER_KILLERS,
  EXPECTED,
  type Planted,
  assertHardenMarks,
  assertHardenVerdicts,
  assertSingleBatch,
  describeRow,
  siteOf,
} from "./harden-expected";
import { diffMutants, keyOf, normalizeForComparison } from "./mutant-equality";
import type { NormalizedMutant } from "./mutant-equality";
import {
  SCRATCH_ANSWERS,
  assertFreshFullRun,
  compareVerifyToFullRun,
  writeScratchSuite,
} from "./verify-agreement";

if (!process.env.LETHAL_ITEST_AGREEMENT) {
  console.log(
    "skipped (set LETHAL_ITEST_AGREEMENT=1, populate the gitignored " +
      "fixtures/sandbox-harden/lethal.config.local.json, and publish fixtures/sandbox-harden-tests " +
      "to that container to run this)",
  );
  const challenged = await emitSkipped("agreement", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-harden");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-harden-tests");
const ANSWERS_FILE = join(
  REPO_ROOT,
  "fixtures",
  "sandbox-harden-answers",
  "src",
  "HardenAnswerKey.Codeunit.al",
);
const CONFIG_LOCAL_PATH = itestConfigPath(PROJECT_DIR);
/** Read only, and refused at startup when missing (R332). This gate never writes it. */
const BASELINE_PATH = join(HERE, "harden.baseline.json");
/** R261: verify reads the config's selector ids, the full runs read this; asserted equal first. */
const SELECTOR_IDS = { selectorId: 79547, controlId: 79548, tableId: 79549 };
/** Microsoft's Base Application: its installed version is the BC build this gate ran against. */
const BASE_APPLICATION_ID = "437dbf0e-84ff-417a-965d-ed2bb9650972";
const BASE_TESTS = { codeunitId: 79550, codeunitName: "Harden Tests" } as const;
/** The restore's one request: S1 against the base test that covers it, expected `survived`. */
const RESTORE_METHOD: TestMethodRef = { ...BASE_TESTS, method: "IsLargeSeparatesSmallFromLarge" };

/** The planted survivors' full identity keys, as frozen in harden.baseline.json. */
const PLANTED_KEYS: Readonly<Record<Planted, string>> = {
  S1: "58ade303c82ea175e1cabd4e46b8cd818e3a59a66b60578ef4d85077548d40e9|Harden Logic|IsLarge|lethal.conditional-boundary|1",
  S2: "2e821ee40319483c2f98a63dec7173245c4b6530d33ff195266e1d190ff97472|Harden Logic|CountInCategory|lethal.remove-setrange|1",
  S3: "33880a1aced9249c8c382656ef30f8da90465d9dab7ba9dc12aae0665e0fdea6|Harden Logic|FirstAmount|lethal.swap-find-direction|1",
  S4: "cf13621963fe1922354a41365812fb0d4e692fe8c2d0ae3e9711fcb3b356e57b|Harden Logic|SetAmount|lethal.validate-to-assign|1",
  S5: "96a63130808135b948b1586ff3955d7a0691ff1d8a86e6c03212ba73831d4f29|Harden Logic|BonusFor|lethal.remove-assignment|1",
};
/** The answer tests' own `Error(...)` texts (pre-committed hypotheses). */
const KILL_TEXTS: Readonly<Record<Exclude<Planted, "S5">, string>> = {
  S1: "IsLarge(100) should be false, got true",
  S2: "CountInCategory(A) should be 2, got 3",
  S3: "FirstAmount() should be 7, got 9",
  S4: "SetAmount(Entry, 5) should leave Doubled 10, got 0",
};
const PLANTED: readonly Planted[] = ["S1", "S2", "S3", "S4", "S5"];
const KILLED_PLANTED = ["S1", "S2", "S3", "S4"] as const;
const SCRATCH_TESTS = [
  "Harden Tests.IsLargeSeparatesSmallFromLarge",
  "Harden Tests.CountInCategoryCountsRows",
  "Harden Tests.FirstAmountReadsARow",
  "Harden Tests.SetAmountStoresTheAmount",
  "Harden Tests.AmountValidateDoublesIt",
  "Harden Tests.BonusForPaysOnlyAboveTen",
  ...Object.values(ANSWER_KILLERS).map((m) => `${SCRATCH_ANSWERS.codeunitName}.${m}`),
  `${SCRATCH_ANSWERS.codeunitName}.BonusForTwiceOnOneInstance`,
];
const RECOVERY =
  "The container may carry the scratch test app. Republish fixtures/sandbox-harden-tests by hand (C02-03 plan Task 5 step 3, dev endpoint) and see itest:harden pass before any other gate.";

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

async function quarantineRecords(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function plantedRow(p: Planted) {
  const rows = EXPECTED.filter((r) => r.planted === p);
  const [row] = rows;
  assert.ok(row !== undefined && rows.length === 1, `${rows.length} EXPECTED rows planted ${p}`);
  return row;
}

/** Exactly one mutant of `report` at the (file, line, operator) site. */
function mutantAt(report: SessionReport, file: string, line: number, op: string): MutantOutcome {
  const site = siteOf(file, line, op);
  const hits = report.mutants.filter((m) => siteOf(m.file, m.line, m.operatorName) === site);
  const [hit] = hits;
  assert.ok(hit !== undefined && hits.length === 1, `${hits.length} mutants at ${site}, not 1`);
  return hit;
}

/** Counts every `LeaseClient.acquire`, including verify's own. */
let acquires = 0;
const realAcquire = LeaseClient.prototype.acquire;
LeaseClient.prototype.acquire = function (
  this: LeaseClient,
  ...args: Parameters<LeaseClient["acquire"]>
) {
  acquires++;
  return realAcquire.apply(this, args);
};
/** Counts every test-app publish: verify must publish exactly once (epic line). */
let testAppPublishes = 0;
const realPublishTestApp = BcDevMcpBackend.prototype.publishTestApp;
BcDevMcpBackend.prototype.publishTestApp = function (
  this: BcDevMcpBackend,
  ...args: Parameters<BcDevMcpBackend["publishTestApp"]>
) {
  testAppPublishes++;
  return realPublishTestApp.apply(this, args);
};

async function main(): Promise<void> {
  preflightReadOnlyBaseline(BASELINE_PATH, "agreement itest");
  const alpackages = join(TEST_DIR, ".alpackages");
  const symbols = await readdir(alpackages).catch(() => [] as string[]);
  if (!symbols.some((n) => n.toLowerCase().endsWith(".app"))) {
    throw new Error(
      `${alpackages} holds no .app symbols (it is gitignored). Copy them from a checkout that has them before running this gate.`,
    );
  }
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  assert.deepEqual(
    resolveSelectorIds({}, validateSelectorIdsConfig(configFile.selectorIds)),
    SELECTOR_IDS,
    "the config's selectorIds (what verify reads) must equal the full runs' SELECTOR_IDS (R261)",
  );
  const marks = await loadEquivalenceMarks(PROJECT_DIR);
  const [mark] = marks ?? [];
  assert.ok(mark !== undefined && marks?.length === 1, "exactly one equivalence mark");
  assert.equal(mark.key, PLANTED_KEYS.S5, "the one mark names S5");
  const equivalenceMarks: readonly EquivalenceMark[] = [mark];
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc.exe/altool.exe under the AL Language extension install");
  }

  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-agreement-"));
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
  /** A new backend per use, as harden.itest.ts builds one per leg. */
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
  /** One full run into its own store, closed before return. No `resume` key (R247). */
  const fullRun = async (leg: "a" | "b", dbPath: string, testDir: string) => {
    const backend = connect();
    const store = new ResultsStore(dbPath);
    try {
      return await runSession({
        backend,
        store,
        projectDir: PROJECT_DIR,
        testDir,
        instrumentedDir: join(scratch, `instr-${leg}`),
        selectorIds: SELECTOR_IDS,
        equivalenceMarks,
        lease,
        resourceServer: bcdev.server,
        resourceServerInstance: bcdev.serverInstance,
        // A SCRATCH quarantine dir, never the real ~/.lethal store (see bcdev.itest.ts).
        quarantineDir: join(scratch, `quarantine-${leg}`),
      });
    } finally {
      store.close();
      await backend.close();
    }
  };

  const aDir = await mkdtemp(join(scratch, "store-a-"));
  const bDir = await mkdtemp(join(scratch, "store-b-"));
  const aDb = join(aDir, "agreement.sqlite");
  const bDb = join(bDir, "agreement.sqlite");

  try {
    // Printed first, as the other gates do: which control app and BC build this ran against.
    const base = await harnessVerifier.fetchExtensionInstalled(BASE_APPLICATION_ID);
    console.log(`agreement itest: LethAL Control ${await harnessVerifier.fetchControlVersion()}`);
    console.log(`agreement itest: BC build (Base Application) ${base.versions.join(", ")}`);

    // ---- 1. Source run A, base suite. Its store is closed by fullRun before verify opens it.
    const a = await fullRun("a", aDb, TEST_DIR);
    assert.equal(a.quarantined, undefined, "step 1: A must not quarantine");
    assert.equal(a.baselineGreen, true, "step 1: A's baseline is green");
    const committed = JSON.parse(await readFile(BASELINE_PATH, "utf8")) as NormalizedMutant[];
    const aDiffs = diffMutants(committed, normalizeForComparison(a));
    assert.equal(
      aDiffs.length,
      0,
      `step 1: A differs from harden.baseline.json:\n${aDiffs.join("\n")}`,
    );
    assertSingleBatch(a);
    assertHardenVerdicts(a);
    assertHardenMarks(a);
    assert.equal(a.mutants.length, 21, "step 1: 21 deployed mutants");
    assert.equal(a.batches, 1, "step 1: one batch");
    assert.deepEqual(
      [a.counts.killed, a.counts.survived, a.counts.noCoverage],
      [16, 5, 0],
      "step 1: killed / survived / no-coverage",
    );
    const lastArtifact = a.artifacts?.at(-1);
    if (lastArtifact === undefined) throw new Error("step 1: A carries no artifacts[]");
    const ids = new Map<Planted, string>();
    for (const p of PLANTED) {
      const row = plantedRow(p);
      const m = mutantAt(a, row.file, row.line, row.operator);
      assert.equal(m.batchIndex, lastArtifact.batchIndex, `step 1: ${p} is in the installed batch`);
      assert.equal(keyOf(m), PLANTED_KEYS[p], `step 1: ${p}'s identity key`);
      const frozen = committed.filter((b) => b.key === PLANTED_KEYS[p]);
      assert.ok(
        frozen.length === 1 && frozen[0]?.verdict === "survived",
        `step 1: ${p} frozen survived`,
      );
      ids.set(p, `${m.batchIndex}/${m.mutantCode}`);
    }
    const idOf = (p: Planted): string => {
      const id = ids.get(p);
      if (id === undefined) throw new Error(`no id for ${p}`);
      return id;
    };
    console.log(
      `step 1 PASS: A ${a.counts.killed}/${a.counts.survived}/${a.counts.noCoverage}, per mutant equal to harden.baseline.json; artifact ${lastArtifact.artifactId} (batch ${lastArtifact.batchIndex}), totalMs ${a.timings.totalMs}; ${PLANTED.map((p) => `${p} ${idOf(p)}`).join(", ")}`,
    );

    // ---- 2. The scratch suite: the base suite plus the answer key, app.json unchanged.
    const scratchTests = join(scratch, "tests-with-answers");
    const refs = await writeScratchSuite(TEST_DIR, ANSWERS_FILE, scratchTests);
    assert.deepEqual(
      refs.map((r) => `${r.codeunitName}.${r.method}`).sort(),
      [...SCRATCH_TESTS].sort(),
      "step 2: the scratch suite's tests",
    );
    const scratchApp = await readJson<{ name: string; version: string; publisher: string }>(
      join(scratchTests, "app.json"),
      "the scratch suite's app.json",
    );
    console.log(`step 2 PASS: scratch suite at ${scratchTests}, ${refs.length} tests`);

    // ---- Steps 3 to 6. Step 7 (restore) runs whatever happens here.
    let gateErr: unknown;
    let bStarted = false;
    try {
      // ---- 3. lethal verify, through the CLI code path.
      const quarantineBefore = await quarantineRecords(defaultQuarantineDir());
      const acquiresBefore = acquires;
      const publishesBefore = testAppPublishes;
      let text = "";
      const code = await verifyFromCli(
        {
          mode: "verify",
          dbPath: aDb,
          artifact: lastArtifact.artifactId,
          testDir: scratchTests,
          survivors: PLANTED.map(idOf),
          configPath: CONFIG_LOCAL_PATH,
        },
        {
          write: (t) => {
            text += t;
          },
        },
      );
      const publishes = testAppPublishes - publishesBefore;
      const acquired = acquires - acquiresBefore;
      const out = JSON.parse(text) as VerifyOutput;
      console.log(`step 3: lethal verify exit ${code}\n${text}`);
      assert.equal(out.exitCode, code, "step 3: printed exitCode = returned exit code");
      assert.equal(code, VERIFY_EXIT.ok, "step 3: exit 0");
      assert.equal(out.ok, true, "step 3: ok");
      assert.equal(out.refused, undefined, `step 3: no refusal (${JSON.stringify(out.refused)})`);
      assert.equal(out.quarantined, undefined, `step 3: no quarantine (${out.quarantined})`);
      assert.equal(publishes, 1, "step 3: exactly one test-app publish");
      assert.ok(acquired > 0, "step 3: the lease spy observed verify's acquire");
      assert.deepEqual(
        out.results.map((r) => r.id).sort(),
        PLANTED.map(idOf).sort(),
        "step 3: exactly the five requested ids",
      );
      assert.equal(out.results.length, 5, "step 3: five rows");
      for (const r of out.results) {
        assert.equal(r.invalidBaseline, undefined, `step 3: ${r.id} has no invalidBaseline`);
      }

      const app = out.testApp;
      assert.ok(app !== undefined, "step 3: the output names the published test app");
      assert.equal(app.name, scratchApp.name, "step 3: testApp.name = the scratch app.json");
      assert.equal(
        app.version,
        scratchApp.version,
        "step 3: testApp.version = the scratch app.json",
      );
      const probe = connect();
      try {
        const fresh = await probe.fetchPublishedAppPackage({
          publisher: scratchApp.publisher,
          name: app.name,
        });
        assert.ok(fresh instanceof Uint8Array, "step 3: a fresh read-back must answer");
        assert.equal(hashPackage(fresh), app.sha256, "step 3: testApp.sha256 = fresh read-back");
      } finally {
        await probe.close();
      }

      const answerNames = SCRATCH_TESTS.filter((t) =>
        t.startsWith(`${SCRATCH_ANSWERS.codeunitName}.`),
      );
      assert.deepEqual(
        out.newTests.map((t) => t.test).sort(),
        [...answerNames].sort(),
        "step 3: newTests are exactly the five answer tests",
      );
      for (const nt of out.newTests) {
        assert.equal(nt.codeunitId, SCRATCH_ANSWERS.codeunitId, `step 3: ${nt.test} codeunit`);
        assert.equal(nt.state, "stable", `step 3: ${nt.test} stable (${JSON.stringify(nt)})`);
        const [b, r] = nt.runs;
        assert.ok(
          b !== undefined && r !== undefined && nt.runs.length === 2,
          `step 3: ${nt.test} two runs`,
        );
        for (const run of [b, r]) {
          assert.equal(run.outcome, "pass", `step 3: ${nt.test} (${JSON.stringify(run)})`);
          assert.equal(run.fresh, true, `step 3: ${nt.test} fresh (${JSON.stringify(run)})`);
        }
        assert.ok(
          b.sessionId !== undefined && r.sessionId !== undefined && b.sessionId !== r.sessionId,
          `step 3: ${nt.test} two DIFFERENT sessionIds (${b.sessionId}, ${r.sessionId})`,
        );
      }

      const rowOf = (p: Planted): VerifyResult => {
        const rows = out.results.filter((r) => r.id === idOf(p));
        const [row] = rows;
        assert.ok(row !== undefined && rows.length === 1, `step 3: one row for ${p}`);
        return row;
      };
      for (const p of KILLED_PLANTED) {
        const row = rowOf(p);
        assert.equal(row.verdict, "killed", `step 3: ${p} killed (${row.failureNote})`);
        assert.deepEqual(
          row.killingTest,
          {
            codeunitId: SCRATCH_ANSWERS.codeunitId,
            codeunitName: SCRATCH_ANSWERS.codeunitName,
            method: ANSWER_KILLERS[p],
          },
          `step 3: ${p}'s killer`,
        );
        assert.equal(row.killedByNewTest, true, `step 3: ${p} killedByNewTest`);
        assert.equal(row.killedBy, "other", `step 3: ${p} killedBy other`);
        assert.ok(
          row.killingTestFailure?.includes(KILL_TEXTS[p]),
          `step 3: ${p}'s failure text ${JSON.stringify(row.killingTestFailure)} lacks ${JSON.stringify(KILL_TEXTS[p])}`,
        );
      }
      const s5 = rowOf("S5");
      assert.equal(s5.verdict, "skipped", "step 3: S5 skipped");
      assert.equal(s5.skipped?.reason, "reader-marked-equivalent", "step 3: S5 skip reason");
      assert.equal(s5.skipped?.mark.key, PLANTED_KEYS.S5, "step 3: S5's mark key");
      assert.deepEqual(
        out.counts,
        { killed: 4, survived: 0, error: 0, skipped: 1 },
        "step 3: counts",
      );

      const quarantineAfter = await quarantineRecords(defaultQuarantineDir());
      assert.deepEqual(
        quarantineAfter.filter((n) => !quarantineBefore.includes(n)),
        [],
        "step 3: no new quarantine record",
      );
      const harness = await harnessVerifier.verify();
      const client = new LeaseClient(odataCfg);
      const outcome = await client.acquire(
        `${hostname()}:${process.pid}:agreement-check`,
        MAX_TTL_SECONDS,
        randomUUID(),
        harness.serverGeneration,
      );
      assert.ok(
        outcome.granted,
        `step 3: a lease acquire right after must succeed: ${JSON.stringify(outcome)}`,
      );
      await client.release(outcome.lease);
      const verifyMs = out.timings.totalMs;
      console.log(
        `step 3 PASS: 4 killed by the answer tests, S5 skipped; exit 0; one test-app publish; read-back equal; lease free; verify totalMs ${verifyMs}`,
      );

      // ---- 4. Fresh full run B with the suite verify published. New store, no resume.
      assert.equal(existsSync(bDb), false, `step 4: B's store ${bDb} must not exist yet`);
      bStarted = true;
      const b = await fullRun("b", bDb, scratchTests);
      assertFreshFullRun(b);
      assert.equal(b.baselineGreen, true, "step 4: B's baseline is green");
      assert.equal(
        b.staleTestApp,
        undefined,
        `step 4: no staleTestApp (${JSON.stringify(b.staleTestApp)})`,
      );
      assert.equal(b.validity.reliability, "full", "step 4: B's reliability is full");
      assert.equal(b.quarantined, undefined, "step 4: B must not quarantine");
      assert.equal(b.mutants.length, 21, "step 4: 21 deployed mutants");
      const predicted = new Set(EXPECTED.map((r) => siteOf(r.file, r.line, r.operator)));
      for (const m of b.mutants) {
        const site = siteOf(m.file, m.line, m.operatorName);
        assert.ok(
          predicted.has(site),
          `step 4: ${m.mutantCode} ${site} (${m.verdict}) is not predicted`,
        );
      }
      for (const row of EXPECTED) {
        const m = mutantAt(b, row.file, row.line, row.operator);
        if (row.planted === "S5") {
          assert.equal(m.verdict, "survived", `step 4: ${describeRow(row)}`);
          assert.equal(m.readerMark?.key, PLANTED_KEYS.S5, "step 4: S5's readerMark");
        } else if (row.planted !== undefined) {
          const killer = ANSWER_KILLERS[row.planted];
          assert.equal(m.verdict, "killed", `step 4: ${describeRow(row)}`);
          assert.equal(m.killingTest, killer, `step 4: ${describeRow(row)} killer`);
        } else {
          // Killer not asserted: several tests can kill it now, and which is recorded is R197's order.
          assert.equal(m.verdict, "killed", `step 4: ${describeRow(row)}`);
        }
      }
      assertHardenMarks(b);
      const s5b = mutantAt(
        b,
        plantedRow("S5").file,
        plantedRow("S5").line,
        plantedRow("S5").operator,
      );
      const les = b.likelyEquivalentSurvivors;
      assert.ok(
        les !== undefined &&
          les.count === 1 &&
          JSON.stringify(les.byRisk.flatMap((g) => g.mutants)) ===
            JSON.stringify([mutantRef(s5b.batchIndex, s5b.mutantCode)]),
        `step 4: likelyEquivalentSurvivors lists S5 only: ${JSON.stringify(les ?? null)}`,
      );
      assert.deepEqual(
        [b.counts.killed, b.counts.survived, b.counts.noCoverage],
        [20, 1, 0],
        "step 4: killed / survived / no-coverage",
      );
      console.log(
        `step 4 PASS: fresh B ${b.counts.killed}/${b.counts.survived}/${b.counts.noCoverage}, per mutant as pre-committed, totalMs ${b.timings.totalMs}`,
      );

      // ---- 5 and 6. The table, the totals and the ratio are printed before anything is asserted.
      const cmp = compareVerifyToFullRun(out, a, b);
      const neg = compareVerifyToFullRun(out, a, a);
      console.log("agreement: id | key suffix | verify | full | agree");
      for (const r of cmp.rows) {
        console.log(
          `  ${r.id} | ${r.key.slice(r.key.indexOf("|"))} | ${r.verify} | ${r.full} | ${r.agree}`,
        );
      }
      const agreeing = cmp.rows.filter((r) => r.agree).length;
      console.log(
        `agreement: ${agreeing} of ${cmp.rows.length} rows agree, ${cmp.diffs.length} diffs`,
      );
      for (const d of cmp.diffs) console.log(`  DIFF ${d}`);
      const ratio = verifyMs / b.timings.totalMs;
      console.log(
        `step 6: wall-time ratio verify/B = ${verifyMs} / ${b.timings.totalMs} ms = ${ratio.toFixed(3)}${ratio > 0.2 ? " (ABOVE the epic's 20% line)" : " (at or below the epic's 20% line)"}; verify/A = ${verifyMs} / ${a.timings.totalMs} ms = ${(verifyMs / a.timings.totalMs).toFixed(3)} (printed only). The 20% criterion is recorded, not gated.`,
      );

      assert.equal(cmp.rows.length, 5, "step 5: five compared rows");
      assert.deepEqual(cmp.diffs, [], "step 5: verify agrees with the fresh full run");
      assert.ok(
        cmp.rows.every((r) => r.agree),
        "step 5: every row agrees",
      );
      assert.equal(
        neg.diffs.length,
        4,
        `step 5: negative control, 4 diffs:\n${neg.diffs.join("\n")}`,
      );
      for (const p of KILLED_PLANTED) {
        const id = idOf(p);
        const hits = neg.diffs.filter((d) => d.startsWith(`${id} (`));
        assert.equal(hits.length, 1, `step 5: negative control, one diff for ${p} (${id})`);
        assert.ok(
          hits[0]?.includes(`verify killed by ${ANSWER_KILLERS[p]}, full run survived`),
          `step 5: negative control text for ${p}: ${hits[0]}`,
        );
        assert.equal(
          neg.rows.find((r) => r.id === id)?.agree,
          false,
          `step 5: ${p} disagrees with A`,
        );
      }
      assert.equal(
        neg.rows.find((r) => r.id === idOf("S5"))?.agree,
        true,
        "step 5: S5 agrees with A",
      );
      console.log(
        "step 5 PASS: every row agrees with B; the negative control finds exactly S1..S4",
      );

      assert.ok(
        verifyMs < b.timings.totalMs,
        `step 6: verify (${verifyMs} ms) faster than B (${b.timings.totalMs} ms)`,
      );
      console.log("step 6 PASS: verify is faster than the fresh full run");
    } catch (err) {
      gateErr = err;
    }

    // ---- 7. Restore the committed tests app. Always, once step 3 began.
    let restoreErr: unknown;
    try {
      await restore(bStarted, aDb, bDb, lastArtifact.artifactId);
    } catch (err) {
      restoreErr = err;
    }
    if (gateErr !== undefined || restoreErr !== undefined) {
      const describe = (e: unknown) => formatFailure(e);
      throw new Error(
        [
          gateErr !== undefined
            ? `steps 3 to 6 FAILED: ${describe(gateErr)}`
            : "steps 3 to 6 passed",
          restoreErr !== undefined
            ? `step 7 (restore) FAILED: ${describe(restoreErr)}. ${RECOVERY}`
            : "step 7 (restore) PASSED: the committed tests app is back, by a fresh read-back",
        ].join("\n"),
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Publishes the committed tests app against whichever artifact is RESIDENT, decided by the
   * server's own read-back (`DeploymentVerifier.verify`, what `attach` uses), never by
   * `artifacts[]`. Refuses to publish when that cannot be named exactly once.
   */
  async function restore(
    bBegan: boolean,
    aPath: string,
    bPath: string,
    aArtifactId: string,
  ): Promise<void> {
    type Candidate = { path: string; artifactId: string; appId: string };
    const recorded = (path: string): Candidate | undefined => {
      if (!existsSync(path)) return undefined;
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
        return { path, artifactId: row.artifact_id, appId };
      } finally {
        s.close();
      }
    };
    const candidates: Candidate[] = [];
    if (bBegan) {
      const bc = recorded(bPath);
      if (bc === undefined) {
        throw new Error(
          "B began but its store records no artifact, so B may be partly deployed and the resident artifact cannot be named; not publishing",
        );
      }
      candidates.push(bc);
    }
    const ac = recorded(aPath);
    if (ac === undefined || ac.artifactId !== aArtifactId) {
      throw new Error(`A's store does not record its artifact ${aArtifactId}; not publishing`);
    }
    candidates.push(ac);
    const accepted: Candidate[] = [];
    for (const c of candidates) {
      const v = await deploymentVerifier.verify({ appId: c.appId, artifactId: c.artifactId });
      console.log(
        `step 7: resident check ${c.artifactId} (${c.path === bPath ? "B" : "A"}): ${JSON.stringify(v)}`,
      );
      if (v.status === "unavailable") {
        throw new Error(
          `resident check of ${c.artifactId} unavailable: ${v.detail}; not publishing`,
        );
      }
      if (v.status === "accepted") accepted.push(c);
    }
    const [resident] = accepted;
    if (resident === undefined || accepted.length !== 1) {
      throw new Error(`${accepted.length} candidate artifacts are resident, not 1; not publishing`);
    }

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
      const s1row = plantedRow("S1");
      const s1Site = siteOf(s1row.file, s1row.line, s1row.operator);
      const s1s = manifest.mutants.filter(
        (m) => siteOf(m.file, m.startLine, m.operatorName) === s1Site,
      );
      const [s1] = s1s;
      assert.ok(
        s1 !== undefined && s1s.length === 1,
        `step 7: ${s1s.length} manifest entries at ${s1Site}`,
      );
      const compiled = await backend.compileTestApp(TEST_DIR, artifact);
      const runId = store.createRun({
        identityScheme: IDENTITY_SCHEME,
        projectPath: PROJECT_DIR,
        backend: "itest-agreement-restore",
        appVersion: "0.0.0.0",
      });
      let published: PublishedTestApp | undefined;
      const res = await runNamedMutants({
        backend,
        store,
        runId,
        installed,
        requests: [{ mutantId: s1.mutantId, methods: [RESTORE_METHOD] }],
        // Required (R-236c): the same scan `lethal run` and `lethal verify` apply before sending.
        testPageRefused: await scanTestPageTests(TEST_DIR, await discoverTests(TEST_DIR)),
        lease,
        resourceServer: bcdev.server,
        resourceServerInstance: bcdev.serverInstance,
        quarantineDir: join(scratch, "quarantine-restore"),
        inLease: async (fence) => {
          published = await backend.publishTestApp(fence, compiled);
        },
      });
      assert.ok(published !== undefined, "step 7: the publish returned no identity");
      assert.equal(published.sha256, compiled.sha256, "step 7: published sha256 = compiled");
      const fresh = await backend.fetchPublishedAppPackage({
        publisher: compiled.publisher,
        name: compiled.name,
      });
      assert.ok(fresh instanceof Uint8Array, "step 7: a fresh read-back must answer");
      assert.equal(hashPackage(fresh), compiled.sha256, "step 7: fresh read-back = compiled");
      assert.equal(res.quarantined, undefined, `step 7: no quarantine (${res.quarantined})`);
      const [o] = res.outcomes;
      assert.ok(o !== undefined && res.outcomes.length === 1, "step 7: one outcome");
      assert.equal(
        o.verdict,
        "survived",
        `step 7: S1 survived the base test (${o.failureNote ?? ""})`,
      );
      console.log(
        `step 7 PASS: restored ${compiled.name} against ${resident.artifactId}; fresh read-back equal; S1 survived`,
      );
    } finally {
      store.close();
      await backend.close();
    }
  }

  console.log("agreement itest: PASS");
  await emitPassed("agreement", { sublegs: ["agreement"], artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  // R332: print the reason before any await, so an operator sees it on the console even when
  // the following receipt write is slow or the process is killed before it finishes.
  console.error(formatFailure(err));
  await emitFailed("agreement", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
