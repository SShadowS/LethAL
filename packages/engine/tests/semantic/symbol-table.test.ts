import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";

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
    const proc = table.resolveProcedure("Vars Test", "Compute");
    expect(proc).not.toBeNull();
    expect(proc?.parameters.map((p) => p.name)).toEqual(["Input"]);
  });

  it("distinguishes global vars from procedure-local vars", async () => {
    const src = await load();
    const table = buildSymbolTable([{ path: "vars.al", root: wrapRoot(parseAL(src)) }]);
    const globals = table.globalsOf("Vars Test");
    expect(globals.map((g) => g.name)).toEqual(["GlobalCount"]);
    const locals = table.localsOf("Vars Test", "Compute");
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
  });
});
