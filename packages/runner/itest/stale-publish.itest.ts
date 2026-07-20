#!/usr/bin/env bun
/**
 * Env-gated LIVE integration test for Layer 5A's hard stop (design spec §9): two
 * stale-publication probes against a real Business Central dev server. NOT a `bun:test` file —
 * standalone script invoked via `bun run itest:stale-publish` (root package.json), never picked
 * up by `bun test`. Skips cleanly (exit 0) when LETHAL_ITEST_BCDEV is unset, same gate as
 * bcdev.itest.ts (this probe needs the same live infra, so it reuses the same env var rather
 * than inventing a second one).
 *
 * Reads the same gitignored local files as bcdev.itest.ts:
 *   fixtures/sandbox-app/.vscode/launch.local.json
 *   fixtures/sandbox-app/lethal.config.local.json
 *
 * **Why two probes, not one delayed publish** (spec §9): "delay A" is ambiguous — if A is
 * delayed only after the server already committed it, the ordering under test never happens;
 * if A holds a catalog lock, B may simply block behind it instead of racing it. Probe A is the
 * DETERMINISTIC case (A compiled first, dispatched last); Probe B is the CONCURRENT case (both
 * dispatched at once, repeatedly, so ordering is genuinely up to the server/OS, not this
 * script).
 *
 * **What "fresh behaviour" means here**, beyond `MutationControl_Identity`: this system has
 * exactly ONE per-artifact discriminator baked at compile time — the artifact id `Identity()`
 * reports (see deployment-verifier.ts's own doc comment: it proves only "a fresh Identity
 * request observed code claiming artifact id X at that moment"). Two artifacts built from the
 * same manifest cannot be told apart by test OUTCOME alone. So "fresh behaviour" here is: run
 * the fixture's real baseline test live via the real bc-dev-mcp test runner, activate a real,
 * known mutant from the artifact's own compiled manifest, confirm the SAME test fails, then
 * clear and confirm it passes again — proving the server is genuinely running live, responsive,
 * correctly-wired LethAL-instrumented code end-to-end, not just that one OData action returns a
 * particular string. Combined with Identity() (which DOES discriminate artifact A from B), this
 * satisfies "never on altool output alone."
 *
 * **The hard stop**: if either probe lets A become the final installed artifact after B,
 * monotonic versioning is not a sufficient deployment-order barrier for this toolchain and, per
 * spec §9, Layer 5A fails. This script throws (non-zero exit) rather than softening that
 * assertion — see the comments on `assertBFinal` below.
 */
import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstrumentedFile, MutantManifest, SelectorConfig } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { MutationControlClient } from "../src/activation";
import { parseVersionConflict, reserveAppVersion } from "../src/app-version";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import type { CompiledArtifact } from "../src/artifact";
import type { TestMethodRef } from "../src/backend";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import type { LethalConfigFile } from "../src/cli";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { discoverTests } from "../src/discovery";
import { generateMutationSet } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { ContainerDeployerIo, SpawnFn } from "../src/publisher";

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

// Same ids as bcdev.itest.ts / al-runner.itest.ts — must live inside the fixture's declared
// idRanges (79000-79199), enforced by real alc.exe (AL0297).
const SELECTOR_IDS: SelectorConfig = { selectorId: 79199, controlId: 79198, tableId: 79197 };

const RUN_TIMEOUT_MS = 60_000;
const PROBE_B_ROUNDS = 3;

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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 128 random bits as 32 lowercase hex chars — same shape/generation as orchestrator.ts's
 * `newArtifactId`, duplicated here since it isn't exported (this script deliberately drives
 * ArtifactCompiler/ContainerDeployer/DeploymentVerifier directly instead of through
 * `runSession`, so it can pause between compile and publish — exactly what the probes need). */
function newArtifactId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Wraps a real `ContainerDeployerIo` with an in-flight counter around `spawn` — the actual
 * `altool.exe` OS process launch, i.e. the exact operation Task 8b's serializer (`publish-
 * serializer.ts`) must never let overlap for two publishes to the same container. Same
 * technique the unit tests use (`publish-serializer.test.ts`): increment on entry, record the
 * max seen, decrement on exit — never wall-clock timing. `reset()` clears the max between Probe
 * B rounds so each round's assertion is about that round only, not a residual high-water mark
 * from an earlier one.
 */
function instrumentedDeployerIo(base: ContainerDeployerIo): {
  readonly io: ContainerDeployerIo;
  readonly maxInFlight: () => number;
  readonly reset: () => void;
} {
  let current = 0;
  let max = 0;
  const spawn: SpawnFn = async (argv, opts) => {
    current++;
    max = Math.max(max, current);
    try {
      return await base.spawn(argv, opts);
    } finally {
      current--;
    }
  };
  return {
    io: { ...base, spawn },
    maxInFlight: () => max,
    reset: () => {
      max = 0;
    },
  };
}

/** Threads the last version this script issued into the next reservation, mirroring
 * `runSession`'s session-scoped `lastIssuedVersion` — keeps every artifact this whole script
 * compiles (both probes, all rounds) strictly increasing, so Probe B's later rounds can never
 * collide with an earlier round's versions. */
class VersionState {
  private last: string | undefined;
  constructor(private readonly sourceVersion: string) {}
  next(): string {
    const v = reserveAppVersion({
      sourceVersion: this.sourceVersion,
      nowMs: Date.now(),
      ...(this.last !== undefined ? { lastIssued: this.last } : {}),
    });
    this.last = v;
    return v;
  }
}

interface Ctx {
  readonly compiler: ArtifactCompiler;
  readonly deployer: ContainerDeployer;
  readonly verifier: DeploymentVerifier;
  readonly activation: MutationControlClient;
  readonly backend: BcDevMcpBackend;
  readonly files: readonly InstrumentedFile[];
  readonly appId: string;
  readonly appManifestBase: Readonly<Record<string, unknown>>;
  readonly versions: VersionState;
  readonly overBudgetRef: TestMethodRef;
  readonly scratchRoot: string;
  /** Task 8b: proves the serializer, not just BC's final state, actually held the two
   * concurrent Probe B publishes to one-at-a-time — see `instrumentedDeployerIo`. */
  readonly publishTracker: { readonly maxInFlight: () => number; readonly reset: () => void };
}

/**
 * Writes one instrumented artifact into `scratchDir` (mirrors orchestrator.ts's
 * `prepareArtifactDir`/`prepareBatchProject`, duplicated here for the same reason as
 * `newArtifactId`) and compiles it — but does NOT publish. That's the point: Probe A's step 1-2
 * ("reserve and compile A at V, do NOT invoke altool yet") needs compile and publish to be two
 * genuinely separate calls a test script controls, which is exactly what `ArtifactCompiler`/
 * `ContainerDeployer` already give it.
 */
async function compileArtifact(
  ctx: Ctx,
  scratchDir: string,
  artifactId: string,
  appVersion: string,
): Promise<CompiledArtifact> {
  await rm(scratchDir, { recursive: true, force: true });
  await writeInstrumentedProject({
    targetDir: scratchDir,
    files: ctx.files,
    selectorIds: SELECTOR_IDS,
    artifactId,
  });
  const appManifest = { ...ctx.appManifestBase, version: appVersion };
  await writeFile(
    join(scratchDir, "app.json"),
    `${JSON.stringify(appManifest, null, 2)}\n`,
    "utf8",
  );

  // Defensive, mirrors prepareBatchProject: copy any project .al file writeInstrumentedProject
  // didn't already write (none today — both sandbox-app .al files carry >=1 mutant — but a
  // future fixture file with zero mutants would need this to compile at all).
  const entries = (await readdir(PROJECT_DIR, { recursive: true })).filter((e) =>
    e.toLowerCase().endsWith(".al"),
  );
  for (const rel of entries) {
    const dest = join(scratchDir, basename(rel));
    if (await pathExists(dest)) continue;
    await copyFile(join(PROJECT_DIR, rel), dest);
  }

  const mutantManifest = JSON.parse(
    await readFile(join(scratchDir, "mutant-manifest.json"), "utf8"),
  ) as MutantManifest;
  assert.equal(
    mutantManifest.artifactId,
    artifactId,
    "compileArtifact: manifest/artifactId mismatch",
  );

  return ctx.compiler.compile({
    projectDir: scratchDir,
    artifactId,
    appId: ctx.appId,
    appVersion,
    mutantManifest,
    appManifest,
  });
}

/**
 * The fixture's known, hand-verified killer (fixtures/README.md's expected verdict table):
 * `IsOverBudget`'s return-value mutant (`exit(Amount>Budget)` -> `exit(not(...))`) is killed by
 * EVERY assertion in `OverBudgetDetected` — the strongest, least ambiguous marker available.
 */
function findKillerMutantId(manifest: MutantManifest): string {
  // Operator names carry the "lethal." prefix (see builtin-tier1's ReturnValue operator) —
  // verified against a real compiled manifest 2026-07-20, not assumed.
  const m = manifest.mutants.find(
    (x) => x.procedureName === "IsOverBudget" && x.operatorName === "lethal.return-value",
  );
  if (m === undefined) {
    throw new Error(
      "stale-publish itest: expected IsOverBudget return-value mutant not found in the compiled " +
        "manifest — fixture or operator set changed? See fixtures/README.md's expected verdict table.",
    );
  }
  return m.mutantId;
}

/**
 * "A fresh behaviour probe still observes B" (spec §9): actually run the live test runner
 * through a full baseline -> mutant-kill -> clear cycle. Not Identity() again — a genuinely
 * independent signal that the currently-deployed artifact is alive, responsive, and its
 * mutation-control wiring behaves exactly as the fixture's hand-verified table says it must.
 */
async function assertFreshBehaviour(
  ctx: Ctx,
  killerMutantId: string,
  label: string,
): Promise<void> {
  await ctx.activation.clearActive();
  const baseline = await ctx.backend.run(ctx.overBudgetRef, {
    coverage: "none",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  assert.equal(
    baseline.outcome,
    "pass",
    `${label}: fresh run of OverBudgetDetected with NO mutant active must PASS, got ` +
      `${baseline.outcome}${baseline.failureMessage ? `: ${baseline.failureMessage}` : ""}`,
  );

  await ctx.activation.setActive(killerMutantId);
  const mutated = await ctx.backend.run(ctx.overBudgetRef, {
    coverage: "none",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  assert.equal(
    mutated.outcome,
    "fail",
    `${label}: fresh run of OverBudgetDetected with killer mutant ${killerMutantId} active must FAIL (this is the fresh-behaviour evidence that the server is genuinely running THIS artifact's code, not cached/stale state) — got ${mutated.outcome}`,
  );

  await ctx.activation.clearActive();
  const cleared = await ctx.backend.run(ctx.overBudgetRef, {
    coverage: "none",
    timeoutMs: RUN_TIMEOUT_MS,
  });
  assert.equal(
    cleared.outcome,
    "pass",
    `${label}: fresh run of OverBudgetDetected after clearActive must PASS again, got ${cleared.outcome}`,
  );
}

/**
 * The shared "is B genuinely the final installed artifact, and A never was" check both probes
 * use. Checks Identity for BOTH artifacts (not just B) — a verifier that only ever checked B
 * would not actually rule out A having ALSO landed in some ambiguous partial state.
 */
async function assertBFinal(
  ctx: Ctx,
  artifactA: CompiledArtifact,
  artifactB: CompiledArtifact,
  label: string,
): Promise<void> {
  const verifyB = await ctx.verifier.verify(artifactB);
  assert.equal(
    verifyB.status,
    "accepted",
    `${label}: Identity must confirm B (${artifactB.artifactId}) as the final installed artifact, got ${JSON.stringify(verifyB)}. If this fails, monotonic versioning is NOT a sufficient deployment-order barrier for this toolchain and per spec §9 Layer 5A fails.`,
  );

  const verifyA = await ctx.verifier.verify(artifactA);
  assert.notEqual(
    verifyA.status,
    "accepted",
    `${label}: Identity must NEVER confirm A (${artifactA.artifactId}) as final — A becoming final after B is exactly the failure mode spec §9 defines as "Layer 5A fails". Got ${JSON.stringify(verifyA)}.`,
  );
  if (verifyA.status === "mismatch") {
    assert.equal(
      verifyA.reported,
      artifactB.artifactId,
      `${label}: A's mismatch must report B's id specifically (proving B, not some third state, ` +
        `is what's actually running), got reported=${verifyA.reported}`,
    );
  }

  await assertFreshBehaviour(ctx, findKillerMutantId(artifactB.mutantManifest), label);
}

/**
 * Probe A — deterministic stale dispatch (spec §9):
 *   1. Reserve and compile A at V.
 *   2. Do NOT invoke altool yet.
 *   3. Reserve and compile B at V+1.
 *   4. Publish and verify B.
 *   5. NOW invoke publication of A.
 * Assert: A's publish fails (and specifically because BC's downgrade rejection names B's
 * version as already installed — not some unrelated failure), catalog/Identity stay on B, and a
 * fresh behaviour probe still observes B.
 */
async function probeA(ctx: Ctx): Promise<void> {
  console.log("\n=== Probe A: deterministic stale dispatch ===");

  const versionA = ctx.versions.next();
  const idA = newArtifactId();
  const artifactA = await compileArtifact(ctx, join(ctx.scratchRoot, "probeA-a"), idA, versionA);
  console.log(
    `  compiled A: version=${artifactA.appVersion} id=${artifactA.artifactId} (NOT published yet)`,
  );

  const versionB = ctx.versions.next();
  const idB = newArtifactId();
  const artifactB = await compileArtifact(ctx, join(ctx.scratchRoot, "probeA-b"), idB, versionB);
  console.log(`  compiled B: version=${artifactB.appVersion} id=${artifactB.artifactId}`);

  await ctx.deployer.publish(artifactB);
  const verifyB = await ctx.verifier.verify(artifactB);
  assert.equal(
    verifyB.status,
    "accepted",
    `Probe A: B's own publish must verify as accepted before testing A, got ${JSON.stringify(verifyB)}`,
  );
  console.log("  published + verified B");
  await assertFreshBehaviour(
    ctx,
    findKillerMutantId(artifactB.mutantManifest),
    "Probe A / after B published",
  );
  console.log("  fresh-behaviour probe confirms B (baseline pass -> mutant fail -> clear pass)");

  let aPublishError: unknown;
  try {
    await ctx.deployer.publish(artifactA);
  } catch (err) {
    aPublishError = err;
  }
  assert.ok(
    aPublishError !== undefined,
    "Probe A: A's publish must be REJECTED now that B (a newer version) is already installed. " +
      "It was not — per spec §9, monotonic versioning is not a sufficient deployment-order " +
      "barrier for this toolchain and Layer 5A fails.",
  );
  const conflictVersion = parseVersionConflict(messageOf(aPublishError));
  assert.equal(
    conflictVersion,
    artifactB.appVersion,
    `Probe A: A's rejection must specifically be BC's downgrade check naming B's version (${artifactB.appVersion}) as already installed — got a different failure, which would mean this probe isn't actually exercising the ordering barrier: ${messageOf(aPublishError)}`,
  );
  console.log(`  A's publish rejected as expected: ${messageOf(aPublishError).split("\n")[0]}`);

  await assertBFinal(ctx, artifactA, artifactB, "Probe A / after A's publish was rejected");
  console.log("Probe A: PASS");
}

/**
 * Probe B — concurrent race (spec §9), repeated `PROBE_B_ROUNDS` times: compile A at V and B at
 * V+1, start BOTH publications concurrently (two real, independent `altool.exe` OS processes
 * racing the actual server — not simulated), and assert that regardless of which one the
 * server processes first, the final state is B: B's version, B's identity, A never final, no
 * partial/ambiguous install.
 *
 * Deliberately does NOT assert anything about which of the two `publish()` promises resolves or
 * rejects, or in what order (see the comment above `settled` below) — only the post-hoc,
 * server-observed final state matters, exactly as the design intends ("never on altool output
 * alone").
 *
 * Task 8b: dispatch stays genuinely concurrent (both `publish()` calls fired without awaiting
 * between them) — the fix under test is that `ContainerDeployer.publish()` now serializes
 * per-container internally (`publish-serializer.ts`), so BC itself never sees two overlapping
 * `altool` processes even though this script still dispatches them at once. Each round asserts
 * BOTH that the serializer actually held them one-at-a-time (`publishTracker.maxInFlight()`,
 * the in-flight counter around the real `altool.exe` spawn) and that B ended up final
 * (`assertBFinal`) — the first proves the mechanism, the second proves the outcome.
 */
async function probeB(ctx: Ctx): Promise<void> {
  console.log(`\n=== Probe B: concurrent race (${PROBE_B_ROUNDS} rounds) ===`);

  for (let round = 1; round <= PROBE_B_ROUNDS; round++) {
    const versionA = ctx.versions.next();
    const idA = newArtifactId();
    const artifactA = await compileArtifact(
      ctx,
      join(ctx.scratchRoot, `probeB-r${round}-a`),
      idA,
      versionA,
    );
    const versionB = ctx.versions.next();
    const idB = newArtifactId();
    const artifactB = await compileArtifact(
      ctx,
      join(ctx.scratchRoot, `probeB-r${round}-b`),
      idB,
      versionB,
    );
    console.log(
      `  round ${round}: A=${artifactA.appVersion}/${artifactA.artifactId} ` +
        `B=${artifactB.appVersion}/${artifactB.artifactId}, publishing concurrently...`,
    );

    ctx.publishTracker.reset();

    // Two genuinely concurrent OS processes (Bun.spawn under ContainerDeployer.publish) hitting
    // the same server — NOT awaited sequentially. `allSettled`, not `all`: either publish may
    // legitimately succeed OR fail depending on server-side interleaving (e.g. A can land
    // harmlessly if the server happens to apply it before B, since B > A is still accepted
    // afterward) — this script must not assume a specific outcome shape, only check the FINAL
    // state below. Safe to re-run every round now (Task 8b): the serializer means BC never
    // actually sees these two `altool` processes overlap, regardless of how this script
    // dispatches them.
    const settled = await Promise.allSettled([
      ctx.deployer.publish(artifactA).then(
        () => ({ who: "A" as const, ok: true as const }),
        (err: unknown) => ({ who: "A" as const, ok: false as const, err: messageOf(err) }),
      ),
      ctx.deployer.publish(artifactB).then(
        () => ({ who: "B" as const, ok: true as const }),
        (err: unknown) => ({ who: "B" as const, ok: false as const, err: messageOf(err) }),
      ),
    ]);
    const summary = settled.map((s) =>
      s.status === "fulfilled" ? s.value : { err: messageOf(s.reason) },
    );
    console.log(`    publish results: ${JSON.stringify(summary)}`);

    const maxInFlight = ctx.publishTracker.maxInFlight();
    assert.ok(
      maxInFlight <= 1,
      `Probe B round ${round}: the serializer failed to hold the two concurrent publishes one-at-a-time — observed ${maxInFlight} altool.exe processes in flight simultaneously against this container. This is exactly the intra-process race Task 8b closes; if this fires, publish-serializer.ts is not actually gating ContainerDeployer.publish().`,
    );
    console.log(`    serializer held publishes one-at-a-time (max in-flight: ${maxInFlight})`);

    await assertBFinal(ctx, artifactA, artifactB, `Probe B round ${round}`);
    console.log(`  round ${round}: PASS — B is final, A never was, fresh behaviour confirms B`);
  }
  console.log("Probe B: PASS");
}

async function main(): Promise<void> {
  const launchLocal = await readJson<LaunchLocalConfig>(LAUNCH_LOCAL_PATH, "launch.local.json");
  const launchCfg = launchLocal.configurations[0];
  if (!launchCfg) throw new Error(`${LAUNCH_LOCAL_PATH} has no configurations[0] entry`);

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

  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-itest-stale-publish-"));
  const outputDir = join(scratchRoot, "publish");
  await mkdir(outputDir, { recursive: true });

  const compiler = new ArtifactCompiler(
    { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
    defaultArtifactIo,
  );
  // Task 8b: instrument the real deployer IO so Probe B can prove the serializer actually held
  // the two concurrent publishes one-at-a-time, not just that BC's final state happened to be
  // B (see `instrumentedDeployerIo`'s doc comment above).
  const deployerIoTracker = instrumentedDeployerIo(defaultDeployerIo);
  const deployer = new ContainerDeployer(
    {
      altoolPath: toolPaths.altoolPath,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      username: bcdev.username,
      password: bcdev.password,
      ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
    },
    deployerIoTracker.io,
  );
  const odataCfg = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const verifier = new DeploymentVerifier(odataCfg);
  const activation = new MutationControlClient(odataCfg);
  const backend = new BcDevMcpBackend(
    {
      mcpCommand: bcdev.mcpCommand,
      project: PROJECT_DIR,
      server: bcdev.server,
      serverInstance: bcdev.serverInstance,
      company: bcdev.company,
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
    undefined, // no compiler/deployer/verifier on the backend itself — this script drives them directly
    activation,
  );

  const appManifestBase = await readJson<Record<string, unknown>>(
    join(PROJECT_DIR, "app.json"),
    "sandbox-app app.json",
  );
  const appId = appManifestBase.id;
  const sourceVersion = appManifestBase.version;
  if (typeof appId !== "string" || typeof sourceVersion !== "string") {
    throw new Error(`${PROJECT_DIR}/app.json must carry string "id" and "version" fields`);
  }

  const files = await generateMutationSet(join(PROJECT_DIR, "src"));
  const tests = await discoverTests(TEST_DIR);
  const overBudgetRef = tests.find((t) => t.method === "OverBudgetDetected");
  if (overBudgetRef === undefined) {
    throw new Error(
      `stale-publish itest: OverBudgetDetected not found by discoverTests(${TEST_DIR}) — fixture changed?`,
    );
  }

  const ctx: Ctx = {
    compiler,
    deployer,
    verifier,
    activation,
    backend,
    files,
    appId,
    appManifestBase,
    versions: new VersionState(sourceVersion),
    overBudgetRef,
    scratchRoot,
    publishTracker: {
      maxInFlight: deployerIoTracker.maxInFlight,
      reset: deployerIoTracker.reset,
    },
  };

  try {
    await probeA(ctx);
    await probeB(ctx);
    console.log("\nstale-publish itest: PASS (Probe A + Probe B)");
  } finally {
    await backend.close();
    await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
