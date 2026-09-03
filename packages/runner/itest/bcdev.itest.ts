#!/usr/bin/env bun
/**
 * Env-gated integration test against a live bc-dev-mcp + Business Central
 * dev server. NOT a `bun:test` file — standalone script invoked via
 * `bun run itest:bcdev` (root package.json), never picked up by `bun test`.
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_BCDEV is unset.
 *
 * This is also where the assumptions pinned during implementation (without
 * a live server to check against) get verified against real infra, and, if
 * wrong, fixed in one commit each:
 *   - `bcdev_test_run` MCP payload shape (Task 7, bcdev-backend.ts)
 *   - `altool` flag spellings (Task 8, publisher.ts)
 *   - OData `MutationControl_*` action parameter/return shape (Task 9, activation.ts)
 *
 * Connection details are never committed: this script reads
 *   fixtures/sandbox-app/.vscode/launch.local.json  (AL server/tenant/environment — gitignored)
 *   fixtures/sandbox-app/lethal.config.local.json    (LethAL bcdev section — gitignored)
 * See fixtures/README.md for the expected shape of both files.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import type { Lease } from "../src/lease";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

if (!process.env.LETHAL_ITEST_BCDEV) {
  console.log(
    "skipped (set LETHAL_ITEST_BCDEV=1 and populate the gitignored launch.local.json / " +
      "lethal.config.local.json fixture files to run against a live dev server)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");
const LAUNCH_LOCAL_PATH = join(PROJECT_DIR, ".vscode", "launch.local.json");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");
// Committed per-mutant healthy-path baseline (Task 15, design spec §14) — see baseline-guard.ts.
// Aggregate counts (EXPECTED below) are a smoke test; this catches a per-mutant verdict swap
// that leaves the aggregate counts unchanged.
const BASELINE_PATH = join(HERE, "bcdev.baseline.json");

// Must live inside the fixture's declared idRanges (79000-79199, see fixtures/README.md) —
// the real alc.exe enforces app.json idRanges (AL0297) for every compiled object, including
// these injected ones; verified against a real BC server 2026-07-18.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

// Hand-computed against fixtures/sandbox-app/src (see fixtures/README.md §Expected verdict table).
// bcdev reports procedure-level coverage, so DiscountedPrice (never called by any test) is
// reported as "no-coverage" rather than "survived".
//
// 16 since the parenthesized-operand operator bug was fixed (findOperatorToken in
// packages/builtin-tier1/src/mutate-helpers.ts): ClampPercent's `(Value < 0) or
// (Value > 100)` now yields its negate-conditional mutant. It survives — ClampPercentRuns
// calls ClampPercent(50) and asserts nothing, and 50 satisfies neither operand, so or/and
// is not observable there anyway.
// R159 moves this from 16 to 17 and no-coverage from 3 to 4. `lethal.swap-additive` claims
// `DiscountedPrice`'s `Price - (Price * Pct / 100)`, the fixture's only site where both operands are
// provably numeric. It lands `no-coverage` for the same reason the other three do: neither test
// touches `Sandbox Pricing`. Pre-committed in
// docs/superpowers/specs/2026-08-19-r159-swap-additive-precommitment.md.
// R159's `remove-assignment` moves this to 18 and survived to 11. Its one site here is
// `Sandbox Logic.LogAudit`'s `Amount := Amount`, a SELF-ASSIGNMENT: deleting it changes nothing
// observable, so it is an equivalent mutant by inspection and a useful one to have on record.
// Pre-committed in docs/superpowers/specs/2026-08-26-r159-remove-assignment-build-precommitment.md.
const EXPECTED = {
  // R159's `shift-integer` moves this from 18 to 19: `LogAudit`'s `Amount <> 0` is an
  // equality-family comparison, so the operator claims the literal.
  totalMutantSites: 19,
  killed: 3,
  // R159's `shift-integer` moves this from 11 to 12: `Sandbox Logic.LogAudit`'s `Amount <> 0`
  // becomes `<> 1`. It survives because the guarded block is `Amount := Amount`, a self-assignment,
  // so changing WHICH inputs enter a block that does nothing is unobservable. Measured in the spike,
  // docs/superpowers/specs/2026-08-26-r159-shift-integer-spike.md.
  survived: 12,
  noCoverage: 4,
  /**
   * R198: one `RunMutantMany` call per mutant that reached the covering loop: 3 killed + 12
   * survived, the 4 no-coverage never reach it. Pinned as a NUMBER, not a predicate: a counter
   * that was never wired reports 0, and a predicate over an empty set is satisfied by it. This is
   * the anti-inertness pin for the grouped path; the tables gate carries the other (362).
   */
  groupedCalls: 15,
  /**
   * R206: how many of this gate's kills were measured at group position > 1. MEASURED from run
   * 304's store before the build (all three kills at position 1), and pre-committed in
   * docs/superpowers/specs/2026-09-03-r206-build-precommitment.md. `groupedCalls` above is
   * `scored + warmKills`, so a replay that ran here would move BOTH numbers.
   */
  warmKills: 0,
  /**
   * R132: this gate now carries the VACUOUS case for R121's assertion screen, which `itest:tables`
   * used to pin and gave up when its fixture grew a Library Assert arm.
   *
   * Every test in `fixtures/sandbox-tests` raises through bare `Error(...)`, so the rule — "the
   * failure text does not begin with `Assert.`" — flags every kill that carries text and separates
   * NOTHING here. That is a property of the suite's assertion style, not of the mutants, and it is
   * worth pinning for the same reason the `partial` case is: the same flagged COUNT means opposite
   * things on the two suites, and only `discrimination` tells them apart.
   *
   * PREDICTED in docs/superpowers/specs/2026-08-14-r132-assertion-arm-precommitment.md before this
   * assertion was ever run, along with the competing possibility (`no-text`, if no kill carried
   * failure text at all — R132's own table lists both because nobody had measured which).
   */
  assertionScreenDiscrimination: "vacuous",
};

// Sandbox target app id (fixtures/sandbox-app/app.json "id") — the RunMutant `targetAppId` and the
// registry key the artifact guard reads. Static: the fixture app id is frozen.
const TARGET_APP_ID = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
// Test-codeunit ids the probes drive directly (fixtures/sandbox-tests + fixtures/sandbox-probes).
const SANDBOX_TESTS_ID = 79100;
const ORDER_MATTERS_PROBE_ID = 79210;
const FAIL_PROBE_ID = 79211;
const PROBE_TIMEOUT_MS = 120_000;
/**
 * Layer 5C-B1 (Task 8): the protocol-invariant probes below drive `RunMutantTransport` DIRECTLY,
 * not through `runSession`, so they must take the machine-global lease themselves — the two-phase
 * fence (design §5) refuses any RunMutant whose (epoch, token, serverGeneration) tuple does not
 * match the row, or whose `opSeq` is not exactly `lastCompletedOpSeq + 1`. `runSession` has
 * already released its own lease by the time the probes run, so this acquire is uncontended.
 *
 * Also live-exercises the renew heartbeat: the probes take minutes and the ttl is 15s, so without
 * renewing, the lease would lapse mid-probe (phase 1 honors a matching-but-lapsed tuple, but a
 * competing acquire could then steal it — exactly the design §9 "slow-run-under-renew" case).
 */
interface ProbeLease {
  readonly client: LeaseClient;
  readonly lease: Lease;
  /** The next exactly-next `opSeq` for a fenced RunMutant. */
  readonly nextOpSeq: () => number;
  /**
   * Task 9 diagnosability fix: the heartbeat used to be `client.renew(...).catch(() => {})` with
   * `renewed` never inspected — a genuinely lost probe lease then surfaced only as a downstream
   * protocol-invariant assertion failure with no hint it was actually a lease problem. Returns
   * `lost:true` once the heartbeat has seen `renewed:false` TWICE in a row (retry-once on a lost
   * ack before concluding loss, design §6) or a renew call itself throw twice in a row — a single
   * bad renew is not conclusive, but two are.
   */
  readonly leaseLostDiagnosis: () => string | undefined;
  readonly stop: () => Promise<void>;
}

async function acquireProbeLease(cfg: ActivationConfig): Promise<ProbeLease> {
  const harness = await new HarnessVerifier(cfg).verify();
  const client = new LeaseClient(cfg);
  const outcome = await client.acquire(
    `${hostname()}:${process.pid}:probes`,
    MAX_TTL_SECONDS,
    randomUUID(),
    harness.serverGeneration,
  );
  if (!outcome.granted) {
    throw new Error(
      `probe lease was not granted (${JSON.stringify(outcome)}) — the container is held or has a stranded operation; recover per design §8 before re-running the gate`,
    );
  }
  const lease = outcome.lease;
  let opSeq = lease.lastCompletedOpSeq;
  let consecutiveRenewFailures = 0;
  let lostDiagnosis: string | undefined;
  const heartbeat = setInterval(
    () => {
      void client
        .renew(lease, MAX_TTL_SECONDS)
        .then((r) => {
          if (r.renewed) {
            consecutiveRenewFailures = 0;
            return;
          }
          consecutiveRenewFailures++;
          if (consecutiveRenewFailures >= 2 && lostDiagnosis === undefined) {
            lostDiagnosis = `probe lease heartbeat: RenewLease returned renewed:false twice in a row (epoch=${lease.epoch}) — the lease is genuinely lost, not a single dropped ack`;
          }
        })
        .catch((err: unknown) => {
          consecutiveRenewFailures++;
          if (consecutiveRenewFailures >= 2 && lostDiagnosis === undefined) {
            lostDiagnosis = `probe lease heartbeat: RenewLease threw twice in a row: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
    },
    Math.floor((MAX_TTL_SECONDS * 1000) / 3),
  );
  return {
    client,
    lease,
    nextOpSeq: () => ++opSeq,
    leaseLostDiagnosis: () => lostDiagnosis,
    stop: async () => {
      clearInterval(heartbeat);
      await client.release(lease).catch(() => {});
    },
  };
}

interface LaunchLocalConfig {
  readonly configurations: ReadonlyArray<{
    readonly server?: string;
    readonly serverInstance?: string;
    readonly tenant?: string;
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

interface RunOnceResult {
  readonly report: SessionReport;
  readonly odataCfg: ActivationConfig;
  /** R206: `ResultsStore.sessionIdLiveness` for this run, read before the store closes. */
  readonly sessionLiveness: ReturnType<ResultsStore["sessionIdLiveness"]>;
  readonly instrumentedDir: string;
}

async function runOnce(scratchRoot: string): Promise<RunOnceResult> {
  const launchLocal = await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json");
  const launchCfg = launchLocal.configurations[0];
  if (!launchCfg) {
    throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);
  }

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

  // Persistent, NOT `:memory:` — historical run data (priorSurvivorKeys) is a supported
  // workflow. NOTE: app-version monotonicity no longer depends on this DB — since Layer 5A
  // versions are clock-derived via reserveAppVersion (app-version.ts), so deleting
  // lethal.sqlite can no longer break publishing.
  const instrumentedDir = join(scratchRoot, "instrumented");
  const store = new ResultsStore(join(PROJECT_DIR, "lethal.sqlite"));
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir,
      selectorIds: SELECTOR_IDS,
      // Layer 5C-B1 (design §6): the session takes the machine-global lease before it deploys,
      // fences the publish, heartbeats it, carries the tuple into every RunMutant, and releases
      // at the end. `serverGeneration` goes through the SAME HarnessVerifier the backend's
      // deploy() uses, so design §7's protocol-v2 gate runs before this session can acquire.
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      // A SCRATCH quarantine dir, deliberately NOT defaultQuarantineDir() (~/.lethal/quarantine —
      // the REAL store a live `lethal run` writes to), matching lease.itest.ts. Since 5C-B1 this
      // gate can write durable container-needs-recycle records, and one transient failure landing
      // in the real store poisons EVERY later gate run until an operator deletes it by hand
      // (observed live). The code path under test is identical either way — the store is
      // constructed from this path and nothing else — so do not "simplify" this back out.
      quarantineDir: join(scratchRoot, "quarantine"),
    });
    const runId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const sessionLiveness = store.sessionIdLiveness(runId);
    return { report, odataCfg, instrumentedDir, sessionLiveness };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and
    // this script never exits, even on a fully successful run.
    await backend.close();
  }
}

/**
 * Read the artifact id the deployed target self-registered, via the control extension's read-only
 * `LethALControl_RegisteredArtifact` OData action (Task 6/7). Single-parse OData scalar `value`
 * (a bare string, not the double-JSON RunMutant shape).
 */
async function odataReadRegisteredArtifact(
  cfg: ActivationConfig,
  targetAppId: string,
): Promise<string> {
  const params = new URLSearchParams({ company: cfg.company });
  if (cfg.tenant !== undefined) params.set("tenant", cfg.tenant);
  const url = `${cfg.baseUrl}/ODataV4/LethALControl_RegisteredArtifact?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ targetAppId }),
  });
  if (!res.ok) {
    throw new Error(`RegisteredArtifact read failed: HTTP ${res.status} ${await res.text()}`);
  }
  const value = ((await res.json()) as { value?: unknown }).value;
  return typeof value === "string" ? value : "";
}

/**
 * The gate is the per-mutant frozen table PLUS these protocol invariants (spec §11): the table
 * alone cannot catch a runner that runs the wrong method set or leaves a mutant active. Each probe
 * drives RunMutant directly against a fixture whose OUTCOME witnesses the invariant — so a lying
 * server (e.g. one that runs a whole codeunit but reports one line) is caught by behaviour, not by
 * a self-reported count. Uses the artifact the scratchB run just deployed — read from the LIVE
 * registry (`LethALControl_RegisteredArtifact`), which is the id the deployed binary itself baked
 * and self-registered on republish. That is the source of truth the RunMutant guard checks against
 * (so the probes' guard passes by construction) and it needs no knowledge of the orchestrator's
 * per-batch scratch-dir layout.
 */
async function runProtocolInvariantProbes(run: RunOnceResult): Promise<void> {
  const { report, odataCfg } = run;

  const artifactId = await odataReadRegisteredArtifact(odataCfg, TARGET_APP_ID);
  if (!/^[0-9a-f]{32}$/.test(artifactId)) {
    throw new Error(
      `LethALControl_RegisteredArtifact(${TARGET_APP_ID}) returned ${JSON.stringify(artifactId)}, not a 32-hex artifact id — the deployed target did not self-register (design §A/§B)`,
    );
  }

  const tx = new RunMutantTransport(odataCfg, TARGET_APP_ID, artifactId);
  // One lease for every probe below; each RunMutant claims the next op seq under it (design §5).
  const probe = await acquireProbeLease(odataCfg);
  const fence = () => ({
    epoch: probe.lease.epoch,
    token: probe.lease.token,
    serverGeneration: probe.lease.serverGeneration,
    opSeq: probe.nextOpSeq(),
  });
  try {
    const overBudget: TestMethodRef = {
      codeunitId: SANDBOX_TESTS_ID,
      codeunitName: "Sandbox Tests",
      method: "OverBudgetDetected",
    };

    // Invariant 1 — exactly-one-method-ran (order-matters witness, spec §C1). Requesting only
    // ZzFailsIfMarkerPresent and observing PASS proves AaInsertsMarker did NOT also run: had the
    // server run the whole codeunit, the marker would be present and this method would fail.
    const order = await tx.run({
      ref: {
        codeunitId: ORDER_MATTERS_PROBE_ID,
        codeunitName: "Order Matters Probe",
        method: "ZzFailsIfMarkerPresent",
      },
      mutantId: "",
      attemptId: "probe-order",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: fence(),
    });
    assert.equal(
      order.outcome,
      "pass",
      `exactly-one-method invariant: RunMutant(ZzFailsIfMarkerPresent) must run ONLY that method; a non-pass means AaInsertsMarker also ran server-side (whole-codeunit run). got ${JSON.stringify(order)}`,
    );

    // Failure round-trip (spec §11): the exact error text survives the identity-validated mapping
    // (result enum 1 -> fail, message carried through).
    const fail = await tx.run({
      ref: { codeunitId: FAIL_PROBE_ID, codeunitName: "Fail Probe", method: "AlwaysFails" },
      mutantId: "",
      attemptId: "probe-fail",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: fence(),
    });
    assert.equal(fail.outcome, "fail", `fail probe must map to fail, got ${JSON.stringify(fail)}`);
    assert.ok(
      fail.failureMessage?.includes("LETHAL-PROBE-FAIL: exact-error-round-trip"),
      `fail probe must round-trip its exact error, got ${JSON.stringify(fail.failureMessage)}`,
    );

    // Invariant 2 — run-scoped clear (spec §5 step 6, §C2). A killer mutant from the frozen table:
    // RunMutant activating it must make OverBudgetDetected fail (proof it was active during the run),
    // then a baseline RunMutant must pass (proof the same call cleared it — container left unmutated).
    const killer = report.mutants.find((m) => m.verdict === "killed");
    if (!killer) {
      throw new Error("no killed mutant in report — cannot drive the run-scoped-clear probe");
    }
    const mutated = await tx.run({
      ref: overBudget,
      mutantId: killer.mutantCode,
      attemptId: "probe-clear-active",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: fence(),
    });
    assert.equal(
      mutated.outcome,
      "fail",
      `run-scoped-clear setup: killer mutant ${killer.mutantCode} must make OverBudgetDetected fail ` +
        `(mutant active during the run). got ${JSON.stringify(mutated)}`,
    );
    const cleared = await tx.run({
      ref: overBudget,
      mutantId: "",
      attemptId: "probe-clear-baseline",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: fence(),
    });
    assert.equal(
      cleared.outcome,
      "pass",
      `run-scoped-clear: after a killer RunMutant, a baseline RunMutant must pass — the container must be left unmutated. got ${JSON.stringify(cleared)}`,
    );

    // Attestation fence (design §G): both `mutated` and `cleared` are real covered runs that drove
    // the deployed target's `Mutation Selector` (IsOverBudget's guard consulted `LC Control State`),
    // so each `ran` verdict must carry a CLEAN attestation — `observedAny` true (a selector was
    // consulted) AND `identityMismatch` false (the live binary's baked (targetAppId, artifactId)
    // matched what we deployed). This is the live proof the running binary is ours; a wrong/stale
    // binary would surface `identityMismatch: true` (already mapped to `error` by the transport, so
    // it never reaches here as a verdict) or, if it ran no guard, `observedAny: false`.
    for (const [label, v] of [
      ["mutated", mutated],
      ["cleared", cleared],
    ] as const) {
      assert.ok(
        v.attestation !== undefined &&
          v.attestation.observedAny === true &&
          v.attestation.identityMismatch === false,
        `attestation §G: covered run "${label}" must cleanly attest the deployed binary's selector ` +
          `(observedAny && !identityMismatch). got ${JSON.stringify(v.attestation)}`,
      );
    }

    // Invariant 3 — artifact-mismatch (spec §C1). A RunMutant whose artifactId differs from the
    // registered one runs nothing and is a typed error, never a verdict.
    //
    // ORDERING HAZARD (Task 9, design §5 phase 1): an artifact-mismatch is refused at phase 1
    // ("2. Artifact guard") BEFORE the opSeq tombstone check ever runs, so the server's
    // `Last Completed Op Seq` does NOT advance past it — this call's `fence()`-supplied opSeq is
    // consumed by our LOCAL bookkeeping (`probe.nextOpSeq()`) but never recorded server-side. That
    // leaves `probe`'s local opSeq counter one ahead of the server's. This is harmless ONLY because
    // this is the LAST fenced call under `probe` before the `finally` releases it — a later fenced
    // call reusing `probe` would send `serverLastCompleted + 2` instead of `+ 1` and be refused as
    // `lease-invalid` (phase 1's "OpSeq <= Last Completed Op Seq" / "else refuse" branches never see
    // an exact match). If you add a fenced call AFTER this one, either move this artifact-mismatch
    // probe to stay last, or resync first via `probe.client.getOperationStatus(...)` and rebuild
    // `probe`'s opSeq counter from its `lastCompletedOpSeq` — do not just append and assume opSeq
    // bookkeeping still lines up.
    const bogusTx = new RunMutantTransport(odataCfg, TARGET_APP_ID, "f".repeat(32));
    const mismatch = await bogusTx.run({
      ref: overBudget,
      mutantId: "",
      attemptId: "probe-artifact-mismatch",
      timeoutMs: PROBE_TIMEOUT_MS,
      lease: fence(),
    });
    assert.equal(
      mismatch.outcome,
      "error",
      `artifact-mismatch must be a typed error, never a verdict. got ${JSON.stringify(mismatch)}`,
    );
    assert.ok(
      mismatch.failureMessage?.includes("artifact-mismatch"),
      `artifact-mismatch probe must surface the mismatch, got ${JSON.stringify(mismatch.failureMessage)}`,
    );

    // Invariant 4 — identity-mismatch rejection (spec §I5). Every real RunMutant above validated the
    // echoed identity tuple; a server that ran something other than requested would have surfaced as
    // an error and failed the assertions here. The client-side rejection of a doctored echo is
    // unit-tested in run-mutant-transport.test.ts.

    console.log("bcdev itest: protocol-invariant probes PASS");
  } catch (err) {
    // Task 9 diagnosability fix (design §9 hazard): a genuinely lost probe lease used to surface
    // only as a confusing downstream protocol-invariant assertion failure (e.g. an unexpected
    // "lease-invalid" on some later RunMutant), with no hint the ROOT cause was the heartbeat
    // losing the renew race, not a bug in the invariant being probed. If the heartbeat itself
    // observed the loss, prepend that diagnosis so the failure names the actual root cause.
    const lost = probe.leaseLostDiagnosis();
    if (lost !== undefined) {
      throw new Error(
        `runProtocolInvariantProbes failed, and the probe lease heartbeat independently reported a lease loss — this is very likely a LEASE-LOSS failure, not a bug in the protocol invariant being probed. Heartbeat diagnosis: ${lost}. Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  } finally {
    // Always stop renewing and release, even on a failed assertion: a probe lease left held would
    // block the next gate run (and every other session on this container) until it lapsed.
    await probe.stop();
  }
}

/**
 * R206 §6: the store-level liveness check on `session_id`, and the guard's own count. Scoped to
 * rows that came from an answer (a 408 carries no id; an aborted call's row has none): every
 * pass/fail row carries an id, the grouped rows' distinct ids equal the group calls that
 * ANSWERED (`groupedCalls` minus `stoppedCalls`), and every single-call row is its own session.
 * This is the anti-inertness control for `sessionId` now that the guard's predicate is
 * `testRunsBefore`: scoped so it holds on every gate, never softened to "some row has an id".
 */
function assertSessionLiveness(
  report: SessionReport,
  live: ReturnType<ResultsStore["sessionIdLiveness"]>,
  stoppedCalls: number,
): void {
  assert.equal(
    report.mutants.filter((m) => m.cause === "session-reused").length,
    0,
    "R206: no mutant may be refused as session-reused on a container that hands every request a fresh session",
  );
  assert.equal(
    live.missing,
    0,
    `R206: every pass/fail row must carry a session id; ${live.missing} do not`,
  );
  assert.ok(live.answered > 0, "R206: the store must hold answered rows to check");
  assert.equal(
    live.manyDistinct,
    (report.groupedCalls ?? 0) - stoppedCalls,
    `R206: distinct session ids among grouped pass/fail rows must equal the group calls that answered (${report.groupedCalls} minus ${stoppedCalls}); got ${live.manyDistinct}`,
  );
  assert.equal(
    live.singleRows,
    live.singleDistinct,
    `R206: every single-call row must be its own session; ${live.singleRows} rows carry ${live.singleDistinct} distinct ids`,
  );
}

function assertVerdictTable(report: SessionReport): void {
  // Always dump the per-mutant table BEFORE asserting. A bare "survived count mismatch 3 !== 10"
  // says nothing about which mutants moved or why, and this gate takes minutes to re-run against
  // a live container — so the first run has to carry its own diagnosis.
  console.log(
    `  verdicts: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage} baselineGreen=${report.baselineGreen}`,
  );
  for (const m of report.mutants) {
    const cause = m.cause !== undefined ? ` cause=${m.cause}` : "";
    // `failureNote` is the only field that says WHY a mutant errored — without it a live failure
    // shows `M0008 error` and nothing else, and the lease/lost-ack branches (design §5) are
    // indistinguishable from a plain transport error in the log. al-runner.itest.ts already
    // prints it; this line had drifted from that one.
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
  assert.equal(
    report.groupedCalls,
    EXPECTED.groupedCalls,
    `R198: expected exactly ${EXPECTED.groupedCalls} RunMutantMany calls (one per scored mutant); ` +
      `got ${report.groupedCalls}. Fewer means the grouped path silently stopped being used; more ` +
      "means a chunk, a lost-ack retry or an unexpected replay happened on a container gate, which must be explained",
  );
  // R206: no kill here is warm (every killer is first in its call), every kill carries a
  // position, and the session guard fired on nothing.
  assert.equal(
    report.warmKills,
    EXPECTED.warmKills,
    `R206: expected ${EXPECTED.warmKills} warm kills; got ${report.warmKills}`,
  );
  for (const m of report.mutants) {
    if (m.verdict !== "killed" && m.verdict !== "timeout-killed") continue;
    assert.equal(
      m.killPosition,
      1,
      `R206: ${m.mutantCode} killPosition ${m.killPosition}, expected 1`,
    );
  }
  assert.ok(
    report.validity.caveats.includes("session-warm"),
    `R206: a report with grouped calls must carry the session-warm caveat; got ${JSON.stringify(report.validity.caveats)}`,
  );
  // R175: pins the ABSENCE. A naming gap means the line map could not place a line BC says executed,
  // in source LethAL itself emitted, and every mutant in that object then reports `no-coverage` for
  // a reason that is ours rather than the suite's. No valid AL should produce one, so a rise here is
  // a regression in attribution, not a change in the fixture — and it would otherwise be invisible,
  // because those mutants keep the same verdict and the same counts.
  assert.equal(
    report.unplaceableCount,
    0,
    `attribution could not place ${report.unplaceableCount} mutant(s): ${report.unplaceableMutants.join(", ")}`,
  );

  const killed = report.mutants.filter((m) => m.verdict === "killed");
  assert.equal(killed.length, EXPECTED.killed);
  for (const m of killed) {
    assert.ok(
      m.file.includes("SandboxLogic"),
      `expected every killed mutant in SandboxLogic.Codeunit.al (IsOverBudget), got ${m.file}`,
    );
  }

  // R132: the vacuous half of the pair this repo now pins live. See EXPECTED's comment.
  const assertionScreen = report.assertionScreen;
  assert.ok(
    assertionScreen !== undefined,
    `a run with ${EXPECTED.killed} kills must carry an assertion screen`,
  );
  assert.ok(
    assertionScreen.killsWithText > 0,
    "every kill on this path records its failure text (R86) — a zero here means the screen is " +
      "reporting `no-text` about a suite it never read",
  );
  assert.equal(
    assertionScreen.discrimination,
    EXPECTED.assertionScreenDiscrimination,
    "this fixture's tests all raise through bare `Error(...)`, so the screen must report that it " +
      "separated nothing here. A `partial` would mean this suite grew an assertion library, or the " +
      "rule started matching text it was never scored on",
  );
  assert.equal(
    assertionScreen.flagged,
    assertionScreen.killsWithText,
    "vacuous means every kill with text was flagged — asserted directly so the label and the " +
      "numbers behind it cannot disagree",
  );

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
  const { files } = await generateMutationSet(join(PROJECT_DIR, "src"));
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the fixture, generated ${total}`,
  );

  const scratchA = await mkdtemp(join(tmpdir(), "lethal-itest-bcdev-a-"));
  const scratchB = await mkdtemp(join(tmpdir(), "lethal-itest-bcdev-b-"));
  try {
    const first = await runOnce(scratchA);
    assertVerdictTable(first.report);
    assertSessionLiveness(first.report, first.sessionLiveness, 0);
    // Per-mutant regression guard against the committed baseline — in addition to the aggregate
    // verdict counts assertVerdictTable already checked. A per-mutant difference fails the
    // itest even when killed/survived/no-coverage totals still match (Task 15, design spec §14).
    await assertMatchesBaseline(first.report, BASELINE_PATH, "bcdev itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second.report);

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first.report),
      shape(second.report),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion)",
    );

    // Gate = the frozen per-mutant table above PLUS the protocol invariants (spec §11). Runs
    // against the artifact scratchB just deployed, before the scratch dirs are cleaned up.
    await runProtocolInvariantProbes(second);
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }

  console.log("bcdev itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
