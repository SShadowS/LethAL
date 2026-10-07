import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef } from "../src/backend";
import { UnfilteredExtensionsQueryError } from "../src/harness";
import { RunMutantTransport } from "../src/run-mutant-transport";
import type { RunMutantManyRequest, RunMutantManyResult } from "../src/run-mutant-transport";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * R198: `RunMutantTransport.runMany` against one fake fetch that routes by action. The design
 * (`docs/superpowers/specs/2026-09-03-r198-run-mutant-loop.md`, §7) names each of these: the
 * answer assertions (§3.3), the watchdog's "ours first" and identity rules (§3.2), server clocks
 * only, today's 408 rule with R204's narrowing, the two per-entry faults that abort the session,
 * cap and the 404, and the shared classifier with `run`.
 */

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
const AL_STOP_BODY = JSON.stringify({
  error: {
    message:
      "The server stopped the session (ID: 2683) because of a stop session request. The session was stopped by an AL StopSession call.",
  },
});

function ref(method: string): TestMethodRef {
  return { codeunitId: 79100, codeunitName: "Sandbox Tests", method };
}
const M = [ref("Alpha"), ref("Beta"), ref("Gamma")];

function req(over: Partial<RunMutantManyRequest> = {}): RunMutantManyRequest {
  return {
    mutantId: "M0003",
    attemptId: "a1",
    lease: LEASE,
    methods: M.map((r) => ({ ref: r, budgetMs: 1000 })),
    requestCeilingMs: 5_000,
    stopGraceMs: 1_000,
    stopHungSessions: false,
    watchdogPollMs: 5,
    ...over,
  };
}

/** R206: the session every well-formed answer below ran in, and the id its entries carry. */
const SESSION = 2037;

function entry(
  i: number,
  method: string,
  result: number,
  lines = 1,
  observedActive = true,
): Record<string, unknown> {
  const testResults = Array.from({ length: lines }, () => ({ method, result }));
  return {
    index: i,
    codeunitId: 79100,
    method,
    lineNo: 20000 + i * 10,
    sessionId: SESSION,
    codeunitResults: JSON.stringify({ testResults }),
    durationMs: 40 + i,
    observedActive,
  };
}

/** A well-formed `ran` answer, overridable per field. R206: it ran in a FRESH session. */
function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ran",
    targetAppId: TA,
    artifactId: AR,
    attemptId: "a1",
    mutantId: "M0003",
    observedAny: true,
    identityMismatch: false,
    testRunsBefore: 0,
    sessionId: SESSION,
    endedBy: "complete",
    ranCount: 3,
    methods: [entry(1, "Alpha", 2), entry(2, "Beta", 2), entry(3, "Gamma", 2)],
    ...over,
  };
}

function statusOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opKind: "run",
    opAttemptId: "a1",
    opSeq: 7,
    lastCompletedOpSeq: 6,
    completed: false,
    serverNow: "2026-09-03T10:00:10Z",
    opProgress: {
      attemptId: "a1",
      opSeq: 7,
      methodIndex: 1,
      codeunitId: 79100,
      method: "Alpha",
      token: "tok-m1",
      startedAt: "2026-09-03T10:00:00Z",
      lastCompletedIndex: 0,
      state: "running",
    },
    ...over,
  };
}

const odata = (inner: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status });

/**
 * One fake fetch routed by action. `many` answers `RunMutantMany` (a Response, or "hold" to keep
 * the request open until `release` is called); `status` is read per poll; `stopAt` answers
 * `StopHungRunAt` and records the bodies it was sent.
 */
function fakes(opts: {
  many: Response | "hold";
  status?: () => Record<string, unknown> | Error;
  /** R-204b: an `Error` rejects the stop (its reply lost); `"hang"` never answers it. */
  stopAt?: (body: Record<string, unknown>) => Record<string, unknown> | Error | "hang";
  /** R236b: answers `GetOpAnswer`; absent, that action is rejected like any unexpected one. */
  kept?: () => Response | Error;
}) {
  const stops: Record<string, unknown>[] = [];
  /** Every action called, in order, except the watchdog's `GetOperationStatus` polls. */
  const calls: string[] = [];
  let polls = 0;
  let release: ((r: Response) => void) | undefined;
  const fetchFn = ((url: unknown, init?: RequestInit) => {
    const u = String(url);
    const action = /LethALControl_(\w+)/.exec(u)?.[1] ?? u;
    if (action !== "GetOperationStatus") calls.push(action);
    if (action === "GetOpAnswer" && opts.kept !== undefined) {
      const k = opts.kept();
      return k instanceof Error ? Promise.reject(k) : Promise.resolve(k);
    }
    if (u.includes("_RunMutantMany")) {
      if (opts.many !== "hold") return Promise.resolve(opts.many);
      return new Promise<Response>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted.")),
          { once: true },
        );
      });
    }
    if (u.includes("_GetOperationStatus")) {
      polls += 1;
      const s = opts.status === undefined ? statusOf() : opts.status();
      if (s instanceof Error) return Promise.reject(s);
      return Promise.resolve(odata(s));
    }
    if (u.includes("_StopHungRunAt")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      stops.push(body);
      const a = opts.stopAt === undefined ? { stopped: true, sessionId: 9 } : opts.stopAt(body);
      if (a === "hang") return new Promise<Response>(() => {});
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(odata(a));
    }
    return Promise.reject(new Error(`unexpected action ${u}`));
  }) as typeof fetch;
  return {
    fetchFn,
    stops,
    calls,
    polls: () => polls,
    release: (r: Response) => release?.(r),
  };
}

function transport(fetchFn: typeof fetch): RunMutantTransport {
  return new RunMutantTransport(CFG, TA, AR, fetchFn);
}
/**
 * R289: a fake whose `RunMutantMany` and `StopHungRunAt` are BOTH held until the test releases
 * them by hand, so a test can reject the main fetch while the watchdog is still waiting on its
 * stop. `fakes` answers the stop synchronously and cannot reject its held fetch, so it cannot
 * build that order. Every call is recorded by action name as it arrives, polls included.
 * `GetOpAnswer` (R236b's readback) is rejected, which `runMany` reports and appends.
 */
function heldFakes() {
  const calls: string[] = [];
  let rejectRun: ((err: unknown) => void) | undefined;
  let answerStop: ((body: Record<string, unknown>) => void) | undefined;
  const fetchFn = ((url: unknown) => {
    const u = String(url);
    const action = /LethALControl_(\w+)/.exec(u)?.[1] ?? u;
    calls.push(action);
    if (action === "RunMutantMany") {
      return new Promise<Response>((_resolve, reject) => {
        rejectRun = reject;
      });
    }
    if (action === "GetOperationStatus") return Promise.resolve(odata(statusOf()));
    if (action === "StopHungRunAt") {
      return new Promise<Response>((resolve) => {
        answerStop = (body) => resolve(odata(body));
      });
    }
    return Promise.reject(new Error(`unexpected action ${u}`));
  }) as typeof fetch;
  return {
    fetchFn,
    calls,
    rejectRun: (err: unknown) => {
      if (rejectRun === undefined) throw new Error("heldFakes: RunMutantMany was never called");
      rejectRun(err);
    },
    answerStop: (body: Record<string, unknown>) => {
      if (answerStop === undefined) throw new Error("heldFakes: StopHungRunAt was never called");
      answerStop(body);
    },
  };
}

/** Fails on its own timer, so a regression that hangs the watchdog fails instead of hanging. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    t = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function readTrace(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Runs `body` with `LETHAL_R289_TRACE` set to `path` (or unset), restoring the old value. */
async function withTraceEnv<T>(path: string | undefined, body: () => Promise<T>): Promise<T> {
  const old = process.env.LETHAL_R289_TRACE;
  if (path === undefined) Reflect.deleteProperty(process.env, "LETHAL_R289_TRACE");
  else process.env.LETHAL_R289_TRACE = path;
  try {
    return await body();
  } finally {
    if (old === undefined) Reflect.deleteProperty(process.env, "LETHAL_R289_TRACE");
    else process.env.LETHAL_R289_TRACE = old;
  }
}

const traceDir = () => scratch("lethal-r289-");

describe("runMany — a well-formed answer becomes per-method verdicts (R198 §3.3)", () => {
  test("complete: one pass per method, in order, with the server's durations", async () => {
    const r = await transport(fakes({ many: odata(answer()) }).fetchFn).runMany(req());
    expect(r.kind).toBe("verdicts");
    if (r.kind !== "verdicts") return;
    expect(r.endedBy).toBe("complete");
    expect(r.ranCount).toBe(3);
    expect(r.verdicts.map((v) => [v.ref.method, v.outcome, v.durationMs])).toEqual([
      ["Alpha", "pass", 41],
      ["Beta", "pass", 42],
      ["Gamma", "pass", 43],
    ]);
    expect(r.verdicts[0]?.attestation).toEqual({ observedAny: true, identityMismatch: false });
  });

  test("failure: a passing prefix then the failing entry, and nothing after it", async () => {
    const inner = answer({
      endedBy: "failure",
      ranCount: 2,
      methods: [entry(1, "Alpha", 2), entry(2, "Beta", 1)],
    });
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    if (r.kind !== "verdicts") throw new Error(r.verdict.failureMessage);
    expect(r.endedBy).toBe("failure");
    expect(r.verdicts.map((v) => v.outcome)).toEqual(["pass", "fail"]);
  });

  test("cap: a passing prefix, for the caller to continue from", async () => {
    const inner = answer({ endedBy: "cap", ranCount: 1, methods: [entry(1, "Alpha", 2)] });
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    if (r.kind !== "verdicts") throw new Error(r.verdict.failureMessage);
    expect(r.endedBy).toBe("cap");
    expect(r.ranCount).toBe(1);
  });
});

describe("runMany — the answer assertions refuse what is not a prefix of the request (R198 §3.3)", () => {
  const malformed = async (over: Record<string, unknown>) => {
    const r = await transport(fakes({ many: odata(answer(over)) }).fetchFn).runMany(req());
    expect(r.kind).toBe("call");
    if (r.kind !== "call") throw new Error("unreachable");
    return r;
  };

  test("missing endedBy", async () => {
    const r = await malformed({ endedBy: undefined });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.outcome).toBe("error");
    expect(r.verdict.operation).toBeUndefined();
  });

  test("ranCount 0 is never a continuation", async () => {
    const r = await malformed({ endedBy: "cap", ranCount: 0, methods: [] });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("ranCount");
  });

  test("ranCount disagrees with the entries", async () => {
    const r = await malformed({ ranCount: 2 });
    expect(r.cause).toBe("group-answer-malformed");
  });

  test("three of three-dozen: complete with fewer entries than requested is an error, not a survivor", async () => {
    const r = await malformed({
      ranCount: 2,
      methods: [entry(1, "Alpha", 2), entry(2, "Beta", 2)],
    });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("complete but 2 of 3");
  });

  test("identity mismatch at entry 2 (a method this request did not ask for there)", async () => {
    const r = await malformed({
      methods: [entry(1, "Alpha", 2), entry(2, "Delta", 2), entry(3, "Gamma", 2)],
    });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("entry 2");
  });

  test("a failure whose last entry passed", async () => {
    const r = await malformed({
      endedBy: "failure",
      ranCount: 2,
      methods: [entry(1, "Alpha", 2), entry(2, "Beta", 2)],
    });
    expect(r.cause).toBe("group-answer-malformed");
  });

  test("runError is named, with the server's own text, before any shape check", async () => {
    const r = await malformed({ runError: "progress-row-missing: no row for attempt a1 op 7" });
    expect(r.cause).toBe("group-run-error");
    expect(r.verdict.failureMessage).toContain("progress-row-missing");
  });
});

describe("runMany — the per-entry faults that abort the session today keep doing so (R198 §3.3)", () => {
  test("an entry with two test lines is a bare error (no cause, no operation)", async () => {
    const inner = answer({
      methods: [entry(1, "Alpha", 2, 2), entry(2, "Beta", 2), entry(3, "Gamma", 2)],
    });
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.cause).toBeUndefined();
    expect(r.verdict.outcome).toBe("error");
    expect(r.verdict.operation).toBeUndefined();
    expect(r.verdict.failureMessage).toContain("2");
  });

  test("an entry whose result is 0 (BC's 'not run') is a bare error, never a pass", async () => {
    const inner = answer({
      methods: [entry(1, "Alpha", 2), entry(2, "Beta", 0), entry(3, "Gamma", 2)],
    });
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.cause).toBeUndefined();
    expect(r.verdict.outcome).toBe("error");
    expect(r.verdict.failureMessage).toContain("result enum");
  });

  test("attestation identityMismatch rejects the whole call as a bare error", async () => {
    const r = await transport(
      fakes({ many: odata(answer({ identityMismatch: true })) }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.cause).toBeUndefined();
    expect(r.verdict.failureMessage).toContain("identity mismatch");
  });

  test("a call-level echo mismatch is completed-effect-unknown, as run's is", async () => {
    const r = await transport(
      fakes({ many: odata(answer({ mutantId: "M0099" })) }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBe("completed-effect-unknown");
  });
});

describe("runMany — refusals classify exactly as run's do (the shared classifier)", () => {
  test("lease-invalid with reason op-stopped is lease-lost carrying the reason; runError beside it is ignored", async () => {
    const inner = { ...answer({ status: "lease-invalid", reason: "op-stopped", runError: "x" }) };
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBe("lease-lost");
    expect(r.verdict.leaseInvalidReason).toBe("op-stopped");
    expect(r.cause).toBeUndefined();
  });

  test("artifact-mismatch is a bare error", async () => {
    const r = await transport(
      fakes({ many: odata(answer({ status: "artifact-mismatch" })) }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBeUndefined();
    expect(r.verdict.failureMessage).toContain("artifact-mismatch");
  });

  test("a non-2xx is in-flight-unknown with the fenced op, and a 404 also asks for a session abort", async () => {
    const r500 = await transport(
      fakes({ many: new Response("boom", { status: 500 }) }).fetchFn,
    ).runMany(req());
    if (r500.kind !== "call") throw new Error("expected a call-level answer");
    expect(r500.verdict.operation).toBe("in-flight-unknown");
    expect(r500.verdict.fencedOp).toEqual({ attemptId: "a1", opSeq: 7 });
    expect(r500.abortSession).toBeUndefined();
    const r404 = await transport(
      fakes({ many: new Response("", { status: 404 }) }).fetchFn,
    ).runMany(req());
    if (r404.kind !== "call") throw new Error("expected a call-level answer");
    expect(r404.verdict.operation).toBe("in-flight-unknown");
    expect(r404.abortSession).toContain("control-app-route-missing");
  });

  test("an unreadable 2xx body is in-flight-unknown, as run's is", async () => {
    const r = await transport(
      fakes({ many: new Response("<html>", { status: 200 }) }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBe("in-flight-unknown");
  });
});

describe("runMany — the watchdog (R198 §3.2)", () => {
  test("the call returns when BC answers, not when the poll interval expires (measured: 4.7 s per call on the tables gate)", async () => {
    const f = fakes({ many: "hold", status: () => statusOf({ opProgress: undefined }) });
    const t0 = Date.now();
    const p = transport(f.fetchFn).runMany(req({ watchdogPollMs: 5_000 }));
    setTimeout(() => f.release(odata(answer())), 20);
    const r = await p;
    expect(r.kind).toBe("verdicts");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("a row that is not ours is 'nothing yet': no stop, no abort, the answer is scored", async () => {
    // The marker idle and the residual row another op's: a start-up poll.
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({
          opKind: "none",
          opAttemptId: "a0",
          opSeq: 6,
          opProgress: {
            ...(statusOf().opProgress as object),
            attemptId: "a0",
            opSeq: 6,
            startedAt: "2026-09-03T09:00:00Z",
          },
        }),
    });
    const p = transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    await new Promise((r) => setTimeout(r, 40));
    f.release(odata(answer()));
    const r = await p;
    expect(f.polls()).toBeGreaterThan(0);
    expect(f.stops.length).toBe(0);
    expect(r.kind).toBe("verdicts");
  });

  test("a progress row that is not ours under a marker that IS ours is 'nothing yet': no stop, no abort (red-checked)", async () => {
    // The marker names our op (kind run, our attempt, our opSeq) but the progress row is a residual
    // of ANOTHER ATTEMPT at the same opSeq (the late-original shape R194 names): over budget on
    // its own clock, naming a method at an index this request does not have. Acting on it would
    // fire a stop on a stale token or abort a healthy call. Same opSeq on purpose, so only the
    // row's own attemptId can exclude it.
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({
          opProgress: {
            ...(statusOf().opProgress as object),
            attemptId: "a0",
            opSeq: 7,
            methodIndex: 9,
            method: "Zeta",
            startedAt: "2026-09-03T09:00:00Z",
          },
        }),
    });
    const p = transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    await new Promise((r) => setTimeout(r, 40));
    f.release(odata(answer()));
    const r = await p;
    expect(f.polls()).toBeGreaterThan(0);
    expect(f.stops.length).toBe(0);
    expect(r.kind).toBe("verdicts");
  });

  test("identity: OUR row naming a method this request did not ask for aborts, and the session must abort after reconciliation", async () => {
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({ opProgress: { ...(statusOf().opProgress as object), method: "Delta" } }),
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(f.stops.length).toBe(0);
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.abortSession).toContain("identity disagreement");
  });

  test("a method over its budget on SERVER clocks fires StopHungRunAt(index, token) once; the 408 is a timeout for that method", async () => {
    const f = fakes({
      many: "hold",
      // 10 s elapsed on the server against a 1 s budget, whatever the client's clock says.
      status: () => statusOf(),
      stopAt: () => {
        setTimeout(() => f.release(new Response(AL_STOP_BODY, { status: 408 })), 5);
        return { stopped: true, sessionId: 9 };
      },
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    expect(f.stops.length).toBe(1);
    expect(f.stops[0]).toMatchObject({
      methodIndex: 1,
      methodToken: "tok-m1",
      attemptId: "a1",
      opSeq: 7,
    });
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("timeout");
    expect(r.verdict.ref.method).toBe("Alpha");
    expect(r.cause).toBeUndefined();
  });

  test("an unparseable server timestamp never fires (elapsed > budget is false for NaN)", async () => {
    const f = fakes({
      many: "hold",
      status: () => statusOf({ serverNow: "not a date" }),
    });
    const p = transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    await new Promise((r) => setTimeout(r, 40));
    f.release(odata(answer()));
    await p;
    expect(f.stops.length).toBe(0);
  });

  test("without --stop-hung-sessions, a method over its budget aborts the request in abortedVerdict's shape", async () => {
    const f = fakes({ many: "hold", status: () => statusOf() });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: false }));
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(f.stops.length).toBe(0);
    expect(r.verdict.outcome).toBe("deadline-exceeded");
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.verdict.fencedOp).toEqual({ attemptId: "a1", opSeq: 7 });
    expect(r.verdict.ref.method).toBe("Alpha");
    expect(r.verdict.failureMessage).toContain("our timer, not BC's stop");
  });

  test("R204: after the 408, a row showing the method's completion recorded refuses the timeout", async () => {
    let afterStop = false;
    const f = fakes({
      many: "hold",
      status: () =>
        afterStop
          ? statusOf({
              opKind: "none",
              lastCompletedOpSeq: 7,
              completed: true,
              opProgress: {
                ...(statusOf().opProgress as object),
                lastCompletedIndex: 1,
                state: "between",
              },
            })
          : statusOf(),
      stopAt: () => {
        afterStop = true;
        setTimeout(() => f.release(new Response(AL_STOP_BODY, { status: 408 })), 5);
        return { stopped: true, sessionId: 9 };
      },
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("error");
    expect(r.cause).toBe("stopped-after-completion");
  });

  test("R204: unavailable evidence after the 408 keeps today's answer, the timeout", async () => {
    let afterStop = false;
    const f = fakes({
      many: "hold",
      status: () => (afterStop ? new Error("status read failed") : statusOf()),
      stopAt: () => {
        afterStop = true;
        setTimeout(() => f.release(new Response(AL_STOP_BODY, { status: 408 })), 5);
        return { stopped: true, sessionId: 9 };
      },
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("timeout");
  });

  test("a 400 after a confirmed stop is in-flight-unknown, never a timeout (R202 stays open)", async () => {
    const f = fakes({
      many: "hold",
      status: () => statusOf(),
      stopAt: () => {
        setTimeout(
          () =>
            f.release(
              new Response("Cannot establish a connection to the SQL Server", { status: 400 }),
            ),
          5,
        );
        return { stopped: true, sessionId: 9 };
      },
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).not.toBe("timeout");
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.verdict.failureMessage).toContain("after our stop (confirmed)");
  });

  test("a 2xx after a fired stop is parsed and scored as if no stop had fired", async () => {
    const f = fakes({
      many: "hold",
      status: () => statusOf(),
      stopAt: () => {
        setTimeout(() => f.release(odata(answer())), 5);
        return { stopped: false, reason: "already-completed" };
      },
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    expect(r.kind).toBe("verdicts");
  });

  test("method-completed clears the decision and the watchdog decides again for a later method", async () => {
    let refusals = 0;
    let index = 1;
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({
          opProgress: {
            ...(statusOf().opProgress as object),
            methodIndex: index,
            method: M[index - 1]?.method,
            token: `tok-m${index}`,
          },
        }),
      stopAt: (body) => {
        if (body.methodIndex === 1) {
          refusals += 1;
          index = 2; // the loop moved on between the poll and the stop
          return { stopped: false, reason: "method-completed", rowIndex: 2, rowState: "running" };
        }
        setTimeout(() => f.release(new Response(AL_STOP_BODY, { status: 408 })), 5);
        return { stopped: true, sessionId: 9 };
      },
    });
    const r = await transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
    expect(refusals).toBe(1);
    expect(f.stops.map((s) => s.methodIndex)).toEqual([1, 2]);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("timeout");
    expect(r.verdict.ref.method).toBe("Beta");
  });

  test("the hard cap (ceiling + grace) aborts a request nothing else ended, naming the watched method", async () => {
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({
          opProgress: { ...(statusOf().opProgress as object), startedAt: "2026-09-03T10:00:09.9Z" },
        }),
    });
    const r = await transport(f.fetchFn).runMany(req({ requestCeilingMs: 30, stopGraceMs: 10 }));
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("deadline-exceeded");
    expect(r.verdict.failureMessage).toContain("hard cap");
    expect(r.verdict.failureMessage).toContain("Alpha");
  });
});

/**
 * R-204b Part R, grouped: every stop the watchdog sends ends in a state, inside its own bound, and
 * the call's state is `refused` only if EVERY attempt was refused. Fake timers, advanced 1 ms at a
 * time, so `at` is the virtual time the call returned.
 */
describe("runMany — R-204b: the call's stop state", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  async function flush(): Promise<void> {
    for (let i = 0; i < 300; i++) await Promise.resolve();
  }
  async function drive(
    fetchFn: typeof fetch,
    over: Partial<RunMutantManyRequest> = {},
  ): Promise<{ r: RunMutantManyResult; at: number }> {
    let out: RunMutantManyResult | undefined;
    let t = 0;
    let at = -1;
    void transport(fetchFn)
      .runMany(req({ stopHungSessions: true, ...over }))
      .then((v) => {
        out = v;
        at = t;
      });
    for (let i = 0; i < 2000 && out === undefined; i++) {
      jest.advanceTimersByTime(1);
      t += 1;
      await flush();
    }
    if (out === undefined) throw new Error("runMany never returned within 2000 virtual ms");
    return { r: out, at };
  }
  const BAD = () => new Response("Cannot establish a connection", { status: 400 });

  test("17a. the stop throws (reply lost): the call's state is unknown", async () => {
    const f = fakes({
      many: "hold",
      stopAt: () => {
        queueMicrotask(() => f.release(BAD()));
        return new Error("ECONNRESET");
      },
    });
    const { r } = await drive(f.fetchFn);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.verdict.stopState).toBe("unknown");
  });

  test("17b. the stop answers stopped:false: refused", async () => {
    const f = fakes({
      many: "hold",
      stopAt: () => {
        queueMicrotask(() => f.release(BAD()));
        return { stopped: false, reason: "no-session-id" };
      },
    });
    const { r } = await drive(f.fetchFn);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.stopState).toBe("refused");
  });

  test("17c. the stop answers stopped:true: confirmed", async () => {
    const f = fakes({
      many: "hold",
      stopAt: () => {
        queueMicrotask(() => f.release(BAD()));
        return { stopped: true, sessionId: 9 };
      },
    });
    const { r } = await drive(f.fetchFn);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.stopState).toBe("confirmed");
  });

  /** Two stop attempts: method 1 refused `method-completed`, then `second` for method 2. */
  function twoAttempts(second: Record<string, unknown> | Error) {
    let index = 1;
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({
          opProgress: {
            ...(statusOf().opProgress as object),
            methodIndex: index,
            method: M[index - 1]?.method,
            token: `tok-m${index}`,
          },
        }),
      stopAt: (body) => {
        if (body.methodIndex === 1) {
          index = 2;
          return { stopped: false, reason: "method-completed", rowIndex: 2, rowState: "running" };
        }
        queueMicrotask(() => f.release(BAD()));
        return second;
      },
    });
    return f;
  }

  test("10. refused then unknown: the call is NOT retry-safe (unknown)", async () => {
    const f = twoAttempts(new Error("ECONNRESET"));
    const { r } = await drive(f.fetchFn);
    expect(f.stops.map((s) => s.methodIndex)).toEqual([1, 2]);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.stopState).toBe("unknown");
  });

  test("10b. refused then refused: the call is refused", async () => {
    const f = twoAttempts({ stopped: false, reason: "no-session-id" });
    const { r } = await drive(f.fetchFn);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.stopState).toBe("refused");
  });

  test("12t. a malformed 2xx after a confirmed stop carries the state as data", async () => {
    const f = fakes({
      many: "hold",
      stopAt: () => {
        queueMicrotask(() => f.release(odata(answer({ endedBy: "bogus" }))));
        return { stopped: true, sessionId: 9 };
      },
    });
    const { r } = await drive(f.fetchFn);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.stopState).toBe("confirmed");
  });

  test("bound: a stop that never answers ends at send time + grace, as unknown", async () => {
    const f = fakes({
      many: "hold",
      stopAt: () => {
        queueMicrotask(() => f.release(BAD()));
        return "hang";
      },
    });
    // Poll at 5, stop sent at 5, grace 100: the call returns at 105, not never.
    const { r, at } = await drive(f.fetchFn, { stopGraceMs: 100 });
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.stopState).toBe("unknown");
    expect(at).toBeGreaterThanOrEqual(104);
    expect(at).toBeLessThanOrEqual(106);
  });

  test("bound: the hard cap ends a stop sent late in the call, not a fresh grace after it", async () => {
    const f = fakes({ many: "hold", stopAt: () => "hang" });
    // Poll at 60, ceiling 50 + grace 100 = hard cap 150: the stop gets 90 ms, not 100.
    const { r, at } = await drive(f.fetchFn, {
      requestCeilingMs: 50,
      stopGraceMs: 100,
      watchdogPollMs: 60,
    });
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("deadline-exceeded");
    expect(r.verdict.stopState).toBe("unknown");
    expect(at).toBeGreaterThanOrEqual(149);
    expect(at).toBeLessThanOrEqual(151);
  });
});

describe("runMany — the session keys (R206 §2.1)", () => {
  const malformed = async (over: Record<string, unknown>) => {
    const r = await transport(fakes({ many: odata(answer(over)) }).fetchFn).runMany(req());
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    return r;
  };

  test("a ran answer without sessionId is malformed", async () => {
    const r = await malformed({ sessionId: undefined });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("sessionId");
  });

  test("a ran answer without testRunsBefore is malformed", async () => {
    const r = await malformed({ testRunsBefore: undefined });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("testRunsBefore");
  });

  test("an entry whose sessionId differs from the call's is malformed (within-call constancy is asserted)", async () => {
    const r = await malformed({
      methods: [
        entry(1, "Alpha", 2),
        { ...entry(2, "Beta", 2), sessionId: SESSION + 1 },
        entry(3, "Gamma", 2),
      ],
    });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("entry 2 carries sessionId");
  });

  test("two entries naming one function line are malformed (the client half of the pair-keyed map)", async () => {
    const r = await malformed({
      methods: [
        entry(1, "Alpha", 2),
        { ...entry(2, "Beta", 2), lineNo: 20010 },
        entry(3, "Gamma", 2),
      ],
    });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("function line 20010");
  });

  test("the guard's value TRAVELS: 0 and a reused count both reach the verdicts unchanged", async () => {
    for (const testRunsBefore of [0, 7]) {
      const r = await transport(fakes({ many: odata(answer({ testRunsBefore })) }).fetchFn).runMany(
        req(),
      );
      if (r.kind !== "verdicts") throw new Error("expected verdicts");
      expect(r.verdicts.map((v) => v.testRunsBefore)).toEqual([
        testRunsBefore,
        testRunsBefore,
        testRunsBefore,
      ]);
      expect(r.verdicts.map((v) => v.sessionId)).toEqual([SESSION, SESSION, SESSION]);
    }
  });

  test("a refusal without either key keeps its own class: lease-invalid, artifact-mismatch, reserved-params, runError", async () => {
    const without = (over: Record<string, unknown>) =>
      answer({ ...over, sessionId: undefined, testRunsBefore: undefined });
    const lease = await transport(
      fakes({ many: odata(without({ status: "lease-invalid", reason: "op-in-flight" })) }).fetchFn,
    ).runMany(req());
    if (lease.kind !== "call") throw new Error("expected call");
    expect(lease.verdict.operation).toBe("lease-lost");
    expect(lease.cause).toBeUndefined();
    const artifact = await transport(
      fakes({ many: odata(without({ status: "artifact-mismatch" })) }).fetchFn,
    ).runMany(req());
    if (artifact.kind !== "call") throw new Error("expected call");
    expect(artifact.verdict.failureMessage).toContain("artifact-mismatch");
    expect(artifact.cause).toBeUndefined();
    const reserved = await transport(
      fakes({ many: odata(without({ status: "reserved-params" })) }).fetchFn,
    ).runMany(req());
    if (reserved.kind !== "call") throw new Error("expected call");
    expect(reserved.verdict.failureMessage).toContain("reserved");
    expect(reserved.cause).toBeUndefined();
    const raised = await transport(
      fakes({ many: odata(without({ runError: "the loop raised" })) }).fetchFn,
    ).runMany(req());
    if (raised.kind !== "call") throw new Error("expected call");
    expect(raised.cause).toBe("group-run-error");
  });

  test("suite-unresolved is a call-level error with NO cause and NO operation, carrying the server's reason", async () => {
    const r = await transport(
      fakes({
        many: odata(
          answer({
            status: "suite-unresolved",
            reason: "expected exactly one method Beta in codeunit 79100, found 0",
            sessionId: undefined,
            testRunsBefore: undefined,
          }),
        ),
      }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected call");
    expect(r.cause).toBeUndefined();
    expect(r.verdict.operation).toBeUndefined();
    expect(r.verdict.outcome).toBe("error");
    expect(r.verdict.failureMessage).toContain("found 0");
    expect(r.methodIndex).toBe(1);
  });

  test("a blank-mutant call (the replay) round-trips: the echo compares blank with blank", async () => {
    const r = await transport(fakes({ many: odata(answer({ mutantId: "" })) }).fetchFn).runMany(
      req({ mutantId: "" }),
    );
    expect(r.kind).toBe("verdicts");
  });

  test("a call-kind result names the request position of the method it is about", async () => {
    const r = await transport(
      fakes({
        many: odata(
          answer({
            methods: [entry(1, "Alpha", 2), entry(2, "Beta", 1, 2)],
            endedBy: "failure",
            ranCount: 2,
          }),
        ),
      }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected the two-line entry to abort the call");
    expect(r.methodIndex).toBe(2);
  });
});

describe("runMany — GH-24: observedActive is per-test reach", () => {
  test("GH-24: observedActive is per entry", async () => {
    const inner = answer({
      methods: [
        entry(1, M[0]?.method ?? "Alpha", 2, 1, false),
        entry(2, M[1]?.method ?? "Beta", 2, 1, true),
        entry(3, M[2]?.method ?? "Gamma", 2, 1, false),
      ],
    });
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    expect(r.kind).toBe("verdicts");
    if (r.kind !== "verdicts") return;
    expect(r.verdicts.map((v) => v.reachedActive)).toEqual([false, true, false]);
  });

  test("GH-24: an entry without observedActive is malformed", async () => {
    const bad = entry(2, M[1]?.method ?? "Beta", 2);
    bad.observedActive = undefined;
    const inner = answer({
      methods: [entry(1, M[0]?.method ?? "Alpha", 2), bad, entry(3, M[2]?.method ?? "Gamma", 2)],
    });
    const r = await transport(fakes({ many: odata(inner) }).fetchFn).runMany(req());
    expect(r.kind).toBe("call");
    if (r.kind !== "call") return;
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toMatch(/observedActive/);
  });
});

describe("RunMutantTransport.runMany: a lost reply is read back (R236b)", () => {
  const TWO = req({ methods: M.slice(0, 2).map((r) => ({ ref: r, budgetMs: 1000 })) });
  const RAN_TWO = answer({
    ranCount: 2,
    methods: [entry(1, "Alpha", 2), entry(2, "Beta", 2)],
  });
  const KEY = { attemptId: "a1", opSeq: 7, epoch: 3, generation: "gen-1" };
  const found =
    (inner: Record<string, unknown>, key: Record<string, unknown> = KEY) =>
    () =>
      odata({ found: true, ...key, answer: JSON.stringify(inner) });
  /** The live shape: a 200 whose body breaks off before its envelope closes. */
  const truncated = () => {
    const text = JSON.stringify({ value: JSON.stringify(RAN_TWO) }).slice(0, -1);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.error(new Error("The socket connection was closed unexpectedly."));
        },
      }),
      { status: 200 },
    );
  };
  const keptUnknown = (r: Awaited<ReturnType<RunMutantTransport["runMany"]>>) => {
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.verdict.fencedOp).toEqual({ attemptId: "a1", opSeq: 7 });
    expect(r.verdict.replyRecovered).toBeUndefined();
    expect(r.verdict.failureMessage).toContain("2xx body could not be read");
    return r.verdict.failureMessage ?? "";
  };

  test("1. body lost, kept answer is two completed passes: they are the verdicts, nothing is re-sent", async () => {
    const f = fakes({ many: truncated(), kept: found(RAN_TWO) });
    const r = await transport(f.fetchFn).runMany(TWO);
    if (r.kind !== "verdicts") throw new Error(`expected verdicts, got ${JSON.stringify(r)}`);
    expect(r.verdicts.map((v) => v.outcome)).toEqual(["pass", "pass"]);
    for (const v of r.verdicts) {
      expect(v.operation).toBeUndefined();
      expect(v.replyRecovered).toContain("2xx body could not be read");
    }
    expect(f.calls).toEqual(["RunMutantMany", "GetOpAnswer"]);
  });

  test("R-496: a readback refused as an unfiltered extensions query rejects runMany", async () => {
    const f = fakes({
      many: truncated(),
      kept: () => new UnfilteredExtensionsQueryError("refused readback"),
    });
    const err = await transport(f.fetchFn)
      .runMany(TWO)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(f.calls).toEqual(["RunMutantMany", "GetOpAnswer"]);
  });

  test("R-496 T-a: a refused main request rejects runMany even though a kept answer is on file", async () => {
    const f = fakes({ many: truncated(), kept: found(RAN_TWO) });
    const fetchFn = ((url: unknown, init?: RequestInit) =>
      String(url).includes("_RunMutantMany")
        ? Promise.reject(new UnfilteredExtensionsQueryError("refused main"))
        : f.fetchFn(url as string, init)) as typeof fetch;
    const err = await transport(fetchFn)
      .runMany(TWO)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(f.calls).toEqual(["GetOpAnswer"]);
  });

  test("R-496 T-b: a status read refused after a confirmed stop and an AL-stop 408 rejects runMany", async () => {
    let after408 = false;
    const f = fakes({
      many: "hold",
      status: () => (after408 ? new UnfilteredExtensionsQueryError("refused status") : statusOf()),
      stopAt: () => {
        setTimeout(() => {
          after408 = true;
          f.release(new Response(AL_STOP_BODY, { status: 408 }));
        }, 5);
        return { stopped: true, sessionId: 9 };
      },
    });
    const err = await transport(f.fetchFn)
      .runMany(req({ stopHungSessions: true }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
  });

  test("2. a kept answer carrying runError is not accepted", async () => {
    const f = fakes({ many: truncated(), kept: found(answer({ runError: "boom" })) });
    const msg = keptUnknown(await transport(f.fetchFn).runMany(TWO));
    expect(msg).toContain("answer readback not accepted");
  });

  test("3. a kept lease-invalid refusal is not accepted", async () => {
    const refusal = answer({ status: "lease-invalid", reason: "op-stopped" });
    const f = fakes({ many: truncated(), kept: found(refusal) });
    const msg = keptUnknown(await transport(f.fetchFn).runMany(TWO));
    expect(msg).toContain("answer readback not accepted");
  });

  test("4. found: false keeps the unknown and names what the server holds", async () => {
    const f = fakes({
      many: truncated(),
      kept: () => odata({ found: false, keptAttemptId: "a0", keptOpSeq: 6 }),
    });
    const msg = keptUnknown(await transport(f.fetchFn).runMany(TWO));
    expect(msg).toContain(
      "answer readback: the server holds no committed answer for a1/7 (it holds a0/6)",
    );
  });

  test("5. a kept answer echoing a different epoch is refused client-side", async () => {
    const f = fakes({ many: truncated(), kept: found(RAN_TWO, { ...KEY, epoch: 4 }) });
    const msg = keptUnknown(await transport(f.fetchFn).runMany(TWO));
    expect(msg).toContain("answer readback failed");
  });

  test("6. a whole reply is scored as it arrives and never reads back", async () => {
    const f = fakes({ many: odata(RAN_TWO), kept: found(RAN_TWO) });
    const r = await transport(f.fetchFn).runMany(TWO);
    if (r.kind !== "verdicts") throw new Error("expected verdicts");
    expect(r.verdicts.every((v) => v.replyRecovered === undefined)).toBe(true);
    expect(f.calls).toEqual(["RunMutantMany"]);
  });

  test("7. an identity disagreement still aborts the session, whatever the kept answer says", async () => {
    const f = fakes({
      many: "hold",
      status: () =>
        statusOf({ opProgress: { ...(statusOf().opProgress as object), method: "Delta" } }),
      kept: found(RAN_TWO),
    });
    const r = await transport(f.fetchFn).runMany({ ...TWO, stopHungSessions: true });
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.abortSession).toContain("identity disagreement");
    expect(f.calls).not.toContain("GetOpAnswer");
  });

  test("8. an unexpected 404 still aborts the session, whatever the kept answer says", async () => {
    const f = fakes({ many: new Response("", { status: 404 }), kept: found(RAN_TWO) });
    const r = await transport(f.fetchFn).runMany(TWO);
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.abortSession?.startsWith("control-app-route-missing")).toBe(true);
    expect(f.calls).not.toContain("GetOpAnswer");
  });
});

describe("runMany, a confirmed stop with no 408 (2026-09-27 hang investigation, offline scenario B)", () => {
  /**
   * `docs/measurements/2026-09-27-r289-hang-rootcause.md`, evidence
   * item 4, scenario B: `StopHungRunAt` answers `stopped: true` (the server confirms the stop) but
   * the held `RunMutantMany` request never gets its 408 back: the exact shape a stranded op takes
   * when the confirmation itself does not land. `runManyOnce` alone already decides
   * `in-flight-unknown` at the hard cap, before any readback runs; `runMany` must reach the SAME
   * classification and only APPEND to the message, and `GetOpAnswer` must never be called before
   * that hard-cap abort: calling it earlier would mean the readback could influence a
   * classification it is defined never to change (review ruling C2, run-mutant-transport.ts).
   */
  test("StopHungRunAt confirms but the held request is never released: the hard cap decides in-flight-unknown, and GetOpAnswer runs only after the abort", async () => {
    const f = fakes({
      many: "hold",
      status: () => statusOf(),
      stopAt: () => ({ stopped: true, sessionId: 9 }), // confirmed, but the held fetch never releases
      kept: () => odata({ found: false, keptAttemptId: "a0", keptOpSeq: 6 }),
    });
    const r = await transport(f.fetchFn).runMany(
      req({ requestCeilingMs: 30, stopGraceMs: 10, stopHungSessions: true }),
    );
    if (r.kind !== "call") throw new Error("expected a call-level answer");
    expect(r.verdict.outcome).toBe("deadline-exceeded");
    expect(r.verdict.operation).toBe("in-flight-unknown");
    expect(r.verdict.failureMessage).toContain("hard cap");
    // The watchdog's stopDetail(): proof the stop was decided before the hard cap ended the call,
    // not routed around it.
    expect(r.verdict.failureMessage).toContain("progress row:");
    // The readback ran (this is what makes it "in-flight-unknown", not silently dropped) but found
    // nothing, so it only appended a reason: it never replaced the verdict or its operation.
    expect(r.verdict.failureMessage).toContain("answer readback:");
    expect(f.stops.length).toBe(1);
    // Call order is the assertion that matters: StopHungRunAt before the abort, GetOpAnswer only
    // after runManyOnce has already settled via that abort.
    expect(f.calls).toEqual(["RunMutantMany", "StopHungRunAt", "GetOpAnswer"]);
  });
});
describe("runMany, a connection failure keeps the watchdog's story (R289)", () => {
  test("R289: the fetch rejects while the stop is still pending; the message names every watchdog step and the trace pins the order", async () => {
    const tracePath = join(traceDir(), "trace.ndjson");
    const f = heldFakes();
    const v = await withTraceEnv(tracePath, async () => {
      const pending = transport(f.fetchFn).runMany(req({ stopHungSessions: true }));
      await until(() => f.calls.includes("StopHungRunAt"), 2_000, "StopHungRunAt");
      f.rejectRun(new DOMException("The operation timed out.", "TimeoutError"));
      // Let the fetch catch run (and block on the held stop) before the stop answers.
      await new Promise((r) => setTimeout(r, 20));
      f.answerStop({ stopped: false, reason: "not-active" });
      const r = await within(pending, 2_000, "runMany to settle");
      if (r.kind !== "call") throw new Error("expected a call-level answer");
      return r.verdict;
    });
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.failureMessage).toContain("RunMutantMany connection failed after dispatch");
    expect(v.failureMessage).toMatch(/stop sent at \+\d+ms, answered at \+\d+ms/);
    expect(v.failureMessage).toMatch(/failed at \+\d+ms/);
    expect(v.failureMessage).toContain("polls ok 1, polls failed 0");
    // ORDER is pinned by trace events, not by elapsed milliseconds (review r2).
    const events = readTrace(tracePath).map((e) => e.event);
    const at = (name: string) => events.indexOf(name);
    expect(at("stop-sent")).toBeGreaterThan(-1);
    expect(at("stop-sent")).toBeLessThan(at("settled"));
    expect(at("settled")).toBeLessThan(at("stop-answered"));
    expect(readTrace(tracePath).find((e) => e.event === "settled")?.how).toBe("connection-failed");
  });

  test("R289 trace: every line names the request; every poll-ok carries its send time, the row's identity and both server clocks", async () => {
    const tracePath = join(traceDir(), "trace.ndjson");
    const f = fakes({
      many: "hold",
      // Running, but inside its budget: the watchdog polls and never stops.
      status: () => statusOf({ serverNow: "2026-09-03T10:00:00Z" }),
    });
    await withTraceEnv(tracePath, async () => {
      const pending = transport(f.fetchFn).runMany(req());
      await until(() => f.polls() >= 3, 2_000, "three polls");
      f.release(odata(answer()));
      const r = await within(pending, 2_000, "runMany to settle");
      expect(r.kind).toBe("verdicts");
    });
    const lines = readTrace(tracePath);
    expect(lines[0]?.event).toBe("dispatch");
    expect(lines.at(-1)).toMatchObject({ event: "settled", how: "answer" });
    for (const l of lines) {
      expect(l).toMatchObject({ mutantId: "M0003", attemptId: "a1", opSeq: 7 });
      expect(typeof l.at).toBe("number");
    }
    const oks = lines.filter((l) => l.event === "poll-ok");
    expect(oks.length).toBeGreaterThanOrEqual(1);
    for (const ok of oks) {
      expect(typeof ok.seq).toBe("number");
      expect(ok.sentAt as number).toBeLessThanOrEqual(ok.at as number);
      expect(ok).toMatchObject({
        state: "running",
        methodIndex: 1,
        rowAttemptId: "a1",
        rowOpSeq: 7,
        startedAt: "2026-09-03T10:00:00Z",
        serverNow: "2026-09-03T10:00:00Z",
      });
      const sentBefore = lines.findIndex((l) => l.event === "poll-sent" && l.seq === ok.seq);
      expect(sentBefore).toBeGreaterThan(-1);
      expect(sentBefore).toBeLessThan(lines.indexOf(ok));
    }
  });

  test("R289 trace: unset, no file is created", async () => {
    const tracePath = join(traceDir(), "trace.ndjson");
    await withTraceEnv(undefined, async () => {
      const r = await within(
        transport(fakes({ many: odata(answer()) }).fetchFn).runMany(req()),
        2_000,
        "runMany",
      );
      expect(r.kind).toBe("verdicts");
    });
    expect(existsSync(tracePath)).toBe(false);
  });

  test("R289 trace: an unwritable path is refused before dispatch, naming the variable and the path", async () => {
    const tracePath = join(traceDir(), "no-such-dir", "trace.ndjson");
    const f = fakes({ many: odata(answer()) });
    await withTraceEnv(tracePath, async () => {
      const run = transport(f.fetchFn).runMany(req());
      await expect(run).rejects.toThrow(`LETHAL_R289_TRACE=${tracePath} is not writable`);
    });
    expect(f.calls).not.toContain("RunMutantMany");
  });

  test("R289 trace: a write that fails inside the watchdog stops tracing, never rejects the watchdog, leaves every verdict untouched and is warned once on stderr", async () => {
    // A passing prefix then a FAIL: the fail's message is what becomes `killingTestFailure`.
    const inner = () =>
      odata(
        answer({
          endedBy: "failure",
          ranCount: 2,
          methods: [entry(1, "Alpha", 2), entry(2, "Beta", 1)],
        }),
      );
    const run = async (traceWrite?: (path: string, line: string) => void) => {
      const f = fakes({
        many: "hold",
        status: () => statusOf({ serverNow: "2026-09-03T10:00:00Z" }),
      });
      const t =
        traceWrite === undefined
          ? transport(f.fetchFn)
          : new RunMutantTransport(CFG, TA, AR, f.fetchFn, { traceWrite });
      const pending = t.runMany(req());
      await until(() => f.polls() >= 3, 2_000, "three polls");
      f.release(inner());
      return within(pending, 2_000, "runMany to settle");
    };
    const tracePath = join(traceDir(), "trace.ndjson");
    const writes: string[] = [];
    const warnings: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    let traced: Awaited<ReturnType<typeof run>>;
    let plain: Awaited<ReturnType<typeof run>>;
    try {
      traced = await withTraceEnv(tracePath, () =>
        run((_path, line) => {
          writes.push(line);
          if (line.includes('"poll-sent"')) throw new Error("disk full");
        }),
      );
      plain = await withTraceEnv(undefined, () => run());
    } finally {
      warn.mockRestore();
    }
    if (traced.kind !== "verdicts") throw new Error("expected verdicts");
    expect(traced.verdicts.map((v) => v.outcome)).toEqual(["pass", "fail"]);
    // The verdicts are exactly what an untraced call returns: no suffix on any failureMessage.
    if (plain.kind !== "verdicts") throw new Error("expected verdicts");
    expect(traced.verdicts).toEqual(plain.verdicts);
    // Named once, on stderr, with the path and the count.
    expect(warnings).toEqual([expect.stringContaining(`LETHAL_R289_TRACE=${tracePath}`)]);
    expect(warnings[0]).toContain("trace write failed 1 times");
    // Bounded: `dispatch`, then the first `poll-sent` that threw, and nothing after it.
    expect(writes.length).toBe(2);
  });
});

describe("R-496 review round 3: a refused extensions query stops the watchdog and the call", () => {
  test("a progress poll refused as an unfiltered extensions query rejects runMany, polling stops", async () => {
    const f = fakes({
      many: "hold",
      status: () => new UnfilteredExtensionsQueryError("refused poll"),
    });
    const err = await within(
      transport(f.fetchFn)
        .runMany(req())
        .catch((e: unknown) => e),
      3_000,
      "runMany",
    );
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(f.polls()).toBe(1);
  });

  test("a StopHungRunAt refused as an unfiltered extensions query rejects runMany", async () => {
    const f = fakes({
      many: "hold",
      stopAt: () => new UnfilteredExtensionsQueryError("refused stop"),
    });
    const err = await within(
      transport(f.fetchFn)
        .runMany(req({ stopHungSessions: true }))
        .catch((e: unknown) => e),
      3_000,
      "runMany",
    );
    expect(err).toBeInstanceOf(UnfilteredExtensionsQueryError);
    expect(f.stops.length).toBe(1);
  });
});
