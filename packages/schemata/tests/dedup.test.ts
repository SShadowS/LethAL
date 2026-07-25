import { describe, expect, it } from "bun:test";
import type { MutationSpec } from "@lethal/engine";
import { dedupeSpecs } from "../src/dedup";

/** Minimal stub node — dedup reads only startIndex/endIndex/text. */
function node(start: number, end: number, text: string): MutationSpec["before"] {
  return {
    kind: "call_expression",
    rawKind: "call_expression",
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
  equivalenceHint?: "likely-equivalent" | "unknown";
}): MutationSpec {
  return {
    operatorName: o.operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${o.start}-${o.end}`,
    before: node(o.start, o.end, "Rec.Foo(X)"),
    after: node(o.start, o.end, o.after),
    parentContext: "statement-position",
    ...(o.equivalenceHint !== undefined ? { equivalenceHint: o.equivalenceHint } : {}),
  };
}

const TIERS = new Map<string, 1 | 2 | 3 | "custom">([
  ["lethal.void-method-call", 1],
  ["lethal.remove-testfield", 2],
  ["lethal.remove-setloadfields", 2],
  ["lethal.swap-modify-flag", 2],
  ["lethal.a", 2],
  ["lethal.b", 2],
  ["vendor.custom", "custom"],
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
});
