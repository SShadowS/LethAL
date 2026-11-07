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

  it("REFUSES a parameter read in a loop that steps a record cursor (no cursor skip any more)", () => {
    const s = seen(
      blankArgument,
      unit("R.SetRange(Id, Step); R.FindSet(); repeat Total += 1; until R.Next() = 0;"),
    );
    expect(s.hang).toContain("Step");
    expect(s.claimed).not.toContain("Step");
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

describe("R868 review 3: the cursor-loop and for skips are narrow", () => {
  beforeAll(async () => {
    await initParser();
  });

  const unit = (callee: string) => `codeunit 50100 "C"
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
        J: Integer;
        Total: Integer;
        RR: RecordRef;
        Q: Codeunit "D";
    begin
${callee}
    end;

    local procedure Show(var Rec2: Record Customer)
    begin
    end;
}`;
  const refused = (callee: string) => {
    const s = seen(blankArgument, unit(callee));
    return s.hang.includes("Step") && !s.claimed.includes("Step");
  };
  const claimed = (callee: string) => seen(blankArgument, unit(callee)).claimed.includes("Step");

  it("REFUSES a cursor step joined by and: until (R.Next() = 0) and (J >= 100)", () => {
    expect(refused("repeat J += Step; until (R.Next() = 0) and (J >= 100);")).toBe(true);
  });

  it("REFUSES a body that restarts the cursor", () => {
    expect(refused("repeat J += 1; if J > Step then R.FindFirst(); until R.Next() = 0;")).toBe(
      true,
    );
  });

  it("REFUSES a body that resets, rereads, steps with an argument, or passes the cursor whole", () => {
    expect(refused("repeat Total += Step; R.Reset(); until R.Next() = 0;")).toBe(true);
    expect(refused("repeat Total += Step; R.Get(1); until R.Next() = 0;")).toBe(true);
    expect(refused("repeat Total += Step; R.Next(-1); until R.Next() = 0;")).toBe(true);
    expect(refused("repeat Total += Step; Show(R); until R.Next() = 0;")).toBe(true);
  });

  it("REFUSES a user codeunit's Next and a Next with an argument", () => {
    expect(refused("repeat J += Step; until (Q.Next() = 0) and (J > 100);")).toBe(true);
    expect(refused("repeat J += Step; until Q.Next() = 0;")).toBe(true);
    expect(refused("repeat Total += 1; until R.Next(Step) = 0;")).toBe(true);
  });

  it("REFUSES a for loop whose body assigns the control variable", () => {
    expect(refused("for I := 1 to 10 do I := I + Step - 1;")).toBe(true);
  });

  it("REFUSES every plain cursor loop that reads the value, whatever its exit", () => {
    expect(refused("repeat Total += Step; until R.Next() = 0;")).toBe(true);
    expect(refused("repeat Total += Step; until (R.Next() = 0) or (Total > 5);")).toBe(true);
    expect(refused("repeat Total += Step; until RR.Next() = 0;")).toBe(true);
    expect(refused("while R.Next() <> 0 do Total += Step;")).toBe(true);
    expect(refused("repeat R.Qty := Step; R.Modify(); until R.Next() = 0;")).toBe(true);
  });

  it("REFUSES a for loop that passes the control variable to a call (it could be var), or compounds it", () => {
    expect(refused("for I := 1 to 10 do if I > Step then Zero(I);")).toBe(true);
    expect(refused("for I := 1 to 10 do if I > Step then I -= 1;")).toBe(true);
    expect(refused("for I := 1 to 10 do if I > Step then I := 0;")).toBe(true);
    // A parameter as control variable (it could be var): not a local.
    expect(refused("for Step := 1 to 10 do Total += Step;")).toBe(true);
  });

  it("CLAIMS a for loop whose body neither assigns nor passes the control variable, or reads it only in a bound", () => {
    expect(claimed("for I := 1 to 10 do Total += Step;")).toBe(true);
    expect(claimed("for I := 1 to Step do Total += 1;")).toBe(true);
    expect(claimed("for I := 1 to 10 do Total += I * Step;")).toBe(true);
  });
});

/**
 * Every cursor-loop shape the reviews probed (c5, c6, c7). None may be claimed, so a future widening
 * of the loop skip fails here. The blanked site is `Spin(K)` in `Caller`.
 */
describe("R868 review 4: the probed cursor-loop escapes stay refused", () => {
  beforeAll(async () => {
    await initParser();
  });

  const cu = (s: string, g = "") => `codeunit 50100 "C"
{
${g}
procedure Caller(N: Integer) var K: Integer; begin K := N; Spin(K); end;
${s}
}`;
  const P =
    "procedure Spin(S: Integer) var J: Integer; R: Record Customer; begin if R.FindSet() then repeat J += 1; ";
  const SHAPES: Record<string, string> = {
    c5_and_exit: cu(
      "procedure Spin(S: Integer) var J: Integer; R: Record Customer; begin if R.FindSet() then repeat J += S; until (R.Next() = 0) and (J >= 100); end;",
    ),
    c5_next_step: cu(
      "procedure Spin(S: Integer) var R: Record Customer; begin if R.FindSet() then repeat until R.Next(S) = 0; end;",
    ),
    c5_findfirst: cu(
      "procedure Spin(S: Integer) var J: Integer; R: Record Customer; begin if R.FindSet() then repeat J += 1; if J < S then R.FindFirst(); until R.Next() = 0; end;",
    ),
    c5_filter: cu(
      "procedure Spin(S: Integer) var R: Record Customer; begin if R.FindSet() then repeat R.SetFilter(\"No.\", '>%1', Format(S)); R.FindFirst(); until R.Next() = 0; end;",
    ),
    c5_for_while: cu(
      "procedure Spin(S: Integer) var I: Integer; J: Integer; begin for I := 1 to 3 do while J < 100 do J += S; end;",
    ),
    c5_for_ctl: cu(
      "procedure Spin(S: Integer) var I: Integer; begin for I := 1 to 10 do I := I + S - 1; end;",
    ),
    c5_user_next: cu(
      "procedure Spin(S: Integer) var Q: Codeunit D; J: Integer; begin repeat J += S; until (Q.Next() = 0) and (J > 100); end;",
    ),
    c6_findfirst_rev: cu(
      "procedure Spin(S: Integer) var J: Integer; R: Record Customer; begin if R.FindSet() then repeat J += 1; if J > S then R.FindFirst(); until R.Next() = 0; end;",
    ),
    c6_or_exit: cu(
      "procedure Spin(S: Integer) var J: Integer; R: Record Customer; begin if R.FindSet() then repeat J += S; until (R.Next() = 0) or (J >= 100); end;",
    ),
    c7_helper_global: cu(
      "procedure Spin(S: Integer) var J: Integer; begin if G.FindSet() then repeat J += 1; if J > S then Rewind(); until G.Next() = 0; end;\nprocedure Rewind() begin G.FindFirst(); end;",
      "var G: Record Customer;",
    ),
    c7_ascending: cu(`${P}if J > S then R.Ascending(not R.Ascending()); until R.Next() = 0; end;`),
    c7_key_field: cu(`${P}if J > S then R."No." := ''; until R.Next() = 0; end;`),
    c7_validate_key: cu(`${P}if J > S then R.Validate("No.", ''); until R.Next() = 0; end;`),
    c7_temp_insert_ahead: cu(
      'procedure Spin(S: Integer) var J: Integer; R: Record "Integer" temporary; begin R.Number := 1; R.Insert(); if R.FindSet() then repeat J += 1; if J > S then begin R.Number += 1; R.Insert(); end; until R.Next() = 0; end;',
    ),
    c7_recref_alias: cu(
      "procedure Spin(S: Integer) var J: Integer; RR: RecordRef; RR2: RecordRef; begin RR.Open(18); RR2 := RR; if RR.FindSet() then repeat J += 1; if J > S then RR2.FindFirst(); until RR.Next() = 0; end;",
    ),
    c7_recref_reopen: cu(
      "procedure Spin(S: Integer) var J: Integer; RR: RecordRef; begin RR.Open(18); if RR.FindSet() then repeat J += 1; if J > S then begin RR.Close(); RR.Open(18); RR.FindSet(); end; until RR.Next() = 0; end;",
    ),
    c7_for_var_call: cu(
      "procedure Spin(S: Integer) var I: Integer; begin for I := 1 to 10 do if I > S then Zero(I); end;\nprocedure Zero(var X: Integer) begin X := 0; end;",
    ),
    c7_for_compound: cu(
      "procedure Spin(S: Integer) var I: Integer; begin for I := 1 to 10 do if I > S then I -= 1; end;",
    ),
    c7_or_operand_helper: cu(
      "procedure Spin(S: Integer) var J: Integer; begin if G.FindSet() then repeat J += 1; until (G.Next() = 0) or Rew(J, S); end;\nprocedure Rew(J: Integer; S: Integer): Boolean begin if J > S then G.FindFirst(); exit(false); end;",
      "var G: Record Customer;",
    ),
    c8_global_ctrl_helper: cu(
      "procedure Spin(S: Integer) begin for G := 1 to 10 do if G > S then Rewind(); end;\nprocedure Rewind() begin G := 0; end;",
      "var G: Integer;",
    ),
    c8_global_ctrl_helper_arg: cu(
      "procedure Spin(S: Integer) begin for G := 1 to 10 do if G > S then Rewind(1); end;\nprocedure Rewind(X: Integer) begin G := X; end;",
      "var G: Integer;",
    ),
    c8_global_ctrl_this: cu(
      "procedure Spin(S: Integer) begin for G := 1 to 10 do if G > S then this.Rewind(); end;\nprocedure Rewind() begin G := 0; end;",
      "var G: Integer;",
    ),
    c8_global_ctrl_untouched: cu(
      "procedure Spin(S: Integer) var J: Integer; begin for G := 1 to 10 do J += S; end;",
      "var G: Integer;",
    ),
  };

  for (const [name, src] of Object.entries(SHAPES)) {
    it(`REFUSES ${name}`, () => {
      const s = seen(blankArgument, src);
      expect(s.hang).toContain("K");
      expect(s.claimed).not.toContain("K");
    });
  }

  it("CLAIMS the safe control: a for loop that only counts", () => {
    const s = seen(
      blankArgument,
      cu(
        "procedure Spin(S: Integer) var I: Integer; J: Integer; begin for I := 1 to S do J += 1; end;",
      ),
    );
    expect(s.claimed).toContain("K");
  });
});

describe("R868 review 3: own-type codeunit by id and by namespace", () => {
  beforeAll(async () => {
    await initParser();
  });

  const unit = (body: string) => `codeunit 50100 "C"
{
    procedure Go(L: Integer)
    var
        X: Codeunit ${body};
    begin
        if L < 10 then
            X.Go(L + 1);
    end;
}`;

  it("REFUSES a variable declared by the object's own id, and by a namespace-qualified name", () => {
    expect(cond(unit("50100"), "L < 10")).toEqual({ claimed: false, refused: true });
    expect(cond(unit('My.Ns."C"'), "L < 10")).toEqual({ claimed: false, refused: true });
    expect(cond(unit("C"), "L < 10")).toEqual({ claimed: false, refused: true });
  });

  it("CLAIMS a variable of another codeunit by id, or by a namespace-qualified other name", () => {
    expect(cond(unit("50101"), "L < 10").claimed).toBe(true);
    expect(cond(unit('My.Ns."D"'), "L < 10").claimed).toBe(true);
  });

  it("REFUSES Codeunit.Run(50100) in the codeunit's OnRun, CLAIMS Codeunit.Run(50101)", () => {
    const run = (id: string) => `codeunit 50100 "C"
{
    trigger OnRun()
    var
        G: Integer;
    begin
        if G < 10 then
            Codeunit.Run(${id});
    end;
}`;
    expect(cond(run("50100"), "G < 10")).toEqual({ claimed: false, refused: true });
    expect(cond(run("50101"), "G < 10").claimed).toBe(true);
  });
});
