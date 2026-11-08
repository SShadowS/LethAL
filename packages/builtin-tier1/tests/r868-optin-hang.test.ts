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
import { recursionRule } from "../src/optin-hang";

/**
 * R868. The hang rules of the two opt-in operators. No live gate may hold a hang-capable site
 * (R164), so each refusal is proved here on a PARSED AL source, with a CONTROL beside it that must
 * still be claimed: a rule that refused everything goes red, and so does a rule that is off.
 * `refusesHangCapable` is read too, so a refusal is a counted hang refusal and not another reason.
 */
interface Seen {
  readonly claimed: string[];
  readonly hang: string[];
}

function seen(op: MutationOperator, src: string): Seen {
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

const header = `
    var
        Counter: Integer;
        Done: Boolean;
        Held: Integer;
        Queue: List of [Integer];
        R: Record Customer;
`;

/** #36: one `if C then ...` in `P`, `C` named by its own text. */
const ifUnit = (body: string, more = ""): string => `codeunit 51680 "C"
{${header}
    procedure P(Flag: Boolean; Restart: Boolean; Back: Boolean; Step: Integer; N: Integer; Level: Integer)
    var
        I: Integer;
        A: Boolean;
        Total: Decimal;
        R2: Record Customer;
    begin
${body}
    end;

    local procedure ResetCounter()
    begin
        Counter := 0;
    end;

    local procedure Other()
    begin
        Counter += 1;
    end;
${more}
}`;

const claimedIf = (src: string, cond: string): boolean =>
  seen(conditionTrue, src).claimed.some((t) => t.startsWith(`if ${cond} then`));
const refusedIf = (src: string, cond: string): boolean =>
  seen(conditionTrue, src).hang.some((t) => t.startsWith(`if ${cond} then`));

describe("R868 #36 condition-true: the then-arm hang rules", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("is opt-in, tier 1, 1.0.0", () => {
    expect(conditionTrue.optIn).toBe(true);
    expect(conditionTrue.tier).toBe(1);
    expect(conditionTrue.version).toBe("1.0.0");
    expect(blankArgument.optIn).toBe(true);
    expect(blankArgument.version).toBe("1.0.0");
  });

  // ---- the three shapes the opus review proved were claimed ----
  it("REFUSES a restart of the exit's cursor: repeat if Restart then R.FindFirst(); until R.Next()=0", () => {
    const src = ifUnit("R.FindSet(); repeat if Restart then R.FindFirst(); until R.Next() = 0;");
    expect(refusedIf(src, "Restart")).toBe(true);
    expect(claimedIf(src, "Restart")).toBe(false);
  });

  it("REFUSES a backward step: if Back then R.Next(-1)", () => {
    const src = ifUnit("R.FindSet(); repeat if Back then R.Next(-1); until R.Next() = 0;");
    expect(refusedIf(src, "Back")).toBe(true);
  });

  it("REFUSES a then-arm that holds a non-Next loop: if Step > 0 then while I<N do I += Step", () => {
    const src = ifUnit("if Step > 0 then while I < N do I += Step;");
    expect(refusedIf(src, "Step > 0")).toBe(true);
    expect(claimedIf(src, "Step > 0")).toBe(false);
  });

  it("REFUSES a repeat loop in the then-arm that does not step a cursor", () => {
    const src = ifUnit("if Flag then repeat I += Step; until I > N;");
    expect(refusedIf(src, "Flag")).toBe(true);
  });

  // ---- names the exit reads ----
  it("REFUSES a local the exit reads: I -= 1", () => {
    const src = ifUnit("while I < N do begin if Flag then I -= 1; I += 1; end;");
    expect(refusedIf(src, "Flag")).toBe(true);
  });

  it("REFUSES a flag the exit reads: A := false", () => {
    const src = ifUnit("repeat if Flag then A := false; Other(); until A;");
    expect(refusedIf(src, "Flag")).toBe(true);
  });

  it("REFUSES a write to a global the exit reads only through a helper: until Finished()", () => {
    const src = ifUnit(
      "repeat if Flag then Counter := 0; Other(); until Finished();",
      `
    local procedure Finished(): Boolean
    begin
        exit(Counter >= 3);
    end;`,
    );
    expect(refusedIf(src, "Flag")).toBe(true);
    // Control: the same loop, a then-arm that writes a name the helper does not read.
    const other = ifUnit(
      "repeat if Flag then Total := 0; Other(); until Finished();",
      `
    local procedure Finished(): Boolean
    begin
        exit(Counter >= 3);
    end;`,
    );
    expect(claimedIf(other, "Flag")).toBe(true);
  });

  it("REFUSES a helper that resets a name the exit reads", () => {
    const src = ifUnit("while Counter < N do begin if Flag then ResetCounter(); Other(); end;");
    expect(refusedIf(src, "Flag")).toBe(true);
  });

  it("REFUSES a requeue into the collection the exit reads", () => {
    const src = ifUnit(
      "while Queue.Count > 0 do begin if Flag then Queue.Add(1); Queue.RemoveAt(1); end;",
    );
    expect(refusedIf(src, "Flag")).toBe(true);
  });

  it("REFUSES R.Next() in the condition inside a loop (forced true, the step never runs)", () => {
    const src = ifUnit("while Counter < N do begin if R.Next() = 0 then Total += 1; Other(); end;");
    expect(refusedIf(src, "R.Next() = 0")).toBe(true);
  });

  it("still refuses a continue in the then-arm (R855's rule)", () => {
    const src = ifUnit("while I < N do begin if Flag then continue; I += 1; end;");
    expect(refusedIf(src, "Flag")).toBe(true);
  });

  // ---- recursion ----
  it("REFUSES a self-call under the guard: if Level < 10 then Self(Level + 1)", () => {
    const src = `codeunit 51681 "C"
{
    procedure Self(Level: Integer)
    begin
        if Level < 10 then
            Self(Level + 1);
    end;
}`;
    expect(refusedIf(src, "Level < 10")).toBe(true);
  });

  it("REFUSES a mutual recursion, one hop: A calls B and B calls A", () => {
    const src = `codeunit 51682 "C"
{
    procedure Ping(Level: Integer)
    begin
        if Level < 10 then
            Pong(Level + 1);
    end;

    procedure Pong(Level: Integer)
    begin
        Ping(Level);
    end;
}`;
    expect(refusedIf(src, "Level < 10")).toBe(true);
  });

  it("REFUSES a mutual recursion of three procedures", () => {
    const src = `codeunit 51683 "C"
{
    procedure A1(Level: Integer)
    begin
        if Level < 10 then
            B1(Level + 1);
    end;

    procedure B1(Level: Integer)
    begin
        C1(Level);
    end;

    procedure C1(Level: Integer)
    begin
        A1(Level);
    end;
}`;
    expect(refusedIf(src, "Level < 10")).toBe(true);
  });

  it("recursion off (the R865 seam): the self-call guard is claimed", () => {
    const src = `codeunit 51684 "C"
{
    procedure Self(Level: Integer)
    begin
        if Level < 10 then
            Self(Level + 1);
    end;
}`;
    recursionRule.on = false;
    try {
      expect(claimedIf(src, "Level < 10")).toBe(true);
    } finally {
      recursionRule.on = true;
    }
  });

  // ---- CONTROLS: each must stay claimed, or a rule is too wide ----
  it("CLAIMS a plain guard outside any loop", () => {
    expect(claimedIf(ifUnit("if Flag then Total := 1;"), "Flag")).toBe(true);
  });

  it("CLAIMS a field read and a field write on the cursor record, Modify and a plain Next()", () => {
    const src = ifUnit(
      "R.FindSet(); repeat if R.Amount > 5 then begin Total += R.Amount; R.Amount := 0; R.Modify(); end; until R.Next() = 0;",
    );
    expect(claimedIf(src, "R.Amount > 5")).toBe(true);
    const plain = ifUnit("R.FindSet(); repeat if Flag then R.Next(); until R.Next() = 0;");
    expect(claimedIf(plain, "Flag")).toBe(true);
  });

  it("CLAIMS a then-arm that writes a name the exit does not read", () => {
    const src = ifUnit("while I < N do begin if Flag then Total += 1; I += 1; end;");
    expect(claimedIf(src, "Flag")).toBe(true);
  });

  it("CLAIMS a then-arm with a cursor loop (Next) and a call that does not recurse", () => {
    const src = ifUnit(
      "if Flag then begin R2.FindSet(); repeat Total += 1; until R2.Next() = 0; end;",
    );
    expect(claimedIf(src, "Flag")).toBe(true);
    expect(claimedIf(ifUnit("if Flag then Other();"), "Flag")).toBe(true);
  });

  it("CLAIMS a guard whose callee calls something else, not back (no false recursion)", () => {
    const src = `codeunit 51685 "C"
{
    procedure A1(Level: Integer)
    begin
        if Level < 10 then
            B1(Level + 1);
    end;

    procedure B1(Level: Integer)
    begin
        Level += 1;
    end;
}`;
    expect(claimedIf(src, "Level < 10")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------
// #34
// ------------------------------------------------------------------------------------------

/** Claimed and hang-refused argument texts of `blankArgument`, whole-source. */
const blank = (src: string): Seen => seen(blankArgument, src);

const callUnit = (callee: string, more = "", caller = "Q(Step);"): string => `codeunit 51690 "C"
{${header}
    procedure P(Step: Integer)
    var
        Remaining: Integer;
        Next: Integer;
    begin
        ${caller}
    end;

    local procedure Q(Step: Integer)
    var
        I: Integer;
        N: Integer;
        L: Integer;
    begin
${callee}
    end;
${more}
}`;

describe("R868 #34 blank-argument: the callee-loop and recursion rules", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("CLAIMS a parameter the callee only uses once", () => {
    const s = blank(callUnit("Counter := Step;"));
    expect(s.claimed).toContain("Step");
    expect(s.hang).toEqual([]);
  });

  it("REFUSES a parameter read in a loop of the callee (the old one-hop rule)", () => {
    const s = blank(callUnit("while I < N do I += Step;"));
    expect(s.claimed).not.toContain("Step");
    expect(s.hang).toContain("Step");
  });

  it("REFUSES a copy: L := Step; while I < N do I += L", () => {
    const s = blank(callUnit("L := Step; while I < N do I += L;"));
    expect(s.hang).toContain("Step");
    expect(s.claimed).not.toContain("Step");
  });

  it("REFUSES a copy through arithmetic: L := Step * 2", () => {
    const s = blank(callUnit("L := Step * 2; while I < N do I += L;"));
    expect(s.hang).toContain("Step");
  });

  it("REFUSES a copy of a copy", () => {
    const s = blank(callUnit("N := Step; L := N; while I < 9 do I += L;"));
    expect(s.hang).toContain("Step");
  });

  it("REFUSES a setter into a global that a loop of the object reads", () => {
    const s = blank(
      callUnit(
        "Held := Step;",
        `
    local procedure Spin()
    var
        K: Integer;
    begin
        while K < 100 do
            K += Held;
    end;`,
      ),
    );
    expect(s.hang).toContain("Step");
    expect(s.claimed).not.toContain("Step");
  });

  it("CLAIMS a parameter when only ANOTHER procedure's own local of that name is read in a loop", () => {
    const s = blank(
      callUnit(
        "Counter := Step;",
        `
    local procedure Elsewhere()
    var
        Step: Integer;
        K: Integer;
    begin
        while K < 100 do
            K += Step + 1;
    end;`,
      ),
    );
    expect(s.claimed).toContain("Step");
  });

  it("CLAIMS a setter into a global no loop reads", () => {
    const s = blank(callUnit("Held := Step;"));
    expect(s.claimed).toContain("Step");
  });

  it("REFUSES a value handed to another procedure that loops on it (followed)", () => {
    const s = blank(
      callUnit(
        "Inner(Step);",
        `
    local procedure Inner(Delta: Integer)
    var
        K: Integer;
    begin
        while K < 100 do
            K += Delta;
    end;`,
      ),
    );
    // Two sites read `Step`: P's `Q(Step)` (refused only by FOLLOWING the hop) and Q's own
    // `Inner(Step)` (refused because Inner loops on its parameter).
    expect(s.hang.filter((t) => t === "Step").length).toBe(2);
    expect(s.claimed).not.toContain("Step");
  });

  it("REFUSES a value stored in a collection that a loop reads", () => {
    const s = blank(callUnit("Queue.Add(Step); while Queue.Count > 0 do Queue.RemoveAt(1);"));
    expect(s.hang).toContain("Step");
  });

  it("REFUSES caller progress: Remaining := Consume(Remaining) under a loop on Remaining", () => {
    const s = blank(
      callUnit(
        "Counter := Step;",
        `
    local procedure Consume(Left: Integer): Integer
    begin
        exit(Left - 1);
    end;`,
        "Remaining := 5; while Remaining > 0 do Remaining := Consume(Remaining);",
      ),
    );
    expect(s.hang).toContain("Remaining");
    expect(s.claimed).not.toContain("Remaining");
  });

  it("REFUSES the depth of a self-call: Next := Level + 1; Self(Next)", () => {
    const src = `codeunit 51691 "C"
{
    procedure Self(Level: Integer)
    var
        Next: Integer;
    begin
        if Level < 10 then begin
            Next := Level + 1;
            Self(Next);
        end;
    end;
}`;
    const s = blank(src);
    expect(s.hang).toContain("Next");
    expect(s.claimed).not.toContain("Next");
  });

  it("REFUSES a mutual recursion, one hop: Ping(Level) calls Pong(Next) and Pong calls Ping", () => {
    const src = `codeunit 51692 "C"
{
    procedure Ping(Level: Integer)
    var
        Next: Integer;
    begin
        if Level < 10 then begin
            Next := Level + 1;
            Pong(Next);
        end;
    end;

    procedure Pong(Depth: Integer)
    begin
        Ping(Depth);
    end;
}`;
    const s = blank(src);
    expect(s.hang).toContain("Next");
    expect(s.claimed).not.toContain("Next");
  });

  it("recursion off (the R865 seam): the self-call argument is claimed", () => {
    const src = `codeunit 51693 "C"
{
    procedure Self(Level: Integer)
    var
        Next: Integer;
    begin
        if Level < 10 then begin
            Next := Level + 1;
            Self(Next);
        end;
    end;
}`;
    recursionRule.on = false;
    try {
      expect(blank(src).claimed).toContain("Next");
    } finally {
      recursionRule.on = true;
    }
  });

  it("CLAIMS an argument of a procedure that does not lead back to the caller", () => {
    const src = `codeunit 51694 "C"
{${header}
    procedure Caller(Level: Integer)
    var
        Next: Integer;
    begin
        Next := Level + 1;
        Leaf(Next);
    end;

    procedure Leaf(Depth: Integer)
    begin
        Counter := Depth;
    end;
}`;
    expect(blank(src).claimed).toContain("Next");
  });
});
