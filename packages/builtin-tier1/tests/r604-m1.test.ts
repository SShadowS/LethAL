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
import { type R572Gaps, r572Census } from "../src/loop-hazard";

/**
 * R-604b (roadmap R604, shape M1, narrowed): a same-object callee that gets the loop's forcing
 * cursor and either (A0) inserts or renames rows of the iterated table, or (var-touch) gets the
 * cursor by `var` and moves, filters or rewrites it, is REFUSED (it used to be dropped). A cursor
 * handed by value, with no table-level insert, stays mutated. All AL here is invented. Each site
 * is a text-literal marker inside a procedure (as in r572-flag-fed.test.ts).
 */

beforeAll(async () => {
  await initParser();
});

const VMC = "lethal.void-method-call";

const BUF = `table 57300 "R604 Buf"
{
    fields { field(1; "Entry No."; Integer) { } field(2; Val; Text[50]) { } field(3; Grp; Integer) { } }
    keys { key(PK; "Entry No.") { Clustered = true; } }
}`;
const OTHER = `table 57302 "R604 Other"
{
    fields { field(1; "Entry No."; Integer) { } }
    keys { key(PK; "Entry No.") { Clustered = true; } }
}`;

type Files = Record<string, string>;
const L = "Loop.Codeunit.al";

function parsedOf(files: Files) {
  const parsed = Object.entries(files).map(([path, src]) => ({
    path,
    src,
    root: wrapRoot(parseAL(src)),
  }));
  const arms = new Map(parsed.map((p) => [p.root, evaluateArms(p.root, p.src, [])]));
  return { parsed, ctx: buildSemanticContext(parsed, arms) };
}

/** Is the marker literal `'<tag>'` in `Loop.Codeunit.al` refused? */
function refused(files: Files, tag: string): boolean {
  const { parsed, ctx } = parsedOf(files);
  const f = parsed.find((p) => p.path === L);
  if (f === undefined) throw new Error("no loop file");
  let hit: ALSyntaxNode | undefined;
  visit(f.root, (n: ALSyntaxNode) => {
    if (hit === undefined && n.text === `'${tag}'`) hit = n;
  });
  if (hit === undefined) throw new Error(`'${tag}' not found`);
  return openItemHangRefuses(hit, ctx, VMC);
}

const gapsOf = (files: Files): R572Gaps => r572Census(parsedOf(files).ctx).gaps;

/** The loop codeunit: `Run` forces its exit with `R.Next() = 0`, and calls `call` in the body. */
const loop = (o: {
  temp?: boolean;
  filter?: string;
  callee: string;
  call?: string;
  global?: boolean;
}): string => `codeunit 57301 "R604 Loop"
{
${o.global === true ? `    var\n        R: Record "R604 Buf"${o.temp === true ? " temporary" : ""};\n` : ""}
    procedure Run()
    var
${o.global === true ? "" : `        R: Record "R604 Buf"${o.temp === true ? " temporary" : ""};\n`}        Done: Boolean;
    begin
        ${o.filter ?? ""}
        if R.FindSet() then
            repeat
                Done := ${o.call ?? "Step(R)"};
            until (R.Next() = 0) or Done;
    end;
${o.callee}
}`;

const param = (byVar: boolean, temp = false) =>
  `${byVar ? "var " : ""}B: Record "R604 Buf"${temp ? " temporary" : ""}`;
/** `Step`: a marker `'<tag>'` first, then `body`. */
const step = (
  tag: string,
  params: string,
  locals: string,
  body: string,
) => `    local procedure Step(${params}): Boolean
    var
        Tag: Text;
${locals}    begin
        Tag := '${tag}';
${body}
        exit(false);
    end;`;
const FILTER = "R.SetRange(Grp, 0);";
const L1 = '        L: Record "R604 Buf";\n';
const insertRows = (ins: string) => `        if B.Grp = 0 then begin
            L.Init();
            L."Entry No." := 0;
            L.Grp := 0;
            ${ins}
        end;`;

const files = (cu: string): Files => ({ "Buf.Table.al": BUF, "Other.Table.al": OTHER, [L]: cu });

describe("R-604b M1: a same-object callee that gets the cursor is REFUSED when it", () => {
  it("A: gets the cursor by var, writes it and inserts a row (the iterated set grows)", () => {
    const f = files(
      loop({
        filter: FILTER,
        callee: step(
          "A",
          param(true),
          L1,
          "        B.Grp := 1;\n        B.Modify();\n        L.Init();\n        L.Insert();",
        ),
      }),
    );
    expect(refused(f, "A")).toBe(true);
    expect(gapsOf(f).m1Refused).toBeGreaterThan(0);
  });
  it("A0: gets the cursor by var, only READS it, and inserts rows of the same table through a local", () => {
    const f = files(
      loop({ filter: FILTER, callee: step("A0", param(true), L1, insertRows("L.Insert();")) }),
    );
    expect(refused(f, "A0")).toBe(true);
    expect(gapsOf(f).m1RefusedA0).toBeGreaterThan(0);
  });
  it("A0p: the same with a paren-less `L.Insert;`", () => {
    const f = files(
      loop({ filter: FILTER, callee: step("A0p", param(true), L1, insertRows("L.Insert;")) }),
    );
    expect(refused(f, "A0p")).toBe(true);
  });
  it("A0_byvalue: gets the cursor BY VALUE and inserts rows of the same table (A0 is not gated on var)", () => {
    const f = files(
      loop({ filter: FILTER, callee: step("A0v", param(false), L1, insertRows("L.Insert();")) }),
    );
    expect(refused(f, "A0v")).toBe(true);
    expect(gapsOf(f).m1RefusedA0).toBeGreaterThan(0);
  });
  it("byvalue_insert: gets the cursor by value and inserts the cursor record itself", () => {
    const f = files(
      loop({
        filter: FILTER,
        callee: step("BVI", param(false), "", '        B."Entry No." := 0;\n        B.Insert();'),
      }),
    );
    expect(refused(f, "BVI")).toBe(true);
  });
  it("A0_temp_local: the insert goes through a TEMPORARY local of the iterated table", () => {
    const f = files(
      loop({
        filter: FILTER,
        callee: step(
          "A0t",
          param(true),
          '        L: Record "R604 Buf" temporary;\n',
          insertRows("L.Insert();"),
        ),
      }),
    );
    expect(refused(f, "A0t")).toBe(true);
  });
  it("C pin: a rows-only by-var callee (non-key field, Modify(false)) is refused: handing the cursor on makes every field count as filtered", () => {
    const f = files(
      loop({
        filter: FILTER,
        callee: step("C", param(true), "", "        B.Val := 'y';\n        B.Modify(false);"),
      }),
    );
    expect(refused(f, "C")).toBe(true);
    expect(gapsOf(f).m1RefusedVar).toBeGreaterThan(0);
  });
  it("I3 (r1): a callee with exit(<call into another object>) that touches its var cursor is refused", () => {
    const f: Files = {
      ...files(
        loop({
          filter: FILTER,
          callee: step(
            "I3x",
            param(true),
            '        O: Codeunit "R604 Pure";\n',
            "        B.SetRange(Val, 'x');\n        exit(O.Pure());",
          ),
        }),
      ),
      "Pure.Codeunit.al": `codeunit 57303 "R604 Pure"
{
    procedure Pure(): Boolean
    begin
        exit(false);
    end;
}`,
    };
    expect(refused(f, "I3x")).toBe(true);
  });
  it("B: gets a temporary cursor by var and moves it (SetRange, FindFirst)", () => {
    const f = files(
      loop({
        temp: true,
        callee: step(
          "B",
          param(true, true),
          "",
          "        B.SetRange(Val, 'x');\n        if B.FindFirst() then;",
        ),
      }),
    );
    expect(refused(f, "B")).toBe(true);
    expect(gapsOf(f).m1RefusedVar).toBeGreaterThan(0);
  });
  it("I2: names a forced GLOBAL cursor without getting it as an argument", () => {
    const callee = (shadow: boolean) => `    local procedure H(): Boolean
    var
        Tag: Text;
${shadow ? '        R: Record "R604 Buf";\n' : ""}    begin
        Tag := 'I2';
        if R.FindFirst() then;
        exit(false);
    end;`;
    const f = files(loop({ global: true, filter: FILTER, callee: callee(false), call: "H()" }));
    expect(refused(f, "I2")).toBe(true);
    expect(gapsOf(f).m1RefusedGlobal).toBeGreaterThan(0);
    // control: H declares its own R, so it does not touch the loop's cursor
    const c = files(loop({ global: true, filter: FILTER, callee: callee(true), call: "H()" }));
    expect(refused(c, "I2")).toBe(false);
  });
  it("I3: gets the cursor in a call whose arguments cannot be read, and the callee passes it on to a touch", () => {
    const f = files(
      loop({
        filter: FILTER,
        call: "Step(R, @)",
        callee: `${step("I3", `${param(true)}; N: Integer`, "", "        Touch(B);")}
    local procedure Touch(var C: Record "R604 Buf")
    var
        Tag: Text;
    begin
        Tag := 'I3t';
        C.SetRange(Val, 'x');
    end;`,
      }),
    );
    expect(gapsOf(f).m1RefusedUnknown).toBeGreaterThan(0);
    expect(refused(f, "I3")).toBe(true);
    expect(refused(f, "I3t")).toBe(true);
  });
});

describe("R-604b M1: stays MUTATED (the other direction)", () => {
  it("A': the cursor is handed by value and written; counted as dropped", () => {
    const f = files(
      loop({
        filter: FILTER,
        callee: step("A1", param(false), "", "        B.Grp := 1;\n        B.Modify();"),
      }),
    );
    expect(refused(f, "A1")).toBe(false);
    const g = gapsOf(f);
    expect(g.m1Dropped).toBeGreaterThan(0);
    expect(g.m1Refused).toBe(0);
  });
  it("A0 control: inserts into a different table", () => {
    const f = files(
      loop({
        filter: FILTER,
        callee: step(
          "A0c",
          param(true),
          '        L: Record "R604 Other";\n',
          "        L.Init();\n        L.Insert();",
        ),
      }),
    );
    expect(refused(f, "A0c")).toBe(false);
  });
});
