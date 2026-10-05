import { beforeAll, describe, expect, it } from "bun:test";
/**
 * R468: a global in an object's SECOND var section resolves, so R196's hang check refuses a write
 * to it that a loop condition reads, by declaration (spec 3.1). The control keeps the refusal
 * narrow: a second-section global that no loop condition reads is still mutated.
 */
import {
  ALNodeKind,
  type ALSyntaxNode,
  buildSemanticContext,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { classifyHangCapable } from "../src/loop-hazard";
import { removeAssignment } from "../src/remove-assignment";

beforeAll(async () => {
  await initParser();
});

const SRC = `codeunit 50480 C
{
    procedure P()
    begin
        while B do begin
            N := 1;
            B := false;
        end;
    end;

    protected var
        A: Boolean;

    var
        B: Boolean;
        N: Integer;
}
`;

function assignment(root: ALSyntaxNode, text: string): ALSyntaxNode {
  const out: ALSyntaxNode[] = [];
  const walk = (n: ALSyntaxNode): void => {
    if (n.kind === ALNodeKind.assignment_statement && n.text === text) out.push(n);
    for (const c of n.namedChildren) walk(c);
  };
  walk(root);
  const first = out[0];
  if (first === undefined) throw new Error(`no assignment ${text}`);
  return first;
}

function load() {
  const root = wrapRoot(parseAL(SRC));
  return { root, ctx: buildSemanticContext([{ path: "c.al", root }]) };
}

describe("R468: the hang check sees a second-section global", () => {
  // Revert (first section only): B does not resolve, the check declines, and remove-assignment
  // claims a write whose removal never ends the loop. R468's own repro.
  it("refuses `B := false` inside `while B do`", () => {
    const { root, ctx } = load();
    const write = assignment(root, "B := false");
    expect(classifyHangCapable(write, ctx)).toBe("loop-condition-target");
    expect(removeAssignment.targets(write, ctx)).toBe(false);
    expect(removeAssignment.refusesHangCapable?.(write, ctx)).toBe(true);
  });

  // Over-applied (refuse every write to a second-section global): N, which no loop condition
  // reads, would lose its mutant.
  it("still mutates a second-section global the loop condition does not read", () => {
    const { root, ctx } = load();
    const write = assignment(root, "N := 1");
    expect(classifyHangCapable(write, ctx)).toBeNull();
    expect(removeAssignment.targets(write, ctx)).toBe(true);
  });
});
