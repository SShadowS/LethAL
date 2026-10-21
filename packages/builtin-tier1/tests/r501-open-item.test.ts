import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * R501: `openItemHangRefuses` directly, for the one direction no generator reaches today: a site
 * INSIDE a bounded item's only bound (an operator on one of its arguments). The orchestrator-level
 * tests are `packages/runner/tests/r501-dispatch.test.ts`.
 */
const SRC = `report 50503 "Bound"
{
    dataset
    {
        dataitem(Fixed; Integer)
        {
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, 3);
                Buf.SetRange("No.", 'F');
            end;
        }
        dataitem(Qual; Integer)
        {
            trigger OnPreDataItem()
            begin
                Qual.SetRange(Number, 1, 4);
            end;
        }
        dataitem(Capped; Integer)
        {
            MaxIteration = 5;
            trigger OnPreDataItem()
            begin
                SetRange(Number, 1, 6);
            end;
        }
    }
    var
        Buf: Record Customer temporary;
}
`;

beforeAll(async () => {
  await initParser();
});

function setup() {
  const root = wrapRoot(parseAL(SRC));
  const ctx = buildSemanticContext([{ path: "b.al", root }]);
  /** The integer literal `text` (unique in SRC), and the call holding it. */
  const literal = (text: string): ALSyntaxNode => {
    let hit: ALSyntaxNode | null = null;
    visit(root, (n: ALSyntaxNode) => {
      if (n.rawKind === "integer" && n.text === text) hit = n;
    });
    if (hit === null) throw new Error(`no literal ${text}`);
    return hit;
  };
  const stringLit = (): ALSyntaxNode => {
    let hit: ALSyntaxNode | null = null;
    visit(root, (n: ALSyntaxNode) => {
      if (n.text === "'F'" && hit === null) hit = n;
    });
    if (hit === null) throw new Error("no 'F'");
    return hit;
  };
  return { ctx, literal, stringLit };
}

describe("R501: openItemHangRefuses", () => {
  it("INSIDE the only bound: an argument of the unqualified and the qualified certified call", () => {
    const { ctx, literal } = setup();
    expect(openItemHangRefuses(literal("3"), ctx, undefined)).toBe(true);
    expect(openItemHangRefuses(literal("4"), ctx, undefined)).toBe(true);
  });

  it("CONTAINS the only bound: the call itself", () => {
    const { ctx, literal } = setup();
    const call3 = literal("3").parent?.parent ?? null;
    expect(call3?.rawKind).toBe("call_expression");
    if (call3 !== null) expect(openItemHangRefuses(call3, ctx, undefined)).toBe(true);
  });

  it("twins: a MaxIteration item's SetRange argument, and another record's SetRange argument", () => {
    const { ctx, literal, stringLit } = setup();
    expect(openItemHangRefuses(literal("6"), ctx, undefined)).toBe(false);
    expect(openItemHangRefuses(stringLit(), ctx, undefined)).toBe(false);
  });

  it("a context without `files` throws (R500: the one-hop callee rule needs every object), whatever the site", () => {
    const { ctx, stringLit, literal } = setup();
    const { files: _files, ...noFiles } = ctx;
    expect(() => openItemHangRefuses(stringLit(), noFiles, undefined)).toThrow(/R500: .*`files`/);
    // a MaxIteration item's site throws too: no answer is read from a context missing objects
    expect(() => openItemHangRefuses(literal("6"), noFiles, undefined)).toThrow(/R500: .*`files`/);
    expect(openItemHangRefuses(literal("6"), ctx, undefined)).toBe(false);
  });
});
