import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef, TestVerdict } from "../src/backend";
import { RunMutantTransport } from "../src/run-mutant-transport";
import {
  BaselineWorkDateUnstableError,
  WorkDateGuard,
  commonWorkDate,
} from "../src/workdate-guard";

/**
 * R1131 (PR-196): the start-WorkDate guard and the transport's `workDate` rule. The backend wiring is in
 * bcdev-backend.test.ts, the orchestrator's step.cause branch in orchestrator.test.ts, snapshot reuse and the
 * report field in resume.test.ts.
 */

const REF: TestMethodRef = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "Alpha" };
const D1 = "2026-11-19";
const D2 = "2026-11-20";
const pass = (workDate?: string): TestVerdict => ({
  ref: REF,
  outcome: "pass",
  durationMs: 5,
  ...(workDate !== undefined ? { workDate } : {}),
});

/** A guard that has seen one baseline call on `date`, the bracket closed. */
function baselined(date: string): WorkDateGuard {
  const g = new WorkDateGuard(true);
  g.baselinePhase(true);
  g.check(pass(date));
  g.baselinePhase(false);
  return g;
}

describe("WorkDateGuard (R1131)", () => {
  test("an answer on another date than the baseline's is error / workdate-changed, naming both dates", () => {
    const v = baselined(D1).check(pass(D2));
    expect(v.outcome).toBe("error");
    expect(v.workDateRefusal).toBe("workdate-changed");
    expect(v.failureMessage).toContain(D1);
    expect(v.failureMessage).toContain(D2);
  });

  test("an answer on the baseline's date is returned unchanged", () => {
    const g = baselined(D1);
    const v = pass(D1);
    expect(g.check(v)).toBe(v);
  });

  test("after one mismatch the rest of the batch is refused, even on the baseline's date (ruling A)", () => {
    const g = baselined(D1);
    g.check(pass(D2));
    const again = g.check(pass(D1));
    expect(again.outcome).toBe("error");
    expect(again.workDateRefusal).toBe("workdate-changed");
    expect(again.failureMessage).toContain("earlier answer in this batch");
  });

  test("a new batch's baseline clears the move", () => {
    const g = baselined(D1);
    g.check(pass(D2));
    g.baselinePhase(true);
    g.check(pass(D2));
    g.baselinePhase(false);
    expect(g.batchWorkDate()).toBe(D2);
    const v = pass(D2);
    expect(g.check(v)).toBe(v);
  });

  test("two baseline calls on different dates refuse the batch by name", () => {
    const g = new WorkDateGuard(true);
    g.baselinePhase(true);
    g.check(pass(D1));
    let caught: unknown;
    try {
      g.check(pass(D2));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BaselineWorkDateUnstableError);
    expect((caught as BaselineWorkDateUnstableError).first).toBe(D1);
    expect((caught as BaselineWorkDateUnstableError).second).toBe(D2);
  });

  test("an answer with no workDate (no test ran) passes through, in and out of the baseline", () => {
    const g = new WorkDateGuard(true);
    g.baselinePhase(true);
    const a: TestVerdict = { ref: REF, outcome: "error", durationMs: 1, failureMessage: "x" };
    expect(g.check(a)).toBe(a);
    g.check(pass(D1));
    g.baselinePhase(false);
    expect(g.check(a)).toBe(a);
  });

  test("hub mode (disabled) compares nothing and reports no baseline date", () => {
    const g = new WorkDateGuard(false);
    g.baselinePhase(true);
    g.check(pass(D1));
    g.baselinePhase(false);
    const v = pass(D2);
    expect(g.check(v)).toBe(v);
    expect(g.batchWorkDate()).toBeUndefined();
    expect(g.refuseReuse(undefined)).toBeUndefined();
  });

  test("snapshot reuse: an equal date is allowed, another date and no date are refused", () => {
    const g = baselined(D1);
    expect(g.refuseReuse(D1)).toBeUndefined();
    expect(g.refuseReuse(D2)).toContain(D2);
    expect(g.refuseReuse(undefined)).toContain("records no start WorkDate");
  });

  test("a reused snapshot's verdicts give the batch its date", () => {
    const g = new WorkDateGuard(true);
    g.baselinePhase(true);
    g.noteReused([{ verdict: pass(D1) }, { verdict: pass() }]);
    g.baselinePhase(false);
    expect(g.batchWorkDate()).toBe(D1);
    expect(g.check(pass(D2)).workDateRefusal).toBe("workdate-changed");
  });

  test("commonWorkDate: the one shared date, nothing when none or two differ", () => {
    expect(commonWorkDate([{ verdict: pass(D1) }, { verdict: pass(D1) }])).toBe(D1);
    expect(commonWorkDate([{ verdict: pass() }])).toBeUndefined();
    expect(commonWorkDate([{ verdict: pass(D1) }, { verdict: pass(D2) }])).toBeUndefined();
  });
});

// ——— the transport: where `workDate` is required, and where it is not ———
const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};
const TA = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const AR = "5c0a4c0a5c0a4c0a5c0a4c0a5c0a4c0a";
const LEASE = { epoch: 3, token: "tok-abc", serverGeneration: "gen-1", opSeq: 7 } as const;
const REQ = {
  ref: REF,
  mutantId: "M0003",
  attemptId: "a1",
  timeoutMs: 5000,
  lease: LEASE,
} as const;

function ran(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ran",
    targetAppId: TA,
    artifactId: AR,
    attemptId: "a1",
    mutantId: "M0003",
    codeunitId: 79100,
    method: "Alpha",
    codeunitResults: JSON.stringify({ testResults: [{ method: "Alpha", result: 2 }] }),
    testRunsBefore: 0,
    sessionId: 2037,
    observedActive: true,
    ...over,
  };
}
const fetchOf = (inner: Record<string, unknown>) =>
  (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), {
      status: 200,
    })) as typeof fetch;
const transport = (inner: Record<string, unknown>) =>
  new RunMutantTransport(CFG, TA, AR, fetchOf(inner));

describe("RunMutant: the workDate rule (R1131)", () => {
  test("a method-ran answer carries workDate onto the verdict", async () => {
    const v = await transport(ran({ workDate: D1 })).run(REQ);
    expect(v.outcome).toBe("pass");
    expect(v.workDate).toBe(D1);
  });

  test("a method-ran answer WITHOUT workDate is refused by name, as a bare error that aborts the session", async () => {
    const v = await transport(ran()).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("workDate");
    expect(v.failureMessage).toContain("1.0.0.28");
    expect(v.operation).toBeUndefined();
  });

  test("a malformed workDate is refused too", async () => {
    const v = await transport(ran({ workDate: "19/11/2026" })).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("workDate");
  });

  test("an answer where no test ran (the fail-closed error shape) needs no workDate", async () => {
    const v = await transport(
      ran({
        codeunitResults: JSON.stringify({ error: "expected exactly one method Alpha, found 0" }),
      }),
    ).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage ?? "").not.toContain("workDate");
    expect(v.workDate).toBeUndefined();
  });
});

describe("RunMutantMany: the workDate rule (R1131)", () => {
  const entry = (i: number, method: string, over: Record<string, unknown> = {}) => ({
    index: i,
    codeunitId: 79100,
    method,
    lineNo: 20000 + i * 10,
    sessionId: 2037,
    codeunitResults: JSON.stringify({ testResults: [{ method, result: 2 }] }),
    durationMs: 40 + i,
    observedActive: true,
    ...over,
  });
  const answer = (methods: Record<string, unknown>[]) => ({
    status: "ran",
    targetAppId: TA,
    artifactId: AR,
    attemptId: "a1",
    mutantId: "M0003",
    observedAny: true,
    identityMismatch: false,
    testRunsBefore: 0,
    sessionId: 2037,
    endedBy: "complete",
    ranCount: methods.length,
    methods,
  });
  const req = {
    mutantId: "M0003",
    attemptId: "a1",
    lease: LEASE,
    methods: [
      { ref: REF, budgetMs: 1000 },
      { ref: { ...REF, method: "Beta" }, budgetMs: 1000 },
    ],
    requestCeilingMs: 60_000,
    stopGraceMs: 1000,
    stopHungSessions: false,
  };

  test("each entry's workDate reaches its verdict", async () => {
    const r = await transport(
      answer([entry(1, "Alpha", { workDate: D1 }), entry(2, "Beta", { workDate: D1 })]),
    ).runMany(req);
    if (r.kind !== "verdicts") throw new Error("expected verdicts");
    expect(r.verdicts.map((v) => v.workDate)).toEqual([D1, D1]);
  });

  test("an entry without workDate makes the whole answer malformed (per-mutant, not an abort)", async () => {
    const r = await transport(
      answer([entry(1, "Alpha", { workDate: D1 }), entry(2, "Beta")]),
    ).runMany(req);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("entry 2");
    // The refusal's own words (the answer text quoted after it also names the key).
    expect(r.verdict.failureMessage).toContain(
      "entry 2: answer ran a method but carries no ISO workDate",
    );
  });
});
