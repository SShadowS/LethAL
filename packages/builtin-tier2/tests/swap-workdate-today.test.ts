import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind, findAll, initParser } from "@lethal/engine";
import { swapWorkDateToday } from "../src/swap-workdate-today";
import { contextFor, parseClean } from "./parse-clean";

function swaps(sourceAL: string): string[] {
  const root = parseClean(sourceAL);
  const ctx = contextFor(root);
  return findAll(root, ALNodeKind.procedure_call)
    .filter((n) => swapWorkDateToday.targets(n, ctx))
    .flatMap((n) => swapWorkDateToday.generate(n, ctx))
    .map((s) => `${s.before.text} -> ${s.after.text} (${s.parentContext})`);
}

const cu = (members: string): string => `codeunit 50195 "C" { ${members} }`;

describe("swapWorkDateToday (R856)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("is opt-in, tier 2, 1.0.0", () => {
    expect(swapWorkDateToday.optIn).toBe(true);
    expect(swapWorkDateToday.tier).toBe(2);
    expect(swapWorkDateToday.version).toBe("1.0.0");
  });

  it("WorkDate() -> Today(), in expression position", () => {
    expect(swaps(cu("procedure P(): Date begin exit(WorkDate()); end;"))).toEqual([
      "WorkDate() -> Today() (expression-position)",
    ]);
  });

  it("Today() -> WorkDate(), in expression position", () => {
    expect(swaps(cu("procedure P() var D: Date; begin D := Today(); end;"))).toEqual([
      "Today() -> WorkDate() (expression-position)",
    ]);
  });

  it("claims a getter in statement position too, with the honest parentContext", () => {
    expect(swaps(cu("procedure P() begin Today(); end;"))).toEqual([
      "Today() -> WorkDate() (statement-position)",
    ]);
  });

  it("refuses the WorkDate(D) setter", () => {
    expect(swaps(cu("procedure P(D: Date) begin WorkDate(D); end;"))).toEqual([]);
  });

  it("refuses a qualified call, which is not the system function", () => {
    expect(
      swaps(cu("procedure P() var X: Codeunit Y; D: Date; begin D := X.WorkDate(); end;")),
    ).toEqual([]);
  });

  it("refuses when the project declares a procedure of the SOURCE name", () => {
    expect(
      swaps(
        cu(
          "procedure Today(): Date begin end; procedure P() var D: Date; begin D := Today(); end;",
        ),
      ),
    ).toEqual([]);
  });

  // The target name must be free, each way. The swap would bind to the namesake and not compile.
  it("WorkDate() -> Today() is refused when a local variable is called Today", () => {
    expect(
      swaps(cu("procedure P() var Today: Date; D: Date; begin D := WorkDate(); end;")),
    ).toEqual([]);
  });

  it("Today() -> WorkDate() is refused when a parameter is called WorkDate", () => {
    expect(swaps(cu("procedure P(WorkDate: Date) var D: Date; begin D := Today(); end;"))).toEqual(
      [],
    );
  });

  it("WorkDate() -> Today() is refused when a global, a procedure or a named return is called Today", () => {
    expect(swaps(cu("var Today: Date; procedure P(): Date begin exit(WorkDate()); end;"))).toEqual(
      [],
    );
    expect(
      swaps(
        cu(
          "procedure Today(X: Integer) begin end; procedure P(): Date begin exit(WorkDate()); end;",
        ),
      ),
    ).toEqual([]);
    expect(
      swaps(
        cu("procedure Q() Today: Date begin end; procedure P(): Date begin exit(WorkDate()); end;"),
      ),
    ).toEqual([]);
  });

  it("a field called Today in a project table refuses the swap toward it", () => {
    const src = `table 50196 "T" { fields { field(1; Today; Date) { } } }
${cu("procedure P(): Date begin exit(WorkDate()); end;")}`;
    expect(swaps(src)).toEqual([]);
  });

  it("control: an unrelated declared name does not refuse", () => {
    expect(swaps(cu("procedure P(): Date var Other: Date; begin exit(WorkDate()); end;"))).toEqual([
      "WorkDate() -> Today() (expression-position)",
    ]);
  });

  it("DOES claim a site outside a body, such as a page-field property (the dispatch drops it as declarative)", () => {
    const src = `page 50197 "P" { layout { area(Content) { field(X; Rec.X) { Visible = Today() > 0D; } } } }`;
    expect(swaps(src)).toEqual(["Today() -> WorkDate() (expression-position)"]);
  });

  // The target name check must see #if-split declarations and data items.
  it("refuses WorkDate() -> Today() when an #if-split procedure is called Today", () => {
    const src = cu(`#if CLEAN20
    procedure Today(): Date
#else
    procedure Today(X: Integer): Date
#endif
    begin end;
    procedure P(): Date begin exit(WorkDate()); end;`);
    expect(swaps(src)).toEqual([]);
  });

  it("refuses WorkDate() -> Today() when a report data item is called Today", () => {
    const src = `report 50198 "R" { dataset { dataitem(Today; Integer) { } } trigger OnPreReport() var D: Date; begin D := WorkDate(); end; }`;
    expect(swaps(src)).toEqual([]);
  });
});
