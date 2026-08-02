import { describe, expect, it } from "bun:test";
import { ALNodeKind } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { dedupeSpecs } from "../src/dedup";

/** Minimal stub node — dedup reads only kind/startIndex/endIndex/text. */
function node(
  start: number,
  end: number,
  text: string,
  kind: ALNodeKind = ALNodeKind.procedure_call,
): MutationSpec["before"] {
  return {
    kind,
    rawKind: kind,
    text,
    startIndex: start,
    endIndex: end,
    startPosition: { row: 0, column: start },
    endPosition: { row: 0, column: end },
    parent: null,
    children: [],
    namedChildren: [],
    fieldName: null,
    childForFieldName: () => null,
  };
}

function spec(o: {
  operatorName: string;
  start: number;
  end: number;
  after: string;
  kind?: ALNodeKind;
  equivalenceHint?: "likely-equivalent" | "unknown";
}): MutationSpec {
  return {
    operatorName: o.operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${o.start}-${o.end}`,
    before: node(o.start, o.end, "Rec.Foo(X)", o.kind),
    after: node(o.start, o.end, o.after, o.kind),
    parentContext: "statement-position",
    ...(o.equivalenceHint !== undefined ? { equivalenceHint: o.equivalenceHint } : {}),
  };
}

const TIERS = new Map<string, 1 | 2 | 3 | "custom">([
  ["lethal.void-method-call", 1],
  ["lethal.remove-testfield", 2],
  ["lethal.remove-setrange", 2],
  ["lethal.remove-calcfields", 2],
  ["lethal.remove-setloadfields", 2],
  ["lethal.swap-modify-flag", 2],
  ["lethal.a", 2],
  ["lethal.b", 2],
  ["vendor.custom", "custom"],
  ["vendor.custom-two", "custom"],
  // R11/R13: a REGISTERED tier-3 operator. No such operator exists, and the R13 decision
  // (docs/superpowers/specs/2026-08-02-r13-tier3-decision.md) is that none should be built — so
  // this entry exists only to keep that decision executable rather than commented.
  ["lethal.hypothetical-tier3", 3],
]);
const tierOf = (name: string) => TIERS.get(name);

describe("dedupeSpecs", () => {
  it("keeps the more specific operator when two produce the same identity", () => {
    const generic = spec({
      operatorName: "lethal.void-method-call",
      start: 10,
      end: 20,
      after: "",
    });
    const specific = spec({
      operatorName: "lethal.remove-testfield",
      start: 10,
      end: 20,
      after: "",
    });
    const out = dedupeSpecs([generic, specific], tierOf);
    expect(out.length).toBe(1);
    expect(out[0]?.operatorName).toBe("lethal.remove-testfield");
  });

  it("keeps both when the after-form differs — they are distinct mutations", () => {
    const del = spec({ operatorName: "lethal.void-method-call", start: 10, end: 20, after: "" });
    const swap = spec({
      operatorName: "lethal.swap-modify-flag",
      start: 10,
      end: 20,
      after: "Modify(false)",
    });
    expect(dedupeSpecs([del, swap], tierOf).length).toBe(2);
  });

  it("never lets a likely-equivalent Tier-2 mutant suppress a scored Tier-1 one", () => {
    const scored = spec({ operatorName: "lethal.void-method-call", start: 10, end: 20, after: "" });
    const hinted = spec({
      operatorName: "lethal.remove-setloadfields",
      start: 10,
      end: 20,
      after: "",
      equivalenceHint: "likely-equivalent",
    });
    const out = dedupeSpecs([scored, hinted], tierOf);
    expect(out.length).toBe(1);
    expect(out[0]?.operatorName).toBe("lethal.void-method-call");
  });

  it("throws naming both operators when two of the same tier collide", () => {
    const a = spec({ operatorName: "lethal.a", start: 10, end: 20, after: "" });
    const b = spec({ operatorName: "lethal.b", start: 10, end: 20, after: "" });
    expect(() => dedupeSpecs([a, b], tierOf)).toThrow(/lethal\.a.*lethal\.b|lethal\.b.*lethal\.a/);
  });

  it("throws when an operator's tier is unknown rather than guessing a precedence", () => {
    const known = spec({ operatorName: "lethal.void-method-call", start: 10, end: 20, after: "" });
    const unknown = spec({ operatorName: "lethal.not-registered", start: 10, end: 20, after: "" });
    expect(() => dedupeSpecs([known, unknown], tierOf)).toThrow(/lethal\.not-registered/);
  });

  it("refuses to order a REGISTERED tier-3 operator against a tier-1 one (R11 stays two-tier)", () => {
    // R11 filed `tierRank`'s missing tier-3 rank as a defect to fix "when tier 3 becomes real".
    // R13 measured that it does not become real, so the throw is the DECISION, not a gap: a third
    // rank with no operator behind it would silently resolve a collision nobody has reasoned about.
    //
    // The collision is concrete rather than hypothetical. The one Tier-3 candidate that fits the
    // existing emit path — `IsolationLevelSwap` deleting `LockTable()` — emits a byte-identical
    // identity to the `void-method-call` mutant already shipped at 25 sites of Continia Document
    // Output, so registering it as tier 3 would abort those sessions HERE, loudly, which is the
    // designed behaviour. This test is that decision as an executable assertion (R70's rule: a
    // premise written only in prose stops being true without anyone noticing).
    const tier1 = spec({ operatorName: "lethal.void-method-call", start: 10, end: 20, after: "" });
    const tier3 = spec({
      operatorName: "lethal.hypothetical-tier3",
      start: 10,
      end: 20,
      after: "",
    });
    expect(() => dedupeSpecs([tier1, tier3], tierOf)).toThrow(/hypothetical-tier3/);
    // Names BOTH tiers, so the reader sees which pair has no defined precedence rather than
    // being sent to the registry for a missing registration.
    expect(() => dedupeSpecs([tier1, tier3], tierOf)).toThrow(/tier 1/);
    expect(() => dedupeSpecs([tier1, tier3], tierOf)).toThrow(/tier 3/);
    expect(() => dedupeSpecs([tier1, tier3], tierOf)).not.toThrow(/registration order/);
    // A tier-3 spec tagged `likely-equivalent` must not slip past the ordering check by winning
    // the hint tiebreak: the NaN throw precedes it, and that ordering is the guarantee.
    const hinted = spec({
      operatorName: "lethal.hypothetical-tier3",
      start: 10,
      end: 20,
      after: "",
      equivalenceHint: "likely-equivalent",
    });
    expect(() => dedupeSpecs([tier1, hinted], tierOf)).toThrow(/hypothetical-tier3/);
  });

  it("reports two UNREGISTERED operators as unorderable, not as a same-tier collision", () => {
    // `tierOf` returns undefined for both, and `undefined === undefined` is true — so testing
    // tier equality first blamed "registration order" for a pair that has no tier at all, sending
    // the reader to the precedence table instead of to the missing registration.
    const a = spec({ operatorName: "vendor.unregistered-a", start: 10, end: 20, after: "" });
    const b = spec({ operatorName: "vendor.unregistered-b", start: 10, end: 20, after: "" });
    expect(() => dedupeSpecs([a, b], tierOf)).toThrow(/unregistered/);
    expect(() => dedupeSpecs([a, b], tierOf)).not.toThrow(/registration order/);
  });

  it("reports two CUSTOM-tier operators as unorderable, not as a same-tier collision", () => {
    // Same trap one step along: `"custom" === "custom"` is true, but `custom` has no defined
    // position against anything, so "the winner would depend on registration order" is wrong.
    const a = spec({ operatorName: "vendor.custom", start: 10, end: 20, after: "" });
    const b = spec({ operatorName: "vendor.custom-two", start: 10, end: 20, after: "" });
    expect(() => dedupeSpecs([a, b], tierOf)).toThrow(/custom-tier/);
    expect(() => dedupeSpecs([a, b], tierOf)).not.toThrow(/registration order/);
  });

  it("gives a single operator colliding with itself its own message", () => {
    // One operator emitting the same mutation twice is a bug in its generate(), not an
    // interaction between two operators — 'operators "lethal.a" and "lethal.a" both claim...'
    // reads as the latter and sends the reader to the registry.
    const once = spec({ operatorName: "lethal.a", start: 10, end: 20, after: "" });
    const twice = spec({ operatorName: "lethal.a", start: 10, end: 20, after: "" });
    expect(() => dedupeSpecs([once, twice], tierOf)).toThrow(/emitted the same mutation twice/);
    expect(() => dedupeSpecs([once, twice], tierOf)).not.toThrow(/registration order/);
  });

  it("keeps a parent and a same-span child as distinct mutations", () => {
    // Same-span parent/child pairs are real in this grammar, not hypothetical: parsing
    // `procedure P() begin if X then Y := 1; end;` gives a `statement_block` and the single
    // `if_statement` inside it BOTH spanning 57-74 (also `declaration_body`/`procedure` and
    // `var_body`/`variable_declaration`). Two operators targeting those two nodes are producing
    // two different mutations; identity keyed on span alone merges them, so one genuinely
    // different mutation site vanishes — silently, since the survivor still looks plausible.
    // Same-tier here, so a merge additionally surfaces as a spurious collision throw.
    const child = spec({
      operatorName: "lethal.a",
      start: 10,
      end: 20,
      after: "",
      kind: ALNodeKind.if_statement,
    });
    const parent = spec({
      operatorName: "lethal.b",
      start: 10,
      end: 20,
      after: "",
      kind: ALNodeKind.statement_block,
    });
    const out = dedupeSpecs([child, parent], tierOf);
    expect(out.length).toBe(2);
    expect(out.map((s) => s.operatorName).sort()).toEqual(["lethal.a", "lethal.b"]);
  });

  it("still throws on a same-tier collision even when one side is likely-equivalent", () => {
    // Deliberate: the same-tier check precedes the likely-equivalent one. Within a
    // tier, operators are specified to match distinct method names, so two of them
    // claiming one site is a caller-contract violation however they are tagged —
    // and an equivalence hint must not quietly promote one into the winner of a
    // collision that should never have happened. Loud beats a plausible default.
    const plain = spec({ operatorName: "lethal.a", start: 10, end: 20, after: "" });
    const hinted = spec({
      operatorName: "lethal.b",
      start: 10,
      end: 20,
      after: "",
      equivalenceHint: "likely-equivalent",
    });
    expect(() => dedupeSpecs([plain, hinted], tierOf)).toThrow(
      /lethal\.a.*lethal\.b|lethal\.b.*lethal\.a/,
    );
  });

  // Task 7 (R12): the first real exercise of this module's collision branch. Tier 2
  // (packages/builtin-tier2) introduced four operators that target sites Tier 1's
  // `void-method-call` also targets: three deletions (`RemoveTestField`, `RemoveSetRange`,
  // `RemoveCalcFields`) claim the identical empty after-form at their own site, and
  // `SwapModifyFlag` claims a `Modify(true)` site with a DIFFERENT after-form
  // (design doc §4 intro; §3.2). This batch mirrors all four shapes at once, at four
  // DIFFERENT sites, so the same call to `dedupeSpecs` exercises precedence (win) and
  // coexistence (no dedup) side by side, the way a real instrumented file would.
  describe("Tier 2 precedence and coexistence across all four Phase-1 shapes (design doc §4, §7.4)", () => {
    const testFieldSite = { start: 100, end: 120 };
    const setRangeSite = { start: 200, end: 230 };
    const calcFieldsSite = { start: 300, end: 320 };
    const modifySite = { start: 400, end: 415 };

    const deletionAt = (operatorName: string, site: { start: number; end: number }): MutationSpec =>
      spec({ operatorName, start: site.start, end: site.end, after: "" });

    // Three deletion collisions (void-method-call vs. the Tier-2 narrowing, same empty
    // after-form) plus one non-collision (void-method-call's empty after-form vs.
    // swap-modify-flag's `Modify(false)` after-form) — eight input specs, four sites.
    const batch: readonly MutationSpec[] = [
      deletionAt("lethal.void-method-call", testFieldSite),
      deletionAt("lethal.remove-testfield", testFieldSite),
      deletionAt("lethal.void-method-call", setRangeSite),
      deletionAt("lethal.remove-setrange", setRangeSite),
      deletionAt("lethal.void-method-call", calcFieldsSite),
      deletionAt("lethal.remove-calcfields", calcFieldsSite),
      deletionAt("lethal.void-method-call", modifySite),
      spec({
        operatorName: "lethal.swap-modify-flag",
        start: modifySite.start,
        end: modifySite.end,
        after: "Rec.Modify(false)",
      }),
    ];

    it("each Tier-2 deletion suppresses void-method-call at its OWN site", () => {
      const out = dedupeSpecs(batch, tierOf);
      const at = (start: number) =>
        out.filter((s) => s.before.startIndex === start).map((s) => s.operatorName);
      expect(at(testFieldSite.start)).toEqual(["lethal.remove-testfield"]);
      expect(at(setRangeSite.start)).toEqual(["lethal.remove-setrange"]);
      expect(at(calcFieldsSite.start)).toEqual(["lethal.remove-calcfields"]);
    });

    it("the Modify(true) site yields TWO mutants — coexistence, not a collision", () => {
      const out = dedupeSpecs(batch, tierOf);
      const atModify = out
        .filter((s) => s.before.startIndex === modifySite.start)
        .map((s) => s.operatorName)
        .sort();
      expect(atModify).toEqual(["lethal.swap-modify-flag", "lethal.void-method-call"]);
    });

    // Eight input specs in, five out: the three deletion collisions each resolve to one winner and
    // the Modify pair does not collide at all.
    //
    // What used to sit here as well — recomputing `kind:start:end:after-text` over the SURVIVING
    // set and asserting the identities are distinct — could not fail: `dedupeSpecs` returns the
    // values of a Map keyed on exactly that string, so uniqueness holds for ANY input, correct
    // implementation or not. The count below is the load-bearing half, and it is kept.
    //
    // Spec §7.4's standing invariant ("no two operators ever emit the same (site, after-form)")
    // is only meaningful over the PRE-dedup set produced by REAL operators, which this package
    // cannot build — `schemata` deliberately does not depend on the operator packages. It is
    // asserted in `packages/runner/tests/orchestrator.test.ts`
    // ("generateMutationSet: real cross-tier collisions"), which imports both registries.
    it("resolves eight specs at four sites into five surviving mutants", () => {
      expect(dedupeSpecs(batch, tierOf)).toHaveLength(5);
    });
  });
});
