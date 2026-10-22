#!/usr/bin/env bun
/**
 * R618 `itest:lend`: the store's lend order, exercised on a BC server with REAL lends (plan
 * docs/superpowers/plans/2026-10-22-r618-bc-lend-gate.md, r2; pre-committed in
 * docs/superpowers/specs/2026-10-22-r618-lend-precommitment.md before the first live run).
 *
 * Every other BC gate starts from an empty results store and uses no lend flag, so history
 * (`--skip-known-survivors`), `--resume`, `--resume-run` and baseline-snapshot reuse never lend
 * there. This gate fills a SCRATCH store with one real run of `fixtures/sandbox-app` (L0), then
 * lends from it on the positive half (L1 history, R1/R2/R3 resume) and seeds clones of it that one
 * field makes untrustworthy on the negative half (N0 control, N1 v3, N5 revoked; RN3, RN1, RN2,
 * RN4 refused before the lease). Seeds are written by `lend-seed.ts`, whose offline test pins that
 * each override changes only its own field.
 *
 * Every per-mutant comparison goes BY IDENTITY KEY through `compareMutants` against the committed
 * `bcdev.baseline.json` (read only; this gate records no baseline). Its own figures are
 * `LEND_FIGURES` / `LEND_MUTANTS` in gate-expected.ts.
 *
 * The connection is `itest:bcdev`'s: `fixtures/sandbox-app`'s gitignored config that
 * `LETHAL_ITEST_CONFIG` names, and its paired launch file. The fixture pair is the one `itest:bcdev`
 * runs, already published by the setup script; this gate publishes nothing else.
 *
 * Not reachable here, and covered elsewhere (docs/gates/lend.md): `backendBuildRefusal` at the two
 * resume sites and the snapshot site's R557 check (the al-runner / al-runner-v3 legs and unit
 * tests), another `runner_build` (only v3 compares builds), and `carry-refused-renumbered`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_LEND is unset.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDENTITY_SCHEME } from "@lethal/schemata";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { devPortOf, odataUrlsOf, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import type { RunEvent } from "../src/events";
import { formatFailure } from "../src/format-failure";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { runSession } from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { preflightReadOnlyBaseline, readGateBaseline } from "./baseline-guard";
import type { GateBaseline } from "./baseline-guard";
import {
  assertLaunchMatchesConfig,
  itestConfigName,
  itestConfigPath,
  itestLaunchPath,
  printItestTarget,
} from "./config-path";
import { LEND_FIGURES, LEND_MUTANTS, type LendCode } from "./gate-expected";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import { PENDING_SUFFIX, REVOKED_SUFFIX, seedRunFrom } from "./lend-seed";
import { compareMutants, keyOf, normalizeForComparison } from "./mutant-equality";
import type { NormalizedMutant } from "./mutant-equality";

if (!process.env.LETHAL_ITEST_LEND) {
  console.log(
    "skipped (set LETHAL_ITEST_LEND=1 and LETHAL_ITEST_CONFIG to a sandbox-app config; see docs/gates/lend.md)",
  );
  const challenged = await emitSkipped("lend", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");
const CONFIG_LOCAL_PATH = itestConfigPath(PROJECT_DIR);
printItestTarget(CONFIG_LOCAL_PATH);
const LAUNCH_LOCAL_PATH = itestLaunchPath(PROJECT_DIR);
const BASELINE_PATH = join(HERE, "bcdev.baseline.json");
// `itest:bcdev`'s ids, inside the fixture's idRanges.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };
const SEED_BUILD = "r618-seed";
const CLOSED_WORLD = "|closed-world:public";
/** The warning codes of the lend sites; a leg names exactly which of them it expects. */
const LEND_CODE = /^(history-|resume-|snapshot-|carry-refused-renumbered$)/;

const CODES = Object.keys(LEND_MUTANTS) as LendCode[];
const keyOfCode = (c: LendCode): string => LEND_MUTANTS[c].key;
const keySet = (codes: readonly string[]): Set<string> =>
  new Set(codes.map((c) => keyOfCode(c as LendCode)));
const ALL = keySet(CODES);
const KEPT = keySet(LEND_FIGURES.kept);
/**
 * R618 live run 1: in a PARTLY carried batch, no-coverage is re-derived from this session's coverage
 * (`scoreBatch`), never carried; only a WHOLLY carried batch (`replayCarriedBatch`, R1) carries it.
 */
const NO_COVERAGE = keySet(CODES.filter((c) => LEND_MUTANTS[c].verdict === "no-coverage"));
const carriedInPartBatch = (rows: Set<string>): Set<string> =>
  new Set([...rows].filter((k) => !NO_COVERAGE.has(k)));
const SURVIVED = keySet(CODES.filter((c) => LEND_MUTANTS[c].verdict === "survived"));

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
}

interface Leg {
  readonly report: SessionReport;
  readonly events: readonly RunEvent[];
  /** The run row this session created. */
  readonly runId: number;
}

/** One session against the server, on the shared scratch store. */
async function session(
  store: ResultsStore,
  root: string,
  label: string,
  extra: Partial<Pick<SessionConfig, "resume" | "skipKnownSurvivors">> = {},
): Promise<Leg> {
  const launchCfg = (await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch file"))
    .configurations[0];
  if (!launchCfg) throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  assertLaunchMatchesConfig(launchCfg, bcdev, LAUNCH_LOCAL_PATH);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) throw new Error("could not locate alc/altool under the AL Language extension");
  const outputDir = join(root, `publish-${label}`);
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
    defaultArtifactIo,
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      ...devPortOf(bcdev),
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    defaultDeployerIo,
  );
  const odataCfg = {
    ...odataUrlsOf(bcdev),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
      ...devPortOf(bcdev),
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
      packageCachePath: bcdev.packageCachePath,
      controlSymbolPath: bcdev.controlSymbolPath,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
      ...(launchCfg.environmentType !== undefined
        ? { environmentType: launchCfg.environmentType }
        : {}),
      ...(launchCfg.environmentName !== undefined
        ? { environmentName: launchCfg.environmentName }
        : {}),
      ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
    },
    undefined,
    { compiler, deployer, verifier: new DeploymentVerifier(odataCfg), harnessVerifier },
    (targetAppId, artifactId, controlState) =>
      new RunMutantTransport(odataCfg, targetAppId, artifactId, undefined, { controlState }),
  );
  const events: RunEvent[] = [];
  console.log(`  ${label}: ${JSON.stringify(extra)}`);
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(root, `instr-${label}`),
      selectorIds: SELECTOR_IDS,
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A scratch quarantine dir, never the real store (see bcdev.itest.ts).
      quarantineDir: join(root, "quarantine"),
      emit: [(e) => events.push(e)],
      ...extra,
    });
    return { report, events, runId: maxRunId(store) };
  } finally {
    await backend.close();
  }
}

function maxRunId(store: ResultsStore): number {
  return (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
}

function printTable(leg: string, r: SessionReport): void {
  const c = r.counts;
  console.log(
    `  ${leg}: killed=${c.killed} survived=${c.survived} noCoverage=${c.noCoverage} knownSurvivors=${c.knownSurvivors} groupedCalls=${r.groupedCalls} resumedFrom=${JSON.stringify(r.resumedFrom)}`,
  );
  for (const m of r.mutants) {
    const carried = m.carried === true ? " carried" : "";
    console.log(`    ${m.mutantCode} ${m.verdict}${carried} ${m.killingTest ?? ""} ${keyOf(m)}`);
  }
}

/** The lend-site warning codes a leg emitted, sorted. */
function lendCodes(events: readonly RunEvent[]): string[] {
  return events
    .flatMap((e) => (e.type === "warning" && LEND_CODE.test(e.code) ? [e.code] : []))
    .sort();
}

function assertCodes(leg: string, events: readonly RunEvent[], want: readonly string[]): void {
  assert.deepEqual(
    lendCodes(events),
    [...want].sort(),
    `${leg}: the lend-site warnings must be exactly ${JSON.stringify(want)}`,
  );
}

/** The one message of `code` (assertCodes has already pinned there is one). */
function message(events: readonly RunEvent[], code: string): string {
  const hit = events.find((e) => e.type === "warning" && e.code === code);
  return hit?.type === "warning" ? hit.message : "";
}

/** R272: how many baseline tests ran in THIS session (a reused snapshot has no durations). */
function ranHere(events: readonly RunEvent[]): number {
  return events.reduce(
    (n, e) =>
      e.type === "baseline-batch-finished"
        ? n + e.verdicts.filter((v) => v.durationMs !== undefined).length
        : n,
    0,
  );
}

/** Per mutant, by identity key, equal to the frozen baseline (I1). */
function assertFrozen(
  leg: string,
  baseline: GateBaseline,
  report: SessionReport,
  map: (m: NormalizedMutant) => NormalizedMutant = (m) => m,
): void {
  const cmp = compareMutants(baseline.entries, normalizeForComparison(report).map(map), {
    sameScheme: baseline.identityScheme === IDENTITY_SCHEME,
  });
  assert.deepEqual(
    cmp.differences,
    [],
    `${leg}: per-mutant difference from ${BASELINE_PATH}:\n${cmp.differences.join("\n")}`,
  );
}

const asSurvived = (m: NormalizedMutant): NormalizedMutant =>
  m.verdict === "known-survivor" ? { ...m, verdict: "survived" } : m;

/** The leg's own run row records the identity L0 proved, so a faithful clone WOULD have lent. */
function assertIdentity(
  leg: string,
  store: ResultsStore,
  runId: number,
  id: { hash: string; deps: string },
): void {
  const row = store.getRun(runId);
  assert.ok(row !== null, `${leg}: run ${runId} not in the store`);
  assert.deepEqual(
    { hash: row.testAppHash, proven: row.testAppProven, deps: row.testAppDeps },
    { hash: id.hash, proven: true, deps: id.deps },
    `${leg}: run ${runId} must record L0's proven test-app identity (a republish between legs would make every negative leg pass for the wrong reason)`,
  );
}

const carriedKeys = (r: SessionReport): Set<string> =>
  new Set(r.mutants.filter((m) => m.carried === true).map(keyOf));

function assertCounts(
  leg: string,
  r: SessionReport,
  want: { killed: number; survived: number; noCoverage: number; groupedCalls: number },
  knownSurvivors = 0,
): void {
  assert.deepEqual(
    {
      killed: r.counts.killed,
      survived: r.counts.survived,
      noCoverage: r.counts.noCoverage,
      knownSurvivors: r.counts.knownSurvivors,
      groupedCalls: r.groupedCalls,
      mutants: r.mutants.length,
    },
    { ...want, knownSurvivors, mutants: LEND_FIGURES.totalMutantSites },
    `${leg}: counts`,
  );
}

/** A history leg that lends: the 12 survivors known, the rest scored and frozen. */
function assertHistoryLent(leg: string, baseline: GateBaseline, r: SessionReport): void {
  printTable(leg, r);
  assertCounts(leg, r, LEND_FIGURES.history, LEND_FIGURES.history.knownSurvivors);
  const known = new Set(r.mutants.filter((m) => m.verdict === "known-survivor").map(keyOf));
  assert.deepEqual(
    known,
    SURVIVED,
    `${leg}: the known survivors must be the 12 frozen survivors, by key`,
  );
  assertFrozen(leg, baseline, r, asSurvived);
}

/** A history leg whose seed must lend nothing: the frozen table, every mutant executed. */
function assertNothingLent(leg: string, baseline: GateBaseline, r: SessionReport): void {
  printTable(leg, r);
  assertCounts(leg, r, LEND_FIGURES.fresh);
  assertFrozen(leg, baseline, r);
}

/** A refusal before the lease: the exact head and tail, and no run row created. */
async function assertRefused(
  leg: string,
  store: ResultsStore,
  run: () => Promise<Leg>,
  head: string,
  tail?: string,
): Promise<void> {
  const before = maxRunId(store);
  let message: string | undefined;
  try {
    await run();
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  console.log(`  ${leg}: refused: ${message ?? "(did not throw)"}`);
  assert.ok(message !== undefined, `${leg}: the session must be refused`);
  assert.ok(message.startsWith(head), `${leg}: the refusal must start ${JSON.stringify(head)}`);
  if (tail !== undefined) {
    assert.ok(message.includes(tail), `${leg}: the refusal must contain ${JSON.stringify(tail)}`);
  }
  assert.equal(maxRunId(store), before, `${leg}: no run row may be created before the refusal`);
}

async function main(): Promise<void> {
  preflightReadOnlyBaseline(BASELINE_PATH, "lend itest");
  const baseline = await readGateBaseline(BASELINE_PATH);
  const root = await mkdtemp(join(tmpdir(), "lethal-lend-"));
  const store = new ResultsStore(join(root, "lethal.sqlite"));
  const sublegs: string[] = [];
  try {
    // ---- L0: fill. Run A, no flag.
    const l0 = await session(store, root, "L0");
    printTable("L0", l0.report);
    assert.equal(l0.report.baselineGreen, true, "L0: the baseline must be green");
    assertCounts("L0", l0.report, LEND_FIGURES.fresh);
    assertFrozen("L0", baseline, l0.report);
    assertCodes("L0", l0.events, []);
    const A = l0.runId;
    const aRow = store.getRun(A);
    assert.ok(aRow?.testAppProven, "L0: run A must record a proven test app");
    const H = aRow.testAppHash ?? "";
    const D = aRow.testAppDeps ?? "";
    // I5: the R389 legs mean something only on a closed-world run.
    if (!H.includes(CLOSED_WORLD) || H.endsWith(PENDING_SUFFIX) || H.endsWith(REVOKED_SUFFIX)) {
      throw new Error(
        `L0: run ${A}'s test-app hash is ${H}, not a confirmed "${CLOSED_WORLD}" identity. The control app answered open-world (or the run was not confirmed), so no seed's pending or revoked suffix would be what refuses it: the R389 legs would test hash inequality only. Refusing (R618 I5).`,
      );
    }
    const snaps = store.db
      .query("SELECT test_app_hash AS h FROM baseline_snapshots WHERE run_id = ?")
      .all(A) as Array<{ h: string }>;
    assert.deepEqual(snaps, [{ h: H }], "L0: run A must hold exactly one snapshot, unsuffixed");
    const l0Ran = ranHere(l0.events);
    assert.ok(
      l0Ran > 0,
      "L0: a re-run baseline must report per-test durations, or B1's evidence is vacuous",
    );
    const identity = { hash: H, deps: D };
    sublegs.push("L0");

    // ---- L1: history. Run B with --skip-known-survivors; the latest finished run is A.
    const l1 = await session(store, root, "L1", { skipKnownSurvivors: true });
    assertHistoryLent("L1", baseline, l1.report);
    assertCodes("L1", l1.events, []);
    assertIdentity("L1", store, l1.runId, identity);
    const B = l1.runId;
    sublegs.push("L1");

    // ---- R1: --resume-run of an UNFINISHED full clone; its one batch is carried whole.
    const full = seedRunFrom(store, A);
    const r1 = await session(store, root, "R1", { resume: full });
    printTable("R1", r1.report);
    assertCodes("R1", r1.events, ["resume-reusing-run", "resume-batch-carried"]);
    assert.ok(
      message(r1.events, "resume-reusing-run").includes(
        `reusing run ${full} — ${LEND_FIGURES.resumeWhole.carryable} mutant verdict(s) may be carried`,
      ),
      "R1: resume-reusing-run must name the clone and 19 carryable",
    );
    assert.equal(r1.report.groupedCalls, LEND_FIGURES.resumeWhole.groupedCalls, "R1: groupedCalls");
    assert.equal(
      (r1.report.artifacts ?? []).length,
      0,
      "R1: a batch carried whole deploys nothing",
    );
    assert.deepEqual(carriedKeys(r1.report), ALL, "R1: every mutant carried, by key");
    assertFrozen("R1", baseline, r1.report);
    assert.deepEqual(
      r1.report.resumedFrom,
      { runId: full, carriedMutants: LEND_FIGURES.resumeWhole.carried, skippedStranded: 0 },
      "R1: resumedFrom",
    );
    assertIdentity("R1", store, r1.runId, identity);
    sublegs.push("R1");

    // ---- R2 seeds: four snapshot owners R389's identity handling must skip, then K, newest.
    seedRunFrom(store, A, { rows: false, hashSuffix: PENDING_SUFFIX, snapshot: "run" }); // SP1
    seedRunFrom(store, A, { rows: false, hashSuffix: PENDING_SUFFIX, snapshot: "source" }); // SP2
    seedRunFrom(store, A, { rows: false, snapshot: "source", revoke: true }); // SP3
    seedRunFrom(store, A, { rows: false, hashSuffix: REVOKED_SUFFIX, snapshot: "source" }); // SP4
    const sentinelKey = keyOfCode(LEND_FIGURES.sentinel.code);
    const K = seedRunFrom(store, A, {
      keepKeys: new Set([...KEPT, ...keySet(LEND_FIGURES.keptAsError)]),
      errorKeys: keySet(LEND_FIGURES.keptAsError),
      permuteCodes: true,
      sentinel: { key: sentinelKey, durationMs: LEND_FIGURES.sentinel.durationMs },
    });

    // ---- R2: --resume (last) resolves to K; the snapshot of B (the newest real owner) is reused.
    const r2 = await session(store, root, "R2", { resume: "last" });
    printTable("R2", r2.report);
    assertCodes("R2", r2.events, ["resume-reusing-run", "resume-baseline-reused"]);
    const reusing = message(r2.events, "resume-reusing-run");
    assert.ok(
      reusing.includes(
        `reusing run ${K} — ${LEND_FIGURES.resumeSnapshot.carryable} mutant verdict(s) may be carried`,
      ) &&
        reusing.includes(
          ` ${LEND_FIGURES.resumeSnapshot.nonCarryableRows} prior 'error' verdict(s) will be re-executed.`,
        ),
      `R2: resume-reusing-run must name K (${K}), 9 carryable and 1 error row; got ${reusing}`,
    );
    assert.ok(
      message(r2.events, "resume-baseline-reused").includes(`same as run ${B}'s batch 0,`),
      `R2: the reused snapshot must be run B's (${B}), not a seeded one`,
    );
    assert.equal(ranHere(r2.events), 0, "R2: a reused baseline runs no unmutated test here (B1)");
    assert.deepEqual(
      carriedKeys(r2.report),
      carriedInPartBatch(KEPT),
      "R2: exactly KEPT minus its no-coverage rows carried, by key (no-coverage re-derived in a partly carried batch)",
    );
    assertFrozen("R2", baseline, r2.report);
    assert.equal(
      r2.report.groupedCalls,
      LEND_FIGURES.resumeSnapshot.groupedCalls,
      "R2: groupedCalls",
    );
    assert.deepEqual(
      r2.report.resumedFrom,
      { runId: K, carriedMutants: LEND_FIGURES.resumeSnapshot.carried, skippedStranded: 0 },
      "R2: resumedFrom",
    );
    const sentinelRow = r2.report.mutants.find((m) => keyOf(m) === sentinelKey);
    const carriedEvent = r2.events.find(
      (e) =>
        e.type === "mutant-carried" &&
        sentinelRow !== undefined &&
        e.mutant.mutantId === sentinelRow.mutantCode &&
        e.batchIndex === sentinelRow.batchIndex,
    );
    assert.ok(
      carriedEvent?.type === "mutant-carried" &&
        carriedEvent.fromRunId === K &&
        carriedEvent.priorDurationMs === LEND_FIGURES.sentinel.durationMs,
      `R2: the sentinel row must be carried from K by key, with priorDurationMs ${LEND_FIGURES.sentinel.durationMs} (I2)`,
    );
    assertIdentity("R2", store, r2.runId, identity);
    sublegs.push("R2");

    // ---- R3: the snapshot site's step 1. SV3 is the newest snapshot owner and a v3 run.
    const SV3 = seedRunFrom(store, A, {
      rows: false,
      backend: "al-runner-v3",
      runnerBuild: SEED_BUILD,
      coverageMode: "fenced",
      snapshot: "source",
    });
    const K2 = seedRunFrom(store, A, {
      keepKeys: new Set([...ALL].filter((k) => !keySet(LEND_FIGURES.r3Rerun).has(k))),
    });
    const r3 = await session(store, root, "R3", { resume: K2 });
    printTable("R3", r3.report);
    assertCodes("R3", r3.events, ["resume-reusing-run", "snapshot-backend-build-changed"]);
    assert.equal(
      message(r3.events, "snapshot-backend-build-changed"),
      `[lethal] run ${SV3}'s batch 0 baseline snapshot is not reused: run ${SV3} ran on al-runner-v3 and this session runs bcdev; a verdict is lent only within al-runner-v3 (R586). Batch 0's baseline is re-run.`,
      "R3: the snapshot refusal, exactly (M3)",
    );
    assert.equal(ranHere(r3.events), l0Ran, "R3: the baseline re-ran here, as L0's did (B1)");
    assert.deepEqual(
      carriedKeys(r3.report),
      carriedInPartBatch(new Set([...ALL].filter((k) => !keySet(LEND_FIGURES.r3Rerun).has(k)))),
      "R3: all but M0019 and the no-coverage rows carried, by key (partly carried batch)",
    );
    assertFrozen("R3", baseline, r3.report);
    assert.equal(
      r3.report.groupedCalls,
      LEND_FIGURES.resumeRefusedSnapshot.groupedCalls,
      "R3: groupedCalls",
    );
    assert.deepEqual(
      r3.report.resumedFrom,
      { runId: K2, carriedMutants: LEND_FIGURES.resumeRefusedSnapshot.carried, skippedStranded: 0 },
      "R3: resumedFrom",
    );
    assertIdentity("R3", store, r3.runId, identity);
    sublegs.push("R3");

    // ---- N0: control. A finished clone, no override, lends exactly as A did.
    seedRunFrom(store, A, { finished: true });
    const n0 = await session(store, root, "N0", { skipKnownSurvivors: true });
    assertHistoryLent("N0", baseline, n0.report);
    assertCodes("N0", n0.events, []);
    assertIdentity("N0", store, n0.runId, identity);
    sublegs.push("N0");

    // ---- N1: a finished v3 clone, one field changed, lends nothing.
    const v3 = seedRunFrom(store, A, {
      finished: true,
      backend: "al-runner-v3",
      runnerBuild: SEED_BUILD,
    });
    const n1 = await session(store, root, "N1", { skipKnownSurvivors: true });
    assertNothingLent("N1", baseline, n1.report);
    assertCodes("N1", n1.events, ["history-backend-build-changed"]);
    assert.equal(
      message(n1.events, "history-backend-build-changed"),
      `[lethal] --skip-known-survivors: run ${v3} ran on al-runner-v3 and this session runs bcdev; a verdict is lent only within al-runner-v3 (R586), so no survivor from it is skipped: every mutant is executed.`,
      "N1: the history refusal, exactly (M3)",
    );
    assertIdentity("N1", store, n1.runId, identity);
    sublegs.push("N1");

    // ---- N5: a finished clone, then revoked (R389), lends nothing.
    const revoked = seedRunFrom(store, A, { finished: true, revoke: true });
    const n5 = await session(store, root, "N5", { skipKnownSurvivors: true });
    assertNothingLent("N5", baseline, n5.report);
    assertCodes("N5", n5.events, ["history-test-app-changed"]);
    const n5Message = message(n5.events, "history-test-app-changed");
    assert.ok(
      n5Message.includes(
        `the latest finished run, run ${revoked}, was measured against test app ${H}${REVOKED_SUFFIX},`,
      ),
      `N5: the refusal must name run ${revoked} and ${H}${REVOKED_SUFFIX}; got ${n5Message}`,
    );
    assertIdentity("N5", store, n5.runId, identity);
    sublegs.push("N5");

    // ---- Refusals before createRun and the lease.
    const KV = seedRunFrom(store, A, { backend: "al-runner-v3", runnerBuild: SEED_BUILD });
    await assertRefused(
      "RN3",
      store,
      () => session(store, root, "RN3", { resume: KV }),
      `--resume-run ${KV} ran on backend al-runner-v3, but this session uses bcdev — verdicts are not interchangeable across backends`,
    );
    sublegs.push("RN3");
    // A crashed run's state: `--resume` must pick KP (KV is another backend) and refuse it.
    const KP = seedRunFrom(store, A, { hashSuffix: PENDING_SUFFIX });
    await assertRefused(
      "RN1",
      store,
      () => session(store, root, "RN1", { resume: "last" }),
      `--resume: run ${KP} was measured against test app ${H}${PENDING_SUFFIX}`,
      "none of its verdicts is carried (R247, R495)",
    );
    sublegs.push("RN1");
    const KR = seedRunFrom(store, A, { revoke: true });
    await assertRefused(
      "RN2",
      store,
      () => session(store, root, "RN2", { resume: KR }),
      `--resume-run ${KR}: run ${KR} was measured against test app ${H}${REVOKED_SUFFIX}`,
      "none of its verdicts is carried (R247, R495)",
    );
    sublegs.push("RN2");
    // R618 ruling 2: a finished run is not resumable.
    await assertRefused(
      "RN4",
      store,
      () => session(store, root, "RN4", { resume: A }),
      `--resume-run ${A}: run ${A} already finished; nothing to resume.`,
    );
    sublegs.push("RN4");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
  console.log("lend itest: PASS");
  await emitPassed("lend", { sublegs, artifacts: { reported: false } });
}

main().catch(async (err: unknown) => {
  console.error(formatFailure(err));
  await emitFailed("lend", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
