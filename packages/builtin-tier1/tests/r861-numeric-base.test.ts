import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  evaluateArms,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";
import { objectsOfType, r532PresetFeedCensus } from "../src/loop-hazard";
import { removeAssignment } from "../src/remove-assignment";

/**
 * R861: tree-sitter-al 4.6.0 parses `extends 50100` as an `integer` base. Readers that match the
 * extended object by NAME missed it, where 4.5.0's unparsed object was caught by conservative
 * fallbacks. One rule: a number resolves to the project object of that type with that id; an id no
 * project object has (a dependency's) is unresolved and takes the conservative path. Each reader
 * is tested with a resolved id, an unresolved id and a plain name.
 */
beforeAll(async () => {
  await initParser();
});

type Files = Record<string, string>;
function parsedOf(files: Files) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    src,
    root: wrapRoot(parseAL(src)),
  }));
  const arms = new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.src, [])]));
  return { parsed, ctx: buildSemanticContext(parsed, arms) };
}
function find(files: Files, path: string, text: string) {
  const { parsed, ctx } = parsedOf(files);
  const f = parsed.find((p) => p.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  let hit: ALSyntaxNode | undefined;
  visit(f.root, (n: ALSyntaxNode) => {
    if (hit === undefined && n.text === text) hit = n;
  });
  if (hit === undefined) throw new Error(`"${text}" not found in ${path}`);
  return { hit, ctx };
}
const VMC = "lethal.void-method-call";
const refused = (files: Files, path: string, text: string): boolean => {
  const { hit, ctx } = find(files, path, text);
  return openItemHangRefuses(hit, ctx, VMC);
};

// ---- reader 1: R487 / R500 shape 7, the report extension's base ----
const REPORT = [
  "report 50100 R",
  "{",
  "    dataset",
  "    {",
  '        dataitem(D; "Integer")',
  "        {",
  "            DataItemTableView = where(Number = const(1));",
  "            trigger OnAfterGetRecord()",
  "            begin",
  "                Continue := false;",
  "            end;",
  "        }",
  "    }",
  "    var",
  "        Continue: Boolean;",
  "}",
].join("\n");
const OTHER_REPORT = "report 50102 Q\n{\n    dataset\n    {\n    }\n}";
const reportExt = (base: string) =>
  `reportextension 50101 X extends ${base}\n{\n    dataset\n    {\n        modify(D)\n        {\n            trigger OnAfterPreDataItem()\n            begin\n                D.SetRange(Number, 1, 2147483647);\n            end;\n        }\n    }\n}`;
const sitesOf = (extra: string[]) => {
  const files = [REPORT, ...extra];
  const { parsed, ctx } = parsedOf(Object.fromEntries(files.map((s, i) => [`f${i}.al`, s])));
  const first = parsed[0];
  if (first === undefined) throw new Error("no file");
  const out: string[] = [];
  visit(first.root, (n: ALSyntaxNode) => {
    if (removeAssignment.targets(n, ctx)) out.push(n.text);
  });
  return out;
};

describe("R861 reader 1: a numeric reportextension base voids the base report's view certificate", () => {
  it("resolved (`extends 50100`, the report's id): the base report's write is refused (red: no numeric branch)", () => {
    expect(sitesOf([reportExt("50100")])).toEqual([]);
  });
  it("unresolved (`extends 50199`, no project report): refused too, as R500 shape 7 (red: the id is taken as a name)", () => {
    expect(sitesOf([reportExt("50199")])).toEqual([]);
  });
  it("resolved to ANOTHER report (`extends 50102`): the base certificate holds (red: unresolved read as any)", () => {
    expect(sitesOf([OTHER_REPORT, reportExt("50102")])).toEqual(["Continue := false"]);
  });
  it("a plain name: refused; another name: claimed", () => {
    expect(sitesOf([reportExt("R")])).toEqual([]);
    expect(sitesOf([reportExt("Z")])).toEqual(["Continue := false"]);
  });
  it("no extension: the certificate holds", () => {
    expect(sitesOf([])).toEqual(["Continue := false"]);
  });
});

// ---- reader 3: tableExtBase, through objectsOfType ----
const TABLE = (id: number, name: string) =>
  `table ${id} "${name}"\n{\n    fields { field(1; "No."; Code[20]) { } }\n}`;
const tableExt = (base: string, body = "") =>
  `tableextension 50111 E extends ${base}\n{\n${body}\n}`;
const extCount = (files: string[], table: string): number =>
  objectsOfType(
    { kind: "table", name: table, temporary: false },
    parsedOf(Object.fromEntries(files.map((s, i) => [`f${i}.al`, s]))).ctx,
  ).filter((o) => o.rawKind === "tableextension_declaration").length;

describe("R861 reader 3: objectsOfType sees a tableextension with a numeric base", () => {
  it("resolved: found under the table's name, not under another's (red: no numeric branch)", () => {
    const files = [TABLE(50110, "Tmpl"), TABLE(50112, "Other"), tableExt("50110")];
    expect(extCount(files, "tmpl")).toBe(1);
    expect(extCount(files, "other")).toBe(0);
  });
  it("unresolved: found under every table (red: the id is taken as a name)", () => {
    const files = [TABLE(50110, "Tmpl"), TABLE(50112, "Other"), tableExt("18")];
    expect(extCount(files, "tmpl")).toBe(1);
    expect(extCount(files, "other")).toBe(1);
    expect(extCount(files, "customer")).toBe(1);
  });
  it("a plain name: found under that table only", () => {
    const files = [TABLE(50110, "Tmpl"), TABLE(50112, "Other"), tableExt("Tmpl")];
    expect(extCount(files, "tmpl")).toBe(1);
    expect(extCount(files, "other")).toBe(0);
  });
});

// ---- reader 3: r696Inserts (a tableextension procedure that inserts into its own table) ----
const TMPL = `table 50110 "R861 Tmpl"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Ident; Code[20]) { }
    }
    keys { key(PK; "No.") { Clustered = true; } }
}`;
const INSERTING_EXT = (base: string) => `tableextension 50111 E extends ${base}
{
    procedure CloneNo(NewNo: Code[20]): Code[20]
    begin
        Rec."No." := NewNo;
        Insert(true);
        exit(NewNo);
    end;
}`;
const CLONE_CU = `codeunit 50112 "R861 Clone"
{
    procedure Clone(Id: Code[20]; NewNo: Code[20])
    var
        R: Record "R861 Tmpl";
        T2: Record "R861 Tmpl";
    begin
        R.SetRange(Ident, Id);
        if R.FindSet() then
            repeat
                T2.CloneNo(NewNo);
                T2.Ident := NewNo;
                T2.Modify();
            until R.Next() = 0;
    end;
}`;
const cloneFiles = (base: string): Files => ({
  "Tmpl.al": TMPL,
  "Ext.al": INSERTING_EXT(base),
  "Cu.al": CLONE_CU,
});

describe("R861 reader 3: r696Inserts sees a numeric-base tableextension's insert", () => {
  it("a plain name (control): the moved walk's Modify is refused", () => {
    expect(refused(cloneFiles('"R861 Tmpl"'), "Cu.al", "T2.Modify()")).toBe(true);
  });
  it("resolved (`extends 50110`): refused (red: no numeric branch)", () => {
    expect(refused(cloneFiles("50110"), "Cu.al", "T2.Modify()")).toBe(true);
  });
  it("unresolved (`extends 18`): refused (red: the id is taken as a name)", () => {
    expect(refused(cloneFiles("18"), "Cu.al", "T2.Modify()")).toBe(true);
  });
});

// ---- reader 3: r604Inserters (the cursor's table gets rows from a tableextension procedure) ----
const BUF = `table 57300 "R604 Buf"
{
    fields { field(1; "Entry No."; Integer) { } field(2; Grp; Integer) { } }
    keys { key(PK; "Entry No.") { Clustered = true; } }
}`;
const BUF_EXT = (base: string) => `tableextension 57303 BE extends ${base}
{
    procedure Grow(): Boolean
    begin
        Rec.Init();
        Rec."Entry No." := 0;
        Insert();
        exit(false);
    end;
}`;
const BUF_LOOP = `codeunit 57301 "R604 Loop"
{
    procedure Run()
    var
        R: Record "R604 Buf";
        Done: Boolean;
    begin
        R.SetRange(Grp, 0);
        if R.FindSet() then
            repeat
                Done := Step(R);
            until (R.Next() = 0) or Done;
    end;

    local procedure Step(var B: Record "R604 Buf"): Boolean
    var
        Tag: Text;
        L: Record "R604 Buf";
    begin
        Tag := 'T';
        if B.Grp = 0 then
            exit(L.Grow());
    end;
}`;
const bufFiles = (base: string): Files => ({
  "Buf.al": BUF,
  "Ext.al": BUF_EXT(base),
  "Loop.al": BUF_LOOP,
});

describe("R861 reader 3: r604Inserters sees a numeric-base tableextension's insert", () => {
  it("a plain name (control): the loop is refused", () => {
    expect(refused(bufFiles('"R604 Buf"'), "Loop.al", "'T'")).toBe(true);
  });
  it("resolved (`extends 57300`): refused (red: no numeric branch)", () => {
    expect(refused(bufFiles("57300"), "Loop.al", "'T'")).toBe(true);
  });
  it("unresolved (`extends 18`): refused (red: the id is taken as a name)", () => {
    expect(refused(bufFiles("18"), "Loop.al", "'T'")).toBe(true);
  });
});

// ---- reader 1: baseCandidatesOf (R547) and the preset-writer key (R555), r555's shapes ----
const PRIV_BASE = `report 50551 "Priv Base"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Go then
                    CurrReport.Break();
            end;
        }
    }

    procedure StartIt()
    begin
        Go := true;
    end;

    var
        Go: Boolean;
}`;
const PRIV_EXT = (base: string) => `reportextension 50552 "Priv Ext" extends ${base}
{
    trigger OnPreReport()
    begin
        StartIt();
    end;
}`;
const atCall = (files: Files, path: string, text: string): boolean => {
  const { parsed, ctx } = parsedOf(files);
  const f = parsed.find((p) => p.path === path);
  if (f === undefined) throw new Error(`no file ${path}`);
  let hit: ALSyntaxNode | undefined;
  visit(f.root, (n: ALSyntaxNode) => {
    if (hit === undefined && n.rawKind === "call_expression" && n.text === text) hit = n;
  });
  if (hit === undefined) throw new Error(`${text} not found`);
  return openItemHangRefuses(hit, ctx, undefined);
};

describe("R861 reader 1: baseCandidatesOf reads a numeric reportextension base", () => {
  const priv = (base: string): Files => ({ "b.al": PRIV_BASE, "e.al": PRIV_EXT(base) });
  it("a plain name (control): the call to the base writer `StartIt()` is refused", () => {
    expect(atCall(priv('"Priv Base"'), "e.al", "StartIt()")).toBe(true);
  });
  it("resolved (`extends 50551`): refused (red: the id is taken as a name)", () => {
    expect(atCall(priv("50551"), "e.al", "StartIt()")).toBe(true);
  });
  it("unresolved (`extends 59999`): refused (red: the id is taken as a name)", () => {
    expect(atCall(priv("59999"), "e.al", "StartIt()")).toBe(true);
  });
});

const CROSS_REP = `report 50555 "Cross Rep"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
            end;
        }
    }

    procedure Other()
    begin
    end;

    protected var
        Continue: Boolean;
}`;
const CROSS_EXT = (base: string) => `reportextension 50556 "Cross Ext" extends ${base}
{
    procedure SetFromExt()
    begin
        Continue := true;
    end;
}`;
const CROSS_MGT = `codeunit 50557 "Cross Mgt"
{
    procedure Go()
    var
        Rep: Report "Cross Rep";
    begin
        Rep.SetFromExt();
        Rep.RunModal();
    end;
}`;

describe("R861 reader 1: the preset-writer key and r532's filter read a numeric reportextension base", () => {
  const cross = (base: string): Files => ({
    "r.al": CROSS_REP,
    "e.al": CROSS_EXT(base),
    "c.al": CROSS_MGT,
  });
  it("a plain name (control): `Rep.SetFromExt()` is refused", () => {
    expect(atCall(cross('"Cross Rep"'), "c.al", "Rep.SetFromExt()")).toBe(true);
  });
  it("resolved (`extends 50555`): refused (red: the id is taken as a name)", () => {
    expect(atCall(cross("50555"), "c.al", "Rep.SetFromExt()")).toBe(true);
  });
  it("unresolved (`extends 59999`): refused (red: the id is taken as a name)", () => {
    expect(atCall(cross("59999"), "c.al", "Rep.SetFromExt()")).toBe(true);
  });
});

// ---- reader 1: r532's census filter (`Report X` receiver reaches the extension's procedures) ----
const CENSUS_REP = `report 50532 "Feed Rep"
{
    dataset
    {
        dataitem(Loop; Integer)
        {
            trigger OnAfterGetRecord()
            begin
                if not Continue then
                    CurrReport.Break();
            end;
        }
    }

    procedure Reset()
    var
        Other: Report "Feed Rep";
    begin
        Continue := Other.Compute();
    end;

    var
        Continue: Boolean;
}`;
const CENSUS_EXT = (base: string) => `reportextension 50533 "Feed Ext" extends ${base}
{
    procedure Compute(): Boolean
    begin
        exit(true);
    end;
}`;
describe("R861 reader 1: r532's census filter reads a numeric reportextension base", () => {
  const tagsOf = (base: string): string[] =>
    r532PresetFeedCensus(parsedOf({ "r.al": CENSUS_REP, "e.al": CENSUS_EXT(base) }).ctx).flatMap(
      (r) => r.tags,
    );
  it("a plain name (control): `Other.Compute()` reaches the extension (A-report)", () => {
    expect(tagsOf('"Feed Rep"')).toContain("A-report");
  });
  it("resolved (`extends 50532`): A-report (red: the id is taken as a name)", () => {
    expect(tagsOf("50532")).toContain("A-report");
  });
  it("unresolved (`extends 59999`): A-report (red: a null base is dropped)", () => {
    expect(tagsOf("59999")).toContain("A-report");
  });
});
