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
 * CLI/JSON contract VERIFIED (2026-07-18) against a real al-runner install:
 * argv shape `--run <method> <instrumentedDir> <testDir> --output-json
 * --test-isolation method [--packages <dir>] [--stubs <dir>]`; JSON stdout
 * envelope `{ tests: [{ name, status, durationMs?, message?, stackTrace?,
 * alSourceLine?, alSourceColumn? }], passed, failed, errors, total,
 * exitCode }` — entry fields are `name`/`status`, not `method`/`result`, and
 * there is no `codeunit` field on an entry. Both confirmed in
 * `src/al-runner-backend.ts`.
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

async function main(): Promise<void> {
  const files = await generateMutationSet(join(PROJECT_DIR, "src"));
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
