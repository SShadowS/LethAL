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
});
