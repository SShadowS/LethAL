#!/usr/bin/env bun
/**
 * Env-gated integration test: real `generateMutationSet` over the sandbox
 * fixture, real `AlRunnerBackend` (spawns the actual al-runner executable),
 * `:memory:` results store. NOT a `bun:test` file — it is a standalone
 * script invoked via `bun run itest:alrunner` (root package.json), never
 * picked up by `bun test`.
 * R321: also runs fixtures/sandbox-symbols under [LETHALA] and [LETHALB], all three transports (symbol-fixture.ts).
 * R353: also runs fixtures/sandbox-layout at two batches, one-shot and --server (layout-fixture.ts).
 * R387: LAST, runs sandbox-app through the CLI's own `buildBackend` with no transport key, and
 * checks that its defaults (`--server`, the resource selector) actually ran (cli-default-leg.ts).
 *
 * Skips cleanly (exit 0) when LETHAL_ITEST_ALRUNNER is unset, so CI/local
 * `bun test` runs are unaffected and a developer without al-runner installed
 * sees a clear "skipped" message instead of a failure.
 *
 * Expected verdict table is hand-computed in fixtures/README.md — keep the
 * two in sync if the fixture AL or tests change.
 *
 * CLI/JSON contract VERIFIED (2026-08-07) against al-runner v2.0.0.0: argv shape
 * `--output-json --isolation test --test <Codeunit<id>.<method>> <instrumentedDir>
 * <testDir> [--package-cache <dir>]`, with the bundle dirs POSITIONAL; the per-test
 * budget travels in the env var `AL_RUNNER_TEST_TIMEOUT_SEC` (2.0.0.0 had no flag for it;
 * 2.10.0.0 accepts `--test-timeout` again, and LethAL still uses the variable). stdout carries a
 * human progress banner BEFORE the JSON, so the envelope has to be located rather
 * than parsed whole (`parseAlRunnerPayload`). Envelope: `{ tests: [{ name, status,
 * durationMs?, message?, stackTrace? }], passed, failed, errors, total, exitCode }` —
 * entry fields are `name`/`status`, not `method`/`result`, `name` is QUALIFIED, and
 * there is no `codeunit` field on an entry. Exit codes: 0 all passed, 1 at least one
 * test failed or errored, 2 a bundle could not execute, 3 a bundle could not compile.
 *
 * The v1 argv this replaced (`--run`, `--packages`, `--stubs`, `--test-timeout`,
 * `--test-isolation method`) was not merely deprecated — 2.0.0.0 rejected each of those as an
 * unknown option (exit 2). 2.10.0.0 has since re-admitted `--test-timeout` and
 * `--test-isolation` as v1 carry-overs; `--run` is still rejected (measured 2026-09-03). See
 * `src/al-runner-transport.ts` for the measurements.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AlRunnerBackend, defaultServerSpawn } from "../src/al-runner-backend";
import { alRunnerCoverageSupport } from "../src/al-runner-coverage";
import type { ExecutionBackend } from "../src/backend";
import { buildBackend } from "../src/cli";
import { formatFailure } from "../src/format-failure";
import { generateMutationSet, runSession } from "../src/orchestrator";
import { defaultSpawn } from "../src/publisher";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import {
  BaselineRecordedError,
  assertGateBaseline,
  assertMatchesFrozenBaseline,
  preflightFrozenBaseline,
  preflightGateBaseline,
} from "./baseline-guard";
import {
  CLI_DEFAULT_SPEC,
  cliDefaultMechanismFailures,
  daemonPlatformAppsLines,
  expectedCliDefaultShape,
  legShape,
  oneShotArgvSummary,
  recordSpawns,
  watchResourceSelector,
} from "./cli-default-leg";
import { emitFailed, emitPassed, emitSkipped } from "./gate-receipt";
import {
  LAYOUT_MAX_GUARDS,
  LAYOUT_PROJECT_DIR,
  LAYOUT_SELECTOR_IDS,
  LAYOUT_TEST_DIR,
  assertLayoutLegsEqual,
  assertLayoutRun,
  printLayoutTable,
} from "./layout-fixture";
import {
  assertEveryMutantHasReachGrain,
  assertNoReachAttestation,
  printReachSummary,
} from "./reach-evidence";
import { SYMBOL_SETS, assertSymbolBuild, printSymbolTable, symbolSetLabel } from "./symbol-fixture";

if (!process.env.LETHAL_ITEST_ALRUNNER) {
  console.log("skipped (set LETHAL_ITEST_ALRUNNER=1 and LETHAL_ALRUNNER_PATH=<path> to run)");
  const challenged = await emitSkipped("alrunner", "the leg's env var is unset");
  process.exit(challenged ? 1 : 0);
}

const alRunnerPathEnv = process.env.LETHAL_ALRUNNER_PATH;
if (!alRunnerPathEnv) {
  console.error(
    "LETHAL_ITEST_ALRUNNER is set but LETHAL_ALRUNNER_PATH is not — point it at the al-runner executable",
  );
  process.exit(1);
}
// Narrowed to `string` here; passed explicitly into runOnce() below rather than closed
// over, since TS does not carry closure-captured narrowing across function boundaries.
const alRunnerPath: string = alRunnerPathEnv;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-app");
const TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-tests");

// Kept consistent with bcdev.itest.ts's SELECTOR_IDS: must live inside the fixture's declared
// idRanges (79000-79199) — the real alc.exe used by the bcdev backend enforces app.json
// idRanges (AL0297), even though al-runner's own compiler tolerated out-of-range ids.
const SELECTOR_IDS = { selectorId: 79199, controlId: 79198, tableId: 79197 };

// Committed per-mutant healthy-path baseline (Task 15, design spec §14) — see baseline-guard.ts.
// Aggregate counts (EXPECTED below) are a smoke test; this catches a per-mutant verdict swap
// that leaves the aggregate counts unchanged.
const BASELINE_PATH = join(HERE, "al-runner.baseline.json");
/** R353: the layout fixture's one-shot leg, recorded only through R332's record path. */
const LAYOUT_BASELINE_PATH = join(HERE, "al-runner.layout.baseline.json");
/** R387: the CLI-default leg (`buildBackend`, no transport key), recorded only through R332. */
const CLI_DEFAULT_BASELINE_PATH = join(HERE, "al-runner.cli-default.baseline.json");

// R321: the symbol fixture pair, its own app and id range (79600-79699), so no other gate moves;
// selector ids at the top of the target's range, per the `pickSelectorIds` convention.
const SYMBOL_PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-symbols");
const SYMBOL_TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-symbols-tests");
const SYMBOL_SELECTOR_IDS = { selectorId: 79649, controlId: 79648, tableId: 79647 };
/** R321 Decision 6: the ONLY way a symbol baseline is ever written. A record run is never a pass. */
const RECORD_SYMBOL_BASELINES = process.env.LETHAL_ITEST_RECORD_SYMBOL_BASELINES === "1";

/** `al-runner.symbols-lethala.baseline.json`, `al-runner.symbols-lethalb.baseline.json`. */
function symbolBaselinePath(symbols: readonly string[]): string {
  if (symbols.length === 0) throw new Error("R321: the symbol legs never run the empty set");
  return join(HERE, `al-runner.symbols-${symbols.join("-").toLowerCase()}.baseline.json`);
}

interface GateFixture {
  readonly projectDir: string;
  readonly testDir: string;
  readonly selectorIds: typeof SELECTOR_IDS;
  readonly symbols: readonly string[];
  /** R353: absent on every leg but the layout legs, so the others still run one batch. */
  readonly maxGuardsPerBatch?: number;
}

const SANDBOX: GateFixture = {
  projectDir: PROJECT_DIR,
  testDir: TEST_DIR,
  selectorIds: SELECTOR_IDS,
  symbols: [],
};

// Hand-computed against fixtures/sandbox-app/src (see fixtures/README.md §Expected verdict table).
// al-runner reports coverage:"none", so the orchestrator never emits a "no-coverage" verdict —
// the 3 DiscountedPrice mutants (uncovered by any test) join the rest as "survived".
//
// 16 since the parenthesized-operand operator bug was fixed (findOperatorToken in
// packages/builtin-tier1/src/mutate-helpers.ts): ClampPercent's `(Value < 0) or
// (Value > 100)` now yields its negate-conditional mutant, which survives.
const EXPECTED = {
  // R159 moves this from 16 to 17 and survived from 13 to 14. `lethal.swap-additive` claims
  // `DiscountedPrice`'s `Price - (Price * Pct / 100)`, the fixture's only site where both operands
  // are provably numeric.
  //
  // It lands SURVIVED here and `no-coverage` on `itest:bcdev`, from the same mutant on the same
  // fixture, and that difference is this gate's whole character rather than a discrepancy: al-runner
  // reports no coverage data, so every mutant runs against the whole suite and nothing can be
  // classified as unreached. `Sandbox Pricing` is called by neither test either way.
  //
  // NOT pre-committed with the other nine: R159's pre-commitment named `itest:tables` and
  // `itest:bcdev` and missed that this gate shares the sandbox-app fixture. The verdict follows from
  // the rule this gate already documents, but it was written down after the refusal, not before, and
  // that is recorded rather than smoothed over.
  // R159's `remove-assignment` moves this to 18 and survived to 15. Its one site here is
  // `Sandbox Logic.LogAudit`'s `Amount := Amount`, a SELF-ASSIGNMENT: deleting it changes nothing
  // observable, so it is an equivalent mutant by inspection and a useful one to have on record.
  // Pre-committed in docs/superpowers/specs/2026-08-26-r159-remove-assignment-build-precommitment.md.
  // R159's `shift-integer` moves this from 18 to 19: `LogAudit`'s `Amount <> 0` is an
  // equality-family comparison, so the operator claims the literal.
  totalMutantSites: 19,
  killed: 3,
  // R159's `shift-integer` moves this from 15 to 16: `Sandbox Logic.LogAudit`'s `Amount <> 0`
  // becomes `<> 1`. It survives because the guarded block is `Amount := Amount`, a self-assignment,
  // so changing WHICH inputs enter a block that does nothing is unobservable. Measured in the spike,
  // docs/superpowers/specs/2026-08-26-r159-shift-integer-spike.md.
  // R220 moves this from 16 to 12 and noCoverage from 0 to 4, and the four are not new mutants:
  // they are `SandboxPricing.Codeunit.al`'s, which no test reaches. Before al-runner had
  // `--coverage` this backend ran every mutant against every green test and reported an unreached
  // one `survived`, which over-reports. With coverage they are `no-coverage`, which is what
  // `itest:bcdev` — the authoritative gate — has always reported for exactly those four.
  //
  // So the load-bearing fact is not the numbers moving, it is that this gate and `itest:bcdev` now
  // agree at 3 / 12 / 4 PER MUTANT, on the one axis they used to disagree about. Pre-committed in
  // docs/superpowers/specs/2026-09-09-r220-alrunner-coverage-precommitment.md before the run.
  survived: 12,
  noCoverage: 4,
};

/**
 * The four mutants R220 predicted would move, BY NAME.
 *
 * Counts alone would pass if coverage lost four of `SandboxLogic`'s survivors and gained four
 * elsewhere, which is the failure mode that matters here: a wrong attribution that happens to
 * balance. Naming them is what makes that impossible.
 */
const EXPECTED_NO_COVERAGE_FILE = "SandboxPricing.Codeunit.al";

/** What two legs must agree on, per mutant. */
const shape = (r: SessionReport) =>
  [...r.mutants]
    .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
    .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));

async function runOnce(
  scratchRoot: string,
  serverMode = false,
  selectorMode: "static" | "resource" = "static",
  fixture: GateFixture = SANDBOX,
): Promise<SessionReport> {
  const store = new ResultsStore(":memory:");
  // `cfg.backend` is CALLER-owned and `runSession` never closes it -- see the ownership note on
  // the worker-disposal test in orchestrator.test.ts, and `cli.ts`'s own `finally`. Harmless while
  // this backend spawned a process per test; under `serverMode` it owns a daemon, and not closing
  // it leaves a finished session that never exits, which reads as a hang. Measured that way before
  // this line existed.
  let backendRef: AlRunnerBackend | undefined;
  try {
    // R220: the caller decides, having first asked whether al-runner can report this project's
    // coverage correctly at all. `capabilities()` is read at the top of `runSession`, before an
    // instrumented bundle exists, so the answer has to come from the source tree.
    const support = await alRunnerCoverageSupport(fixture.projectDir);
    if (!support.supported) {
      throw new Error(
        `al-runner coverage is unsupported for this fixture, which it must not be: ${support.multiObjectFiles.join(", ")}`,
      );
    }
    const backend = new AlRunnerBackend({
      alRunnerPath,
      instrumentedDir: join(scratchRoot, "instrumented"),
      testDir: fixture.testDir,
      selectorObjectId: fixture.selectorIds.selectorId,
      coverage: "al-runner",
      ...(serverMode ? { serverMode: true } : {}),
      ...(selectorMode === "resource" ? { selectorMode } : {}),
      // R321: the one-shot argv (`buildAlRunnerArgv`) and the daemon's start argv (R319) read this.
      ...(fixture.symbols.length > 0 ? { preprocessorSymbols: fixture.symbols } : {}),
    });
    backendRef = backend;
    return await runSession({
      backend,
      store,
      projectDir: fixture.projectDir,
      testDir: fixture.testDir,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: fixture.selectorIds,
      // R321: compiles nothing; it is only what `SessionReport.preprocessorSymbols` records.
      ...(fixture.symbols.length > 0 ? { preprocessorSymbols: fixture.symbols } : {}),
      ...(fixture.maxGuardsPerBatch !== undefined
        ? { maxGuardsPerBatch: fixture.maxGuardsPerBatch }
        : {}),
    });
  } finally {
    store.close();
    await backendRef?.close();
  }
}

/**
 * R147 pin check, called ONLY on the one-shot legs (R235). Only the one-shot CLI path sends the pin
 * (`--package-cache <pin>` in place of `--auto-provision`); `--server` starts the daemon with
 * `packagesDir` alone and never receives it, so asserting it on the server and resource legs would
 * check a value that was recorded but not used. Since R242 it is not recorded there at all, which
 * `assertPlatformAppsNotRecorded` pins on those two legs.
 */
function assertPlatformAppsPinned(report: SessionReport): void {
  // R147: this run must have PINNED the Microsoft platform-app directory its own provisioning run
  // reported, and must say which. Without this assertion the optimisation could stop working with no
  // observable difference anywhere — same verdicts, same counts, no line — and the wording it parses
  // has already moved once inside a week (2.1.1.0's `fetching` line carried no path at all).
  //
  // Asserted as a SHAPE, not a fixed directory, for the same reason `bcBuild` is: al-runner resolves
  // the project's BC version prefix forward to the latest Microsoft build, so the exact directory
  // changes every time upstream publishes. What must not regress is that a directory was pinned at
  // all. This is a MECHANISM assertion and deliberately not a timing one — the wall-clock gain
  // (17.1 s to 6.8 s per invocation, measured 2026-08-15 on 2.1.2.0) depends on the network and on
  // whether the AL output cache is warm, so no gate can hold it.
  const pinned = report.validity.executionContexts.find((c) => c.platformAppsDir !== undefined);
  assert.ok(
    pinned !== undefined,
    "no execution context carries a `platformAppsDir` — this session did not pin al-runner's " +
      "platform-app directory, so every invocation paid --auto-provision again (R147). The run " +
      "emits an `al-runner-platform-apps-unpinned` warning naming the reason; read it rather than " +
      "guessing.",
  );
  assert.match(
    pinned.platformAppsDir ?? "",
    /platform-apps[\\/]?$/,
    "the pinned directory must be a platform-apps directory — anything else means the parse " +
      "matched a line it should not have",
  );
  console.log(`  platform apps pinned at: ${pinned.platformAppsDir}`);
}

/**
 * R242: the `--server` and resource legs must NOT record `platformAppsDir`. The daemon never
 * receives the pin, so a recorded directory there would be one the run never searched.
 */
function assertPlatformAppsNotRecorded(report: SessionReport, leg: string): void {
  const recorded = report.validity.executionContexts.filter((c) => c.platformAppsDir !== undefined);
  assert.equal(
    recorded.length,
    0,
    `R242: the ${leg} leg recorded platformAppsDir (${recorded.map((c) => c.platformAppsDir).join(", ")}), but --server never sends --package-cache`,
  );
}

function assertVerdictTable(report: SessionReport): void {
  // Always dump the per-mutant table BEFORE asserting — a bare count mismatch says nothing about
  // WHICH mutant moved, and this gate takes minutes to re-run. Mirrors bcdev.itest.ts.
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
  assert.equal(report.counts.noCoverage, EXPECTED.noCoverage, "noCoverage count mismatch");
  // R220, BY MUTANT rather than by count. A wrong attribution that loses four survivors in one
  // file and gains four no-coverage in another satisfies every count above and is exactly the
  // failure this gate exists to catch, so the file each no-coverage verdict lands in is named.
  const noCoverageFiles = report.mutants
    .filter((m) => m.verdict === "no-coverage")
    .map((m) => m.file);
  assert.equal(
    noCoverageFiles.every((f) => f.endsWith(EXPECTED_NO_COVERAGE_FILE)),
    true,
    `R220: every no-coverage mutant must be in ${EXPECTED_NO_COVERAGE_FILE}, got ${noCoverageFiles.join(", ")}`,
  );
  // And the converse: nothing in that file may be scored, since no test reaches it. Without this
  // the assertion above passes on an empty set.
  assert.equal(
    report.mutants.filter((m) => m.file.endsWith(EXPECTED_NO_COVERAGE_FILE)).length,
    EXPECTED.noCoverage,
    `R220: ${EXPECTED_NO_COVERAGE_FILE} must hold exactly ${EXPECTED.noCoverage} mutants, all no-coverage`,
  );
  // R198: al-runner has no RunMutantMany; 0 is also what an unwired counter reports, so this pins
  // only that the backend is untouched. The container gates carry the anti-inertness numbers.
  assert.equal(report.groupedCalls, 0, "R198: al-runner must make no grouped call");
  // R206: the sequential path records position 1 on every kill (one method per call, by
  // definition), replays nothing, and carries no session-warm caveat (no grouped call ran).
  assert.equal(report.warmKills, 0, "R206: al-runner cannot measure a warm kill");
  for (const m of report.mutants) {
    if (m.verdict !== "killed" && m.verdict !== "timeout-killed") continue;
    assert.equal(
      m.killPosition,
      1,
      `R206: ${m.mutantCode} killPosition ${m.killPosition}, expected 1 on the sequential path`,
    );
  }
  assert.ok(
    !report.validity.caveats.includes("session-warm"),
    "R206: a report with no grouped call must not carry the session-warm caveat",
  );
  assert.equal(report.counts.survived, EXPECTED.survived, "survived count mismatch");
  assert.equal(
    report.counts.noCoverage,
    EXPECTED.noCoverage,
    'al-runner reports coverage:"none" — no-coverage must never occur',
  );

  // R129: this run must SAY which BC runtime produced its verdicts. The gate's first line names the
  // al-runner BINARY, which is a different question — the binary selects a BC artifact build on its
  // own, announces it, and until R129 nothing read the line.
  //
  // Asserted as a SHAPE, never as a fixed version. Pinning a version here would fail every time
  // upstream ships a new binary, which is several times a day, and would be a version pin dressed
  // up as a regression test. What must not regress is that the field is populated at all.
  const announced = report.validity.executionContexts.find((c) => c.bcBuild !== undefined);
  assert.ok(
    announced !== undefined,
    "no execution context carries a `bcBuild` — al-runner announces its BC artifact selection on " +
      "every invocation (R129), so an absent field means the parse stopped matching (most likely " +
      "the runner reworded its `[bc]` line) and the report can no longer say which BC RUNTIME " +
      "produced these verdicts",
  );
  assert.match(
    announced.bcBuild ?? "",
    /^\d+\.\d+\.\d+\.\d+$/,
    "the recorded BC build must be a four-part version",
  );
  assert.ok(
    (announced.bcBuildAnnouncement ?? "").includes(announced.bcBuild ?? ""),
    "the verbatim announcement must contain the version parsed out of it — otherwise the two " +
      "fields describe different things and a reader cannot check the parse",
  );
  console.log(`  BC runtime under test: ${announced.bcBuild}`);

  const killed = report.mutants.filter((m) => m.verdict === "killed");
  assert.equal(killed.length, EXPECTED.killed);
  for (const m of killed) {
    assert.ok(
      m.file.includes("SandboxLogic"),
      `expected every killed mutant in SandboxLogic.Codeunit.al (IsOverBudget), got ${m.file}`,
    );
  }
  assert.deepEqual(
    [...new Set(killed.map((m) => m.operatorName))].sort(),
    ["lethal.conditional-boundary", "lethal.empty-block", "lethal.return-value"],
    "IsOverBudget must be killed by exactly its conditional-boundary, return-value, and whole-body empty-block mutants",
  );

  // R220 changed the VERDICT here without changing the claim, and the claim is the point.
  //
  // This assertion has always said: nothing in this suite calls `DiscountedPrice`, so nothing in
  // `SandboxPricing` may be killed. Before al-runner had `--coverage` the only way to say that was
  // `survived`, which is the verdict for "the tests ran and did not catch it" and was therefore
  // the wrong word for "no test ran at all". With coverage the run says the true thing, and it is
  // the same thing `itest:bcdev` has always said about these four.
  //
  // R159 made the count four: `lethal.swap-additive` claims the `Price - (Price * Pct / 100)` this
  // procedure returns. The count is pinned rather than the shape, so a mutant arriving here is a
  // deliberate edit.
  const fromPricing = report.mutants.filter((m) => m.file.includes("SandboxPricing"));
  assert.equal(
    fromPricing.length,
    4,
    "DiscountedPrice's mutant count changed — a deliberate edit, or a site moved",
  );
  assert.equal(
    fromPricing.filter((m) => m.verdict === "no-coverage").length,
    4,
    "DiscountedPrice is never called by any test — R220: its 4 mutants must be no-coverage, not survived and never killed",
  );

  // GH-24 plan Decision 11: al-runner has no attestation mechanism at all — `Reached` is a no-op
  // in its selectors, so no mutant may carry `guardReached`, whatever its grain. `reachGrain`
  // itself is still a compile-time fact and must still be written.
  printReachSummary(report);
  assertEveryMutantHasReachGrain(report);
  assertNoReachAttestation(report);
}

/**
 * Stamps the al-runner build this gate actually ran against, and refuses one it cannot identify.
 *
 * al-runner ships several times a day, and the binary here is a globally-installed dotnet tool that
 * `dotnet tool update` can move under us between one gate run and the next. Measured on 2026-08-07:
 * 2.0.0.0 reported a runner-enforced timeout as `TIMEOUT after <n>s`, and 2.0.1.0 — published the
 * same day — went back to `Test exceeded <n>s timeout.`. A frozen verdict table that does not say
 * which build produced it is a frozen table about nothing, and the first symptom of a silent tool
 * update is a "regression" in code that did not change. So the version goes in the log next to the
 * verdicts, every run.
 */
async function stampRunnerVersion(): Promise<void> {
  const proc = Bun.spawn([alRunnerPath, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const line = out.trim() || err.trim();
  assert.equal(
    exitCode,
    0,
    `al-runner --version exited ${exitCode} (${line}) — v1.0.31 rejected --version outright, so this is either a v1 binary or not al-runner. This gate is frozen against v2.`,
  );
  console.log(`  al-runner build under test: ${line}`);
}

/**
 * R321: the symbol fixture under `[LETHALA]` and `[LETHALB]`, through all three transports.
 *
 * Every check is COLLECTED and the gate fails once at the end, so a run shows every leg that saw a
 * wrong build rather than the first. A session that crashes still throws at once. Per leg: the table
 * is printed first, then the server legs are compared with the one-shot leg per mutant, then every
 * leg with the pre-committed table. The one-shot leg alone is compared with the frozen baseline,
 * AFTER its table check, so record mode can never record a leg that disagrees with the table.
 *
 * These legs do not assert the R147 platform pin; only the sandbox one-shot legs do.
 */
async function runSymbolLegs(): Promise<void> {
  const failures: string[] = [];
  const check = async (what: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED ${what}: ${message}`);
      failures.push(message);
    }
  };
  for (const symbols of SYMBOL_SETS) {
    const label = symbolSetLabel(symbols);
    const fixture: GateFixture = {
      projectDir: SYMBOL_PROJECT_DIR,
      testDir: SYMBOL_TEST_DIR,
      selectorIds: SYMBOL_SELECTOR_IDS,
      symbols,
    };
    const oneShotDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-sym-oneshot-"));
    const serverDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-sym-server-"));
    const resourceDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-sym-resource-"));
    try {
      const oneShot = await runOnce(oneShotDir, false, "static", fixture);
      printSymbolTable(oneShot, symbols, "one-shot");
      await check(`one-shot ${label}`, async () => {
        assertSymbolBuild(oneShot, symbols, "one-shot");
        await assertMatchesFrozenBaseline(
          oneShot,
          symbolBaselinePath(symbols),
          `al-runner itest ${label}`,
          RECORD_SYMBOL_BASELINES,
        );
      });

      const viaServer = await runOnce(serverDir, true, "static", fixture);
      printSymbolTable(viaServer, symbols, "--server");
      await check(`--server ${label}`, () => {
        assert.deepEqual(
          shape(viaServer),
          shape(oneShot),
          `R321 ${label}: the --server transport must reach the SAME per-mutant verdicts as the one-shot one`,
        );
        assertSymbolBuild(viaServer, symbols, "--server");
      });

      const viaResource = await runOnce(resourceDir, true, "resource", fixture);
      printSymbolTable(viaResource, symbols, "resource");
      await check(`resource ${label}`, () => {
        assert.deepEqual(
          shape(viaResource),
          shape(oneShot),
          `R321 ${label}: the resource selector must reach the SAME per-mutant verdicts as the one-shot one`,
        );
        assertSymbolBuild(viaResource, symbols, "resource");
      });

      console.log(
        `  symbol set ${label}: one-shot killed=${oneShot.counts.killed} survived=${oneShot.counts.survived} noCoverage=${oneShot.counts.noCoverage}`,
      );
    } finally {
      await rm(oneShotDir, { recursive: true, force: true });
      await rm(serverDir, { recursive: true, force: true });
      await rm(resourceDir, { recursive: true, force: true });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `R321: ${failures.length} symbol-leg check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
}

/**
 * R353: `sandbox-layout` at two batches, one-shot then `--server`. Only the one-shot leg can see a
 * coverage index kept across `deploy()` (R349): it names a covered line's procedure through the
 * index's line map, while the daemon names it itself. So `--server` is a CONTROL: it must match the
 * table in every run, and equal the one-shot leg exactly when the one-shot leg is right.
 *
 * Checks are collected and thrown once, so a red-check shows both legs. Returns the one-shot
 * report for `main()` to compare with the frozen baseline LAST, after every table check passed,
 * so a record run can never record a leg that disagrees with the pre-commitment.
 */
async function runLayoutLegs(): Promise<SessionReport> {
  const fixture: GateFixture = {
    projectDir: LAYOUT_PROJECT_DIR,
    testDir: LAYOUT_TEST_DIR,
    selectorIds: LAYOUT_SELECTOR_IDS,
    symbols: [],
    maxGuardsPerBatch: LAYOUT_MAX_GUARDS,
  };
  const failures: string[] = [];
  const check = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED ${what}: ${message}`);
      failures.push(message);
    }
  };
  const oneShotDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-layout-oneshot-"));
  const serverDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-layout-server-"));
  try {
    const oneShot = await runOnce(oneShotDir, false, "static", fixture);
    printLayoutTable(oneShot, "one-shot");
    check("layout one-shot", () => assertLayoutRun(oneShot, "one-shot"));

    const viaServer = await runOnce(serverDir, true, "static", fixture);
    printLayoutTable(viaServer, "--server");
    check("layout --server", () => assertLayoutRun(viaServer, "--server"));
    check("layout --server vs one-shot", () =>
      assertLayoutLegsEqual(oneShot, viaServer, "--server"),
    );

    if (failures.length > 0) {
      throw new Error(
        `R353: ${failures.length} layout-leg check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
      );
    }
    console.log(
      `  layout legs: one-shot killed=${oneShot.counts.killed} survived=${oneShot.counts.survived} noCoverage=${oneShot.counts.noCoverage}, --server identical`,
    );
    return oneShot;
  } finally {
    await rm(oneShotDir, { recursive: true, force: true });
    await rm(serverDir, { recursive: true, force: true });
  }
}

/** R387: the BC build and platform-app directory a report records, for printing beside another. */
function provenance(report: SessionReport): { bcBuild: string; platformAppsDir: string } {
  const ctx = report.validity.executionContexts;
  return {
    bcBuild: ctx.find((c) => c.bcBuild !== undefined)?.bcBuild ?? "<not recorded>",
    platformAppsDir:
      ctx.find((c) => c.platformAppsDir !== undefined)?.platformAppsDir ?? "<not recorded>",
  };
}

/**
 * R387: sandbox-app through `buildBackend` with an `alRunner` section that sets NO transport key,
 * so the leg measures what `lethal run --backend al-runner` does with no config. Runs after every
 * other leg (R345: one al-runner session at a time).
 *
 * Its table is pre-committed against leg A (`expectedCliDefaultShape`, CLI_DEFAULT_SPEC): equal per
 * mutant except `SandboxPricing`'s four, which are `survived` because coverage is off by default.
 * The table cannot tell the fast path from the one-shot static path, so the mechanism is checked
 * independently (`cliDefaultMechanismFailures`). Checks are collected and thrown once; the frozen
 * baseline is compared by `main()` AFTER they pass, so a record run never records a wrong leg.
 */
async function runCliDefaultLeg(legA: SessionReport): Promise<SessionReport> {
  const scratch = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-cli-default-"));
  const store = new ResultsStore(":memory:");
  const rec = recordSpawns(defaultSpawn, defaultServerSpawn);
  let backend: AlRunnerBackend | undefined;
  try {
    const built: ExecutionBackend = await buildBackend(
      { backendKind: "al-runner", projectDir: PROJECT_DIR, testDir: TEST_DIR },
      { alRunner: { alRunnerPath } },
      scratch,
      undefined,
      { alRunnerSpawn: rec.spawn, alRunnerServerSpawn: rec.serverSpawn },
      SELECTOR_IDS,
    );
    if (!(built instanceof AlRunnerBackend)) {
      throw new Error(
        "R387: buildBackend did not return an AlRunnerBackend for --backend al-runner",
      );
    }
    backend = built;
    // `buildBackend` gives the backend `<scratch>/al-runner-active`; `deploy()` copies into `active`.
    const resource = watchResourceSelector(backend, join(scratch, "al-runner-active", "active"));
    const report = await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratch, "instrumented"),
      selectorIds: SELECTOR_IDS,
    });

    console.log(
      `  cli-default leg: killed=${report.counts.killed} survived=${report.counts.survived} noCoverage=${report.counts.noCoverage}`,
    );
    for (const m of report.mutants) {
      console.log(`    ${m.mutantCode} ${m.verdict} ${m.file}:${m.line} ${m.operatorName}`);
    }
    console.log(
      `  cli-default mechanism: ${rec.record.serverArgv.length} daemon spawn(s), ${rec.record.oneShotArgv.length} one-shot spawn(s), ${resource.deploys} deploy(s), ${resource.activations} activation(s), ${resource.alHashes.size} distinct *.al text(s)`,
    );
    for (const argv of oneShotArgvSummary(rec.record)) console.log(`    one-shot argv: ${argv}`);
    // R387 plan 2a: server mode declines R147's pin, so the build and the platform apps can differ
    // from leg A's. RECORDED and printed, never asserted away. The daemon's own words only; nothing
    // is inferred when it does not name a directory.
    const a = provenance(legA);
    const d = provenance(report);
    console.log(`  BC build: leg A ${a.bcBuild}, cli-default ${d.bcBuild}`);
    if (a.bcBuild !== d.bcBuild) {
      console.warn(
        `  R387: the two transports selected DIFFERENT BC builds; see ${CLI_DEFAULT_SPEC}`,
      );
    }
    console.log(`  platform apps: leg A ${a.platformAppsDir}`);
    const named = daemonPlatformAppsLines(rec.record.serverStderr);
    console.log(
      named.length > 0
        ? `  platform apps, as the daemon named them: ${named.join(" | ")}`
        : "  platform apps: the daemon named no platform-app directory on stderr (a stated limit, not inferred)",
    );

    const failures: string[] = [];
    const check = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  FAILED ${what}: ${message}`);
        failures.push(message);
      }
    };
    check("cli-default counts", () => {
      assert.equal(
        report.baselineGreen,
        true,
        "R387: the cli-default leg's baseline must be green",
      );
      assert.deepEqual(
        {
          killed: report.counts.killed,
          survived: report.counts.survived,
          noCoverage: report.counts.noCoverage,
        },
        { killed: 3, survived: 16, noCoverage: 0 },
        `R387: the cli-default leg must be 3 / 16 / 0 (${CLI_DEFAULT_SPEC})`,
      );
    });
    check("cli-default table", () =>
      assert.deepEqual(
        legShape(report),
        expectedCliDefaultShape(legA),
        `R387: per-mutant verdicts differ from the pre-committed table (${CLI_DEFAULT_SPEC})`,
      ),
    );
    check("cli-default mechanism", () =>
      assert.deepEqual(
        cliDefaultMechanismFailures(rec.record, resource),
        [],
        "R387: the CLI defaults did not take effect (--server and the resource selector)",
      ),
    );
    if (failures.length > 0) {
      throw new Error(
        `R387: ${failures.length} cli-default check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
      );
    }
    return report;
  } finally {
    store.close();
    await backend?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  preflightGateBaseline(BASELINE_PATH, "al-runner itest");
  preflightGateBaseline(CLI_DEFAULT_BASELINE_PATH, "al-runner itest cli-default");
  preflightGateBaseline(LAYOUT_BASELINE_PATH, "al-runner itest layout");
  // Check BOTH symbol baselines before either leg runs: a missing file fails at startup rather
  // than after a live run, and record mode starts only when both files are in the state it needs.
  for (const symbols of SYMBOL_SETS) {
    preflightFrozenBaseline(
      symbolBaselinePath(symbols),
      "al-runner itest symbols",
      RECORD_SYMBOL_BASELINES,
    );
  }
  await stampRunnerVersion();
  const { files } = await generateMutationSet(join(PROJECT_DIR, "src"));
  const total = files.reduce((n, f) => n + f.specs.length, 0);
  assert.equal(
    total,
    EXPECTED.totalMutantSites,
    `expected ${EXPECTED.totalMutantSites} mutant sites across the fixture, generated ${total} — either the fixture changed or a tier-1 operator's targeting changed; update fixtures/README.md`,
  );

  const scratchA = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-a-"));
  const scratchB = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-b-"));
  const scratchC = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-server-"));
  const scratchD = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-resource-"));
  // R387: kept for the CLI-default leg, which runs last and is pre-committed against it.
  let legA: SessionReport | undefined;
  try {
    const first = await runOnce(scratchA);
    legA = first;
    assertVerdictTable(first);
    assertPlatformAppsPinned(first);
    // Per-mutant regression guard against the committed baseline — in addition to the aggregate
    // verdict counts assertVerdictTable already checked. A per-mutant difference fails the
    // itest even when killed/survived/no-coverage totals still match (Task 15, design spec §14).
    await assertGateBaseline(first, BASELINE_PATH, "al-runner itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second);
    assertPlatformAppsPinned(second);

    assert.deepEqual(
      shape(first),
      shape(second),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion)",
    );

    // R220 leg 3: the SAME fixture through `al-runner --server`, the warm daemon, which must reach
    // the same verdicts as the one-shot transport.
    //
    // This is the anti-inertness half of server mode. The two transports differ in every way that
    // could move a verdict -- one process per test against one warm process, one `--test` filter
    // against a whole-suite run served from a per-activation cache, Cobertura against
    // `perTestCoverage` -- so agreement here is evidence rather than a tautology. A cache that
    // outlived an `activate()` would show up as every mutant sharing the baseline's verdicts, and
    // a suite run that silently reused a previous compile would show up the same way.
    const viaServer = await runOnce(scratchC, true);
    assertVerdictTable(viaServer);
    assertPlatformAppsNotRecorded(viaServer, "--server");
    assert.deepEqual(
      shape(viaServer),
      shape(first),
      "R220: the --server transport must reach the SAME per-mutant verdicts as the one-shot one",
    );
    console.log(`  --server leg: ${viaServer.counts.killed} killed, verdicts identical`);

    // R222 leg 4: the RESOURCE selector, which compiles the bundle once and writes the active
    // mutant to a text file the compiled AL reads at runtime, instead of baking the id into AL and
    // recompiling per mutant.
    //
    // The verdicts must be identical AGAIN, and this leg is the one that can go wrong quietly. The
    // resource is read at runtime, so a selector that failed to re-read, or a file written after
    // the request started, would score a mutant against the PREVIOUS mutant's value and still
    // produce a plausible-looking table. Comparing per mutant against the static transports is
    // what catches that; a matching killed/survived/no-coverage count would not.
    const viaResource = await runOnce(scratchD, true, "resource");
    assertVerdictTable(viaResource);
    assertPlatformAppsNotRecorded(viaResource, "resource");
    assert.deepEqual(
      shape(viaResource),
      shape(first),
      "R222: the resource selector must reach the SAME per-mutant verdicts as the baked-in one",
    );
    console.log(`  resource-selector leg: ${viaResource.counts.killed} killed, verdicts identical`);
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
    await rm(scratchC, { recursive: true, force: true });
    await rm(scratchD, { recursive: true, force: true });
  }

  const layoutOneShot = await runLayoutLegs();
  await assertGateBaseline(layoutOneShot, LAYOUT_BASELINE_PATH, "al-runner itest layout");

  await runSymbolLegs();
  if (RECORD_SYMBOL_BASELINES) {
    // Decision 6: recording is not a measurement against a frozen table, so it is never a pass.
    console.log(
      "al-runner itest: RECORDED the symbol baselines; NOT a pass. Review them against the pre-commitment, commit, and re-run without LETHAL_ITEST_RECORD_SYMBOL_BASELINES.",
    );
    await emitFailed("alrunner", "record mode: symbol baselines recorded, not a pass");
    process.exit(3);
  }

  // R387: last, after every existing leg, against leg A's report.
  if (legA === undefined) throw new Error("R387: leg A produced no report to compare against");
  const cliDefault = await runCliDefaultLeg(legA);
  await assertGateBaseline(cliDefault, CLI_DEFAULT_BASELINE_PATH, "al-runner itest cli-default");

  console.log("al-runner itest: PASS");
  await emitPassed("alrunner", {
    sublegs: [
      "one-shot",
      "server",
      "resource",
      "platform-pin",
      "layout-one-shot",
      "layout-server",
      "cli-default",
    ],
    artifacts: { reported: false },
  });
}

main().catch(async (err: unknown) => {
  // R332: print the reason before any await, so an operator sees it on the console even when
  // the following receipt write is slow or the process is killed before it finishes.
  console.error(formatFailure(err));
  await emitFailed("alrunner", err instanceof Error ? err.message : String(err));
  process.exit(err instanceof BaselineRecordedError ? 3 : 1);
});
