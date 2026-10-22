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
 * ORDER IS DELIBERATE: the ON leg runs FIRST, because it leaves the tier clean. The SINGLE leg
 * (R-204b) runs second: the ON leg's flag with `--no-group-runs`, so every covering test goes
 * through `RunMutant` alone, which is the only path R-204b's Part A changes and which the grouped
 * ON leg cannot reach. It also leaves the tier clean. The BASELINE leg (R-658) runs third: a short
 * baseline budget over `HangBaselineTests.Codeunit.al`, so LethAL stops one UNMUTATED test on the
 * server, on the coverage path. Any failure there is a STOP (exit 5, no further leg, no teardown,
 * the server held), per `docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md`;
 * its judgements live in `hang-baseline-leg.ts`. The OFF leg quarantines by design and is torn
 * down afterwards.
 *
 * Connection details are never committed; this reads the gitignored
 *   fixtures/sandbox-hang/lethal.config.local.json
 * and the fixture's test app must be published to that container (LethAL publishes the TARGET on
 * every run but treats publishing the TEST app as the user's own workflow — R56).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationConfig } from "../src/activation";
import { ArtifactCompiler, defaultArtifactIo } from "../src/artifact";
import { BcDevMcpBackend } from "../src/bcdev-backend";
import { devPortOf, odataUrlsOf, validateBcDevConfig } from "../src/cli";
import type { LethalConfigFile } from "../src/cli";
import { DeploymentVerifier } from "../src/deployment-verifier";
import type { EventSubscriber, RunEvent } from "../src/events";
import { formatFailure } from "../src/format-failure";
import { HarnessVerifier } from "../src/harness";
import { LeaseClient, MAX_TTL_SECONDS } from "../src/lease";
import { runSession } from "../src/orchestrator";
import { ContainerDeployer, defaultAlToolPaths, defaultDeployerIo } from "../src/publisher";
import type { QuarantineRecord } from "../src/quarantine-store";
import type { SessionReport } from "../src/report";
import { RunMutantTransport } from "../src/run-mutant-transport";
import { ResultsStore } from "../src/store";
import { BaselineRecordedError, assertGateBaseline, preflightGateBaseline } from "./baseline-guard";
import { itestConfigName, itestConfigPath, printItestTarget } from "./config-path";
import { HANG_FIGURES } from "./gate-expected";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  BASELINE_PROBE_OWNER,
  type BaselineVerdictEvent,
  type HangTestRow,
  type LegState,
  baselineLegFailures,
  copyEvidence,
  quarantineRecordsIn,
  quarantineStopReasons,
  stopHungSessionsFindings,
  writeLegState,
} from "./hang-baseline-leg";
import {
  type QuarantineDiagnostic,
  type WarningDiagnostic,
  printHangLegFailureDiagnostics,
} from "./hang-diagnostics";
import { stopRowFailures } from "./hang-stop-rows";
import { killReproductionFailures, latestRunId } from "./kill-reproduction";

if (!process.env.LETHAL_ITEST_HANG) {
  console.log(
    "skipped (set LETHAL_ITEST_HANG=1, populate the gitignored " +
      "fixtures/sandbox-hang/lethal.config.local.json, and publish " +
      "fixtures/sandbox-hang-tests to that container to run this)",
  );
  const challenged = await emitSkipped("hang", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-hang");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-hang-tests");
const CONFIG_LOCAL_PATH = itestConfigPath(PROJECT_DIR);
printItestTarget(CONFIG_LOCAL_PATH);

/**
 * R-658 §5: the STOP rule's in-process state. The wrapper passes the leg marker's path and the
 * evidence dir; without them (a run by hand) the marker and the copy are skipped, never the rule.
 */
const LEG_STATE_PATH = process.env.LETHAL_ITEST_HANG_LEG_STATE;
const EVIDENCE_DIR = process.env.LETHAL_ITEST_HANG_EVIDENCE_DIR;
const LEG_MODES = ["on", "single", "baseline", "off"] as const;
let legState: LegState | undefined;
let stopReason: string | undefined;
/** Set once `main()` made its scratch root, so a crash handler can copy the evidence. */
let scratchRootForEvidence: string | undefined;

function setLegState(state: LegState): void {
  legState = state;
  writeLegState(LEG_STATE_PATH, state);
}

/** A STOP raised on purpose (a D-C quarantine, a failed BASELINE assertion). */
class HangStopError extends Error {
  override readonly name = "HangStopError";
}

/** The STOP path. The marker is written FIRST, before any log line (§5). Idempotent. */
function fireStop(reason: string): void {
  if (stopReason !== undefined) return;
  setLegState("stop");
  stopReason = reason;
}

function printStopBanner(): void {
  console.error(
    [
      `hang itest: STOP (${stopReason ?? "unknown"})`,
      "  No further leg ran, and there was no teardown force-reset, RecoverOp or unpublish.",
      "  If BC answered the stop, the control-app lease and `lethal doctor` may read this server",
      "  CLEAN. Do NOT trust that until the owner has restarted it and bc-linux-setup ran clean.",
    ].join("\n"),
  );
}

/**
 * Review I1: on any exit that is not yet a STOP, a quarantine record left by ON or SINGLE makes it
 * one, because a throw in those legs skips their D-C check.
 */
function stopOnLeftoverQuarantine(scratchRoot: string | undefined): void {
  if (stopReason !== undefined || scratchRoot === undefined) return;
  const found = quarantineRecordsIn(scratchRoot);
  if (found.length > 0) fireStop(`D-C quarantine found on the way out: ${found.join("; ")}`);
}

async function crashed(kind: string, err: unknown): Promise<void> {
  if (legState === "armed") fireStop(`${kind} while the BASELINE leg was armed`);
  else stopOnLeftoverQuarantine(scratchRootForEvidence);
  console.error(`hang itest: ${kind}`);
  console.error(formatFailure(err));
  const msg = err instanceof Error ? err.message : String(err);
  if (stopReason !== undefined) {
    if (scratchRootForEvidence !== undefined) {
      for (const l of copyEvidence(scratchRootForEvidence, EVIDENCE_DIR, LEG_MODES))
        console.error(`  ${l}`);
    }
    printStopBanner();
  } else {
    // ponytail: no async teardown from a crash handler; it says what was skipped instead.
    console.error(
      "  No teardown force-reset ran. If the OFF leg had started, its stranded op marker blocks every later run on this server; see teardown() in hang.itest.ts for the recovery.",
    );
  }
  // Review M3: a crash writes a failed receipt too, naming the STOP or the crash.
  try {
    await emitFailed(
      "hang",
      stopReason !== undefined ? `STOP (exit 5): ${stopReason}` : `${kind}: ${msg}`,
    );
  } catch (receiptErr) {
    console.error(`  receipt write failed: ${formatFailure(receiptErr)}`);
  }
  process.exit(stopReason !== undefined ? 5 : 1);
}
process.on("uncaughtException", (err) => void crashed("uncaught exception", err));
process.on("unhandledRejection", (err) => void crashed("unhandled rejection", err));
/**
 * R-204b: the SINGLE leg's committed per-mutant baseline (R332: refused when missing, recorded
 * once with `LETHAL_ITEST_RECORD_BASELINE=hang.single.baseline.json`, exit 3, never a pass). The ON
 * and OFF legs keep their inline tables.
 */
const SINGLE_BASELINE_PATH = join(HERE, "hang.single.baseline.json");

// Inside sandbox-hang's declared idRanges (79400-79449) — alc enforces app.json idRanges (AL0297)
// for the injected objects too.
const SELECTOR_IDS = { selectorId: 79447, controlId: 79448, tableId: 79449 };

/**
 * Short on purpose. Every hanging mutant costs a full budget before the stop fires, and there are
 * two of them, so this is the dominant term in the gate's wall clock. 20 s is far above the
 * terminating mutants' measured cost (66-141 ms, three orders of magnitude of headroom) and far
 * below anything that would make a slow-but-correct mutant look like a hang.
 */
const BUDGET_MS = HANG_FIGURES.budgetMs;
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
  // Line 104 (`Pending -= 1`) has NO row since R196: `while Pending > 0` reads `Pending`, so
  // `remove-assignment` and `shift-integer` refuse it as hang-capable. Both were measured `killed`
  // by ARITHMETIC OVERFLOW, not by the budget: the frozen condition left `Drained += 1` to overflow
  // Int32 in ~4.4 s. They are the refusal's measured over-approximation, not hangs
  // (docs/superpowers/specs/2026-10-04-r196-refuse-precommitment.md).
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
const EXPECTED_WARM_KILLS = HANG_FIGURES.warmKills;

/**
 * R516: the cold confirms of the position-1 timeouts, pinned as NUMBERS, never read back from the
 * report (`docs/superpowers/specs/2026-10-08-r516-hang-confirm-every-timeout-precommitment.md`).
 * ON: lines 37, 43, 44 and 73 (line 145 is at position 2 and is confirmed by its replay instead).
 * SINGLE: the same four plus line 145, every call holding one method.
 */
const EXPECTED_COLD_CONFIRMS_ON = HANG_FIGURES.coldConfirmsOn;
const EXPECTED_COLD_CONFIRMS_SINGLE = HANG_FIGURES.coldConfirmsSingle;

/**
 * R516: every position-1 timeout is confirmed by ONE unmutated `RunMutant` call before it is
 * scored. A cold confirm row is exactly `mutant_code IS NULL AND op_kind IS NULL` (a replay row is
 * op_kind `many`; never "op_kind not many", which SQL would compare as unknown for NULL). For each
 * `timeout-killed` mutant at position 1, keyed by the `mutant_row_id` of its own timeout row: exactly
 * one such row, for the killing test, outcome `pass`, inside half the budget (R53's margin). On the
 * ON leg the position-2 timeout (line 145) has none.
 */
function assertColdConfirms(label: string, leg: LegResult, expected: number): void {
  const { report, testRows } = leg;
  const coldConfirmsOf = (m: SessionReport["mutants"][number]) => {
    const stopped = testRows.find((r) => r.mutant_code === m.mutantCode && r.outcome === "timeout");
    assert.ok(stopped !== undefined, `[${label}] R516: ${m.mutantCode} has no timeout row`);
    assert.ok(
      stopped.mutant_row_id !== null,
      `[${label}] R516: ${m.mutantCode}'s timeout row has no mutant_row_id`,
    );
    return testRows.filter(
      (r) =>
        r.mutant_row_id === stopped.mutant_row_id && r.mutant_code === null && r.op_kind === null,
    );
  };
  const timeoutKilled = report.mutants.filter((m) => m.verdict === "timeout-killed");
  let total = 0;
  for (const m of timeoutKilled) {
    const rows = coldConfirmsOf(m);
    if (m.killPosition !== 1) {
      assert.equal(
        rows.length,
        0,
        `[${label}] R516: ${m.mutantCode} (line ${m.line}) is a position-${m.killPosition} timeout, confirmed by its replay; it must have no cold confirm row, got ${rows.length}`,
      );
      continue;
    }
    assert.equal(
      rows.length,
      1,
      `[${label}] R516: ${m.mutantCode} (line ${m.line}) must have exactly one cold confirm row, got ${rows.length}`,
    );
    const [row] = rows;
    assert.ok(row !== undefined);
    assert.equal(
      row.method,
      m.killingTest,
      `[${label}] R516: ${m.mutantCode}'s confirm ran ${row.method}`,
    );
    assert.equal(
      row.outcome,
      "pass",
      `[${label}] R516: ${m.mutantCode}'s confirm answered ${row.outcome}`,
    );
    assert.ok(
      2 * row.duration_ms <= BUDGET_MS,
      `[${label}] R516: ${m.mutantCode}'s confirm took ${row.duration_ms} ms, more than half the ${BUDGET_MS} ms budget`,
    );
    total += 1;
  }
  assert.equal(
    total,
    expected,
    `[${label}] R516: expected ${expected} cold confirms of position-1 timeouts, got ${total}`,
  );
  if (label === "ON") {
    const line145 = timeoutKilled.find(
      (m) => m.line === 145 && m.operatorName === "lethal.void-method-call",
    );
    assert.ok(line145 !== undefined, "[ON] R516: line 145's timeout-killed mutant is missing");
    assert.equal(
      coldConfirmsOf(line145).length,
      0,
      "[ON] R516: line 145 must have no cold confirm row",
    );
  }
}

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
  /**
   * `test_results` rows for this run, so the gate can assert BC's own words, not just a verdict.
   * `mutant_code` is NULL on a confirm row (R514/R516's cold confirm, R206's replay) and on a
   * baseline row; `mutant_row_id` (R516) is NULL only on a baseline row.
   */
  readonly testRows: readonly HangTestRow[];
  /** R-658: every `baseline-batch-finished` verdict, with its classification. */
  readonly baselineVerdicts: readonly BaselineVerdictEvent[];
  /** R-658: this run's `quarantined` events (D-C, assertion 10). */
  readonly quarantinedEvents: number;
  /** R-658: this run's `baseline_snapshots` rows (assertion 12; the ON leg's positive control). */
  readonly baselineSnapshotRows: number;
  readonly odataCfg: ActivationConfig;
  readonly quarantineDir: string;
  /** R206: `ResultsStore.sessionIdLiveness` for this run, read before the store closes. */
  readonly sessionLiveness: ReturnType<ResultsStore["sessionIdLiveness"]>;
  /**
   * Diagnostics only, never asserted on: this run's `{ type: "warning" }` events (events.ts),
   * collected via `emit` since `runSession` otherwise reports them only to a subscriber this gate
   * did not use to pass, see the 2026-09-27 hang investigation
   * (`docs/measurements/2026-09-27-r289-hang-rootcause.md`, point 8).
   */
  readonly warnings: readonly WarningDiagnostic[];
  /** R582: `killReproductionFailures` for this leg, read before the store closes. */
  readonly repro: readonly string[];
}

/**
 * `single` is R-204b's leg: `--stop-hung-sessions` with `--no-group-runs`. `baseline` is R-658's:
 * the flag absent, a 10 s baseline budget, `--tests-only` on the new codeunit, and
 * `--operator conditional-boundary`.
 */
type LegMode = (typeof LEG_MODES)[number];

async function runLeg(scratchRoot: string, mode: LegMode): Promise<LegResult> {
  const stopHungSessions = mode === "on" || mode === "single";
  const configFile = await readJson<LethalConfigFile>(CONFIG_LOCAL_PATH, itestConfigName());
  const bcdev = validateBcDevConfig(configFile.bcdev);
  const toolPaths = await defaultAlToolPaths();
  if (!toolPaths) {
    throw new Error("could not locate alc.exe/altool.exe under the AL Language extension install");
  }

  const outputDir = join(scratchRoot, `publish-${mode}`);
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
  // R-658: named so assertion 19 can read it; `devPortOf` adds only the port, at the constructor.
  const backendCfg = {
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
  };
  const backend = new BcDevMcpBackend(
    { ...backendCfg, ...devPortOf(bcdev) },
    undefined,
    {
      compiler,
      deployer,
      verifier: new DeploymentVerifier(odataCfg),
      harnessVerifier,
    },
    (targetAppId, artifactId, controlState) =>
      new RunMutantTransport(odataCfg, targetAppId, artifactId, undefined, { controlState }),
  );
  // A SCRATCH quarantine dir: the OFF leg quarantines BY DESIGN, and one landing in the real
  // ~/.lethal store would poison every later gate run on this container until an operator deleted
  // it by hand. Same reasoning as bcdev.itest.ts, load-bearing here rather than defensive.
  const quarantineDir = join(scratchRoot, `quarantine-${mode}`);
  const store = new ResultsStore(join(scratchRoot, `hang-${mode}.sqlite`));
  const warnings: WarningDiagnostic[] = [];
  const baselineVerdicts: BaselineVerdictEvent[] = [];
  let quarantinedEvents = 0;
  const collect: EventSubscriber = (event: RunEvent) => {
    if (event.type === "warning") warnings.push({ code: event.code, message: event.message });
    if (event.type === "quarantined") quarantinedEvents += 1;
    if (event.type === "baseline-batch-finished") {
      for (const v of event.verdicts) {
        baselineVerdicts.push({
          name: v.name,
          outcome: v.outcome,
          classification: v.classification,
        });
      }
    }
  };
  const sessionCfg = {
    backend,
    store,
    projectDir: PROJECT_DIR,
    testDir: TEST_DIR,
    instrumentedDir: join(scratchRoot, `instr-${mode}`),
    selectorIds: SELECTOR_IDS,
    mutantTimeoutMs: BUDGET_MS,
    ...(stopHungSessions ? { stopHungSessions: true } : {}),
    // R-204b: the CLI's `--no-group-runs`, so every covering test is one `RunMutant` call.
    ...(mode === "single" ? { groupRuns: { enabled: false } } : {}),
    // R-658 §4: the BASELINE leg's narrowing and its short baseline budget; grouping at default.
    ...(mode === "baseline"
      ? {
          baselineTimeoutMs: HANG_FIGURES.baselineBudgetMs,
          testsOnly: ["**/HangBaselineTests.Codeunit.al"],
          operators: ["lethal.conditional-boundary"],
        }
      : {}),
    lease: {
      client: new LeaseClient(odataCfg),
      serverGeneration: async () => (await harnessVerifier.verify()).serverGeneration,
    },
    resourceServer: bcdev.server,
    resourceServerInstance: bcdev.serverInstance,
    quarantineDir,
    emit: [collect],
  };
  try {
    if (mode === "baseline") {
      // Assertion 19 (M4), before the leg's first server call and before the marker is armed:
      // a plain Error, so exit 1 and today's teardown. Nothing was sent.
      const found = stopHungSessionsFindings(backendCfg, sessionCfg);
      if (found.length > 0) throw new Error(found.join("; "));
      setLegState("armed");
    }
    const report = await runSession(sessionCfg);
    const testRows = store.db
      .query(
        "SELECT mutant_code, mutant_row_id, codeunit_name, method, outcome, duration_ms, failure_message, op_kind FROM test_results ORDER BY id",
      )
      .all() as HangTestRow[];
    const runId = latestRunId(store);
    const sessionLiveness = store.sessionIdLiveness(runId);
    const repro = killReproductionFailures(`hang/${mode}`, report, store, runId);
    const snap = store.db
      .query("SELECT COUNT(*) AS n FROM baseline_snapshots WHERE run_id = ?")
      .get(runId) as { n: number };
    return {
      report,
      testRows,
      baselineVerdicts,
      quarantinedEvents,
      baselineSnapshotRows: snap.n,
      odataCfg,
      quarantineDir,
      sessionLiveness,
      warnings,
      repro,
    };
  } finally {
    store.close();
    // Without this the spawned bc-dev MCP child keeps the event loop alive and the script hangs —
    // which would be a particularly poor failure mode for the hang gate.
    await backend.close();
  }
}

/**
 * Best-effort: lists every record under a `QuarantineStore`'s dir and parses it, without needing
 * the `resourceKey` a `.read()` call would require. Diagnostics only: a file that fails to parse
 * is reported as such rather than thrown, since a broken quarantine record must not hide whatever
 * the test assertion above already found.
 */
async function readQuarantineRecords(dir: string): Promise<readonly QuarantineDiagnostic[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: QuarantineDiagnostic[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      records.push(JSON.parse(await readFile(join(dir, name), "utf8")) as QuarantineRecord);
    } catch (err) {
      records.push({
        resourceKey: name,
        opKind: "unreadable",
        detail: `could not read/parse this quarantine record: ${err instanceof Error ? err.message : String(err)}`,
        recordedAtIso: "",
        generation: 0,
      });
    }
  }
  return records;
}

/**
 * R-236b/2026-09-27 hang investigation: on a failed assertion, print what the scratch store and
 * quarantine dir hold before `main()`'s `finally` deletes them, otherwise the ONLY record of why
 * a leg failed is gone by the time anyone reads the gate's output (see
 * `docs/measurements/2026-09-27-r289-hang-rootcause.md`).
 */
async function printLegFailureDiagnostics(label: string, leg: LegResult): Promise<void> {
  const errorMutants = leg.report.mutants
    .filter((m) => m.verdict === "error")
    .map((m) => ({
      mutantCode: m.mutantCode,
      failureMessages: leg.testRows
        .filter((r) => r.mutant_code === m.mutantCode)
        .map((r) => r.failure_message ?? "(test_results row has no failure_message)"),
    }));
  const quarantine = await readQuarantineRecords(leg.quarantineDir);
  printHangLegFailureDiagnostics({ leg: label, errorMutants, quarantine, warnings: leg.warnings });
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

/**
 * R447: R196 refuses both mutations of `Pending -= 1` (line 104, `DrainQueue`), so the report names
 * them as ONE `hang-refused` row and reads `narrowed`. Pre-committed in
 * `docs/superpowers/specs/2026-10-05-r447-hang-row-precommitment.md`; built at generation, so both
 * legs carry it, the quarantined OFF leg included.
 */
function assertHangRefusedRow(label: string, report: SessionReport): void {
  assert.deepEqual(
    (report.excludedSites?.files ?? []).filter((f) => f.reason === "hang-refused"),
    [
      {
        file: "src/HangLogic.Codeunit.al",
        reason: "hang-refused",
        kinds: "codeunit_declaration",
        sites: 2,
      },
    ],
    `[${label}] R447: expected exactly one hang-refused row with 2 sites`,
  );
  assert.ok(
    report.validity.scoreDescribes.includes("; 2 hang-refused site(s) in 1 file(s) not mutated"),
    `[${label}] R447: scoreDescribes must name the hang-refused sites; got ${JSON.stringify(report.validity.scoreDescribes)}`,
  );
  assert.equal(
    report.validity.reliability,
    "narrowed",
    `[${label}] R447: the hang-refused row narrows reliability (and nothing degrades it)`,
  );
}

function assertOnLeg(leg: LegResult): void {
  const { report, testRows } = leg;
  dump("stop-hung-sessions ON", report);
  assertHangRefusedRow("ON", report);

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
  // R582: a warm kill also adds ONE re-run under the mutant (R577's rule, on for bcdev), so the
  // pin is `scored + 2 x warmKills`; a position-1 re-run is a single call and adds nothing.
  assert.equal(
    report.groupedCalls,
    report.counts.killed +
      report.counts.survived +
      report.counts.timeoutKilled +
      2 * EXPECTED_WARM_KILLS,
    `R198/R206/R582: expected one RunMutantMany call per scored mutant plus one replay and one re-run per warm kill; got groupedCalls=${report.groupedCalls}`,
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
  //
  // "Calls that did not answer" is 408s HERE, but not in general: run 4 on the hosted sandbox
  // (2026-09-04) matched 886 grouped sessions against 895 calls minus 8 stopped minus ONE lost
  // ack, whose op completed server-side while its answer never arrived, so it recorded no rows.
  // A container gate has no lost acks; a hosted run does. Subtract them too if this ever runs
  // somewhere that produces them.
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
  // R582: the stopped grouped calls are the 5 first timeouts plus line 145's warm timeout re-run,
  // pinned as a NUMBER (`HANG_FIGURES.stoppedCallsOn`), never read back from the report. The
  // cross-check below says the same 6 from the verdicts.
  const STOPPED_CALLS_ON = HANG_FIGURES.stoppedCallsOn;
  assert.equal(
    timeoutKilled.length + timeoutKilled.filter((m) => (m.killPosition ?? 1) > 1).length,
    STOPPED_CALLS_ON,
    `R582: ${STOPPED_CALLS_ON} stopped grouped calls expected: one per timeout kill plus one per warm timeout kill's re-run`,
  );
  assert.equal(
    live.manyDistinct,
    (report.groupedCalls ?? 0) - STOPPED_CALLS_ON,
    `distinct session ids among grouped pass/fail rows must equal the group calls that answered (groupedCalls ${report.groupedCalls} minus ${STOPPED_CALLS_ON} stopped calls); got ${live.manyDistinct}`,
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
  assertColdConfirms("ON", leg, EXPECTED_COLD_CONFIRMS_ON);
  assertTwoStops("ON", leg);
  assert.deepEqual(leg.repro, [], leg.repro.join("; "));
  // R-658 §3: the positive control for the BASELINE leg's assertion 12 (no snapshot there). A
  // green baseline at the default budget records one, so a store read that saw nothing fails here.
  assert.ok(
    leg.baselineSnapshotRows >= 1,
    `[ON] R-658: the store must hold at least one baseline_snapshots row; got ${leg.baselineSnapshotRows}`,
  );
}

/** R-658 §3 D-C: a quarantine in ON or SINGLE is a STOP, checked before the leg's assertions. */
async function stopOnQuarantine(label: string, leg: LegResult): Promise<void> {
  const reasons = quarantineStopReasons(label, {
    report: leg.report,
    quarantinedEvents: leg.quarantinedEvents,
    quarantineRecords: (await readQuarantineRecords(leg.quarantineDir)).length,
  });
  if (reasons.length === 0) return;
  fireStop(`D-C quarantine: ${reasons.join("; ")}`);
  await printLegFailureDiagnostics(label, leg);
  throw new HangStopError(reasons.join("; "));
}

/**
 * R-658 §4 assertion 18: after the session, the control-app lease must be free to a fresh owner
 * and give itself back. A throw here is a STOP too (the marker reads `armed`).
 */
async function probeAcquire(
  odataCfg: ActivationConfig,
): Promise<{ granted: boolean; released: boolean }> {
  const generation = (await new HarnessVerifier(odataCfg).verify()).serverGeneration;
  const client = new LeaseClient(odataCfg);
  const got = await client.acquire(BASELINE_PROBE_OWNER, MAX_TTL_SECONDS, randomUUID(), generation);
  if (!got.granted) {
    console.error(`  probe acquire REFUSED: ${JSON.stringify(got)}`);
    return { granted: false, released: false };
  }
  const rel = await client.release(got.lease);
  if (!rel.released) console.error(`  probe release REFUSED: ${rel.reason}`);
  return { granted: true, released: rel.released };
}

function dumpBaselineLeg(leg: LegResult): void {
  dump("BASELINE (--baseline-timeout-ms 10000)", leg.report);
  const r = leg.report;
  // §4 "recorded, not asserted".
  console.log(
    `  [BASELINE] groupedCalls=${r.groupedCalls} warmKills=${r.warmKills} singleRows=${leg.sessionLiveness.singleRows} singleDistinct=${leg.sessionLiveness.singleDistinct} manyDistinct=${leg.sessionLiveness.manyDistinct} caveats=${JSON.stringify(r.validity.caveats)}`,
  );
  for (const row of leg.testRows.filter((t) => t.mutant_row_id === null)) {
    console.log(
      `    baseline ${row.codeunit_name}.${row.method} ${row.outcome} ${row.duration_ms} ms ${JSON.stringify((row.failure_message ?? "").slice(0, 160))}`,
    );
  }
}

/** R582: every `timeout-killed` mutant was stopped twice by BC, the first run and the re-run. */
function assertTwoStops(label: string, leg: LegResult): void {
  const failures = leg.report.mutants
    .filter((m) => m.verdict === "timeout-killed")
    .flatMap((m) => stopRowFailures(label, m, leg.testRows, BUDGET_MS, STOP_GRACE_MS));
  assert.deepEqual(failures, [], failures.join("; "));
}

/**
 * R-204b's SINGLE leg: the ON leg's flag with `--no-group-runs`. Pre-committed: every mutant
 * scores the ON leg's verdict (`EXPECTED_ON`), every hang stays `timeout-killed` with BC's own stop
 * words on a single-call row, every kill sits at position 1 (one method per call, so the line-145
 * hang is no longer a position-2 warm kill), and NO mutant ends `stopped-after-completion` (Part A
 * must not swallow a real hang) or `stop-outcome-unconfirmed` (R202's 400; if it appears live it
 * is a gate failure to re-run once, never a baseline value). `main()` then checks the per-mutant
 * baseline.
 */
function assertSingleLeg(leg: LegResult): void {
  const { report, testRows } = leg;
  dump("stop-hung-sessions SINGLE (--no-group-runs)", report);
  assertHangRefusedRow("SINGLE", report);
  assert.equal(report.baselineGreen, true, "[SINGLE] baseline must be green");
  assert.equal(report.mutants.length, EXPECTED_ON.length, "[SINGLE] every mutant must be scored");
  for (const cause of ["stopped-after-completion", "stop-outcome-unconfirmed"] as const) {
    const hit = report.mutants.filter((m) => m.cause === cause);
    assert.equal(
      hit.length,
      0,
      `[SINGLE] R-204b: ${hit.length} mutant(s) with cause ${cause} (${hit.map((m) => `${m.mutantCode} line ${m.line}`).join(", ")}) — a real hang must stay timeout-killed`,
    );
  }
  assert.equal(
    report.counts.errors,
    0,
    "[SINGLE] no mutant may error when the stop path is available",
  );
  for (const want of EXPECTED_ON) {
    const got = report.mutants.find(
      (m) => m.line === want.line && m.operatorName === want.operator,
    );
    assert.ok(got !== undefined, `[SINGLE] no mutant at line ${want.line} for ${want.operator}`);
    assert.equal(
      got.verdict,
      want.verdict,
      `[SINGLE] ${want.operator} at line ${want.line}: expected ${want.verdict} (the ON leg's), got ${got.verdict}`,
    );
    if (got.verdict === "killed" || got.verdict === "timeout-killed") {
      assert.equal(
        got.killPosition,
        1,
        `[SINGLE] ${want.operator} at line ${want.line}: killPosition ${got.killPosition}, expected 1 (one method per call)`,
      );
    }
  }
  const timeoutKilled = report.mutants.filter((m) => m.verdict === "timeout-killed");
  assert.equal(timeoutKilled.length, 5, "[SINGLE] the same five hangs as the ON leg");
  for (const m of timeoutKilled) {
    const stopped = testRows.find((r) => r.mutant_code === m.mutantCode && r.outcome === "timeout");
    assert.ok(stopped !== undefined, `[SINGLE] ${m.mutantCode}: no test row with outcome timeout`);
    const msg = stopped.failure_message ?? "";
    assert.match(msg, /stopped the session/i, `[SINGLE] ${m.mutantCode}: no BC stop confirmation`);
    assert.match(msg, /StopSession/i, `[SINGLE] ${m.mutantCode}: BC names no AL StopSession call`);
    assert.ok(
      stopped.duration_ms >= BUDGET_MS && stopped.duration_ms < BUDGET_MS + STOP_GRACE_MS,
      `[SINGLE] ${m.mutantCode}: duration ${stopped.duration_ms}ms is outside [${BUDGET_MS}, ${BUDGET_MS + STOP_GRACE_MS})`,
    );
    assert.notEqual(
      stopped.op_kind,
      "many",
      `[SINGLE] ${m.mutantCode}'s timeout row must come from a single RunMutant call, got op_kind ${stopped.op_kind}`,
    );
  }
  assert.equal(report.groupedCalls ?? 0, 0, "[SINGLE] --no-group-runs: no RunMutantMany call");
  assert.equal(report.warmKills ?? 0, 0, "[SINGLE] one method per call: no warm kill");
  assert.ok(
    report.validity.caveats.includes("stop-hung-sessions"),
    `[SINGLE] the report must carry the stop-hung-sessions caveat; got ${JSON.stringify(report.validity.caveats)}`,
  );
  assert.equal(report.quarantined, undefined, "[SINGLE] the leg must leave the tier unquarantined");
  assertColdConfirms("SINGLE", leg, EXPECTED_COLD_CONFIRMS_SINGLE);
  assertTwoStops("SINGLE", leg);
  assert.deepEqual(leg.repro, [], leg.repro.join("; "));
}

function assertOffLeg(leg: LegResult): void {
  const { report, testRows } = leg;
  dump("stop-hung-sessions OFF", report);
  assertHangRefusedRow("OFF", report);
  // R447 pre-commitment: the M0004 quarantine leaves the baseline green and is not all-errors,
  // so the OFF leg is `narrowed`, never `narrowed-degraded`.
  assert.equal(report.baselineGreen, true, "the OFF leg's baseline must be green");
  assert.ok(
    !report.validity.caveats.includes("all-errors"),
    `the OFF leg must not be all-errors; got ${JSON.stringify(report.validity.caveats)}`,
  );

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
  // R582: the kill scored before the quarantine (M0001) was re-run too.
  assert.deepEqual(leg.repro, [], leg.repro.join("; "));
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
  // R332: refuse in seconds, before any live work, when the SINGLE leg's baseline is missing.
  preflightGateBaseline(SINGLE_BASELINE_PATH, "hang itest SINGLE leg");
  const scratchRoot = await mkdtemp(join(tmpdir(), "lethal-hang-itest-"));
  scratchRootForEvidence = scratchRoot;
  let odataCfg: ActivationConfig | undefined;
  try {
    // ON first: it leaves the tier clean, so a failure here is not confounded by the OFF leg's
    // deliberate quarantine.
    const on = await runLeg(scratchRoot, "on");
    odataCfg = on.odataCfg;
    await stopOnQuarantine("stop-hung-sessions ON", on);
    try {
      assertOnLeg(on);
    } catch (err) {
      await printLegFailureDiagnostics("stop-hung-sessions ON", on);
      throw err;
    }

    // R-204b: the single path, second, because it too leaves the tier clean.
    const single = await runLeg(scratchRoot, "single");
    odataCfg = single.odataCfg;
    await stopOnQuarantine("stop-hung-sessions SINGLE", single);
    try {
      assertSingleLeg(single);
    } catch (err) {
      await printLegFailureDiagnostics("stop-hung-sessions SINGLE", single);
      throw err;
    }
    await assertGateBaseline(single.report, SINGLE_BASELINE_PATH, "hang itest SINGLE leg");

    // R-658: the BASELINE leg, third. `runLeg` checks assertion 19 and then arms the marker; from
    // there every failure and every throw is a STOP (D1).
    const started = Date.now();
    const baseline = await runLeg(scratchRoot, "baseline");
    odataCfg = baseline.odataCfg;
    const probe = await probeAcquire(baseline.odataCfg);
    const elapsedMs = Date.now() - started;
    const failures = baselineLegFailures({
      report: baseline.report,
      testRows: baseline.testRows,
      baselineVerdicts: baseline.baselineVerdicts,
      quarantinedEvents: baseline.quarantinedEvents,
      quarantineRecords: (await readQuarantineRecords(baseline.quarantineDir)).length,
      warnings: baseline.warnings,
      baselineSnapshotRows: baseline.baselineSnapshotRows,
      repro: baseline.repro,
      sessionLiveness: baseline.sessionLiveness,
      probe,
      elapsedMs,
    });
    // The marker is written before any log line of a STOP (§5), so the judgement comes first.
    if (failures.length > 0) fireStop(`BASELINE leg: ${failures.join("; ")}`);
    dumpBaselineLeg(baseline);
    console.log(
      `  [BASELINE] probe granted=${probe.granted} released=${probe.released}; leg ${elapsedMs} ms`,
    );
    if (failures.length > 0) {
      await printLegFailureDiagnostics("BASELINE", baseline);
      throw new HangStopError(failures.join("; "));
    }
    setLegState("passed");

    const off = await runLeg(scratchRoot, "off");
    odataCfg = off.odataCfg;
    try {
      assertOffLeg(off);
    } catch (err) {
      await printLegFailureDiagnostics("stop-hung-sessions OFF", off);
      throw err;
    }

    console.log("hang itest: PASS");
    await emitPassed("hang", {
      sublegs: [
        "stop-hung-sessions-on",
        "stop-hung-sessions-single",
        "stop-baseline",
        "stop-hung-sessions-off",
      ],
      artifacts: { reported: false },
    });
  } catch (err) {
    // §5 trigger 6: any throw once the marker reads `armed` (runSession, the probe, a store read).
    if (legState === "armed") {
      fireStop(
        `throw while the BASELINE leg was armed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  } finally {
    // Review I1: a throw in ON or SINGLE skipped their D-C check; a record they left is a STOP.
    stopOnLeftoverQuarantine(scratchRoot);
    if (stopReason !== undefined) {
      // A STOP: evidence first, before the scratch root goes, and NO teardown.
      for (const l of copyEvidence(scratchRoot, EVIDENCE_DIR, LEG_MODES)) console.error(`  ${l}`);
      printStopBanner();
    } else if (odataCfg !== undefined) {
      await teardown(odataCfg);
    }
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  // hang runs main() at top level rather than through main().catch, so without this a failure
  // exits non-zero with no receipt, which the executor cannot tell from a crashed process.
  // R346: print the reason before any await, as R332 does, so a kill during the receipt write
  // cannot hide it.
  console.error(formatFailure(err));
  const msg = err instanceof Error ? err.message : String(err);
  await emitFailed("hang", stopReason !== undefined ? `STOP (exit 5): ${stopReason}` : msg);
  // R-658: a STOP exits 5. R332: a record run wrote the SINGLE leg's baseline and is never a pass.
  // The two never meet: a record run writes in SINGLE, after its D-C check and before BASELINE.
  process.exit(err instanceof BaselineRecordedError ? 3 : stopReason !== undefined ? 5 : 1);
}
