#!/usr/bin/env bun
/**
 * Env-gated integration test: real `generateMutationSet` over the sandbox
 * fixture, real `AlRunnerBackend` (spawns the actual al-runner executable),
 * `:memory:` results store. NOT a `bun:test` file — it is a standalone
 * script invoked via `bun run itest:alrunner` (root package.json), never
 * picked up by `bun test`.
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
 * budget is the env var `AL_RUNNER_TEST_TIMEOUT_SEC`, not a flag. stdout carries a
 * human progress banner BEFORE the JSON, so the envelope has to be located rather
 * than parsed whole (`parseAlRunnerPayload`). Envelope: `{ tests: [{ name, status,
 * durationMs?, message?, stackTrace? }], passed, failed, errors, total, exitCode }` —
 * entry fields are `name`/`status`, not `method`/`result`, `name` is QUALIFIED, and
 * there is no `codeunit` field on an entry. Exit codes: 0 all passed, 1 at least one
 * test failed or errored, 2 a bundle could not execute, 3 a bundle could not compile.
 *
 * The v1 argv this replaced (`--run`, `--packages`, `--stubs`, `--test-timeout`,
 * `--test-isolation method`) is not merely deprecated — v2 rejects each of those as an
 * unknown option (exit 2). See `src/al-runner-transport.ts` for the measurements.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AlRunnerBackend } from "../src/al-runner-backend";
import { generateMutationSet, runSession } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { assertMatchesBaseline } from "./baseline-guard";

if (!process.env.LETHAL_ITEST_ALRUNNER) {
  console.log("skipped (set LETHAL_ITEST_ALRUNNER=1 and LETHAL_ALRUNNER_PATH=<path> to run)");
  process.exit(0);
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

// Hand-computed against fixtures/sandbox-app/src (see fixtures/README.md §Expected verdict table).
// al-runner reports coverage:"none", so the orchestrator never emits a "no-coverage" verdict —
// the 3 DiscountedPrice mutants (uncovered by any test) join the rest as "survived".
//
// 16 since the parenthesized-operand operator bug was fixed (findOperatorToken in
// packages/builtin-tier1/src/mutate-helpers.ts): ClampPercent's `(Value < 0) or
// (Value > 100)` now yields its negate-conditional mutant, which survives.
const EXPECTED = {
  totalMutantSites: 16,
  killed: 3,
  survived: 13,
  noCoverage: 0,
};

async function runOnce(scratchRoot: string): Promise<SessionReport> {
  const store = new ResultsStore(":memory:");
  try {
    const backend = new AlRunnerBackend({
      alRunnerPath,
      instrumentedDir: join(scratchRoot, "instrumented"),
      testDir: TEST_DIR,
      selectorObjectId: SELECTOR_IDS.selectorId,
    });
    return await runSession({
      backend,
      store,
      projectDir: PROJECT_DIR,
      testDir: TEST_DIR,
      instrumentedDir: join(scratchRoot, "instrumented"),
      selectorIds: SELECTOR_IDS,
    });
  } finally {
    store.close();
  }
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

  const survivedFromPricing = report.mutants.filter(
    (m) => m.verdict === "survived" && m.file.includes("SandboxPricing"),
  );
  assert.equal(
    survivedFromPricing.length,
    3,
    "DiscountedPrice is never called by any test — its 3 mutants must survive, not be killed",
  );
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

async function main(): Promise<void> {
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
  try {
    const first = await runOnce(scratchA);
    assertVerdictTable(first);
    // Per-mutant regression guard against the committed baseline — in addition to the aggregate
    // verdict counts assertVerdictTable already checked. A per-mutant difference fails the
    // itest even when killed/survived/no-coverage totals still match (Task 15, design spec §14).
    await assertMatchesBaseline(first, BASELINE_PATH, "al-runner itest");

    const second = await runOnce(scratchB);
    assertVerdictTable(second);

    const shape = (r: SessionReport) =>
      [...r.mutants]
        .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
        .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
    assert.deepEqual(
      shape(first),
      shape(second),
      "two consecutive runs must be 100% verdict-identical (determinism exit criterion)",
    );
  } finally {
    await rm(scratchA, { recursive: true, force: true });
    await rm(scratchB, { recursive: true, force: true });
  }

  console.log("al-runner itest: PASS");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
