import { beforeAll, describe, expect, test } from "bun:test";
import { type ALSyntaxNode, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { firstStatementOf } from "../src/dispatch-plan";

beforeAll(async () => {
  await initParser();
});

/** The first `code_block` (the procedure body) of a one-procedure codeunit. */
function body(statements: string): ALSyntaxNode {
  const src = `codeunit 79900 "R976"\n{\n    procedure P(var X: Integer)\n    begin\n${statements}\n    end;\n}\n`;
  const find = (n: ALSyntaxNode): ALSyntaxNode | undefined => {
    if (n.rawKind === "code_block") return n;
    for (const c of n.namedChildren) {
      const f = find(c);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  const b = find(wrapRoot(parseAL(src)));
  if (b === undefined) throw new Error("no body");
  return b;
}

const first = (statements: string) => firstStatementOf(body(statements))?.text.split("\n")[0]?.trim();

// R976: a block-grain mutant's reach line is the line of the statement its block runs first.
describe("R976: firstStatementOf", () => {
  test("the first statement", () => {
    expect(first("        X := 1;\n        X := 2;")).toBe("X := 1");
  });
  test("a leading comment and a lone `;` are skipped: neither has a coverage line", () => {
    expect(first("        // note\n        ;\n        X := 3;")).toBe("X := 3");
    // a comment inside the statement list (after the `;`), not only before it
    expect(first("        ;\n        // note\n        /* more */\n        X := 3;")).toBe("X := 3");
  });
  test("a leading nested block is entered: its own first statement", () => {
    expect(first("        begin\n            X := 4;\n        end;\n        X := 5;")).toBe("X := 4");
  });
  test("a compound first statement is itself the answer (its line is where it starts)", () => {
    expect(first("        if X > 0 then\n            X := 6;")).toBe("if X > 0 then");
  });
  test("an empty block, or one whose first entry is a #if, has none (FALLBACK 1 stays)", () => {
    expect(firstStatementOf(body(""))).toBeUndefined();
    expect(firstStatementOf(body("#if CLEAN99\n        X := 7;\n#endif\n        X := 8;"))).toBeUndefined();
  });
});
