import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findAll, wrapRoot } from "../../src/ast/syntax-node";
import { buildCFG } from "../../src/semantic/cfg";

describe("buildCFG", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function cfgOf(fixture: string, procIndex = 0) {
    const src = await readFile(resolve(__dirname, `../fixtures/al/${fixture}`), "utf8");
    const root = wrapRoot(parseAL(src));
    const proc = findAll(root, ALNodeKind.procedure)[procIndex];
    if (proc === undefined) {
      throw new Error(`no procedure #${procIndex} in ${fixture}`);
    }
    return buildCFG(proc);
  }

  it("produces an entry block and an exit block", async () => {
    const cfg = await cfgOf("branching.al");
    expect(cfg.entry).toBeDefined();
    expect(cfg.exit).toBeDefined();
  });

  it("includes three exit paths for the branching fixture", async () => {
    const cfg = await cfgOf("branching.al");
    const exitBlocks = cfg.blocks.filter((b) => b.successors.includes(cfg.exit));
    expect(exitBlocks.length).toBe(3);
  });

  it("marks unreachable blocks when they exist", () => {
    const src = `codeunit 50107 "U" { procedure P(): Integer begin exit(1); exit(2); end; }`;
    const root = wrapRoot(parseAL(src));
    const proc = findAll(root, ALNodeKind.procedure)[0];
    if (proc === undefined) throw new Error("no procedure parsed");
    const cfg = buildCFG(proc);
    expect(cfg.blocks.some((b) => !b.reachable)).toBe(true);
  });
});
