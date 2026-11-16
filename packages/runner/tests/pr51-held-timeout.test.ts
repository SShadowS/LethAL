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
import { runSession } from "../src/orchestrator";
import type { SessionConfig } from "../src/orchestrator";
import type { SessionReport } from "../src/report";
import { SessionSafety } from "../src/session-safety";
import { GROUP_SUITE_UNRESOLVED_HEAD, runMutantLineCountMessage } from "../src/stale-test-app";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";

/**
 * PR-51 (R1057): a timeout is HELD while the walk looks for a kill, so the class of a mutant does
 * not depend on which covering test is met first. The stubs below are trimmed copies of the ones in
 * `orchestrator.test.ts` (StubBackend, GroupStubBackend, WarmStubBackend, ReproStub, ReproWarmStub,
 * PairStub, DiscoveryStub), which live in that file's scope and are not exported; that file is over
 * biome's size limit, so these tests live here.
 */

const scratch = scratchDirs();
async function v3RunnerBuild(): Promise<{ version: string; binarySha256: string }> {
  return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
}
/** Each call gets its own directory, so tests never share quarantine state. */
function freshTmpDir(): string {
  return scratch("lethal-orch-quarantine-");
}

const TARGET_AL = `codeunit 79000 "Sandbox Logic"
{
    procedure IsOverBudget(Amount: Decimal; Budget: Decimal): Boolean
    begin
        exit(Amount > Budget);
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
const DISCOVERY_TESTS_AL = `codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    [Test]
    procedure T1() begin end;
    [Test]
    procedure T2() begin end;
}

codeunit 79101 "Zulu Tests"
{
    Subtype = Test;

    [Test]
    procedure K1() begin end;
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

async function makeProject(testAl: string) {
  const root = scratch("lethal-orch-");
  const projectDir = join(root, "app");
  const testDir = join(root, "tests");
  const instrumentedDir = join(root, "instr");
  await Bun.write(join(projectDir, "SandboxLogic.Codeunit.al"), TARGET_AL);
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(testDir, "SandboxTests.Codeunit.al"), testAl);
  await Bun.write(
    join(testDir, "app.json"),
    '{"name":"Tests","publisher":"P","version":"1.0.0.0"}',
  );
  return { projectDir, testDir, instrumentedDir };
}

class StubBackend implements ExecutionBackend {
  readonly runnerBuild = v3RunnerBuild;
  activations: Array<string | null> = [];
  constructor(
    private readonly caps: BackendCapabilities,
    private readonly script: (
      mutant: string | null,
      ref: TestMethodRef,
      opts: RunOpts,
    ) => TestVerdict["outcome"],
    private readonly coverageProcedures: string[] = [],
  ) {}
  capabilities() {
    return this.caps;
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
  async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const outcome = this.script(active, ref, opts);
    const hasCoverage = active === null && this.caps.coverage !== "none";
    const hasAttestation = this.caps.authoritative && opts.coverage === "none";
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
      ...(hasAttestation ? { attestation: { observedAny: true, identityMismatch: false } } : {}),
      ...(hasAttestation ? { reachedActive: active !== null } : {}),
    };
  }
}

class GroupStubBackend extends StubBackend {
  /** Every `runMany` call this backend answered, with what it was asked. */
  readonly manyCalls: RunManyOpts[] = [];
  private manySeq = 0;
  async runMany(opts: RunManyOpts): Promise<RunManyResult> {
    this.manySeq += 1;
    this.manyCalls.push(opts);
    const fencedOp = { attemptId: `g${this.manySeq}`, opSeq: 100 + this.manySeq };
    const verdicts: TestVerdict[] = [];
    let endedBy: "complete" | "failure" | "cap" = "complete";
    for (const m of opts.methods) {
      const v = await this.run(m.ref, { coverage: "none", timeoutMs: m.budgetMs });
      verdicts.push(v);
      if (v.outcome !== "pass") {
        endedBy = "failure";
        break;
      }
    }
    return {
      kind: "verdicts",
      endedBy,
      ranCount: verdicts.length,
      verdicts,
      durationMs: verdicts.length * 5,
      fencedOp,
    };
  }
}

/** A session-scoped group stub whose own watchdog can stop a method (a call-level timeout). */
class WarmStubBackend extends GroupStubBackend {
  nextSessionId = 1000;
  /** A timeout the fake's own watchdog scores for this method under this mutant, with its duration. */
  timeoutFor?: (mutant: string | null, ref: TestMethodRef, position: number) => number | undefined;
  private warmSeq = 0;
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const v = await super.run(ref, opts);
    return { ...v, sessionId: this.nextSessionId++, testRunsBefore: 0 };
  }
  override async runMany(opts: RunManyOpts): Promise<RunManyResult> {
    this.warmSeq += 1;
    const sessionId = this.nextSessionId++;
    this.manyCalls.push(opts);
    const fencedOp = { attemptId: `w${this.warmSeq}`, opSeq: 500 + this.warmSeq };
    const active = this.activations.at(-1) ?? null;
    const verdicts: TestVerdict[] = [];
    let endedBy: "complete" | "failure" | "cap" = "complete";
    for (const [i, m] of opts.methods.entries()) {
      const stopAt = this.timeoutFor?.(active, m.ref, i + 1);
      if (stopAt !== undefined) {
        return {
          kind: "call",
          methodIndex: i + 1,
          verdict: {
            ref: m.ref,
            outcome: "timeout",
            durationMs: stopAt,
            failureMessage: `stopped ${m.ref.method} after ${stopAt} ms (fake 408)`,
          },
          fencedOp,
        };
      }
      const v = await StubBackend.prototype.run.call(this, m.ref, {
        coverage: "none",
        timeoutMs: m.budgetMs,
      });
      verdicts.push({ ...v, sessionId, testRunsBefore: 0 });
      if (v.outcome !== "pass") {
        endedBy = "failure";
        break;
      }
    }
    return {
      kind: "verdicts",
      endedBy,
      ranCount: verdicts.length,
      verdicts,
      durationMs: verdicts.length * 5,
      fencedOp,
    };
  }
}

/** R577: a stub with the rule ON, counting mutated runs and logging every activation and run. */
class ReproStub extends StubBackend {
  readonly killsMustReproduce = true;
  readonly nth = new Map<string, number>();
  readonly trace: string[] = [];
  readonly sent: Array<{ mutant: string | null; method: string; timeoutMs: number }> = [];
  answer?: (mutant: string | null, n: number, v: TestVerdict) => TestVerdict | undefined;
  override async activate(id: string | null) {
    this.trace.push(`activate ${id ?? "null"}`);
    await super.activate(id);
  }
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const n = active === null ? 0 : (this.nth.get(active) ?? 0) + 1;
    if (active !== null) this.nth.set(active, n);
    this.sent.push({ mutant: active, method: ref.method, timeoutMs: opts.timeoutMs });
    const base = await super.run(ref, opts);
    const v = this.answer?.(active, n, base) ?? base;
    this.trace.push(`run ${active ?? "null"} ${ref.method} ${v.outcome}`);
    return v;
  }
}

/** R577: the warm group stub with the rule on. */
class ReproWarmStub extends WarmStubBackend {
  readonly killsMustReproduce = true;
  /** Every non-confirmation `runMany` under `mutant`, as its method names, in order. */
  callsUnder(mutant: string): string[][] {
    return this.callLog.filter((c) => c.mutant === mutant).map((c) => c.methods);
  }
  private readonly callLog: Array<{ mutant: string | null; methods: string[] }> = [];
  override async runMany(opts: RunManyOpts): Promise<RunManyResult> {
    if (opts.confirmation !== true) {
      this.callLog.push({
        mutant: this.activations.at(-1) ?? null,
        methods: opts.methods.map((x) => x.ref.method),
      });
    }
    return super.runMany(opts);
  }
}

/** R653: a ReproStub that logs `sendKillPair` into the same trace. */
class PairStub extends ReproStub {
  readonly pairs: string[] = [];
  async sendKillPair(mutantId: string, ref: TestMethodRef): Promise<void> {
    this.pairs.push(`${mutantId} ${ref.method}`);
    this.trace.push(`pair ${mutantId} ${ref.method}`);
  }
}

/** R688: a stub whose single runs can answer BC's found-0 for a method under a mutant. */
class DiscoveryStub extends GroupStubBackend {
  blanks: (mutant: string) => readonly number[] = () => [];
  blanksMethod?: (mutant: string, ref: TestMethodRef) => boolean;
  readonly runs: Array<{
    active: string | null;
    started: boolean;
    codeunitId: number;
    method: string;
  }> = [];
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    const started = this.activations.some((a) => a !== null);
    this.runs.push({ active, started, codeunitId: ref.codeunitId, method: ref.method });
    if (
      active !== null &&
      (this.blanks(active).includes(ref.codeunitId) || this.blanksMethod?.(active, ref) === true)
    ) {
      return {
        ref,
        outcome: "error",
        durationMs: 1,
        failureMessage: runMutantLineCountMessage(
          0,
          `expected exactly one method ${ref.method}, found 0`,
        ),
      };
    }
    return super.run(ref, opts);
  }
}
void GROUP_SUITE_UNRESOLVED_HEAD;

class HeldStub extends PairStub {
  /** Every run: the active mutant, the method, and whether the run asked for `alone`. */
  readonly aloneRuns: Array<{ mutant: string | null; method: string; alone: boolean }> = [];
  /** Marks a mutated fail as measured ALONE (`selection: "alone"`), as v3 does. */
  markAlone?: (method: string) => boolean;
  /** Addendum 1: a v3-like cut state. `cutState` hands out 1, 2, ...; `restored` logs each put-back. */
  private cuts = 0;
  readonly restored: unknown[] = [];
  cutState(_mutantId: string): unknown {
    this.cuts += 1;
    return this.cuts;
  }
  restoreCutState(_mutantId: string, state: unknown): void {
    this.restored.push(state);
  }
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    this.aloneRuns.push({ mutant: active, method: ref.method, alone: opts.alone === true });
    const v = await super.run(ref, opts);
    return active !== null && v.outcome === "fail" && this.markAlone?.(ref.method) === true
      ? { ...v, selection: "alone" as const }
      : v;
  }
}

describe("PR-51: a timeout is held while the walk looks for a kill", () => {
  type Outcome = TestVerdict["outcome"];
  type Plan = Record<string, Outcome | ((nth: number) => Outcome)>;
  const NAME = (method: string) => `Sandbox Tests.${method}`;
  const make = (
    plan: Plan,
    answer?: (method: string, nth: number, v: TestVerdict) => TestVerdict | undefined,
  ): HeldStub => {
    const b: HeldStub = new HeldStub(
      CAPS_NST,
      (mutant, ref) => {
        if (mutant !== "M0001") return "pass";
        const p = plan[ref.method];
        if (p === undefined) return "pass";
        return typeof p === "function" ? p(nthOf(b, ref.method)) : p;
      },
      ["IsOverBudget"],
    );
    if (answer !== undefined) {
      b.answer = (mutant, _n, v) =>
        mutant === "M0001" ? answer(v.ref.method, nthOf(b, v.ref.method), v) : undefined;
    }
    return b;
  };
  /** M0001's mutated runs of `method` so far (the current one included). */
  const nthOf = (b: ReproStub, method: string) =>
    b.sent.filter((s) => s.mutant === "M0001" && s.method === method).length;
  /** The unmutated confirms of `method` (the baseline's own run is not one). */
  const confirms = (b: ReproStub, method: string) =>
    b.trace.filter((t) => t.startsWith(`run null ${method} `)).length - 1;
  const session = async (
    backend: ExecutionBackend,
    extra: Partial<SessionConfig> = {},
  ): Promise<SessionReport> => {
    const dirs = await makeProject(FIVE_TESTS_AL);
    const store = new ResultsStore(":memory:");
    try {
      return await runSession({ backend, store, ...dirs, selectorIds, ...extra });
    } finally {
      store.close();
    }
  };
  const m1 = (r: SessionReport) => r.mutants.find((m) => m.mutantCode === "M0001");
  const REFUSED = "NotRun: out-of-scope: Commit [not run by al-runner v3]";

  test("P1: hang then fail -> killed with the failing test; the hung test is never confirmed", async () => {
    const b = make({ T1: "timeout", T2: "fail" });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T2");
    expect(m1(report)?.killReproduced).toBe(true);
    expect(m1(report)?.failureNote).toContain(`the timeout of ${NAME("T1")} was not scored`);
    expect(confirms(b, "T1")).toBe(0);
    expect(nthOf(b, "T1")).toBe(1);
    expect(nthOf(b, "T3")).toBe(0);
  });

  test("P2: hang, pass, hang -> timeout-killed with the FIRST hang; the second is only named", async () => {
    const b = make({ T1: "timeout", T3: "timeout" });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.failureNote).toContain(
      `after the timeout: ${NAME("T2")}, ${NAME("T3")}, ${NAME("T4")}, ${NAME("T5")}`,
    );
    // T1: the kill and its reproduction. T3: the one walk run, never confirmed or reproduced.
    expect(nthOf(b, "T1")).toBe(2);
    expect(confirms(b, "T1")).toBe(1);
    expect(nthOf(b, "T3")).toBe(1);
    expect(confirms(b, "T3")).toBe(0);
  });

  test("P3: fail first, then a would-be hang -> killed, the hang is never run", async () => {
    const b = make({ T1: "fail", T2: "timeout" });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.failureNote).toBeUndefined();
    expect(nthOf(b, "T2")).toBe(0);
  });

  test("P4: hang then a fail that does not reproduce -> timeout-killed by the hang", async () => {
    const b = make({ T1: "timeout", T2: (n) => (n === 1 ? "fail" : "pass") });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.cause).toBeUndefined();
    // T2's fail was confirmed and reproduced (and did not repeat) before the walk went on.
    expect(confirms(b, "T2")).toBe(1);
    expect(nthOf(b, "T2")).toBe(2);
  });

  test("P5a: hang then a session-reused fail -> the walk ends, the held timeout is scored, no later test runs", async () => {
    const b = make({ T1: "timeout", T2: "fail" }, (method, _n, v) =>
      method === "T2" ? { ...v, testRunsBefore: 3, sessionId: 7 } : undefined,
    );
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.cause).toBeUndefined();
    expect(m1(report)?.failureNote ?? "").not.toContain("session-reused");
    expect(nthOf(b, "T3")).toBe(0);
  });

  test("P5b: hang then a fail whose confirm is unstable -> the walk ends, the held timeout is scored, no later test runs", async () => {
    // T2 fails under M0001 and again in its unmutated confirm (its second null run; the first is
    // the baseline, which passes).
    const b = make({ T1: "timeout", T2: "fail" });
    b.answer = (mutant, _n, v) =>
      mutant === null &&
      v.ref.method === "T2" &&
      b.trace.filter((t) => t.startsWith("run null T2 ")).length >= 1
        ? { ...v, outcome: "fail" }
        : undefined;
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.cause).toBeUndefined();
    expect(m1(report)?.failureNote ?? "").not.toContain("unstable");
    expect(nthOf(b, "T3")).toBe(0);
  });

  test("P6: hang then a stranded step -> the strand stands, the held timeout is named after its prefix, no further call", async () => {
    const b = make({ T1: "timeout" }, (method, _n, v) =>
      method === "T2"
        ? { ref: v.ref, outcome: "error", durationMs: 1, operation: "in-flight-unknown" }
        : undefined,
    );
    const report = await session(b, {
      quarantineDir: freshTmpDir(),
      nowIso: () => "2026-07-20T12:00:00.000Z",
      resourceServer: "http://cronus281",
      resourceServerInstance: "BC",
    });
    const row = m1(report);
    expect(row?.verdict).toBe("error");
    expect(row?.cause).toBe("stranded");
    expect(row?.failureNote?.startsWith("quarantined: ")).toBe(true);
    expect(row?.failureNote).toContain(NAME("T1"));
    expect((row?.failureNote ?? "").indexOf(NAME("T1"))).toBeGreaterThan(
      (row?.failureNote ?? "").indexOf("quarantined: "),
    );
    expect(b.trace.at(-1)).toBe("run M0001 T2 error");
    expect(confirms(b, "T1")).toBe(0);
  });

  test("P7: hang then a deadline-exceeded step -> terminal, the held timeout is not confirmed", async () => {
    const b = make({ T1: "timeout" }, (method, _n, v) =>
      method === "T2" ? { ref: v.ref, outcome: "deadline-exceeded", durationMs: 1 } : undefined,
    );
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("deadline-exceeded");
    expect(m1(report)?.failureNote).toContain(NAME("T1"));
    expect(confirms(b, "T1")).toBe(0);
    expect(b.trace.filter((t) => t.startsWith("run M0001 ")).at(-1)).toBe(
      "run M0001 T2 deadline-exceeded",
    );
    expect(nthOf(b, "T3")).toBe(0);
  });

  test("P8: hang then a transport error -> today's session abort with the later test's note, no held confirm", async () => {
    const b = make({ T1: "timeout" }, (method, _n, v) =>
      method === "T2"
        ? { ref: v.ref, outcome: "error", durationMs: 1, failureMessage: "wire down" }
        : undefined,
    );
    const error = await session(b).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("backend transport error");
    expect((error as Error).message).toContain("T2");
    expect((error as Error).message).toContain("wire down");
    expect(confirms(b, "T1")).toBe(0);
    expect(b.trace.filter((t) => t.startsWith("run ")).at(-1)).toBe("run M0001 T2 error");
  });

  test("P9: hang then a flagged R639 refusal -> the walk goes on and a later fail kills", async () => {
    const b = make({ T1: "timeout", T3: "fail" }, (method, _n, v) =>
      method === "T2"
        ? {
            ref: v.ref,
            outcome: "error",
            durationMs: 1,
            failureMessage: REFUSED,
            operation: "completed-accepted",
            runnerRow: "runner-refused",
            refusedAfterStop: "T1",
          }
        : undefined,
    );
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T3");
    expect(nthOf(b, "T3")).toBeGreaterThan(0);
  });

  test("P10: hang then a found-0 -> confirmed, skipped, the mutant re-activated, the walk goes on", async () => {
    const dirs = await makeProject(DISCOVERY_TESTS_AL);
    const b = new DiscoveryStub(
      CAPS_NST,
      (mutant, ref) => (mutant === "M0001" && ref.method === "T1" ? "timeout" : "pass"),
      ["IsOverBudget"],
    );
    b.blanks = () => [];
    b.blanksMethod = (mutant, ref) => mutant === "M0001" && ref.method === "T2";
    const store = new ResultsStore(":memory:");
    const report = await runSession({
      backend: b,
      store,
      ...dirs,
      selectorIds,
      groupRuns: { enabled: false },
    });
    store.close();
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.failureNote).toContain("were skipped under this mutant");
    // K1 (the other codeunit) ran under M0001 after the found-0's confirm re-activated it.
    expect(b.runs.filter((r) => r.active === "M0001" && r.method === "K1").length).toBe(1);
    expect(b.runs.filter((r) => r.active === null && r.started && r.method === "T2").length).toBe(
      1,
    );
  });

  describe("a held WARM timeout (position 2 of a call of 3)", () => {
    const warm = (plan: Plan) => {
      const b: ReproWarmStub = new ReproWarmStub(
        CAPS_NST,
        (mutant, ref) => {
          if (mutant !== "M0001") return "pass";
          const p = plan[ref.method];
          return p === undefined || typeof p === "function" ? "pass" : p;
        },
        ["IsOverBudget"],
      );
      b.timeoutFor = (mutant, ref) =>
        mutant === "M0001" && ref.method === "T2" ? 999_999 : undefined;
      return b;
    };
    const confirmCalls = (b: ReproWarmStub) =>
      b.manyCalls
        .filter((c) => c.confirmation === true)
        .map((c) => c.methods.map((x) => x.ref.method));

    test("the deferred confirm and the reproduction replay the HELD call's prefix", async () => {
      const b = warm({});
      const report = await session(b, { groupRuns: { maxMethodsPerCall: 3 } });
      expect(m1(report)?.verdict).toBe("timeout-killed");
      expect(m1(report)?.killPosition).toBe(2);
      expect(b.callsUnder("M0001")).toEqual([
        ["T1", "T2", "T3"],
        ["T3", "T4", "T5"],
        ["T1", "T2"],
      ]);
      expect(confirmCalls(b)).toEqual([["T1", "T2"]]);
    });

    test("a later kill in the NEXT call is confirmed and reproduced with only that call's prefix", async () => {
      const b = warm({ T4: "fail" });
      const report = await session(b, { groupRuns: { maxMethodsPerCall: 3 } });
      expect(m1(report)?.verdict).toBe("killed");
      expect(m1(report)?.killingTest).toContain("T4");
      expect(m1(report)?.killPosition).toBe(2);
      expect(b.callsUnder("M0001")).toEqual([
        ["T1", "T2", "T3"],
        ["T3", "T4", "T5"],
        ["T3", "T4"],
      ]);
      expect(confirmCalls(b)).toEqual([["T3", "T4"]]);
    });
  });

  test("P11 (F1): inside the held walk a fail marked alone is confirmed and reproduced alone, and no kill pair is sent", async () => {
    const b = make({ T1: "timeout", T2: "fail" });
    b.markAlone = (method) => method === "T2";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T2");
    expect(b.pairs).toEqual([]);
    const t2 = b.aloneRuns.filter(
      (r) => r.method === "T2" && (r.mutant === "M0001" || r.mutant === null),
    );
    // baseline (null, not alone), the covering run (M0001, not alone), the confirm (null, alone),
    // the reproduction (M0001, alone).
    expect(t2.map((r) => `${r.mutant ?? "null"}:${r.alone}`).slice(0, 4)).toEqual([
      "null:false",
      "M0001:false",
      "null:true",
      "M0001:true",
    ]);
  });

  test("P11b (F1): with no timeout held, a fail marked alone keeps today's in-context confirm and pair", async () => {
    const b = make({ T1: "fail" });
    b.markAlone = (method) => method === "T1";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(b.pairs).toContain("M0001 T1");
    expect(b.aloneRuns.some((r) => r.alone)).toBe(false);
  });

  test("P11c (F1): a fail marked alone whose alone confirm is unstable -> the walk ends and the held timeout is scored, no pair", async () => {
    const b: HeldStub = new HeldStub(
      CAPS_NST,
      (mutant, ref) => {
        if (mutant === "M0001")
          return ref.method === "T1" ? "timeout" : ref.method === "T2" ? "fail" : "pass";
        // unmutated: T2 fails when asked to run alone (the confirm), passes otherwise.
        return ref.method === "T2" && b.aloneRuns.at(-1)?.alone === true ? "fail" : "pass";
      },
      ["IsOverBudget"],
    );
    b.markAlone = (method) => method === "T2";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(b.pairs).toEqual([]);
    expect(nthOf(b, "T3")).toBe(0);
  });

  test("P12: a held timeout whose reproduction fails and no noted timeout is left -> error with the held note", async () => {
    const b = make({
      T1: (n) => (n === 1 ? "timeout" : "pass"),
      T2: (n) => (n === 1 ? "fail" : "pass"),
    });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("kill-not-reproduced");
    // The HELD timeout's note, not the earlier-met T2 fail's (the snapshot restore).
    expect(m1(report)?.failureNote).toContain("kill-not-reproduced T1:");
    expect(m1(report)?.failureNote).not.toContain("kill-not-reproduced T2:");
    expect(m1(report)?.failureNote).toContain(`after the timeout: ${NAME("T2")}`);
  });

  test("P14 (Addendum 1): a flaky first hang, then a real later hang -> timeout-killed by the later one; the cut state is put back before each replay", async () => {
    const b = make({ T1: (n) => (n === 1 ? "timeout" : "pass"), T3: "timeout" });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T3");
    expect(m1(report)?.cause).toBeUndefined();
    // T1: the walk run and its failed reproduction. T3: the walk run, the confirm, the reproduction.
    expect(nthOf(b, "T1")).toBe(2);
    expect(confirms(b, "T1")).toBe(1);
    expect(nthOf(b, "T3")).toBe(2);
    expect(confirms(b, "T3")).toBe(1);
    // State 1 was read at T1's step, 2 at T3's; each is put back before that step's replay.
    expect(b.restored).toEqual([1, 2]);
  });

  test("P14b: a flaky hang before and a real hang after, in the other order, give the same class", async () => {
    const b = make({ T1: "timeout", T3: (n) => (n === 1 ? "timeout" : "pass") });
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("timeout-killed");
    expect(m1(report)?.killingTest).toContain("T1");
  });

  test("P15 (Addendum 1): the walk ends with the session latched unsafe and nothing scored -> it throws, no survivor stands", async () => {
    // The last covering test (T5) passes, and the session is latched while it runs: no later call
    // reaches `assertSafe`, so the held timeout's own check is the only one left.
    const seen: { safety?: SessionSafety } = {};
    const original = SessionSafety.prototype.assertSafe;
    SessionSafety.prototype.assertSafe = function (this: SessionSafety, what: string) {
      seen.safety = this;
      return original.call(this, what);
    };
    try {
      const b = make({ T1: "timeout" }, (method, _n, v) => {
        if (method === "T5") seen.safety?.latchUnsafe("test: latched while T5 ran");
        return method === "T5" ? v : undefined;
      });
      const report = await session(b);
      // The throw is caught by runSession, which reports the latch; the mutant is not recorded.
      expect(report.quarantined?.reason).toContain("latched while T5 ran");
      expect(m1(report)).toBeUndefined();
      expect(confirms(b, "T1")).toBe(0);
    } finally {
      SessionSafety.prototype.assertSafe = original;
    }
  });

  test("P16 (Addendum 1): a held WARM timeout whose reproduction fails -> error with the held note", async () => {
    const b: ReproWarmStub = new ReproWarmStub(CAPS_NST, () => "pass", ["IsOverBudget"]);
    let stops = 0;
    // T2 is stopped under M0001 the first time only: the reproduction (second stop request) passes.
    b.timeoutFor = (mutant, ref) => {
      if (mutant !== "M0001" || ref.method !== "T2") return undefined;
      stops += 1;
      return stops === 1 ? 999_999 : undefined;
    };
    const report = await session(b, { groupRuns: { maxMethodsPerCall: 3 } });
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("kill-not-reproduced");
    expect(m1(report)?.failureNote).toContain("kill-not-reproduced T2:");
    // Walk call 1, walk call 2 (after the held timeout), then the replay's reproduction: the
    // held call's own prefix [T1, T2].
    expect(b.callsUnder("M0001")).toEqual([
      ["T1", "T2", "T3"],
      ["T3", "T4", "T5"],
      ["T1", "T2"],
    ]);
  });

  test("P13 (property): hang and fail in any order, sequential or grouped, give the same class: killed by the failing test", async () => {
    const methods = ["T1", "T2", "T3", "T4", "T5"];
    for (const hang of methods) {
      for (const fail of methods) {
        if (hang === fail) continue;
        const seq = make({ [hang]: "timeout", [fail]: "fail" });
        const a = await session(seq);
        expect([hang, fail, m1(a)?.verdict, m1(a)?.killingTest]).toEqual([
          hang,
          fail,
          "killed",
          fail,
        ]);
      }
    }
    for (const size of [2, 3, 5]) {
      for (const [hang, fail] of [
        ["T1", "T2"],
        ["T2", "T1"],
        ["T2", "T4"],
        ["T4", "T2"],
        ["T5", "T3"],
      ] as const) {
        const b: ReproWarmStub = new ReproWarmStub(
          CAPS_NST,
          (mutant, ref) => (mutant === "M0001" && ref.method === fail ? "fail" : "pass"),
          ["IsOverBudget"],
        );
        b.timeoutFor = (mutant, ref) =>
          mutant === "M0001" && ref.method === hang ? 999_999 : undefined;
        const g = await session(b, { groupRuns: { maxMethodsPerCall: size } });
        expect([size, hang, fail, m1(g)?.verdict, m1(g)?.killingTest]).toEqual([
          size,
          hang,
          fail,
          "killed",
          fail,
        ]);
      }
    }
  }, 120_000);
});
