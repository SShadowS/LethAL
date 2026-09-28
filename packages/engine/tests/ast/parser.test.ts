import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { findAll, wrapRoot } from "../../src/ast/syntax-node";

const fixture = resolve(__dirname, "../fixtures/al/simple-codeunit.al");

describe("parser", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("parses a simple codeunit without errors", async () => {
    const root = wrapRoot(parseAL(await readFile(fixture, "utf8")));
    expect(root.hasError).toBe(false);
    expect(root.rawKind).toBe("source_file");
  });

  it("surfaces a procedure named DoubleIt in the AST", async () => {
    const root = wrapRoot(parseAL(await readFile(fixture, "utf8")));
    const [proc] = findAll(root, ALNodeKind.procedure);
    expect(proc?.text).toContain("DoubleIt");
  });

  it("is safe to initParser twice (concurrent and sequential)", async () => {
    await Promise.all([initParser(), initParser()]);
    await initParser();
    expect(wrapRoot(parseAL('codeunit 50999 "X" { }')).rawKind).toBe("source_file");
  });
});
