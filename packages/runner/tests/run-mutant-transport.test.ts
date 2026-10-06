import { describe, expect, test } from "bun:test";
import type { ActivationConfig } from "../src/activation";
import type { TestMethodRef } from "../src/backend";
import { MAX_ATTEMPT_ID_LENGTH } from "../src/lease";
import {
  FencedCoverageError,
  KEPT_ANSWER_READ_MS,
  RunMutantTransport,
  isAlStopResponse,
} from "../src/run-mutant-transport";
import { describeStaleTestApp, runMutantLineCountMessage } from "../src/stale-test-app";

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
const LEASE = { epoch: 3, token: "tok-abc", serverGeneration: "gen-1", opSeq: 7 } as const;
const REQ = {
  ref: REF,
  mutantId: "M0003",
  attemptId: "a1",
  timeoutMs: 5000,
  lease: LEASE,
} as const;

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
    // R206 §2.1: every answer that ran carries the session keys (control app 1.0.0.18).
    testRunsBefore: 0,
    sessionId: 2037,
    // GH-24: every answer that ran carries this test's own reach attestation (control app 1.0.0.19).
    observedActive: true,
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

  // R139: the server ALREADY says why it returned nothing, in `codeunitResults.error` — both from
  // `RunOneMethod`'s own fail-closed exit and from `BuildRunError`, which wraps every caught
  // phase-2 terminal error in the same shape. This branch used to discard that text and report a
  // line count, which is how a stale published test app and a lock timeout became indistinguishable
  // (roadmap R139). Surfacing it is what lets a detector key on the ONE condition that has a single
  // producing code path instead of on the line count, which has several.
  test("zero test lines: the server's own error text is carried, not discarded", async () => {
    const inner = echo({
      codeunitResults: JSON.stringify({
        error: "expected exactly one method OverBudgetDetected, found 0",
      }),
    });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("expected exactly 1");
    expect(v.failureMessage).toContain("expected exactly one method OverBudgetDetected, found 0");
    // THE SEAM, pinned twice. Everything else in this file and in the classifier's own tests builds
    // its inputs by calling `runMutantLineCountMessage`, which closes helper-to-detector drift and
    // opens a worse hole: nothing would observe the TRANSPORT's actual output meeting the detector.
    // A hand-rolled message here that still contained both substrings above would leave every test
    // in the repo green while `describeStaleTestApp` stopped matching anything a live server can
    // produce, which is the exact shape of the bug R139 exists to close.
    expect(v.failureMessage).toBe(
      runMutantLineCountMessage(0, "expected exactly one method OverBudgetDetected, found 0"),
    );
    expect(describeStaleTestApp(v.failureMessage)).toBeDefined();
  });

  test("zero test lines with no server error key: the message is unchanged", async () => {
    // `{"testResults":[]}` is a distinct, unmeasured server state. It must stay exactly as
    // informative (and as unclassified) as it was before R139, never gain an invented annotation.
    const inner = echo({ codeunitResults: JSON.stringify({ testResults: [] }) });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toBe("RunMutant returned 0 test lines, expected exactly 1");
  });

  test("a non-string server error key is reported as malformed, with evidence", async () => {
    // Never `String(...)`: `{"error":{...}}` would render as "[object Object]", which is the
    // plausible-default shape this repo's conventions forbid. Never a throw either — a malformed
    // server answer is not a caller-contract violation.
    const inner = echo({
      codeunitResults: JSON.stringify({ error: { code: 42, detail: "structured" } }),
    });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("not a string");
    expect(v.failureMessage).toContain("structured");
    expect(v.failureMessage).not.toContain("[object Object]");
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
  test("POSTs LethALControl_RunMutant with camelCase body + the lease tuple", async () => {
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
      leaseEpoch: 3,
      leaseToken: "tok-abc",
      serverGeneration: "gen-1",
      opSeq: 7,
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

// Layer 5C-B2 item 1: an `in-flight-unknown` verdict is the ONLY input the orchestrator's
// lost-ack reconciliation (design §5) has to work from, and it can only ask
// `GetOperationStatus(attemptId, opSeq)` about an op it can name. Every ambiguous exit therefore
// carries the fence coordinates of the attempt that produced it — without them the orchestrator
// has no choice but to condemn the tier, which is exactly the live defect (BC answering a
// RunMutant with HTTP 200 and a zero-byte body, three times in eight gate runs).
describe("RunMutantTransport.run — ambiguous exits carry their fence coordinates (5C-B2)", () => {
  const FENCE = { attemptId: "a1", opSeq: 7 };

  test("the live defect: HTTP 200 with a ZERO-BYTE body carries attemptId + opSeq", async () => {
    const emptyBody = (async (_url: unknown, _init?: RequestInit) =>
      new Response("", { status: 200 })) as typeof fetch;
    const v = await transport(emptyBody).run(REQ);
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.fencedOp).toEqual(FENCE);
  });

  test("a non-2xx carries them", async () => {
    const five00 = (async (_url: unknown, _init?: RequestInit) =>
      new Response("boom", { status: 500 })) as typeof fetch;
    expect((await transport(five00).run(REQ)).fencedOp).toEqual(FENCE);
  });

  test("a post-dispatch connection failure carries them", async () => {
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect((await transport(fetchFn).run(REQ)).fencedOp).toEqual(FENCE);
  });

  test("our own client timeout carries them", async () => {
    const neverResolving = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const v = await transport(neverResolving).run({ ...REQ, timeoutMs: 20 });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.fencedOp).toEqual(FENCE);
  });

  test("a `value` that is not JSON carries them", async () => {
    const notJson = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: "{{{" }), { status: 200 })) as typeof fetch;
    expect((await transport(notJson).run(REQ)).fencedOp).toEqual(FENCE);
  });

  test("a terminal verdict carries NONE — the op resolved, there is nothing to reconcile", async () => {
    const v = await transport(okFetch(echo())).run(REQ);
    expect(v.outcome).toBe("pass");
    expect(v.fencedOp).toBeUndefined();
  });

  test("a pre-dispatch rejection carries NONE — no op was ever claimed", async () => {
    const badCfg: ActivationConfig = { ...CFG, password: "π" }; // btoa throws on >255 code units
    const spyFetch = (async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ value: JSON.stringify(echo()) }), {
        status: 200,
      })) as typeof fetch;
    const v = await new RunMutantTransport(badCfg, TA, AR, spyFetch).run(REQ);
    expect(v.operation).toBe("pre-dispatch-rejected");
    expect(v.fencedOp).toBeUndefined();
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

  // Layer 5C-B1: the fenced RunMutant carries an attemptId into the server's Text[64] column, so
  // it is held to the SAME bound every lease action is (lease.ts). Over-length must be refused
  // BEFORE dispatch: phase 1 stores CopyStr(AttemptId,1,64) while phase 3 compares that truncated
  // value against the full incoming one, so dispatching would leave `Op Kind = run` set and
  // quarantine the tier. The zero-call assertion is the load-bearing half — a test that only
  // asserted "it throws" would still pass if the throw happened after the request went out.
  test("attemptId over MAX_ATTEMPT_ID_LENGTH throws before any fetch is issued", async () => {
    let calls = 0;
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ value: JSON.stringify(echo()) }), { status: 200 });
    }) as typeof fetch;
    const tooLong = "a".repeat(MAX_ATTEMPT_ID_LENGTH + 1);
    await expect(transport(fetchFn).run({ ...REQ, attemptId: tooLong })).rejects.toThrow(
      /attemptId/,
    );
    expect(calls).toBe(0);
  });

  test("an attemptId exactly at the bound is dispatched normally", async () => {
    let calls = 0;
    const atBound = "a".repeat(MAX_ATTEMPT_ID_LENGTH);
    const fetchFn = (async (_url: unknown, _init?: RequestInit) => {
      calls++;
      return new Response(JSON.stringify({ value: JSON.stringify(echo({ attemptId: atBound })) }), {
        status: 200,
      });
    }) as typeof fetch;
    const v = await transport(fetchFn).run({ ...REQ, attemptId: atBound });
    expect(calls).toBe(1);
    expect(v.outcome).toBe("pass");
  });
});

describe("RunMutantTransport.run — lease-invalid mapping (design §5/§8, Layer 5C-B1)", () => {
  // Phase-1 genuine tuple mismatch: ControlState.TryBeginRun sets Reason:'lease-invalid', and
  // ControlApi.RunMutant echoes it verbatim as the `reason` key (BuildStatus only omits `reason`
  // when it's blank) — so a real lost lease carries reason:"lease-invalid", same as status.
  test("phase-1 genuine lease-invalid (reason echoes 'lease-invalid') -> outcome:error, operation:lease-lost, reason preserved", async () => {
    const inner = {
      status: "lease-invalid",
      reason: "lease-invalid",
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      codeunitId: 79100,
      method: "OverBudgetDetected",
    };
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("lease-lost");
    expect(v.leaseInvalidReason).toBe("lease-invalid");
  });

  // Phase-3 verify-and-clear refusal: ControlApi.RunMutant's phase-3 exit passes '' for Reason,
  // so BuildStatus omits the `reason` key entirely — no reason to surface.
  test("phase-3 lease-invalid (no `reason` key) -> outcome:error, operation:lease-lost, no leaseInvalidReason", async () => {
    const inner = {
      status: "lease-invalid",
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      codeunitId: 79100,
      method: "OverBudgetDetected",
    };
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("lease-lost");
    expect(v.leaseInvalidReason).toBeUndefined();
  });

  // THE BINDING REQUIREMENT: a still-active same-attempt duplicate claim (ClaimReason
  // 'op-in-flight' in TryBeginRun) means the caller's OWN attempt is still executing
  // server-side — poll, do not retry, do not treat as genuine lease loss. It must be
  // distinguishable from the two cases above via `leaseInvalidReason`, never silently folded
  // into an indistinguishable `operation:"lease-lost"`.
  test("op-in-flight duplicate claim -> operation:lease-lost AND leaseInvalidReason:'op-in-flight' (distinguishable from genuine loss)", async () => {
    const inner = {
      status: "lease-invalid",
      reason: "op-in-flight",
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      codeunitId: 79100,
      method: "OverBudgetDetected",
    };
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.operation).toBe("lease-lost");
    expect(v.leaseInvalidReason).toBe("op-in-flight");
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

describe("RunMutantTransport.run — GH-24: per-test reach attestation", () => {
  test("a ran answer without observedActive is an error, not unreached", async () => {
    const inner = echo({ observedAny: true, identityMismatch: false });
    inner.observedActive = undefined;
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toMatch(/observedActive.*1\.0\.0\.19/);
    expect(v.reachedActive).toBeUndefined();
  });

  test("observedActive reaches the verdict", async () => {
    const inner = echo({ observedAny: true, identityMismatch: false, observedActive: false });
    const v = await transport(okFetch(inner)).run(REQ);
    expect(v.reachedActive).toBe(false);
    expect(v.attestation).toEqual({ observedAny: true, identityMismatch: false });
  });
});

/**
 * R58: the fenced-coverage variant. The server half is control app 1.0.0.9's
 * `RunMutantWithCoverage`, which wraps `RunMutant` in Start/StopApplicationCoverage and attaches
 * the `Code Coverage` table. The client half must reach a DIFFERENT OData action, must tolerate a
 * refusal carrying no coverage at all, and must refuse to proceed silently when a `ran` result's
 * coverage is unreadable.
 */
describe("RunMutantTransport.runWithCoverage — R58", () => {
  /** Captures the URL as well as answering, since WHICH action is called is half of this feature. */
  function urlCapturingFetch(inner: Record<string, unknown>): {
    fetchFn: typeof fetch;
    urls: string[];
  } {
    const urls: string[] = [];
    const fetchFn = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
    }) as typeof fetch;
    return { fetchFn, urls };
  }

  const ROWS = [
    { objectType: 5, objectId: 79100, lineNo: 12, hits: 3 },
    { objectType: 1, objectId: 79300, lineNo: 0, hits: 1 },
  ];

  test("posts to LethALControl_RunMutantWithCoverage, not RunMutant", async () => {
    const { fetchFn, urls } = urlCapturingFetch(echo({ coverage: ROWS }));
    await transport(fetchFn).runWithCoverage(REQ);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/ODataV4/LethALControl_RunMutantWithCoverage?");
  });

  test("run() still posts to the unchanged LethALControl_RunMutant action", async () => {
    const { fetchFn, urls } = urlCapturingFetch(echo());
    await transport(fetchFn).run(REQ);
    expect(urls[0]).toContain("/ODataV4/LethALControl_RunMutant?");
    expect(urls[0]).not.toContain("WithCoverage");
  });

  test("a ran result yields the verdict AND the raw rows", async () => {
    const { verdict, coverageRows } = await transport(
      okFetch(echo({ coverage: ROWS })),
    ).runWithCoverage(REQ);
    expect(verdict.outcome).toBe("pass");
    expect(coverageRows).toEqual(ROWS);
  });

  test("an EMPTY coverage array is valid — the test recorded no hits", async () => {
    const { verdict, coverageRows } = await transport(
      okFetch(echo({ coverage: [] })),
    ).runWithCoverage(REQ);
    expect(verdict.outcome).toBe("pass");
    expect(coverageRows).toEqual([]);
  });

  test("a refusal carries no coverage, and that is NORMAL — no throw, no rows", async () => {
    // `RunMutantWithCoverage` returns RunMutant's inner payload untouched when it cannot re-parse
    // it, and every refusal status legitimately answers before coverage could be attached.
    const inner = {
      status: "lease-invalid",
      reason: "epoch-mismatch",
      targetAppId: TA,
      artifactId: AR,
      attemptId: "a1",
      mutantId: "M0003",
      codeunitId: 79100,
      method: "OverBudgetDetected",
    };
    const { verdict, coverageRows } = await transport(okFetch(inner)).runWithCoverage(REQ);
    expect(verdict.operation).toBe("lease-lost");
    expect(coverageRows).toBeUndefined();
  });

  test("ABSENT coverage on a ran result throws — never a silent empty green set", async () => {
    // The failure this closes: a baseline that quietly contributes no coverage is indistinguishable
    // from a baseline that genuinely covered nothing, and every mutant then reads `no-coverage`.
    await expect(transport(okFetch(echo())).runWithCoverage(REQ)).rejects.toThrow(
      /status=ran but `coverage` is absent/,
    );
  });

  test("a MALFORMED coverage row on a ran result throws, naming the row", async () => {
    const inner = echo({ coverage: [{ objectType: 5, objectId: 79100, lineNo: "12", hits: 3 }] });
    await expect(transport(okFetch(inner)).runWithCoverage(REQ)).rejects.toThrow(
      /coverage row 0 is malformed/,
    );
  });

  test("coverage that is not an array at all throws", async () => {
    const inner = echo({ coverage: { rows: [] } });
    await expect(transport(okFetch(inner)).runWithCoverage(REQ)).rejects.toThrow(
      FencedCoverageError,
    );
  });

  test("run() ignores a coverage array entirely — the unchanged path stays unchanged", async () => {
    const v = await transport(okFetch(echo({ coverage: "garbage" }))).run(REQ);
    expect(v.outcome).toBe("pass");
  });
});

/**
 * R58's object filter and the diagnostics that measure its effect. See
 * `bcdev-backend.test.ts`'s "the server-side object-id filter" describe for the measurement that
 * made this mandatory rather than an optimisation (300 s unfiltered vs 126 ms filtered).
 */
describe("RunMutantTransport.runWithCoverage — filter + stats", () => {
  function bodyCapturingFetch(inner: Record<string, unknown>): {
    fetchFn: typeof fetch;
    bodies: Array<Record<string, unknown>>;
  } {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ value: JSON.stringify(inner) }), { status: 200 });
    }) as typeof fetch;
    return { fetchFn, bodies };
  }

  test("sends coverageObjectIdFilter verbatim on the coverage action", async () => {
    const { fetchFn, bodies } = bodyCapturingFetch(echo({ coverage: [] }));
    await transport(fetchFn).runWithCoverage({ ...REQ, coverageObjectIdFilter: "79000..79199" });
    expect(bodies[0]?.coverageObjectIdFilter).toBe("79000..79199");
  });

  test("run() never sends the field — the unchanged action's OData signature has no such param", async () => {
    const { fetchFn, bodies } = bodyCapturingFetch(echo());
    await transport(fetchFn).run({ ...REQ, coverageObjectIdFilter: "79000..79199" });
    expect("coverageObjectIdFilter" in (bodies[0] ?? {})).toBe(false);
  });

  test("surfaces the server's cost + row diagnostics", async () => {
    // scannedRows vs emittedRows is what distinguishes "the filter matched a small set correctly"
    // from "the filter matched nothing" — the same empty array otherwise.
    const inner = echo({
      coverage: [{ objectType: 5, objectId: 79100, lineNo: 4, hits: 1 }],
      coverageRunMs: 812,
      coverageSerializeMs: 37,
      coverageScannedRows: 44,
      coverageEmittedRows: 41,
    });
    const { coverageStats } = await transport(okFetch(inner)).runWithCoverage(REQ);
    expect(coverageStats).toEqual({
      runMs: 812,
      serializeMs: 37,
      scannedRows: 44,
      emittedRows: 41,
    });
  });

  test("a server reporting no timing yields undefined stats, never fabricated zeros", async () => {
    const { coverageStats, coverageRows } = await transport(
      okFetch(echo({ coverage: [] })),
    ).runWithCoverage(REQ);
    expect(coverageRows).toEqual([]);
    expect(coverageStats).toBeUndefined();
  });
});

/**
 * R53. A non-terminating mutant makes RunMutant hang. Today the client aborts at its budget and
 * must classify `in-flight-unknown` — BC may still be executing — which quarantines the tier and
 * blocks every mutant behind it (125 of 138 on Document Output).
 *
 * The mechanism, MEASURED (`scripts/r53-probe/`): a second session can stop the first, and BC then
 * answers the STILL-OPEN original request with an HTTP 408 naming the AL `StopSession` call. So the
 * request is deliberately NOT aborted at the budget — that would throw the answer away and leave
 * only `StopHungRun`'s return value, which is worth nothing, because `StopSession` returns without
 * throwing for a nonexistent id, for 0, and for -1. It cannot report failure.
 */

describe("RunMutantTransport.run — R53 server-side stop", () => {
  const AL_STOP_BODY = JSON.stringify({
    error: {
      message:
        "The server stopped the session (ID: 2683) because of a stop session request.  " +
        "The session was stopped by an AL StopSession call.",
    },
  });

  /**
   * A fetch that stays open until the test answers it — AND honours the abort signal the way a
   * real fetch does.
   *
   * The abort half is the point. An earlier version of these tests used a fake that ignored
   * `init.signal`, so "abort immediately after firing the stop hook" — a mutation that defeats the
   * ENTIRE fix, since the held request is what receives BC's 408 — could not be detected. Those
   * tests passed whether or not the code held the request open, which is precisely the hazard this
   * repo keeps finding.
   */
  function heldFetch(): { fetchFn: typeof fetch; answer: (r: Response) => void } {
    let resolveWith: ((r: Response) => void) | undefined;
    const fetchFn = ((url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        // Only RunMutant is held. R-204b's status read after a stop 408 (and R236b's readback)
        // find no server here: unavailable evidence, which keeps today's answers.
        if (!String(url).includes("_RunMutant?")) {
          reject(new Error(`no ${String(url)} in this test`));
          return;
        }
        resolveWith = resolve;
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted.")),
          { once: true },
        );
      })) as typeof fetch;
    return { fetchFn, answer: (r: Response) => resolveWith?.(r) };
  }

  test("scores a stopped run as `timeout` — terminal, NOT in-flight-unknown", async () => {
    const { fetchFn, answer } = heldFetch();
    let stopCalls = 0;
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      onBudgetExceeded: async () => {
        stopCalls += 1;
        answer(new Response(AL_STOP_BODY, { status: 408 }));
        return { stopped: true };
      },
    });
    expect(stopCalls).toBe(1);
    expect(v.outcome).toBe("timeout");
    expect(v.operation).toBeUndefined();
    expect(v.failureMessage).toContain("stopped the session");
  });

  // The half the first draft never reached: a 408 that DOES say "stopped the session" but does not
  // attribute it to an AL StopSession call. BC emits session-timeout text of that shape, and it
  // proves nothing about whether OUR stop is what ended it.
  test("a 408 that says 'stopped the session' but names no AL StopSession call quarantines", async () => {
    const { fetchFn, answer } = heldFetch();
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      onBudgetExceeded: async () => {
        answer(
          new Response(
            JSON.stringify({
              error: { message: "The server stopped the session (ID: 9) due to inactivity." },
            }),
            { status: 408 },
          ),
        );
        return { stopped: true };
      },
    });
    expect(v.outcome).not.toBe("timeout");
    expect(v.operation).toBe("in-flight-unknown");
  });

  test("an unrelated 408 (a proxy timing the socket out) quarantines", async () => {
    const { fetchFn, answer } = heldFetch();
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      onBudgetExceeded: async () => {
        answer(new Response("<html>Gateway Timeout</html>", { status: 408 }));
        return { stopped: true };
      },
    });
    expect(v.outcome).not.toBe("timeout");
    expect(v.operation).toBe("in-flight-unknown");
  });

  // A 408 arriving BEFORE any stop was fired cannot have been caused by our stop. Without the
  // `stopFired` guard this scores a kill off a response we had nothing to do with.
  test("an AL-stop 408 arriving before the budget is NOT scored as a stop", async () => {
    const immediate = (async (_url: unknown, _init?: RequestInit) =>
      new Response(AL_STOP_BODY, { status: 408 })) as typeof fetch;
    const v = await transport(immediate).run({
      ...REQ,
      timeoutMs: 10_000,
      onBudgetExceeded: async () => {
        throw new Error("the budget must not have elapsed in this test");
      },
    });
    expect(v.outcome).not.toBe("timeout");
    expect(v.operation).toBe("in-flight-unknown");
  });

  // The regression this guards: if the budget still aborts once the hook is wired, BC's 408 lands
  // on a destroyed socket and the run quarantines instead of scoring. `heldFetch` honours abort,
  // so that mutation is visible here — it was not, before.
  test("the request is HELD OPEN at the budget rather than aborted", async () => {
    const { fetchFn, answer } = heldFetch();
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      stopGraceMs: 500,
      onBudgetExceeded: async () => {
        // Answer on a LATER tick, so an abort fired alongside the hook wins the race and the
        // answer arrives too late to be seen.
        await new Promise((r) => setTimeout(r, 20));
        answer(new Response(AL_STOP_BODY, { status: 408 }));
        return { stopped: true };
      },
    });
    expect(v.outcome).toBe("timeout");
    expect(v.operation).toBeUndefined();
  });

  test("with no stop hook, the budget still aborts and quarantines", async () => {
    const { fetchFn } = heldFetch();
    const v = await transport(fetchFn).run({ ...REQ, timeoutMs: 20 });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBe("in-flight-unknown");
  });

  test("names a FAILED stop in the quarantine message", async () => {
    const { fetchFn } = heldFetch();
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      stopGraceMs: 30,
      onBudgetExceeded: async () => {
        throw Object.assign(new Error(""), { code: "ECONNREFUSED", path: "/StopHungRun" });
      },
    });
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.failureMessage).toContain("stop was attempted and FAILED");
    expect(v.failureMessage).toContain("ECONNREFUSED");
  });

  test("a run that completes just after the budget is scored on its real result", async () => {
    const { fetchFn, answer } = heldFetch();
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      onBudgetExceeded: async () => {
        answer(new Response(JSON.stringify({ value: JSON.stringify(echo()) }), { status: 200 }));
        return { stopped: false, reason: "already-completed" };
      },
    });
    // The echoed result is scored, NOT a manufactured timeout — scoring `timeout` here would be a
    // false kill for a mutant that merely ran slowly.
    expect(v.outcome).toBe("pass");
    expect(v.operation).toBeUndefined();
  });
});

describe("isAlStopResponse (R53)", () => {
  const BODY =
    "The server stopped the session (ID: 2683) because of a stop session request. " +
    "The session was stopped by an AL StopSession call.";

  test("accepts only BC's AL-stop 408", () => {
    expect(isAlStopResponse(408, BODY)).toBe(true);
  });

  // The status half is unreachable through `run` (which gates on 408 first) and was therefore
  // untested until asserted directly. A 200 carrying that wording is not a stopped session.
  test("rejects the same wording on a non-408 status", () => {
    expect(isAlStopResponse(200, BODY)).toBe(false);
    expect(isAlStopResponse(504, BODY)).toBe(false);
  });

  test("rejects a 408 that names no AL StopSession call", () => {
    expect(isAlStopResponse(408, "The server stopped the session (ID: 9) due to inactivity.")).toBe(
      false,
    );
  });

  test("rejects a 408 that mentions StopSession but not a stopped session", () => {
    expect(isAlStopResponse(408, "StopSession is not permitted for this user.")).toBe(false);
  });
});

/**
 * R191. `fetch` resolves on HEADERS. Every timer used to be cleared right there, so a server that
 * stalled AFTER sending a 200 sat outside the budget, outside the R53 stop hook and outside the
 * hard cap: the body read ran until the runtime gave up (measured: 272 s, recorded as 2,800 ms,
 * then a quarantine with no stop ever attempted). One abort controller now spans both phases.
 */
describe("RunMutantTransport.run — the budget covers the BODY phase too (R191)", () => {
  /** A 200 whose body never completes; the stream honours the fetch signal like Bun's does. */
  function stalledBody(): { readonly fetchFn: typeof fetch; readonly aborted: () => boolean } {
    let sawAbort = false;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":'));
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              controller.error(new Error("The operation was aborted."));
            },
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    return { fetchFn, aborted: () => sawAbort };
  }

  test("without a stop hook, a stall after the headers hits the budget and is in-flight-unknown", async () => {
    const { fetchFn, aborted } = stalledBody();
    const started = Date.now();
    const v = await transport(fetchFn).run({ ...REQ, timeoutMs: 30 });
    expect(aborted()).toBe(true);
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.failureMessage).toContain("after headers");
    // The duration now includes the stall, rather than stopping at the headers.
    expect(v.durationMs).toBeGreaterThanOrEqual(25);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("with a stop hook, the hook FIRES during the body phase and the hard cap ends the wait", async () => {
    const { fetchFn } = stalledBody();
    let stopCalls = 0;
    const v = await transport(fetchFn).run({
      ...REQ,
      timeoutMs: 20,
      stopGraceMs: 30,
      onBudgetExceeded: async () => {
        stopCalls += 1;
        return { stopped: true };
      },
    });
    expect(stopCalls).toBe(1);
    expect(v.outcome).toBe("deadline-exceeded");
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.failureMessage).toContain("after headers");
    expect(v.failureMessage).toContain("server-side stop was attempted");
  });

  test("a body that arrives in time settles the timers and scores normally", async () => {
    // The mirror image: a slow-but-finishing body must neither abort nor leak a timer that fires
    // later. `okFetch` resolves its body immediately; a short budget still has to be cleared.
    const v = await transport(okFetch(echo())).run({ ...REQ, timeoutMs: 20 });
    expect(v.outcome).toBe("pass");
    await new Promise((r) => setTimeout(r, 40));
    expect(v.outcome).toBe("pass"); // nothing fired after the fact
  });
});

describe("RunMutantTransport: a lost reply is read back from the committed answer (R236b)", () => {
  const FENCE = { attemptId: "a1", opSeq: 7 };
  const CLR =
    "Unexpected CLR exception thrown.: System.NotSupportedException: Specified method is not supported. at Microsoft.Dynamics.Nav.Runtime.NavSession.CreateNavTestService()";
  const FAILED = echo({
    codeunitResults: JSON.stringify({
      testResults: [{ method: "OverBudgetDetected", result: 1, message: CLR }],
    }),
  });
  const wrap = (inner: Record<string, unknown>) => JSON.stringify({ value: JSON.stringify(inner) });
  /** The live shape: everything but the envelope's final `}`. */
  const TRUNCATED = wrap(FAILED).slice(0, -1);
  const KEY = { attemptId: "a1", opSeq: 7, epoch: 3, generation: "gen-1" };
  type Kept = { readonly status: number; readonly body: string } | "throw" | "hang" | "deaf";
  /** A readback that never answers ends here, so a broken bound FAILS the test instead of hanging the run. */
  const UNBOUNDED_MS = 3000;
  const found = (answer: string, key: Record<string, unknown> = KEY): Kept => ({
    status: 200,
    body: wrap({ found: true, ...key, answer }),
  });

  function routed(
    run: "truncated" | "stall" | "ok",
    kept: Kept,
    calls: string[],
    bodies: unknown[] = [],
  ): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      const action = /ODataV4\/LethALControl_(\w+)/.exec(String(url))?.[1] ?? String(url);
      calls.push(action);
      if (action === "GetOpAnswer") {
        bodies.push(JSON.parse(String(init?.body)));
        if (kept === "throw") throw new Error("ECONNRESET");
        if (kept === "hang" || kept === "deaf") {
          return new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new Error("readback not bounded")), UNBOUNDED_MS);
            // "deaf" is a fetch that ignores its abort signal; only the client's own race bounds it.
            if (kept === "hang") {
              init?.signal?.addEventListener(
                "abort",
                () => {
                  calls.push("GetOpAnswer:aborted");
                  reject(new Error("aborted"));
                },
                { once: true },
              );
            }
          });
        }
        return new Response(kept.body, { status: kept.status });
      }
      if (run === "ok") return new Response(wrap(FAILED), { status: 200 });
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(TRUNCATED));
          if (run === "truncated")
            c.error(new Error("The socket connection was closed unexpectedly."));
          else
            signal?.addEventListener(
              "abort",
              () => c.error(new Error("The operation was aborted.")),
              { once: true },
            );
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
  }
  const keptUnknown = (v: {
    operation?: unknown;
    fencedOp?: unknown;
    replyRecovered?: unknown;
  }) => {
    expect(v.operation).toBe("in-flight-unknown");
    expect(v.fencedOp).toEqual(FENCE);
    expect(v.replyRecovered).toBeUndefined();
  };

  test("1. body lost, kept answer is a completed fail: it is the verdict, no second RunMutant is sent", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const v = await transport(
      routed("truncated", found(JSON.stringify(FAILED)), calls, bodies),
    ).run(REQ);
    expect(v.outcome).toBe("fail");
    expect(v.operation).toBeUndefined();
    expect(v.fencedOp).toBeUndefined();
    expect(v.failureMessage).toContain("CreateNavTestService");
    expect(v.replyRecovered).toContain("2xx body could not be read");
    expect(calls).toEqual(["RunMutant", "GetOpAnswer"]);
    expect(bodies).toEqual([{ epoch: 3, generation: "gen-1", attemptId: "a1", opSeq: 7 }]);
  });

  test("2. body stalls until the budget: the kept completed pass is the verdict", async () => {
    const calls: string[] = [];
    const v = await transport(routed("stall", found(JSON.stringify(echo())), calls)).run({
      ...REQ,
      timeoutMs: 30,
    });
    expect(v.outcome).toBe("pass");
    expect(v.replyRecovered).toContain("timed out after headers");
    expect(calls).toEqual(["RunMutant", "GetOpAnswer"]);
  });

  test("3. no committed answer for this op: in-flight-unknown stays and says what the server holds", async () => {
    const kept: Kept = {
      status: 200,
      body: wrap({ found: false, keptAttemptId: "a0", keptOpSeq: 6 }),
    };
    const v = await transport(routed("truncated", kept, [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("2xx body could not be read");
    expect(v.failureMessage).toContain(
      "answer readback: the server holds no committed answer for a1/7 (it holds a0/6)",
    );
  });

  test("4. the readback throws: in-flight-unknown stays", async () => {
    const v = await transport(routed("truncated", "throw", [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
  });

  test("5. the readback hangs: bounded by the call's budget, then in-flight-unknown", async () => {
    const calls: string[] = [];
    const started = Date.now();
    const v = await transport(routed("truncated", "hang", calls)).run({ ...REQ, timeoutMs: 30 });
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
    expect(Date.now() - started).toBeLessThan(2000);
    // The request itself was ended, not merely abandoned.
    expect(calls).toContain("GetOpAnswer:aborted");
  });

  test("5b. a readback whose fetch ignores the abort is still bounded", async () => {
    const started = Date.now();
    const v = await transport(routed("truncated", "deaf", [])).run({ ...REQ, timeoutMs: 30 });
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
    expect(v.failureMessage).not.toContain("readback not bounded");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("5c. the readback bound is the call's budget, capped at KEPT_ANSWER_READ_MS", async () => {
    // Seam: `readKeptAnswer` is public, so the bound it is handed is observed directly.
    const seen: number[] = [];
    for (const timeoutMs of [60_000, 30]) {
      const t = transport(routed("truncated", "throw", []));
      t.readKeptAnswer = async (_lease, _attemptId, _opSeq, bound) => {
        seen.push(bound);
        return { found: false };
      };
      keptUnknown(await t.run({ ...REQ, timeoutMs }));
    }
    expect(seen).toEqual([KEPT_ANSWER_READ_MS, 30]);
    expect(KEPT_ANSWER_READ_MS).toBe(15_000);
  });

  test("6. a kept answer that is not JSON is never accepted", async () => {
    const v = await transport(routed("truncated", found("{{{"), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback not accepted");
  });

  test("7. a kept answer naming another attempt is never accepted", async () => {
    const v = await transport(
      routed("truncated", found(JSON.stringify(echo({ attemptId: "a9" }))), []),
    ).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("identity mismatch");
  });

  test("8. a kept REFUSAL for the same key (a same-key duplicate) is never accepted", async () => {
    const refusal = echo({ status: "lease-invalid", reason: "op-in-flight", codeunitResults: "" });
    const v = await transport(routed("truncated", found(JSON.stringify(refusal)), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback not accepted");
  });

  test("9. a kept lease-lost answer is never accepted", async () => {
    const lost = echo({ status: "lease-invalid", codeunitResults: "" });
    const v = await transport(routed("truncated", found(JSON.stringify(lost)), [])).run(REQ);
    keptUnknown(v);
  });

  test("10. a well-formed ran answer with a malformed RESULT (zero test lines) is never accepted", async () => {
    const empty = echo({ codeunitResults: JSON.stringify({ testResults: [] }) });
    const v = await transport(routed("truncated", found(JSON.stringify(empty)), [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback not accepted");
  });

  test("11. a kept answer under another lease (echoed epoch or generation differs) is never accepted", async () => {
    for (const key of [
      { ...KEY, epoch: 4 },
      { ...KEY, generation: "gen-2" },
      { ...KEY, opSeq: 8 },
      { ...KEY, attemptId: "a9" },
    ]) {
      const v = await transport(routed("truncated", found(JSON.stringify(FAILED), key), [])).run(
        REQ,
      );
      keptUnknown(v);
      expect(v.failureMessage).toContain("answer readback failed");
    }
  });

  test("12. a PARTIAL readback body is never accepted", async () => {
    const partial: Kept = {
      status: 200,
      body: wrap({ found: true, ...KEY, answer: JSON.stringify(FAILED) }).slice(0, -1),
    };
    const v = await transport(routed("truncated", partial, [])).run(REQ);
    keptUnknown(v);
    expect(v.failureMessage).toContain("answer readback failed");
  });

  test("13. a reply that arrives whole never reads back", async () => {
    const calls: string[] = [];
    const v = await transport(routed("ok", "throw", calls)).run(REQ);
    expect(v.outcome).toBe("fail");
    expect(v.replyRecovered).toBeUndefined();
    expect(calls).toEqual(["RunMutant"]);
  });

  test("14. runWithCoverage: the kept answer's coverage rows come back", async () => {
    const withCov = {
      ...FAILED,
      coverage: [{ objectType: 5, objectId: 79300, lineNo: 10, hits: 1 }],
      coverageRunMs: 1,
      coverageSerializeMs: 1,
      coverageScannedRows: 1,
      coverageEmittedRows: 1,
    };
    const r = await transport(
      routed("truncated", found(JSON.stringify(withCov)), []),
    ).runWithCoverage(REQ);
    expect(r.verdict.outcome).toBe("fail");
    expect(r.coverageRows).toHaveLength(1);
  });

  test("15. runWithCoverage: a malformed kept coverage array is never accepted, and leaves no rows", async () => {
    const bad = { ...FAILED, coverage: "not-an-array" };
    const r = await transport(routed("truncated", found(JSON.stringify(bad)), [])).runWithCoverage(
      REQ,
    );
    keptUnknown(r.verdict);
    expect(r.coverageRows).toBeUndefined();
  });

  test("16. a refused readback leaves the original verdict AND its coverage rows exactly as dispatch left them", async () => {
    // `status: ran` with coverage but no codeunitResults: dispatch parses the rows, then answers
    // in-flight-unknown. That is today's path, and a refused readback must not change it.
    // `undefined` drops the key from the JSON on the wire.
    const noResults = echo({
      coverage: [{ objectType: 5, objectId: 79300, lineNo: 10, hits: 1 }],
      codeunitResults: undefined,
    });
    const fetchFn = (async (url: unknown) => {
      if (String(url).includes("LethALControl_GetOpAnswer")) {
        return new Response(wrap({ found: false, keptAttemptId: "a0", keptOpSeq: 6 }), {
          status: 200,
        });
      }
      return new Response(wrap(noResults), { status: 200 });
    }) as typeof fetch;
    const r = await transport(fetchFn).runWithCoverage(REQ);
    keptUnknown(r.verdict);
    expect(r.verdict.failureMessage).toStartWith(
      "RunMutant status=ran but no codeunitResults; answer readback: the server holds no committed answer",
    );
    expect(r.coverageRows).toEqual([{ objectType: 5, objectId: 79300, lineNo: 10, hits: 1 }]);
  });
});
