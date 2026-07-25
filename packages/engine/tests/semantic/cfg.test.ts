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

  it("walks a begin...end block used as an if-branch, not just the procedure body", () => {
    // The then-branch is itself a code_block (begin...end), not a bare
    // statement. Under v3 that block's statements sit inside its own nested
    // `statement_block`, same as the procedure body's — this pins that
    // `emitStatement`'s ALNodeKind.block case unwraps it too.
    const src = `codeunit 50108 "U" { procedure P(n: Integer): Integer begin if n > 0 then begin exit(1); exit(2); end; exit(0); end; }`;
    const root = wrapRoot(parseAL(src));
    const proc = findAll(root, ALNodeKind.procedure)[0];
    if (proc === undefined) throw new Error("no procedure parsed");
    const cfg = buildCFG(proc);
    // exit(2) directly follows exit(1) inside the nested block: dead code.
    expect(cfg.blocks.some((b) => !b.reachable)).toBe(true);
    // Three live exit paths: exit(1), exit(2) [unreachable, still an edge],
    // and exit(0).
    const exitBlocks = cfg.blocks.filter((b) => b.successors.includes(cfg.exit));
    expect(exitBlocks.length).toBe(3);
  });
});
