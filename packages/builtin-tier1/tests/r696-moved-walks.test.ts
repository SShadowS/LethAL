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

/**
 * R696: a loop that moves the record it walks (a Next-driven loop, or a report/XMLport data item)
 * through a SECOND variable of the same table is hang-refused for every operator: the exit that
 * ends it, the mover and its writes, the feeds, and the pre-loop filters. Each test names the one
 * clause whose removal turns it red (R696 red-check log). Twins (the walked variable's own Modify,
 * a temporary record, a non-key write, no mover, a break of an inner loop, a callee into another
 * table) must stay emitted.
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

function project(files: Record<string, string>) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    root: wrapRoot(parseAL(src)),
  }));
  const ctx = buildSemanticContext(parsed);
  const find = (path: string, text: string, nth: number): ALSyntaxNode => {
    const f = parsed.find((p) => p.path === path);
    if (f === undefined) throw new Error(`no file ${path}`);
    const hits: ALSyntaxNode[] = [];
    visit(f.root, (n: ALSyntaxNode) => {
      const last = hits[hits.length - 1];
      if (last !== undefined && n.startIndex < last.endIndex) return;
      if (n.text === text) hits.push(n);
    });
    const hit = hits[nth - 1];
    if (hit === undefined) throw new Error(`"${text}" #${nth} not found in ${path}`);
    return hit;
  };
  return {
    /** Is the `nth` outermost node with exactly this text refused? */
    refused: (path: string, text: string, nth = 1): boolean =>
      openItemHangRefuses(find(path, text, nth), ctx, VMC),
  };
}

const LINE_TABLE = (procs = ""): string => `table 50200 "R696 Line"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Doc No."; Code[20]) { }
        field(3; Status; Integer) { }
        field(4; Seq; Integer) { }
        field(5; Note; Text[30]) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
        key(Doc; "Doc No.") { }
    }
${procs}
}`;

const OTHER_TABLE = `table 50202 "R696 Other"
{
    fields
    {
        field(1; Id; Code[20]) { }
        field(2; Val; Integer) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}`;

const PARAMS = "FirstNo: Code[20]; NewNo: Code[20]; Limit: Integer";
const VARS = `        R: Record "R696 Line";
        R2: Record "R696 Line";
        Mid: Integer;
        Base: Integer;`;

/** A codeunit procedure. */
const proc = (name: string, body: string, params = PARAMS, vars = VARS): string => `
    procedure ${name}(${params})
    var
${vars}
    begin
${body}
    end;
`;

const CU = (...procs: string[]): string => `codeunit 50201 "R696 Cu"
{${procs.join("")}}`;

/** The standard walk: R in "Doc No." order, `inner` as the loop body. */
const WALK = (inner: string, pre = 'R.SetCurrentKey("Doc No.");'): string => `        ${pre}
        if R.FindSet() then
            repeat
${inner}
            until R.Next() = 0;`;

const MOVE_DOC = `                R2.Get(R."No.");
                R2."Doc No." := NewNo;
                R2.Modify();`;

const files = (cu: string): Record<string, string> => ({
  "line.al": LINE_TABLE(),
  "other.al": OTHER_TABLE,
  "cu.al": cu,
});

describe("R696 shape B: a Next-driven loop whose body moves its own table", () => {
  it("1. the renumber shape: the moving Modify and the exit that ends the walk are refused", () => {
    const p = project(
      files(
        CU(
          proc(
            "Renumber",
            WALK(`                if R.Note = FirstNo then
                    exit;
${MOVE_DOC}`),
          ),
        ),
      ),
    );
    // revert: the B mover push
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
    // revert: the B guards push (the guard reads Note, the mover writes "Doc No.")
    expect(p.refused("cu.al", "exit")).toBe(true);
    expect(p.refused("cu.al", "R.Note = FirstNo")).toBe(true);
  });

  it("1b. the key write itself is refused (primary key: no SetCurrentKey argument feeds it)", () => {
    const p = project(
      files(
        CU(
          proc(
            "RenumberPk",
            WALK(
              `                R2.Get(R."No.");
                R2."No." := NewNo;
                R2.Modify();`,
              "R.SetRange(Status, 0);",
            ),
          ),
        ),
      ),
    );
    // revert: the B writes push
    expect(p.refused("cu.al", 'R2."No." := NewNo')).toBe(true);
  });

  it("3. an Insert loop: the pre-loop filter, the guard around it and its feed are refused", () => {
    const p = project(
      files(
        CU(
          proc(
            "Fill",
            `        Mid := Limit + 1;
        if Limit > 0 then
            R.SetRange(Status, Mid);
        if R.FindSet() then
            repeat
                R2.Init();
                R2."No." := FirstNo;
                R2.Insert();
            until R.Next() = 0;`,
          ),
        ),
      ),
    );
    expect(p.refused("cu.al", "R2.Insert()")).toBe(true);
    // revert: the pre-loop filter collector
    expect(p.refused("cu.al", "R.SetRange(Status, Mid)")).toBe(true);
    // revert: the guardsUpTo push around that call
    expect(p.refused("cu.al", "Limit > 0")).toBe(true);
    // revert: the feeds of the filter's arguments
    expect(p.refused("cu.al", "Mid := Limit + 1")).toBe(true);
  });

  it("4a. the walked variable's own Rename is refused (the probe had no Rename leg)", () => {
    const p = project(files(CU(proc("Own", WALK("                R.Rename(NewNo);")))));
    // revert: the Rename branch for R itself
    expect(p.refused("cu.al", "R.Rename(NewNo)")).toBe(true);
  });

  it("4b. a second variable's Rename is refused", () => {
    const p = project(
      files(
        CU(
          proc(
            "Other",
            WALK(`                R2.Get(R."No.");\n                R2.Rename(NewNo);`),
          ),
        ),
      ),
    );
    // revert: the Rename branch for another variable
    expect(p.refused("cu.al", "R2.Rename(NewNo)")).toBe(true);
  });

  it("5. a guard feed through a TWO-STEP chain is refused to a fixpoint", () => {
    const p = project(
      files(
        CU(
          proc(
            "Chain",
            `        Limit := Mid + 1;
        Mid := Base + 1;
${WALK(`                if R.Seq > Limit then
                    exit;
                R2.Rename(NewNo);`)}`,
          ),
        ),
      ),
    );
    // revert: the fixpoint (one step only refuses the first)
    expect(p.refused("cu.al", "Limit := Mid + 1")).toBe(true);
    expect(p.refused("cu.al", "Mid := Base + 1")).toBe(true);
  });

  it("6. a table that is not in the project: every field counts as a key", () => {
    const p = project({
      "cu.al": CU(
        proc(
          "Unknown",
          `        if R.FindSet() then
            repeat
                R2.Anything := 1;
                R2.Modify();
            until R.Next() = 0;`,
          PARAMS,
          `        R: Record "R696 Nowhere";
        R2: Record "R696 Nowhere";`,
        ),
      ),
    });
    // revert: the unknown-table branch (the primary key of an unknown table is empty)
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
  });

  it("8. ModifyAll of a key field is a mover, on the walked variable and on another", () => {
    const p = project(
      files(
        CU(
          proc("AllOwn", WALK('                R.ModifyAll("Doc No.", NewNo);')),
          proc("AllOther", WALK('                R2.ModifyAll("Doc No.", NewNo);')),
        ),
      ),
    );
    // revert: the ModifyAll branch
    expect(p.refused("cu.al", 'R.ModifyAll("Doc No.", NewNo)')).toBe(true);
    expect(p.refused("cu.al", 'R2.ModifyAll("Doc No.", NewNo)')).toBe(true);
  });

  it("9. a Validate of a key field before Modify is a key write", () => {
    const p = project(
      files(
        CU(
          proc(
            "Val",
            WALK(`                R2.Get(R."No.");
                R2.Validate("Doc No.", NewNo);
                R2.Modify();`),
          ),
        ),
      ),
    );
    // revert: Validate recognition
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
    expect(p.refused("cu.al", 'R2.Validate("Doc No.", NewNo)')).toBe(true);
  });

  it("10. a whole-record write (TransferFields, :=, Copy) before Modify counts as a key write", () => {
    const p = project(
      files(
        CU(
          proc("Tf", WALK("                R2.TransferFields(R);\n                R2.Modify();")),
          proc("Asg", WALK("                R2 := R;\n                R2.Modify();")),
          proc("Cp", WALK("                R2.Copy(R);\n                R2.Modify();")),
          proc("Ini", WALK("                R2.Init();\n                R2.Modify();")),
        ),
      ),
    );
    // revert: the whole-record write branch (one assertion per form)
    expect(p.refused("cu.al", "R2.Modify()", 1)).toBe(true);
    expect(p.refused("cu.al", "R2.Modify()", 2)).toBe(true);
    expect(p.refused("cu.al", "R2.Modify()", 3)).toBe(true);
    expect(p.refused("cu.al", "R2.Modify()", 4)).toBe(true);
  });

  it("11. the implicit Rec as the mover, in a table procedure whose walked record is a local", () => {
    const procs = `
    procedure Renum(NewNo: Code[20])
    var
        R: Record "R696 Line";
    begin
        R.SetCurrentKey("Doc No.");
        if R.FindSet() then
            repeat
                "Doc No." := NewNo;
                Modify();
            until R.Next() = 0;
    end;
`;
    const p = project({ "line.al": LINE_TABLE(procs), "other.al": OTHER_TABLE });
    // revert: the implicit-Rec branch
    expect(p.refused("line.al", "Modify()")).toBe(true);
  });

  it("12. SetCurrentKey on the other branch of an if counts (the union of every branch)", () => {
    const p = project(
      files(
        CU(
          proc(
            "Branch",
            `        if Limit > 0 then
            R.SetCurrentKey("Doc No.")
        else
            R.SetCurrentKey(Seq);
        if R.FindSet() then
            repeat
${MOVE_DOC}
            until R.Next() = 0;`,
          ),
        ),
      ),
    );
    // revert: the union back to the last SetCurrentKey only
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
  });

  it("13. a SetView on R before the loop: every field counts; without it a Note write is no key write", () => {
    const write = `                R2.Get(R."No.");
                R2.Note := 'x';
                R2.Modify();`;
    const p = project(
      files(
        CU(
          proc("View", WALK(write, "R.SetView('sorting(Seq)');")),
          proc("NoView", WALK(write, "R.SetRange(Status, 1);")),
        ),
      ),
    );
    // revert: the SetView fail-closed branch
    expect(p.refused("cu.al", "R2.Modify()", 1)).toBe(true);
    expect(p.refused("cu.al", "R2.Modify()", 2)).toBe(false);
  });

  it("14. the while R.Next() <> 0 form is found", () => {
    const p = project(
      files(
        CU(
          proc(
            "WhileForm",
            `        if R.FindFirst() then
            while R.Next() <> 0 do begin
                R2.Rename(NewNo);
            end;`,
          ),
        ),
      ),
    );
    // revert: the while branch of the Next finder
    expect(p.refused("cu.al", "R2.Rename(NewNo)")).toBe(true);
  });

  it("15. a key set by the caller (R a parameter, no SetCurrentKey): fail closed, every field counts", () => {
    const p = project(
      files(
        CU(
          proc(
            "Param",
            `        if R.FindSet() then
            repeat
                R2.Get(R."No.");
                R2.Note := 'x';
                R2.Modify();
            until R.Next() = 0;`,
            `var R: Record "R696 Line"`,
            `        R2: Record "R696 Line";`,
          ),
        ),
      ),
    );
    // revert: the caller-key fail-closed ruling
    expect(p.refused("cu.al", "R2.Modify()")).toBe(true);
  });
});

const ITEM_REPORT = (body: string, extra = ""): string => `report 50210 "R696 Rpt"
{
    dataset
    {
        dataitem(Ln; "R696 Line")
        {
            DataItemTableView = sorting(Seq);
${body}
        }
    }
${extra}
}`;

describe("R696 shape A: a report data item whose triggers move or insert into its own table", () => {
  it("2. the Resend shape: Validate of the SORTING field, Modify on a second variable; the Skip is refused", () => {
    const trigger = (field: string): string => `            trigger OnAfterGetRecord()
            var
                Sorter: Record "R696 Other";
                NewLn: Record "R696 Line";
            begin
                if Sorter.Get(Ln."No.") then
                    CurrReport.Skip();
                NewLn.Validate(${field}, 5);
                NewLn.Modify(true);
            end;`;
    const p = project({
      "line.al": LINE_TABLE(),
      "other.al": OTHER_TABLE,
      "rpt.al": ITEM_REPORT(trigger("Seq")),
      "twin.al": ITEM_REPORT(trigger("Status"))
        .replace('"R696 Rpt"', '"R696 Rpt Twin"')
        .replace("50210", "50211")
        .replace("sorting(Seq)", 'sorting("No.")'),
    });
    // revert: the A scope push (the key comes from SORTING only: no SetCurrentKey, Seq is not the primary key)
    expect(p.refused("rpt.al", "CurrReport.Skip()")).toBe(true);
    // revert: the key test (Status is in neither SORTING nor the primary key)
    expect(p.refused("twin.al", "CurrReport.Skip()")).toBe(false);
  });

  it("7. an item filter in OnPreReport and the assignment that feeds it are refused", () => {
    const p = project({
      "line.al": LINE_TABLE(),
      "other.al": OTHER_TABLE,
      "rpt.al": ITEM_REPORT(
        `            trigger OnAfterGetRecord()
            var
                Moved: Record "R696 Line";
            begin
                Moved.Get(Ln."No.");
                Moved.Rename(Ln."Doc No.");
            end;`,
        `    var
        Mid: Integer;
        Limit: Integer;

    trigger OnPreReport()
    begin
        Mid := Limit + 1;
        Ln.SetRange(Status, Mid);
    end;`,
      ),
    });
    // revert: the A filters push
    expect(p.refused("rpt.al", "Ln.SetRange(Status, Mid)")).toBe(true);
    expect(p.refused("rpt.al", "Mid := Limit + 1")).toBe(true);
  });

  it("16. a one-hop table procedure with a bare Insert, called as V.P() on a variable of the item's table", () => {
    const procs = `
    procedure AddCopy()
    begin
        Insert();
    end;
`;
    const p = project({
      "line.al": LINE_TABLE(procs),
      "other.al": OTHER_TABLE,
      "rpt.al": ITEM_REPORT(`            trigger OnAfterGetRecord()
            var
                Extra: Record "R696 Line";
            begin
                if Ln.Status = 1 then
                    CurrReport.Skip();
                Extra.AddCopy();
            end;`),
    });
    // revert: the table-procedure branch
    expect(p.refused("rpt.al", "CurrReport.Skip()")).toBe(true);
  });

  it("23. twin: a callee that inserts into ANOTHER table leaves the item emitted", () => {
    const cu = `codeunit 50220 "R696 Writer"
{
    procedure Add()
    var
        O: Record "R696 Other";
    begin
        O.Insert();
    end;
}`;
    const p = project({
      "line.al": LINE_TABLE(),
      "other.al": OTHER_TABLE,
      "writer.al": cu,
      "rpt.al": ITEM_REPORT(`            trigger OnAfterGetRecord()
            var
                W: Codeunit "R696 Writer";
            begin
                if Ln.Status = 1 then
                    CurrReport.Skip();
                W.Add();
            end;`),
    });
    // red when the callee table test is dropped
    expect(p.refused("rpt.al", "CurrReport.Skip()")).toBe(false);
  });
});

describe("R696 shape A: keys set by a bare call in the item's own trigger, and a codeunit callee", () => {
  const byNo = (s: string): string => s.replace("sorting(Seq)", 'sorting("No.")');
  const trigs = (pre: string, field: string): string => `            trigger OnPreDataItem()
            begin
${pre}
            end;

            trigger OnAfterGetRecord()
            var
                N: Record "R696 Line";
            begin
                N.Get(Ln."No.");
                N.${field} := 'X';
                N.Modify();
                CurrReport.Skip();
            end;`;
  const skipRefused = (pre: string, field: string): boolean =>
    project({
      "line.al": LINE_TABLE(),
      "other.al": OTHER_TABLE,
      "rpt.al": byNo(ITEM_REPORT(trigs(pre, field))),
    }).refused("rpt.al", "CurrReport.Skip()");

  it("24. a BARE SetCurrentKey in OnPreDataItem is part of the item's key (the Skip is refused)", () => {
    // revert: the bare-call branch of the item's key collector
    expect(skipRefused('                SetCurrentKey("Doc No.");', '"Doc No."')).toBe(true);
    // twin: no SetCurrentKey, "Doc No." is in neither SORTING nor the primary key
    expect(skipRefused("                SetRange(Status, 1);", '"Doc No."')).toBe(false);
  });

  it("24b. a BARE SetView in OnPreDataItem makes every field a key field", () => {
    // revert: the bare-call branch of the item's key collector
    expect(skipRefused("                SetView('sorting(Seq)');", "Note")).toBe(true);
    // twin: a bare SetRange leaves Note outside the key
    expect(skipRefused("                SetRange(Status, 1);", "Note")).toBe(false);
  });

  it("25. a codeunit callee that inserts into the item's table is followed", () => {
    const cu = `codeunit 50221 "R696 Inserter"
{
    procedure Add()
    var
        L: Record "R696 Line";
    begin
        L.Insert();
    end;
}`;
    const p = project({
      "line.al": LINE_TABLE(),
      "other.al": OTHER_TABLE,
      "inserter.al": cu,
      "rpt.al": ITEM_REPORT(`            trigger OnAfterGetRecord()
            var
                W: Codeunit "R696 Inserter";
            begin
                if Ln.Status = 1 then
                    CurrReport.Skip();
                W.Add();
            end;`),
    });
    // revert: the callee rule (callTargets over scopes)
    expect(p.refused("rpt.al", "CurrReport.Skip()")).toBe(true);
  });
});

describe("R696 twins: loops that must stay emitted", () => {
  it("17. the walked variable's own Modify never revisits a row", () => {
    const p = project(
      files(
        CU(
          proc(
            "OwnModify",
            WALK(`                if R.Note = FirstNo then
                    exit;
                R."Doc No." := NewNo;
                R.Modify();`),
          ),
        ),
      ),
    );
    // red when the "V differs from R" test is dropped
    expect(p.refused("cu.al", "R.Modify()")).toBe(false);
    expect(p.refused("cu.al", "exit")).toBe(false);
  });

  it("18. a walked TEMPORARY record, and a TEMPORARY mover, are skipped", () => {
    const tempVars = (r: string, r2: string): string => `        R: Record "R696 Line"${r};
        R2: Record "R696 Line"${r2};`;
    const body = WALK(`                if R.Note = FirstNo then
                    exit;
${MOVE_DOC}`);
    const p = project(
      files(
        CU(
          proc("TempWalk", body, PARAMS, tempVars(" temporary", "")),
          proc("TempMover", body, PARAMS, tempVars("", " temporary")),
          proc("Plain", body, PARAMS, tempVars("", "")),
        ),
      ),
    );
    // red when the walked-record temporary skip is dropped
    expect(p.refused("cu.al", "R2.Modify()", 1)).toBe(false);
    expect(p.refused("cu.al", "exit", 1)).toBe(false);
    // red when the mover's temporary test is dropped
    expect(p.refused("cu.al", "R2.Modify()", 2)).toBe(false);
    expect(p.refused("cu.al", "R2.Modify()", 3)).toBe(true);
  });

  it("19. a write to a field that is in no key is no mover", () => {
    const p = project(
      files(
        CU(
          proc(
            "NonKey",
            WALK(`                R2.Get(R."No.");
                R2.Note := 'x';
                R2.Modify();`),
          ),
        ),
      ),
    );
    // red when the key test is dropped
    expect(p.refused("cu.al", "R2.Modify()")).toBe(false);
  });

  it("20. a Next loop with an exit and no mover is not refused", () => {
    const p = project(
      files(
        CU(
          proc(
            "NoMover",
            WALK(`                if R.Status = 1 then
                    exit;
                Mid := Mid + 1;`),
          ),
        ),
      ),
    );
    // red when "has a mover" is not required
    expect(p.refused("cu.al", "exit")).toBe(false);
  });

  it("21. a SetCurrentKey after the loop is not the loop's key; inside an enclosing loop it is", () => {
    const after = `        if R.FindSet() then
            repeat
${MOVE_DOC}
            until R.Next() = 0;
        R.SetCurrentKey("Doc No.");`;
    const enclosed = `        for Mid := 1 to 2 do begin
            if R.FindSet() then
                repeat
${MOVE_DOC}
                until R.Next() = 0;
            R.SetCurrentKey("Doc No.");
        end;`;
    const p = project(files(CU(proc("After", after), proc("Enclosed", enclosed))));
    // red when text order is ignored
    expect(p.refused("cu.al", "R2.Modify()", 1)).toBe(false);
    // red when the enclosing-loop rule (S5) is dropped
    expect(p.refused("cu.al", "R2.Modify()", 2)).toBe(true);
  });

  it("22. a break of an inner loop is not an exit of the walk", () => {
    const p = project(
      files(
        CU(
          proc(
            "InnerBreak",
            WALK(`                for Mid := 1 to 3 do
                    if Mid = 2 then
                        break;
                R2.Rename(NewNo);`),
          ),
        ),
      ),
    );
    expect(p.refused("cu.al", "R2.Rename(NewNo)")).toBe(true);
    // red when exitsLoop is dropped
    expect(p.refused("cu.al", "break")).toBe(false);
  });
});
