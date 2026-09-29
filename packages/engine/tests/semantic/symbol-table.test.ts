import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import {
  buildSymbolTable,
  extensionScopeKey,
  objectScopeKey,
} from "../../src/semantic/symbol-table";

describe("buildSymbolTable", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function load(): Promise<string> {
    return readFile(resolve(__dirname, "../fixtures/al/procedure-with-vars.al"), "utf8");
  }

  it("registers a codeunit by id and name", async () => {
    const src = await load();
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    const cu = table.resolveObject({ kind: "codeunit", idOrName: "50105" });
    expect(cu).not.toBeNull();
    expect(cu?.name).toBe("Vars Test");
    expect(cu?.id).toBe(50105);
  });

  it("registers a procedure within a codeunit", async () => {
    const src = await load();
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    // R70: scope lookups are keyed by (kind, name). The bare name must NOT answer — that is
    // what let a page named after its table return the table's procedures.
    expect(table.resolveProcedure("Vars Test", "Compute")).toBeNull();
    const proc = table.resolveProcedure(objectScopeKey("codeunit", "Vars Test"), "Compute");
    expect(proc).not.toBeNull();
    expect(proc?.parameters.map((p) => p.name)).toEqual(["Input"]);
  });

  it("distinguishes global vars from procedure-local vars", async () => {
    const src = await load();
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    const globals = table.globalsOf(objectScopeKey("codeunit", "Vars Test"));
    expect(globals.map((g) => g.name)).toEqual(["GlobalCount"]);
    const locals = table.localsOf(objectScopeKey("codeunit", "Vars Test"), "Compute");
    expect(locals.map((l) => l.name)).toEqual(["Local"]);
  });

  // A `tableextension` adds members to a table it only NAMES. It is indexed separately from
  // `objects` so nothing that walks `objects` (buildCallerIndex, buildTypeTable) changes
  // behaviour, while a consumer that must answer "does the project declare this procedure on
  // that table?" can still see it — `claimsRecordMethod` in @lethal/builtin-tier2 is that
  // consumer, and answering "no" there wrongly CLAIMS a mutation site.
  describe("tableextension", () => {
    const EXT = `tableextension 50002 "Other Ext" extends "Other Table"
{
    fields { field(50000; MyField; Integer) { } }

    procedure SetRange(FromNo: Code[20]; ToNo: Code[20])
    begin
    end;
}`;
    const build = (src: string) =>
      buildSymbolTable([{ path: "ext.al", root: wrapRoot(parseAL(src)) }]);

    it("indexes it with its own name and its extends target, quotes stripped", () => {
      const table = build(EXT);
      expect(table.tableExtensions.map((e) => [e.kind, e.name, e.baseObject])).toEqual([
        ["tableextension", "Other Ext", "Other Table"],
      ]);
    });

    it("keeps it OUT of `objects` — an extension declares no object of its own", () => {
      expect(build(EXT).objects).toEqual([]);
    });

    it("does not register the extension's procedures under the extension's name", () => {
      // They belong to the extended table; an owner named after the extension is one no AL call
      // can ever name, and would make `resolveProcedure` answer for a receiver that cannot exist.
      expect(build(EXT).resolveProcedure("Other Ext", "SetRange")).toBeNull();
    });

    it("is an empty array — never absent — for a project with no extensions", async () => {
      const src = await load();
      expect(build(src).tableExtensions).toEqual([]);
    });

    it("indexes its own members for VARIABLE SCOPE under the kind-namespaced key", () => {
      const src = `tableextension 50002 "Other Ext" extends "Other Table"
{
    var
        ExtGlobal: Record "Other Table";

    procedure Helper(Param: Record Customer)
    var
        ExtLocal: Record Vendor;
    begin
    end;
}`;
      const table = build(src);
      const key = extensionScopeKey("tableextension", "Other Ext");
      expect(table.globalsOf(key).map((g) => g.name)).toEqual(["ExtGlobal"]);
      expect(table.localsOf(key, "Helper").map((l) => l.name)).toEqual(["ExtLocal"]);
      expect(table.resolveProcedure(key, "Helper")?.parameters.map((p) => p.name)).toEqual([
        "Param",
      ]);
    });
  });

  /**
   * R30: a `pageextension`'s members were indexed NOWHERE — `parseExtensionHeader` matched only
   * `tableextension_declaration` and the object-kind map omits both extension kinds, so the node
   * fell through the loop entirely. Every call on a variable DECLARED inside a `pageextension` was
   * therefore refused as an unresolvable receiver by `claimsRecordMethod` (rule 4). Measured on
   * Continia Document Output: 18 such sites (`scripts/probe-r30-pageext.ts`).
   *
   * Scope only. A `pageextension` declares no object of its own, exactly like a `tableextension`,
   * and it must NOT enter `tableExtensions` — that array feeds the rule-3 shadowing guard, which is
   * keyed on the extended TABLE, and a page name compared against a table name can only ever match
   * by coincidence.
   */
  describe("pageextension", () => {
    const PAGE_EXT = `pageextension 50003 "My Page Ext" extends "Customer Card"
{
    var
        PageGlobal: Record Customer;

    procedure Helper(Param: Record Item)
    var
        PageLocal: Record Vendor;
    begin
    end;
}`;
    const build = (src: string) =>
      buildSymbolTable([{ path: "pageext.al", root: wrapRoot(parseAL(src)) }]);

    it("indexes its members for VARIABLE SCOPE under the kind-namespaced key", () => {
      const table = build(PAGE_EXT);
      const key = extensionScopeKey("pageextension", "My Page Ext");
      expect(table.globalsOf(key).map((g) => g.name)).toEqual(["PageGlobal"]);
      expect(table.localsOf(key, "Helper").map((l) => l.name)).toEqual(["PageLocal"]);
      expect(table.resolveProcedure(key, "Helper")?.parameters.map((p) => p.name)).toEqual([
        "Param",
      ]);
    });

    it("does not register its procedures under the BARE extension name", () => {
      // Same contract the tableextension half keeps: a receiver named after the extension is one
      // no AL call can name, so `resolveProcedure` answering for it would invent a call target.
      expect(build(PAGE_EXT).resolveProcedure("My Page Ext", "Helper")).toBeNull();
    });

    it("keeps it OUT of `objects` and OUT of `tableExtensions`", () => {
      const table = build(PAGE_EXT);
      expect(table.objects).toEqual([]);
      // `tableExtensions` is the rule-3 shadowing guard's input, keyed on the extended TABLE.
      // A `pageextension` extends a PAGE; letting it in would compare a page name to a table name.
      expect(table.tableExtensions).toEqual([]);
    });

    it("does not share variables with a same-named tableextension", () => {
      // AL permits a `tableextension` and a `pageextension` to carry the same name. One namespace
      // for both would let each resolve the other's variables — a receiver classified from the
      // wrong declaration, which is the direction that CLAIMS a site wrongly.
      const src = `tableextension 50004 "Dup" extends "Other Table"
{
    var
        FromTableExt: Record "Other Table";
}
pageextension 50005 "Dup" extends "Customer Card"
{
    var
        FromPageExt: Record Customer;
}`;
      const table = build(src);
      expect(
        table.globalsOf(extensionScopeKey("tableextension", "Dup")).map((g) => g.name),
      ).toEqual(["FromTableExt"]);
      expect(table.globalsOf(extensionScopeKey("pageextension", "Dup")).map((g) => g.name)).toEqual(
        ["FromPageExt"],
      );
    });
  });
});

// ————————————————————————————————————————————————————————————————————————
// R70: scope was keyed on the BARE object name, so `table 50000 "CDO Setup"` and
// `page 50000 "CDO Setup"` shared one key and whichever parsed LAST won WHOLESALE. That naming is
// the ordinary BC convention, not an edge case — measured on Continia Document Output Cloud: 13
// names shared across kinds, 12 of them page+table.
//
// The direction is the dangerous one. `claimsRecordMethod`'s `lookupVar` is the consumer: a
// receiver that SHOULD be unresolvable inside the table (a rule-4 refusal) can resolve through the
// page's declaration and be CLAIMED, and a receiver resolving to a DIFFERENT table sends rule 3's
// shadowing guard at the wrong table. A wrong claim mislabels the mutation and, under §3.2 dedup
// precedence, DELETES the correct Tier-1 mutant at that site.
// ————————————————————————————————————————————————————————————————————————
describe("buildSymbolTable — a page named after its table (R70)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const CROSS_KIND = `table 50000 "CDO Setup"
{
    var
        Helper: Integer;

    procedure Configure()
    var
        TableLocal: Record "CDO Setup";
    begin
    end;
}
page 50000 "CDO Setup"
{
    SourceTable = "CDO Setup";

    var
        Helper: Record Customer;

    procedure Configure()
    var
        PageLocal: Record Vendor;
    begin
    end;
}`;

  const build = (src: string) =>
    buildSymbolTable([{ path: "crosskind.al", root: wrapRoot(parseAL(src)) }]);

  it("keeps the table's globals separate from the same-named page's", () => {
    const table = build(CROSS_KIND);
    expect(table.globalsOf(objectScopeKey("table", "CDO Setup")).map((g) => g.typeText)).toEqual([
      "Integer",
    ]);
    expect(table.globalsOf(objectScopeKey("page", "CDO Setup")).map((g) => g.typeText)).toEqual([
      "Record Customer",
    ]);
  });

  it("keeps the table's locals separate from the same-named page's", () => {
    const table = build(CROSS_KIND);
    expect(
      table.localsOf(objectScopeKey("table", "CDO Setup"), "Configure").map((v) => v.name),
    ).toEqual(["TableLocal"]);
    expect(
      table.localsOf(objectScopeKey("page", "CDO Setup"), "Configure").map((v) => v.name),
    ).toEqual(["PageLocal"]);
  });

  it("resolveObject is unaffected — it was already kind-aware", () => {
    const table = build(CROSS_KIND);
    expect(table.resolveObject({ kind: "table", idOrName: "CDO Setup" })?.kind).toBe("table");
    expect(table.resolveObject({ kind: "page", idOrName: "CDO Setup" })?.kind).toBe("page");
  });

  // ORDER INVARIANCE — the property the R70 bug actually violated, asserted directly.
  //
  // The bug was `globals.set(bareName, ...)` overwriting WHOLESALE, so the answer depended on which
  // file parsed last. `generateMutationSet` sorts its entries, so the tie was resolved by FILENAME
  // — a fact no test asserted and no reader would guess. Permuting the inputs and demanding the
  // same answers is stronger than any single-order assertion, because it cannot be satisfied by a
  // detector that merely happens to win the sort.
  it("answers identically whichever file parses last", () => {
    const TABLE = `table 50000 "CDO Setup"
{
    var
        Helper: Integer;
}`;
    const PAGE = `page 50000 "CDO Setup"
{
    var
        Helper: Record Customer;
}`;
    const build2 = (a: string, b: string) =>
      buildSymbolTable([
        { path: "a.al", root: wrapRoot(parseAL(a)) },
        { path: "b.al", root: wrapRoot(parseAL(b)) },
      ]);

    for (const table of [build2(TABLE, PAGE), build2(PAGE, TABLE)]) {
      expect(table.globalsOf(objectScopeKey("table", "CDO Setup")).map((g) => g.typeText)).toEqual([
        "Integer",
      ]);
      expect(table.globalsOf(objectScopeKey("page", "CDO Setup")).map((g) => g.typeText)).toEqual([
        "Record Customer",
      ]);
    }
  });
});

// R302: a split member (R301's shared-body shape, R316's per-arm preamble) is a member of its
// object. A name inside it resolves only when EVERY arm declares it with the same type; any other
// name the arms declare is ambiguous and resolves to nothing.
describe("buildSymbolTable: split members (R302)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const KEY = objectScopeKey("codeunit", "Repro S");
  const build = (src: string) => buildSymbolTable([{ path: "s.al", root: wrapRoot(parseAL(src)) }]);
  const startOf = (src: string, marker: string) => src.indexOf(marker);

  const SPLIT = `codeunit 50100 "Repro S"
{
#if CLEAN27
    procedure Pick(X: Integer; Y: Integer): Integer
#else
    internal procedure Pick(X: Integer; Y: Text): Integer
#endif
    var
        Shared: Decimal;
    begin
        exit(X);
    end;
}
`;
  const PREAMBLE = `codeunit 50100 "Repro S"
{
#if CLEAN27
    procedure Pick(X: Integer): Decimal
    var
        N: Integer;
        Both: Code[20];
#else
    procedure Pick(X: Integer): Integer
    var
        Both: Code[20];
#endif
    begin
        exit(X);
    end;
}
`;

  it("a split member is found by its own start, with the every-arm rule applied", () => {
    const t = build(SPLIT);
    const p = t.resolveProcedureAt(KEY, startOf(SPLIT, "#if CLEAN27"));
    expect(p?.name).toBe("Pick");
    expect(p?.parameters.map((v) => v.name)).toEqual(["X"]);
    expect(p?.locals.map((v) => v.name)).toEqual(["Shared"]);
    expect(p?.ambiguous).toEqual(["y"]);
    expect(p?.returnType).toBe("Integer");
  });

  it("a preamble's agreeing arm local is listed; an arm-only local and a disagreeing return are not", () => {
    const t = build(PREAMBLE);
    const p = t.resolveProcedureAt(KEY, startOf(PREAMBLE, "#if CLEAN27"));
    expect(p?.parameters.map((v) => v.name)).toEqual(["X"]);
    expect(p?.locals.map((v) => v.name)).toEqual(["Both"]);
    expect(p?.ambiguous).toEqual(["n"]);
    expect(p?.returnType).toBeNull();
  });

  it("a renamed member is indexed by position only, with the name ''", () => {
    const renamed = SPLIT.replace("internal procedure Pick(", "internal procedure PickOld(");
    const t = build(renamed);
    expect(t.resolveProcedureAt(KEY, startOf(renamed, "#if CLEAN27"))?.name).toBe("");
    expect(t.resolveProcedure(KEY, "")).toBeNull();
    expect(t.resolveProcedure(KEY, "Pick")).toBeNull();
  });

  // R324: a call is typed only when its name names exactly one procedure of the owner. A split
  // member counts under every arm's name, so a renamed member makes both names non-unique.
  it("uniqueProcedure: one of a name, null for two, a renamed member under each arm's name", () => {
    const two = `${SPLIT.slice(0, SPLIT.lastIndexOf("}"))}
    procedure Pick(T: Text): Text
    begin
        exit(T);
    end;

    procedure Other(): Integer
    begin
        exit(1);
    end;
}
`;
    const t = build(two);
    expect(t.uniqueProcedure(KEY, "Pick")).toBeNull();
    expect(t.uniqueProcedure(KEY, "OTHER")?.name).toBe("Other");
    const renamed = two.replace("internal procedure Pick(", "internal procedure Other(");
    const r = build(renamed);
    expect(r.uniqueProcedure(KEY, "Other")).toBeNull();
    // `Pick` is now arm 1's name and the plain overload's: two again.
    expect(r.uniqueProcedure(KEY, "Pick")).toBeNull();
    const single = build(SPLIT);
    expect(single.uniqueProcedure(KEY, '"pick"')?.name).toBe("Pick");
  });
});

// R327: a split member swallowed by the global var section is not indexed, but its names still
// count, so `uniqueProcedure` never answers with another procedure of the same name.
describe("buildSymbolTable: a swallowed split member still counts by name (R327)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const KEY = objectScopeKey("codeunit", "Repro S");
  const src = (plain: string) => `codeunit 50100 "Repro S"
{
    var
        G: Integer;

#if CLEAN27
    procedure Foo(T: Text): Text
#else
    procedure FooOld(T: Text): Text
#endif
    begin
        exit(T);
    end;
${plain}}
`;

  it("a plain overload after a swallowed one is not unique", () => {
    const t = buildSymbolTable([
      {
        path: "s.al",
        root: wrapRoot(
          parseAL(
            src(
              "\n    procedure Foo(X: Integer): Integer\n    begin\n        exit(X);\n    end;\n",
            ),
          ),
        ),
      },
    ]);
    expect(t.uniqueProcedure(KEY, "Foo")).toBeNull();
  });

  it("a name only a swallowed member declares, under any arm, is not unique either", () => {
    const t = buildSymbolTable([{ path: "s.al", root: wrapRoot(parseAL(src(""))) }]);
    expect(t.uniqueProcedure(KEY, "Foo")).toBeNull();
    expect(t.uniqueProcedure(KEY, "FooOld")).toBeNull();
  });
});

// Review M3, Decision 2: a call by either name of a RENAMED split member does not resolve to it,
// even when no other procedure has that name. Which arm compiles is decided by symbols the engine
// never sees, so neither name is the member's name.
describe("buildSymbolTable: a renamed split member is never a call's target (R302, Decision 2)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("uniqueProcedure answers null for either arm's name", () => {
    const src = `codeunit 50100 "Repro S"
{
#if CLEAN27
    procedure AIf(X: Integer): Integer
#else
    procedure AElse(X: Integer): Integer
#endif
    begin
        exit(X);
    end;
}
`;
    const t = buildSymbolTable([{ path: "s.al", root: wrapRoot(parseAL(src)) }]);
    const key = objectScopeKey("codeunit", "Repro S");
    expect(t.uniqueProcedure(key, "AIf")).toBeNull();
    expect(t.uniqueProcedure(key, "AElse")).toBeNull();
  });
});

// R330: every procedure-like declaration counts by name, wherever the grammar put it; a local in a
// `#if` var block is ambiguous.
describe("buildSymbolTable: #if-wrapped declarations (R330)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const KEY = objectScopeKey("codeunit", "Repro S");

  it("uniqueProcedure is null for a name a #if-wrapped procedure also declares", () => {
    const src = `codeunit 50100 "Repro S"
{
    procedure Foo(A: Integer): Integer
    begin
        exit(A);
    end;

#if X
    procedure Foo(A: Text): Text
    begin
        exit(A);
    end;
#endif

    procedure Other(): Integer
    begin
        exit(1);
    end;
}
`;
    const t = buildSymbolTable([{ path: "s.al", root: wrapRoot(parseAL(src)) }]);
    expect(t.uniqueProcedure(KEY, "Foo")).toBeNull();
    expect(t.uniqueProcedure(KEY, "Other")?.name).toBe("Other");
  });

  it("a local declared in a #if var block is ambiguous; a plain local is not", () => {
    const src = `codeunit 50100 "Repro S"
{
    procedure P()
    var
        Kept: Integer;
#if not CLEAN27
        Amt: Text;
#endif
    begin
    end;
}
`;
    const t = buildSymbolTable([{ path: "s.al", root: wrapRoot(parseAL(src)) }]);
    const p = t.resolveProcedure(KEY, "P");
    expect(p?.ambiguous).toEqual(["amt"]);
    expect(p?.locals.map((v) => v.name)).toEqual(["Kept"]);
  });
});
