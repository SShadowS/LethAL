import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  RunOpts,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { createEmitter } from "../src/events";
import type { RunEvent } from "../src/events";
import { cappedWalkNote, runSession } from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-108: (1) R1057's cap on PR-51's held-timeout walk: the 3rd hang ends the walk as a natural end
 * does, and today's after-walk code replays the held step. (2) R1014: the CLOCK budget (or a signal, never a memory stop) is checked
 * before each covering step; a spent one drops the mutant unrecorded. The stub is a trimmed copy of
 * `pr51-held-timeout.test.ts`'s `HeldStub` chain (those classes are not exported).
 */

const scratch = scratchDirs();
const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
    end;
}
`;
const APP_JSON = JSON.stringify(
  {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Sandbox Orchestrator Fixture",
    publisher: "LethAL",
    version: "1.0.0.0",
    idRanges: [{ from: 79000, to: 79199 }],
  },
  null,
  2,
);
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
const CAPS: BackendCapabilities = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
};
const selectorIds = { selectorId: 50000, controlId: 50001, tableId: 50002 };

async function makeProject() {
  const root = scratch("lethal-pr108-");
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

type StopInfo = {
  readonly usedBytes: number;
  readonly boundBytes: number;
  readonly source: string;
};

class CapStub implements ExecutionBackend {
  readonly killsMustReproduce = true;
  readonly runnerBuild = async () => ({
    version: "alrunner 3.0.0-alpha.2 (91253f2d6)",
    binarySha256: "b".repeat(64),
  });
  activations: Array<string | null> = [];
  readonly trace: string[] = [];
  readonly sent: Array<{ mutant: string | null; method: string }> = [];
  answer?: (mutant: string | null, n: number, v: TestVerdict) => TestVerdict | undefined;
  /** Called with every mutated run's method, before it answers (a call counter, never a clock). */
  onMutatedRun?: (method: string) => void;
  private handle: { stopForMemory(info: StopInfo): void } | undefined;
  private readonly nth = new Map<string, number>();
  constructor(
    private readonly script: (mutant: string | null, ref: TestMethodRef) => TestVerdict["outcome"],
  ) {}
  useStopHandle(h: { stopForMemory(info: StopInfo): void }): void {
    this.handle = h;
  }
  memoryStop(): void {
    this.handle?.stopForMemory({ usedBytes: 2, boundBytes: 1, source: "test" });
  }
  capabilities() {
    return CAPS;
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  async deploy() {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null) {
    this.trace.push(`activate ${id ?? "null"}`);
    this.activations.push(id);
  }
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const n = active === null ? 0 : (this.nth.get(`${active}/${ref.method}`) ?? 0) + 1;
    if (active !== null) {
      this.nth.set(`${active}/${ref.method}`, n);
      this.onMutatedRun?.(ref.method);
    }
    this.sent.push({ mutant: active, method: ref.method });
    const outcome = this.script(active, ref);
    const hasCoverage = active === null;
    const hasAttestation = opts.coverage === "none";
    const base: TestVerdict = {
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
      ...(hasAttestation ? { attestation: { observedAny: true, identityMismatch: false } } : {}),
      ...(hasAttestation ? { reachedActive: active !== null } : {}),
    };
    const v = this.answer?.(active, n, base) ?? base;
    this.trace.push(`run ${active ?? "null"} ${ref.method} ${v.outcome}`);
    return v;
  }
}

describe("PR-108: the 3-hang cap ends the walk (addendum 2)", () => {
  type Outcome = TestVerdict["outcome"];
  type Plan = Record<string, Outcome | ((nth: number) => Outcome)>;
  const make = (plan: Plan): CapStub => {
    const b: CapStub = new CapStub((mutant, ref) => {
      if (mutant !== "M0001") return "pass";
      const p = plan[ref.method];
      if (p === undefined) return "pass";
      return typeof p === "function" ? p(nthOf(b, ref.method)) : p;
    });
    return b;
  };
  /** M0001's mutated runs of `method` so far (the current one included). */
  const nthOf = (b: CapStub, method: string) =>
    b.sent.filter((s) => s.mutant === "M0001" && s.method === method).length;
  /** The unmutated confirms of `method` (the baseline's own run is not one). */
  const confirms = (b: CapStub, method: string) =>
    b.trace.filter((t) => t.startsWith(`run null ${method} `)).length - 1;
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
  const sessionWithWarnings = async (backend: ExecutionBackend) => {
    const events: RunEvent[] = [];
    const report = await session(backend, { emit: [createEmitter([(e) => events.push(e)])] });
    const capWarnings = events.flatMap((e) =>
      e.type === "warning" && e.code === "held-walk-capped" ? [e.message] : [],
    );
    return { report, capWarnings };
  };
  const CAP_NOTE = "the walk stopped after 3 timeouts (PR-108, R1057's cap)";

  test("C1: 4 covering tests that all hang -> exactly 3 hang steps and the replay, timeout-killed, with the cap note", async () => {
    const b = make({ T1: "timeout", T2: "timeout", T3: "timeout", T4: "timeout" });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    // red without the cap: T4 and T5 were run, and there is no note
    expect(nthOf(b, "T4")).toBe(0);
    expect(nthOf(b, "T5")).toBe(0);
    // T1: the walk run and the reproduction; one unmutated confirm.
    expect(nthOf(b, "T1")).toBe(2);
    expect(confirms(b, "T1")).toBe(1);
    expect(m1(report)?.failureNote).toContain(
      `${CAP_NOTE}; 2 covering test(s) after them were not run`,
    );
  });

  test("C2: 2 hangs then a fail -> killed, the cap not reached", async () => {
    const b = make({ T1: "timeout", T2: "timeout", T3: "fail" });
    const report = await session(b);
    // red with the cap at 2: the walk is replayed at the 2nd hang and reads timeout-killed
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T3");
    expect(m1(report)?.failureNote ?? "").not.toContain("PR-108");
  });

  test("C3: 3 hangs then a later fail -> timeout-killed (the documented move), no 4th step is fed", async () => {
    const b = make({ T1: "timeout", T2: "timeout", T3: "timeout", T4: "fail" });
    const report = await session(b);
    // red without the cap: killed by T4
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(nthOf(b, "T4")).toBe(0);
    expect(m1(report)?.failureNote).toContain(CAP_NOTE);
  });

  test("C4: the replay's own timeouts do not count toward the cap", async () => {
    // 2 hangs only. If the replayed (reproduced) timeout counted, the walk would read as capped.
    const b = make({ T1: "timeout", T2: "timeout" });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.failureNote ?? "").not.toContain("PR-108");
    expect(nthOf(b, "T5")).toBe(1);
  });

  test("C5: the held confirm fails at the cap, a later test would fail -> error (move 2), named in the warning, T4 never fed", async () => {
    const b = make({ T1: "timeout", T2: "timeout", T3: "timeout", T4: "fail" });
    // T1's unmutated confirm (its second null run; the first is the baseline) hangs too.
    b.answer = (mutant, _n, v) =>
      mutant === null &&
      v.ref.method === "T1" &&
      b.trace.filter((t) => t.startsWith("run null T1 ")).length >= 1
        ? { ...v, outcome: "timeout" }
        : undefined;
    const { report, capWarnings } = await sessionWithWarnings(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("unstable");
    expect(m1(report)?.failureNote).toContain(`${CAP_NOTE}; 2 covering test(s)`);
    expect(nthOf(b, "T4")).toBe(0);
    expect(capWarnings).toHaveLength(1);
    expect(capWarnings[0]).toContain("M0001");
    expect(capWarnings[0]).toContain("verdict error");
    expect(capWarnings[0]).toContain("2 covering test(s)");
  });

  test("C6: none of the 3 hangs reproduces, only a 4th would -> error (move 3), the 4th never fed", async () => {
    const b = make({
      T1: (n) => (n === 1 ? "timeout" : "pass"),
      T2: (n) => (n === 1 ? "timeout" : "pass"),
      T3: (n) => (n === 1 ? "timeout" : "pass"),
      T4: "timeout",
    });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("kill-not-reproduced");
    expect(m1(report)?.failureNote).toContain(CAP_NOTE);
    expect(nthOf(b, "T4")).toBe(0);
  });

  test("C8: the 3rd hang is the last covering test (k = 0): the walk is still noted and warned", async () => {
    const b = make({ T3: "timeout", T4: "timeout", T5: "timeout" });
    const { report, capWarnings } = await sessionWithWarnings(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.failureNote).toContain(`${CAP_NOTE}; 0 covering test(s) after them`);
    expect(capWarnings).toHaveLength(1);
  });

  test("C9: a walk with fewer than 3 hangs has no cap warning", async () => {
    const b = make({ T1: "timeout", T2: "timeout" });
    const { capWarnings } = await sessionWithWarnings(b);
    expect(capWarnings).toEqual([]);
  });

  test("C10: cappedWalkNote counts the ordered refs after the 3rd hang minus skipped codeunits, and a missing ref throws", () => {
    const ref = (codeunitId: number, method: string): TestMethodRef => ({
      codeunitId,
      codeunitName: `CU${codeunitId}`,
      method,
    });
    const ordered = [ref(1, "A"), ref(1, "B"), ref(2, "C"), ref(2, "D"), ref(3, "E")];
    expect(cappedWalkNote(ordered, ref(1, "B"), new Set(), "M1").k).toBe(3);
    expect(cappedWalkNote(ordered, ref(1, "B"), new Set([2]), "M1").k).toBe(1);
    expect(cappedWalkNote(ordered, ref(3, "E"), new Set(), "M1").k).toBe(0);
    expect(() => cappedWalkNote(ordered, ref(9, "Z"), new Set(), "M1")).toThrow("caller-contract");
  });

  test("C7: a 3rd hang that alone reproduces -> timeout-killed by the 3rd, with the cap note", async () => {
    const b = make({
      T1: (n) => (n === 1 ? "timeout" : "pass"),
      T2: (n) => (n === 1 ? "timeout" : "pass"),
      T3: "timeout",
    });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T3");
    expect(m1(report)?.failureNote).toContain(`${CAP_NOTE}; 2 covering test(s)`);
  });
});

describe("PR-108: the clock budget inside a walk (R1014)", () => {
  type Outcome = TestVerdict["outcome"];
  const make = (plan: Record<string, Outcome>): CapStub =>
    new CapStub((mutant, ref) => (mutant === "M0001" ? (plan[ref.method] ?? "pass") : "pass"));
  const nthOf = (b: CapStub, method: string) =>
    b.sent.filter((s) => s.mutant === "M0001" && s.method === method).length;
  const confirms = (b: CapStub, method: string) =>
    b.trace.filter((t) => t.startsWith(`run null ${method} `)).length - 1;
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
  /** 10 s of clock per mutated run of M0001 (a call counter): a 15 s budget is spent after its 2nd step. */
  const clocked = (b: CapStub, seconds: number): Partial<SessionConfig> => ({
    timeBudgetSeconds: seconds,
    clockMs: () => b.sent.filter((s) => s.mutant === "M0001").length * 10_000,
  });

  test("B1: a budget spent after the 2nd step -> no further step, no stored mutant, counted as left out, no replay", async () => {
    const b = make({ T1: "timeout" });
    const report = await session(b, clocked(b, 15));
    // red without the in-walk check: the walk ran on, the held step was replayed and recorded
    expect(m1(report)).toBeUndefined();
    expect(nthOf(b, "T1")).toBe(1);
    expect(nthOf(b, "T2")).toBe(1);
    expect(nthOf(b, "T3")).toBe(0);
    expect(confirms(b, "T1")).toBe(0);
    expect(report.timeBudget?.unscheduledCount).toBeGreaterThanOrEqual(1);
  });

  test("B2: the other direction: with the budget not spent, the same walk completes with today's verdict", async () => {
    const b = make({ T1: "timeout" });
    const report = await session(b, clocked(b, 1000));
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(nthOf(b, "T5")).toBe(1);
    expect(report.timeBudget).toBeUndefined();
  });

  test("B3: a walk with NO held step, cut by the budget -> no row, no group-coverage-incomplete", async () => {
    const b = make({});
    const report = await session(b, clocked(b, 15));
    expect(m1(report)).toBeUndefined();
    expect(report.mutants.some((m) => m.cause === "group-coverage-incomplete")).toBe(false);
    expect(nthOf(b, "T3")).toBe(0);
    expect(report.timeBudget?.unscheduledCount).toBeGreaterThanOrEqual(1);
  });

  test("B4: a memory-guard stop mid-walk does not cut it: the walk continues and its verdict is recorded", async () => {
    const b = make({ T1: "timeout" });
    b.onMutatedRun = (method) => {
      if (method === "T2") b.memoryStop();
    };
    const report = await session(b);
    // red if the cut also fired on a memory stop: no row
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(nthOf(b, "T5")).toBe(1);
  });
});
