// PR-88: the v3 gate's observe switch for serve pins (pure half).
import { describe, expect, test } from "bun:test";
import {
  judgeServePins,
  observePinsEnd,
  observePinsRequested,
  observePinsWithReceiptRefusal,
  v3ReceiptOutcome,
} from "../itest/al-runner-v3-gate";

const ENV = "LETHAL_ITEST_V3_OBSERVE_PINS";

describe("PR-88: the observe-pins switch never yields a pass", () => {
  test("only unset, empty or 1 is valid", () => {
    expect(observePinsRequested({})).toBe(false);
    expect(observePinsRequested({ [ENV]: "" })).toBe(false);
    expect(observePinsRequested({ [ENV]: "1" })).toBe(true);
    for (const bad of ["0", "true", "yes", " 1"])
      expect(() => observePinsRequested({ [ENV]: bad })).toThrow(/is not valid/);
  });

  test("it is refused together with a receipt, and not without one", () => {
    expect(
      observePinsWithReceiptRefusal({ [ENV]: "1", LETHAL_V3_GATE_RECEIPT: "/r.json" }),
    ).toMatch(/cannot be combined/);
    expect(observePinsWithReceiptRefusal({ [ENV]: "1" })).toBeUndefined();
    expect(observePinsWithReceiptRefusal({ LETHAL_V3_GATE_RECEIPT: "/r.json" })).toBeUndefined();
  });

  test("the run ends non-pass: an OBSERVED line, never PASS; off, nothing", () => {
    const end = observePinsEnd({ [ENV]: "1" });
    expect(end?.line).toBe("al-runner-v3 itest: OBSERVED (exit 3, not a pass)");
    expect(end?.line).not.toContain("PASS");
    expect(end?.message).toMatch(/never a pass/);
    expect(observePinsEnd({})).toBeUndefined();
  });

  test("the receipt outcome of an observing run is gate-fail even when every leg passed", () => {
    expect(v3ReceiptOutcome({ A: "pass" }, true)).toBe("gate-fail");
    expect(v3ReceiptOutcome({ A: "pass" }, false)).not.toBe("gate-fail");
  });
});

const say = (k: string, g: unknown, v: number) => `${k} ${g}, pinned ${v}`;

describe("PR-88: judgeServePins", () => {
  const pins = { boundChecks: 10, entriesSent: 100 };

  test("enforced: a pin difference is a failure, an equal pin is not", () => {
    const j = judgeServePins("N1S", { boundChecks: 10, entriesSent: 120 }, pins, false, say);
    expect(j.failures).toEqual(["entriesSent 120, pinned 100"]);
    expect(j.lines).toEqual([]);
  });

  test("observe: every pin prints actual beside pinned, a moved one is marked, nothing fails", () => {
    const j = judgeServePins("N1S", { boundChecks: 10, entriesSent: 120 }, pins, true, say);
    expect(j.failures).toEqual([]);
    expect(j.lines).toEqual([
      "  N1S: pin boundChecks: actual 10, pinned 10",
      "  N1S: pin entriesSent: actual 120, pinned 100  MOVED",
    ]);
  });
});
