import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "@lethal/engine";
import { runConformance } from "@lethal/operator-sdk";
import { loopTruncate } from "../src/loop-truncate";

describe("loopTruncate (R164, pre-registration)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("passes its conformance suite", async () => {
    const result = await runConformance(loopTruncate);
    if (!result.allPassed) console.error(JSON.stringify(result.failures, null, 2));
    expect(result.allPassed).toBe(true);
  });
});
