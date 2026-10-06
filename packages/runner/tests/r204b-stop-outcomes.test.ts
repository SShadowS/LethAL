import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef, TestVerdict } from "../src/backend";
import { RunMutantTransport } from "../src/run-mutant-transport";
import type { StopHookAnswer } from "../src/run-mutant-transport";

/**
 * R-204b, the single path (`RunMutant`). Part A: a recognised stop 408 is refused as
 * `stopped-after-completion` when the op's own progress row shows the method recorded its
 * completion. Part R: the stop hook's outcome is recorded on the verdict as `stopState`, settled
 * before the call returns, inside the REMAINING grace. Every test drives the order by hand with
 * deferred promises and fake timers; none waits on the wall clock.
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
const REF: TestMethodRef = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "Hangs" };
const LEASE = { epoch: 3, token: "tok-abc", serverGeneration: "gen-1", opSeq: 7 } as const;
const BUDGET = 1000;
const GRACE = 500;
const AL_STOP_BODY = JSON.stringify({
  error: {
    message:
      "The server stopped the session (ID: 2683) because of a stop session request. The session was stopped by an AL StopSession call.",
  },
});

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise chain run; fake timers do not advance here. */
async function flush(): Promise<void> {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

const odata = (inner: Record<string, unknown>) =>
  new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opKind: "none",
    opAttemptId: "a1",
    opSeq: 7,
    lastCompletedOpSeq: 7,
    completed: true,
    serverNow: "2026-10-06T10:00:10Z",
    opProgress: {
      attemptId: "a1",
      opSeq: 7,
      methodIndex: 1,
      codeunitId: 79100,
      method: "Hangs",
      token: "tok-m1",
      startedAt: "2026-10-06T10:00:00Z",
      lastCompletedIndex: 0,
      state: "running",
      ...over,
    },
  };
}

/**
 * One single-path call. `RunMutant` answers when the test resolves `run`; `GetOperationStatus`
 * answers from `status` (or rejects); `GetOpAnswer` (R236b) rejects unless `kept` is given.
 */
function start(o: {
  hook: () => Promise<StopHookAnswer>;
  status?: () => Record<string, unknown> | Error;
  kept?: () => Response;
}) {
  const run = deferred<Response>();
  const calls: string[] = [];
  let fired = 0;
  const fetchFn = ((url: unknown, init?: RequestInit) => {
    const action = /LethALControl_(\w+)/.exec(String(url))?.[1] ?? String(url);
    calls.push(action);
    if (action === "RunMutant") {
      // Honours the abort signal like a real fetch, so the hard cap can end the held request.
      init?.signal?.addEventListener("abort", () => run.reject(new Error("aborted")), {
        once: true,
      });
      return run.promise;
    }
    if (action === "GetOperationStatus") {
      const s = o.status === undefined ? new Error("no status in this test") : o.status();
      return s instanceof Error ? Promise.reject(s) : Promise.resolve(odata(s));
    }
    if (action === "GetOpAnswer" && o.kept !== undefined) return Promise.resolve(o.kept());
    return Promise.reject(new Error(`unexpected action ${action}`));
  }) as typeof fetch;
  let out: TestVerdict | undefined;
  const p = new RunMutantTransport(CFG, TA, AR, fetchFn).run({
    ref: REF,
    mutantId: "M0003",
    attemptId: "a1",
    timeoutMs: BUDGET,
    stopGraceMs: GRACE,
    lease: LEASE,
    onBudgetExceeded: () => {
      fired += 1;
      return o.hook();
    },
  });
  void p.then((v) => {
    out = v;
  });
  return { run, calls, fired: () => fired, out: () => out };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("R-204b Part A: a stop 408 after the method recorded its completion is refused (single path)", () => {
  async function stoppedWith(status: () => Record<string, unknown> | Error) {
    const c = start({ hook: async () => ({ stopped: true }), status });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    expect(c.fired()).toBe(1);
    c.run.resolve(new Response(AL_STOP_BODY, { status: 408 }));
    await flush();
    const v = c.out();
    if (v === undefined) throw new Error("the call did not return");
    return { v, calls: c.calls };
  }

  test("1. row ours with lastCompletedIndex 1: error / stopped-after-completion, no operation", async () => {
    const { v, calls } = await stoppedWith(() => row({ lastCompletedIndex: 1, state: "between" }));
    expect(calls).toContain("GetOperationStatus");
    expect(v.outcome).toBe("error");
    expect(v.stopRefusal).toBe("stopped-after-completion");
    expect(v.operation).toBeUndefined();
  });

  test("2. lastCompletedIndex 0: the stop stands, timeout", async () => {
    const { v } = await stoppedWith(() => row({ lastCompletedIndex: 0 }));
    expect(v.outcome).toBe("timeout");
    expect(v.stopRefusal).toBeUndefined();
  });

  test("3. the status read throws: unavailable evidence stays timeout", async () => {
    const { v } = await stoppedWith(() => new Error("GetOperationStatus unreachable"));
    expect(v.outcome).toBe("timeout");
    expect(v.stopRefusal).toBeUndefined();
  });

  test("4. the row names another attemptId: not ours, timeout", async () => {
    const { v } = await stoppedWith(() => row({ lastCompletedIndex: 1, attemptId: "a0" }));
    expect(v.outcome).toBe("timeout");
    expect(v.stopRefusal).toBeUndefined();
  });

  test("4b. the row names another opSeq: not ours, timeout", async () => {
    const { v } = await stoppedWith(() => row({ lastCompletedIndex: 1, opSeq: 6 }));
    expect(v.outcome).toBe("timeout");
  });
});

describe("R-204b Part R: the stop's outcome is settled before the call returns (single path)", () => {
  const BAD_REQUEST = () => new Response("Cannot establish a connection", { status: 400 });

  test("13. 400 BEFORE the stop's reply: the call waits, and the reply's `confirmed` is recorded", async () => {
    const hook = deferred<StopHookAnswer>();
    const c = start({ hook: () => hook.promise });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    c.run.resolve(BAD_REQUEST());
    await flush();
    expect(c.out()).toBeUndefined(); // still waiting on the stop's reply
    hook.resolve({ stopped: true });
    await flush();
    expect(c.out()?.stopState).toBe("confirmed");
    expect(c.out()?.operation).toBe("in-flight-unknown");
  });

  test("14. the stop's reply BEFORE the 400: confirmed", async () => {
    const c = start({ hook: async () => ({ stopped: true }) });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    c.run.resolve(BAD_REQUEST());
    await flush();
    expect(c.out()?.stopState).toBe("confirmed");
  });

  test("15. a stop that never answers is `unknown`, and the wait ends at the REMAINING grace, not a fresh one", async () => {
    const hook = deferred<StopHookAnswer>(); // never settled
    const c = start({ hook: () => hook.promise });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    // The answer arrives 100 ms before the grace ends: it must not buy another full grace.
    jest.advanceTimersByTime(GRACE - 100);
    c.run.resolve(BAD_REQUEST());
    await flush();
    jest.advanceTimersByTime(99);
    await flush();
    expect(c.out()).toBeUndefined();
    jest.advanceTimersByTime(1);
    await flush();
    expect(c.out()?.stopState).toBe("unknown");
  });

  test("15b. the grace already spent when the call ends: `unknown` at once", async () => {
    const hook = deferred<StopHookAnswer>();
    const c = start({ hook: () => hook.promise });
    await flush();
    jest.advanceTimersByTime(BUDGET + GRACE);
    await flush();
    // The hard cap aborted the held request; the stop is still unanswered.
    expect(c.out()?.stopState).toBe("unknown");
    expect(c.out()?.outcome).toBe("deadline-exceeded");
  });

  test("16a. the stop REJECTS (its reply was lost): unknown, never refused", async () => {
    const c = start({ hook: () => Promise.reject(new Error("ECONNRESET")) });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    c.run.resolve(BAD_REQUEST());
    await flush();
    expect(c.out()?.stopState).toBe("unknown");
  });

  test("16b. the stop RESOLVES with a typed refusal: refused", async () => {
    const c = start({ hook: async () => ({ stopped: false, reason: "already-completed" }) });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    c.run.resolve(BAD_REQUEST());
    await flush();
    expect(c.out()?.stopState).toBe("refused");
    expect(c.out()?.failureMessage).toContain("already-completed");
  });

  test("no stop fired: no stopState at all", async () => {
    const c = start({ hook: async () => ({ stopped: true }) });
    await flush();
    c.run.resolve(BAD_REQUEST());
    await flush();
    expect(c.fired()).toBe(0);
    expect(c.out()?.operation).toBe("in-flight-unknown");
    expect(c.out()?.stopState).toBeUndefined();
  });

  test("11. a valid kept answer is still recovered and scored after a confirmed stop (R236b runs first)", async () => {
    const answer = JSON.stringify({
      status: "ran",
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      codeunitId: 79100,
      method: "Hangs",
      codeunitResults: JSON.stringify({ testResults: [{ method: "Hangs", result: 2 }] }),
      testRunsBefore: 0,
      sessionId: 2037,
      observedActive: true,
    });
    const c = start({
      hook: async () => ({ stopped: true }),
      kept: () => odata({ found: true, attemptId: "a1", opSeq: 7, epoch: 3, generation: "gen-1", answer }),
    });
    await flush();
    jest.advanceTimersByTime(BUDGET);
    await flush();
    c.run.resolve(BAD_REQUEST());
    await flush();
    expect(c.out()?.outcome).toBe("pass");
    expect(c.out()?.replyRecovered).toContain("HTTP 400");
  });
});
