import { describe, expect, test } from "bun:test";
import { HALT_ALLOWED, HALT_REFUSED, HaltError, assertPermittedUnderHalt } from "./halt.ts";
import { type RunFacts, burn, canMerge, canReRecord, canRunLiveLeg, canSeal } from "./run-state.ts";

const SHA = "1111111111111111111111111111111111111111";

const HEALTHY: RunFacts = {
  halted: false,
  candidateSha: SHA,
  burnedShas: [],
  precommitmentCommitted: true,
  liveRunsForCandidate: 0,
  precommitmentPredatesFirstLiveRun: true,
  leasedContainers: ["agent-data"],
  qualified: { "agent-data": 4 },
  generations: { "agent-data": 4 },
  acceptedLegs: ["tables", "chunked"],
  requiredLegs: ["tables", "chunked"],
  testsWithoutRedCheck: [],
  artifactProblems: [],
  issueBodyChanged: false,
};

describe("HALT is an allowlist", () => {
  test("containment is permitted", () => {
    for (const a of HALT_ALLOWED) {
      expect(() => assertPermittedUnderHalt(a, true)).not.toThrow();
    }
  });

  test("restoration is refused", () => {
    for (const a of HALT_REFUSED) {
      expect(() => assertPermittedUnderHalt(a, true)).toThrow(HaltError);
    }
  });

  test("stopping a container is containment; starting one is not", () => {
    // The contradiction this list replaced: an earlier rule said no container mutation under HALT
    // and then permitted stopping one. Stopping IS a mutation. The real line is containment versus
    // restoration.
    expect(() => assertPermittedUnderHalt("container-stop", true)).not.toThrow();
    expect(() => assertPermittedUnderHalt("container-start", true)).toThrow(HaltError);
    expect(() => assertPermittedUnderHalt("container-restart", true)).toThrow(HaltError);
  });

  test("clearing a lease is refused, because early clearing is the false-verdict mechanism", () => {
    expect(() => assertPermittedUnderHalt("lease-reset", true)).toThrow(HaltError);
  });

  test("an unclassified action is refused by default, not permitted", () => {
    // A capability added to the executor without deciding its HALT status must fail closed.
    expect(() => assertPermittedUnderHalt("some-new-capability", true)).toThrow(HaltError);
    try {
      assertPermittedUnderHalt("some-new-capability", true);
    } catch (e) {
      expect((e as Error).message).toContain("not on either HALT list");
    }
  });

  test("nothing is refused when not halted", () => {
    for (const a of HALT_REFUSED) {
      expect(() => assertPermittedUnderHalt(a, false)).not.toThrow();
    }
  });

  test("the two lists do not overlap", () => {
    const allowed = new Set<string>(HALT_ALLOWED);
    for (const a of HALT_REFUSED) expect(allowed.has(a)).toBe(false);
  });
});

describe("a burned SHA may not RUN, not merely may not merge", () => {
  test("a burned candidate cannot start a live leg", () => {
    // Blocking only at merge would leave the second observation in the agent's hands, which is
    // where the prediction comes from. The run must not happen at all.
    const facts = { ...HEALTHY, burnedShas: [SHA] };
    const g = canRunLiveLeg(facts, "agent-data");
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(" ")).toContain("new SHA");
  });

  test("a burned candidate cannot merge or re-record either", () => {
    const facts = { ...HEALTHY, burnedShas: [SHA] };
    expect(canMerge(facts, true).allowed).toBe(false);
    expect(canReRecord(facts, "predicted", true).allowed).toBe(false);
  });

  test("a different SHA is unaffected by the burn", () => {
    const facts = { ...HEALTHY, burnedShas: ["2222222222222222222222222222222222222222"] };
    expect(canRunLiveLeg(facts, "agent-data").allowed).toBe(true);
  });

  test("burn is idempotent", () => {
    expect(burn(["a"], "a")).toEqual(["a"]);
    expect(burn(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("pre-commitment timing", () => {
  test("no committed pre-commitment refuses the live run", () => {
    const g = canRunLiveLeg({ ...HEALTHY, precommitmentCommitted: false }, "agent-data");
    expect(g.allowed).toBe(false);
    expect(g.reasons[0]).toContain("no committed pre-commitment");
  });

  test("a pre-commitment written after the FIRST live run refuses further runs", () => {
    // The timing that matters is against the first run of this SHA, not against this invocation.
    // Checking the weaker condition would let run 1 be the peek and run 2 the theatre.
    const g = canRunLiveLeg(
      {
        ...HEALTHY,
        liveRunsForCandidate: 1,
        precommitmentPredatesFirstLiveRun: false,
      },
      "agent-data",
    );
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(" ")).toContain("observed result");
  });

  test("a later run is fine when the pre-commitment predates the first", () => {
    expect(canRunLiveLeg({ ...HEALTHY, liveRunsForCandidate: 2 }, "agent-data").allowed).toBe(true);
  });
});

describe("leases, qualification and generations", () => {
  test("no lease refuses", () => {
    expect(canRunLiveLeg({ ...HEALTHY, leasedContainers: [] }, "agent-data").allowed).toBe(false);
  });

  test("an unqualified container refuses", () => {
    expect(canRunLiveLeg({ ...HEALTHY, qualified: {} }, "agent-data").allowed).toBe(false);
  });

  test("qualification at an older generation refuses", () => {
    // "Heartbeat stale" never means "the old writer is dead". A container reset since it was
    // qualified is not the environment that qualification measured.
    const g = canRunLiveLeg(
      { ...HEALTHY, qualified: { "agent-data": 4 }, generations: { "agent-data": 5 } },
      "agent-data",
    );
    expect(g.allowed).toBe(false);
    expect(g.reasons.join(" ")).toContain("requalify");
  });

  test("all reasons accumulate rather than short-circuiting", () => {
    const g = canRunLiveLeg(
      {
        ...HEALTHY,
        burnedShas: [SHA],
        precommitmentCommitted: false,
        leasedContainers: [],
        qualified: {},
      },
      "agent-data",
    );
    expect(g.reasons.length).toBe(4);
  });
});

describe("sealing", () => {
  test("a healthy run seals", () => {
    expect(canSeal(HEALTHY).allowed).toBe(true);
  });

  test("a required leg with no accepted receipt refuses", () => {
    const g = canSeal({ ...HEALTHY, acceptedLegs: ["tables"] });
    expect(g.allowed).toBe(false);
    expect(g.reasons[0]).toContain("chunked");
  });

  test("a stale artifact refuses, even with every leg green", () => {
    // R56: the failure where every verdict matches because BC ran the previous build.
    const g = canSeal({ ...HEALTHY, artifactProblems: ["tests: built sha:new, server sha:old"] });
    expect(g.allowed).toBe(false);
    expect(g.reasons[0]).toContain("stale artifact");
  });

  test("a changed test with no red-check refuses", () => {
    const g = canSeal({ ...HEALTHY, testsWithoutRedCheck: ["selection.test.ts > twin ordinals"] });
    expect(g.allowed).toBe(false);
    expect(g.reasons[0]).toContain("red-check");
  });

  test("an extra leg that was not required does not refuse", () => {
    expect(canSeal({ ...HEALTHY, acceptedLegs: ["tables", "chunked", "bcdev"] }).allowed).toBe(
      true,
    );
  });
});

describe("merging", () => {
  test("an unsealed run cannot merge", () => {
    expect(canMerge(HEALTHY, false).allowed).toBe(false);
  });

  test("an issue edited since claim cannot merge", () => {
    // Seven of eight open issues on this repo come from an external collaborator, so concurrent
    // editing is an operating condition rather than a hypothetical.
    const g = canMerge({ ...HEALTHY, issueBodyChanged: true }, true);
    expect(g.allowed).toBe(false);
    expect(g.reasons[0]).toContain("acceptance being merged is not the one tested");
  });
});

describe("re-recording", () => {
  test("only from outcome predicted, and only after the proof run", () => {
    expect(canReRecord(HEALTHY, "predicted", true).allowed).toBe(true);
    expect(canReRecord(HEALTHY, "predicted", false).allowed).toBe(false);
    expect(canReRecord(HEALTHY, "inconclusive", true).allowed).toBe(false);
    expect(canReRecord(HEALTHY, "match", true).allowed).toBe(false);
  });

  test("the proof-run requirement cites why a one-phase re-record is unsafe", () => {
    const g = canReRecord(HEALTHY, "predicted", false);
    expect(g.reasons.join(" ")).toContain("R29");
  });
});

describe("every guard refuses under HALT", () => {
  const halted = { ...HEALTHY, halted: true };
  test("live legs, sealing, merging and re-recording all throw", () => {
    expect(() => canRunLiveLeg(halted, "agent-data")).toThrow(HaltError);
    expect(() => canSeal(halted)).toThrow(HaltError);
    expect(() => canMerge(halted, true)).toThrow(HaltError);
    expect(() => canReRecord(halted, "predicted", true)).toThrow(HaltError);
  });
});
