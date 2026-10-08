/**
 * R518 evidence run (pre-commitment Part B, docs/superpowers/specs/2026-10-08-r518-alrunner-precommitment.md).
 * Throwaway, NOT a gate. One al-runner ONE-SHOT session over `fixtures/sandbox-hang`, static selector,
 * as one `itest:alrunner` one-shot leg does it. Reads NO config file; al-runner is local, no BC.
 *
 * Usage, from the worktree root, foreground, bounded:
 *   timeout 1800 bun scripts/r518-probe/run.ts
 * Needs LETHAL_ALRUNNER_PATH. Prints the per-mutant table, every `timeout` test row with its
 * reported stop, the spawn counts, and the five pre-committed hang checks; writes the report JSON
 * into its scratch dir. Exits 1 when a pre-committed check fails.
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlRunnerBackend,
  RUNNER_TIMEOUT_MESSAGE,
  parseReportedStopMs,
} from "../../packages/runner/src/al-runner-backend";
import { alRunnerCoverageSupport } from "../../packages/runner/src/al-runner-coverage";
import { runSession } from "../../packages/runner/src/orchestrator";
import { type SpawnFn, defaultSpawn } from "../../packages/runner/src/publisher";
import { ResultsStore } from "../../packages/runner/src/store";

const alRunnerPath = process.env.LETHAL_ALRUNNER_PATH;
if (alRunnerPath === undefined || alRunnerPath === "") {
  console.error("LETHAL_ALRUNNER_PATH is not set; refusing to start.");
  process.exit(2);
}

const root = join(import.meta.dir, "..", "..");
const PROJECT_DIR = join(root, "fixtures", "sandbox-hang");
const TEST_DIR = join(root, "fixtures", "sandbox-hang-tests");
// hang.itest.ts's SELECTOR_IDS, inside sandbox-hang's idRanges (79400-79449).
const SELECTOR_IDS = { selectorId: 79447, controlId: 79448, tableId: 79449 };
const BUDGET_MS = 20_000;

/** Pre-committed: the five structural hangs (lines of HangLogic.Codeunit.al). */
const HANGS: ReadonlyArray<{ line: number; operator: string }> = [
  { line: 37, operator: "lethal.void-method-call" },
  { line: 43, operator: "lethal.empty-block" },
  { line: 44, operator: "lethal.remove-assignment" },
  { line: 73, operator: "lethal.remove-assignment" },
  { line: 145, operator: "lethal.void-method-call" },
];

const scratch = await mkdtemp(join(tmpdir(), "r518-"));
const instrumentedDir = join(scratch, "instrumented");
const activeDir = join(instrumentedDir, "active");
console.log(`scratch: ${scratch}`);
console.log(`al-runner: ${alRunnerPath}`);

/** The active mutant id in the static selector the backend wrote, or "" when none is active. */
async function activeMutant(): Promise<string> {
  let files: string[];
  try {
    files = (await readdir(activeDir, { recursive: true })).map(String);
  } catch {
    return "";
  }
  for (const f of files.filter((x) => x.endsWith(".al"))) {
    const m = /exit\(MutantId = '([^']+)'\);/.exec(await readFile(join(activeDir, f), "utf8"));
    if (m?.[1] !== undefined) return m[1];
  }
  return "";
}

/** Every `--test` spawn, in order, with the mutant active at that moment. */
const spawns: { active: string; test: string }[] = [];
const countingSpawn: SpawnFn = async (argv, opts) => {
  const t = argv.indexOf("--test");
  const test = t >= 0 ? argv[t + 1] : undefined;
  if (test !== undefined) spawns.push({ active: await activeMutant(), test });
  return defaultSpawn(argv, opts);
};

const support = await alRunnerCoverageSupport(PROJECT_DIR);
const coverage = support.supported ? "al-runner" : "none";
console.log(
  `coverage: ${coverage}${support.supported ? "" : ` (unsupported: ${support.multiObjectFiles.join(", ")})`}`,
);

const store = new ResultsStore(join(scratch, "lethal.sqlite"));
const backend = new AlRunnerBackend(
  {
    alRunnerPath,
    instrumentedDir,
    testDir: TEST_DIR,
    selectorObjectId: SELECTOR_IDS.selectorId,
    coverage,
  },
  countingSpawn,
);
const t0 = Date.now();
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${what}`);
};
try {
  const report = await runSession({
    backend,
    store,
    projectDir: PROJECT_DIR,
    testDir: TEST_DIR,
    instrumentedDir,
    selectorIds: SELECTOR_IDS,
    mutantTimeoutMs: BUDGET_MS,
  });
  console.log(`session completed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const out = join(scratch, "report.json");
  await writeFile(out, JSON.stringify(report, null, 2));
  console.log(`report: ${out}`);

  console.log("\nper mutant: batch/code line operator verdict killPosition killingTest cause");
  for (const m of report.mutants) {
    console.log(
      `  ${m.batchIndex}/${m.mutantCode} ${m.line} ${m.operatorName} ${m.verdict} ${m.killPosition ?? "-"} ${m.killingTest ?? "-"} ${m.cause ?? "-"}`,
    );
  }

  const rows = store.db
    .query(
      "SELECT mutant_code, method, outcome, duration_ms, failure_message FROM test_results ORDER BY id",
    )
    .all() as {
    mutant_code: string | null;
    method: string;
    outcome: string;
    duration_ms: number;
    failure_message: string | null;
  }[];
  const timeouts = rows.filter((r) => r.outcome === "timeout");
  console.log("\ntest rows with outcome timeout: mutant method duration_ms reportedStopMs message");
  for (const r of timeouts) {
    console.log(
      `  ${r.mutant_code ?? "<baseline>"} ${r.method} ${r.duration_ms} ${parseReportedStopMs(r.failure_message ?? undefined) ?? "-"} ${JSON.stringify(r.failure_message)}`,
    );
  }

  const counts = new Map<string, number>();
  for (const s of spawns) {
    const k = `${s.active || "<none>"} ${s.test}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  console.log(`\nspawns: ${spawns.length} in all; per active mutant and --test:`);
  for (const [k, n] of [...counts].sort()) console.log(`  ${n} ${k}`);
  /** A cold confirm: an unmutated spawn of the same test right after a mutated one. */
  const confirms = spawns.filter((s, i) => {
    const prev = spawns[i - 1];
    return s.active === "" && prev !== undefined && prev.active !== "" && prev.test === s.test;
  }).length;
  console.log(`unmutated spawns right after a mutated spawn of the same test: ${confirms}`);

  console.log("\npre-committed: the five structural hangs");
  for (const h of HANGS) {
    const m = report.mutants.find((x) => x.line === h.line && x.operatorName === h.operator);
    const label = `line ${h.line} ${h.operator}`;
    if (m === undefined) {
      check(false, `${label}: no such mutant`);
      continue;
    }
    check(m.verdict === "timeout-killed", `${label}: verdict ${m.verdict}`);
    check(m.killPosition === 1, `${label}: killPosition ${m.killPosition ?? "-"}`);
    // `killingTest` is `<codeunit name>.<method>`; al-runner's `--test` is `Codeunit<id>.<method>`.
    const method = m.killingTest?.slice(m.killingTest.lastIndexOf(".") + 1);
    const test = spawns.find((s) => method !== undefined && s.test.endsWith(`.${method}`))?.test;
    const row = timeouts.find((r) => r.mutant_code === m.mutantCode && r.method === method);
    const msg = row?.failure_message ?? undefined;
    const stop = parseReportedStopMs(msg);
    check(
      msg !== undefined &&
        RUNNER_TIMEOUT_MESSAGE.test(msg) &&
        stop !== undefined &&
        stop >= BUDGET_MS,
      `${label}: timeout row ${JSON.stringify(msg)} reportedStopMs ${stop ?? "-"} >= ${BUDGET_MS}`,
    );
    const mutated = spawns.flatMap((s, i) =>
      s.active === m.mutantCode && s.test === test ? [i] : [],
    );
    check(mutated.length === 1, `${label}: mutated spawns of ${test}: ${mutated.length}`);
    const [at] = mutated;
    const next = at === undefined ? undefined : spawns[at + 1];
    const confirmsOf = spawns.filter(
      (s, i) => i > (at ?? spawns.length) && s.active === "" && s.test === test,
    ).length;
    check(
      next?.active === "" && next.test === test,
      `${label}: the next spawn is one unmutated confirm of ${test} (unmutated spawns of it after: ${confirmsOf})`,
    );
  }

  console.log("\npre-committed: the session");
  check(report.baselineGreen, `baselineGreen ${report.baselineGreen}`);
  check(report.groupedCalls === 0, `groupedCalls ${report.groupedCalls ?? "-"}`);
  check(report.warmKills === 0, `warmKills ${report.warmKills ?? "-"}`);
  const tk = report.mutants.filter((m) => m.verdict === "timeout-killed").length;
  check(tk === 5, `timeout-killed ${tk}`);
  const tu = report.mutants.filter((m) => m.cause === "timeout-unconfirmed").length;
  check(tu === 0, `timeout-unconfirmed ${tu}`);
  check(confirms === 5, `cold confirms ${confirms}`);
  const errors = report.mutants.filter((m) => m.verdict === "error");
  console.log(`\nerror verdicts (observations, named): ${errors.length}`);
  for (const m of errors) {
    console.log(
      `  ${m.mutantCode} line ${m.line} ${m.operatorName} ${m.cause ?? "-"} ${m.failureNote ?? ""}`,
    );
  }
} catch (err) {
  failures++;
  console.log(`SESSION REJECTED: ${err instanceof Error ? err.message : String(err)}`);
  const counts = new Map<string, number>();
  for (const s of spawns) {
    const k = `${s.active || "<none>"} ${s.test}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...counts].sort()) console.log(`  ${n} ${k}`);
} finally {
  store.close();
  await backend.close();
}
console.log(
  `\n${failures === 0 ? "ALL PRE-COMMITTED CHECKS PASS" : `${failures} PRE-COMMITTED CHECK(S) FAILED`}`,
);
process.exit(failures === 0 ? 0 : 1);
