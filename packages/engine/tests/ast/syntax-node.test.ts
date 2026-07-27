import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findAll, findFirst, wrapRoot } from "../../src/ast/syntax-node";

describe("syntax-node", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function load(): Promise<string> {
    return readFile(resolve(__dirname, "../fixtures/al/simple-codeunit.al"), "utf8");
  }

  it("wraps a tree-sitter root into an ALSyntaxNode", async () => {
    const tree = parseAL(await load());
    const root = wrapRoot(tree);
    expect(root.kind).toBe(ALNodeKind.source_file);
    expect(root.children.length).toBeGreaterThan(0);
  });

  it("findFirst returns the first descendant matching a kind", async () => {
    const root = wrapRoot(parseAL(await load()));
    const proc = findFirst(root, ALNodeKind.procedure);
    expect(proc).not.toBeNull();
    expect(proc!.text).toContain("DoubleIt");
  });

  it("findAll returns all descendants matching a kind", async () => {
    const root = wrapRoot(parseAL(await load()));
    const exits = findAll(root, ALNodeKind.exit_statement);
    expect(exits.length).toBe(1);
  });

  it("exposes parent + children + text as read-only", async () => {
    const root = wrapRoot(parseAL(await load()));
    const proc = findFirst(root, ALNodeKind.procedure)!;
    expect(proc.parent).not.toBeNull();
    // readonly compile-time check (no runtime assertion possible)
    // @ts-expect-error children is readonly
    proc.children = [];
  });
});
