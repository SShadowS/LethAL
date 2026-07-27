import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";

const fixture = resolve(__dirname, "../fixtures/al/simple-codeunit.al");

describe("parser", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("parses a simple codeunit without errors", async () => {
    const source = await readFile(fixture, "utf8");
    const tree = parseAL(source);
    expect(tree.rootNode.hasError).toBe(false);
    expect(tree.rootNode.type).toBe("source_file");
  });

  it("surfaces a procedure named DoubleIt in the AST", async () => {
    const source = await readFile(fixture, "utf8");
    const tree = parseAL(source);
    const proc = tree.rootNode.descendantsOfType("procedure")[0];
    expect(proc).toBeDefined();
    expect(proc!.text).toContain("DoubleIt");
  });

  it("is safe to initParser twice (concurrent and sequential)", async () => {
    await Promise.all([initParser(), initParser()]);
    await initParser();
    const tree = parseAL('codeunit 50999 "X" { }');
    expect(tree.rootNode.type).toBe("source_file");
  });
});
