import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMISSIBLE_INTERPRETATIONS } from "../src/explain";
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
  expect(Object.keys(CAVEAT_INTERPRETATIONS).length).toBe(16);
});

test("every shipped interpretation's basis resolves", () => {
  const deps = realDeps(); // read ROADMAP.md once, not once per interpretation
  // `ADMISSIBLE_INTERPRETATIONS` (explain.ts) is the closed set the projection may emit, so it is
  // also the complete list of interpretations this repo ships — iterating it rather than naming
  // the registries here means a NEW registry cannot be added to the projection while staying
  // outside this check.
  expect(ADMISSIBLE_INTERPRETATIONS.length).toBeGreaterThan(
    Object.keys(ATTRIBUTION_INTERPRETATIONS).length + Object.keys(CAVEAT_INTERPRETATIONS).length,
  );
  for (const i of ADMISSIBLE_INTERPRETATIONS) {
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

/**
 * R115 gap (2). Every registry `Interpretation` must carry ONLY the three keys the type declares —
 * checked at RUNTIME, over every entry, whether or not any committed report emits it.
 *
 * MEASURED before this existed, by doing it: adding
 * `advice: "these are the weak spots in this suite and deserve attention first"` to
 * `CAVEAT_INTERPRETATIONS["runner-disagreement"]` left `bun test` at **1599 pass / 0 fail**. Only
 * `tsc` objected (TS2353). That is a smuggling route rather than a maintenance nicety: `explain`'s
 * whole admissibility rule is that it emits registry constants BY REFERENCE, so prose added to a
 * registry entry ships straight into the output — and this project's build order runs `bun test` as
 * a step SEPARATE from `bun run typecheck`, so a session or CI job running only tests lands it.
 *
 * `runner-disagreement` is what made it invisible: no committed report emits that caveat, so every
 * DATA-derived check (the leaf-path pin, string provenance, the banned-phrase regex) is blind to it.
 * These tests are deliberately not data-derived — they walk `ADMISSIBLE_INTERPRETATIONS`, built from
 * `Object.values` over every registry, so an entry no report has ever produced is checked exactly
 * like one that ships daily.
 */
describe("R115: an interpretation carries only its declared keys, at runtime", () => {
  const ALLOWED: readonly string[] = ["meaning", "entailedNegative", "basis"];

  test("no registry interpretation carries a key beyond meaning/entailedNegative/basis", () => {
    const offenders: string[] = [];
    for (const i of ADMISSIBLE_INTERPRETATIONS) {
      for (const key of Object.keys(i)) {
        if (!ALLOWED.includes(key)) {
          offenders.push(`"${key}" on basis ${i.basis}: ${i.meaning.slice(0, 60)}`);
        }
      }
    }
    // Named, never counted: the message has to say WHICH entry grew a field, because the offending
    // one may be an entry no report ever emits.
    expect(offenders).toEqual([]);
  });

  test("every registry interpretation actually has the two required keys", () => {
    // The other direction. An entry missing `meaning` or `basis` satisfies the check above
    // trivially, and `basis` is what `assertBasisResolves` keys on — an absent one is a bare claim.
    for (const i of ADMISSIBLE_INTERPRETATIONS) {
      expect(typeof i.meaning, `meaning on ${i.basis}`).toBe("string");
      expect(typeof i.basis, `basis on ${i.meaning.slice(0, 40)}`).toBe("string");
      expect(i.meaning.length, `meaning on ${i.basis} is empty`).toBeGreaterThan(0);
    }
  });

  test("the registries are actually reachable through ADMISSIBLE_INTERPRETATIONS", () => {
    // Guards the guard. If `ADMISSIBLE_INTERPRETATIONS` ever stopped spreading a registry, the two
    // tests above would pass over a smaller set and report nothing — the same
    // absent-tally-reads-as-zero shape R106 closed in the fold. Pinned by IDENTITY against a known
    // member of each, so a copy of the prose would not satisfy it.
    expect(ADMISSIBLE_INTERPRETATIONS).toContain(CAVEAT_INTERPRETATIONS["runner-disagreement"]);
    expect(ADMISSIBLE_INTERPRETATIONS).toContain(ATTRIBUTION_INTERPRETATIONS.object);
    expect(ADMISSIBLE_INTERPRETATIONS.length).toBeGreaterThanOrEqual(
      Object.keys(CAVEAT_INTERPRETATIONS).length + Object.keys(ATTRIBUTION_INTERPRETATIONS).length,
    );
  });
});
