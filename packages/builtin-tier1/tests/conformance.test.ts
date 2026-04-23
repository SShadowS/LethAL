import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "@lethal/engine";
import { runConformance } from "@lethal/operator-sdk";
import { tier1Operators } from "../src";

describe("tier 1 conformance", () => {
  beforeAll(async () => {
    await initParser();
  });

  for (const op of tier1Operators) {
    it(`${op.name} passes its conformance suite`, async () => {
      const result = await runConformance(op);
      if (!result.allPassed) {
        console.error(JSON.stringify(result.failures, null, 2));
      }
      expect(result.allPassed).toBe(true);
    });
  }
});
