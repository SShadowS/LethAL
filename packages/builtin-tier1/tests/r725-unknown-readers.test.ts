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
import { r737Seam } from "../src/loop-hazard";

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
      // R796: tree-sitter-al 4.5.0 parses this member as a DIRECT member, so its local is declared
      // (4.4.1 swallowed it into the var section: 'unknown'). Kept as a control: still refused.
      name: "former swallowed member (declared under 4.5.0)",
      globals: "",
      locals: `        ${decl}`,
      wrapOpen: "#if not LETHALX",
      wrapClose: "#endif",
    },
  ];
};

/** A form whose name the engine reports 'unknown' (not a plain declared one, nor the former swallowed member). */
const isUnknownForm = (f: Form): boolean => f.name !== "declared" && !f.name.startsWith("former");

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
      if (isUnknownForm(f)) expect(p.state("Loop.al", "Bottom")).toBe("unknown");
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
      if (isUnknownForm(f)) expect(p.state("Cu.al", "Del")).toBe("unknown");
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
      if (isUnknownForm(f)) expect(p.state("Cu.al", "R2")).toBe("unknown");
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
      if (isUnknownForm(f)) expect(p.state("Cu.al", "R")).toBe("unknown");
      expect(p.refused("Cu.al", "R2.Modify()")).toBe(true);
      expect(p.refused("Cu.al", "exit")).toBe(true);
    });
});

/**
 * The other direction: a name that is provably ABSENT (declared nowhere; not compilable AL, which
 * is exactly why it pins the contract) stays absent. Only "unknown" fails closed.
 */
describe("R725 twins: an ABSENT name is not an unknown one", () => {
  it("an undeclared second receiver gets no table: the walk is not refused through it", () => {
    const p = project({
      "Line.al": LINE,
      "Cu.al": `codeunit 50105 "R725 Absent"
{
    procedure Renumber(NewNo: Code[20])
    var
        R: Record "R725 Line";
    begin
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                if R.Qty = 7 then
                    exit;
                Ghost.Get(R."No.");
                Ghost."Doc No." := NewNo;
                Ghost.Modify();
            until R.Next() = 0;
    end;
}`,
    });
    expect(p.state("Cu.al", "Ghost")).not.toBe("unknown");
    // red when any unresolved receiver (not only an "unknown" one) gets the wildcard table
    expect(p.refused("Cu.al", "Ghost.Modify()")).toBe(false);
  });

  it("an undeclared var-out argument is no flag: its callee is not refused through it", () => {
    const p = project({
      "Cap.al": `codeunit 57212 "R725 Cap2"
{
    procedure GetNext(var B: Integer)
    var
        Tag: Text;
    begin
        Tag := 'T9';
        B := B + 10;
    end;
}`,
      "Loop.al": `codeunit 57211 "R725 Loop2"
{
    procedure Run()
    var
        Cap: Codeunit "R725 Cap2";
    begin
        repeat
            Cap.GetNext(Phantom);
        until Phantom >= 100;
    end;
}`,
    });
    expect(p.state("Loop.al", "Phantom")).not.toBe("unknown");
    // red when an undeclared (not "unknown") argument is counted as a flag
    expect(p.refused("Cap.al", "'T9'")).toBe(false);
  });
});

describe("R725: an insert through an unknown receiver arms R717's fix-up refusal", () => {
  it("a callee inserting through a var-section #if global still counts as inserting", () => {
    const p = project({
      "Line.al": `table 50110 "R725 Tmpl"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Ident; Code[20]) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    var
        G0: Integer;
#if not LETHALX
        X: Record "R725 Tmpl";
#else
        X: Record "R725 Tmpl";
#endif

    procedure CloneNo(var From: Record "R725 Tmpl"; NewNo: Code[20]): Code[20]
    begin
        X := From;
        X."No." := NewNo;
        X.Insert(true);
        exit(X."No.");
    end;
}`,
      "Cu.al": `codeunit 50111 "R725 Clone"
{
    procedure Clone(Id: Code[20]; NewNo: Code[20])
    var
        R: Record "R725 Tmpl";
        T2: Record "R725 Tmpl";
    begin
        R.SetRange(Ident, Id);
        if R.FindSet() then
            repeat
                T2.Get(T2.CloneNo(R, NewNo));
                T2.Ident := NewNo;
                T2.Modify();
            until R.Next() = 0;
    end;
}`,
    });
    expect(p.state("Line.al", "X")).toBe("unknown");
    // red when r696Inserts compares tables exactly (an unknown receiver's insert is then missed)
    expect(p.refused("Cu.al", "T2.Modify()")).toBe(true);
  });
});

describe("R725 review B1: R696's whole-record write by an unknown second variable", () => {
  for (const f of forms('R2: Record "R725 Line";'))
    it(`${f.name}: R2 := Src, then R2.Modify(), moves the walk and is refused`, () => {
      const p = project({
        "Line.al": LINE,
        "Cu.al": `codeunit 50112 "R725 Whole"
{
    var
        G0: Integer;
${f.globals}
${f.wrapOpen}
    procedure Copy(var Src: Record "R725 Line")
    var
        R: Record "R725 Line";
${f.locals}
    begin
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                if R.Qty = 7 then
                    exit;
                R2 := Src;
                R2.Modify();
            until R.Next() = 0;
    end;
${f.wrapClose}
}`,
      });
      // red when r696Writes reads an unknown R2 := X as an implicit-Rec field write only
      expect(p.refused("Cu.al", "R2.Modify()")).toBe(true);
      expect(p.refused("Cu.al", "exit")).toBe(true);
    });
});

describe("R725 review S3: R572 statefulness and an unknown local record", () => {
  it("every-arm-ambiguous local record in the callee is not a simple variable: refused", () => {
    const p = project({
      "Line.al": LINE,
      "Cap.al": `codeunit 57222 "R725 Step"
{
    procedure Step(): Boolean
    var
        Tag: Text;
#if not CLEAN27
        E: Record "R725 Line";
#endif
    begin
        Tag := 'S3';
        E.Insert();
        exit(E.Count() > 10);
    end;
}`,
      "Loop.al": `codeunit 57221 "R725 StepLoop"
{
    procedure Run()
    var
        Cap: Codeunit "R725 Step";
        Done: Boolean;
    begin
        repeat
            Done := Cap.Step();
        until Done;
    end;
}`,
    });
    expect(p.state("Cap.al", "E")).toBe("unknown");
    // red when an unknown local passes as "a declared simple-type variable's built-in"
    expect(p.refused("Cap.al", "'S3'")).toBe(true);
  });
});

describe("R725 review S5: R530 and a self-insert through an unknown variable", () => {
  it("a report item inserting through a var-section #if global: the exit guard's outside write is refused", () => {
    const p = project({
      "Tbl.al": `table 50120 "R725 Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
}`,
      "Rep.al": `report 50121 "R725 Rep"
{
    dataset
    {
        dataitem(Walk; "R725 Entry")
        {
            trigger OnAfterGetRecord()
            begin
                if Walk."Entry No." > LastEntryNo then
                    CurrReport.Break();
                X := Walk;
                X."Entry No." := Walk."Entry No." + 1000;
                X.Insert();
            end;
        }
    }

    trigger OnPreReport()
    begin
        LastEntryNo := 5;
    end;

    var
        LastEntryNo: Integer;
#if not LETHALX
        X: Record "R725 Entry";
#else
        X: Record "R725 Entry";
#endif
}`,
    });
    expect(p.state("Rep.al", "X")).toBe("unknown");
    // red when selfInserts reads an unknown receiver's Insert as no self-insert
    expect(p.refused("Rep.al", "LastEntryNo := 5")).toBe(true);
  });
});

describe("R737: a callee receiver declared inside a var-section #if", () => {
  const CAP = `codeunit 57202 "R725 Cap"
{
    procedure GetNext(var B: Integer)
    var
        Tag: Text;
    begin
        Tag := 'T4';
        B := B + 10;
    end;
}`;
  const PLAIN = `codeunit 57203 "R725 Plain"
{
    procedure GetNext(var B: Integer)
    begin
        B := B + 10;
    end;
}`;
  /** `globals` goes in the object's var section, `locals` in Run's. */
  const loop = (globals: string, locals: string) => `codeunit 57201 "R725 Loop"
{
    var
        G0: Integer;
${globals}

    procedure Run()
    var
        Bottom: Integer;
${locals}
    begin
        repeat
            Cap.GetNext(Bottom);
        until Bottom >= 100;
    end;
}`;
  const refusedWith = (loopSrc: string, seam: boolean): boolean => {
    const files = { "Cap.al": CAP, "Plain.al": PLAIN, "Loop.al": loopSrc };
    const was = r737Seam.on;
    r737Seam.on = seam;
    try {
      return project(files).refused("Cap.al", "'T4'");
    } finally {
      r737Seam.on = was;
    }
  };
  const BOTH = `#if not LETHALX
        Cap: Codeunit "R725 Cap";
#else
        Cap: Codeunit "R725 Cap";
#endif`;

  it("T1: a #if global with the same type in both arms is followed (off: not)", () => {
    expect(refusedWith(loop(BOTH, ""), true)).toBe(true);
    expect(refusedWith(loop(BOTH, ""), false)).toBe(false);
  });

  it("T2: a single-arm live #if local is followed (off: not)", () => {
    const l = `#if not CLEAN27\n        Cap: Codeunit "R725 Cap";\n#endif`;
    expect(refusedWith(loop("", l), true)).toBe(true);
    expect(refusedWith(loop("", l), false)).toBe(false);
  });

  it("T3: a plain local control is followed with the seam on and off", () => {
    const l = `        Cap: Codeunit "R725 Cap";`;
    expect(refusedWith(loop("", l), true)).toBe(true);
    expect(refusedWith(loop("", l), false)).toBe(true);
  });

  it("T4: an UNDECIDED file with two types follows both (the stateful one is second)", () => {
    const g = `#if CLEAN27 && Q
        Cap: Codeunit "Absent X";
#else
        Cap: Codeunit "R725 Cap";
#endif`;
    const src = loop(g, "");
    const root = wrapRoot(parseAL(src));
    expect(evaluateArms(root, src, []).kind).toBe("undecided");
    expect(refusedWith(src, true)).toBe(true);
    expect(refusedWith(src, false)).toBe(false);
  });

  it("T5: a decided file reads only the live arm (the stateful type is compiled out)", () => {
    const g = `#if CLEAN27
        Cap: Codeunit "R725 Cap";
#else
        Cap: Codeunit "R725 Plain";
#endif`;
    expect(refusedWith(loop(g, ""), true)).toBe(false);
    // a compiled-out local does not exist: the plain global types the receiver
    const out = `#if CLEAN27\n        Cap: Codeunit "R725 Cap";\n#endif`;
    expect(refusedWith(loop(`        Cap: Codeunit "R725 Plain";`, out), true)).toBe(false);
  });

  it("T6: a live #if local hides a #if global of another type", () => {
    const l = `#if not CLEAN27\n        Cap: Codeunit "R725 Plain";\n#endif`;
    expect(refusedWith(loop(BOTH, l), true)).toBe(false);
  });

  it("T7 (review MUST 2): seam off equals master on a split-header procedure's compiled-out local", () => {
    // decided file; the compiled-out arm declares the stateful type, the live arm the plain one
    const split = `codeunit 57201 "R725 Loop"
{
#if CLEAN27
    procedure Run()
    var
        Cap: Codeunit "R725 Cap";
        Bottom: Integer;
#else
    procedure Run()
    var
        Cap: Codeunit "R725 Plain";
        Bottom: Integer;
#endif
    begin
        repeat
            Cap.GetNext(Bottom);
        until Bottom >= 100;
    end;
}`;
    // red when the declaration-level inactive skip is not behind the seam: off no longer refuses
    expect(refusedWith(split, false)).toBe(true);
    expect(refusedWith(split, true)).toBe(false);
  });

  it("T8 (review SHOULD): an UNDECIDED local and a stateful global are both followed", () => {
    const l = `#if CLEAN27 && Q\n        Cap: Codeunit "R725 Plain";\n#endif`;
    const src = loop(`        Cap: Codeunit "R725 Cap";`, l);
    expect(evaluateArms(wrapRoot(parseAL(src)), src, []).kind).toBe("undecided");
    // red when an uncertain local no longer unions with the object pass
    expect(refusedWith(src, true)).toBe(true);
  });
});

describe("R737 review MUST 1: a two-type receiver where one type has no project object", () => {
  const BUF = `table 57200 "R572 Buf"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
        field(3; Step; Integer) { }
    }
    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}`;
  const FEED = `codeunit 57202 "R572 Feed"
{
    var
        Left: Integer;

    procedure More(): Boolean
    var
        Tag: Text;
    begin
        Tag := 'FEED';
        Left -= 1;
        exit(Left > 0);
    end;
}`;
  const Q = `codeunit 57203 "R572 Q"
{
    procedure Touch(S: Integer)
    begin
        Message('%1', S);
    end;
}`;
  const files = (qdecl: string) => ({
    "Buf.Table.al": BUF,
    "Callee.Codeunit.al": FEED,
    "Q.Codeunit.al": Q,
    "Q2.Codeunit.al": Q.replace("57203", "57204")
      .replace('"R572 Q"', '"R572 Q2"')
      .replace("Touch", "Other"),
    "Q3.Codeunit.al": Q.replace("57203", "57205").replace('"R572 Q"', '"R572 Q3"'),
    "Loop.Codeunit.al": `codeunit 57201 "R572 Loop"
{
    procedure Run()
    var
        R: Record "R572 Buf";
        F: Codeunit "R572 Feed";
        More: Boolean;
        Step: Integer;
${qdecl}
    begin
        Step := 1;
        if R.FindSet() then
            repeat
                More := F.More();
                Qv.Touch(Step);
            until (R.Next(Step) = 0) or not More;
    end;
}`,
  });
  const amb = `#if CLEAN27 && Q
        Qv: Codeunit "Absent X";
#else
        Qv: Codeunit "R572 Q";
#endif`;
  const refusedWith = (qdecl: string, seam: boolean): boolean => {
    const was = r737Seam.on;
    r737Seam.on = seam;
    try {
      return project(files(qdecl)).refused("Callee.Codeunit.al", "'FEED'");
    } finally {
      r737Seam.on = was;
    }
  };

  it("an undecided Absent/project pair is unresolved: refused, seam on and off", () => {
    const src = files(amb)["Loop.Codeunit.al"];
    expect(evaluateArms(wrapRoot(parseAL(src)), src, []).kind).toBe("undecided");
    // red when the union keeps only the resolving type: Touch(Step) by value looks complete
    expect(refusedWith(amb, true)).toBe(true);
    expect(refusedWith(amb, false)).toBe(true);
  });

  // R751: both types name a project codeunit, but one has no `Touch`: the union is partial.
  it("B1: two project codeunits where one lacks the called member: refused", () => {
    const lacks = `#if CLEAN27 && Q
        Qv: Codeunit "R572 Q2";
#else
        Qv: Codeunit "R572 Q";
#endif`;
    const src = files(lacks)["Loop.Codeunit.al"];
    expect(evaluateArms(wrapRoot(parseAL(src)), src, []).kind).toBe("undecided");
    expect(refusedWith(lacks, true)).toBe(true);
  });

  it("B2: two project codeunits that both have the member: complete, admitted", () => {
    const both = `#if CLEAN27 && Q
        Qv: Codeunit "R572 Q3";
#else
        Qv: Codeunit "R572 Q";
#endif`;
    expect(refusedWith(both, true)).toBe(false);
  });

  it("controls: plain absent refuses, plain project by-value skips", () => {
    expect(refusedWith(`        Qv: Codeunit "Absent X";`, true)).toBe(true);
    expect(refusedWith(`        Qv: Codeunit "R572 Q";`, true)).toBe(false);
  });
});

// R752 (build review SHOULD 1): R751 made a two-type union with a type lacking the member PARTIAL
// (strict reads get []). A PAREN-LESS `Qv.X` was then read as a field read, though T1 has a
// procedure X (master followed it). T2 has only a FIELD X.
describe("R752: a paren-less member call on a partial two-type record receiver", () => {
  const T1 = (body: string) => `table 57210 "R752 T1"
{
    fields { field(1; "No."; Integer) { } }
    var
        Counter: Integer;

    procedure X(): Integer
    begin
${body}
    end;
}`;
  const T2 = (xField: string) => `table 57211 "R752 T2"
{
    fields
    {
        field(1; "No."; Integer) { }
${xField}
    }
}`;
  const UNION = `#if CLEAN27 && Q
        Qv: Record "R752 T2";
#else
        Qv: Record "R752 T1";
#endif`;
  const withSeam = <T>(seam: boolean, f: () => T): T => {
    const was = r737Seam.on;
    r737Seam.on = seam;
    try {
      return f();
    } finally {
      r737Seam.on = was;
    }
  };
  const XFIELD = "        field(2; X; Integer) { }";

  // (b) r572Stateful: the callee reads `Qv.X`; T1.X touches a table global (stateful)
  const stateful = (t1: string, t2: string) => ({
    "T1.al": T1(t1),
    "T2.al": T2(t2),
    "Cap.al": `codeunit 57222 "R752 Step"
{
    procedure Step(): Boolean
    var
        Tag: Text;
${UNION}
    begin
        Tag := 'PL';
        Tag := Format(Qv.X);
        exit(Tag = '');
    end;
}`,
    "Loop.al": `codeunit 57221 "R752 StepLoop"
{
    procedure Run()
    var
        Cap: Codeunit "R752 Step";
        Done: Boolean;
    begin
        repeat
            Done := Cap.Step();
        until Done;
    end;
}`,
  });
  const statefulRefused = (t1: string, t2: string, seam: boolean) =>
    withSeam(seam, () => project(stateful(t1, t2)).refused("Cap.al", "'PL'"));

  it("(b) r572Stateful: T1.X stateful, T2 only a field X: refused (seam on; off reads one arm)", () => {
    const src = stateful("        Counter += 1;\n        exit(Counter);", XFIELD)["Cap.al"];
    expect(evaluateArms(wrapRoot(parseAL(src)), src, []).kind).toBe("undecided");
    expect(project(stateful("", XFIELD)).state("Cap.al", "Qv")).toBe("unknown");
    // red when the paren-less branch of r572StatefulOnce reads the partial union as a field read
    expect(statefulRefused("        Counter += 1;\n        exit(Counter);", XFIELD, true)).toBe(
      true,
    );
  });

  it("(b) control: both types have a FIELD X and no procedure: a field read, not refused (as master)", () => {
    const files = stateful("", XFIELD);
    // T1 with a field X and no procedure X
    files["T1.al"] = `table 57210 "R752 T1"
{
    fields
    {
        field(1; "No."; Integer) { }
        field(2; X; Integer) { }
    }
}`;
    for (const seam of [true, false])
      expect(withSeam(seam, () => project(files).refused("Cap.al", "'PL'"))).toBe(false);
  });

  // (a) the R570 writer search (r570Scan's viaRec) has no twin here: see the ponytail note there.
});
