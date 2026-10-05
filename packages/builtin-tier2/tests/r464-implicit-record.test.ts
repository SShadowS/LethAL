import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R-464: one implicit-record resolver (`recordScopesAt`, engine `semantic/receiver.ts`).
 *
 * Plan: docs/superpowers/plans/2026-10-05-R-464-implicit-record-resolver.md, section 4. These tests
 * assert the GENERATED TEXT (the receiver the mutant writes to), not only claim/no-claim, because
 * the defect class is a mutant of a different record: master emits `Rec.Amount := 1` for a bare
 * `Validate(Amount, 1)` inside `with R do begin ... end`.
 */
import {
  ALNodeKind,
  type MutationOperator,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { removeCommit } from "../src/remove-commit";
import { swapModifyFlag } from "../src/swap-modify-flag";
import { validateToAssign } from "../src/validate-to-assign";
import { parseClean } from "./parse-clean";

/** `<before> => <after> [<tag>]` for every spec `op` emits in file `O.al`, one project context. */
function emitted(
  op: MutationOperator,
  files: Readonly<Record<string, string>>,
  strict = true,
): string[] {
  // `strict` false only where the grammar cannot parse valid AL (an `#if` inside a declaration
  // list, test 10c): that object is exactly the text the scan must still read.
  const parsed = Object.entries(files).map(([path, text]) => ({
    path,
    root: strict ? parseClean(text) : wrapRoot(parseAL(text)),
  }));
  const ctx = buildSemanticContext(parsed);
  const ops = parsed.find((p) => p.path === "O.al");
  if (ops === undefined) throw new Error("no O.al");
  return findAll(ops.root, ALNodeKind.procedure_call)
    .filter((n) => op.targets(n, ctx))
    .flatMap((n) => op.generate(n, ctx))
    .map((s) => `${s.before.text} => ${s.after.text} [${s.platformKillMechanism ?? "-"}]`);
}

const OWN = `table 50100 Own
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
        field(3; Flag; Boolean) { }
    }
    keys { key(PK; "No.") { } }
    trigger OnModify()
    var
        Other: Record Other;
    begin
        Other.DeleteAll();
    end;
}`;
const OTHER = `table 50101 Other
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    keys { key(PK; "No.") { } }
}`;
const base = { "Own.al": OWN, "Other.al": OTHER };

describe("R-464 implicit-record resolver: generated text", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Test 1: page with SourceTable, qualified `Rec.` (was unresolved while the bare form claimed).
  it("1a. page SourceTable: qualified Rec.Modify(true) is claimed and keeps its receiver", () => {
    const page = `page 50103 OwnCard
{
    SourceTable = Own;
    trigger OnOpenPage()
    begin
        Rec.Modify(true);
    end;
}`;
    expect(emitted(swapModifyFlag, { ...base, "O.al": page })).toEqual([
      "Rec.Modify(true) => Rec.Modify(false) [run-trigger-skipped-modify]",
    ]);
  });

  it("1b. pageextension: bare and qualified Rec calls stay refused (R30/R67)", () => {
    const page = "page 50103 OwnCard { SourceTable = Own; }";
    const ext = `pageextension 50104 OwnCardExt extends OwnCard
{
    trigger OnOpenPage()
    begin
        Rec.Modify(true);
        Modify(true);
        Validate(Amount, 1);
    end;
}`;
    const files = { ...base, "P.al": page, "O.al": ext };
    expect(emitted(swapModifyFlag, files)).toEqual([]);
    expect(emitted(validateToAssign, files)).toEqual([]);
  });

  // Test 2: TableNo codeunit, OnRun only, Rec only.
  it("2a. TableNo OnRun: bare and qualified Validate bind the TableNo table's Rec", () => {
    const cu = `codeunit 50102 TableNoRun
{
    TableNo = Own;
    trigger OnRun()
    begin
        Validate(Amount, 2);
        Rec.Validate(Amount, 3);
    end;
}`;
    expect(emitted(validateToAssign, { ...base, "O.al": cu })).toEqual([
      "Validate(Amount, 2) => Rec.Amount := 2 [-]",
      "Rec.Validate(Amount, 3) => Rec.Amount := 3 [-]",
    ]);
  });

  it("2b. TableNo codeunit: xRec in OnRun and Rec outside OnRun stay unresolved", () => {
    const cu = `codeunit 50102 TableNoRun
{
    TableNo = Own;
    trigger OnRun()
    begin
        xRec.Modify(true);
    end;
    procedure NotOnRun()
    begin
        Rec.Modify(true);
        Modify(true);
    end;
}`;
    expect(emitted(swapModifyFlag, { ...base, "O.al": cu })).toEqual([]);
  });

  // Test 3: a `with` subject is the receiver of a bare call (sol's WRONG mutant).
  it("3a. TableNo OnRun: a bare Validate inside `with R do` writes R, not Rec", () => {
    const cu = `codeunit 50102 TableNoRun
{
    TableNo = Own;
    trigger OnRun()
    var
        R: Record Other;
    begin
        with R do begin
            Validate(Amount, 1);
        end;
        Validate(Amount, 2);
    end;
}`;
    expect(emitted(validateToAssign, { ...base, "O.al": cu })).toEqual([
      "Validate(Amount, 1) => R.Amount := 1 [-]",
      "Validate(Amount, 2) => Rec.Amount := 2 [-]",
    ]);
  });

  it("3b. table trigger and page: bare Validate inside `with R do` writes R (master: Rec)", () => {
    const tbl = `table 50105 WithTable
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    trigger OnInsert()
    var
        R: Record Other;
    begin
        with R do begin
            Validate(Amount, 1);
        end;
    end;
}`;
    const page = `page 50106 WithPage
{
    SourceTable = Own;
    trigger OnOpenPage()
    var
        R: Record Other;
    begin
        with R do begin
            Validate(Amount, 4);
        end;
        Validate(Amount, 5);
    end;
}`;
    expect(emitted(validateToAssign, { ...base, "O.al": tbl })).toEqual([
      "Validate(Amount, 1) => R.Amount := 1 [-]",
    ]);
    expect(emitted(validateToAssign, { ...base, "O.al": page })).toEqual([
      "Validate(Amount, 4) => R.Amount := 4 [-]",
      "Validate(Amount, 5) => Rec.Amount := 5 [-]",
    ]);
  });

  it("3c. the swap-modify-flag tag follows the with subject's table, not Rec's", () => {
    // Own's OnModify writes another table (a skip can raise); Other has no OnModify.
    const page = `page 50106 WithPage
{
    SourceTable = Own;
    trigger OnOpenPage()
    var
        R: Record Other;
    begin
        with R do begin
            Modify(true);
        end;
        Modify(true);
    end;
}`;
    expect(emitted(swapModifyFlag, { ...base, "O.al": page })).toEqual([
      "Modify(true) => Modify(false) [-]",
      "Modify(true) => Modify(false) [run-trigger-skipped-modify]",
    ]);
  });

  // Test 4: report dataitem chain.
  it("4. dataitem chain: inner bare call binds the inner dataitem; outer name resolves", () => {
    const rep = `report 50107 Rep
{
    dataset
    {
        dataitem(Hdr; Own)
        {
            dataitem(Line; Other)
            {
                trigger OnAfterGetRecord()
                begin
                    Validate(Amount, 6);
                    Hdr.Validate(Amount, 7);
                end;
            }
        }
    }
    procedure Outside()
    begin
        Validate(Amount, 8);
    end;
}`;
    expect(emitted(validateToAssign, { ...base, "O.al": rep })).toEqual([
      "Validate(Amount, 6) => Line.Amount := 6 [-]",
      "Hdr.Validate(Amount, 7) => Hdr.Amount := 7 [-]",
    ]);
  });

  // claimsSystemCall rule 3 reaches every record scope: a TableNo table's own `Commit` wins.
  it("5. TableNo OnRun: a bare Commit() is the table's procedure when the table declares one", () => {
    const own = OWN.replace(
      "    trigger OnModify()",
      "    procedure Commit()\n    begin\n    end;\n    trigger OnModify()",
    );
    const cu = `codeunit 50109 RunCommit
{
    TableNo = Own;
    trigger OnRun()
    begin
        Commit();
    end;
}`;
    const plain = cu.replace("TableNo = Own;", "");
    expect(emitted(removeCommit, { ...base, "Own.al": own, "O.al": cu })).toEqual([]);
    expect(emitted(removeCommit, { ...base, "Own.al": own, "O.al": plain })).toEqual([
      "Commit() =>  [-]",
    ]);
  });

  // Test 6: a tableextension field `modify(...)` is not a record scope (prototype bug the diff found).
  it("6. tableextension field modify trigger: bare Validate is still claimed on Rec", () => {
    const ext = `tableextension 50108 OwnExt extends Own
{
    fields
    {
        modify(Flag)
        {
            trigger OnAfterValidate()
            begin
                Validate(Amount, 9);
            end;
        }
    }
}`;
    expect(emitted(validateToAssign, { ...base, "O.al": ext })).toEqual([
      "Validate(Amount, 9) => Rec.Amount := 9 [-]",
    ]);
  });
});

describe("R-464 prefix proof: the spelled receiver must BIND the call's record", () => {
  beforeAll(async () => {
    await initParser();
  });

  const U = `table 50111 U
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
}`;

  // Test 8 (sol r1).
  it("8a. a local `Rec: Record U` in a table trigger: no spec (master: Rec.Amount := 1)", () => {
    const t = `table 50110 T
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    trigger OnInsert()
    var
        Rec: Record U;
    begin
        Validate(Amount, 1);
    end;
}`;
    const control = `table 50112 T2
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    trigger OnModify()
    begin
        Validate(Amount, 11);
    end;
}`;
    expect(emitted(validateToAssign, { "U.al": U, "O.al": t })).toEqual([]);
    expect(emitted(validateToAssign, { "U.al": U, "O.al": control })).toEqual([
      "Validate(Amount, 11) => Rec.Amount := 11 [-]",
    ]);
  });

  it("8b. nested with whose inner table has a field named like the subject: no spec", () => {
    const inner = `table 50112 Inner
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal) { }
        field(3; R; Integer) { }
    }
}`;
    const outer = `table 50113 Outer { fields { field(1; "No."; Code[20]) { } } }`;
    const cu = `codeunit 50114 Nest
{
    procedure P()
    var
        O: Record Outer;
        R: Record Inner;
        Q: Record U;
    begin
        with O do begin
            with R do begin
                Validate(Amount, 1);
            end;
        end;
        with Q do begin
            Validate(Amount, 2);
        end;
    end;
}`;
    expect(
      emitted(validateToAssign, { "U.al": U, "I.al": inner, "X.al": outer, "O.al": cu }),
    ).toEqual(["Validate(Amount, 2) => Q.Amount := 2 [-]"]);
  });

  it("8c. `with Rec do` (a subject that is no declaration) is refused, not compared", () => {
    // The prefix rule compares the subject's DECLARATION at the with and at the call; `Rec` has
    // none, so the bare call is refused rather than assumed (conservative, measured: no site lost).
    const page = `page 50115 WithRec
{
    SourceTable = U;
    trigger OnOpenPage()
    begin
        with Rec do begin
            Validate(Amount, 1);
        end;
    end;
}`;
    expect(emitted(validateToAssign, { "U.al": U, "O.al": page })).toEqual([]);
  });

  // Test 9 (sol r2).
  it("9a. an `#if`-only local `Rec: Record U`: no spec (master and r2: Rec.Amount := 1)", () => {
    const t = `table 50120 T2
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    procedure P()
    var
#if X
        Rec: Record U;
#endif
        Dummy: Integer;
    begin
        Validate(Amount, 1);
    end;
    procedure Control()
    begin
        Validate(Amount, 3);
    end;
}`;
    expect(emitted(validateToAssign, { "U.al": U, "O.al": t })).toEqual([
      "Validate(Amount, 3) => Rec.Amount := 3 [-]",
    ]);
  });

  it("9b. `with` over a record whose table is not in the project: not claimed at all", () => {
    const cu = `codeunit 50122 DepWith
{
    procedure P(Name: Record Customer)
    begin
        with Name do begin
            Validate("No.", 'X');
        end;
    end;
}`;
    expect(emitted(validateToAssign, { "O.al": cu })).toEqual([]);
    // Refused in targets() too, so it is not a claimed site with no spec.
    const root = parseClean(cu);
    const ctx = buildSemanticContext([{ path: "O.al", root }]);
    const claimed = findAll(root, ALNodeKind.procedure_call).filter((n) =>
      validateToAssign.targets(n, ctx),
    );
    expect(claimed).toEqual([]);
  });

  it("9c. an `#if`-only field named like the with subject: no spec", () => {
    const inner = `table 50123 Inner2
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
#if X
        field(3; R2; Integer) { }
#endif
    }
}`;
    const cu = `codeunit 50124 Hidden
{
    procedure P(R2: Record Inner2)
    begin
        with R2 do begin
            Validate(Amount, 4);
        end;
    end;
}`;
    expect(emitted(validateToAssign, { "I.al": inner, "O.al": cu })).toEqual([]);
  });

  // Test 10 (sol r3, Opus r4/r5).
  it("10a. a field hidden after a string holding `//`: no spec (the engine's lexer)", () => {
    const t3 = `table 50140 T3
{
    fields
    {
        field(1; Amount; Decimal) { Caption = 'https://x'; } field(2; R; Integer) { }
    }
}`;
    const t4 = `table 50141 T4
{
    fields
    {
        field(1; Amount; Decimal) { Caption = 'https://x'; }
        field(2; Other; Integer) { }
    }
}`;
    const cu = `codeunit 50142 MaskCase
{
    procedure P(R: Record T3)
    begin
        with R do begin
            Validate(Amount, 1);
        end;
    end;
    procedure Control(Q: Record T4)
    begin
        with Q do begin
            Validate(Amount, 2);
        end;
    end;
}`;
    expect(emitted(validateToAssign, { "T3.al": t3, "T4.al": t4, "O.al": cu })).toEqual([
      "Validate(Amount, 2) => Q.Amount := 2 [-]",
    ]);
  });

  it("10b. an object-level `#if` declaration list naming Rec: no spec", () => {
    const t6 = `table 50154 T6
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    procedure P()
    begin
        Validate(Amount, 4);
    end;
#if CLEAN
    var
        Rec, Dummy: Record U;
#endif
}`;
    const t7 = `table 50155 T7
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    procedure P()
    begin
        Validate(Amount, 5);
    end;
    var
        Dummy: Record U;
}`;
    expect(emitted(validateToAssign, { "U.al": U, "O.al": t6 })).toEqual([]);
    expect(emitted(validateToAssign, { "U.al": U, "O.al": t7 })).toEqual([
      "Validate(Amount, 5) => Rec.Amount := 5 [-]",
    ]);
  });

  it("10c. a declaration list broken by `#if` lines still names Rec: no spec", () => {
    const t8 = `table 50156 T8
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    procedure P()
    begin
        Validate(Amount, 6);
    end;
#if OUTER
    var
        Rec,
#if CLEAN
        Other,
#endif
        Dummy: Record U;
#endif
}`;
    // The call itself parses (the ERROR is confined to the `#if` arm); the control proves the
    // operator still reaches a Validate in the same object shape without the list.
    const control = t8.replace("Rec,\n", "Keep,\n");
    expect(emitted(validateToAssign, { "U.al": U, "O.al": t8 }, false)).toEqual([]);
    expect(emitted(validateToAssign, { "U.al": U, "O.al": control }, false)).toEqual([
      "Validate(Amount, 6) => Rec.Amount := 6 [-]",
    ]);
  });

  it("10d. a table procedure named like the with subject: no spec", () => {
    const w5 = `table 50152 W5
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    procedure R(): Integer
    begin
        exit(0);
    end;
}`;
    const cu = `codeunit 50153 ProcCase
{
    procedure P(R: Record W5)
    begin
        with R do begin
            Validate(Amount, 2);
        end;
    end;
    procedure Control(Q: Record U)
    begin
        with Q do begin
            Validate(Amount, 3);
        end;
    end;
}`;
    expect(emitted(validateToAssign, { "U.al": U, "W.al": w5, "O.al": cu })).toEqual([
      "Validate(Amount, 3) => Q.Amount := 3 [-]",
    ]);
  });
});
