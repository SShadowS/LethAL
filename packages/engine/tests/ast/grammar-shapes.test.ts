import { beforeAll, describe, expect, it } from "bun:test";
import type { ALSyntaxNode } from "../../src";
import { initParser, isStatementSlot, parseAL, visit, wrapRoot } from "../../src";

/**
 * Shapes tree-sitter-al 4.4.1 fixed after LethAL or a downstream user reported them (upstream #24,
 * #25, #26, #27, #28). Each upstream case is RED under the 4.3.0 wasm. If a bump turns one red, the
 * grammar regressed on a shape LethAL depends on: map it before editing this file.
 */
function ofKind(root: ALSyntaxNode, raw: string): ALSyntaxNode[] {
  const out: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.rawKind === raw) out.push(n);
  });
  return out;
}

function hasError(root: ALSyntaxNode): boolean {
  return ofKind(root, "ERROR").length > 0;
}

/** Calls whose callee text is exactly `name`. */
function callsNamed(root: ALSyntaxNode, name: string): ALSyntaxNode[] {
  return ofKind(root, "call_expression").filter(
    (c) => c.childForFieldName("function")?.text === name,
  );
}

const codeunit = (body: string, vars = "Outcome: Integer;"): string =>
  `codeunit 50001 "Shape Probe"\n{\n    procedure Run()\n    var\n        ${vars}\n    begin\n${body}\n    end;\n}\n`;

describe("tree-sitter-al 4.4.1 shapes", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("#24: an operator dangling before #if parses without ERROR", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "        B := (1 = 1) or\n#if X\n          (2 = 2) or\n#endif\n          (3 = 3);",
          "B: Boolean;",
        ),
      ),
    );
    expect(hasError(root)).toBe(false);
    expect(ofKind(root, "preproc_operand_prefix").length).toBe(1);
  });

  it("#24 follow-up: `or` opening a #if continuation continues the assignment's expression", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "        B := (1 = 1)\n#if X\n          or (2 = 2)\n#endif\n          or (3 = 3);",
          "B: Boolean;",
        ),
      ),
    );
    expect(hasError(root)).toBe(false);
    expect(callsNamed(root, "or")).toEqual([]);
    // The expected shape, from upstream's test/corpus/preproc_expression_continuation_operators_test.txt:
    // ONE assignment whose right is `(1 = 1)` and which carries a preproc_conditional_expression_tail
    // holding both continuation operands. Under 4.3.0 the assignment ended at `(1 = 1)` and the
    // rest was two sibling calls named `or`.
    const assigns = ofKind(root, "assignment_statement");
    expect(assigns.length).toBe(1);
    expect(assigns[0]?.childForFieldName("right")?.text).toBe("(1 = 1)");
    const tails = ofKind(root, "preproc_conditional_expression_tail");
    expect(tails.length).toBe(1);
    expect(tails[0]?.parent?.rawKind).toBe("assignment_statement");
    const operands = (tails[0]?.namedChildren ?? [])
      .filter((c) => c.fieldName === "operand")
      .map((c) => c.text);
    expect(operands).toEqual(["(2 = 2)", "(3 = 3)"]);
  });

  it("#25: a begin opened inside a #if branch and closed after #endif parses without ERROR", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "#if not CLEAN27\n        if true then begin\n            Message('a');\n#endif\n            Message('b');\n        end;",
        ),
      ),
    );
    expect(hasError(root)).toBe(false);
    expect(callsNamed(root, "Message").map((c) => c.text)).toEqual([
      "Message('a')",
      "Message('b')",
    ]);
  });

  it("#26: asserterror over a call on an array element is one statement whose body is the whole call", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "        asserterror Buckets[1].Delete(true);",
          'Buckets: array[3] of Record "Integer";',
        ),
      ),
    );
    const stmts = ofKind(root, "asserterror_statement");
    expect(stmts.length).toBe(1);
    const body = stmts[0]?.childForFieldName("body");
    expect(body?.rawKind).toBe("call_expression");
    expect(body?.text).toBe("Buckets[1].Delete(true)");
    expect(ofKind(root, "list_literal")).toEqual([]);
  });

  it("#28: an assignment under asserterror is an assignment_statement, and if/exit attach as the body", () => {
    const root = wrapRoot(
      parseAL(
        codeunit(
          "        asserterror Outcome := 1;\n        asserterror if Outcome = 2 then Error('two');\n        asserterror exit;",
        ),
      ),
    );
    const bodies = ofKind(root, "asserterror_statement").map(
      (s) => s.childForFieldName("body")?.rawKind,
    );
    expect(bodies).toEqual(["assignment_statement", "if_statement", "exit_statement"]);
    expect(ofKind(root, "assignment_expression")).toEqual([]);
  });

  it("#27: `Visible = Type = Type::Alpha;` is a comparison, with no ERROR", () => {
    const src =
      'page 50006 "Mode Card Probe"\n{\n    PageType = Card;\n    SourceTable = "Mode Probe";\n\n    layout\n    {\n        area(Content)\n        {\n            field(Type; Rec.Type)\n            {\n                ApplicationArea = All;\n                Visible = Type = Type::Alpha;\n            }\n        }\n    }\n}\n';
    const root = wrapRoot(parseAL(src));
    expect(hasError(root)).toBe(false);
    expect(ofKind(root, "comparison_expression").map((c) => c.text)).toEqual([
      "Type = Type::Alpha",
    ]);
  });

  it("#27, bare values: `Image = Filter;` and `ExternalAccess = Modify;` are identifiers, not table relations", () => {
    // Upstream's own examples of the class (551829e: 812 BC.History values moved from
    // table_relation_value to identifier, `ExternalAccess = Modify` 92 and `Image = Filter` 10 among
    // them); shape from test/corpus/value_start_keyword_name_test.txt.
    const root = wrapRoot(
      parseAL("page 50008 P\n{\n    ExternalAccess = Modify;\n    Image = Filter;\n}\n"),
    );
    expect(hasError(root)).toBe(false);
    const values = ofKind(root, "property").map((p) => [
      p.childForFieldName("name")?.text,
      p.childForFieldName("value")?.rawKind,
      p.childForFieldName("value")?.text,
    ]);
    // THE bare-value assertion. Under 4.3.0 each value is a `table_relation_value`, so this fails.
    expect(values).toEqual([
      ["ExternalAccess", "identifier", "Modify"],
      ["Image", "identifier", "Filter"],
    ]);
  });

  it("R216 still open: a call that is an asserterror body is NOT a statement slot", () => {
    const root = wrapRoot(parseAL(codeunit("        asserterror Compute(8);")));
    const body = ofKind(root, "asserterror_statement")[0]?.childForFieldName("body");
    if (body === null || body === undefined) throw new Error("no asserterror body");
    expect(body.rawKind).toBe("call_expression");
    // Flip to true in the follow-on that closes R216 (add `asserterror_statement.body` to
    // SINGLE_STATEMENT_SLOTS in packages/engine/src/ast/tree-walks.ts), with its own census.
    expect(isStatementSlot(body)).toBe(false);
  });
});
