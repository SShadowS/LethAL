import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { print, printWithRewrites } from "../../src/ast/printer";
import { findFirst, wrapRoot } from "../../src/ast/syntax-node";
import { FileRefusedError } from "../../src/file-refused";

describe("printer", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function loadFixture(name: string): Promise<string> {
    return readFile(resolve(__dirname, `../fixtures/al/${name}`), "utf8");
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
    const output = printWithRewrites(source, root, new Map([[exit, "exit(0);"]]));
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
    const output = printWithRewrites(
      source,
      root,
      new Map([
        [resultAssign, "Result := Amount >= 0;"],
        [exit, "exit(not Result);"],
      ]),
    );
    expect(output).toContain("Amount >= 0");
    expect(output).toContain("not Result");
    expect(output).toContain("// trailing comment");
    expect(output).toContain("// inside-block comment");
  });

  it("names the file and both node kinds when two rewrites overlap (R297)", async () => {
    await initParser();
    const source =
      "codeunit 50100 X\n{\n    procedure P()\n    begin\n        Message('a');\n    end;\n}\n";
    const root = wrapRoot(parseAL(source));
    const proc = findFirst(root, ALNodeKind.procedure);
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (proc === null || call === null) throw new Error("fixture shape");
    const run = (): string =>
      printWithRewrites(
        source,
        root,
        new Map([
          [proc, "x"],
          [call, "y"],
        ]),
        "src/X.Codeunit.al",
      );
    expect(run).toThrow(
      `overlapping rewrites in src/X.Codeunit.al at ${proc.startIndex}..${proc.endIndex} (procedure) and ${call.startIndex}..${call.endIndex} (${call.rawKind})`,
    );
    // R307: typed, so a run can refuse this one file instead of aborting.
    let thrown: unknown;
    try {
      run();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FileRefusedError);
    if (!(thrown instanceof FileRefusedError)) return;
    expect(thrown.shape).toBe("overlap");
    expect(thrown.site).toBe("rewrite.overlap");
    expect(thrown.file).toBe("src/X.Codeunit.al");
    expect(thrown.lines).toEqual([3, 6]);
    expect(thrown.objects).toBeUndefined();
  });
});
