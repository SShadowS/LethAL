import { describe, expect, it } from "bun:test";
import { continuationRefusal } from "../src/ast/preproc-arms";
import type { ALSyntaxNode } from "../src/ast/syntax-node";

/**
 * R402 plan r3, rule step 3: a previous statement whose LAST leaf is `;` owns its terminator, so a
 * statement-level `#if` after it continues nothing. No parse produces that shape (in a statement
 * list the `;` is a sibling, measured), so the tree is hand-built. The twin without the `;` leaf is
 * refused, which shows the hand-built shape is one the rule otherwise refuses.
 */
type Fake = {
  rawKind: string;
  text: string;
  children: Fake[];
  parent: Fake | null;
  startIndex: number;
};
let at = 0;
const node = (rawKind: string, children: Fake[] = [], text = rawKind): Fake => {
  const n: Fake = { rawKind, text, children, parent: null, startIndex: at++ };
  for (const c of children) c.parent = n;
  return n;
};
const tree = (ownsTerminator: boolean): ALSyntaxNode => {
  const statement = node("assignment_statement", [
    node("identifier", [], "A"),
    node(":="),
    node("integer", [], "1"),
    ...(ownsTerminator ? [node(";")] : []),
  ]);
  const tail = node("preproc_conditional_statement", [
    node("preproc_if", [node("preproc_open", [], "#if"), node("identifier", [], "LETHALX")]),
    node("call_expression", [node("identifier", [], "or"), node("argument_list")]),
    node("preproc_endif", [node("preproc_close", [], "#endif")]),
  ]);
  const block = node("statement_block", [statement, tail]);
  // `lineOf` reads startPosition; give every node one.
  const stamp = (n: Fake): void => {
    Object.assign(n, { startPosition: { row: 0, column: 0 } });
    for (const c of n.children) stamp(c);
  };
  stamp(block);
  return block as unknown as ALSyntaxNode;
};

describe("R402: continuationRefusal, owned terminator", () => {
  it("admits a #if after a statement whose last leaf is `;`", () => {
    expect(continuationRefusal(tree(true))).toBeNull();
  });

  it("refuses the same tree when the statement has no `;` leaf", () => {
    expect(continuationRefusal(tree(false))).toStartWith("directive-continues-statement at line");
  });
});
