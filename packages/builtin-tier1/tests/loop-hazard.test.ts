import { beforeAll, describe, expect, it } from "bun:test";
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { classifyHangCapable } from "../src/loop-hazard";

function load(src: string) {
  const root = wrapRoot(parseAL(src));
  return { root, ctx: buildSemanticContext([{ path: "t.al", root }]) };
}

/** The assignment statement whose source text contains `needle`. */
function assignment(root: ALSyntaxNode, needle: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement && n.text.includes(needle)) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  const first = out[0];
  if (first === undefined) throw new Error(`no assignment containing ${needle}`);
  return first;
}

describe("classifyHangCapable", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("CLAIMS a counter advanced in a while body whose condition reads it", () => {
    const { root, ctx } = load(`codeunit 50300 "R" {
      procedure P(Limit: Integer) var I: Integer; begin
        while I < Limit do I += 1;
      end; }`);
    expect(classifyHangCapable(assignment(root, "I += 1"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS a flag assigned in a repeat body whose until reads it", () => {
    const { root, ctx } = load(`codeunit 50301 "R" {
      procedure P() var Done: Boolean; begin
        repeat Done := true; until Done;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Done := true"), ctx)).toBe(
      "loop-condition-target",
    );
  });

  it("CLAIMS through an OUTER loop, not only the nearest one", () => {
    const { root, ctx } = load(`codeunit 50302 "R" {
      procedure P() var Outer: Integer; Inner: Integer; begin
        while Outer < 10 do begin
          while Inner < 3 do Inner += 1;
          Outer += 1;
        end;
      end; }`);
    // `Outer += 1` sits inside the inner loop's sibling, but the OUTER condition reads it.
    expect(classifyHangCapable(assignment(root, "Outer += 1"), ctx)).toBe("loop-condition-target");
  });

  it("CLAIMS inside a TRIGGER body", () => {
    const { root, ctx } = load(`table 50303 "R" { fields { field(1; "No."; Code[20]) { } }
      trigger OnInsert() var N: Integer; begin
        while N < 3 do N += 1;
      end; }`);
    expect(classifyHangCapable(assignment(root, "N += 1"), ctx)).toBe("loop-condition-target");
  });

  it("DECLINES an assignment the condition does not read: the step variable (spec 3.2.1)", () => {
    const { root, ctx } = load(`codeunit 50304 "R" {
      procedure P(Limit: Integer) var I: Integer; Step: Integer; begin
        Step := 1;
        while I < Limit do I += Step;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Step := 1"), ctx)).toBeNull();
  });

  it("DECLINES a preheader assignment (spec 3.2.2)", () => {
    const { root, ctx } = load(`codeunit 50305 "R" {
      procedure P(Target: Integer) var Position: Integer; begin
        Position := Target + 1;
        repeat if Position > Target then Position -= 1; until Position = Target;
      end; }`);
    expect(classifyHangCapable(assignment(root, "Position := Target + 1"), ctx)).toBeNull();
  });

  it("DECLINES an assignment outside any loop", () => {
    const { root, ctx } = load(`codeunit 50306 "R" {
      procedure P() var I: Integer; begin I := 1; end; }`);
    expect(classifyHangCapable(assignment(root, "I := 1"), ctx)).toBeNull();
  });

  it("DECLINES when the target cannot be resolved, rather than matching on name", () => {
    const { root, ctx } = load(`codeunit 50307 "R" {
      procedure P() begin while Ghost < 3 do Ghost += 1; end; }`);
    expect(classifyHangCapable(assignment(root, "Ghost += 1"), ctx)).toBeNull();
  });

  it("DECLINES a same-named variable in a DIFFERENT procedure's loop", () => {
    const { root, ctx } = load(`codeunit 50308 "R" {
      procedure A() var I: Integer; begin while I < 3 do ; end;
      procedure B() var I: Integer; begin I += 1; end; }`);
    expect(classifyHangCapable(assignment(root, "I += 1"), ctx)).toBeNull();
  });

  it("CLAIMS a QUOTED-identifier target read by an enclosing loop's condition", () => {
    const { root, ctx } = load(`codeunit 50309 "R" {
      procedure P() var "Line Done": Boolean; begin
        while not "Line Done" do "Line Done" := true;
      end; }`);
    expect(classifyHangCapable(assignment(root, '"Line Done" := true'), ctx)).toBe(
      "loop-condition-target",
    );
  });
});
