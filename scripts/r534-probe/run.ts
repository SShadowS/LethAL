/**
 * R534 evidence run (pre-commitment Part B,
 * docs/superpowers/specs/2026-10-09-r534-alrunner-precommitment.md). Throwaway, NOT a gate.
 * One al-runner session per leg over `scripts/r534-probe/app` + `tests` (no --only), local
 * al-runner only: no BC, no lease, reads NO config file. From the session mode of
 * /coord/handoff/R-534/probe/probe.ts; `app/` and `tests/` are byte-identical to the measured
 * /coord/handoff/R-534/session/.
 *
 * Usage, from the worktree root, foreground, bounded:
 *   timeout 2400 bun scripts/r534-probe/run.ts oneshot
 *   timeout 2400 bun scripts/r534-probe/run.ts server
 * Needs LETHAL_ALRUNNER_PATH. Logs every one-shot `--test` spawn with the active selector's mutant
 * id, every daemon start, every timeout row's message and reported stop, every warning; then checks
 * B1-B3 exactly as pre-committed and exits 1 on any miss.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AlRunnerBackend, defaultServerSpawn } from "../../packages/runner/src/al-runner-backend";
import { alRunnerCoverageSupport } from "../../packages/runner/src/al-runner-coverage";
import type { ServerSpawnFn } from "../../packages/runner/src/al-runner-server";
import type { RunEvent } from "../../packages/runner/src/events";
import { runSession } from "../../packages/runner/src/orchestrator";
import { type SpawnFn, defaultSpawn } from "../../packages/runner/src/publisher";
import type { SessionReport } from "../../packages/runner/src/report";
import { ResultsStore } from "../../packages/runner/src/store";

const leg = process.argv[2];
if (leg !== "oneshot" && leg !== "server") {
  console.error("usage: bun scripts/r534-probe/run.ts <oneshot|server>");
  process.exit(2);
}
const alRunnerPath = process.env.LETHAL_ALRUNNER_PATH;
if (alRunnerPath === undefined || alRunnerPath === "") {
  console.error("LETHAL_ALRUNNER_PATH is not set; refusing to start.");
  process.exit(2);
}

const PROJECT_DIR = join(import.meta.dir, "app");
const TEST_DIR = join(import.meta.dir, "tests");
// Inside the app's idRanges (79680-79689), as the measured session used.
const SELECTOR_IDS = { selectorId: 79687, controlId: 79688, tableId: 79689 };
const MUTANT_TIMEOUT_MS = 60_000;
/** Pre-committed B3: the reported stop N, in seconds, per leg. */
const N = leg === "oneshot" ? 60 : 120;
const HANG_TEST = "Codeunit79690.CountsToThree";
const ONRUN_MESSAGE = `The test codeunit's OnRun trigger exceeded the ${N}s timeout, so none of its test methods ran.`;

/** Pre-committed B2, keyed `<file stem>:<line> <operator>`. */
const B2: ReadonlyArray<readonly [string, string, string | null]> = [
  ["CountLogic:9 empty-block", "killed", null],
  ["CountLogic:10 remove-assignment", "survived", null],
  ["CountLogic:10 shift-integer", "survived", null],
  ["CountLogic:12 void-method-call", "timeout-killed", null],
  ["CountLogic:13 loop-truncate", "killed", null],
  ["CountLogic:13 conditional-boundary", "killed", null],
  ["CountLogic:14 return-value", "killed", null],
  ["CountLogic:18 empty-block", "timeout-killed", null],
  ["CountLogic:19 remove-assignment", "timeout-killed", null],
  ["CountLogic:19 shift-integer", "killed", null],
  ["ScopeLogic:5 empty-block", "killed", null],
  ["ScopeLogic:6 negate-guard", "error", "runner-refused"],
  ["ScopeLogic:7 return-value", "survived", null],
  ["ScopeLogic:8 return-value", "killed", null],
  ["ScopeLogic:8 flip-boolean-literal", "killed", null],
  ["AskLogic:5 empty-block", "error", "runner-test-error"],
  ["AskLogic:6 negate-guard", "error", "runner-test-error"],
  ["AskLogic:7 return-value", "survived", null],
  ["AskLogic:8 return-value", "survived", null],
  ["AskLogic:8 flip-boolean-literal", "survived", null],
];
const HANGS = [
  "CountLogic:12 void-method-call",
  "CountLogic:18 empty-block",
  "CountLogic:19 remove-assignment",
];
const ONE_SPAWN = [
  "ScopeLogic:6 negate-guard",
  "AskLogic:5 empty-block",
  "AskLogic:6 negate-guard",
];

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const scratch = await mkdtemp(join(tmpdir(), `r534-${leg}-`));
const instrumentedDir = join(scratch, "instrumented");
console.log(`R534 probe, leg ${leg}; scratch ${scratch}; al-runner ${alRunnerPath}`);

/** The active mutant id in the static selector the backend wrote, or "" when none is active. */
async function activeMutant(): Promise<string> {
  try {
    const al = await readFile(
      join(instrumentedDir, "active", "MutationSelector.Codeunit.al"),
      "utf8",
    );
    return /exit\(MutantId = '([^']+)'\);/.exec(al)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Every one-shot `--test` spawn, in order, with the mutant active at that moment. */
const spawns: { active: string; test: string }[] = [];
const loggingSpawn: SpawnFn = async (argv, opts) => {
  const t = argv.indexOf("--test");
  const test = t >= 0 ? argv[t + 1] : undefined;
  if (test !== undefined) {
    const active = await activeMutant();
    spawns.push({ active, test });
    console.log(`${at()} spawn #${spawns.length} active=${active || "<none>"} --test ${test}`);
  }
  return defaultSpawn(argv, opts);
};
let daemons = 0;
const loggingServerSpawn: ServerSpawnFn = (argv) => {
  daemons += 1;
  console.log(`${at()} daemon #${daemons}: ${argv.slice(1).join(" ")}`);
  return defaultServerSpawn(argv);
};

const support = await alRunnerCoverageSupport(PROJECT_DIR);
if (!support.supported) {
  console.error(
    `al-runner coverage is unsupported here (${support.multiObjectFiles.join(", ")}); the pre-commitment needs coverage al-runner. Refusing.`,
  );
  process.exit(1);
}

const store = new ResultsStore(join(scratch, "lethal.sqlite"));
const backend = new AlRunnerBackend(
  {
    alRunnerPath,
    instrumentedDir,
    testDir: TEST_DIR,
    selectorObjectId: SELECTOR_IDS.selectorId,
    coverage: "al-runner",
    ...(leg === "server" ? { serverMode: true } : {}),
  },
  loggingSpawn,
  loggingServerSpawn,
);
/** Every timeout verdict, with the mutant active when it was measured. */
const timeouts: { active: string; test: string; message: string; reportedStopMs?: number }[] = [];
const run = backend.run.bind(backend);
backend.run = async (ref, o) => {
  const v = await run(ref, o);
  if (v.outcome === "timeout") {
    const active = await activeMutant();
    const test = `Codeunit${ref.codeunitId}.${ref.method}`;
    timeouts.push({
      active,
      test,
      message: v.failureMessage ?? "",
      ...(v.reportedStopMs !== undefined ? { reportedStopMs: v.reportedStopMs } : {}),
    });
    console.log(
      `${at()} timeout row active=${active || "<none>"} ${test} reportedStopMs=${v.reportedStopMs ?? "-"} timeoutIn=${v.timeoutIn ?? "-"} message=${JSON.stringify(v.failureMessage)}`,
    );
  }
  return v;
};
const events: RunEvent[] = [];

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${what}`);
};
const blocks: string[] = [];

let report: SessionReport | undefined;
try {
  report = await runSession({
    backend,
    store,
    projectDir: PROJECT_DIR,
    testDir: TEST_DIR,
    instrumentedDir,
    selectorIds: SELECTOR_IDS,
    mutantTimeoutMs: MUTANT_TIMEOUT_MS,
    emit: [
      (e) => {
        events.push(e);
        if (e.type === "warning") console.log(`${at()} WARNING [${e.code}] ${e.message}`);
      },
    ],
  });
  console.log(`${at()} session completed`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`${at()} SESSION REJECTED: ${msg}`);
  blocks.push(`session abort: ${msg.slice(0, 300)}`);
} finally {
  store.close();
  await backend.close();
}

console.log("\nB1");
check(report !== undefined, "the session completes (no backend transport error ... spec §11)");
check(report?.baselineGreen === true, "the baseline is green");

if (report !== undefined) {
  await writeFile(join(scratch, "report.json"), JSON.stringify(report, null, 2));
  console.log(`report: ${join(scratch, "report.json")}`);
  const keyOf = (m: SessionReport["mutants"][number]) =>
    `${basename(m.file).replace(/\.Codeunit\.al$/, "")}:${m.line} ${m.operatorName.replace(/^lethal\./, "")}`;
  console.log("\nper mutant: batch/code key verdict cause killingTest killPosition");
  for (const m of report.mutants) {
    console.log(
      `  ${m.batchIndex}/${m.mutantCode} ${keyOf(m)} ${m.verdict} ${m.cause ?? "-"} ${m.killingTest ?? "-"} ${m.killPosition ?? "-"} note=${JSON.stringify((m.failureNote ?? "").slice(0, 160))}`,
    );
  }

  console.log("\nB2");
  check(
    report.mutants.every((m) => m.batchIndex === 0),
    "one batch (mutant ids are unambiguous in the spawn log)",
  );
  const byKey = new Map(report.mutants.map((m) => [keyOf(m), m]));
  check(
    report.mutants.length === B2.length && byKey.size === B2.length,
    `exactly ${B2.length} mutants, one per key (got ${report.mutants.length}, ${byKey.size} keys)`,
  );
  for (const [key, verdict, cause] of B2) {
    const m = byKey.get(key);
    check(
      m !== undefined && m.verdict === verdict && (m.cause ?? null) === cause,
      `${key}: ${verdict}${cause !== null ? ` ${cause}` : ""} (got ${m === undefined ? "<missing>" : `${m.verdict}${m.cause !== undefined ? ` ${m.cause}` : ""}`})`,
    );
  }
  const count = (pred: (m: SessionReport["mutants"][number]) => boolean) =>
    report?.mutants.filter(pred).length ?? 0;
  check(
    count((m) => m.verdict === "killed") === 8 &&
      count((m) => m.verdict === "timeout-killed") === 3 &&
      count((m) => m.verdict === "survived") === 6 &&
      count((m) => m.verdict === "error") === 3 &&
      count((m) => m.cause === "runner-refused") === 1 &&
      count((m) => m.cause === "runner-test-error") === 2 &&
      count((m) => m.verdict === "no-coverage") === 0 &&
      count((m) => m.cause === "timeout-unconfirmed") === 0,
    "totals: killed 8, timeout-killed 3, survived 6, error 3 (runner-refused 1, runner-test-error 2), no-coverage 0, timeout-unconfirmed 0",
  );

  console.log("\nB3");
  for (const key of HANGS) {
    const m = byKey.get(key);
    if (m === undefined) {
      check(false, `${key}: present`);
      continue;
    }
    check(
      m.killingTest === "CountsToThree" && m.killPosition === 1,
      `${key}: killingTest CountsToThree, killPosition 1 (got ${m.killingTest ?? "-"}, ${m.killPosition ?? "-"})`,
    );
    check(
      m.killingTestFailure === ONRUN_MESSAGE,
      `${key}: the mutated row's message is exactly "${ONRUN_MESSAGE}" (got ${JSON.stringify(m.killingTestFailure)})`,
    );
    const rows = timeouts.filter((t) => t.active === m.mutantCode && t.test === HANG_TEST);
    check(
      rows.length > 0 && rows.every((t) => t.reportedStopMs === N * 1000),
      `${key}: reportedStopMs = ${N * 1000} (got ${rows.map((t) => t.reportedStopMs ?? "-").join(", ") || "<no timeout row>"})`,
    );
    if (leg === "oneshot") {
      const idx = spawns.flatMap((s, i) => (s.active === m.mutantCode ? [i] : []));
      const first = idx[0];
      const next = first === undefined ? undefined : spawns[first + 1];
      check(
        idx.length === 1 && spawns[first ?? -1]?.test === HANG_TEST,
        `${key}: exactly ONE spawn with ${m.mutantCode} active, of ${HANG_TEST} (got ${idx.map((i) => spawns[i]?.test).join(", ") || "none"})`,
      );
      check(
        next !== undefined && next.active === "" && next.test === HANG_TEST,
        `${key}: the next spawn is the confirm, ${HANG_TEST} with NO mutant active (got ${next === undefined ? "none" : `${next.active || "<none>"} ${next.test}`})`,
      );
    }
  }
  if (leg === "oneshot") {
    for (const key of ONE_SPAWN) {
      const m = byKey.get(key);
      const n = m === undefined ? 0 : spawns.filter((s) => s.active === m.mutantCode).length;
      check(n === 1, `${key}: exactly ONE spawn with the mutant active, no retry (got ${n})`);
    }
  }
  const scope6 = byKey.get("ScopeLogic:6 negate-guard");
  check(
    scope6?.failureNote?.startsWith(
      "RunnerOutOfScopeException: out-of-scope: TaskScheduler.TaskExists",
    ) === true,
    "ScopeLogic:6's note starts with the refusal row's own message",
  );
  for (const key of ["AskLogic:5 empty-block", "AskLogic:6 negate-guard"]) {
    check(
      byKey
        .get(key)
        ?.failureNote?.includes("The following UI handlers were not executed: ConfirmYes") === true,
      `${key}'s note carries the unexecuted-handler message`,
    );
  }
  const wording = events.filter(
    (e) => e.type === "warning" && e.code === "alrunner-timeout-wording-unrecognised",
  );
  check(
    wording.length === 0,
    `no alrunner-timeout-wording-unrecognised warning (got ${wording.length})`,
  );

  // The outcomes that are a BLOCK on the build, not only a miss.
  for (const key of HANGS) {
    const m = byKey.get(key);
    if (m !== undefined && m.verdict !== "timeout-killed") {
      blocks.push(`hang mutant ${key} scored ${m.verdict}`);
    }
  }
  for (const m of report.mutants) {
    const text = m.killingTestFailure ?? "";
    if (m.verdict === "killed" && (text.includes("out-of-scope") || text.includes("UI handlers"))) {
      blocks.push(`${keyOf(m)} scored killed on ${JSON.stringify(text.slice(0, 120))}`);
    }
  }
}

console.log(`\none-shot --test spawns: ${spawns.length}; daemons started: ${daemons}`);
for (const b of blocks) console.log(`BLOCK: ${b}`);
console.log(
  failures === 0 && blocks.length === 0
    ? `\nPart B leg ${leg}: MATCHES the pre-commitment`
    : `\nPart B leg ${leg}: MISS (${failures} failed check(s), ${blocks.length} block(s))`,
);
process.exit(failures === 0 && blocks.length === 0 ? 0 : 1);
