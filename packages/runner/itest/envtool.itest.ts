#!/usr/bin/env bun
/**
 * Env-gated integration test against a real Business Central environment reached through a
 * config-declared external environment tool (Layer 6C — spec:
 * docs/superpowers/specs/2026-07-26-custom-env-tool-design.md, plan:
 * docs/superpowers/plans/2026-07-26-custom-env-tool.md, Task 8). Targets the SAME fixture
 * `bcdev.itest.ts` targets directly against a container — `fixtures/sandbox-app` +
 * `fixtures/sandbox-tests` — but reaches it through `validateEnvToolConfig` ->
 * `resolveEnvToolSession`/`startEnvToolSession` -> the env-tool publisher (Tasks 2-7) instead of a
 * hand-built `ContainerDeployer`/altool connection.
 *
 * NOT a `bun:test` file — a standalone script invoked via `bun run itest:envtool` (root
 * package.json), never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_ENVTOOL is unset.
 *
 * WHY THE EXPECTED TABLE IS 3/10/3, NOT al-runner's 3/13/0. Task 1's live probe (recorded in the
 * plan's "## Probe result" section, corrected 2026-07-26) established `coverageMode: "procedure"`
 * for these environments: `bcdev_status` reports `supportsTestRunning: true` once bc-dev-mcp is
 * given `port: 443` (a Continia-hosted portal answers standard HTTPS; there is no dev-service TCP
 * port at the OnPrem-fallback 7049). `startEnvToolSession` derives that port from the resolved
 * `baseUrl` automatically (`deriveMcpPort`, env-tool-session.ts) — nothing in this script sets it
 * by hand. Procedure-level coverage means DiscountedPrice (never called by any test) reports
 * `no-coverage` rather than `survived` — exactly the table `bcdev.itest.ts` already freezes for
 * this same fixture. If a future environment forces the `"none"` fallback instead, this gate's
 * counts will visibly disagree (13 survived / 0 no-coverage) rather than silently drift.
 *
 * WIRING, NOT REIMPLEMENTATION. This drives the exact seams `cli.ts`'s `runFromCli` drives —
 * `resolveEnvToolSession` (which itself calls `validateEnvToolConfig` then `startEnvToolSession`),
 * `buildBackend` (which threads the resolved env-tool publisher into the bcdev backend via
 * `deployerFor`), `leaseSessionFor`/`resourceIdentityFor`, and `withEnvTeardown` — then calls
 * `runSession` directly (like `tables.itest.ts`/`bcdev.itest.ts`) rather than `runFromCli` itself,
 * so a transient failure lands in a SCRATCH quarantine dir, never the real `~/.lethal/quarantine`
 * store (see `runOnce`'s comment). Nothing here re-derives env-tool validation, provisioning,
 * polling, or publish semantics — that would defeat the point of this gate, which is to prove the
 * WIRING (Tasks 2-7 wired together), not a hand-rolled duplicate of the same behaviour.
 *
 * Connection details are never committed: this script reads
 *   fixtures/sandbox-app/lethal.config.envtool.json   (gitignored — bcdev + envTool sections)
 *
 * EXPECTED SHAPE (documented here since the file itself cannot be committed — see env-tool.ts's
 * `EnvToolConfigSection`/`validateEnvToolConfig` and env-tool-session.ts's `startEnvToolSession`
 * for the authoritative field list; this is the worked example from the design spec, adapted for
 * this fixture pair):
 *
 * ```jsonc
 * {
 *   "bcdev": {
 *     "mcpCommand": ["bun", "run", "U:/Git/bc-dev-mcp/src/mcp/index.ts"],
 *     "company": "CRONUS Danmark A/S",
 *     "tenant": "default",
 *     "controlSymbolPath": "U:/Git/LethAL/extensions/lethal-control/lethal-control.app"
 *     // Deliberately NO server/serverInstance/username/password/baseUrl/port here —
 *     // resolveEnvToolSession/startEnvToolSession derive and substitute all of those from the
 *     // env tool's own `resolve` output; hand-writing them would be silently overwritten anyway.
 *     // "packageCachePath" is optional: set it to a pre-downloaded .alpackages dir to skip
 *     // envTool.downloadSymbols below; omit it and envTool.downloadSymbols becomes REQUIRED
 *     // (validateEnvToolConfig enforces this — see env-tool.ts).
 *   },
 *   "envTool": {
 *     "toolPath": "U:/Git/CLI/continia.exe",
 *     "env": { "CONTINIA_API_TOKEN": "${CONTINIA_API_TOKEN}" },
 *
 *     // RESOLVE-MODE (recommended for repeat gate runs): point at Task 1's already-provisioned
 *     // environment instead of paying the ~6.5-minute create+start cost on every invocation.
 *     "envId": "${CONTINIA_ENV_ID}",
 *
 *     "resolve": [
 *       { "command": ["env", "get", "{envId}", "--json"],
 *         "reads": { "baseUrl": "url", "expiresUtc": "expiresUtc" } },
 *       { "command": ["env", "users", "{envId}", "--json"],
 *         "reads": { "username": "0.username", "password": "0.password" } }
 *     ],
 *     "downloadSymbols": { "command": ["deps", "download", "{envId}", "{projectDir}", "--json"] },
 *     "publish": { "command": ["publish", "{envId}", "{appFile}", "--sync-mode", "ForceSync", "--json"] },
 *
 *     // CREATE-MODE is also supported (omit "envId" above) — required only for Task 8 Step 4's
 *     // one-time teardown proof (see the KEEP_ENV note below), NOT for routine gate runs: it
 *     // provisions a REAL, billed environment (~6.5 minutes) and needs createEnv/startEnv/
 *     // readyWhen/publishApps/deleteEnv too — see the design spec's full worked example
 *     // (docs/superpowers/specs/2026-07-26-custom-env-tool-design.md, "Configuration") for those
 *     // blocks; omitted here since this gate's default shape is resolve-mode.
 *     "deleteEnv": { "command": ["env", "delete", "{envId}"] }
 *   }
 * }
 * ```
 *
 * ```sh
 * # .env next to fixtures/sandbox-app — gitignored, loaded automatically by Bun
 * CONTINIA_API_TOKEN=…
 * CONTINIA_ENV_ID=0494e53d-c76e-4a05-96f5-593d49830a64
 * ```
 *
 * TASK 8 STEP 4 (plan doc) — proving teardown on a real environment: this script does not exercise
 * create-mode or `--keep-env` itself. To prove it by hand: run once with no `envId` in the config
 * (confirm `~/.lethal/env-state/<runId>.json` appears mid-run and the environment is gone
 * afterwards), then run again with `LETHAL_ITEST_ENVTOOL_KEEP_ENV=1` set (confirm it survives).
 * Neither run is part of this commit's verification — see this task's scope note (creating an
 * environment costs real time and money, and the only existing one belongs to someone else's work
 * item).
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import {
  buildBackend,
  leaseSessionFor,
  resolveEnvToolSession,
  resourceIdentityFor,
  withEnvTeardown,
} from "../src/cli";
import type { LethalConfigFile, RunCliConfig } from "../src/cli";
import { generateMutationSet, runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

if (!process.env.LETHAL_ITEST_ENVTOOL) {
  console.log(
    "skipped (set LETHAL_ITEST_ENVTOOL=1 and populate the gitignored " +
      "fixtures/sandbox-app/lethal.config.envtool.json to run against a real environment)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");
const CONFIG_PATH = join(PROJECT_DIR, "lethal.config.envtool.json");
// Committed per-mutant baseline — see baseline-guard.ts. Absent on the first run: the guard
// RECORDS it and says so (Task 8 Step 2/3 of the plan). Never hand-write this file; it must come
// from a live run, which this task deliberately does not perform.
const BASELINE_PATH = join(HERE, "envtool.baseline.json");

// See Task 8 Step 4's doc comment above — unexercised by this commit's own verification.
const KEEP_ENV = process.env.LETHAL_ITEST_ENVTOOL_KEEP_ENV === "1";

// Must live inside the fixture's declared idRanges (79000-79199, see fixtures/README.md) — same
// requirement bcdev.itest.ts documents: real alc.exe enforces app.json idRanges (AL0297) for
// every compiled object, including these injected ones.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

// Same fixture as bcdev.itest.ts, same coverage mode ("procedure" — see the header comment above),
// so the same table is expected. NOT hard-coded per-mutant here (unlike tables.itest.ts): which
// mutant lands on which verdict cannot be known without a live run against this specific
// environment, and this task is scoped to never perform one — `assertMatchesBaseline` below is
// what pins the per-mutant table down, on whatever the human's first real run records.
const EXPECTED = {
  totalMutantSites: 16,
  killed: 3,
  survived: 10,
  noCoverage: 3,
};

async function readJson<T>(path: string, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${what} at ${path}: ${err instanceof Error ? err.message : String(err)}. See this file's header comment for the expected shape.`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * Runs one session through the real CLI wiring (see the header comment's "WIRING, NOT
 * REIMPLEMENTATION" paragraph): `resolveEnvToolSession` resolves/provisions exactly once,
 * `withEnvTeardown` owns tearing the session down no matter how the body settles, `buildBackend`
 * constructs the bcdev backend threaded through the resolved env-tool publisher, and
 * `leaseSessionFor`/`resourceIdentityFor` supply the SAME lease/quarantine-identity wiring a real
 * `lethal run` would — all exported specifically so a test can call them (see cli.ts).
 *
 * Calls `runSession` directly rather than `runFromCli`: `runFromCli` has no `quarantineDir`
 * override, so it always writes to the real `~/.lethal/quarantine` store. A SCRATCH quarantine dir
 * here mirrors bcdev.itest.ts/tables.itest.ts exactly — one transient failure landing in the real
 * store poisons every later gate run until an operator deletes it by hand (observed live).
 */
async function runOnce(scratchRoot: string): Promise<SessionReport> {
  const configFile = await readJson<LethalConfigFile>(CONFIG_PATH, "lethal.config.envtool.json");
  if (configFile.envTool === undefined) {
    throw new Error(
      `${CONFIG_PATH} has no "envTool" section — this gate exists to exercise the env-tool wiring; a config with only "bcdev" would make resolveEnvToolSession no-op (its no-envTool-section branch) and test nothing of Tasks 2-7. See this file's header comment for the expected shape.`,
    );
  }

  const parsed: RunCliConfig = {
    mode: "run",
    projectDir: PROJECT_DIR,
    testDir: TEST_DIR,
    backendKind: "bcdev",
    dbPath: join(PROJECT_DIR, "lethal.sqlite"),
    configPath: CONFIG_PATH,
    skipKnownSurvivors: false,
    workers: 1,
    keepEnv: KEEP_ENV,
    allowExpiringEnv: false,
  };

  const runId = basename(scratchRoot);
  const { effectiveConfig, envSession, deploy } = await resolveEnvToolSession(
    parsed,
    configFile,
    runId,
  );

  return await withEnvTeardown(envSession, parsed.keepEnv, async () => {
    const backend = await buildBackend(parsed, effectiveConfig, scratchRoot, deploy);
    // Persistent, NOT `:memory:` — historical run data (priorSurvivorKeys) is a supported
    // workflow, matching bcdev.itest.ts.
    const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
    try {
      return await runSession({
        backend,
        store,
        projectDir: PROJECT_DIR,
        testDir: TEST_DIR,
        instrumentedDir: join(scratchRoot, "instrumented"),
        selectorIds: SELECTOR_IDS,
        // Same lease/resource-identity wiring a real `lethal run` gets — sourced from the SAME
        // already-resolved `effectiveConfig` every other seam below reads (Task 7's contract).
        ...leaseSessionFor(parsed, effectiveConfig),
        ...resourceIdentityFor(parsed, effectiveConfig),
        quarantineDir: join(scratchRoot, "quarantine"),
      });
    } finally {
      store.close();
      // Without this the spawned bc-dev MCP child keeps the event loop alive and this script
      // never exits, even on a fully successful run.
      if (backend instanceof BcDevMcpBackend) await backend.close();
    }
  });
}

function assertVerdictTable(report: SessionReport): void {
  // Always dump the per-mutant table BEFORE asserting. A bare "survived count mismatch 3 !== 10"
  // says nothing about which mutants moved or why, and this gate takes minutes to re-run against a
  // live environment — so the first run has to carry its own diagnosis.
  console.log(
    `  verdicts: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage} baselineGreen=${report.baselineGreen}`,
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
    "baseline must be green (both fixture tests pass unmutated)",
  );
  assert.equal(report.counts.killed, EXPECTED.killed, "killed count mismatch");
  assert.equal(report.counts.survived, EXPECTED.survived, "survived count mismatch");
  assert.equal(report.counts.noCoverage, EXPECTED.noCoverage, "no-coverage count mismatch");

  // Same file-level invariant bcdev.itest.ts pins for this fixture under procedure-level coverage:
  // every killed mutant lives in IsOverBudget (SandboxLogic), every no-coverage mutant in the
  // never-called DiscountedPrice (SandboxPricing).
  const killed = report.mutants.filter((m) => m.verdict === "killed");
  assert.equal(killed.length, EXPECTED.killed);
  for (const m of killed) {
    assert.ok(
      m.file.includes("SandboxLogic"),
      `expected every killed mutant in SandboxLogic.Codeunit.al (IsOverBudget), got ${m.file}`,
    );
  }

  const noCoverage = report.mutants.filter((m) => m.verdict === "no-coverage");
  assert.equal(noCoverage.length, EXPECTED.noCoverage);
  for (const m of noCoverage) {
    assert.ok(
      m.file.includes("SandboxPricing"),
      `expected every no-coverage mutant in SandboxPricing.Codeunit.al (DiscountedPrice, never called), got ${m.file}`,
    );
  }
}

async function main(): Promise<void> {
  const files = await generateMutationSet(join(PROJECT_DIR, "src"));
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the fixture, generated ${total}`,
  );

  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-envtool-"));
  try {
    const report = await runOnce(scratch);
    assertVerdictTable(report);
    // Per-mutant regression guard against the committed baseline, keyed on semantic identity
    // (astHash/codeunitName/operatorName/operatorMajor) rather than mutant code. Absent on the
    // first real run — it RECORDS one instead of failing (baseline-guard.ts).
    await assertMatchesBaseline(report, BASELINE_PATH, "envtool itest");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  console.log("envtool itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
