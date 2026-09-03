import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef } from "../src/backend";
import { RunMutantTransport } from "../src/run-mutant-transport";
import type { RunMutantManyRequest } from "../src/run-mutant-transport";

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

function entry(i: number, method: string, result: number, lines = 1): Record<string, unknown> {
  const testResults = Array.from({ length: lines }, () => ({ method, result }));
  return {
    index: i,
    codeunitId: 79100,
    method,
    lineNo: 20000 + i * 10,
    sessionId: SESSION,
    codeunitResults: JSON.stringify({ testResults }),
    durationMs: 40 + i,
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
  stopAt?: (body: Record<string, unknown>) => Record<string, unknown>;
}) {
  const stops: Record<string, unknown>[] = [];
  let polls = 0;
  let release: ((r: Response) => void) | undefined;
  const fetchFn = ((url: unknown, init?: RequestInit) => {
    const u = String(url);
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
      return Promise.resolve(odata(a));
    }
    return Promise.reject(new Error(`unexpected action ${u}`));
  }) as typeof fetch;
  return {
    fetchFn,
    stops,
    polls: () => polls,
    release: (r: Response) => release?.(r),
  };
}

function transport(fetchFn: typeof fetch): RunMutantTransport {
  return new RunMutantTransport(CFG, TA, AR, fetchFn);
}

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
      methods: [entry(1, "Alpha", 2), { ...entry(2, "Beta", 2), sessionId: SESSION + 1 }, entry(3, "Gamma", 2)],
    });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("entry 2 carries sessionId");
  });

  test("two entries naming one function line are malformed (the client half of the pair-keyed map)", async () => {
    const r = await malformed({
      methods: [entry(1, "Alpha", 2), { ...entry(2, "Beta", 2), lineNo: 20010 }, entry(3, "Gamma", 2)],
    });
    expect(r.cause).toBe("group-answer-malformed");
    expect(r.verdict.failureMessage).toContain("function line 20010");
  });

  test("the guard's value TRAVELS: 0 and a reused count both reach the verdicts unchanged", async () => {
    for (const testRunsBefore of [0, 7]) {
      const r = await transport(fakes({ many: odata(answer({ testRunsBefore })) }).fetchFn).runMany(req());
      if (r.kind !== "verdicts") throw new Error("expected verdicts");
      expect(r.verdicts.map((v) => v.testRunsBefore)).toEqual([testRunsBefore, testRunsBefore, testRunsBefore]);
      expect(r.verdicts.map((v) => v.sessionId)).toEqual([SESSION, SESSION, SESSION]);
    }
  });

  test("a refusal without either key keeps its own class: lease-invalid, artifact-mismatch, reserved-params, runError", async () => {
    const without = (over: Record<string, unknown>) =>
      answer({ ...over, sessionId: undefined, testRunsBefore: undefined });
    const lease = await transport(fakes({ many: odata(without({ status: "lease-invalid", reason: "op-in-flight" })) }).fetchFn).runMany(req());
    if (lease.kind !== "call") throw new Error("expected call");
    expect(lease.verdict.operation).toBe("lease-lost");
    expect(lease.cause).toBeUndefined();
    const artifact = await transport(fakes({ many: odata(without({ status: "artifact-mismatch" })) }).fetchFn).runMany(req());
    if (artifact.kind !== "call") throw new Error("expected call");
    expect(artifact.verdict.failureMessage).toContain("artifact-mismatch");
    expect(artifact.cause).toBeUndefined();
    const reserved = await transport(fakes({ many: odata(without({ status: "reserved-params" })) }).fetchFn).runMany(req());
    if (reserved.kind !== "call") throw new Error("expected call");
    expect(reserved.verdict.failureMessage).toContain("reserved");
    expect(reserved.cause).toBeUndefined();
    const raised = await transport(fakes({ many: odata(without({ runError: "the loop raised" })) }).fetchFn).runMany(req());
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
        many: odata(answer({ methods: [entry(1, "Alpha", 2), entry(2, "Beta", 1, 2)], endedBy: "failure", ranCount: 2 })),
      }).fetchFn,
    ).runMany(req());
    if (r.kind !== "call") throw new Error("expected the two-line entry to abort the call");
    expect(r.methodIndex).toBe(2);
  });
});
