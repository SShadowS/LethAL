#!/usr/bin/env bun
/**
 * Env-gated integration test against a live bc-dev-mcp + Business Central dev server, pointed at
 * the TABLE fixture (`fixtures/sandbox-data` + `fixtures/sandbox-data-tests`) rather than the
 * codeunit one. NOT a `bun:test` file — a standalone script invoked via `bun run itest:tables`
 * (root package.json), never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_TABLES is unset.
 *
 * WHY THIS EXISTS AS A COMMITTED GATE. Tier-2 Phase 0's whole claim is that a mutation living
 * inside a table trigger is generated, attributed, instrumented, executed and killed on a real
 * server. Every OTHER result in this repo is frozen per-mutant and asserted
 * (`bcdev.baseline.json`, `al-runner.baseline.json`); the table result was recorded once, by
 * hand, into `fixtures/README.md`, with no committed gate — so a regression in trigger
 * attribution, in the (objectType, objectId) coverage key, or in table selector-var injection
 * would break the one behaviour Phase 0 exists to prove and nothing would fail. `assertVerdictTable`
 * below plus `assertMatchesBaseline` close that.
 *
 * Connection details are never committed: this script reads
 *   fixtures/sandbox-data/lethal.config.local.json         (LethAL bcdev section — gitignored)
 *   fixtures/sandbox-data/.vscode/launch.local.json        (OPTIONAL — gitignored)
 * Note the config is the sandbox-data one, NOT sandbox-app's: the two fixtures target DIFFERENT
 * containers (and different .alpackages), so cross-reading would publish this app to the wrong
 * server. See fixtures/README.md for the expected shape.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MutantManifest, MutantManifestEntry } from "@lethal/schemata";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

if (!process.env.LETHAL_ITEST_TABLES) {
  console.log(
    "skipped (set LETHAL_ITEST_TABLES=1 and populate the gitignored " +
      "fixtures/sandbox-data/lethal.config.local.json to run against a live dev server)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-data");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-data-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");
// Committed per-mutant baseline — see baseline-guard.ts. Absent on the first run: the guard
// RECORDS it and says so. Never hand-write this file; it must come from a live run.
const BASELINE_PATH = join(HERE, "tables.baseline.json");

// Must live inside sandbox-data's declared idRanges (79197-79199 + 79300-79399, see its
// app.json) — real alc.exe enforces app.json idRanges (AL0297) for the injected objects too.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

/**
 * Frozen from the live gate of 2026-07-25 against the authoritative bcdev backend
 * (fixtures/README.md §Tier-2 Phase 0). The per-mutant map is the point: aggregate counts stay
 * 3/2/2 even if two verdicts swap between mutants, and a trigger mutant silently reclassified
 * from `killed` to `no-coverage` is exactly the regression this fixture exists to catch.
 */
const EXPECTED = {
  totalMutantSites: 7,
  killed: 3,
  survived: 2,
  noCoverage: 2,
  mutationScore: 0.6,
  /** mutantCode -> verdict, per fixtures/README.md's frozen table. */
  verdicts: {
    M0001: "killed", // DataMain field "No." OnValidate body — empty-block
    M0002: "killed", // same trigger's `if` — negate-conditional
    M0003: "survived", // DataMain OnInsert body — empty-block (weak test asserts nothing)
    M0004: "no-coverage", // TouchCount() body — empty-block (no test calls it)
    M0005: "no-coverage", // TouchCount() return — return-value
    M0006: "killed", // DataNoTrigger field OnValidate body — empty-block
    M0007: "survived", // same trigger's `>` — conditional-boundary (weak test)
  } as Record<string, string>,
};

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly environmentType?: "OnPrem" | "Sandbox" | "Production";
    readonly environmentName?: string;
  }>;
}

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See fixtures/README.md for the expected local-file setup.`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * `launch.local.json` only supplies `environmentType`/`environmentName`, both optional on the
 * backend. sandbox-data has no `.vscode/` of its own, so a missing file is normal here and must
 * not be an error — but a PRESENT-and-unreadable/corrupt one still is (never swallow that: it
 * would silently target the wrong environment).
 */
async function readOptionalLaunchConfig(): Promise<LaunchLocalConfig["configurations"][number]> {
  let text: string;
  try {
    text = await readFile(LAUNCH_LOCAL_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed = JSON.parse(text) as LaunchLocalConfig;
  return parsed.configurations[0] ?? {};
}

interface RunOnceResult {
  readonly report: SessionReport;
  readonly odataCfg: ActivationConfig;
}

async function runOnce(scratchRoot: string): Promise<RunOnceResult> {
  const launchCfg = await readOptionalLaunchConfig();
  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);

  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error(
      "could not locate alc.exe/altool.exe under the AL Language VS Code extension install",
    );
  }

  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    {
      alcPath: toolPaths.alcPath,
      packageCachePath: bcdev.packageCachePath,
      outputDir,
    },
    defaultArtifactIo,
  );
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    defaultDeployerIo,
  );
  const odataCfg = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const verifier = new DeploymentVerifier(odataCfg);
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
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
    { compiler, deployer, verifier, harnessVerifier },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );

  const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: SELECTOR_IDS,
      // Layer 5C-B1 (design §6): take the machine-global lease before deploying, fence the
      // publish, heartbeat it, carry the tuple into every RunMutant, release at the end —
      // identical to bcdev.itest.ts, since this drives the same fenced server path.
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A SCRATCH quarantine dir, deliberately NOT defaultQuarantineDir() — one transient
      // failure landing in the real ~/.lethal store poisons every later gate run until an
      // operator deletes it by hand (observed live). Same reasoning as bcdev.itest.ts.
      quarantineDir: join(scratchRoot, "quarantine"),
    });
    return { report, odataCfg };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and this script never
    // exits, even on a fully successful run.
    await backend.close();
  }
}

function assertVerdictTable(report: SessionReport): void {
  // Always dump the per-mutant table BEFORE asserting. A bare "survived count mismatch 1 !== 2"
  // says nothing about which mutant moved, and this gate takes minutes to re-run against a live
  // container — so the first run has to carry its own diagnosis.
  console.log(
    `  verdicts: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage} baselineGreen=${report.baselineGreen} score=${report.mutationScore}`,
  );
  for (const m of report.mutants) {
    const cause = m.cause !== undefined ? ` cause=${m.cause}` : "";
    const note = m.failureNote !== undefined ? ` note=${m.failureNote}` : "";
    console.log(
      `    ${m.mutantCode} ${m.verdict}${cause} ${m.file}:${m.line} ${m.operatorName}${note}`,
    );
  }
  if (report.quarantined !== undefined) {
    console.log(`  quarantined: ${JSON.stringify(report.quarantined)}`);
  }

  assert.equal(
    report.baselineGreen,
    true,
    "baseline must be green (every sandbox-data test passes unmutated)",
  );
  assert.equal(report.counts.killed, EXPECTED.killed, "killed count mismatch");
  assert.equal(report.counts.survived, EXPECTED.survived, "survived count mismatch");
  assert.equal(report.counts.noCoverage, EXPECTED.noCoverage, "no-coverage count mismatch");
  assert.equal(report.counts.errors, 0, "no mutant may error on the healthy path");
  assert.equal(report.counts.unstable, 0, "no mutant may be unstable on the healthy path");
  assert.equal(report.mutationScore, EXPECTED.mutationScore, "mutation score mismatch");

  // Per-mutant, not aggregate: the counts above stay 3/2/2 even if two verdicts swap.
  const actual = Object.fromEntries(report.mutants.map((m) => [m.mutantCode, m.verdict]));
  assert.deepEqual(
    actual,
    EXPECTED.verdicts,
    "per-mutant verdict table mismatch against the live gate of 2026-07-25 " +
      "(fixtures/README.md §Tier-2 Phase 0) — see the dump above for which mutant moved",
  );
}

/**
 * Every mutant of every artifact this run actually deployed, keyed by mutant id.
 *
 * `MutantOutcome` (report.ts) carries neither `triggerName` nor `objectType`, so the report alone
 * cannot say whether a verdict landed on a TRIGGER site — the one claim Phase 0 exists to prove.
 * The manifest can: `prepareArtifactDir` writes one `mutant-manifest.json` per artifact into
 * `<instrumentedDir>/run-<runId>-batch-<n>/`, from the same `triggerNameOf`/`objectHeaderOf`
 * attribution the coverage key uses.
 *
 * `run-…-batch-<n>-bisect` dirs are excluded by the `\d+$` anchor: those hold NARROWED subsets
 * written while searching for a compile-failure culprit, not the deployed set.
 */
async function readDeployedManifests(
  instrumentedDir: string,
): Promise<Map<string, MutantManifestEntry>> {
  const byId = new Map<string, MutantManifestEntry>();
  const entries = await readdir(instrumentedDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !/^run-.+-batch-\d+$/.test(e.name)) continue;
    const raw = await readFile(join(instrumentedDir, e.name, "mutant-manifest.json"), "utf8");
    for (const m of (JSON.parse(raw) as MutantManifest).mutants) byId.set(m.mutantId, m);
  }
  if (byId.size === 0) {
    const why =
      "cannot verify trigger attribution, and passing without verifying it is exactly the " +
      "failure this gate exists to catch";
    throw new Error(`no deployed mutant-manifest.json found under ${instrumentedDir} — ${why}`);
  }
  return byId;
}

/**
 * The exit criterion, asserted rather than described: a kill AND a survive on TRIGGER sites
 * specifically. A kill alone can come from a runtime error unrelated to any assertion, and an
 * all-survive table proves nothing about activation. Both killed trigger mutants live in a
 * field-level `OnValidate`; the surviving M0003 is the object-level `OnInsert`.
 *
 * Trigger-ness comes from the deployed manifest, not from the mutant's file name: the file-name
 * check this replaced could not fail (the fixture holds only `DataMain`/`DataNoTrigger`), so it
 * asserted nothing at all.
 */
function assertTriggerKillAndSurvive(
  report: SessionReport,
  byId: ReadonlyMap<string, MutantManifestEntry>,
): void {
  const sited = report.mutants.map((m) => {
    const entry = byId.get(m.mutantCode);
    if (entry === undefined) {
      // Report and deployed artifact disagree about which mutants exist — never "close enough".
      throw new Error(
        `mutant ${m.mutantCode} appears in the report but in no deployed mutant-manifest.json`,
      );
    }
    return { code: m.mutantCode, verdict: m.verdict, entry };
  });
  const triggers = sited.filter((s) => s.entry.triggerName !== undefined);
  console.log(
    `  trigger-sited mutants: ${
      triggers
        .map((t) => `${t.code}=${t.verdict} (${t.entry.objectType} ${t.entry.triggerName})`)
        .join(", ") || "(none)"
    }`,
  );

  assert.ok(
    triggers.some((t) => t.verdict === "killed"),
    "no KILLED mutant sits at a trigger site (manifest `triggerName` set) — Phase 0's claim is " +
      "that a mutation inside a table trigger is generated, attributed, executed AND killed",
  );
  assert.ok(
    triggers.some((t) => t.verdict === "survived"),
    "no SURVIVED mutant sits at a trigger site — without one, an all-kill table could equally " +
      "be explained by the whole tier erroring out rather than by real activation",
  );
  for (const t of triggers) {
    assert.equal(
      t.entry.objectType,
      "table",
      `${t.code}: this fixture's trigger sites must all be table triggers, got ${t.entry.objectType}`,
    );
  }
}

async function main(): Promise<void> {
  // PROJECT_DIR, not `<PROJECT_DIR>/src` — `runSession` generates from `cfg.projectDir`, so
  // scanning anything else would let this header describe a different file set than the run
  // below it actually executes.
  const { files } = await generateMutationSet(PROJECT_DIR);
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the table fixture, generated ${total} — either the fixture changed or a tier-1 operator's targeting changed; update fixtures/README.md`,
  );

  // R9: runs the session TWICE and asserts verdict-identity, matching itest:bcdev/itest:alrunner
  // — a single run left cross-run nondeterminism here indistinguishable from a confusing
  // per-mutant baseline mismatch instead of an explicit determinism failure.
  const scratchA = await mkdtemp(join(tmpdir(), "lethal-itest-tables-a-"));
  const scratchB = await mkdtemp(join(tmpdir(), "lethal-itest-tables-b-"));
  try {
    const first = await runOnce(scratchA);
    assertVerdictTable(first.report);
    // The trigger claim itself, read off the manifests the run actually deployed (the scratch
    // dir is still on disk here — it is removed in the `finally` below).
    assertTriggerKillAndSurvive(
      first.report,
      await readDeployedManifests(join(scratchA, "instrumented")),
    );
    // Per-mutant regression guard against the committed baseline, keyed on semantic identity
    // (astHash/codeunitName/operatorName/operatorMajor) rather than mutant code — so it survives
    // renumbering that the EXPECTED.verdicts map above deliberately does not.
    await assertMatchesBaseline(first.report, BASELINE_PATH, "tables itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second.report);
    assertTriggerKillAndSurvive(
      second.report,
      await readDeployedManifests(join(scratchB, "instrumented")),
    );

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first.report),
      shape(second.report),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion) — R9: " +
        "cross-run nondeterminism here must surface as an explicit determinism failure, not a " +
        "confusing per-mutant baseline mismatch",
    );
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }

  console.log("tables itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
