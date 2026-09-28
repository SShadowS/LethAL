import { describe, expect, it } from "bun:test";
import { type FlatTree, wrapFlatRoot } from "../../src/ast/syntax-node";

const flat: FlatTree = {
  kindNames: ["r", "x", "+"],
  kind: Uint16Array.of(0, 1, 2),
  fieldNames: ["", "left"],
  field: Uint16Array.of(0, 1, 0),
  flags: Uint8Array.of(1 | 4, 1, 2),
  childCount: Uint32Array.of(2, 0, 0),
  nextSibling: Int32Array.of(-1, 2, -1),
  startIndex: Uint32Array.of(0, 0, 1),
  endIndex: Uint32Array.of(2, 1, 2),
  points: Uint32Array.of(0, 0, 0, 2, 0, 0, 0, 1, 0, 1, 0, 2),
};
const root = wrapFlatRoot({ source: "ab", flat });

describe("FlatNode", () => {
  it("exposes kind, text, offsets, points and parse health", () => {
    expect(root.rawKind).toBe("r");
    expect(root.text).toBe("ab");
    expect([root.startIndex, root.endIndex]).toEqual([0, 2]);
    expect(root.endPosition).toEqual({ row: 0, column: 2 });
    expect(root.parent).toBeNull();
    expect(root.fieldName).toBeNull();
    expect(root.hasError).toBe(true);
    expect(root.isMissing).toBe(false);
    expect(root.children[1]?.isMissing).toBe(true);
  });

  it("lists all children and only named children, with field names and parent", () => {
    expect(root.children.map((c) => c.rawKind)).toEqual(["x", "+"]);
    expect(root.namedChildren.map((c) => c.rawKind)).toEqual(["x"]);
    const [x] = root.children;
    expect(x?.fieldName).toBe("left");
    expect(x?.parent).toBe(root);
    expect(x?.text).toBe("a");
    expect(x?.children).toEqual([]);
  });

  it("finds a child by field name, or null", () => {
    expect(root.childForFieldName("left")?.text).toBe("a");
    expect(root.childForFieldName("left")?.fieldName).toBe("left");
    expect(root.childForFieldName("right")).toBeNull();
  });

  it("returns fresh wrappers per read, as WrappedNode did", () => {
    expect(root.children[0]).not.toBe(root.children[0]);
  });

  it("throws on a corrupt tree instead of returning undefined", () => {
    const bad = wrapFlatRoot({ source: "ab", flat: { ...flat, kind: Uint16Array.of(9, 1, 2) } });
    expect(() => bad.rawKind).toThrow(/kindNames\[9\]/);
  });

  it("covers every ALSyntaxNode member", () => {
    const [x, plus] = root.children;
    expect(root.kind as string).toBe("r");
    expect(root.startPosition).toEqual({ row: 0, column: 0 });
    expect(x?.startPosition).toEqual({ row: 0, column: 0 });
    expect(x?.endPosition).toEqual({ row: 0, column: 1 });
    expect(plus?.startPosition).toEqual({ row: 0, column: 1 });
    expect(plus?.fieldName).toBeNull();
    expect(plus?.hasError).toBe(false);
    expect(x?.namedChildren).toEqual([]);
    expect(x?.childForFieldName("left")).toBeNull();
  });
});

// "(ab)": an anonymous "(" in field "open", then a named x in field "left" that sits in the MIDDLE of
// its parent's text (1..3, so slice and substr differ) and starts at a non-zero column, then ")".
const mid: FlatTree = {
  kindNames: ["r", "(", "x", ")"],
  kind: Uint16Array.of(0, 1, 2, 3),
  fieldNames: ["", "open", "left"],
  field: Uint16Array.of(0, 1, 2, 0),
  flags: Uint8Array.of(1, 0, 1, 0),
  childCount: Uint32Array.of(3, 0, 0, 0),
  nextSibling: Int32Array.of(-1, 2, 3, -1),
  startIndex: Uint32Array.of(0, 0, 1, 3),
  endIndex: Uint32Array.of(4, 1, 3, 4),
  points: Uint32Array.of(0, 0, 0, 4, 0, 0, 0, 1, 0, 1, 0, 3, 0, 3, 0, 4),
};
const midRoot = wrapFlatRoot({ source: "(ab)", flat: mid });

describe("FlatNode, a named child after an anonymous sibling", () => {
  it("slices the child's own text and reads its own column", () => {
    const [, x] = midRoot.children;
    expect(x?.text).toBe("ab");
    expect(x?.startPosition).toEqual({ row: 0, column: 1 });
    expect(x?.endPosition).toEqual({ row: 0, column: 3 });
  });

  it("takes a named child's field name from the node, not from its position", () => {
    expect(midRoot.children.map((c) => c.fieldName)).toEqual(["open", "left", null]);
    const named = midRoot.namedChildren;
    expect(named.map((c) => [c.rawKind, c.fieldName])).toEqual([["x", "left"]]);
    expect(midRoot.childForFieldName("left")?.text).toBe("ab");
  });
});
