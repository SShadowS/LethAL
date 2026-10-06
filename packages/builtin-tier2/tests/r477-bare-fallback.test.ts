import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R477: `validate-to-assign`'s guarded BARE fallback. Where R-464 cannot prove a receiver spelling
 * for a bare `Validate(F, V)`, the mutant is the bare `F := V`, but only where `F` is provably
 * undeclared at the call (`bareFieldAssignable`, engine `semantic/receiver.ts`). Every shape below
 * was compiled with `alc` 18.0.43 (coord handoff `R-477`, `survey.md`): a local, parameter, named
 * return value or trigger local captures a bare assignment, and an object global does in a
 * tableextension, so each must be refused; with nothing declared the bare name binds the innermost
 * record's field, including a `with` subject over a competing implicit `Rec`.
 */
import { ALNodeKind, buildSemanticContext, findAll, initParser } from "@lethal/engine";
import { validateToAssign } from "../src/validate-to-assign";
import { parseClean } from "./parse-clean";

function emitted(src: string): string[] {
  const root = parseClean(src);
  const ctx = buildSemanticContext([{ path: "O.al", root }]);
  return findAll(root, ALNodeKind.procedure_call)
    .filter((n) => validateToAssign.targets(n, ctx))
    .flatMap((n) => validateToAssign.generate(n, ctx))
    .map((s) => `${s.before.text} => ${s.after.text}`);
}

/** A tableextension of a table this project does not declare: R-464 refuses the `Rec.` spelling. */
const ext = (decl: string, body = "Validate(Name, 'X');", head = "procedure P()") =>
  `tableextension 50100 E extends Customer
{
    ${decl}
    ${head}
    begin
        ${body}
    end;
}`;

beforeAll(async () => {
  await initParser();
});

describe("R477 bare fallback: emitted where the field name provably binds the field", () => {
  it("a tableextension of a dependency table (alc P01, E2)", () => {
    expect(emitted(ext(""))).toEqual(["Validate(Name, 'X') => Name := 'X'"]);
  });

  it("a report dataitem over a dependency table, quoted field kept (alc E3, RE1)", () => {
    const r = `report 50100 R
{
    dataset
    {
        dataitem(Cust; Customer)
        {
            trigger OnAfterGetRecord()
            begin
                Validate("Search Name", 'X');
            end;
        }
    }
}`;
    expect(emitted(r)).toEqual([`Validate("Search Name", 'X') => "Search Name" := 'X'`]);
  });

  it("competing records: `with Cust do` in a table with its own Name binds Cust.Name (alc C1); the outer call keeps Rec.", () => {
    const t = `table 50101 T
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Name; Boolean) { }
    }
    procedure P(var Cust: Record Customer)
    begin
        with Cust do begin
            Validate(Name, 'X');
        end;
        Validate(Name, true);
    end;
}`;
    expect(emitted(t)).toEqual([
      "Validate(Name, 'X') => Name := 'X'",
      "Validate(Name, true) => Rec.Name := true",
    ]);
  });

  it("R-464's proven prefix still wins where the table is in the project", () => {
    const t = `table 50101 T
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Integer) { }
    }
    procedure P()
    begin
        Validate(Amount, 1);
    end;
}`;
    expect(emitted(t)).toEqual(["Validate(Amount, 1) => Rec.Amount := 1"]);
  });
});

describe("R477 bare fallback: refused where a declaration could capture the bare name", () => {
  it("a local (alc P02)", () => {
    expect(emitted(ext("", undefined, "procedure P()\n    var\n        Name: Boolean;"))).toEqual(
      [],
    );
  });

  it("a parameter (alc P03)", () => {
    expect(emitted(ext("", undefined, "procedure P(Name: Boolean)"))).toEqual([]);
  });

  it("a named return value (alc P04)", () => {
    expect(emitted(ext("", undefined, "procedure P() Name: Boolean"))).toEqual([]);
  });

  it("an object global (alc P09)", () => {
    expect(emitted(ext("var\n        Name: Boolean;"))).toEqual([]);
  });

  it("a trigger local (alc P07)", () => {
    const src = `tableextension 50100 E extends Customer
{
    fields
    {
        modify("No.")
        {
            trigger OnAfterValidate()
            var
                Name: Boolean;
            begin
                Validate(Name, 'X');
            end;
        }
    }
}`;
    expect(emitted(src)).toEqual([]);
  });

  it("an #if-only global", () => {
    expect(
      emitted(ext("var\n#if X\n        Name: Boolean;\n#endif\n        Dummy: Integer;")),
    ).toEqual([]);
  });

  it("a quoted declaration of the quoted field name (alc C6)", () => {
    expect(
      emitted(
        ext(
          "",
          `Validate("Search Name", 'X');`,
          `procedure P()\n    var\n        "Search Name": Boolean;`,
        ),
      ),
    ).toEqual([]);
  });

  it("an enclosing procedure with no symbol (`#if`-wrapped member): unknown, not absent", () => {
    const src = `tableextension 50100 E extends Customer
{
#if not CLEAN26
    [Obsolete('x', '26.0')]
    procedure P()
    begin
        Validate(Name, 'X');
    end;
#endif
}`;
    expect(emitted(src)).toEqual([]);
  });

  it("a refused F-shadow site is neither claimed nor generated (replaces R-464 red-check 21)", () => {
    const root = parseClean(ext("", undefined, "procedure P()\n    var\n        Name: Boolean;"));
    const ctx = buildSemanticContext([{ path: "O.al", root }]);
    const calls = findAll(root, ALNodeKind.procedure_call);
    expect(calls.length).toBe(1);
    expect(calls.map((n) => validateToAssign.targets(n, ctx))).toEqual([false]);
    expect(calls.flatMap((n) => validateToAssign.generate(n, ctx))).toEqual([]);
  });
});
