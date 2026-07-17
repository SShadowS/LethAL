import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTests } from "../src/discovery";

describe("discoverTests", () => {
  test("finds [Test] methods in Subtype=Test codeunits, skips helpers and handlers", async () => {
    const refs = await discoverTests(join(import.meta.dir, "fixtures", "al"));
    expect(refs).toEqual([
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" },
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "DiscountCapped" },
    ]);
  });
});
