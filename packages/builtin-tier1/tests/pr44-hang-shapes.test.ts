import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { openItemHangRefuses } from "../src/index";

/**
 * PR-44: `toggle-blank-string` on the blank of a loop-exit comparison whose other side the body
 * writes is hang-refused. Invented AL. Each test names its revert.
 */

beforeAll(async () => {
  await initParser();
});

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

function refused(src: string, kind: ALNodeKind, start: string, op: string): boolean {
  const { root, ctx } = load(src);
  const site = findAll(root, kind).find((n: ALSyntaxNode) => n.text.startsWith(start));
  if (site === undefined) throw new Error(`no ${kind} starting ${start}`);
  return openItemHangRefuses(site, ctx, op);
}

const TOGGLE = "lethal.toggle-blank-string";

const unit = (body: string, vars = "X: Text; N: Integer;") => `codeunit 50400 "Shape"
{
    procedure Run()
    var
        ${vars}
    begin
${body}
    end;
}`;

describe("PR-44: blank literal in an exit comparison the body feeds", () => {
  it("refuses `until X = ''` with X written in the body", () => {
    // revert: return false at the top of toggledExitBlankHangs (or drop the `repeat`/`until` climb)
    const src = unit("repeat X := CopyStr(X, 2); until X = '';");
    expect(refused(src, ALNodeKind.text_literal, "''", TOGGLE)).toBe(true);
  });

  it("refuses `while X <> ''` with X written in the body", () => {
    // revert: drop the `<>` from the sign check
    const src = unit("while X <> '' do X := CopyStr(X, 2);");
    expect(refused(src, ALNodeKind.text_literal, "''", TOGGLE)).toBe(true);
  });

  it("refuses the blank as an operand of a top-level and / or", () => {
    // revert: stop the climb at the comparison (drop the logical_expression / parenthesized climb)
    const src = unit("while (X <> '') and (N < 3) do begin X := CopyStr(X, 2); N += 1; end;");
    expect(refused(src, ALNodeKind.text_literal, "''", TOGGLE)).toBe(true);
  });

  it("keeps a blank literal when the body does not write the other operand", () => {
    // revert: drop the loopBodyWrites test
    const src = unit("while X <> '' do N += 1;");
    expect(refused(src, ALNodeKind.text_literal, "''", TOGGLE)).toBe(false);
  });

  it("keeps a blank literal in a comparison that is not the exit", () => {
    // revert: drop the `LOOP_KINDS.has(loop.kind)` check (an `if` condition then counts)
    const src = unit("while N < 3 do begin if X = '' then X := 'a'; N += 1; end;");
    expect(refused(src, ALNodeKind.text_literal, "''", TOGGLE)).toBe(false);
  });

  it("keeps a non-blank literal and other operators", () => {
    // revert: drop the blank-text check
    const src = unit("repeat X := CopyStr(X, 2); until X = 'abc';");
    expect(refused(src, ALNodeKind.text_literal, "'abc'", TOGGLE)).toBe(false);
  });

  it("does not refuse other operators on the same site", () => {
    // revert: drop the op check
    const src = unit("repeat X := CopyStr(X, 2); until X = '';");
    expect(refused(src, ALNodeKind.text_literal, "''", "lethal.flip-boolean-literal")).toBe(false);
  });
});
