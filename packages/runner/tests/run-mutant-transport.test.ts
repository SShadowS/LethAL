import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef } from "../src/backend";
import { RunMutantTransport } from "../src/run-mutant-transport";

const CFG: ActivationConfig = {
  baseUrl: "http://bc:7048/BC",
  company: "CRONUS Danmark A/S",
  username: "u",
  password: "p",
  tenant: "default",
};
const TA = "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a";
const AR = "5c0a4c0a5c0a4c0a5c0a4c0a5c0a4c0a";
const REF: TestMethodRef = {
  codeunitId: 79100,
  codeunitName: "Sandbox Tests",
  method: "OverBudgetDetected",
};
const REQ = { ref: REF, mutantId: "M0003", attemptId: "a1", timeoutMs: 5000 } as const;

/** An identity-echoing RunMutant result, overridable per-field. */
function echo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ran",
    targetAppId: TA,
    artifactId: AR,
    attemptId: "a1",
    mutantId: "M0003",
    codeunitId: 79100,
    method: "OverBudgetDetected",
    codeunitResults: JSON.stringify({
      testResults: [{ method: "OverBudgetDetected", result: 2 }],
    }),
    ...over,
  };
}

/** A 200 whose OData scalar `value` is the (stringified) inner result JSON. */
function okFetch(inner: Record<string, unknown>): typeof fetch {
  return (async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ value: JSON.stringify(inner) }), {
      status: 200,
    })) as typeof fetch;
}

function transport(fetchFn: typeof fetch): RunMutantTransport {
  return new RunMutantTransport(CFG, TA, AR, fetchFn);
}

describe("RunMutantTransport.run — terminal mapping", () => {
  test("result enum 2 → pass", async () => {
    const v = await transport(okFetch(echo())).run(REQ);
    expect(v.outcome).toBe("pass");
    expect(v.operation).toBeUndefined();
  });

  test("baseline (mutantId empty) round-trips", async () => {
    const inner = echo({
      mutantId: "",
      codeunitResults: JSON.stringify({
        testResults: [{ method: "OverBudgetDetected", result: 2 }],
      }),
    });
    const v = await transport(okFetch(inner)).run({ ...REQ, mutantId: "" });
    expect(v.outcome).toBe("pass");
  });

  test("result enum 1 → fail, carries message + stack", async () => {
    const inner = echo({
      codeunitResults: JSON.stringify({
        testResults: [
          {
            method: "OverBudgetDetected",
            result: 1,
            message: "equal amounts must not be over budget",
            stackTrace: "Sandbox Tests(CodeUnit 79100).OverBudgetDetected line 7",
          },
        ],
      }),
    });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("fail");
    expect(v.failureMessage).toContain("equal amounts must not be over budget");
    expect(v.failureMessage).toContain("line 7");
  });

  test("unexpected result enum → error (fail closed)", async () => {
    const inner = echo({
      codeunitResults: JSON.stringify({
        testResults: [{ method: "OverBudgetDetected", result: 9 }],
      }),
    });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("unexpected result enum");
  });

  test("more than one test line → error (exactly-one fail closed)", async () => {
    const inner = echo({
      codeunitResults: JSON.stringify({
        testResults: [
          { method: "OverBudgetDetected", result: 2 },
          { method: "ClampPercentRuns", result: 2 },
        ],
      }),
    });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("expected exactly 1");
  });
});

describe("RunMutantTransport.run — request shape", () => {
  test("POSTs LethALControl_RunMutant with camelCase body + empty lease params", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const capture = (async (url: unknown, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ value: JSON.stringify(echo()) }), { status: 200 });
    }) as typeof fetch;
    await transport(capture).run(REQ);
    expect(seen?.url).toContain("/ODataV4/LethALControl_RunMutant");
    expect(seen?.url).toContain("tenant=default");
    expect(seen?.url).toContain("company=CRONUS");
    expect(seen?.body).toEqual({
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      testCodeunitId: 79100,
      testMethod: "OverBudgetDetected",
      leaseEpoch: "",
      leaseToken: "",
    });
  });
});

describe("RunMutantTransport.run — 5B dispatch classification", () => {
  // Revision: a throw surfacing from `await this.fetchFn(...)` means fetchFn was already
  // invoked — the connection may have reached BC before failing, so this is NOT provably
  // pre-dispatch. Only a throw before fetchFn is ever called would be pre-dispatch-rejected;
  // this transport has no such code path today (design doc §H / sol6).
  test("fetch throw after invocation → error + in-flight-unknown (never retry-safe)", async () => {
    const throwing = (async (_url: unknown, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const v = await transport(throwing).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("in-flight-unknown");
  });

  test("post-dispatch connection reset (not our abort) → in-flight-unknown", async () => {
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch; // controller.signal NOT aborted
    const v = await transport(fetchFn).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("in-flight-unknown");
  });

  test("request-construction throw (bad credential char) → error + pre-dispatch-rejected, fetchFn never called", async () => {
    // U+0100 has a code unit >255 — btoa() throws InvalidCharacterError encoding the auth header,
    // synchronously and BEFORE fetchFn is invoked (design §H).
    const badCfg: ActivationConfig = { ...CFG, password: "bĀd" };
    let called = false;
    const spyFetch = (async (_url: unknown, _init?: RequestInit) => {
      called = true;
      return new Response(JSON.stringify({ value: JSON.stringify(echo()) }), { status: 200 });
    }) as typeof fetch;
    const v = await new RunMutantTransport(badCfg, TA, AR, spyFetch).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("pre-dispatch-rejected");
    expect(called).toBe(false);
  });

  test("our timeout → deadline-exceeded + in-flight-unknown (clear unconfirmed)", async () => {
    const neverResolving = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const v = await transport(neverResolving).run({ ...REQ, timeoutMs: 20 });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBe("in-flight-unknown");
  });

  test("non-2xx → error + in-flight-unknown (possibly-stranded mutant)", async () => {
    const five00 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const v = await transport(five00).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("in-flight-unknown");
  });

  test("2xx malformed body → in-flight-unknown", async () => {
    const malformed = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as typeof fetch;
    const v = await transport(malformed).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("in-flight-unknown");
  });
});

describe("RunMutantTransport.run — guards", () => {
  test("artifact-mismatch → typed error, never survived, ran nothing (no in-flight)", async () => {
    const inner = {
      status: "artifact-mismatch",
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      codeunitId: 79100,
      method: "OverBudgetDetected",
    };
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("artifact-mismatch");
    expect(v.operation).toBeUndefined();
  });

  test("identity mismatch (echoed method differs) → rejected error", async () => {
    const inner = echo({ method: "SomeOtherMethod" });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("identity mismatch");
  });

  test("identity mismatch on mutantId → rejected error", async () => {
    const inner = echo({ mutantId: "M9999" });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("identity mismatch");
  });
});

describe("RunMutantTransport.run — per-run attestation (spec §G)", () => {
  test("identityMismatch=true → error, never a verdict", async () => {
    const inner = echo({ observedAny: true, identityMismatch: true });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("identity");
  });

  test("clean run surfaces attestation for the session gate", async () => {
    const inner = echo({ observedAny: true, identityMismatch: false });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("pass");
    expect(v.attestation).toEqual({ observedAny: true, identityMismatch: false });
  });

  test("empty attestation (no instrumented site) is allowed", async () => {
    const inner = echo({ observedAny: false, identityMismatch: false });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("pass");
    expect(v.attestation).toEqual({ observedAny: false, identityMismatch: false });
  });
});
