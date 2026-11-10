import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";
import { r896P1Seam, r896P1bSeam, r896P2Seam, r896P5Seam, r896P6Seam } from "../src/loop-hazard";

/**
 * R896: the Tier-2 hang shapes refused at the dispatch (`openItemHangRefuses`), so R447 counts each
 * by operator name. P1 flip-filter-literal before a walk jump, P1b swap-find-direction through a
 * copy, P2 value swaps in a loop's exit, P5 progress through another variable, P6 a TestField that
 * is the loop's only exit. Invented AL only.
 */

beforeAll(async () => {
  await initParser();
});

const FFL = "lethal.flip-filter-literal";
const SFD = "lethal.swap-find-direction";
const SEM = "lethal.swap-enum-member";
const SRX = "lethal.swap-rec-xrec";
const SMF = "lethal.swap-modify-flag";
const RTF = "lethal.remove-testfield";

/** Is the `nth` distinct node whose text is `text` refused for `op`? */
function refused(src: string, text: string, op: string, nth = 0): boolean {
  const parsed = [{ path: "a.al", root: wrapRoot(parseAL(src)) }];
  const ctx = buildSemanticContext(parsed);
  const hits: ALSyntaxNode[] = [];
  visit(parsed[0]?.root as ALSyntaxNode, (n: ALSyntaxNode) => {
    if (n.text === text && !hits.some((h) => h.startIndex === n.startIndex)) hits.push(n);
  });
  const hit = hits[nth];
  if (hit === undefined) throw new Error(`not found: ${text} #${nth}`);
  return openItemHangRefuses(hit, ctx, op);
}

const OBJECTS = `table 50310 "R896 Entry"
{
    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; Grp; Code[20]) { }
        field(3; Done; Boolean) { }
        field(4; Phase; Enum "R896 Phase") { }
        field(5; Qty; Integer)
        {
            trigger OnValidate()
            begin
                while Rec.Qty > 10 do
                    Qty := Qty - 1;
                Done := xRec.Qty = 0;
            end;
        }
    }
    keys { key(PK; "Entry No.") { Clustered = true; } }

    trigger OnModify()
    begin
        Done := true;
    end;
}

table 50311 "R896 Other"
{
    fields
    {
        field(1; "Line No."; Integer) { }
        field(2; Amount; Integer) { }
    }
    keys { key(PK; "Line No.") { Clustered = true; } }
}

enum 50310 "R896 Phase"
{
    Extensible = false;
    value(0; Fresh) { }
    value(1; Busy) { }
    value(2; Over) { }
}
`;

const proc = (body: string, vars = ""): string => `${OBJECTS}
codeunit 50312 "R896 Shapes"
{
    procedure Run(Flag: Boolean)
    var
        R: Record "R896 Entry";
        X: Record "R896 Entry";
        L: Record "R896 Other";
        P: Enum "R896 Phase";
${vars}
    begin
${body}
    end;
}`;

const WALK = (inner: string) => `        if R.FindSet() then
            repeat
${inner}
            until R.Next() = 0;`;

// P1: a group bound written as a filter literal, then a jump that lands by it.
const P1_FILTER = "R.SetFilter(Grp, '<=%1', R.Grp)";
const P1_HANG = WALK(`                ${P1_FILTER};
                if R.FindLast() then;
                R.SetRange(Grp);`);

// P1b: the jump on a second variable, copied back into the walked one.
const P1B_HANG = (copy: string) =>
  WALK(`                X.SetRange(Grp, R.Grp);
                X.FindLast();
                ${copy};`);

// P2: a phase machine; the loop ends when P reaches Over.
const P2_HANG = `        P := "R896 Phase"::Fresh;
        while P <> "R896 Phase"::Over do
            case P of
                "R896 Phase"::Fresh:
                    P := "R896 Phase"::Busy;
                "R896 Phase"::Busy:
                    P := "R896 Phase"::Over;
            end;`;

// P5: the loop asks W's set; X's trigger does the progress.
const P5_HANG = (extra = "") => `        X.SetRange(Done, false);
        while not X.IsEmpty() do begin
            R.SetRange(Done, false);
            R.FindFirst();
            R.Modify(true);
${extra}
        end;`;

// P6: TestField is the only way out.
const P6_HANG = (extra = "") => `        repeat
            R.FindFirst();
${extra}
            R.TestField(Done, false);
        until false;`;

/** Run `f` with `seam` off, then restore the seam to what it was. */
function seamOff(seam: { on: boolean }, f: () => void): void {
  const was = seam.on;
  seam.on = false;
  try {
    f();
  } finally {
    seam.on = was;
  }
}

describe("R896 P1: flip-filter-literal before a walk jump", () => {
  it("refused", () => {
    expect(refused(proc(P1_HANG), P1_FILTER, FFL)).toBe(true);
  });
  it("a while R.Next() walk and a FindFirst jump", () => {
    const body = `        while R.Next() <> 0 do begin
            R.SetFilter(Grp, '>=%1', R.Grp);
            R.FindFirst();
        end;`;
    expect(refused(proc(body), "R.SetFilter(Grp, '>=%1', R.Grp)", FFL)).toBe(true);
  });
  it("admitted: the flip on a different record", () => {
    const body = WALK(`                L.SetFilter(Amount, '<=%1', 0);
                if R.FindLast() then;`);
    expect(refused(proc(body), "L.SetFilter(Amount, '<=%1', 0)", FFL)).toBe(false);
  });
  it("admitted: no jump after the filter", () => {
    const body = WALK(`                if R.FindLast() then;
                ${P1_FILTER};`);
    expect(refused(proc(body), P1_FILTER, FFL)).toBe(false);
  });
  it("admitted: another operator on the same call", () => {
    expect(refused(proc(P1_HANG), P1_FILTER, "lethal.remove-setrange")).toBe(false);
  });
  it("seam off: admitted", () => {
    seamOff(r896P1Seam, () => expect(refused(proc(P1_HANG), P1_FILTER, FFL)).toBe(false));
  });
});

describe("R896 P1b: swap-find-direction on a jump copied into the walk", () => {
  it("refused: R := X", () => {
    expect(refused(proc(P1B_HANG("R := X")), "X.FindLast()", SFD)).toBe(true);
  });
  it("refused: R.Copy(X)", () => {
    expect(refused(proc(P1B_HANG("R.Copy(X)")), "X.FindLast()", SFD)).toBe(true);
  });
  it("refused: R.TransferFields(X)", () => {
    expect(refused(proc(P1B_HANG("R.TransferFields(X)")), "X.FindLast()", SFD)).toBe(true);
  });
  it("admitted: a jump on X with no R := X", () => {
    expect(refused(proc(P1B_HANG("Flag := true")), "X.FindLast()", SFD)).toBe(false);
  });
  it("admitted: R := X before the jump", () => {
    const body = WALK(`                R := X;
                X.FindLast();`);
    expect(refused(proc(body), "X.FindLast()", SFD)).toBe(false);
  });
  it("seam off: admitted", () => {
    seamOff(r896P1bSeam, () =>
      expect(refused(proc(P1B_HANG("R := X")), "X.FindLast()", SFD)).toBe(false),
    );
  });
});

describe("R896 P2: value swaps that freeze a loop", () => {
  it("refused: swap-enum-member on the exit value", () => {
    expect(refused(proc(P2_HANG), '"R896 Phase"::Over', SEM, 0)).toBe(true);
  });
  it("refused: swap-enum-member on a write the exit reads", () => {
    expect(refused(proc(P2_HANG), '"R896 Phase"::Over', SEM, 1)).toBe(true);
  });
  it("refused: swap-rec-xrec in the loop condition", () => {
    expect(refused(proc(""), "Rec.Qty", SRX)).toBe(true);
  });
  it("admitted: swap-rec-xrec outside the loop", () => {
    expect(refused(proc(""), "xRec.Qty", SRX)).toBe(false);
  });
  it("admitted: an enum swap outside any loop exit", () => {
    const body = WALK(`                R.Phase := "R896 Phase"::Over;
                R.Modify();`);
    expect(refused(proc(body), '"R896 Phase"::Over', SEM)).toBe(false);
  });
  it("admitted: an enum swap before the loop", () => {
    expect(refused(proc(P2_HANG), '"R896 Phase"::Fresh', SEM, 0)).toBe(false);
  });
  it("seam off: admitted", () => {
    seamOff(r896P2Seam, () => {
      expect(refused(proc(P2_HANG), '"R896 Phase"::Over', SEM, 0)).toBe(false);
      expect(refused(proc(""), "Rec.Qty", SRX)).toBe(false);
    });
  });
});

describe("R896 P5: progress through another variable of the walked table", () => {
  it("refused: swap-modify-flag", () => {
    expect(refused(proc(P5_HANG()), "R.Modify(true)", SMF)).toBe(true);
  });
  it("refused: any operator on such a call", () => {
    expect(refused(proc(P5_HANG()), "R.FindFirst()", SFD)).toBe(true);
  });
  it("admitted: a Next walk on the other variable", () => {
    // The condition also asks X's set: only its `Next` admits the site.
    const body = `        if X.FindSet() then
            repeat
                R.SetRange(Done, false);
                R.FindFirst();
                R.Modify(true);
            until (X.Next() = 0) or X.IsEmpty();`;
    expect(refused(proc(body), "R.Modify(true)", SMF)).toBe(false);
  });
  it("admitted: a consumer present", () => {
    const extra = `            if X.FindFirst() then
                X.Delete();`;
    expect(refused(proc(P5_HANG(extra)), "R.Modify(true)", SMF)).toBe(false);
  });
  it("admitted: the loop asks a different table", () => {
    const body = `        while not L.IsEmpty() do begin
            R.Modify(true);
            L.DeleteAll();
        end;`;
    expect(refused(proc(body), "R.Modify(true)", SMF)).toBe(false);
  });
  it("seam off: admitted", () => {
    seamOff(r896P5Seam, () => expect(refused(proc(P5_HANG()), "R.Modify(true)", SMF)).toBe(false));
  });
});

describe("R896 P6: a TestField that is the loop's only exit", () => {
  it("refused", () => {
    expect(refused(proc(P6_HANG()), "R.TestField(Done, false)", RTF)).toBe(true);
  });
  it("admitted: the loop has another exit", () => {
    // The guard reads no name of R: one that did would be R830's (`deletedCallHangs`).
    const extra = `            if Flag then
                break;`;
    expect(refused(proc(P6_HANG(extra)), "R.TestField(Done, false)", RTF)).toBe(false);
  });
  it("admitted: the condition reads a name", () => {
    const body = `        repeat
            R.FindFirst();
            R.TestField(Done, false);
        until Flag;`;
    expect(refused(proc(body), "R.TestField(Done, false)", RTF)).toBe(false);
  });
  it("seam off: admitted", () => {
    seamOff(r896P6Seam, () =>
      expect(refused(proc(P6_HANG()), "R.TestField(Done, false)", RTF)).toBe(false),
    );
  });
});
