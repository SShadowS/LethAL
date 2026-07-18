import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { runSession } from "../src/orchestrator";
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

// Two independent, non-nested procedures for the parallel-workers concurrency
// probe below. The standard `TARGET_AL` fixture's single comparison produces
// exactly 3 mutants (empty-block on the procedure body, return-value on the
// exit statement, conditional-boundary on the comparison) that are ALL nested
// inside one another — `batchByOverlap` (packages/runner/src/selection.ts)
// forbids any overlap within a batch, so those 3 mutants always land in 3
// separate batches of exactly 1, and a batch of 1 mutant can never be
// sharded across >1 worker no matter how correct the fan-out is. Two disjoint
// procedure bodies never overlap, so each of the 3 batches instead gets one
// mutant from each procedure (2 per batch) — enough to actually shard.
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

// Three independent, non-nested procedures — for the fractional-workers
// test below specifically, which needs a batch with >=3 shardable mutants.
// With TWO_PROC_AL (2 per batch), `shardEvenly(items, 2.5)` never actually
// drops anything: `Array.from({length: 2.5}, ...)` truncates to a length-2
// shard array, but with only 2 items, `i % 2.5` for i=0,1 is just 0 and 1 —
// both land inside the truncated array. The bug only surfaces once an index
// >=2 is reached (`2 % 2.5 === 2`, out of the truncated array's bounds), so
// a third independent procedure is needed to prove the fix actually matters.
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
  ) {}
  capabilities() {
    return this.caps;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string) {
    if (this.deployError !== undefined) throw this.deployError;
    this.deploys.push(dir);
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
    // 1.0.<runId>.<batchIdx> — run BEFORE batch, so versions increase across runs.
    // BC rejects publishing a version lower than the installed one, which the
    // original 1.0.<batch>.<run> order violated on every run after the first.
    expect(appJson.version).toMatch(/^1\.0\.\d+\.0$/);

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

  // Hardening: counts.deadlineExceeded must be derived structurally (an
  // explicit `cause` set only at the two orchestrator sites that know it),
  // never by sniffing failureNote text. The batch-deploy-failure handler
  // stores `String(err)` verbatim as failureNote for every mutant in the
  // batch — a thrown bare string (not an Error, which would stringify to
  // "Error: ...") that happens to start with "deadline exceeded" must still
  // land as a plain error, not get miscounted as a client deadline.
  test("batch deploy failure whose message starts with 'deadline exceeded' is still just an error", async () => {
    const dirs = await makeProject();
    const backend = new StubBackend(
      CAPS_NST,
      () => "pass",
      ["IsOverBudget"],
      "deadline exceeded talking to NST", // thrown bare string, not an Error
    );
    const store = new ResultsStore(":memory:");
    const report = await runSession({ backend, store, ...dirs, selectorIds });
    expect(report.counts.errors).toBeGreaterThan(0);
    expect(report.counts.deadlineExceeded).toBe(0);
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

  // The test above reuses the standard single-comparison fixture, which
  // (see TWO_PROC_AL comment) always produces exactly 1 mutant per batch —
  // shardEvenly then has only one non-empty shard no matter the worker
  // count, so that test alone never actually exercises >1 concurrently
  // executing shard whose verdicts must agree. This test uses TWO_PROC_AL so
  // every batch really does contain 2 shardable mutants, genuinely stressing
  // cross-shard determinism.
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
      // Worker 0 (shardEvenly's round-robin always gives it the LOWER-
      // startIndex mutant, IsOverBudget) is made artificially slower than
      // worker 1 (the later-position IsUnderBudget mutant). Without
      // runSession's outcomes.sort(), worker 1 would finish and call
      // record() first, so the raw accumulation order would come out
      // file-position-reversed relative to the workers=1 baseline — the sort
      // is what makes this test's order assertion pass regardless of which
      // worker happens to finish first.
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
    // shardEvenly's round-robin always sends the lower-startIndex mutant
    // (IsOverBudget) to worker 0 and the other (IsUnderBudget) to worker 1.
    // Worker 0's backend always fails to deploy; worker 1's succeeds and
    // kills its mutant normally. Mirrors the sequential per-batch deploy
    // try/catch (step 3 in orchestrator.ts): a deploy failure must record
    // every mutant in the affected shard as "error" and let the session
    // continue, not reject the whole `runSession` call.
    const make = (workerIndex: number) =>
      new StubBackend(
        caps,
        (mutant) => (mutant === null ? "pass" : "fail"),
        [],
        workerIndex === 0 ? "boom: worker 0 could not deploy" : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // 3 batches: worker 0's mutant errors every time, worker 1's is killed
    // every time — the deploy failure never propagates past its own shard.
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
    // procedure — IsUnderBudget's mutant is therefore uncovered and already
    // recorded "no-coverage" by step 5, before the per-mutant fan-out ever
    // runs. shardEvenly's round-robin sends IsOverBudget's mutant (lower
    // startIndex) to worker 0 and IsUnderBudget's (the uncovered one) to
    // worker 1. Worker 1's backend always fails to deploy: without the
    // `perMutantTests.get(...) === undefined` skip in the deploy-failure
    // catch, the uncovered IsUnderBudget mutant would be recorded a SECOND
    // time as "error" — `mutants` has no unique constraint on (run_id,
    // mutant_code), so `recordMutant`'s plain INSERT would silently
    // duplicate the row rather than fail loudly.
    const make = (workerIndex: number) =>
      new StubBackend(
        CAPS_NST,
        (mutant) => (mutant === null ? "pass" : "fail"),
        ["IsOverBudget"],
        workerIndex === 1 ? "boom: worker 1 could not deploy" : undefined,
      );
    const report = await runSession({
      backend: make(-1),
      backendFactory: make,
      store,
      ...dirs,
      selectorIds,
      workers: 2,
    });
    // 3 batches, 2 mutants each = 6 total — never 9 (which would mean
    // IsUnderBudget's mutant landed under both no-coverage and error).
    expect(report.mutants.length).toBe(6);
    expect(report.counts.noCoverage).toBe(3); // IsUnderBudget's mutant, once per batch
    expect(report.counts.errors).toBe(0); // never re-recorded via worker 1's deploy failure
    expect(report.counts.killed).toBe(3); // IsOverBudget's mutant, worker 0 deploys fine
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
    // Worker 0 (the lower-startIndex IsOverBudget mutant) is slow — 30ms per
    // run(). Worker 1 (IsUnderBudget) errors on every active-mutant run,
    // tripping the I7 "two consecutive transport errors" abort almost
    // immediately. If runSession rethrew as soon as worker 1's shard
    // rejected (plain `Promise.all` semantics) instead of waiting for every
    // shard to settle (`Promise.allSettled`), worker 0 could still be
    // mid-flight — and, worse, a caller reacting to the rejection by closing
    // the store could race a still-running worker 0's write to it.
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
    // TWO_PROC_AL yields 3 batches. If worker backends were rebuilt every
    // batch (the bug), the factory would run 1 (cfg.backend) + 3 batches * 2
    // workers = 7 times; built once per session it's 1 + 2 = 3.
    expect(factoryCalls).toBe(3);
    // Exactly the 2 worker backends close, each exactly once — cfg.backend
    // is caller-owned (see cli.ts) and is never closed by runSession itself.
    expect(closeCallCounts).toEqual([1, 1]);
    store.close();
  });

  test("a fractional workers count is floored, not silently dropping mutants", async () => {
    const dirs = await makeProject();
    // THREE_PROC_AL, not TWO_PROC_AL: with only 2 shardable mutants per
    // batch, `i % 2.5` for i=0,1 never lands outside shardEvenly's
    // (length-truncated) 2-element shard array, so the drop bug needs a
    // batch with >=3 items to actually manifest — see THREE_PROC_AL's
    // comment.
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
    // 3 batches * 3 mutants each = 9. Before flooring, shardEvenly(execute, 2.5)
    // built a length-2 shard array (Array.from truncates a fractional
    // `length`) while still computing target indices via `i % 2.5`, so the
    // 3rd item each batch (index 2, `2 % 2.5 === 2`, outside the truncated
    // array) was silently dropped by shardEvenly's `if (target !== undefined)`
    // guard — no error, just fewer mutants in the report than were generated.
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
