import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { type ALSyntaxNode, visit, wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";
import { resolveVarRef } from "../../src/semantic/resolve-var-ref";
import {
  buildSymbolTable,
  collectVarDeclarations,
  objectScopeKey,
} from "../../src/semantic/symbol-table";

// R295: `A, B: T` declares A AND B, both of type T. Each of the four readers of a declaration
// (`collectVarDeclarations`, `triggerLocalNames`, `conditionallyDeclared`, `parseSplitProcedure`)
// read only the first name, so a use of B fell through to a same-named global of ANOTHER type.
// Every fixture below has such a global, typed differently, so a reader that misses B answers with
// the global's type instead of the prescribed one.

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** The LAST identifier `text` that is not a declaration's own name: the use site. */
function useOf(root: ALSyntaxNode, text: string): ALSyntaxNode {
  let hit: ALSyntaxNode | null = null;
  visit(root, (n) => {
    if (n.kind === ALNodeKind.identifier && n.text === text && n.fieldName !== "name") hit = n;
  });
  if (hit === null) throw new Error(`no use of ${text}`);
  return hit;
}

function typeAt(src: string, text: string): string | null {
  const { root, ctx } = load(src);
  return ctx.types.typeOf(useOf(root, text));
}

describe("R295: every name of a multi-name declaration is declared", () => {
  beforeAll(async () => {
    await initParser();
  });

  describe("collectVarDeclarations (procedure locals, globals, trigger var sections)", () => {
    const PROC = `codeunit 50100 "R"
{
    procedure P()
    var
        A, B: Integer;
    begin
        Message('%1', B + B);
    end;

    var
        B: Text;
}
`;
    it("a later local name types by its own declaration, not the global", () => {
      expect(typeAt(PROC, "B")).toBe("Integer");
    });

    it("resolveVarRef answers the local, whose node is the shared declaration node", () => {
      const { root, ctx } = load(PROC);
      const sym = resolveVarRef(useOf(root, "B"), ctx);
      expect(sym?.typeText).toBe("Integer");
      expect(sym?.node.kind).toBe(ALNodeKind.variable_declaration);
    });

    it("every name gets the FULL shared type text, temporary records and arrays included", () => {
      const src = `codeunit 50100 "R"
{
    var
        A, "B C", D: Record Customer temporary;
        M, N: array[2, 3] of Integer;
        L: Label 'x', Comment = 'y', Locked = true;
}
`;
      const t = buildSymbolTable([{ path: "t.al", root: wrapRoot(parseAL(src)) }]);
      const globals = t.globalsOf(objectScopeKey("codeunit", "R"));
      expect(globals.map((v) => [v.name, v.typeText])).toEqual([
        ["A", "Record Customer temporary"],
        ["B C", "Record Customer temporary"],
        ["D", "Record Customer temporary"],
        ["M", "array[2, 3] of Integer"],
        ["N", "array[2, 3] of Integer"],
        // A Label's attributes carry `name` fields too; only the declaration's own names count.
        ["L", "Label"],
      ]);
    });

    it("a later name in a trigger's own var section resolves to that local", () => {
      const { root, ctx } = load(`codeunit 50100 "R"
{
    trigger OnRun()
    var
        A, B: Integer;
    begin
        B := 1;
    end;

    var
        B: Text;
}
`);
      expect(resolveVarRef(useOf(root, "B"), ctx)?.typeText).toBe("Integer");
    });

    it("collectVarDeclarations yields one symbol per name, in source order", () => {
      const root = wrapRoot(parseAL(`codeunit 50100 "R" { var A, B, C: Integer; }`));
      let section: ALSyntaxNode | null = null;
      visit(root, (n) => {
        if (n.kind === ALNodeKind.var_section) section = n;
      });
      if (section === null) throw new Error("no var section");
      expect(collectVarDeclarations(section).map((v) => v.name)).toEqual(["A", "B", "C"]);
    });
  });

  describe("triggerLocalNames: a later name blocks the fallback to a global", () => {
    // R340: a plain trigger local is typed by its own declaration (B: Integer, from `A, B: Integer`),
    // a `#if` one stays unknown (R330). Missing B fell through to the global's Text.
    const src = (header: string) => `codeunit 50100 "R"
{
    trigger OnRun()
${header}
    begin
        Message('%1', B + B);
    end;

    var
        B: Text;
}
`;
    it("in a plain var section", () => {
      expect(typeAt(src("    var\n        A, B: Integer;"), "B")).toBe("Integer");
    });
    it("in a #if var section", () => {
      const header = "#if not CLEAN27\n    var\n        A, B: Integer;\n#endif";
      expect(typeAt(src(header), "B")).toBeNull();
    });
    it("control: a trigger that declares no B still types the global", () => {
      expect(typeAt(src("    var\n        A: Integer;"), "B")).toBe("Text");
    });
  });

  describe("conditionallyDeclared: a later #if name blocks the fallback to a global", () => {
    // A `#if` var-block name is ambiguous (R330): it types as nothing and hides the global.
    const src = `codeunit 50100 "R"
{
    procedure P()
#if not CLEAN27
    var
        A, B: Integer;
#endif
    begin
        Message('%1', B + B);
    end;

    var
        B: Text;
}
`;
    it("types as nothing, never the global's Text", () => {
      expect(typeAt(src, "B")).toBeNull();
    });
    it("is listed as ambiguous", () => {
      const t = buildSymbolTable([{ path: "t.al", root: wrapRoot(parseAL(src)) }]);
      expect(t.resolveProcedure(objectScopeKey("codeunit", "R"), "P")?.ambiguous).toEqual([
        "a",
        "b",
      ]);
    });
  });

  describe("parseSplitProcedure: per-arm declarations, every-arm rule", () => {
    const src = (armA: string, armB: string) => `codeunit 50100 "R"
{
#if CLEAN27
    procedure Pick(X: Integer): Integer
    var
        ${armA}
#else
    procedure Pick(X: Integer): Integer
    var
        ${armB}
#endif
    begin
        Message('%1', B + B);
        exit(X);
    end;

    var
        B: Text;
}
`;
    it("arms that agree type the later name by their shared type", () => {
      expect(typeAt(src("A, B: Integer;", "A, B: Integer;"), "B")).toBe("Integer");
    });
    it("arms that agree across declaration shapes (A, B vs B alone) still agree", () => {
      expect(typeAt(src("A, B: Integer;", "B: Integer;"), "B")).toBe("Integer");
    });
    it("arms that disagree make the later name ambiguous: nothing, never the global", () => {
      expect(typeAt(src("A, B: Integer;", "A, B: Decimal;"), "B")).toBeNull();
    });
  });

  describe("inside `with R do`, a bare name types as nothing (R's fields come first)", () => {
    const src = (body: string) => `codeunit 50100 "R"
{
    procedure P()
    var
        R: Record Customer;
        Q, Z: Integer;
    begin
        ${body}
    end;
}
`;
    it("a later local name inside a with body", () => {
      expect(typeAt(src("with R do begin Message('%1', Z + Q); end;"), "Z")).toBeNull();
    });
    it("control: the same name outside any with types by the local", () => {
      expect(typeAt(src("Message('%1', Z + Q);"), "Z")).toBe("Integer");
    });
  });

  it("a #if BETWEEN two names of one declaration is not this rule's shape: the parse has errors", () => {
    // Pinned as it is today: the grammar does not read it as one declaration, so the file carries
    // ERROR nodes and the pipeline refuses it (see the runner's R295 test for the deployed side).
    const root = wrapRoot(
      parseAL(`codeunit 50100 X
{
    procedure P()
    var
        A,
#if X
        B,
#endif
        C: Integer;
    begin
        C := 1;
    end;
}
`),
    );
    let errors = 0;
    visit(root, (n) => {
      if (n.rawKind === "ERROR") errors++;
    });
    expect(errors).toBeGreaterThan(0);
  });
});
