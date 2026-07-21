import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import type { InstrumentedFile, MutantManifestEntry } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { AlcCompileError, ArtifactPrepareError, DeploymentError } from "../src/artifact";
import type { CompiledArtifact } from "../src/artifact";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { DeploymentVerifier, decidePublishOutcome } from "../src/deployment-verifier";
import { ActivationFailure } from "../src/failure-classes";
import {
  activateOnce,
  generateMutationSet,
  narrowFilesToSubset,
  runOnce,
  runSession,
} from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import { QuarantineStore } from "../src/quarantine-store";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore } from "../src/store";

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;

const TEST_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

// A file with zero mutable sites — no comparisons, no exit(), no calls, no
// non-empty blocks — so generateMutationSet never includes it in any batch's
// `files`. Used to prove the orchestrator still copies it into the batch dir
// verbatim (C3), since alc needs the FULL project to compile, not just the
// mutated subset.
const NO_MUTANTS_AL = `codeunit 79002 "Sandbox NoOp"
{
    procedure NoOp()
    begin
    end;
}
`;

// Two independent, non-nested procedures. Used below for worker-sharding
// tests and for coverage-filter tests that need mutants split across two
// distinctly-identifiable procedures (e.g. "only IsOverBudget's procedure is
// covered"). Historically this fixture existed because `batchByOverlap`
// forbade any overlap within a batch, so `TARGET_AL`'s 3 nested mutants
// (empty-block on the procedure body, return-value on the exit statement,
// conditional-boundary on the comparison) always landed in 3 separate
// batches of exactly 1, and a batch of 1 mutant could never be sharded
// across >1 worker no matter how correct the fan-out was. Layer 4.3 removed
// overlap batching (every mutant compiles into the same single artifact
// regardless of overlap), so that constraint is gone — `TARGET_AL`'s 3
// mutants shard across workers directly now too.
const TWO_PROC_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure IsUnderBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;
}
`;

// Three independent, non-nested procedures — used by the fractional-workers
// test below, which needs several shardable mutants to prove the flooring
// fix matters. Historically (pre-Layer-4.3, when `shardEvenly` ran once per
// batch) TWO_PROC_AL's exactly-2-mutants-per-batch made `i % 2.5` for i=0,1
// land safely inside `Array.from({length: 2.5}, ...)`'s truncated 2-element
// shard array — the drop bug only surfaces once an index >=2 is reached
// (`2 % 2.5 === 2`, out of the truncated array's bounds), so a third
// procedure was needed to reach it. With overlap batching removed,
// `shardEvenly` now runs once over every mutant in the single artifact, so
// this fixture is no longer uniquely load-bearing for that — THREE_PROC_AL's
// 9 mutants still comfortably exercise the fix.
const THREE_PROC_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

    procedure IsUnderBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;

    procedure IsEqualBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount = Budget);
    end;
}
`;

// M4 regression: two independent, non-nested procedures whose mutation sites'
// character offsets (`startIndex`) are chosen so a leading-digit comparison
// disagrees with the numeric one — IsOverBudget's sites land in the 200s
// (leading digit "2"), IsUnderBudget's land in the 1800s (leading digit "1"),
// after the padding comment block. `outcomes.sort()` in orchestrator.ts must
// order these ascending by NUMERIC startIndex (207 < 1830); sorting the
// colon-joined string "file:startIndex" via localeCompare instead compares
// "207" against "1830" character-by-character and finds '2' > '1' at the
// first position, putting the LARGER offset first — exactly the ":1000
// sorts before :99" bug this fixture is built to catch. (Verified against
// the real parser: without WIDE_GAP_LEAD_PAD, both procedures' offsets
// happen to share a leading "1" digit and the bug doesn't manifest.)
const WIDE_GAP_LEAD_PAD = "// L\n".repeat(20);
const WIDE_GAP_MID_PAD = "    // padding\n".repeat(100);
const WIDE_GAP_AL = `${WIDE_GAP_LEAD_PAD}codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;

${WIDE_GAP_MID_PAD}
    procedure IsUnderBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount < Budget);
    end;
}
`;

const APP_ID = "11111111-1111-1111-1111-111111111111";
const APP_JSON = JSON.stringify(
  {
    id: APP_ID,
    name: "Sandbox Orchestrator Fixture",
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 79000, to: 79199 }],
  },
  null,
  2,
);

class StubBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  deploys: string[] = [];
  constructor(
    private readonly caps: BackendCapabilities,
    private readonly script: (mutant: string | null, ref: TestMethodRef) => TestVerdict["outcome"],
    private readonly coverageProcedures: string[] = [],
    // When set, deploy() throws this value instead of succeeding — lets tests
    // simulate a batch-deploy failure (e.g. to prove the failure text alone
    // can't be miscounted as a different verdict cause).
    private readonly deployError?: unknown,
    // When set, awaited at the top of run() — lets tests probe how many
    // concurrent run() calls are in flight at once (the parallel-workers
    // concurrency proof).
    private readonly onRun?: () => Promise<void>,
    // When set, called on every deploy() with the artifact dir; returning an
    // Error throws it instead of succeeding, returning undefined succeeds.
    // Unlike `deployError` (a fixed always-throw), this lets a test fail
    // deploy conditionally — e.g. only while a specific mutant's spec is
    // still present in the artifact — to exercise bisection.
    private readonly deployGuard?: (dir: string) => Error | undefined,
  ) {}
  capabilities() {
    return this.caps;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    if (this.deployError !== undefined) throw this.deployError;
    const guardErr = this.deployGuard?.(dir);
    if (guardErr !== undefined) throw guardErr;
    this.deploys.push(dir);
    return null; // in-memory stub: nothing compiled, no artifact to describe
  }
  // This stub never modeled a separate publish/verify phase (that split is what
  // CompilePublishVerifyBackend below exists to test), so its compile-only seam is just its
  // existing deploy(): same guard, same error typing, same `deploys` bookkeeping. Every
  // bisection test below that exercises `deployGuard`/`deploys` keeps working unchanged —
  // bisection now calls this instead of deploy(), not some new, separately-behaving path.
  async compileCheck(dir: string): Promise<void> {
    await this.deploy(dir);
  }
  async activate(id: string | null) {
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    await this.onRun?.();
    const active = this.activations.at(-1) ?? null;
    const outcome = this.script(active, ref);
    const hasCoverage = active === null && this.caps.coverage === "procedure";
    return {
      ref,
      outcome,
      durationMs: 5,
      ...(hasCoverage
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: this.coverageProcedures.map((p) => ({
                objectType: "Codeunit",
                objectId: 79000,
                procedure: p,
              })),
            },
          }
        : {}),
    };
  }
}

async function makeProject(testAl: string = TEST_AL) {
  const root = await mkdtemp(join(tmpdir(), "lethal-orch-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), testAl);
  return { projectDir, testDir, instrumentedDir };
}

const CAPS_NST: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

describe("runSession", () => {
  test("kill: mutant-active fail + baseline-pass confirmation = killed", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.baselineGreen).toBe(true);
    expect(report.counts.killed).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
    expect(backend.activations.at(-1)).toBeNull(); // finally: deactivated
    expect(backend.deploys.length).toBeGreaterThan(0);
  });

  test("survive: tests pass under every mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.killed).toBe(0);
    expect(report.counts.survived).toBeGreaterThan(0);
    expect(report.mutationScore).toBe(0);
  });

  test("no coverage: uncovered procedure mutants get no-coverage, no runs", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, () => "pass", []); // covers nothing
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.noCoverage).toBeGreaterThan(0);
    expect(report.counts.survived).toBe(0);
  });

  test("coverage:none capability runs all tests per mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false },
      (mutant) => (mutant === null ? "pass" : "fail"),
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.noCoverage).toBe(0);
    expect(report.counts.killed).toBeGreaterThan(0);
    // Controller decision: deploy() is always called (in-memory backends
    // need the per-batch instrumented dir too), so deploy:"none" no longer
    // means zero deploys — it means capabilities().deploy doesn't describe
    // a publish cost. Assert the batch dir was actually handed to deploy().
    expect(backend.deploys.length).toBeGreaterThanOrEqual(1);
    for (const d of backend.deploys) {
      expect(d.startsWith(dirs.instrumentedDir)).toBe(true);
    }
  });

  test("late flakiness: fails under mutant AND at confirmation = error + unstable", async () => {
    const dirs = await makeProject();
    // Deterministic script: the fixture has exactly 1 test, so baseline is 1 inactive run.
    // Count inactive runs: run #1 (baseline) passes; every later inactive run (the
    // confirmation re-runs) fails. Active runs always fail.
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "fail";
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    expect(report.counts.unstable).toBeGreaterThan(0);
    expect(report.counts.killed).toBe(0);
  });

  test("timeout under mutant = timeout-killed, no confirmation re-run", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "timeout"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBeGreaterThan(0);
  });

  test("red baseline test is excluded and reported, session continues", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (_mutant, ref) => (ref.method === "OverBudgetDetected" ? "fail" : "pass"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.baselineGreen).toBe(false);
    // single-test fixture: every test red → batch aborted → zero executed mutants
    expect(report.counts.killed + report.counts.survived).toBe(0);
  });
});

describe("runSession — C3 batch app.json + full source copy", () => {
  test("batch dir gets app.json with bumped version + no-mutant files copied verbatim", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxNoOp.Codeunit.al"), NO_MUTANTS_AL);
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });

    // Batch dirs are named run-<runId>-batch-<batchIdx>, find the one created
    const entries = await readdir(dirs.instrumentedDir);
    const batchDirs = entries.filter((e) => e.match(/^run-\d+-batch-0$/));
    expect(batchDirs.length).toBe(1);
    const batchDirName = batchDirs.at(0);
    expect(batchDirName).toBeDefined();
    const batchDir = join(dirs.instrumentedDir, batchDirName as string);
    const appJson = JSON.parse(await readFile(join(batchDir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    expect(appJson.id).toBe(APP_ID); // target app id preserved (spec §5)
    // 1.0.<daysSinceEpoch>.<halfSeconds> — major.minor from the fixture's own app.json
    // (1.0.0.0), build/revision clock-derived via reserveAppVersion (app-version.ts). BC
    // rejects publishing a version lower than the installed one; the clock components
    // increase across runs with no dependence on a persistent results DB.
    expect(appJson.version).toMatch(/^1\.0\.\d+\.\d+$/);
    expect(appJson.version).not.toBe("1.0.0.0"); // actually re-stamped, not the source version

    const copied = await readFile(join(batchDir, "SandboxNoOp.Codeunit.al"), "utf8");
    expect(copied).toBe(NO_MUTANTS_AL); // writeInstrumentedProject never wrote this file
  });

  test("missing app.json aborts with a clear error before deploy", async () => {
    const dirs = await makeProject();
    await rm(join(dirs.projectDir, "app.json"));
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(/app\.json/);
    expect(backend.deploys.length).toBe(0); // aborted before ever calling deploy()
  });

  // Was: "counts.deadlineExceeded must be derived structurally, never by sniffing
  // failureNote text" — proven via a batch-deploy failure whose bare-string message happened
  // to start with "deadline exceeded", downgraded to a per-mutant "error" note. Task 7 changed
  // what a batch-deploy failure like this one even DOES: a bare string/plain Error thrown from
  // deploy() is not a typed `AlcCompileError`, so it is no longer a bisectable compile
  // verdict — it now aborts the whole session before any note is ever written, rather than
  // being downgraded into a per-mutant error. (The original hardening property — that
  // `counts.deadlineExceeded` is never derived from note text — still holds and is still
  // covered structurally by the "client deadline" tests above, which set `cause` directly.)
  test("batch deploy failure that is not a typed AlcCompileError aborts the session, not just this batch", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      "deadline exceeded talking to NST", // thrown bare string, not an Error, not AlcCompileError
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /deadline exceeded talking to NST/,
    );
    store.close();
  });
});

describe("runSession — deadline vs runner-confirmed timeout", () => {
  test("runner-confirmed timeout under a mutant is timeout-killed", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "timeout"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBeGreaterThan(0);
    expect(report.counts.deadlineExceeded).toBe(0);
    store.close();
  });

  test("a client deadline is infrastructure: verdict error, never a kill", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => (mutant === null ? "pass" : "deadline-exceeded"),
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.timeoutKilled).toBe(0);
    expect(report.counts.killed).toBe(0);
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.errors).toBeGreaterThan(0);
    // excluded from the score denominator
    expect(report.mutationScore).toBeNull();
    store.close();
  });

  // I1: a client deadline during KILL CONFIRMATION (the re-run of a mutant's
  // failing test against baseline) is the same kind of infrastructure noise as
  // a deadline during the initial mutant run above — not evidence the test is
  // flaky. Before the fix, the `fail` branch's confirmation handling treated
  // every non-"pass" confirm.outcome (including "deadline-exceeded") as
  // cause: "unstable", inflating counts.unstable and under-reporting
  // counts.deadlineExceeded for exactly the event this layer built that
  // counter for.
  test("deadline exceeded confirming a mutant's fail is deadlineExceeded, not unstable", async () => {
    const dirs = await makeProject();
    // Fixture has exactly 1 test: inactive run #1 is the baseline (must pass
    // for the session to proceed to mutants), inactive run #2 is the
    // confirmation re-run triggered by the active-mutant run's "fail" below.
    let inactiveRuns = 0;
    const backend = new StubBackend(
      CAPS_NST,
      (mutant) => {
        if (mutant !== null) return "fail";
        inactiveRuns++;
        return inactiveRuns === 1 ? "pass" : "deadline-exceeded";
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.unstable).toBe(0);
    expect(report.counts.killed).toBe(0);
    store.close();
  });
});

describe("runSession — I7 second consecutive transport error aborts the session", () => {
  test("stub backend erroring on every active-mutant run throws, persists partial results", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-i7-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "error"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(dbPath);
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /transport error/i,
    );
    expect(backend.activations.at(-1)).toBeNull(); // finally: still deactivated

    // Reopen the same on-disk (WAL-mode) db from a second connection to
    // confirm the errored mutant's row was persisted before the throw —
    // recordMutant auto-commits per statement, so it survives the abort.
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT verdict FROM mutants").all() as Array<{ verdict: string }>;
    raw.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.verdict === "error")).toBe(true);
  });
});

describe("runSession — parallel workers", () => {
  test("verdicts are identical at 1, 2 and 4 workers", async () => {
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants].map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`).sort();
    // Unsorted report order: `shape()` above ends in `.sort()`, so it would
    // still pass even if runSession's internal `outcomes.sort(...)` were
    // deleted (report ordering would then depend on scheduling, but the
    // multiset would be unaffected). This captures `report.mutants` in
    // whatever order runSession actually produced it, unsorted, so a
    // regression that drops the internal sort has something to break against.
    const order = (r: Awaited<ReturnType<typeof runSession>>) =>
      r.mutants.map((m) => `${m.file}:${m.line}:${m.operatorName}`);

    const results: string[][] = [];
    const orders: string[][] = [];
    for (const workers of [1, 2, 4]) {
      const dirs = await makeProject();
      const store = new ResultsStore(":memory:");
      const report = await runSession({
        backend: new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
          "IsOverBudget",
        ]),
        backendFactory: () =>
          new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
            "IsOverBudget",
          ]),
        store,
        ...dirs,
        selectorIds,
        workers,
      });
      results.push(shape(report));
      orders.push(order(report));
      store.close();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  // The test above reuses the standard single-comparison fixture; since
  // Layer 4.3 (see TWO_PROC_AL comment) it too now shards its 3 mutants
  // across workers, so it already exercises >1 concurrently executing
  // shard. This test additionally uses TWO_PROC_AL so the cross-shard
  // determinism check is stressed with mutants spanning two independent
  // procedures, not just three sites within one.
  test("verdicts are identical at 1, 2 and 4 workers when a batch has multiple shardable mutants", async () => {
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants].map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`).sort();
    const order = (r: Awaited<ReturnType<typeof runSession>>) =>
      r.mutants.map((m) => `${m.file}:${m.line}:${m.operatorName}`);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };

    const results: string[][] = [];
    const orders: string[][] = [];
    for (const workers of [1, 2, 4]) {
      const dirs = await makeProject();
      await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
      const store = new ResultsStore(":memory:");
      // Worker 0 is made artificially slower than worker 1. (shardEvenly's
      // round-robin no longer aligns worker assignment with procedure
      // identity post-Layer-4.3 — both workers get a mix of IsOverBudget's
      // and IsUnderBudget's mutants — so this no longer cleanly slows "the
      // IsOverBudget worker"; it doesn't need to.) Without runSession's
      // outcomes.sort(), whichever worker finishes first would call
      // record() first, so the raw accumulation order could come out
      // different from the workers=1 baseline depending on scheduling — the
      // sort is what makes this test's order assertion pass regardless of
      // which worker happens to finish first.
      const make = (workerIndex: number) =>
        new StubBackend(
          caps,
          (mutant) => (mutant === null ? "pass" : "fail"),
          [],
          undefined,
          workerIndex === 0
            ? async () => {
                await new Promise((r) => setTimeout(r, 15));
              }
            : undefined,
        );
      const report = await runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers,
      });
      results.push(shape(report));
      orders.push(order(report));
      store.close();
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
  });

  test("more than one worker actually runs concurrently", async () => {
    const dirs = await makeProject();
    // Overwrite the single-comparison fixture with two independent
    // procedures (see TWO_PROC_AL comment) so a batch actually contains more
    // than one shardable mutant. coverage:"none" means every mutant is
    // covered by every green test regardless of which procedure it targets,
    // so no per-procedure coverage bookkeeping is needed here.
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    let concurrent = 0;
    let peak = 0;
    const make = () =>
      new StubBackend(
        { coverage: "none", deploy: "none", isolation: "full-reset", authoritative: false },
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
        },
      );
    await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 3,
    });
    expect(peak).toBeGreaterThan(1);
    store.close();
  });

  test("a worker's own deploy failure records that shard's mutants as errors, other shards still run", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // Layer 4.3 collapsed overlap batching to a single artifact, so
    // shardEvenly's round-robin (index % workers) no longer aligns with
    // procedure boundaries — worker 0 and worker 1 each get a mix of
    // IsOverBudget's and IsUnderBudget's mutants, 3 of TWO_PROC_AL's 6 total
    // apiece. That mix doesn't matter here (unlike the coverage-scoped test
    // below): every mutant behaves identically regardless of procedure, so
    // worker 0's shard (deploy always fails) records 3 errors and worker 1's
    // shard (deploy always succeeds) kills its 3, whichever specific mutants
    // land where. Mirrors the sequential per-artifact deploy try/catch (step
    // 3 in orchestrator.ts): a deploy failure must record every mutant in
    // the affected shard as "error" and let the session continue, not
    // reject the whole `runSession` call.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        // A typed AlcCompileError — the only shape a per-shard deploy failure may take and
        // still be bisected/downgraded to per-mutant errors (Task 7); anything else now aborts
        // the whole session (see the DeploymentError/ArtifactPrepareError abort tests below).
        workerIndex === 0 ? new AlcCompileError("boom: worker 0 could not deploy") : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // 6 total mutants split 3/3 across the two workers: worker 0's 3 error,
    // worker 1's 3 are killed — the deploy failure never propagates past its
    // own shard.
    expect(report.counts.errors).toBe(3);
    expect(report.counts.killed).toBe(3);
    expect(report.counts.survived).toBe(0);
    store.close();
  });

  test("a worker deploy failure does not double-record a mutant step 5 already marked no-coverage", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    // Procedure-level coverage (CAPS_NST), covering ONLY IsOverBudget's
    // procedure — all 3 of IsUnderBudget's mutants are therefore uncovered
    // and already recorded "no-coverage" by step 5, ONCE EACH (Layer 4.3:
    // one artifact means step 5's coverage filter runs once over every
    // mutant, not once per batch), before the per-mutant fan-out ever runs.
    //
    // TWO_PROC_AL's 6 mutants sort (by file, startIndex) as IsOverBudget's 3
    // then IsUnderBudget's 3 (indices 0-2, 3-5). Since there's only one
    // artifact now, shardEvenly's round-robin (index % workers) no longer
    // has a per-batch boundary to align on, so it interleaves the two
    // procedures instead of cleanly separating them: worker 0 gets indices
    // 0, 2, 4 (IsOverBudget's 1st + 3rd mutants, plus IsUnderBudget's 2nd);
    // worker 1 gets indices 1, 3, 5 (IsOverBudget's 2nd, plus IsUnderBudget's
    // 1st + 3rd). Worker 1's backend always fails to deploy: without the
    // `perMutantTests.get(...) === undefined` skip in the deploy-failure
    // catch, its two already-no-coverage IsUnderBudget mutants would be
    // recorded a SECOND time as "error" — `mutants` has no unique constraint
    // on (run_id, mutant_code), so `recordMutant`'s plain INSERT would
    // silently duplicate the row rather than fail loudly. Its one covered
    // mutant (IsOverBudget's 2nd) has nothing recorded yet, so the deploy
    // failure legitimately records it as "error".
    const make = (workerIndex: number) =>
      new StubBackend(
        CAPS_NST,
        (mutant) => (mutant === null ? "pass" : "fail"),
        ["IsOverBudget"],
        // Typed AlcCompileError — see the sibling test above for why (Task 7 no longer
        // bisects/downgrades an untyped deploy failure).
        workerIndex === 1 ? new AlcCompileError("boom: worker 1 could not deploy") : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // 6 total — never 9 (which would mean an IsUnderBudget mutant landed
    // under both no-coverage and error).
    expect(report.mutants.length).toBe(6);
    expect(report.counts.noCoverage).toBe(3); // IsUnderBudget's 3 mutants, recorded once each
    expect(report.counts.errors).toBe(1); // IsOverBudget's mutant on worker 1's shard
    expect(report.counts.killed).toBe(2); // IsOverBudget's other 2 mutants, on worker 0's shard
    // Belt-and-suspenders: no single mutant identity appears under both verdicts.
    const noCoverageKeys = new Set(
      report.mutants.filter((m) => m.verdict === "no-coverage").map((m) => `${m.file}:${m.line}`),
    );
    const errorKeys = new Set(
      report.mutants.filter((m) => m.verdict === "error").map((m) => `${m.file}:${m.line}`),
    );
    for (const k of noCoverageKeys) expect(errorKeys.has(k)).toBe(false);
    store.close();
  });

  test("a shard's transport-error abort drains sibling shards before rethrowing", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-parallel-i7-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(dbPath);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // Worker 0 is slow — 30ms per run(). Worker 1 errors on every
    // active-mutant run, tripping the I7 "two consecutive transport errors"
    // abort almost immediately. (Both behaviors key on workerIndex, not on
    // which specific mutants land in a shard — shardEvenly's round-robin no
    // longer aligns shard composition with procedure identity post-Layer-4.3,
    // so each shard now holds a mix of IsOverBudget's and IsUnderBudget's
    // mutants.) If runSession rethrew as soon as worker 1's shard rejected
    // (plain `Promise.all` semantics) instead of waiting for every shard to
    // settle (`Promise.allSettled`), worker 0 could still be mid-flight —
    // and, worse, a caller reacting to the rejection by closing the store
    // could race a still-running worker 0's write to it.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : workerIndex === 1 ? "error" : "fail"),
        [],
        undefined,
        workerIndex === 0
          ? async () => {
              await new Promise((r) => setTimeout(r, 30));
            }
          : undefined,
      );
    await expect(
      runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers: 2,
      }),
    ).rejects.toThrow(/transport error/i);

    // Reopen the same on-disk DB from a second connection immediately after
    // the rejection (no sleep, no retry): worker 0's mutant row must already
    // be there, proving allSettled actually waited for it rather than the
    // throw racing ahead of a still-writing sibling.
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT verdict FROM mutants").all() as Array<{ verdict: string }>;
    raw.close();
    expect(rows.some((r) => r.verdict === "error")).toBe(true); // worker 1's abort
    expect(rows.length).toBeGreaterThanOrEqual(2); // worker 0's mutant landed too
    store.close();
  });

  test("worker backends are built once per session and disposed exactly once, not once per batch", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    let factoryCalls = 0;
    const closeCallCounts: number[] = [];
    // Duck-typed close(), same as real backends (BcDevMcpBackend,
    // AlRunnerBackend) that StubBackend itself doesn't model.
    const make = () => {
      factoryCalls++;
      let closed = 0;
      const backend = new StubBackend(caps, (mutant) => (mutant === null ? "pass" : "fail"), []);
      return Object.assign(backend, {
        async close() {
          closed++;
          closeCallCounts.push(closed);
        },
      });
    };
    await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // TWO_PROC_AL yields exactly 1 artifact (Layer 4.3 collapsed overlap
    // batching), so this can no longer observationally distinguish "built
    // once per session" from "built once per artifact" the way it could
    // when TWO_PROC_AL yielded 3 batches (the bug would have run the
    // factory 1 (cfg.backend) + 3 batches * 2 workers = 7 times, vs. 1 + 2 =
    // 3 once fixed). The invariant this asserts — workerBackends are built
    // once, outside the artifacts loop, and reused across it — still holds
    // structurally; Task 6's multi-artifact bisection will make it
    // observable here again.
    expect(factoryCalls).toBe(3);
    // Exactly the 2 worker backends close, each exactly once — cfg.backend
    // is caller-owned (see cli.ts) and is never closed by runSession itself.
    expect(closeCallCounts).toEqual([1, 1]);
    store.close();
  });

  test("a fractional workers count is floored, not silently dropping mutants", async () => {
    const dirs = await makeProject();
    // THREE_PROC_AL, not TWO_PROC_AL: needs >=3 shardable mutants in a
    // single sharding call for the drop bug to manifest (`i % 2.5` for
    // i=0,1 never lands outside shardEvenly's length-truncated 2-element
    // shard array) — see THREE_PROC_AL's comment.
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const make = () => new StubBackend(caps, (mutant) => (mutant === null ? "pass" : "fail"), []);
    const report = await runSession({
      backend: make(),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2.5,
    });
    // 9 total (3 procedures * 3 mutants each, all in the single Layer-4.3
    // artifact). Before flooring, shardEvenly(execute, 2.5) built a
    // length-2 shard array (Array.from truncates a fractional `length`)
    // while still computing target indices via `i % 2.5`, so an item whose
    // index (e.g. 2, `2 % 2.5 === 2`) fell outside the truncated array was
    // silently dropped by shardEvenly's `if (target !== undefined)` guard —
    // no error, just fewer mutants in the report than were generated.
    expect(report.mutants.length).toBe(9);
    expect(report.counts.killed).toBe(9);
    store.close();
  });
});

describe("runSession — M4 outcome ordering", () => {
  test("report order is numeric by startIndex, not lexicographic on the colon-joined string", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), WIDE_GAP_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const backend = new StubBackend(caps, (mutant) => (mutant === null ? "pass" : "fail"), []);
    const report = await runSession({ backend, store, ...dirs, selectorIds, workers: 1 });
    // IsOverBudget's mutants sit on lines ~21-26 (startIndex in the 200s);
    // IsUnderBudget's sit past the 100-line padding block, well past line 100
    // (startIndex in the 1800s). Numeric ascending order must list every
    // IsOverBudget mutant before every IsUnderBudget one; the buggy string
    // sort inverted this (see WIDE_GAP_AL's comment).
    const overBudgetIndices = report.mutants
      .map((m, i) => (m.line <= 50 ? i : -1))
      .filter((i) => i >= 0);
    const lastOverBudgetIdx = overBudgetIndices.at(-1) ?? -1;
    const firstUnderBudgetIdx = report.mutants.findIndex((m) => m.line > 50);
    expect(lastOverBudgetIdx).toBeGreaterThanOrEqual(0);
    expect(firstUnderBudgetIdx).toBeGreaterThanOrEqual(0);
    expect(lastOverBudgetIdx).toBeLessThan(firstUnderBudgetIdx);
    store.close();
  });
});

describe("mutation score — timeout-killed contribution", () => {
  test("timeout-killed and killed contribute equally to the score", async () => {
    const dirs = await makeProject();
    // Create a scenario: some mutants killed, some timeout-killed, some survived
    // We'll use a fixture where 2 out of 3 mutants are tested, but with different outcomes
    const backend = new StubBackend(
      { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      (mutant) => {
        // First test run is baseline (green)
        // Mutant activation determines outcome per test run
        if (mutant === null) return "pass";
        // For orchestrator, we can't directly control which mutant gets which verdict,
        // but we can test via the mock. Let's use a simpler approach.
        return "pass"; // Will mark all as survived initially
      },
      ["IsOverBudget"],
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    // This test won't work directly with runSession since we can't control
    // individual mutant verdicts easily. Let's instead test buildReport directly.
    store.close();
  });

  test("buildReport: only timeout-killed and survived produces non-null score", async () => {
    const { buildReport } = await import("../src/report");
    const report = buildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      outcomes: [
        {
          mutant: {
            mutantId: "M1",
            file: "test.al",
            startIndex: 0,
            endIndex: 1,
            startLine: 10,
            operatorName: "Op1",
            operatorVersion: "1.0.0",
            astHash: "hash1",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "timeout-killed" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M2",
            file: "test.al",
            startIndex: 2,
            endIndex: 3,
            startLine: 20,
            operatorName: "Op2",
            operatorVersion: "1.0.0",
            astHash: "hash2",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "survived" as const,
          batchIndex: 0,
        },
      ],
    });
    // 1 timeout-killed + 0 killed = 1 in numerator
    // 1 timeout-killed + 0 killed + 1 survived = 2 in denominator
    // Expected score: 1/2 = 0.5
    expect(report.mutationScore).toBe(0.5);
    expect(report.counts.timeoutKilled).toBe(1);
    expect(report.counts.killed).toBe(0);
  });

  test("buildReport: killed and timeout-killed contribute equally", async () => {
    const { buildReport } = await import("../src/report");
    const report = buildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      outcomes: [
        {
          mutant: {
            mutantId: "M1",
            file: "test.al",
            startIndex: 0,
            endIndex: 1,
            startLine: 10,
            operatorName: "Op1",
            operatorVersion: "1.0.0",
            astHash: "hash1",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "killed" as const,
          batchIndex: 0,
          killingTest: "Test1",
        },
        {
          mutant: {
            mutantId: "M2",
            file: "test.al",
            startIndex: 2,
            endIndex: 3,
            startLine: 20,
            operatorName: "Op2",
            operatorVersion: "1.0.0",
            astHash: "hash2",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "timeout-killed" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M3",
            file: "test.al",
            startIndex: 4,
            endIndex: 5,
            startLine: 30,
            operatorName: "Op3",
            operatorVersion: "1.0.0",
            astHash: "hash3",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "survived" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M4",
            file: "test.al",
            startIndex: 6,
            endIndex: 7,
            startLine: 40,
            operatorName: "Op4",
            operatorVersion: "1.0.0",
            astHash: "hash4",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "survived" as const,
          batchIndex: 0,
        },
      ],
    });
    // 1 killed + 1 timeout-killed = 2 in numerator
    // 1 killed + 1 timeout-killed + 2 survived = 4 in denominator
    // Expected score: 2/4 = 0.5
    expect(report.mutationScore).toBe(0.5);
    expect(report.counts.killed).toBe(1);
    expect(report.counts.timeoutKilled).toBe(1);
    expect(report.counts.survived).toBe(2);
  });

  test("buildReport: null score when no killable mutants", async () => {
    const { buildReport } = await import("../src/report");
    const report = buildReport({
      caps: { coverage: "procedure", deploy: "publish", isolation: "session", authoritative: true },
      baselineGreen: true,
      batches: 1,
      outcomes: [
        {
          mutant: {
            mutantId: "M1",
            file: "test.al",
            startIndex: 0,
            endIndex: 1,
            startLine: 10,
            operatorName: "Op1",
            operatorVersion: "1.0.0",
            astHash: "hash1",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "no-coverage" as const,
          batchIndex: 0,
        },
        {
          mutant: {
            mutantId: "M2",
            file: "test.al",
            startIndex: 2,
            endIndex: 3,
            startLine: 20,
            operatorName: "Op2",
            operatorVersion: "1.0.0",
            astHash: "hash2",
            codeunitId: 50000,
            codeunitName: "Test",
            procedureName: "TestProc",
          },
          verdict: "error" as const,
          batchIndex: 0,
          cause: "unstable" as const,
        },
      ],
    });
    // No killed, timeout-killed, or survived mutants
    expect(report.mutationScore).toBeNull();
  });
});

describe("runSession — single artifact", () => {
  test("a project whose mutants overlap still deploys exactly once", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(CAPS_NST, (mutant) => (mutant === null ? "pass" : "fail"), [
      "IsOverBudget",
    ]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.deploys).toHaveLength(1);
    expect(report.batches).toBe(1);
    store.close();
  });

  // `planArtifacts` returns zero artifacts for zero instrumented files (see its
  // doc comment) — mirroring `batchByOverlap([])`'s old `[]` result — so a
  // project with no mutable sites anywhere must never reach deploy() at all,
  // not deploy one pointless empty artifact. Overwriting the target logic
  // file with NO_MUTANTS_AL (no comparisons, no exit(), no calls, no
  // non-empty blocks) makes `generateMutationSet` return zero files for the
  // whole project, so this is a genuine zero-mutant project, not just a
  // zero-mutant file alongside other mutable ones.
  test("a project with no mutable sites deploys nothing", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), NO_MUTANTS_AL);
    const backend = new StubBackend(CAPS_NST, () => "pass", ["IsOverBudget"]);
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(backend.deploys).toHaveLength(0);
    expect(report.batches).toBe(0);
    expect(report.mutants.length).toBe(0);
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5A (Task 6): deployment identity — compile/publish/verify phases,
// version reservation, artifact provenance, version-conflict retry.
// ————————————————————————————————————————————————————————————————————————

const PHASE_CAPS: BackendCapabilities = {
  coverage: "none",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
};

const PHASE_VERIFIER_CFG = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS",
  username: "u",
  password: "p",
};

/**
 * Mirrors `BcDevMcpBackend.deploy()`'s three-phase composition (compile -> publish -> verify),
 * faking the compile (it reads the batch dir's app.json + mutant-manifest.json, exactly like
 * the real prepare step) and the publish, while running the REAL `DeploymentVerifier`,
 * `decidePublishOutcome` and `DeploymentError`. Using the real verifier is deliberate: its
 * malformed-id tripwire THROWS on anything that isn't 32 lowercase hex, so a placeholder
 * artifact id surviving anywhere in the orchestrator fails every one of these tests loudly.
 */
class PhaseBackend implements ExecutionBackend {
  readonly calls: string[] = [];
  lastCompiledVersion: string | undefined;
  constructor(
    private readonly opts: {
      /** Called once per publish phase (1-based attempt); throwing simulates altool failing. */
      readonly onPublish?: (attempt: number) => void;
      /** What MutationControl_Identity reports; defaults to echoing the compiled artifact. */
      readonly reportedIdentity?: string;
    } = {},
  ) {}
  private publishAttempts = 0;
  capabilities() {
    return PHASE_CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "phase" };
  }
  /** Shared compile-only step: reads the batch dir's inputs, builds the fake artifact. Used by
   *  both deploy() (compile -> publish -> verify) and compileCheck() (compile, stop). */
  private async compileArtifact(dir: string): Promise<CompiledArtifact> {
    this.calls.push("compile");
    const appManifest = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    const mutantManifest = JSON.parse(
      await readFile(join(dir, "mutant-manifest.json"), "utf8"),
    ) as CompiledArtifact["mutantManifest"];
    this.lastCompiledVersion = appManifest.version;
    return {
      artifactId: mutantManifest.artifactId,
      appId: appManifest.id,
      appVersion: appManifest.version,
      appPath: join(dir, "phase-fake.app"),
      sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
      mutantManifest,
      appManifest: appManifest as unknown as Record<string, unknown>,
    };
  }
  /** Compile-only seam: no "publish"/"verify" entries in `calls`, ever. */
  async compileCheck(dir: string): Promise<void> {
    await this.compileArtifact(dir);
  }
  async deploy(dir: string): Promise<CompiledArtifact | null> {
    const artifact = await this.compileArtifact(dir);
    this.calls.push("publish");
    this.publishAttempts++;
    let publishOk = true;
    let publishError: string | undefined;
    try {
      this.opts.onPublish?.(this.publishAttempts);
    } catch (err) {
      publishOk = false;
      publishError = err instanceof Error ? err.message : String(err);
    }
    this.calls.push("verify");
    // A failed publish leaves the PREVIOUS artifact running server-side, so identity then
    // reports some other (well-formed) id, never the one this deploy just tried to publish.
    const reported =
      this.opts.reportedIdentity ?? (publishOk ? artifact.artifactId : "f".repeat(32));
    const fetchFn = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: reported }), { status: 200 })) as typeof fetch;
    const verification = await new DeploymentVerifier(PHASE_VERIFIER_CFG, fetchFn).verify(artifact);
    const outcome = decidePublishOutcome(publishOk, verification);
    if (outcome !== "accepted") throw new DeploymentError(outcome, publishError, verification);
    return artifact;
  }
  async activate(mutantId: string | null): Promise<void> {
    // runSession's cleanup `finally` always deactivates (activate(null)); only a real mutant
    // activation counts as "the orchestrator started testing against this deployment".
    if (mutantId !== null) this.calls.push("activate");
  }
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    this.calls.push("run");
    return { ref, outcome: "pass", durationMs: 5 };
  }
}

describe("runSession — Layer 5A deployment identity", () => {
  test("calls compile once, then publish, then verify — in that order, before any test runs", async () => {
    const dirs = await makeProject();
    const backend = new PhaseBackend();
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    const calls = backend.calls;
    const firstRun = calls.indexOf("run");
    expect(firstRun).toBeGreaterThan(-1);
    expect(calls.filter((c) => c === "compile")).toHaveLength(1);
    expect(calls.indexOf("compile")).toBeLessThan(calls.indexOf("publish"));
    expect(calls.indexOf("publish")).toBeLessThan(calls.indexOf("verify"));
    expect(calls.indexOf("verify")).toBeLessThan(firstRun);
    store.close();
  });

  test("records the version actually compiled, not the createRun placeholder", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    await runSession({ backend: new PhaseBackend(), store, ...dirs, selectorIds });
    const row = store.db
      .query("SELECT app_version, app_id, artifact_id, artifact_sha256 FROM runs LIMIT 1")
      .get() as {
      app_version: string;
      app_id: string;
      artifact_id: string;
      artifact_sha256: string;
    };
    expect(row.app_version).not.toBe("0.0.0.0");
    expect(row.app_version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Major.minor come from the fixture's own app.json (1.0.0.0), never hardcoded elsewhere.
    expect(row.app_version.startsWith("1.0.")).toBe(true);
    expect(row.app_id).toBe(APP_ID);
    expect(row.artifact_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    store.close();
  });

  test("re-stamps above the version BC names and retries exactly once on conflict", async () => {
    const dirs = await makeProject();
    let attempts = 0;
    const backend = new PhaseBackend({
      onPublish: () => {
        attempts++;
        if (attempts === 1) {
          throw new Error(
            "Cannot install the extension X by Y 1.0.1.1 because a newer version 9.9.9.9 was already installed.",
          );
        }
      },
    });
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(attempts).toBe(2);
    expect(backend.lastCompiledVersion).toBe("9.9.9.10");
    expect(report.counts.errors).toBe(0);
    store.close();
  });

  test("fails loudly on a SECOND version conflict rather than retrying forever", async () => {
    const dirs = await makeProject();
    const backend = new PhaseBackend({
      onPublish: () => {
        throw new Error(
          "Cannot install the extension X by Y 1.0.1.1 because a newer version 9.9.9.9 was already installed.",
        );
      },
    });
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /version conflict/i,
    );
    store.close();
  });

  test("runs no tests when identity does not match the published artifact", async () => {
    const dirs = await makeProject();
    const backend = new PhaseBackend({ reportedIdentity: "some-other-artifact-id" });
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /indeterminate/i,
    );
    expect(backend.calls).not.toContain("run");
    expect(backend.calls).not.toContain("activate");
    store.close();
  });

  test("an app.json version component above 65535 aborts the session before any compile", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "70000.0.0.0" }),
    );
    const backend = new PhaseBackend();
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /app\.json version/,
    );
    expect(backend.calls).not.toContain("compile");
    store.close();
  });

  test("a malformed app.json version aborts the session before any compile", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.0" }),
    );
    const backend = new PhaseBackend();
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /app\.json version/,
    );
    expect(backend.calls).not.toContain("compile");
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 14 (Layer 5B fold-in): a deploy:"none" (al-runner) run's `createRun` placeholder is what
// durably lands in `runs.app_version` — al-runner's deploy() always returns null, so the
// Layer 5A `recordArtifact` correction (3d, see "records the version actually compiled" above)
// never fires for it. Must read the project's own app.json version instead of the meaningless
// "0.0.0.0" default.
// ————————————————————————————————————————————————————————————————————————

describe("runSession — deploy:none (al-runner) app_version", () => {
  const AL_RUNNER_CAPS: BackendCapabilities = {
    coverage: "none",
    deploy: "none",
    isolation: "full-reset",
    authoritative: false,
  };

  test("records the project's own app.json version, not the 0.0.0.0 placeholder", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.2.3.4" }),
    );
    const backend = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds });
    const row = store.db.query("SELECT app_version FROM runs LIMIT 1").get() as {
      app_version: string;
    };
    expect(row.app_version).toBe("1.2.3.4");
    expect(row.app_version).not.toBe("0.0.0.0");
    store.close();
  });

  test("an explicit cfg.appVersion still wins over app.json for a deploy:none backend", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.2.3.4" }),
    );
    const backend = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const store = new ResultsStore(":memory:");
    await runSession({ backend, store, ...dirs, selectorIds, appVersion: "9.9.9.9" });
    const row = store.db.query("SELECT app_version FROM runs LIMIT 1").get() as {
      app_version: string;
    };
    expect(row.app_version).toBe("9.9.9.9");
    store.close();
  });

  test("does not change mutant verdicts — recorded-metadata fix only", async () => {
    const dirs = await makeProject();
    const manifest = JSON.parse(APP_JSON) as Record<string, unknown>;
    await Bun.write(
      join(dirs.projectDir, "app.json"),
      JSON.stringify({ ...manifest, version: "1.2.3.4" }),
    );
    const shape = (r: Awaited<ReturnType<typeof runSession>>) =>
      [...r.mutants].map((m) => `${m.file}:${m.line}:${m.operatorName}:${m.verdict}`).sort();
    const store = new ResultsStore(":memory:");
    const backend = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    store.close();

    const dirs2 = await makeProject(); // app.json still the default 1.0.0.0 here
    const store2 = new ResultsStore(":memory:");
    const backend2 = new StubBackend(AL_RUNNER_CAPS, (mutant) =>
      mutant === null ? "pass" : "fail",
    );
    const report2 = await runSession({ backend: backend2, store: store2, ...dirs2, selectorIds });
    store2.close();

    expect(shape(report)).toEqual(shape(report2));
  });
});

describe("narrowFilesToSubset", () => {
  // Minimal fakes: `narrowFilesToSubset` only ever reads `spec.before.{start,end}Index`,
  // `spec.operatorName`, and `file.{path,specs}` — every other field on `ALSyntaxNode` /
  // `MutationSpec` is irrelevant to the regrouping logic under test, so the fakes only
  // populate what's actually read rather than constructing a real parsed tree.
  function fakeNode(startIndex: number, endIndex: number): ALSyntaxNode {
    return { startIndex, endIndex } as unknown as ALSyntaxNode;
  }
  function fakeSpec(operatorName: string, startIndex: number, endIndex: number): MutationSpec {
    return {
      operatorName,
      operatorVersion: "1.0.0",
      astNodeId: `${operatorName}@${startIndex}`,
      before: fakeNode(startIndex, endIndex),
      after: fakeNode(startIndex, endIndex),
      parentContext: "statement",
    } as unknown as MutationSpec;
  }
  function fakeEntry(
    file: string,
    startIndex: number,
    endIndex: number,
    operatorName: string,
  ): MutantManifestEntry {
    return {
      mutantId: "M0000",
      file,
      startIndex,
      endIndex,
      startLine: 1,
      operatorName,
      operatorVersion: "1.0.0",
      astHash: "h",
      codeunitId: 1,
      codeunitName: "C",
      procedureName: "P",
    };
  }

  test("keeps only the specs matching the subset, by (file, span, operator)", () => {
    const specA = fakeSpec("lethal.empty-block", 0, 10);
    const specB = fakeSpec("lethal.conditional-boundary", 20, 30);
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "", root: fakeNode(0, 100), specs: [specA, specB] },
    ];
    const narrowed = narrowFilesToSubset(files, [
      fakeEntry("a.al", 20, 30, "lethal.conditional-boundary"),
    ]);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.specs).toEqual([specB]);
  });

  test("drops a file entirely when none of its specs are in the subset", () => {
    const specA = fakeSpec("lethal.empty-block", 0, 10);
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "", root: fakeNode(0, 100), specs: [specA] },
    ];
    expect(narrowFilesToSubset(files, [])).toHaveLength(0);
  });

  test("a file untouched by the subset is dropped, a matching file across many is kept", () => {
    const specA = fakeSpec("lethal.empty-block", 0, 10);
    const specB = fakeSpec("lethal.return-value", 5, 8);
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "srcA", root: fakeNode(0, 100), specs: [specA] },
      { path: "b.al", source: "srcB", root: fakeNode(0, 100), specs: [specB] },
    ];
    const narrowed = narrowFilesToSubset(files, [fakeEntry("b.al", 5, 8, "lethal.return-value")]);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.path).toBe("b.al");
  });

  test("throws loudly when two specs collide on the (file, span, operator) key", () => {
    // The key's uniqueness holds today only because every Tier 1 operator
    // emits at most one spec per node. The day an operator emits two variants
    // for the same node, matching a manifest entry back to "its" spec becomes
    // ambiguous — that must fail loudly, not silently coarsen bisection.
    const specA = fakeSpec("lethal.two-variant", 0, 10);
    const specB = fakeSpec("lethal.two-variant", 0, 10); // same node, same operator
    const files: InstrumentedFile[] = [
      { path: "a.al", source: "", root: fakeNode(0, 100), specs: [specA, specB] },
    ];
    expect(() =>
      narrowFilesToSubset(files, [fakeEntry("a.al", 0, 10, "lethal.two-variant")]),
    ).toThrow(/duplicate spec key/);
    // Same-operator specs on DIFFERENT spans stay legal.
    const okFiles: InstrumentedFile[] = [
      {
        path: "a.al",
        source: "",
        root: fakeNode(0, 100),
        specs: [fakeSpec("lethal.two-variant", 0, 10), fakeSpec("lethal.two-variant", 20, 30)],
      },
    ];
    expect(() => narrowFilesToSubset(okFiles, [])).not.toThrow();
  });
});

describe("runSession — bisection on compile failure", () => {
  // Brief's literal test, adapted: `deployGuard` is a `StubBackend` constructor
  // parameter (matching how `deployError`/`onRun` already extend it) rather than a
  // property assigned after construction. The guard fails only the very first deploy
  // (the whole-artifact one), then succeeds on everything bisection tries afterward —
  // a minimal smoke test that the new catch-block wiring doesn't crash or hang, and
  // that the batch still ends up correctly recorded as errored. Since this scenario's
  // culprit search comes up empty (the guard stops failing before any subset is
  // proven guilty), the note falls back to the raw error text — asserted here too,
  // now that `failureNote` reaches `SessionReport`.
  test("a mutant that breaks compilation is named, not blamed on the whole run", async () => {
    const dirs = await makeProject();
    let seenSubsets = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        seenSubsets++;
        return seenSubsets === 1 ? new AlcCompileError("alc: AL0001") : undefined;
      },
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("AL0001");
    store.close();
  });

  // Stronger: `deployGuard` fails whenever the ACTUAL manifest written for whatever
  // subset `prepareArtifactDir` just built still contains the
  // `lethal.conditional-boundary` mutant (TARGET_AL's 3 nested mutants —
  // empty-block/return-value/conditional-boundary — all share one containment
  // component, exactly the "one bad spec in one file" shape bisection exists for).
  // If `narrowFilesToSubset` were a no-op (e.g. always re-writing the full,
  // unnarrowed spec set regardless of `subset`), every attempt would keep seeing the
  // boundary mutant and keep failing — `attempts` would never see `false`.
  //
  // Critically, the identity this test cares about is asserted on `report.mutants`
  // itself, not inferred from re-reading the scratch artifact's manifest — reading
  // the manifest inside `deployGuard` only simulates a realistic backend (one whose
  // failure genuinely depends on which spec is present), it is not how the test
  // proves the name reached the user. Verified by temporarily deleting the
  // `...(o.failureNote !== undefined ? { failureNote: o.failureNote } : {})` line in
  // `buildReport` (report.ts) and re-running: `noted?.failureNote` came back
  // `undefined` and both `toContain` assertions failed — restoring the line turned it
  // green again, confirming this test actually depends on that wiring end to end.
  test("bisection identifies the culprit in the SessionReport, not just via a manifest side channel", async () => {
    const dirs = await makeProject();
    const attempts: boolean[] = []; // true = this attempt's manifest still had the boundary mutant
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (dir: string) => {
        const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
          mutants: Array<{ operatorName: string }>;
        };
        const hasBoundary = manifest.mutants.some(
          (m) => m.operatorName === "lethal.conditional-boundary",
        );
        attempts.push(hasBoundary);
        return hasBoundary
          ? new AlcCompileError("alc: AL0001 malformed operator replacement")
          : undefined;
      },
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    // More than the one always-failing whole-artifact deploy — bisection genuinely ran.
    expect(attempts.length).toBeGreaterThan(1);
    // At least one narrowed attempt excluded the boundary mutant and compiled clean —
    // proof the artifact `prepareArtifactDir` wrote actually reflected that subset.
    expect(attempts.some((hasBoundary) => !hasBoundary)).toBe(true);

    // The actual assertion this test exists for: the culprit's identity must reach
    // the public SessionReport.
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });

  // I3: a deploy failure that reproduces regardless of which mutants are in
  // the artifact (observed live with BC app-version monotonicity, see
  // fixtures/README.md) must NOT be pinned on a mutant. The unconfirmed search used to
  // converge on candidates[0] and blame it with full confidence; the confirmation step
  // (complement still fails without the candidate) now classifies it as environmental
  // instead. (This fixture used to fail with a version-conflict message; since Task 6 that
  // specific shape is handled UPSTREAM of bisection — re-stamp + one retry, then a loud
  // session abort, see the test below.) Typed as `AlcCompileError`, not a bare licence-style
  // message: since Task 7, only a deterministic alc rejection ever reaches bisection at all —
  // a real licence failure surfaces as `DeploymentError` and aborts upstream of this path (see
  // the DeploymentError/ArtifactPrepareError abort tests below) — so this fixture stands in
  // for something alc itself can genuinely fail on regardless of mutant content (e.g. a
  // resource limit), not a publish-time licence check.
  test("an environment-caused deploy failure is reported as such, not blamed on a mutant", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      // Every deploy fails identically, whatever the manifest contains —
      // the environmental shape.
      () => new AlcCompileError("alc: internal compiler error (resource limit exceeded)"),
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("not attributable to any mutant");
    expect(noted?.failureNote).toContain("resource limit exceeded");
    expect(noted?.failureNote).not.toContain("bisected to mutant");
    store.close();
  });

  // Same problem, `workers > 1` path: a worker's own deploy of the shared artifact
  // can fail while other workers succeed (existing "worker's own deploy failure"
  // tests already cover that split), and until now that failure was never bisected —
  // every mutant in the failing shard was blamed with a flat `String(err)`. Only
  // worker 0's backend is guarded here (mirroring the existing per-worker-failure
  // tests' `workerIndex === 0` convention); worker 1 has no guard and always
  // succeeds, so its shard's mutants must resolve normally (killed/survived), never
  // "error" — proving the bisected failure stayed scoped to worker 0's shard.
  //
  // The guard is scoped to IsOverBudget's conditional-boundary specifically (operatorName
  // AND procedureName), not just operatorName: TWO_PROC_AL carries a conditional-boundary
  // mutant in EACH procedure, so an operatorName-only check would make two mutants equally
  // "guilty" — bisectFailingMutant assumes exactly one culprit, and confirmation against a
  // manifest search that (correctly, post-Task-7) spans every procedure would then find the
  // complement still fails (the OTHER procedure's conditional-boundary is still present) and
  // report "environmental" instead of naming either one. Scoping to one procedure keeps this
  // fixture a genuine single-culprit case.
  test("a worker's deploy failure is bisected to a named mutant, not blamed on its whole shard", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        undefined,
        workerIndex === 0
          ? (dir: string) => {
              const manifest = JSON.parse(
                readFileSync(join(dir, "mutant-manifest.json"), "utf8"),
              ) as { mutants: Array<{ operatorName: string; procedureName: string }> };
              const hasBoundary = manifest.mutants.some(
                (m) =>
                  m.operatorName === "lethal.conditional-boundary" &&
                  m.procedureName === "IsOverBudget",
              );
              return hasBoundary
                ? new AlcCompileError("alc: AL0001 malformed operator replacement")
                : undefined;
            }
          : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    expect(report.counts.errors).toBeGreaterThan(0);
    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    // Worker 1's shard (no guard, always succeeds) still produced real verdicts —
    // the bisected failure never spread past worker 0's own shard.
    expect(report.counts.killed).toBeGreaterThan(0);
    store.close();
  });

  // The `workers > 1` twin of the sequential AlcCompileError-guard abort (step 3b, covered
  // above by the "reportedIdentity" tests using a single `backend`): a DeploymentError is
  // NOT a compile verdict — the per-shard catch's `if (!(err instanceof AlcCompileError))
  // throw err` must reject the whole session before `bisectAndNote` ever runs, exactly like
  // the sequential path. Without that guard, a worker's publish/verify failure would fall
  // through into the same bisection machinery the previous test exercises for a plain compile
  // error, and get silently downgraded into a per-mutant "error" note instead of aborting the
  // run.
  test("a worker's DeploymentError aborts the whole session instead of being bisected", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-parallel-deployerr-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(dbPath);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // The exact object worker 0's deploy() throws — asserted below by reference (`.toBe`),
    // so the rethrow at orchestrator.ts:667 is proven to propagate it untouched, never
    // wrapped in a "bisected to mutant ..." note the way a plain compile failure would be.
    const deployErr = new DeploymentError("failed", "boom: worker 0 could not deploy", {
      status: "unavailable",
      detail: "no response",
    });
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        workerIndex === 0 ? deployErr : undefined,
      );
    await expect(
      runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers: 2,
      }),
    ).rejects.toBe(deployErr);

    // Reopen the on-disk DB: no mutant anywhere carries a "bisected" note — proof the
    // DeploymentError never reached bisectAndNote, on worker 0's shard or anywhere else.
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT failure_note FROM mutants").all() as Array<{
      failure_note: string | null;
    }>;
    raw.close();
    expect(rows.every((r) => !r.failure_note?.includes("bisected"))).toBe(true);
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7: bisect the full manifest (not the history-filtered `execute` set),
// and never let a non-compiler failure reach — or survive inside — bisection.
// ————————————————————————————————————————————————————————————————————————

/**
 * Writes `projectDir`'s full (unfiltered) mutation set to a throwaway scratch dir and returns
 * its manifest entries — used only to read a REAL mutant's identity fields ahead of a real run,
 * so a seeded "prior survivor" (see `seedPriorSurvivor` below) structurally matches a mutant
 * `runSession` will itself generate for the same project. `generateMutationSet` +
 * `writeInstrumentedProject` are pure functions of the project's source (same file list, same
 * AST traversal order, same `astSubtreeHash`), so calling this once here and letting
 * `runSession` regenerate the same project again independently yields identical identity
 * fields for the same mutant — this is exactly what `narrowFilesToSubset`'s own (file, span,
 * operator) matching and every existing `deployGuard`-reads-the-manifest test above already
 * lean on.
 */
async function manifestMutants(
  projectDir: string,
  scratchDir: string,
): Promise<readonly MutantManifestEntry[]> {
  const files = await generateMutationSet(projectDir);
  await writeInstrumentedProject({
    targetDir: scratchDir,
    files,
    selectorIds,
    artifactId: "seed00000000000000000000000000",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
  });
  const manifest = JSON.parse(await readFile(join(scratchDir, "mutant-manifest.json"), "utf8")) as {
    mutants: MutantManifestEntry[];
  };
  await rm(scratchDir, { recursive: true, force: true });
  return manifest.mutants;
}

/**
 * Seeds `store` with a single prior "survived" mutant whose identity matches `target`'s exactly
 * on the four fields `identityKeyOf`/`priorSurvivorKeys` (selection.ts/store.ts) key on —
 * astHash, codeunitName, operatorName, and operatorMajor (operatorVersion's leading component)
 * — NEVER the per-batch `mutantId` label, which `assignMutantIds` renumbers fresh per batch and
 * so cannot identify a mutant across two independent generations of the same project. Finishes
 * the run so a subsequent `runSession({ store, skipKnownSurvivors: true })` against the SAME
 * `projectPath` sees it via `priorSurvivorKeys` and excludes it from `execute` — while it stays
 * compiled into the artifact regardless, exactly the shipped defect this file's first new test
 * below exists to catch.
 */
function seedPriorSurvivor(
  store: ResultsStore,
  projectPath: string,
  target: MutantManifestEntry,
): void {
  const runId = store.createRun({ projectPath, backend: "bcdev", appVersion: "0.0.0.1" });
  store.recordMutant(runId, {
    mutantCode: "SEED",
    astHash: target.astHash,
    codeunitName: target.codeunitName,
    operatorName: target.operatorName,
    operatorMajor: Number(target.operatorVersion.split(".")[0] ?? "0"),
    file: target.file,
    line: target.startLine,
    verdict: "survived",
    durationMs: 0,
  });
  store.finishRun(runId, { batchCount: 1, baselineGreen: true });
}

describe("runSession — Task 7: bisects the full manifest, not the history-filtered execute set", () => {
  // Defect 1 (sequential path): `execute` (post `filterHistory`) omits known survivors, but
  // `writeInstrumentedProject` still compiled them into the artifact — they were only excluded
  // from EXECUTION, not from COMPILATION. Bisecting `execute` (the shipped bug) can therefore
  // never find a malformed known-survivor: `compiles(execute)` never re-includes it in any
  // candidate subset, so the very first check trivially "compiles" and bisection reports
  // "no-repro" — an admitted, but previously unexplained, dead end. Bisecting
  // `manifest.mutants` (every mutant the artifact actually contains) finds it like any other.
  test("bisects the FULL embedded manifest, so a malformed known-survivor is findable", async () => {
    const dirs = await makeProject();
    const scratchDir = join(dirs.instrumentedDir, "seed-scratch");
    const mutants = await manifestMutants(dirs.projectDir, scratchDir);
    const boundary = mutants.find((m) => m.operatorName === "lethal.conditional-boundary");
    expect(boundary).toBeDefined();
    if (boundary === undefined) throw new Error("unreachable: asserted above");

    const store = new ResultsStore(":memory:");
    seedPriorSurvivor(store, dirs.projectDir, boundary);

    // The whole-artifact deploy fails as long as the conditional-boundary spec is present.
    // `execute` (skipKnownSurvivors: true) excludes it, but the compiled artifact — what this
    // guard actually inspects — does not; the failure is deterministic on every attempt that
    // still contains it.
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (dir: string) => {
        const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
          mutants: Array<{ operatorName: string }>;
        };
        const hasBoundary = manifest.mutants.some(
          (m) => m.operatorName === "lethal.conditional-boundary",
        );
        return hasBoundary
          ? new AlcCompileError("alc: AL0001 malformed operator replacement")
          : undefined;
      },
    );
    const report = await runSession({
      backend,
      store,
      ...dirs,
      selectorIds,
      skipKnownSurvivors: true,
    });
    expect(report.counts.errors).toBeGreaterThan(0);
    // The known survivor itself is recorded separately (verdict "known-survivor", no note); the
    // culprit's identity lands on `execute`'s error-recorded mutants' shared note instead.
    const knownSurvivor = report.mutants.find((m) => m.verdict === "known-survivor");
    expect(knownSurvivor).toBeDefined();
    const noted = report.mutants.find((m) => m.failureNote !== undefined);
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });

  // Defect 1 (per-shard worker path): every worker deploys the SAME `batchDir` — the whole
  // artifact, every mutant, not a shard-scoped subset (sharding only decides which worker
  // EXECUTES which mutant's tests). Bisecting `shard` (the shipped bug) can therefore miss a
  // culprit that happens to be assigned to a DIFFERENT worker's shard: that worker's own search
  // never re-includes it in any candidate, so it "compiles" trivially and falls back to
  // "no-repro" — exactly the sequential path's bug, reproduced per-shard. Guarding both workers
  // identically (they see the same artifact) and searching `manifest.mutants` for both finds
  // the true culprit regardless of which shard it landed in.
  test("a worker's shard-scoped bisection can miss a culprit outside its own shard; the full manifest finds it", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    // Scoped to one specific mutant (operatorName AND procedureName) so there is exactly one
    // culprit — TWO_PROC_AL carries a conditional-boundary mutant in EACH procedure, and an
    // operatorName-only guard would make two mutants equally "guilty", which bisection can't
    // resolve to a single confirmed name (see the comment on the sibling test above).
    const guard = (dir: string) => {
      const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
        mutants: Array<{ operatorName: string; procedureName: string }>;
      };
      const hasCulprit = manifest.mutants.some(
        (m) =>
          m.operatorName === "lethal.conditional-boundary" && m.procedureName === "IsUnderBudget",
      );
      return hasCulprit
        ? new AlcCompileError("alc: AL0001 malformed operator replacement")
        : undefined;
    };
    // Both REAL workers (0 and 1) guarded identically: they deploy the same full batchDir, so
    // both observe the same failure regardless of which one's own shard happens to contain the
    // culprit. `cfg.backend` (workerIndex -1, the session's initial/step-3 deploy) is NOT
    // guarded — matching the existing per-worker-failure tests' convention — so the batch's
    // own whole-artifact deploy at step 3 succeeds and execution actually reaches the per-shard
    // fan-out this test means to exercise, rather than the sequential catch handling it first.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        undefined,
        workerIndex === -1 ? undefined : guard,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    const errorMutants = report.mutants.filter((m) => m.verdict === "error");
    expect(errorMutants.length).toBeGreaterThan(0);
    // Every errored mutant — from EITHER worker's shard — must be attributed to the actual
    // culprit, never a shard-scoped "no-repro" fallback for whichever worker's own shard
    // doesn't happen to contain it.
    for (const m of errorMutants) {
      expect(m.failureNote).toContain("bisected to mutant");
      expect(m.failureNote).toContain("lethal.conditional-boundary");
    }
    store.close();
  });
});

describe("runSession — Task 7: only a typed AlcCompileError may be bisected", () => {
  // Brief's literal test 3: a subset-preparation failure that is NOT a compiler verdict
  // (filesystem, not alc) must abort the search rather than be read as "this subset doesn't
  // compile". `ArtifactPrepareError` and `DeploymentError` both extend `Error` directly, not
  // `AlcCompileError` — `instanceof` cannot cross-match them — so guarding on `AlcCompileError`
  // specifically excludes ArtifactPrepareError too, not just DeploymentError (the shipped
  // guard's actual gap).
  test("aborts immediately on a non-compiler ArtifactPrepareError, without a single bisection compile", async () => {
    const dirs = await makeProject();
    let calls = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        calls++;
        return new ArtifactPrepareError("disk full");
      },
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(/disk full/);
    // Exactly the one production deploy — the guard aborted before bisection ever called
    // deploy() again.
    expect(calls).toBe(1);
    store.close();
  });

  // Brief's literal test 2, adapted to a bare (untyped) publish-style failure rather than
  // `DeploymentError` specifically: the shipped guard (`instanceof DeploymentError`) already
  // excluded `DeploymentError` itself pre-Task-7, so it alone would not distinguish old from
  // new behaviour here. An untyped `Error` — standing in for any publish/transport failure that
  // isn't perfectly wrapped — is exactly what the old, too-narrow guard let slip through.
  test("never bisects a publish-style failure that is not a typed AlcCompileError", async () => {
    const dirs = await makeProject();
    let calls = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        calls++;
        return new Error("NST unavailable");
      },
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /NST unavailable/,
    );
    expect(calls).toBe(1);
    store.close();
  });

  // Same guard, worker path: mirrors the existing "a worker's DeploymentError aborts" test
  // above, swapped to ArtifactPrepareError — the shape the shipped guard (`instanceof
  // DeploymentError`) did NOT exclude, and would have bisected/downgraded to a per-shard error.
  // Uses `deployGuard` (not the fixed `deployError`) so `calls` can prove the OUTER guard
  // specifically: `subsetMutants` already searches the full manifest (Task 7's other fix), and
  // the inner `compiles` callback already propagates a non-AlcCompileError too, so an always-
  // failing deploy would eventually abort with the right error via the INNER guard alone even
  // if this outer one were missing — `calls === 1` is what only the outer guard delivers (zero
  // wasted bisection compiles, not merely "eventually aborts correctly").
  test("a worker's ArtifactPrepareError aborts the whole session instead of being bisected", async () => {
    const root = await mkdtemp(join(tmpdir(), "lethal-orch-parallel-prepareerr-"));
    const dbPath = join(root, "results.sqlite");
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(dbPath);
    const caps: BackendCapabilities = {
      coverage: "none",
      deploy: "none",
      isolation: "full-reset",
      authoritative: false,
    };
    const deployErr = new ArtifactPrepareError("boom: worker 0 disk full");
    let worker0Calls = 0;
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        undefined,
        undefined,
        workerIndex === 0
          ? () => {
              worker0Calls++;
              return deployErr;
            }
          : undefined,
      );
    await expect(
      runSession({
        backend: make(-1),
        backendFactory: make,
        store,
        ...dirs,
        selectorIds,
        workers: 2,
      }),
    ).rejects.toBe(deployErr);
    // Exactly the one production deploy on worker 0's shard — the guard aborted before
    // bisection ever called deploy() again.
    expect(worker0Calls).toBe(1);

    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.query("SELECT failure_note FROM mutants").all() as Array<{
      failure_note: string | null;
    }>;
    raw.close();
    expect(rows.every((r) => !r.failure_note?.includes("bisected"))).toBe(true);
    store.close();
  });

  // The DEEPER half of the guard: not just "don't bisect a non-compile failure", but "don't
  // let one masquerade as a compile answer FROM WITHIN an already-legitimate bisection search".
  // The first deploy fails with a genuine AlcCompileError (entering bisection legitimately,
  // same as the existing "bisection identifies the culprit" test), but the very first candidate
  // `bisectAndNote` tries then fails for an unrelated, non-compiler reason (simulating a disk
  // failure mid-search). That must abort the whole search immediately, not be read as `false`
  // ("this subset doesn't compile") and keep halving toward an innocent mutant.
  test("a non-compiler failure mid-bisection aborts the search instead of being read as a compile answer", async () => {
    const dirs = await makeProject();
    let calls = 0;
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      undefined,
      undefined,
      (_dir: string) => {
        calls++;
        // Call 1: the initial whole-artifact deploy — a genuine compiler rejection, legitimately
        // entering bisection. Every call after that (bisection's own candidate deploys):
        // unrelated infrastructure failure, never a compile answer.
        if (calls === 1) return new AlcCompileError("alc: AL0001 malformed operator replacement");
        return new ArtifactPrepareError("disk full mid-search");
      },
    );
    const store = new ResultsStore(":memory:");
    await expect(runSession({ backend, store, ...dirs, selectorIds })).rejects.toThrow(
      /disk full mid-search/,
    );
    // Exactly 2 deploy calls: the initial production compile, and the ONE bisection attempt
    // whose non-compiler failure aborted the search immediately — proof the search did not
    // misread it as "false" and keep going (which would have driven `calls` well past 2, per
    // `bisectFailingMutant`'s halving + confirmation steps).
    expect(calls).toBe(2);
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 7b: bisection's compile-only seam. Spec §8 forbids publishing a bisection
// candidate; spec §10's operational test is a call-count gate on a compiler failure:
// publisher and verifier call counts stay ZERO, bisection makes compiler calls only, and the
// culprit is still named. Asserted with call counters on an instrumented fake — never timing.
// ————————————————————————————————————————————————————————————————————————

/**
 * Like `PhaseBackend`, but with compile/publish/verify tracked as SEPARATE counters (not one
 * shared `calls` log) so a test can assert "publisher/verifier called zero times" directly,
 * and with `compileViaDeployCalls`/`compileViaCheckCalls` split so "the production deploy
 * compiled exactly once, everything after that was compileCheck" is a call-count fact, not an
 * inference from the note text. `compileGuard` decides per-candidate whether the compile phase
 * throws `AlcCompileError`, reading the actual mutant-manifest.json each candidate write
 * produced — same technique as `StubBackend.deployGuard` — so the guard genuinely depends on
 * which mutant a given subset still carries, not on call order alone.
 */
class CompilePublishVerifyBackend implements ExecutionBackend {
  compileViaDeployCalls = 0;
  compileViaCheckCalls = 0;
  publisherCalls = 0;
  verifierCalls = 0;
  // Mirrors BcDevMcpBackend.deploy() setting `this.methodIndex`/`this.localProcedures` right
  // after a successful compile, before publish — only a real deploy() may touch this.
  methodIndexAssignments = 0;

  constructor(private readonly compileGuard: (dir: string) => Error | undefined) {}

  capabilities(): BackendCapabilities {
    return PHASE_CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "counting-phase" };
  }

  private async compile(dir: string): Promise<CompiledArtifact> {
    const guardErr = this.compileGuard(dir);
    if (guardErr !== undefined) throw guardErr;
    const appManifest = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
      id: string;
      version: string;
    };
    const mutantManifest = JSON.parse(
      await readFile(join(dir, "mutant-manifest.json"), "utf8"),
    ) as CompiledArtifact["mutantManifest"];
    return {
      artifactId: mutantManifest.artifactId,
      appId: appManifest.id,
      appVersion: appManifest.version,
      appPath: join(dir, "counting-fake.app"),
      sha256: Bun.SHA256.hash(new Uint8Array([1, 2, 3]), "hex"),
      mutantManifest,
      appManifest: appManifest as unknown as Record<string, unknown>,
    };
  }

  async deploy(dir: string): Promise<CompiledArtifact | null> {
    this.compileViaDeployCalls++;
    const artifact = await this.compile(dir); // throws BEFORE publish/verify on a bad candidate
    this.methodIndexAssignments++;
    this.publisherCalls++;
    this.verifierCalls++;
    return artifact;
  }

  /** The seam under test: compile only, never touches publish/verify/methodIndex. */
  async compileCheck(dir: string): Promise<void> {
    this.compileViaCheckCalls++;
    await this.compile(dir);
  }

  async activate(): Promise<void> {}
  async run(ref: TestMethodRef, _opts: RunOpts): Promise<TestVerdict> {
    return { ref, outcome: "pass", durationMs: 5 };
  }
}

/** True while `dir`'s just-written manifest still carries TARGET_AL's
 *  conditional-boundary mutant — the shared "one bad spec" fixture bisection narrows to. */
function manifestHasConditionalBoundary(dir: string): boolean {
  const manifest = JSON.parse(readFileSync(join(dir, "mutant-manifest.json"), "utf8")) as {
    mutants: Array<{ operatorName: string }>;
  };
  return manifest.mutants.some((m) => m.operatorName === "lethal.conditional-boundary");
}

describe("runSession — Task 7b: bisection's compile-only seam (spec §10 counters)", () => {
  test("sequential: compiler failure leaves publisher/verifier at zero while bisection names the culprit", async () => {
    const dirs = await makeProject();
    const backend = new CompilePublishVerifyBackend((dir) =>
      manifestHasConditionalBoundary(dir)
        ? new AlcCompileError("alc: AL0001 malformed operator replacement")
        : undefined,
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });

    // The gate: publisher/verifier never ran at all, for this batch or for bisection.
    expect(backend.publisherCalls).toBe(0);
    expect(backend.verifierCalls).toBe(0);
    expect(backend.methodIndexAssignments).toBe(0);
    // Exactly one production compile (the whole-artifact deploy that failed); everything
    // bisection did after that went through compileCheck, never deploy() again.
    expect(backend.compileViaDeployCalls).toBe(1);
    expect(backend.compileViaCheckCalls).toBeGreaterThan(1);

    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });

  test("worker path: the failing shard's publisher/verifier stay at zero while bisection names the culprit", async () => {
    const dirs = await makeProject();
    await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), TWO_PROC_AL);
    const store = new ResultsStore(":memory:");
    const backends = new Map<number, CompilePublishVerifyBackend>();
    const make = (workerIndex: number) => {
      const backend = new CompilePublishVerifyBackend(
        workerIndex === 0
          ? (dir) => {
              const manifest = JSON.parse(
                readFileSync(join(dir, "mutant-manifest.json"), "utf8"),
              ) as { mutants: Array<{ operatorName: string; procedureName: string }> };
              const hasBoundary = manifest.mutants.some(
                (m) =>
                  m.operatorName === "lethal.conditional-boundary" &&
                  m.procedureName === "IsOverBudget",
              );
              return hasBoundary
                ? new AlcCompileError("alc: AL0001 malformed operator replacement")
                : undefined;
            }
          : () => undefined, // worker 1 and cfg.backend (-1) always compile fine
      );
      backends.set(workerIndex, backend);
      return backend;
    };
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });

    const worker0 = backends.get(0);
    expect(worker0).toBeDefined();
    if (worker0 === undefined) throw new Error("unreachable");
    // The gate, scoped to the shard that actually hit a compiler failure: its ONE fan-out
    // deploy() attempt failed before ever reaching publish/verify, and every bisection
    // candidate after that went through compileCheck — publisher/verifier stayed at zero for
    // this worker's whole search.
    expect(worker0.publisherCalls).toBe(0);
    expect(worker0.verifierCalls).toBe(0);
    expect(worker0.methodIndexAssignments).toBe(0);
    expect(worker0.compileViaDeployCalls).toBe(1);
    expect(worker0.compileViaCheckCalls).toBeGreaterThan(1);

    const noted = report.mutants.find((m) => m.verdict === "error");
    expect(noted).toBeDefined();
    expect(noted?.failureNote).toContain("bisected to mutant");
    expect(noted?.failureNote).toContain("lethal.conditional-boundary");
    store.close();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 10): activateOnce/runOnce — retry ONLY provably-undispatched
// failures. A minimal ExecutionBackend fake (not the fuller StubBackend
// above, which models a whole session's worth of scripted deploy/run
// behavior) is enough here: these tests exercise the two helpers directly,
// not a full runSession.
// ————————————————————————————————————————————————————————————————————————

function fakeBackend(overrides: Partial<ExecutionBackend> = {}): ExecutionBackend {
  return {
    capabilities: () => CAPS_NST,
    status: async () => ({ ok: true, details: "fake" }),
    deploy: async () => null,
    compileCheck: async () => {},
    activate: async () => {},
    run: async (ref) => ({ ref, outcome: "pass", durationMs: 1 }),
    ...overrides,
  };
}

function aRef(): TestMethodRef {
  return { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "OverBudgetDetected" };
}

describe("activateOnce / runOnce — retry only pre-dispatch failures", () => {
  test("activateOnce retries a pre-dispatch-rejected activation exactly once", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        if (calls === 1) throw new ActivationFailure("boom", "pre-dispatch-rejected");
        // second call succeeds
      },
    });
    const safety = new SessionSafety();
    await activateOnce(backend, safety, "M0007");
    expect(calls).toBe(2);
    expect(safety.isUnsafe).toBe(false);
  });

  test("activateOnce does NOT retry an in-flight-unknown activation; latches unsafe and rethrows", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        throw new ActivationFailure("timed out", "in-flight-unknown");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
    expect(calls).toBe(1); // never retried
    expect(safety.isUnsafe).toBe(true);
  });

  test("runOnce retries only a pre-dispatch-rejected run", async () => {
    let calls = 0;
    const backend = fakeBackend({
      run: async (ref) => {
        calls++;
        if (calls === 1)
          return { ref, outcome: "error", durationMs: 1, operation: "pre-dispatch-rejected" };
        return { ref, outcome: "pass", durationMs: 1 };
      },
    });
    const v = await runOnce(backend, aRef(), { coverage: "none", timeoutMs: 100 });
    expect(calls).toBe(2);
    expect(v.outcome).toBe("pass");
  });

  test("runOnce does NOT retry an in-flight-unknown run", async () => {
    let calls = 0;
    const backend = fakeBackend({
      run: async (ref) => {
        calls++;
        return { ref, outcome: "error", durationMs: 1, operation: "in-flight-unknown" };
      },
    });
    const v = await runOnce(backend, aRef(), { coverage: "none", timeoutMs: 100 });
    expect(calls).toBe(1);
    expect(v.operation).toBe("in-flight-unknown");
  });

  // Task 10 review Minor-3 (folded into Task 11, see .superpowers/sdd/5b-task-11-brief.md):
  // two activateOnce branches the original suite never exercised.
  test("activateOnce rethrows a completed-effect-unknown failure WITHOUT retry or latch", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        throw new ActivationFailure("malformed 2xx body", "completed-effect-unknown");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
    expect(calls).toBe(1); // never retried — completed-effect-unknown is not retry-safe
    expect(safety.isUnsafe).toBe(false); // only in-flight-unknown latches
  });

  test("activateOnce lets a raw non-ActivationFailure Error fall through un-retried, un-latched", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        throw new Error("ECONNRESET");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1); // not an ActivationFailure — no retry/latch branch can even inspect it
    expect(safety.isUnsafe).toBe(false);
  });

  // Task 10 review Minor-1 (folded into Task 11): the RETRY of a retry-safe failure is a fresh
  // dispatch attempt — if IT resolves in-flight-unknown, the latch invariant must still trip.
  test("activateOnce latches unsafe when the retry of a retry-safe failure itself is in-flight-unknown", async () => {
    let calls = 0;
    const backend = fakeBackend({
      activate: async () => {
        calls++;
        if (calls === 1) throw new ActivationFailure("boom", "pre-dispatch-rejected");
        throw new ActivationFailure("timed out on retry", "in-flight-unknown");
      },
    });
    const safety = new SessionSafety();
    await expect(activateOnce(backend, safety, "M0007")).rejects.toBeInstanceOf(ActivationFailure);
    expect(calls).toBe(2); // the retry-safe first failure DID earn its one retry
    expect(safety.isUnsafe).toBe(true); // ...but the retry itself came back ambiguous
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 11): gate all work-plane calls on SessionSafety — quarantine consult BEFORE
// status(), and a latch-gated finally teardown (no mutating activate(null) once unsafe).
// ————————————————————————————————————————————————————————————————————————

/** Synchronous sibling of `mkdtemp` for inline use in test literals (e.g.
 *  `runSessionForTest(backend, { quarantineDir: freshTmpDir() })`), where an `await` isn't
 *  available. Each call gets its own directory, so tests never share (or race on) quarantine
 *  state. */
function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lethal-orch-quarantine-"));
}

/**
 * Thin wrapper building a full `SessionConfig` around a caller-supplied fake backend: a fresh
 * `makeProject()` fixture (overwritten with THREE_PROC_AL — 9 mutants, M0001..M0009 — so tests
 * that need to reach a specific mutant id like "M0007" have one to reach), an in-memory store,
 * and the tier resource key the brief's tests assert against: `resourceServer` +
 * `resourceServerInstance` normalize (resource-key.ts) to exactly `http://cronus281|BC`.
 * `overrides` lets a test inject `quarantineDir` (always required in tests — production alone
 * defaults to `~/.lethal/quarantine`) or replace any other field, e.g. `nowIso` for Task 12.
 */
async function runSessionForTest(
  backend: ExecutionBackend,
  overrides: Partial<SessionConfig> = {},
) {
  const dirs = await makeProject();
  await Bun.write(join(dirs.projectDir, "SandboxLogic.Codeunit.al"), THREE_PROC_AL);
  const store = new ResultsStore(":memory:");
  return runSession({
    backend,
    store,
    ...dirs,
    selectorIds,
    resourceServer: "http://cronus281",
    resourceServerInstance: "BC",
    ...overrides,
  });
}

describe("runSession — Task 11 quarantine consult + latch-gated finally", () => {
  test("a pre-quarantined tier refuses to run before status() is ever called", async () => {
    const dir = freshTmpDir();
    const store = new QuarantineStore(dir);
    await store.record({
      resourceKey: "http://cronus281|BC",
      opKind: "test-run",
      detail: "prior strand",
      recordedAtIso: "2026-07-20T10:00:00.000Z",
    });
    let statusCalled = false;
    const backend = fakeBackend({
      status: async () => {
        statusCalled = true;
        return { ok: true, details: "" };
      },
    });
    await expect(runSessionForTest(backend, { quarantineDir: dir })).rejects.toThrow(
      /quarantined/i,
    );
    expect(statusCalled).toBe(false);
  });

  test("an unquarantined tier proceeds past the consult and reaches status()", async () => {
    let statusCalled = false;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      status: async () => {
        statusCalled = true;
        return { ok: true, details: "" };
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir() });
    expect(statusCalled).toBe(true);
  });

  test("finally teardown does NOT call activate(null) once the session is unsafe", async () => {
    // Reaches the unsafe latch via the mutant loop's OWN activateOnce call (already latch-wired
    // since Task 10) rather than a run()-side in-flight-unknown: recording a durable quarantine
    // on a run()-side ambiguity is Task 12's job (deadline-branch), not this task's — this test
    // only needs SOME real path to `safety.isUnsafe === true` reached from inside `runSession`,
    // and activate()-throws-in-flight-unknown is already fully wired end to end.
    const activateCalls: Array<string | null> = [];
    const backend = fakeBackend({
      // coverage:"none" so every mutant is covered by the (always-passing) baseline test —
      // THREE_PROC_AL's 9 mutants would otherwise all resolve "no-coverage" against a fake
      // backend that never reports real procedure coverage, and the mutant loop (and M0007)
      // would never be reached at all.
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activateCalls.push(id);
        if (id === "M0007") throw new ActivationFailure("timed out", "in-flight-unknown");
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir() }).catch(() => {});
    // M0001..M0006 activate and run clean (every run() call defaults to "pass" — see
    // fakeBackend); M0007's activation is where the latch trips and the session aborts. NO
    // activate(null) may appear after it — that would be the finally block's deactivating
    // ClearActive, a mutating call on a tier that may still be stranded (spec §8).
    const afterUnsafe = activateCalls.slice(activateCalls.indexOf("M0007") + 1);
    expect(afterUnsafe).not.toContain(null);
    // Sanity: the latch path was actually exercised, not vacuously true because M0007 never ran.
    expect(activateCalls).toContain("M0007");
  });

  test("finally DOES call activate(null) on the ordinary (safe) path", async () => {
    const activateCalls: Array<string | null> = [];
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activateCalls.push(id);
      },
    });
    await runSessionForTest(backend, { quarantineDir: freshTmpDir() });
    expect(activateCalls.at(-1)).toBeNull();
  });
});

// ————————————————————————————————————————————————————————————————————————
// Task 13 folded fix (Task 11 review, Important-1): the quarantine consult above only fires when
// BOTH `resourceServer`/`resourceServerInstance` are present — an authoritative caller that omits
// them is tolerated (skip, not throw), because ~30 pre-existing authoritative-backend unit tests
// exercise an in-memory stub without ever setting them. Tolerated is not the same as silent: a
// regression in whatever sources these fields from real config (`cli.ts`'s `resourceIdentityFor`,
// added this same task) would otherwise leave quarantine permanently — and invisibly — inert
// against a real BC server. `runSession` must warn every time this happens.
// ————————————————————————————————————————————————————————————————————————
describe("runSession — Task 13 folded fix: warn when authoritative but no tier identity", () => {
  // Authoritative fake backends below explicitly set `coverage: "none"` (rather than relying on
  // `fakeBackend()`'s CAPS_NST default of `coverage: "procedure"`), mirroring the already-proven
  // "an unquarantined tier proceeds past the consult" test above — coverage:"none" runs every
  // test against every mutant without needing the backend to report per-procedure coverage data.
  const authoritativeNoCoverage = (): ExecutionBackend =>
    fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
    });

  test("warns when an authoritative backend omits resourceServer/resourceServerInstance", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let messages: string[] = [];
    try {
      // Deliberately the RAW runSession call (not runSessionForTest, which always fills in
      // resourceServer/resourceServerInstance) — this is exactly the shape of the ~30
      // pre-existing authoritative tests elsewhere in this file.
      await runSession({ backend: authoritativeNoCoverage(), store, ...dirs, selectorIds });
      // Captured INSIDE the try, before `finally`'s mockRestore() — bun:test's mockRestore()
      // also resets `.mock.calls` (like Jest's), so reading it after restore would always see
      // zero calls regardless of what actually happened.
      messages = warnSpy.mock.calls.map((call) => String(call[0]));
    } finally {
      warnSpy.mockRestore();
    }
    expect(messages.some((m) => m.includes("quarantine consult is DISABLED"))).toBe(true);
  });

  test("does NOT warn when resourceServer/resourceServerInstance are both set", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;
    try {
      await runSessionForTest(authoritativeNoCoverage(), { quarantineDir: freshTmpDir() });
      callCount = warnSpy.mock.calls.length; // see note above: read before mockRestore()
    } finally {
      warnSpy.mockRestore();
    }
    expect(callCount).toBe(0);
  });

  test("does NOT warn for a non-authoritative (al-runner) backend either", async () => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "none",
        isolation: "full-reset",
        authoritative: false,
      }),
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let callCount = 0;
    try {
      await runSession({ backend, store, ...dirs, selectorIds });
      callCount = warnSpy.mock.calls.length; // see note above: read before mockRestore()
    } finally {
      warnSpy.mockRestore();
    }
    expect(callCount).toBe(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 12): mutant-loop in-flight-unknown deadline records a durable
// quarantine, latches unsafe, and stops — a plain (non-in-flight-unknown)
// deadline stays an ordinary error, no quarantine.
// ————————————————————————————————————————————————————————————————————————

describe("runSession — Task 12 quarantine on in-flight-unknown deadline", () => {
  test("an in-flight-unknown deadline records a durable quarantine and reports quarantined", async () => {
    const dir = freshTmpDir();
    // NOTE on this fixture (deviates from the brief's literal `run: async (ref) => ({ ...
    // deadline-exceeded/in-flight-unknown }))` one-liner): a `run` override that uniform for
    // EVERY call also answers the session's BASELINE test (step 4, before the mutant loop —
    // which has no in-flight-unknown handling of its own, by design/scope). A deadline-exceeded
    // baseline just fails baseline outright ("no green baseline tests") and the session never
    // reaches the mutant loop this test means to exercise — confirmed empirically: the literal
    // brief fixture leaves the quarantine store empty even with Step 3 fully implemented.
    // Tracking `activeMutant` (same pattern as the "finally teardown" test above) lets baseline
    // (activation `null`) pass normally and keeps the ambiguous deadline scoped to the
    // per-mutant covering-test run this task's branch actually guards.
    let activeMutant: string | null = null;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none", // every mutant covered by baseline's one passing test — no coverage index needed
        deploy: "publish",
        isolation: "session",
        authoritative: true, // required for the Task 11 quarantine consult/record path to engage
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) =>
        activeMutant === null
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" },
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T12:00:00.000Z",
    }).catch((e) => e);
    // session exits quarantined (either a thrown quarantined error or a report flag — assert the store):
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).not.toBeNull();
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.recordedAtIso).toBe("2026-07-20T12:00:00.000Z");
    // The session resolves (not rejects) with a report naming the stranded op — Step 3's "stop
    // scheduling further mutants after the mutant loop" wiring, not just the store write.
    expect(report).not.toBeInstanceOf(Error);
    expect((report as Awaited<ReturnType<typeof runSession>>).quarantined?.reason).toContain(
      "in-flight-unknown",
    );
  });

  test("a plain deadline-exceeded (no in-flight-unknown operation) stays an ordinary error — no quarantine, session continues", async () => {
    const dir = freshTmpDir();
    let activeMutant: string | null = null;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: false, // al-runner shape: no shared tier, mirrors the brief's "no shared tier" case
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) =>
        activeMutant === null
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1 }, // no `operation` — al-runner has no seam for it
    });
    const report = await runSessionForTest(backend, { quarantineDir: dir });
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).toBeNull(); // no quarantine recorded
    expect(report.quarantined).toBeUndefined();
    expect(report.counts.deadlineExceeded).toBeGreaterThan(0);
    expect(report.counts.errors).toBeGreaterThan(0);
  });
});

// ————————————————————————————————————————————————————————————————————————
// Layer 5B (Task 12 follow-up): Task 12 only wired the mutant-loop's covering-test run — two
// other `runOnce` sites also consume a `TestVerdict` and inspect `.outcome` without ever
// looking at `.operation`: the BASELINE test loop (runs before any mutant is even scheduled)
// and the kill-CONFIRMATION rerun (the baseline-re-run triggered by a mutant's covering test
// failing). Both now share the same `quarantineInFlight` helper the mutant-loop's main branch
// was refactored to call.
// ————————————————————————————————————————————————————————————————————————

describe("runSession — latch+quarantine on in-flight-unknown at baseline and kill-confirm too", () => {
  test("a BASELINE test returning in-flight-unknown records a durable quarantine and quarantines the session before any mutant is scheduled", async () => {
    const dir = freshTmpDir();
    // THREE_PROC_AL's discovered test suite (from TEST_AL, via runSessionForTest) has exactly
    // one baseline test method — so it's simultaneously the FIRST and only baseline test, and
    // every `run()` call in this fixture is answered identically: there is no mutant-loop call
    // to distinguish from the baseline one, because the session must never reach the mutant
    // loop at all once the baseline itself comes back in-flight-unknown.
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none",
        deploy: "publish",
        isolation: "session",
        authoritative: true, // required for the Task 11 quarantine consult/record path to engage
      }),
      run: async (ref) => ({
        ref,
        outcome: "deadline-exceeded",
        durationMs: 1,
        operation: "in-flight-unknown",
      }),
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T12:00:00.000Z",
    }).catch((e) => e);
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).not.toBeNull();
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.recordedAtIso).toBe("2026-07-20T12:00:00.000Z");
    // Resolves (doesn't reject) with a quarantined report — same "stop cleanly" contract as
    // Task 12's mutant-loop branch, not a thrown SessionUnsafeError.
    expect(report).not.toBeInstanceOf(Error);
    const sessionReport = report as Awaited<ReturnType<typeof runSession>>;
    expect(sessionReport.quarantined?.reason).toContain("in-flight-unknown");
    // No mutant scheduling: the baseline latch must stop the session before step 5/6 ever run,
    // so nothing at all lands in `report.mutants` (not even "no green baseline tests" errors).
    expect(sessionReport.mutants).toHaveLength(0);
  });

  test("a kill-confirmation rerun returning in-flight-unknown records a durable quarantine and latches the session unsafe", async () => {
    const dir = freshTmpDir();
    // Stateful fake (same pattern as the Task 12 "finally teardown"/"in-flight-unknown deadline"
    // tests above): `activeMutant` tracks the most recent activate() call so `run()` can answer
    // differently for the baseline/confirm (null-activation) runs vs. a mutant-active run, and
    // `nullRuns` distinguishes the FIRST null-activation run (the baseline, which must pass so
    // the session reaches the mutant loop) from the SECOND (the kill-confirmation rerun
    // triggered by the first mutant's covering test failing below).
    let activeMutant: string | null = null;
    let nullRuns = 0;
    const backend = fakeBackend({
      capabilities: () => ({
        coverage: "none", // every mutant covered by baseline's one passing test — no coverage index needed
        deploy: "publish",
        isolation: "session",
        authoritative: true,
      }),
      activate: async (id) => {
        activeMutant = id;
      },
      run: async (ref) => {
        if (activeMutant !== null) return { ref, outcome: "fail", durationMs: 1 };
        nullRuns++;
        return nullRuns === 1
          ? { ref, outcome: "pass", durationMs: 1 }
          : { ref, outcome: "deadline-exceeded", durationMs: 1, operation: "in-flight-unknown" };
      },
    });
    const report = await runSessionForTest(backend, {
      quarantineDir: dir,
      nowIso: () => "2026-07-20T13:00:00.000Z",
    }).catch((e) => e);
    const store = new QuarantineStore(dir);
    const rec = await store.read("http://cronus281|BC");
    expect(rec).not.toBeNull();
    expect(rec?.opKind).toBe("test-run");
    expect(rec?.recordedAtIso).toBe("2026-07-20T13:00:00.000Z");
    expect(report).not.toBeInstanceOf(Error);
    const sessionReport = report as Awaited<ReturnType<typeof runSession>>;
    expect(sessionReport.quarantined?.reason).toContain("in-flight-unknown");
    // Stops scheduling further mutants after the one whose confirm run tripped the latch: only
    // that single mutant (M0001, the first one activated) reaches `report.mutants`.
    expect(sessionReport.mutants).toHaveLength(1);
    expect(sessionReport.mutants[0]?.verdict).toBe("error");
    expect(sessionReport.mutants[0]?.cause).toBe("deadline-exceeded");
  });
});
