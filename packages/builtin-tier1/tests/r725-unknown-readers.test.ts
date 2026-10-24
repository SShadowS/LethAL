import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  declarationStateAt,
  evaluateArms,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * R725: hang readers in loop-hazard.ts that read a null `resolveVarRef` as "absent". The engine
 * also returns null for a name it refuses to resolve ("unknown", R720): a member swallowed into the
 * var section, a global declared inside a var-section `#if`, an every-arm-ambiguous name. Each
 * reader's own loop shape is built with a DECLARED control and the three unknown forms; the
 * hang-capable site must be refused in every form (fail closed, as R720).
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    src,
    root: wrapRoot(parseAL(src)),
  }));
  const arms = new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.src, [])]));
  const ctx = buildSemanticContext(parsed, arms);
  const find = (path: string, text: string): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    let hit: ALSyntaxNode | undefined;
    visit(f.root, (n: ALSyntaxNode) => {
      if (hit === undefined && n.text === text) hit = n;
    });
    if (hit === undefined) throw new Error(`"${text}" not found in ${path}`);
    return hit;
  };
  return {
    refused: (path: string, text: string): boolean =>
      openItemHangRefuses(find(path, text), ctx, VMC),
    state: (path: string, text: string) => declarationStateAt(find(path, text), ctx),
  };
}

/** The declaration forms of one variable `decl` ("Name: Type;"), as a global and a local block. */
type Form = { name: string; globals: string; locals: string; wrapOpen: string; wrapClose: string };
const forms = (decl: string): Form[] => {
  const [name = "", type = ""] = decl
    .replace(/;$/, "")
    .split(":")
    .map((s) => s.trim());
  return [
    { name: "declared", globals: "", locals: `        ${decl}`, wrapOpen: "", wrapClose: "" },
    {
      name: "var-section #if global",
      globals: `#if not LETHALX\n        ${name}: ${type};\n#else\n        ${name}: ${type};\n#endif`,
      locals: "",
      wrapOpen: "",
      wrapClose: "",
    },
    {
      name: "every-arm-ambiguous local",
      globals: "",
      locals: `#if not CLEAN27\n        ${decl}\n#endif`,
      wrapOpen: "",
      wrapClose: "",
    },
    {
      name: "swallowed member",
      globals: "",
      locals: `        ${decl}`,
      wrapOpen: "#if not LETHALX",
      wrapClose: "#endif",
    },
  ];
};

describe("R572: a var-out flag whose declaration is unknown", () => {
  const CALLEE = `codeunit 57202 "R725 Cap"
{
    procedure GetNext(var B: Integer)
    var
        Tag: Text;
    begin
        Tag := 'T4';
        B := B + 10;
    end;
}`;
  for (const f of forms("Bottom: Integer;"))
    it(`${f.name}: the stateful callee feeding the flag is refused`, () => {
      const p = project({
        "Cap.al": CALLEE,
        "Loop.al": `codeunit 57201 "R725 Loop"
{
    var
        G0: Integer;
${f.globals}
${f.wrapOpen}
    procedure Run()
    var
        Cap: Codeunit "R725 Cap";
${f.locals}
    begin
        repeat
            Cap.GetNext(Bottom);
        until Bottom >= 100;
    end;
${f.wrapClose}
}`,
      });
      if (f.name !== "declared") expect(p.state("Loop.al", "Bottom")).toBe("unknown");
      expect(p.refused("Cap.al", "'T4'")).toBe(true);
    });
});

const LINE = `table 50100 "R725 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Doc No."; Code[20]) { }
        field(3; Qty; Integer) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}`;

describe("R531: a consuming loop whose cursor's declaration is unknown", () => {
  for (const f of forms('Del: Record "R725 Line";'))
    it(`${f.name}: the consumer (Delete) is refused`, () => {
      const p = project({
        "Line.al": LINE,
        "Cu.al": `codeunit 50101 "R725 Cu"
{
    var
        G0: Integer;
${f.globals}
${f.wrapOpen}
    procedure KDelete()
    var
        Tag: Text;
${f.locals}
    begin
        while Del.FindFirst() do begin
            Tag := 'K1';
            Del.Delete();
        end;
    end;
${f.wrapClose}
}`,
      });
      if (f.name !== "declared") expect(p.state("Cu.al", "Del")).toBe("unknown");
      expect(p.refused("Cu.al", "Del.Delete()")).toBe(true);
    });
});

describe("R696: a moved walk whose SECOND variable's declaration is unknown", () => {
  for (const f of forms('R2: Record "R725 Line";'))
    it(`${f.name}: the moving Modify and the exit are refused`, () => {
      const p = project({
        "Line.al": LINE,
        "Cu.al": `codeunit 50102 "R725 Mv"
{
    var
        G0: Integer;
${f.globals}
${f.wrapOpen}
    procedure Renumber(FirstNo: Code[20]; NewNo: Code[20])
    var
        R: Record "R725 Line";
${f.locals}
    begin
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                if R.Qty = 7 then
                    exit;
                R2.Get(R."No.");
                R2."Doc No." := NewNo;
                R2.Modify();
            until R.Next() = 0;
    end;
${f.wrapClose}
}`,
      });
      if (f.name !== "declared") expect(p.state("Cu.al", "R2")).toBe("unknown");
      expect(p.refused("Cu.al", "R2.Modify()")).toBe(true);
      expect(p.refused("Cu.al", "exit")).toBe(true);
    });
});

describe("R725 twin: an unknown second variable still needs a key write to move the walk", () => {
  it("var-section #if global R2 writing a non-key field: the exit stays emitted", () => {
    const [, glob] = forms('R2: Record "R725 Line";');
    if (glob === undefined) throw new Error("no form");
    const p = project({
      "Line.al": LINE,
      "Cu.al": `codeunit 50104 "R725 Twin"
{
    var
        G0: Integer;
${glob.globals}

    procedure Touch(NewQty: Integer)
    var
        R: Record "R725 Line";
    begin
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                if R.Qty = 7 then
                    exit;
                R2.Get(R."No.");
                R2.Qty := NewQty;
                R2.Modify();
            until R.Next() = 0;
    end;
}`,
    });
    expect(p.state("Cu.al", "R2")).toBe("unknown");
    // red when an unknown receiver makes every write a key write (keys "all" for its table)
    expect(p.refused("Cu.al", "exit")).toBe(false);
  });
});

describe("R696: a moved walk whose WALKED variable's declaration is unknown", () => {
  for (const f of forms('R: Record "R725 Line";'))
    it(`${f.name}: the moving Modify and the exit are refused`, () => {
      const p = project({
        "Line.al": LINE,
        "Cu.al": `codeunit 50103 "R725 Wk"
{
    var
        G0: Integer;
${f.globals}
${f.wrapOpen}
    procedure Renumber(FirstNo: Code[20]; NewNo: Code[20])
    var
        R2: Record "R725 Line";
${f.locals}
    begin
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                if R.Qty = 7 then
                    exit;
                R2.Get(R."No.");
                R2."Doc No." := NewNo;
                R2.Modify();
            until R.Next() = 0;
    end;
${f.wrapClose}
}`,
      });
      if (f.name !== "declared") expect(p.state("Cu.al", "R")).toBe("unknown");
      expect(p.refused("Cu.al", "R2.Modify()")).toBe(true);
      expect(p.refused("Cu.al", "exit")).toBe(true);
    });
});
