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
 * PR-53: `toggle-blank-string` on the blank of `X := ''`, a statement of a loop's body, is
 * hang-refused when the loop's exit needs X blank. Invented AL. Each test names its revert.
 */

beforeAll(async () => {
  await initParser();
});

const TOGGLE = "lethal.toggle-blank-string";

/** Is the blank literal that is the right side of an assignment refused? */
function refused(body: string, op = TOGGLE): boolean {
  const src = `codeunit 50400 "Shape"
{
    procedure Run()
    var
        Rest: Text; Cur: Text; P: Integer;
    begin
${body}
    end;
}`;
  const root = wrapRoot(parseAL(src));
  const ctx = buildSemanticContext([{ path: "t.al", root }]);
  const site = findAll(root, ALNodeKind.text_literal).find(
    (n: ALSyntaxNode) => n.text.trim() === "''" && n.parent?.rawKind === "assignment_statement",
  );
  if (site === undefined) throw new Error("no assigned blank literal");
  return openItemHangRefuses(site, ctx, op);
}

const DO_SHAPE = (cond: string) =>
  `while ${cond} do begin if P > 0 then begin Cur := CopyStr(Rest, 1, P); Rest := CopyStr(Rest, P + 1) end else begin Cur := Rest; Rest := '' end; end;`;

describe("PR-53: X := '' in a loop whose exit needs X blank", () => {
  it("refuses the DO shape: `while Rest <> ''`, the blank in an else branch", () => {
    // revert: return false at the top of toggledAssignedBlankHangs
    expect(refused(DO_SHAPE("Rest <> ''"))).toBe(true);
  });

  it("refuses `repeat .. until Rest = ''`", () => {
    // revert: drop the repeat case of the `refuses` result in exitPolarity
    expect(refused("repeat Rest := ''; P += 1; until Rest = '';")).toBe(true);
  });

  it("refuses through `or` / `and` by the polarity rules", () => {
    // revert: drop the connective rule in exitPolarity
    expect(refused(DO_SHAPE("(Rest <> '') or (P < 3)"))).toBe(true);
    expect(refused("repeat Rest := ''; until (Rest = '') and (P > 0);")).toBe(true);
    expect(refused(DO_SHAPE("(Rest <> '') and (P < 3)"))).toBe(false);
    expect(refused("repeat Rest := ''; until (Rest = '') or (P > 0);")).toBe(false);
  });

  it("keeps an assignment in a loop whose exit does not read X", () => {
    // revert: drop the `baseNameOf(other) !== name` check
    expect(refused("while P < 3 do begin Rest := ''; P += 1; end;")).toBe(false);
    expect(refused("while Cur <> '' do begin Rest := ''; P += 1; end;")).toBe(false);
  });

  it("keeps an exit that needs X non-blank", () => {
    // revert: drop the polarity check (`refuses`)
    expect(refused("repeat Rest := ''; P += 1; until Rest <> '';")).toBe(false);
    expect(refused("while Rest = '' do begin Rest := ''; P += 1; end;")).toBe(false);
  });

  it("keeps `X := ''` outside the loop", () => {
    // revert: drop the enclosing-loop search (use any loop in the procedure)
    expect(refused("Rest := ''; while Rest <> '' do P += 1;")).toBe(false);
  });

  it("keeps the same site under another operator", () => {
    // revert: drop the op check
    expect(refused(DO_SHAPE("Rest <> ''"), "lethal.flip-boolean-literal")).toBe(false);
  });
});
