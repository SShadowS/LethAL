import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  type MutationOperator,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { blankArgument } from "../src/blank-argument";
import { conditionTrue } from "../src/condition-true";

/**
 * R868 build review. Self-calls through a codeunit variable of the object's own type, a
 * `Codeunit.Run` of the object itself, a bare `true` operand (dedupe), and the narrowed callee-loop
 * rule of `blank-argument` (a `for` and a cursor loop are claimed, a `while` is still refused).
 */
function seen(op: MutationOperator, src: string): { claimed: string[]; hang: string[] } {
  const root = wrapRoot(parseAL(src));
  expect(root.hasError).toBe(false);
  const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
  const claimed: string[] = [];
  const hang: string[] = [];
  visit(root, (n: ALSyntaxNode) => {
    const on = op.targets(n, ctx);
    expect(on, `targets() and generate() disagree at ${n.text}`).toBe(
      op.generate(n, ctx).length > 0,
    );
    if (on) claimed.push(n.text);
    if (op.refusesHangCapable?.(n, ctx) === true) hang.push(n.text);
  });
  return { claimed, hang };
}

const cond = (src: string, c: string) => ({
  claimed: seen(conditionTrue, src).claimed.some((t) => t.startsWith(`if ${c} then`)),
  refused: seen(conditionTrue, src).hang.some((t) => t.startsWith(`if ${c} then`)),
});

describe("R868 review: self-calls through a codeunit variable (#36)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("REFUSES if L < 10 then Me.Rec(L + 1) with Me: Codeunit of its own type", () => {
    const src = `codeunit 51700 "C"
{
    procedure Rec(L: Integer)
    var
        Me: Codeunit "C";
    begin
        if L < 10 then
            Me.Rec(L + 1);
    end;
}`;
    expect(cond(src, "L < 10")).toEqual({ claimed: false, refused: true });
  });

  it("REFUSES a mutual recursion whose first hop is a call through the variable", () => {
    const src = `codeunit 51701 "C"
{
    procedure Ping(L: Integer)
    var
        Me: Codeunit "C";
    begin
        if L < 10 then
            Me.Pong(L + 1);
    end;

    procedure Pong(L: Integer)
    var
        Me: Codeunit "C";
    begin
        Me.Ping(L);
    end;
}`;
    expect(cond(src, "L < 10")).toEqual({ claimed: false, refused: true });
  });

  it("CLAIMS a call through a variable of ANOTHER codeunit type, and one that does not lead back", () => {
    const src = `codeunit 51702 "C"
{
    procedure Go(L: Integer)
    var
        Other: Codeunit "D";
        Me: Codeunit "C";
    begin
        if L < 10 then
            Other.Go(L + 1);
        if L < 5 then
            Me.Leaf(L);
    end;

    procedure Leaf(L: Integer)
    begin
        L += 1;
    end;
}`;
    expect(cond(src, "L < 10").claimed).toBe(true);
    expect(cond(src, "L < 5").claimed).toBe(true);
  });

  it('REFUSES Codeunit.Run(Codeunit::"C") and Me.Run() in the then-arm of the codeunit itself', () => {
    const run = `codeunit 51703 "C"
{
    trigger OnRun()
    var
        Flag: Boolean;
    begin
        if Flag then
            Codeunit.Run(Codeunit::"C");
    end;
}`;
    expect(cond(run, "Flag")).toEqual({ claimed: false, refused: true });
    const me = `codeunit 51704 "C"
{
    trigger OnRun()
    var
        Flag: Boolean;
        Me: Codeunit "C";
    begin
        if Flag then
            Me.Run();
    end;
}`;
    expect(cond(me, "Flag")).toEqual({ claimed: false, refused: true });
  });

  it("CLAIMS Codeunit.Run of another codeunit", () => {
    const src = `codeunit 51705 "C"
{
    trigger OnRun()
    var
        Flag: Boolean;
    begin
        if Flag then
            Codeunit.Run(Codeunit::"D");
    end;
}`;
    expect(cond(src, "Flag").claimed).toBe(true);
  });
});

describe("R868 review: #34 recursion through a codeunit variable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("REFUSES the depth argument of Me.Rec(Next)", () => {
    const src = `codeunit 51706 "C"
{
    procedure Rec(L: Integer)
    var
        Me: Codeunit "C";
        Next: Integer;
    begin
        Next := L + 1;
        if L < 10 then
            Me.Rec(Next);
    end;
}`;
    const s = seen(blankArgument, src);
    expect(s.hang).toContain("Next");
    expect(s.claimed).not.toContain("Next");
  });
});

describe("R868 review: a bare `true` operand (dedupe with delete-logical)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const unit = (c: string) => `codeunit 51707 "C"
{
    procedure P(A: Boolean)
    var
        N: Integer;
    begin
        if ${c} then
            N := 1;
    end;
}`;

  it("refuses A and true, true or A, true and A, A or TRUE", () => {
    for (const c of ["A and true", "true or A", "true and A", "A or TRUE"]) {
      expect(seen(conditionTrue, unit(c)).claimed).toEqual([]);
    }
  });

  it("CLAIMS a logical condition without a bare true, and one with true inside parentheses", () => {
    expect(seen(conditionTrue, unit("A and not A")).claimed.length).toBe(1);
    expect(seen(conditionTrue, unit("A and (true or A)")).claimed.length).toBe(1);
  });
});

describe("R868 review: blank-argument callee-loop rule, narrowed", () => {
  beforeAll(async () => {
    await initParser();
  });

  const unit = (callee: string, more = "") => `codeunit 51708 "C"
{
    var
        R: Record Customer;

    procedure P(Step: Integer)
    begin
        Q(Step);
    end;

    local procedure Q(Step: Integer)
    var
        I: Integer;
        Total: Integer;
    begin
${callee}
    end;
${more}
}`;

  it("CLAIMS a parameter read in a for loop (the bound is read once)", () => {
    expect(seen(blankArgument, unit("for I := 1 to 5 do Total += Step;")).claimed).toContain(
      "Step",
    );
  });

  it("CLAIMS a parameter read in a loop that steps a record cursor", () => {
    const s = seen(
      blankArgument,
      unit("R.SetRange(Id, Step); R.FindSet(); repeat Total += 1; until R.Next() = 0;"),
    );
    expect(s.claimed).toContain("Step");
  });

  it("still REFUSES a while on the blanked value, also inside a for", () => {
    expect(seen(blankArgument, unit("while I < 10 do I += Step;")).hang).toContain("Step");
    expect(
      seen(blankArgument, unit("for Total := 1 to 3 do while I < 10 do I += Step;")).hang,
    ).toContain("Step");
  });

  it("still REFUSES a repeat without a cursor step on the blanked value", () => {
    expect(seen(blankArgument, unit("repeat I += Step; until I > 10;")).hang).toContain("Step");
  });
});
