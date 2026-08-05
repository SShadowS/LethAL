import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BasisResolutionDeps, assertBasisResolves } from "../src/interpretation";
import { CAVEAT_INTERPRETATIONS } from "../src/report";
import { ATTRIBUTION_INTERPRETATIONS } from "../src/selection";

/**
 * The universe of pointers this repo's own interpretations may cite — built from the REAL
 * `ROADMAP.md`, not a fixture set, so this test fails the moment a shipped `basis` cites a
 * roadmap id that has since been renumbered or removed. `assertBasisResolves` deliberately has no
 * filesystem access of its own (see its doc comment); this is the caller that gives it one.
 *
 * `files` stays empty: no shipped interpretation currently cites a file basis (every one below
 * points at a roadmap id). Extend this set the day one does.
 */
function realDeps(): BasisResolutionDeps {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const roadmap = readFileSync(join(repoRoot, "ROADMAP.md"), "utf8");
  const roadmapIds = new Set<string>();
  for (const match of roadmap.matchAll(/\*\*(R\d+)\*\*/g)) {
    const [, id] = match;
    if (id !== undefined) roadmapIds.add(id);
  }
  return { roadmapIds, files: new Set() };
}

test("adding an attribution variant fails to COMPILE until its interpretation exists", () => {
  // The Record<> type is the real assertion — this test documents it and pins the count.
  expect(Object.keys(ATTRIBUTION_INTERPRETATIONS).sort()).toEqual(["all-green", "exact", "object"]);
});

test("every caveat has an interpretation", () => {
  expect(Object.keys(CAVEAT_INTERPRETATIONS).length).toBe(11);
});

test("every shipped interpretation's basis resolves", () => {
  const deps = realDeps(); // read ROADMAP.md once, not once per interpretation
  for (const i of [
    ...Object.values(ATTRIBUTION_INTERPRETATIONS),
    ...Object.values(CAVEAT_INTERPRETATIONS),
  ]) {
    expect(() => assertBasisResolves(i.basis, deps)).not.toThrow();
  }
});

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
