import { describe, expect, test } from "bun:test";
import {
  type MutantDiff,
  type PrecommitEntry,
  PrecommitmentShapeError,
  decideGateOutcome,
} from "./gate-outcome.ts";

const K1 = "abc123|Sandbox Logic|IsOverBudget|negate-conditional|1";
const K2 = "def456|Sandbox Logic|Total|shift-integer|1";
const K3 = "ghi789|Sandbox Logic|Total|shift-integer|1|2";

function changed(key: string, from: string, to: string): MutantDiff {
  return {
    key,
    kind: "changed",
    fields: ["verdict"],
    baselineVerdict: from,
    observedVerdict: to,
  };
}
function added(key: string, verdict: string): MutantDiff {
  return { key, kind: "added", fields: [], observedVerdict: verdict };
}
function removed(key: string, verdict: string): MutantDiff {
  return { key, kind: "removed", fields: [], baselineVerdict: verdict };
}
function killerSwap(key: string): MutantDiff {
  return {
    key,
    kind: "changed",
    fields: ["killingTest"],
    baselineVerdict: "killed",
    observedVerdict: "killed",
  };
}

describe("outcome 1: nothing moved", () => {
  test("an empty candidate diff is a match, with or without a control", () => {
    expect(decideGateOutcome({ candidate: [], precommitment: [] })).toEqual({ outcome: "match" });
    expect(decideGateOutcome({ candidate: [], control: [], precommitment: [] })).toEqual({
      outcome: "match",
    });
  });

  test("a match does not depend on the pre-commitment being empty", () => {
    // A pre-commitment predicting a movement that did not happen is NOT a pass. It is caught as
    // `unobserved` once a control run exists, not silently ignored here.
    const decision = decideGateOutcome({
      candidate: [],
      precommitment: [{ op: "change", key: K1, from: "survived", to: "killed" }],
    });
    expect(decision).toEqual({ outcome: "match" });
  });
});

describe("the control run is required before any verdict on a disagreement", () => {
  test("a disagreement with no control asks for the control, it does not guess", () => {
    expect(
      decideGateOutcome({ candidate: [changed(K1, "killed", "survived")], precommitment: [] }),
    ).toEqual({ outcome: "control-required" });
  });

  test("a disagreement with no control asks for the control EVEN IF it was predicted", () => {
    // The load-bearing ordering. If reconciliation ran first, a prediction that happened to match a
    // drifting environment would re-record that drift into the frozen baseline as a property of the
    // code. The control is what distinguishes "the code did this" from "the machine did this", and
    // a correct prediction is not a substitute for it.
    const decision = decideGateOutcome({
      candidate: [changed(K1, "survived", "killed")],
      precommitment: [{ op: "change", key: K1, from: "survived", to: "killed" }],
    });
    expect(decision).toEqual({ outcome: "control-required" });
  });
});

describe("outcome 2: predicted movement on a stable base", () => {
  test("an exactly reconciled change is legitimate and re-records", () => {
    const decision = decideGateOutcome({
      candidate: [changed(K1, "survived", "killed")],
      control: [],
      precommitment: [{ op: "change", key: K1, from: "survived", to: "killed" }],
    });
    expect(decision).toEqual({ outcome: "predicted", reRecord: true });
  });

  test("add and remove reconcile on their verdicts, not merely on their keys", () => {
    const decision = decideGateOutcome({
      candidate: [added(K2, "killed"), removed(K1, "survived")],
      control: [],
      precommitment: [
        { op: "add", key: K2, expect: "killed" },
        { op: "remove", key: K1, was: "survived" },
      ],
    });
    expect(decision).toEqual({ outcome: "predicted", reRecord: true });
  });

  test("an add predicted with the wrong verdict is not reconciled", () => {
    const decision = decideGateOutcome({
      candidate: [added(K2, "survived")],
      control: [],
      precommitment: [{ op: "add", key: K2, expect: "killed" }],
    });
    expect(decision.outcome).toBe("candidate-caused-blocked");
  });
});

describe("outcome 3 burns the candidate SHA", () => {
  test("an unpredicted candidate-caused movement blocks, and may only be retried on a new SHA", () => {
    const decision = decideGateOutcome({
      candidate: [changed(K1, "killed", "survived")],
      control: [],
      precommitment: [],
    });
    expect(decision).toEqual({
      outcome: "candidate-caused-blocked",
      retry: "new-sha-only",
      unexplained: [K1],
      unobserved: [],
    });
  });

  test("THE LAUNDERING SEQUENCE: a generation written after the observation does not rescue the SHA", () => {
    // This is the hole both reviewers of the design found, expressed as a test. Generation 1 does
    // not predict the movement; the run observes `killed -> survived`; generation 2 is written
    // afterwards predicting exactly that.
    //
    // The point of the test is NOT that generation 2 fails to reconcile. It reconciles perfectly:
    // it was copied from the result. The point is that reconciling is not enough, because the
    // decision for the FIRST run is terminal for this SHA, and the caller may not run generation 2
    // against it at all. `retry: "new-sha-only"` is the whole anti-laundering property, and a test
    // that only asserted `outcome` would pass even if that field said `same-sha`.
    const observed = [changed(K1, "killed", "survived")];

    const generation1 = decideGateOutcome({ candidate: observed, control: [], precommitment: [] });
    expect(generation1.outcome).toBe("candidate-caused-blocked");
    if (generation1.outcome !== "candidate-caused-blocked") throw new Error("unreachable");
    expect(generation1.retry).toBe("new-sha-only");

    const generation2: PrecommitEntry[] = [
      { op: "change", key: K1, from: "killed", to: "survived" },
    ];
    const laundered = decideGateOutcome({
      candidate: observed,
      control: [],
      precommitment: generation2,
    });
    // It does reconcile. That is exactly why the SHA-burning rule, and not the reconciliation, is
    // what closes the hole.
    expect(laundered).toEqual({ outcome: "predicted", reRecord: true });
  });

  test("predicted-but-not-observed blocks as loudly as observed-but-not-predicted", () => {
    // A causal story that is wrong about what will happen is not evidence about what did.
    const decision = decideGateOutcome({
      candidate: [changed(K1, "survived", "killed")],
      control: [],
      precommitment: [
        { op: "change", key: K1, from: "survived", to: "killed" },
        { op: "change", key: K2, from: "killed", to: "survived" },
      ],
    });
    expect(decision).toEqual({
      outcome: "candidate-caused-blocked",
      retry: "new-sha-only",
      unexplained: [],
      unobserved: [`change ${K2}`],
    });
  });
});

describe("rename may carry identity churn but never a verdict change", () => {
  test("a rename with a stable verdict reconciles", () => {
    const decision = decideGateOutcome({
      candidate: [removed(K2, "killed"), added(K3, "killed")],
      control: [],
      precommitment: [
        { op: "rename", from: K2, to: K3, because: "twin inserted above; source-order ordinal" },
      ],
    });
    expect(decision).toEqual({ outcome: "predicted", reRecord: true });
  });

  test("a verdict flip hidden inside a rename is refused", () => {
    // The channel: `selection.ts` takes the ordinal from SOURCE order, so inserting a
    // byte-identical twin renames every later twin. If a rename were allowed to carry a verdict
    // change, a real regression would look like ordinary churn.
    const decision = decideGateOutcome({
      candidate: [removed(K2, "killed"), added(K3, "survived")],
      control: [],
      precommitment: [
        { op: "rename", from: K2, to: K3, because: "twin inserted above; source-order ordinal" },
      ],
    });
    expect(decision.outcome).toBe("candidate-caused-blocked");
    if (decision.outcome !== "candidate-caused-blocked") throw new Error("unreachable");
    expect(decision.unexplained).toEqual([K2, K3]);
    expect(decision.unobserved[0]).toContain("may not carry a verdict change");
  });

  test("a rename whose sides are not a removal and an addition is refused", () => {
    const decision = decideGateOutcome({
      candidate: [changed(K2, "killed", "survived")],
      control: [],
      precommitment: [{ op: "rename", from: K2, to: K3, because: "churn" }],
    });
    expect(decision.outcome).toBe("candidate-caused-blocked");
  });
});

describe("environment drift is inconclusive, never a code block", () => {
  test("a base that also disagrees voids the measurement and permits a same-SHA retry", () => {
    const decision = decideGateOutcome({
      candidate: [changed(K1, "killed", "survived")],
      control: [changed(K2, "killed", "survived")],
      precommitment: [],
    });
    expect(decision).toEqual({
      outcome: "inconclusive",
      reason: "environment-drift",
      retry: "same-sha",
      detail: [K2],
    });
  });

  test("drift wins over a would-be block, so a drifting run never burns a SHA", () => {
    // Direction matters: the expensive mistake is burning a candidate for the machine's fault.
    const decision = decideGateOutcome({
      candidate: [changed(K1, "killed", "survived")],
      control: [changed(K1, "killed", "survived")],
      precommitment: [],
    });
    expect(decision.outcome).toBe("inconclusive");
  });

  test("drift also wins over a would-be pass, so drift is never re-recorded as a measurement", () => {
    const decision = decideGateOutcome({
      candidate: [changed(K1, "survived", "killed")],
      control: [changed(K2, "killed", "survived")],
      precommitment: [{ op: "change", key: K1, from: "survived", to: "killed" }],
    });
    expect(decision.outcome).toBe("inconclusive");
  });

  test("killing-test noise on the BASE does not by itself void a candidate run", () => {
    const decision = decideGateOutcome({
      candidate: [changed(K1, "survived", "killed")],
      control: [killerSwap(K2)],
      precommitment: [{ op: "change", key: K1, from: "survived", to: "killed" }],
    });
    expect(decision).toEqual({ outcome: "predicted", reRecord: true });
  });
});

describe("killingTest order noise", () => {
  test("a killingTest-only difference is inconclusive, not a pass and not a block", () => {
    // R197: covering tests run killer-first, so the killer depends on the order earlier mutants
    // were scored in. Calling it a match would let a genuine attribution change ride in on a rule
    // written for scheduling noise.
    const decision = decideGateOutcome({
      candidate: [killerSwap(K1)],
      precommitment: [],
    });
    expect(decision).toEqual({
      outcome: "inconclusive",
      reason: "killing-test-order",
      retry: "same-sha",
      detail: [K1],
    });
  });

  test("noise alongside a real movement does not suppress the real movement", () => {
    const decision = decideGateOutcome({
      candidate: [killerSwap(K2), changed(K1, "killed", "survived")],
      control: [],
      precommitment: [],
    });
    expect(decision.outcome).toBe("candidate-caused-blocked");
    if (decision.outcome !== "candidate-caused-blocked") throw new Error("unreachable");
    // The noise is not reported as unexplained: it was never a verdict claim.
    expect(decision.unexplained).toEqual([K1]);
  });

  test("a difference in verdict AND killingTest is not noise", () => {
    const decision = decideGateOutcome({
      candidate: [
        {
          key: K1,
          kind: "changed",
          fields: ["verdict", "killingTest"],
          baselineVerdict: "killed",
          observedVerdict: "survived",
        },
      ],
      precommitment: [],
    });
    expect(decision).toEqual({ outcome: "control-required" });
  });
});

describe("a malformed pre-commitment throws rather than resolving toward a pass", () => {
  test("two entries claiming one key are ambiguous and refused", () => {
    expect(() =>
      decideGateOutcome({
        candidate: [changed(K1, "killed", "survived")],
        control: [],
        precommitment: [
          { op: "change", key: K1, from: "killed", to: "survived" },
          { op: "remove", key: K1, was: "killed" },
        ],
      }),
    ).toThrow(PrecommitmentShapeError);
  });

  test("a rename claiming a key another entry claims is refused", () => {
    expect(() =>
      decideGateOutcome({
        candidate: [],
        precommitment: [
          { op: "rename", from: K2, to: K3, because: "churn" },
          { op: "add", key: K3, expect: "killed" },
        ],
      }),
    ).toThrow(PrecommitmentShapeError);
  });

  test("a rename without evidence is refused", () => {
    expect(() =>
      decideGateOutcome({
        candidate: [],
        precommitment: [{ op: "rename", from: K2, to: K3, because: "   " }],
      }),
    ).toThrow(PrecommitmentShapeError);
  });

  test("a rename with identical sides is refused", () => {
    expect(() =>
      decideGateOutcome({
        candidate: [],
        precommitment: [{ op: "rename", from: K2, to: K2, because: "churn" }],
      }),
    ).toThrow(PrecommitmentShapeError);
  });
});
