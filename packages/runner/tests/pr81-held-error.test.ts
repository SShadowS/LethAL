import { afterEach, describe, expect, test } from "bun:test";
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
import { withheldKillOf } from "../src/report";
import { SessionSafety } from "../src/session-safety";
import { ResultsStore } from "../src/store";
import { scratchDirs } from "./helpers/scratch";
import { A, OPTS, SUITE, allPass, cleanRigs, laneBaseline, lanesRig } from "./helpers/v3-lanes-rig";
import type { FakeRow, RowsFn } from "./helpers/v3-lanes-rig";

/**
 * PR-81 (R1066): a non-terminal error met first is HELD like PR-51's timeout, so the class of a
 * mutant does not depend on whether its error or its kill is met first. The stubs are trimmed
 * copies of `pr51-held-timeout.test.ts`'s (neither file exports them).
 */

const scratch = scratchDirs();
afterEach(cleanRigs);
async function v3RunnerBuild(): Promise<{ version: string; binarySha256: string }> {
  return { version: "alrunner 3.0.0-alpha.2 (91253f2d6)", binarySha256: "b".repeat(64) };
}
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

class WarmStubBackend extends GroupStubBackend {
  nextSessionId = 1000;
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

class ReproStub extends StubBackend {
  readonly killsMustReproduce = true;
  readonly nth = new Map<string, number>();
  steps = 0;
  readonly trace: string[] = [];
  readonly sent: Array<{ mutant: string | null; method: string; timeoutMs: number }> = [];
  answer?: (mutant: string | null, n: number, v: TestVerdict) => TestVerdict | undefined;
  override async activate(id: string | null) {
    this.trace.push(`activate ${id ?? "null"}`);
    await super.activate(id);
  }
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    this.steps += 1;
    if (this.steps > 200) throw new Error("fake backend: more than 200 runs, the walk is looping");
    const n = active === null ? 0 : (this.nth.get(active) ?? 0) + 1;
    if (active !== null) this.nth.set(active, n);
    this.sent.push({ mutant: active, method: ref.method, timeoutMs: opts.timeoutMs });
    const base = await super.run(ref, opts);
    const v = this.answer?.(active, n, base) ?? base;
    this.trace.push(`run ${active ?? "null"} ${ref.method} ${v.outcome}`);
    return v;
  }
}

/** The warm group stub with the rule on; `inConfirm` is true while a confirmation replay runs. */
class ReproWarmStub extends WarmStubBackend {
  readonly killsMustReproduce = true;
  inConfirm = false;
  /** Methods the replay fails (without the mutant), while `inConfirm`. */
  failInConfirm = new Set<string>();
  readonly callLog: Array<{ mutant: string | null; methods: string[] }> = [];
  override async runMany(opts: RunManyOpts): Promise<RunManyResult> {
    if (opts.confirmation !== true) {
      this.callLog.push({
        mutant: this.activations.at(-1) ?? null,
        methods: opts.methods.map((x) => x.ref.method),
      });
    }
    this.inConfirm = opts.confirmation === true;
    try {
      return await super.runMany(opts);
    } finally {
      this.inConfirm = false;
    }
  }
}

/** A ReproStub that logs `sendKillPair` and models v3's pending pair (`pairRequests`). */
class HeldStub extends ReproStub {
  readonly pairs: string[] = [];
  readonly aloneRuns: Array<{ mutant: string | null; method: string; alone: boolean }> = [];
  markAlone?: (method: string) => boolean;
  async sendKillPair(mutantId: string, ref: TestMethodRef): Promise<void> {
    this.pairs.push(`${mutantId} ${ref.method}`);
    this.trace.push(`pair ${mutantId} ${ref.method}`);
    this.pending = mutantId;
  }
  /** v3's `lane.pair`: set by `sendKillPair`, read by the next `activate(mutantId)`. */
  pending: string | undefined;
  pairRequests = 0;
  override async run(ref: TestMethodRef, opts: RunOpts): Promise<TestVerdict> {
    const active = this.activations.at(-1) ?? null;
    this.aloneRuns.push({ mutant: active, method: ref.method, alone: opts.alone === true });
    const v = await super.run(ref, opts);
    return active !== null && v.outcome === "fail" && this.markAlone?.(ref.method) === true
      ? { ...v, selection: "alone" as const }
      : v;
  }
  override async activate(id: string | null) {
    if (id !== null && this.pending === id) {
      this.pairRequests += 1; // v3's `activateOn`: the pair's reproduction branch
      this.pending = undefined;
    }
    await super.activate(id);
  }
}

/** HeldStub with the hook: v3's `dropPendingPair`. */
class HookStub extends HeldStub {
  readonly dropped: string[] = [];
  dropPendingPair(mutantId: string): void {
    this.dropped.push(mutantId);
    this.trace.push(`drop ${mutantId}`);
    if (this.pending === mutantId) this.pending = undefined;
  }
}

type Outcome = TestVerdict["outcome"];
type Role = "pass" | "fail" | "timeout" | "session-reused" | "unstable" | "runner-refused";
const NAME = (method: string) => `Sandbox Tests.${method}`;
const REFUSED = "NotRun: out-of-scope: Commit [not run by al-runner v3]";
const PERM =
  "Sorry, the current permissions prevented the action. (TableData 79300 Data Main Insert: Suite)";
const refusedRow = (ref: TestMethodRef): TestVerdict => ({
  ref,
  outcome: "error",
  durationMs: 1,
  failureMessage: REFUSED,
  operation: "completed-accepted",
  runnerRow: "runner-refused",
});

/** A sequential stub whose M0001 answers follow `roles`, one fixed answer per test. */
function build<B extends HeldStub>(
  roles: Record<string, Role | undefined>,
  Ctor: new (
    caps: BackendCapabilities,
    script: (mutant: string | null, ref: TestMethodRef, opts: RunOpts) => Outcome,
    procs: string[],
  ) => B,
): B {
  const b: B = new Ctor(
    CAPS_NST,
    (mutant, ref) => {
      if (mutant !== "M0001") return "pass";
      const r = roles[ref.method];
      return r === "fail" || r === "session-reused" || r === "unstable"
        ? "fail"
        : r === "timeout"
          ? "timeout"
          : "pass";
    },
    ["IsOverBudget"],
  );
  b.answer = (mutant, _n, v) => {
    const r = roles[v.ref.method];
    if (mutant === "M0001") {
      if (r === "session-reused") return { ...v, testRunsBefore: 3, sessionId: 7 };
      if (r === "runner-refused") return refusedRow(v.ref);
      if (r === "unstable") return { ...v, failureMessage: PERM };
    }
    // The unmutated confirm (the baseline's own run is the first null run) fails too.
    if (
      mutant === null &&
      r === "unstable" &&
      b.trace.filter((t) => t.startsWith(`run null ${v.ref.method} `)).length >= 1
    ) {
      return { ...v, outcome: "fail", failureMessage: PERM };
    }
    return undefined;
  };
  return b;
}

const nthOf = (b: ReproStub, method: string) =>
  b.sent.filter((s) => s.mutant === "M0001" && s.method === method).length;
const confirms = (b: ReproStub, method: string) =>
  b.trace.filter((t) => t.startsWith(`run null ${method} `)).length - 1;
const m1 = (r: SessionReport) => r.mutants.find((m) => m.mutantCode === "M0001");
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
/** The text a held error's own diagnosis would put on a kill (L8: it must not). */
const DIAGNOSIS: Record<"session-reused" | "unstable" | "runner-refused", string> = {
  "session-reused": "had already run in session",
  unstable: "fails at baseline confirmation",
  "runner-refused": "NotRun",
};
const KINDS = ["session-reused", "unstable", "runner-refused"] as const;

describe("PR-81: a non-terminal error is held while the walk looks for a kill", () => {
  for (const kind of KINDS) {
    test(`E1 (${kind}): error, then a fail -> killed by the fail; no field of the error stays on the kill`, async () => {
      const b = build({ T1: kind, T2: "fail" }, HeldStub);
      const report = await session(b);
      const row = m1(report);
      expect(row?.verdict).toBe("killed");
      expect(row?.killingTest).toContain("T2");
      expect(row?.killReproduced).toBe(true);
      expect(row?.cause).toBeUndefined();
      // L8: names only, never the error's diagnosis.
      expect(row?.failureNote).toContain(`the error of ${NAME("T1")} was not scored`);
      expect(row?.failureNote ?? "").not.toContain(DIAGNOSIS[kind]);
      expect(row?.failureNote ?? "").not.toContain("permissions prevented");
      // The R35 figures cannot disagree with the note: the dropped error counts nowhere.
      expect(report.permissionsRefused).toBeUndefined();
      expect(nthOf(b, "T3")).toBe(0);
    });

    test(`E3 (${kind}): error, then passes only -> error with the held error's cause; the later tests ran`, async () => {
      const b = build({ T1: kind }, HeldStub);
      const report = await session(b);
      const row = m1(report);
      expect(row?.verdict).toBe("error");
      expect(row?.cause).toBe(kind);
      expect(row?.failureNote).toContain(
        `after the error: ${NAME("T2")}, ${NAME("T3")}, ${NAME("T4")}, ${NAME("T5")}`,
      );
      for (const t of ["T2", "T3", "T4", "T5"]) expect(nthOf(b, t)).toBe(1);
      // A survivor is never made of a held error.
      expect(row?.verdict).not.toBe("survived");
    });

    test(`E6 (${kind}): error, then a fail that does not reproduce -> error (the held one)`, async () => {
      const b = build({ T1: kind, T2: "fail" }, HeldStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) =>
        mutant === "M0001" && v.ref.method === "T2" && n > 0 && nthOf(b, "T2") > 1
          ? { ...v, outcome: "pass" }
          : prev?.(mutant, n, v);
      const report = await session(b);
      expect(m1(report)?.verdict).toBe("error");
      expect(m1(report)?.cause).toBe(kind);
      expect(confirms(b, "T2")).toBe(1);
      expect(nthOf(b, "T2")).toBe(2);
    });
  }

  test("E2: fail first, then a would-be error -> killed, the erroring test is never run", async () => {
    const b = build({ T1: "fail", T2: "runner-refused" }, HeldStub);
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T1");
    expect(m1(report)?.failureNote).toBeUndefined();
    expect(nthOf(b, "T2")).toBe(0);
  });

  test("E4: error, a second qualifying error, then a fail -> killed; with no fail the FIRST error is the outcome and the second is only named", async () => {
    const withFail = build({ T1: "runner-refused", T2: "session-reused", T3: "fail" }, HeldStub);
    const k = m1(await session(withFail));
    expect(k?.verdict).toBe("killed");
    expect(k?.killingTest).toContain("T3");
    expect(k?.failureNote).toContain(`the error of ${NAME("T1")}, ${NAME("T2")} was not scored`);

    const noFail = build({ T1: "runner-refused", T2: "session-reused" }, HeldStub);
    const e = m1(await session(noFail));
    expect(e?.verdict).toBe("error");
    expect(e?.cause).toBe("runner-refused");
    expect(e?.failureNote).toContain(REFUSED);
    expect(e?.failureNote ?? "").not.toContain("had already run in session");
    expect(e?.failureNote).toContain(`after the error: ${NAME("T2")}`);
    expect(nthOf(noFail, "T5")).toBe(1);
  });

  describe("E5: error, then a terminal step", () => {
    test("stranded: the strand stands, the held error is named after its prefix, no further call", async () => {
      const b = build({ T1: "runner-refused" }, HeldStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) =>
        v.ref.method === "T2" && mutant === "M0001"
          ? { ref: v.ref, outcome: "error", durationMs: 1, operation: "in-flight-unknown" }
          : prev?.(mutant, n, v);
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
      expect(row?.failureNote).toContain(`an error of ${NAME("T1")} was held earlier`);
      expect(nthOf(b, "T3")).toBe(0);
    });

    test("deadline-exceeded: terminal, the held error is named, no further call", async () => {
      const b = build({ T1: "runner-refused" }, HeldStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) =>
        v.ref.method === "T2" && mutant === "M0001"
          ? { ref: v.ref, outcome: "deadline-exceeded", durationMs: 1 }
          : prev?.(mutant, n, v);
      const row = m1(await session(b));
      expect(row?.verdict).toBe("error");
      expect(row?.cause).toBe("deadline-exceeded");
      expect(row?.failureNote).toContain(`an error of ${NAME("T1")} was held earlier`);
      expect(nthOf(b, "T3")).toBe(0);
    });

    test("runner-test-error before a fail: terminal as today (never held, the fail is never run)", async () => {
      const b = build({ T1: "pass", T2: "fail" }, HeldStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) =>
        v.ref.method === "T1" && mutant === "M0001"
          ? {
              ref: v.ref,
              outcome: "error",
              durationMs: 1,
              failureMessage: "echo mismatch",
              operation: "completed-accepted",
              runnerRow: "runner-test-error",
            }
          : prev?.(mutant, n, v);
      const row = m1(await session(b));
      expect(row?.verdict).toBe("error");
      expect(row?.cause).toBe("runner-test-error");
      expect(nthOf(b, "T2")).toBe(0);
    });

    test("a plain error row is a transport error: the session aborts, nothing is held", async () => {
      const b = build({ T1: "runner-refused" }, HeldStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) =>
        v.ref.method === "T2" && mutant === "M0001"
          ? { ref: v.ref, outcome: "error", durationMs: 1, failureMessage: "wire down" }
          : prev?.(mutant, n, v);
      const error = await session(b).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as Error).message).toContain("backend transport error");
      expect((error as Error).message).toContain("T2");
      expect(nthOf(b, "T3")).toBe(0);
    });

    test("op-stopped and stopped-after-completion on the covering row are terminal", async () => {
      for (const [cause, extra] of [
        ["op-stopped", { operation: "lease-lost", leaseInvalidReason: "op-stopped" }],
        [
          "stopped-after-completion",
          { stopRefusal: "stopped-after-completion", stopState: "confirmed" },
        ],
      ] as const) {
        const b = build({ T1: "runner-refused" }, HeldStub);
        const prev = b.answer;
        b.answer = (mutant, n, v) =>
          v.ref.method === "T2" && mutant === "M0001"
            ? ({
                ref: v.ref,
                outcome: "error",
                durationMs: 1,
                failureMessage: cause,
                ...extra,
              } as TestVerdict)
            : prev?.(mutant, n, v);
        const row = m1(await session(b));
        expect([cause, row?.verdict, row?.cause]).toEqual([cause, "error", cause]);
        expect(row?.failureNote).toContain(`an error of ${NAME("T1")} was held earlier`);
        expect(nthOf(b, "T3")).toBe(0);
      }
    });
  });

  test("E5b: an error whose step set transportErrorRef is terminal, not held (a warm replay's plain error row)", async () => {
    const b: ReproWarmStub = new ReproWarmStub(
      CAPS_NST,
      (mutant, ref) => (mutant === "M0001" && ref.method === "T2" ? "fail" : "pass"),
      ["IsOverBudget"],
    );
    const original = b.runMany.bind(b);
    b.runMany = async (opts) => {
      if (opts.confirmation !== true) return original(opts);
      const ref = opts.methods[1]?.ref;
      if (ref === undefined) throw new Error("no method 2");
      return {
        kind: "call",
        methodIndex: 2,
        verdict: { ref, outcome: "error", durationMs: 1, failureMessage: "wire down" },
        fencedOp: { attemptId: "c1", opSeq: 900 },
      };
    };
    const error = await session(b, { groupRuns: { maxMethodsPerCall: 3 } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("backend transport error");
    // Call 1 only: held, the walk would have made a second call.
    expect(b.callLog.filter((c) => c.mutant === "M0001")).toHaveLength(1);
  });

  test("E7: timeout, error, fail -> killed; timeout, error, no fail -> the timeout's result; error, timeout, no fail -> the same (order independence)", async () => {
    const a = build({ T1: "timeout", T2: "runner-refused", T3: "fail" }, HeldStub);
    expect(m1(await session(a))?.verdict).toBe("killed");
    expect(m1(await session(a))?.killingTest).toContain("T3");

    const b = build({ T1: "timeout", T2: "runner-refused" }, HeldStub);
    const rb = m1(await session(b));
    expect(rb?.verdict).toBe("timeout-killed");
    expect(rb?.killingTest).toContain("T1");
    expect(rb?.failureNote).toContain(NAME("T2"));

    const c = build({ T1: "runner-refused", T2: "timeout" }, HeldStub);
    const rc = m1(await session(c));
    expect(rc?.verdict).toBe("timeout-killed");
    expect(rc?.killingTest).toContain("T2");
    // Both the held error's test and the later ones are named, names only.
    expect(rc?.failureNote).toContain(`after the timeout: ${NAME("T1")}`);
  });

  test("E8 (M3): an error met on the covering row does not re-activate the mutant", async () => {
    const b = build({ T1: "runner-refused" }, HookStub);
    await session(b);
    // The baseline's null activation, then M0001 once: no re-activation between T1 and T2.
    expect(b.trace.filter((t) => t === "activate M0001")).toHaveLength(1);
    expect(b.dropped).toEqual([]);
  });

  test("E8b (M3): an error after a confirm re-activates the mutant before the next step, and drops the pending pair first (no pairRequests)", async () => {
    const b = build({ T1: "unstable", T2: "fail" }, HookStub);
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    const t = b.trace;
    const i = t.indexOf("run null T1 fail", t.indexOf("run M0001 T1 fail"));
    // confirm (null) -> drop the pair -> re-activate -> T2's covering run under the mutant.
    expect(t.slice(i - 1, i + 4)).toEqual([
      "activate null",
      "run null T1 fail",
      "drop M0001",
      "activate M0001",
      "run M0001 T2 fail",
    ]);
    expect(b.dropped).toEqual(["M0001"]);
    // T2's own kill pair is the only reproduction asked for.
    expect(b.pairRequests).toBe(1);
  });

  test("E8d (M3): an error from the kill's REPRODUCTION leaves the mutant active (reproduceKill re-activated it): no second re-activation, no drop", async () => {
    const b = build({ T1: "fail" }, HookStub);
    const prev = b.answer;
    b.answer = (mutant, n, v) =>
      mutant === "M0001" && v.ref.method === "T1" && nthOf(b, "T1") > 1
        ? { ...v, testRunsBefore: 3, sessionId: 7 }
        : prev?.(mutant, n, v);
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("session-reused");
    // The covering run's activation and the reproduction's own; none for the held error.
    expect(b.trace.filter((t) => t === "activate M0001")).toHaveLength(2);
    expect(b.dropped).toEqual([]);
    expect(nthOf(b, "T5")).toBe(1);
  });

  /** T1 fails under the mutant (a kill candidate); its unmutated confirm answers `confirm`. */
  const withConfirm = (confirm: (v: TestVerdict) => TestVerdict) => {
    const b = build({ T1: "fail", T2: "fail" }, HeldStub);
    const prev = b.answer;
    b.answer = (mutant, n, v) =>
      mutant === null && v.ref.method === "T1" && b.trace.includes("run M0001 T1 fail")
        ? confirm(v)
        : prev?.(mutant, n, v);
    return b;
  };

  test("E19 (M2): a confirm that is an ERROR (v3 runner-test-error row) is terminal: no later covering test runs", async () => {
    const b = withConfirm((v) => ({
      ref: v.ref,
      outcome: "error",
      durationMs: 1,
      failureMessage: "contract violation",
      operation: "completed-accepted",
      runnerRow: "runner-test-error",
    }));
    const row = m1(await session(b));
    expect(row?.verdict).toBe("error");
    expect(nthOf(b, "T2")).toBe(0);
  });

  test("E20 (M2): a pre-dispatch-rejected confirm (after runFenced's retry) is terminal: no later covering test runs", async () => {
    const b = withConfirm((v) => ({
      ref: v.ref,
      outcome: "error",
      durationMs: 1,
      failureMessage: "rejected before dispatch",
      operation: "pre-dispatch-rejected",
    }));
    const row = m1(await session(b));
    expect(row?.verdict).toBe("error");
    expect(nthOf(b, "T2")).toBe(0);
  });

  test("E21 (L1): a held confirm with the clock then spent sends no re-activation", async () => {
    const b = build({ T1: "unstable", T2: "fail" }, HookStub);
    // 10 s of clock per mutated run: a 5 s budget is spent after the first step.
    const report = await session(b, {
      timeBudgetSeconds: 5,
      clockMs: () => b.sent.filter((s) => s.mutant === "M0001").length * 10_000,
    });
    expect(m1(report)).toBeUndefined();
    expect(nthOf(b, "T2")).toBe(0);
    expect(b.trace.filter((t) => t === "activate M0001")).toHaveLength(1);
    expect(b.trace.at(-1)).not.toBe("activate M0001");
  });

  test("E8c: a backend without the hook still gets the re-activation", async () => {
    const b = build({ T1: "unstable", T2: "fail" }, HeldStub);
    await session(b);
    const t = b.trace;
    const i = t.indexOf("run null T1 fail", t.indexOf("run M0001 T1 fail"));
    expect(t.slice(i, i + 3)).toEqual(["run null T1 fail", "activate M0001", "run M0001 T2 fail"]);
  });

  test("E9 (L8): safety latched after an error -> terminal, nothing is re-activated", async () => {
    const seen: { safety?: SessionSafety } = {};
    const original = SessionSafety.prototype.assertSafe;
    SessionSafety.prototype.assertSafe = function (this: SessionSafety, what: string) {
      seen.safety = this;
      return original.call(this, what);
    };
    try {
      const b = build({ T1: "unstable", T2: "fail" }, HookStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) => {
        // The confirm of T1 is where the session latches.
        if (mutant === null && v.ref.method === "T1" && b.sent.length > 1) {
          seen.safety?.latchUnsafe("test: latched during T1's confirm");
        }
        return prev?.(mutant, n, v);
      };
      const report = await session(b);
      const activations = b.trace.filter((t) => t.startsWith("activate "));
      // null (baseline), M0001, null (T1's confirm): no re-activation after the latch.
      expect(activations.at(-1)).toBe("activate null");
      expect(b.dropped).toEqual([]);
      expect(nthOf(b, "T2")).toBe(0);
      expect(m1(report)?.verdict ?? "error").toBe("error");
    } finally {
      SessionSafety.prototype.assertSafe = original;
    }
  });

  test("E10 (L5): a mutant with a held error is never a survivor, whatever else is pending", async () => {
    // The error, then a fail that does not reproduce (kill-not-reproduced pending), then passes.
    const b = build({ T1: "runner-refused", T2: "fail" }, HeldStub);
    const prev = b.answer;
    b.answer = (mutant, n, v) =>
      mutant === "M0001" && v.ref.method === "T2" && nthOf(b, "T2") > 1
        ? { ...v, outcome: "pass" }
        : prev?.(mutant, n, v);
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("error");
    expect(m1(report)?.cause).toBe("runner-refused");
    expect(m1(report)?.verdict).not.toBe("survived");
  });

  test("E11 (H1, PR-55's condition): a held runner-refused timeout row, then an alone fail -> alone confirm and reproduction, NO kill pair", async () => {
    const b = build({ T1: "runner-refused", T2: "fail" }, HeldStub);
    const prev = b.answer;
    b.answer = (mutant, n, v) =>
      mutant === "M0001" && v.ref.method === "T1"
        ? {
            ref: v.ref,
            outcome: "error",
            durationMs: 1,
            failureMessage:
              "Test exceeded 1s timeout. [al-runner v3: stopped on v3's virtual clock; BC's real wait unknown; never scored]",
            operation: "completed-accepted",
            runnerRow: "runner-refused",
          }
        : prev?.(mutant, n, v);
    b.markAlone = (method) => method === "T2";
    const report = await session(b);
    expect(m1(report)?.verdict).toBe("killed");
    expect(m1(report)?.killingTest).toContain("T2");
    expect(b.pairs).toEqual([]);
    const t2 = b.aloneRuns.filter(
      (r) => r.method === "T2" && (r.mutant === "M0001" || r.mutant === null),
    );
    expect(t2.map((r) => `${r.mutant ?? "null"}:${r.alone}`).slice(0, 4)).toEqual([
      "null:false",
      "M0001:false",
      "null:true",
      "M0001:true",
    ]);
  });

  describe("E12 (M2): after a terminal answer the held timeout is still replayed and scored", () => {
    test("confirm-stopped: T1 hangs (held), T2 fails and its unmutated confirm is stopped -> timeout-killed by T1", async () => {
      const b = build({ T1: "timeout", T2: "fail" }, HeldStub);
      const prev = b.answer;
      b.answer = (mutant, n, v) =>
        mutant === null &&
        v.ref.method === "T2" &&
        b.trace.filter((t) => t.startsWith("run null T2 ")).length >= 1
          ? { ...v, outcome: "timeout", stopState: "confirmed" }
          : prev?.(mutant, n, v);
      const row = m1(await session(b));
      expect(row?.verdict).toBe("timeout-killed");
      expect(row?.killingTest).toContain("T1");
      expect(row?.cause).toBeUndefined();
      expect(nthOf(b, "T3")).toBe(0);
    });

    for (const [cause, extra] of [
      ["op-stopped", { operation: "lease-lost", leaseInvalidReason: "op-stopped" }],
      [
        "stopped-after-completion",
        { stopRefusal: "stopped-after-completion", stopState: "confirmed" },
      ],
    ] as const) {
      test(`${cause} on the covering row: the held timeout is replayed -> timeout-killed by T1`, async () => {
        const b = build({ T1: "timeout" }, HeldStub);
        const prev = b.answer;
        b.answer = (mutant, n, v) =>
          v.ref.method === "T2" && mutant === "M0001"
            ? ({
                ref: v.ref,
                outcome: "error",
                durationMs: 1,
                failureMessage: cause,
                ...extra,
              } as TestVerdict)
            : prev?.(mutant, n, v);
        const row = m1(await session(b));
        expect(row?.verdict).toBe("timeout-killed");
        expect(row?.killingTest).toContain("T1");
        expect(nthOf(b, "T3")).toBe(0);
      });
    }

    test("a group-* cause is terminal too; the held timeout is replayed", async () => {
      const b: ReproWarmStub = new ReproWarmStub(
        CAPS_NST,
        (mutant, ref) => (mutant === "M0001" && ref.method === "T1" ? "timeout" : "pass"),
        ["IsOverBudget"],
      );
      b.timeoutFor = (mutant, ref) =>
        mutant === "M0001" && ref.method === "T1" ? 999_999 : undefined;
      const original = b.runMany.bind(b);
      let mutantCalls = 0;
      b.runMany = async (opts) => {
        if (opts.confirmation === true || (b.activations.at(-1) ?? null) !== "M0001") {
          return original(opts);
        }
        mutantCalls += 1;
        if (mutantCalls === 1) return original(opts);
        const first = opts.methods[0];
        if (first === undefined) throw new Error("empty call");
        return {
          kind: "call",
          methodIndex: 1,
          verdict: {
            ref: first.ref,
            outcome: "error",
            durationMs: 1,
            failureMessage: "server loop raised",
          },
          cause: "group-run-error",
          fencedOp: { attemptId: "x1", opSeq: 950 },
        };
      };
      const row = m1(await session(b, { groupRuns: { maxMethodsPerCall: 3 } }));
      expect(row?.verdict).toBe("timeout-killed");
      expect(row?.killingTest).toContain("T1");
      // The walk ended at the group error: no third mutated call.
      expect(mutantCalls).toBe(2);
    });
  });

  test("E13 (property, M5): fixed per-test answers give the same CLASS in every order", async () => {
    const expected = (roles: Role[]) =>
      roles.includes("fail")
        ? "killed"
        : roles.includes("timeout")
          ? "timeout-killed"
          : roles.some((r) => r !== "pass")
            ? "error"
            : "survived";
    const perms = (xs: Role[]): Role[][] => {
      if (xs.length <= 1) return [xs];
      const out: Role[][] = [];
      const seen = new Set<Role>();
      xs.forEach((x, i) => {
        if (seen.has(x)) return;
        seen.add(x);
        for (const rest of perms([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
      });
      return out;
    };
    // At most 4 covering tests with answers, so at most 24 orders per set and 72 sessions in all.
    const sets: Role[][] = [
      ["fail", "timeout", "runner-refused", "session-reused"],
      ["timeout", "runner-refused", "unstable", "pass"],
      ["runner-refused", "session-reused", "unstable", "pass"],
    ];
    let runs = 0;
    for (const set of sets) {
      for (const order of perms(set)) {
        const roles: Record<string, Role> = {};
        order.forEach((r, i) => {
          roles[`T${i + 1}`] = r;
        });
        const b = build(roles, HeldStub);
        const row = m1(await session(b));
        const got = [row?.verdict, row?.killingTest];
        const want = expected(order);
        const killer = order.indexOf(want === "killed" ? "fail" : "timeout");
        expect([order.join(","), ...got]).toEqual([
          order.join(","),
          want,
          want === "killed" || want === "timeout-killed"
            ? expect.stringContaining(`T${killer + 1}`)
            : undefined,
        ]);
        runs += 1;
      }
    }
    expect(runs).toBe(72);
  }, 120_000);

  test("E14 (M5): warm errors depend on the packing: the same flaky-replay test is killed at position 1 and an error at position 2", async () => {
    const run = async (failing: "T1" | "T2") => {
      const b: ReproWarmStub = new ReproWarmStub(
        CAPS_NST,
        (mutant, ref) => {
          if (mutant === "M0001") return ref.method === failing ? "fail" : "pass";
          return b.inConfirm && b.failInConfirm.has(ref.method) ? "fail" : "pass";
        },
        ["IsOverBudget"],
      );
      b.failInConfirm = new Set([failing]);
      return m1(await session(b, { groupRuns: { maxMethodsPerCall: 3 } }));
    };
    const first = await run("T1"); // position 1: a single cold run; the replay fake does not touch it
    expect(first?.verdict).toBe("killed");
    const second = await run("T2"); // position 2: the warm replay fails -> `unstable`, held, no later kill
    expect(second?.verdict).toBe("error");
    expect(second?.cause).toBe("unstable");
  });

  test("E15: a warm error (warm-prefix-unstable) is held; a later fail in the next call kills", async () => {
    const b: ReproWarmStub = new ReproWarmStub(
      CAPS_NST,
      (mutant, ref) => {
        if (mutant === "M0001") return ref.method === "T2" || ref.method === "T4" ? "fail" : "pass";
        return b.inConfirm && ref.method === "T1" && confirmN(b) === 1 ? "fail" : "pass";
      },
      ["IsOverBudget"],
    );
    // Only the FIRST replay (T2's) loses its prefix; T4's replay is clean.
    let replays = 0;
    const original = b.runMany.bind(b);
    b.runMany = async (opts) => {
      if (opts.confirmation === true) replays += 1;
      return original(opts);
    };
    const confirmN = (_b: ReproWarmStub) => replays;
    const row = m1(await session(b, { groupRuns: { maxMethodsPerCall: 3 } }));
    expect(row?.verdict).toBe("killed");
    expect(row?.killingTest).toContain("T4");
    expect(row?.cause).toBeUndefined();
    expect(row?.failureNote).toContain(`the error of ${NAME("T2")} was not scored`);
  });

  /** T2 and T4 fail under M0001 (position 2 of two warm calls); the FIRST replay answers `first`. */
  const warmWithBadFirstReplay = async (
    first: (opts: RunManyOpts) => RunManyResult,
  ): Promise<{ b: ReproWarmStub; row: ReturnType<typeof m1> }> => {
    const b: ReproWarmStub = new ReproWarmStub(
      CAPS_NST,
      (mutant, ref) =>
        mutant === "M0001" && (ref.method === "T2" || ref.method === "T4") ? "fail" : "pass",
      ["IsOverBudget"],
    );
    let replays = 0;
    const original = b.runMany.bind(b);
    b.runMany = async (opts) => {
      if (opts.confirmation === true) replays += 1;
      if (opts.confirmation === true && replays === 1) return first(opts);
      return original(opts);
    };
    const row = m1(await session(b, { groupRuns: { maxMethodsPerCall: 3 } }));
    return { b, row };
  };
  const mutantCalls = (b: ReproWarmStub) =>
    b.callLog.filter((c) => c.mutant === "M0001").map((c) => c.methods);

  test("E16: warm-timeout-unconfirmed is held; a later fail in the next call kills", async () => {
    // The replay of T2 (position 2) is stopped at T2 itself, without the mutant.
    const { b, row } = await warmWithBadFirstReplay((opts) => {
      const ref = opts.methods[1]?.ref;
      if (ref === undefined) throw new Error("no method 2");
      return {
        kind: "call",
        methodIndex: 2,
        verdict: { ref, outcome: "timeout", durationMs: 9, failureMessage: "stopped (fake 408)" },
        fencedOp: { attemptId: "c1", opSeq: 901 },
      };
    });
    expect(row?.verdict).toBe("killed");
    expect(row?.killingTest).toContain("T4");
    expect(row?.cause).toBeUndefined();
    expect(row?.failureNote).toContain(`the error of ${NAME("T2")} was not scored`);
    expect(mutantCalls(b)[0]).toEqual(["T1", "T2", "T3"]);
    expect(mutantCalls(b).slice(1).flat()).toContain("T4"); // the walk went on past the error
  });

  test("E17: warm-confirmation-incomplete is held; a later fail in the next call kills", async () => {
    // The replay stops at the server's cap after one method, before reaching T2.
    const { b, row } = await warmWithBadFirstReplay((opts) => {
      const m = opts.methods[0];
      if (m === undefined) throw new Error("no method 1");
      return {
        kind: "verdicts",
        endedBy: "cap",
        ranCount: 1,
        verdicts: [
          { ref: m.ref, outcome: "pass", durationMs: 1, sessionId: 4242, testRunsBefore: 0 },
        ],
        durationMs: 1,
        fencedOp: { attemptId: "c1", opSeq: 901 },
      };
    });
    expect(row?.verdict).toBe("killed");
    expect(row?.killingTest).toContain("T4");
    expect(row?.cause).toBeUndefined();
    expect(row?.failureNote).toContain(`the error of ${NAME("T2")} was not scored`);
    expect(mutantCalls(b)[0]).toEqual(["T1", "T2", "T3"]);
    expect(mutantCalls(b).slice(1).flat()).toContain("T4"); // the walk went on past the error
  });

  test("E18: an error met in the REPLAY of a held timeout is not held: the walk ends, no covering test runs after it", async () => {
    // T1 hangs under M0001 (held); T2..T5 pass. The replay's unmutated confirm of T1 fails -> unstable.
    const b: HeldStub = new HeldStub(
      CAPS_NST,
      (mutant, ref) => {
        if (mutant === "M0001") return ref.method === "T1" ? "timeout" : "pass";
        return ref.method === "T1" && b.trace.some((t) => t.startsWith("run null T1 "))
          ? "fail"
          : "pass";
      },
      ["IsOverBudget"],
    );
    const row = m1(await session(b));
    expect(row?.verdict).toBe("error");
    expect(row?.cause).toBe("unstable");
    expect(row?.failureNote).toContain("unstable test T1");
    // The walk ran T1..T5 once under the mutant; the replay added nothing under it.
    const mutated = b.sent.filter((s) => s.mutant === "M0001").map((s) => s.method);
    expect(mutated).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    const confirmAt = b.trace.indexOf("run null T1 fail"); // the replay's confirm
    expect(confirmAt).toBeGreaterThan(-1);
    // A held error would re-activate the mutant to go on; the walk ends instead.
    expect(b.trace[confirmAt + 1]).not.toBe("activate M0001");
  });
});

describe("PR-81: the lane view forwards dropPendingPair to its own lane (delta M1)", () => {
  const failingA = (rows: FakeRow[]): FakeRow[] =>
    rows.map((r) => (r.method === "A" ? { ...r, status: "fail" as const, message: "boom" } : r));
  const rows: RowsFn = (m) => (m === "M0001" ? failingA(allPass(m, 0, 0, 0)) : allPass(m, 0, 0, 0));
  const setup = async () => {
    const r = await lanesRig({ lanes: 2, rows });
    await laneBaseline(r);
    const [v0, v1] = r.views;
    if (v0 === undefined || v1 === undefined) throw new Error("lanes");
    await r.b.prefetchMutants([{ mutantId: "M0001", refs: SUITE }]);
    await v0.activate("M0001");
    expect((await v0.run(A, OPTS)).outcome).toBe("fail");
    await v0.sendKillPair("M0001", A);
    await v0.activate(null); // the confirm, served from the pair
    return { r, v0, v1 };
  };

  test("lane 0 drops its own pending pair: the next activate is no reproduction (pairRequests stays 0)", async () => {
    const { r, v0 } = await setup();
    v0.dropPendingPair("M0001");
    await v0.activate("M0001");
    expect(r.b.entriesStats().pairRequests).toBe(0);
  });

  test("control: without the drop the activation counts as the pair's reproduction; another lane's drop leaves the pair", async () => {
    const { r, v0, v1 } = await setup();
    v1.dropPendingPair("M0001"); // not lane 0's pair
    await v0.activate("M0001");
    expect(r.b.entriesStats().pairRequests).toBe(1);
  });
});

// PR-341 (R1178): PR-144's recheck picks a mutant by its kept held error's note (`withheldKillOf`). When the first held error
// is not a withheld kill and a later one of the same walk is, the later one is kept, so eligibility does not depend on walk
// order. The verdict stays `error` / `runner-refused`.
describe("PR-341: the first withheld-ELIGIBLE held error is kept", () => {
  const WITHHELD =
    "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (Sandbox Tests.T0: Commit): this failure is not trusted: Expected 1 got 2";
  /** `build` with `withheld` tests answering the eligible cascade form (a runner-refused row). */
  const withWithheld = (roles: Record<string, "runner-refused">, withheld: readonly string[]) => {
    const b = build(roles, HeldStub);
    const prev = b.answer;
    b.answer = (mutant, n, v) =>
      mutant === "M0001" && withheld.includes(v.ref.method)
        ? { ...refusedRow(v.ref), failureMessage: WITHHELD }
        : prev?.(mutant, n, v);
    return b;
  };

  test("a non-eligible held error, then an eligible one: the eligible note is kept (revert: first always kept)", async () => {
    const e = m1(
      await session(withWithheld({ T1: "runner-refused", T2: "runner-refused" }, ["T2"])),
    );
    expect(e?.verdict).toBe("error");
    expect(e?.cause).toBe("runner-refused");
    expect(withheldKillOf(e?.verdict ?? "", e?.cause, e?.failureNote)).not.toBeUndefined();
    expect(e?.failureNote).toContain("this failure is not trusted: Expected 1 got 2");
    // The note (review S1): the kept T2 is never named "after" itself; the later T3 is; the replaced T1 is named earlier.
    expect(e?.failureNote ?? "").not.toContain(`after the error: ${NAME("T2")}`);
    expect(e?.failureNote).toContain(`after the error: ${NAME("T3")}`);
    expect(e?.failureNote).toContain(`an earlier held error (not a withheld kill): ${NAME("T1")}`);
  });

  test("eligible first, then non-eligible: unchanged, the first is kept", async () => {
    const e = m1(
      await session(withWithheld({ T1: "runner-refused", T2: "runner-refused" }, ["T1"])),
    );
    expect(e?.verdict).toBe("error");
    expect(withheldKillOf(e?.verdict ?? "", e?.cause, e?.failureNote)).not.toBeUndefined();
    expect(e?.failureNote).toContain(`after the error: ${NAME("T2")}`);
  });

  test("two non-eligible held errors: unchanged, the first is kept and not eligible", async () => {
    const e = m1(await session(withWithheld({ T1: "runner-refused", T2: "runner-refused" }, [])));
    expect(e?.verdict).toBe("error");
    expect(e?.cause).toBe("runner-refused");
    expect(e?.failureNote).toContain(REFUSED);
    expect(withheldKillOf(e?.verdict ?? "", e?.cause, e?.failureNote)).toBeUndefined();
  });
});
