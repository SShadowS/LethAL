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
});
