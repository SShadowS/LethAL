import { beforeAll, describe, expect, it } from "bun:test";
import { ALNodeKind } from "../../src/ast/node-kinds";
import { initParser, parseAL } from "../../src/ast/parser";
import { planEdits } from "../../src/ast/rewrite-plan";
import { type ALSyntaxNode, findFirst, wrapRoot } from "../../src/ast/syntax-node";
import { FileRefusedError } from "../../src/file-refused";

/**
 * R-307 O4. `planEdits` is the PLAN half of `printWithRewrites`: E4 (each edit inside the root),
 * the stable sort and the overlap refusal, over spans only. No text is joined.
 */
describe("planEdits", () => {
  beforeAll(async () => {
    await initParser();
  });

  const source =
    "codeunit 50100 X\n{\n    procedure P()\n    begin\n        Message('a');\n    end;\n}\n";

  it("refuses two overlapping rewrites with the same fields printWithRewrites does (R297 twin)", () => {
    const root = wrapRoot(parseAL(source));
    const proc = findFirst(root, ALNodeKind.procedure);
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (proc === null || call === null) throw new Error("fixture shape");
    const run = () =>
      planEdits(
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

  it("returns no edit for an empty map without reading the root (the early return stays before E4)", () => {
    const root = new Proxy({} as ALSyntaxNode, {
      get(_t, prop) {
        throw new Error(`root.${String(prop)} read`);
      },
    });
    expect(planEdits(source, root, new Map())).toEqual([]);
  });

  it("throws E4 as a plain Error for an edit outside the root", () => {
    const root = wrapRoot(parseAL(source));
    const call = findFirst(root, ALNodeKind.procedure_call);
    const proc = findFirst(root, ALNodeKind.procedure);
    if (call === null || proc === null) throw new Error("fixture shape");
    let thrown: unknown;
    try {
      planEdits(source, call, new Map([[proc, "x"]]));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(FileRefusedError);
    expect(thrown instanceof Error ? thrown.message : "").toContain("is outside root");
  });

  it("keeps a zero-width latch inserted BEFORE a chain at the same offset, sorted by start", () => {
    const root = wrapRoot(parseAL(source));
    const body = findFirst(root, ALNodeKind.block);
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (body === null || call === null) throw new Error("fixture shape");
    const at = (n: ALSyntaxNode, start: number, end: number): ALSyntaxNode =>
      Object.create(n, { startIndex: { value: start }, endIndex: { value: end } });
    // Insertion order is what decides a tie: the latch first, then the chain rooted at `begin`,
    // then a later edit inserted earlier in the map than its position.
    const latch = at(body, body.startIndex, body.startIndex);
    const rewrites = new Map<ALSyntaxNode, string>([
      [latch, "var L: Boolean; "],
      [body, "<chain>"],
    ]);
    const edits = planEdits(source, root, rewrites, "src/X.Codeunit.al");
    expect(edits.map((e) => [e.start, e.end, e.payload])).toEqual([
      [body.startIndex, body.startIndex, "var L: Boolean; "],
      [body.startIndex, body.endIndex, "<chain>"],
    ]);
    const sorted = planEdits(
      source,
      root,
      new Map<ALSyntaxNode, string>([
        [call, "c"],
        [at(body, body.startIndex - 2, body.startIndex - 1), "a"],
      ]),
    );
    expect(sorted.map((e) => e.payload)).toEqual(["a", "c"]);
  });
});
