#!/usr/bin/env bun
/**
 * R514 reuse probe: one probe, two runs, on the hang fixture. The method, the predictions and what
 * each result changes are pre-committed in
 * `docs/superpowers/specs/2026-10-08-r514-reuse-probe-precommitment.md`; this script checks each
 * prediction and prints PASS or FAIL. Evidence, not a gate: no baseline file, no receipt.
 * r3 (after run 1 BLOCKED on P4): P4 by a dispatch counter, M1/M2 from the first mutant-covered
 * row; see the amended pre-commitment `probe-precommitment-r3.md` (R-514 handoff).
 *
 *   LETHAL_R514_PROBE=1 bun scripts/r514-probe/probe.ts
 *
 * - Run 1 builds the backend as `hang.itest.ts`'s SINGLE leg does, and stops with a planned throw
 *   from `activate` for the SECOND mutant, before anything for it reaches BC.
 * - Run 2 resumes run 1 (`resume: "last"`) on a fresh backend, so its batch reuses run 1's baseline
 *   snapshot (R192). The fixture's five real hangs must stay `timeout-killed`, each with ONE
 *   unmutated confirm (I4), and the first covering runs after the deploy are measured (I1).
 *
 * The fixture config is read through the same loader the gate uses (`itestConfigPath`,
 * `validateBcDevConfig`). Nothing from it is printed. One scratch store and one scratch quarantine
 * dir serve both runs, and are deleted at the end. Take the Cronus28 lease (coord) yourself first.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itestConfigName, itestConfigPath } from "../../packages/runner/itest/config-path";
import type { ActivationConfig } from "../../packages/runner/src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../../packages/runner/src/artifact";
import { BcDevMcpBackend } from "../../packages/runner/src/bcdev-backend";
import { odataBaseUrl, validateBcDevConfig } from "../../packages/runner/src/cli";
import type { LethalConfigFile } from "../../packages/runner/src/cli";
import { DeploymentVerifier } from "../../packages/runner/src/deployment-verifier";
import type { EventSubscriber } from "../../packages/runner/src/events";
import { formatFailure } from "../../packages/runner/src/format-failure";
import { HarnessVerifier } from "../../packages/runner/src/harness";
import { LeaseClient } from "../../packages/runner/src/lease";
import { runSession } from "../../packages/runner/src/orchestrator";
import type { SessionConfig } from "../../packages/runner/src/orchestrator";
import {
  ContainerDeployer,
  defaultAlToolPaths,
  defaultDeployerIo,
} from "../../packages/runner/src/publisher";
import type { SessionReport } from "../../packages/runner/src/report";
import { RunMutantTransport } from "../../packages/runner/src/run-mutant-transport";
import { ResultsStore } from "../../packages/runner/src/store";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-hang");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-hang-tests");
/** As `hang.itest.ts`: inside sandbox-hang's idRanges. */
const SELECTOR_IDS = { selectorId: 79447, controlId: 79448, tableId: 79449 };
/** As `hang.itest.ts`'s `BUDGET_MS` and `STOP_GRACE_MS`. */
const BUDGET_MS = 20_000;
const STOP_GRACE_MS = 30_000;
const PLANNED_STOP = "R514 probe: planned stop before the second mutant";

/**
 * A COPY of `hang.itest.ts`'s `EXPECTED_ON` verdicts (that file runs its gate at import, so it
 * cannot be imported). P6 also checks the counts 24 / 9 / 5, so a copy that drifted from the gate's
 * table fails here rather than passing quietly.
 */
const EXPECTED: ReadonlyArray<readonly [line: number, operator: string, verdict: string]> = [
  [34, "lethal.empty-block", "killed"],
  [35, "lethal.remove-assignment", "survived"],
  [35, "lethal.shift-integer", "survived"],
  [37, "lethal.void-method-call", "timeout-killed"],
  [38, "lethal.conditional-boundary", "killed"],
  [38, "lethal.loop-truncate", "killed"],
  [39, "lethal.return-value", "killed"],
  [43, "lethal.empty-block", "timeout-killed"],
  [44, "lethal.remove-assignment", "timeout-killed"],
  [44, "lethal.shift-integer", "killed"],
  [62, "lethal.empty-block", "survived"],
  [63, "lethal.conditional-boundary", "killed"],
  [65, "lethal.return-value", "survived"],
  [69, "lethal.empty-block", "killed"],
  [70, "lethal.remove-assignment", "survived"],
  [70, "lethal.shift-integer", "killed"],
  [71, "lethal.remove-assignment", "survived"],
  [71, "lethal.shift-integer", "killed"],
  [73, "lethal.remove-assignment", "timeout-killed"],
  [73, "lethal.shift-integer", "killed"],
  [74, "lethal.loop-truncate", "survived"],
  [75, "lethal.return-value", "killed"],
  [101, "lethal.empty-block", "killed"],
  [102, "lethal.remove-assignment", "killed"],
  [103, "lethal.conditional-boundary", "killed"],
  [103, "lethal.loop-skip", "killed"],
  [105, "lethal.remove-assignment", "killed"],
  [105, "lethal.shift-integer", "killed"],
  [107, "lethal.return-value", "killed"],
  [140, "lethal.empty-block", "killed"],
  [141, "lethal.conditional-boundary", "killed"],
  [142, "lethal.return-value", "killed"],
  [143, "lethal.remove-assignment", "survived"],
  [143, "lethal.shift-integer", "survived"],
  [146, "lethal.loop-truncate", "killed"],
  [145, "lethal.void-method-call", "timeout-killed"],
  [146, "lethal.conditional-boundary", "killed"],
  [147, "lethal.return-value", "killed"],
];
/** P7: the five hangs. */
const HANGS: ReadonlyArray<readonly [number, string]> = [
  [37, "lethal.void-method-call"],
  [43, "lethal.empty-block"],
  [44, "lethal.remove-assignment"],
  [73, "lethal.remove-assignment"],
  [145, "lethal.void-method-call"],
];

/** Run 1's backend: refuses the second distinct mutant before calling the real `activate`. */
class StopBeforeSecondMutant extends BcDevMcpBackend {
  private firstMutant: string | undefined;
  override async activate(mutantId: string | null): Promise<void> {
    if (mutantId !== null) {
      if (this.firstMutant === undefined) this.firstMutant = mutantId;
      else if (mutantId !== this.firstMutant) throw new Error(PLANNED_STOP);
    }
    await super.activate(mutantId);
  }
}

/**
 * r3 P4: run 2's test dispatches in order, each the mutant id it carries (null = UNMUTATED).
 * `activate` on bcdev is bookkeeping only: it sets the pending mutant id that the NEXT `run` or
 * `runMany` sends (`pendingMutantId ?? ""`), and RunMutant clears after itself. So a dispatch is
 * unmutated iff the last `activate` argument was null (or there was none yet). An `activate(null)`
 * on its own (the baseline phase's deactivate, ClearActive at teardown) dispatches nothing and is
 * not logged; an R514 confirm is logged as null but comes after a mutated dispatch.
 */
const run2Dispatches: Array<string | null> = [];
class CountDispatches extends BcDevMcpBackend {
  private active: string | null = null;
  override async activate(mutantId: string | null): Promise<void> {
    this.active = mutantId;
    await super.activate(mutantId);
  }
  override run(...a: Parameters<BcDevMcpBackend["run"]>) {
    run2Dispatches.push(this.active);
    return super.run(...a);
  }
  override runMany(...a: Parameters<BcDevMcpBackend["runMany"]>) {
    run2Dispatches.push(this.active);
    return super.runMany(...a);
  }
}

interface Check {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
function check(id: string, pass: boolean, detail: string): boolean {
  checks.push({ id, pass, detail });
  console.log(`  ${id} ${pass ? "PASS" : "FAIL"}: ${detail}`);
  return pass;
}

async function makeBackend(scratch: string, label: string, Backend: typeof BcDevMcpBackend) {
  const raw = await readFile(itestConfigPath(PROJECT_DIR), "utf8").catch((err: unknown) => {
    throw new Error(
      `cannot read ${itestConfigName()} under fixtures/sandbox-hang: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const bcdev = validateBcDevConfig((JSON.parse(raw) as LethalConfigFile).bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc/altool under the AL Language extension install");
  }
  const outputDir = join(scratch, `publish-${label}`);
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
  const odataCfg: ActivationConfig = {
    baseUrl: odataBaseUrl(bcdev.server, bcdev.serverInstance),
    company: bcdev.company,
    username: bcdev.username,
    password: bcdev.password,
    ...(bcdev.tenant !== undefined ? { tenant: bcdev.tenant } : {}),
  };
  const harnessVerifier = new HarnessVerifier(odataCfg);
  const backend = new Backend(
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
      stopHungSessions: true,
    },
    undefined,
    { compiler, deployer, verifier: new DeploymentVerifier(odataCfg), harnessVerifier },
    (targetAppId, artifactId, controlState) =>
      new RunMutantTransport(odataCfg, targetAppId, artifactId, undefined, { controlState }),
  );
  const session = (scratchStore: ResultsStore, emit: EventSubscriber): SessionConfig => ({
    backend,
    store: scratchStore,
    projectDir: PROJECT_DIR,
    testDir: TEST_DIR,
    instrumentedDir: join(scratch, `instr-${label}`),
    selectorIds: SELECTOR_IDS,
    mutantTimeoutMs: BUDGET_MS,
    stopHungSessions: true,
    groupRuns: { enabled: false },
    lease: {
      client: new LeaseClient(odataCfg),
      serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
    },
    resourceServer: bcdev.server,
    resourceServerInstance: bcdev.serverInstance,
    quarantineDir: join(scratch, "quarantine"),
    emit: [emit],
  });
  return { backend, odataCfg, session };
}

interface Row {
  readonly id: number;
  readonly mutant_row_id: number | null;
  readonly mutant_code: string | null;
  readonly codeunit_name: string | null;
  readonly method: string;
  readonly outcome: string;
  readonly duration_ms: number;
  readonly failure_message: string | null;
}
const rowsOf = (store: ResultsStore, runId: number): Row[] =>
  store.db
    .query(
      "SELECT id, mutant_row_id, mutant_code, codeunit_name, method, outcome, duration_ms, failure_message FROM test_results WHERE run_id = ? ORDER BY id",
    )
    .all(runId) as Row[];
const lastRunId = (store: ResultsStore): number =>
  (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
const testKey = (r: Row) => `${r.codeunit_name ?? "?"}.${r.method}`;
function median(xs: readonly number[]): number | undefined {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return undefined;
  const mid = Math.floor(s.length / 2);
  const hi = s[mid];
  const lo = s[mid - 1];
  if (hi === undefined) return undefined;
  return s.length % 2 === 1 || lo === undefined ? hi : (lo + hi) / 2;
}

/** I1's bound: at most 2 000 ms predicted; above 5 000 ms is material (pre-committed). */
function firstCallVerdict(id: string, label: string, delta: number | undefined): void {
  if (delta === undefined) {
    check(id, false, `${label}: no steady-state rows to compare against`);
    return;
  }
  const band =
    delta <= 2_000
      ? "within the 2 000 ms prediction"
      : delta <= 5_000
        ? "prediction MISSED, not material (<= 5 000 ms): record it and file a re-measure item"
        : "MATERIAL (> 5 000 ms): add the warm-up before R514 closes";
  check(id, delta <= 2_000, `${label}: first minus median = ${delta} ms (${band})`);
}

function run2Checks(
  report: SessionReport,
  warnings: string[],
  rows: Row[],
  ctx: {
    readonly run1: number;
    readonly store: ResultsStore;
    readonly run2: number;
  },
): void {
  // P4 (r3): no unmutated dispatch before mutant 2's first covering run, by the dispatch log. Run
  // 2's NULL-mutant_row_id rows are R192's copies of run 1's baseline, not dispatches (run 1 BLOCK).
  const reuse = warnings.filter((w) => w.startsWith("resume-baseline-reused:"));
  const firstMutated = run2Dispatches.findIndex((d) => d !== null);
  const unmutatedBefore = (
    firstMutated === -1 ? run2Dispatches : run2Dispatches.slice(0, firstMutated)
  ).filter((d) => d === null).length;
  const unmutatedTotal = run2Dispatches.filter((d) => d === null).length;
  check(
    "P4",
    reuse.length === 1 &&
      reuse[0]?.includes(`run ${ctx.run1}'s batch 0`) === true &&
      firstMutated !== -1 &&
      unmutatedBefore === 0,
    `${reuse.length} resume-baseline-reused warning(s) (naming run ${ctx.run1}'s batch 0: ${reuse.some((w) => w.includes(`run ${ctx.run1}'s batch 0`))}); ${run2Dispatches.length} dispatch(es), first mutated at #${firstMutated + 1}${firstMutated === -1 ? " (NONE)" : ` (${run2Dispatches[firstMutated]})`}; ${unmutatedBefore} unmutated before it, ${unmutatedTotal} unmutated in all; ${rows.filter((r) => r.mutant_row_id === null).length} copied baseline row(s) (not dispatches)`,
  );
  // P5
  const carried = report.mutants.filter((m) => m.carried === true);
  check(
    "P5",
    report.mutants.length === EXPECTED.length &&
      carried.length === 1 &&
      carried[0]?.line === 34 &&
      carried[0]?.operatorName === "lethal.empty-block" &&
      report.baselineGreen === true &&
      report.counts.errors === 0 &&
      report.quarantined === undefined,
    `${report.mutants.length} mutants, ${carried.length} carried (${carried.map((m) => `${m.line} ${m.operatorName}`).join(", ")}), baselineGreen ${report.baselineGreen}, errors ${report.counts.errors}, quarantined ${report.quarantined === undefined ? "undefined" : "SET"}`,
  );
  // P6
  const wrong: string[] = [];
  for (const [line, op, want] of EXPECTED) {
    const got = report.mutants.find((m) => m.line === line && m.operatorName === op);
    if (got === undefined) wrong.push(`${line} ${op}: missing`);
    else if (got.verdict !== want) wrong.push(`${line} ${op}: ${got.verdict}, expected ${want}`);
    else if (
      (got.verdict === "killed" || got.verdict === "timeout-killed") &&
      got.killPosition !== 1
    ) {
      wrong.push(`${line} ${op}: killPosition ${got.killPosition}, expected 1`);
    }
  }
  const badCause = report.mutants.filter(
    (m) => m.cause === "reused-budget-stale" || m.cause === "unstable" || m.cause === "stranded",
  );
  const count = (v: string) => report.mutants.filter((m) => m.verdict === v).length;
  check(
    "P6",
    wrong.length === 0 &&
      badCause.length === 0 &&
      count("killed") === 24 &&
      count("survived") === 9 &&
      count("timeout-killed") === 5,
    `killed ${count("killed")}, survived ${count("survived")}, timeout-killed ${count("timeout-killed")}; ${wrong.length} per-mutant difference(s)${wrong.length > 0 ? ` [${wrong.join("; ")}]` : ""}; ${badCause.length} with cause reused-budget-stale/unstable/stranded${badCause.length > 0 ? ` [${badCause.map((m) => `${m.mutantCode} ${m.cause}`).join(", ")}]` : ""}`,
  );
  // P7
  const timeoutKilled = report.mutants.filter((m) => m.verdict === "timeout-killed");
  const hangSet = new Set(HANGS.map(([l, o]) => `${l} ${o}`));
  const p7: string[] = [];
  if (
    timeoutKilled.length !== HANGS.length ||
    !timeoutKilled.every((m) => hangSet.has(`${m.line} ${m.operatorName}`))
  ) {
    p7.push(
      `timeout-killed set is [${timeoutKilled.map((m) => `${m.line} ${m.operatorName}`).join(", ")}]`,
    );
  }
  let confirmTotal = 0;
  for (const m of timeoutKilled) {
    const rowId = (
      ctx.store.db
        .query("SELECT id FROM mutants WHERE run_id = ? AND mutant_code = ?")
        .get(ctx.run2, m.mutantCode) as { id: number } | null
    )?.id;
    const mine = rows.filter((r) => r.mutant_row_id === rowId);
    const stops = mine.filter((r) => r.mutant_code !== null && r.outcome === "timeout");
    const stop = stops[0];
    if (stops.length !== 1 || stop === undefined) {
      p7.push(`${m.mutantCode}: ${stops.length} covering timeout row(s)`);
      continue;
    }
    const msg = stop.failure_message ?? "";
    if (!/stopped the session/i.test(msg) || !/StopSession/i.test(msg)) {
      p7.push(`${m.mutantCode}: the timeout row lacks BC's stop wording`);
    }
    if (stop.duration_ms < BUDGET_MS || stop.duration_ms >= BUDGET_MS + STOP_GRACE_MS) {
      p7.push(`${m.mutantCode}: timeout row duration ${stop.duration_ms} ms`);
    }
    const confirms = mine.filter((r) => r.mutant_code === null);
    confirmTotal += confirms.length;
    const c = confirms[0];
    if (
      confirms.length !== 1 ||
      c === undefined ||
      c.method !== stop.method ||
      c.outcome !== "pass" ||
      c.duration_ms > BUDGET_MS / 2
    ) {
      p7.push(
        `${m.mutantCode}: unmutated confirm row(s) [${confirms.map((r) => `${r.method} ${r.outcome} ${r.duration_ms} ms`).join(", ")}]`,
      );
    } else {
      console.log(
        `    ${m.mutantCode} line ${m.line}: timeout ${stop.duration_ms} ms, confirm ${c.method} pass ${c.duration_ms} ms`,
      );
    }
  }
  check(
    "P7",
    p7.length === 0 && confirmTotal === HANGS.length,
    `${confirmTotal} timeout confirm row(s)${p7.length > 0 ? `; ${p7.join("; ")}` : ""}`,
  );
}

function measure(store: ResultsStore, run1: number, run2: number): void {
  const rows2 = rowsOf(store, run2);
  // r3: only rows with a non-null mutant_code are real calls in run 2; the rest are R192's copies
  // of run 1's baseline or confirms. Steady state = the same test's LATER such rows that pass.
  const covered = rows2.filter((r) => r.mutant_code !== null);
  const steady = (key: string, afterId: number) =>
    median(
      covered
        .filter((r) => r.id > afterId && testKey(r) === key && r.outcome === "pass")
        .map((r) => r.duration_ms),
    );
  const first = covered[0];
  if (first === undefined) {
    check("M1", false, "run 2 recorded no mutant-covered test_results row");
  } else {
    const med = steady(testKey(first), first.id);
    firstCallVerdict(
      "M1",
      `${testKey(first)} (${first.mutant_code}, ${first.outcome}, ${first.duration_ms} ms, median ${med ?? "?"} ms)`,
      med === undefined ? undefined : first.duration_ms - med,
    );
  }
  const seen = new Set<string>();
  for (const r of covered) {
    const key = testKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    const med = steady(key, r.id);
    if (med === undefined) {
      console.log(
        `  M2 SKIPPED: ${key} (first mutant-covered row ${r.mutant_code} ${r.outcome} ${r.duration_ms} ms): no later mutant-covered pass row`,
      );
      continue;
    }
    firstCallVerdict(
      "M2",
      `${key} (${r.mutant_code}, ${r.outcome}, ${r.duration_ms} ms, median ${med} ms)`,
      r.duration_ms - med,
    );
  }
  const uncovered = [...new Set(rows2.map(testKey))].filter((k) => !seen.has(k));
  if (uncovered.length > 0) {
    console.log(`  M2 SKIPPED (no mutant-covered row in run 2): ${uncovered.join(", ")}`);
  }
  const base1 = rowsOf(store, run1).find((r) => r.mutant_row_id === null);
  if (base1 !== undefined) {
    const med = steady(testKey(base1), -1);
    console.log(
      `  M3 (context only): run 1's first baseline row ${testKey(base1)} ${base1.duration_ms} ms, run-2 median ${med ?? "?"} ms, difference ${med === undefined ? "?" : base1.duration_ms - med} ms`,
    );
  }
}

async function teardown(odataCfg: ActivationConfig): Promise<void> {
  try {
    const generation = (await new HarnessVerifier(odataCfg).verify()).serverGeneration;
    const outcome = await new LeaseClient(odataCfg).forceResetLease(generation);
    console.log(
      `  teardown: force-reset-lease ${outcome.reset ? "OK" : `REFUSED (${outcome.reason ?? "no reason"})`}`,
    );
  } catch (err) {
    console.error(
      `  teardown FAILED: ${err instanceof Error ? err.message : String(err)}. Recover with lethal force-reset-lease against the fixture's container before releasing the Cronus28 lease.`,
    );
  }
}

async function main(): Promise<number> {
  console.log("R514 probe r3");
  if (process.env.LETHAL_R514_PROBE !== "1") {
    console.error(
      "refused: this probe drives a live BC container. Set LETHAL_R514_PROBE=1 under the Cronus28 lease (docs/superpowers/specs/2026-10-08-r514-reuse-probe-precommitment.md).",
    );
    return 2;
  }
  const scratch = await mkdtemp(join(tmpdir(), "lethal-r514-probe-"));
  const store = new ResultsStore(join(scratch, "probe.sqlite"));
  let odataCfg: ActivationConfig | undefined;
  try {
    // Run 1: stop before the second mutant.
    console.log("R514 probe, run 1 (stops before the second mutant)");
    const one = await makeBackend(scratch, "run1", StopBeforeSecondMutant);
    odataCfg = one.odataCfg;
    let rejection: unknown;
    try {
      await runSession(one.session(store, () => {}));
    } catch (err) {
      rejection = err;
    } finally {
      await one.backend.close();
    }
    const run1 = lastRunId(store);
    const p1 = check(
      "P1",
      rejection instanceof Error && rejection.message === PLANNED_STOP,
      rejection === undefined
        ? "the session did NOT reject"
        : `rejected with ${rejection instanceof Error ? `${rejection.name}: ${rejection.message}` : String(rejection)}`,
    );
    const mutants1 = store.db
      .query("SELECT line, operator_name, verdict FROM mutants WHERE run_id = ?")
      .all(run1) as Array<{ line: number; operator_name: string; verdict: string }>;
    const m1 = mutants1[0];
    const p2 = check(
      "P2",
      mutants1.length === 1 &&
        m1?.line === 34 &&
        m1.operator_name === "lethal.empty-block" &&
        m1.verdict === "killed",
      `run 1 mutant rows: [${mutants1.map((m) => `${m.line} ${m.operator_name} ${m.verdict}`).join(", ")}]`,
    );
    const snaps = store.db
      .query("SELECT batch_index FROM baseline_snapshots WHERE run_id = ?")
      .all(run1) as Array<{ batch_index: number }>;
    const suspects = (
      store.db.query("SELECT COUNT(*) AS n FROM suspect_snapshots").get() as { n: number }
    ).n;
    const p3 = check(
      "P3",
      snaps.length === 1 && snaps[0]?.batch_index === 0 && suspects === 0,
      `run 1 snapshots [${snaps.map((s) => s.batch_index).join(", ")}], suspect_snapshots ${suspects}`,
    );
    if (!(p1 && p2 && p3)) {
      console.log("R514 probe: VOID (P1 to P3 did not set up the resume). No run 2.");
      return 1;
    }

    // Run 2: resume with reuse.
    console.log("R514 probe, run 2 (resume, baseline reused)");
    const two = await makeBackend(scratch, "run2", CountDispatches);
    odataCfg = two.odataCfg;
    const warnings: string[] = [];
    let report: SessionReport;
    try {
      report = await runSession({
        ...two.session(store, (e) => {
          if (e.type === "warning") warnings.push(`${e.code}: ${e.message}`);
        }),
        resume: "last",
      });
    } finally {
      await two.backend.close();
    }
    const run2 = lastRunId(store);
    run2Checks(report, warnings, rowsOf(store, run2), { run1, store, run2 });
    measure(store, run1, run2);
    const failed = checks.filter((c) => !c.pass);
    console.log(
      failed.length === 0
        ? "R514 probe: PASS"
        : `R514 probe: ${failed.length} FAIL (${failed.map((c) => c.id).join(", ")}); read the pre-commitment's "What result changes the plan"`,
    );
    return failed.length === 0 ? 0 : 1;
  } finally {
    store.close();
    if (odataCfg !== undefined) await teardown(odataCfg);
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (err) {
    console.error(formatFailure(err));
    process.exit(1);
  }
}
