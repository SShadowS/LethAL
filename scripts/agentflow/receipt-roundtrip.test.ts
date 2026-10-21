import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALRUNNER_LEG_IDS, fullRunSublegs } from "../../packages/runner/itest/alrunner-legs.ts";
import { readChallenge, writeReceipt } from "../../packages/runner/itest/gate-receipt.ts";
import { ReceiptError, validateReceipt } from "./receipt.ts";

/**
 * The contract that would otherwise drift silently.
 *
 * `gate-receipt.ts` lives with the gates and writes the receipt; `receipt.ts` lives with the
 * executor and decides whether to believe it. They are deliberately in different packages, because
 * the executor must not import product code at runtime. Nothing but this test stops the two shapes
 * from parting company, and the failure if they did is the worst available: a leg that ran
 * correctly, reported correctly, and was rejected, or worse, one whose fields the validator no
 * longer looks at.
 */
describe("what a gate writes is what the executor accepts", () => {
  test("itest:alrunner's 23-leg pass round-trips (R-587)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-rt-"));
    try {
      const c = readChallenge({
        LETHAL_GATE_NONCE: "c".repeat(32),
        LETHAL_GATE_SHA: "3".repeat(40),
        LETHAL_GATE_GENERATION: "5",
        LETHAL_GATE_RECEIPT: join(dir, "r.json"),
      });
      expect(c).toBeDefined();
      if (c === undefined) throw new Error("unreachable");

      await writeReceipt(c, "alrunner", {
        status: "passed",
        sublegs: fullRunSublegs(ALRUNNER_LEG_IDS),
        artifacts: { reported: false },
      });

      const raw = JSON.parse(await readFile(c.receiptPath, "utf8"));
      const ok = validateReceipt(
        {
          leg: "alrunner",
          nonce: c.nonce,
          candidateSha: c.candidateSha,
          containerGeneration: 5,
          expectedSublegs: ALRUNNER_LEG_IDS,
        },
        raw,
      );
      expect(ok.status).toBe("passed");
      expect(ok.sublegs).toEqual([...ALRUNNER_LEG_IDS]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a skip the gate wrote is refused by the executor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-rt-"));
    try {
      const c = readChallenge({
        LETHAL_GATE_NONCE: "d".repeat(32),
        LETHAL_GATE_SHA: "4".repeat(40),
        LETHAL_GATE_GENERATION: "1",
        LETHAL_GATE_RECEIPT: join(dir, "r.json"),
      });
      if (c === undefined) throw new Error("unreachable");
      await writeReceipt(c, "tables", {
        status: "skipped",
        sublegs: [],
        artifacts: { reported: false },
        reason: "LETHAL_ITEST_TABLES unset",
      });
      const raw = JSON.parse(await readFile(c.receiptPath, "utf8"));
      expect(() =>
        validateReceipt(
          {
            leg: "tables",
            nonce: c.nonce,
            candidateSha: c.candidateSha,
            containerGeneration: 1,
            expectedSublegs: 1,
          },
          raw,
        ),
      ).toThrow(ReceiptError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
