#!/usr/bin/env bun
/**
 * R53's gate: a mutant that never terminates, scored rather than quarantined.
 *
 * Env-gated, standalone (`bun run itest:hang`), never picked up by `bun test`. Skips cleanly when
 * LETHAL_ITEST_HANG is unset.
 *
 * WHY A WHOLE FIXTURE AND GATE EXIST FOR ONE FLAG. Measured on Continia Document Output, M0013 is
 * `negate-conditional` on `until DOCustSetup.Next() = 0;` — it never terminates, the client can
 * only see its own abort, and an abort is ambiguous (BC may still be executing), so it quarantines
 * the tier and BLOCKS EVERY MUTANT BEHIND IT: 125 of 138 never ran. No other fixture in this repo
 * contains a non-terminating mutant, so before this gate the entire `--stop-hung-sessions` path
 * was proven only by unit tests and one manual run.
 *
 * WHAT MAKES THIS GATE UNABLE TO PASS FOR THE WRONG REASON — and which assertion does which job,
 * MEASURED by mutating the source and re-running, not assumed:
 *
 *   - Minting a kill from our own abort (transport's aborted branch returning `outcome: "timeout"`
 *     with no 408 behind it) is caught by the OFF LEG: its hanging mutant stops being an `error`
 *     with the "could not be confirmed complete" note. NOT by the ON leg — there the stop works,
 *     the 408 arrives, and the aborted branch is never reached.
 *   - Recording a kill without BC's confirmation (the 408 branch keeping the verdict but dropping
 *     the body from the record) is caught by the ON LEG's evidence assertion: outcome exactly
 *     `timeout`, and a failure message carrying BOTH "stopped the session" and "StopSession".
 *
 * The two legs therefore guard different doors and neither is redundant. One mutation was also
 * tried and did NOT fail this gate — routing `deadline-exceeded` to `timeout-killed` in the
 * orchestrator's outcome switch — because a hung run reaches the stranded/quarantine path before
 * that switch, so the branch is unreachable in both legs. It is recorded here because an untested
 * claim about what a gate catches is exactly the defect this repo keeps finding.
 *
 * ORDER IS DELIBERATE: the ON leg runs FIRST, because it leaves the tier clean. The OFF leg
 * quarantines by design and is torn down afterwards.
 *
 * Connection details are never committed; this reads the gitignored
 *   fixtures/sandbox-hang/lethal.config.local.json
 * and the fixture's test app must be published to that container (LethAL publishes the TARGET on
 * every run but treats publishing the TEST app as the user's own workflow — R56).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient } from "../src/lease";
import { runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";

if (!process.env.LETHAL_ITEST_HANG) {
  console.log(
    "skipped (set LETHAL_ITEST_HANG=1, populate the gitignored " +
      "fixtures/sandbox-hang/lethal.config.local.json, and publish " +
      "fixtures/sandbox-hang-tests to that container to run this)",
  );
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-hang");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-hang-tests");
const CONFIG_LOCAL_PATH = join(PROJECT_DIR, "lethal.config.local.json");

// Inside sandbox-hang's declared idRanges (79400-79449) — alc enforces app.json idRanges (AL0297)
// for the injected objects too.
const SELECTOR_IDS = { selectorId: 79447, controlId: 79448, tableId: 79449 };

/**
 * Short on purpose. Every hanging mutant costs a full budget before the stop fires, and there are
 * two of them, so this is the dominant term in the gate's wall clock. 20 s is far above the
 * terminating mutants' measured cost (66-141 ms, three orders of magnitude of headroom) and far
 * below anything that would make a slow-but-correct mutant look like a hang.
 */
const BUDGET_MS = 20_000;
/** `RunMutantRequest.stopGraceMs`'s default — how long the held request waits after the stop. */
const STOP_GRACE_MS = 30_000;

/**
 * The expected per-mutant table, keyed by `file:line` + operator so a moved line fails loudly
 * rather than silently re-pairing. Line numbers track `HangLogic.Codeunit.al`.
 *
 * Both hangs are STRUCTURAL, not slow: each freezes `Counter` at 0, so `until Counter >= Limit` is
 * monotonically false with no dependence on data, clock or I/O.
 */
const EXPECTED_ON: ReadonlyArray<{ line: number; operator: string; verdict: string }> = [
  { line: 32, operator: "lethal.empty-block", verdict: "killed" },
  // The advancing call, deleted: the loop can never progress.
  { line: 35, operator: "lethal.void-method-call", verdict: "timeout-killed" },
  { line: 36, operator: "lethal.conditional-boundary", verdict: "killed" },
  { line: 37, operator: "lethal.return-value", verdict: "killed" },
  // The advancing procedure's body, emptied: same property, different operator.
  { line: 41, operator: "lethal.empty-block", verdict: "timeout-killed" },
];

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

interface LegResult {
  readonly report: SessionReport;
  /** `test_results` rows for this run, so the gate can assert BC's own words, not just a verdict. */
  readonly testRows: ReadonlyArray<{
    mutant_code: string;
    outcome: string;
    duration_ms: number;
    failure_message: string | null;
  }>;
  readonly odataCfg: ActivationConfig;
  readonly quarantineDir: string;
}

async function runLeg(scratchRoot: string, stopHungSessions: boolean): Promise<LegResult> {
  const configFile = await readJson<LethalConfigFile>(
    CONFIG_LOCAL_PATH,
    "lethal.config.local.json",
  );
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc.exe/altool.exe under the AL Language extension install");
  }

  const outputDir = join(scratchRoot, stopHungSessions ? "publish-on" : "publish-off");
  await mkdir(outputDir, { recursive: true });
  const compiler = new ArtifactCompiler(
    { alcPath: toolPaths.alcPath, packageCachePath: bcdev.packageCachePath, outputDir },
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
      ...(bcdev.env !== undefined ? { env: bcdev.env } : {}),
      ...(stopHungSessions ? { stopHungSessions: true } : {}),
    },
    undefined,
    {
      compiler,
      deployer,
      verifier: new DeploymentVerifier(odataCfg),
      harnessVerifier,
    },
    (targetAppId, artifactId) => new RunMutantTransport(odataCfg, targetAppId, artifactId),
  );

  // A SCRATCH quarantine dir: the OFF leg quarantines BY DESIGN, and one landing in the real
  // ~/.lethal store would poison every later gate run on this container until an operator deleted
  // it by hand. Same reasoning as bcdev.itest.ts, load-bearing here rather than defensive.
  const quarantineDir = join(scratchRoot, stopHungSessions ? "quarantine-on" : "quarantine-off");
  const store = new ResultsStore(
    join(scratchRoot, `hang-${stopHungSessions ? "on" : "off"}.sqlite`),
  );
  try {
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, stopHungSessions ? "instr-on" : "instr-off"),
      selectorIds: SELECTOR_IDS,
      mutantTimeoutMs: BUDGET_MS,
      ...(stopHungSessions ? { stopHungSessions: true } : {}),
      lease: {
        client: new LeaseClient(odataCfg),
        serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
      },
      resourceServer: bcdev.server,
      resourceServerInstance: bcdev.serverInstance,
      quarantineDir,
    });
    const testRows = store.db
      .query(
        "SELECT mutant_code, outcome, duration_ms, failure_message FROM test_results ORDER BY id",
      )
      .all() as LegResult["testRows"];
    return { report, testRows, odataCfg, quarantineDir };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and the script hangs —
    // which would be a particularly poor failure mode for the hang gate.
    await backend.close();
  }
}

function dump(label: string, report: SessionReport): void {
  console.log(
    `  [${label}] killed=${report.counts.killed} timeoutKilled=${report.counts.timeoutKilled} survived=${report.counts.survived} errors=${report.counts.errors} baselineGreen=${report.baselineGreen}`,
  );
  for (const m of report.mutants) {
    const note = m.failureNote !== undefined ? ` note=${m.failureNote}` : "";
    console.log(`    ${m.mutantCode} ${m.verdict} ${m.file}:${m.line} ${m.operatorName}${note}`);
  }
}

function assertOnLeg(leg: LegResult): void {
  const { report, testRows } = leg;
  dump("stop-hung-sessions ON", report);

  assert.equal(report.baselineGreen, true, "baseline must be green (the fixture test passes)");
  assert.equal(report.mutants.length, EXPECTED_ON.length, "every mutant must be scored");
  assert.equal(report.counts.errors, 0, "no mutant may error when the stop path is available");

  for (const want of EXPECTED_ON) {
    const got = report.mutants.find(
      (m) => m.line === want.line && m.operatorName === want.operator,
    );
    assert.ok(got !== undefined, `no mutant at line ${want.line} for ${want.operator}`);
    assert.equal(
      got.verdict,
      want.verdict,
      `${want.operator} at line ${want.line}: expected ${want.verdict}, got ${got.verdict}`,
    );
  }

  const timeoutKilled = report.mutants.filter((m) => m.verdict === "timeout-killed");
  assert.equal(timeoutKilled.length, 2, "the fixture has exactly two non-terminating mutants");

  // THE ASSERTION THAT CANNOT PASS FOR THE WRONG REASON. A verdict check alone would still hold if
  // someone routed `deadline-exceeded` — our own abort, which says nothing about the server — into
  // a kill. Only BC's own words prove the session was ended by an AL StopSession call, which is
  // what makes the operation terminal and the mutant scoreable.
  for (const m of timeoutKilled) {
    const rows = testRows.filter((r) => r.mutant_code === m.mutantCode);
    assert.ok(rows.length > 0, `no test_results row for ${m.mutantCode}`);
    const stopped = rows.find((r) => r.outcome === "timeout");
    assert.ok(
      stopped !== undefined,
      `${m.mutantCode} is timeout-killed but no test row has outcome "timeout" — a kill was minted from something else`,
    );
    const msg = stopped.failure_message ?? "";
    assert.match(
      msg,
      /stopped the session/i,
      `${m.mutantCode}: the run's own record does not carry BC's stop confirmation — got ${JSON.stringify(msg.slice(0, 200))}`,
    );
    assert.match(
      msg,
      /StopSession/i,
      `${m.mutantCode}: BC's message does not attribute the stop to an AL StopSession call — a session that merely went away is not evidence`,
    );
    // Held open to the budget, then answered — not aborted at the hard cap.
    assert.ok(
      stopped.duration_ms >= BUDGET_MS && stopped.duration_ms < BUDGET_MS + STOP_GRACE_MS,
      `${m.mutantCode}: duration ${stopped.duration_ms}ms is outside [${BUDGET_MS}, ${BUDGET_MS + STOP_GRACE_MS}) — the request was not held to its budget and then stopped`,
    );
  }

  // Spec §5: the verdict is evidentially weaker than every other kill, and the report must say so.
  assert.ok(
    report.validity.caveats.includes("stop-hung-sessions"),
    `the report must carry the stop-hung-sessions caveat when it scored a timeout-killed; got ${JSON.stringify(report.validity.caveats)}`,
  );
  assert.equal(report.quarantined, undefined, "the ON leg must leave the tier unquarantined");
}

function assertOffLeg(leg: LegResult): void {
  const { report, testRows } = leg;
  dump("stop-hung-sessions OFF", report);

  // The failure R53 was filed for: the hang quarantines AND blocks everything behind it.
  assert.ok(
    report.mutants.length < EXPECTED_ON.length,
    `without the flag the run must NOT get through every mutant — got all ${report.mutants.length}`,
  );
  assert.equal(
    report.counts.timeoutKilled,
    0,
    "without the flag nothing may be scored timeout-killed — that verdict is only obtainable by stopping a session",
  );
  const errored = report.mutants.filter((m) => m.verdict === "error");
  assert.ok(errored.length > 0, "the hanging mutant must error");
  assert.ok(
    errored.some((m) => /could not be confirmed complete/i.test(m.failureNote ?? "")),
    "the error must say the operation could not be confirmed complete — that is what makes it a quarantine rather than a verdict",
  );
  // Pins that the OFF path produces our own abort, never the server-confirmed outcome.
  assert.ok(
    testRows.some((r) => r.outcome === "deadline-exceeded"),
    "the OFF leg's hanging run must record deadline-exceeded (our timer), not timeout (BC's stop)",
  );
  assert.ok(
    !testRows.some((r) => r.outcome === "timeout"),
    "no test row may carry outcome timeout without the flag",
  );
  assert.notEqual(
    report.quarantined,
    undefined,
    "the OFF leg must quarantine the tier — if it stops doing so, this leg has silently become a no-op",
  );
}

/**
 * The OFF leg strands an op marker on the server by design (design §8: the marker is a committed
 * table row and survives whatever happened to the session). Left in place it blocks every later
 * run on this container — including `itest:bcdev` and `itest:envtool`, which share it.
 *
 * Best-effort and LOUD on failure: a half-torn-down hang gate is worse than a failed one, because
 * the next gate's error will point at the lease and not at this script.
 */
async function teardown(odataCfg: ActivationConfig): Promise<void> {
  try {
    const harness = new HarnessVerifier(odataCfg);
    const generation = (await harness.verify()).serverGeneration;
    const outcome = await new LeaseClient(odataCfg).forceResetLease(generation);
    console.log(
      `  teardown: force-reset-lease ${outcome.reset ? "OK" : `REFUSED (${outcome.reason ?? "no reason"})`}`,
    );
  } catch (err) {
    console.error(
      [
        `  teardown FAILED: ${err instanceof Error ? err.message : String(err)}`,
        "  The OFF leg leaves a stranded op marker. Until it is cleared, every run against this",
        "  container will refuse with operation-orphaned — including itest:bcdev and itest:envtool.",
        "  Recover (design §8): restart the NST, then",
        "    bun packages/runner/src/cli.ts force-reset-lease --server <url> --instance BC --config fixtures/sandbox-hang/lethal.config.local.json",
      ].join("\n"),
    );
  }
}

async function main(): Promise<void> {
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-hang-itest-"));
  let odataCfg: ActivationConfig | undefined;
  try {
    // ON first: it leaves the tier clean, so a failure here is not confounded by the OFF leg's
    // deliberate quarantine.
    const on = await runLeg(scratchRoot, true);
    odataCfg = on.odataCfg;
    assertOnLeg(on);

    const off = await runLeg(scratchRoot, false);
    odataCfg = off.odataCfg;
    assertOffLeg(off);

    console.log("hang itest: PASS");
  } finally {
    if (odataCfg !== undefined) await teardown(odataCfg);
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

await main();
