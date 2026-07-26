import { describe, expect, it } from "bun:test";
import { tier2Operators } from "../src/index";

describe("tier2Operators", () => {
  it("is a registry the pipeline can consume, even while empty", () => {
    expect(Array.isArray(tier2Operators)).toBe(true);
  });

  it("every operator declares a lethal.-prefixed name and a semver version", () => {
    for (const op of tier2Operators) {
      expect(op.name.startsWith("lethal.")).toBe(true);
      expect(op.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
