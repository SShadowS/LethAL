import { describe, expect, test } from "bun:test";
import { assertBasisResolves } from "../src/interpretation";

describe("every basis resolves — the roadmap-auditor discipline, applied to prose", () => {
  test("a roadmap id that exists is accepted", () => {
    expect(() =>
      assertBasisResolves("R29", { roadmapIds: new Set(["R29"]), files: new Set() }),
    ).not.toThrow();
  });

  test("a roadmap id that does NOT exist throws, naming it", () => {
    expect(() =>
      assertBasisResolves("R999", { roadmapIds: new Set(["R29"]), files: new Set() }),
    ).toThrow(/R999/);
  });

  test("a measurement file that does not exist throws", () => {
    expect(() =>
      assertBasisResolves("docs/measurements/README.md#gone", {
        roadmapIds: new Set(),
        files: new Set(),
      }),
    ).toThrow(/docs\/measurements/);
  });

  test("an empty basis is refused — 'never a bare claim'", () => {
    expect(() => assertBasisResolves("", { roadmapIds: new Set(), files: new Set() })).toThrow(
      /bare|empty/i,
    );
  });
});
