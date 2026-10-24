import { describe, expect, test } from "bun:test";
import {
  legOutcomeOfError,
  observeWithReceiptRefusal,
  v3ReceiptOutcome,
} from "../itest/al-runner-v3-gate";
import { GATE_WARNINGS } from "../itest/gate-expected";
import {
  GateWarningsMismatchError,
  GateWarningsUnrecordedError,
  OBSERVE_WARNINGS_ENV,
  WarningsObservedError,
  assertGateWarnings,
  checkGateWarnings,
  collectWarnings,
  finishGate,
  gateEndLine,
  nonPassExit,
  observeRequested,
  preflightObserve,
  settleThrown,
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

const OBSERVE = { [OBSERVE_WARNINGS_ENV]: "1" };

/** Run `fn` with console.log captured; returns the printed lines. */
function captured(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe("checkGateWarnings", () => {
  const collector = () => {
    const w = collectWarnings();
    w.subscriber(warn("x", "an example message"));
    return w;
  };

  test("observe mode skips the refusal for an unpinned key and prints codes and an example", () => {
    const lines = captured(() => checkGateWarnings("nogate", "leg", collector(), OBSERVE));
    expect(lines[0]).toBe('[gate-warnings] nogate/leg: ["x"]');
    expect(lines.join("\n")).toContain("x: an example message");
  });

  test("normal mode refuses a missing key", () => {
    expect(() => checkGateWarnings("nogate", "leg", collector(), {})).toThrow(
      GateWarningsUnrecordedError,
    );
  });

  test("normal mode asserts a present key, both ways", () => {
    const w = collectWarnings();
    for (const c of GATE_WARNINGS["hang/baseline"] ?? []) w.subscriber(warn(c, "m"));
    checkGateWarnings("hang", "baseline", w, {});
    w.subscriber(warn("surprise", "m"));
    expect(() => checkGateWarnings("hang", "baseline", w, {})).toThrow(/Extra: \["surprise"\]/);
  });
});

describe("a throwing run, the end line and the preflight", () => {
  test("settleThrown prints the codes and asserts nothing, even for an absent key", () => {
    const w = collectWarnings();
    w.subscriber(warn("x", "m"));
    const lines = captured(() => settleThrown("nogate", "leg", w));
    expect(lines.join("\n")).toContain("the run threw");
    expect(lines.join("\n")).toContain('nogate/leg: ["x"]');
  });

  test("the closing line says OBSERVED, never PASS, in observe mode", () => {
    expect(gateEndLine("g", "", OBSERVE)).toBe("g itest: OBSERVED (exit 3, not a pass)");
    expect(gateEndLine("g", " (x)", {})).toBe("g itest: PASS (x)");
  });

  test("preflightObserve refuses a bad value", () => {
    expect(() => preflightObserve({ [OBSERVE_WARNINGS_ENV]: "true" })).toThrow(/not valid/);
    preflightObserve({});
  });
});

describe("al-runner-v3 gate and observe mode (R736)", () => {
  const allPass = { C: "pass" } as never;

  test("observe mode never yields a pass receipt outcome", () => {
    const legs = Object.fromEntries(
      ["C", "S1", "S3", "N1", "N1E", "X", "D1", "D1c", "L1", "Y-A", "Y-B", "MO", "WR", "T"].map(
        (l) => [l, "pass"],
      ),
    ) as never;
    expect(v3ReceiptOutcome(legs, true)).toBe("gate-fail");
    expect(v3ReceiptOutcome(allPass, true)).not.toBe("pass");
  });

  test("observe with a receipt path (the update gate) is refused, by name", () => {
    expect(observeWithReceiptRefusal(true, "/x/receipt.json")).toMatch(/LETHAL_V3_GATE_RECEIPT/);
    expect(observeWithReceiptRefusal(true, undefined)).toBeUndefined();
    expect(observeWithReceiptRefusal(false, "/x/receipt.json")).toBeUndefined();
  });

  test("differing codes are a gate-fail; an unrecorded set is an infra-fail, never a verdict on the build", () => {
    expect(legOutcomeOfError(new GateWarningsMismatchError("m"))).toBe("gate-fail");
    expect(legOutcomeOfError(new GateWarningsUnrecordedError("m"))).toBe("infra-fail");
    expect(legOutcomeOfError(new Error("plain"))).toBe("infra-fail");
  });
});

describe("GATE_WARNINGS", () => {
  test("hang/baseline equals check 11's allow-list", () => {
    expect(GATE_WARNINGS["hang/baseline"]).toEqual([...HANG_BASELINE_WARNING_CODES]);
  });
});
