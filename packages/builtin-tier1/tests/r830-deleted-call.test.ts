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
    var Counter: Integer; Log: Integer; Other: Codeunit "Other"; S: InStream; Items: List of [Integer];
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
          `procedure P() begin while Items.Count() > 0 do Items.RemoveAt(1); end;`,
          "Items.RemoveAt(1)",
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

    it("asks ANY enclosing loop: an inner stepped loop does not hide an outer one", () => {
      expect(
        refused(
          `procedure P(var C: Record Customer) begin while C.Count() > 0 do repeat C.Delete(); until C.Next() = 0; end;`,
          "C.Delete()",
        ),
      ).toBe(true);
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
