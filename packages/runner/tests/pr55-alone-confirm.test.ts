import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunManyOpts,
  RunManyResult,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import type { RunEvent } from "../src/events";
import { createEmitter } from "../src/events";
import { ALONE_UNSTABLE_NOTE, runSession } from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-55 (R1067): a kill or timeout measured on a test run ALONE (`TestVerdict.selection ===
 * "alone"`) is confirmed and reproduced alone, whatever the isolation, with no kill pair. The stubs
 * are trimmed copies of `pr51-held-timeout.test.ts`'s (neither file exports them).
 */

const scratch = scratchDirs();
async function v3RunnerBuild(): Promise<{ version: string; binarySha256: string }> {
  return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
}
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const APP_JSON = JSON.stringify({
  id: "11111111-1111-1111-1111-111111111111",
  name: "Sandbox Orchestrator Fixture",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
});
const FIVE_TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure T1() begin end;
    [Test]
    procedure T2() begin end;
    [Test]
    procedure T3() begin end;
    [Test]
    procedure T4() begin end;
    [Test]
    procedure T5() begin end;
}
`;
const CAPS_NST: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
};
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = scratch("lethal-orch-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), FIVE_TESTS_AL);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, instrumentedDir };
}

type Outcome = TestVerdict["outcome"];

/** Records every run (mutant, method, alone) and every pair; marks chosen mutated runs alone. */
class AloneStub implements ExecutionBackend {
  readonly runnerBuild = v3RunnerBuild;
  readonly killsMustReproduce = true;
  inRunStopIsBudget = false;
  activations: Array<string | null> = [];
  readonly runs: Array<{ mutant: string | null; method: string; alone: boolean; ms: number }> = [];
  readonly pairs: string[] = [];
  readonly restored: unknown[] = [];
  private cuts = 0;
  /** Which tests a mutated run answers as ALONE (`selection: "alone"`). */
  markAlone: (method: string) => boolean = () => false;
  /** Rewrites a verdict (durations, `timeoutIn`) once the outcome is decided. */
  decorate?: (active: string | null, opts: RunOpts, v: TestVerdict) => TestVerdict;
  isolationOf?: (codeunitId: number) => "test" | "method";
  constructor(
    private readonly script: (
      mutant: string | null,
      ref: TestMethodRef,
      opts: RunOpts,
      started: boolean,
    ) => Outcome,
  ) {}
  capabilities() {
    return CAPS_NST;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy() {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null) {
    this.activations.push(id);
  }
  async sendKillPair(mutantId: string, ref: TestMethodRef): Promise<void> {
    this.pairs.push(`${mutantId} ${ref.method}`);
  }
  cutState(_id: string): unknown {
    this.cuts += 1;
    return this.cuts;
  }
  restoreCutState(_id: string, state: unknown): void {
    this.restored.push(state);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const started = this.activations.some((a) => a !== null);
    this.runs.push({
      mutant: active,
      method: ref.method,
      alone: opts.alone === true,
      ms: opts.timeoutMs,
    });
    const outcome = this.script(active, ref, opts, started);
    const hasCoverage = active === null && !started;
    const v: TestVerdict = {
      ref,
      outcome,
      durationMs: 5,
      ...(hasCoverage
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 79000, procedure: "IsOverBudget" }],
            },
          }
        : {}),
      ...(opts.coverage === "none"
        ? {
            attestation: { observedAny: true, identityMismatch: false },
            reachedActive: active !== null,
          }
        : {}),
      ...(active !== null &&
      (outcome === "fail" || outcome === "timeout") &&
      (opts.alone === true || this.markAlone(ref.method))
        ? { selection: "alone" as const }
        : {}),
    };
    return this.decorate?.(active, opts, v) ?? v;
  }
}

describe("PR-55: a kill or timeout measured alone is confirmed and reproduced alone", () => {
  const NOTE = `unstable test T1: ${ALONE_UNSTABLE_NOTE}`;
  const session = async (
    backend: ExecutionBackend,
    extra: Partial<SessionConfig> = {},
  ): Promise<SessionReport> => {
    const dirs = await makeProject();
    const store = new ResultsStore(":memory:");
    try {
      return await runSession({ backend, store, ...dirs, selectorIds, ...extra });
    } finally {
      store.close();
    }
  };
  const m1 = (r: SessionReport) => r.mutants.find((m) => m.mutantCode === "M0001");
  /** M0001: T1 fails (or times out); every other test and mutant passes. */
  const plan = (outcome: Outcome) => (mutant: string | null, ref: TestMethodRef) =>
    mutant === "M0001" && ref.method === "T1" ? outcome : "pass";
  const t1Runs = (b: AloneStub) =>
    b.runs
      .filter((r) => r.method === "T1" && (r.mutant === "M0001" || r.mutant === null))
      .map((r) => `${r.mutant ?? "null"}:${r.alone}`);

  test("A1: a FIRST fail marked alone (default isolation) is confirmed alone, reproduced alone, and sends no pair", async () => {
    const b = new AloneStub(plan("fail"));
    b.markAlone = (m) => m === "T1";
    const events: RunEvent[] = [];
    const report = await session(b, { emit: [createEmitter([(e) => events.push(e)])] });
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killReproduced).toBe(true);
    expect(b.pairs).toEqual([]);
    expect(t1Runs(b).slice(0, 4)).toEqual(["null:false", "M0001:false", "null:true", "M0001:true"]);
    // One alone-confirm event, naming the mutant and the test.
    const alone = events.filter((e) => e.type === "warning" && e.code === "alone-confirm");
    expect(alone).toHaveLength(1);
    expect(alone[0]?.type === "warning" ? alone[0].message : "").toContain("T1 (mutant M0001)");
  });

  test("A2: a first fail marked alone that also fails alone with no mutant -> error unstable with the named note", async () => {
    const b = new AloneStub((mutant, ref, opts, started) => {
      if (ref.method !== "T1") return "pass";
      if (mutant === "M0001") return "fail";
      return mutant === null && started && opts.alone === true ? "fail" : "pass";
    });
    b.markAlone = (m) => m === "T1";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("unstable");
    // The hub-coverage stub also appends R59's runner-disagreement text after the named cause.
    expect(m1(report)?.failureNote?.startsWith(NOTE)).toBe(true);
    expect(NOTE).toBe(
      "unstable test T1: fails (or hangs) when run alone with no mutant: it ran alone under the mutant after a cut in its codeunit, and tests of a codeunit share state in order, so the failure is not attributable to the mutant",
    );
  });

  test("A3: a first fail marked alone that passes alone but fails in context with no mutant -> killed; not marked, the same script is unstable", async () => {
    const inContextFails = (
      mutant: string | null,
      ref: TestMethodRef,
      opts: RunOpts,
      started: boolean,
    ) => {
      if (ref.method !== "T1") return "pass";
      if (mutant === "M0001") return "fail";
      return mutant === null && started && opts.alone !== true ? "fail" : "pass";
    };
    const marked = new AloneStub(inContextFails);
    marked.markAlone = (m) => m === "T1";
    expect(m1(await session(marked))?.verdict).toBe("killed");
    const plain = new AloneStub(inContextFails);
    const report = await session(plain);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("unstable");
  });

  test("A4: a first TIMEOUT marked alone gets an alone cold confirm and no noteMeasured; one not marked feeds it", async () => {
    // The confirm passes with a long wall but a short own time, so the 2x rule holds and a
    // noteMeasured would raise T1's budget for the next mutant (M0002 onwards).
    const make = (alone: boolean) => {
      const b = new AloneStub(plan("timeout"));
      b.inRunStopIsBudget = true;
      b.markAlone = (m) => alone && m === "T1";
      b.decorate = (active, _opts, v) =>
        v.outcome === "timeout"
          ? { ...v, timeoutIn: "body" as const }
          : v.outcome === "pass" && active === null && b.activations.some((a) => a !== null)
            ? { ...v, durationMs: 5000, measuredDurationMs: 10 }
            : v;
      return b;
    };
    const laterBudget = (b: AloneStub) =>
      b.runs.find((r) => r.mutant !== null && r.mutant !== "M0001" && r.method === "T1")?.ms;
    const marked = make(true);
    const mr = await session(marked, { mutantTimeoutMs: 100 });
    expect(m1(mr)?.verdict).toBe("timeout-killed");
    expect(t1Runs(marked).slice(0, 4)).toEqual([
      "null:false",
      "M0001:false",
      "null:true",
      "M0001:true",
    ]);
    expect(laterBudget(marked)).toBe(100);
    const plain = make(false);
    await session(plain, { mutantTimeoutMs: 100 });
    expect(laterBudget(plain)).toBe(10000);
  });

  test("A5: a fail NOT marked alone keeps the pair and the in-context confirm", async () => {
    const b = new AloneStub(plan("fail"));
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(b.pairs).toContain("M0001 T1");
    expect(b.runs.some((r) => r.alone)).toBe(false);
  });

  test("A6: a per-test isolated (method) kill marked alone keeps its verdict: the same one-test request", async () => {
    const b = new AloneStub(plan("fail"));
    b.markAlone = (m) => m === "T1";
    b.isolationOf = () => "method";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killReproduced).toBe(true);
    expect(b.pairs).toEqual([]);
  });

  test("A8: a PR-51 held timeout measured alone gets an alone confirm on replay; the cut restore does not change it", async () => {
    const b = new AloneStub(plan("timeout"));
    b.markAlone = (m) => m === "T1";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(t1Runs(b).slice(0, 4)).toEqual(["null:false", "M0001:false", "null:true", "M0001:true"]);
    expect(b.restored).toEqual([1]);
  });

  test("A9: a backend that never marks a verdict alone never receives opts.alone, for any kill or timeout", async () => {
    for (const outcome of ["fail", "timeout"] as const) {
      const b = new AloneStub(plan(outcome));
      b.decorate = (_a, opts, v) => {
        if (opts.alone === true)
          throw new Error("opts.alone reached a backend that never marks alone");
        const { selection: _drop, ...rest } = v;
        return rest;
      };
      const report = await session(b);
      expect(m1(report)?.verdict).toBe(outcome === "fail" ? "killed" : "timeout-killed");
    }
  });

  test("A10: a step marked alone at group position > 1 throws", async () => {
    class GroupAlone extends AloneStub {
      async runMany(opts: RunManyOpts): Promise<RunManyResult> {
        const second = opts.methods[1];
        if (second === undefined) throw new Error("test stub: needs a call of two methods");
        return {
          kind: "call",
          methodIndex: 2,
          verdict: { ref: second.ref, outcome: "fail", durationMs: 1, selection: "alone" },
          fencedOp: { attemptId: "g1", opSeq: 101 },
        };
      }
    }
    const b = new GroupAlone(() => "pass");
    const error = await session(b, { groupRuns: { maxMethodsPerCall: 3 } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error | undefined)?.message).toContain("marked alone at group position 2");
  });
});
