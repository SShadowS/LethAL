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
const EXPECTED_ON: ReadonlyArray<{
  line: number;
  operator: string;
  verdict: string;
  /** R206: pinned where the design pre-committed it; every kill is checked to carry ONE. */
  killPosition?: number;
}> = [
  // --- `CountUpTo` / `Advance`, the original R53 arm. R164 shifted every line down two, because
  // --- its arm added two `var` declarations at the top of the codeunit.
  { line: 34, operator: "lethal.empty-block", verdict: "killed" },
  { line: 35, operator: "lethal.remove-assignment", verdict: "survived" },
  { line: 35, operator: "lethal.shift-integer", verdict: "survived" },
  // The advancing call, deleted: the loop can never progress.
  { line: 37, operator: "lethal.void-method-call", verdict: "timeout-killed" },
  // THE CESSION CONTROL. R164 cedes a `repeat` exit condition from `negate-conditional` to
  // `loop-truncate`, and only from that operator. `conditional-boundary` still claims this same
  // span, it still terminates, and it is still killed. A cession that was too broad would delete
  // this row, which is an operator-NAME change the per-mutant table catches and a total would not.
  { line: 38, operator: "lethal.conditional-boundary", verdict: "killed" },
  // R164: `until Counter >= Limit` -> `until true`. `CountUpTo(3)` advances once and returns 1
  // against a test expecting 3, so this is `loop-truncate`'s killability proof and it needed no new
  // fixture code at all.
  { line: 38, operator: "lethal.loop-truncate", verdict: "killed" },
  { line: 39, operator: "lethal.return-value", verdict: "killed" },
  // The advancing procedure's body, emptied: same property, different operator.
  { line: 43, operator: "lethal.empty-block", verdict: "timeout-killed" },
  // R159's `remove-assignment` adds both of these, and they are a matched pair worth reading
  // together. Deleting `Counter := 0` changes nothing, a codeunit `Integer` global is 0 on a fresh
  // instance, so it is an equivalent mutant by inspection. Deleting `Counter += 1` removes the
  // loop's only progress and is non-terminating, reached by a third operator.
  { line: 44, operator: "lethal.remove-assignment", verdict: "timeout-killed" },
  { line: 44, operator: "lethal.shift-integer", verdict: "killed" },

  // --- `NextRow` / `WalkOneRow`, R164's arm. It reproduces BC's `Rec.Next()` CONTRACT with no
  // --- table behind it, so the canonical hang is deterministic rather than data-dependent.
  { line: 62, operator: "lethal.empty-block", verdict: "survived" },
  { line: 63, operator: "lethal.conditional-boundary", verdict: "killed" },
  // `exit(1)` is only reached while rows remain, and a ONE-row walk never reaches it. Covered but
  // unreached, which is a survivor rather than no-coverage: the procedure itself did execute.
  { line: 65, operator: "lethal.return-value", verdict: "survived" },
  { line: 69, operator: "lethal.empty-block", verdict: "killed" },
  { line: 70, operator: "lethal.remove-assignment", verdict: "survived" },
  { line: 70, operator: "lethal.shift-integer", verdict: "killed" },
  { line: 71, operator: "lethal.remove-assignment", verdict: "survived" },
  { line: 71, operator: "lethal.shift-integer", verdict: "killed" },
  // The arm's SECOND non-terminating mutant, and it is not the exit condition's. Deleting
  // `Walked += 1` removes the loop's only progress, which is why R164's cession does not remove it:
  // any loop whose progress is arithmetic can be stranded by an operator that touches that
  // arithmetic, and no cession at the exit condition can help.
  { line: 73, operator: "lethal.remove-assignment", verdict: "timeout-killed" },
  { line: 73, operator: "lethal.shift-integer", verdict: "killed" },
  // THE ROW R164 EXISTS FOR. Before the cession this span carried TWO mutants: this one, and a
  // `lethal.negate-conditional` scored `timeout-killed` (MEASURED, stage 1 of
  // docs/superpowers/specs/2026-08-26-r164-loop-truncate-precommitment.md). After it, exactly one,
  // and it cannot hang. `loop-truncate` SURVIVES here, honestly: truncating a one-iteration loop to
  // one iteration changes nothing, which is the operator's documented equivalence limit seen from
  // the inside. A SECOND mutant appearing at this line is the regression to look for.
  { line: 74, operator: "lethal.loop-truncate", verdict: "survived" },
  { line: 75, operator: "lethal.return-value", verdict: "killed" },

  // --- `DrainQueue`, R179's arm: a `while` loop whose BODY advances its own condition, which every
  // --- terminating `while` loop does by construction.
  { line: 101, operator: "lethal.empty-block", verdict: "killed" },
  { line: 102, operator: "lethal.remove-assignment", verdict: "killed" },
  // THE CONTROL for R173. `>` -> `>=` is that row's hazardous shape, and here it TERMINATES:
  // `Pending` reaches 0, takes one extra lap and returns 4. R173's 7 hazardous sites are all
  // `StrPos(...) > 0`, where the value cannot go below 0. Same syntax, opposite outcome, which is
  // why R173 must not cede on syntax alone.
  { line: 103, operator: "lethal.conditional-boundary", verdict: "killed" },
  // THE ROW R179 EXISTS FOR. Before the cession this span's `while` BODY also carried a
  // `lethal.empty-block` mutant scored `timeout-killed` (MEASURED, stage 1 of
  // docs/superpowers/specs/2026-08-27-r179-loop-skip-precommitment.md). `empty-block` now cedes a
  // `while` body, and `loop-skip` asks the same question in a way that cannot hang. A SECOND mutant
  // appearing at line 103's body is the regression to look for.
  { line: 103, operator: "lethal.loop-skip", verdict: "killed" },
  // Killed by ARITHMETIC OVERFLOW, not by the budget, and worth knowing. Deleting `Pending -= 1`
  // freezes the condition exactly as emptying the body does, but the surviving `Drained += 1` keeps
  // accumulating and overflows Int32 in ~4.4 s ("Arithmetic operation resulted in an overflow").
  // A frozen loop only STRANDS when nothing in it accumulates, which is why `empty-block` (whole
  // body gone) hangs and this does not. Predicted `timeout-killed` and measured `killed`: the one
  // miss in that pre-commitment, and its cause is measured rather than reasoned.
  { line: 104, operator: "lethal.remove-assignment", verdict: "killed" },
  { line: 104, operator: "lethal.shift-integer", verdict: "killed" },
  { line: 105, operator: "lethal.remove-assignment", verdict: "killed" },
  { line: 105, operator: "lethal.shift-integer", verdict: "killed" },
  { line: 107, operator: "lethal.return-value", verdict: "killed" },

  // --- `SpinUntil`, R206's arm: the only live exercise of a WARM timeout and of the warm
  // --- confirmation's replay. Two tests cover it; `SpinUntilAtZeroExitsEarly` (T1) takes the
  // --- early exit and asserts -1, `SpinUntilReachesTheTarget` (T2) drives the same unbounded
  // --- loop as `CountUpTo`. T1 sorts first (fewer members, then the ledger, seeded by the
  // --- guard-line kills below, which are scored first in manifest order), so every loop kill is
  // --- T2's at group position 2 and is confirmed by replaying [T1, T2] unmutated. Every
  // --- position was PRE-COMMITTED from the dry-run manifest in
  // --- docs/superpowers/specs/2026-09-03-r206-build-precommitment.md before this gate ran.
  { line: 140, operator: "lethal.empty-block", verdict: "killed", killPosition: 1 },
  { line: 141, operator: "lethal.conditional-boundary", verdict: "killed", killPosition: 1 },
  { line: 142, operator: "lethal.return-value", verdict: "killed", killPosition: 1 },
  { line: 143, operator: "lethal.remove-assignment", verdict: "survived" },
  { line: 143, operator: "lethal.shift-integer", verdict: "survived" },
  { line: 146, operator: "lethal.loop-truncate", verdict: "killed", killPosition: 2 },
  // THE ROW R206's ARM EXISTS FOR: the fifth non-terminating mutant, and the only one whose hang
  // lands at group position 2, so it is scored `timeout-killed` only after methods 1..2 were
  // replayed unmutated and method 2 completed inside its budget.
  { line: 145, operator: "lethal.void-method-call", verdict: "timeout-killed", killPosition: 2 },
  { line: 146, operator: "lethal.conditional-boundary", verdict: "killed", killPosition: 2 },
  { line: 147, operator: "lethal.return-value", verdict: "killed", killPosition: 2 },
];

/** R206: the warm kills of the ON leg, all in the new arm: three warm fails and one warm timeout. */
const EXPECTED_WARM_KILLS = 4;

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
    readonly op_kind: string | null;
    mutant_code: string;
    outcome: string;
    duration_ms: number;
    failure_message: string | null;
  }>;
  readonly odataCfg: ActivationConfig;
  readonly quarantineDir: string;
  /** R206: `ResultsStore.sessionIdLiveness` for this run, read before the store closes. */
  readonly sessionLiveness: ReturnType<ResultsStore["sessionIdLiveness"]>;
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
        "SELECT mutant_code, outcome, duration_ms, failure_message, op_kind FROM test_results ORDER BY id",
      )
      .all() as LegResult["testRows"];
    const runId = (store.db.query("SELECT MAX(id) AS id FROM runs").get() as { id: number }).id;
    const sessionLiveness = store.sessionIdLiveness(runId);
    return { report, testRows, odataCfg, quarantineDir, sessionLiveness };
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
    // R206: every kill carries a position, and the pinned ones carry the pre-committed number.
    // A kill at position > 1 is a WARM kill, confirmed by a replay; a `killPosition` that moved
    // means the kill ledger ordered the arm's tests differently from the design's argument.
    if (got.verdict === "killed" || got.verdict === "timeout-killed") {
      assert.ok(
        got.killPosition !== undefined,
        `${want.operator} at line ${want.line}: a kill without killPosition (R206 records one on every kill)`,
      );
      assert.equal(
        got.killPosition,
        want.killPosition ?? 1,
        `${want.operator} at line ${want.line}: killPosition ${got.killPosition}, expected ${want.killPosition ?? 1}`,
      );
    }
  }

  const timeoutKilled = report.mutants.filter((m) => m.verdict === "timeout-killed");
  assert.equal(
    timeoutKilled.length,
    5,
    "the fixture has exactly FIVE non-terminating mutants, and each is reached by a DIFFERENT " +
      "operator or arm: void-method-call and empty-block on the original arm, remove-assignment " +
      "twice (R159), once on each of R164's and the original arm, and R206's `void-method-call` on " +
      "`SpinUntil`'s advancing call (line 145), the ONE the new arm adds, which shares `Advance()` " +
      "rather than copying it precisely so it adds one and not three. R179's arm did NOT change " +
      "this number: it added a hang (`empty-block` on a `while` body, MEASURED `timeout-killed` in " +
      "stage 1) and the cession to `loop-skip` removed it again. None of the five is a loop EXIT " +
      "CONDITION, and that is the point of the count: R164 ceded the exit condition from " +
      "`negate-conditional` to `loop-truncate`, which cannot hang, and `shift-integer` refuses that " +
      "position outright. A SIXTH non-terminating mutant means one of those two cessions has " +
      "stopped holding, or that the arm stopped sharing `Advance()`",
  );
  assert.ok(
    timeoutKilled.some((m) => m.line === 145 && m.operatorName === "lethal.void-method-call"),
    "the fifth hang must be R206's arm at line 145, not some other mutant that started hanging",
  );

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

  // R198: the ON leg's kills are now scored through RunMutantMany + StopHungRunAt + the 408, one
  // call per mutant that reached the covering loop (no chunking on a container; a kill stops at
  // its first failure). Pinned as the arithmetic of the counts rather than a bare "> 0", and the
  // timeout rows themselves must carry the grouped op kind, so the stop cannot have been scored
  // through the single-method path this gate used to pin.
  // R206: a warm kill adds ONE replay call, so the pin is `scored + warmKills` with `warmKills`
  // a NUMBER, never read back from the report (a `warmKills` that was never wired reads 0 and
  // would make `scored + 0` pass on a build that replays nothing).
  assert.equal(
    report.warmKills,
    EXPECTED_WARM_KILLS,
    `R206: expected ${EXPECTED_WARM_KILLS} warm kills (the new arm's four loop kills at position 2); got warmKills=${report.warmKills}`,
  );
  assert.equal(
    report.groupedCalls,
    report.counts.killed +
      report.counts.survived +
      report.counts.timeoutKilled +
      EXPECTED_WARM_KILLS,
    `R198/R206: expected one RunMutantMany call per scored mutant plus one replay per warm kill; got groupedCalls=${report.groupedCalls}`,
  );
  assert.ok(
    report.validity.caveats.includes("session-warm"),
    `a report with grouped calls must carry the session-warm caveat; got ${JSON.stringify(report.validity.caveats)}`,
  );
  // R206 §2.1: the session guard fired on nothing (the container hands every request a fresh
  // session), and the session ids are LIVE data: every answered row carries one, the grouped
  // rows' distinct ids equal the group calls that ANSWERED (the five 408s carry none), and every
  // single-call row is its own session. Scoped, not softened: this is the anti-inertness control
  // for `sessionId` now that the guard's predicate is `testRunsBefore`.
  assert.equal(
    report.mutants.filter((m) => m.cause === "session-reused").length,
    0,
    "no mutant may be refused as session-reused on a container that hands every request a fresh session",
  );
  const live = leg.sessionLiveness;
  assert.equal(
    live.missing,
    0,
    `every pass/fail row must carry a session id; ${live.missing} do not`,
  );
  assert.ok(live.answered > 0, "the store must hold answered rows to check");
  assert.equal(
    live.manyDistinct,
    (report.groupedCalls ?? 0) - timeoutKilled.length,
    `distinct session ids among grouped pass/fail rows must equal the group calls that answered (groupedCalls ${report.groupedCalls} minus ${timeoutKilled.length} stopped calls); got ${live.manyDistinct}`,
  );
  assert.equal(
    live.singleRows,
    live.singleDistinct,
    `every single-call row must be its own session; ${live.singleRows} rows carry ${live.singleDistinct} distinct ids`,
  );
  for (const m of timeoutKilled) {
    const stopped = testRows.find((r) => r.mutant_code === m.mutantCode && r.outcome === "timeout");
    assert.equal(
      stopped?.op_kind,
      "many",
      `${m.mutantCode}'s timeout row must come from a grouped call (op_kind many), got ${stopped?.op_kind}`,
    );
  }
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
