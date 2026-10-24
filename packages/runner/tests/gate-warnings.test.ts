import { describe, expect, test } from "bun:test";
import { GATE_WARNINGS } from "../itest/gate-expected";
import {
  GateWarningsMismatchError,
  GateWarningsUnrecordedError,
  OBSERVE_WARNINGS_ENV,
  WarningsObservedError,
  assertGateWarnings,
  collectWarnings,
  finishGate,
  nonPassExit,
  observeRequested,
} from "../itest/gate-warnings";
import { HANG_BASELINE_WARNING_CODES } from "../itest/hang-baseline-leg";

const warn = (code: string, message: string) => ({ type: "warning", code, message }) as never;

describe("assertGateWarnings", () => {
  test("an extra observed code fails and names it", () => {
    expect(() => assertGateWarnings("g", "l", ["a", "b"], ["a"])).toThrow(
      /Extra: \["b"\]. Missing: \[\]/,
    );
    expect(() => assertGateWarnings("g", "l", ["a", "b"], ["a"])).toThrow(
      GateWarningsMismatchError,
    );
  });

  test("a missing code fails and names it", () => {
    expect(() => assertGateWarnings("g", "l", ["a"], ["a", "b"])).toThrow(
      /Extra: \[\]. Missing: \["b"\]/,
    );
  });

  test("order and duplicates do not matter; messages are ignored", () => {
    assertGateWarnings("g", "l", ["b", "a", "b"], ["a", "b"]);
    const w = collectWarnings();
    w.subscriber(warn("b", "id 1"));
    w.subscriber(warn("a", "id 2"));
    w.subscriber(warn("b", "id 3"));
    expect(w.codes()).toEqual(["a", "b"]);
    assertGateWarnings("g", "l", w.codes(), ["a", "b"]);
  });

  test("an absent expectation refuses with the observe instruction", () => {
    expect(() => assertGateWarnings("g", "l", [], undefined)).toThrow(GateWarningsUnrecordedError);
    expect(() => assertGateWarnings("g", "l", [], undefined)).toThrow(
      new RegExp(`g/l.*${OBSERVE_WARNINGS_ENV}=1`),
    );
  });

  test("an empty expectation is a real expectation, not an absent one", () => {
    assertGateWarnings("g", "l", [], []);
    expect(() => assertGateWarnings("g", "l", ["a"], [])).toThrow(GateWarningsMismatchError);
  });
});

describe("observe mode", () => {
  test("never passes: finishGate throws, writes no pass receipt, and the exit is 3", async () => {
    let passed = 0;
    const err = await finishGate(
      async () => {
        passed += 1;
      },
      { [OBSERVE_WARNINGS_ENV]: "1" },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WarningsObservedError);
    expect(passed).toBe(0);
    expect(nonPassExit(err, 1)).toBe(3);
  });

  test("outside observe mode finishGate emits the pass", async () => {
    let passed = 0;
    await finishGate(async () => {
      passed += 1;
    }, {});
    expect(passed).toBe(1);
    expect(nonPassExit(new Error("x"), 1)).toBe(1);
  });

  test("a bad value refuses; 1, unset and empty are accepted", () => {
    expect(() => observeRequested({ [OBSERVE_WARNINGS_ENV]: "yes" })).toThrow(/not valid/);
    expect(() => observeRequested({ [OBSERVE_WARNINGS_ENV]: "0" })).toThrow(/not valid/);
    expect(observeRequested({ [OBSERVE_WARNINGS_ENV]: "1" })).toBe(true);
    expect(observeRequested({})).toBe(false);
    expect(observeRequested({ [OBSERVE_WARNINGS_ENV]: "" })).toBe(false);
  });
});

describe("GATE_WARNINGS", () => {
  test("hang/baseline equals check 11's allow-list", () => {
    expect(GATE_WARNINGS["hang/baseline"]).toEqual([...HANG_BASELINE_WARNING_CODES]);
  });
});
