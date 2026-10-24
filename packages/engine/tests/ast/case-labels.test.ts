import { beforeAll, describe, expect, it } from "bun:test";
import {
  type ALSyntaxNode,
  caseLabelCollides,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "../../src";

/** Which spellings alc treats as the same case label was MEASURED offline (R732, 2026-10-24):
 *  alc compares the label's own text (comments and outer spacing ignored) and folds constants; it
 *  does NOT merge `X=1` with `X = 1` or `x` with `X`. This guard refuses a superset, never fewer. */
function nodeWithText(src: string, text: string, nth = 0): ALSyntaxNode {
  const root = wrapRoot(parseAL(src));
  const hits: ALSyntaxNode[] = [];
  visit(root, (n) => {
    if (n.text === text && n.namedChildren.length === 0) hits.push(n);
  });
  const hit = hits[nth];
  if (hit === undefined) throw new Error(`no node "${text}" #${nth}`);
  return hit;
}

const caseTrue = (labels: string[]): string =>
  `codeunit 50732 R732 { procedure P(X: Integer; Y: Integer) begin case true of ${labels
    .map((l) => `${l}: X := 0;`)
    .join(" ")} end; end; }`;

describe("caseLabelCollides (R732)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("collides: `X = 0` shifted to 1 beside a sibling `X = 1`", () => {
    const src = caseTrue(["X = 0", "X = 1"]);
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(true);
  });

  it("does not collide: shifted to 2", () => {
    const src = caseTrue(["X = 0", "X = 1"]);
    expect(caseLabelCollides(nodeWithText(src, "0"), "2")).toBe(false);
  });

  it("does not collide: the same text in a NESTED case is another statement's label", () => {
    const src = `codeunit 50732 R732 { procedure P(X: Integer; Y: Integer) begin
      case true of X = 0: case true of X = 1: Y := 0; end; Y = 5: X := 0; end; end; }`;
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(false);
  });

  it("collides inside a nested case with ITS sibling, not the outer one", () => {
    const src = `codeunit 50732 R732 { procedure P(X: Integer; Y: Integer) begin
      case true of Y = 5: case true of X = 0: Y := 1; X = 1: Y := 2; end; end; end; }`;
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(true);
  });

  it("collides with a label in the same branch (`A, A:`)", () => {
    const src = caseTrue(["X = 0, X = 1"]);
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(true);
  });

  it("collides across spacing, comments and identifier case (a superset of alc)", () => {
    const src = caseTrue(["X = 0", "x=1", "Y /* c */ = 3"]);
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(true);
    expect(caseLabelCollides(nodeWithText(src, "0"), "3")).toBe(false);
  });

  it("collides with a parenthesised sibling", () => {
    const src = caseTrue(["X = 0", "(X = 1)"]);
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(true);
  });

  it("keeps string case: 'A' and 'a' are different labels to alc", () => {
    const src = `codeunit 50732 R732 { procedure P(T: Text) begin case true of T = 'A': T := ''; T = 'b': T := ''; end; end; }`;
    expect(caseLabelCollides(nodeWithText(src, "'A'"), "'b'")).toBe(true);
    expect(caseLabelCollides(nodeWithText(src, "'A'"), "'B'")).toBe(false);
  });

  it("folds integer constants in a value case (`1:` beside `0 + 1:`, `2 - 1:`)", () => {
    const src =
      "codeunit 50732 R732 { procedure P(X: Integer) begin case X of 0: X := 1; 0 + 1: X := 2; 5: X := 3; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "5"), "1")).toBe(true);
    expect(caseLabelCollides(nodeWithText(src, "5"), "(3 - 2)")).toBe(true);
    expect(caseLabelCollides(nodeWithText(src, "5"), "9")).toBe(false);
  });

  it("folds a leading minus (alc AL0402, measured 2026-10-24): `-1:` beside `0 - 1:` and `0-1:`", () => {
    const src =
      "codeunit 50732 R732 { procedure P(N: Integer) begin case N of 0 - 1: N := 1; 0-2: N := 2; 5: N := 3; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "5"), "-1")).toBe(true);
    expect(caseLabelCollides(nodeWithText(src, "5"), "-2")).toBe(true);
  });

  it("folds a leading minus the other way: a mutated `0 - 1` beside a sibling `-1`", () => {
    const src =
      "codeunit 50732 R732 { procedure P(N: Integer) begin case N of -1: N := 1; 5: N := 3; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "5"), "0 - 1")).toBe(true);
    expect(caseLabelCollides(nodeWithText(src, "5"), "0-1")).toBe(true);
  });

  it("a leading minus that is not equal still does not collide (`-1` vs `1`, `-2`, `0 - 2`)", () => {
    const src =
      "codeunit 50732 R732 { procedure P(N: Integer) begin case N of -1: N := 1; 5: N := 3; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "5"), "1")).toBe(false);
    expect(caseLabelCollides(nodeWithText(src, "5"), "-2")).toBe(false);
    expect(caseLabelCollides(nodeWithText(src, "5"), "0 - 2")).toBe(false);
  });

  it("alc keeps `X = -1` and `X = 0 - 1` apart inside `case true of`, and so does the guard", () => {
    const src = caseTrue(["X = -1", "X = 5"]);
    expect(caseLabelCollides(nodeWithText(src, "5"), "0 - 1")).toBe(false);
  });

  it('alc keeps `PE::A`, `"PE"::A` and `PE::"A"` apart (measured), and so does the guard', () => {
    const src =
      "codeunit 50732 R732 { procedure P(E: Enum PE) begin case E of PE::A: E := PE::B; 5: E := PE::A; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "5"), '"PE"::A')).toBe(false);
    expect(caseLabelCollides(nodeWithText(src, "5"), 'PE::"A"')).toBe(false);
    expect(caseLabelCollides(nodeWithText(src, "5"), "PE::A")).toBe(true);
  });

  it("does not collide for a node outside any case label", () => {
    const src =
      "codeunit 50732 R732 { procedure P(X: Integer) begin X := 0; case true of X = 0: X := 0; X = 1: X := 2; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "0", 0), "1")).toBe(false);
  });

  it("does not collide for a node in a branch BODY", () => {
    const src =
      "codeunit 50732 R732 { procedure P(X: Integer) begin case true of X = 7: X := 0; X = 1: X := 2; end; end; }";
    expect(caseLabelCollides(nodeWithText(src, "0"), "1")).toBe(false);
  });
});
