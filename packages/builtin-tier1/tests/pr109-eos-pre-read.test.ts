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
 * PR-109: `remove-not` on `while not S.EOS do`, S an InStream read straight-line before the loop,
 * is hang-refused. Invented AL. Each test names its revert.
 */

beforeAll(async () => {
  await initParser();
});

const NOT = "lethal.remove-not";

/** Is the first `not ...` unary site of the unit refused? */
function refused(
  body: string,
  vars = "S: InStream; Other: InStream; T: Text; B: Byte; X: Boolean;",
  params = "",
) {
  const src = `codeunit 50500 "Shape"
{
    procedure Run(${params})
    var
        ${vars}
    begin
${body}
    end;
}`;
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  const site = findAll(root, ALNodeKind.unary_expression).find((n: ALSyntaxNode) =>
    n.text.startsWith("not"),
  );
  if (site === undefined) throw new Error("no not site");
  return openItemHangRefuses(site, ctx, NOT);
}

describe("PR-109: while not S.EOS after a pre-read", () => {
  it("refuses with S.ReadText before the loop", () => {
    // revert: PR109_RULE off (or `removeNotEosAfterReadHangs` returning false)
    expect(refused("S.ReadText(T); while not S.EOS do S.ReadText(T);")).toBe(true);
  });

  it("refuses with S.Read(B) before the loop", () => {
    // revert: drop "read" from the pre-read method list
    expect(refused("S.Read(B); while not S.EOS do S.ReadText(T);")).toBe(true);
  });

  it("refuses S.EOS()", () => {
    // revert: make plainMemberCall reject the call form
    expect(refused("S.ReadText(T); while not S.EOS() do S.ReadText(T);")).toBe(true);
  });

  it("refuses S as a parameter", () => {
    // revert: resolve the type of locals only
    expect(
      refused("S.ReadText(T); while not S.EOS do S.ReadText(T);", "T: Text;", "var S: InStream"),
    ).toBe(true);
  });

  it("keeps a loop with no pre-read", () => {
    // revert: drop the pre-read scan (return true after the EOS checks)
    expect(refused("while not S.EOS do S.ReadText(T);")).toBe(false);
  });

  it("refuses when the pre-read and the loop share one if-block (the DO shape)", () => {
    // revert: require the read's block to be the procedure's own (the first measurement's rule)
    expect(
      refused("if X then begin S.ReadText(T); while not S.EOS do begin S.ReadText(T); end; end;"),
    ).toBe(true);
  });

  it("keeps a pre-read inside an if the loop is not in", () => {
    // revert: drop the block-holds-the-loop check (any earlier read counts)
    expect(refused("if X then S.ReadText(T); while not S.EOS do S.ReadText(T);")).toBe(false);
    expect(refused("if X then begin S.ReadText(T); end; while not S.EOS do S.ReadText(T);")).toBe(
      false,
    );
  });

  it("keeps a pre-read in the then-branch with the loop in the else-branch", () => {
    // revert: same as above
    expect(
      refused(
        "if X then begin S.ReadText(T); end else begin while not S.EOS do S.ReadText(T); end;",
      ),
    ).toBe(false);
  });

  it("keeps a pre-read inside another loop", () => {
    // revert: drop the block-holds-the-loop check
    expect(refused("while X do S.ReadText(T); while not S.EOS do S.ReadText(T);")).toBe(false);
    expect(refused("while X do begin S.ReadText(T); end; while not S.EOS do S.ReadText(T);")).toBe(
      false,
    );
  });

  it("keeps a pre-read of another stream", () => {
    // revert: drop the receiver-name comparison
    expect(refused("Other.ReadText(T); while not S.EOS do S.ReadText(T);")).toBe(false);
  });

  it("keeps S that is not an InStream", () => {
    // revert: drop the InStream type check
    expect(
      refused("S.ReadText(T); while not S.EOS do S.ReadText(T);", "S: Record Customer; T: Text;"),
    ).toBe(false);
  });

  it("keeps `not (S.EOS and X)`", () => {
    // revert: accept any `not` over a condition that reads EOS (drop the operand-shape check)
    expect(refused("S.ReadText(T); while not (S.EOS and X) do S.ReadText(T);")).toBe(false);
  });

  it("keeps `until not S.EOS`: a repeat, not a while (`until S.EOS` has no not at all)", () => {
    // revert: drop the while_statement check
    expect(refused("S.ReadText(T); repeat S.ReadText(T); until not S.EOS;")).toBe(false);
  });

  it("keeps a pre-read that comes after the loop", () => {
    // revert: drop the `endIndex > loop.startIndex` position check
    expect(refused("while not S.EOS do S.ReadText(T); S.ReadText(T);")).toBe(false);
  });

  it("keeps a `not` that is only part of the loop condition", () => {
    // revert: drop the while_statement-parent check (it is also the whole-condition check; the
    // `and` node, not the loop, is this `not`'s parent)
    expect(refused("S.ReadText(T); while X and not S.EOS do S.ReadText(T);")).toBe(false);
  });
});
