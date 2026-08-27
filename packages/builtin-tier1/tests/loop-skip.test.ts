import { beforeAll, describe, expect, it } from "bun:test";
import { initParser } from "@lethal/engine";
import { runConformance } from "@lethal/operator-sdk";
import { loopSkip } from "../src/loop-skip";

describe("loopSkip (R179, pre-registration)", () => {
  beforeAll(async () => {
    await initParser();
  });
  it("passes its conformance suite", async () => {
    const r = await runConformance(loopSkip);
    if (!r.allPassed) console.error(JSON.stringify(r.failures, null, 2));
    expect(r.allPassed).toBe(true);
  });
});
