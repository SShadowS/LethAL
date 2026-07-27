import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildSemanticContext } from "../../src/semantic/context";

describe("buildSemanticContext", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("exposes symbols, types, callers, and cfg-for-procedure", async () => {
    const src = await readFile(resolve(__dirname, "../fixtures/al/caller-chain.al"), "utf8");
    const ctx = buildSemanticContext([{ path: "c.al", root: wrapRoot(parseAL(src)) }]);
    expect(ctx.symbols.resolveProcedure("Callers", "Helper")).not.toBeNull();
    expect(ctx.callers.callersOf("Callers", "Helper").length).toBe(2);

    const helper = ctx.symbols.resolveProcedure("Callers", "Helper");
    if (helper === null) throw new Error("Helper not found");
    const cfg = ctx.cfgFor(helper);
    expect(cfg.entry).toBeDefined();
    expect(cfg.exit).toBeDefined();
  });
});
