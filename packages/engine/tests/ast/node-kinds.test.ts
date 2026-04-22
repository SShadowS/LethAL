import { describe, it, expect } from "bun:test";
import {
  ALNodeKind,
  BINARY_EXPRESSION_KINDS,
  isALNodeKind,
  isBinaryExpressionKind,
} from "../../src/ast/node-kinds";

describe("ALNodeKind", () => {
  it("includes core kinds referenced by the design spec", () => {
    // Values whose string form matches the grammar verbatim.
    expect(ALNodeKind.if_statement).toBe("if_statement");
    expect(ALNodeKind.procedure).toBe("procedure");
    expect(ALNodeKind.source_file).toBe("source_file");

    // Values adjusted to match SShadowS/tree-sitter-al v2.5.0 node-types.
    // Plan key is kept; string value mirrors the grammar's actual node type.
    expect(ALNodeKind.codeunit).toBe("codeunit_declaration");
  });

  it("exposes the four precedence-class binary expression kinds", () => {
    expect(ALNodeKind.additive_expression).toBe("additive_expression");
    expect(ALNodeKind.multiplicative_expression).toBe("multiplicative_expression");
    expect(ALNodeKind.comparison_expression).toBe("comparison_expression");
    expect(ALNodeKind.logical_expression).toBe("logical_expression");
    expect(BINARY_EXPRESSION_KINDS.length).toBe(4);
  });

  it("recognizes valid kinds via isALNodeKind", () => {
    expect(isALNodeKind("if_statement")).toBe(true);
    expect(isALNodeKind("source_file")).toBe(true);
    expect(isALNodeKind("codeunit_declaration")).toBe(true);
    expect(isALNodeKind("call_expression")).toBe(true);
    expect(isALNodeKind("member_expression")).toBe(true);
    expect(isALNodeKind("additive_expression")).toBe(true);
  });

  it("rejects unknown kinds", () => {
    expect(isALNodeKind("not_a_real_kind")).toBe(false);
    expect(isALNodeKind("")).toBe(false);
    // Plan values that do not exist in the grammar must NOT be recognized.
    expect(isALNodeKind("binary_expression")).toBe(false);
    expect(isALNodeKind("expression_statement")).toBe(false);
    expect(isALNodeKind("method_call")).toBe(false);
  });

  it("isBinaryExpressionKind identifies only the four precedence classes", () => {
    expect(isBinaryExpressionKind("additive_expression")).toBe(true);
    expect(isBinaryExpressionKind("comparison_expression")).toBe(true);
    expect(isBinaryExpressionKind("unary_expression")).toBe(false);
    expect(isBinaryExpressionKind("if_statement")).toBe(false);
  });
});
