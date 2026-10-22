import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  fieldSegments,
  initParser,
  lastFieldChild,
  nameSegments,
  parseAL,
  wrapRoot,
} from "../../src";

/**
 * R502: a namespace-qualified name is several sibling children sharing one field, one per segment
 * (tree-sitter-al 4.4.1), and `childForFieldName` returns the FIRST.
 */
describe("qualified names", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("nameSegments: dotted segments, a quoted segment kept whole and unquoted", () => {
    expect(nameSegments("System.Utilities.Integer")).toEqual(["System", "Utilities", "Integer"]);
    expect(nameSegments("Integer")).toEqual(["Integer"]);
    expect(nameSegments('Microsoft.Sales."Sales Header"')).toEqual([
      "Microsoft",
      "Sales",
      "Sales Header",
    ]);
    expect(nameSegments('"Sales.Header"')).toEqual(["Sales.Header"]);
    expect(nameSegments(' Ns."A.B" ')).toEqual(["Ns", "A.B"]);
    expect(nameSegments("50004")).toEqual(["50004"]);
  });

  it("fieldSegments and lastFieldChild: one segment and three", () => {
    const root = wrapRoot(
      parseAL(`report 50100 R
{
    dataset
    {
        dataitem(X; System.Utilities.Integer) { }
        dataitem(Y; "Sales Header") { }
    }
}
`),
    );
    const items: ALSyntaxNode[] = [];
    const collect = (n: ALSyntaxNode): void => {
      if (n.rawKind === "report_dataitem") items.push(n);
      for (const c of n.namedChildren) collect(c);
    };
    collect(root);
    const [x, y] = items;
    if (x === undefined || y === undefined) throw new Error("two data items expected");
    expect(x.childForFieldName("table_name")?.text).toBe("System");
    expect(fieldSegments(x, "table_name")).toEqual(["System", "Utilities", "Integer"]);
    expect(lastFieldChild(x, "table_name")?.text).toBe("Integer");
    expect(fieldSegments(y, "table_name")).toEqual(["Sales Header"]);
    expect(lastFieldChild(y, "table_name")?.text).toBe('"Sales Header"');
    expect(fieldSegments(y, "no_such_field")).toEqual([]);
    expect(lastFieldChild(y, "no_such_field")).toBeNull();
  });
});
