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
import { classifyHangCapable, hangCapableForMutatedNode } from "../src/loop-hazard";

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** Is the statement call with this text refused at dispatch? */
function refused(body: string, call: string): boolean {
  const { root, ctx } = load(`codeunit 50830 "R" {
    var Counter: Integer; Log: Integer; Other: Codeunit "Other"; S: InStream; Items: List of [Integer]; Q: Record Customer;
    ${body} }`);
  const site = findAll(root, ALNodeKind.procedure_call).find((n) => n.text === call);
  if (site === undefined) throw new Error(`no call ${call}`);
  return openItemHangRefuses(site, ctx, "lethal.void-method-call");
}

describe("R830: a statement call a loop's progress may rest on", () => {
  beforeAll(async () => {
    await initParser();
  });

  describe("shape 1, the receiver", () => {
    it("refuses a read under EOS, which only asks", () => {
      expect(
        refused(
          `procedure P() var T: Text; begin while not S.EOS() do S.ReadText(T); end;`,
          "S.ReadText(T)",
        ),
      ).toBe(true);
    });

    it("refuses a call on a receiver the condition reads with a method that does not step", () => {
      expect(
        refused(
          `procedure P() begin while Items.Contains(1) do Items.Remove(1); end;`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
    });

    it("keeps a call that is not a statement: deleting it is not what is asked", () => {
      expect(
        refused(
          `procedure P() var I: Integer; begin while I > 0 do if Keep(I) then Log += 1; end;`,
          "Keep(I)",
        ),
      ).toBe(false);
    });

    it("asks every enclosing loop, the outer one's condition", () => {
      expect(
        refused(
          `procedure P() begin while Items.Contains(1) do repeat Items.Remove(1); until Q.Next() = 0; end;`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
    });

    it("asks every enclosing loop, the inner one's condition", () => {
      expect(
        refused(
          `procedure P() begin repeat while Items.Contains(1) do Items.Remove(1); until Q.Next() = 0; end;`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
    });

    for (const step of ["Next", "Read", "MoveNext"]) {
      it(`keeps a call when the condition steps that receiver with ${step}`, () => {
        expect(
          refused(
            `procedure P(var C: Record Customer) begin repeat C.Modify(); until C.${step}() = 0; end;`,
            "C.Modify()",
          ),
        ).toBe(false);
      });
    }

    it("keeps a call on a receiver no loop reads", () => {
      expect(
        refused(
          `procedure P() begin while Counter < 3 do begin Other.Run(); Counter += 1; end; end;`,
          "Other.Run()",
        ),
      ).toBe(false);
    });

    it("keeps the same call outside a loop", () => {
      expect(refused(`procedure P() var T: Text; begin S.ReadText(T); end;`, "S.ReadText(T)")).toBe(
        false,
      );
    });

    it("reads the exit parts, so a value fed from the receiver is seen", () => {
      expect(
        refused(
          `procedure P() var D: Integer; begin while D > 0 do begin Other.Step(); D := Other.Value(); end; end;`,
          "Other.Step()",
        ),
      ).toBe(true);
    });

    it("reads the exit parts, so a guard in a `while true` is seen", () => {
      expect(
        refused(
          `procedure P() begin while true do begin Items.RemoveAt(1); if Items.Count() = 0 then exit; end; end;`,
          "Items.RemoveAt(1)",
        ),
      ).toBe(true);
    });
  });

  describe("shape 2(a), a plain-name argument", () => {
    it("refuses a call on another receiver whose argument the condition reads", () => {
      expect(
        refused(
          `procedure P() var L: Text; begin while L <> '' do S.ReadText(L); end;`,
          "S.ReadText(L)",
        ),
      ).toBe(true);
    });

    it("refuses a bare call whose argument the condition reads", () => {
      expect(
        refused(`procedure P() var I: Integer; begin while I > 0 do Chop(I); end;`, "Chop(I)"),
      ).toBe(true);
    });

    it("reads an element as its array", () => {
      expect(
        refused(
          `procedure P() var B: array[2] of Integer; begin while B[1] > 0 do Chop(B[1]); end;`,
          "Chop(B[1])",
        ),
      ).toBe(true);
    });

    it("keeps an argument the condition does not read", () => {
      expect(
        refused(
          `procedure P() var I: Integer; begin while Counter > 0 do begin Chop(I); Counter -= 1; end; end;`,
          "Chop(I)",
        ),
      ).toBe(false);
    });

    it("keeps an argument the condition steps", () => {
      expect(
        refused(
          `procedure P(var C: Record Customer) begin repeat Keep(C); until C.Next() = 0; end;`,
          "Keep(C)",
        ),
      ).toBe(false);
    });
  });

  describe("shape 2(b), a same-object callee", () => {
    const ADVANCE = `local procedure Advance() begin Counter += 1; end;`;

    it("refuses a bare call whose callee writes a global the condition reads", () => {
      expect(
        refused(
          `procedure P() begin repeat Advance(); until Counter >= 3; end; ${ADVANCE}`,
          "Advance()",
        ),
      ).toBe(true);
    });

    it("follows the chain with no hop limit", () => {
      const chain = `local procedure A() begin B(); end; local procedure B() begin C(); end; local procedure C() begin Counter += 1; end;`;
      expect(
        refused(`procedure P() begin repeat A(); until Counter >= 3; end; ${chain}`, "A()"),
      ).toBe(true);
    });

    it("survives recursion", () => {
      const rec = `local procedure A() begin A(); Counter += 1; end;`;
      expect(
        refused(`procedure P() begin repeat A(); until Counter >= 3; end; ${rec}`, "A()"),
      ).toBe(true);
    });

    it("reads a global through the condition's own call", () => {
      const done = `local procedure Done(): Boolean begin exit(Counter > 3); end;`;
      expect(
        refused(
          `procedure P() begin repeat Advance(); until Done(); end; ${ADVANCE} ${done}`,
          "Advance()",
        ),
      ).toBe(true);
    });

    it("keeps it when the condition's own call steps that global", () => {
      const done = `local procedure Done(): Boolean begin exit(R.Next() = 0); end;`;
      const adv = `local procedure Touch() begin R.Modify(); end;`;
      const src = `var R: Record Customer; procedure P() begin repeat Touch(); until Done(); end; ${adv} ${done}`;
      expect(refused(src, "Touch()")).toBe(false);
    });

    it("keeps a callee that writes something else", () => {
      const noise = `local procedure Noise() begin Log += 1; end;`;
      expect(
        refused(
          `procedure P() begin while Counter < 3 do begin Noise(); Counter += 1; end; end; ${noise}`,
          "Noise()",
        ),
      ).toBe(false);
    });

    it("keeps a callee that only READS what the condition reads", () => {
      const look = `local procedure Look() begin if Counter = 2 then Log := 1; end;`;
      expect(
        refused(
          `procedure P() begin while Counter < 3 do begin Look(); Counter += 1; end; end; ${look}`,
          "Look()",
        ),
      ).toBe(false);
    });

    it("a callee's local of the same name is not the global", () => {
      const shadow = `local procedure Shadow() var Counter: Integer; begin Counter += 1; end;`;
      expect(
        refused(
          `procedure P() begin while Counter < 3 do begin Shadow(); Counter += 1; end; end; ${shadow}`,
          "Shadow()",
        ),
      ).toBe(false);
    });

    it("a callee that calls a method on what the condition reads", () => {
      const step = `local procedure Step() begin Items.Remove(1); end;`;
      expect(
        refused(`procedure P() begin while Items.Contains(1) do Step(); end; ${step}`, "Step()"),
      ).toBe(true);
    });

    it("a callee that passes on what the condition reads", () => {
      const step = `local procedure Step() begin Bump(Counter); end;`;
      expect(
        refused(`procedure P() begin while Counter < 3 do Step(); end; ${step}`, "Step()"),
      ).toBe(true);
    });

    it("a callee's `for` control variable is a write", () => {
      const step = `local procedure Step() begin for Counter := 1 to 5 do Log += 1; end;`;
      expect(
        refused(`procedure P() begin while Counter < 3 do Step(); end; ${step}`, "Step()"),
      ).toBe(true);
    });

    it("`this.` is a same-object call, at the site and in the condition", () => {
      const done = `local procedure Done(): Boolean begin exit(Counter > 3); end;`;
      const src = `procedure P() begin repeat this.Advance(); until this.Done(); end; ${ADVANCE} ${done}`;
      expect(refused(src, "this.Advance()")).toBe(true);
    });

    it("a paren-less call is followed in a chain and in a value", () => {
      const a = `local procedure A() begin Advance; end;`;
      const over = `local procedure Over(): Boolean begin exit(Counter > 3); end;`;
      const done = `local procedure Done(): Boolean begin exit(Over); end;`;
      const src = `procedure P() begin repeat A(); until Done(); end; ${ADVANCE} ${a} ${over} ${done}`;
      expect(refused(src, "A()")).toBe(true);
    });

    it("a global declared inside `#if` is still the loop's name", () => {
      const { root, ctx } = load(`codeunit 50834 "R" {
        var
#if not LETHALX
          Hidden: Integer;
#endif
          Log: Integer;
        procedure P() begin repeat Up(); until Hidden >= 3; end;
        local procedure Up() begin Hidden += 1; end; }`);
      const site = findAll(root, ALNodeKind.procedure_call).find((n) => n.text === "Up()");
      if (site === undefined) throw new Error("no call");
      expect(openItemHangRefuses(site, ctx, undefined)).toBe(true);
    });

    for (const [name, write] of [
      ["a bare field", "Qty += 1"],
      ["`Rec.`", "Rec.Qty += 1"],
    ] as const) {
      it(`a table's field written as ${name}`, () => {
        const { root, ctx } = load(`table 50835 "T" { fields { field(1; Qty; Integer) { } }
          procedure P() begin repeat StepIt(); until Qty >= 3; end;
          local procedure StepIt() begin ${write}; end; }`);
        const site = findAll(root, ALNodeKind.procedure_call).find((n) => n.text === "StepIt()");
        if (site === undefined) throw new Error("no call");
        expect(openItemHangRefuses(site, ctx, undefined)).toBe(true);
      });
    }

    const tableCase = (body: string, call: string): boolean => {
      const { root, ctx } = load(
        `table 50838 "T" { fields { field(1; Qty; Integer) { } } ${body} }`,
      );
      const site = findAll(root, ALNodeKind.procedure_call).find((n) => n.text === call);
      if (site === undefined) throw new Error(`no call ${call}`);
      return openItemHangRefuses(site, ctx, undefined);
    };
    const STEP_IT = `local procedure StepIt() begin Qty += 1; end;`;

    it("a field the condition's callee reads through `Rec.`", () => {
      const done = `local procedure Done(): Boolean begin exit(Rec.Qty > 3); end;`;
      expect(
        tableCase(
          `procedure P() begin repeat StepIt(); until Done(); end; ${STEP_IT} ${done}`,
          "StepIt()",
        ),
      ).toBe(true);
    });

    it("`Rec.P()` is a same-object call, at the site and in a chain", () => {
      expect(
        tableCase(
          `procedure P() begin repeat Rec.StepIt(); until Qty >= 3; end; ${STEP_IT}`,
          "Rec.StepIt()",
        ),
      ).toBe(true);
      const a = `local procedure A() begin Rec.StepIt(); end;`;
      expect(
        tableCase(`procedure P() begin repeat A(); until Qty >= 3; end; ${STEP_IT} ${a}`, "A()"),
      ).toBe(true);
    });

    it("`CurrReport.P()` is a same-object call at the site", () => {
      const { root, ctx } = load(`report 50839 "R" { var Counter: Integer;
        procedure P() begin repeat CurrReport.Advance(); until Counter >= 3; end;
        local procedure Advance() begin Counter += 1; end; }`);
      const site = findAll(root, ALNodeKind.procedure_call).find(
        (n) => n.text === "CurrReport.Advance()",
      );
      if (site === undefined) throw new Error("no call");
      expect(openItemHangRefuses(site, ctx, undefined)).toBe(true);
    });

    it("a callee's `foreach` control variable is a write", () => {
      const step = `local procedure Step() begin foreach Counter in Items do Log += 1; end;`;
      expect(
        refused(`procedure P() begin while Counter < 3 do Step(); end; ${step}`, "Step()"),
      ).toBe(true);
    });

    it("a callee's named return is its own, not the caller's name", () => {
      const done = `local procedure Done() Items: Record Customer begin Items.Next(); end;`;
      expect(
        refused(
          `procedure P() begin repeat Items.Remove(1); until Items.Contains(1) or Done(); end; ${done}`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
    });

    it("an option value named like a procedure is not a call to it", () => {
      const stepper = `local procedure Flag(): Boolean begin exit(Items.Next() = 0); end;`;
      expect(
        refused(
          `procedure P() var S: Option Flag; begin repeat Items.Remove(1); until Items.Contains(1) or (S = S::Flag); end; ${stepper}`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
    });

    it("a field the condition reads through `Rec.`", () => {
      const { root, ctx } = load(`table 50836 "T" { fields { field(1; Qty; Integer) { } }
        procedure P() begin repeat StepIt(); until Rec.Qty >= 3; end;
        local procedure StepIt() begin Qty += 1; end; }`);
      const site = findAll(root, ALNodeKind.procedure_call).find((n) => n.text === "StepIt()");
      if (site === undefined) throw new Error("no call");
      expect(openItemHangRefuses(site, ctx, undefined)).toBe(true);
    });

    it("a local in the condition's callee does not step the caller's global", () => {
      const done = `local procedure Done(): Boolean var Items: Record Customer; begin exit(Items.Next() = 0); end;`;
      expect(
        refused(
          `procedure P() begin repeat Items.Remove(1); until Items.Contains(1) or Done(); end; ${done}`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
    });

    it("a local read in the condition's callee is not the caller's global", () => {
      const look = `local procedure Look(): Boolean var Counter: Integer; begin exit(Counter > 3); end;`;
      expect(
        refused(
          `procedure P() begin repeat Advance(); until Look(); end; ${look} ${ADVANCE}`,
          "Advance()",
        ),
      ).toBe(false);
    });

    it("a paren-less call in the condition is followed", () => {
      const over = `local procedure Over(): Boolean begin exit(Counter > 3); end;`;
      expect(
        refused(
          `procedure P() begin repeat Advance(); until Over; end; ${over} ${ADVANCE}`,
          "Advance()",
        ),
      ).toBe(true);
    });

    it("a local named like a procedure is not a call to it", () => {
      const stepper = `local procedure Flag(): Boolean begin exit(Items.Next() = 0); end;`;
      expect(
        refused(
          `procedure P() var Flag: Boolean; begin repeat Items.Remove(1); until Items.Contains(1) or Flag; end; ${stepper}`,
          "Items.Remove(1)",
        ),
      ).toBe(true);
      const total = `local procedure Total(): Integer begin exit(Counter); end;`;
      const helper = `local procedure Helper() begin Counter += 1; end;`;
      expect(
        refused(
          `procedure P() var Total: Integer; begin while Total < 3 do begin Helper(); Total += 1; end; end; ${total} ${helper}`,
          "Helper()",
        ),
      ).toBe(false);
    });

    it("KNOWN, not seen: an event publisher, whose subscribers step (`itest:hang` rests on this)", () => {
      const pub = `[IntegrationEvent(false, false)] local procedure OnAdvance() begin end;`;
      expect(
        refused(
          `procedure P() begin repeat OnAdvance(); until Counter >= 3; end; ${pub}`,
          "OnAdvance()",
        ),
      ).toBe(false);
    });
  });

  it("refuses every operator on the site: the check is at dispatch", () => {
    const { root, ctx } = load(`codeunit 50831 "R" { var S: InStream;
      procedure P() var T: Text; begin while not S.EOS() do S.ReadText(T); end; }`);
    const site = findAll(root, ALNodeKind.procedure_call).find((n) => n.text === "S.ReadText(T)");
    if (site === undefined) throw new Error("no call");
    expect(openItemHangRefuses(site, ctx, "lethal.remove-setrange")).toBe(true);
    expect(openItemHangRefuses(site, ctx, undefined)).toBe(true);
  });
});

describe("R831: an element reads as its array", () => {
  beforeAll(async () => {
    await initParser();
  });

  const assignment = (root: ALSyntaxNode, needle: string): ALSyntaxNode => {
    const a = findAll(root, ALNodeKind.assignment_statement).find((n) => n.text.includes(needle));
    if (a === undefined) throw new Error(`no assignment ${needle}`);
    return a;
  };
  const classify = (body: string, needle: string): string | null => {
    const { root, ctx } = load(`codeunit 50832 "R" { ${body} }`);
    return classifyHangCapable(assignment(root, needle), ctx);
  };
  const HANG = "loop-condition-target";

  it("the loop's own step", () => {
    const src = `procedure P() var Buf: array[3] of Integer; begin while Buf[1] < 10 do Buf[1] := Buf[1] + 1; end;`;
    expect(classify(src, "Buf[1] :=")).toBe(HANG);
  });

  it("another element of the same array: one name, the safe direction", () => {
    const src = `procedure P() var Buf: array[3] of Integer; begin while Buf[1] < 10 do Buf[2] := 1; end;`;
    expect(classify(src, "Buf[2] :=")).toBe(HANG);
  });

  it("not another array", () => {
    const src = `procedure P() var Buf: array[3] of Integer; O: array[3] of Integer; I: Integer; begin while O[1] < 10 do begin Buf[1] := 1; O[1] += 1; end; end;`;
    expect(classify(src, "Buf[1] :=")).toBeNull();
  });

  it("a feed through an element", () => {
    const src = `procedure P() var Buf: array[3] of Integer; Pos: Integer; Step: Integer; begin while Pos < 10 do begin Buf[1] := Step; Pos := Buf[1]; Step += 1; end; end;`;
    expect(classify(src, "Buf[1] :=")).toBe(HANG);
    expect(classify(src, "Step += 1")).toBe(HANG);
  });

  it("a record array's field", () => {
    const src = `procedure P() var Recs: array[2] of Record Customer; begin while Recs[1].Name = '' do Recs[1].Name := 'x'; end;`;
    expect(classify(src, "Recs[1].Name :=")).toBe(HANG);
  });

  it("an index on the left is a feed", () => {
    const src = `procedure P() var Buf: array[3] of Integer; I: Integer; begin while Buf[3] = 0 do begin Buf[I] := 1; I += 1; end; end;`;
    expect(classify(src, "I += 1")).toBe(HANG);
  });

  it("a member's own subscript", () => {
    const src = `procedure P(var R: Record Customer) begin while R.Name[1] <> 'x' do R.Name[1] := 'x'; end;`;
    expect(classify(src, "R.Name[1] :=")).toBe(HANG);
  });

  it("an index on a record array's field is a feed", () => {
    const src = `procedure P() var Recs: array[3] of Record Customer; I: Integer; begin while Recs[3].Name = '' do begin Recs[I].Name := 'x'; I += 1; end; end;`;
    expect(classify(src, "I += 1")).toBe(HANG);
  });

  it("each index of a two-index element is a feed", () => {
    const src = `procedure P() var A: array[3, 3] of Integer; I: Integer; J: Integer; begin while A[3, 3] = 0 do begin A[I, J] := 1; I += 1; J += 1; end; end;`;
    expect(classify(src, "I += 1")).toBe(HANG);
    expect(classify(src, "J += 1")).toBe(HANG);
  });

  it("the by-name path, for a receiver nothing resolves", () => {
    const { root, ctx } = load(`codeunit 50837 "R" {
      var
#if not LETHALX
        U: array[2] of Record Customer;
#endif
        Log: Integer;
      procedure P() begin while U[1].Name = '' do U[1].Name := 'x'; end; }`);
    expect(classifyHangCapable(assignment(root, "U[1].Name :="), ctx)).toBe(HANG);
  });

  it("a mutant inside the left index", () => {
    const { root, ctx } = load(`codeunit 50833 "R" {
      procedure P() var Buf: array[3] of Integer; I: Integer; begin
        while Buf[3] = 0 do begin Buf[I + 1] := 1; I += 1; end;
      end; }`);
    const add = findAll(root, ALNodeKind.additive_expression).find((n) => n.text === "I + 1");
    if (add === undefined) throw new Error("no index");
    expect(hangCapableForMutatedNode(add, ctx)).toBe(HANG);
  });
});
