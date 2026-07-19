import { describe, expect, test } from "bun:test";
import { bisectFailingMutant } from "../src/bisect";

describe("bisectFailingMutant", () => {
  test("finds the single offending mutant", async () => {
    const bad = "M0007";
    const found = await bisectFailingMutant(
      ["M0001", "M0002", bad, "M0009"],
      async (subset) => !subset.includes(bad),
    );
    expect(found).toBe(bad);
  });

  test("returns null when everything compiles", async () => {
    expect(await bisectFailingMutant(["M0001", "M0002"], async () => true)).toBeNull();
  });

  test("uses O(log n) compiles, not O(n)", async () => {
    let calls = 0;
    const mutants = Array.from({ length: 64 }, (_, i) => `M${i}`);
    await bisectFailingMutant(mutants, async (subset) => {
      calls++;
      return !subset.includes("M63");
    });
    expect(calls).toBeLessThan(20);
  });
});
