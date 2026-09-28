import { describe, expect, test } from "bun:test";
import type { CallTrace } from "./fetch-trace";
import {
  classifyDispatch,
  keepOriginalBody,
  keptCheckRecord,
  keptCheckVerdict,
  readA2,
  selectOriginalTrace,
} from "./size-arm";

function trace(partial: Partial<CallTrace> = {}): CallTrace {
  return { action: "LethALControl_RunMutantWithCoverage", dispatchedAt: 0, ...partial };
}

describe("readA2", () => {
  const full = { pairsDone: 60, pairsPlanned: 60, sBreaks: 0, sRunnable: true };
  test("a complete arm with no S break clears the grouped path", () => {
    expect(readA2(full)).toBe("grouped fix not required");
  });
  test("ONE S break requires the grouped fix", () => {
    expect(readA2({ ...full, sBreaks: 1 })).toBe("grouped fix required");
  });
  test("an incomplete arm cannot clear it", () => {
    expect(readA2({ ...full, pairsDone: 59 })).toBe("grouped fix required");
  });
  test("an unrunnable S arm cannot clear it", () => {
    expect(readA2({ ...full, sRunnable: false })).toBe("grouped fix required");
  });
});

describe("keepOriginalBody", () => {
  test("keeps the RunMutantWithCoverage body and ignores the GetOpAnswer body of the same attempt", () => {
    const bodies = new Map<string, string>();
    keepOriginalBody(
      bodies,
      { action: "LethALControl_RunMutantWithCoverage", attemptId: "r236s-k-1" },
      "original",
    );
    keepOriginalBody(
      bodies,
      { action: "LethALControl_GetOpAnswer", attemptId: "r236s-k-1" },
      "readback",
    );
    expect(bodies.get("r236s-k-1")).toBe("original");
  });
});

describe("selectOriginalTrace", () => {
  test("picks the original (lost) trace, not the transport's own recovery GetOpAnswer readback", () => {
    // Review r1: this is the shape `runWithCoverage` adds after a lost body it then recovers: the
    // original action broke mid-body, and a later, CLEAN `GetOpAnswer` readback follows it. Naive
    // `calls.at(-1)` picks the clean readback and `isLostBody` reads false for a genuine lost body.
    const added: CallTrace[] = [
      trace({ action: "LethALControl_RunMutantWithCoverage", errorPhase: "body" }),
      trace({ action: "LethALControl_GetOpAnswer", headersAt: 5, bodyEndAt: 6 }),
    ];
    expect(selectOriginalTrace(added)).toBe(added[0]);
  });

  test("ambiguous (not exactly one original-action trace) resolves to undefined", () => {
    expect(selectOriginalTrace([trace({ action: "LethALControl_GetOpAnswer" })])).toBeUndefined();
    expect(
      selectOriginalTrace([
        trace({ action: "LethALControl_RunMutantWithCoverage" }),
        trace({ action: "LethALControl_RunMutantWithCoverage" }),
      ]),
    ).toBeUndefined();
  });
});

describe("classifyDispatch", () => {
  // Review r1: this is the exact shape `dispatchOne` must classify correctly. `added.at(-1)` (the old
  // `calls.at(-1)` bug) would pick the clean recovery trace and read `broke` as false, hiding a real
  // break behind a GetOpAnswer readback for the SAME attempt id.
  test("a lost body recovered by a clean GetOpAnswer readback is still a break", () => {
    const added: CallTrace[] = [
      trace({ action: "LethALControl_RunMutantWithCoverage", errorPhase: "body" }),
      trace({ action: "LethALControl_GetOpAnswer", headersAt: 5, bodyEndAt: 6 }),
    ];
    const result = classifyDispatch(added);
    expect(result.broke).toBe(true);
    expect(result.trace).toBe(added[0]);
    expect(result.traceAmbiguous).toBe(false);
  });

  test("ambiguous (not exactly one original-action trace) is conservative: treated as a break", () => {
    expect(classifyDispatch([])).toEqual({ trace: undefined, traceAmbiguous: true, broke: true });
    expect(
      classifyDispatch([
        trace({ action: "LethALControl_RunMutantWithCoverage" }),
        trace({ action: "LethALControl_RunMutantWithCoverage" }),
      ]).broke,
    ).toBe(true);
  });

  test("a clean original trace, with no recovery readback, is not a break", () => {
    const added: CallTrace[] = [trace({ action: "LethALControl_RunMutantWithCoverage" })];
    const result = classifyDispatch(added);
    expect(result.broke).toBe(false);
    expect(result.traceAmbiguous).toBe(false);
  });
});

describe("keptCheckRecord", () => {
  test("a whole call with a matching readback is not bad", () => {
    const t = trace({ headersAt: 750, bodyEndAt: 820, status: 200, bytesReceived: 6616 });
    const { record, bad, lostBody } = keptCheckRecord(1, t, {
      whole: true,
      outcome: "fail",
      clr: true,
      replyRecovered: null,
      recoveryReadback: false,
      read: { ok: true, found: true, byteEqual: true },
    });
    expect(bad).toBe(false);
    expect(lostBody).toBe(false);
    expect(record).toMatchObject({
      kind: "kept-check",
      whole: true,
      found: true,
      byteEqual: true,
      outcome: "fail",
      clr: true,
      headersMs: 750,
      bytesReceived: 6616,
      status: 200,
      bodyEndSeen: true,
      errorPhase: null,
    });
  });

  test("a whole call whose readback itself failed is bad, and is NOT a lost body", () => {
    // R236b: this is the C1b defect. readKeptAnswer threw (its 15s abort) after a whole body.
    const t = trace({ headersAt: 750, bodyEndAt: 820 });
    const { record, bad, lostBody } = keptCheckRecord(2, t, {
      whole: true,
      outcome: "fail",
      clr: true,
      replyRecovered: null,
      recoveryReadback: false,
      read: { ok: false, readError: "AbortError: The operation was aborted" },
    });
    expect(bad).toBe(true);
    expect(lostBody).toBe(false);
    expect(record).toMatchObject({
      whole: true,
      found: false,
      readError: "AbortError: The operation was aborted",
    });
  });

  test("lost body classification: headers arrived, the body broke, no bodyEndAt", () => {
    const t = trace({ headersAt: 700, errorPhase: "body", bytesReceived: 6540 });
    const { bad, lostBody } = keptCheckRecord(3, t, {
      whole: false,
      outcome: "deadline-exceeded",
      operation: "in-flight-unknown",
      replyRecovered: null,
      recoveryReadback: false,
    });
    expect(lostBody).toBe(true);
    expect(bad).toBe(false);
  });

  test("a fetch failure before headers arrived is NOT a lost body", () => {
    const t = trace({ errorPhase: "fetch" });
    const { lostBody } = keptCheckRecord(4, t, {
      whole: false,
      outcome: "deadline-exceeded",
      operation: "in-flight-unknown",
      replyRecovered: null,
      recoveryReadback: false,
    });
    expect(lostBody).toBe(false);
  });

  test("an ambiguous trace selection (the original trace could not be resolved) is recorded and bad", () => {
    const { record, bad, lostBody } = keptCheckRecord(5, undefined, {
      whole: false,
      outcome: "deadline-exceeded",
      operation: "in-flight-unknown",
      replyRecovered: null,
      recoveryReadback: true,
    });
    expect(bad).toBe(true);
    expect(lostBody).toBe(false);
    expect(record).toMatchObject({ traceAmbiguous: true, recoveryReadback: true });
  });
});

describe("keptCheckVerdict", () => {
  // Orchestrator ruling (R236b Task 9 Step 2): C1b must not pass vacuously. A run where zero calls
  // arrived whole never exercised the byte-equality check once, so it is not-measured, not a pass.
  test("zero whole calls, zero bad, is not-measured", () => {
    expect(keptCheckVerdict({ whole: 0, bad: 0 })).toBe("not-measured");
  });

  test("at least one whole call and zero bad is pass", () => {
    expect(keptCheckVerdict({ whole: 1, bad: 0 })).toBe("pass");
  });

  test("any bad call fails, even with whole calls present", () => {
    expect(keptCheckVerdict({ whole: 5, bad: 1 })).toBe("fail");
  });

  // Bad wins over not-measured: a bad call can happen with zero whole calls (e.g. an ambiguous trace on
  // a call that never arrived whole), and that is a real failure, not "nothing was measured".
  test("bad wins over not-measured: zero whole but a bad call is still fail", () => {
    expect(keptCheckVerdict({ whole: 0, bad: 1 })).toBe("fail");
  });
});
