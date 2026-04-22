import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot, findFirst } from "../../src/ast/syntax-node";
import { print, printWithRewrites } from "../../src/ast/printer";
import { ALNodeKind } from "../../src/ast/node-kinds";

describe("printer", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function loadFixture(name: string): Promise<string> {
    return readFile(
      resolve(__dirname, `../fixtures/al/${name}`),
      "utf8",
    );
  }

  it("round-trips a file byte-identical without rewrites", async () => {
    const source = await loadFixture("comments-and-spacing.al");
    const tree = parseAL(source);
    const output = print(source, wrapRoot(tree));
    expect(output).toBe(source);
  });

  it("replaces a single node via printWithRewrites, preserving surroundings", async () => {
    const source = await loadFixture("simple-codeunit.al");
    const tree = parseAL(source);
    const root = wrapRoot(tree);
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    const output = printWithRewrites(source, root, new Map([
      [exit, "exit(0);"],
    ]));
    expect(output).toContain("exit(0);");
    expect(output).not.toContain("Value * 2");
    expect(output.split("\n").length).toBe(source.split("\n").length);
  });

  it("composes multiple rewrites in document order", async () => {
    const source = await loadFixture("comments-and-spacing.al");
    const tree = parseAL(source);
    const root = wrapRoot(tree);
    const resultAssign = findFirst(root, ALNodeKind.assignment_statement)!;
    const exit = findFirst(root, ALNodeKind.exit_statement)!;
    const output = printWithRewrites(source, root, new Map([
      [resultAssign, "Result := Amount >= 0;"],
      [exit, "exit(not Result);"],
    ]));
    expect(output).toContain("Amount >= 0");
    expect(output).toContain("not Result");
    expect(output).toContain("// trailing comment");
    expect(output).toContain("// inside-block comment");
  });
});
