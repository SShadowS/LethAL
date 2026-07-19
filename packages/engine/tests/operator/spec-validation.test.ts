import { beforeAll, describe, expect, it } from "bun:test";
import type { ALSyntaxNode } from "../../src";
import { ALNodeKind, findAll, initParser, parseAL, visit, wrapRoot } from "../../src";
import { buildSpanIndex, validateSpec } from "../../src/operator/spec-validation";

describe("validateSpec", () => {
  const base = {
    operatorName: "test.op",
    operatorVersion: "1.0.0",
    astNodeId: "node-1",
    before: { kind: "comparison_expression" },
    after: { kind: "comparison_expression" },
    parentContext: "statement-position",
  };

  it("accepts a well-formed spec", () => {
    const result = validateSpec(base);
    expect(result.ok).toBe(true);
  });

  it("rejects a spec missing parentContext", () => {
    const { parentContext, ...bad } = base;
    const result = validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("parentContext");
  });

  it("rejects a spec with an invalid parentContext value", () => {
    const result = validateSpec({ ...base, parentContext: "nowhere" });
    expect(result.ok).toBe(false);
  });

  it("rejects a spec with non-semver operator version", () => {
    const result = validateSpec({ ...base, operatorVersion: "v1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("operatorVersion");
  });

  it("accepts optional equivalenceHint when present", () => {
    const result = validateSpec({ ...base, equivalenceHint: "likely-equivalent" });
    expect(result.ok).toBe(true);
  });
});

describe("validateSpec — before must be a real tree node when root is given", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = `codeunit 1 "T" { procedure P(A: Integer): Boolean begin exit(A > 0); end; }`;

  it("rejects a synthetic span that matches no node in the tree", () => {
    const root = wrapRoot(parseAL(SRC));
    // Spreading a node only copies its OWN properties (`ts`/`parentNode`/
    // `fieldName`); `kind`/`startIndex`/`endIndex` are prototype getters, so
    // `kind` must be copied explicitly here — otherwise the spec would already
    // be rejected by the `before.kind` schema check above, and this test
    // would pass without ever exercising the root-membership check.
    const synthetic = { ...root, kind: root.kind, startIndex: 10, endIndex: 30 } as never;
    const res = validateSpec(
      {
        operatorName: "x",
        operatorVersion: "1.0.0",
        astNodeId: "10-30",
        before: synthetic,
        after: synthetic,
        parentContext: "statement-position",
      },
      root,
    );
    expect(res.ok).toBe(false);
  });

  it("accepts a genuine node matched by exact range", () => {
    const root = wrapRoot(parseAL(SRC));
    const cmp = findAll(root, ALNodeKind.comparison_expression)[0];
    if (cmp === undefined) throw new Error("fixture drift");
    const res = validateSpec(
      {
        operatorName: "x",
        operatorVersion: "1.0.0",
        astNodeId: `${cmp.startIndex}-${cmp.endIndex}`,
        before: cmp,
        after: cmp,
        parentContext: "statement-position",
      },
      root,
    );
    expect(res.ok).toBe(true);
  });

  it("skips the root-membership check when root is omitted (backward compatible)", () => {
    const root = wrapRoot(parseAL(SRC));
    const synthetic = { ...root, kind: root.kind, startIndex: 10, endIndex: 30 } as never;
    const res = validateSpec({
      operatorName: "x",
      operatorVersion: "1.0.0",
      astNodeId: "10-30",
      before: synthetic,
      after: synthetic,
      parentContext: "statement-position",
    });
    expect(res.ok).toBe(true);
  });
});

describe("validateSpec — indexed span lookup (buildSpanIndex)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const SRC = `codeunit 1 "T" { procedure P(A: Integer): Boolean begin exit(A > 0); end; }`;

  it("rejects a synthetic span that matches no node, via the indexed route", () => {
    const root = wrapRoot(parseAL(SRC));
    const spanIndex = buildSpanIndex(root);
    const synthetic = { ...root, kind: root.kind, startIndex: 10, endIndex: 30 } as never;
    const res = validateSpec(
      {
        operatorName: "x",
        operatorVersion: "1.0.0",
        astNodeId: "10-30",
        before: synthetic,
        after: synthetic,
        parentContext: "statement-position",
      },
      root,
      spanIndex,
    );
    expect(res.ok).toBe(false);
  });

  it("accepts EVERY genuine node in the tree, via the indexed route", () => {
    const root = wrapRoot(parseAL(SRC));
    const spanIndex = buildSpanIndex(root);
    const nodes: ALSyntaxNode[] = [];
    visit(root, (n) => nodes.push(n));
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      const res = validateSpec(
        {
          operatorName: "x",
          operatorVersion: "1.0.0",
          astNodeId: `${n.startIndex}-${n.endIndex}`,
          before: n,
          after: n,
          parentContext: "statement-position",
        },
        root,
        spanIndex,
      );
      expect(res.ok).toBe(true);
    }
  });
});
