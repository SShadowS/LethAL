import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  findFirst,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { synthesizeAfter } from "../src/mutate-helpers";

describe("synthesizeAfter", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("copies before's span + kind but replaces text", () => {
    const src = `codeunit 51200 "S" { procedure P(A: Integer; B: Integer) begin if A > B then exit(1); end; }`;
    const root = wrapRoot(parseAL(src));
    const cmp = findFirst(root, ALNodeKind.comparison_expression);
    if (cmp === null) throw new Error("no comparison_expression");
    const after = synthesizeAfter(cmp, "A >= B");
    expect(after.text).toBe("A >= B");
    expect(after.kind).toBe(cmp.kind);
    expect(after.startIndex).toBe(cmp.startIndex);
    expect(after.endIndex).toBe(cmp.endIndex);
    expect(after.parent).toBe(cmp.parent);
    // RUST-03 S4.2c: every other member reads the same as before's, now through `before`.
    const shape = (n: ALSyntaxNode | null) =>
      n === null
        ? null
        : { kind: n.kind, start: n.startIndex, end: n.endIndex, text: n.text, field: n.fieldName };
    expect(after.rawKind).toBe(cmp.rawKind);
    expect(after.startPosition).toEqual(cmp.startPosition);
    expect(after.endPosition).toEqual(cmp.endPosition);
    expect(after.fieldName).toBe(cmp.fieldName);
    expect(after.isMissing).toBe(cmp.isMissing);
    expect(after.hasError).toBe(cmp.hasError);
    expect(after.children.map(shape)).toEqual(cmp.children.map(shape));
    expect(after.namedChildren.map(shape)).toEqual(cmp.namedChildren.map(shape));
    expect(after.children.length).toBeGreaterThan(0);
    for (const f of ["left", "right", "operator", "nope"])
      expect(shape(after.childForFieldName(f))).toEqual(shape(cmp.childForFieldName(f)));
    expect(after.childForFieldName("left")).not.toBeNull();
  });
});
