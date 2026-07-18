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
