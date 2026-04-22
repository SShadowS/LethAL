import { describe, it, expect, beforeAll } from "bun:test";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { synthesizeAfter } from "../src/mutate-helpers";

describe("synthesizeAfter", () => {
  beforeAll(async () => { await initParser(); });

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
  });
});
