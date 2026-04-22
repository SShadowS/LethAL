import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSymbolTable } from "../../src/semantic/symbol-table";
import { buildCallerIndex } from "../../src/semantic/callers";

describe("buildCallerIndex", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("indexes direct and indirect callers of Helper", async () => {
    const src = await readFile(
      resolve(__dirname, "../fixtures/al/caller-chain.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "c.al", root }]);
    const callers = buildCallerIndex([{ path: "c.al", root }], symbols);
    const helperCalls = callers.callersOf("Callers", "Helper");
    const names = helperCalls.map((c) => c.fromProcedure).sort();
    expect(names).toEqual(["Direct", "Indirect"]);
  });

  it("returns empty list for an uncalled procedure", async () => {
    const src = `codeunit 50109 "U" { procedure Unused(): Integer begin exit(0); end; }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "u.al", root }]);
    const callers = buildCallerIndex([{ path: "u.al", root }], symbols);
    expect(callers.callersOf("U", "Unused")).toEqual([]);
  });
});
