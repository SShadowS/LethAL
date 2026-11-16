import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * R1061 (PR-48): `remove-assignment` of `X := v` before a loop whose exit, with X at its default,
 * never ends. Invented AL. Each test names the condition whose removal turns it red.
 */

beforeAll(async () => {
  await initParser();
});

const OP = "lethal.remove-assignment";

function refused(src: string, start: string): boolean {
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  const site = findAll(root, ALNodeKind.assignment_statement).find((n: ALSyntaxNode) =>
    n.text.startsWith(start),
  );
  if (site === undefined) throw new Error(`no assignment starting ${start}`);
  return openItemHangRefuses(site, ctx, OP);
}

/** The M7544 shape: the bound is set before the loop, the counter climbs inside it. */
const shape = (o: {
  assign?: string;
  until?: string;
  body?: string;
  globals?: string;
  locals?: string;
  extra?: string;
}) => `codeunit 50130 "Rule B"
{
    var
        ${o.globals ?? ""}

    procedure Run()
    var
        N: Integer;
        Size: Integer;
        ${o.locals ?? ""}
    begin
        ${o.assign ?? "Size := 1000;"}
        repeat
            N := 0;
            Work();
            ${o.body ?? ""}
            N += 1;
        until ${o.until ?? "N < Size"};
    end;

    local procedure Work()
    begin
    end;
    ${o.extra ?? ""}
}`;

// the counter must start non-negative and only climb: N := 0 inside the loop is a literal 0
describe("R1061: remove-assignment of an exit-read bound set before the loop", () => {
  it("refuses the M7544 shape", () => {
    // revert: drop the Y < X read in evalAt (the loop then reads as unknown)
    expect(refused(shape({}), "Size :=")).toBe(true);
  });

  it("refuses when the loop sits inside a foreach after the assignment (the DO shape)", () => {
    // revert: look only at loops that are siblings of the assignment
    const src = `codeunit 50133 "Rule B Foreach"
{
    procedure Run(Ids: List of [Integer])
    var
        Id: Integer;
        N: Integer;
        Size: Integer;
    begin
        Size := 1000;
        foreach Id in Ids do begin
            repeat
                N := 0;
                N += 1;
            until N < Size;
        end;
    end;
}`;
    expect(refused(src, "Size :=")).toBe(true);
    // a write to X inside the foreach, outside the loop, resets it: kept
    const reset = src.replace("repeat\n", "Size := 7;\n            repeat\n");
    expect(refused(reset, "Size :=")).toBe(false);
  });

  it("keeps X := 0 (the default; condition 2)", () => {
    // revert: drop the literalValue(right) === dflt check
    expect(refused(shape({ assign: "Size := 0;" }), "Size :=")).toBe(false);
  });

  it("keeps it when the exit at default does not block (until N >= Size; condition 1)", () => {
    // revert: return true whenever X is read by the exit
    expect(refused(shape({ until: "N >= Size" }), "Size :=")).toBe(false);
  });

  it("keeps it when the body writes X directly (condition 3)", () => {
    // revert: drop the directWrite check on the loop
    expect(refused(shape({ body: "Size := 5;" }), "Size :=")).toBe(false);
  });

  it("keeps it when the body passes X as a var argument (condition 3)", () => {
    // revert: drop the directWrite check on the loop
    const src = shape({
      body: "Fill(Size);",
      extra: "local procedure Fill(var S: Integer)\n    begin\n    end;",
    });
    expect(refused(src, "Size :=")).toBe(false);
  });

  it("keeps it when a same-object callee writes the global X (condition 3)", () => {
    // revert: drop the chainEffect(callee).writes check
    const src = shape({
      globals: "Size: Integer;",
      locals: "",
      body: "Grow();",
      extra: "local procedure Grow()\n    begin\n        Size := 3;\n    end;",
    }).replace("        Size: Integer;\n        \n", "\n");
    expect(refused(src, "Size :=")).toBe(false);
  });

  it("refuses the global when the body only calls a plain helper (control for the two below)", () => {
    const src = shape({ globals: "Size: Integer;" }).replace(
      "        Size: Integer;\n        \n",
      "\n",
    );
    expect(refused(src, "Size :=")).toBe(true);
  });

  it("keeps a global when the body raises an event (condition 3)", () => {
    // revert: drop the chainRaisesEvent check
    const src = shape({
      globals: "Size: Integer;",
      body: "OnStep();",
      extra: "[IntegrationEvent(false, false)]\n    local procedure OnStep()\n    begin\n    end;",
    }).replace("        Size: Integer;\n        \n", "\n");
    expect(refused(src, "Size :=")).toBe(false);
  });

  it("keeps a global when the body calls another object (condition 3)", () => {
    // revert: drop the non-Record receiver check
    const src = shape({
      globals: 'Size: Integer;\n        Other: Codeunit "Other Rule B";',
      body: "Other.Poke();",
    }).replace("        Size: Integer;\n        \n", "\n");
    expect(refused(src, "Size :=")).toBe(false);
  });

  it("keeps a field (condition 4)", () => {
    // revert: refuse when resolveVarRef is null
    const src = `table 50131 "Rule B Tab"
{
    fields
    {
        field(1; Size; Integer) { }
    }

    procedure Run()
    var
        N: Integer;
    begin
        Size := 1000;
        repeat
            N := 0;
            N += 1;
        until N < Size;
    end;
}`;
    expect(refused(src, "Size :=")).toBe(false);
  });

  it("keeps a parameter (condition 4)", () => {
    // revert: drop the parameter check
    const src = shape({})
      .replace("procedure Run()", "procedure Run(Size: Integer)")
      .replace("        Size: Integer;\n", "");
    expect(refused(src, "Size :=")).toBe(false);
  });

  it("keeps it when N is not a counter that only climbs (condition 1)", () => {
    // revert: drop isUpCounter
    expect(refused(shape({ body: "N -= 2;" }), "Size :=")).toBe(false);
  });

  it("while: refuses a Boolean flag stuck true, keeps one stuck false", () => {
    // revert: swap the repeat/while polarity at the end of removedBoundHangs
    const w = (cond: string) => `codeunit 50132 "Rule B While"
{
    procedure Run()
    var
        Done: Boolean;
        N: Integer;
    begin
        Done := true;
        while ${cond} do
            N += 1;
    end;
}`;
    expect(refused(w("not Done"), "Done :=")).toBe(true);
    expect(refused(w("Done"), "Done :=")).toBe(false);
  });
});
