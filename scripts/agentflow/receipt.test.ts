import { describe, expect, test } from "bun:test";
import {
  type ReceiptChallenge,
  ReceiptError,
  mintNonce,
  validateReceipt,
  verifyArtifactFreshness,
} from "./receipt.ts";

const CHALLENGE: ReceiptChallenge = {
  leg: "tables",
  nonce: "a".repeat(32),
  candidateSha: "1234567890abcdef1234567890abcdef12345678",
  containerGeneration: 7,
  expectedSublegs: 1,
};

function receipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leg: CHALLENGE.leg,
    nonce: CHALLENGE.nonce,
    candidateSha: CHALLENGE.candidateSha,
    containerGeneration: CHALLENGE.containerGeneration,
    status: "passed",
    sublegs: ["tables"],
    observedArtifacts: { "sandbox-data": "sha256:aaaa" },
    ...over,
  };
}

describe("a well-formed receipt", () => {
  test("validates and returns the parsed receipt", () => {
    const r = validateReceipt(CHALLENGE, receipt());
    expect(r.leg).toBe("tables");
    expect(r.status).toBe("passed");
    expect(r.observedArtifacts["sandbox-data"]).toBe("sha256:aaaa");
  });

  test("nonces are fresh and 32 hex characters", () => {
    const a = mintNonce();
    const b = mintNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("a skip is an executor error, never a pass", () => {
  test("status skipped throws and says why", () => {
    // The whole reason receipts exist. Every env-gated itest exits 0 on its skip path, so a caller
    // reading the exit code cannot tell a gate that passed from one that never contacted BC.
    expect(() => validateReceipt(CHALLENGE, receipt({ status: "skipped" }))).toThrow(ReceiptError);
    try {
      validateReceipt(CHALLENGE, receipt({ status: "skipped" }));
    } catch (e) {
      expect((e as Error).message).toContain("R223");
    }
  });

  test("a missing receipt object throws rather than defaulting", () => {
    expect(() => validateReceipt(CHALLENGE, undefined)).toThrow(ReceiptError);
    expect(() => validateReceipt(CHALLENGE, null)).toThrow(ReceiptError);
    expect(() => validateReceipt(CHALLENGE, [])).toThrow(ReceiptError);
  });

  test("status failed throws and carries the reason", () => {
    try {
      validateReceipt(CHALLENGE, receipt({ status: "failed", reason: "publish refused" }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("publish refused");
    }
  });
});

describe("replay and misdirection", () => {
  test("a receipt echoing a stale nonce is refused", () => {
    // Same OS user, so a file on disk is not evidence of when it was written. A green receipt from
    // the previous run of this leg is the most convincing wrong evidence available.
    expect(() => validateReceipt(CHALLENGE, receipt({ nonce: "b".repeat(32) }))).toThrow(
      ReceiptError,
    );
  });

  test("a receipt for a different leg is refused", () => {
    expect(() => validateReceipt(CHALLENGE, receipt({ leg: "bcdev" }))).toThrow(ReceiptError);
  });

  test("a receipt naming a different candidate SHA is refused", () => {
    expect(() => validateReceipt(CHALLENGE, receipt({ candidateSha: "f".repeat(40) }))).toThrow(
      ReceiptError,
    );
  });

  test("a receipt produced under a different container generation is refused", () => {
    // The container was reset mid-run, so whatever it measured was measured somewhere else.
    expect(() => validateReceipt(CHALLENGE, receipt({ containerGeneration: 6 }))).toThrow(
      ReceiptError,
    );
  });

  test("the nonce is checked before the content, so a stale green receipt cannot pass on merit", () => {
    const stale = receipt({ nonce: "c".repeat(32), candidateSha: "f".repeat(40) });
    try {
      validateReceipt(CHALLENGE, stale);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("nonce");
    }
  });
});

describe("partial runs are not passes", () => {
  test("a four-subleg gate reporting one subleg is refused", () => {
    // itest:alrunner has four legs: one-shot, server, server plus resource, platform-apps pin. A
    // receipt for one of them is a partial run presented as a complete one.
    const four: ReceiptChallenge = { ...CHALLENGE, leg: "alrunner", expectedSublegs: 4 };
    expect(() =>
      validateReceipt(four, receipt({ leg: "alrunner", sublegs: ["one-shot"] })),
    ).toThrow(ReceiptError);
  });

  test("padding the subleg count with a duplicate is refused", () => {
    const two: ReceiptChallenge = { ...CHALLENGE, expectedSublegs: 2 };
    expect(() => validateReceipt(two, receipt({ sublegs: ["tables", "tables"] }))).toThrow(
      ReceiptError,
    );
  });

  test("the exact expected count validates", () => {
    const four: ReceiptChallenge = { ...CHALLENGE, leg: "alrunner", expectedSublegs: 4 };
    const r = validateReceipt(
      four,
      receipt({ leg: "alrunner", sublegs: ["one-shot", "server", "resource", "platform-pin"] }),
    );
    expect(r.sublegs).toHaveLength(4);
  });
});

describe("artifact freshness compares expected against observed", () => {
  test("equal identities pass", () => {
    expect(
      verifyArtifactFreshness(
        { target: "sha:1", tests: "sha:2" },
        { target: "sha:1", tests: "sha:2" },
      ),
    ).toEqual([]);
  });

  test("R56: a test app never rebuilt is caught by the comparison, not by the verdicts", () => {
    // The failure where NOTHING moves: the fixture changed, the test app was not republished, BC
    // ran the previous build, every frozen verdict matched. No prediction logic fires here.
    const problems = verifyArtifactFreshness(
      { target: "sha:new", tests: "sha:new-tests" },
      { target: "sha:new", tests: "sha:OLD-tests" },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale build");
    expect(problems[0]).toContain("tests");
  });

  test("an app on the server that candidate source does not build is caught", () => {
    const problems = verifyArtifactFreshness({}, { leftover: "sha:x" });
    expect(problems[0]).toContain("published but not built from candidate source");
  });

  test("an app built but never observed is caught", () => {
    const problems = verifyArtifactFreshness({ target: "sha:1" }, {});
    expect(problems[0]).toContain("not observed on the server");
  });

  test("two identical hashes on both sides do not prove freshness on their own", () => {
    // Documents the reasoning rather than the code: this call passes, and it SHOULD, because the
    // expected side is derived from candidate source. The check is only as good as that
    // derivation, which is why compile:fixtures must retain and hash what it builds instead of
    // deleting it.
    expect(verifyArtifactFreshness({ a: "same" }, { a: "same" })).toEqual([]);
  });
});
