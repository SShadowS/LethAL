import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
    TestIsolation = Function;

    [Test]
    procedure OverBudgetDetected()
    begin
    end;
}
`;

class StubBackend implements ExecutionBackend {
  activations: Array<string | null> = [];
  deploys: string[] = [];
  constructor(
    private readonly caps: BackendCapabilities,
    private readonly script: (mutant: string | null, ref: TestMethodRef) => TestVerdict["outcome"],
    private readonly coverageProcedures: string[] = [],
  ) {}
  capabilities() {
    return this.caps;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy(dir: string) {
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

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "lethal-orch-"));
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), TEST_AL);
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
