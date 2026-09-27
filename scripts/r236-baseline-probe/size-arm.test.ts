import { describe, expect, test } from "bun:test";
import type { CallTrace } from "./fetch-trace";
import { keepOriginalBody, keptCheckRecord, readA2 } from "./size-arm";

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

describe("keptCheckRecord", () => {
  test("a whole call with a matching readback is not bad", () => {
    const t = trace({ headersAt: 750, bodyEndAt: 820, status: 200, bytesReceived: 6616 });
    const { record, bad, lostBody } = keptCheckRecord(1, t, {
      whole: true,
      outcome: "fail",
      clr: true,
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
    // R236b: this is the C1b defect — readKeptAnswer threw (its 15s abort) after a whole body.
    const t = trace({ headersAt: 750, bodyEndAt: 820 });
    const { record, bad, lostBody } = keptCheckRecord(2, t, {
      whole: true,
      outcome: "fail",
      clr: true,
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
    });
    expect(lostBody).toBe(false);
  });
});
