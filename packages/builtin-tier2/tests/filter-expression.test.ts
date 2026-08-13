import { describe, expect, it } from "bun:test";
import {
  classifyContent,
  extractPlaceholders,
  mutateFilterContent,
  quoteALString,
  unquoteALString,
} from "../src/filter-expression";

describe("unquoteALString / quoteALString", () => {
  it("round-trips the escaped quote", () => {
    expect(unquoteALString("'it''s'")).toBe("it's");
    expect(quoteALString("it's")).toBe("'it''s'");
  });
  it("refuses a non-literal shape", () => {
    expect(unquoteALString("Foo")).toBeNull();
  });
  it("round-trips content with no embedded quote at all", () => {
    expect(unquoteALString("'<>%1'")).toBe("<>%1");
    expect(quoteALString("<>%1")).toBe("'<>%1'");
  });
  it("round-trips the empty literal", () => {
    expect(unquoteALString("''")).toBe("");
    expect(quoteALString("")).toBe("''");
  });
  it("refuses a string missing its delimiters", () => {
    expect(unquoteALString("'unterminated")).toBeNull();
    expect(unquoteALString("unterminated'")).toBeNull();
    expect(unquoteALString("")).toBeNull();
  });
});

describe("mutateFilterContent, the precedence ladder", () => {
  it("rule 1: flips <>%1 to =%1", () => {
    expect(mutateFilterContent("<>%1")).toEqual({ mutated: "=%1", rule: "flip-negation" });
  });
  it("rule 2: shifts each boundary by one", () => {
    expect(mutateFilterContent("<%1")?.mutated).toBe("<=%1");
    expect(mutateFilterContent("<=%1")?.mutated).toBe("<%1");
    expect(mutateFilterContent(">%1")?.mutated).toBe(">=%1");
    expect(mutateFilterContent(">=%1")?.mutated).toBe(">%1");
  });
  it("rule 3: flips an open range", () => {
    expect(mutateFilterContent("..%1")?.mutated).toBe("%1..");
    expect(mutateFilterContent("%1..")?.mutated).toBe("..%1");
  });
  it("rule 4: drops the first placeholder-free alternative, keeping arity intact", () => {
    expect(mutateFilterContent("%1|FIXED")).toEqual({ mutated: "%1", rule: "drop-alternative" });
    expect(mutateFilterContent("A|%1|B")?.mutated).toBe("%1|B");
  });
  it("precedence: negation beats drop-alternative on a mixed expression", () => {
    expect(mutateFilterContent("<>%1|FIXED")?.rule).toBe("flip-negation");
  });
  it("precedence: negation (rule 1) beats boundary shift (rule 2) when different alternatives qualify for each", () => {
    // '<>%1' (rule 1) and '<%2' (rule 2) cannot be the SAME alternative (each alternative classifies
    // into exactly one shape), so this is the only way the two rules can ever compete on one site.
    expect(mutateFilterContent("<>%1|<%2")).toEqual({ mutated: "=%1|<%2", rule: "flip-negation" });
  });
  it("precedence: boundary shift (rule 2) beats open-range flip (rule 3), NOT on severity (spec §2.3's own worked example)", () => {
    // Spec §2.3: "at a filter like '<%1|..%2', ... the ladder fires rule 2 and emits the narrower of
    // the two available mutations", rule 2's position is justified by sharing rule 1's single-token
    // rewrite mechanism, not by severity, and this is the one case the order actually changes the
    // outcome for, so it is the case worth pinning.
    expect(mutateFilterContent("<%1|..%2")).toEqual({
      mutated: "<=%1|..%2",
      rule: "shift-boundary",
    });
  });
  it("precedence: open-range flip (rule 3) beats drop-alternative (rule 4) when both qualify", () => {
    expect(mutateFilterContent("..%1|FIXED")).toEqual({
      mutated: "%1..|FIXED",
      rule: "flip-open-range",
    });
  });
  it("refuses when every alternative carries a placeholder and no other rule applies", () => {
    expect(mutateFilterContent("%1|%2")).toBeNull();
  });
  it("refuses closed ranges as the only shape", () => {
    expect(mutateFilterContent("%1..%2")).toBeNull();
  });
  it("refuses wildcards, at-signs, ampersands, parens, and embedded quotes", () => {
    for (const bad of ["FIL*", "@name", "%1&<>%2", "(%1)", "it's"]) {
      expect(mutateFilterContent(bad)).toBeNull();
    }
  });
  it("refuses the empty and whitespace-only string", () => {
    expect(mutateFilterContent("")).toBeNull();
    expect(mutateFilterContent("  ")).toBeNull();
  });
  it("never changes the placeholder multiset (property over the table)", () => {
    const cases = ["<>%1", "<%1", "..%1", "%1..", "%1|FIXED", "A|%1|B", "<>%1|FIXED"];
    const multiset = (s: string) => (s.match(/%\d+/g) ?? []).sort().join(",");
    for (const c of cases) {
      const m = mutateFilterContent(c);
      if (m !== null) expect(multiset(m.mutated)).toBe(multiset(c));
    }
  });

  // --- Amendment-driven cases: the two reviewed blockers, plus the refusal surface the amended
  // spec (docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md §2.2, §2.3, §5) names
  // explicitly rather than leaves implicit.

  describe("BLOCKER 1: an empty comparator remainder refuses instead of emitting an unmeasured '='", () => {
    it("'<>' alone (empty remainder) refuses: the non-empty requirement in isAtom is load-bearing", () => {
      expect(mutateFilterContent("<>")).toBeNull();
    });
    it("'<=' alone (empty remainder) refuses the same way", () => {
      expect(mutateFilterContent("<=")).toBeNull();
    });
    it("'<>1..5' is not a comparator (remainder contains '..') and falls through every rule", () => {
      expect(mutateFilterContent("<>1..5")).toBeNull();
    });
  });

  describe("BLOCKER 2: rule 4's rejoin is safe by construction, and step 5 backstops it", () => {
    it("drops a leading placeholder-free alternative without leaving a stray '|' (spec §2.2 step 5's own example)", () => {
      expect(mutateFilterContent("ABC|%1")).toEqual({ mutated: "%1", rule: "drop-alternative" });
    });
    it("classifyContent, the same function step 5 re-runs on the ladder's output, refuses a leading, trailing or doubled '|' directly", () => {
      // These are exactly the shapes a naive substring-deletion rejoin (deleting "ABC" from
      // "ABC|%1" by removing only that substring, leaving "|%1") would produce. Testing them
      // directly against classifyContent proves the defence classifyContent-as-step-5 provides,
      // independent of whether this module's own rule-4 implementation happens to need it.
      expect(classifyContent("|%1")).toBeNull();
      expect(classifyContent("%1|")).toBeNull();
      expect(classifyContent("A||B")).toBeNull();
    });
  });

  describe("whitespace is refused explicitly, not treated as an unrecognised character by accident", () => {
    it("a leading or trailing space inside one alternative of a multi-alternative filter refuses the whole site", () => {
      expect(mutateFilterContent("A | B")).toBeNull();
      expect(mutateFilterContent("A |B")).toBeNull();
      expect(mutateFilterContent("A| B")).toBeNull();
    });
  });

  describe("a stray '%' that does not form a clean, whole-alternative placeholder refuses (spec §2.2 step 4)", () => {
    it("refuses '50%', '%A' and '%1x'", () => {
      for (const bad of ["50%", "%A", "%1x"]) {
        expect(mutateFilterContent(bad)).toBeNull();
      }
    });
  });

  describe("ladder exhaustion is a distinct outcome from parser refusal (spec §5)", () => {
    it("a lone placeholder atom (the pre-existing fixture shape) matches no rule and produces no mutant", () => {
      expect(mutateFilterContent("%1")).toBeNull();
    });
    it("an empty alternative ('||', a leading or trailing '|') refuses rather than reaching the ladder", () => {
      expect(mutateFilterContent("||")).toBeNull();
      expect(mutateFilterContent("|%1")).toBeNull();
      expect(mutateFilterContent("%1|")).toBeNull();
    });
  });
});

describe("independent audit findings (2026-08-13): guards with no coverage", () => {
  it("finding 1: a second '..' occurrence refuses rather than silently dropping the tail (classifyRange's parts.length !== 2 check)", () => {
    // With that check removed, classifyRange("..A..B") reads only the first ".."-split pair
    // (left="", right="A") and silently drops the "..B" tail; the ladder would then emit
    // {mutated:"A..", rule:"flip-open-range"}, a corrupted mutation. Correctly, this refuses.
    expect(mutateFilterContent("..A..B")).toBeNull();
  });
  it("finding 2: a bare '..' alternative (both sides empty) refuses even alongside another alternative", () => {
    // With classifyRange's "left === '' && right === ''" check removed, ".." classifies as a
    // (vacuous) range, rule 4 then drops the OTHER alternative "FIXED" and rejoins to bare "..",
    // which step 5 (wrongly) accepts because the same relaxed classifyRange re-validates it.
    expect(mutateFilterContent("..|FIXED")).toBeNull();
  });
  it("finding 3: classifyRange's left/right atom-validity checks are a MASKING PAIR, pinned by defeating both at once", () => {
    // Defeating either check ALONE is invisible to any test: rule 3 transposes whichever side is
    // non-empty to the OTHER side when it fires ('X..' <-> '..X'), and step 5 re-runs this same
    // classifyRange on that transposed output, so the SURVIVING check catches the invalid atom on
    // the way out even when the check on its original side was removed on the way in. Only
    // defeating BOTH simultaneously (the red-check for this test) lets an atom containing '='
    // through on both ends. See the paired comments on both checks in filter-expression.ts.
    expect(mutateFilterContent("X=Y..")).toBeNull();
    expect(mutateFilterContent("..X=Y")).toBeNull();
  });
  it("finding 4: a single non-placeholder atom with no '|' produces no mutant (rule 4's parts.length >= 2 guard)", () => {
    // Masked to the same null by step 5 even if this guard were removed (dropping the site's only
    // alternative rejoins to "", which step 5's empty-alternative check refuses independently),
    // but nothing in the suite called mutateFilterContent with this exact shape before this test.
    expect(mutateFilterContent("FIXED")).toBeNull();
  });
  it("finding 5: '?' (a documented BC wildcard) refuses in isolation, not only alongside '*'", () => {
    expect(mutateFilterContent("<>FIL?")).toBeNull();
  });
  it("finding 6: '(' and ')' each refuse in isolation, not only when both appear together", () => {
    expect(mutateFilterContent("<>(FIL")).toBeNull();
    expect(mutateFilterContent("<>FIL)")).toBeNull();
  });
});

describe("extractPlaceholders", () => {
  it("extracts every %N token as a sorted list", () => {
    expect(extractPlaceholders("%2|FIXED|%1")).toEqual(["%1", "%2"]);
    expect(extractPlaceholders("FIXED")).toEqual([]);
  });
});
